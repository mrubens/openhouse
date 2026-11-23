package dev.openhouse.shell

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.UserManager
import android.util.Log

/**
 * What the tablet won't do while it's the family's display (device owner): factory reset, add users, install
 * apps from outside the shell, or turn on USB debugging. Someone leaving kiosk mode (Settings, PIN) lifts
 * them until the display is reopened. USB debugging has its own switch in Settings, so a developer
 * keeps adb: it starts the way the tablet was set up (adb was on: it stays allowed).
 */
object Kiosk {
    private const val TAG = "Kiosk"
    private val ALWAYS = listOf(UserManager.DISALLOW_FACTORY_RESET, UserManager.DISALLOW_ADD_USER,
        UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES, UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY)
    private val UNKNOWN = listOf(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES, UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY)
    @Volatile private var on = false

    private fun dpm(c: Context) = c.getSystemService(DevicePolicyManager::class.java)
    private fun admin(c: Context) = ComponentName(c, AdminReceiver::class.java)
    private fun owner(c: Context) = dpm(c).isDeviceOwnerApp(c.packageName)
    private fun prefs(c: Context) = c.getSharedPreferences("shell", Context.MODE_PRIVATE)

    /** May a computer use adb (USB debugging)? */
    fun debugging(c: Context): Boolean {
        val p = prefs(c)
        if (!p.contains("debugging")) p.edit().putBoolean("debugging",
            runCatching { android.provider.Settings.Global.getInt(c.contentResolver, android.provider.Settings.Global.ADB_ENABLED) == 1 }.getOrDefault(true)).apply()
        return p.getBoolean("debugging", true)
    }

    fun setDebugging(c: Context, allowed: Boolean) {
        prefs(c).edit().putBoolean("debugging", allowed).apply()
        set(c, UserManager.DISALLOW_DEBUGGING_FEATURES, !allowed)
    }

    /** Kiosk mode on: the restrictions on. */
    fun apply(c: Context) {
        if (!owner(c)) return
        on = true
        ALWAYS.forEach { set(c, it, true) }
        set(c, UserManager.DISALLOW_DEBUGGING_FEATURES, !debugging(c))
    }

    /** Someone left kiosk mode: everything back, except USB debugging (its own switch). */
    fun lift(c: Context) {
        if (!owner(c)) return
        on = false
        ALWAYS.forEach { set(c, it, false) }
    }

    /** Aurora Store open for someone: Android's "install unknown apps" must be allowed for it to hand over an APK. */
    fun storeOpen(c: Context, open: Boolean) {
        if (!owner(c) || !on) return
        UNKNOWN.forEach { set(c, it, !open) }
    }

    private fun set(c: Context, r: String, restricted: Boolean) = runCatching {
        if (restricted) dpm(c).addUserRestriction(admin(c), r) else dpm(c).clearUserRestriction(admin(c), r)
    }.onFailure { Log.w(TAG, "$r: $it") }
}
