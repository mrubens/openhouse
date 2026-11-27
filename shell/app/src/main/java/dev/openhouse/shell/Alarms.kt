package dev.openhouse.shell

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * The alarm clocks (bridge/alarms.js keeps them; they come with the home view). The shell keeps its own copy and
 * schedules the next one with Android's alarm manager (setAlarmClock: exact, even in Doze), so an alarm rings with
 * the network down, the bridge restarting, or the display's process gone: Android starts MainActivity at the time,
 * which rings it full screen. After a reboot or an update the next one is scheduled again (AlarmsReceiver, and every
 * start). The bridge is told what rang (ringing, snoozed, stopped), so Opie and the screens can stop or snooze it.
 */
object Alarms {
    const val ACTION_RING = "dev.openhouse.shell.ALARM"
    private const val TAG = "Alarms"
    const val SNOOZE_MIN = 9
    private const val RING_MAX_MS = 10 * 60_000L // stops by itself after ten minutes
    private const val LATE_MS = 10 * 60_000L // fired later than this (the tablet was off): not rung

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("alarms", Context.MODE_PRIVATE)
    private fun list(ctx: Context) = runCatching { JSONArray(prefs(ctx).getString("list", "[]")) }.getOrDefault(JSONArray())
    private fun snooze(ctx: Context) = runCatching { JSONObject(prefs(ctx).getString("snooze", "") ?: "") }.getOrNull()
    private fun find(ctx: Context, id: String): JSONObject? { val a = list(ctx); for (i in 0 until a.length()) a.optJSONObject(i)?.takeIf { it.optString("id") == id }?.let { return it }; return null }

    /** When [a] next rings after [now], or null: the same rule as bridge/alarms.js nextRing, in this device's time zone. */
    fun nextRing(a: JSONObject, now: Long): Long? {
        if (!a.optBoolean("on")) return null
        val hm = a.optString("time").split(":").mapNotNull { it.toIntOrNull() }
        if (hm.size != 2) return null
        val days = a.optJSONArray("days")?.let { d -> (0 until d.length()).map { d.optInt(it) }.toSet() } ?: emptySet()
        val c = Calendar.getInstance()
        if (days.isNotEmpty()) {
            for (i in 0..7) {
                c.timeInMillis = now; c.add(Calendar.DAY_OF_YEAR, i)
                c.set(Calendar.HOUR_OF_DAY, hm[0]); c.set(Calendar.MINUTE, hm[1]); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
                if (c.timeInMillis > now && (c.get(Calendar.DAY_OF_WEEK) - 1) in days) return c.timeInMillis
            }
            return null
        }
        val ymd = a.optString("date").split("-").mapNotNull { it.toIntOrNull() }
        if (ymd.size != 3) return null
        c.clear(); c.set(ymd[0], ymd[1] - 1, ymd[2], hm[0], hm[1], 0)
        return c.timeInMillis.takeIf { it > now }
    }

    /** The bridge's list (the home view's alarms.list): kept, and the next one scheduled. Unchanged: nothing to do. */
    fun update(ctx: Context, a: JSONArray) {
        val s = a.toString()
        if (s == prefs(ctx).getString("list", null)) return
        prefs(ctx).edit().putString("list", s).apply()
        snooze(ctx)?.let { z -> if (find(ctx, z.optString("id")) == null) prefs(ctx).edit().remove("snooze").apply() } // (cancelled; one turned off is stopped by the bridge)
        schedule(ctx)
    }

    /** The soonest of every alarm's next ring and a snooze, given to Android's alarm manager (or none). */
    fun schedule(ctx: Context) {
        val now = System.currentTimeMillis()
        var best: Pair<String, Long>? = null
        val a = list(ctx)
        for (i in 0 until a.length()) { val x = a.optJSONObject(i) ?: continue; val t = nextRing(x, now) ?: continue; if (best == null || t < best.second) best = x.optString("id") to t }
        snooze(ctx)?.let { z -> val t = z.optLong("until"); if (t > now - LATE_MS && (best == null || t < best!!.second)) best = z.optString("id") to t.coerceAtLeast(now + 1000) }
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val show = PendingIntent.getActivity(ctx, 41, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val fire = { id: String, at: Long -> PendingIntent.getBroadcast(ctx, 40, Intent(ctx, AlarmsReceiver::class.java).setAction(ACTION_RING).putExtra("id", id).putExtra("at", at), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val b = best
        if (b == null) { am.cancel(fire("", 0)); Log.i(TAG, "none to schedule"); return }
        runCatching {
            if (android.os.Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, b.second, fire(b.first, b.second)); Log.w(TAG, "no exact alarms allowed: inexact") }
            else am.setAlarmClock(AlarmManager.AlarmClockInfo(b.second, show), fire(b.first, b.second))
            Log.i(TAG, "next ${b.first} in ${(b.second - now) / 1000}s")
        }.onFailure { Log.w(TAG, "schedule failed: $it") }
    }

    // ---- ringing (MainActivity's screen) ----
    private val main = Handler(Looper.getMainLooper())
    private var ringing: Ring? = null
    /** Stopped or snoozed from somewhere else (Opie, a screen: DeviceServer /alarms). */
    fun control(what: String, minutes: Int) = main.post {
        val r = ringing
        when {
            r != null && what == "snooze" -> r.snooze(minutes)
            r != null -> r.stop()
            what == "stop" -> ctxRef?.let { c -> snooze(c)?.let { z -> prefs(c).edit().remove("snooze").apply(); schedule(c); tell("stopped", z.optString("id")) } }
        }
    }
    private var ctxRef: Context? = null
    private fun tell(what: String, id: String, until: Long = 0) {
        Thread { runCatching { dev.openhouse.ui.Openhouse.post("/home/alarm", JSONObject().put(what, id).apply { if (until > 0) put("until", until) }) } }.start()
    }
    /** What the bridge's home view says is ringing (null after a bridge restart): told again, so Opie can stop it. */
    fun bridgeSays(ring: JSONObject?) {
        val r = ringing
        val c = ctxRef ?: return
        val z = snooze(c)
        when {
            r != null -> if (ring?.optString("state") != "ringing") tell("ringing", r.id)
            z != null -> if (ring?.optString("state") != "snoozed") tell("snoozed", z.optString("id"), z.optLong("until"))
            ring != null -> tell("stopped", ring.optString("id")) // (it stopped while the bridge wasn't listening)
        }
    }

    /** Android started the display for an alarm ([intent] has its id and time). */
    fun fired(activity: Activity, root: FrameLayout, intent: Intent?) {
        if (intent?.action != ACTION_RING) return
        ctxRef = activity.applicationContext
        val id = intent.getStringExtra("id") ?: return
        val at = intent.getLongExtra("at", 0L)
        intent.action = null // (an activity recreated doesn't ring it again)
        val c = activity.applicationContext
        runCatching { c.getSystemService(android.app.NotificationManager::class.java).cancel(NOTE) }
        if (ringing?.id == id) return // (the notification's and the start's both arrived)
        val z = snooze(c)
        val a = find(c, id)
        val snoozed = z?.optString("id") == id
        if (snoozed) prefs(c).edit().remove("snooze").apply()
        schedule(c) // the one after it
        if (a == null || (!a.optBoolean("on") && !snoozed)) { Log.i(TAG, "$id is gone or off: not rung"); return }
        if (System.currentTimeMillis() - at > LATE_MS) { Log.i(TAG, "$id fired ${(System.currentTimeMillis() - at) / 1000}s late: not rung"); return }
        ringing?.stop(quiet = true)
        ringing = Ring(activity, root, id, a.optString("label"), a.optString("who").takeIf { it.isNotBlank() && it != "null" })
    }
    fun start(ctx: Context) { ctxRef = ctx.applicationContext; schedule(ctx) }

    private const val CHANNEL = "alarms"
    private const val NOTE = 4040
    /** The alarm manager's broadcast: the display brought up to ring it. Android lets an app start its screen from
     *  the background only sometimes (the device owner, as the household's tablet is, always), so a full-screen
     *  notification goes up too, which brings the screen up (or, while it's in use, rings it there); fired() takes it down. */
    fun due(ctx: Context, id: String, at: Long) {
        val ring = Intent(ctx, MainActivity::class.java).setAction(ACTION_RING).putExtra("id", id).putExtra("at", at).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { ctx.startActivity(ring) }.onFailure { Log.w(TAG, "start: $it") }
        runCatching {
            val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
            nm.createNotificationChannel(android.app.NotificationChannel(CHANNEL, "Alarms", android.app.NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null) })
            val opts = if (android.os.Build.VERSION.SDK_INT >= 34) android.app.ActivityOptions.makeBasic().setPendingIntentCreatorBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED).toBundle() else null
            val pi = PendingIntent.getActivity(ctx, 42, ring, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT, opts)
            val a = find(ctx, id)
            nm.notify(NOTE, android.app.Notification.Builder(ctx, CHANNEL).setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(a?.optString("label")?.ifBlank { null } ?: "Alarm").setCategory(android.app.Notification.CATEGORY_ALARM)
                .setFullScreenIntent(pi, true).setContentIntent(pi).setOngoing(true).build())
        }.onFailure { Log.w(TAG, "notification: $it") }
    }

    private class Ring(val activity: Activity, val root: FrameLayout, val id: String, label: String, who: String?) {
        private fun dp(v: Int) = (v * activity.resources.displayMetrics.density).toInt()
        private var tone: Ringtone? = null
        private val view = FrameLayout(activity).apply { setBackgroundColor(Color.rgb(30, 29, 27)); isClickable = true }
        private val clock = TextView(activity).apply { textSize = 96f; setTextColor(Color.rgb(243, 239, 230)); typeface = Typeface.create("sans-serif-light", Typeface.NORMAL); gravity = Gravity.CENTER }
        private val tick = object : Runnable { override fun run() { clock.text = android.text.format.DateFormat.getTimeFormat(activity).format(java.util.Date()); main.postDelayed(this, 1000) } }
        private val giveUp = Runnable { stop() }

        init {
            val col = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
            col.addView(clock)
            col.addView(TextView(activity).apply { text = listOfNotNull(label.ifBlank { "Alarm" }, who).joinToString(" · "); textSize = 28f; setTextColor(Color.rgb(200, 194, 184)); gravity = Gravity.CENTER; setPadding(0, dp(4), 0, dp(40)) })
            val row = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
            fun button(t: String, filled: Boolean, go: () -> Unit) = TextView(activity).apply {
                text = t; textSize = 24f; gravity = Gravity.CENTER; setPadding(dp(40), 0, dp(40), 0)
                setTextColor(if (filled) Color.rgb(30, 29, 27) else Color.rgb(243, 239, 230))
                background = GradientDrawable().apply { cornerRadius = dp(36).toFloat(); setColor(if (filled) Color.rgb(233, 185, 73) else Color.rgb(58, 55, 51)) }
                setOnClickListener { go() }
            }
            row.addView(button("Snooze", false) { snooze(SNOOZE_MIN) }, LinearLayout.LayoutParams(dp(220), dp(76)).apply { setMargins(dp(12), 0, dp(12), 0) })
            row.addView(button("Stop", true) { stop() }, LinearLayout.LayoutParams(dp(220), dp(76)).apply { setMargins(dp(12), 0, dp(12), 0) })
            col.addView(row)
            view.addView(col, FrameLayout.LayoutParams(-1, -1))
            root.addView(view, FrameLayout.LayoutParams(-1, -1))
            view.bringToFront()
            view.translationZ = dp(1000).toFloat() // above whatever is brought to the front later (the setup layer, the overlay)
            if (android.os.Build.VERSION.SDK_INT >= 27) { activity.setShowWhenLocked(true); activity.setTurnScreenOn(true) }
            dev.openhouse.ui.Openhouse.touch() // out of the resting screen and night's dimming
            main.post(tick)
            main.postDelayed(giveUp, RING_MAX_MS)
            runCatching {
                val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                tone = RingtoneManager.getRingtone(activity, uri)?.apply { audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build(); isLooping = true; play() }
            }.onFailure { Log.w(TAG, "ring failed: $it") }
            Log.i(TAG, "ringing $id")
            tell("ringing", id)
        }
        private fun close() {
            tone?.stop(); tone = null
            main.removeCallbacks(tick); main.removeCallbacks(giveUp)
            root.removeView(view)
            if (android.os.Build.VERSION.SDK_INT >= 27) { activity.setShowWhenLocked(false); activity.setTurnScreenOn(false) }
            if (ringing === this) ringing = null
        }
        fun stop(quiet: Boolean = false) { close(); Log.i(TAG, "stopped $id"); if (!quiet) tell("stopped", id) }
        fun snooze(minutes: Int) {
            close()
            val until = System.currentTimeMillis() + minutes.coerceIn(1, 60) * 60_000L
            val c = activity.applicationContext
            prefs(c).edit().putString("snooze", JSONObject().put("id", id).put("until", until).toString()).apply()
            schedule(c)
            Log.i(TAG, "snoozed $id for $minutes min")
            tell("snoozed", id, until)
        }
    }
}

/** After a reboot or an update, Android has forgotten the alarm: the next one is scheduled again. */
class AlarmsReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Alarms.ACTION_RING) Alarms.due(ctx, intent.getStringExtra("id") ?: return, intent.getLongExtra("at", 0L))
        else Alarms.schedule(ctx)
    }
}
