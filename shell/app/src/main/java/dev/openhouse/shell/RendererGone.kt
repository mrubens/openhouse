package dev.openhouse.shell

import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView

/**
 * A web view's page renderer went (out of memory, or it crashed). All of this app's web views share one renderer, so
 * every one of them hears it, and any that doesn't answer `true` takes the whole app down with it: the shell, the
 * bridge it runs and the microphone. So each web view here answers it: the view is dropped (it can't be used again)
 * and its owner makes a new one, or closes it if it was a passing thing (a video, the live voice).
 */
internal object RendererGone {
    /** Log it, take [w] out of its parent and destroy it. The caller makes a new one, if it wants one. */
    fun drop(tag: String, what: String, w: WebView, d: RenderProcessGoneDetail?) {
        Log.e(tag, "$what: the page's renderer went (${if (d?.didCrash() == true) "crashed" else "stopped by the system, likely for memory"}, priority ${d?.rendererPriorityAtExit()})")
        runCatching { (w.parent as? android.view.ViewGroup)?.removeView(w) }
        runCatching { w.destroy() }
    }
}

/**
 * How long to wait before bringing a page back after its renderer went: at once the first time, then longer each time
 * it goes again less than [quietMs] after the last time, up to the last step (kept there while it keeps going). A page
 * that keeps taking its renderer down (a leak, a page too big for the tablet) is then brought back every few minutes
 * rather than in a tight loop; after [quietMs] without one, it starts over. Pure, for the unit test.
 */
internal class RenderBackoff(
    private val quietMs: Long = 10 * 60_000L,
    private val steps: LongArray = longArrayOf(0L, 2_000L, 10_000L, 60_000L, 5 * 60_000L),
) {
    private var count = 0
    private var last = Long.MIN_VALUE

    /** It went now: the delay before making the page again. */
    @Synchronized fun next(now: Long): Long {
        count = if (last != Long.MIN_VALUE && now - last < quietMs) count + 1 else 0
        last = now
        return steps[minOf(count, steps.lastIndex)]
    }
}
