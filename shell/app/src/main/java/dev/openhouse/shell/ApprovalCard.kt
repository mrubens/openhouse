package dev.openhouse.shell

import android.app.Dialog
import android.content.Context
import android.graphics.drawable.ColorDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The "Is this OK?" card: a plugin to add, a reward, a risky tap in another app (DeviceServer /approve,
 * DeviceAccess.approve). It's the shell's own card, so it doesn't need Device control: with it on, the card is an
 * accessibility overlay (over whatever app is in front); with it off (a tablet set up by QR code), it's a window of
 * the display, brought to the front. Either way its yes answers only a real finger ([dev.openhouse.ui.PersonCards]),
 * or the PIN on its own pad.
 */
object ApprovalCard {
    private const val TAG = "Approval"
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val ASKING = Object()
    /** A card is up, waiting for a person's tap (the live voice doesn't wait on it: LiveVoice building). */
    @Volatile var open = false; private set

    /** What a card shows, all of it (the rights scroll, never cut): more than this and the card says no instead. The
     *  bridge's longest is a voice action's words (bridge/plugins.js ACTION_LIMITS: about 12,500 characters for one),
     *  20 apps of 16 actions each, and the request is at most DeviceServer's 1 MB. */
    object Limits {
        const val TITLE = 200
        const val DETAIL = 3000
        const val MORE = 20_000
        const val RIGHTS = 400
        const val RIGHT = 20_000
    }

    /** Why a card with these words can't be shown in full (so it's a no), or null when it can. Plain Kotlin, for tests. */
    fun tooLong(title: String, detail: String, more: String?, rights: List<Pair<String, String>>): String? = when {
        title.length > Limits.TITLE -> "its title is longer than ${Limits.TITLE} characters"
        detail.length > Limits.DETAIL -> "its text is longer than ${Limits.DETAIL} characters"
        (more?.length ?: 0) > Limits.MORE -> "its details are longer than ${Limits.MORE} characters"
        rights.size > Limits.RIGHTS -> "it lists more than ${Limits.RIGHTS} things it may do"
        rights.any { it.second.length > Limits.RIGHT } -> "one thing it may do is longer than ${Limits.RIGHT} characters"
        else -> null
    }

    /** Where a card goes up and comes down. */
    private class Host(val c: Context, val show: (View) -> Unit, val hide: (View) -> Unit)

    /** The display's own window for it, over its dialogs (Settings' may be open), the display brought to the front. */
    private fun displayHost(a: MainActivity): Host {
        var d: Dialog? = null
        return Host(a, show = { v ->
            if (!a.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) KioskApps.goHome()
            runCatching { // a keyboard left up (a field below in focus) would hide the card's buttons
                a.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(a.window.decorView.windowToken, 0)
            }
            d = Dialog(a).apply {
                requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
                setContentView(v); setCancelable(false)
                window?.apply {
                    setBackgroundDrawable(ColorDrawable(0))
                    setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
                    setDimAmount(0f)
                }
                show()
                window?.insetsController?.hide(WindowInsets.Type.systemBars()) // the tablet stays full screen
            }
        }, hide = { runCatching { d?.dismiss() }; d = null })
    }

    /**
     * Ask the people in the room. Blocks the calling (server) thread until someone answers; no answer in [timeoutMs]
     * counts as No, and so does nowhere to show it (no Device control and no display). Nothing the agent sends can
     * answer it: while it's up the device tools do nothing ([dev.openhouse.ui.PersonCards]), and its yes answers only
     * a real finger. One card at a time: a second waits for the first.
     * With [parent], only someone can say yes: the PIN on the card's own pad (no keyboard), right as its last digit
     * goes in. Within the grace after an unlock (ParentGrace) the card just asks.
     */
    fun ask(title: String, detail: String, timeoutMs: Long = 90_000, parent: Boolean = false, yes: String = "Allow",
            rights: List<Pair<String, String>> = emptyList(), more: String? = null, danger: Boolean = false): Boolean = synchronized(ASKING) {
        val host = DeviceAccess.instance?.let { acc -> Host(acc, acc::showOverlay, acc::hideOverlay) }
            ?: MainActivity.live?.let(::displayHost)
            ?: return false.also { Log.i(TAG, "nowhere to ask \"$title\"") }
        val c = host.c
        val done = CountDownLatch(1)
        val asking = dev.openhouse.ui.PersonCards.open(title)
        var said = false
        var shown: View? = null
        main.post {
            // The shared look (Calm), as the shell's own dialogs; the house rules in docs/ux.md: the title is the
            // question, one short line, the rights as a list (never behind More), then the verb.
            val K = dev.openhouse.ui.Calm
            val col = K.column(c).apply {
                setPadding(K.px(c, 44), K.px(c, 40), K.px(c, 44), K.px(c, 32))
                background = K.rounded(K.SHEET, K.R_SHEET * K.u(c)); elevation = 24f
            }
            col.addView(K.title(c, title))
            if (detail.isNotBlank()) col.addView(K.text(c, detail, K.BODY, 400, K.SOFT).apply {
                setPadding(0, K.px(c, 12), 0, 0)
                maxHeight = K.px(c, 300)
                movementMethod = android.text.method.ScrollingMovementMethod() // (no scrollbar: a TextView made in code has no drawable for one, and asking for it crashes)
            })
            // All of them, scrolling when there are many: never cut. At most 330 dp tall, so the PIN and buttons fit.
            if (rights.isNotEmpty()) col.addView(dev.openhouse.ui.Calm.Capped(c, K.px(c, 330)).apply { addView(K.rights(c, rights)); isVerticalScrollBarEnabled = false },
                android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = K.px(c, 22) })
            more?.takeIf { it.isNotBlank() }?.let { col.addView(dev.openhouse.ui.Calm.Capped(c, K.px(c, 240)).apply { addView(K.more(c, it)); isVerticalScrollBarEnabled = false },
                android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = K.px(c, 8) }) }
            val row = K.row(c, 8).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL; setPadding(0, K.px(c, 28), 0, 0) }
            fun answer(a: Boolean) { if (done.count == 0L) return; said = a; done.countDown() }
            val needPin = parent && ParentPin.isSet(c) && !ParentGrace.isOpen()
            if (needPin) { // a yes: the PIN is the yes
                col.addView(K.text(c, "Type the PIN to ${yes.lowercase()}.", 18f, 500, K.SOFT).apply { setPadding(0, K.px(c, 20), 0, 0) })
                val pad = dev.openhouse.ui.PinPad(c, ParentPin.length(c)) { p, entry ->
                    if (ParentPin.check(c, entry)) answer(true) else PinPrompt.showLock(p, c, "Wrong PIN")
                }
                PinPrompt.showLock(pad, c, null)
                col.addView(pad, android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = K.px(c, 8) })
                row.addView(K.quiet(c, "Not now") { answer(false) })
            } else {
                row.addView(K.quiet(c, "Not now") { answer(false) })
                var byHand: () -> Boolean = { false }
                row.addView((if (danger) K::danger else K::primary)(c, yes) { if (byHand()) answer(true) }
                    .also { byHand = dev.openhouse.ui.PersonCards.yesOnlyByHand(it) })
            }
            col.addView(row)
            val dim = android.widget.FrameLayout(c).apply {
                setBackgroundColor(K.SCRIM)
                addView(col, android.widget.FrameLayout.LayoutParams(K.px(c, 760), -2, Gravity.CENTER))
                isClickable = true // swallow taps meant for what's underneath
            }
            if (runCatching { host.show(dim) }.onFailure { Log.w(TAG, "couldn't show the card: $it") }.isFailure) { answer(false); return@post }
            shown = dim; Log.i(TAG, "asking: $title")
        }
        open = true
        val answered = try { done.await(timeoutMs, TimeUnit.MILLISECONDS) } finally {
            open = false
            main.post { shown?.let { v -> runCatching { host.hide(v) }; (v.parent as? ViewGroup)?.removeView(v) }; shown = null }
            dev.openhouse.ui.PersonCards.close(asking)
        }
        Log.i(TAG, "approval \"$title\": ${if (!answered) "timed out" else if (said) "yes" else "no"}")
        answered && said
    }
}
