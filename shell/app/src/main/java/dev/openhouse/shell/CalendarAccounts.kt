package dev.openhouse.shell

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import android.widget.ImageView
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread

/**
 * Two-way calendars (docs/calendar-sync.md): the household's Google and iCloud sign-ins. Like the calendar links
 * ([CalendarLinks]), they're kept here, sealed with a Keystore key in the no-backup folder, never in the household
 * the agent reads. The bridge's calendar-sync.js does the syncing, and every request it makes to Google or iCloud
 * comes through here (DeviceServer /calendar/request): this adds the authorization, and only for that account's own
 * service (Google's Calendar API; the account's CalDAV server). Google: a refresh token from a phone's sign-in
 * through OpenHouse's cloud (/g/start?k=cal); access tokens from the cloud's refresher (through the bridge,
 * /cloud/google/refresh), kept in memory only. iCloud: the Apple ID and an app-specific password, typed here.
 *
 * Never logged: no token, password, Apple ID or calendar address.
 */
object CalendarAccounts {
    private const val TAG = "CalendarAccounts"
    private const val ALIAS = "calendar-accounts"
    private const val GOOGLE_API = "https://www.googleapis.com/calendar/v3/"
    const val ICLOUD = "https://caldav.icloud.com/"
    private val main = Handler(Looper.getMainLooper())
    private lateinit var ctx: Context

    /** provider: "google" (secret: refresh token) or "caldav" (user + secret: app-specific password, at server). */
    class Account(val id: String, val provider: String, val name: String, val who: String, val server: String, val user: String, val secret: String)
    private class Said(m: String) : Exception(m)

    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }

    // --- storage ---------------------------------------------------------------------------------
    private val file get() = File(ctx.noBackupFilesDir, "calendar-accounts")
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    @Synchronized fun list(): List<Account> = runCatching {
        val b = file.readBytes()
        val plain = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12)) }.doFinal(b, 12, b.size - 12)
        val a = JSONArray(String(plain))
        (0 until a.length()).map { a.getJSONObject(it).let { j -> Account(j.getString("id"), j.getString("provider"), j.optString("name"), j.optString("who"), j.optString("server"), j.optString("user"), j.getString("secret")) } }
    }.getOrDefault(emptyList())
    @Synchronized private fun save(all: List<Account>) {
        val plain = JSONArray(all.map { JSONObject().put("id", it.id).put("provider", it.provider).put("name", it.name).put("who", it.who).put("server", it.server).put("user", it.user).put("secret", it.secret) }).toString().toByteArray()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(plain))
        tmp.renameTo(file)
    }
    @Synchronized private fun put(a: Account) = save(list().filter { it.id != a.id } + a)
    @Synchronized fun remove(id: String) { save(list().filter { it.id != id }); tokens.remove(id) }

    /** What the bridge may know: no secrets. */
    fun public(): JSONObject = JSONObject().put("accounts", JSONArray(list().map {
        JSONObject().put("id", it.id).put("provider", it.provider).put("name", it.name).put("who", it.who).apply { if (it.provider == "caldav") put("server", it.server) }
    }))

    // --- requests for the bridge (DeviceServer /calendar/request) ------------------------------------------------
    private val tokens = java.util.concurrent.ConcurrentHashMap<String, Pair<String, Long>>() // account -> (access token, until)
    private val METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "PROPFIND", "REPORT")
    private val PASS = setOf("content-type", "if-match", "if-none-match", "depth")

    /** Only this account's own service: Google's Calendar API, or its CalDAV server (iCloud's are all *.icloud.com). */
    private fun allowed(a: Account, u: URL): Boolean {
        if (u.protocol != "https" || u.userInfo != null) return false
        if (a.provider == "google") return u.host == "www.googleapis.com" && u.path.startsWith("/calendar/v3/")
        val home = runCatching { URL(a.server).host }.getOrNull() ?: return false
        return u.host == home || (home.endsWith("icloud.com") && u.host.endsWith(".icloud.com"))
    }

    fun request(b: JSONObject): JSONObject {
        val a = list().firstOrNull { it.id == b.optString("account") } ?: return JSONObject().put("error", "no such account")
        val u = runCatching { URL(b.optString("url")) }.getOrNull() ?: return JSONObject().put("error", "bad address")
        val method = b.optString("method").uppercase()
        if (method !in METHODS || !allowed(a, u)) return JSONObject().put("error", "not for this account")
        val hs = mutableMapOf<String, String>()
        b.optJSONObject("headers")?.let { h -> h.keys().forEach { k -> if (k.lowercase() in PASS) hs[k.lowercase()] = h.optString(k).take(300) } }
        val body = b.optString("body").takeIf { !b.isNull("body") && it.isNotEmpty() }?.toByteArray()
        return try {
            var r = send(a, method, u, hs, body, fresh = false)
            if (r.code == 401 && a.provider == "google") r = send(a, method, u, hs, body, fresh = true) // expired early
            JSONObject().put("status", r.code).put("body", r.body)
                .put("headers", JSONObject().apply { r.headers["etag"]?.let { put("etag", it) }; r.headers["location"]?.let { put("location", it) } })
        } catch (e: Said) { if (e.message == "signin") JSONObject().put("status", 401).put("body", "") else JSONObject().put("error", e.message) }
        catch (e: Exception) { Log.w(TAG, "request: ${e.javaClass.simpleName}"); JSONObject().put("error", "Couldn't reach it") }
    }

    private fun send(a: Account, method: String, u: URL, hs: Map<String, String>, body: ByteArray?, fresh: Boolean): Http.Res {
        val auth = if (a.provider == "google") "Bearer " + access(a, fresh)
            else "Basic " + Base64.encodeToString("${a.user}:${a.secret}".toByteArray(), Base64.NO_WRAP)
        return Http.call(method, u, hs + ("authorization" to auth), body)
    }

    /** A Google access token: kept for its hour; a new one from the cloud's refresher (it holds the client secret). */
    private fun access(a: Account, fresh: Boolean): String {
        if (!fresh) tokens[a.id]?.takeIf { it.second > System.currentTimeMillis() }?.let { return it.first }
        val (code, text) = bridgePost("/cloud/google/refresh", JSONObject().put("refresh_token", a.secret))
        val j = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        if (code == 200 && j.optString("access_token").length > 10) {
            tokens[a.id] = j.getString("access_token") to (System.currentTimeMillis() + (j.optLong("expires_in", 3600) - 120) * 1000)
            return j.getString("access_token")
        }
        if (j.optString("error") == "invalid_grant") { tokens.remove(a.id); throw Said("signin") } // signed out at Google: sign in again
        throw Said(if (j.optString("error") == "unlinked") "The tablet isn't linked to OpenHouse cloud" else "Google isn't reachable right now")
    }

    private fun bridge(): String = runCatching { dev.openhouse.ui.Openhouse.bridgeUrl }.getOrDefault("http://127.0.0.1:8787")
    /** POST to the bridge: (status, body), errors too (BridgeClient.post hides those). */
    private fun bridgePost(path: String, body: JSONObject): Pair<Int, String> = runCatching {
        val c = dev.openhouse.ui.BridgeClient.open(bridge() + path)
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = 70_000
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = c.responseCode
        code to ((if (code < 400) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: "")
    }.getOrDefault(0 to "")
    private fun bridgeGet(path: String): JSONObject? = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText(bridge() + path, readMs = 30_000)) }.getOrNull()

    // --- Settings' screens ----------------------------------------------------------------------------------------
    /** "Add a calendar": Google or iCloud (two-way), or a calendar's link (read only). Behind the PIN. */
    fun choose(a: Activity, immersive: () -> Unit) {
        thread {
            val cloud = cloudApi()
            main.post {
                val rows = listOf(
                    CalmDialog.Row("Google Calendar", if (cloud != null) "Two-way: what's added here shows up in Google too" else "Two-way. Needs the tablet linked to OpenHouse cloud (Settings, Account)"),
                    CalmDialog.Row("iCloud", "Two-way, with an app-specific password"),
                    CalmDialog.Row("A calendar's link", "Read only: Outlook, a school or team calendar"))
                CalmDialog(a).setTitle("Add a calendar").setWidth(860f).setRows(rows) { _, i ->
                    when (i) {
                        0 -> if (cloud != null) addGoogle(a, cloud, immersive) else CalmDialog(a).setTitle("Link the tablet first").setMessage("Google sign-in goes through OpenHouse cloud: Settings, Account.").setPositiveButton("OK", null).show().also { immersive() }
                        1 -> addICloud(a, immersive)
                        else -> CalendarLinks.add(a, immersive)
                    }
                }.setNeutralButton("Your calendars") { _, _ -> CalendarLinks.manage(a, immersive) } // back to the ones already here
                    .setNegativeButton("Cancel", null).show().also { immersive() }
            }
        }
    }

    private fun cloudApi(): String? = bridgeGet("/cloud/status")?.takeIf { it.optBoolean("linked") }?.optString("api")?.trimEnd('/')
        ?.takeIf { it.startsWith("https://") || it.startsWith("http://localhost") || it.startsWith("http://10.0.2.2") }

    private fun familyNames(): List<String> = runCatching {
        val a = bridgeGet("/household")?.optJSONArray("family") ?: JSONArray()
        (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("name")?.takeIf { n -> n.isNotBlank() } }
    }.getOrDefault(emptyList())

    /** iCloud: the Apple ID and an app-specific password (appleid.apple.com), typed here. Checked before it's kept. */
    fun addICloud(a: Activity, immersive: () -> Unit) {
        thread {
            val names = familyNames()
            main.post {
                val user = Calm.field(a, "Apple ID (email)").apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
                val pass = Calm.field(a, "App-specific password").apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD }
                val who = Calm.field(a, if (names.isEmpty()) "Whose is it? (optional)" else "Whose? " + names.take(4).joinToString(", "))
                val col = Calm.column(a, 12).apply {
                    addView(user); addView(pass); addView(who)
                    addView(Calm.more(a, "Make one at appleid.apple.com: Sign-In and Security, App-Specific Passwords. Your Apple ID needs two-factor authentication. The password stays sealed on this tablet and only reaches iCloud's calendars."))
                }
                CalmDialog(a).setTitle("iCloud calendars").setView(col).setWidth(760f)
                    .setPositiveButton("Sign in") { _, _ ->
                        val u = user.text.toString().trim(); val p = pass.text.toString().replace(" ", "").trim()
                        val w = who.text.toString().trim().let { t -> names.firstOrNull { it.equals(t, true) } ?: t }.take(40)
                        if (u.length < 3 || p.length < 8) { CalmDialog(a).setTitle("Both are needed").setMessage("The Apple ID and an app-specific password.").setPositiveButton("OK", null).show().also { immersive() }; return@setPositiveButton }
                        val acct = Account(UUID.randomUUID().toString().take(8), "caldav", if (w.isNotBlank()) "$w's iCloud" else "iCloud", w, ICLOUD, u, p)
                        signedIn(a, acct, immersive)
                    }.setNegativeButton("Cancel", null).show().also { immersive() }
            }
        }
    }

    /** Kept, its calendars found (the sign-in checked on the way), then which to show. Dropped again if it didn't sign in. */
    private fun signedIn(a: Activity, acct: Account, immersive: () -> Unit) {
        val wait = CalmDialog(a).setTitle("Finding the calendars…").setCancelable(false).show().also { immersive() }
        thread {
            put(acct)
            val (code, text) = bridgePost("/calendar/sync/discover", JSONObject().put("account", acct.id))
            val j = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            if (code != 200) remove(acct.id)
            main.post {
                wait.dismiss()
                if (code != 200) CalmDialog(a).setTitle(if (j.optBoolean("signin")) "That didn't sign in" else "Couldn't reach the calendars")
                    .setMessage(if (j.optBoolean("signin")) (if (acct.provider == "caldav") "Check the Apple ID, and use an app-specific password (not the Apple ID's own)." else "Sign in again from the phone.") else j.optString("error", "Try again in a moment."))
                    .setPositiveButton("OK", null).show().also { immersive() }
                else calendars(a, acct.id, immersive)
            }
        }
    }

    /** Google: a phone on the home Wi-Fi signs in (Google won't let a tablet's page do it), through OpenHouse's cloud. */
    fun addGoogle(a: Activity, cloud: String, immersive: () -> Unit) {
        var dialog: android.app.Dialog? = null
        var got: String? = null
        var state = JSONObject().put("state", "start").put("kind", "cal")
        var self: String? = null // this page's own address, where the sign-in comes back to
        var link: String? = null // the phone's way to Google's sign-in, made when it taps Sign in
        val h = Handoff(a, JSONObject(), minutes = 15, page = "google.html", maxBytes = 8192, once = false,
            infoNow = { JSONObject(state.toString()).put("cloud", cloud).apply { link?.let { put("signin", it) } } },
            onData = { bytes ->
                val j = JSONObject(String(bytes, Charsets.UTF_8))
                if (j.optBoolean("start")) { link = GooglePhotos.signInLink(self ?: throw IllegalStateException("no page"), cal = true) ?: throw IllegalStateException("no link"); return@Handoff }
                val t = j.optString("refresh").takeIf { it.length in 20..2048 } ?: throw IllegalArgumentException("no token")
                if (got == null) { got = t; state = JSONObject().put("state", "signedin").put("kind", "cal"); main.post { dialog?.dismiss() } }
            },
            onEnd = { if (got == null) main.post { dialog?.dismiss() } })
        if (!h.start()) { CalmDialog(a).setTitle("Connect the tablet to Wi-Fi first.").setPositiveButton("Close", null).show().also { immersive() }; return }
        self = h.url!!.substringBefore('#')
        val qr = ImageView(a).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
        val col = Calm.qr(a, qr, Calm.caption(a, "Scan with a phone on this Wi-Fi to sign in to Google. Then choose the calendars here."), 360) { Handoff.share(a, h.url!!) }
        dialog = CalmDialog(a).setTitle("Google Calendar").setWidth(560f).setView(col).setNegativeButton("Cancel", null)
            .setOnDismissListener {
                val t = got
                if (t == null) { h.stop(); return@setOnDismissListener }
                main.postDelayed({ h.stop() }, 10_000) // the phone sees "signed in" first
                thread {
                    val acct = Account(UUID.randomUUID().toString().take(8), "google", "Google", "", "", "", t)
                    put(acct)
                    // Its name: the account's own address (its primary calendar's id), so two Google accounts can be told apart.
                    val name = runCatching { JSONObject(request(JSONObject().put("account", acct.id).put("method", "GET").put("url", GOOGLE_API + "calendars/primary")).optString("body")).optString("id") }.getOrNull()
                    val named = if (!name.isNullOrBlank()) Account(acct.id, acct.provider, name.take(80), acct.who, acct.server, acct.user, acct.secret).also { put(it) } else acct
                    main.post { signedIn(a, named, immersive) }
                }
            }.show().also { immersive() }
    }

    /** Every calendar on one screen: a section for each signed-in account (Sign out beside its name) with a box to show
     *  each of its calendars, then the calendars' links (read only). [account]: kept for callers; all are shown. */
    fun calendars(a: Activity, account: String?, immersive: () -> Unit) {
        thread {
            val j = bridgeGet("/calendar/sync") ?: JSONObject()
            val all = j.optJSONArray("calendars") ?: JSONArray()
            val cals = (0 until all.length()).map { all.getJSONObject(it) }
            val accounts = rows(); val links = CalendarLinks.list()
            main.post {
                val again = { calendars(a, null, immersive) }
                val modeWord = mapOf("two-way" to "Two-way", "read" to "Shown, changed only there", "off" to "Hidden")
                val detail = { c: JSONObject -> listOfNotNull(modeWord[c.optString("mode")],
                    c.optString("who").takeIf { it.isNotBlank() && it != "null" }?.let { "$it's" }, if (c.optBoolean("default") && c.optString("mode") == "two-way") "New events go here" else null).joinToString(" · ") }
                var shown: android.app.Dialog? = null
                val col = Calm.column(a)
                fun header(label: String, action: String?, onAction: (() -> Unit)?) {
                    col.addView(Calm.row(a).apply {
                        gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(Calm.px(a, 16), Calm.px(a, if (col.childCount == 0) 4 else 28), Calm.px(a, 4), Calm.px(a, 4))
                        addView(Calm.eyebrow(a, label), android.widget.LinearLayout.LayoutParams(0, -2, 1f))
                        if (action != null && onAction != null) addView(Calm.quiet(a, action) { onAction() })
                    }, android.widget.LinearLayout.LayoutParams(-1, -2))
                }
                fun line(title: String, sub: android.widget.TextView, tone: String?, lead: android.view.View?, tap: () -> Unit) {
                    val row = Calm.row(a).apply { minimumHeight = Calm.px(a, 72); gravity = android.view.Gravity.CENTER_VERTICAL }
                    if (lead != null) row.addView(lead, android.widget.LinearLayout.LayoutParams(Calm.px(a, 72), Calm.px(a, 72)))
                    row.addView(Calm.column(a, 4).apply {
                        val r = 16 * Calm.u(a)
                        background = Calm.pressable(a, Calm.rounded(0x00FFFFFF, r), r); isClickable = true
                        setPadding(Calm.px(a, if (lead != null) 8 else 16), Calm.px(a, 14), Calm.px(a, 16), Calm.px(a, 14))
                        addView(Calm.row(a, 10).apply { gravity = android.view.Gravity.CENTER_VERTICAL
                            tone?.takeIf { it.startsWith("#") }?.let { t -> addView(android.view.View(a).apply { background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(android.graphics.Color.parseColor(t)) } }, android.widget.LinearLayout.LayoutParams(Calm.px(a, 14), Calm.px(a, 14))) }
                            addView(Calm.text(a, title, 22f, 500)) })
                        addView(sub)
                        setOnClickListener { tap() }
                    }, android.widget.LinearLayout.LayoutParams(0, -2, 1f))
                    col.addView(row, android.widget.LinearLayout.LayoutParams(-1, -2))
                }
                accounts.forEach { (name, kind, id) ->
                    header("${kind.substringBefore(",")} · $name", "Sign out") {
                        CalmDialog(a).setTitle("Sign out of $name?").setMessage("Its calendars leave this tablet. Nothing changes in them.").setDanger()
                            .setPositiveButton("Sign out") { _, _ -> shown?.dismiss(); signOut(id) { again() } }.setNegativeButton("Cancel", null).show().also { immersive() }
                    }
                    cals.filter { it.optString("account") == id }.forEach { c ->
                        val sub = Calm.text(a, detail(c), 17f, 400, Calm.SOFT)
                        val box = Check(a, c.optString("mode") != "off")
                        box.setOnClickListener {
                            box.on = !box.on
                            c.put("mode", if (!box.on) "off" else if (c.optBoolean("canWrite")) "two-way" else "read"); sub.text = detail(c)
                            thread { bridgePost("/calendar/sync/set", JSONObject().put("key", c.optString("key")).put("mode", c.optString("mode"))) }
                        }
                        line(c.optString("name"), sub, c.optString("tone"), box) { shown?.dismiss(); one(a, c, immersive) { again() } }
                    }
                }
                if (links.isNotEmpty()) {
                    header("Links · read only", null, null)
                    links.forEach { l ->
                        val title = l.name.ifBlank { CalendarLinks.label(l.who) }
                        line(title, Calm.text(a, l.only.takeIf { it.isNotBlank() }?.let { "Only $it" } ?: "Read only", 17f, 400, Calm.SOFT), l.tone.takeIf { it.startsWith("#") }, null) {
                            shown?.dismiss()
                            CalmDialog(a).setTitle(title).setItems(arrayOf("Color", "Remove")) { _, i ->
                                if (i == 0) palette(a, title, l.tone.takeIf { it.startsWith("#") }, immersive, { again() }) { t -> thread { CalendarLinks.setTone(l.id, t ?: ""); CalendarLinks.sync(fresh = false); main.post { again() } } }
                                else CalmDialog(a).setTitle("Remove $title?").setDanger()
                                    .setPositiveButton("Remove") { _, _ -> thread { CalendarLinks.remove(l.id); CalendarLinks.sync(); main.post { again() } } }
                                    .setNegativeButton("Cancel") { _, _ -> again() }.show().also { immersive() }
                            }.setNegativeButton("Back") { _, _ -> again() }.show().also { immersive() }
                        }
                    }
                }
                val h = a.resources.displayMetrics.let { minOf(it.widthPixels, it.heightPixels) }
                val list = Calm.Capped(a, (h * .62f).toInt()).apply { addView(col); isVerticalScrollBarEnabled = false }
                shown = CalmDialog(a).setTitle("Calendars").setWidth(860f).apply { if (col.childCount == 0) setMessage("None yet.") else setView(list) }
                    .setNeutralButton("Add a calendar") { _, _ -> choose(a, immersive) }
                    .setPositiveButton("Done", null).show().also { immersive() }
            }
        }
    }

    private fun one(a: Activity, c: JSONObject, immersive: () -> Unit, back: () -> Unit) {
        thread {
            val names = familyNames()
            main.post {
                val key = c.optString("key"); val canWrite = c.optBoolean("canWrite")
                val opts = mutableListOf<Pair<String, JSONObject>>()
                if (canWrite) opts += "Two-way: changes go both ways" to JSONObject().put("mode", "two-way")
                opts += "Shown here, changed only there" to JSONObject().put("mode", "read")
                opts += "Hidden here" to JSONObject().put("mode", "off")
                if (canWrite && c.optString("mode") == "two-way" && !c.optBoolean("default")) opts += "New events go here (unless they're someone's with their own)" to JSONObject().put("default", true)
                opts += "Color" to JSONObject().put("color", true)
                opts += "Everyone's" to JSONObject().put("who", "")
                names.forEach { n -> opts += "$n's" to JSONObject().put("who", n) }
                CalmDialog(a).setTitle(c.optString("name")).setItems(opts.map { it.first }.toTypedArray()) { _, i ->
                    if (opts[i].second.optBoolean("color")) { color(a, c, immersive, back); return@setItems }
                    thread { bridgePost("/calendar/sync/set", opts[i].second.put("key", key)); main.post(back) }
                }.setNegativeButton("Back") { _, _ -> back() }.show().also { immersive() }
            }
        }
    }

    /** A calendar's color, from the household's palette (its events take it unless they're someone's). */
    private fun color(a: Activity, c: JSONObject, immersive: () -> Unit, back: () -> Unit) =
        palette(a, c.optString("name"), c.optString("tone").takeIf { it.startsWith("#") }, immersive, back) { t ->
            thread { bridgePost("/calendar/sync/set", JSONObject().put("key", c.optString("key")).put("tone", t ?: "")); main.post(back) } }

    /** The household's palette (or none) for a calendar's color: [chosen] gets the pick, null for none. */
    private fun palette(a: Activity, title: String, now: String?, immersive: () -> Unit, back: () -> Unit, chosen: (String?) -> Unit) {
        var d: android.app.Dialog? = null
        fun pick(t: String?) { d?.dismiss(); chosen(t) }
        val grid = android.widget.GridLayout(a).apply { columnCount = 6 }
        val s = Calm.px(a, 64); val m = Calm.px(a, 10)
        (listOf<String?>(null) + dev.openhouse.ui.PERSON_COLORS).forEach { t ->
            grid.addView(android.view.View(a).apply {
                background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.OVAL
                    if (t != null) setColor(android.graphics.Color.parseColor(t)) else setStroke(Calm.px(a, 2), Calm.SOFT)
                    if (t == now || (t == null && now == null)) setStroke(Calm.px(a, 4), Calm.INK)
                }
                contentDescription = t ?: "No color"; isClickable = true; setOnClickListener { pick(t) }
            }, android.widget.GridLayout.LayoutParams().apply { width = s; height = s; setMargins(m, m, m, m) })
        }
        d = CalmDialog(a).setTitle("$title's color").setWidth(640f).setView(grid)
            .setNegativeButton("Back") { _, _ -> back() }.show().also { immersive() }
    }

    /** Signed-in accounts, for Settings' Calendars list: (label, detail, remove). */
    fun rows(): List<Triple<String, String, String>> = list().map { Triple(it.name.ifBlank { if (it.provider == "google") "Google" else "iCloud" }, if (it.provider == "google") "Google, two-way" else "iCloud, two-way", it.id) }

    fun signOut(id: String, then: () -> Unit = {}) { thread { remove(id); bridgePost("/calendar/sync/forget", JSONObject().put("account", id)); main.post(then) } }
}

/** A checkbox: a rounded square, filled with a check when [on]. */
private class Check(c: Context, on: Boolean) : android.view.View(c) {
    var on = on; set(v) { field = v; invalidate() }
    private val u = Calm.u(c)
    private val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    init { isClickable = true; contentDescription = "Show" }
    override fun onDraw(cv: android.graphics.Canvas) {
        val s = 28 * u; val l = (width - s) / 2f; val t = (height - s) / 2f; val r = 7 * u
        if (on) { p.style = android.graphics.Paint.Style.FILL; p.color = Calm.INK; cv.drawRoundRect(l, t, l + s, t + s, r, r, p)
            p.style = android.graphics.Paint.Style.STROKE; p.strokeWidth = 3 * u; p.color = 0xFFFFFFFF.toInt(); p.strokeCap = android.graphics.Paint.Cap.ROUND; p.strokeJoin = android.graphics.Paint.Join.ROUND
            cv.drawPath(android.graphics.Path().apply { moveTo(l + s * .26f, t + s * .52f); lineTo(l + s * .44f, t + s * .70f); lineTo(l + s * .76f, t + s * .32f) }, p)
        } else { p.style = android.graphics.Paint.Style.STROKE; p.strokeWidth = 2 * u; p.color = Calm.SOFT; cv.drawRoundRect(l + u, t + u, l + s - u, t + s - u, r, r, p) }
    }
}

/** A small HTTPS/1.1 client: Android's own one won't send PROPFIND or REPORT, which CalDAV needs. */
object Http {
    class Res(val code: Int, val headers: Map<String, String>, val body: String)
    fun call(method: String, u: URL, headers: Map<String, String>, body: ByteArray?, max: Int = 6_000_000): Res {
        require(u.protocol == "https")
        val port = if (u.port > 0) u.port else 443
        val raw = Socket().apply { connect(InetSocketAddress(u.host, port), 15_000); soTimeout = 30_000 }
        val s = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, u.host, port, true) as SSLSocket
        s.use {
            s.startHandshake()
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(u.host, s.session)) throw java.io.IOException("certificate")
            val path = (u.path.ifEmpty { "/" }) + (u.query?.let { "?$it" } ?: "")
            val head = StringBuilder("$method $path HTTP/1.1\r\nHost: ${u.host}${if (port != 443) ":$port" else ""}\r\nUser-Agent: openhouse-calendar/0.2\r\nAccept-Encoding: identity\r\nConnection: close\r\n")
            headers.forEach { (k, v) -> if (!k.contains('\n') && !v.contains('\n') && !v.contains('\r')) head.append("$k: $v\r\n") }
            if (body != null || method in setOf("POST", "PUT", "PATCH", "PROPFIND", "REPORT")) head.append("Content-Length: ${body?.size ?: 0}\r\n")
            head.append("\r\n")
            val out = s.getOutputStream(); out.write(head.toString().toByteArray()); body?.let { out.write(it) }; out.flush()
            val inp = BufferedInputStream(s.getInputStream())
            val status = line(inp) ?: throw java.io.IOException("no answer")
            val code = status.split(' ').getOrNull(1)?.toIntOrNull() ?: throw java.io.IOException("bad answer")
            val hs = mutableMapOf<String, String>()
            while (true) { val l = line(inp) ?: break; if (l.isEmpty()) break; val i = l.indexOf(':'); if (i > 0) hs[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim() }
            val bytes = ByteArrayOutputStream()
            if (method == "HEAD" || code == 204 || code == 304) Unit
            else if (hs["transfer-encoding"]?.contains("chunked", true) == true) {
                while (true) {
                    val n = (line(inp) ?: break).substringBefore(';').trim().toIntOrNull(16) ?: break
                    if (n == 0) break
                    if (bytes.size() + n > max) throw java.io.IOException("too big")
                    bytes.write(read(inp, n)); line(inp)
                }
            } else hs["content-length"]?.toIntOrNull()?.let { n -> if (n > max) throw java.io.IOException("too big"); bytes.write(read(inp, n)) }
                ?: run { val buf = ByteArray(16384); while (true) { val r = inp.read(buf); if (r < 0) break; bytes.write(buf, 0, r); if (bytes.size() > max) throw java.io.IOException("too big") } }
            return Res(code, hs, bytes.toString("UTF-8"))
        }
    }
    private fun read(i: BufferedInputStream, n: Int): ByteArray { val b = ByteArray(n); var o = 0; while (o < n) { val r = i.read(b, o, n - o); if (r < 0) break; o += r }; return if (o == n) b else b.copyOf(o) }
    private fun line(i: BufferedInputStream): String? {
        val sb = ByteArrayOutputStream()
        while (true) { val c = i.read(); if (c < 0) return if (sb.size() == 0) null else sb.toString("UTF-8"); if (c == '\n'.code) return sb.toString("UTF-8").trimEnd('\r'); sb.write(c); if (sb.size() > 16384) throw java.io.IOException("line too long") }
    }
}
