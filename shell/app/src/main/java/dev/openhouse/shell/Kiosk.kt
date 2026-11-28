package dev.openhouse.shell

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.UserManager
import android.util.Log

/**
 * What the tablet won't do while it's the family's display (device owner): factory reset, start in safe mode (which
 * would open without Opie), add users, install apps from outside the shell, or turn on USB debugging. Someone
 * leaving kiosk mode (Settings, PIN) lifts them until the display is reopened. USB debugging has its own switch in Settings, so a developer
 * keeps adb: it starts the way the tablet was set up (adb was on: it stays allowed).
 */
object Kiosk {
    private const val TAG = "Kiosk"
    private val ALWAYS = listOf(UserManager.DISALLOW_FACTORY_RESET, UserManager.DISALLOW_SAFE_BOOT, UserManager.DISALLOW_ADD_USER,
        UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES, UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY)
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

    /** Is Android's USB debugging actually on (and not blocked by Opie)? */
    fun adbOn(c: Context): Boolean = debugging(c) &&
        runCatching { android.provider.Settings.Global.getInt(c.contentResolver, android.provider.Settings.Global.ADB_ENABLED) == 1 }.getOrDefault(false)

    /** Are Android's Developer options open (Build number tapped seven times)? */
    fun developerOptions(c: Context): Boolean =
        runCatching { android.provider.Settings.Global.getInt(c.contentResolver, android.provider.Settings.Global.DEVELOPMENT_SETTINGS_ENABLED) == 1 }.getOrDefault(false)

    fun setDebugging(c: Context, allowed: Boolean) {
        prefs(c).edit().putBoolean("debugging", allowed).apply()
        set(c, UserManager.DISALLOW_DEBUGGING_FEATURES, !allowed)
        // Allowing it isn't enough: Android's own USB debugging (and Developer options, which it lives under) comes on
        // too, so a computer can connect without a trip through Android's settings. Off leaves them as they are.
        if (allowed && owner(c)) {
            runCatching { dpm(c).setGlobalSetting(admin(c), android.provider.Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, "1") }
            runCatching { dpm(c).setGlobalSetting(admin(c), android.provider.Settings.Global.ADB_ENABLED, "1") }
        }
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

    private fun set(c: Context, r: String, restricted: Boolean) = runCatching {
        if (restricted) dpm(c).addUserRestriction(admin(c), r) else dpm(c).clearUserRestriction(admin(c), r)
    }.onFailure { Log.w(TAG, "$r: $it") }
}
