package dev.openhouse.shell

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.LinearLayout
import android.widget.TextView
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Lets the agent see and operate other apps (M3 stretch), through tools served by [DeviceServer].
 * Part of the fixed shell: the agent can ask for actions, but the checks and the approval card
 * live here, where it can't edit them.
 *
 * It also owns a small system overlay (an accessibility overlay window, so no extra permission):
 *  - the floating assistant over other apps ([Buddy]: listening, what it hears, "Tapping Start", Stop)
 *  - the approval card for risky taps (Send, Pay, Delete...), answered by a person on the screen.
 */
/** Keys that mean "assistant" (the keyboard cover's AI key and the like). */
val AI_KEYS = setOf(1104 /* Samsung keyboard cover AI key */, android.view.KeyEvent.KEYCODE_ASSIST, android.view.KeyEvent.KEYCODE_VOICE_ASSIST, android.view.KeyEvent.KEYCODE_SEARCH)

class DeviceAccess : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private val wm by lazy { getSystemService(WindowManager::class.java) }
    private var buddy: BuddyWindow? = null

    override fun onServiceConnected() {
        instance = this
        DeviceServer.start(applicationContext)
        buddy = BuddyWindow(this); Buddy.recheck()
        Log.i(TAG, "device control on")
    }

    override fun onAccessibilityEvent(e: AccessibilityEvent?) {
        // The app in front changed: the floating assistant shows over other apps, not over the display.
        if (e?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || e?.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) { Buddy.recheck(); VideoFloat.check() }
    }
    override fun onInterrupt() {}

    /** The keyboard's AI / assistant key, anywhere: the assistant comes out and listens; pressed while it's open, it goes. */
    override fun onKeyEvent(e: android.view.KeyEvent): Boolean {
        // Over another app: typing to the assistant (after a tap or the AI key, or with its box open) goes to it.
        if (e.keyCode !in AI_KEYS && !Buddy.shellOnTop && dev.openhouse.ui.Openhouse.typeKey(e)) return true
        if (e.keyCode !in AI_KEYS) { if (e.action == android.view.KeyEvent.ACTION_DOWN && !e.isPrintingKey) Log.d(TAG, "key ${e.keyCode} ${android.view.KeyEvent.keyCodeToString(e.keyCode)} scan ${e.scanCode}"); return false }
        if (e.action == android.view.KeyEvent.ACTION_UP) main.post { dev.openhouse.ui.Openhouse.aiKey() }
        return true
    }
    override fun onDestroy() { buddy?.close(); if (instance === this) instance = null; super.onDestroy() }

    // --- web pages ---------------------------------------------------------------
    // Chromium (Opie's tabs and apps are web pages) builds its pages' accessibility only for a service that asks for
    // more than window changes. Asked for while Opie is using the screen, and back to window changes two minutes after,
    // so other apps aren't sending every event here the rest of the time.
    private val narrow = Runnable { setWide(false) }
    @Volatile private var wide = false
    private fun setWide(on: Boolean) {
        if (wide == on) return
        runCatching { serviceInfo = serviceInfo.apply { eventTypes = if (on) AccessibilityEvent.TYPES_ALL_MASK else AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_WINDOWS_CHANGED } }
            .onSuccess { wide = on; Log.i(TAG, if (on) "reading web pages" else "back to window changes") }
    }
    /** Opie is using the screen: web pages readable now, and for two minutes after the last action. */
    fun usingScreen() {
        val was = wide
        main.post { setWide(true); main.removeCallbacks(narrow); main.postDelayed(narrow, 120_000) }
        if (was) return
        // Chromium builds the page's tree once it sees the change: wait (up to 4 s) until a web view on screen has some.
        val until = System.currentTimeMillis() + 4000
        do { Thread.sleep(300) } while (System.currentTimeMillis() < until && webEmpty())
    }
    /** A web view on screen with nothing in it yet. */
    private fun webEmpty(): Boolean = windows.any { w ->
        fun find(n: AccessibilityNodeInfo, d: Int): Boolean = (n.className?.toString()?.endsWith("WebView") == true && n.childCount == 0) ||
            (d < 6 && (0 until n.childCount).any { i -> n.getChild(i)?.let { find(it, d + 1) } == true })
        w.root?.let { find(it, 0) } == true
    }

    // --- reading the screen -------------------------------------------------
    /** Nodes from the last [describe], by the number shown to the agent. */
    private val nodes = HashMap<Int, AccessibilityNodeInfo>()

    fun foregroundPackage(): String? =
        windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isActive }?.root?.packageName?.toString()
            ?: rootInActiveWindow?.packageName?.toString()

    /** The visible screen as numbered lines the agent can refer to: `[7] Button "Start" (tap)`. */
    fun describe(): String {
        nodes.clear()
        val sb = StringBuilder()
        var n = 0
        val wins = windows.filter {
            it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && it.type != AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER
        }.sortedByDescending { it.layer }
        for (w in wins) {
            val root = w.root ?: continue
            val pkg = root.packageName?.toString() ?: ""
            // Opie's own screen (its tabs and apps are web pages, read like any app's, and Settings), except a PIN.
            if (hasPin(root)) { sb.append("(A PIN is being asked for: only the people here answer it, never Opie.)\n"); continue }
            if (w.type == AccessibilityWindowInfo.TYPE_SYSTEM && pkg == "com.android.systemui") continue
            // The on-screen keyboard: one line (its keys would fill the list; the type tool types without them).
            if (w.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) { sb.append("(The keyboard is showing: type text with the type tool, not its keys.)\n"); continue }
            sb.append("## ").append(if (pkg == packageName) "Opie's own screen (tabs and apps; show_on_screen changes the tab)" else appLabel(pkg)).append(" (").append(pkg).append(")")
            sb.append('\n')
            fun walk(node: AccessibilityNodeInfo, depth: Int) {
                if (!node.isVisibleToUser) return
                // (stateDescription: a dropdown's chosen option, a switch's on or off; roleDescription: what Chromium says it is)
                val role = runCatching { node.extras?.getCharSequence("AccessibilityNodeInfo.roleDescription")?.toString() }.getOrNull()?.takeIf { it.isNotBlank() }
                val label = listOfNotNull(node.text?.toString(), node.contentDescription?.toString(),
                    runCatching { node.stateDescription?.toString() }.getOrNull()?.takeIf { it.isNotBlank() }?.let { "now: $it" },
                    role?.let { "a $it" },
                    node.hintText?.toString()?.takeIf { it.isNotBlank() }?.let { "hint: $it" }).map { it.replace('\n', ' ').trim() }.filter { it.isNotEmpty() }.distinct()
                    .joinToString(" / ").take(120)
                val acts = buildList {
                    if (node.isClickable) add("tap")
                    if (node.isLongClickable) add("long-press")
                    if (node.isPassword) add("password: theirs to type") else if (node.isEditable) add("type")
                    if (node.isScrollable) add("scroll")
                    if (node.isCheckable) add(if (node.isChecked) "checked" else "unchecked")
                    if (node.isSelected) add("selected")
                    if (!node.isEnabled) add("disabled")
                }
                var d = depth
                if (label.isNotEmpty() || node.isClickable || node.isEditable || node.isScrollable) {
                    if (n >= 400) return
                    val id = ++n
                    nodes[id] = node
                    val cls = node.className?.toString()?.substringAfterLast('.') ?: "View"
                    val r = Rect().also { node.getBoundsInScreen(it) }
                    sb.append("  ".repeat(depth)).append('[').append(id).append("] ").append(cls)
                    if (label.isNotEmpty()) sb.append(" \"").append(label).append('"')
                    if (acts.isNotEmpty()) sb.append(" (").append(acts.joinToString(", ")).append(')')
                    sb.append(" @").append(r.centerX()).append(',').append(r.centerY()).append('\n')
                    d = depth + 1
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, d) }
            }
            val before = n
            walk(root, 1)
            // A window with nothing readable (a popup some apps draw themselves): said, so the next step knows it's there.
            if (n == before) sb.append("  (a ").append(windowKind(w.type)).append(" window with nothing readable in it)\n")
        }
        if (n >= 400) sb.append("(screen truncated)\n")
        return sb.toString().ifBlank { "(nothing readable on screen)" }
    }

    /** A PIN pad is on screen, in Opie or one of its apps' windows: only a person answers it. */
    fun pinShowing(): Boolean = windows.any { w -> w.root?.let { hasPin(it) } == true }
    private fun hasPin(root: AccessibilityNodeInfo) = runCatching { root.findAccessibilityNodeInfosByText(dev.openhouse.ui.PinPad.MARK).any { it.contentDescription?.toString() == dev.openhouse.ui.PinPad.MARK } }.getOrDefault(false)

    private fun windowKind(t: Int) = when (t) { AccessibilityWindowInfo.TYPE_APPLICATION -> "app"; AccessibilityWindowInfo.TYPE_SYSTEM -> "system"; else -> "type $t" }

    /** Every option-like line in windows that weren't there before [known] (a dropdown's popup): (node, its text). */
    fun newWindowTexts(known: Set<Int>): List<Pair<AccessibilityNodeInfo, String>> = buildList {
        for (w in windows) {
            if (w.id in known || w.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY || w.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue
            fun walk(n: AccessibilityNodeInfo, d: Int) {
                if (!n.isVisibleToUser || d > 12) return
                val t = (n.text ?: n.contentDescription)?.toString()?.trim().orEmpty()
                if (t.isNotEmpty()) add(n to t)
                for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, d + 1) }
            }
            w.root?.let { walk(it, 0) }
        }
    }
    fun windowIds(): Set<Int> = windows.map { it.id }.toSet()

    fun node(id: Int): AccessibilityNodeInfo? = nodes[id]?.takeIf { it.refresh() }

    /** Everything a person would read on or inside a node: used for the risk check and approvals. */
    fun words(node: AccessibilityNodeInfo, depth: Int = 0): String {
        val own = listOfNotNull(node.text, node.contentDescription).joinToString(" ")
        if (depth > 3) return own
        return (listOf(own) + (0 until node.childCount).mapNotNull { node.getChild(it)?.let { c -> words(c, depth + 1) } }).joinToString(" ")
    }

    /** Text in the editable fields on screen, e.g. the message about to be sent. */
    fun fieldText(): String = buildList {
        fun walk(n: AccessibilityNodeInfo) {
            if (n.isEditable && !n.text.isNullOrBlank() && n.text.toString() != n.hintText?.toString()) add(n.text.toString())
            for (i in 0 until n.childCount) n.getChild(i)?.let(::walk)
        }
        windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }.forEach { w -> w.root?.let(::walk) }
    }.joinToString(" / ").take(300)

    fun appLabel(pkg: String?): String = pkg?.let {
        runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(it, 0)).toString() }.getOrNull()
    } ?: pkg ?: "?"

    // --- acting -------------------------------------------------------------
    fun click(node: AccessibilityNodeInfo, long: Boolean = false): Boolean {
        val action = if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
        var n: AccessibilityNodeInfo? = node
        while (n != null) {
            if ((if (long) n.isLongClickable else n.isClickable) && n.performAction(action)) return true
            n = n.parent
        }
        val r = Rect().also { node.getBoundsInScreen(it) }
        return tap(r.exactCenterX(), r.exactCenterY(), if (long) 700 else 60)
    }

    fun tap(x: Float, y: Float, ms: Long = 60) = gesture(Path().apply { moveTo(x, y) }, ms)

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long = 350) =
        gesture(Path().apply { moveTo(x1, y1); lineTo(x2, y2) }, ms)

    private fun gesture(p: Path, ms: Long): Boolean {
        val done = CountDownLatch(1)
        var ok = false
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(p, 0, ms)).build()
        main.post {
            val sent = dispatchGesture(g, object : GestureResultCallback() {
                override fun onCompleted(d: GestureDescription?) { ok = true; done.countDown() }
                override fun onCancelled(d: GestureDescription?) { done.countDown() }
            }, null)
            if (!sent) done.countDown()
        }
        done.await(ms + 3000, TimeUnit.MILLISECONDS)
        return ok
    }

    /** A JPEG of the screen, half size by default (enough to read, cheap in tokens); [div] 4 for a smaller one. */
    fun screenshot(div: Int = 2, quality: Int = 70): String? {
        val done = CountDownLatch(1)
        var out: String? = null
        Buddy.hideForShot(true); Thread.sleep(120) // not in its own picture
        main.post {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(s: ScreenshotResult) {
                    runCatching {
                        val hw = Bitmap.wrapHardwareBuffer(s.hardwareBuffer, s.colorSpace)!!
                        val bmp = hw.copy(Bitmap.Config.ARGB_8888, false)
                        s.hardwareBuffer.close()
                        val d = div.coerceIn(1, 8)
                        val small = Bitmap.createScaledBitmap(bmp, bmp.width / d, bmp.height / d, true)
                        val bytes = ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 90), it) }.toByteArray()
                        out = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    }.onFailure { Log.w(TAG, "screenshot: $it") }
                    done.countDown()
                }
                override fun onFailure(code: Int) { Log.w(TAG, "screenshot failed $code"); done.countDown() }
            })
        }
        done.await(5, TimeUnit.SECONDS)
        Buddy.hideForShot(false)
        return out
    }

    // --- system overlay: status pill and approval card ----------------------
    private fun overlayParams(w: Int, h: Int, gravity: Int, focusable: Boolean) = WindowManager.LayoutParams(
        w, h, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        (if (focusable) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT).apply { this.gravity = gravity; y = 24 }

    private fun rounded(color: Int, r: Float) = GradientDrawable().apply { cornerRadius = r; setColor(color) }

    /** What it's doing ("Tapping “Install”"), shown by the floating assistant, which glides next to [at]. */
    fun status(text: String, at: android.graphics.PointF? = null) = Buddy.act(text, foregroundPackage()?.takeIf { it != packageName }?.let { appLabel(it) }, at)

    fun hideStatus() = Buddy.act(null)

    /** The approval card ([ApprovalCard]) as an accessibility overlay: over whatever app is in front. On the main thread. */
    internal fun showOverlay(v: View) { wm.addView(v, overlayParams(-1, -1, Gravity.CENTER, false).apply { y = 0 }) }
    internal fun hideOverlay(v: View) { runCatching { wm.removeView(v) } }
    /** A card's small bar (an app made here, to try: [ApprovalCard]), at the top over that app: taps elsewhere reach the app. */
    internal fun showBar(v: View) { wm.addView(v, overlayParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL, false)) }

    /** The "Is this OK?" card ([ApprovalCard.ask]), here over whatever app is in front. */
    fun approve(title: String, detail: String, timeoutMs: Long = 90_000, parent: Boolean = false, yes: String = "Allow",
                rights: List<Pair<String, String>> = emptyList(), more: String? = null, danger: Boolean = false): Boolean =
        ApprovalCard.ask(title, detail, timeoutMs, parent, yes, rights, more, danger)

    companion object {
        const val TAG = "Device"
        @Volatile var instance: DeviceAccess? = null
    }
}
