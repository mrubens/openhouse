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
 * through Opie's cloud (/g/start?k=cal); access tokens from the cloud's refresher (through the bridge,
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
        } catch (e: Said) {
            when (e.message) {
                "signin" -> JSONObject().put("status", 401).put("body", "")
                // (The bridge passes `unlinked` on, so a screen can offer to link: linkFirst.)
                "unlinked" -> JSONObject().put("error", "The device isn't linked to Opie cloud").put("unlinked", true)
                else -> JSONObject().put("error", e.message)
            }
        }
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
        throw Said(if (j.optString("error") == "unlinked") "unlinked" else "Google isn't reachable right now")
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
                    CalmDialog.Row("Google Calendar", if (cloud != null) "Two-way: what's added here shows up in Google too" else "Two-way, through Opie cloud: free"),
                    CalmDialog.Row("iCloud", "Two-way, with an app-specific password"),
                    CalmDialog.Row("A calendar's link", "Read only: Outlook, a school or team calendar"))
                CalmDialog(a).setTitle("Add a calendar").setWidth(860f).setRows(rows) { _, i ->
                    when (i) {
                        0 -> google(a, immersive, cloud)
                        1 -> addICloud(a, immersive)
                        else -> CalendarLinks.add(a, immersive)
                    }
                }.setNeutralButton("Your calendars") { _, _ -> CalendarLinks.manage(a, immersive) } // back to the ones already here
                    .setNegativeButton("Cancel", null).show().also { immersive() }
            }
        }
    }

    /** Google's sign-in, through Opie cloud: the tablet linked first. [cloud]: the account's API, if it's known. */
    fun google(a: Activity, immersive: () -> Unit, cloud: String? = null) {
        if (cloud != null) return addGoogle(a, cloud, immersive)
        thread {
            val c = cloudApi()
            main.post { if (c != null) addGoogle(a, c, immersive) else linkFirst(a, immersive) }
        }
    }

    /** Not linked: Google's sign-in goes through Opie cloud, and linking is free, so offer it (with the PIN, as Settings,
     *  Account asks), then go on to Google's sign-in. */
    private fun linkFirst(a: Activity, immersive: () -> Unit) {
        val act = a as? MainActivity
        CalmDialog(a).setTitle("Link the device first").setMessage("Google Calendar signs in through Opie cloud. Linking is free.")
            .apply { if (act != null) setPositiveButton("Link") { _, _ -> act.lock.always { CloudMenu(act).startLink { google(a, immersive) } } }.setNegativeButton("Cancel", null) else setPositiveButton("OK", null) }
            .show().also { immersive() }
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
                    addView(Calm.more(a, "Make one at appleid.apple.com: Sign-In and Security, App-Specific Passwords. Your Apple ID needs two-factor authentication. The password stays sealed on this device and only reaches iCloud's calendars."))
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

    /** iCloud from the setup's phone or computer (DeviceServer /setup/icloud): the Apple ID and app-specific password
     *  typed there, sealed on the way, checked here before they're kept; then which calendars to show, on the tablet.
     *  null once it signed in, else what went wrong, for that phone. Runs off the main thread. */
    fun addICloudFrom(a: Activity, user: String, pass: String, who: String, immersive: () -> Unit): String? {
        val u = user.trim().take(200); val p = pass.replace(" ", "").trim().take(100)
        if (u.length < 3 || p.length < 8) return "Both are needed: the Apple ID and an app-specific password."
        val names = familyNames()
        val w = who.trim().let { t -> names.firstOrNull { it.equals(t, true) } ?: t }.take(40)
        val acct = Account(UUID.randomUUID().toString().take(8), "caldav", if (w.isNotBlank()) "$w's iCloud" else "iCloud", w, ICLOUD, u, p)
        put(acct)
        val (code, text) = bridgePost("/calendar/sync/discover", JSONObject().put("account", acct.id))
        if (code != 200) {
            remove(acct.id)
            val j = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            return if (j.optBoolean("signin")) "That didn't sign in. Check the Apple ID, and use an app-specific password (not the Apple ID's own)." else j.optString("error", "Couldn't reach the calendars. Try again in a moment.")
        }
        main.post { calendars(a, acct.id, immersive) }
        return null
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
                if (code != 200 && j.optBoolean("unlinked")) linkFirst(a, immersive)
                else if (code != 200) CalmDialog(a).setTitle(if (j.optBoolean("signin")) "That didn't sign in" else "Couldn't reach the calendars")
                    .setMessage(if (j.optBoolean("signin")) (if (acct.provider == "caldav") "Check the Apple ID, and use an app-specific password (not the Apple ID's own)." else "Sign in again from the phone.") else j.optString("error", "Try again in a moment."))
                    .setPositiveButton("OK", null).show().also { immersive() }
                else calendars(a, acct.id, immersive)
            }
        }
    }

    /** Google: a phone on the home Wi-Fi signs in (Google won't let a tablet's page do it), through Opie's cloud. */
    fun addGoogle(a: Activity, cloud: String, immersive: () -> Unit, remote: ((String?) -> Unit)? = null) {
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
        if (!h.start()) { remote?.invoke(null); CalmDialog(a).setTitle("Connect the device to Wi-Fi first.").setPositiveButton("Close", null).show().also { immersive() }; return }
        self = h.url!!.substringBefore('#')
        // From the setup's phone or computer (DeviceServer /setup/google): the sign-in opens there, with no code to scan.
        remote?.invoke(h.url!!)
        val col = if (remote != null) Calm.column(a).apply { addView(Calm.caption(a, "Sign in to Google on the phone or computer, then choose the calendars here.")) }
            else Calm.qr(a, ImageView(a).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }, Calm.caption(a, "Scan with a phone on this Wi-Fi to sign in to Google. Then choose the calendars here."), 360) { Handoff.share(a, h.url!!) }
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

    /** What the calendars list shows, read off the main thread: the synced calendars, the signed-in accounts, the links. */
    internal class Shown(val cals: List<JSONObject>, val accounts: List<Triple<String, String, String>>, val links: List<CalendarLinks.Link>) {
        /** How many are shown (an account's ones that aren't hidden, and links). */
        val count: Int get() = cals.count { it.optString("mode") != "off" } + links.size
        val none: Boolean get() = accounts.isEmpty() && links.isEmpty()
    }

    internal fun shown(): Shown {
        val all = bridgeGet("/calendar/sync")?.optJSONArray("calendars") ?: JSONArray()
        return Shown((0 until all.length()).map { all.getJSONObject(it) }, rows(), CalendarLinks.list())
    }

    /** Every calendar on one screen (the same rows as Settings' Connections): each signed-in account (Sign out beside
     *  it) with a box to show each of its calendars, then the calendars' links (read only). [account]: kept for callers. */
    fun calendars(a: Activity, account: String?, immersive: () -> Unit) {
        thread {
            val s = shown()
            main.post {
                var shown: android.app.Dialog? = null
                val l = Lines(a)
                fill(a, l, s, immersive, again = { calendars(a, null, immersive) }, close = { shown?.dismiss() })
                val h = a.resources.displayMetrics.let { minOf(it.widthPixels, it.heightPixels) }
                val list = Calm.Capped(a, (h * .62f).toInt()).apply { addView(l.col); isVerticalScrollBarEnabled = false }
                shown = CalmDialog(a).setTitle("Calendars").setWidth(860f).apply { if (s.none) setMessage("None yet.") else setView(list) }
                    .setNeutralButton("Add a calendar") { _, _ -> choose(a, immersive) }
                    .setPositiveButton("Done", null).show().also { immersive() }
            }
        }
    }

    /** The calendars' rows into [l]: each account, its calendars (a box to show each), then the links. [again] shows
     *  them again after a change; [close] takes away the page they're on before a step opens. */
    internal fun fill(a: Activity, l: Lines, s: Shown, immersive: () -> Unit, again: () -> Unit, close: () -> Unit) {
        val modeWord = mapOf("two-way" to "Two-way", "read" to "Shown, changed only there", "off" to "Hidden")
        val detail = { c: JSONObject -> listOfNotNull(modeWord[c.optString("mode")],
            c.optString("who").takeIf { it.isNotBlank() && it != "null" }?.let { "$it's" }, if (c.optBoolean("default") && c.optString("mode") == "two-way") "New events go here" else null).joinToString(" · ") }
        s.accounts.forEach { (name, kind, id) ->
            l.line(name, l.soft(kind), end = Calm.quiet(a, "Sign out") {
                CalmDialog(a).setTitle("Sign out of $name?").setMessage("Its calendars leave this device. Nothing changes in them.").setDanger()
                    .setPositiveButton("Sign out") { _, _ -> close(); signOut(id) { again() } }.setNegativeButton("Cancel", null).show().also { immersive() }
            })
            s.cals.filter { it.optString("account") == id }.forEach { c ->
                val sub = l.soft(detail(c))
                val box = Check(a, c.optString("mode") != "off")
                box.setOnClickListener {
                    box.on = !box.on
                    c.put("mode", if (!box.on) "off" else if (c.optBoolean("canWrite")) "two-way" else "read"); sub.text = detail(c)
                    thread { bridgePost("/calendar/sync/set", JSONObject().put("key", c.optString("key")).put("mode", c.optString("mode"))) }
                }
                l.line(c.optString("name"), sub, c.optString("tone"), box) { close(); one(a, c, immersive) { again() } }
            }
        }
        s.links.forEach { lk ->
            val title = lk.name.ifBlank { CalendarLinks.label(lk.who) }
            // One that couldn't be read at the last look says so, and why (a tap: Remove).
            val why = CalendarLinks.problem(lk.id)
            val sub = why?.let { "Can't read it: $it" } ?: lk.only.takeIf { it.isNotBlank() }?.let { "Only $it, read only" } ?: "Read only"
            l.line(title, l.soft(sub).apply { if (why != null) setTextColor(Calm.INK) }, lk.tone.takeIf { it.startsWith("#") }) {
                close()
                CalmDialog(a).setTitle(title).setItems(arrayOf("Color", "Remove")) { _, i ->
                    if (i == 0) palette(a, title, lk.tone.takeIf { it.startsWith("#") }, immersive, { again() }) { t -> thread { CalendarLinks.setTone(lk.id, t ?: ""); CalendarLinks.sync(fresh = false); main.post { again() } } }
                    else CalmDialog(a).setTitle("Remove $title?").setDanger()
                        .setPositiveButton("Remove") { _, _ -> thread { CalendarLinks.remove(lk.id); CalendarLinks.sync(); main.post { again() } } }
                        .setNegativeButton("Cancel") { _, _ -> again() }.show().also { immersive() }
                }.setNegativeButton("Back") { _, _ -> again() }.show().also { immersive() }
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

    /** Signed-in accounts, for the calendars' rows: (label, detail, remove). */
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
