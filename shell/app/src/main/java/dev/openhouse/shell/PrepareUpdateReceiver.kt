package dev.openhouse.shell

import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log

/**
 * The display is about to be replaced by a new build. While it's gone, Android opens "home"; make home
 * the plain cover in the host app (which isn't being replaced) instead of the tablet's own home screen,
 * and put the cover up now. The new display points home back at itself when it starts (setupKiosk).
 *
 *   adb shell am broadcast -n dev.openhouse.shell/.PrepareUpdateReceiver -a dev.openhouse.shell.PREPARE_UPDATE
 *
 * Self-update (Updater, UpdateGuard) puts the same cover up through [UpdateCover].
 */
class PrepareUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.getBooleanExtra("cancel", false)) UpdateCover.down(ctx) // the install failed: this display stays
        else UpdateCover.up(ctx)
    }
}

internal object UpdateCover {
    private fun cover() = ComponentName(MainActivity.HOST_PKG, "dev.openhouse.host.CoverActivity")
    private fun homeFilter() = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }

    /** Is the cover app on this tablet? Without it an update still goes on; the tablet's own home flashes by. */
    fun present(ctx: Context) = runCatching { ctx.packageManager.getPackageInfo(MainActivity.HOST_PKG, 0); true }.getOrDefault(false)

    /** [face]: false from UpdateGuard's own process, where the floating face (Buddy) isn't. */
    fun up(ctx: Context, face: Boolean = true) {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        if (face) {
            Buddy.covering = true // no floating face on the cover
            // If no new display comes (the install failed and nobody cancelled), the face comes back by itself.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ Buddy.covering = false }, 3 * 60_000L)
        }
        if (!present(ctx)) return
        if (dpm.isDeviceOwnerApp(ctx.packageName)) runCatching {
            dpm.clearPackagePersistentPreferredActivities(admin, ctx.packageName)
            dpm.addPersistentPreferredActivity(admin, homeFilter(), cover())
        }.onFailure { Log.w("Shell", "update cover: $it") }
        runCatching { ctx.startActivity(Intent(Intent.ACTION_MAIN).setComponent(cover()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("at", System.currentTimeMillis())) }
        ctx.getSharedPreferences("shell", Context.MODE_PRIVATE).edit().putLong("covered_at", System.currentTimeMillis()).apply()
        Log.i("Shell", "covered for an update")
    }

    /**
     * A cover that outstayed its update: the new display is running but stays behind the cover. The cover can miss the
     * update's end (a second one Android opened as home mid-install doesn't know when the update began) and then holds
     * the screen for its full three minutes, putting itself back in front. As the tablet's owner, close the cover app
     * (hiding it stops it at once; it's shown again straight after) and come to the front.
     */
    fun clearStuck(act: android.app.Activity) {
        val dpm = act.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(act, AdminReceiver::class.java)
        if (!dpm.isDeviceOwnerApp(act.packageName) || !present(act)) return
        Log.w("Shell", "the update cover stayed up: closing it")
        runCatching { dpm.setApplicationHidden(admin, MainActivity.HOST_PKG, true) }
        runCatching { dpm.setApplicationHidden(admin, MainActivity.HOST_PKG, false) }
        runCatching { act.startActivity(Intent(act, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)) }
    }

    /** Home back to the display, the face back, the display in front. */
    fun down(ctx: Context) {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        Buddy.covering = false
        if (dpm.isDeviceOwnerApp(ctx.packageName)) runCatching {
            dpm.clearPackagePersistentPreferredActivities(admin, MainActivity.HOST_PKG)
            dpm.addPersistentPreferredActivity(admin, homeFilter(), ComponentName(ctx, MainActivity::class.java))
        }.onFailure { Log.w("Shell", "uncover: $it") }
        runCatching { ctx.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setClass(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        Log.i("Shell", "update cancelled: the display is home again")
    }
}
