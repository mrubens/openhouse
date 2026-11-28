package dev.openhouse.shell

// Which apps kiosk (lock task) mode lets open: the display, the family's apps and the apps someone added; Settings
// and the stores only for someone, and only until the display is back in front.

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

object KioskApps {
    private const val TAG = "DeviceServer"
    private val ctx get() = DeviceServer.ctx
    /** (label, package) for every app with a launcher icon, except the display itself. */
    fun launchable(): List<Pair<String, String>> {
        val pm = ctx.packageManager
        return pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
            .filter { it.second != ctx.packageName }.distinctBy { it.second }.sortedBy { it.first.lowercase() }
    }

    /**
     * Open an Android app. One that leads out of kiosk mode ([needsParent]) opens only with [parentOk] (a
     * yes, the PIN when the lock is on), and only until the display is back in front ([revokeTemporary]).
     */
    fun openApp(pkg: String, parentOk: Boolean = false): Boolean {
        val gated = needsParent(pkg)
        if (gated && !parentOk) { Log.w(TAG, "refused to open $pkg without a yes"); return false }
        allowInKiosk(pkg, temporary = gated)
        val i = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        VideoFloat.beforeOther(pkg) // a video floating: kiosk mode again first
        if (!gated) VideoFloat.liftFor(ctx, pkg) // a video app: out of lock task, so it can float over the home screen
        ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
        return true
    }

    private val STORES = setOf(PlayStore.PKG, "com.aurora.store", "com.sec.android.app.samsungapps", "com.amazon.venezia",
        "org.fdroid.fdroid", "com.huawei.appmarket", "com.google.android.packageinstaller", "com.android.packageinstaller")

    /**
     * Does opening [pkg] need someone? The tablet's Settings, app stores and installers, and system apps (a
     * browser, Files, the launcher...), which lead to Wi-Fi, accounts, developer options or factory reset. Not
     * the display's own apps, nor apps someone already said yes to adding (the home screen's).
     */
    fun needsParent(pkg: String): Boolean {
        if (pkg == ctx.packageName || pkg == MainActivity.HOST_PKG || pkg.startsWith(AppStubs.PREFIX)) return false
        if (pkg in STORES) return true
        val pm = ctx.packageManager
        if (pkg in settingsPackages() || pkg == "com.android.settings") return true
        if (AppStore.homeApps().any { it.first == pkg }) return false
        val flags = runCatching { pm.getApplicationInfo(pkg, 0).flags }.getOrDefault(0)
        return flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0
    }

    /** The tablet's Settings and launcher (Samsung's have their own packages). */
    fun settingsPackages(): List<String> {
        val pm = ctx.packageManager
        return listOf(android.provider.Settings.ACTION_SETTINGS, Intent.ACTION_MAIN + ":home").mapNotNull { a ->
            val i = if (a.endsWith(":home")) Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME) else Intent(a)
            pm.resolveActivity(i, 0)?.activityInfo?.packageName
        }.filter { it != ctx.packageName }
    }

    /** Apps let into kiosk mode only for now (someone opened them): taken out again when the display is back. */
    private val temporary = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    /** Kiosk (lock task) only lets listed apps open; add this one ([temporary]: until the display is back in front). */
    fun allowInKiosk(pkg: String, temporary: Boolean = false) {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        if (temporary) this.temporary += pkg else this.temporary -= pkg
        if (dpm.isDeviceOwnerApp(ctx.packageName)) runCatching { // kiosk: allow this app inside lock task
            val cur = dpm.getLockTaskPackages(admin).toMutableSet()
            if (cur.add(pkg)) dpm.setLockTaskPackages(admin, cur.toTypedArray())
        }
    }

    /** The display is in front again: the apps someone opened for now can't be reached from kiosk any more. */
    fun revokeTemporary() {
        if (!DeviceServer.hasContext) return
        val gone = synchronized(temporary) { temporary.toList().also { temporary.clear() } }
        if (gone.isEmpty()) return
        gone.forEach { disallowInKiosk(it) }
        Log.i(TAG, "kiosk allowlist back to normal (closed ${gone.joinToString()})")
    }

    fun disallowInKiosk(pkg: String) {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        if (dpm.isDeviceOwnerApp(ctx.packageName)) runCatching {
            val cur = dpm.getLockTaskPackages(admin).toMutableSet()
            if (cur.remove(pkg)) dpm.setLockTaskPackages(admin, cur.toTypedArray())
        }
    }

    fun goHome() {
        DeviceAccess.instance?.hideStatus()
        ctx.startActivity(Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
    }
}
