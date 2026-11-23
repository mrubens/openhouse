package dev.openhouse.shell

import android.accessibilityservice.AccessibilityService
import android.animation.ValueAnimator
import android.graphics.PixelFormat
import android.graphics.PointF
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.runtime.rememberUpdatedState
import kotlin.math.abs
import androidx.compose.ui.unit.dp
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import dev.openhouse.ui.Answers
import dev.openhouse.ui.LocalU
import dev.openhouse.ui.Oh
import dev.openhouse.ui.Openhouse
import dev.openhouse.ui.Segment
import dev.openhouse.ui.ohText
import dev.openhouse.ui.u
import kotlin.math.PI
import kotlin.math.sin

/**
 * The assistant, floating over everything when another app is on screen (the Play Store, Settings...):
 * a little round face plus a speech bubble. You can always see whether it is asleep, listening,
 * hearing you, or working (and where: it glides over to the button it is about to tap).
 * Tap it to start or stop listening; long-press to go back to the family display.
 *
 * Part of the fixed shell. It lives in the device-control accessibility service's overlay window,
 * so it sits above other apps without an extra permission. The home board has its own microphone.
 */
object Buddy {
    /** What device control is doing right now ("Tapping “Install”"), in which app, and since when. */
    var step by mutableStateOf<String?>(null); private set
    var app by mutableStateOf<String?>(null); private set
    var stepAt by mutableStateOf(0L); private set
    /** Layout, set by the window as it moves: bubble to the right of the face, and top-anchored. */
    internal var bubbleRight by mutableStateOf(true) // home is bottom-left, so its words go to its right
    internal var top by mutableStateOf(false)
    /** In its corner (not beside something it's tapping): there it's the same horizontal pill as on the home screen, at the bottom centre. */
    internal var atHome by mutableStateOf(true)
    /** Where its eyes look: -1..1 each way (towards what it is about to tap). */
    internal var lookX by mutableStateOf(0f)
    internal var lookY by mutableStateOf(0f)

    private val main = Handler(Looper.getMainLooper())
    internal var window: BuddyWindow? = null

    /** The family display is on screen (it has its own microphone button): the float hides. */
    @Volatile var shellOnTop = true; private set
    /** The update cover is up (the display is about to be replaced): no face over it. */
    @Volatile var covering = false
    /** Listening, working or answering right now: it slides out from the edge (otherwise only a sliver shows over apps). */
    @Volatile var awake = false

    // Decided from the window actually in front (device control sees it), else from how many of the
    // shell's activities are started. Not from the last onStart/onStop: a second copy of the activity
    // (a Home intent) or a recreated one stops the old copy after the new one started.
    private var started = 0
    fun activityStarted() { started++; recheck() }
    fun activityStopped() { started = maxOf(0, started - 1); recheck() }
    fun recheck() = main.post {
        val acc = DeviceAccess.instance
        val front = acc?.foregroundPackage()?.takeIf { it != "com.android.systemui" }
        shellOnTop = if (front != null) front == acc.packageName else started > 0
        window?.refresh()
    }

    /** Device control is doing [text] (null: done), optionally at a point on the screen. */
    fun act(text: String?, app: String? = null, at: PointF? = null) = main.post {
        step = text; this.app = app; stepAt = System.currentTimeMillis()
        window?.moveTo(at)
    }

    /** Hidden while a screenshot for the agent is taken (so it doesn't cover what it's looking at). */
    fun hideForShot(hide: Boolean) = main.post { window?.view?.visibility = if (hide) View.INVISIBLE else View.VISIBLE }
}

/** Compose needs a lifecycle; a window owned by a service has none, so give it one that is always resumed. */
private class AlwaysOn : LifecycleOwner, SavedStateRegistryOwner {
    private val reg = LifecycleRegistry(this)
    private val saved = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = reg
    override val savedStateRegistry: SavedStateRegistry get() = saved.savedStateRegistry
    init { saved.performRestore(null); reg.currentState = Lifecycle.State.RESUMED }
}

internal class BuddyWindow(private val svc: AccessibilityService) {
    private val wm = svc.getSystemService(WindowManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val owner = AlwaysOn()
    val view = ComposeView(svc).apply {
        setViewTreeLifecycleOwner(owner); setViewTreeSavedStateRegistryOwner(owner)
        setContent { BuddyView() }
    }
    private val lp = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    )
    private var added = false
    private var cx = -1f; private var cy = -1f // the face's centre on screen
    private var anim: ValueAnimator? = null
    private val goHome = Runnable { moveTo(null) }

    /** What people say (or type) as they say it, centered along the bottom, apart from the note and its words. */
    private val words = ComposeView(svc).apply {
        setViewTreeLifecycleOwner(owner); setViewTreeSavedStateRegistryOwner(owner)
        setContent { WordsCaption() }
    }
    private val wordsLp = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.BOTTOM or Gravity.START; x = 40; y = 80 }
    private var wordsAdded = false


    fun close() { if (Buddy.window === this) Buddy.window = null; anim?.cancel(); if (added) runCatching { wm.removeView(view) }; added = false; if (wordsAdded) runCatching { wm.removeView(words) }; wordsAdded = false }

    fun refresh() {
        val want = !Buddy.shellOnTop && !Buddy.covering
        if (want && !added) {
            if (cx < 0) home().let { (x, y) -> cx = x; cy = y }
            layout(); runCatching { wm.addView(view, lp); added = true }
        } else if (!want && added) { runCatching { wm.removeView(view) }; added = false }
        if (want && !wordsAdded) { wordsLp.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; wordsLp.x = 0; wordsLp.y = (20 * unit()).toInt(); runCatching { wm.addView(words, wordsLp); wordsAdded = true } } // their words: along the bottom, centred
        else if (!want && wordsAdded) { runCatching { wm.removeView(words) }; wordsAdded = false }
    }

    private fun screen() = wm.currentWindowMetrics.bounds
    private fun unit() = screen().width() / 1536f // px per u (see Theme.kt)
    private fun face() = 92 * unit()
    private fun faceW() = (if (Buddy.atHome) 172 else 92) * unit() // the pill in its corner, the round button beside a tap
    private fun faceH() = (if (Buddy.atHome) 76 else 92) * unit()
    private fun pad() = 16 * unit()
    private fun home(): Pair<Float, Float> { // bottom centre, clear of the navigation bar, where the home screen has it
        val b = screen(); val m = 48 * unit() // the pill's centre: 10u from the bottom to its 76u height
        val bars = wm.currentWindowMetrics.windowInsets.getInsets(android.view.WindowInsets.Type.systemBars())
        return b.width() / 2f to b.height() - bars.bottom - m
    }
    /** No button at rest: invisible and not in the way of taps. (Moving it off the edge didn't work: Android keeps an
     *  overlay window on the screen, so it sat in the corner over every app.) */
    private var hidden = false
    private fun hide(h: Boolean) {
        if (h == hidden) return
        hidden = h
        view.animate().cancel(); view.animate().alpha(if (h) 0f else 1f).setDuration(220).start()
        lp.flags = if (h) lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        if (added) runCatching { wm.updateViewLayout(view, lp) }
    }

    /** Glide next to [at] (beside it, never on it: it must not cover what it's tapping), or back to the corner. */
    fun moveTo(at: PointF?) {
        main.removeCallbacks(goHome)
        val b = screen(); val d = face() * 0.85f
        Buddy.atHome = at == null
        hide(at == null && !Buddy.awake)
        val (tx, ty) = if (at == null) home() else {
            val right = at.x < b.width() * 0.55f // target on the left: face to its right, bubble further right
            val below = at.y < b.height() * 0.7f
            Buddy.bubbleRight = right; Buddy.top = below
            Buddy.lookX = if (right) -1f else 1f; Buddy.lookY = if (below) -1f else 1f
            (if (right) at.x + d else at.x - d).coerceIn(face(), b.width() - face()) to (if (below) at.y + d else at.y - d).coerceIn(face(), b.height() - face())
        }
        if (at == null) { Buddy.bubbleRight = true; Buddy.top = false; Buddy.lookX = 0f; Buddy.lookY = 0f } // home is bottom-left: words to its right
        else main.postDelayed(goHome, 4000) // nothing for a while: back to the corner
        anim?.cancel()
        val fx = cx; val fy = cy
        anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = if (fx < 0) 0 else 420; interpolator = DecelerateInterpolator(1.6f)
            addUpdateListener { v -> val f = v.animatedValue as Float; cx = fx + (tx - fx) * f; cy = fy + (ty - fy) * f; layout() }
            start()
        }
    }

    /** An explicit width: for a WRAP_CONTENT window Android first tries a narrow dialog width, which squeezed the face. */
    fun setWide(wide: Boolean) {
        main.removeCallbacks(narrow)
        if (wide) { bubbleOn = true; layout() } else main.postDelayed(narrow, 300) // after the fade
    }
    private var bubbleOn = false
    private val narrow = Runnable { bubbleOn = false; layout() }

    // Last, after every field of the window: Kotlin runs initializers in order, and refresh() uses the words window
    // (made while another app is in front, as when the accessibility service reconnects after an install, it crashed).
    init { Buddy.window = this; refresh() }

    private fun layout() {
        lp.width = (32 * unit() + faceW() + (if (bubbleOn) (14 + BUBBLE_U) * unit() else 0f)).toInt() // the face, and the bubble beside it while it shows
        val b = screen(); val halfX = faceW() / 2 + pad(); val halfY = faceH() / 2 + pad()
        lp.gravity = (if (Buddy.top) Gravity.TOP else Gravity.BOTTOM) or (if (Buddy.bubbleRight) Gravity.START else Gravity.END)
        lp.x = (if (Buddy.bubbleRight) cx - halfX else b.width() - cx - halfX).toInt()
        lp.y = (if (Buddy.top) cy - halfY else b.height() - cy - halfY).toInt()
        if (added) runCatching { wm.updateViewLayout(view, lp) }
    }
}

private const val BUBBLE_U = 620

/** Over other apps: what they're saying or typing, in a bubble at the left edge, the mirror of the note's. */
@Composable
private fun WordsCaption() {
    val o = Openhouse
    val now = o.now
    val text = o.draft.takeIf { o.typing != null }?.let { it + "▏" }
        ?: o.partial?.takeIf { it.isNotBlank() }
        ?: o.heard?.takeIf { now - it.at < 2500 && !it.text.startsWith("Got it") && it.text != "…" }?.text
    if (text != null) Box(Modifier.padding(14.u)) { dev.openhouse.ui.TheirWords(text) } // along the bottom, centred: apart from the assistant's words
}

private enum class Mood { Asleep, Typing, Listening, Hearing, Talking, Thinking, Working, Replied }

@Composable
private fun BuddyView() {
    val u = LocalConfiguration.current.screenWidthDp / 1536f
    CompositionLocalProvider(LocalU provides u) {
        val now by produceState(System.currentTimeMillis()) { while (true) { value = System.currentTimeMillis(); kotlinx.coroutines.delay(200) } }
        val o = Openhouse
        val a = o.answer
        val handsFree = o.handsFreeUntil > now
        val armed = o.awaitingUntil > now || handsFree
        val live = a?.live == true
        val step = Buddy.step?.takeIf { now - Buddy.stepAt < (if (live) 6000 else 8000) } // a stopped task clears at once (between steps a typed turn waits on its model a few seconds)
        val reply = a?.takeIf { !it.live && now - it.at < 20_000 && it.at > o.quietAt }
        val hearing = isHearing(now)
        val ended = !armed && o.handsFreeUntil > 0 && now - o.handsFreeUntil in 0..5000 && now - o.quietAt > 5000 // not when tapped quiet
        val mood = moodAt(now)
        val awake = mood != Mood.Asleep
        val engaged = assistantEngaged(now)
        LaunchedEffect(engaged) { Buddy.awake = engaged; Buddy.window?.moveTo(null) } // slide out to talk, back in after
        // The bubble: what it hears, what it's doing, what it said, and whether it's still listening.
        var label: String? = null; var main: String? = null; var foot: String? = null; var left = 0f; var stop = false
        // Only real words: what they typed or said, what it's doing (its own words), what it answered. The face shows the rest.
        if (o.showJobs && (o.inFlight.isNotEmpty() || o.build?.done == false)) { // tapped while it works: what's in flight
            main = (o.inFlight.map { j -> "“${tail(j.question, 50)}” ${j.status}".trim() } + listOfNotNull(o.build?.takeIf { !it.done }?.let { "“${tail(it.request, 50)}”" })).joinToString("\n")
            LaunchedEffect(Unit) { kotlinx.coroutines.delay(6000); o.showJobs = false }
        }
        else if (o.typing != null) {} // what they type shows in their own bubble at the left (WordsCaption), never here too
        else if (LiveVoice.problemNow(now) != null) { // the live voice couldn't say it: the answer, and why it wasn't heard
            main = listOfNotNull(LiveVoice.problemNow(now), reply?.text?.let { prose(it) }?.takeIf { it.isNotBlank() }).joinToString("\n\n")
        }
        else if (LiveVoice.mood != null) { // a live session: what it says, as it says it (its own transcript)
            if (mood == Mood.Talking || mood == Mood.Listening) main = LiveVoice.caption.takeIf { it.isNotBlank() }?.let { prose(it) }
        }
        else when (mood) {
            Mood.Hearing -> {} // what they're saying shows centered at the bottom (WordsWindow), not out of the note
            // Only words: what it says as it comes, or (using an app for them) what it's doing there, with Stop. No
            // "thinking" text: the face shows that.
            Mood.Working, Mood.Thinking -> if (step != null || live) {
                main = a?.text?.takeIf { it.isNotBlank() }?.let { prose(it) } ?: step
                stop = main != null
            }
            Mood.Listening -> {
                if (reply != null) main = prose(reply.text)
                if (handsFree && main != null) left = ((o.handsFreeUntil - now) / 8_000f).coerceIn(0f, 1f)
            }
            Mood.Replied -> main = prose(reply!!.text)
            Mood.Talking -> main = a?.let { prose(it.text) }?.takeIf { it.isNotBlank() }
            Mood.Asleep, Mood.Typing -> {}
        }
        Row(
            Modifier.padding(16.u),
            verticalAlignment = if (Buddy.top) Alignment.Top else Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(14.u),
        ) {
            val shown = main != null
            LaunchedEffect(shown) { Buddy.window?.setWide(shown) }
            val bubble: @Composable () -> Unit = {
                AnimatedVisibility(shown, enter = fadeIn(), exit = fadeOut()) {
                    Bubble(label, main ?: "", foot, left, armed || hearing, stop)
                }
            }
            if (!Buddy.bubbleRight) bubble()
            Face(mood, now, onLongPress = { KioskApps.goHome() }, wide = Buddy.atHome) // a tap talks
            if (Buddy.bubbleRight) bubble()
        }
    }
}

private fun isHearing(now: Long) = !Openhouse.partial.isNullOrBlank() || (Openhouse.hearingAt > 0 && now - Openhouse.hearingAt < 2500)

/** Listening, working or answering right now (it slides out from tucked to show it). */
fun assistantAwake(now: Long = System.currentTimeMillis()) = moodAt(now) != Mood.Asleep
/** In a conversation (listening, hearing, answering, using an app for someone), not just making an app in the background:
 *  only then does it slide out from the edge. A build only shows as the spinner on the note. */
fun assistantEngaged(now: Long = System.currentTimeMillis()): Boolean {
    val m = moodAt(now)
    // At rest it's not shown at all (no button at rest): typing has its own box, and a finished answer its bubble.
    if (m == Mood.Asleep || m == Mood.Typing || m == Mood.Replied) return false
    if (m == Mood.Thinking || m == Mood.Talking) return true
    if (m == Mood.Working) { val live = Openhouse.answer?.live == true; val step = Buddy.step?.takeIf { now - Buddy.stepAt < (if (live) 6000 else 2000) }; return live || step != null }
    return true
}

/** What the assistant is doing now, the same everywhere it's drawn (over apps, and on the display). */
private fun moodAt(now: Long): Mood {
    val o = Openhouse; val a = o.answer
    val armed = o.awaitingUntil > now || o.handsFreeUntil > now
    val live = a?.live == true
    val step = Buddy.step?.takeIf { now - Buddy.stepAt < (if (live) 6000 else 2000) }
    // OpenAI's live voice has the conversation: its own events say what it's doing (LiveVoice.mood), not the tablet's
    // listening and speaking, which are paused meanwhile.
    when (LiveVoice.mood) {
        "hearing" -> return Mood.Hearing
        "thinking" -> return Mood.Thinking
        "talking" -> return Mood.Talking
        "listening" -> return Mood.Listening
    }
    return when {
        o.typing != null && !o.dictating -> Mood.Typing // typing to it: not listening (the box's own mic, dictating, is)
        o.typing != null -> Mood.Listening // dictating into the typing box: the microphone is open
        isHearing(now) -> Mood.Hearing
        o.speaking -> Mood.Talking // saying something out loud
        live && step == null && a.text.isBlank() -> Mood.Thinking // asked, and it hasn't said or done anything yet
        o.showConversation && o.conversation?.turns?.lastOrNull()?.live == true -> Mood.Thinking // the same in the conversation screen
        step != null || live || o.build?.done == false -> Mood.Working // answering, using an app, or making something
        armed -> Mood.Listening
        a != null && !a.live && now - a.at < 20_000 && a.at > o.quietAt -> Mood.Replied
        else -> Mood.Asleep
    }
}

/**
 * The assistant's button: one face, the same on the family display and floating over other apps.
 * Tap to talk; long-press does [onLongPress] (over apps: go home; on the display: type instead).
 */
@Composable
fun AssistantFace(onLongPress: () -> Unit, onTap: (() -> Unit)? = null, onSwipe: ((Float) -> Unit)? = null, wide: Boolean = false) {
    val now by produceState(System.currentTimeMillis()) { while (true) { value = System.currentTimeMillis(); kotlinx.coroutines.delay(200) } }
    Face(moodAt(now), now, onLongPress, onTap, onSwipe, wide)
}

private fun tail(t: String, max: Int = 110): String {
    if (t.length <= max) return t
    val cut = t.length - max
    val sp = t.indexOf(' ', cut).takeIf { it in cut..(cut + 20) } ?: cut
    return "…" + t.substring(sp).trimStart()
}

private fun prose(t: String): String {
    val p = Answers.speakable(Answers.segments(t).filterIsInstance<Segment.Prose>().joinToString(" ") { it.text }).ifEmpty { "Done." }
    return if (p.length <= 160) p else p.take(157).substringBeforeLast(' ') + "…"
}

@Composable
private fun Bubble(label: String?, text: String, foot: String?, left: Float, listening: Boolean, stop: Boolean) {
    val shape = dev.openhouse.ui.AssistantCardShape
    Column(
        Modifier.width(BUBBLE_U.u).shadow(18.u, shape).clip(shape).background(Color.White).padding(horizontal = 26.u, vertical = 18.u),
        verticalArrangement = Arrangement.spacedBy(6.u),
    ) {
        if (label != null) Text(label, style = ohText(16, color = Oh.muted), maxLines = 1)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.u)) {
            Text(text, style = dev.openhouse.ui.quietText(20), maxLines = 3, modifier = Modifier.weight(1f, fill = false))
            if (stop) dev.openhouse.ui.StopButton(40) { DeviceServer.stop("Someone pressed Stop on the screen."); Openhouse.stopAnswer() }
        }
        if (foot != null) {
            Text(foot, style = ohText(16, color = if (listening) Oh.accent else Oh.muted), maxLines = 1)
            if (left > 0f) Box(Modifier.fillMaxWidth().height(4.u).clip(RoundedCornerShape(2.u)).background(Oh.line)) {
                Box(Modifier.fillMaxWidth(left).fillMaxHeight().background(Oh.accent))
            }
        }
    }
}

/** The assistant's button: a round voice control with bars in it. Asleep: a soft button, the bars flat and still (so it
 *  costs nothing while it waits, which is nearly all day). Listening: dark, the bars breathing low. Hearing: the bars
 *  move. Talking: the accent color, the bars moving with its voice. Thinking or working: a slow wave across the bars.
 *  Replied: the bars at rest in the accent color. */
@Composable
private fun Face(mood: Mood, now: Long, onLongPress: () -> Unit, onTap: (() -> Unit)? = null, onSwipe: ((Float) -> Unit)? = null, wide: Boolean = false) {
    // One indicator, three states: listening (dark, the bars follow the room), thinking (dark, a slow wave), talking (the
    // accent color, the bars move with its voice); otherwise at rest. Hearing is listening, working is thinking, and a
    // finished answer is rest (it used to have a look of its own).
    @Suppress("NAME_SHADOWING") val mood = when (mood) { Mood.Typing, Mood.Replied -> Mood.Asleep; Mood.Hearing -> Mood.Listening; Mood.Working -> Mood.Thinking; else -> mood }
    val awake = mood != Mood.Asleep
    // Only awake does anything animate every frame; asleep follows `now` (five ticks a second) and stays still.
    val phase: State<Float>? = if (awake) rememberInfiniteTransition(label = "bars").animateFloat(0f, 1f, infiniteRepeatable(tween(2400, easing = LinearEasing), RepeatMode.Restart), label = "p") else null
    val ink = Color(0xFF2A2826); val accent = Color(0xFFB5562F); val soft = Color(0xFFE4DED3)
    val bg by animateColorAsState(when (mood) { Mood.Asleep, Mood.Typing, Mood.Replied -> soft; Mood.Talking -> accent; else -> ink }, tween(220), label = "bg")
    val barColor by animateColorAsState(when (mood) { Mood.Asleep, Mood.Typing -> Color(0xFF5F584F).copy(alpha = .7f); Mood.Replied -> accent; else -> Color(0xFFFBF9F5) }, tween(220), label = "bar")
    val tapState = rememberUpdatedState(Triple(onTap, onSwipe, onLongPress))
    val level = remember { floatArrayOf(0f, 0f) }
    // wide: a horizontal pill at the bottom centre of the home screen (the user: "a more horizontal thing"); otherwise the
    // round button (over apps, where it moves beside what it taps).
    val shape = if (wide) RoundedCornerShape(26.u) else CircleShape
    Box(if (wide) Modifier.size(172.u, 76.u) else Modifier.size(92.u), contentAlignment = Alignment.Center) {
        // Connected to OpenAI's live voice: a thin ring around the button, so it's plain the line is open; while it thinks
        // (or is still connecting), an arc runs round the ring. (The user: "it's not clear that it's connected and thinking".)
        val live = LiveVoice.active; val ringW = 3.u; val ringR = 32.u
        if (wide && (live || mood == Mood.Thinking)) Canvas(Modifier.size(158.u, 64.u)) {
            // the pill's outline: steady while connected, breathing while it thinks
            val w = ringW.toPx(); val r = ringR.toPx()
            val p = phase?.value ?: 0f
            val thinking = mood == Mood.Thinking || (live && LiveVoice.mood == null)
            val a = if (thinking) 0.35f + 0.65f * ((sin(p * 4f * 2 * PI).toFloat() + 1f) / 2f) else .28f
            drawRoundRect(accent.copy(alpha = a), Offset(w / 2, w / 2), Size(size.width - w, size.height - w), androidx.compose.ui.geometry.CornerRadius(r), style = Stroke(w))
        }
        if (!wide && (live || mood == Mood.Thinking)) Canvas(Modifier.size(74.u)) {
            val w = ringW.toPx(); val r = size.minDimension / 2 - w
            val tl = Offset(size.width / 2 - r, size.height / 2 - r); val sz = Size(r * 2, r * 2)
            if (live) drawArc(accent.copy(alpha = .28f), 0f, 360f, false, tl, sz, style = Stroke(w))
            if (mood == Mood.Thinking || (live && LiveVoice.mood == null)) {
                val p = phase?.value ?: 0f
                drawArc(accent, p * 720f - 90f, 100f, false, tl, sz, style = Stroke(w, cap = StrokeCap.Round))
            }
        }
        Box(
            (if (wide) Modifier.size(144.u, 52.u) else Modifier.size(58.u)).shadow(if (Openhouse.appOpen) 6.u else 0.u, shape).clip(shape).background(bg)
                .pointerInput(Unit) { // one detector: tap, long press, or a sideways flick (two detectors fought over it)
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var dx = 0f; var dy = 0f; var long = false; var up = false
                        val slop = viewConfiguration.touchSlop
                        withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            while (true) {
                                val e = awaitPointerEvent(); val c = e.changes.firstOrNull { it.id == down.id } ?: break
                                dx += c.positionChange().x; dy += c.positionChange().y
                                if (abs(dx) > slop || abs(dy) > slop) c.consume()
                                if (!c.pressed) { up = true; break }
                            }
                        } ?: run { if (abs(dx) < slop && abs(dy) < slop) { long = true; tapState.value.third() } }
                        if (!up && !long) while (true) { // still down after the timeout: a slow drag
                            val e = awaitPointerEvent(); val c = e.changes.firstOrNull { it.id == down.id } ?: break
                            dx += c.positionChange().x; dy += c.positionChange().y; c.consume()
                            if (!c.pressed) { up = true; break }
                        }
                        if (long || !up) return@awaitEachGesture
                        val swipe = tapState.value.second
                        when {
                            swipe != null && abs(dx) > 28.dp.toPx() && abs(dx) > abs(dy) -> swipe(dx)
                            abs(dx) < slop * 2 && abs(dy) < slop * 2 -> (tapState.value.first ?: { Openhouse.tapToTalk() })()
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Canvas(if (wide) Modifier.size(92.u, 26.u) else Modifier.size(30.u, 28.u)) {
                val n = if (mood == Mood.Asleep || mood == Mood.Typing || mood == Mood.Replied) 4 else if (wide) 9 else 5
                val bw = if (wide) size.width * 0.06f else size.width * 0.13f; val gap = (size.width - n * bw) / (n - 1)
                val arc = { i: Int -> 0.5f + 0.5f * sin(PI * (i + 0.5) / n).toFloat() } // taller in the middle
                val p = phase?.value ?: 0f
                // Listening or hearing: the bars follow the microphone, a little smoothed (quick up, slower down).
                val target = if (mood == Mood.Listening || mood == Mood.Hearing) dev.openhouse.ui.MicLevel.shown() else 0f
                level[0] += (target - level[0]) * (if (target > level[0]) 0.5f else 0.15f)
                // Talking: its own voice as the page measures it (OpenAI's live voice); without that, the bars' own rhythm.
                val outNow = if (mood == Mood.Talking) dev.openhouse.ui.OutLevel.shown() else -1f
                if (outNow >= 0f) level[1] += (outNow - level[1]) * (if (outNow > level[1]) 0.6f else 0.2f)
                for (i in 0 until n) {
                    val h = when (mood) {
                        Mood.Asleep, Mood.Typing, Mood.Replied -> floatArrayOf(0.3f, 0.6f, 0.8f, 0.45f)[i % 4] * 0.6f // at rest, but still audio
                        Mood.Listening, Mood.Hearing -> { // the room's level, shaped across the bars, each a little alive
                            val shape = if (n == 5) floatArrayOf(0.55f, 0.85f, 1f, 0.8f, 0.6f)[i] else arc(i)
                            val wobble = 0.85f + 0.15f * sin((p * 6f + i * 0.37f) * 2 * PI).toFloat()
                            0.18f + 0.82f * level[0] * shape * wobble
                        }
                        Mood.Talking -> if (outNow >= 0f) { // its own voice, measured: shaped across the bars, each a little alive
                            val shape = if (n == 5) floatArrayOf(0.6f, 0.9f, 1f, 0.85f, 0.65f)[i] else arc(i)
                            val wobble = 0.8f + 0.2f * sin((p * 7f + i * 0.41f) * 2 * PI).toFloat()
                            0.2f + 0.8f * level[1] * shape * wobble
                        } else { // its own voice: lively, each bar at its own pace
                            val k = floatArrayOf(5f, 7f, 6f, 8f, 4.5f)[i % 5]
                            0.35f + 0.6f * abs(sin((p * k + i * 0.37f) * 2 * PI).toFloat())
                        }
                        else -> 0.25f + 0.75f * ((sin((p * 2.5f - i * 0.22f) * 2 * PI).toFloat() + 1f) / 2f) // thinking, working: a wave across the bars
                    }.coerceIn(0.15f, 1f) * size.height
                    val x = i * (bw + gap)
                    drawRoundRect(barColor, Offset(x, (size.height - h) / 2), Size(bw, h), androidx.compose.ui.geometry.CornerRadius(bw / 2))
                }
            }
        }
        // (No dot at its shoulder for what's in flight: it read as a notification. The moving bars already say it's working.)
    }
}
