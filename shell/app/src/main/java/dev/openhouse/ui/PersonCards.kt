package dev.openhouse.ui

import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View

/**
 * The cards that wait for a person's own answer: the shell's "Is this OK?" card (DeviceAccess.approve), a device
 * asking to pair, a calendar or album link someone sent (CalmDialog.setForPerson). While one is up, Opie's screen
 * tools do nothing (DeviceServer), and the card's yes listens only to a finger on the glass ([yesOnlyByHand]).
 */
object PersonCards {
    private const val TAG = "PersonCards"
    private class Card(val title: String, val alive: () -> Boolean)
    private val up = LinkedHashMap<Any, Card>()

    /** A card came up; [close] it with what this returns. [alive] says it's still on screen (one that went away
     *  without closing, with its window, doesn't hold Opie up for good). */
    fun open(title: String, alive: () -> Boolean = { true }): Any = Any().also { synchronized(up) { up[it] = Card(title.take(120), alive) } }
    fun close(token: Any) { synchronized(up) { up.remove(token) } }
    /** The newest card still up (its title), or null. */
    fun showing(): String? = synchronized(up) {
        up.entries.removeAll { (_, c) -> !runCatching { c.alive() }.getOrDefault(false) }
        up.values.lastOrNull()?.title
    }

    /** MotionEvent.FLAG_IS_ACCESSIBILITY_EVENT (hidden in the SDK). Not a sign of who touched: while an accessibility
     *  service filters input (Opie's DeviceAccess does), Android 12 and later put it on every touch, a finger's too
     *  (seen on a Lenovo Tab One: its touchscreen, device 6, flags 0x800). */
    internal const val FLAG_IS_ACCESSIBILITY_EVENT = 0x800

    /**
     * A touch from a real input device: one that exists and isn't virtual. dispatchGesture (how DeviceAccess taps)
     * sends its events as device 0, which no touchscreen is; `adb shell input` is the virtual device; an accessibility
     * ACTION_CLICK sends no touch at all. ([flags] is kept for the log; see FLAG_IS_ACCESSIBILITY_EVENT.)
     */
    @Suppress("UNUSED_PARAMETER")
    internal fun realTouch(flags: Int, deviceId: Int, virtual: Boolean?): Boolean = deviceId > 0 && virtual == false

    fun realTouch(e: MotionEvent): Boolean = realTouch(e.flags, e.deviceId, InputDevice.getDevice(e.deviceId)?.isVirtual)

    /**
     * Watches [v]'s touches; what it returns says whether the click happening now came from a real finger (down and
     * up on [v] from a real device, just now). A click with no touch behind it (an accessibility click, a key) is no.
     */
    fun yesOnlyByHand(v: View): () -> Boolean {
        var down = false
        var upAt = 0L
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { down = realTouch(e); if (!down) Log.i(TAG, "not a person's touch: device ${e.deviceId}, flags ${e.flags}") }
                MotionEvent.ACTION_UP -> { if (down && realTouch(e)) upAt = SystemClock.uptimeMillis(); down = false }
                MotionEvent.ACTION_CANCEL -> down = false
            }
            false
        }
        return { (upAt != 0L && SystemClock.uptimeMillis() - upAt < 1000).also { upAt = 0L } }
    }
}
