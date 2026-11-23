package dev.openhouse.shell

import android.app.Activity
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import android.view.Gravity
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
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
 * The family's private calendar links. Whoever has one can read that calendar, so they're kept here in the shell,
 * not in the household (which the agent reads): in the app's no-backup folder, outside the runtime, sealed with a
 * key from the Android Keystore. The shell reads each link every 15 minutes and posts only what it says, and
 * whose it is, to the bridge (POST /calendar/feeds), which feeds the Calendar app and the assistant.
 *
 * Links are added from Settings with a phone ([Handoff]) and confirmed on the tablet. Links the bridge
 * kept before this are claimed from it (POST /calendar/claim) and dropped there.
 *
 * Never logged: not the links, not their hosts.
 */
object CalendarLinks {
    private const val TAG = "Calendars"
    private const val ALIAS = "calendar-links"
    private val main = Handler(Looper.getMainLooper())
    private lateinit var ctx: Context
    private var bridge: () -> String = { "http://127.0.0.1:8787" }
    @Volatile private var running = false

    class Link(val id: String, val who: String, val url: String)
    private class Said(m: String) : Exception(m) // an error that's safe to show: never has the link in it

    /** Only the stored links (Move.kt), without reading the calendars. */
    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }

    /** Reading stops for good in this process (the old display, after it handed the tablet over). */
    @Volatile private var stopped = false
    fun stop() { stopped = true; main.removeCallbacksAndMessages(null) }

    /** At launch: claim old links, read every calendar, and again every 15 minutes. */
    fun start(c: Context, bridgeUrl: () -> String) {
        ctx = c.applicationContext; bridge = bridgeUrl
        main.removeCallbacksAndMessages(null)
        if (stopped || Move.handedOver(c)) return // the old display, after the handover
        val tick = object : Runnable { override fun run() { sync(); main.postDelayed(this, 15 * 60_000L) } }
        main.postDelayed(tick, 20_000) // the bridge is still starting
    }

    // --- storage ---------------------------------------------------------------------------------
    private val file get() = File(ctx.noBackupFilesDir, "calendar-links")

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
        (0 until a.length()).map { a.getJSONObject(it).let { j -> Link(j.getString("id"), j.optString("who"), j.getString("url")) } }
    }.getOrDefault(emptyList())

    @Synchronized private fun save(links: List<Link>) {
        val plain = JSONArray(links.map { JSONObject().put("id", it.id).put("who", it.who).put("url", it.url) }).toString().toByteArray()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(plain))
        tmp.renameTo(file)
    }

    /** A calendar link as people paste it (webcal:// too), or null if it isn't one. */
    fun clean(raw: String): String? {
        val u = raw.trim().replace(Regex("^webcals?://", RegexOption.IGNORE_CASE), "https://")
        return u.takeIf { it.length <= 2000 && Regex("^https?://[^\\s/]+\\S*$", RegexOption.IGNORE_CASE).matches(it) }
    }

    @Synchronized fun add(who: String, url: String) {
        val u = clean(url) ?: return
        save(list().filter { it.url != u } + Link(UUID.randomUUID().toString().take(8), who.trim().take(40), u))
    }

    @Synchronized fun remove(id: String) = save(list().filter { it.id != id })

    fun label(who: String) = if (who.isBlank()) "A calendar" else "$who's calendar"

    // --- reading the calendars -----------------------------------------------------------------
    fun sync() {
        if (stopped || running) return
        running = true
        thread(name = "calendars") {
            try {
                claim()
                val feeds = JSONArray()
                for (l in list()) feeds.put(JSONObject().put("id", l.id).put("who", l.who).apply {
                    runCatching { put("ics", fetch(l.url)) }.onFailure { put("error", (it as? Said)?.message ?: "Couldn't read it") /* other messages can hold the link */ }
                })
                val ok = post("/calendar/feeds", JSONObject().put("feeds", feeds)) != null
                Log.i(TAG, "${feeds.length()} calendar(s) ${if (ok) "sent" else "not sent (bridge not up)"}")
                if (!ok) main.postDelayed(::sync, 60_000)
            } finally { running = false }
        }
    }

    /** Links the household kept before they moved here: take them, and the bridge forgets them. */
    private fun claim() {
        val a = post("/calendar/claim", JSONObject())?.let { runCatching { JSONObject(it).optJSONArray("calendars") }.getOrNull() } ?: return
        for (i in 0 until a.length()) a.optJSONObject(i)?.let { add(it.optString("who").takeIf { w -> w != "null" } ?: "", it.optString("url")) }
        if (a.length() > 0) Log.i(TAG, "moved ${a.length()} link(s) out of the household")
    }

    private fun fetch(url: String): String {
        var u = URL(url)
        repeat(5) {
            val c = (u.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000; readTimeout = 20_000; instanceFollowRedirects = false
                setRequestProperty("User-Agent", "openhouse-calendar/0.1")
            }
            val code = try { c.responseCode } catch (e: Exception) { throw Said("Couldn't reach it") }
            if (code in 300..399) { u = URL(u, c.getHeaderField("Location") ?: throw Said("HTTP $code")); c.disconnect(); return@repeat }
            if (code != 200) throw Said("HTTP $code")
            val bytes = c.inputStream.use { s -> val o = java.io.ByteArrayOutputStream(); val buf = ByteArray(16384); var n = 0
                while (true) { val r = s.read(buf); if (r < 0) break; n += r; if (n > 8_000_000) throw Said("Too big"); o.write(buf, 0, r) }; o.toByteArray() }
            return String(bytes, Charsets.UTF_8)
        }
        throw Said("Too many redirects")
    }

    private fun post(path: String, body: JSONObject): String? = runCatching {
        val c = dev.openhouse.ui.BridgeClient.open(bridge() + path)
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = 15_000
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        c.inputStream.bufferedReader().use { it.readText() }
    }.getOrNull()

    private fun familyNames(): List<String> = runCatching {
        val c = dev.openhouse.ui.BridgeClient.open(bridge() + "/household"); c.connectTimeout = 3000; c.readTimeout = 5000
        val a = JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optJSONArray("family") ?: JSONArray()
        (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("name")?.takeIf { n -> n.isNotBlank() } }
    }.getOrDefault(emptyList())

    // --- Settings' screens --------------------------------------------------------------
    /** The calendars (tap one to remove it), and adding one from a phone. Only reached through the PIN. */
    fun manage(a: Activity, immersive: () -> Unit) {
        val links = list()
        CalmDialog(a).setTitle("Calendars").apply { if (links.isEmpty()) setMessage("None yet.") }
            .setItems(links.map { label(it.who) }.toTypedArray()) { _, i ->
                val l = links[i]
                CalmDialog(a).setTitle("Remove ${label(l.who)}?")
                    .setPositiveButton("Remove") { _, _ -> thread { remove(l.id); sync() } }.setNegativeButton("Cancel", null).show().also { immersive() }
            }
            .setPositiveButton("Add a calendar") { _, _ -> add(a, immersive) }
            .setNegativeButton("Back", null).show().also { immersive() }
    }

    private const val HELP = "Google Calendar: Settings, your calendar, “Secret address in iCal format”. iCloud: share as a public calendar. Outlook: publish a calendar, ICS link."

    /**
     * Add a calendar on the tablet: paste its link here (or send it from a phone), say whose it is. Reached behind the
     * PIN: Settings, or the Calendar app's "Add a calendar" (MainActivity.addCalendar).
     */
    fun add(a: Activity, immersive: () -> Unit) {
        thread {
            val names = familyNames()
            main.post {
                val link = Calm.field(a, "https://…/basic.ics").apply {
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    // What's on the clipboard, when it's a calendar link: copied in the tablet's browser, it's one tap.
                    runCatching { (a.getSystemService(android.content.ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(a)?.toString())?.let { clean(it) }?.let { setText(it) } }
                }
                val who = Calm.field(a, if (names.isEmpty()) "Whose is it? (optional)" else "Whose? " + names.take(4).joinToString(", "))
                val col = Calm.column(a, 12).apply { addView(link); addView(who); addView(Calm.caption(a, HELP)) }
                CalmDialog(a).setTitle("Add a calendar").setView(col).setWidth(760f)
                    .setPositiveButton("Add") { _, _ ->
                        val u = clean(link.text.toString())
                        if (u == null) { CalmDialog(a).setTitle("That isn't a calendar link.").setMessage(HELP).setPositiveButton("OK", null).show().also { immersive() }; return@setPositiveButton }
                        val w = who.text.toString().trim().let { t -> names.firstOrNull { it.equals(t, true) } ?: t }
                        thread { add(w, u); sync() }
                        CalmDialog(a).setTitle("Added ${label(w)}").setMessage("Its events show in the Calendar in a minute.").setPositiveButton("OK", null).show().also { immersive() }
                    }
                    .setNeutralButton("From a phone") { _, _ -> addFromPhone(a, immersive) }
                    .setNegativeButton("Cancel", null).show().also { immersive() }
            }
        }
    }

    /**
     * A link from the person's computer (the workshop's add_calendar) or pasted to the assistant: it comes straight
     * here from the bridge (DeviceServer /calendar), never kept there. Kept only after a yes on the tablet,
     * with the PIN. [done] gets whether it was added.
     */
    fun offer(a: Activity, withPin: (() -> Unit) -> Unit, who: String, url: String, from: String, immersive: () -> Unit, done: (Boolean) -> Unit) {
        var answered = false
        val finish = { yes: Boolean -> if (!answered) { answered = true; done(yes) } }
        CalmDialog(a).setTitle("Add ${label(who)}?")
            .setMessage(listOfNotNull(runCatching { URL(url).host }.getOrNull(), from.takeIf { it.isNotBlank() }?.let { "Sent by $it." }).joinToString("\n"))
            .setPositiveButton("Add") { _, _ -> if (DeviceServer.personOnly("Adding a calendar someone sent")) { finish(false); return@setPositiveButton }; withPin { thread { add(who, url); sync() }; finish(true) } }
            .setNegativeButton("Not now") { _, _ -> finish(false) }
            .setOnDismissListener { main.postDelayed({ if (!answered) finish(false) }, 95_000) } // the PIN box may still be open
            .show().also { immersive() }
    }

    private fun addFromPhone(a: Activity, immersive: () -> Unit) {
        thread {
            val names = familyNames()
            main.post {
                var dialog: android.app.Dialog? = null
                var got: JSONObject? = null
                val info = JSONObject().put("title", "Add a calendar").put("field", "Calendar link (iCal)").put("hint", "https://…/basic.ics")
                    .put("help", "Google Calendar: Settings, your calendar, “Secret address in iCal format”. iCloud: share as a public calendar. Outlook: publish a calendar, ICS link.")
                    .put("who", true).put("names", JSONArray(names)).put("done", "Sent. Check the display.")
                val h = Handoff(a, info, onSecret = { got = it; dialog?.dismiss() }, onEnd = { if (got == null) dialog?.dismiss() })
                if (!h.start()) { CalmDialog(a).setTitle("Connect the tablet to Wi-Fi first.").setPositiveButton("OK", null).show().also { immersive() }; return@post }
                val qr = ImageView(a).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
                val col = Calm.qr(a, qr, Calm.caption(a, "Scan with a phone on this Wi-Fi, and paste the calendar's link there."), 360) { Handoff.share(a, h.url!!) }
                dialog = CalmDialog(a).setTitle("Add a calendar").setView(col).setNegativeButton("Cancel", null)
                    .setOnDismissListener { h.stop(); got?.let { confirm(a, it, immersive) } }.show().also { immersive() }
            }
        }
    }

    /** On the tablet: name what came from the phone before keeping it. */
    private fun confirm(a: Activity, msg: JSONObject, immersive: () -> Unit) {
        val url = clean(msg.optString("value"))
        val who = msg.optString("who").trim().take(40)
        if (url == null) { CalmDialog(a).setTitle("That isn't a calendar link.").setPositiveButton("OK", null).show().also { immersive() }; return }
        CalmDialog(a).setTitle("Add ${label(who)}?").setMessage(runCatching { URL(url).host }.getOrDefault(""))
            .setPositiveButton("Add") { _, _ -> thread { add(who, url); sync() } }
            .setNegativeButton("Cancel", null).show().also { immersive() }
    }
}
