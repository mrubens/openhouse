package dev.openhouse.shell

// What the display sets up on the tablet as its device owner: kiosk (lock task) mode, the permanent home app,
// the home screen-colored wallpaper, the child processes kept alive, and the accessibility service the assistant uses
// to work other apps (device control).

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.util.Log

internal object DeviceOwner {
    private const val TAG = "Shell"
    private fun dpm(a: Activity) = a.getSystemService(DevicePolicyManager::class.java)
    private fun admin(a: Activity) = ComponentName(a, AdminReceiver::class.java)
    fun isOwner(a: Activity) = dpm(a).isDeviceOwnerApp(a.packageName)

    // When the shell is device owner: it is the permanent home app, the device skips the lock screen, and the
    // shell runs in lock task mode (no status bar, notification shade, home, recents or app switching). Parents
    // get out through Settings (Settings → Advanced, behind the PIN).
    fun setUp(a: Activity) {
        if (!isOwner(a)) return
        val dpm = dpm(a); val admin = admin(a)
        runCatching { AppStore.init(a); AppStore.retireAurora() } // (before home: it clears the shell's preferred activities)
        runCatching { GooglePrivacy.start(a) } // a Google account here keeps its mail and photos out of reach
        // Home first, on its own: if anything below fails, Home must still be the display (not the update cover, nor
        // the tablet's own home screen), or the tablet comes back from an update on a blank cover.
        if (!a.getSharedPreferences("shell", Activity.MODE_PRIVATE).contains("outHome")) runCatching {
            dpm.clearPackagePersistentPreferredActivities(admin, MainActivity.HOST_PKG) // home was the update cover while this was installed
            dpm.addPersistentPreferredActivity(admin,
                IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) },
                ComponentName(a, MainActivity::class.java))
        }.onFailure { Log.w(TAG, "claiming home failed: $it") }
        runCatching {
            AppStore.init(a)
            // The display, the update cover, each family app (AppStubs) and the apps someone added. Anything else
            // (Settings, a store) is let in only for someone, until the display is back (KioskApps.revokeTemporary).
            dpm.setLockTaskPackages(admin, (arrayOf(a.packageName, MainActivity.HOST_PKG) + AppStubs.installed().values +
                AppStore.homeApps().map { it.first }.filter { !KioskApps.needsParent(it) }).distinct().toTypedArray())
            Kiosk.apply(a) // no factory reset, new users, unknown sources (or USB debugging, if someone turned it off)
            // Keep the power menu so someone can still turn the device off.
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS)
            dpm.setKeyguardDisabled(admin, true)
            dpm.setStatusBarDisabled(admin, true)
            showHiddenHomes(a)
            homeWallpaper(a)
        }.onFailure { Log.w(TAG, "kiosk setup failed: $it") }
        nightOsUpdates(a)
    }

    /**
     * Android's own updates install (and restart the tablet) only at night, 3:00 to 5:00, instead of whenever the
     * tablet's maker pushes one. Our own updates go in from 2:00 when the tablet is quiet (Updater); a restart in the
     * middle of one is covered by UpdateGuard. Makers may hold an update back up to 30 days in this window, then
     * install it anyway, so security fixes still land.
     */
    private fun nightOsUpdates(a: Activity) = runCatching {
        val dpm = dpm(a)
        val cur = dpm.systemUpdatePolicy
        if (cur?.policyType == android.app.admin.SystemUpdatePolicy.TYPE_INSTALL_WINDOWED && cur.installWindowStart == 180 && cur.installWindowEnd == 300) return@runCatching
        dpm.setSystemUpdatePolicy(admin(a), android.app.admin.SystemUpdatePolicy.createWindowedInstallPolicy(180, 300))
        Log.i(TAG, "Android's updates: 3:00-5:00")
    }.onFailure { Log.w(TAG, "system update policy: $it") }

    /** Lock task mode on, unless someone left kiosk mode for now. */
    fun enterKiosk(a: Activity, paused: Boolean) {
        if (!isOwner(a) || paused) return
        UpdateGuard.kioskBack(a) // an update being watched gets its health time again from now
        backFromOut(a)
        Kiosk.apply(a)
        val am = a.getSystemService(android.app.ActivityManager::class.java)
        if (am.lockTaskModeState == android.app.ActivityManager.LOCK_TASK_MODE_NONE) runCatching { a.startLockTask() }.onFailure { Log.w(TAG, "startLockTask: $it") }
    }

    private fun homeFilter() = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }

    /**
     * "Leave kiosk mode" in Settings: the tablet as it came, until someone opens the display again from its
     * icon. Unpinned, restrictions and the status bar back, and Home is the tablet's own home screen (else Home is
     * the display, which pins itself again: leaving did nothing).
     */
    fun leaveForGood(a: Activity) {
        leaveKiosk(a)
        if (!isOwner(a)) return
        val dpm = a.getSystemService(DevicePolicyManager::class.java); val admin = ComponentName(a, AdminReceiver::class.java)
        val pm = a.packageManager
        val theirs = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0).map { it.activityInfo }
            .firstOrNull { it.packageName !in setOf(a.packageName, MainActivity.HOST_PKG, "com.android.settings") }
        runCatching {
            dpm.setStatusBarDisabled(admin, false)
            dpm.clearPackagePersistentPreferredActivities(admin, a.packageName)
            if (theirs != null) dpm.addPersistentPreferredActivity(admin, homeFilter(), ComponentName(theirs.packageName, theirs.name))
        }.onFailure { Log.w(TAG, "leave kiosk: $it") }
        a.getSharedPreferences("shell", Activity.MODE_PRIVATE).edit().putString("outHome", theirs?.packageName ?: "").apply()
        if (theirs != null) runCatching { a.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setClassName(theirs.packageName, theirs.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    /** The display opened again after someone left kiosk mode: Home is the display again, the status bar hidden. */
    private fun backFromOut(a: Activity) {
        val prefs = a.getSharedPreferences("shell", Activity.MODE_PRIVATE)
        val out = prefs.getString("outHome", null) ?: return
        val dpm = a.getSystemService(DevicePolicyManager::class.java); val admin = ComponentName(a, AdminReceiver::class.java)
        runCatching {
            if (out.isNotEmpty()) dpm.clearPackagePersistentPreferredActivities(admin, out)
            dpm.addPersistentPreferredActivity(admin, homeFilter(), ComponentName(a, MainActivity::class.java))
            dpm.setStatusBarDisabled(admin, true)
        }.onFailure { Log.w(TAG, "back to kiosk: $it") }
        prefs.edit().remove("outHome").apply()
    }

    /** Someone leaves kiosk mode until the display is reopened (Home): restrictions off too. */
    fun leaveKiosk(a: Activity) { runCatching { a.stopLockTask() }; Kiosk.lift(a); if (isOwner(a)) UpdateGuard.kioskLeft(a) } // an update being watched isn't judged meanwhile

    /**
     * When the display is updated it's gone for a second or two and Android shows the tablet's own home
     * screen. Make that the home screen's plain paper (home and lock wallpaper), so the moment looks blank
     * instead of like a Samsung tablet. Once per device; someone can change the wallpaper back.
     */
    private fun homeWallpaper(a: Activity) {
        val prefs = a.getSharedPreferences("shell", Activity.MODE_PRIVATE)
        if (prefs.getBoolean("paperWallpaper", false)) return // (once again on tablets that had the old green)
        runCatching {
            val b = android.graphics.Bitmap.createBitmap(64, 64, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(dev.openhouse.ui.Calm.PAPER) }
            android.app.WallpaperManager.getInstance(a).setBitmap(b, null, true, android.app.WallpaperManager.FLAG_SYSTEM or android.app.WallpaperManager.FLAG_LOCK)
            prefs.edit().putBoolean("paperWallpaper", true).apply()
            Log.i(TAG, "wallpaper set to the home screen's paper")
        }.onFailure { Log.w(TAG, "wallpaper: $it") }
    }

    /** Undo an experiment that hid other launchers (kept so a device that ran it gets them back). */
    private fun showHiddenHomes(a: Activity) {
        val prefs = a.getSharedPreferences("shell", Activity.MODE_PRIVATE)
        val before = prefs.getStringSet("hiddenHomes", emptySet())!!
        if (before.isEmpty()) return
        for (p in before) runCatching { dpm(a).setApplicationHidden(admin(a), p, false) }
        prefs.edit().remove("hiddenHomes").apply()
        Log.i(TAG, "unhid $before")
    }

    /**
     * Real tablets (Samsung especially) kill an app's child processes: Android 12+'s "phantom
     * process" limit (32 across apps, and any that use a lot of CPU). The whole runtime is child
     * processes (proot, Node, the agent CLI, the voice models), so turn that off, and keep the
     * screen on while plugged in. Needs WRITE_SECURE_SETTINGS, granted once over adb at setup.
     */
    fun keepAlive(a: Activity) {
        // Awake while plugged in: a device owner may set this itself (no adb). The display also keeps the screen on
        // while it's in front (FLAG_KEEP_SCREEN_ON); this covers a family app or Settings open over it.
        if (isOwner(a)) runCatching { dpm(a).setGlobalSetting(admin(a), android.provider.Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7") }.onFailure { Log.w(TAG, "stay on: $it") }
        if (a.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != PackageManager.PERMISSION_GRANTED) return
        val cr = a.contentResolver
        runCatching { android.provider.Settings.Global.putString(cr, "settings_enable_monitor_phantom_procs", "false") }.onFailure { Log.w(TAG, "phantom procs: $it") }
        runCatching { android.provider.Settings.Global.putInt(cr, android.provider.Settings.Global.STAY_ON_WHILE_PLUGGED_IN, 7) }
    }

    // --- device control (the assistant working other apps) ---------------------------------------
    private fun deviceService(a: Activity) = "${a.packageName}/${DeviceAccess::class.java.name}"

    /** Switch our accessibility service on, if someone granted WRITE_SECURE_SETTINGS once (adb) and didn't turn it off. */
    fun enableDeviceControl(a: Activity) {
        if (a.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != PackageManager.PERMISSION_GRANTED) return
        if (!a.getSharedPreferences("shell", Activity.MODE_PRIVATE).getBoolean("device_control", true)) return
        runCatching {
            val cr = a.contentResolver
            val cur = android.provider.Settings.Secure.getString(cr, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
            if (deviceService(a) !in cur) {
                android.provider.Settings.Secure.putString(cr, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                    listOf(cur, deviceService(a)).filter { it.isNotBlank() }.joinToString(":"))
                android.provider.Settings.Secure.putString(cr, android.provider.Settings.Secure.ACCESSIBILITY_ENABLED, "1")
                Log.i(TAG, "device control enabled")
            }
        }.onFailure { Log.w(TAG, "enable device control: $it") }
    }

    fun setDeviceControl(a: Activity, on: Boolean) {
        a.getSharedPreferences("shell", Activity.MODE_PRIVATE).edit().putBoolean("device_control", on).apply()
        if (on) enableDeviceControl(a) else runCatching {
            val cr = a.contentResolver
            val cur = android.provider.Settings.Secure.getString(cr, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
            android.provider.Settings.Secure.putString(cr, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                cur.split(':').filter { it != deviceService(a) }.joinToString(":"))
        }
    }
}
