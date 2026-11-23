package dev.openhouse.shell

// A USB drive plugged into the tablet, as a place for backups (bridge/drive.js). Android lets an app at a USB drive
// only through a folder someone picked in the system's picker, so the shell holds that permission and the
// bridge asks it to copy files, on 127.0.0.1 with a token it leaves in display/.backup/drive.json. Files move by
// path through display/.backup/tmp only (both sides see the display folder); the agent's tools never reach this.
//
// On the drive: the folder the person made in the picker ("Display backups") with display-backup-<time>-<kind>-<keyId>.backup files (encrypted on
// the tablet before they get here). Later a shared folder on a home computer (SMB) can answer the same five calls.

import dev.openhouse.ui.CalmDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import kotlin.concurrent.thread

object BackupDrive {
    private const val TAG = "BackupDrive"
    private val NAME = Regex("^display-backup-\\d{8}T\\d{6}Z-(nightly|manual)-[0-9a-f]{16}\\.backup$")
    private lateinit var ctx: Context
    @Volatile private var started = false
    private fun prefs() = ctx.getSharedPreferences("backup_drive", Context.MODE_PRIVATE)
    private val tmp get() = File(ctx.filesDir, "display/.backup/tmp").canonicalFile

    fun start(c: Context) {
        if (started) return
        started = true
        ctx = c.applicationContext
        val token = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val ss = runCatching { ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")) }.getOrElse { Log.w(TAG, "no port: ${it.message}"); return }
        val conf = File(ctx.filesDir, "display/.backup").apply { mkdirs() }
        File(conf, "drive.json.new").apply { writeText(JSONObject().put("port", ss.localPort).put("token", token).toString()); setReadable(false, false); setReadable(true, true); renameTo(File(conf, "drive.json")) }
        thread(name = "backup-drive", isDaemon = true) {
            while (true) {
                val s = runCatching { ss.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { runCatching { s.use { serve(it, token) } }.onFailure { Log.d(TAG, "call: ${it.message}") } }
            }
        }
    }

    // --- choosing the drive (Settings) --------------------------------------------------------------------
    fun chosenName(): String? = if (::ctx.isInitialized) prefs().getString("name", null) else null

    /** Ask Android for the plugged-in USB drive's folder (the person taps Allow), then [done] with its name or null. */
    fun choose(act: MainActivity, done: (String?) -> Unit) {
        val sm = act.getSystemService(StorageManager::class.java)
        val vols = sm.storageVolumes.filter { it.isRemovable && it.state == Environment.MEDIA_MOUNTED }
        if (vols.isEmpty()) {
            CalmDialog(act).setTitle("USB drive").setMessage("Plug a USB drive into the tablet, then try again.").setPositiveButton("OK") { _, _ -> done(null) }.show().also { act.immersive() }
            return
        }
        val vol = vols.first()
        prefs().edit().putString("pending_name", vol.getDescription(act)).apply()
        CalmDialog(act).setTitle("Choose the USB drive")
            .setMessage("Next, Android asks which folder backups go in. Tap \u201cCreate new folder\u201d, call it Display backups, then tap \u201cUse this folder\u201d and \u201cAllow\u201d.")
            .setPositiveButton("OK") { _, _ ->
                val intent = vol.createOpenDocumentTreeIntent()
                // The picker is another app: let it through kiosk mode while it's open.
                runCatching { act.packageManager.resolveActivity(intent, 0)?.activityInfo?.packageName }.getOrNull()?.let { runCatching { KioskApps.allowInKiosk(it, temporary = true) } }
                act.drivePicker.launch(intent)
            }.setNegativeButton("Cancel") { _, _ -> done(null) }.show().also { act.immersive() }
    }

    /** The picker's answer (MainActivity registers it, so it still arrives if the display was recreated meanwhile). */
    fun picked(act: MainActivity, r: androidx.activity.result.ActivityResult) {
        if (!::ctx.isInitialized) ctx = act.applicationContext
        act.immersive()
        val uri = r.data?.data
        Log.i(TAG, "picker: result ${r.resultCode}, ${if (uri != null) "a folder" else "nothing"}")
        if (uri == null) return
        runCatching { act.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        // Let go of the drive chosen before, if any.
        prefs().getString("uri", null)?.let { old -> if (old != uri.toString()) runCatching { act.contentResolver.releasePersistableUriPermission(Uri.parse(old), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } }
        prefs().edit().putString("uri", uri.toString()).putString("name", prefs().getString("pending_name", null)).apply()
        BackupMenu(act).driveChosen()
    }

    // --- the drive itself ----------------------------------------------------------------------------------------
    private fun tree(): Uri? = prefs().getString("uri", null)?.let(Uri::parse)
    private data class Doc(val id: String, val name: String, val size: Long, val dir: Boolean)
    private fun children(tree: Uri, parentId: String): List<Doc> {
        val out = mutableListOf<Doc>()
        ctx.contentResolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId),
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
            while (c.moveToNext()) out += Doc(c.getString(0), c.getString(1) ?: "", if (c.isNull(2)) 0 else c.getLong(2), c.getString(3) == DocumentsContract.Document.MIME_TYPE_DIR)
        }
        return out
    }
    /** The chosen folder on the drive (someone made "Display backups" in the picker); null when none is chosen
     *  or the drive isn't plugged in. */
    private fun folder(): Pair<Uri, String>? {
        val t = tree() ?: return null
        val root = DocumentsContract.getTreeDocumentId(t)
        runCatching { children(t, root) }.getOrNull() ?: return null
        return t to root
    }
    private fun inTmp(p: String): File {
        val f = File(p).canonicalFile
        require(f.path.startsWith(tmp.path + File.separator)) { "not a backup file" }
        return f
    }

    private fun answer(call: String, b: JSONObject): JSONObject = when (call) {
        "/status" -> JSONObject().put("chosen", tree() != null).put("name", prefs().getString("name", null)).put("present", folder() != null)
        "/list" -> {
            val (t, id) = folder() ?: throw IllegalStateException("Plug in the drive.")
            JSONObject().put("files", JSONArray().apply { children(t, id).filter { !it.dir && NAME.matches(it.name) }.forEach { put(JSONObject().put("name", it.name).put("size", it.size)) } })
        }
        "/put" -> {
            val name = b.optString("name"); require(NAME.matches(name)) { "bad name" }
            val src = inTmp(b.optString("path"))
            val (t, id) = folder() ?: throw IllegalStateException("Plug in the drive.")
            val parent = DocumentsContract.buildDocumentUriUsingTree(t, id)
            // Written under a working name, then renamed: a half-written backup never looks like a real one.
            children(t, id).filter { it.name == "$name.part" }.forEach { DocumentsContract.deleteDocument(ctx.contentResolver, DocumentsContract.buildDocumentUriUsingTree(t, it.id)) }
            val doc = DocumentsContract.createDocument(ctx.contentResolver, parent, "application/octet-stream", "$name.part") ?: throw IllegalStateException("The drive didn't take the file.")
            try {
                ctx.contentResolver.openOutputStream(doc, "w")!!.use { o -> src.inputStream().use { it.copyTo(o, 1 shl 16) } }
                DocumentsContract.renameDocument(ctx.contentResolver, doc, name)
            } catch (e: Exception) { runCatching { DocumentsContract.deleteDocument(ctx.contentResolver, doc) }; throw e }
            JSONObject().put("ok", true)
        }
        "/get", "/remove" -> {
            val name = b.optString("name"); require(NAME.matches(name)) { "bad name" }
            val (t, id) = folder() ?: throw IllegalStateException("Plug in the drive.")
            val d = children(t, id).firstOrNull { it.name == name } ?: throw IllegalStateException("That backup isn't on the drive.")
            val uri = DocumentsContract.buildDocumentUriUsingTree(t, d.id)
            if (call == "/get") {
                val dst = inTmp(b.optString("path"))
                ctx.contentResolver.openInputStream(uri)!!.use { i -> dst.outputStream().use { i.copyTo(it, 1 shl 16) } }
            } else DocumentsContract.deleteDocument(ctx.contentResolver, uri)
            JSONObject().put("ok", true)
        }
        else -> throw NoSuchElementException()
    }

    private fun serve(s: Socket, token: String) {
        s.soTimeout = 30 * 60_000 // a big backup to a slow drive
        val inp = BufferedInputStream(s.getInputStream())
        val lines = mutableListOf<String>(); val line = StringBuilder()
        while (true) {
            val c = inp.read(); if (c < 0) return
            if (c == '\n'.code) { val l = line.toString().trimEnd('\r'); line.clear(); if (l.isEmpty()) break; lines += l; if (lines.size > 40) return } else { line.append(c.toChar()); if (line.length > 4096) return }
        }
        val head = lines.drop(1).associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
        val path = lines.firstOrNull()?.split(' ')?.getOrNull(1) ?: return
        val n = head["content-length"]?.toIntOrNull() ?: 0
        val body = if (n in 1..16384) ByteArray(n).also { var got = 0; while (got < n) { val r = inp.read(it, got, n - got); if (r < 0) return; got += r } } else ByteArray(0)
        val (code, out) = when {
            head["authorization"] != "Bearer $token" -> 401 to JSONObject().put("error", "no")
            else -> runCatching { 200 to answer(path, if (body.isEmpty()) JSONObject() else JSONObject(String(body))) }.getOrElse {
                if (it is NoSuchElementException) 404 to JSONObject().put("error", "not found")
                else { Log.d(TAG, "$path: ${it.message}"); 409 to JSONObject().put("error", it.message ?: "The drive didn't answer.") }
            }
        }
        val bytes = out.toString().toByteArray()
        s.getOutputStream().apply { write("HTTP/1.1 $code X\r\ncontent-type: application/json\r\ncontent-length: ${bytes.size}\r\nconnection: close\r\n\r\n".toByteArray()); write(bytes); flush() }
    }
}
