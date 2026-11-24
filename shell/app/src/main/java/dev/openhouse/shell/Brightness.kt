package dev.openhouse.shell

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.provider.Settings
import dev.openhouse.ui.CalmDialog

/**
 * The screen's brightness, from Settings → This tablet (kiosk mode hides Android's own slider): Automatic (Android's
 * adaptive brightness, which can go very dim in a dark room) or a fixed level. Set as the device owner
 * (DevicePolicyManager.setSystemSetting), so it holds everywhere, not only over OpenHouse's own window. The night
 * hours' dimming (HomeView) still goes over it.
 */
object Brightness {
    private val LEVELS = listOf("Automatic" to -1, "Low" to 64, "Medium" to 128, "High" to 192, "Full" to 255)

    private fun auto(a: Activity) = runCatching { Settings.System.getInt(a.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE) == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC }.getOrDefault(true)
    private fun level(a: Activity) = runCatching { Settings.System.getInt(a.contentResolver, Settings.System.SCREEN_BRIGHTNESS) }.getOrDefault(128)

    /** What the row shows: Automatic, or the nearest named level. */
    fun label(a: Activity): String = if (auto(a)) "Automatic" else LEVELS.drop(1).minByOrNull { kotlin.math.abs(it.second - level(a)) }!!.first

    fun choose(a: Activity, immersive: () -> Unit, done: () -> Unit) {
        val now = label(a)
        val rows = LEVELS.map { (name, _) -> CalmDialog.Row(name, value = if (name == now) "Now" else null) }
        CalmDialog(a).setTitle("Brightness").setRows(rows) { _, i -> set(a, LEVELS[i].second); done() }
            .setNegativeButton("Close", null).show().also { immersive() }
    }

    private fun set(a: Activity, value: Int) {
        val dpm = a.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(a, AdminReceiver::class.java)
        runCatching {
            if (value < 0) dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC.toString())
            else {
                dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL.toString())
                dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS, value.toString())
            }
        }.onFailure { android.util.Log.w("Brightness", "couldn't set: $it") }
    }
}
