package dev.openhouse.shell

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import android.widget.ImageView
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

/**
 * The household's shared albums: iCloud shared albums with a public website, kept in step with the household's photos
 * (the Photos app, Today's photo, the idle screen). Anyone with an album's link can see it, so the links are kept
 * here like the calendar links ([CalendarLinks]): in the no-backup folder, sealed with a Keystore key, never in the
 * household (which the agent reads) and never logged.
 *
 * Every 30 minutes (sooner while an album is still coming in) the shell asks Apple what's in each album (the call
 * that needs the link) and hands Apple's answer to the bridge (POST /house/album/stream), which says which photos are
 * new; it asks Apple for those photos' addresses (short-lived, without the link) and hands them over too
 * (/house/album/assets): the bridge fetches them itself and keeps the album (bridge/photo-albums.js).
 *
 * Added behind the PIN (Settings' Photo albums, or the Photos app's "Add an iCloud album"), from a
 * phone ([Handoff]), or from the computer or the assistant ([offer], DeviceServer /album) with a yes on the tablet.
 */
object PhotoAlbums {
    private const val TAG = "PhotoAlbums"
    private const val ALIAS = "album-links"
    private val main = Handler(Looper.getMainLooper())
    private lateinit var ctx: Context
    private var bridge: () -> String = { "http://127.0.0.1:8787" }
    @Volatile private var running = false
    @Volatile private var stopped = false

    class Link(val id: String, val url: String)
    private class Said(m: String) : Exception(m) // safe to show: never has the link in it

    const val HELP = "In Photos on an iPhone or Mac, make a shared album just for this screen (one called Kitchen works well) " +
        "and add photos to it. Then in the album's sharing settings, turn on its public link (Public Website) and copy it. " +
        "Anyone with the link can see the album, so the tablet keeps it sealed. New photos show up here within half an hour."

    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }
    fun stop() { stopped = true; main.removeCallbacksAndMessages(null) }

    fun start(c: Context, bridgeUrl: () -> String) {
        ctx = c.applicationContext; bridge = bridgeUrl
        main.removeCallbacksAndMessages(null)
        if (stopped || Move.handedOver(c)) return
        main.postDelayed({ sync() }, 40_000) // the bridge is still starting (and the calendars go first)
    }

    // --- storage (as CalendarLinks) ---------------------------------------------------------------
    private val file get() = File(ctx.noBackupFilesDir, "album-links")

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }

    @Synchronized fun list(): List<Link> = runCatching {
        val b = file.readBytes()
        val plain = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12)) }.doFinal(b, 12, b.size - 12)
        val a = JSONArray(String(plain))
        (0 until a.length()).map { a.getJSONObject(it).let { j -> Link(j.getString("id"), j.getString("url")) } }
    }.getOrDefault(emptyList())

    @Synchronized private fun save(links: List<Link>) {
        val plain = JSONArray(links.map { JSONObject().put("id", it.id).put("url", it.url) }).toString().toByteArray()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(plain))
        tmp.renameTo(file)
    }

    /** Kept (once per album); its id, which the bridge knows the album by. */
    @Synchronized fun add(url: String): String? {
        val u = AlbumLink.clean(url) ?: return null
        list().firstOrNull { it.url == u }?.let { return it.id }
        val id = UUID.randomUUID().toString().replace("-", "").take(10)
        save(list() + Link(id, u)); return id
    }

    /** Taken off: the link, and (in the bridge) the album and the photos that came from it. */
    fun remove(id: String) {
        synchronized(this) { save(list().filter { it.id != id }) }
        post("/house/album/stream", JSONObject().put("source", id).put("gone", true))
    }

    // --- reading the albums ------------------------------------------------------------------------
    fun sync() {
        if (stopped || running) return
        running = true
        thread(name = "albums") {
            var more = false
            try {
                for (l in list()) more = syncOne(l) || more
            } finally {
                running = false
                main.removeCallbacksAndMessages(null)
                if (!stopped) main.postDelayed({ sync() }, if (more) 90_000L else 30 * 60_000L)
            }
        }
    }

    /** One album: true if photos are still to come (the next look is soon). */
    private fun syncOne(l: Link): Boolean {
        AlbumLink.shareKey(l.url)?.let { return syncShared(l, it) }
        val token = AlbumLink.token(l.url) ?: return false
        var host = AlbumLink.host(token)
        val stream = try {
            var r = call(AlbumLink.webstream(host, token), """{"streamCtag":null}""")
            if (r.first == 330) { host = AlbumLink.movedTo(r.second)?.takeIf { AlbumLink.okHost(it) } ?: throw Said("Couldn't read the album"); r = call(AlbumLink.webstream(host, token), """{"streamCtag":null}""") }
            when (r.first) {
                200 -> r.second
                404 -> throw Said("The album isn't shared any more (its public website is off)")
                else -> throw Said("Couldn't read the album")
            }
        } catch (e: Exception) {
            val why = (e as? Said)?.message ?: "Couldn't reach iCloud"
            post("/house/album/stream", JSONObject().put("source", l.id).put("error", why))
            Log.i(TAG, "an album: $why")
            return false
        }
        val said = post("/house/album/stream", JSONObject().put("source", l.id).put("stream", stream))?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return true // the bridge isn't up
        val want = said.optJSONArray("want") ?: JSONArray()
        if (want.length() == 0) return false
        for (start in 0 until want.length() step 20) {
            val batch = JSONArray((start until minOf(want.length(), start + 20)).map { want.getString(it) })
            val r = runCatching { call(AlbumLink.assetUrls(host, token), JSONObject().put("photoGuids", batch).toString()) }.getOrNull() ?: break
            if (r.first != 200) break
            post("/house/album/assets", JSONObject().put("source", l.id).put("assets", r.second))
        }
        Log.i(TAG, "an album: ${want.length()} new, ${said.optInt("left") - want.length()} after that")
        return said.optInt("left") > want.length()
    }

    /**
     * A new-style album (iOS 27, CloudKit): the key resolved to the album's zone and a short-lived public token, then
     * its records a page at a time (oldest first), trimmed to what the bridge reads. The bridge fetches the new photos
     * itself, from the addresses in the records. True if photos are still to come.
     */
    private fun syncShared(l: Link, key: String): Boolean {
        val ck = try {
            val r = call(AlbumLink.resolveUrl(key), JSONObject().put("shortGUIDs", JSONArray().put(JSONObject().put("value", key))).toString(), "https://photos.icloud.com")
            val res = if (r.first == 200) runCatching { JSONObject(r.second).getJSONArray("results").getJSONObject(0) }.getOrNull() else null
            val access = res?.optJSONObject("anonymousPublicAccess")
            if (res == null || res.has("serverErrorCode") || access == null) throw Said("The album isn't shared any more, or its link has run out")
            val partition = access.optString("databasePartition").takeIf { AlbumLink.okPartition(it) } ?: throw Said("Couldn't read the album")
            val fields = res.optJSONObject("share")?.optJSONObject("fields")
            val records = JSONArray()
            var rank = 0
            for (page in 0 until 30) { // up to 3,000 photos (the bridge keeps the newest 600)
                val body = JSONObject().put("query", JSONObject().put("recordType", "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted").put("filterBy", JSONArray()
                        .put(JSONObject().put("fieldName", "startRank").put("comparator", "EQUALS").put("fieldValue", JSONObject().put("value", rank).put("type", "INT64")))
                        .put(JSONObject().put("fieldName", "direction").put("comparator", "EQUALS").put("fieldValue", JSONObject().put("value", "ASCENDING").put("type", "STRING")))))
                    .put("zoneID", res.getJSONObject("zoneID")).put("resultsLimit", 200)
                val q = call(AlbumLink.queryUrl(partition, key, access.getString("token")), body.toString(), "https://photos.icloud.com")
                if (q.first != 200) throw Said("Couldn't read the album")
                val list = JSONObject(q.second).optJSONArray("records") ?: throw Said("Couldn't read the album")
                var assets = 0
                for (i in 0 until list.length()) {
                    val rec = list.getJSONObject(i)
                    val type = rec.optString("recordType")
                    if (type != "CPLAsset" && type != "CPLMaster") continue
                    if (type == "CPLAsset") assets++
                    val f = rec.optJSONObject("fields") ?: continue
                    val kept = JSONObject(); for (k in f.keys()) if (AlbumLink.keepField(k)) kept.put(k, f.get(k))
                    records.put(JSONObject().put("recordType", type).put("recordName", rec.optString("recordName")).put("fields", kept))
                }
                if (assets == 0) break
                rank += assets
            }
            JSONObject().put("title", fields?.optJSONObject("cloudkit.title")?.optString("value") ?: "").put("expires", fields?.optJSONObject("expiryDate")?.optLong("value") ?: 0L).put("records", records)
        } catch (e: Exception) {
            val why = (e as? Said)?.message ?: "Couldn't reach iCloud"
            post("/house/album/stream", JSONObject().put("source", l.id).put("error", why))
            Log.i(TAG, "an album: $why")
            return false
        }
        val said = post("/house/album/stream", JSONObject().put("source", l.id).put("ck", ck))?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return true
        val want = said.optJSONArray("want")?.length() ?: 0
        Log.i(TAG, "an album: $want new, ${said.optInt("left") - want} after that")
        return said.optInt("left") > want
    }

    /** A POST to Apple (the link's token is in the address): status and body, at most 20 MB. */
    private fun call(url: String, body: String, origin: String = "https://www.icloud.com"): Pair<Int, String> {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; doOutput = true; connectTimeout = 15_000; readTimeout = 30_000; instanceFollowRedirects = false
            setRequestProperty("Content-Type", "text/plain;charset=UTF-8")
            setRequestProperty("Origin", origin)
            setRequestProperty("User-Agent", "openhouse-photos/0.1")
        }
        try {
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            val s = (if (code >= 400) c.errorStream else c.inputStream) ?: return code to ""
            val bytes = s.use { i -> val o = java.io.ByteArrayOutputStream(); val buf = ByteArray(16384); var n = 0
                while (true) { val r = i.read(buf); if (r < 0) break; n += r; if (n > 20_000_000) throw Said("Too big"); o.write(buf, 0, r) }; o.toByteArray() }
            val text = String(bytes, Charsets.UTF_8)
            // A 330's new home is in its body, sometimes only in the header.
            return code to (if (code == 330 && AlbumLink.movedTo(text) == null) c.getHeaderField("X-Apple-MMe-Host")?.let { """{"X-Apple-MMe-Host":"$it"}""" } ?: text else text)
        } finally { c.disconnect() }
    }

    private fun post(path: String, body: JSONObject): String? = dev.openhouse.ui.BridgeClient.post(bridge() + path, body.toString(), readMs = 60_000)

    /** The albums as the bridge has them: link id -> (name, a line about it). */
    private fun albums(): Map<String, Pair<String, String>> = runCatching {
        val h = JSONObject(dev.openhouse.ui.BridgeClient.getText(bridge() + "/house"))
        val names = h.optJSONArray("albums") ?: JSONArray()
        val linked = h.optJSONArray("linked") ?: JSONArray()
        (0 until linked.length()).associate { i ->
            val s = linked.getJSONObject(i)
            val name = (0 until names.length()).map { names.getJSONObject(it) }.firstOrNull { it.optString("id") == s.optString("album") }?.optString("name") ?: "A shared album"
            val n = s.optInt("photos")
            val line = when {
                s.optString("status") == "error" -> s.optString("error", "Couldn't read the album")
                s.optInt("coming") > 0 -> "$n photos, ${s.optInt("coming")} more coming"
                else -> if (n == 1) "1 photo" else "$n photos"
            }
            s.optString("id") to (name to line)
        }
    }.getOrDefault(emptyMap())

    // --- Settings' screens ------------------------------------------------------------------
    /** The linked albums (tap one to take it off) and adding one. Only reached through the PIN. */
    fun manage(a: Activity, immersive: () -> Unit) {
        thread {
            val links = list(); val known = albums()
            main.post {
                val rows = links.map { l -> known[l.id]?.let { "${it.first} · ${it.second}" } ?: "A shared album · not read yet" }
                CalmDialog(a).setTitle("Photo albums")
                    .apply { if (links.isEmpty()) setMessage("None yet.") }
                    .setItems(rows.toTypedArray()) { _, i ->
                        val l = links[i]
                        CalmDialog(a).setTitle("Take ${known[l.id]?.first ?: "this album"} off?").setMessage("Its photos come off the tablet too. They stay in iCloud.")
                            .setPositiveButton("Take it off") { _, _ -> thread { remove(l.id) } }.setNegativeButton("Keep it", null).show().also { immersive() }
                    }
                    .setPositiveButton("Add an iCloud album") { _, _ -> add(a, immersive) }
                    .setNeutralButton("Phones") { _, _ -> PhotoShare.show(a, immersive) }
                    .setNegativeButton("Back", null).show().also { immersive() }
            }
        }
    }

    /** Paste the album's link here (or send it from a phone). Behind the PIN. */
    fun add(a: Activity, immersive: () -> Unit) {
        val link = Calm.field(a, "https://photos.icloud.com/shared/album/…").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            runCatching { (a.getSystemService(android.content.ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(a)?.toString())?.let { AlbumLink.clean(it) }?.let { setText(it) } }
        }
        val col = Calm.column(a, 12).apply { addView(link); addView(Calm.caption(a, HELP)) }
        CalmDialog(a).setTitle("Add an iCloud album").setView(col).setWidth(760f)
            .setPositiveButton("Add") { _, _ ->
                val u = AlbumLink.clean(link.text.toString())
                if (u == null) { notAlbum(a, immersive); return@setPositiveButton }
                keep(a, u, immersive)
            }
            .setNeutralButton("From a phone") { _, _ -> addFromPhone(a, immersive) }
            .setNegativeButton("Cancel", null).show().also { immersive() }
    }

    private fun notAlbum(a: Activity, immersive: () -> Unit) =
        CalmDialog(a).setTitle("That isn't a shared album link.").setMessage("It starts https://photos.icloud.com/shared/album/ or https://www.icloud.com/sharedalbum/#\n\n$HELP").setPositiveButton("OK", null).show().also { immersive() }

    private fun keep(a: Activity, url: String, immersive: () -> Unit) {
        thread { add(url); sync() }
        CalmDialog(a).setTitle("Added the album").setMessage("Its photos come in over the next few minutes, into Photos.").setPositiveButton("OK", null).show().also { immersive() }
    }

    /** A link from the computer (the workshop) or the assistant: kept only after a yes and PIN here. */
    fun offer(a: Activity, withPin: (() -> Unit) -> Unit, url: String, from: String, immersive: () -> Unit, done: (Boolean) -> Unit) {
        var answered = false
        val finish = { yes: Boolean -> if (!answered) { answered = true; done(yes) } }
        CalmDialog(a).setTitle("Add an iCloud shared album?")
            .setMessage(listOfNotNull("Its photos show in Photos and when the screen is idle.", from.takeIf { it.isNotBlank() }?.let { "Sent by $it." }).joinToString("\n"))
            .setPositiveButton("Add") { _, _ -> if (DeviceServer.personOnly("Adding an album someone sent")) { finish(false); return@setPositiveButton }; withPin { thread { add(url); sync() }; finish(true) } }
            .setNegativeButton("Not now") { _, _ -> finish(false) }
            .setOnDismissListener { main.postDelayed({ if (!answered) finish(false) }, 95_000) }
            .show().also { immersive() }
    }

    private fun addFromPhone(a: Activity, immersive: () -> Unit) {
        var dialog: android.app.Dialog? = null
        var got: JSONObject? = null
        val info = JSONObject().put("title", "Add an iCloud album").put("field", "Shared album link").put("hint", "https://photos.icloud.com/shared/album/…")
            .put("help", HELP).put("done", "Sent. Check the tablet.")
        val h = Handoff(a, info, onSecret = { got = it; dialog?.dismiss() }, onEnd = { if (got == null) dialog?.dismiss() })
        if (!h.start()) { CalmDialog(a).setTitle("Connect the tablet to Wi-Fi first.").setPositiveButton("OK", null).show().also { immersive() }; return }
        val qr = ImageView(a).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
        val col = Calm.qr(a, qr, Calm.caption(a, "Scan with a phone on this Wi-Fi, and paste the album's link there."), 360) { Handoff.share(a, h.url!!) }
        dialog = CalmDialog(a).setTitle("Add an iCloud album").setView(col).setNegativeButton("Cancel", null)
            .setOnDismissListener {
                h.stop()
                got?.let { msg ->
                    val u = AlbumLink.clean(msg.optString("value"))
                    if (u == null) notAlbum(a, immersive)
                    else CalmDialog(a).setTitle("Add this album?").setMessage("A shared album from iCloud. Its photos show in Photos.")
                        .setPositiveButton("Add") { _, _ -> keep(a, u, immersive) }.setNegativeButton("Cancel", null).show().also { immersive() }
                }
            }.show().also { immersive() }
    }
}
