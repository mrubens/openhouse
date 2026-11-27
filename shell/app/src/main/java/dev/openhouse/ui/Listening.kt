package dev.openhouse.ui

// Listening: what the microphone hears (the bridge's /voice/events), a tap on the assistant's note, and when it
// listens without its name (just after it answers, or after a tap). The regexes here only decide the moments
// the assistant can't: "stop" while it talks, and whether a few words right after an answer were for it.

import android.util.Log
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

internal object Listening {
    private val o = Openhouse
    private val armQ = java.util.concurrent.Executors.newSingleThreadExecutor().asCoroutineDispatcher()

    /** A reaction to an answer, not something to answer ("Okay.", "Cool."). Sign-offs ("Bye", "Thanks") do go to the assistant. */
    private val fillerRe = Regex("^\\W*(ok(ay)?|hmm+|mm+|uh+|um+|uh huh|cool|nice|great|wow|oh|ah|huh|alright|all right|right|yeah|yep|sure|got it|awesome|perfect)\\W*$", RegexOption.IGNORE_CASE)
    /** Only to interrupt it while it talks or works (it can't hear itself out). */
    private val stopRe = Regex("^(ok(ay)?,? )?(stop|stop it|stop that|stop talking|be quiet|quiet|shh+|cancel)\\W*$", RegexOption.IGNORE_CASE)

    /** Its answer ended in a question ("What's your zip code?"): then anyone in the room may answer it. */
    fun askedQuestion(t: String) = Answers.segments(t).filterIsInstance<Segment.Prose>().lastOrNull()?.text?.trimEnd()?.endsWith("?") == true

    /** Listen without the wake words for [ms] (0: stop). In order, so a stop never lands after a later start. */
    fun arm(ms0: Long, why: String, anyone: Boolean = false) {
        // While the typing box is open there's no hands-free follow-up: listening starts only from a tap, the box's own mic
        // (dictating) or the wake word.
        val ms = if (o.typing != null && why == "followup") 0 else ms0
        o.ui { o.handsFreeUntil = if (ms > 0 && why == "followup") System.currentTimeMillis() + ms else if (o.handsFreeUntil > System.currentTimeMillis()) 0 else o.handsFreeUntil }
        o.scope.launch(armQ) { o.post("/voice/arm", JSONObject().put("ms", ms).put("why", why).put("anyone", anyone)) }
    }

    /**
     * A tap on the note, one rule per state: talking → it stops talking; listening → it stops listening;
     * working on something → the list of what's in flight (stop any of it there); otherwise → it listens.
     */
    fun tapToTalk() {
        o.touch()
        if (o.typing != null && !o.dictating) { o.vlog("tap", "put typing away"); o.closeTyping(); return }
        val t = System.currentTimeMillis()
        // Words left showing from something that ended long ago (nothing came of it) are not someone talking now.
        if (!o.partial.isNullOrBlank() && t - o.hearingAt > 6000) o.partial = null
        val hearing = !o.partial.isNullOrBlank() || (o.hearingAt > 0 && t - o.hearingAt < 2500)
        val listening = o.awaitingUntil > t || o.handsFreeUntil > t || hearing
        if (o.speaking) { o.vlog("tap", "stop talking"); Speech.stop(); if (listening) { o.awaitingUntil = 0; arm(0, "tap") }; return }
        // Talking to it right now: the tap means "that's it" (take what was said), not "never mind".
        if (!o.partial.isNullOrBlank() || (o.hearingAt > 0 && t - o.hearingAt < 1500)) { o.vlog("tap", "done talking"); o.postAsync("/voice/done"); return }
        if (!listening && (o.inFlight.isNotEmpty() || o.build?.done == false)) { o.vlog("tap", "show what's in flight"); o.showJobs = true; return }
        o.vlog("tap", if (listening) "stop listening" else "listen")
        if (listening) {
            o.awaitingUntil = 0; o.hearingAt = 0; o.partial = null; o.onboarding = false; o.heard = null; o.quietAt = t; arm(0, "tap")
            o.scope.launch(armQ) { o.post("/voice/stop") } // its name said a moment ago counts no more, and what it was hearing is dropped
            return
        }
        // Talking to it is OpenAI's live voice (nothing on the tablet hears words); without it, a tap is for typing.
        if (liveHook?.invoke("", "tap", System.currentTimeMillis()) != true) o.openTyping()
    }

    /**
     * The typing box's mic: listen once, and the words land in the draft to fix before sending. Tapping it again
     * while someone is talking takes what was said; with nothing heard yet, it stops.
     */
    fun dictate() {
        o.touch()
        if (o.dictating) {
            if (!o.partial.isNullOrBlank()) { o.vlog("dictate", "done talking"); o.postAsync("/voice/done"); return }
            o.dictating = false; o.partial = null; arm(0, "tap"); return
        }
        o.scope.launch {
            val v = if (o.voice.listening) o.voice else o.loadVoiceStatus()
            if (v?.listening != true) return@launch
            Speech.stop()
            o.ui { o.dictating = true; o.partial = null }
            o.vlog("dictate", "listen")
            arm(15_000, "dictate")
            delay(15_000)
            o.ui { if (o.dictating && o.partial.isNullOrBlank()) o.dictating = false } // nobody spoke
        }
    }

    private fun onVoice(ev: JSONObject) {
        fun JSONObject.s(k: String) = optString(k).takeIf { has(k) && !isNull(k) && it.isNotEmpty() }
        when (ev.optString("type")) {
            // "Listening…" only when it is: after the wake words, or while armed (a tap, or a follow-up).
            // Other talk in the room is dropped unheard, so don't claim to be listening to it.
            "speech" -> if (ev.optBoolean("forMe")) { o.hearingAt = System.currentTimeMillis(); o.touch() }
            // Its name (the wake model, docs/wake-word.md): OpenAI's live voice hears the rest. (Only while it's on: otherwise
            // the microphone is off and nothing listens.)
            // (at: when the bridge heard it, on this tablet's clock: what's said from then on is kept for the session.)
            "wake" -> { o.touch(); Speech.stop(); liveHook?.invoke("", "wake", ev.optLong("at").takeIf { it > 0 } ?: System.currentTimeMillis()) }
            "say" -> ev.s("text")?.let { Speech.say(it, ev.s("who")) } // an app's words (kit say)
            // Talked over while it was talking: quiet at once, and listen to them.
            "barge" -> { o.vlog("talked-over"); Speech.hushed = true; Speech.stop(); o.hearingAt = System.currentTimeMillis(); o.touch() }
            "partial" -> {
                // Each update re-reads the whole utterance and usually grows; ignore a re-read that lost
                // most of what was there (a glitch), so the words don't flicker.
                val t = ev.optString("text").ifBlank { null }
                if (t != null && (o.partial == null || t.length >= (o.partial?.length ?: 0) * 0.6)) o.partial = t
                o.hearingAt = System.currentTimeMillis(); o.touch()
            }
            "heard" -> heard(ev, ev.s("who"))
            // What it was hearing turned out not to be for it (its own voice, the room): the words it showed go, and a
            // tap is no longer "done talking".
            "dropped" -> { o.partial = null; o.hearingAt = 0 }
            "echo" -> MicMode.set(ev.optBoolean("on")) // the bridge cancels echo itself now (or no longer): the microphone reopens to suit
            "recording" -> o.recordingUntil = if (ev.optBoolean("on")) ev.optLong("until", Long.MAX_VALUE) else 0
        }
    }

    /** OpenAI's live voice (shell LiveVoice): (what was heard, how: wake, tap or heard, when) → true when a session is starting. */
    @Volatile var liveHook: ((String, String, Long) -> Boolean)? = null

    private fun heard(ev: JSONObject, who: String?) {
        o.partial = null
        if (o.dictating) { // into the draft, not asked
            o.dictating = false; o.hearingAt = 0; arm(0, "tap")
            val words = ev.optString("command").trim()
            if (words.isNotEmpty()) o.draft = listOf(o.draft.trimEnd(), words).filter { it.isNotEmpty() }.joinToString(" ")
            o.vlog("dictated", words, who); return
        }
        o.hearingAt = 0
        val tapped = o.awaitingUntil > 0
        if (tapped) { o.awaitingUntil = 0; arm(0, "tap") } // one request per tap
        val cmd = ev.optString("command").trim()
        val via = ev.optString("via")
        // What they said over it: a reaction just stops it, anything else is the next thing to do.
        if (via == "barge" && (cmd.count { it.isLetter() } < 2 || fillerRe.matches(cmd))) { o.vlog("talked-over-filler", cmd, who); arm(Turns.HANDS_FREE_MS, "followup"); return }
        // After an answer the display keeps listening briefly for a follow-up. Only take it if it sounds like one:
        // the same person (when we know who asked), and real words.
        if (via == "followup" && !tapped) {
            val sameAsker = Turns.lastAsker == null || who == null || who == Turns.lastAsker
            // If the display just asked something ("What's your zip code?"), any reply counts, even a single word or a number.
            val askedUs = o.answer?.let { a -> a.ok && askedQuestion(a.text) } == true
            // Otherwise anything with words from the same voice ("Louder.", "And tomorrow?"), except a reaction ("Okay.", "Cool.").
            val ok = (sameAsker || askedUs) && cmd.any { it.isLetter() } && (askedUs || !fillerRe.matches(cmd))
            if (!ok) { Log.d("Openhouse", "follow-up ignored: $cmd"); o.vlog("ignored-followup", "$cmd (same voice: $sameAsker, asked a question: $askedUs)", who); o.ignored = Heard(who, cmd, System.currentTimeMillis()); return }
        }
        Turns.byName = via != "followup" && via != "barge"
        if (Turns.byName) Turns.wokeAt = System.currentTimeMillis() // someone said its name: a fresh start
        o.touch()
        o.heard = Heard(who, cmd.ifEmpty { "…" }, System.currentTimeMillis())
        // Right after a tap, a filler ("Um", "Huh?") isn't the question: keep listening for it.
        if (tapped && fillerRe.matches(cmd)) { o.vlog("filler", cmd, who); o.ui { o.awaitingUntil = System.currentTimeMillis() + 10_000 }; arm(10_000, "tap"); return }
        // OpenAI's live voice (the trial): its session listens and speaks from here; the question, if there was one, is asked as usual.
        val live = Turns.byName && via == "wake" && liveHook?.invoke(cmd, "heard", System.currentTimeMillis()) == true
        if (cmd.count { it.isLetter() } < 2) { // just its name ("Widget?"): a little chime, and it listens for the question
            o.vlog("name-only", null, who)
            // It's listening for the question now (the listener keeps its ears open 8 s after its name): the face shows it.
            o.ui { o.awaitingUntil = System.currentTimeMillis() + 8_000 }
            if (!live) runCatching { android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, 55).startTone(android.media.ToneGenerator.TONE_PROP_ACK, 160) }
            return
        }
        // "stop" while it talks or works: quiet at once, and it stops listening until someone wakes it again
        if (stopRe.matches(cmd) && (o.answer?.live == true || Speech.busy())) { o.vlog("stop", cmd, who); Speech.stop(); if (o.answer?.live == true) Turns.stopAnswer(); o.awaitingUntil = 0; arm(0, "tap"); o.onboarding = false; return }
        Speech.waitingSince = System.currentTimeMillis()
        Turns.ask(cmd, who, voice = true)
    }

    suspend fun events() {
        while (true) {
            runCatching {
                BridgeClient.lines(BridgeClient.open(o.bridgeUrl + "/voice/events").apply { connectTimeout = 3000; readTimeout = 0 }) { l ->
                    if (l.startsWith("data: ")) runCatching { JSONObject(l.removePrefix("data: ")) }.getOrNull()?.let { ev -> o.ui { onVoice(ev) } }
                }
            }.onFailure { Log.d("Openhouse", "voice events: $it") }
            delay(3000)
        }
    }
}
