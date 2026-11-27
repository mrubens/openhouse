package dev.openhouse.ui

// Speaking: the device's own speech engine (Samsung/Google neural voices) makes the audio, and the shell plays it.
// The engine reads numbers, times, names and contractions properly and starts in a few hundred ms. While it talks, the bridge
// knows what it's saying, so other words it hears are someone talking over it.
// With OpenAI's live voice on (openhouse-cloud/docs/cloud-beta.md), a live session has the speaker instead (sink, shell LiveVoice).

import android.util.Log
import kotlinx.coroutines.launch
import org.json.JSONObject

internal object Speech {
    private val o = Openhouse
    private var tts: android.speech.tts.TextToSpeech? = null
    @Volatile private var ttsReady = false
    private val pending = java.util.concurrent.atomic.AtomicInteger(0)
    fun busy() = pending.get() > 0
    /** Where it says things instead, when a live voice session has the speaker (shell LiveVoice): true if it took it. */
    @Volatile var sink: ((String) -> Boolean)? = null
    private var uttN = 0
    private val idleCallbacks = mutableListOf<() -> Unit>()
    private var speechPrefs: android.content.SharedPreferences? = null
    /** Speak a sample in this voice, and use it from now on. */
    fun chooseVoice(name: String) {
        val t = tts ?: return
        val v = runCatching { t.voices.firstOrNull { it.name == name } }.getOrNull() ?: return
        t.voice = v; o.voiceName = name
        speechPrefs?.edit()?.putString("voice", name)?.apply()
        stop(); hushed = false; say("Hi, I'm ${o.assistantName}. This is how I sound.", null)
    }

    fun init(ctx: android.content.Context, engines: List<String>? = null) {
        if (speechPrefs == null) { speechPrefs = ctx.getSharedPreferences("speech", android.content.Context.MODE_PRIVATE); o.voiceName = speechPrefs?.getString("voice", null) }
        // Google's offline neural voices sound far less robotic than Samsung's, so try Google first and
        // use it if it has a good English voice installed (quality 400+, no network); else Samsung's.
        val order = engines ?: listOf("com.google.android.tts", "com.samsung.SMT").filter { e ->
            runCatching { ctx.packageManager.getPackageInfo(e, 0) }.isSuccess }
        val engine = order.firstOrNull()
        tts = android.speech.tts.TextToSpeech(ctx.applicationContext, { st ->
            val t = tts ?: return@TextToSpeech
            if (st != android.speech.tts.TextToSpeech.SUCCESS) {
                Log.w("Openhouse", "speech engine $engine failed: $st")
                if (order.size > 1) { runCatching { t.shutdown() }; init(ctx, order.drop(1)) }
                return@TextToSpeech
            }
            val all = runCatching { t.voices.toList() }.getOrDefault(emptyList())
            Log.i("Openhouse", "speech engine ${t.defaultEngine}: ${all.size} voices")
            val voices = all.filter { it.locale.language == "en" && !it.isNetworkConnectionRequired && "notInstalled" !in it.features }
            voices.sortedByDescending { it.quality }.forEach { Log.i("Openhouse", "voice ${it.name} ${it.locale} q${it.quality} l${it.latency} ${it.features}") }
            val us = voices.filter { it.locale.country == "US" }
            val pick = voices.firstOrNull { it.name == o.voiceName } ?: us.maxWithOrNull(compareBy({ it.quality }, { -it.latency })) ?: voices.maxByOrNull { it.quality }
            if ((pick == null || pick.quality < android.speech.tts.Voice.QUALITY_HIGH) && order.size > 1) { // no good voice here: the next engine
                Log.i("Openhouse", "no good voice in $engine (${pick?.name} q${pick?.quality}), trying ${order[1]}")
                runCatching { t.shutdown() }; init(ctx, order.drop(1)); return@TextToSpeech
            }
            pick?.let { t.voice = it }
            val regions = mapOf("US" to "American", "GB" to "British", "AU" to "Australian", "IN" to "Indian", "CA" to "Canadian", "IE" to "Irish", "NG" to "Nigerian", "ZA" to "South African")
            val usable = voices.filter { !it.name.endsWith("-language") }.sortedWith(compareBy({ it.locale.country != "US" }, { it.locale.country }, { it.name }))
            val counts = mutableMapOf<String, Int>()
            val list = usable.map { v -> val r = regions[v.locale.country] ?: v.locale.displayCountry.ifBlank { "English" }; val n = (counts[r] ?: 0) + 1; counts[r] = n; SpeechVoice(v.name, "$r $n") }
            o.ui { o.speechVoices = list; if (o.voiceName == null || list.none { it.name == o.voiceName }) o.voiceName = t.voice?.name }
            Log.i("Openhouse", "speaking with ${t.voice?.name} (${t.defaultEngine})")
            cacheDir = ctx.applicationContext.cacheDir
            t.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
                // The engine only makes the audio (synthesizeToFile); the shell plays it (see "playing it itself" below).
                override fun onBeginSynthesis(id: String, rate: Int, format: Int, channels: Int) {
                    if (format == android.media.AudioFormat.ENCODING_PCM_16BIT) { refFmt[id] = intArrayOf(rate, channels); utters[id]?.let { it.rate = rate; it.channels = channels } }
                    if (refFmt.size > 50) refFmt.clear()
                }
                override fun onAudioAvailable(id: String, audio: ByteArray) {
                    val u = utters[id] ?: return; if (u.rate == 0) return
                    val c = audio.copyOf(); u.got += c.size; u.chunks.add(c) // (the player tells the bridge, in the order it plays them)
                }
                override fun onStart(id: String) {}
                override fun onDone(id: String) = made(id)
                @Deprecated("") override fun onError(id: String) = made(id)
                override fun onError(id: String, code: Int) = made(id)
                override fun onStop(id: String, interrupted: Boolean) = made(id)
            })
            ttsReady = true
        }, engine)
    }
    // One thread, so the pieces of a sentence reach the bridge in order.
    private val refOut = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "speech-ref").apply { isDaemon = true } }
    private val refFmt = java.util.concurrent.ConcurrentHashMap<String, IntArray>() // sentence -> rate, channels
    private fun refAudio(id: String, audio: ByteArray) {
        val f = refFmt[id] ?: return
        val copy = audio.copyOf()
        refOut.execute { runCatching {
            BridgeClient.open("${o.bridgeUrl}/voice/ref?id=$id&rate=${f[0]}&ch=${f[1]}").run {
                requestMethod = "POST"; doOutput = true; connectTimeout = 2000; readTimeout = 5000
                setRequestProperty("content-type", "application/octet-stream"); setFixedLengthStreamingMode(copy.size)
                outputStream.use { it.write(copy) }
                inputStream.use { it.readBytes() }
            }
        } }
    }
    // ---- playing it itself ----
    // The engine makes each sentence's audio as fast as it can, and the shell plays it through its own audio track.
    // So it knows exactly which samples come out and when (the track's own clock), which echo cancelling needs: with
    // the engine playing, "it started" was up to 120 ms out from one sentence to the next, and the first sentence's
    // audio reached the bridge only after it had begun (the tablet, 2026-11-17). Stopping is also immediate.
    private class Utter(val id: String, val gen: Int) {
        val chunks = java.util.concurrent.LinkedBlockingQueue<ByteArray>()
        @Volatile var rate = 0; @Volatile var channels = 1 // as the engine makes it (0: not said yet)
        @Volatile var got = 0 // bytes of it the engine has made
        @Volatile var done = false // the engine has made all of it
        var file: java.io.File? = null
    }
    private val END = ByteArray(0)
    private val utters = java.util.concurrent.ConcurrentHashMap<String, Utter>()
    private val line = java.util.concurrent.LinkedBlockingQueue<Utter>() // in the order they were said
    @Volatile private var gen = 0 // goes up when it's stopped: what was queued before is dropped
    @Volatile private var renew = false // the track was cut off: make a new one (its count of samples starts again)
    @Volatile private var track: android.media.AudioTrack? = null
    private var trackRate = 0; private var trackCh = 1
    private var written = 0L // samples (frames) given to the track since it was made
    private var player: Thread? = null
    private var cacheDir: java.io.File? = null
    private const val LEAD_MS = 200 // silence before the first sentence after a pause: by the time the words come out, the track's clock is running
    // Better: the track is already running when the first sentence arrives. A spoken request is being answered
    // (waitingSince): play silence, a twentieth of a second ahead at most, until the words come or half a minute passes.
    @Volatile private var warmUntil = 0L
    @Volatile private var roomGain = 1f
    private fun keepWarm() {
        if (System.currentTimeMillis() > warmUntil) return
        // (In the engine's own format, remembered from last time: another format means a new track, with no clock yet.)
        val t = (if (trackRate > 0) trackFor(trackRate, trackCh) else trackFor(speechPrefs?.getInt("rate", 24000) ?: 24000, speechPrefs?.getInt("channels", 1) ?: 1)) ?: return
        if (waiting(t) >= trackRate / 20) return
        val z = ByteArray((if (written == 0L && android.os.Build.VERSION.SDK_INT < 31) trackRate / 4 else trackRate / 25) * 2 * trackCh) // (a full buffer the first time, where it can't be told to start sooner)
        val n = t.write(z, 0, z.size, android.media.AudioTrack.WRITE_NON_BLOCKING)
        if (n > 0) written += n / (2 * trackCh)
    }
    /** The engine has made all of this sentence (or gave up). */
    private fun made(id: String) { utters[id]?.let { it.done = true; it.chunks.add(END) } }

    private fun startPlayer() {
        if (player?.isAlive == true) return
        player = Thread({
            runCatching { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO) } // it feeds the speaker: not to be kept waiting by the screen
            while (true) {
                val u = try { line.poll(20, java.util.concurrent.TimeUnit.MILLISECONDS) } catch (e: InterruptedException) { return@Thread }
                if (u == null) { runCatching { keepWarm() }; continue }
                warmUntil = 0
                runCatching { playOne(u) }.onFailure { Log.w("Openhouse", "speech player: $it") }
                utters.remove(u.id); refFmt.remove(u.id); runCatching { u.file?.delete() }
                if (u.gen != gen || renew) dropTrack() else finished()
            }
        }, "speech-play").apply { isDaemon = true; start() }
    }
    private fun dropTrack() { val t = track; track = null; written = 0; renew = false; anchorFrame = -1; runCatching { t?.pause(); t?.flush() }; runCatching { t?.release() } }
    private fun trackFor(rate: Int, ch: Int): android.media.AudioTrack? {
        if (renew || (track != null && (rate != trackRate || ch != trackCh))) dropTrack()
        track?.let { if (it.playState != android.media.AudioTrack.PLAYSTATE_PLAYING) runCatching { it.play() }; return it }
        val mask = if (ch == 2) android.media.AudioFormat.CHANNEL_OUT_STEREO else android.media.AudioFormat.CHANNEL_OUT_MONO
        val min = android.media.AudioTrack.getMinBufferSize(rate, mask, android.media.AudioFormat.ENCODING_PCM_16BIT)
        val t = runCatching {
            android.media.AudioTrack.Builder()
                .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(android.media.AudioFormat.Builder().setSampleRate(rate).setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT).setChannelMask(mask).build())
                .setBufferSizeInBytes(maxOf(min, rate * 2 * ch / 4)) // a quarter second
                .setTransferMode(android.media.AudioTrack.MODE_STREAM).build()
        }.getOrNull()?.takeIf { it.state == android.media.AudioTrack.STATE_INITIALIZED } ?: return null
        if (rate != speechPrefs?.getInt("rate", 0) || ch != speechPrefs?.getInt("channels", 0)) speechPrefs?.edit()?.putInt("rate", rate)?.putInt("channels", ch)?.apply() // (for the next start: see keepWarm)
        // (A new track waits for a full buffer before it starts, by default: start at once, so a little silence is enough to get its clock going.)
        if (android.os.Build.VERSION.SDK_INT >= 31) runCatching { t.setStartThresholdInFrames(rate / 50) }
        runCatching { t.setVolume(roomGain) }
        trackRate = rate; trackCh = ch; written = 0; anchorFrame = -1; track = t; t.play()
        return t
    }
    private fun write(t: android.media.AudioTrack, c: ByteArray, u: Utter) {
        var off = 0
        while (off < c.size && u.gen == gen) { // (cutting it off pauses the track, and write comes back short)
            val n = t.write(c, off, c.size - off)
            if (n < 0) return
            if (n == 0) Thread.sleep(5) else off += n
        }
        written += off / (2 * trackCh)
    }
    /** How much is in the track still to come out, in samples. */
    private fun waiting(t: android.media.AudioTrack) = written - (t.playbackHeadPosition.toLong() and 0xFFFFFFFFL)
    /** Keep a running track running: a little silence when it's about to run dry (between sentences, or before the engine has enough). */
    private fun quiet() {
        val t = track ?: return
        if (renew || t.playState != android.media.AudioTrack.PLAYSTATE_PLAYING || waiting(t) >= trackRate / 20) return
        val z = ByteArray(trackRate / 25 * 2 * trackCh); val n = t.write(z, 0, z.size, android.media.AudioTrack.WRITE_NON_BLOCKING)
        if (n > 0) written += n / (2 * trackCh)
    }
    private const val AHEAD_MS = 300
    /**
     * Play one sentence. What goes to the bridge as "what it's playing" is exactly what goes to the track, in the
     * same order, by this one thread: the engine's audio, and any silence put in where the engine fell behind. The
     * canceller can only take out what it was told was played; a gap it wasn't told about puts the rest out of step.
     */
    private fun playOne(u: Utter) {
        // Not before the engine is 0.3 s into it (or has made all of it): a sentence shouldn't have to wait for its own next piece.
        val began = System.currentTimeMillis()
        while (u.gen == gen && !u.done && (u.rate == 0 || u.got < u.rate.toLong() * 2 * u.channels * AHEAD_MS / 1000)) {
            if (System.currentTimeMillis() - began > 15000) return
            quiet(); Thread.sleep(10)
        }
        var first = -1L; var told = false; var taken = 0; var gaps = 0; var under0 = 0; var least = Long.MAX_VALUE; var t: android.media.AudioTrack? = null
        while (u.gen == gen) {
            var c = u.chunks.poll(10, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (c == null) { // the engine has no more yet
                val tt = t ?: continue
                if (!u.done && waiting(tt) < trackRate * 6 / 100) { // and the track is about to run dry: silence, and the bridge is told the same silence was played
                    val z = ByteArray(trackRate / 50 * 2 * trackCh); refAudio(u.id, z); write(tt, z, u); gaps++
                }
                continue
            }
            if (c === END) {
                if (taken > 0) break
                c = fromFile(u) ?: return // an engine that doesn't hand over its audio as it goes: what it wrote
            }
            val tt = trackFor(u.rate, u.channels) ?: return
            if (first < 0) {
                if (waiting(tt) <= 0) write(tt, ByteArray(trackRate * LEAD_MS / 1000 * 2 * trackCh), u) // nothing is playing: a little silence first
                first = written; under0 = tt.underrunCount
            } else least = minOf(least, waiting(tt))
            t = tt
            refAudio(u.id, c); write(tt, c, u); taken += c.size
            if (!told && u.gen == gen) { told = true; startsAt(u, tt, first) }
        }
        val tt = t ?: return
        val under = tt.underrunCount - under0 // the track ran dry part-way all the same (this thread was kept waiting): what came out isn't what the bridge was told
        if (under > 0 && u.gen == gen) { anchorFrame = -1; refOut.execute { o.post("/voice/ref/slip", JSONObject().put("id", u.id).put("underruns", under)) } }
        Log.d("Openhouse", "sentence ${u.id}: ${taken / (2 * trackCh) * 1000L / trackRate} ms said, never less than ${if (least == Long.MAX_VALUE) "-" else (least * 1000 / trackRate).toString()} ms ahead of the speaker, $gaps gaps filled with silence, the track ran dry $under times")
    }
    /** What the engine wrote to its file, for an engine that only does that (a plain 16-bit WAV). */
    private fun fromFile(u: Utter): ByteArray? = runCatching {
        val b = u.file?.readBytes() ?: return null
        fun le(i: Int, n: Int): Int { var v = 0; for (k in 0 until n) v = v or ((b[i + k].toInt() and 0xff) shl (8 * k)); return v }
        if (b.size <= 44 || String(b, 0, 4) != "RIFF" || le(34, 2) != 16) return null
        u.channels = le(22, 2).coerceIn(1, 2); u.rate = le(24, 4); refFmt[u.id] = intArrayOf(u.rate, u.channels)
        b.copyOfRange(44, b.size).also { u.got = it.size }
    }.getOrNull()
    // Where a sentence starts is counted from the one before when the track hasn't stopped in between: so many samples
    // later, exactly. Only the first after a pause is read off the clocks (good to a millisecond or two, no better).
    private var anchorFrame = -1L; private var anchorMic = 0.0; private var anchorUnder = 0; private var anchorMicRun = 0; private var lastSaid: String? = null
    /**
     * Tell the bridge at which microphone sample this sentence's first sample comes out of the speaker: the track
     * says which of its samples came out when, and the microphone (MicClock) which sample it captured when.
     */
    private fun startsAt(u: Utter, t: android.media.AudioTrack, first: Long) {
        val ts = android.media.AudioTimestamp(); var ok = false; var counted = false; var mic = -1L; var out = 0L
        if (anchorFrame >= 0 && t.underrunCount == anchorUnder && MicClock.run == anchorMicRun) {
            mic = Math.round(anchorMic + (first - anchorFrame) * 16000.0 / trackRate); ok = true; counted = true
            out = System.nanoTime() + waiting(t) * 1_000_000_000L / trackRate // (only for the log)
        } else {
            val until = System.nanoTime() + 300_000_000
            while (u.gen == gen) { // (for as long as there's a tenth of a second still waiting to come out: this thread is also the one that feeds it)
                if (t.getTimestamp(ts) && ts.framePosition > 0 && System.nanoTime() - ts.nanoTime < 100_000_000) { ok = true; break }
                if (System.nanoTime() > until || waiting(t) < trackRate / 10) break
                Thread.sleep(5)
            }
            // (No clock from the track: a guess, from how much is still to come out. The bridge then lines it up by ear.)
            out = if (ok) ts.nanoTime + (first - ts.framePosition) * 1_000_000_000L / trackRate else System.nanoTime() + waiting(t) * 1_000_000_000L / trackRate + 60_000_000
            mic = MicClock.at(out + android.os.SystemClock.elapsedRealtimeNanos() - System.nanoTime())
            if (ok && mic >= 0) { anchorFrame = first; anchorMic = mic.toDouble(); anchorUnder = t.underrunCount; anchorMicRun = MicClock.run } else anchorFrame = -1
        }
        val at = mic; val exact = ok; val after = if (counted) lastSaid else null; lastSaid = u.id
        refOut.execute { o.post("/voice/ref/start", JSONObject().put("id", u.id).put("at", at).put("exact", exact).apply { if (after != null) put("after", after) }) } // (after the audio made so far)
        Log.d("Openhouse", "sentence ${u.id} comes out in ${(out - System.nanoTime()) / 1_000_000} ms (${if (counted) "counted from the sentence before" else if (ok) "by the track's clock" else "a guess: the track gave no clock"}), at microphone sample $mic; $trackRate Hz, $trackCh channel(s)")
        val q = queuedAt.remove(u.id); val w = waitingSince // how long they waited in silence, for the speech log
        if (w > 0) { waitingSince = 0; val heard = System.currentTimeMillis() + (out - System.nanoTime()) / 1_000_000; o.vlog("first-sound", "${heard - w} ms after the request (engine ${q?.let { heard - it } ?: -1} ms)") }
    }
    private fun finished() {
        if (pending.decrementAndGet() > 0) return
        pending.set(0)
        // What's in the track still has to come out.
        val t = track; val g = gen; val until = System.currentTimeMillis() + 1500
        while (t != null && pending.get() == 0 && g == gen && System.currentTimeMillis() < until && (t.playbackHeadPosition.toLong() and 0xFFFFFFFFL) < written) Thread.sleep(10)
        if (pending.get() > 0 || g != gen) return // more was said meanwhile, or it was cut off
        Thread.sleep(60)
        o.ui {
            if (pending.get() > 0) return@ui
            o.speaking = false
            val cbs = idleCallbacks.toList(); idleCallbacks.clear()
            o.scope.launch { o.post("/voice/quiet"); cbs.forEach { it() } }
        }
    }
    fun say(text: String, about: String?) {
        if (Setup.hushed) return // the welcome and the setup say nothing aloud (nothing until it is over)
        val t = Answers.speakable(text); if (t.isEmpty()) return
        if (sink?.invoke(t) == true) return
        val e = tts ?: return
        if (!ttsReady) return
        val age = Regex("age\\s*(\\d+)", RegexOption.IGNORE_CASE).find(about ?: "")?.groupValues?.get(1)?.toIntOrNull()
        e.setSpeechRate(if (age != null && age < 10) 0.92f else 1.0f) // a little slower for young kids
        if (hushed) return // talked over: the rest of this answer stays on screen
        // It keeps listening while it talks: the bridge knows what it's saying, so other words are someone talking over it.
        // The room (RoomVolume), once per answer, so it never changes mid-sentence. A track can't go over its stream, so
        // here it only ever goes quieter (at night; without the live voice there's no microphone to hear the room).
        if (pending.getAndIncrement() == 0) { roomGain = RoomVolume.factor().toFloat().coerceAtMost(1f); runCatching { track?.setVolume(roomGain) } }
        o.postAsync("/voice/talking", JSONObject().put("text", t))
        o.ui { o.speaking = true }
        val id = "u${uttN++}"; queuedAt[id] = System.currentTimeMillis(); if (queuedAt.size > 50) queuedAt.clear()
        val u = Utter(id, gen).apply { file = java.io.File(cacheDir, "say-$id.wav") }
        utters[id] = u; line.add(u); startPlayer()
        if (e.synthesizeToFile(t, null, u.file, id) != android.speech.tts.TextToSpeech.SUCCESS) made(id)
    }
    /** Someone talked over it: it stopped, and doesn't say the rest of this answer. A new question clears it. */
    @Volatile var hushed = false
    /** When the last spoken request was taken (for "first-sound" in the speech log), and when each sentence was queued. */
    @Volatile var waitingSince = 0L
        set(v) { field = v; if (v > 0 && ttsReady) { warmUntil = System.currentTimeMillis() + 30_000; startPlayer() } }
    private val queuedAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    /** Once it has finished talking (now, if it isn't). */
    fun afterSpeaking(f: () -> Unit) = o.ui { if (!o.speaking && pending.get() == 0) o.scope.launch { f() } else idleCallbacks += f }
    fun stop() {
        idleCallbacks.clear()
        if (pending.get() > 0) {
            pending.set(0); gen++; renew = true
            val dropped = ArrayList<Utter>(); line.drainTo(dropped) // what hadn't started: never said
            for (u in dropped) { utters.remove(u.id); refFmt.remove(u.id); runCatching { u.file?.delete() } }
            for (id in utters.keys) made(id) // (the one being said: the player sees it's over)
            runCatching { track?.pause(); track?.flush() } // silent at once
            runCatching { tts?.stop() }
            val mic = MicClock.now(); refOut.execute { o.post("/voice/ref/stop", org.json.JSONObject().put("at", mic)) }
        }
        o.speaking = false
        o.postAsync("/voice/quiet")
    }
}
