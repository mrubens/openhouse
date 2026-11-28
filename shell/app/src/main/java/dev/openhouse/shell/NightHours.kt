package dev.openhouse.shell

import android.app.Activity
import dev.openhouse.ui.CalmDialog
import dev.openhouse.ui.House

/**
 * Settings → Screen → Night hours: when nobody's using it at night, the screen goes dark and shows only the time, and
 * the check-ins sleep. The household's own setting (bridge house.js `night`, House.setNight), so every screen and the
 * hub's settings page agree, and Opie's night_hours does the same. No PIN, as the tool: anyone may want it darker.
 */
object NightHours {
    private val FROM = (38..47).map { it * 30 } + listOf(0, 30, 60) // 7 PM to 1 AM, each half hour
    private val TO = (8..20).map { it * 30 } // 4 AM to 10 AM

    private fun mins(s: String) = s.split(":").let { (it.getOrNull(0)?.toIntOrNull() ?: 0) * 60 + (it.getOrNull(1)?.toIntOrNull() ?: 0) }
    private fun hhmm(m: Int) = "%02d:%02d".format(m / 60 % 24, m % 60)

    /** "9:30 PM", or "21:30" with Settings → Screen → Time at 24-hour. */
    private fun time(a: Activity, s: String): String {
        val m = mins(s); val h = m / 60 % 24; val mm = m % 60
        if (Clock.is24(a)) return "%d:%02d".format(h, mm)
        return "%d:%02d %s".format(if (h % 12 == 0) 12 else h % 12, mm, if (h < 12) "AM" else "PM")
    }

    /** What the row shows: "9:30 PM to 6:30 AM", or Off. */
    fun label(a: Activity): String = House.night?.let { (f, t) -> "${time(a, f)} to ${time(a, t)}" } ?: "Off"

    fun choose(a: Activity, immersive: () -> Unit, done: () -> Unit) {
        val n = House.night
        val d = CalmDialog(a).setTitle("Night hours")
        // Off: a line and Turn on (with a view, so it's a page in Settings, not a dialog over it).
        if (n == null) d.setMessage("Off").setView(android.view.View(a)).setPositiveButton("Turn on") { _, _ -> House.setNight("21:30", "06:30"); done(); choose(a, immersive, done) }
        else d.setRows(listOf(CalmDialog.Row("From", value = time(a, n.first)), CalmDialog.Row("To", value = time(a, n.second)))) { _, i ->
            pick(a, if (i == 0) "From" else "To", if (i == 0) n.first else n.second, if (i == 0) FROM else TO, immersive, back = { choose(a, immersive, done) }) { s ->
                if (i == 0) House.setNight(s, n.second) else House.setNight(n.first, s)
                done(); choose(a, immersive, done)
            }
        }.setNeutralButton("Turn off") { _, _ -> House.setNight(null, null); done(); choose(a, immersive, done) }
        d.setNegativeButton("Close", null).show().also { immersive() }
    }

    private fun pick(a: Activity, title: String, now: String, choices: List<Int>, immersive: () -> Unit, back: () -> Unit, then: (String) -> Unit) {
        val all = (choices + mins(now)).distinct().let { l -> if (mins(now) in choices) l else l.sortedBy { (it - choices.first() + 1440) % 1440 } }
        val rows = all.map { m -> CalmDialog.Row(time(a, hhmm(m)), value = if (m == mins(now)) "Now" else null) }
        CalmDialog(a).setTitle(title).setRows(rows) { _, i -> then(hhmm(all[i])) }
            .setNegativeButton("Back") { _, _ -> back() }.show().also { immersive() }
    }
}
