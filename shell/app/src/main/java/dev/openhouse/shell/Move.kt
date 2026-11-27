package dev.openhouse.shell

// Moving a tablet from the prototype's package IDs (dev.openhouse.*) to Opie's (computer.openhouse.*) without a
// factory reset: the family's data and the tablet's device owner go from the old display to the new one, and then
// the old apps are removed. docs/self-update.md, "Moving to Opie".
//
// Android keeps each app's files to itself and never renames a package, so the old display does the handing over:
//
//   1. The old display, built under the old ID with -Popenhouse.moveTo=computer.openhouse (scripts/move-tablet.sh
//      installs it), lets the new display into kiosk mode and opens its MoveActivity once it's installed.
//   2. The new display asks the old one (MoveOut, a content provider only the new display, signed with the release
//      key, may use) to stop its runtime, then reads its files as one tar: the family's folder, the runtime, the
//      settings. The calendar links come decrypted (their key is in the old app's keystore) and are sealed again here.
//   3. It checks the family's folder arrived whole (every file, every byte), then asks the old display to hand over
//      device owner (DevicePolicyManager.transferOwnership). As owner it takes Home and kiosk mode (DeviceOwner).
//   4. When the new display has been healthy for a while, it removes the old apps. Until then the old display, with
//      everything it had, is still there.

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Color
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.PersistableBundle
import android.util.Log
import android.view.Gravity
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

internal object Move {
    const val TAG = "Move"
    /** The display under the old IDs, when this one takes over from it. */
    val fromPkg get() = BuildConfig.MOVED_FROM.takeIf { it.isNotEmpty() }?.let { "$it.shell" }
    /** The display under the new IDs, when this one hands over to it. */
    val toPkg get() = BuildConfig.MOVE_TO.takeIf { it.isNotEmpty() }?.let { "$it.shell" }
    fun authority(pkg: String) = "$pkg.move"
    /** The family's own folder: nothing is handed over until all of it arrived. */
    const val FAMILY = "files/display"
    /** What of the old app's data folder goes over. Not its caches, update downloads, the family apps' launcher
     * entries (made again under the new IDs) or self-update's state. */
    val PARTS = listOf("files", "shared_prefs", "no_backup")
    val SKIP = listOf("files/updates", "files/rootfs.new", "files/move", "shared_prefs/stubs.xml", "shared_prefs/update.xml", "shared_prefs/move.xml",
        "no_backup/calendar-links", "no_backup/calendar-links.new", "no_backup/album-links", "no_backup/album-links.new", "no_backup/photo-share", "no_backup/photo-share.new") // sealed with the old app's key: they come over by calendarLinksFromOld

    /**
     * The family's calendar links from the old display (its key is in its own keystore, so they come decrypted, over the
     * move's own channel, never as a file) and sealed again with this app's key. Null if the old display can't say
     * (an older build without it); otherwise how many came.
     */
    fun calendarLinksFromOld(c: Context): Int? {
        val from = fromPkg ?: return null
        val text = runCatching {
            c.contentResolver.openInputStream(Uri.parse("content://${authority(from)}/calendar-links"))?.use { it.readBytes().decodeToString() }
        }.onFailure { Log.w(TAG, "calendar links: $it") }.getOrNull() ?: return null
        val a = org.json.JSONArray(text)
        CalendarLinks.init(c)
        for (i in 0 until a.length()) a.getJSONObject(i).let { CalendarLinks.add(it.optString("who"), it.getString("url")) }
        Log.i(TAG, "calendar links from the old display: ${a.length()}")
        return a.length()
    }

    fun prefs(c: Context) = c.getSharedPreferences("move", Context.MODE_PRIVATE)
    private fun dpm(c: Context) = c.getSystemService(DevicePolicyManager::class.java)
    fun installed(c: Context, pkg: String) = runCatching { c.packageManager.getPackageInfo(pkg, 0); true }.getOrDefault(false)

    /** The old display is the tablet's owner and this one isn't yet: take over (MoveActivity). */
    fun takeOverNeeded(c: Context): Boolean {
        val from = fromPkg ?: return false
        val dpm = dpm(c)
        return !dpm.isDeviceOwnerApp(c.packageName) && installed(c, from) && dpm.isDeviceOwnerApp(from)
    }

    /** Under the old ID, after handing over: this display only steps aside. */
    fun handedOver(c: Context) = toPkg != null && prefs(c).getBoolean("handed_over", false)

    /** [pkg] is signed with the release key (the one certificate built in). */
    fun signedByUs(c: Context, pkg: String): Boolean {
        val cert = BuildConfig.RELEASE_CERT.takeIf { it.length == 64 } ?: return false
        val bytes = cert.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        return runCatching { c.packageManager.hasSigningCertificate(pkg, bytes, PackageManager.CERT_INPUT_SHA256) }.getOrDefault(false)
    }

    /** Every file under [dir], by its path from [dir], with its size: to see that a copy arrived whole. */
    fun inventory(dir: File): Map<String, Long> {
        val out = HashMap<String, Long>()
        val base = dir.toPath()
        walk(dir) { p, a -> if (a.isRegularFile) out[base.relativize(p).toString()] = a.size() }
        return out
    }

    /** Every file and link under [dir], not following links, past folders that can't be read (the runtime has some). */
    fun walk(dir: File, visit: (java.nio.file.Path, java.nio.file.attribute.BasicFileAttributes) -> Unit) {
        if (!dir.exists()) return
        java.nio.file.Files.walkFileTree(dir.toPath(), object : java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
            override fun visitFile(f: java.nio.file.Path, a: java.nio.file.attribute.BasicFileAttributes) = java.nio.file.FileVisitResult.CONTINUE.also { visit(f, a) }
            override fun visitFileFailed(f: java.nio.file.Path, e: java.io.IOException) = java.nio.file.FileVisitResult.CONTINUE
        })
    }

    /**
     * Links the old app's runtime made point into its own data folder (proot keeps hard links as links to absolute
     * paths): made to point at the same place in this app's. Returns how many.
     */
    fun relink(dir: File, oldData: String, newData: String): Int {
        var n = 0
        walk(dir) { p, a ->
            if (!a.isSymbolicLink) return@walk
            val t = java.nio.file.Files.readSymbolicLink(p).toString()
            val rest = listOf(oldData, oldData.replace("/data/user/0/", "/data/data/")).firstNotNullOfOrNull { o -> t.takeIf { it == o || it.startsWith("$o/") }?.removePrefix(o) }
            if (rest != null) runCatching { java.nio.file.Files.delete(p); java.nio.file.Files.createSymbolicLink(p, java.nio.file.Paths.get(newData + rest)); n++ }
        }
        return n
    }

    // --- the old display: handing over ------------------------------------------------------------------------------

    private var offeredAt = 0L

    /**
     * Under the old ID, from the watchdog: once the new display is installed (signed with the release key), let it
     * into kiosk mode and open its MoveActivity. Again after 10 minutes if the move didn't happen.
     */
    fun offer(a: Activity) {
        val to = toPkg ?: return
        val p = prefs(a)
        if (p.getBoolean("moving", false) || p.getBoolean("handed_over", false)) return
        if (System.currentTimeMillis() - offeredAt < 10 * 60_000L) return
        if (!installed(a, to) || !signedByUs(a, to) || !dpm(a).isDeviceOwnerApp(a.packageName)) return
        offeredAt = System.currentTimeMillis()
        runCatching {
            val admin = ComponentName(a, AdminReceiver::class.java)
            val have = dpm(a).getLockTaskPackages(admin).toSet()
            if (to !in have) dpm(a).setLockTaskPackages(admin, (have + to).toTypedArray())
            a.startActivity(Intent().setComponent(ComponentName(to, MoveActivity::class.java.name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            Log.i(TAG, "opened $to to move the tablet over")
        }.onFailure { Log.w(TAG, "opening $to: $it") }
    }

    /** Under the old ID, after the handover: the new display is the tablet's now. */
    fun stepAside(a: Activity) {
        val to = toPkg ?: return
        runCatching { a.stopLockTask() }
        runCatching { a.startActivity(Intent().setComponent(ComponentName(to, MainActivity::class.java.name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    // --- the new display: taking over ------------------------------------------------------------------------------

    private fun call(c: Context, method: String, timeoutNote: String = ""): Bundle? {
        val from = fromPkg ?: return null
        return c.contentResolver.call(Uri.parse("content://${authority(from)}"), method, null, null).also { Log.i(TAG, "$method$timeoutNote: $it") }
    }

    /** Steps 2 and 3. [say] gets a line for the screen. Throws if something's wrong; the old display is then as it was. */
    fun takeOver(c: Context, say: (String) -> Unit) {
        val from = fromPkg!!
        val oldData = c.packageManager.getApplicationInfo(from, 0).dataDir
        val newData = c.applicationInfo.dataDir
        say("Getting ready to move…")
        val ready = call(c, "prepare") ?: error("the old display didn't answer")
        if (!ready.getBoolean("ok")) error(ready.getString("error") ?: "the old display said no")
        try {
            // The family folder's files and sizes, as the old display has them (too many for a Binder call).
            val expected = c.contentResolver.openInputStream(Uri.parse("content://${authority(from)}/inventory"))!!.use { i ->
                val j = JSONObject(i.readBytes().decodeToString()); j.keys().asSequence().associateWith { j.getLong(it) }
            }
            say("Moving the family's things…")
            val stage = File(newData, "move-in").apply { deleteRecursively(); mkdirs() }
            val t0 = System.currentTimeMillis()
            val pipe = c.contentResolver.openFileDescriptor(Uri.parse("content://${authority(from)}/data"), "r") ?: error("no data")
            val p = ProcessBuilder("/system/bin/tar", "-xf", "-", "-C", stage.path).redirectErrorStream(true).start()
            val out = StringBuilder()
            val reader = thread { p.inputStream.bufferedReader().forEachLine { if (out.length < 4000) out.appendLine(it) } }
            val bytes = runCatching { ParcelFileDescriptor.AutoCloseInputStream(pipe).use { i -> p.outputStream.use { i.copyTo(it, 1 shl 16) } } }
            val rc = p.waitFor(); reader.join(2000)
            Log.i(TAG, "${bytes.getOrNull()?.let { it shr 20 } ?: "?"} MB in ${System.currentTimeMillis() - t0} ms (tar $rc${if (rc != 0) ": " + out.takeLast(600) else ""})")
            bytes.getOrThrow()
            // Whole, or nothing changes: every file of the family's folder, at its size.
            val got = inventory(File(stage, FAMILY))
            val missing = expected.filter { (k, v) -> got[k] != v }
            if (expected.isEmpty() || missing.isNotEmpty()) error("the family's folder didn't arrive whole (${missing.size} of ${expected.size} files differ)")
            say("Putting it in place…")
            for (part in PARTS) {
                val f = File(stage, part); if (!f.exists()) continue
                val mine = File(newData, part)
                if (part == "shared_prefs") { // ours so far (this move's own) stay
                    mine.mkdirs(); f.listFiles()?.forEach { pf -> File(mine, pf.name).delete(); pf.renameTo(File(mine, pf.name)) }
                } else {
                    val aside = File(newData, "$part.before-move").apply { deleteRecursively() }
                    if (mine.exists()) mine.renameTo(aside)
                    if (!f.renameTo(mine)) { aside.renameTo(mine); error("couldn't put $part in place") }
                    aside.deleteRecursively()
                }
            }
            stage.deleteRecursively()
            Log.i(TAG, "relinked ${relink(File(newData, "files"), oldData, newData)} links")
            // The calendar links, sealed with this app's own key. (Until 2026-11-20 they were written to files/move,
            // which the copy skips: the family tablet's never came over.)
            calendarLinksFromOld(c)?.let { prefs(c).edit().putBoolean("calendars_from_old", true).apply() }
            File(newData, "files/move").deleteRecursively()
            prefs(c).edit().putLong("moved_at", System.currentTimeMillis()).apply()
            say("Taking over…")
            val handed = call(c, "handover") ?: error("the old display didn't answer")
            if (!handed.getBoolean("ok")) error(handed.getString("error") ?: "the old display didn't hand over")
            // transferOwnership has called AdminReceiver.onTransferOwnershipComplete by now (it's synchronous).
            if (!dpm(c).isDeviceOwnerApp(c.packageName)) error("not the tablet's owner after the handover")
            say("Done")
        } catch (e: Throwable) {
            runCatching { call(c, "abort") }
            throw e
        }
    }

    /** As the new owner: Home and kiosk are this display's now (DeviceOwner.setUp does the rest when it starts). */
    fun becameOwner(c: Context) {
        val dpm = dpm(c)
        val admin = ComponentName(c, AdminReceiver::class.java)
        val old = BuildConfig.MOVED_FROM.takeIf { it.isNotEmpty() }
        if (old != null) for (pkg in listOf("$old.shell", "$old.host")) runCatching { dpm.clearPackagePersistentPreferredActivities(admin, pkg) }
        runCatching {
            dpm.addPersistentPreferredActivity(admin,
                android.content.IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) },
                ComponentName(c, MainActivity::class.java))
            dpm.setLockTaskPackages(admin, arrayOf(c.packageName, MainActivity.HOST_PKG))
        }.onFailure { Log.w(TAG, "claiming home: $it") }
        // The microphone and notifications, which the old display had from tablet-setup.sh over adb: granted as the
        // owner, so no question about them comes up over the display (MoveActivity opens it once this is done).
        for (p in listOf(android.Manifest.permission.RECORD_AUDIO, "android.permission.POST_NOTIFICATIONS"))
            runCatching { dpm.setPermissionGrantState(admin, c.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }
        prefs(c).edit().putLong("owner_at", System.currentTimeMillis()).apply()
        dropOldDeviceControl(c)
    }

    /**
     * The old display's device-control service off: it draws the assistant's button in its own overlay window, so left
     * on, the tablet shows two. The old display switches itself off at the handover; this is in case it switched itself
     * on again since (it starts, until it's removed), from each watchdog tick too. Needs WRITE_SECURE_SETTINGS
     * (move-tablet.sh grants it).
     */
    fun dropOldDeviceControl(c: Context) {
        val old = BuildConfig.MOVED_FROM.takeIf { it.isNotEmpty() } ?: return
        runCatching {
            val cr = c.contentResolver
            val key = android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            val cur = android.provider.Settings.Secure.getString(cr, key) ?: return
            val kept = cur.split(':').filter { it.isNotBlank() && !it.startsWith("$old.shell/") }
            if (kept.size != cur.split(':').count { it.isNotBlank() }) {
                android.provider.Settings.Secure.putString(cr, key, kept.joinToString(":"))
                Log.i(TAG, "switched $old.shell's device control off")
            }
        }.onFailure { Log.w(TAG, "switching $old.shell's device control off: $it") }
    }

    /**
     * From the display's watchdog, once it's the owner: step 4 (the assistant's home folder, once the new assistant's
     * app is bound: before its runtime arrives too, which keeps the home folder), then step 5 (removing the old apps, a day after a healthy start, so the old display stays as a
     * copy of everything for a while).
     */
    private val ticking = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var calendarsNext = 0L

    fun tick(c: Context, healthy: Boolean) {
        if (BuildConfig.MOVED_FROM.isEmpty() || !ticking.compareAndSet(false, true)) return // a step can take minutes
        try { step(c, healthy) } finally { ticking.set(false) }
    }

    private fun step(c: Context, healthy: Boolean) {
        val old = BuildConfig.MOVED_FROM
        val p = prefs(c)
        if (!p.contains("moved_at") || !dpm(c).isDeviceOwnerApp(c.packageName)) return
        dropOldDeviceControl(c)
        // Moved before the calendar links came over (or the old display didn't answer then): ask it again while it's
        // here, once it can say (move-tablet.sh --old-again puts a build that can on), and only if this one has none.
        if (!p.getBoolean("calendars_from_old", false) && installed(c, fromPkg!!) && System.currentTimeMillis() > calendarsNext) {
            calendarsNext = System.currentTimeMillis() + 10 * 60_000L
            CalendarLinks.init(c)
            if (CalendarLinks.list().isNotEmpty()) p.edit().putBoolean("calendars_from_old", true).apply()
            else calendarLinksFromOld(c)?.let { n -> p.edit().putBoolean("calendars_from_old", true).apply(); if (n > 0) thread { CalendarLinks.sync() } }
        }
        if (!healthy) { p.edit().remove("healthy_since").apply(); return }
        val since = p.getLong("healthy_since", 0L).takeIf { it > 0 } ?: System.currentTimeMillis().also { p.edit().putLong("healthy_since", it).apply() }
        val after = p.getLong("remove_after_ms", 24 * 3600_000L)
        if (System.currentTimeMillis() - since < after) return
        removeOld(c, old)
    }

    private fun removeOld(c: Context, old: String) {
        val pi = c.packageManager.packageInstaller
        val admin = ComponentName(c, AdminReceiver::class.java)
        @Suppress("DEPRECATION") val all = c.packageManager.getInstalledPackages(PackageManager.MATCH_UNINSTALLED_PACKAGES)
        val pkgs = all.map { it.packageName }.filter { it.startsWith("$old.") }
        if (pkgs.isEmpty()) return
        // The old display kept its assistant's app from being stopped or removed; that came over with the tablet. An
        // old app that was hidden is shown again to be removed.
        runCatching {
            val kept = dpm(c).getUserControlDisabledPackages(admin)
            if (kept.any { it in pkgs }) dpm(c).setUserControlDisabledPackages(admin, kept - pkgs.toSet())
        }
        for (pkg in pkgs) runCatching { if (dpm(c).isApplicationHidden(admin, pkg)) dpm(c).setApplicationHidden(admin, pkg, false) }
        for (pkg in pkgs.sortedBy { it == "$old.shell" }) runCatching { // the old display last
            val i = Intent(c, MainActivity::class.java).setAction("removed")
            pi.uninstall(pkg, android.app.PendingIntent.getActivity(c, pkg.hashCode(), i, android.app.PendingIntent.FLAG_IMMUTABLE).intentSender)
            Log.i(TAG, "removing $pkg")
        }.onFailure { Log.w(TAG, "removing $pkg: $it") }
    }
}

/** The new display, before it's the tablet's owner: moves the family's things over (Move.takeOver), then starts. */
class MoveActivity : Activity() {
    @Volatile private var running = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A phone turns upright too (the manifest keeps tablets sideways, as they always were): Calm.compact.
        if (dev.openhouse.ui.Calm.compact(this)) requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        val text = TextView(this).apply {
            textSize = 30f; setTextColor(Color.rgb(29, 28, 26)); gravity = Gravity.CENTER; setBackgroundColor(Color.rgb(253, 250, 243))
            text = "Moving to Opie…"
        }
        setContentView(text)
        if (!Move.takeOverNeeded(this)) return done()
        if (running) return
        running = true
        thread(name = "move") {
            val r = runCatching { Move.takeOver(this) { s -> runOnUiThread { text.text = s } } }
            r.exceptionOrNull()?.let { Log.e(Move.TAG, "the move stopped", it) }
            runOnUiThread {
                if (r.isSuccess) done()
                else { text.text = "Couldn't move to Opie. The display is as it was."; text.postDelayed({ finish() }, 8000) }
            }
        }
    }

    private fun done() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }
}

/**
 * The old display's end (built with -Popenhouse.moveTo): answers only the new display, signed with the release key.
 *   call prepare   stop the runtime
 *   open calendar-links  the family's calendar links (JSON), decrypted with this app's key
 *   open inventory the family folder's files and their sizes (JSON)
 *   open data      a tar of the app's data folder (Move.PARTS without Move.SKIP)
 *   call handover  transferOwnership to the new display's admin
 *   call abort     start again as before
 */
class MoveOut : ContentProvider() {
    override fun onCreate() = true

    private fun allowed(): Boolean {
        val c = context ?: return false
        val to = Move.toPkg ?: return false
        val caller = c.packageManager.getNameForUid(Binder.getCallingUid())
        return caller == to && Move.signedByUs(c, to)
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val c = context ?: return null
        if (!allowed()) { Log.w(Move.TAG, "refused $method from uid ${Binder.getCallingUid()}"); return Bundle().apply { putBoolean("ok", false); putString("error", "not allowed") } }
        val id = Binder.clearCallingIdentity()
        try {
            return runCatching { answer(c, method) }.getOrElse { e -> Log.e(Move.TAG, method, e); Bundle().apply { putBoolean("ok", false); putString("error", e.message) } }
        } finally { Binder.restoreCallingIdentity(id) }
    }

    private fun answer(c: Context, method: String): Bundle = Bundle().apply {
        val p = Move.prefs(c)
        when (method) {
            "prepare" -> {
                p.edit().putBoolean("moving", true).apply()
                Runtime.init(c); Runtime.stopAll()
                Thread.sleep(1500); Runtime.stopAll() // anything the supervisor started meanwhile
                File(c.filesDir, "move").deleteRecursively() // where the calendar links went until 2026-11-20
                putBoolean("ok", true)
            }
            "handover" -> {
                val dpm = c.getSystemService(DevicePolicyManager::class.java)
                val target = ComponentName(Move.toPkg!!, AdminReceiver::class.java.name)
                p.edit().putBoolean("handed_over", true).apply()
                runCatching { dpm.transferOwnership(ComponentName(c, AdminReceiver::class.java), target, PersistableBundle()) }
                    .onFailure { p.edit().putBoolean("handed_over", false).apply(); throw it }
                // Device control is the new display's now: off here for good, so this one's assistant button goes.
                c.getSharedPreferences("shell", Context.MODE_PRIVATE).edit().putBoolean("device_control", false).apply()
                runCatching {
                    val cr = c.contentResolver
                    val key = android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
                    val cur = android.provider.Settings.Secure.getString(cr, key) ?: ""
                    android.provider.Settings.Secure.putString(cr, key, cur.split(':').filter { it.isNotBlank() && !it.startsWith("${c.packageName}/") }.joinToString(":"))
                }.onFailure { Log.w(Move.TAG, "device control off: $it") }
                DeviceAccess.instance?.let { a -> android.os.Handler(android.os.Looper.getMainLooper()).post { runCatching { a.disableSelf() } } }
                File(c.filesDir, "move").deleteRecursively()
                Log.i(Move.TAG, "handed the tablet over to ${Move.toPkg}")
                // Nothing of this display runs on: its calendar reads (they'd post to the new display's bridge), its
                // runtime, its screen. Then the process goes, once this answer is back; it starts again only for the
                // new display's calls here (MainActivity steps aside at once).
                CalendarLinks.stop(); PhotoAlbums.stop(); PhotoShare.stop()
                runCatching { Runtime.init(c); Runtime.stopAll() }
                MainActivity.live?.let { a -> a.runOnUiThread { a.finish() } }
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ android.os.Process.killProcess(android.os.Process.myPid()) }, 3000)
                putBoolean("ok", true)
            }
            "abort" -> {
                p.edit().putBoolean("moving", false).apply()
                File(c.filesDir, "move").deleteRecursively()
                MainActivity.live?.let { a -> a.runOnUiThread { a.recreate() } }
                putBoolean("ok", true)
            }
            else -> { putBoolean("ok", false); putString("error", "unknown") }
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val c = context ?: return null
        if (!allowed() || mode != "r") throw SecurityException("not allowed")
        val id = Binder.clearCallingIdentity()
        try {
            val (read, write) = ParcelFileDescriptor.createPipe()
            when (uri.lastPathSegment) {
                "data" -> thread(name = "move-out") { sendData(c, write) }
                "inventory" -> thread(name = "move-out") {
                    val fam = JSONObject(); Move.inventory(File(c.applicationInfo.dataDir, Move.FAMILY)).forEach { (k, v) -> fam.put(k, v) }
                    runCatching { ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write(fam.toString().toByteArray()) } }
                }
                "calendar-links" -> thread(name = "move-out") { // decrypted with this app's key, straight into the pipe
                    CalendarLinks.init(c)
                    val links = org.json.JSONArray(CalendarLinks.list().map { JSONObject().put("who", it.who).put("url", it.url) }).toString()
                    runCatching { ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write(links.toByteArray()) } }
                }
                else -> { read.close(); write.close(); return null }
            }
            return read
        } finally { Binder.restoreCallingIdentity(id) }
    }

    private fun sendData(c: Context, write: ParcelFileDescriptor) {
        val data = File(c.applicationInfo.dataDir)
        val t0 = System.currentTimeMillis()
        // Everything in PARTS but what's skipped: the tops of the skipped paths are listed one level down.
        val items = Move.PARTS.flatMap { part ->
            val f = File(data, part)
            when {
                !f.exists() -> emptyList()
                Move.SKIP.none { it.startsWith("$part/") } -> listOf(part)
                else -> f.list().orEmpty().map { "$part/$it" }.filter { it !in Move.SKIP }
            }
        }
        val p = ProcessBuilder(listOf("/system/bin/tar", "-cf", "-", "-C", data.path) + items).redirectError(File(c.cacheDir, "move-tar.log")).start()
        p.outputStream.close()
        val n = runCatching { ParcelFileDescriptor.AutoCloseOutputStream(write).use { o -> p.inputStream.use { it.copyTo(o, 1 shl 16) } } }
        Log.i(Move.TAG, "sent ${n.getOrNull()?.let { it shr 20 } ?: "?"} MB in ${System.currentTimeMillis() - t0} ms (tar ${p.waitFor()}${n.exceptionOrNull()?.let { ", $it" } ?: ""})")
    }

    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
}
