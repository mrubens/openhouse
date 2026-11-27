package dev.openhouse.shell

// OpenAI's live voice, Opie cloud's voice (openhouse-cloud/docs/cloud-beta.md), off unless someone turned it on (Settings →
// Better voice). After its name is heard on the tablet, a full-duplex session takes the conversation: it listens while
// it talks, and someone can talk over it. It only listens and speaks. Every request is handed back here (OpenAI's
// "client delegation") and asked of the family's own assistant as usual; its answer is what the session says.
//
// The session runs in a hidden web view, over WebRTC with Chromium's own echo cancelling (it knows what it plays, so it
// doesn't hear itself). One of them has the microphone at a time (Samsung tablets give it to one recorder), so while the
// session connects (about 2 s), the tablet's own listening keeps it and keeps what's said, from a moment before the name
// on ("Hey Opie, add milk to the list" in one breath). Once the session can hear, that goes to it first, through the
// same audio track (WebRTC takes no audio any other way), with its pauses shortened until it has caught up; at the next
// pause the tablet lets go and the session's own microphone takes over. Nothing is kept anywhere else. Our service
// starts each session with OpenAI (the key stays there) and gets back OpenAI's half of the connection; audio then goes
// between the tablet and OpenAI. It ends 8 s after anyone last talked, counted here and only once nothing is being
// worked on (a tool, a web search) and its voice has finished playing (OpenAI's own idle timer counts a web search as
// quiet, and once closed a session mid-answer, so it's only a backstop at 60 s), or after 5 minutes in all.
//
// What was said, heard and looked up goes to the bridge too (POST /live/said, kept there for half an hour and never
// sent anywhere on its own), so the next conversation starts knowing what was just talked about.
//
// With the household's tools (bridge/live-tools.js: calendar, lists, chores and stars, meals, notes, the weather, the
// TV and the apps' own actions), OpenAI's model answers, calling them here; the tools change the same data typed turns do. Without them (an older bridge), every request is handed to the assistant.

import android.annotation.SuppressLint
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import dev.openhouse.ui.Listening
import dev.openhouse.ui.Openhouse
import dev.openhouse.ui.Speech
import org.json.JSONObject
import kotlin.concurrent.thread

internal object LiveVoice {
    private const val TAG = "LiveVoice"
    private const val ORIGIN = "https://live.openhouse.invalid/"
    private const val MAX_MS = 5 * 60_000L
    /** The family chose OpenAI's live voice (CloudSetup asks the bridge once a minute). The microphone and the wake
     *  model run only while it's on: with nothing to hear the request, nothing listens for the name (MainActivity.micWanted). */
    @Volatile var chosen = false
        set(v) { val was = field; field = v; if (was != v) onChosen?.invoke(v) }
    @Volatile var onChosen: ((Boolean) -> Unit)? = null
    /** A session is open. */
    val active: Boolean get() = web != null || pretending
    /** On an emulator (adb: ConfigReceiver's liveMood), a session's look without one, so each state can be seen and
     *  screenshotted: the mood, and levels that move as a voice would. "off" ends it. */
    @Volatile private var pretending = false
    fun pretend(m: String) = main.post {
        if (m == "off") { pretending = false; mood = null; caption = ""; return@post }
        if (m.startsWith("problem:")) { trouble(m.removePrefix("problem:")); return@post }
        val was = pretending; pretending = true; mood = m
        if (!was) thread { var t = 0.0; while (pretending) { t += 0.08; val v = (0.5 + 0.5 * kotlin.math.sin(t * 5)).toFloat()
            if (mood == "talking") dev.openhouse.ui.OutLevel.set(0.02f + 0.12f * v) else dev.openhouse.ui.MicLevel.set(if (mood == "hearing") 0.004f + 0.05f * v else 0.0025f); Thread.sleep(80) } }
    }
    /** While a session runs, what it's doing, from its own events (the assistant's face and bubble: Buddy):
     *  listening, hearing (someone's talking), thinking (it handed the request over, nothing said yet), talking. Null: no session. */
    @Volatile var mood: String? = null; private set
    /** What it's saying or last said in this session (its output transcript), for the bubble. */
    @Volatile var caption = ""; private set
    @Volatile private var web: WebView? = null
    @Volatile private var act: MainActivity? = null
    @Volatile private var startedAt = 0L
    /** session.started came and the data channel is open: answers can go to it. */
    @Volatile private var ready = false
    @Volatile private var idleS = 8
    /** When its name was heard (or the tap): the log's timings ("t+… ms") count from here. */
    @Volatile private var t0 = 0L
    private fun mark(what: String) = Log.i(TAG, "t+${System.currentTimeMillis() - t0} ms $what")
    /** What's said is being kept (the tablet's listening still has the microphone) and, once it can hear, fed to the session. */
    @Volatile private var buffering = false
    @Volatile private var feeding = false
    @Volatile private var handed = false
    private val kept = java.io.ByteArrayOutputStream()
    @Volatile private var setupTask: java.util.concurrent.FutureTask<JSONObject?>? = null
    /** Words to say, waiting for the session to be able to talk. */
    private val held = mutableListOf<String>()
    private fun flush() {
        val w = web ?: return
        if (!ready) return
        val t = synchronized(held) { held.toList().also { held.clear() } }
        t.forEach { w.evaluateJavascript("say(${JSONObject.quote(it)})", null) }
    }
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    fun install(a: MainActivity) {
        // A question said with its name ("Hey Opie, how's it going?") is asked as usual and the session only says the answer,
        // so it waits longer for it before its standby (the family's assistant can take several seconds).
        // Just its name: the chime waits until the session can hear (it takes a couple of seconds to connect, and the
        // tablet's own listening has let go of the microphone by then), so nobody speaks into the gap.
        Listening.liveHook = { cmd, how, at ->
            if (!chosen) false
            else if (web != null) true // (already listening)
            else { val asked = cmd.count { it.isLetter() } >= 2; main.post { start(a, asked, how = how, at = at) }; true }
        }
        Listening.liveEndHook = { if (web != null) { end("closed with the AI key"); true } else false }
        // The web view's first start loads Chromium (a few hundred ms): done once now, not while someone waits.
        main.postDelayed({ runCatching { WebView(a).destroy() } }, 5000)
        // With the live voice on, it's the only voice: nothing falls back to the tablet's own. Whatever is to be said
        // (answers, reminders, an app's words) waits here until a session can talk; with none open, a short one opens
        // just to say it, which then listens for the usual few seconds and goes to standby. If it can't, the bubble says so.
        Speech.sink = { text -> if (!chosen) false else if (dev.openhouse.ui.Setup.hushed) true /* the setup is quiet throughout */ else {
            synchronized(held) { held.add(text) }
            main.post { if (web == null) start(a, false, how = "say") else flush() }
            true
        } }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun start(a: MainActivity, asked: Boolean, how: String, at: Long = System.currentTimeMillis()) {
        if (web != null || dev.openhouse.ui.Setup.hushed) return // (the welcome and the setup open no microphone)
        val now = System.currentTimeMillis()
        act = a; startedAt = now; t0 = if (how == "say") now else minOf(at, now); ready = false; idleS = 8
        mark(if (how == "say") "opening to say something" else "starting ($how)")
        // From its name on, what's said is kept until the session can hear it (from 0.7 s before the wake model fired,
        // which is a moment after the name ends, so nothing after it is lost); a tap keeps from the tap.
        synchronized(kept) { kept.reset() }
        feeding = false; handed = false
        buffering = how != "say" && a.listenOn && a.micHeld()
        if (buffering) {
            if (how == "wake") synchronized(kept) { kept.write(a.micRecent((now - t0 + 700).toInt().coerceIn(700, 3000))) }
            a.micTap { b, n -> keepOrFeed(b, n) }
        }
        // Heard: a chime at once (it's listening from now on; nobody waits for it to connect).
        if (how != "say") runCatching { android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, 55).startTone(android.media.ToneGenerator.TONE_PROP_ACK, 120) }
        // What the session starts with (the household's tools and rules), asked for now, alongside the page.
        setupTask = java.util.concurrent.FutureTask { runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("${a.bridge}/live/setup?how=$how", 2000, 5000)) }.getOrNull() }.also { thread { it.run(); mark("setup fetched") } }
        volumeIn(a)
        watchMode(a, true)
        holdFocus(a, true)
        // Android's call mode from the start, once: the session's microphone (handOff, a few seconds in) used to switch it,
        // and that came just before the first reply and swallowed its first words (the log: "audio mode 3" ~1 s before
        // "reply 1: voice"). After the chime, so the chime isn't cut.
        main.postDelayed({ if (web != null && act === a) callMode(a, true) }, 160)
        mood = "listening"; caption = ""
        val w = WebView(a)
        w.settings.javaScriptEnabled = true
        w.settings.mediaPlaybackRequiresUserGesture = false
        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(r: PermissionRequest) {
                if (r.origin.toString().startsWith(ORIGIN.trimEnd('/')) && PermissionRequest.RESOURCE_AUDIO_CAPTURE in r.resources) r.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else r.deny()
            }
        }
        // Its renderer going (it's the app's one renderer, shared with the home screen) must not end the app: the session
        // ends (RendererGone), and the next wake word opens a new one.
        w.webViewClient = object : android.webkit.WebViewClient() {
            override fun onRenderProcessGone(v: WebView, d: android.webkit.RenderProcessGoneDetail?): Boolean {
                RendererGone.drop(TAG, "the live voice", v, d)
                if (web === v) end("its page's renderer went", dead = true)
                return true
            }
        }
        w.addJavascriptInterface(Host(), "Host")
        a.root.addView(w, FrameLayout.LayoutParams(1, 1))
        web = w
        // The connection starts at once; the microphone comes later (handOff).
        w.loadDataWithBaseURL(ORIGIN, page(a), "text/html", "utf-8", null)
        main.postDelayed({ if (web === w) end("five minutes") }, MAX_MS)
    }

    /** What the tablet's listening just heard, while it's kept: held until the session can hear, then sent on as it comes. */
    private fun keepOrFeed(b: ByteArray, n: Int) {
        val chunk = synchronized(kept) { kept.write(b, 0, n); if (!feeding) null else kept.toByteArray().also { kept.reset() } }
        if (chunk != null) feed(chunk)
    }
    private fun feed(pcm: ByteArray) {
        val w = web ?: return
        val b64 = android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP)
        main.post { if (web === w) w.evaluateJavascript("feed('$b64')", null) }
    }
    /** The session's own microphone takes over: one recorder at a time on Samsung tablets, so the tablet's listening lets
     *  go first (Voice.pauseAndRelease; a read can take up to 100 ms to return), and what it heard last goes before. */
    private fun handOff(why: String) {
        val a = act ?: return
        val w = web ?: return
        if (handed) return
        handed = true
        thread {
            val free = a.micReleased(2000)
            if (!free) Log.w(TAG, "the tablet's listening didn't let go of the microphone in 2 s")
            a.micTap(null)
            val rest = synchronized(kept) { kept.toByteArray().also { kept.reset() } }
            if (buffering && feeding && rest.isNotEmpty()) feed(rest)
            buffering = false; feeding = false
            mark("microphone to the session ($why)")
            main.post { if (web === w) w.evaluateJavascript("goLive()", null) }
        }
    }

    /** [dead]: its page's renderer went, so the view is destroyed already and nothing more is said to it. */
    private fun end(why: String, dead: Boolean = false) = main.post {
        val w = web ?: return@post
        if (Buddy.working()) Buddy.stopWorking() // told to stop (or tapped) while it used an app: that stops too
        val wasReady = ready
        val left = synchronized(held) { held.size.also { held.clear() } }
        if (left > 0 && wasReady) trouble("The live voice ended before it could say this.")
        web = null; ready = false; mood = null; caption = ""
        act?.micTap(null); buffering = false; feeding = false; synchronized(kept) { kept.reset() }
        if (!wasReady && !toldWhy && why != "microphone turned off" && why != "tapped away") trouble("The live voice couldn't connect. Try again in a moment.")
        toldWhy = false
        Log.i(TAG, "ended ($why) after ${(System.currentTimeMillis() - startedAt) / 1000} s")
        Openhouse.vlog("live-ended", "$why after ${(System.currentTimeMillis() - startedAt) / 1000} s") // the speech log outlives logcat
        if (!dead) {
            w.evaluateJavascript("stop()", null)
            main.postDelayed({ runCatching { (w.parent as? android.view.ViewGroup)?.removeView(w); w.destroy() } }, 500)
        }
        // Call mode goes once its WebRTC has let go, and only then does the tablet's own listening open the microphone again:
        // opened while still in call mode (the Galaxy Tab A11), it stayed on the call's path, ~10x quieter and without
        // echo cancelling, and no "Hey Opie" got past the wake model's loudness floor until it was next reopened.
        act?.let { volumeOut(it); watchMode(it, false); val ma = it; main.postDelayed({ if (web == null) { callMode(ma, false); holdFocus(ma, false); ma.micPaused(false) } }, 600) }
    }

    /** What went wrong with the live voice just now, for the bubble (Buddy), and when. */
    @Volatile var problem = ""; private set
    @Volatile var problemAt = 0L; private set
    /** Why this start failed was said already (out of credit): end() doesn't say "couldn't connect" over it. */
    @Volatile private var toldWhy = false
    private fun trouble(text: String) { Log.i(TAG, "problem: $text"); problem = text; problemAt = System.currentTimeMillis() }
    fun putProblemAway() { problem = "" }
    fun problemNow(now: Long) = problem.takeIf { it.isNotEmpty() && now - problemAt < 15_000 }

    /** The microphone switch was turned off (Settings): a session going now ends. */
    fun stopNow() { if (web != null) end("microphone turned off") }
    /** Someone tapped Opie while it was open: it goes away now (the conversation ends, as if they said goodbye). */
    fun tappedAway() { if (web != null) end("tapped away") }

    // One volume for both voices, done in software. WebRTC plays on the call stream, which on Samsung tablets is much
    // louder a step than media and can't go below 1, so the call stream is held at one fixed level for the session (the
    // reference, LIVE_CALL_SHARE of its range: about as loud as media at full) and the page scales the session's audio by
    // the household's volume, the media stream's share, on a curve so the low steps are really quiet and 0 is silent.
    // The volume keys turn the media stream as always (MainActivity.dispatchKeyEvent sends them here), and the page follows.
    private const val LIVE_CALL_SHARE = 0.5f
    /** Android's audio mode (normal, call...) as it changes during a session, for the log: a change can cut off a moment of sound. */
    private var modeListener: Any? = null
    private fun watchMode(a: MainActivity, on: Boolean) = runCatching {
        if (android.os.Build.VERSION.SDK_INT < 31) return@runCatching
        val am = audio(a)
        (modeListener as? android.media.AudioManager.OnModeChangedListener)?.let { am.removeOnModeChangedListener(it) }; modeListener = null
        if (on) {
            mark("audio mode ${am.mode}")
            val l = android.media.AudioManager.OnModeChangedListener { m -> mark("audio mode $m"); Openhouse.vlog("live-audio-mode", "$m at t+${System.currentTimeMillis() - t0} ms") }
            am.addOnModeChangedListener(a.mainExecutor, l); modeListener = l
        }
    }.onFailure { Log.w(TAG, "audio mode: $it") }
    /** Android's audio focus for the conversation, as an assistant (transient): whatever was playing (music, a book, a
     *  podcast) pauses while someone talks to Opie and carries on after, as the apps themselves do it. Something Opie
     *  starts during the conversation takes the focus over, and keeps playing. */
    private var focus: android.media.AudioFocusRequest? = null
    private fun holdFocus(a: MainActivity, on: Boolean) = runCatching {
        SpotifyEmbed.holdForVoice(on) // (Spotify's player on Home is a page of Opie's own: Android's focus doesn't pause it)
        val am = audio(a)
        if (on) {
            if (focus != null) return@runCatching
            val f = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener({ }, main).build()
            focus = f; mark("audio focus ${am.requestAudioFocus(f)}")
        } else focus?.let { am.abandonAudioFocusRequest(it); focus = null }
    }.onFailure { Log.w(TAG, "audio focus: $it") }
    /** Call mode (MODE_IN_COMMUNICATION) for the session, and back to what it was after; only if this set it. */
    private var modeBefore = -1
    private fun callMode(a: MainActivity, on: Boolean) = runCatching {
        val am = audio(a); val CALL = android.media.AudioManager.MODE_IN_COMMUNICATION
        if (on) { if (modeBefore < 0 && am.mode != CALL) { modeBefore = am.mode; am.mode = CALL; mark("call mode from the start") } }
        else if (modeBefore >= 0) { if (am.mode == CALL) am.mode = modeBefore; modeBefore = -1 }
    }.onFailure { Log.w(TAG, "call mode: $it") }
    private var callBefore = -1
    @Volatile private var gain = 1.0
    private fun audio(a: MainActivity) = a.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
    private fun share(am: android.media.AudioManager): Float { val M = android.media.AudioManager.STREAM_MUSIC; return am.getStreamVolume(M).toFloat() / am.getStreamMaxVolume(M).coerceAtLeast(1) }
    private fun volumeIn(a: MainActivity) = runCatching {
        val am = audio(a); val C = android.media.AudioManager.STREAM_VOICE_CALL
        callBefore = am.getStreamVolume(C)
        // The room (RoomVolume): worked out once, as the session opens, so it doesn't change while it talks. Over full, the
        // call stream goes a step up for each 3 dB the page can't give (about a step's worth on Samsung tablets).
        room = dev.openhouse.ui.RoomVolume.factor()
        val over = (curve(share(am)) * room).takeIf { it > 1.0 }?.let { kotlin.math.ceil(20 * kotlin.math.log10(it) / 3).toInt() } ?: 0
        val ref = kotlin.math.round(a.getSharedPreferences("shell", android.content.Context.MODE_PRIVATE).getFloat("liveCallShare", LIVE_CALL_SHARE) * am.getStreamMaxVolume(C)).toInt() + over
        am.setStreamVolume(C, ref.coerceIn(am.getStreamMinVolume(C), am.getStreamMaxVolume(C)), 0)
        lifted = Math.pow(10.0, (am.getStreamVolume(C) - (ref - over).coerceIn(am.getStreamMinVolume(C), am.getStreamMaxVolume(C))) * 3 / 20.0)
        Log.i(TAG, "volume: call held at ${am.getStreamVolume(C)}/${am.getStreamMaxVolume(C)} (room x%.2f, %d over)".format(room, over))
        setGain(share(am))
    }.onFailure { Log.w(TAG, "volume: $it") }
    private fun volumeOut(a: MainActivity) = runCatching {
        if (callBefore < 0) return@runCatching
        audio(a).setStreamVolume(android.media.AudioManager.STREAM_VOICE_CALL, callBefore, 0); callBefore = -1; room = 1.0; lifted = 1.0
    }.onFailure { Log.w(TAG, "volume: $it") }
    /** The room's adjustment for this session (RoomVolume): 1 is the household's volume as it is. */
    @Volatile private var room = 1.0
    /** About how much louder the call stream was put than its reference for the room (the page gives the rest). */
    @Volatile private var lifted = 1.0
    // About 8 dB over the cube (to at most full): music is mixed far louder than a voice, so at one volume Opie was
    // much quieter than the music it had just paused (the user).
    private fun curve(share: Float) = share.toDouble().let { (it * it * it * 2.5).coerceAtMost(1.0) }
    /** The household's volume share (0..1) as the session's loudness: cubed, about how loudness is heard; 0 is silent. */
    private fun setGain(share: Float) {
        gain = (curve(share) * room / lifted).coerceAtMost(1.0)
        Log.i(TAG, "volume: gain %.3f (share %.2f, room x%.2f)".format(gain, share, room))
        web?.let { w -> main.post { w.evaluateJavascript("setGain($gain)", null) } }
    }
    /** A volume key while a session runs: the media stream (the household's volume) turns, with its usual slider, and
     *  the session follows. False: no session, the key does what it always does. */
    fun volumeKey(a: MainActivity, up: Boolean): Boolean {
        if (web == null) return false
        val am = audio(a)
        am.adjustStreamVolume(android.media.AudioManager.STREAM_MUSIC, if (up) android.media.AudioManager.ADJUST_RAISE else android.media.AudioManager.ADJUST_LOWER, android.media.AudioManager.FLAG_SHOW_UI)
        setGain(share(am))
        return true
    }

    private fun post(path: String, body: JSONObject, readMs: Int = 30_000): JSONObject? {
        val a = act ?: return null
        val (_, r) = CloudSetup.post("${a.bridge}$path", body, readMs)
        return r
    }

    private class Host {
        @JavascriptInterface fun offer(sdp: String) = thread {
            mark("offer made")
            val setup = runCatching { setupTask?.get(6, java.util.concurrent.TimeUnit.SECONDS) }.getOrNull()
            // An app in use hands-free (cooking: bridge live-tools.js quietS) keeps the session a while longer after the last
            // words, so "next" works without the name; then it ends as usual and the name is needed again.
            setup?.optInt("quietS", 0)?.takeIf { it > idleS }?.let { idleS = it.coerceAtMost(30); mark("hands-free: ending ${idleS} s after the last words") }
            val body = JSONObject().put("sdp", sdp).put("name", Openhouse.assistantName).put("idleTimeoutS", 60)
            if (setup != null) body.put("instructions", setup.optString("instructions")).put("tools", setup.optJSONArray("tools"))
                .put("earlier", setup.optJSONArray("earlier") ?: org.json.JSONArray())
            val r = post("/cloud/live/start", body)
            mark("cloud answered")
            // Out of Opie credit (the cloud's credits.ts): said as that, not as "couldn't connect".
            if (r?.optString("code") == "over_credit") { trouble(r.optString("error")); toldWhy = true }
            val w = web ?: return@thread
            main.post { w.evaluateJavascript("answer(${JSONObject.quote((r ?: JSONObject().put("error", "the tablet's software didn't answer")).toString())})", null) }
        }
        /** It handed a request over: the family's assistant answers it as if it had been asked aloud. */
        @JavascriptInterface fun delegated(text: String) { val q = text.trim(); if (q.isNotEmpty()) main.post { Openhouse.ask(q, null, voice = true) } }
        /** Its text model called one of the household's tools: run it. */
        @JavascriptInterface fun tool(delegationId: String, callId: String, name: String, args: String) = thread {
            val a = runCatching { JSONObject(args) }.getOrDefault(JSONObject())
            // (a tool may wait on a person: the camera asks on screen first, up to 30 s, then takes its picture)
            val out = post("/live/tool", JSONObject().put("name", name).put("args", a), 200_000)?.optString("text") ?: "That didn't work."
            Openhouse.vlog("live-tool-call", "$name ${a.toString().take(400)} -> ${out.take(300)}")
            if (name == "volume") act?.let { ma -> runCatching { setGain(share(audio(ma))) } } // (the session's loudness follows the household's volume) // what it asked for and what came back, so a bad moment can be traced
            val w = web ?: return@thread
            main.post { w.evaluateJavascript("toolResult(${JSONObject.quote(delegationId)}, ${JSONObject.quote(callId)}, ${JSONObject.quote(out.take(6000))})", null) }
        }
        /** backend: what its text model used (JSON from live-session.cjs), billed apart from the seconds. */
        @JavascriptInterface fun usage(sessionId: String, seconds: Double, backend: String) {
            if (sessionId.isNotEmpty()) thread { post("/cloud/live/usage", JSONObject().put("sessionId", sessionId).put("seconds", seconds).put("backend", runCatching { JSONObject(backend) }.getOrNull())) }
        }
        @JavascriptInterface fun log(text: String) { Log.i(TAG, text.take(600)) }
        @JavascriptInterface fun level(mic: Double, out: Double) { dev.openhouse.ui.MicLevel.set(mic.toFloat()); dev.openhouse.ui.OutLevel.set(out.toFloat()) }
        @JavascriptInterface fun gain() = LiveVoice.gain
        /** The microphone switch: off, the session only speaks (its microphone track sends silence). */
        @JavascriptInterface fun listening() = act?.listenOn ?: true
        @JavascriptInterface fun state(m: String, said: String) { if (web != null) { mood = m; caption = said.takeLast(600) } }
        @JavascriptInterface fun ready(on: Boolean) {
            val was = ready
            ready = on && web != null
            if (ready && !was) {
                main.post { flush() }
                // What was said meanwhile goes to it now, then as it comes; at the latest 10 s on, the session's microphone takes over.
                if (buffering && !feeding) {
                    val all = synchronized(kept) { feeding = true; kept.toByteArray().also { kept.reset() } }
                    mark("can hear: ${all.size / 32} ms kept go first")
                    feed(all)
                    val w = web
                    main.postDelayed({ if (buffering && web === w && w != null) handOff("10 s") }, 10_000)
                } else mark("can hear")
            }
        }
        /** How the page gets its microphone: buffer (what the tablet kept comes first), direct (at once), none (switched off). */
        @JavascriptInterface fun mode() = if (act?.listenOn == false) "none" else if (buffering) "buffer" else "direct"
        /** It caught up with what was kept (or started talking): its own microphone now. */
        @JavascriptInterface fun handoff(why: String) { handOff(why) }
        @JavascriptInterface fun mark(what: String) { LiveVoice.mark(what) }
        /** What it was given to say and hadn't said when it ended: the tablet says it. */
        @JavascriptInterface fun unsaid(text: String) { if (text.isNotBlank()) { Log.i(TAG, "unsaid: ${text.length} chars"); trouble("The live voice ended before it could say this.") } }
        @JavascriptInterface fun ended(why: String) { end(why) }
        /** How a request went, to the speech log: handed to its text model, a tool asked for, the text model failing. */
        @JavascriptInterface fun note(event: String, text: String) { Log.i(TAG, "$event: ${text.take(300)}"); Openhouse.vlog(event, text.take(300)) }
        /** A request it handed over got no answer before the session ended: said on the screen, and in the speech log. */
        @JavascriptInterface fun unanswered(text: String) { Openhouse.vlog("live-unanswered", text.takeLast(300)); trouble("Opie didn't get an answer for that. Try asking again.") }
        /** What it heard or said, or a tool its text model used, to the tablet's speech log (kept on the tablet, and only
         *  while someone has it on: bridge voice.js), so a conversation that went wrong can be read afterwards. */
        @JavascriptInterface fun said(event: String, text: String) {
            if (text.isBlank()) return
            Openhouse.vlog(event, text.trim().takeLast(300))
            val role = when (event) { "live-heard" -> "user"; "live-said" -> "assistant"; else -> "tool" }
            val body = JSONObject().put("role", role).put("text", text.trim().takeLast(2000))
            if (role != "user") { Openhouse.postAsync("/live/said", body); return }
            // What they said may be wanting it over (the bridge asks a small model): it stops listening, says goodbye, and goes.
            val w = web
            thread { if (post("/live/said", body)?.optBoolean("end") == true) main.post { if (web != null && web === w) { Openhouse.vlog("live-go-away", text.trim().takeLast(80)); w?.evaluateJavascript("leave()", null) } } }
        }
        /** Seconds of quiet, with nothing in the works, before it ends. */
        @JavascriptInterface fun idle() = idleS
    }

    // The session's page: chat/live/live-session.cjs, the one copy the tablet and every browser run (a phone or laptop
    // on the household's hub: chat/src/live-voice.js, docs/hub.md). Its events: https://developers.openai.com/api/docs/guides/live
    // (WebRTC, client delegation). It talks to this file through Host, above.
    private fun page(a: MainActivity) = "<!doctype html><meta charset=\"utf-8\"><script>\n" +
        a.assets.open("live-session.cjs").bufferedReader().use { it.readText() } + "\n</script>"
}
