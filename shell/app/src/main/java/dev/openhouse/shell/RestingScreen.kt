package dev.openhouse.shell

import android.app.Activity
import dev.openhouse.ui.CalmDialog
import dev.openhouse.ui.House
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Settings → Screen → Resting screen: what the screens show when nobody has touched them for a while. The household's
 * own (bridge house/settings.js `resting`, view().resting), so this device, a second screen and a hub's settings page
 * agree, and Opie's resting_screen does the same: when it starts, the calendar or the photos, how long each photo
 * stays, in order or shuffled, the whole photo or the whole screen, which albums, and what shows over the photo.
 * No PIN, as Night hours: it's how the room looks, not who may do what.
 */
object RestingScreen {
    private val AFTER = listOf(1, 2, 5, 8, 10, 15, 30, 0)
    private val EVERY = listOf(5, 10, 15, 20, 30, 60, 120)
    private val SHOW = listOf("time" to "Time and date", "weather" to "Weather", "next" to "What's next", "captions" to "Captions")

    private fun after(m: Int) = when (m) { 0 -> "Never"; 1 -> "1 minute"; else -> "$m minutes" }
    private fun every(s: Int) = if (s % 60 == 0) (if (s == 60) "1 minute" else "${s / 60} minutes") else "$s seconds"
    private fun onOff(b: Boolean) = if (b) "On" else "Off"

    /** What the row shows: when it starts, and the calendar when that's what it shows. */
    fun label(): String = if (House.restAfter == 0) "Never" else "After ${after(House.restAfter)}"

    fun choose(a: Activity, immersive: () -> Unit, done: () -> Unit) {
        thread {
            val h = House.restingNow()
            a.runOnUiThread { if (h != null) page(a, h.optJSONObject("resting") ?: JSONObject(), h.optJSONArray("albums"), immersive, done) else a.toastSoon() }
        }
    }

    private fun Activity.toastSoon() = android.widget.Toast.makeText(this, "Try again in a moment", android.widget.Toast.LENGTH_SHORT).show()

    private fun page(a: Activity, r: JSONObject, albums: org.json.JSONArray?, immersive: () -> Unit, done: () -> Unit) {
        val show = r.optJSONObject("show") ?: JSONObject()
        val calendar = r.optBoolean("calendar")
        val albumList = (0 until (albums?.length() ?: 0)).mapNotNull { albums?.optJSONObject(it) }
        fun again() = page(a, r, albums, immersive, done)
        fun set(k: String, v: Any) { r.put(k, v); House.setResting(JSONObject().put(k, v)); done(); again() }
        val rows = mutableListOf<Pair<CalmDialog.Row, () -> Unit>>()
        rows += CalmDialog.Row("Starts after", value = after(r.optInt("after", 8))) to {
            pick(a, "Starts after", AFTER, r.optInt("after", 8), ::after, immersive, back = { again() }) { set("after", it) }
        }
        rows += CalmDialog.Row("Shows", value = if (calendar) "The calendar" else "Photos") to { set("calendar", !calendar) }
        if (!calendar) {
            rows += CalmDialog.Row("Each photo", value = every(r.optInt("every", 15))) to {
                pick(a, "Each photo", EVERY, r.optInt("every", 15), ::every, immersive, back = { again() }) { set("every", it) }
            }
            rows += CalmDialog.Row("Order", value = if (r.optString("order") == "shuffle") "Shuffled" else "In order") to { set("order", if (r.optString("order") == "shuffle") "order" else "shuffle") }
            rows += CalmDialog.Row("Photo", value = if (r.optString("fit") == "fill") "Fills the screen" else "Whole photo") to { set("fit", if (r.optString("fit") == "fill") "fit" else "fill") }
            if (albumList.size > 1) rows += CalmDialog.Row("Albums", value = "${albumList.count { it.optBoolean("sleep", true) }} of ${albumList.size}") to { albumsPage(a, r, albums, albumList, immersive, done) }
            rows += CalmDialog.Row("On the photo", header = true) to {}
            for ((k, name) in SHOW) rows += CalmDialog.Row(name, value = onOff(show.optBoolean(k, true))) to {
                val v = !show.optBoolean(k, true); show.put(k, v); r.put("show", show)
                House.setResting(JSONObject().put("show", JSONObject().put(k, v))); done(); again()
            }
        }
        CalmDialog(a).setTitle("Resting screen").setRows(rows.map { it.first }) { _, i -> rows[i].second() }
            .setNegativeButton("Close", null).show().also { immersive() }
    }

    private fun albumsPage(a: Activity, r: JSONObject, albums: org.json.JSONArray?, list: List<JSONObject>, immersive: () -> Unit, done: () -> Unit) {
        val rows = list.map { CalmDialog.Row(it.optString("name"), value = onOff(it.optBoolean("sleep", true))) }
        CalmDialog(a).setTitle("Albums").setRows(rows) { _, i ->
            val al = list[i]; val v = !al.optBoolean("sleep", true); al.put("sleep", v)
            House.albumOnRest(al.optString("id"), v); done(); albumsPage(a, r, albums, list, immersive, done)
        }.setNegativeButton("Back") { _, _ -> page(a, r, albums, immersive, done) }.show().also { immersive() }
    }

    private fun pick(a: Activity, title: String, choices: List<Int>, now: Int, name: (Int) -> String, immersive: () -> Unit, back: () -> Unit, then: (Int) -> Unit) {
        val all = if (now in choices) choices else (choices + now).sortedBy { if (it == 0) Int.MAX_VALUE else it }
        CalmDialog(a).setTitle(title).setRows(all.map { CalmDialog.Row(name(it), value = if (it == now) "Now" else null) }) { _, i -> then(all[i]) }
            .setNegativeButton("Back") { _, _ -> back() }.show().also { immersive() }
    }
}
