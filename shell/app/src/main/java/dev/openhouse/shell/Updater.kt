package dev.openhouse.shell

// Self-update (docs/self-update.md): the display looks at its release manifest once a day (and when someone asks,
// in Settings), downloads a new release in the background, checks it (SHA-256, same package, a newer version,
// signed by the key this display is signed with or one it rotated to) and installs it itself, as device owner, with
// nobody asked: only when the tablet is quiet, at night unless the release says it's urgent. Before installing it
// stages the release's rescue build (the release before, a version code above) so that UpdateGuard, in its own
// process, can go back to it if the new display doesn't come up healthy. Only the display's own APK changes (and what
// it carries: the bridge, start script, the update cover); the family's files and apps are left as they are.

import android.content.Context
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

internal object Updater {
    private const val TAG = "Updater"
    private const val DAY = 24 * 60 * 60_000L

    /** What Settings shows: where updates stand on this tablet. */
    @Volatile var status = ""; private set
    /** The door's page loaded since this display started (DoorView): half of "healthy". */
    @Volatile var homeLoaded = false

    @Volatile private var busy = false
    @Volatile private var parentAsked = false
    private var lastQuietCheck = 0L

    fun dir(c: Context) = File(c.filesDir, "updates").apply { mkdirs() }
    private fun prefs(c: Context) = c.getSharedPreferences("update", Context.MODE_PRIVATE)
    fun installedCode(c: Context): Long = c.packageManager.getPackageInfo(c.packageName, 0).longVersionCode
    fun installedVersion(c: Context): String = c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: "?"

    /** The manifest's URL: set over adb (ConfigReceiver update_url), else the one this build was made with. Empty: off. */
    fun url(c: Context) = prefs(c).getString("url", null) ?: BuildConfig.UPDATE_URL
    /** Random, made once: only for where this tablet falls in a rollout. Never sent anywhere. */
    private fun deviceId(c: Context) = prefs(c).getString("device", null) ?: UUID.randomUUID().toString().also { prefs(c).edit().putString("device", it).apply() }
    private fun failed(c: Context): Set<Long> = prefs(c).getStringSet("failed", emptySet())!!.mapNotNull { it.toLongOrNull() }.toSet()
    private fun window(c: Context) = prefs(c).getString("hours", "2-5")!!
    /** How long a new display has to come up healthy before UpdateGuard goes back (seconds). */
    fun healthSeconds(c: Context) = prefs(c).getInt("health_s", 300)

    fun configure(c: Context, url: String?, hours: String?, healthS: Int?) {
        val e = prefs(c).edit()
        url?.let { if (it.isEmpty()) e.remove("url") else e.putString("url", it) }
        hours?.let { if (runCatching { Releases.inWindow(0, it) }.isSuccess) e.putString("hours", it) }
        healthS?.let { e.putInt("health_s", it.coerceIn(30, 3600)) }
        e.commit()
    }

    // --- the watchdog's tick (every 10 s, off the main thread) ------------------------------------------------------

    fun tick(c: Context, bridge: String) {
        if (busy) return
        busy = true
        try {
            afterUpdate(c, bridge)
            val now = System.currentTimeMillis()
            if (startedAt == 0L) startedAt = now
            // Once a day (an hour after a failed check), the first a few minutes after the display starts.
            if (url(c).isNotEmpty() && now - startedAt > 3 * 60_000L && now >= prefs(c).getLong("next_check", 0)) check(c)
            if (now - lastQuietCheck > 60_000 || parentAsked) { lastQuietCheck = now; maybeInstall(c, bridge) }
        } catch (e: Exception) { Log.w(TAG, "tick: $e") } finally { busy = false }
    }

    private var startedAt = 0L

    /** Someone's "Check for updates": check now, and install what's found as soon as it's downloaded. */
    fun checkNow(c: Context, install: Boolean, done: (String) -> Unit) = kotlin.concurrent.thread(name = "update-check") {
        while (busy) Thread.sleep(200)
        busy = true
        try {
            check(c)
            if (install && File(dir(c), "ready.json").exists()) { parentAsked = true; status = "Installing ${readyVersion(c)}…" }
        } finally { busy = false }
        done(status)
    }

    fun installNow(c: Context) { parentAsked = true }
    fun readyVersion(c: Context): String? = runCatching { JSONObject(File(dir(c), "ready.json").readText()).getString("version") }.getOrNull()

    // --- checking and downloading ------------------------------------------------------------------------------------

    private fun check(c: Context) {
        val url = url(c)
        val now = System.currentTimeMillis()
        prefs(c).edit().putLong("last_check", now).putLong("next_check", now + DAY).apply()
        if (url.isEmpty()) { status = "Updates are off on this tablet"; return }
        val cred = cloudCredential(c, url)
        val ask = Releases.requestUrl(url, installedCode(c), prefs(c).getString("channel", "stable")!!, if (cred == null) deviceId(c) else null)
        val answer = try { Releases.parseAnswer(fetchText(ask, cred?.let { "Device $it" }), url) } catch (e: Exception) {
            prefs(c).edit().putLong("next_check", now + DAY / 24).apply()
            Log.w(TAG, "manifest $url: $e"); status = "Couldn't check for updates (${e.message?.take(80)})"; return
        }
        answer.checkAgainSeconds?.let { prefs(c).edit().putLong("next_check", now + it * 1000).apply() }
        val r = answer.release ?: run { status = "Up to date"; clearDownloads(c); Log.i(TAG, "checked $url: $status"); return }
        val mine = installedCode(c)
        when (val d = Releases.decide(mine, r, Releases.bucket(deviceId(c), r.versionCode), failed(c))) {
            Decision.UpToDate -> { status = "Up to date"; clearDownloads(c) }
            Decision.FailedHere -> status = "Version ${r.version} didn't start properly here, so this tablet stays on ${installedVersion(c)}"
            Decision.NotYet -> status = "Version ${r.version} is coming to tablets a few at a time; not this one yet"
            is Decision.Take -> {
                download(c, d.release, d.urgent)
                if (!File(dir(c), "ready.json").exists()) prefs(c).edit().putLong("next_check", now + DAY / 24).apply() // try again in an hour
            }
        }
        Log.i(TAG, "checked $url: $status")
    }

    private fun download(c: Context, r: Release, urgent: Boolean) {
        val d = dir(c)
        val ready = File(d, "ready.json")
        val had = runCatching { JSONObject(ready.readText()) }.getOrNull()
        if (had != null && had.optLong("versionCode") == r.versionCode) {
            // Already downloaded: the manifest may have changed since (made urgent with minVersion, new notes).
            ready.writeText(had.put("urgent", urgent).put("notes", r.notes).toString())
            status = "Version ${r.version} is ready to install"; return
        }
        clearDownloads(c)
        status = "Downloading version ${r.version}"
        val apk = File(d, "update.apk")
        fetchVerified(r.apk, apk)?.let { status = "Version ${r.version}: $it"; return }
        verifyApp(c, apk, r.versionCode)?.let { apk.delete(); status = "Version ${r.version} was refused: $it"; Log.w(TAG, status); return }
        var rescue: ApkRef? = null
        r.rescue?.let { ref ->
            val f = File(d, "rescue.apk")
            val bad = fetchVerified(ref, f) ?: verifyApp(c, f, ref.versionCode)
            if (bad == null) rescue = ref else { f.delete(); Log.w(TAG, "rescue build ${ref.version}: $bad") }
        }
        ready.writeText(JSONObject().put("version", r.version).put("versionCode", r.versionCode).put("urgent", urgent).put("notes", r.notes)
            .put("rescueVersion", rescue?.version).put("rescueCode", rescue?.versionCode ?: 0).toString())
        status = "Version ${r.version} is ready to install" + if (rescue == null) " (Settings, Updates, Install now)" else ""
        Log.i(TAG, status)
    }

    private fun clearDownloads(c: Context) { for (n in listOf("ready.json", "update.apk", "rescue.apk", "update.apk.part", "rescue.apk.part")) File(dir(c), n).delete() }

    /**
     * The managed cloud's credential for this tablet, when someone linked it to a family (the bridge keeps it in
     * display/.cloud/device.json) and only for the cloud's own address: it never goes to another host.
     */
    private fun cloudCredential(c: Context, url: String): String? = runCatching {
        val d = JSONObject(File(c.filesDir, "display/.cloud/device.json").readText())
        val api = java.net.URI(d.getString("api")); val u = java.net.URI(url)
        d.getString("credential").takeIf { api.scheme == u.scheme && api.host == u.host && api.port == u.port && it.isNotEmpty() }
    }.getOrNull()

    private fun open(url: String, auth: String? = null): HttpURLConnection {
        var u = URL(url)
        val origin = URL(url)
        repeat(5) { // GitHub's release links redirect (to its file host); HttpURLConnection follows only same-scheme
            val h = (u.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000; readTimeout = 30_000; instanceFollowRedirects = false; setRequestProperty("User-Agent", "openhouse-display")
                if (auth != null && u.host == origin.host) setRequestProperty("Authorization", auth) // never carried to a redirect's host
            }
            if (h.responseCode in 300..399) {
                val next = URL(u, h.getHeaderField("Location")); h.disconnect()
                require(next.protocol == "https" || next.protocol == u.protocol) { "redirected to ${next.protocol}" }
                u = next
            } else {
                if (h.responseCode != 200) { h.disconnect(); throw java.io.IOException("HTTP ${h.responseCode}") }
                return h
            }
        }
        throw java.io.IOException("too many redirects")
    }

    private fun fetchText(url: String, auth: String? = null) = open(url, auth).run { try { inputStream.bufferedReader().readText() } finally { disconnect() } }

    /** Download to [to] (through a .part file); null when it's the right file, else what went wrong. */
    private fun fetchVerified(ref: ApkRef, to: File): String? {
        if (to.exists() && sha256(to) == ref.sha256) return null
        val part = File(to.path + ".part")
        return try {
            val md = MessageDigest.getInstance("SHA-256")
            open(ref.url).run {
                try { inputStream.use { i -> part.outputStream().use { o -> val b = ByteArray(1 shl 16); while (true) { val n = i.read(b); if (n < 0) break; md.update(b, 0, n); o.write(b, 0, n) } } } }
                finally { disconnect() }
            }
            val got = md.digest().joinToString("") { "%02x".format(it) }
            when {
                got != ref.sha256 -> { part.delete(); "the download didn't match its checksum" }
                ref.size >= 0 && part.length() != ref.size -> { part.delete(); "the download was the wrong size" }
                else -> { to.delete(); part.renameTo(to); null }
            }
        } catch (e: Exception) { part.delete(); "couldn't download (${e.message?.take(80)})" }
    }

    private fun sha256(f: File) = MessageDigest.getInstance("SHA-256").let { md -> f.inputStream().use { i -> val b = ByteArray(1 shl 16); while (true) { val n = i.read(b); if (n < 0) break; md.update(b, 0, n) } }; md.digest().joinToString("") { "%02x".format(it) } }

    /** Is [apk] this app, at [code], signed by the key the installed display is signed with (or rotated from it)? Null: yes. */
    fun verifyApp(c: Context, apk: File, code: Long): String? {
        val pm = c.packageManager
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        @Suppress("DEPRECATION")
        val info = (if (Build.VERSION.SDK_INT >= 33) pm.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(flags.toLong())) else pm.getPackageArchiveInfo(apk.path, flags))
            ?: return "it isn't an Android app"
        if (info.packageName != c.packageName) return "it's another app (${info.packageName})"
        if (info.longVersionCode != code) return "its version (${info.longVersionCode}) isn't the manifest's ($code)"
        if (info.applicationInfo?.flags?.and(android.content.pm.ApplicationInfo.FLAG_TEST_ONLY) != 0) return "it's a test build"
        val s = info.signingInfo ?: return "it isn't signed"
        fun hex(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
        val signers = s.apkContentsSigners.map { hex(it.toByteArray()) }
        val history = if (s.hasPastSigningCertificates()) s.signingCertificateHistory.map { hex(it.toByteArray()) } else emptyList()
        val mine = pm.getPackageInfo(c.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo!!.apkContentsSigners.map { hex(it.toByteArray()) }
        if (!Releases.signerAllowed(mine, signers, history)) return "it isn't signed with this display's key"
        return null
    }

    // --- installing --------------------------------------------------------------------------------------------------

    /** No turn running, no one talking or being heard, nobody at the screen for a while, no app open over the board. */
    private fun quiet(bridge: String): Boolean {
        val o = dev.openhouse.ui.Openhouse
        if (!o.idle || o.speaking || System.currentTimeMillis() - o.hearingAt < 120_000) return false
        val st = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("$bridge/state", 3000, 5000)).optString("state") }.getOrNull()
        return st == "idle"
    }

    private fun maybeInstall(c: Context, bridge: String) {
        val readyF = File(dir(c), "ready.json")
        if (!readyF.exists()) { parentAsked = false; return }
        val ready = JSONObject(readyF.readText())
        val code = ready.getLong("versionCode")
        if (code <= installedCode(c)) { clearDownloads(c); parentAsked = false; return }
        val rescueCode = ready.optLong("rescueCode", 0)
        val rescue = File(dir(c), "rescue.apk").takeIf { rescueCode > 0 && it.exists() }
        val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
        val asked = parentAsked
        if (!Releases.mayInstall(quiet(bridge), asked, ready.optBoolean("urgent"), rescue != null, Releases.inWindow(hour, window(c)))) return
        parentAsked = false
        install(c, File(dir(c), "update.apk"), ready.getString("version"), code, rescue, rescueCode, ready.optString("rescueVersion"))
    }

    private fun install(c: Context, apk: File, version: String, code: Long, rescue: File?, rescueCode: Long, rescueVersion: String) {
        // Checked again: the files sat on the tablet since they were downloaded.
        verifyApp(c, apk, code)?.let { status = "Version $version was refused: $it"; clearDownloads(c); return }
        val session = rescue?.let { r -> if (verifyApp(c, r, rescueCode) == null) stage(c, r) else null }
        if (rescue != null && session == null) Log.w(TAG, "couldn't stage the rescue build: installing without one")
        File(dir(c), "healthy").delete()
        File(dir(c), "pending.json").writeText(JSONObject().put("from", installedCode(c)).put("fromVersion", installedVersion(c))
            .put("to", code).put("version", version).put("rescueCode", if (session != null) rescueCode else 0).put("rescueVersion", rescueVersion)
            .put("session", session ?: -1).put("at", System.currentTimeMillis()).put("healthS", healthSeconds(c)).toString())
        UpdateGuard.schedule(c, healthSeconds(c) * 1000L) // also scheduled by the new display when it's replaced; whichever is there
        status = "Installing version $version"
        Log.i(TAG, "installing $version ($code), rescue ${if (session != null) "$rescueVersion ($rescueCode) staged" else "none"}")
        UpdateCover.up(c)
        Thread.sleep(1200) // the cover is up before the display goes
        AppStore.init(c)
        val (ok, msg) = AppStore.install(listOf(apk), "the display $version")
        // On success Android stops this process before we get here; reaching it means the install didn't happen.
        Log.w(TAG, "install $version: $ok $msg")
        File(dir(c), "pending.json").delete()
        session?.let { runCatching { c.packageManager.packageInstaller.abandonSession(it) } }
        UpdateCover.down(c)
        status = "Version $version didn't install ($msg)"
        if (!ok) { remember(c, code); clearDownloads(c) }
    }

    /** Write the rescue build into an install session, not committed: UpdateGuard commits it if it must go back. */
    private fun stage(c: Context, apk: File): Int? = runCatching {
        val pi = c.packageManager.packageInstaller
        // An earlier staged rescue left behind (an update that didn't happen) is no use: start clean.
        pi.mySessions.filter { it.appPackageName == c.packageName }.forEach { runCatching { pi.abandonSession(it.sessionId) } }
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(c.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            setInstallReason(PackageManager.INSTALL_REASON_POLICY)
            setSize(apk.length())
        }
        val id = pi.createSession(params)
        pi.openSession(id).use { s -> apk.inputStream().use { i -> s.openWrite("base.apk", 0, apk.length()).use { o -> i.copyTo(o, 1 shl 16); s.fsync(o) } } }
        id
    }.onFailure { Log.w(TAG, "stage rescue: $it") }.getOrNull()

    private fun remember(c: Context, code: Long) {
        val s = prefs(c).getStringSet("failed", emptySet())!!.toMutableSet().apply { add(code.toString()) }
        prefs(c).edit().putStringSet("failed", s).apply()
    }

    // --- after an update: healthy, or went back ----------------------------------------------------------------------

    /**
     * Just updated: once the bridge answers and the door's page has loaded, this display is healthy (UpdateGuard then
     * leaves it be). Just gone back to the rescue build: remember that release failed here, so it isn't tried again.
     */
    private fun afterUpdate(c: Context, bridge: String) {
        val pf = File(dir(c), "pending.json")
        if (!pf.exists()) return
        val p = runCatching { JSONObject(pf.readText()) }.getOrNull() ?: return run { pf.delete() }
        val mine = installedCode(c)
        val to = p.getLong("to")
        when {
            mine == to -> {
                if (File(dir(c), "healthy").exists()) return
                val bridgeOk = runCatching { dev.openhouse.ui.BridgeClient.getText("$bridge/state", 3000, 5000) }.isSuccess
                if (!bridgeOk || !homeLoaded) { status = "Version ${p.optString("version")} is starting"; return }
                File(dir(c), "healthy").writeText(mine.toString())
                p.optInt("session", -1).takeIf { it >= 0 }?.let { runCatching { c.packageManager.packageInstaller.abandonSession(it) } }
                UpdateGuard.cancel(c)
                pf.delete(); clearDownloads(c)
                history(c, "Updated from ${p.optString("fromVersion")} to ${p.optString("version")}")
                status = "Updated to ${p.optString("version")}"
                Log.i(TAG, "healthy on $to")
            }
            mine == p.optLong("rescueCode", -1) -> {
                remember(c, to)
                pf.delete(); clearDownloads(c)
                File(dir(c), "healthy").writeText(mine.toString())
                history(c, "Version ${p.optString("version")} didn't start properly, so it went back to ${p.optString("rescueVersion")}")
                status = "Version ${p.optString("version")} didn't start properly, so this tablet went back to ${p.optString("rescueVersion")}"
                Log.w(TAG, status)
            }
            mine == p.optLong("from") && System.currentTimeMillis() - p.optLong("at") > 10 * 60_000L -> { pf.delete() } // the install never happened
        }
    }

    private fun history(c: Context, line: String) {
        val a = runCatching { JSONArray(prefs(c).getString("history", "[]")) }.getOrDefault(JSONArray())
        a.put(JSONObject().put("at", System.currentTimeMillis()).put("text", line))
        while (a.length() > 20) a.remove(0)
        prefs(c).edit().putString("history", a.toString()).apply()
    }

    /** The last few things updates did here, newest first. */
    fun historyLines(c: Context): List<String> = runCatching {
        val a = JSONArray(prefs(c).getString("history", "[]"))
        val f = java.text.SimpleDateFormat("d MMM HH:mm", java.util.Locale.getDefault())
        (a.length() - 1 downTo 0).map { a.getJSONObject(it).let { o -> "${f.format(java.util.Date(o.getLong("at")))}  ${o.getString("text")}" } }
    }.getOrDefault(emptyList())
}
