package dev.openhouse.ui

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.View
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import dev.openhouse.shell.PinEntry

/**
 * The on-screen pad for the PIN, in the shared look: a line for what's wrong, a dot per digit, and big number
 * keys with Delete. No system keyboard. With the PIN's [length] known, [onEntry] gets the digits as the last one is
 * pressed; without, an OK key appears from 4 digits. [onEntry] answers with [wrong] (or by closing what holds it).
 * A hardware keyboard's digits, Backspace and Enter work too.
 */
class PinPad(private val c: Context, private val length: Int?, private val onEntry: (PinPad, String) -> Unit) : LinearLayout(c) {
    companion object { const val MARK = "PIN pad" }
    private val entry = PinEntry(length)
    private val status = Calm.text(c, "", 18f, 500, Calm.SOFT).apply { gravity = Gravity.CENTER; minHeight = Calm.px(c, 28) }
    private val dots = Calm.row(c, 18).apply { gravity = Gravity.CENTER; minimumHeight = Calm.px(c, 30) }
    private val keys = mutableListOf<TextView>()
    private lateinit var okKey: TextView
    private var below: LinearLayout? = null
    var locked = false; private set

    init {
        orientation = VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
        contentDescription = MARK // how device control knows a PIN is up, in whichever app's window (DeviceAccess.pinShowing)
        isFocusable = true; isFocusableInTouchMode = true; defaultFocusHighlightEnabled = false // focused only for a keyboard's keys
        addView(status, LayoutParams(-1, -2))
        addView(dots, LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 10); bottomMargin = Calm.px(c, 26) })
        val grid = GridLayout(c).apply { columnCount = 3 }
        for (k in listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "OK", "0", "Delete")) {
            val ink = k == "OK"
            val t = Calm.text(c, k, if (k.length > 1) Calm.LABEL else 32f, if (ink) 600 else 500, if (ink) Calm.SHEET else Calm.INK).apply {
                gravity = Gravity.CENTER; isClickable = true; isFocusable = false
                val r = Calm.R_CARD * Calm.u(c)
                background = Calm.pressable(c, Calm.rounded(if (ink) Calm.INK else if (k == "Delete") 0x00000000 else Calm.TINT, r), r)
                setOnClickListener { v -> v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); press(k) }
            }
            if (ink) okKey = t
            keys += t
            grid.addView(t, GridLayout.LayoutParams().apply {
                width = Calm.px(c, 150); height = Calm.px(c, 78)
                val m = Calm.px(c, 6); setMargins(m, m, m, m)
            })
        }
        addView(grid, LayoutParams(-2, -2))
        redraw()
    }

    /** A quiet choice under the keys. */
    fun addBelow(label: CharSequence, onClick: () -> Unit): View {
        val b = Calm.quiet(c, label) { onClick() }
        (below ?: Calm.row(c, 8).apply { gravity = Gravity.CENTER; this@PinPad.addView(this, LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 14) }) }.also { below = it }).addView(b)
        return b
    }

    /** That wasn't it: a short shake, the dots empty, and [message] above them. */
    fun wrong(message: CharSequence) {
        entry.clear(); redraw(); say(message)
        dots.animate().cancel()
        dots.translationX = 0f
        val d = Calm.px(c, 12).toFloat()
        dots.animate().translationX(d).setDuration(50).withEndAction {
            dots.animate().translationX(-d).setDuration(90).withEndAction { dots.animate().translationX(0f).setDuration(60) }
        }
    }

    /** Keys off while the PIN is locked after wrong guesses ([message]: when it takes guesses again). */
    fun lock(message: CharSequence?) {
        locked = message != null
        keys.forEach { it.isEnabled = !locked; it.alpha = if (locked) .4f else 1f }
        say(message ?: "")
    }

    fun say(message: CharSequence) { status.text = message }

    private fun press(k: String) {
        if (locked) return
        when (k) {
            "Delete" -> { entry.delete(); redraw() }
            "OK" -> if (entry.wantsOk) onEntry(this, entry.text)
            else -> {
                if (status.text.isNotEmpty()) say("")
                val last = entry.digit(k[0]); redraw()
                if (last) post { onEntry(this, entry.text) } // after the last dot is drawn
            }
        }
    }

    private fun redraw() {
        dots.removeAllViews()
        val slots = length ?: entry.count.coerceAtLeast(1)
        for (i in 0 until slots) dots.addView(View(c).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                if (i < entry.count) setColor(Calm.INK) else setStroke(Calm.px(c, 2).coerceAtLeast(2), if (length == null) 0x00000000 else Calm.FAINT)
            }
        }, LayoutParams(Calm.px(c, 20), Calm.px(c, 20)))
        okKey.visibility = if (entry.wantsOk) View.VISIBLE else View.INVISIBLE
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (e.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(e)
        when {
            e.keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> press(('0' + (e.keyCode - KeyEvent.KEYCODE_0)).toString())
            e.keyCode in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> press(('0' + (e.keyCode - KeyEvent.KEYCODE_NUMPAD_0)).toString())
            e.keyCode == KeyEvent.KEYCODE_DEL -> press("Delete")
            e.keyCode == KeyEvent.KEYCODE_ENTER || e.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER -> press("OK")
            else -> return super.dispatchKeyEvent(e)
        }
        return true
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); requestFocus() }
}
