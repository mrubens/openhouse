package dev.openhouse.shell

// Asking for the PIN: the on-screen pad (PinPad) in a sheet,
// and none of it within two minutes of the last unlock (ParentGrace). Settings, askParentPin and the approval
// card (DeviceAccess.approve) all come here.

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import dev.openhouse.ui.CalmDialog
import dev.openhouse.ui.PinPad

internal object PinPrompt {
    private const val TAG = "PinPrompt"

    /**
     * The PIN (one is set: callers check), then [ok]. Straight to [ok] within the grace. [pins]: the shell's
     * context, where the PIN is kept; [act]: what to draw over. [cancelled] when it's closed without unlocking.
     */
    fun ask(act: Activity, pins: Context, title: String, ok: () -> Unit, cancelled: () -> Unit = {}) {
        if (ParentGrace.isOpen()) return ok()
        var done = false
        var dialog: android.app.Dialog? = null
        fun unlocked() { if (done) return; done = true; dialog?.dismiss(); ok() }
        val pad = PinPad(act, ParentPin.length(pins)) { p, entry ->
            if (ParentPin.check(pins, entry)) unlocked() else showLock(p, pins, "Wrong PIN")
        }
        showLock(pad, pins, null)
        // Rare, so a quiet link under the pad, not a third button (docs/ux.md). The forgot steps answer for it after.
        val view = dev.openhouse.ui.Calm.column(act).apply {
            addView(pad, android.widget.LinearLayout.LayoutParams(-1, -2))
            addView(dev.openhouse.ui.Calm.quiet(act, "Forgot PIN?") { done = true; dialog?.dismiss(); forgot(act, pins, ok, cancelled) },
                android.widget.LinearLayout.LayoutParams(-2, -2).apply { gravity = android.view.Gravity.CENTER_HORIZONTAL; topMargin = dev.openhouse.ui.Calm.px(act, 8) })
        }
        dialog = CalmDialog(act).setTitle(title).setView(view).setWidth(620f)
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!done) { done = true; cancelled() } }
            .show()
        (act as? MainActivity)?.immersive()
    }

    /** Choose a PIN (4 to 8 digits), typed twice, then its recovery code; then [then]. Nothing is set until someone
     *  says they've kept the code, so a PIN never exists without one having been shown. [back]: closed before that. */
    fun choose(act: Activity, pins: Context, then: () -> Unit = {}, note: String? = null, back: () -> Unit = {}) {
        lateinit var d: android.app.Dialog
        var going = false
        val first = PinPad(act, null) { _, entry ->
            going = true; d.dismiss()
            again(act, pins, entry, then, back)
        }
        first.say(note ?: "")
        d = CalmDialog(act).setTitle("Choose a PIN").setMessage("4 to 8 digits.")
            .setView(first).setWidth(620f).setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!going) back() }.show()
        (act as? MainActivity)?.immersive()
    }

    private fun again(act: Activity, pins: Context, first: String, then: () -> Unit, back: () -> Unit) {
        lateinit var d: android.app.Dialog
        var going = false
        val pad = PinPad(act, first.length) { _, entry ->
            going = true; d.dismiss()
            if (entry == first) showCode(act, RecoveryCode.new(), keep = { code -> ParentPin.set(pins, first, code); ParentGrace.open(); dev.openhouse.ui.Openhouse.settingsChanged(); then() }, back = back)
            else choose(act, pins, then, "Those didn't match. Try again.", back)
        }
        d = CalmDialog(act).setTitle("Once more").setView(pad).setWidth(620f).setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!going) back() }.show()
        (act as? MainActivity)?.immersive()
    }

    // --- the recovery code (docs/settings.md, "Forgot the PIN") ----------------------------------------------------

    /**
     * The PIN's recovery code, shown once: [keep] with it after "I've kept it" (only then is anything saved), [back]
     * on Cancel. It can't be swiped away, and while it's up Opie's screen tools see nothing (it's marked as a PIN pad,
     * DeviceAccess.pinShowing) and its tap can't say "I've kept it" (setForPerson).
     */
    fun showCode(act: Activity, code: String, keep: (String) -> Unit, back: () -> Unit = {}) {
        val box = dev.openhouse.ui.Calm.column(act).apply {
            contentDescription = PinPad.MARK
            addView(dev.openhouse.ui.Calm.text(act, "If the PIN is forgotten, this code sets a new one. Write it down or take a photo, and keep it where only you can get to it.", 19f, 400, dev.openhouse.ui.Calm.SOFT))
            addView(dev.openhouse.ui.Calm.text(act, code, 40f, 600).apply { letterSpacing = .08f; gravity = android.view.Gravity.CENTER; setPadding(0, dev.openhouse.ui.Calm.px(act, 28), 0, dev.openhouse.ui.Calm.px(act, 8)) },
                android.widget.LinearLayout.LayoutParams(-1, -2))
        }
        CalmDialog(act).setTitle("PIN recovery code").setView(box).setWidth(760f).setCancelable(false).setForPerson()
            .setMore("It's shown only now: the tablet keeps a scrambled copy that can check it but not show it. A new code can be made later in Settings, Advanced, after the PIN.")
            .setPositiveButton("I've kept it") { _, _ -> keep(code) }
            .setNegativeButton("Cancel") { _, _ -> back() }.show()
        (act as? MainActivity)?.immersive()
    }

    /**
     * "Forgot PIN?": the PIN's recovery code (or the backups' recovery code, which only someone who saved it has),
     * then a new PIN and its new code, then [ok]. [cancelled] if they give up. Opie can't see or type in it (PIN pad
     * mark, setForPerson). A tablet linked to an account also offers Reset with your account ([viaAccount]).
     */
    fun forgot(act: Activity, pins: Context, ok: () -> Unit, cancelled: () -> Unit = {}, again: Boolean = false) {
        val box = dev.openhouse.ui.Calm.field(act, "XXXX-XXXX-XXXX-XXXX").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            letterSpacing = .06f
        }
        var d: android.app.Dialog? = null
        val view = dev.openhouse.ui.Calm.column(act).apply { contentDescription = PinPad.MARK; addView(box, android.widget.LinearLayout.LayoutParams(-1, -2)) }
        // Linked to an account: a signed-in member of the family can say yes instead (a quiet link, not a third button).
        kotlin.concurrent.thread {
            val linked = runCatching { org.json.JSONObject(dev.openhouse.ui.BridgeClient.getText(dev.openhouse.ui.Openhouse.bridgeUrl + "/cloud/status", 1500, 5000)).optBoolean("linked") }.getOrDefault(false)
            if (linked) act.runOnUiThread {
                if (d?.isShowing != true) return@runOnUiThread
                view.addView(dev.openhouse.ui.Calm.quiet(act, "Reset with your account") { d?.dismiss(); viaAccount(act, pins, ok, cancelled) }.apply { setPadding(0, 0, 0, 0) },
                    android.widget.LinearLayout.LayoutParams(-2, -2).apply { topMargin = dev.openhouse.ui.Calm.px(act, 12) })
            }
        }
        d = CalmDialog(act).setTitle(if (again) "That code doesn't fit" else "Forgot the PIN")
            .setMessage("Type the recovery code that was shown when the PIN was chosen. The backups' recovery code works too.")
            .setView(view).setWidth(760f).setForPerson().setCancelable(false)
            .setMore("A tablet set up before recovery codes has none: make one in Settings, Advanced, while the PIN is known.")
            .setPositiveButton("Next") { _, _ ->
                val typed = box.text.toString()
                kotlin.concurrent.thread {
                    val right = ParentPin.checkRecovery(pins, typed) || backupCode()?.let { RecoveryCode.sameBackupCode(typed, it) } == true
                    act.runOnUiThread {
                        if (!right) return@runOnUiThread forgot(act, pins, ok, cancelled, again = true)
                        Log.i(TAG, "PIN reset with a recovery code")
                        choose(act, pins, then = { MainActivity.live?.lock?.changed(); ok() }, note = "Choose a new PIN.", back = cancelled)
                    }
                }
            }
            .setNegativeButton("Cancel") { _, _ -> cancelled() }.show()
        (act as? MainActivity)?.immersive()
    }

    /**
     * Reset with your account (docs/settings.md, "Forgot the PIN"): the tablet shows a code (bridge /cloud/pin-reset);
     * someone signed in to the account page of the family this tablet is linked to types it there, and only then may
     * they choose a new PIN (and see its new recovery code), then [ok]. It's a person card with the PIN pad's mark, so
     * Opie's screen tools neither read the code nor act while it's up. [cancelled] if they give up.
     */
    fun viaAccount(act: Activity, pins: Context, ok: () -> Unit, cancelled: () -> Unit = {}) {
        val bridge = dev.openhouse.ui.Openhouse.bridgeUrl
        fun say(title: String, text: String) {
            CalmDialog(act).setTitle(title).setMessage(text).setCancelable(false)
                .setPositiveButton("Back") { _, _ -> forgot(act, pins, ok, cancelled) }
                .setNegativeButton("Cancel") { _, _ -> cancelled() }.show()
            (act as? MainActivity)?.immersive()
        }
        kotlin.concurrent.thread {
            val (code, r) = CloudSetup.post("$bridge/cloud/pin-reset/start", org.json.JSONObject(), 20_000)
            act.runOnUiThread {
                if (code != 200 || r == null) return@runOnUiThread say("Couldn't start it",
                    if (r?.optString("code") == "unlinked") "This tablet isn't linked to an account any more." else r?.optString("error")?.ifBlank { null } ?: "The tablet didn't answer. Try again in a minute.")
                val url = r.optString("url")
                val where = runCatching { java.net.URL(url).let { it.host + (if (it.port > 0) ":${it.port}" else "") + it.path } }.getOrDefault(url)
                val C = dev.openhouse.ui.Calm
                val box = C.column(act).apply {
                    contentDescription = PinPad.MARK
                    addView(C.text(act, "On a phone or computer, sign in at $where. Under Reset a tablet's PIN, type this code:", 19f, 400, C.SOFT))
                    addView(C.text(act, r.optString("display"), 48f, 600).apply { letterSpacing = .08f; gravity = android.view.Gravity.CENTER; setPadding(0, C.px(act, 28), 0, C.px(act, 8)) },
                        android.widget.LinearLayout.LayoutParams(-1, -2))
                }
                var waiting = true
                val d = CalmDialog(act).setTitle("Reset with your account").setView(box).setWidth(760f).setForPerson().setCancelable(false)
                    .setMore("Only someone signed in to the account this tablet is linked to can do it. The code works once, for 15 minutes.")
                    .setNegativeButton("Cancel") { _, _ -> waiting = false; cancelled() }
                    .setOnDismissListener { waiting = false }.show()
                (act as? MainActivity)?.immersive()
                kotlin.concurrent.thread {
                    while (waiting) {
                        Thread.sleep(3000)
                        if (!waiting) return@thread
                        val (c2, p) = CloudSetup.post("$bridge/cloud/pin-reset/poll", org.json.JSONObject(), 15_000)
                        if (c2 != 200 || p == null) continue // offline a moment: keep asking until the code runs out
                        val status = p.optString("status")
                        if (status == "waiting") continue
                        act.runOnUiThread {
                            if (!d.isShowing) return@runOnUiThread
                            waiting = false; d.dismiss()
                            if (status != "approved") return@runOnUiThread say("The code ran out", "Start again to get a new one.")
                            Log.i(TAG, "PIN reset through the account")
                            choose(act, pins, then = { MainActivity.live?.lock?.changed(); ok() }, note = "Choose a new PIN.", back = cancelled)
                        }
                        return@thread
                    }
                }
            }
        }
    }

    /** The backups' recovery code, if the tablet has one (bridge/backup.js). */
    private fun backupCode(): String? = runCatching {
        org.json.JSONObject(dev.openhouse.ui.BridgeClient.getText(dev.openhouse.ui.Openhouse.bridgeUrl + "/backup/recovery-code", 1500, 5000)).optString("code").takeIf { it.isNotEmpty() }
    }.getOrNull()

    /** The pad's keys off while the PIN is locked after wrong guesses, back on when it isn't; else [message]. */
    fun showLock(pad: PinPad, pins: Context, message: String?) {
        val wait = ParentPin.lockedForMs(pins)
        if (wait <= 0) { pad.lock(null); if (message != null) pad.wrong(message); return }
        if (message != null) pad.wrong(message)
        pad.lock(tryAgainIn(wait))
        pad.postDelayed({ if (pad.isAttachedToWindow) showLock(pad, pins, null) }, minOf(wait + 50, 1000L))
    }

    // --- the grace ends when the screen sleeps ---------------------------------------------------------------------
    @Volatile private var watching = false
    fun watchScreen(c: Context) {
        if (watching) return
        watching = true
        c.applicationContext.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) { ParentGrace.close() }
        }, IntentFilter(Intent.ACTION_SCREEN_OFF))
    }
}
