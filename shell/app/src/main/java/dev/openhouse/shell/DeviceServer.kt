package dev.openhouse.shell

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.UUID
import kotlin.concurrent.thread

/**
 * "device" MCP server (MCP over HTTP, JSON responses), on 127.0.0.1:8791: the bridge's way to the tablet's screen
 * (the workshop's look_at_tablet). Every call needs the bearer token in files/device-mcp.json, which only the bridge
 * reads. Actions run one at a time; risky taps wait for a person to say yes.
 */
object DeviceServer {
    const val PORT = 8791
    private const val TAG = "DeviceServer"
    private var started = false
    internal lateinit var ctx: Context
        private set
    internal val hasContext get() = ::ctx.isInitialized
    /** Its context before it starts: kiosk setup asks KioskApps (which reads it) which apps need someone. */
    fun bind(c: Context) { if (!hasContext) ctx = c.applicationContext }
    private lateinit var token: String
    /** One tool at a time (they drive the same screen), but a stuck one (an approval nobody answered, an install
     *  that never finished) must not block every later call: others wait a while, then hear what it's busy with. */
    private val lock = java.util.concurrent.locks.ReentrantLock()
    @Volatile private var busyWith: String? = null
    @Volatile private var stopped: String? = null

    /** Words that mean the tap does something you can't take back, or that reaches other people. */
    private val RISKY = Regex(
        "\\b(send|sent|pay|payment|buy|purchase|order|checkout|check out|donate|subscribe|delete|remove|erase|discard|" +
        "clear all|reset|uninstall|install|post|publish|share|reply|call|dial|transfer|confirm|accept|agree|allow|" +
        "sign out|log out|factory)\\b", RegexOption.IGNORE_CASE)

    /**
     * A tap needs a yes when the control, or anything drawn inside it, is labelled with a risky
     * verb as a button would be: "Send", "Send SMS", "Pay now", "Delete", "Place order", or any
     * Button-class label. A row that merely mentions one ("Send to 555-0100") doesn't count.
     * Errs on the side of asking.
     */
    /** A finishing button (pay, place order, send...: [DeviceRules.finalAction]) on or just inside [n]. */
    private fun finalIn(n: AccessibilityNodeInfo, depth: Int = 0): String? {
        for (l in listOfNotNull(n.contentDescription?.toString(), n.text?.toString())) DeviceRules.finalAction(l)?.let { return it }
        if (depth >= 3) return null
        for (i in 0 until n.childCount) n.getChild(i)?.let { finalIn(it, depth + 1) }?.let { return it }
        return null
    }

    /** A password or card field on or inside [n]. */
    private fun secretIn(n: AccessibilityNodeInfo, depth: Int = 0): Boolean {
        if (n.isPassword || (n.isEditable && DeviceRules.secretField(n.hintText?.toString(), n.viewIdResourceName, n.contentDescription?.toString()))) return true
        if (depth >= 2) return false
        return (0 until n.childCount).any { i -> n.getChild(i)?.let { secretIn(it, depth + 1) } == true }
    }

    private const val PRIVATE = "The tablet is asking for the PIN, and only a person types it: Opie never enters it, hears it or gets round it. " +
        "Tell them to type the PIN on the tablet (on the tablet itself, when they're talking from a phone), then look_at_screen: it waits for them, and you carry on from there."
    /** What Opie's tap or typing just opened is the PIN pad (a locked Settings row, say): not a refusal, the person's turn. */
    private const val PIN_NOW = "\n\nThe tablet is asking for the PIN now. Tell them to type it on the tablet (never to you), then look_at_screen: it waits for them."
    /** A PIN pad is up (in Opie or one of its apps): nothing Opie does lands while it is. Everything else a person
     *  can tap in Opie, Settings too, Opie can (Settings' rows ask for the PIN themselves when the lock is on). */
    @Suppress("UNUSED_PARAMETER")
    private fun ownPrivate(acc: DeviceAccess, n: AccessibilityNodeInfo?): Boolean = acc.pinShowing()

    // --- for a person -------------------------------------------------------------------------------------------------
    // The few controls that would widen what Opie may do, take the tablet out of Opie, or say yes to something Opie
    // or a computer asked for: they check [personOnly] and do nothing when Opie's own tap set them off.
    @Volatile private var actedAt = 0L
    @Volatile private var refused: String? = null
    /** Opie's tap (or typing) just now set this off: don't, and tell Opie. */
    fun personOnly(what: String): Boolean {
        if (System.currentTimeMillis() - actedAt > 2500) return false
        refused = "Not done: $what is for a person to tap, not Opie. Tell them it's theirs to do."
        Log.i(TAG, "person only: $what"); return true
    }

    /** Someone turned on "Opie uses apps" (Settings, This tablet; behind the lock when it's on). Off by default. */
    fun appsOn(c: Context = ctx) = c.getSharedPreferences("shell", Context.MODE_PRIVATE).getBoolean("opie_apps", false)
    fun setAppsOn(c: Context, on: Boolean) { c.getSharedPreferences("shell", Context.MODE_PRIVATE).edit().putBoolean("opie_apps", on).apply(); if (!on) halt("Opie using apps was turned off.") }

    /** Stop what it's doing in an app at once, and stay where it is (said "Opie, stop"): the next request starts again. */
    fun halt(reason: String) { stopped = reason; DeviceAccess.instance?.hideStatus(); Log.i(TAG, "halted: $reason") }

    private fun risky(n: AccessibilityNodeInfo, depth: Int = 0): String? {
        for (l in listOfNotNull(n.contentDescription?.toString(), n.text?.toString())) {
            val t = l.trim()
            if (RISKY.containsMatchIn(t) && (t.split(Regex("\\s+")).size <= 2 || (n.className?.contains("Button") == true))) return t
        }
        if (depth >= 3) return null
        for (i in 0 until n.childCount) n.getChild(i)?.let { risky(it, depth + 1) }?.let { return it }
        return null
    }

    fun start(c: Context): Unit = synchronized(this) {
        if (started) return
        started = true
        ctx = c.applicationContext
        AppStore.init(ctx)
        val prefs = ctx.getSharedPreferences("shell", Context.MODE_PRIVATE)
        token = prefs.getString("device_token", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("device_token", it).apply() }
        writeConfig()
        thread(name = "device-mcp", isDaemon = true) {
            runCatching {
                ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1")).use { ss ->
                    Log.i(TAG, "listening on $PORT")
                    // A few connections at a time: any app on the tablet can connect, and mustn't be able to exhaust threads.
                    val pool = java.util.concurrent.ThreadPoolExecutor(4, 8, 30, java.util.concurrent.TimeUnit.SECONDS, java.util.concurrent.ArrayBlockingQueue(16))
                    while (true) {
                        val s = ss.accept()
                        runCatching { pool.execute { runCatching { serve(s) }.onFailure { Log.w(TAG, "conn: $it") } } }
                            .onFailure { runCatching { s.close() } } // queue full
                    }
                }
            }.onFailure { Log.e(TAG, "server stopped: $it"); started = false }
        }
        Unit
    }

    /** Where the bridge finds this server and its token (outside the apps folder). */
    private fun writeConfig() {
        val cfg = JSONObject().put("mcpServers", JSONObject().put("device", JSONObject()
            .put("type", "http").put("url", "http://127.0.0.1:$PORT/mcp")
            .put("headers", JSONObject().put("Authorization", "Bearer $token"))))
        File(ctx.filesDir, "device-mcp.json").writeText(cfg.toString(2))
    }

    fun stop(reason: String) {
        stopped = reason
        thread { runCatching { dev.openhouse.ui.BridgeClient.open("http://127.0.0.1:8787/cancel").run {
            requestMethod = "POST"; doOutput = true; connectTimeout = 2000; outputStream.use { it.write("{}".toByteArray()) }; responseCode } } }
        KioskApps.goHome()
    }

    // --- HTTP ---------------------------------------------------------------
    private fun serve(s: Socket) = s.use {
        s.soTimeout = 120_000
        val inp = BufferedInputStream(s.getInputStream())
        while (true) {
            val reqLine = readLine(inp) ?: return
            if (reqLine.isEmpty()) continue
            val (method, path) = reqLine.split(" ").let { it[0] to it.getOrElse(1) { "/" } }
            val headers = HashMap<String, String>()
            while (true) {
                val l = readLine(inp) ?: return
                if (l.isEmpty()) break
                val i = l.indexOf(':'); if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
            }
            // Who's asking first, before reading (or making room for) a body.
            val authed = java.security.MessageDigest.isEqual((headers["authorization"] ?: "").toByteArray(), "Bearer $token".toByteArray())
            val len = headers["content-length"]?.toIntOrNull() ?: 0
            if (!authed || len !in 0..(if (path in MailConvert.PATHS) MailConvert.MAX_BODY else MAX_BODY)) {
                respond(s, if (!authed) 401 else 413, if (!authed) """{"error":"unauthorized"}""" else """{"error":"too large"}""")
                return
            }
            val body = ByteArray(len).also { var o = 0; while (o < len) { val r = inp.read(it, o, len - o); if (r < 0) break; o += r } }
            val (code, out) = when {
                method == "POST" && path.startsWith("/mcp") -> rpc(String(body))
                // An email's PDF or HEIC (bridge/mail.js), up to 25 MB as base64: read straight from the body, not parsed as JSON.
                method == "POST" && path in MailConvert.PATHS -> MailConvert.handle(ctx, path, body)
                method == "POST" && path in HOME_PATHS -> home(path, runCatching { JSONObject(String(body)) }.getOrNull() ?: JSONObject())
                else -> 405 to ""
            }
            respond(s, code, out)
            if (headers["connection"]?.equals("close", true) == true) return
        }
    }

    private const val MAX_BODY = 1 shl 20

    private fun respond(s: Socket, code: Int, out: String) {
        val bytes = out.toByteArray()
        val status = mapOf(200 to "OK", 202 to "Accepted", 401 to "Unauthorized", 405 to "Method Not Allowed", 413 to "Payload Too Large")[code] ?: "OK"
        s.getOutputStream().apply {
            write(("HTTP/1.1 $code $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\n" +
                (if (code == 405) "Allow: POST\r\n" else "") + (if (code >= 400 && code != 405) "Connection: close\r\n" else "") + "\r\n").toByteArray())
            write(bytes); flush()
        }
    }

    private fun readLine(i: BufferedInputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = i.read(); if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
        }
    }

    // --- for the bridge's home devices (bridge/devices) -----------------------
    // Same token as the MCP server. /approve: the "Is this OK?" card for a risky device action
    // (turn on, open, launch…); /say: the status pill; /multicast: hold Wi-Fi multicast for a scan.
    private val HOME_PATHS = setOf("/host", "/openai", "/ownkey", "/setup/google", "/setup/icloud", "/setup/pin", "/approve", "/say", "/multicast", "/share", "/calendar", "/calendar/accounts", "/calendar/request", "/album", "/halt", "/bt", "/front", "/camera", "/screen", "/media/still", "/media", "/storage/status", "/storage/set", "/storage/sign", "/storage/remove", "/alarms", "/mic-check", "/pin-choices")
    /** What the shell can do, for /host (bridge/host.js CAPS; its TABLET_CAPS is the same list, for a shell older than /host). */
    private val HOST_CAN = listOf("screen", "approve", "calendar", "calendar-accounts", "openai", "pin", "google-signin", "drive", "updates",
        "mail-convert", "stills", "speaker", "apps", "bluetooth", "camera", "media", "multicast", "share", "brightness", "storage", "alarms", "mic-check", "pin-choices")
    private var multicast: android.net.wifi.WifiManager.MulticastLock? = null
    private val releaseMulticast = Runnable { runCatching { multicast?.takeIf { it.isHeld }?.release() } }
    private val handler by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }

    private fun home(path: String, b: JSONObject): Pair<Int, String> {
        val acc = DeviceAccess.instance
        return when (path) {
            // The bridge's host interface (bridge/host.js, docs/host.md): what this shell can do. The reference host:
            // every other host answers the same requests the same way, and leaves out what it can't.
            "/host" -> 200 to JSONObject().put("kind", "tablet").put("can", JSONArray(HOST_CAN)).toString()
            "/approve" -> {
                // The shell's own card (ApprovalCard): with Device control off (a tablet set up by QR code) it's a
                // window of the display, so plugin adds and rewards are asked there too.
                if (acc == null && MainActivity.live == null) return 200 to """{"yes":false,"why":"the display isn't showing"}"""
                // "pin": a yes that needs the PIN when the lock is on (a reward the kids saved stars for). "grownup": a
                // yes that always needs the PIN, lock or not (an app made on the tablet going in, bridge/build-waits.js);
                // a tablet with no PIN yet asks whoever is there to choose one on the card first. "for": which of the
                // household's PIN choices this is (PinChoices: apps, photos, calendar, rewards, settings); one they turned
                // off asks with a person's plain yes instead. None named, or one this shell doesn't know: the PIN, as always.
                val asks = PinChoices.asks(b.optString("for").ifEmpty { null }, PinChoices.saved(ctx))
                val grownUp = b.optBoolean("grownup") && asks
                val parent = grownUp || (b.optBoolean("pin") && asks && ParentPin.isSet(ctx))
                // "later": the card also has "Not now", which (like no answer) leaves it waiting: "answered" says which.
                // "no": the word for its no. "waitMs": how long it stays up (90 s by default, at most 10 minutes).
                val later = b.optBoolean("later")
                val noWord = b.optString("no").trim().take(24).ifEmpty { null }
                val waitMs = b.optLong("waitMs", 90_000).coerceIn(10_000, 600_000)
                // The card's words (docs/ux.md): a verb for the yes, what it may do as a list (always shown), and
                // the rest behind More. All of them, as the voice model gets them: one too long to show is a no, never cut.
                val rights = b.optJSONArray("rights")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { it.optString("kind").take(20) to it.optString("text") } }.orEmpty()
                val title = b.optString("title"); val detail = b.optString("detail"); val more = b.optString("more").ifBlank { null }
                ApprovalCard.tooLong(title, detail, more, rights)?.let { return 200 to JSONObject().put("yes", false).put("answered", true).put("why", "the card can't show all of it: $it").toString() }
                val yesWord = b.optString("yes").trim().take(20).ifEmpty { "Allow" }
                // Under the tools' lock: no device tool runs while the card is up, so none can answer it.
                if (!lock.tryLock(60, java.util.concurrent.TimeUnit.SECONDS)) return 200 to JSONObject().put("yes", false).put("why", "the display is busy with $busyWith").toString()
                val said = try {
                    busyWith = "a question on screen for the people here"
                    ApprovalCard.answer(title, detail, timeoutMs = waitMs, parent = parent, yes = yesWord, rights = rights, more = more,
                        danger = b.optBoolean("danger"), grownUp = grownUp, later = later, no = noWord)
                } finally { busyWith = null; lock.unlock() }
                acc?.hideStatus()
                200 to JSONObject().put("yes", said == ApprovalCard.Answer.YES).put("answered", said != ApprovalCard.Answer.NONE).toString()
            }
            // A phone hand-off link from one of the family's apps (Photos, Lists), through the share sheet. The apps run
            // as their own packages, which can't see which apps are browsers or let anything into kiosk: the shell can.
            "/share" -> {
                val url = b.optString("url")
                if (!Regex("^http://(10|192\\.168|172\\.(1[6-9]|2\\d|3[01]))(\\.\\d{1,3}){2,3}:\\d{2,5}/#[A-Za-z0-9_-]{43}$").matches(url)) return 400 to """{"error":"not a hand-off link"}"""
                handler.post { Handoff.share(ctx, url) }
                200 to "{}"
            }
            // A calendar link from the workshop's add_calendar or the assistant: kept here (sealed), never in the bridge,
            // and only after a yes and PIN on the tablet. Waits for them, up to a minute and a half.
            "/calendar" -> {
                val url = CalendarLinks.clean(b.optString("url")) ?: return 400 to """{"error":"That isn't a calendar link (an https:// or webcal:// address ending in .ics, usually)."}"""
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                // Read once first: a link that doesn't read is said so here, and never kept or counted.
                CalendarLinks.check(url)?.let { return 400 to JSONObject().put("error", it).toString() }
                val got = java.util.concurrent.LinkedBlockingQueue<Boolean>()
                handler.post { a.offerCalendar(b.optString("who").trim().take(40), url, b.optString("from").take(40), { got.offer(it) }, trusted = b.optBoolean("trusted"), name = b.optString("name").trim().take(60), only = b.optString("only").trim().take(200)) }
                val yes = got.poll(100, java.util.concurrent.TimeUnit.SECONDS) ?: false
                200 to JSONObject().put("added", yes).toString()
            }
            // Two-way calendars (CalendarAccounts, the bridge's calendar-sync.js): the accounts without their secrets, and
            // a request to Google or iCloud made with an account's sign-in, only to that account's own service.
            "/calendar/accounts" -> { CalendarAccounts.init(ctx); 200 to CalendarAccounts.public().toString() }
            "/calendar/request" -> { CalendarAccounts.init(ctx); 200 to CalendarAccounts.request(b).toString() }
            // An iCloud shared album's link (add_photo_album): the same as a calendar link, sealed here after a yes.
            "/album" -> {
                val url = AlbumLink.clean(b.optString("url")) ?: return 400 to """{"error":"That isn't an iCloud shared album link (https://www.icloud.com/sharedalbum/#... or https://photos.icloud.com/shared/album/...). In the album's sharing settings, turn on its public link (Public Website) and copy it."}"""
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                PhotoAlbums.check(url)?.let { return 400 to JSONObject().put("error", it).toString() } // as a calendar's
                val got = java.util.concurrent.LinkedBlockingQueue<Boolean>()
                handler.post { a.offerAlbum(url, b.optString("from").take(40), { got.offer(it) }, trusted = b.optBoolean("trusted")) }
                val yes = got.poll(100, java.util.concurrent.TimeUnit.SECONDS) ?: false
                200 to JSONObject().put("added", yes).toString()
            }
            // Bluetooth (Bluetooth.kt, docs/bluetooth.md): scanning, pairing after the bridge's yes, GATT and audio.
            "/bt" -> 200 to Bluetooth.handle(b).toString()
            // Opie's tablet_screen (bridge live-tools.js): the brightness, as Settings' Brightness row sets it (not behind
            // the PIN there either), and Sleep now, as the moon button does.
            // The microphone check (MicCheck), for Opie's mic_check: "start" puts it on the screen, "get" says how the last one went.
            // Opie's pin_choices (bridge devices/index.js): what asks for the PIN (Settings → Advanced → Ask for the PIN), and
            // changing one, which always takes the PIN typed on this tablet, on a card only a person answers.
            "/pin-choices" -> {
                val saved = PinChoices.saved(ctx)
                fun state(key: String? = null, now: Boolean = false) = JSONObject().put("pin", ParentPin.isSet(ctx))
                    .put("choices", JSONArray(PinChoices.ALL.map { JSONObject().put("key", it.key).put("label", it.label).put("asks", if (it.key == key) now else PinChoices.asks(it.key, saved)) }))
                    .put("always", JSONArray(PinChoices.ALWAYS))
                if (b.optString("do") != "set") return 200 to state().toString()
                val key = b.optString("what"); val on = b.optBoolean("ask")
                if (acc == null && MainActivity.live == null) return 200 to state().put("changed", "no_screen").toString()
                if (!lock.tryLock(60, java.util.concurrent.TimeUnit.SECONDS)) return 200 to state().put("changed", "busy").toString()
                val label = PinChoices.ALL.firstOrNull { it.key == key }?.label?.replaceFirstChar { it.lowercase() } ?: ""
                val r = try {
                    busyWith = "a question on screen for the people here"
                    PinChoices.change(key, on, ParentPin.isSet(ctx), saved,
                        confirm = { ApprovalCard.ask(if (on) "Ask for the PIN to $label?" else "Stop asking for the PIN to $label?", "", parent = true, yes = if (on) "Ask" else "Stop asking") },
                        save = { k, v -> PinChoices.save(ctx, k, v) })
                } finally { busyWith = null; lock.unlock() }
                acc?.hideStatus()
                200 to (if (r == PinChoices.Changed.DONE) state(key, on) else state()).put("changed", r.name.lowercase()).toString()
            }
            "/mic-check" -> {
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                if (b.optString("do") == "start") handler.post { MicCheck.open(a) }
                200 to JSONObject().put("running", MicCheck.running || b.optString("do") == "start").put("last", MicCheck.last ?: JSONObject.NULL).toString()
            }
            "/screen" -> {
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                when (b.optString("do")) {
                    "brightness" -> {
                        val level = Brightness.setNamed(a, b.optString("level")) ?: return 400 to JSONObject().put("error", "A level is one of ${Brightness.names.joinToString(", ")}, or brighter or dimmer.").toString()
                        handler.post { dev.openhouse.ui.Openhouse.settingsChanged() }
                        200 to JSONObject().put("brightness", level).toString()
                    }
                    "sleep" -> { handler.post { dev.openhouse.ui.Openhouse.sleepNow(); dev.openhouse.ui.Heartbeat.sleep() }; 200 to """{"sleeping":true}""" }
                    else -> 200 to JSONObject().put("brightness", Brightness.label(a)).toString()
                }
            }
            // A video's still for Photos (bridge/stills.js): a frame from a file in the photos folder, as a JPEG.
            "/media/still" -> MediaStill.still(ctx, b.optString("path"))
            // Opie's music tool (bridge devices/index.js mediaDo, Media.kt): what's playing, its buttons, play from a search.
            "/media" -> 200 to Media.handle(b).toString()
            // The household's own OpenAI key (OwnKey): the bridge's call, sent on to a fixed path at OpenAI with the key
            // added here; never logged, and the key never comes back.
            "/openai" -> OwnKey.forward(b.optString("kind"), (b.optJSONObject("body") ?: JSONObject()).toString())
            // The setup's phone or computer (bridge /setup/google, /setup/icloud): a Google sign-in that opens there (its
            // address back, for the phone to open), and an iCloud sign-in typed there; the calendars are chosen here.
            "/setup/google" -> {
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                val cloud = b.optString("cloud").takeIf { it.startsWith("https://") || it.startsWith("http://10.0.2.2") } ?: return 409 to """{"error":"Link the tablet to your Opie account first."}"""
                val got = java.util.concurrent.LinkedBlockingQueue<String>()
                handler.post { if (b.optString("kind") == "photos") GooglePhotos.showFor(a, a::immersive, cloud) { got.offer(it ?: "") } else CalendarAccounts.addGoogle(a, cloud, a::immersive) { got.offer(it ?: "") } }
                val url = got.poll(15, java.util.concurrent.TimeUnit.SECONDS)
                if (url.isNullOrEmpty()) 409 to """{"error":"The tablet isn't on Wi-Fi."}""" else 200 to JSONObject().put("url", url).toString()
            }
            "/setup/icloud" -> {
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                val why = CalendarAccounts.addICloudFrom(a, b.optString("user"), b.optString("pass"), b.optString("who"), a::immersive)
                if (why == null) 200 to """{"ok":true}""" else 400 to JSONObject().put("error", why).toString()
            }
            // The PIN, chosen on the setup's phone or computer (bridge /setup/pin): only while the setup's PIN step shows
            // and no PIN is set yet. On an unlinked tablet its recovery code goes back to be shown there, once (never kept
            // here but as a hash).
            "/setup/pin" -> {
                if (dev.openhouse.ui.Openhouse.setupStep != "pin" || ParentPin.isSet(ctx)) return 409 to """{"error":"The PIN can be chosen here only during the setup, before one is set."}"""
                val pin = b.optString("pin")
                if (!ParentPin.valid(pin)) return 400 to """{"error":"4 to 8 digits."}"""
                val code = if (b.optBoolean("linked")) null else RecoveryCode.new()
                ParentPin.set(ctx, pin, code)
                handler.post { dev.openhouse.ui.Openhouse.settingsChanged() }
                200 to JSONObject().put("ok", true).putOpt("recovery", code?.chunked(4)?.joinToString("-")).toString()
            }
            // The household's own OpenAI key from a settings page (bridge /setup/openai): checked and kept here (the PIN
            // first, with the lock on); never logged, never answered back.
            "/ownkey" -> {
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                val got = java.util.concurrent.LinkedBlockingQueue<String>()
                handler.post { OwnKey.offer(a, b.optString("key")) { got.offer(it ?: "") } }
                val why = got.poll(100, java.util.concurrent.TimeUnit.SECONDS)
                when { why == null -> 200 to JSONObject().put("added", false).put("error", "Nobody answered on the tablet.").toString()
                    why.isEmpty() -> 200 to JSONObject().put("added", true).toString()
                    else -> 400 to JSONObject().put("added", false).put("error", why).toString() }
            }
            // The household's own storage bucket for backups (OwnStorage): what it is (never its key), one presigned
            // request at a time for the bridge, forgotten; and set from a settings page (the PIN first, with the lock on).
            "/storage/status", "/storage/sign", "/storage/remove" -> { OwnStorage.init(ctx); OwnStorage.handle(path, b) }
            "/storage/set" -> {
                val a = MainActivity.live ?: return 409 to """{"error":"the display isn't showing"}"""
                val got = java.util.concurrent.LinkedBlockingQueue<String>()
                handler.post { OwnStorage.offer(a, b) { got.offer(it ?: "") } }
                val why = got.poll(120, java.util.concurrent.TimeUnit.SECONDS)
                when { why == null -> 400 to JSONObject().put("error", "Nobody answered on the tablet.").toString()
                    why.isEmpty() -> 200 to JSONObject().put("ok", true).toString()
                    else -> 400 to JSONObject().put("error", why).toString() }
            }
            "/alarms" -> { Alarms.control(b.optString("do"), b.optInt("minutes", Alarms.SNOOZE_MIN)); 200 to "{}" } // stop or snooze the one ringing (Opie, a screen)
            "/say" -> { acc?.status(b.optString("text").take(120)); 200 to "{}" }
            // "Opie, stop" (bridge device-tools.js): what it's doing in an app stops now; the next request starts fresh.
            // Opie back in front (from another Android app), for Opie showing one of its tabs (bridge show_on_screen).
            "/front" -> { handler.post { KioskApps.goHome() }; 200 to "{}" }
            // Opie's look_with_camera (bridge device-tools.js): the tablet asks on screen, and only a person's Allow opens
            // the camera (CameraLook). Back with one picture (base64 JPEG, never written down) or why there's none.
            "/camera" -> when (val r = CameraLook.ask(b.optString("why").replace(Regex("\\s+"), " ").trim().take(140))) {
                is CameraLook.Result.Picture -> 200 to JSONObject().put("jpeg", android.util.Base64.encodeToString(r.jpeg, android.util.Base64.NO_WRAP)).toString()
                is CameraLook.Result.No -> 200 to JSONObject().put("no", r.why).toString()
            }
            "/halt" -> { halt(b.optString("reason").take(120).ifBlank { "Someone said stop." }); 200 to "{}" }
            "/multicast" -> {
                val ms = b.optLong("ms", 15_000).coerceIn(1_000, 60_000)
                runCatching {
                    val wifi = ctx.getSystemService(android.net.wifi.WifiManager::class.java)
                    val lock = multicast ?: wifi.createMulticastLock("openhouse-devices").apply { setReferenceCounted(false) }.also { multicast = it }
                    if (!lock.isHeld) lock.acquire()
                    handler.removeCallbacks(releaseMulticast); handler.postDelayed(releaseMulticast, ms)
                }.fold({ 200 to """{"held":true}""" }, { 200 to JSONObject().put("held", false).put("why", it.toString()).toString() })
            }
            else -> 405 to ""
        }
    }

    // --- MCP (JSON-RPC) -----------------------------------------------------
    private fun rpc(body: String): Pair<Int, String> {
        val msg = runCatching { JSONObject(body) }.getOrNull() ?: return 200 to err(null, -32700, "parse error")
        val id = msg.opt("id")
        val params = msg.optJSONObject("params") ?: JSONObject()
        if (!msg.has("id")) return 202 to "" // notification
        val result = when (msg.optString("method")) {
            "initialize" -> {
                stopped = null // a new agent run
                JSONObject().put("protocolVersion", params.optString("protocolVersion", "2025-06-18"))
                    .put("capabilities", JSONObject().put("tools", JSONObject()))
                    .put("serverInfo", JSONObject().put("name", "device").put("version", "0.1"))
                    .put("instructions", "Tools to see and use the other apps on this device. Every action returns what is on screen afterwards.")
            }
            "ping" -> JSONObject()
            "tools/list" -> JSONObject().put("tools", TOOLS)
            "tools/call" -> {
                val name = params.optString("name")
                DeviceRules.whileCard(dev.openhouse.ui.PersonCards.showing())?.let { text(it, true) }
                    ?: if (!lock.tryLock(20, java.util.concurrent.TimeUnit.SECONDS)) JSONObject().put("content", org.json.JSONArray().put(JSONObject().put("type", "text").put("text", "The display is still busy with $busyWith; try again in a moment."))).put("isError", true)
                else try { busyWith = name; call(name, params.optJSONObject("arguments") ?: JSONObject()) } finally { busyWith = null; lock.unlock() }
            }
            else -> return 200 to err(id, -32601, "unknown method")
        }
        return 200 to JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result).toString()
    }

    private fun err(id: Any?, code: Int, m: String) =
        JSONObject().put("jsonrpc", "2.0").put("id", id ?: JSONObject.NULL).put("error", JSONObject().put("code", code).put("message", m)).toString()

    private fun tool(name: String, desc: String, props: JSONObject = JSONObject(), required: List<String> = emptyList()) =
        JSONObject().put("name", name).put("description", desc)
            .put("inputSchema", JSONObject().put("type", "object").put("properties", props).put("required", JSONArray(required)))

    private fun p(type: String, desc: String) = JSONObject().put("type", type).put("description", desc)

    private val TOOLS = JSONArray(listOf(
        tool("screen", "List what is on screen now: numbered elements with their text and what you can do with them."),
        tool("look", "A picture of the screen (plus the element list). Use when the list isn't enough, e.g. pictures or games."),
        tool("open_app", "Open an app by its name (e.g. \"Clock\") or package.", JSONObject().put("name", p("string", "App name or package")), listOf("name")),
        tool("tap", "Tap an element by its number from the screen list, or a point. Taps that send, pay, delete or post ask the people in the room first.",
            JSONObject().put("id", p("integer", "Element number")).put("x", p("number", "Screen x")).put("y", p("number", "Screen y"))
                .put("long", p("boolean", "Long-press instead"))),
        tool("type", "Type text into a field (by element number, or the focused field). submit=true presses the keyboard's action key.",
            JSONObject().put("id", p("integer", "Element number")).put("text", p("string", "Text to enter")).put("submit", p("boolean", "Press enter/search/send after")),
            listOf("text")),
        tool("scroll", "Scroll an element (or the screen) up, down, left or right.",
            JSONObject().put("id", p("integer", "Element number")).put("direction", p("string", "up, down, left or right")), listOf("direction")),
        tool("key", "Press back, or go home (back to the family display: do this when you are finished).",
            JSONObject().put("key", p("string", "back or home")), listOf("key")),
        tool("pick", "Choose an option in a dropdown (a select): its element number and the option as it reads. Opens it, finds the option, taps it.",
            JSONObject().put("id", p("integer", "The dropdown's element number")).put("option", p("string", "The option, as it reads")), listOf("id", "option")),
        tool("wait", "Wait for the screen to change (seconds, max 10).", JSONObject().put("seconds", p("number", "How long"))),
        tool("install_app", "Put an Android app on the home screen, by its name (\"Netflix\") or package, in one step. One already on the tablet " +
            "goes on at once. Otherwise it's found on Google Play (through Aurora Store, no Google account), someone says yes on screen, and it " +
            "downloads, installs and goes on the home screen (a minute or two). It takes the first free spot; move it only if they said where.",
            JSONObject().put("name", p("string", "The app's name")).put("package", p("string", "Its package, if you know it (e.g. com.instagram.android)")),
            listOf())
    ))

    internal fun text(t: String, error: Boolean = false) =
        JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", t))).put("isError", error)

    private fun call(name: String, a: JSONObject): JSONObject {
        Log.i(TAG, "call $name $a")
        val r = call1(name, a)
        // Every action, and what came of it, to the speech log (on the tablet; Settings, This tablet, Speech log).
        val said = r.optJSONArray("content")?.let { c -> (0 until c.length()).map { c.getJSONObject(it) }.firstOrNull { it.optString("type") == "text" }?.optString("text") }.orEmpty()
        val shown = JSONObject(a.toString()).apply { if (has("text")) put("text", optString("text").take(80)) }
        if (name.removePrefix("device_") !in setOf("look", "screen")) runCatching {
            dev.openhouse.ui.Openhouse.vlog("device-action", "$name $shown -> ${if (r.optBoolean("isError")) "refused/failed: " else ""}${said.substringBefore("\n\nOn screen now:").take(240)}")
        }
        return r
    }

    private fun call1(name: String, a: JSONObject): JSONObject {
        stopped?.let { return text("Stopped: $it Don't continue; say so in one sentence.", true) }
        // A card a person answers (DeviceAccess.approve, a device asking to pair, a link someone sent) is up: nothing on
        // screen, reading it included, until it's gone.
        DeviceRules.whileCard(dev.openhouse.ui.PersonCards.showing())?.let { return text(it, true) }
        // The camera's sheet is a person's to answer: while it's up Opie neither sees the screen nor touches it (CameraLook).
        if (CameraLook.showing) return text("Not done: the tablet is asking the people here about the camera, and only they answer it. Wait for look_with_camera to finish.", true)
        val acc = DeviceAccess.instance
            ?: return text("Device control is off on this display. It's turned on in Settings, This tablet.", true)
        // Opie's own screen (its tabs, and its apps open full screen) is Opie's to use with device control on; other
        // Android apps, and opening or installing one, only with "Opie uses apps" on too.
        val fg = acc.foregroundPackage()
        val own = fg == ctx.packageName || fg?.startsWith(AppStubs.PREFIX) == true
        val onScreen = name.removePrefix("device_") in setOf("look", "screen", "wait", "tap", "type", "scroll", "key", "pick")
        if (name.removePrefix("device_") != "look" && !(own && onScreen) && !appsOn())
            return text("Opie using apps is off on this tablet. Someone can turn it on in Settings, This tablet, Opie uses apps.", true)
        acc.usingScreen()
        val app = acc.appLabel(acc.foregroundPackage())
        fun after(msg: String): JSONObject {
            Thread.sleep(700)
            refused?.let { refused = null; return text("$it\n\nOn screen now:\n${acc.describe()}", true) }
            return text("$msg${if (acc.pinShowing()) PIN_NOW else ""}\n\nOn screen now:\n${acc.describe()}")
        }
        fun nodeOrPoint(): Pair<AccessibilityNodeInfo?, Pair<Float, Float>?> {
            if (a.has("id")) return (acc.node(a.getInt("id")) ?: return null to null) to null
            if (a.has("x") && a.has("y")) return null to (a.getDouble("x").toFloat() to a.getDouble("y").toFloat())
            return null to null
        }
        return when (name.removePrefix("device_")) {
            "screen" -> {
                // The PIN pad is up (Opie opened something behind the PIN): wait for the person to type it, up to a minute.
                if (acc.pinShowing()) { acc.status("Waiting for the PIN"); val t0 = System.currentTimeMillis(); while (acc.pinShowing() && System.currentTimeMillis() - t0 < 60_000) Thread.sleep(400); Thread.sleep(600) }
                if (acc.pinShowing()) return text("Nobody has typed the PIN yet. Ask once more, or leave it for when someone is at the tablet.\n\nOn screen now:\n${acc.describe()}")
                acc.status("Reading the screen"); text(acc.describe())
            }
            "look" -> {
                acc.status("Looking at the screen")
                val div = a.optInt("scale", 2).coerceIn(1, 8)
                val img = acc.screenshot(div, if (div >= 4) 55 else 70)
                val list = acc.describe()
                JSONObject().put("content", JSONArray().apply {
                    if (img != null) put(JSONObject().put("type", "image").put("data", img).put("mimeType", "image/jpeg"))
                    put(JSONObject().put("type", "text").put("text", "(picture is 1/$div size: multiply by $div for screen coordinates)\n$list"))
                })
            }
            "open_app" -> {
                val q = a.optString("name").trim().lowercase()
                val apps = KioskApps.launchable()
                val hit = apps.firstOrNull { it.second.lowercase() == q } ?: apps.firstOrNull { it.first.lowercase() == q }
                    ?: apps.firstOrNull { it.first.lowercase().startsWith(q) } ?: apps.firstOrNull { it.first.lowercase().contains(q) }
                    ?: return text("No app called \"$q\". Installed: ${apps.joinToString { it.first }}", true)
                if (DeviceRules.neverOpen(hit.second, KioskApps.settingsPackages()))
                    return text("Opie doesn't open ${hit.first}: it's a way out of the tablet's own screen. Someone opens it themselves (Settings, This tablet); to add an app, use install_app.", true)
                if (KioskApps.needsParent(hit.second)) { // system apps (a browser, Files...): someone says yes once
                    if (!acc.approve("Let Opie open ${hit.first}?", "", parent = ParentPin.isSet(ctx), yes = "Open"))
                        return text("Nobody said yes, so ${hit.first} stays closed. Say so, and don't try another way in.", true)
                }
                acc.status("Opening ${hit.first}")
                // An app Opie opens is one of the apps added to this tablet from now on (Apps; kiosk lets it open).
                if (hit.second != ctx.packageName && !hit.second.startsWith(AppStubs.PREFIX) && hit.second != MainActivity.HOST_PKG) AppStore.addToHome(hit.second)
                KioskApps.openApp(hit.second, parentOk = true)
                Thread.sleep(1200)
                after("Opened ${hit.first}.")
            }
            "tap" -> {
                val (node, pt) = nodeOrPoint()
                if (node == null && pt == null) return text("No such element; call screen again for fresh numbers.", true)
                val target = node ?: pt?.let { (x, y) -> nodeAt(acc, x, y) }
                val words = target?.let { acc.words(it) }?.replace(Regex("\\s+"), " ")?.trim() ?: ""
                val label = (target?.contentDescription ?: target?.text)?.toString()?.takeIf { it.isNotBlank() } ?: words.take(40).ifBlank { "there" }
                // Never the last step: paying, ordering, sending, deleting an account (the person taps it), or a password or card field.
                val clickable = generateSequence(target) { it.parent }.take(6).firstOrNull { it.isClickable }
                listOfNotNull(target, clickable).firstNotNullOfOrNull { finalIn(it) }?.let {
                    acc.status("Stopped at “$it”: that one's yours to tap")
                    return text(DeviceRules.refusal(it), true)
                }
                if (ownPrivate(acc, target)) return text(PRIVATE, true)
                if (target != null && secretIn(target))
                    return text("Not done: that's a password or card field, and Opie never fills those in. Ask them to type it themselves.", true)
                val danger = target?.let { risky(it) }
                val ownScreen = (target?.packageName?.toString() ?: acc.foregroundPackage()).let { it == ctx.packageName || it?.startsWith(AppStubs.PREFIX) == true }
                if (danger != null && ownScreen) {
                    // Opie's own (deleting a list, removing an app...): as a person would, after a spoken yes.
                    if (!a.optBoolean("confirmed")) return text("“$danger” is hard to take back. Ask them first in a few words (\"Delete the Groceries list?\"), then tap again with confirmed true once they say yes.", true)
                } else if (danger != null) {
                    val label = danger
                    acc.status("Waiting for a yes: “$label”")
                    val field = acc.fieldText()
                    if (!acc.approve("Tap “$label” in $app?", if (field.isNotBlank()) "“$field”" else "", yes = "Tap"))
                        return text("The people here said no (or didn't answer) to tapping “$label”. Don't try again; tell them it wasn't done.", true)
                }
                val at = pt?.let { android.graphics.PointF(it.first, it.second) } ?: target?.let { Rect().also { r -> it.getBoundsInScreen(r) } }?.let { android.graphics.PointF(it.exactCenterX(), it.exactCenterY()) }
                acc.status("Tapping “$label”", at)
                if (at != null) Thread.sleep(450) // let the assistant get there first, so people can follow along
                val long = a.optBoolean("long")
                actedAt = System.currentTimeMillis()
                val ok = if (node != null) acc.click(node, long) else acc.tap(pt!!.first, pt.second, if (long) 700 else 60)
                if (!ok) return text("That tap didn't go through.", true)
                after("Tapped “$label”.")
            }
            "type" -> {
                val t = a.optString("text")
                val node = if (a.has("id")) acc.node(a.getInt("id")) else acc.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                if (node == null) return text("No text field: give the element number of the field.", true)
                if (ownPrivate(acc, node)) return text(PRIVATE, true)
                if (secretIn(node) || DeviceRules.looksLikeCard(t))
                    return text("Not done: Opie never types passwords or card details. Ask them to type it themselves.", true)
                acc.status("Typing “${t.take(40)}”", Rect().also { node.getBoundsInScreen(it) }.let { android.graphics.PointF(it.exactCenterX(), it.exactCenterY()) })
                actedAt = System.currentTimeMillis()
                if (!node.isFocused) node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
                    Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, t) })
                if (!ok) return text("Couldn't type there.", true)
                if (a.optBoolean("submit")) {
                    val isSearch = Regex("search|find|url", RegexOption.IGNORE_CASE).containsMatchIn(listOfNotNull(node.viewIdResourceName, node.hintText, node.contentDescription).joinToString(" "))
                    val ownPage = node.packageName?.toString().let { it == ctx.packageName || it?.startsWith(AppStubs.PREFIX) == true } // Opie's own (adding to a list): nothing leaves the house
                    if (!isSearch && !ownPage) // a message, a review, a form: Opie writes it, the person sends it
                        return text("Typed “${t.take(60)}”, not sent: Opie never sends messages or forms. Tell them it's written and they can send it themselves.", true)
                    // Opie's own page hears a real Enter (its fields add on keydown; Chromium ignores the accessibility one).
                    val mine = node.packageName?.toString() == ctx.packageName && MainActivity.live != null
                    if (mine) handler.post { MainActivity.live?.window?.decorView?.findFocus()?.let { v ->
                        for (act in listOf(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.ACTION_UP)) v.dispatchKeyEvent(android.view.KeyEvent(act, android.view.KeyEvent.KEYCODE_ENTER)) } }
                    else node.performAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                }
                after("Typed “$t”${if (a.optBoolean("submit")) " and pressed enter" else ""}.")
            }
            "scroll" -> {
                val dir = a.optString("direction").lowercase()
                val node = if (a.has("id")) acc.node(a.getInt("id")) else null
                if (ownPrivate(acc, node)) return text(PRIVATE, true)
                acc.status("Scrolling $dir")
                val act = when (dir) {
                    "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP
                    "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN
                    "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT
                    else -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT
                }
                var done = node?.performAction(act.id) == true ||
                    node?.performAction(if (dir == "up" || dir == "left") AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) == true
                if (!done) {
                    val r = Rect(); (node ?: acc.rootInActiveWindow)?.getBoundsInScreen(r)
                    val cx = r.exactCenterX(); val cy = r.exactCenterY(); val dx = r.width() / 3f; val dy = r.height() / 3f
                    done = when (dir) { // swipe the opposite way to move the content
                        "down" -> acc.swipe(cx, cy + dy, cx, cy - dy)
                        "up" -> acc.swipe(cx, cy - dy, cx, cy + dy)
                        "right" -> acc.swipe(cx + dx, cy, cx - dx, cy)
                        else -> acc.swipe(cx - dx, cy, cx + dx, cy)
                    }
                }
                after(if (done) "Scrolled $dir." else "Couldn't scroll.")
            }
            "key" -> when (a.optString("key").lowercase()) {
                "home" -> { KioskApps.goHome(); text("Back on the family display.") }
                else -> { acc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); after("Pressed back.") }
            }
            "pick" -> {
                val node = acc.node(a.optInt("id", -1)) ?: return text("No such element; look at the screen again for fresh numbers.", true)
                if (ownPrivate(acc, node)) return text(PRIVATE, true)
                val want = a.optString("option").trim()
                if (want.isEmpty()) return text("Say which option.", true)
                val known = acc.windowIds()
                actedAt = System.currentTimeMillis()
                acc.status("Opening the list", Rect().also { node.getBoundsInScreen(it) }.let { android.graphics.PointF(it.exactCenterX(), it.exactCenterY()) })
                if (!acc.click(node)) return text("That didn't open.", true)
                // Its options come up in a window of their own: wait for it (up to 3 s), then the option by what it reads.
                var opts = emptyList<Pair<AccessibilityNodeInfo, String>>()
                val until = System.currentTimeMillis() + 3000
                while (System.currentTimeMillis() < until) { Thread.sleep(250); opts = acc.newWindowTexts(known); if (opts.isNotEmpty()) break }
                if (opts.isEmpty()) return after("Opened it, but its options didn't come up where Opie can read them. If they show in the picture, tap one by x and y.").put("isError", true)
                val norm = { s: String -> s.lowercase().replace(Regex("\\s+"), " ").trim() }
                val hit = opts.firstOrNull { norm(it.second) == norm(want) } ?: opts.firstOrNull { norm(it.second).startsWith(norm(want)) }
                    ?: run { acc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); return text("No option “$want”. The options: ${opts.map { it.second }.distinct().take(40).joinToString(", ")}. (The list is closed again.)", true) }
                finalIn(hit.first)?.let { acc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); return text(DeviceRules.refusal(it), true) }
                acc.status("Choosing “${hit.second.take(40)}”", Rect().also { hit.first.getBoundsInScreen(it) }.let { android.graphics.PointF(it.exactCenterX(), it.exactCenterY()) })
                actedAt = System.currentTimeMillis()
                if (!acc.click(hit.first)) return text("Couldn't choose it.", true)
                after("Chose “${hit.second}”.")
            }
            "wait" -> { acc.status("Waiting for it to load"); Thread.sleep((a.optDouble("seconds", 1.0).coerceIn(0.2, 10.0) * 1000).toLong()); text(acc.describe()) }
            "install_app" -> {
                val given = a.optString("name").trim(); var pkg = a.optString("package").trim()
                if (pkg.isEmpty()) {
                    if (given.isEmpty()) return text("Give the app's name.", true)
                    val q = given.lowercase()
                    val apps = KioskApps.launchable() // on the tablet already: no search, no download
                    pkg = (apps.firstOrNull { it.first.lowercase() == q } ?: apps.firstOrNull { it.first.lowercase().startsWith(q) })?.second ?: run {
                        acc.status("Looking for “$given”")
                        val hits = runCatching { AppStore.search(given) }.getOrElse { return text("Couldn't search Google Play: ${it.message}", true) }
                        val hit = hits.firstOrNull { it.first.lowercase() == q } ?: hits.firstOrNull { it.first.lowercase().startsWith(q) }
                            ?: return text(if (hits.isEmpty()) "Nothing found on Google Play for “$given”." else "Which one? ${hits.take(5).joinToString("; ") { "${it.first} (${it.second})" }}. Call again with its package.", true)
                        hit.second
                    }
                }
                AuroraInstall.installApp(acc, pkg, given)
            }
            else -> text("Unknown tool $name", true)
        }
    }

    private fun nodeAt(acc: DeviceAccess, x: Float, y: Float): AccessibilityNodeInfo? {
        var best: AccessibilityNodeInfo? = null
        fun walk(n: AccessibilityNodeInfo) {
            val r = Rect(); n.getBoundsInScreen(r)
            if (!r.contains(x.toInt(), y.toInt())) return
            best = n
            for (i in 0 until n.childCount) n.getChild(i)?.let(::walk)
        }
        acc.rootInActiveWindow?.let(::walk)
        return best
    }

}
