package dev.openhouse.shell

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Kitchen timers, kept by the shell so they keep running and ring whatever is on screen (the
 * conversation, an app, the home screen). The board draws them as dials on the home screen; over apps they're
 * pills along the bottom-left edge. Tap a ringing pill to stop it; tap its cross to cancel a running one.
 */
class Timers(private val activity: Activity, parent: FrameLayout) {
    private class T(val id: Int, val label: String, val total: Int, val endAt: Long, val pill: LinearLayout, val time: TextView) { var ringing = false }

    private val main = Handler(Looper.getMainLooper())
    private val timers = mutableListOf<T>()
    private var tone: Ringtone? = null
    private var nextId = 1
    private fun dp(v: Int) = (v * activity.resources.displayMetrics.density).toInt()

    val view = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }

    /** The bridge keeps the house's timers too (screens show them): told of each one started or stopped here. */
    var onStart: ((label: String, total: Int, endAt: Long) -> Unit)? = null
    var onStop: ((endAt: Long) -> Unit)? = null

    init {
        parent.addView(view, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.START).apply { setMargins(dp(20), 0, 0, dp(18)) })
    }

    /** [endAt]: when it rings (a timer put back after it was trashed keeps its time); else [total] seconds from now. */
    /** [quiet]: it came from the bridge (started on a screen), so the bridge isn't told again. */
    fun start(label: String, total: Int, endAt: Long = System.currentTimeMillis() + total * 1000L, quiet: Boolean = false) {
        val pill = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply { cornerRadius = dp(28).toFloat(); setColor(Color.rgb(45, 43, 40)); setStroke(dp(1), Color.rgb(92, 79, 44)) }
            elevation = dp(6).toFloat()
        }
        val name = TextView(activity).apply { text = label.take(28); textSize = 18f; setTextColor(Color.rgb(243, 239, 230)) }
        val time = TextView(activity).apply { textSize = 22f; setTextColor(Color.rgb(233, 185, 73)); setPadding(dp(14), 0, dp(6), 0); typeface = android.graphics.Typeface.DEFAULT_BOLD }
        val x = android.widget.ImageView(activity).apply { setImageResource(android.R.drawable.ic_menu_close_clear_cancel); setColorFilter(Color.rgb(165, 159, 147)); setPadding(dp(8), dp(6), dp(8), dp(6)) }
        pill.addView(name); pill.addView(time); pill.addView(x, LinearLayout.LayoutParams(dp(40), dp(40)))
        val t = T(nextId++, label, total, endAt, pill, time)
        x.setOnClickListener { remove(t) }
        pill.setOnClickListener { if (t.ringing) remove(t) }
        view.addView(pill, LinearLayout.LayoutParams(-2, dp(56)).apply { setMargins(0, 0, dp(12), 0) })
        timers += t
        view.bringToFront()
        Log.i("Timers", "start \"$label\" ${(endAt - System.currentTimeMillis()) / 1000}s")
        if (!quiet) onStart?.invoke(label, total, endAt)
        tick()
    }

    /** For the home board, which draws the timers itself. */
    fun list() = timers.map { t -> dev.openhouse.ui.TimerInfo(t.id, t.label, t.total, t.endAt, t.ringing) }

    fun cancel(id: Int) { timers.firstOrNull { it.id == id }?.let { remove(it) } }
    fun has(endAt: Long) = timers.any { it.endAt == endAt }
    /** Stopped somewhere else (a screen): stop here too, quietly. */
    fun stopped(endAt: Long) { timers.firstOrNull { it.endAt == endAt }?.let { remove(it, quiet = true) } }

    /** The board shows timers itself; the pills are for everywhere else. */
    fun showPills(show: Boolean) { view.visibility = if (show) android.view.View.VISIBLE else android.view.View.GONE }

    private fun remove(t: T, quiet: Boolean = false) {
        if (t !in timers) return
        timers.remove(t); view.removeView(t.pill)
        if (!quiet) onStop?.invoke(t.endAt)
        if (timers.none { it.ringing }) { tone?.stop(); tone = null; ringDone() }
    }

    private val ticker = Runnable { tick() }
    private fun tick() {
        main.removeCallbacks(ticker)
        val now = System.currentTimeMillis()
        for (t in timers) {
            val left = ((t.endAt - now + 999) / 1000).coerceAtLeast(0)
            if (left > 0) { t.time.text = fmt(left); continue }
            if (!t.ringing) {
                t.ringing = true
                t.time.text = "done! tap to stop"
                (t.pill.background as GradientDrawable).setColor(Color.rgb(231, 111, 81))
                ring()
                main.postDelayed({ if (t in timers) remove(t) }, 5 * 60_000L) // don't ring forever
            }
        }
        if (timers.isNotEmpty()) main.postDelayed(ticker, 500)
    }

    /** A ring is as loud as the household's volume (Opie's and the music's), fitted to the room (RoomVolume), but never
     *  under a fifth of the alarm stream: a muted tablet still rings. Android's alarm stream is its own volume, so it's
     *  set for the ring and put back after. */
    private var alarmBefore = -1
    private fun ringVolume() = runCatching {
        val am = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        val M = android.media.AudioManager.STREAM_MUSIC; val A = android.media.AudioManager.STREAM_ALARM
        val share = am.getStreamVolume(M).toDouble() / am.getStreamMaxVolume(M).coerceAtLeast(1)
        val want = (share * dev.openhouse.ui.RoomVolume.factor()).coerceIn(0.2, 1.0)
        if (alarmBefore < 0) alarmBefore = am.getStreamVolume(A)
        am.setStreamVolume(A, kotlin.math.round(want * am.getStreamMaxVolume(A)).toInt().coerceIn(am.getStreamMinVolume(A), am.getStreamMaxVolume(A)), 0)
        Log.i("Timers", "ring at ${am.getStreamVolume(A)}/${am.getStreamMaxVolume(A)}")
    }
    private fun ringDone() = runCatching {
        if (alarmBefore < 0) return@runCatching
        (activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager).setStreamVolume(android.media.AudioManager.STREAM_ALARM, alarmBefore, 0); alarmBefore = -1
    }

    private fun ring() {
        if (tone?.isPlaying == true) return
        ringVolume()
        runCatching {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            tone = RingtoneManager.getRingtone(activity, uri)?.apply {
                audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
                isLooping = true
                play()
            }
        }.onFailure { Log.w("Timers", "ring failed: $it") }
    }

    private fun fmt(s: Long): String {
        val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
    }
}
