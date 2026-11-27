package dev.openhouse.ui

import android.content.Context
import android.media.AudioManager
import android.util.Log

/**
 * A volume that fits the room, for Opie's voice and the timers (not music: that stays where someone put it). The
 * household's volume (the media stream: Settings → Volume, the keys, Opie's volume tool) is the normal level; with
 * "Adjust to the room" on (the default), what Opie says and a timer's ring are a little quieter than that in a quiet
 * room, louder in a noisy one (the dishwasher, the kids, a party), and quieter again in the night hours (House.night).
 *
 * The noise comes from the microphone that already listens for "Hey Opie" (Voice.kt): only its level, one number every
 * 100 ms, and nothing kept but a minute of those numbers. Only while the tablet itself plays nothing (its own sound would
 * count as the room's, and turn it up and up). The room's level is its noise floor, a low share of the minute's levels,
 * so people talking to it don't count, compared with the usual quiet of this room on this microphone (the lowest floor
 * it has heard lately, which drifts up slowly), so no microphone or gain control needs tuning per tablet.
 *
 * It's worked out when something starts to sound (a reply, a ring), never in the middle of one, so nothing jumps.
 * Without the microphone (the voice off), only the night hours change it.
 */
object RoomVolume {
    private const val TAG = "RoomVolume"
    private const val PREFS = "shell"
    private const val KEY = "roomVolume"
    /** dB in a room at its usual quiet, and at most in a noisy one; the night takes off NIGHT_DB more. */
    private const val QUIET_DB = -3.0
    private const val LOUD_DB = 9.0
    private const val NIGHT_DB = -6.0
    /** How far over the usual quiet (dB) the room's floor is when it's as loud as it gets here, and where it starts. */
    private const val OVER_FROM = 4.0
    private const val OVER_TO = 22.0

    private var prefs: android.content.SharedPreferences? = null
    private var am: AudioManager? = null
    fun init(c: Context) {
        prefs = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        am = c.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        quiet = prefs?.getFloat("roomQuiet", Float.NaN)?.toDouble()?.takeIf { !it.isNaN() }
    }

    /** "Adjust to the room" (Settings → Volume, Opie's volume tool). */
    var on: Boolean
        get() = prefs?.getBoolean(KEY, true) ?: true
        set(v) { prefs?.edit()?.putBoolean(KEY, v)?.apply(); Log.i(TAG, "adjust to the room: $v") }

    // The last minute: each 10 s, the floor of its 100 levels (their 20th percentile, in dBFS); the room's level is the
    // middle one of the last six. Only levels heard while the tablet played nothing count.
    private val chunk = DoubleArray(100); private var inChunk = 0
    private val floors = ArrayDeque<Double>()
    @Volatile private var floorAt = 0L
    /** The usual quiet here (dBFS), lowest lately: up 3 dB a day at most, down at once. */
    @Volatile private var quiet: Double? = null
    private var savedAt = 0L

    /** From the microphone's thread, each read: its RMS (0..1 of full scale). */
    fun hear(rms: Float) {
        if (busy()) { inChunk = 0; return } // (a chunk with our own sound in it is dropped whole)
        chunk[inChunk++] = 20 * kotlin.math.log10(rms.toDouble().coerceAtLeast(1e-5))
        if (inChunk < chunk.size) return
        inChunk = 0
        val f = chunk.sortedArray()[chunk.size / 5]
        synchronized(floors) { floors.addLast(f); while (floors.size > 6) floors.removeFirst() }
        floorAt = System.currentTimeMillis()
        val q = quiet
        quiet = if (q == null || f < q) f else q + 3.0 / 8640 // (8640 chunks a day)
        if (floorAt - savedAt > 10 * 60_000L) { savedAt = floorAt; prefs?.edit()?.putFloat("roomQuiet", quiet!!.toFloat())?.apply() }
    }

    /** The tablet is making a sound itself (a reply, music, a ring, a call). */
    private fun busy(): Boolean = runCatching { val a = am ?: return true; a.mode != AudioManager.MODE_NORMAL || a.activePlaybackConfigurations.isNotEmpty() }.getOrDefault(true)

    /** The room's floor now (dBFS), if the microphone heard it in the last 3 minutes. */
    private fun level(): Double? {
        if (System.currentTimeMillis() - floorAt > 3 * 60_000L) return null
        return synchronized(floors) { floors.sorted().getOrNull(floors.size / 2) }
    }

    /** How much louder (over 1) or quieter Opie's voice and a ring are than the household's volume now. */
    fun factor(): Double {
        if (!on) return 1.0
        val night = House.isNight()
        val lv = level(); val q = quiet
        val room = if (lv == null || q == null) 0.0 else {
            val t = ((lv - q - OVER_FROM) / (OVER_TO - OVER_FROM)).coerceIn(0.0, 1.0)
            QUIET_DB + t * (LOUD_DB - QUIET_DB)
        }
        val db = room + if (night) NIGHT_DB else 0.0
        Log.i(TAG, "room %s dBFS, usual quiet %s, night %b: %+.1f dB".format(lv?.let { "%.1f".format(it) } ?: "unheard", q?.let { "%.1f".format(it) } ?: "unknown", night, db))
        return Math.pow(10.0, db / 20)
    }

    /** For the voice tool and Settings: on or off, and how it's adjusting now. */
    fun describe(): org.json.JSONObject = org.json.JSONObject().put("adjust", on).apply {
        if (!on) return@apply
        val f = factor(); val db = 20 * kotlin.math.log10(f)
        put("now", when { House.isNight() && db < -4 -> "quieter for the night"; db > 2 -> "louder for a noisy room"; db < -1 -> "a little quieter, the room is quiet"; else -> "as set" })
    }
}
