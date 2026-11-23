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
        dialog = CalmDialog(act).setTitle(title).setView(pad).setWidth(620f)
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { if (!done) { done = true; cancelled() } }
            .show()
        (act as? MainActivity)?.immersive()
    }

    /** Choose a PIN (4 to 8 digits), typed twice; then [then]. */
    fun choose(act: Activity, pins: Context, then: () -> Unit = {}, note: String? = null) {
        lateinit var d: android.app.Dialog
        val first = PinPad(act, null) { _, entry ->
            d.dismiss()
            again(act, pins, entry, then)
        }
        first.say(note ?: "")
        d = CalmDialog(act).setTitle("Choose a PIN").setMessage("4 to 8 digits.")
            .setView(first).setWidth(620f).setNegativeButton("Cancel", null).show()
        (act as? MainActivity)?.immersive()
    }

    private fun again(act: Activity, pins: Context, first: String, then: () -> Unit) {
        lateinit var d: android.app.Dialog
        val pad = PinPad(act, first.length) { _, entry ->
            d.dismiss()
            if (entry == first) { ParentPin.set(pins, first); ParentGrace.open(); dev.openhouse.ui.Openhouse.settingsChanged(); then() }
            else choose(act, pins, then, "Those didn't match. Try again.")
        }
        d = CalmDialog(act).setTitle("Once more").setView(pad).setWidth(620f).setNegativeButton("Cancel", null).show()
        (act as? MainActivity)?.immersive()
    }

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
