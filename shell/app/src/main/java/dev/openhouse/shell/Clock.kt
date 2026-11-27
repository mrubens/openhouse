package dev.openhouse.shell

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import dev.openhouse.ui.CalmDialog
import java.util.TimeZone

/**
 * Settings → Screen → Time: the clock's format (12-hour "3:07pm" or 24-hour "15:07", which the home page asks for through
 * HomeView's clock24) and the time zone. Automatic is Android's own (from the network); a chosen zone is set as the
 * device owner (DevicePolicyManager.setTimeZone, with the automatic zone off), so the page's clock follows it.
 */
object Clock {
    private val ZONES = listOf(
        "Eastern" to "America/New_York", "Central" to "America/Chicago", "Mountain" to "America/Denver", "Arizona" to "America/Phoenix",
        "Pacific" to "America/Los_Angeles", "Alaska" to "America/Anchorage", "Hawaii" to "Pacific/Honolulu",
        "London" to "Europe/London", "Central Europe" to "Europe/Berlin", "India" to "Asia/Kolkata", "Japan" to "Asia/Tokyo", "Sydney" to "Australia/Sydney",
    )

    private fun prefs(c: Context) = c.getSharedPreferences("shell", Context.MODE_PRIVATE)
    fun is24(c: Context) = prefs(c).getBoolean("clock24", false)

    private fun dpm(a: Activity) = a.getSystemService(DevicePolicyManager::class.java)
    private fun admin(a: Activity) = ComponentName(a, AdminReceiver::class.java)
    private fun autoZone(a: Activity) = runCatching { if (Build.VERSION.SDK_INT >= 30) dpm(a).getAutoTimeZoneEnabled(admin(a)) else android.provider.Settings.Global.getInt(a.contentResolver, android.provider.Settings.Global.AUTO_TIME_ZONE) == 1 }.getOrDefault(true)

    private fun zoneName(a: Activity): String {
        if (autoZone(a)) return "Automatic"
        val id = TimeZone.getDefault().id
        return ZONES.firstOrNull { it.second == id }?.first ?: TimeZone.getDefault().getDisplayName(false, TimeZone.SHORT)
    }

    /** What the row shows: "12-hour · Automatic". */
    fun label(a: Activity) = "${if (is24(a)) "24-hour" else "12-hour"} · ${zoneName(a)}"

    fun choose(a: Activity, immersive: () -> Unit, done: () -> Unit) {
        val rows = listOf(
            CalmDialog.Row("12-hour", detail = "3:07pm", value = if (!is24(a)) "Now" else null),
            CalmDialog.Row("24-hour", detail = "15:07", value = if (is24(a)) "Now" else null),
            CalmDialog.Row("Time zone", value = zoneName(a)),
        )
        CalmDialog(a).setTitle("Time").setRows(rows) { _, i ->
            when (i) {
                0, 1 -> { prefs(a).edit().putBoolean("clock24", i == 1).apply(); done() }
                else -> zones(a, immersive, done)
            }
        }.setNegativeButton("Close", null).show().also { immersive() }
    }

    private fun zones(a: Activity, immersive: () -> Unit, done: () -> Unit) {
        val now = zoneName(a)
        val names = listOf("Automatic") + ZONES.map { it.first }
        val rows = names.map { CalmDialog.Row(it, value = if (it == now) "Now" else null) }
        CalmDialog(a).setTitle("Time zone").setRows(rows) { _, i ->
            if (Build.VERSION.SDK_INT >= 30) runCatching {
                if (i == 0) dpm(a).setAutoTimeZoneEnabled(admin(a), true)
                else { dpm(a).setAutoTimeZoneEnabled(admin(a), false); dpm(a).setTimeZone(admin(a), ZONES[i - 1].second) }
            }.onFailure { android.util.Log.w("Clock", "couldn't set the time zone: $it") }
            done()
        }.setNegativeButton("Close", null).show().also { immersive() }
    }
}
