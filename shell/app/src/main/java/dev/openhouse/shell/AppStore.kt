package dev.openhouse.shell

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Android apps added to the tablet (Apps lists them; kiosk lets them open), and the shell's own installs (its
 * updates, the update cover, the family's app windows: [install], silent for a device owner).
 *
 * Apps come from Google Play (PlayStore): a person taps Install on the app's page, and when Play has installed it the
 * package-added broadcast puts it in Apps. Aurora Store, the earlier way, is uninstalled on update if Opie put it on
 * ([retireAurora]); the apps it added stay.
 */
object AppStore {
    /** Aurora Store, only to take it off tablets where Opie installed it. */
    private const val AURORA = "com.aurora.store"
    private const val TAG = "AppStore"
    private const val ACTION_DONE = "dev.openhouse.shell.INSTALL_DONE"

    private lateinit var ctx: Context
    private val prefs by lazy { ctx.getSharedPreferences("store", Context.MODE_PRIVATE) }
    /** Called after an app is added (the home board refreshes its stickers). */
    var onChanged: (() -> Unit)? = null

    fun init(c: Context) {
        if (::ctx.isInitialized) return
        ctx = c.applicationContext
        // An app Google Play just installed (a person tapped Install there) goes into Apps.
        val f = IntentFilter(Intent.ACTION_PACKAGE_ADDED).apply { addDataScheme("package") }
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val pkg = i.data?.schemeSpecificPart ?: return
                if (i.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
                if (PlayStore.installer(ctx, pkg) != PlayStore.PKG || ctx.packageManager.getLaunchIntentForPackage(pkg) == null) return
                Log.i(TAG, "Google Play added $pkg")
                addToHome(pkg)
                DeviceAccess.instance?.status("${label(pkg)} is in Apps")
            }
        }
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rx, f, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(rx, f)
    }

    private val dpm get() = ctx.getSystemService(DevicePolicyManager::class.java)
    private val admin get() = ComponentName(ctx, AdminReceiver::class.java)
    private fun isOwner() = dpm.isDeviceOwnerApp(ctx.packageName)

    fun installed(pkg: String) = runCatching { ctx.packageManager.getPackageInfo(pkg, 0); true }.getOrDefault(false)
    fun label(pkg: String) = runCatching { ctx.packageManager.getApplicationInfo(pkg, 0).loadLabel(ctx.packageManager).toString() }.getOrDefault(pkg)

    /**
     * Aurora Store's last traces, once, after the update that replaced it: Opie's own Aurora uninstalled (one someone
     * installed themselves stays), and the shell no longer the handler for "install this APK" (only Aurora used it).
     * The apps it added stay installed and in Apps.
     */
    fun retireAurora() {
        if (!isOwner() || prefs.getBoolean("aurora_retired", false)) return
        runCatching { dpm.clearPackagePersistentPreferredActivities(admin, ctx.packageName) } // (home is claimed again right after: DeviceOwner)
        KioskApps.disallowInKiosk(AURORA)
        if (installed(AURORA) && PlayStore.installer(ctx, AURORA) == ctx.packageName) runCatching {
            val action = "$ACTION_DONE.aurora"
            val pend = PendingIntent.getBroadcast(ctx, 0, Intent(action).setPackage(ctx.packageName), PendingIntent.FLAG_IMMUTABLE)
            ctx.packageManager.packageInstaller.uninstall(AURORA, pend.intentSender)
            Log.i(TAG, "uninstalling Aurora Store")
        }.onFailure { Log.w(TAG, "uninstall Aurora: $it") }
        prefs.edit().putBoolean("aurora_retired", true).remove("aurora_ready").putString("apps", JSONArray(list().filter { it != AURORA }).toString()).apply()
    }

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

    // --- installing (the shell's own) --------------------------------------------------------

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

    /** Apps added (Google Play, Opie opening one, Aurora before it) that are still installed, newest first: (package, label). */
    fun homeApps(): List<Pair<String, String>> = if (!::ctx.isInitialized) emptyList() else list().filter { installed(it) }.map { it to label(it) }
}
