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
    private val noBridge = "The device's software isn't answering right now. Try again in a minute."

    fun show() = thread {
        val s = get("/cloud/status?check=1", 15000)
        ui { if (s == null) say("Cloud", noBridge) else if (s.optBoolean("linked")) linked(s) else unlinked(s) }
    }

    private fun unlinked(s: JSONObject) {
        // (Your own cloud's address is in Advanced, For developers: rare, so not a third button here.)
        CalmDialog(act).setTitle("Account").setMessage("See this device from the web, and back it up.")
            // A USB drive works unlinked too; so does Email with the household's own mailbox.
            .setItems(arrayOf("Backups", "Email")) { _, i -> if (i == 0) BackupMenu(act) { show() }.show() else act.lock.withPin { EmailMenu(act).show() } }
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
        val r = post("/cloud/link/start", JSONObject().put("name", "Opie"))
        ui {
            // The service's own words only as the details: they're for us, not the household.
            if (r == null || r.has("error")) return@ui run {
                CalmDialog(act).setTitle("Couldn't link")
                    .setMessage(if (r == null) noBridge else "The device couldn't reach your Opie account just now. Check the Wi-Fi and try again in a minute.")
                    .setMore(r?.optString("error")?.ifEmpty { null }).setPositiveButton("Close", null).open()
            }
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
                    if (s.optBoolean("linked")) { ui { d.dismiss(); done(s, then) }; return@thread } // (an older cloud: no yes asked)
                    if (s.isNull("linking") || !s.has("linking")) { ui { if (d.isShowing) { d.dismiss(); say("Link", "The code ran out. Start again to get a new one.") } }; return@thread }
                    val ask = s.optJSONObject("linking")?.optJSONObject("confirm")
                    if (ask != null) { ui { if (d.isShowing) { d.dismiss(); confirm(ask, then) } }; return@thread }
                }
            }
        }
    }

    /** Linked: [then], or the Account menu. Either way the voice is looked at at once (CloudSetup.autoVoice): on by
     *  itself if this household said yes to it and its account has it. */
    private fun done(s: JSONObject, then: (() -> Unit)?) { act.toast("Linked to ${s.optString("family")}"); CloudSetup.voiceSoon(); if (then != null) then() else linked(s) }

    /** Someone entered the code: link to their account? A person's own yes, by hand (a person card; Opie's tap on it
     *  does nothing). No, or closing it, tells the cloud no. */
    private fun confirm(ask: JSONObject, then: (() -> Unit)?) {
        var answered = false
        fun answer(ok: Boolean) {
            if (answered) return
            answered = true
            thread {
                val r = post("/cloud/link/confirm", JSONObject().put("ok", ok))
                ui {
                    when {
                        r == null || r.has("error") -> say("Link", r?.optString("error")?.ifEmpty { null } ?: noBridge)
                        ok && r.optBoolean("linked") -> done(r, then)
                        else -> act.toast("Not linked")
                    }
                }
            }
        }
        val family = ask.optString("family").ifBlank { null }
        val by = ask.optString("by").ifBlank { null }
        CalmDialog(act).setForPerson().setTitle(if (family != null) "Link to $family?" else "Link to this account?")
            .setMessage(if (by != null) "$by entered the code." else "Someone entered the code.")
            .setPositiveButton("Link") { _, _ -> if (!DeviceServer.personOnly("Linking this device to an account")) answer(true) }
            .setNegativeButton("No") { _, _ -> answer(false) }
            .setOnDismissListener { act.window.decorView.post { answer(false) } }.open() // (after a button's own answer)
    }

    private fun linked(s: JSONObject) {
        val items = listOf<Pair<String, () -> Unit>>("Backups" to { BackupMenu(act) { show() }.show() }, "Email" to { act.lock.withPin { EmailMenu(act).show() } }, "Use it away from home" to { away() }, "Unlink this device" to { unlink() })
        CalmDialog(act).setTitle("Account").setMessage("Linked to ${s.optString("family").ifEmpty { "your household" }}.")
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }.setNegativeButton("Back", null).open()
    }

    /** Paired computers, screens and phone lists reaching this tablet from anywhere, through the cloud's relay
     *  (bridge/relay.js, docs/networking.md). Off until someone turns it on here, or opens Connect your AI assistant. */
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
                .setMore("Linked computers, screens and phones reach this device from anywhere, sealed so the relay can't read it.")
                .setPositiveButton(if (on) "Turn off" else "Turn on") { _, _ -> thread { val x = post("/relay", JSONObject().put("on", !on)); ui { if (x == null || x.has("error")) say("Use it away from home", x?.optString("error") ?: noBridge) else act.toast(if (on) "Off" else "On") } } }
                .setNegativeButton("Back") { _, _ -> show() }.open()
        }
    }

    /** Behind a PIN, set first if there's none (SettingsLock.withPinSet): unlinked, the account's way back in goes. A
     *  PIN chosen while linked has no recovery code (the account resets it: PinPrompt.choose), so one is shown and
     *  kept first, since unlinked it's the way back in. */
    private fun unlink() = act.lock.withPinSet(back = { show() }) {
        if (!ParentPin.hasRecovery(act)) PinPrompt.showCode(act, RecoveryCode.new(), keep = { ParentPin.setRecovery(act, it); unlinkNow() }, back = { show() })
        else unlinkNow()
    }

    private fun unlinkNow() {
        CalmDialog(act).setTitle("Unlink this device?").setMessage("Its backups stay in the account.")
            .setPositiveButton("Unlink") { _, _ -> thread { val r = post("/cloud/unlink"); ui { if (r?.optBoolean("ok") == true) act.toast("Unlinked") else say("Unlink", r?.optString("error") ?: noBridge) } } }
            .setNegativeButton("Cancel", null).open()
    }
}
