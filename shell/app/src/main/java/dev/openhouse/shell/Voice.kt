package dev.openhouse.shell

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

/**
 * The microphone, for listening. Streams 16 kHz mono PCM to the bridge on this device, which
 * works out who is talking and what they said; audio never goes anywhere else and isn't kept.
 * Pauses while something else needs the microphone (dictation in the classic dashboard).
 */
class Voice(private val bridge: () -> String, private val source: () -> Int = { MediaRecorder.AudioSource.VOICE_RECOGNITION },
    /** The source while the bridge cancels echo itself: the plainest the device has (no gain control or noise suppression in it). */
    private val plainSource: () -> Int = { MediaRecorder.AudioSource.VOICE_RECOGNITION }) {
    @Volatile var enabled = true
    /** Restart the microphone (e.g. after changing the audio source). */
    fun restart() { restartReq = true }
    /** The source it has open now (-1: none), so a settings change only reopens the microphone when it's a different one. */
    @Volatile var openSource = -1; private set
    /** Reopen only if the source it would choose now isn't the one it has open (adb's settings broadcasts, even a token fetch, used to reopen it). */
    fun restartIfChanged() { val now = if (dev.openhouse.ui.MicMode.plain) plainSource() else source(); if (holding && now != openSource) restart() }
    @Volatile private var restartReq = false
    @Volatile var paused = false
    /** The screen is off (the cover closed, or the power button): the microphone is let go until it's on again. */
    @Volatile var screenOff = false
    /** The microphone is open here (an AudioRecord exists). */
    @Volatile var holding = false; private set
    private val lock = Object()
    /** Pause and wait until the microphone is let go, up to [ms]: some tablets give it to one recorder at a time. */
    fun pauseAndRelease(ms: Long): Boolean {
        paused = true
        val until = System.currentTimeMillis() + ms
        synchronized(lock) { while (holding) { val left = until - System.currentTimeMillis(); if (left <= 0) break; lock.wait(left) } }
        return !holding
    }
    @Volatile private var running = false
    private var thread: Thread? = null

    // The last couple of seconds it heard, kept here only (nothing is written anywhere), and a tap on what it hears
    // next: OpenAI's live voice takes what was said right after its name while its session connects (LiveVoice).
    private val ring = ByteArray(RING); private var ringEnd = 0L
    /** Each read, as it comes (on the microphone's thread), while set. */
    @Volatile var tap: ((ByteArray, Int) -> Unit)? = null
    /** The last [ms] it heard (16 kHz mono 16-bit), oldest first. */
    fun recent(ms: Int): ByteArray = synchronized(ring) {
        val n = minOf((ms * 32L / 2 * 2).toInt(), RING, ringEnd.toInt())
        ByteArray(n) { i -> ring[((ringEnd - n + i) % RING).toInt()] }
    }
    private fun keep(b: ByteArray, n: Int) = synchronized(ring) { for (i in 0 until n) ring[((ringEnd + i) % RING).toInt()] = b[i]; ringEnd += n }

    fun start() {
        if (running) return
        running = true
        dev.openhouse.ui.MicMode.onChange = { restart() } // echo cancelling switched on or off: open the microphone again, plain or not
        thread = Thread(::loop, "voice").apply { isDaemon = true; start() }
    }

    fun stop() { running = false; thread?.interrupt() }

    @SuppressLint("MissingPermission") // checked by the caller before start()
    private fun loop() {
        val rate = 16000
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val buf = ByteArray(3200) // 100 ms
        while (running) {
            if (!enabled || paused || screenOff) { sleep(500); continue }
            var rec: AudioRecord? = null
            var conn: HttpURLConnection? = null
            val opened = System.currentTimeMillis()
            try {
                conn = dev.openhouse.ui.BridgeClient.open(bridge() + "/voice/stream").apply {
                    requestMethod = "POST"; doOutput = true; setChunkedStreamingMode(3200)
                    setRequestProperty("content-type", "application/octet-stream")
                    connectTimeout = 3000; readTimeout = 0
                }
                val out = conn.outputStream
                // Is the bridge cancelling echo itself? (Asked each time the microphone opens; it also says so when it's switched.)
                runCatching { dev.openhouse.ui.MicMode.set(org.json.JSONObject(dev.openhouse.ui.BridgeClient.getText(bridge() + "/voice/status", 1500, 3000)).optBoolean("echo")) }
                val plain = dev.openhouse.ui.MicMode.plain
                val src = if (plain) plainSource() else source()
                holding = true; openSource = src
                rec = AudioRecord(src, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, rate * 2))
                if (rec.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("microphone unavailable")
                // The platform's voice processing: gain, noise suppression, and echo cancelling (so it
                // can hear people while it talks). Each is optional; some sources apply them already.
                val sid = rec.audioSessionId
                // (Not when the bridge cancels echo itself: it needs the microphone as it is.)
                val fx = if (plain) emptyList() else listOfNotNull(
                    runCatching { if (android.media.audiofx.AutomaticGainControl.isAvailable()) android.media.audiofx.AutomaticGainControl.create(sid)?.apply { enabled = true } else null }.getOrNull(),
                    runCatching { if (android.media.audiofx.NoiseSuppressor.isAvailable()) android.media.audiofx.NoiseSuppressor.create(sid)?.apply { enabled = true } else null }.getOrNull(),
                    runCatching { if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) android.media.audiofx.AcousticEchoCanceler.create(sid)?.apply { enabled = true } else null }.getOrNull(),
                )
                rec.startRecording(); restartReq = false; dev.openhouse.ui.MicClock.began()
                Log.i(TAG, "listening (source $src, effects: ${if (plain) "none, the bridge cancels echo" else fx.joinToString { it.javaClass.simpleName }})")
                val stamp = android.media.AudioTimestamp(); var total = 0L
                var peak = 0; var sum = 0.0; var count = 0; var lastLog = System.currentTimeMillis()
                while (running && enabled && !paused && !screenOff && !restartReq) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) {
                        // Where the microphone is, for echo cancelling: how many samples so far, and when the last was captured
                        // (the recorder's own clock says which sample it captured when; without it, now).
                        total += n / 2
                        val captured = if (rec.getTimestamp(stamp, android.media.AudioTimestamp.TIMEBASE_BOOTTIME) == AudioRecord.SUCCESS && stamp.framePosition > 0) stamp.nanoTime + (total - stamp.framePosition) * 1_000_000_000L / rate else 0L
                        dev.openhouse.ui.MicClock.read(n / 2, captured)
                        keep(buf, n); tap?.invoke(buf, n)
                        out.write(buf, 0, n)
                        var chunk = 0.0
                        for (i in 0 until n / 2) { val v = (buf[2 * i].toInt() and 0xff) or (buf[2 * i + 1].toInt() shl 8); val a = kotlin.math.abs(v.toShort().toInt()); if (a > peak) peak = a; sum += a.toDouble() * a; chunk += a.toDouble() * a; count++ }
                        dev.openhouse.ui.MicLevel.set((kotlin.math.sqrt(chunk / maxOf(1, n / 2)) / 32768.0).toFloat()) // the assistant's bars move with it
                        if (System.currentTimeMillis() - lastLog > 2000) { // the level, for tuning the microphone
                            Log.d(TAG, "level peak %.4f rms %.4f".format(peak / 32768.0, kotlin.math.sqrt(sum / maxOf(1, count)) / 32768.0))
                            peak = 0; sum = 0.0; count = 0; lastLog = System.currentTimeMillis()
                        }
                    } else if (n < 0) throw IllegalStateException("read $n")
                }
                fx.forEach { runCatching { it.release() } }
                letGo(rec); rec = null // before waiting on the bridge's reply, so the microphone is free at once
                out.close(); conn.responseCode
            } catch (e: Exception) {
                // The bridge may still be starting: wait a moment. But a stream that ran a while and broke is opened again at
                // once (every second deaf can be the request after its name).
                if (running) { Log.w(TAG, "listening stopped: $e"); if (System.currentTimeMillis() - opened < 10_000) sleep(3000) }
            } finally {
                dev.openhouse.ui.MicClock.ended()
                letGo(rec); openSource = -1
                conn?.disconnect()
            }
        }
    }

    private fun letGo(rec: AudioRecord?) {
        if (rec != null) { runCatching { rec.stop() }; runCatching { rec.release() } }
        synchronized(lock) { holding = false; lock.notifyAll() }
    }

    private fun sleep(ms: Long) = runCatching { Thread.sleep(ms) }

    companion object {
        const val TAG = "Voice"; private const val RING = 3 * 32000 /* 3 s */
        /**
         * The audio source for listening on this tablet, measured with someone saying "Hey Opie" from 1.5-2 m (peak level,
         * of full scale, at the microphone):
         * - Galaxy Tab S10 FE (SM-X52x): MIC. It was ~40x louder than VOICE_COMMUNICATION and ~2x VOICE_RECOGNITION, and the
         *   wake model's gain and loudness floor (models/wake/opie.json) were set on it.
         * - Galaxy Tab A11 (SM-X230, 2026-11-25): VOICE_RECOGNITION 0.15-0.5; MIC 0.003-0.02 (below the wake floor: it
         *   never woke); VOICE_COMMUNICATION 0.05-0.14; UNPROCESSED ~0.0001 (silent).
         * Any other tablet: VOICE_RECOGNITION, the source Android tunes for speech recognition.
         */
        fun defaultSource(model: String = android.os.Build.MODEL ?: ""): Int =
            if (Regex("^SM-X52\\d").containsMatchIn(model)) MediaRecorder.AudioSource.MIC else MediaRecorder.AudioSource.VOICE_RECOGNITION
    }
}
