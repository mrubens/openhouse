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

    /** Kiosk mode on: the restrictions on (but recovery's wipe and safe mode while this start is stuck: [checkStuck]). */
    fun apply(c: Context) {
        if (!owner(c)) return
        on = true
        val stuck = stuckLifted(c)
        ALWAYS.forEach { set(c, it, !(stuck && it in RECOVERY)) }
        set(c, UserManager.DISALLOW_DEBUGGING_FEATURES, !debugging(c))
    }

    // --- a device that never gets as far as its home screen ------------------------------------------------------
    // With the two restrictions on and Opie not opening, recovery's wipe can be refused (Samsung does), and there would
    // be no way back. So the guard's process (GuardJob), [STUCK_MS] after the device starts, lets them through if the
    // home screen hasn't loaded this boot; they go back on once it does. Files, as both processes read them.

    private val RECOVERY = listOf(UserManager.DISALLOW_FACTORY_RESET, UserManager.DISALLOW_SAFE_BOOT)
    /** How long after the device starts its home screen has to load. */
    const val STUCK_MS = 10 * 60_000L

    private fun file(c: Context, name: String) = java.io.File(c.filesDir, "updates").apply { mkdirs() }.let { java.io.File(it, name) }
    private fun read(c: Context, name: String) = runCatching { org.json.JSONObject(file(c, name).readText()) }.getOrNull()
    private fun mark(c: Context, name: String) = runCatching {
        file(c, name).writeText(org.json.JSONObject().put("boot", UpdateGuard.bootCount(c)).put("at", System.currentTimeMillis()).toString())
    }
    /** Written in this boot: Android's count of starts, else the wall clock against when this boot began. */
    private fun thisBoot(c: Context, j: org.json.JSONObject?): Boolean {
        if (j == null) return false
        val boot = UpdateGuard.bootCount(c)
        if (boot >= 0 && j.optInt("boot", -1) >= 0) return j.optInt("boot") == boot
        return j.optLong("at") >= System.currentTimeMillis() - android.os.SystemClock.elapsedRealtime() - 5_000
    }
    private fun stuckLifted(c: Context) = thisBoot(c, read(c, "stuck.json"))

    /** The home screen loaded (HomeView): this boot came up, and what [checkStuck] let through goes back on. */
    fun displayUp(c: Context) {
        if (!thisBoot(c, read(c, "up.json"))) mark(c, "up.json")
        if (file(c, "stuck.json").delete() && on) apply(c)
    }

    /** [STUCK_MS] after the device started (GuardJob): no home screen yet this boot, so recovery's wipe and safe mode
     *  are allowed until it loads. */
    fun checkStuck(c: Context) {
        if (!owner(c) || thisBoot(c, read(c, "up.json"))) return
        mark(c, "stuck.json")
        RECOVERY.forEach { set(c, it, false) }
        Log.w(TAG, "no home screen ${STUCK_MS / 60_000} minutes after starting: recovery's wipe and safe mode allowed until it loads")
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
