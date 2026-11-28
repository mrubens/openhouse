package dev.openhouse.shell

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.text.InputType
import android.util.Log
import android.widget.CheckBox
import android.widget.ImageView
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

/**
 * The household's Home Assistant (bridge/devices/drivers/homeassistant.js): its address and a long-lived access token,
 * kept here sealed with a key in Android's keystore, in the shell's no-backup files, as [OwnKey] keeps the OpenAI key:
 * never in the bridge's files, a backup or a report, never said to or by Opie. The bridge asks [forward] for one call
 * at a time (DeviceServer /homeassistant), which goes only to that address, only if [refuse] allows it (the same rules
 * as bridge/devices/ha-rules.js, which the keeper uses): lights, switches, scenes and media players to use, thermostats
 * to read; locks, garage doors and covers, alarms and cameras never, nor a scene that sets one. Connecting, choosing
 * what Opie may use and disconnecting are an adult's (behind the PIN); the token is typed here or sent from a phone on
 * the Wi-Fi ([Handoff]), and putting it in is a person's own tap.
 */
object HomeAssistant {
    private const val TAG = "HomeAssistant"
    private const val ALIAS = "openhouse-home-assistant"

    // --- the rules (bridge/devices/ha-rules.js: keep the two the same) ----------------------------------------------
    /** domain -> service -> the data it may carry beside entity_id. */
    val CONTROL: Map<String, Map<String, List<String>>> = mapOf(
        "light" to mapOf("turn_on" to listOf("brightness_pct"), "turn_off" to emptyList()),
        "switch" to mapOf("turn_on" to emptyList(), "turn_off" to emptyList()),
        "scene" to mapOf("turn_on" to emptyList()),
        "media_player" to mapOf("turn_on" to emptyList(), "turn_off" to emptyList(), "media_play" to emptyList(), "media_pause" to emptyList(),
            "media_next_track" to emptyList(), "media_previous_track" to emptyList(), "volume_set" to listOf("volume_level"), "volume_up" to emptyList(),
            "volume_down" to emptyList(), "volume_mute" to listOf("is_volume_muted")),
    )
    val SEEN = CONTROL.keys + "climate"
    private val ENTITY = Regex("^([a-z0-9_]{1,60})\\.[a-z0-9_]{1,200}$")
    fun domainOf(e: String?): String? = e?.let { ENTITY.matchEntire(it)?.groupValues?.get(1) }
    private fun seen(e: String?) = domainOf(e) in SEEN
    private fun valueOk(k: String, v: Any?): Boolean = when (k) {
        "brightness_pct" -> v is Int && v in 0..100
        "volume_level" -> v is Number && v.toDouble() in 0.0..1.0
        "is_volume_muted" -> v is Boolean
        else -> false
    }

    /** null when the call is one of these, else why not. */
    fun refuse(method: String, path: String, body: JSONObject?): String? {
        val no = "not a call this route makes"
        if (method == "GET") {
            if (path == "/api/" || path == "/api/config" || path == "/api/states") return null
            val m = Regex("^/api/states/([a-z0-9_.]{3,262})$").matchEntire(path) ?: return no
            return if (seen(m.groupValues[1])) null else no
        }
        if (method != "POST") return no
        val m = Regex("^/api/services/([a-z0-9_]{1,60})/([a-z0-9_]{1,60})$").matchEntire(path) ?: return no
        val keys = CONTROL[m.groupValues[1]]?.get(m.groupValues[2]) ?: return no
        body ?: return no
        val e = body.opt("entity_id") as? String ?: return no
        if (domainOf(e) != m.groupValues[1]) return no
        for (k in body.keys()) if (k != "entity_id" && !(k in keys && valueOk(k, body.opt(k)))) return no
        return null
    }

    /** A scene whose list of what it sets is known and only names what can be used. */
    fun sceneOk(state: JSONObject?): Boolean {
        val l = state?.optJSONObject("attributes")?.optJSONArray("entity_id") ?: return false
        if (l.length() == 0) return false
        return (0 until l.length()).all { val d = domainOf(l.optString(it)); d != null && d in CONTROL && d != "scene" }
    }

    /** What Home Assistant answered, with nothing in it of what can't be reached. */
    fun shown(path: String, text: String): Any? {
        fun states(a: JSONArray?) = JSONArray().apply { a?.let { for (i in 0 until it.length()) it.optJSONObject(i)?.takeIf { s -> seen(s.optString("entity_id")) }?.let { s -> put(s) } } }
        val v = runCatching { org.json.JSONTokener(text).nextValue() }.getOrNull()
        return when {
            path == "/api/states" -> states(v as? JSONArray)
            path == "/api/config" -> JSONObject().put("location_name", (v as? JSONObject)?.opt("location_name") as? String).put("version", (v as? JSONObject)?.opt("version") as? String)
            path.startsWith("/api/services/") -> states(v as? JSONArray ?: (v as? JSONObject)?.optJSONArray("changed_states"))
            path.startsWith("/api/states/") -> (v as? JSONObject)?.takeIf { seen(it.optString("entity_id")) }
            path == "/api/" -> JSONObject().put("message", (v as? JSONObject)?.optString("message").orEmpty())
            else -> null
        }
    }

    /** An address someone typed: http(s), no path, user or query; just an address gets Home Assistant's own port. */
    fun cleanUrl(raw: String): String? {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) return null
        val bare = !Regex("^[a-zA-Z]+://.*").matches(s)
        if (bare) s = "http://$s"
        val u = runCatching { URL(s) }.getOrNull() ?: return null
        if (u.protocol !in setOf("http", "https") || u.userInfo != null || u.query != null || u.ref != null || (u.path != "" && u.path != "/") || u.host.isNullOrEmpty()) return null
        val port = if (u.port != -1) ":${u.port}" else if (bare) ":8123" else ""
        return "${u.protocol}://${u.host.lowercase()}$port"
    }
    /** A long-lived access token as Home Assistant makes them (a JWT). */
    fun cleanToken(raw: String): String? = raw.trim().takeIf { it.length <= 2000 && Regex("^[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}$").matches(it) }

    // --- kept, sealed ---------------------------------------------------------------------------------------------
    data class Kept(val url: String, val token: String)
    private lateinit var ctx: Context
    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }
    private val file get() = File(ctx.noBackupFilesDir, "home-assistant")
    private fun secret(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    @Synchronized private fun read(): Kept? = if (!::ctx.isInitialized) null else runCatching {
        val b = file.readBytes()
        val j = JSONObject(String(Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, b, 0, 12)) }.doFinal(b, 12, b.size - 12)))
        Kept(j.getString("url"), j.getString("token"))
    }.getOrNull()
    @Synchronized private fun write(k: Kept) {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(JSONObject().put("url", k.url).put("token", k.token).toString().toByteArray()))
        tmp.renameTo(file)
    }
    @Synchronized private fun forget() { if (::ctx.isInitialized) file.delete() }

    // --- calls ----------------------------------------------------------------------------------------------------
    private fun go(k: Kept, method: String, path: String, body: JSONObject?): Pair<Int, String> {
        val c = URL(k.url + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method; c.connectTimeout = 8_000; c.readTimeout = 15_000; c.instanceFollowRedirects = false // only the address that was typed
            c.setRequestProperty("authorization", "Bearer ${k.token}"); c.setRequestProperty("content-type", "application/json")
            if (method == "POST") { c.doOutput = true; c.outputStream.use { it.write((body ?: JSONObject()).toString().toByteArray()) } }
            val code = c.responseCode
            val t = runCatching { (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() }.getOrNull().orEmpty()
            return code to t.replace(k.token, "") // (an answer with the token in it, however it got there: taken out)
        } finally { c.disconnect() }
    }

    /** Does Home Assistant at that address take that token? null when it does, else why not. */
    fun check(k: Kept): String? = runCatching {
        when (val s = go(k, "GET", "/api/", null).first) {
            200 -> null
            401, 403 -> "Home Assistant didn't accept that token. Make a new one and copy all of it."
            else -> "That address answered, but not as Home Assistant does ($s). Check the address."
        }
    }.getOrElse { Log.d(TAG, "check: ${it.javaClass.simpleName}"); "Couldn't reach Home Assistant at that address. Check it, and that it's on this Wi-Fi." }

    /** The bridge's call (DeviceServer /homeassistant {method, path, body}): checked, sent with the token, its answer
     *  cut down to what may be seen. The token never comes back. */
    fun forward(b: JSONObject): Pair<Int, String> {
        val method = b.optString("method", "GET").uppercase(); val path = b.optString("path"); val body = b.optJSONObject("body")
        if (refuse(method, path, body) != null) return 403 to JSONObject().put("error", "not a call this route makes").toString()
        val k = read() ?: return 409 to JSONObject().put("error", "no_homeassistant").toString()
        return runCatching {
            if (method == "POST" && domainOf(body!!.optString("entity_id")) == "scene") {
                val (s, t) = go(k, "GET", "/api/states/${body.optString("entity_id")}", null)
                if (s != 200) return@runCatching (if (s == 401) 401 else 404) to JSONObject().put("error", if (s == 401) "ha_refused" else "not found").toString()
                if (!sceneOk(runCatching { JSONObject(t) }.getOrNull())) return@runCatching 403 to JSONObject().put("error", "scene_reaches_too_far").toString()
            }
            val (s, t) = go(k, method, path, body)
            when {
                s == 401 || s == 403 -> 401 to JSONObject().put("error", "ha_refused").toString()
                s >= 300 -> s to JSONObject().put("error", "home assistant answered $s").toString()
                else -> 200 to JSONObject().put("answer", shown(path, t) ?: JSONObject.NULL).toString()
            }
        }.getOrElse { 502 to JSONObject().put("error", "home assistant unreachable").toString() }
    }

    fun handle(path: String, b: JSONObject): Pair<Int, String> = when (path) {
        "/homeassistant/status" -> 200 to read().let { JSONObject().put("set", it != null).put("url", it?.url ?: JSONObject.NULL) }.toString()
        "/homeassistant" -> forward(b)
        "/homeassistant/remove" -> { forget(); thread { changed() }; 200 to """{"ok":true}""" }
        else -> 404 to ""
    }

    private fun bridge() = dev.openhouse.ui.Openhouse.bridgeUrl
    private fun changed() = runCatching { CloudSetup.post("${bridge()}/devices/homeassistant/changed", JSONObject()) }

    // --- the adult's screens --------------------------------------------------------------------------------------
    private const val HELP = "On Home Assistant, open your profile, then Security, and make a long-lived access token. Opie only uses the lights, switches, scenes and media players you choose here, and reads thermostats. It never reaches locks, garage doors, alarms or cameras."

    /** The Home Assistant's own row (Devices): connect it, or with it connected, choose what Opie may use or disconnect.
     *  [found]: its address from the scan, if it was found. Behind the PIN. */
    fun menu(act: MainActivity, found: String) = act.lock.withPin("Home Assistant") {
        val k = read()
        if (k == null) return@withPin connect(act, found)
        CalmDialog(act).setTitle("Home Assistant").setMessage(URL(k.url).host)
            .setItems(arrayOf("Choose what Opie may use", "Connect again", "Disconnect")) { _, i -> when (i) { 0 -> choose(act); 1 -> connect(act, found.ifEmpty { k.url }); else -> disconnect(act) } }
            .setNegativeButton("Back", null).show()
    }

    /** The address and token from a phone on this Wi-Fi (the QR code), or typed here. A person's own tap. */
    private fun connect(act: MainActivity, found: String) {
        if (DeviceServer.personOnly("Connecting Home Assistant")) return
        var dialog: android.app.Dialog? = null
        var got: JSONObject? = null
        val hint = found.ifEmpty { "http://192.168.1.20:8123" }
        val info = JSONObject().put("title", "Home Assistant").put("done", "Sent. Check the device.")
            .put("fields", JSONArray(listOf(JSONObject().put("id", "url").put("label", "Address").put("hint", hint).put("optional", found.isNotEmpty()),
                JSONObject().put("id", "token").put("label", "Long-lived access token").put("hint", "").put("secret", true))))
        val h = Handoff(act, info, minutes = 15, onSecret = { got = it; dialog?.dismiss() }, onEnd = { if (got == null) dialog?.dismiss() })
        if (!h.start()) return type(act, found, "")
        val qr = ImageView(act).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
        val col = Calm.column(act, 12).apply {
            gravity = android.view.Gravity.CENTER_HORIZONTAL
            addView(Calm.qr(act, qr, Calm.caption(act, "Scan with a phone on this Wi-Fi, then paste the token there."), 360) { Handoff.share(act, h.url!!) })
            addView(Calm.quiet(act, "Type it here instead") { dialog?.dismiss(); type(act, found, "") })
            addView(Calm.more(act, HELP))
        }
        dialog = CalmDialog(act).setTitle("Connect Home Assistant").setView(col).setNegativeButton("Cancel", null)
            .setOnDismissListener { h.stop(); got?.optJSONObject("fields")?.let { f -> use(act, f.optString("url").ifBlank { found }, f.optString("token")) } }.show()
    }

    private fun type(act: MainActivity, found: String, url: String) {
        val addr = Calm.field(act, found.ifEmpty { "Address" }, 22f).apply { setText(url); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val tok = Calm.field(act, "Long-lived access token", 22f).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val col = Calm.column(act, 10).apply { addView(addr); addView(tok) }
        CalmDialog(act).setTitle("Connect Home Assistant").setView(col).setWidth(760f).setMore(HELP)
            .setPositiveButton("Connect") { _, _ -> use(act, addr.text.toString().ifBlank { found }, tok.text.toString()) }
            .setNegativeButton("Cancel", null).show()
    }

    /** Checked, then kept and the bridge told (only that it changed); else why not. */
    private fun use(act: MainActivity, rawUrl: String, rawToken: String) {
        val url = cleanUrl(rawUrl) ?: return notYet(act, "That isn't Home Assistant's address (like http://192.168.1.20:8123).", rawUrl)
        val token = cleanToken(rawToken) ?: return notYet(act, "That isn't a Home Assistant token. It's one long line: copy all of it.", url)
        act.toast("Checking it…")
        thread {
            val k = Kept(url, token)
            val why = check(k)
            if (why == null) { write(k); changed() }
            act.runOnUiThread { if (why == null) choose(act) else notYet(act, why, url) }
        }
    }
    private fun notYet(act: MainActivity, why: String, url: String) {
        CalmDialog(act).setTitle("That didn't work").setMessage(why)
            .setPositiveButton("Try again") { _, _ -> type(act, "", url) }.setNegativeButton("Cancel", null).show()
    }

    /** What Opie may use: everything Home Assistant has that could be, each a tick. Changes go in on Done. */
    private fun choose(act: MainActivity) = thread {
        val j = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("${bridge()}/devices/homeassistant", 3000, 20000)) }.getOrNull()
        val things = j?.optJSONArray("things")
        act.runOnUiThread {
            if (things == null || things.length() == 0) {
                CalmDialog(act).setTitle("Home Assistant").setMessage(j?.optString("error")?.ifBlank { null } ?: "It has no lights, switches, scenes, media players or thermostats Opie could use.")
                    .setPositiveButton("Close", null).show(); return@runOnUiThread
            }
            val boxes = (0 until things.length()).mapNotNull { things.optJSONObject(it) }.map { t ->
                t.optString("entity") to CheckBox(act).apply { text = t.optString("name"); textSize = 20f; isChecked = t.optBoolean("picked") }
            }
            val was = boxes.associate { (e, b) -> e to b.isChecked }
            val col = Calm.column(act, 4).apply { boxes.forEach { addView(it.second) } }
            val scroll = android.widget.ScrollView(act).apply { addView(col) }
            CalmDialog(act).setTitle("What Opie may use").setView(scroll)
                .setPositiveButton("Done") { _, _ ->
                    val changes = boxes.filter { (e, b) -> was[e] != b.isChecked }.map { (e, b) -> e to b.isChecked }
                    thread { for ((e, on) in changes) CloudSetup.post("${bridge()}/devices/homeassistant/use", JSONObject().put("entity", e).put("use", on)); act.runOnUiThread { dev.openhouse.ui.Devices.load() } }
                }.setNegativeButton("Cancel", null).show()
        }
    }

    private fun disconnect(act: MainActivity) {
        CalmDialog(act).setTitle("Disconnect Home Assistant?").setMessage("Opie stops using it at once.")
            .setPositiveButton("Disconnect") { _, _ -> forget(); thread { changed() } }.setNegativeButton("Cancel", null).show()
    }
}
