package dev.openhouse.shell

// Settings → Account: linking the tablet to a family account, its address, and unlinking. Backups (to the cloud
// or a USB drive) are their own section (BackupMenu). The bridge does the work (bridge/cloud.js, its /cloud/ routes); this is only the dialogs. Off
// until someone links the tablet.

import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import android.graphics.Typeface
import android.text.InputType
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import dev.openhouse.ui.BridgeClient
import org.json.JSONObject
import kotlin.concurrent.thread

internal class CloudMenu(private val act: MainActivity) {
    private fun get(path: String, readMs: Int = 30_000) = runCatching { JSONObject(BridgeClient.getText("${act.bridge}$path", 3000, readMs)) }.getOrNull()
    /** The answer (with "error" on a refusal), or null if the bridge didn't answer. */
    private fun post(path: String, body: JSONObject = JSONObject(), readMs: Int = 30_000): JSONObject? = runCatching {
        val c = BridgeClient.open("${act.bridge}$path")
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = readMs
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val s = (if (c.responseCode < 400) c.inputStream else c.errorStream).use { it.readBytes().toString(Charsets.UTF_8) }
        JSONObject(s)
    }.getOrNull()
    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private fun CalmDialog.open(): android.app.Dialog = show() // the shared look (ui/Calm.kt)
    private fun say(title: String, text: String, then: (() -> Unit)? = null) {
        CalmDialog(act).setTitle(title).setMessage(text).setPositiveButton("Close") { _, _ -> then?.invoke() }.open()
    }
    private val noBridge = "The tablet's software isn't answering right now. Try again in a minute."

    fun show() = thread {
        val s = get("/cloud/status?check=1", 15000)
        ui { if (s == null) say("Cloud", noBridge) else if (s.optBoolean("linked")) linked(s) else unlinked(s) }
    }

    private fun unlinked(s: JSONObject) {
        // (Your own cloud's address is in Advanced, For developers: rare, so not a third button here.)
        CalmDialog(act).setTitle("Account").setMessage("See this tablet from the web, and back it up.")
            .setItems(arrayOf("Backups")) { _, _ -> BackupMenu(act) { show() }.show() } // a USB drive works unlinked too
            .setPositiveButton("Link") { _, _ -> startLink() }
            .setNegativeButton("Back", null).open()
    }

    /** The cloud's address, for people who run their own (Advanced). */
    fun address() = thread { val s = get("/cloud/status", 5000); ui { if (s == null) say("Cloud address", noBridge) else address(s.optString("api")) } }

    private fun address(now: String) {
        val box = Calm.field(act, "https://…").apply { setText(now); inputType = InputType.TYPE_TEXT_VARIATION_URI }
        CalmDialog(act).setTitle("Cloud address").setMessage("Only if you run your own.").setView(box)
            .setPositiveButton("Save") { _, _ -> thread { val r = post("/cloud/config", JSONObject().put("api", box.text.toString().trim())); ui { if (r?.has("error") != false) say("Cloud address", r?.optString("error") ?: noBridge) else act.toast("Saved") } } }
            .setNegativeButton("Cancel", null).open()
    }

    /** Link with a code typed on a phone or computer; then [then] (turning on Live voice, from the welcome), or the
     *  Account menu. */
    fun startLink(why: String? = null, then: (() -> Unit)? = null) = thread {
        val r = post("/cloud/link/start", JSONObject().put("name", "OpenHouse"))
        ui {
            if (r == null || r.has("error")) return@ui say("Link", r?.optString("error")?.ifEmpty { null } ?: noBridge)
            val url = r.optString("url")
            val host = runCatching { java.net.URL(url).let { it.host + (if (it.port > 0) ":${it.port}" else "") } }.getOrDefault(url)
            val box = Calm.column(act)
            box.addView(Calm.text(act, (why?.let { "$it " } ?: "") + "On a phone or computer, go to $host/link and type this code:", 20f, 400, Calm.SOFT))
            box.addView(Calm.text(act, r.optString("display"), 52f, 600).apply { gravity = Gravity.CENTER; setPadding(0, Calm.px(act, 28), 0, Calm.px(act, 28)); letterSpacing = 0.08f; setTextIsSelectable(true) })
            box.addView(Calm.text(act, "Or scan this with a phone.", 17f, 400, Calm.SOFT))
            runCatching { Handoff.qr(url, 360) }.getOrNull()?.let { bmp -> box.addView(android.widget.ImageView(act).apply { setImageBitmap(bmp); setPadding(0, 16, 0, 0) }, LinearLayout.LayoutParams(-1, 380)) }
            var waiting = true
            val d = CalmDialog(act).setTitle("Link to your account").setView(box)
                .setNegativeButton("Cancel") { _, _ -> waiting = false; thread { post("/cloud/link/cancel") } }
                .setOnDismissListener { waiting = false }.open()
            thread {
                while (waiting) {
                    Thread.sleep(2000)
                    val s = get("/cloud/status", 5000) ?: continue
                    if (s.optBoolean("linked")) { ui { d.dismiss(); act.toast("Linked to ${s.optString("family")}"); if (then != null) then() else linked(s) }; return@thread }
                    if (s.isNull("linking") || !s.has("linking")) { ui { if (d.isShowing) { d.dismiss(); say("Link", "The code ran out. Start again to get a new one.") } }; return@thread }
                }
            }
        }
    }

    private fun linked(s: JSONObject) {
        val items = listOf<Pair<String, () -> Unit>>("Backups" to { BackupMenu(act) { show() }.show() }, "Use it away from home" to { away() }, "Unlink this tablet" to { unlink() })
        CalmDialog(act).setTitle("Account").setMessage("Linked to ${s.optString("family").ifEmpty { "your family" }}.")
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }.setNegativeButton("Back", null).open()
    }

    /** Paired computers, screens and phone lists reaching this tablet from anywhere, through the cloud's relay
     *  (bridge/relay.js, docs/networking.md). Off until someone turns it on here. */
    private fun away() = thread {
        val r = get("/relay", 5000)
        ui {
            if (r == null) return@ui say("Use it away from home", noBridge)
            val on = r.optBoolean("on")
            val now = when {
                !on -> "Off."
                r.optBoolean("connected") -> "On. Connected to the relay."
                r.optString("error").isNotEmpty() && !r.isNull("error") -> "On, but not connected: ${r.optString("error")}."
                else -> "On. Connecting to the relay…"
            }
            CalmDialog(act).setTitle("Use it away from home").setMessage(now)
                .setMore("Linked computers, screens and phones reach this tablet from anywhere, sealed so the relay can't read it.")
                .setPositiveButton(if (on) "Turn off" else "Turn on") { _, _ -> thread { val x = post("/relay", JSONObject().put("on", !on)); ui { if (x == null || x.has("error")) say("Use it away from home", x?.optString("error") ?: noBridge) else act.toast(if (on) "Off" else "On") } } }
                .setNegativeButton("Back") { _, _ -> show() }.open()
        }
    }

    private fun unlink() {
        CalmDialog(act).setTitle("Unlink this tablet?").setMessage("Its backups stay in the account.")
            .setPositiveButton("Unlink") { _, _ -> thread { val r = post("/cloud/unlink"); ui { if (r?.optBoolean("ok") == true) act.toast("Unlinked") else say("Unlink", r?.optString("error") ?: noBridge) } } }
            .setNegativeButton("Cancel", null).open()
    }
}
