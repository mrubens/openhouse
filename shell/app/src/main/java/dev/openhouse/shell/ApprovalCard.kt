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

    /**
     * The card's words as they're shown: no characters that reorder or hide text (bidi controls, zero-width ones, other
     * controls), and on one line where it's one line (the title, each thing it may do). Words that run on can't push
     * what it may do out of sight. [lines]: the text keeps its line breaks, one at a time. Plain Kotlin, for tests.
     */
    fun plain(s: String, lines: Boolean = false): String {
        val kept = s.replace(Regex("[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF\\u061C\\u180E]"), "")
            .replace(Regex("\\r\\n?|[\\u2028\\u2029\\u0085\\u000B\\u000C]"), "\n")
            .replace(Regex("[\\p{Cc}&&[^\\n]]"), " ")
        return if (lines) kept.split('\n').map { it.replace(Regex("\\s+"), " ").trim() }.filter { it.isNotEmpty() }.joinToString("\n")
        else kept.replace(Regex("\\s+"), " ").trim()
    }

    /** How long a card's yes waits after the card is up before it takes a tap (a tap meant for what was there before). */
    const val YES_AFTER_MS = 800L

    /** Where a card goes up and comes down. [bar]: a small bar over the app in front, taps elsewhere reaching the app
     *  (null where there's none: the display's own window can't sit over an app running as its own Android app). */
    private class Host(val c: Context, val show: (View) -> Unit, val hide: (View) -> Unit, val bar: ((View) -> Unit)? = null)

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
            rights: List<Pair<String, String>> = emptyList(), more: String? = null, danger: Boolean = false): Boolean =
        answer(title, detail, timeoutMs, parent, yes, rights, more, danger) == Answer.YES

    /** What the card's people said: yes, no, or nothing (no answer in time, "Not now" on a [later] card, nowhere to show it). */
    enum class Answer { YES, NO, NONE }

    /**
     * [ask], telling a no from no answer. [later]: the card has "Not now" (answers NONE: it's asked again later, as an app
     * made on the tablet waits on Home) besides its no, worded [no]. [grownUp]: the yes always takes the PIN, lock or
     * not; with no PIN set yet the card asks whoever is there to choose one (PinPrompt.choose, with its recovery code),
     * then comes back, and the time it took doesn't count against [timeoutMs] (up to 10 minutes more).
     * [tryApp]: an app made on the tablet, to try first. It's opened, with a small bar at the top ([title], [no], [yes])
     * instead of the card, over it as it runs. Its yes brings the card (rights, the PIN) when there's the PIN to type or
     * [grants] (it would get some of the family's things or websites), and is the yes itself otherwise. Leaving the app
     * is no answer (NONE). Without Device control (no bar over another app) it's the card, as before.
     */
    fun answer(title: String, detail: String, timeoutMs: Long = 90_000, parent: Boolean = false, yes: String = "Allow",
               rights: List<Pair<String, String>> = emptyList(), more: String? = null, danger: Boolean = false,
               grownUp: Boolean = false, later: Boolean = false, no: String? = null, tryApp: String? = null, grants: Boolean = true): Answer =
        shown(plain(title), plain(detail, lines = true), timeoutMs, parent, plain(yes).ifEmpty { "Allow" },
            rights.map { (k, t) -> plain(k) to plain(t) }, more?.let { plain(it, lines = true) }, danger, grownUp, later, no?.let { plain(it) }, tryApp, grants)

    private fun shown(title: String, detail: String, timeoutMs: Long, parent: Boolean, yes: String,
                      rights: List<Pair<String, String>>, more: String?, danger: Boolean,
                      grownUp: Boolean, later: Boolean, no: String?, tryApp: String?, grants: Boolean): Answer = synchronized(ASKING) {
        val host = DeviceAccess.instance?.let { acc -> Host(acc, acc::showOverlay, acc::hideOverlay, acc::showBar) }
            ?: MainActivity.live?.let(::displayHost)
            ?: return Answer.NONE.also { Log.i(TAG, "nowhere to ask \"$title\"") }
        val c = host.c
        val done = CountDownLatch(1)
        val asking = dev.openhouse.ui.PersonCards.open(title)
        var said = Answer.NONE
        var shown: View? = null
        val choosing = java.util.concurrent.atomic.AtomicBoolean(false) // choosing a PIN on the display: the card is down, and its time stands still
        fun hide() { shown?.let { v -> runCatching { host.hide(v) }; (v.parent as? ViewGroup)?.removeView(v) }; shown = null }
        fun answer(a: Answer) { if (done.count == 0L) return; said = a; done.countDown() }
        lateinit var put: () -> Unit
        // [tryApp]: an app made on the tablet, open to try, with a small bar over it (putBar) instead of the card. Its
        // "Keep it" is the card's yes; the full card (what it may use, the PIN) comes up only when there's that to show.
        val trying = tryApp != null && host.bar != null
        val barUp = java.util.concurrent.atomic.AtomicBoolean(false)
        lateinit var putBar: () -> Unit
        put = {
            barUp.set(false)
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
                maxHeight = K.px(c, 200) // (a few lines; the rest scrolls, and what it may do stays in sight below)
                movementMethod = android.text.method.ScrollingMovementMethod() // (no scrollbar: a TextView made in code has no drawable for one, and asking for it crashes)
            })
            // All of them, scrolling when there are many: never cut. At most 330 dp tall, so the PIN and buttons fit.
            if (rights.isNotEmpty()) col.addView(dev.openhouse.ui.Calm.Capped(c, K.px(c, 330)).apply { addView(K.rights(c, rights)); isVerticalScrollBarEnabled = false },
                android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = K.px(c, 22) })
            more?.takeIf { it.isNotBlank() }?.let { col.addView(dev.openhouse.ui.Calm.Capped(c, K.px(c, 240)).apply { addView(K.more(c, it)); isVerticalScrollBarEnabled = false },
                android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = K.px(c, 8) }) }
            val row = K.row(c, 8).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL; setPadding(0, K.px(c, 28), 0, 0) }
            // The quiet ones: its no, and on a [later] card "Not now", which leaves it waiting.
            fun quiet() {
                if (trying) { row.addView(K.quiet(c, "Back") { hide(); putBar() }); return } // (to the app and its bar)
                if (later) row.addView(K.quiet(c, no ?: "No") { answer(Answer.NO) })
                row.addView(K.quiet(c, "Not now") { answer(if (later) Answer.NONE else Answer.NO) })
            }
            // Its yes takes no tap in the first moment it's up, nor one through something drawn over it.
            val liveAt = android.os.SystemClock.uptimeMillis() + YES_AFTER_MS
            fun ready() = android.os.SystemClock.uptimeMillis() >= liveAt
            val noPinYet = grownUp && !ParentPin.isSet(c)
            val needPin = (parent || grownUp) && ParentPin.isSet(c) && !ParentGrace.isOpen()
            if (noPinYet) { // a yes that needs the PIN, and there's none yet: choosing one is the first step
                col.addView(K.text(c, "This needs the PIN, and the tablet has none yet. Choose one, then ${yes.lowercase()}.", 18f, 500, K.SOFT).apply { setPadding(0, K.px(c, 20), 0, 0) })
                quiet()
                var byHand: () -> Boolean = { false }
                row.addView(K.primary(c, "Choose a PIN") {
                    if (!ready() || !byHand()) return@primary
                    val act = MainActivity.live ?: return@primary
                    choosing.set(true); hide()
                    if (!act.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) KioskApps.goHome()
                    val back = { choosing.set(false); if (done.count > 0L) put() }
                    PinPrompt.choose(act, act, then = back, back = back)
                }.also { it.filterTouchesWhenObscured = true; byHand = dev.openhouse.ui.PersonCards.yesOnlyByHand(it) })
            } else if (needPin) { // a yes: the PIN is the yes
                col.addView(K.text(c, "Type the PIN to ${yes.lowercase()}.", 18f, 500, K.SOFT).apply { setPadding(0, K.px(c, 20), 0, 0) })
                val pad = dev.openhouse.ui.PinPad(c, ParentPin.length(c)) { p, entry ->
                    if (ParentPin.check(c, entry)) answer(Answer.YES) else PinPrompt.showLock(p, c, "Wrong PIN")
                }
                PinPrompt.showLock(pad, c, null)
                pad.filterTouchesWhenObscured = true
                col.addView(pad, android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = K.px(c, 8) })
                quiet()
            } else {
                quiet()
                var byHand: () -> Boolean = { false }
                row.addView((if (danger) K::danger else K::primary)(c, yes) { if (ready() && byHand()) answer(Answer.YES) }
                    .also { it.filterTouchesWhenObscured = true; byHand = dev.openhouse.ui.PersonCards.yesOnlyByHand(it) })
            }
            col.addView(row)
            val dim = android.widget.FrameLayout(c).apply {
                setBackgroundColor(K.SCRIM)
                addView(col, android.widget.FrameLayout.LayoutParams(K.px(c, 760), -2, Gravity.CENTER))
                isClickable = true // swallow taps meant for what's underneath
            }
            if (runCatching { host.show(dim) }.onFailure { Log.w(TAG, "couldn't show the card: $it") }.isFailure) answer(Answer.NONE)
            else { shown = dim; Log.i(TAG, "asking: $title") }
        }
        putBar = {
            barUp.set(true)
            val K = dev.openhouse.ui.Calm
            val bar = K.row(c, 8).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(K.px(c, 24), K.px(c, 8), K.px(c, 8), K.px(c, 8))
                background = K.rounded(K.SHEET, K.R_SHEET * K.u(c), K.px(c, 1).coerceAtLeast(1), K.LINE) // (a hairline, not a shadow: an overlay's own window clips one into a box)
            }
            bar.addView(K.text(c, title, K.LABEL, 600).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; maxWidth = K.px(c, 420) },
                android.widget.LinearLayout.LayoutParams(-2, -2).apply { marginEnd = K.px(c, 12) })
            bar.addView(K.quiet(c, no ?: "No") { answer(Answer.NO) })
            val liveAt = android.os.SystemClock.uptimeMillis() + YES_AFTER_MS
            var byHand: () -> Boolean = { false }
            bar.addView(K.primary(c, yes) {
                if (android.os.SystemClock.uptimeMillis() < liveAt || !byHand()) return@primary
                val pin = (grownUp && !ParentPin.isSet(c)) || ((parent || grownUp) && ParentPin.isSet(c) && !ParentGrace.isOpen())
                if (!pin && !grants) answer(Answer.YES) else { hide(); put() } // the PIN, or what it may use: the card
            }.also { it.filterTouchesWhenObscured = true; byHand = dev.openhouse.ui.PersonCards.yesOnlyByHand(it) })
            val wrap = android.widget.FrameLayout(c).apply { setPadding(0, K.px(c, 12), 0, 0); addView(bar) }
            if (runCatching { host.bar!!(wrap) }.onFailure { Log.w(TAG, "couldn't show the bar: $it") }.isFailure) put()
            else { shown = wrap; Log.i(TAG, "to try: $title") }
            // The app itself, in front (it opened as it was made; again here when it was asked for from Home or by Opie).
            MainActivity.live?.let { a -> if (runCatching { dev.openhouse.ui.Openhouse.openAppId }.getOrNull() != tryApp) a.openApp(tryApp!!) }
        }
        main.post { if (trying) putBar() else put() }
        try { // no answer in [timeoutMs] of the card being up (time choosing a PIN doesn't count, up to 10 minutes of it)
            var up = 0L; var aside = 0L
            var seen = false; var away = 0 // (trying: the app has been in front; leaving it, for 2 s, is no answer: it waits on Home)
            while (!done.await(500, TimeUnit.MILLISECONDS)) {
                if (choosing.get()) aside += 500 else up += 500
                if (up >= timeoutMs || aside >= 600_000) break
                if (trying && barUp.get()) {
                    val front = runCatching { dev.openhouse.ui.Openhouse.openAppId }.getOrNull()
                    if (front == tryApp) { seen = true; away = 0 } else if (seen && ++away >= 4) { Log.i(TAG, "left $tryApp without choosing"); break }
                }
            }
        } finally {
            main.post { hide() }
            dev.openhouse.ui.PersonCards.close(asking)
        }
        Log.i(TAG, "approval \"$title\": ${when (said) { Answer.YES -> "yes"; Answer.NO -> "no"; Answer.NONE -> "no answer" }}")
        said
    }
}
