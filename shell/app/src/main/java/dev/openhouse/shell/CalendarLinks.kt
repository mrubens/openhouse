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
import java.net.Socket
import java.net.URL
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
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

    /** [name]: its own name, for a calendar that isn't a person's (a team's schedule); [only]: which of its events to
     *  keep, in the words they used ("home games"), judged by the bridge (calendar.js). */
    class Link(val id: String, val who: String, val url: String, val name: String = "", val only: String = "", val tone: String = "")
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
        (0 until a.length()).map { a.getJSONObject(it).let { j -> Link(j.getString("id"), j.optString("who"), j.getString("url"), j.optString("name"), j.optString("only"), j.optString("tone")) } }
    }.getOrDefault(emptyList())

    @Synchronized private fun save(links: List<Link>) {
        val plain = JSONArray(links.map { JSONObject().put("id", it.id).put("who", it.who).put("url", it.url).put("name", it.name).put("only", it.only).put("tone", it.tone) }).toString().toByteArray()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(plain))
        tmp.renameTo(file)
    }

    /** A calendar link as people paste it, or null if it isn't one. Always read over https: webcal:// (what Google,
     *  iCloud and Outlook hand out for subscribing) and http:// links are the same address over https. */
    fun clean(raw: String): String? {
        val u = raw.trim().replace(Regex("^(webcals?|https?)://", RegexOption.IGNORE_CASE), "https://")
        return u.takeIf { it.length <= 2000 && Regex("^https://[^\\s/]+\\S*$", RegexOption.IGNORE_CASE).matches(it) }
    }

    @Synchronized fun add(who: String, url: String, name: String = "", only: String = "") {
        val u = clean(url) ?: return
        save(list().filter { it.url != u } + Link(UUID.randomUUID().toString().take(8), who.trim().take(40), u, name.trim().take(60), only.trim().take(200), list().firstOrNull { it.url == u }?.tone ?: ""))
    }

    @Synchronized fun remove(id: String) { save(list().filter { it.id != id }); problems.remove(id); lastIcs.remove(id) }
    /** Its events' color (Settings, Calendars): one of the household's palette, or "" for none. */
    @Synchronized fun setTone(id: String, tone: String) = save(list().map { if (it.id == id) Link(it.id, it.who, it.url, it.name, it.only, tone) else it })

    fun label(who: String) = if (who.isBlank()) "A calendar" else "$who's calendar"

    // --- reading the calendars -----------------------------------------------------------------
    /** What each calendar said at the last read (by id), so a change made here (its color) shows at once, without reading them all again. */
    private val lastIcs = java.util.concurrent.ConcurrentHashMap<String, String>()
    /** Why a calendar couldn't be read at the last read (by id), for the Calendars list: never has the link in it. */
    private val problems = java.util.concurrent.ConcurrentHashMap<String, String>()
    fun problem(id: String): String? = problems[id]

    /**
     * Read a link once, before it's kept (from setup's phone, the assistant, the paste box): null when it's a calendar
     * that reads, else what to tell them ("Couldn't read that calendar: it asked for a sign-in."). Off the main thread.
     */
    fun check(url: String): String? {
        val u = clean(url) ?: return "That isn't a calendar link (an https:// or webcal:// address ending in .ics, usually)."
        return try { read(u); null } catch (e: Exception) { "Couldn't read that calendar: ${(e as? Said)?.message ?: "it didn't answer"}." }
    }

    /** A calendar's text, or why it isn't one ([Said]): what [fetch] got, if it's iCal. */
    private fun read(url: String): String {
        val t = fetch(url)
        if (!t.trimStart('﻿', ' ', '\r', '\n', '\t').startsWith("BEGIN:VCALENDAR", ignoreCase = true))
            throw Said(if (t.contains("<html", ignoreCase = true)) "that's a web page, not the calendar itself (look for its iCal or .ics address)" else "what's there isn't a calendar")
        return t
    }

    /** [fresh] false: send what was read last time with the links' settings as they are now (a color just chosen). */
    fun sync(fresh: Boolean = true) {
        if (stopped || (running && fresh)) return
        if (fresh) running = true
        thread(name = "calendars") {
            try {
                if (fresh) claim()
                val feeds = JSONArray()
                for (l in list()) feeds.put(JSONObject().put("id", l.id).put("who", l.who).put("name", l.name).put("only", l.only).put("tone", l.tone).apply {
                    val kept = lastIcs[l.id]
                    if (!fresh && kept != null) put("ics", kept)
                    else runCatching { put("ics", read(l.url).also { lastIcs[l.id] = it; problems.remove(l.id) }) }.onFailure {
                        val why = (it as? Said)?.message ?: "it didn't answer" // other messages can hold the link
                        problems[l.id] = why; put("error", why.replaceFirstChar { c -> c.uppercase() })
                    }
                })
                val ok = post("/calendar/feeds", JSONObject().put("feeds", feeds)) != null
                Log.i(TAG, "${feeds.length()} calendar(s) ${if (ok) "sent" else "not sent (bridge not up)"}")
                if (!ok) main.postDelayed(::sync, 60_000)
            } finally { if (fresh) running = false }
        }
    }

    /** Links the household kept before they moved here: take them, and the bridge forgets them. */
    private fun claim() {
        val a = post("/calendar/claim", JSONObject())?.let { runCatching { JSONObject(it).optJSONArray("calendars") }.getOrNull() } ?: return
        for (i in 0 until a.length()) a.optJSONObject(i)?.let { add(it.optString("who").takeIf { w -> w != "null" } ?: "", it.optString("url")) }
        if (a.length() > 0) Log.i(TAG, "moved ${a.length()} link(s) out of the household")
    }

    /** An https address of [u] (http is read as https), or why it can't be read. */
    private fun https(u: URL): URL = when (u.protocol.lowercase()) {
        "https" -> u
        "http" -> URL("https", u.host, if (u.port == 80) -1 else u.port, u.file)
        else -> throw Said("only https and webcal addresses can be read")
    }

    /**
     * A link someone sent, read the way the bridge reads one (publicGet in bridge/app-web.js): https only, every hop
     * (each redirect too) a name whose addresses are all public, never the home network or this tablet, and connected
     * to at exactly the address checked, so a name can't answer one way to the check and another to the read.
     */
    private fun fetch(url: String): String {
        var u = https(URL(url))
        repeat(6) { // the link, and up to five redirects
            if (u.userInfo != null) throw Said("it has a sign-in in its address")
            val host = PublicAddress.bare(u.host)
            if (host.isEmpty() || PublicAddress.localName(host)) throw Said("it points into a home network, which isn't read")
            val found = try { java.net.InetAddress.getAllByName(host).toList() } catch (e: Exception) { throw Said("there's no site by that name, or the Wi-Fi is down") }
            if (found.isEmpty() || found.any { PublicAddress.isPrivate(it) }) throw Said("it points into a home network, which isn't read")
            // Each of its addresses in turn (all of them checked above), until one answers: a site with an IPv6
            // address first doesn't fail on a Wi-Fi without IPv6, nor a site with one server down.
            var c: HttpsURLConnection? = null
            var code = -1
            for (at in found.take(4)) {
                val ip = at.hostAddress.substringBefore('%').let { if (at is java.net.Inet6Address) "[$it]" else it }
                val tried = (URL("https", ip, u.port, u.file).openConnection(java.net.Proxy.NO_PROXY) as HttpsURLConnection).apply {
                    connectTimeout = if (found.size > 1) 8_000 else 15_000; readTimeout = 20_000; instanceFollowRedirects = false
                    sslSocketFactory = Pinned(host)
                    hostnameVerifier = HostnameVerifier { _, s -> HttpsURLConnection.getDefaultHostnameVerifier().verify(host, s) }
                    setRequestProperty("Host", if (u.port == -1 || u.port == 443) u.host else "${u.host}:${u.port}")
                    setRequestProperty("User-Agent", "openhouse-calendar/0.1")
                }
                code = try { tried.responseCode } catch (e: Exception) { tried.disconnect(); -1 }
                if (code != -1) { c = tried; break }
            }
            if (c == null) throw Said("its site didn't answer")
            if (code in 300..399) { u = https(URL(u, c.getHeaderField("Location") ?: throw Said("its site answered with an error ($code)"))); c.disconnect(); return@repeat }
            if (code == 401 || code == 403) throw Said("it asked for a sign-in (copy the calendar's secret or public iCal address instead)")
            if (code == 404 || code == 410) throw Said("there's nothing at that address (a link that was reset stops working)")
            if (code != 200) throw Said("its site answered with an error ($code)")
            val bytes = c.inputStream.use { s -> val o = java.io.ByteArrayOutputStream(); val buf = ByteArray(16384); var n = 0
                while (true) { val r = s.read(buf); if (r < 0) break; n += r; if (n > 8_000_000) throw Said("it's too big"); o.write(buf, 0, r) }; o.toByteArray() }
            return String(bytes, Charsets.UTF_8)
        }
        throw Said("it kept sending the tablet somewhere else")
    }

    /**
     * TLS for a connection made to the checked address: the server is asked for [host] (SNI) and the handshake is
     * done here, before the connection sends anything; the certificate is checked for [host] (fetch's verifier).
     * Only the layered socket (over the connection already made to the address) is ever used.
     */
    private class Pinned(private val host: String) : SSLSocketFactory() {
        private val d = HttpsURLConnection.getDefaultSSLSocketFactory()
        override fun getDefaultCipherSuites(): Array<String> = d.defaultCipherSuites
        override fun getSupportedCipherSuites(): Array<String> = d.supportedCipherSuites
        override fun createSocket(s: Socket, ignored: String?, port: Int, autoClose: Boolean): Socket =
            (d.createSocket(s, host, port, autoClose) as SSLSocket).apply {
                if (!host.contains(':') && !host.all { it.isDigit() || it == '.' })
                    sslParameters = sslParameters.apply { serverNames = listOf(SNIHostName(host)) }
                startHandshake()
            }
        private fun no(): Nothing = throw java.io.IOException("only over a checked address")
        override fun createSocket(h: String?, p: Int): Socket = no()
        override fun createSocket(h: String?, p: Int, la: java.net.InetAddress?, lp: Int): Socket = no()
        override fun createSocket(a: java.net.InetAddress?, p: Int): Socket = no()
        override fun createSocket(a: java.net.InetAddress?, p: Int, la: java.net.InetAddress?, lp: Int): Socket = no()
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
    fun manage(a: Activity, immersive: () -> Unit) = CalendarAccounts.calendars(a, null, immersive) // one list: accounts' calendars, then links

    private const val HELP = "Google Calendar: Settings, your calendar, “Secret address in iCal format”. iCloud: share as a public calendar. Outlook: publish a calendar, ICS link."

    /**
     * Add a calendar from a link: sent from a phone (it scans the code and pastes the link there), since a link is
     * copied on a phone or computer, not on the tablet. Pasting or typing it here is the small way, for a tablet with a
     * keyboard cover. Reached from Settings, the Calendar app's "Add a calendar" (MainActivity.addCalendar) and setup.
     */
    fun add(a: Activity, immersive: () -> Unit) = addFromPhone(a, immersive)

    /** Paste or type the link here, and say whose it is (a tablet with a keyboard cover). */
    fun paste(a: Activity, immersive: () -> Unit) {
        thread {
            val names = familyNames()
            main.post {
                val link = Calm.field(a, "https://…/basic.ics").apply {
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    // What's on the clipboard, when it's a calendar link: copied in the tablet's browser, it's one tap.
                    runCatching { (a.getSystemService(android.content.ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(a)?.toString())?.let { clean(it) }?.let { setText(it) } }
                }
                val who = Calm.field(a, if (names.isEmpty()) "Whose is it? (optional)" else "Whose? " + names.take(4).joinToString(", "))
                // Where to find the link is behind More (docs/ux.md).
                val col = Calm.column(a, 12).apply {
                    addView(link); addView(who)
                    addView(Calm.more(a, HELP))
                }
                CalmDialog(a).setTitle("Add a calendar").setView(col).setWidth(760f)
                    .setPositiveButton("Add") { _, _ ->
                        val u = clean(link.text.toString())
                        if (u == null) { CalmDialog(a).setTitle("That isn't a calendar link").setMessage(HELP).setPositiveButton("Close", null).show().also { immersive() }; return@setPositiveButton }
                        val w = who.text.toString().trim().let { t -> names.firstOrNull { it.equals(t, true) } ?: t }
                        checkThenAdd(a, w, u, immersive)
                    }
                    .setNegativeButton("Cancel", null).show().also { immersive() }
            }
        }
    }

    /**
     * A link from the person's computer (the workshop's add_calendar) or pasted to the assistant: it comes straight
     * here from the bridge (DeviceServer /calendar), never kept there. Kept only after a yes on the tablet,
     * with the PIN. [done] gets whether it was added.
     */
    fun offer(a: Activity, withPin: (() -> Unit) -> Unit, who: String, url: String, from: String, immersive: () -> Unit, done: (Boolean) -> Unit, name: String = "", only: String = "") {
        var answered = false
        val finish = { yes: Boolean -> if (!answered) { answered = true; done(yes) } }
        CalmDialog(a).setForPerson().setTitle("Add ${name.ifBlank { label(who) }}?")
            .setMessage(listOfNotNull(runCatching { URL(url).host }.getOrNull(), only.takeIf { it.isNotBlank() }?.let { "Only: $it" }, from.takeIf { it.isNotBlank() }?.let { "Sent by $it." }).joinToString("\n"))
            .setPositiveButton("Add") { _, _ -> if (DeviceServer.personOnly("Adding a calendar someone sent")) { finish(false); return@setPositiveButton }; withPin { thread { add(who, url, name, only); sync() }; finish(true) } }
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
                if (!h.start()) { paste(a, immersive); return@post } // no Wi-Fi: no phone to send it from
                val qr = ImageView(a).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
                // The phone is the way: the link is copied there. Pasting here is a quiet link, for a keyboard cover.
                val col = Calm.column(a, 12).apply {
                    gravity = android.view.Gravity.CENTER_HORIZONTAL
                    addView(Calm.qr(a, qr, Calm.caption(a, "Copy the calendar's link on your phone, then scan this with it on this Wi-Fi and send the link."), 360) { Handoff.share(a, h.url!!) })
                    addView(Calm.quiet(a, "Paste it here instead") { dialog?.dismiss(); paste(a, immersive) })
                    addView(Calm.more(a, HELP))
                }
                dialog = CalmDialog(a).setTitle("Send a calendar from your phone").setView(col).setNegativeButton("Cancel", null)
                    .setOnDismissListener { h.stop(); got?.let { confirm(a, it, immersive) } }.show().also { immersive() }
            }
        }
    }

    /** On the tablet: name what came from the phone before keeping it. */
    private fun confirm(a: Activity, msg: JSONObject, immersive: () -> Unit) {
        val url = clean(msg.optString("value"))
        val who = msg.optString("who").trim().take(40)
        if (url == null) { CalmDialog(a).setTitle("That isn't a calendar link").setPositiveButton("Close", null).show().also { immersive() }; return }
        CalmDialog(a).setTitle("Add ${label(who)}?").setMessage(runCatching { URL(url).host }.getOrDefault(""))
            .setPositiveButton("Add") { _, _ -> checkThenAdd(a, who, url, immersive) }
            .setNegativeButton("Cancel", null).show().also { immersive() }
    }

    /** Read it once first: kept (and "Added") only if it reads, else why not, and nothing is kept. */
    private fun checkThenAdd(a: Activity, who: String, url: String, immersive: () -> Unit) {
        (a as? MainActivity)?.toast("Reading the calendar…")
        thread {
            val why = check(url)
            if (why == null) { add(who, url); sync() }
            main.post {
                if (why == null) (a as? MainActivity)?.toast("Added ${label(who)}")
                else CalmDialog(a).setTitle("Not added").setMessage(why).setMore(HELP).setPositiveButton("Close", null).show().also { immersive() }
            }
        }
    }
}
