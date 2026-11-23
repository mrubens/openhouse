package dev.openhouse.ui

import java.net.HttpURLConnection
import java.net.URL

/**
 * Every request to the bridge goes through here: it carries the bridge's secret (a new one each time the tablet
 * starts, from the shell), without which the bridge answers 401. Other apps on the tablet don't have it.
 * Also the one place requests are made from (the board, the shell, an app's own window).
 */
object BridgeClient {
    const val HEADER = "X-Openhouse-Token"
    /** Set by the shell (and, in an app's own window, from what the display passed it). */
    @Volatile var token: String? = null
    fun open(url: String): HttpURLConnection = URL(url).let { u ->
        (u.openConnection() as HttpURLConnection).apply { if (isBridge(u)) token?.let { setRequestProperty(HEADER, it) } }
    }
    /** Only the bridge gets the secret (never a picture's web server, nor the dev server). */
    fun isBridge(u: URL) = u.port == 8787 && u.host in setOf("127.0.0.1", "localhost", "10.0.2.2")

    /** GET [url]'s body; throws if it can't. */
    fun get(url: String, connectMs: Int = 3000, readMs: Int = 15000): ByteArray = open(url).run {
        connectTimeout = connectMs; readTimeout = readMs; inputStream.use { it.readBytes() }
    }
    fun getText(url: String, connectMs: Int = 3000, readMs: Int = 15000) = get(url, connectMs, readMs).toString(Charsets.UTF_8)

    /** POST a JSON body; the answer, or null if it couldn't. */
    fun post(url: String, body: String = "{}", connectMs: Int = 3000, readMs: Int = 30000): String? = runCatching {
        open(url).run {
            requestMethod = "POST"; doOutput = true; connectTimeout = connectMs; readTimeout = readMs
            setRequestProperty("content-type", "application/json")
            outputStream.use { it.write(body.toByteArray()) }
            inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        }
    }.getOrNull()

    /**
     * A stream of lines (NDJSON, or server-sent events' `data:` lines): each line to [onLine] until it ends. Blocking.
     * [onOpen] gets the connection first, so whoever wants to stop it early can close it ([HttpURLConnection.disconnect]
     * ends the read at once, unlike cancelling the coroutine around it).
     */
    fun lines(c: HttpURLConnection, onOpen: (HttpURLConnection) -> Unit = {}, onLine: (String) -> Unit) {
        onOpen(c)
        c.inputStream.bufferedReader().useLines { ls -> for (l in ls) onLine(l) }
    }
}

/**
 * Where the microphone is, counted in samples of the stream it is sending the bridge. The listener takes the
 * display's own voice out of what it hears (echo cancelling), and for that it must know at which microphone
 * sample each spoken sentence starts playing. The microphone (shell/Voice.kt) says how much it has sent.
 */
/** How loud the microphone is right now (RMS of the last 100 ms, 0-1), for the assistant's bars to move with the room. */
object MicLevel {
    @Volatile var rms = 0f; private set
    @Volatile var at = 0L; private set
    /** The room's own level (dB), learned: it follows quiet at once and rises only slowly, so speech stands above it. */
    @Volatile private var floor = -55f
    fun set(v: Float) {
        rms = v; at = android.os.SystemClock.uptimeMillis()
        val db = if (v > 0f) 20f * kotlin.math.log10(v) else -90f
        floor = if (db < floor) db else floor + 0.05f // about half a dB a second
    }
    /** The level as the bars show it: 0 at the room's level, 1 about 26 dB above it (a voice close by); 0 when the
     *  microphone hasn't sent for a moment. (The tablet's plain microphone is quiet: the room near -52 dB.) */
    fun shown(): Float {
        if (android.os.SystemClock.uptimeMillis() - at > 400 || rms <= 0f) return 0f
        return ((20f * kotlin.math.log10(rms) - floor - 4f) / 22f).coerceIn(0f, 1f)
    }
}

/** How loud the assistant's own voice is right now (OpenAI's live voice: the page measures what it plays), 0-1 RMS. */
object OutLevel {
    @Volatile var rms = 0f; private set
    @Volatile var at = 0L; private set
    fun set(v: Float) { rms = v; at = android.os.SystemClock.uptimeMillis() }
    /** As the bars show it: 0 near silence (-50 dB), 1 at a strong voice (-14 dB); -1 when nothing was measured lately. */
    fun shown(): Float {
        if (android.os.SystemClock.uptimeMillis() - at > 400) return -1f
        if (rms <= 0f) return 0f
        return ((20f * kotlin.math.log10(rms) + 50f) / 36f).coerceIn(0f, 1f)
    }
}

object MicClock {
    private class Mark(val sent: Long, val at: Long) // this many samples sent, the last of them captured at this time (elapsedRealtimeNanos)
    @Volatile private var mark: Mark? = null
    private var sent = 0L
    /** Which run of the microphone this is: it goes up each time it restarts, and its count of samples with it. */
    @Volatile var run = 0; private set
    fun began() { sent = 0; mark = null; run++ }
    /** [samples] more were read. [capturedAt]: when the last of them was captured, by the recorder's own clock; 0 if it has none (then: now). */
    fun read(samples: Int, capturedAt: Long = 0) { sent += samples; mark = Mark(sent, if (capturedAt > 0) capturedAt else android.os.SystemClock.elapsedRealtimeNanos()) }
    fun ended() { mark = null }
    /** The sample being captured right now (-1: the microphone is off). */
    fun now(): Long = at(android.os.SystemClock.elapsedRealtimeNanos())
    /** The sample captured at [nanos] (elapsedRealtimeNanos; it may be a little way ahead). -1: the microphone is off. */
    fun at(nanos: Long): Long = mark?.let { it.sent + (nanos - it.at) * 16000 / 1_000_000_000 } ?: -1
}

/**
 * Is the bridge cancelling the display's own voice itself (POST /voice/echo)? Then the microphone must be plain: the
 * tablet's own gain control, noise suppression and echo cancelling change what it hears from moment to moment, and
 * the bridge's canceller can only take out a voice that comes back the same way each time.
 */
object MicMode {
    @Volatile var plain = false; private set
    @Volatile var onChange: (() -> Unit)? = null
    fun set(p: Boolean) { if (p != plain) { plain = p; onChange?.invoke() } }
}
