package dev.openhouse.shell

// Settings → Advanced → Tailscale: reaching the tablet from away through the household's own Tailscale, for a
// household with no Opie cloud (bridge/tailscale.js, docs/networking.md). Off until someone turns it on; Advanced is
// behind the PIN, and the row is a person's own (DeviceServer.personOnly): it changes who can reach the tablet. The
// bridge does the work; this is only the dialogs: Turn on, the QR code to sign in on a phone (or an auth key), the
// address, Turn off.

import android.text.InputType
import android.widget.ImageView
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import kotlin.concurrent.thread

internal class TailscaleMenu(private val act: MainActivity, private val back: () -> Unit) {
    /** Its state, or null if the bridge didn't answer it (a bridge starting again answers other things first). */
    private fun get() = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/tailscale", 3000, 10_000)) }.getOrNull()?.takeIf { it.has("state") }
    /** The answer (with "error" on a refusal: a key that isn't one), or null if the bridge didn't answer. */
    private fun post(body: JSONObject): JSONObject? = runCatching {
        val c = BridgeClient.open("${act.bridge}/tailscale")
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = 30_000
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        JSONObject((if (c.responseCode < 400) c.inputStream else c.errorStream).use { it.readBytes().toString(Charsets.UTF_8) })
    }.getOrNull()
    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private val noBridge = "The tablet's software isn't answering right now. Try again in a minute."

    fun show() = thread { val s = get(); ui { if (s == null) say(noBridge) else open(s) } }

    private fun say(text: String) { CalmDialog(act).setTitle("Tailscale").setMessage(text).setPositiveButton("Close") { _, _ -> back() }.show() }

    private fun open(s: JSONObject) {
        val state = if (!s.optBoolean("on")) "off" else s.optString("state")
        val error = s.optString("error").takeIf { !s.isNull("error") && it.isNotEmpty() }
        when (state) {
            "off" -> CalmDialog(act).setTitle("Reach Opie with Tailscale?")
                .setMessage("Phones and computers with Tailscale on reach it from anywhere.")
                .setMore("Your own Tailscale account, not Opie's cloud. Tailscale has to be on on each phone and computer, at home too. Turning it on downloads Tailscale (about 40 MB).")
                .setPositiveButton("Turn on") { _, _ -> thread { val r = post(JSONObject().put("on", true)); ui { if (r == null || !r.has("state")) say(r?.optString("error") ?: noBridge) else follow() } } }
                .setNegativeButton("Back") { _, _ -> back() }.show()
            "signin" -> signIn(s.optString("login"), error)
            "approve" -> CalmDialog(act).setTitle("Approve Opie in Tailscale")
                .setMessage("In Tailscale's admin console, under Machines.")
                .setPositiveButton("Close") { _, _ -> back() }.setNegativeButton("Turn off") { _, _ -> turnOff() }.show()
            "on" -> {
                val address = s.optString("address").removePrefix("https://").removePrefix("http://")
                CalmDialog(act).setTitle("Tailscale is on").setMessage(address)
                    .setMore(if (s.optBoolean("https")) null else "For an https address, turn on HTTPS in Tailscale's admin console, under DNS.")
                    .setPositiveButton("Turn off") { _, _ -> turnOff() }.setNegativeButton("Back") { _, _ -> back() }.show()
            }
            else -> follow(error) // getting, starting, error
        }
    }

    /** While it downloads and starts: a moment's wait, then whatever comes next (the QR code to sign in, usually). */
    private fun follow(error: String? = null) {
        var showing = true
        val d = CalmDialog(act).setTitle("Tailscale").setMessage(error ?: "Starting…")
            .setPositiveButton("Close") { _, _ -> back() }.setNegativeButton("Turn off") { _, _ -> turnOff() }
            .setOnDismissListener { showing = false }.show()
        thread {
            val until = System.currentTimeMillis() + 3 * 60_000L
            while (showing && System.currentTimeMillis() < until) {
                Thread.sleep(1500)
                val s = get() ?: continue
                val st = if (!s.optBoolean("on")) "off" else s.optString("state")
                if (st == "getting" || st == "starting" || (st == "error" && s.optString("error") == error)) continue
                ui { if (showing) { d.dismiss(); open(s) } }
                return@thread
            }
        }
    }

    /** The login link as a QR code, for a phone; or an auth key pasted here. It moves on by itself once signed in. */
    private fun signIn(login: String, error: String?) {
        var showing = true
        val col = Calm.qr(act, ImageView(act).apply { setImageBitmap(Handoff.qr(login, 520)) }, Calm.caption(act, error ?: "Scan with your phone and sign in."), 340)
        var d: android.app.Dialog? = null
        col.addView(Calm.quiet(act, "Use an auth key") { showing = false; d?.dismiss(); key() }) // (this one goes: the key's answer opens the next)
        d = CalmDialog(act).setTitle("Sign in to Tailscale").setView(col)
            .setPositiveButton("Close") { _, _ -> back() }.setNegativeButton("Turn off") { _, _ -> turnOff() }
            .setOnDismissListener { showing = false }.show()
        thread {
            val until = System.currentTimeMillis() + 15 * 60_000L
            while (showing && System.currentTimeMillis() < until) {
                Thread.sleep(2000)
                val s = get() ?: continue
                if (s.optBoolean("on") && s.optString("state") == "signin" && s.optString("login") == login) continue
                ui { if (showing) { d?.dismiss(); open(s) } }
                return@thread
            }
        }
    }

    /** An auth key from Tailscale's admin console (Settings, Keys), pasted. */
    private fun key() {
        val box = Calm.field(act, "tskey-…").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD }
        CalmDialog(act).setTitle("Auth key").setView(box)
            .setPositiveButton("Use it") { _, _ ->
                thread { val r = post(JSONObject().put("on", true).put("key", box.text.toString().trim())); ui { if (r == null || !r.has("state")) say(r?.optString("error") ?: noBridge) else follow() } }
            }
            .setNegativeButton("Cancel") { _, _ -> show() }.show()
    }

    /** Signed out of Tailscale here, and its download and state gone. */
    private fun turnOff() {
        CalmDialog(act).setTitle("Turn off Tailscale?").setMessage("Opie signs out of it here.").setDanger()
            .setPositiveButton("Turn off") { _, _ -> thread { val r = post(JSONObject().put("on", false)); ui { if (r == null) say(noBridge) else { act.toast("Off"); back() } } } }
            .setNegativeButton("Cancel") { _, _ -> show() }.show()
    }
}
