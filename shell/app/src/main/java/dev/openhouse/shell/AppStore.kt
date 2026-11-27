package dev.openhouse.shell

import android.app.Activity
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Adding Android apps, through Aurora Store (an open-source Google Play client that signs in with a
 * shared anonymous account from Aurora's own dispenser: nobody's Google account is involved).
 *
 * Aurora finds and downloads the APKs. Installing is the shell's job: Aurora's "Native" installer
 * hands each APK out as an ACTION_INSTALL_PACKAGE intent, and as device owner the shell makes
 * [InstallActivity] the persistent handler for that intent. The shell then installs the files with
 * its own PackageInstaller session, which a device owner commits without any system prompt. The
 * system installer's own dialog never shows (in lock task it couldn't open anyway), so someone's
 * yes on the shell's card is the only gate, whether the agent asked or someone tapped Install in
 * Aurora. The card asks for the PIN (no PIN set: nothing installs), and says where the files
 * really came from: the app whose content provider served them, not what the APK calls itself.
 */
object AppStore {
    const val AURORA = "com.aurora.store"
    // Aurora Store 4.8.4, the build F-Droid publishes. Hash and signer checked against F-Droid's
    // signed index (index-v2.json via entry.jar, signed by F-Droid's repo key 43238d51...).
    private const val AURORA_URL = "https://f-droid.org/repo/com.aurora.store_76.apk"
    private const val AURORA_SHA256 = "fd9c75d90d0f4a7c132b9b4a5a2cf1992a45e03b8d8ff988b7dcfbc0db2c4d11"
    private const val AURORA_SIGNER = "5c83c7672b929955dc0a1db89a5e6ae4389e2eae7ec939956041694e5815f532"
    private const val TAG = "AppStore"
    private const val ACTION_DONE = "dev.openhouse.shell.INSTALL_DONE"
    private const val APPROVED_MS = 15 * 60_000L

    private lateinit var ctx: Context
    private val prefs by lazy { ctx.getSharedPreferences("store", Context.MODE_PRIVATE) }
    /** Packages someone already said yes to (via install_app), until this time. */
    private val approved = HashMap<String, Long>()
    /** Someone waiting for a package to finish installing: package -> callback(ok, message). */
    private val waiting = HashMap<String, (Boolean, String) -> Unit>()
    /** Files arriving from Aurora, grouped by the folder they came from (one app's splits). */
    private val incoming = LinkedHashMap<String, MutableList<File>>()
    private val pending = HashMap<String, Runnable>()
    private val handler by lazy { android.os.Handler(ctx.mainLooper) }
    /** Called after an app is added (the home board refreshes its stickers). */
    var onChanged: (() -> Unit)? = null

    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }

    private val dpm get() = ctx.getSystemService(DevicePolicyManager::class.java)
    private val admin get() = ComponentName(ctx, AdminReceiver::class.java)
    private fun isOwner() = dpm.isDeviceOwnerApp(ctx.packageName)

    /** Device owner: send every "install this APK" intent to the shell rather than the system installer. */
    fun claimInstallIntents() {
        if (!isOwner()) return
        runCatching {
            val f = IntentFilter(Intent.ACTION_INSTALL_PACKAGE).apply {
                addCategory(Intent.CATEGORY_DEFAULT); addDataScheme("content"); addDataScheme("file")
                addDataType("application/vnd.android.package-archive")
            }
            dpm.addPersistentPreferredActivity(admin, f, ComponentName(ctx, InstallActivity::class.java))
        }.onFailure { Log.w(TAG, "claim install intents: $it") }
    }

    fun installed(pkg: String) = runCatching { ctx.packageManager.getPackageInfo(pkg, 0); true }.getOrDefault(false)
    fun label(pkg: String) = runCatching { ctx.packageManager.getApplicationInfo(pkg, 0).loadLabel(ctx.packageManager).toString() }.getOrDefault(pkg)

    // --- Aurora itself ----------------------------------------------------------------------

    private fun signer(info: android.content.pm.PackageInfo?): String? =
        info?.signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()?.let { sha256(it) }
    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    /** Aurora on the device and allowed in kiosk; downloads (checked) and installs it if it isn't. */
    fun ensureAurora(status: (String) -> Unit): String? {
        val pm = ctx.packageManager
        if (installed(AURORA)) {
            val s = signer(runCatching { pm.getPackageInfo(AURORA, PackageManager.GET_SIGNING_CERTIFICATES) }.getOrNull())
            if (s != AURORA_SIGNER) return "The Aurora Store on this device isn't the F-Droid build (signer $s). Uninstall it in Android's settings."
            setUpAurora(); return null
        }
        status("Getting Aurora Store")
        val f = File(ctx.cacheDir, "aurora.apk")
        val err = runCatching {
            val c = URL(AURORA_URL).openConnection() as HttpURLConnection
            c.connectTimeout = 15_000; c.readTimeout = 30_000
            if (c.responseCode != 200) error("F-Droid answered ${c.responseCode}")
            val md = MessageDigest.getInstance("SHA-256")
            c.inputStream.use { i -> f.outputStream().use { o ->
                val buf = ByteArray(64 * 1024); while (true) { val n = i.read(buf); if (n < 0) break; md.update(buf, 0, n); o.write(buf, 0, n) }
            } }
            val got = md.digest().joinToString("") { "%02x".format(it) }
            if (got != AURORA_SHA256) error("the download's checksum is wrong ($got)")
            val s = signer(pm.getPackageArchiveInfo(f.path, PackageManager.GET_SIGNING_CERTIFICATES))
            if (s != AURORA_SIGNER) error("the download isn't signed by F-Droid ($s)")
            null
        }.getOrElse { "Couldn't get Aurora Store: ${it.message}" }
        if (err != null) { f.delete(); return err }
        status("Installing Aurora Store")
        val (ok, msg) = install(listOf(f), "Aurora Store")
        f.delete()
        if (!ok) return "Couldn't install Aurora Store: $msg"
        setUpAurora()
        return null
    }

    /** Let Aurora run inside kiosk, and give it its permissions so its first run doesn't stop to ask. */
    private fun setUpAurora() {
        KioskApps.allowInKiosk(AURORA, temporary = true) // the PIN opened it; out again when the display is back
        if (!isOwner()) return
        for (p in listOf("android.permission.POST_NOTIFICATIONS")) runCatching {
            dpm.setPermissionGrantState(admin, AURORA, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        }
    }

    /** Aurora's first run (sign-in, Native installer) is done, for the Aurora installed now. */
    fun auroraReady(): Boolean = installedAt(AURORA)?.let { prefs.getLong("aurora_ready", 0) == it } ?: false
    fun auroraReady(done: Boolean) { prefs.edit().putLong("aurora_ready", if (done) installedAt(AURORA) ?: 0 else 0).apply() }
    /** Android's "Install unknown apps" switch for Aurora (Aurora won't start an install without it). */
    fun auroraMayInstall(): Boolean = runCatching {
        val uid = ctx.packageManager.getApplicationInfo(AURORA, 0).uid
        ctx.getSystemService(android.app.AppOpsManager::class.java)
            .unsafeCheckOpNoThrow("android:request_install_packages", uid, AURORA) == android.app.AppOpsManager.MODE_ALLOWED
    }.getOrDefault(false)
    private fun installedAt(pkg: String) = runCatching { ctx.packageManager.getPackageInfo(pkg, 0).firstInstallTime }.getOrNull()

    // --- finding apps -----------------------------------------------------------------------

    /** Search Google Play's public web search (no account): name and package of the top hits. */
    fun search(q: String): List<Pair<String, String>> {
        val url = "https://play.google.com/store/search?c=apps&hl=en&q=" + URLEncoder.encode(q, "UTF-8")
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000; c.readTimeout = 20_000
        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36")
        val html = c.inputStream.bufferedReader().use { it.readText() }
        // Result cards link to the app with its name as the link's label.
        val named = Regex("href=\"/store/apps/details\\?id=([A-Za-z0-9._]+)\"[^>]*aria-label=\"([^\"]+)\"").findAll(html)
            .map { it.groupValues[1] to android.text.Html.fromHtml(it.groupValues[2], 0).toString() }.toMap()
        val ids = Regex("/store/apps/details\\?id=([A-Za-z0-9._]+)").findAll(html).map { it.groupValues[1] }.distinct().take(8).toList()
        return ids.sortedBy { it !in named }.map { id -> (named[id] ?: "(name not shown)") to id }
    }

    // --- installing -------------------------------------------------------------------------

    fun approve(pkg: String) = synchronized(this) { approved[pkg] = System.currentTimeMillis() + APPROVED_MS }
    private fun isApproved(pkg: String) = synchronized(this) { (approved[pkg] ?: 0) > System.currentTimeMillis() }

    /** Wait for [pkg] to finish installing through the shell (true, message), or time out. */
    fun await(pkg: String, timeoutMs: Long, tick: () -> Unit): Pair<Boolean, String> {
        val done = CountDownLatch(1)
        var result = false to "It didn't finish in time."
        synchronized(this) { waiting[pkg] = { ok, m -> result = ok to m; done.countDown() } }
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end && !done.await(1500, TimeUnit.MILLISECONDS)) tick()
        synchronized(this) { waiting.remove(pkg) }
        return result
    }

    /** Which app handed over each group of files (the package owning the content provider), or null if unknown. */
    private val sources = HashMap<String, String?>()

    /** An APK handed over by Aurora (or anything else) from [source]. The rest of its splits follow within moments. */
    fun receive(files: List<File>, group: String, source: String?) = synchronized(this) {
        incoming.getOrPut(group) { mutableListOf() }.addAll(files)
        if (sources[group] != source) sources[group] = if (group in sources) null else source // mixed sources: unknown
        pending.remove(group)?.let { handler.removeCallbacks(it) }
        val r = Runnable { val (fs, src) = synchronized(this) { pending.remove(group); incoming.remove(group) to sources.remove(group) }; if (fs != null) thread { handle(fs, src) } }
        pending[group] = r
        handler.postDelayed(r, 1500)
    }

    /** Where an install came from, as the card says it. */
    private fun from(source: String?): String = when (source) {
        AURORA -> "From Google Play"
        null -> "Not from Google Play"
        else -> "From ${label(source)} ($source), not Google Play"
    }

    private fun handle(files: List<File>, source: String?) {
        val pm = ctx.packageManager
        val base = files.firstOrNull { it.name.endsWith("-base.apk") } ?: files.first()
        val info = pm.getPackageArchiveInfo(base.path, 0)
        val pkg = info?.packageName ?: files.firstNotNullOfOrNull { pm.getPackageArchiveInfo(it.path, 0)?.packageName }
        val name = info?.applicationInfo?.let { it.sourceDir = base.path; it.publicSourceDir = base.path; it.loadLabel(pm).toString() } ?: pkg ?: "this app"
        Log.i(TAG, "received ${files.size} file(s) for $pkg ($name)")
        // A yes to install_app covers what Aurora then hands over for that package; anything else asks again (the
        // shell's own card, with or without Device control).
        val ok = pkg != null && ((isApproved(pkg) && source == AURORA) ||
            ApprovalCard.ask("Add $name?", "", parent = PinChoices.needed(ctx, PinChoices.APPS), yes = "Add", rights = listOf("from" to from(source)), more = pkg))
        if (!ok) {
            files.forEach { it.delete() }
            finish(pkg, false, if (pkg == null) "Those files weren't an app." else "Nobody said yes, so $name wasn't added.")
            return
        }
        DeviceAccess.instance?.status("Installing $name")
        val (done, msg) = install(files, name)
        files.forEach { it.delete() }
        if (done) addToHome(pkg!!)
        finish(pkg, done, if (done) "${label(pkg)} is on the home screen." else "Couldn't install $name: $msg")
    }

    private fun finish(pkg: String?, ok: Boolean, msg: String) {
        Log.i(TAG, "install $pkg: $ok $msg")
        val cb = synchronized(this) { pkg?.let { waiting.remove(it) } }
        if (cb != null) cb(ok, msg) else DeviceAccess.instance?.let { a -> if (ok) a.status(msg) }
    }

    /** Install APK files (one app, base plus splits) with a PackageInstaller session. Silent for a device owner. */
    fun install(files: List<File>, name: String): Pair<Boolean, String> {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            setInstallReason(PackageManager.INSTALL_REASON_POLICY)
        }
        val id = runCatching { pi.createSession(params) }.getOrElse { return false to "${it.message}" }
        val done = CountDownLatch(1)
        var result = false to "no answer from the installer"
        val action = "$ACTION_DONE.$id"
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) { // not device owner: the system asks
                    @Suppress("DEPRECATION") (i.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))?.let { c.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    return
                }
                result = (st == PackageInstaller.STATUS_SUCCESS) to (i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $st")
                done.countDown()
            }
        }
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rx, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
        else ctx.registerReceiver(rx, IntentFilter(action))
        try {
            pi.openSession(id).use { s ->
                files.forEachIndexed { n, f ->
                    s.openWrite("$n-${f.name}", 0, f.length()).use { o -> f.inputStream().use { it.copyTo(o) }; s.fsync(o) }
                }
                val pend = PendingIntent.getBroadcast(ctx, id, Intent(action).setPackage(ctx.packageName),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                s.commit(pend.intentSender)
            }
            done.await(5, TimeUnit.MINUTES)
        } catch (e: Exception) {
            Log.w(TAG, "install $name: $e"); runCatching { pi.abandonSession(id) }; result = false to "${e.message}"
        } finally { runCatching { ctx.unregisterReceiver(rx) } }
        return result
    }

    // --- the home screen's list -------------------------------------------------------------

    fun addToHome(pkg: String) {
        KioskApps.allowInKiosk(pkg)
        val now = list().filter { it != pkg }
        prefs.edit().putString("apps", JSONArray(listOf(pkg) + now).toString()).apply()
        onChanged?.invoke()
    }

    private fun list(): List<String> = runCatching {
        val a = JSONArray(prefs.getString("apps", "[]")); (0 until a.length()).map { a.getString(it) }
    }.getOrDefault(emptyList())

    /** Apps added through the store that are still installed, newest first: (package, label). */
    fun homeApps(): List<Pair<String, String>> = if (!::ctx.isInitialized) emptyList() else list().filter { installed(it) }.map { it to label(it) }
}

/**
 * Receives "install this APK" from Aurora (and is the device's handler for that intent; see
 * [AppStore.claimInstallIntents]). Copies the file while the read grant lasts, then hands it over.
 */
class InstallActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        AppStore.init(this)
        val uri: Uri? = intent.data
        if (uri != null) thread {
            runCatching {
                val dir = File(cacheDir, "incoming").apply { mkdirs() }
                val name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.endsWith(".apk") } ?: "app.apk"
                val f = File.createTempFile("in-", "-$name", dir)
                contentResolver.openInputStream(uri)!!.use { i -> f.outputStream().use { i.copyTo(it) } }
                // Who really sent it: the app that owns the content provider serving the file (file:// can't say).
                val source = if (uri.scheme == "content") uri.authority?.let { packageManager.resolveContentProvider(it, 0)?.packageName } else null
                AppStore.receive(listOf(f), uri.path?.substringBeforeLast('/') ?: "", source)
            }.onFailure { Log.w("AppStore", "couldn't read $uri: $it") }
        }
        finish()
        overridePendingTransition(0, 0)
    }
}
