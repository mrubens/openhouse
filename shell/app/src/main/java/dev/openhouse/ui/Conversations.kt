package dev.openhouse.ui

// Asking: each question is one conversation turn, streamed from the bridge (POST /chat, NDJSON events). A turn
// answers on the assistant's note (Openhouse.answer) or in the open conversation screen; a newer one from
// someone else can take the note while an older one finishes in the background.
//
//  - Stop closes the turn's connection (the bridge stops the turn when it does), so it stops at once.
//  - What someone says or types while their turn is still going is queued, per person, and asked next.
//  - A BUILD line in an answer changes the app that was open when it was asked (or makes a new one).
//
// Also the agent at work from the builder (bridge /events): its steps, then what it did.

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedDeque

internal object Turns {
    private val o = Openhouse

    /** One turn in flight: its coroutine, its connection (closed to stop it), and its conversation once known. */
    private class Running(val job: Job) { @Volatile var conn: HttpURLConnection? = null; @Volatile var convo: String? = null }
    private val running = ConcurrentHashMap<Long, Running>()
    /** The turn in the conversation screen, if one is going. */
    @Volatile private var screenTurn: Long? = null

    /** Asked while that person's turn was still going: theirs next, in order (typed or spoken). Per person, so one
     *  person's background turn never takes another's next question. */
    private data class Next(val text: String, val voice: Boolean)
    private val queued = ConcurrentHashMap<String, ConcurrentLinkedDeque<Next>>()
    private fun queueOf(who: String?) = queued.getOrPut(who ?: "") { ConcurrentLinkedDeque() }
    /** Take [who]'s next queued question, if any. */
    private fun nextFor(who: String?): Next? = queued[who ?: ""]?.pollFirst()

    /** An app crashed (the shell says so): the next request about it carries the crash, so "fix it" works. */
    val crashes = ConcurrentHashMap<String, String>()
    /** Whoever asked last (a follow-up must sound like the same voice). */
    @Volatile var lastAsker: String? = null
    /** When someone last said its name (not a hands-free follow-up). */
    @Volatile var wokeAt = 0L
    /** This request came with its name (or right after its name alone), not as a follow-up to an answer. */
    @Volatile var byName = false

    private const val SPEAK_MAX = 3 // sentences read out; the rest stays on screen
    /** Woken again this soon after an answer, it's the same conversation ("and tomorrow?"). */
    private const val FOLLOW_UP_MS = 5 * 60_000L
    /** After it answers: how long it waits for them to start a follow-up. Short, so when they're done talking it stops listening. */
    const val HANDS_FREE_MS = 8_000L

    val undoRe = Regex("^(please )?(undo|undo (that|it|this|the last (change|thing))|change it back|put it back( how it was)?|revert( that| it)?)( please)?[.!]*$", RegexOption.IGNORE_CASE)

    fun firstSentence(t: String) = (Regex("^.*?[.!?](\\s|$)").find(t.replace(Regex("\\s+"), " "))?.value ?: t).trim().trimEnd('.', '!', '…').take(90)
    private fun prose(t: String) = Answers.segments(t).filterIsInstance<Segment.Prose>().joinToString(" ") { it.text }

    /**
     * One turn, streamed: POST /chat with [body], each event to [onEvent]. Blocking. The connection is kept with
     * the turn [id], so stopping it closes the connection. Returns false if the bridge couldn't be reached (then
     * [error] says why).
     */
    private fun stream(id: Long, body: JSONObject, onEvent: (JSONObject) -> Unit, error: (Exception) -> Unit) {
        try {
            val c = BridgeClient.open(o.bridgeUrl + "/chat").apply {
                requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 900_000
                setRequestProperty("content-type", "application/json")
            }
            running[id]?.conn = c
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            BridgeClient.lines(c) { line -> runCatching { JSONObject(line) }.getOrNull()?.let(onEvent) }
        } catch (e: CancellationException) { throw e
        } catch (e: Exception) { if (running.containsKey(id)) error(e) } // closed by Stop: not an error
    }

    /** Stop one turn: close its connection (the bridge stops it), cancel it, and tell the bridge by its conversation too. */
    fun stop(id: Long) {
        val r = running.remove(id) ?: return
        runCatching { r.conn?.disconnect() }
        r.job.cancel()
        r.convo?.let { o.postAsync("/chat/stop", JSONObject().put("id", it)) }
    }

    /** Stop the turn being answered on screen (the conversation screen's, or the note's). */
    fun stopAnswer() {
        queued.clear()
        val id = screenTurn?.takeIf { o.showConversation } ?: o.answer?.turnId
        id?.let { stop(it) }
        Speech.stop()
    }

    /** Stop one thing it's working on (the list of what's in flight). */
    fun stopJob(id: Long) {
        val j = o.inFlight.firstOrNull { it.id == id } ?: return
        o.vlog("stop-job", j.question, j.who)
        stop(id)
        if (o.answer?.turnId == id) Speech.stop()
        o.inFlight = o.inFlight.filter { it.id != id }
        if (o.inFlight.isEmpty() && o.build?.done != false) o.showJobs = false
    }

    /** "Undo that": put back the latest change the agent made. */
    fun undo(voice: Boolean = false) {
        o.touch()
        o.scope.launch {
            val r = o.post("/undo")?.let { runCatching { JSONObject(it) }.getOrNull() }
            val msg = r?.optString("undid")?.takeIf { it.isNotEmpty() }?.let { "Okay, I undid “$it”." } ?: "There’s nothing to undo."
            o.ui { o.heard = Heard(null, msg, System.currentTimeMillis()); if (voice) Speech.say(msg.replace("“", "").replace("”", ""), null) }
        }
    }

    /** No network at all: thinking needs the internet, so it says so right away (the Wi-Fi button is by its face). */
    private fun offline(q: String, who: String?, voice: Boolean) {
        o.touch(); o.typing = null; o.draft = ""; Speech.stop()
        val msg = "I'm not on the internet, so I can't answer yet. Connect me to Wi-Fi with the button by my face."
        o.vlog("ask", "$q (offline)", who)
        o.answer = Answer(q, o.person(who)?.name, text = msg, live = false, ok = false, voice = voice, at = System.currentTimeMillis())
        if (voice) { Speech.say(msg, o.person(who)?.note); Speech.afterSpeaking { Listening.arm(0, "followup") } }
    }

    fun ask(text: String, who: String?, voice: Boolean = false) {
        val q = text.trim()
        if (q.isEmpty()) return
        // Someone else woke it ("hi Widget") while it's busy with another person's request, or right after: a new
        // conversation of their own. The other one carries on in the background and still finishes.
        // Only when they said its name for this: a follow-up to its answer carries on the same conversation, whoever's
        // voice it is (most voices aren't recognized, and an unknown voice used to count as someone else every time).
        // Someone else only when both voices are known and differ: a voice it only guessed counts as theirs, and an
        // unknown one is whoever is in the room (it used to count as someone else, so every "hey Opie" started over).
        val woke = voice && byName && System.currentTimeMillis() - wokeAt < 20_000
        val voiceNow = who ?: o.speaker?.takeIf { System.currentTimeMillis() - it.at < 5_000 }?.name
        val before = o.answer?.who
        val someoneElse = woke && voiceNow != null && before != null && voiceNow != before
        // The same person talking or typing while it works: the next thing to do, once this turn ends (never dropped).
        if (o.answer?.live == true && !someoneElse) {
            // The same thing again while it's already on it (a button tapped twice, said twice): once is enough.
            if (q == o.answer?.question || queueOf(o.answer?.who).any { it.text == q }) { o.vlog("already-asked", q, who); return }
            o.vlog("queued", q, who); queueOf(o.answer?.who).addLast(Next(q, voice))
            o.heard = Heard(who, "Got it, next: $q", System.currentTimeMillis()); o.typing = null; o.draft = ""
            return
        }
        Speech.hushed = false // a new turn: it talks again
        if (undoRe.matches(q)) { o.typing = null; o.draft = ""; undo(voice); return }
        // With an app open it's still a conversation ("do you have information about pressure?" gets an answer);
        // the assistant knows which app they're looking at, and a change to it comes back as a BUILD line (below).
        if (o.net == Net.NoNetwork) { offline(q, who, voice); return }
        if (o.showConversation) { sayInConversation(q, voice); return }
        lastAsker = who
        o.touch(); o.typing = null; o.draft = ""; Speech.stop()
        val prev = o.answer
        val followUp = prev?.takeIf { it.ok && !it.live && !someoneElse && System.currentTimeMillis() - it.at < FOLLOW_UP_MS }?.convo
        val asker = o.person(who)
        val app = o.openAppId // the app on screen as they asked: a change it asks for is to this one, wherever they are when it's done
        val mine = Answer(q, asker?.name, convo = followUp, voice = voice)
        o.vlog("ask", "$q${if (followUp != null) " (follow-up)" else " (new conversation)"}${if (someoneElse) " (someone else woke it)" else ""}${if (voice) "" else " (typed)"}", who)
        o.answer = mine
        o.inFlight = o.inFlight + InFlight(mine.turnId, q, asker?.name)
        val current = { o.answer?.turnId == mine.turnId } // still the conversation on screen (not moved to the background)
        fun upd(f: (Answer) -> Answer) = o.ui {
            o.answer?.takeIf { it.turnId == mine.turnId }?.let { o.answer = f(it) }
            // the jobs list follows it even after it moves to the background
            o.inFlight = o.inFlight.map { j -> if (j.id != mine.turnId) j else f(Answer(q, j.who, status = j.status, convo = j.convo)).let { a -> j.copy(status = a.status, convo = a.convo) } }
        }
        // What it says, said message by message: the sentences of the message being written as each is complete, and
        // all of it when the message ends (a tool comes next, or another message), not when the whole turn ends. So "It's
        // 11:37" is heard as soon as it's written, though the turn goes on (it ends the conversation, says nothing more).
        var spoken = 0; var total = 0 // sentences said of this message, and in all
        val said = mutableSetOf<String>() // messages said in full
        val once = SaidInTurn() // (a message that only repeats an earlier one isn't said again)
        var msgDone = false
        val quietRe = Regex("^\\W*\\[quiet]\\W*$", RegexOption.IGNORE_CASE)
        fun speakFrom(t: String, final: Boolean) {
            if (!voice || total >= SPEAK_MAX || !current() || quietRe.matches(t)) return
            val sentences = Answers.sentences(prose(t), final) // all it says; UI isn't read out
            while (spoken < sentences.size && total < SPEAK_MAX) { val s = sentences[spoken++]; if (once.fresh(s)) { Speech.say(s, asker?.note); total++ } }
        }
        fun endMessage(t: String) { if (msgDone || t.isBlank()) return; speakFrom(t, true); said += t.trim(); once.messageEnded(); msgDone = true }
        val job = o.scope.launch(start = CoroutineStart.LAZY) {
            var id = followUp; var streamed = ""; var final = ""; var ok = false; var ended = false; var quiet = false
            try {
                stream(mine.turnId, JSONObject().put("id", id).put("text", q).put("who", asker?.name).put("about", asker?.note?.ifEmpty { null })
                    .put("app", app?.takeIf { it != "home" }).put("crash", app?.let { crashes[it] }).put("spoken", voice), onEvent = { ev ->
                    when (ev.optString("type")) {
                        "start" -> { id = ev.optString("id"); running[mine.turnId]?.convo = id; upd { it.copy(convo = id) } }
                        "status" -> { val s = ev.optString("text"); upd { it.copy(status = s) } }
                        "delta" -> { // its words now: the thought before them is over
                            // (Words after a message has ended are a new message's, whether or not the bridge said so:
                            // added to the old one, its sentences were counted as said and the new message's were skipped.)
                            if (msgDone) { streamed = ""; spoken = 0; msgDone = false }
                            streamed += ev.optString("text"); val t = streamed; upd { it.copy(text = t, status = "") }; speakFrom(t, false)
                        }
                        // A new message begins: the last one is said in full, and stays up until the new one has words
                        // (else the caption blinks to "…" between them, as when it ends the conversation after answering).
                        "reset" -> { endMessage(streamed); streamed = ""; spoken = 0; msgDone = false }
                        "message" -> { // a whole message (written, or sent in one piece)
                            val s = ev.optString("text")
                            if (streamed.isEmpty() && s.isNotBlank()) { streamed = s; upd { it.copy(text = s, status = "") } }
                            endMessage(streamed)
                        }
                        "done" -> { ok = ev.optBoolean("ok"); final = ev.optString("text"); ended = ev.optBoolean("end"); quiet = ev.optBoolean("quiet") }
                        "notes" -> { val ids = ev.optJSONArray("notes").let { a -> (0 until (a?.length() ?: 0)).mapNotNull { a!!.optJSONObject(it)?.optString("id") } }; upd { it.copy(notes = ids) } }
                        // How it's going, in its own words: on its note, and said aloud when they asked by voice.
                        "progress" -> { val t = ev.optString("text"); upd { it.copy(text = t, status = "") }; if (voice && current() && once.fresh(t)) { once.messageEnded(); Speech.say(t, asker?.note) } } // said aloud: words, not a thought
                        // It's changing an app: show that app, so they watch it change.
                        "edit" -> { val a = ev.optString("app"); if (current() && a.isNotEmpty() && a != "home" && o.openAppId != a && !ev.optBoolean("inTab")) o.ui { o.openApp(a) } } // inTab: already showing in the home screen's tab, which reloads it
                    }
                }, error = { final = "I couldn’t reach the display’s helper." ; android.util.Log.w("Openhouse", "turn: $it") })
                if (!running.containsKey(mine.turnId) && !ok) final = "Stopped."
            } catch (e: CancellationException) { final = "Stopped."; throw e
            } finally {
                running.remove(mine.turnId)
                val t = final.ifEmpty { streamed.ifEmpty { "…" } }
                o.vlog("answered", "${t.take(140)}${if (ended) " [ended the conversation]" else ""}${if (!ok) " [failed]" else ""}", who)
                upd { it.copy(text = t, ok = ok, live = false, convo = id, at = System.currentTimeMillis()) }
                if (quiet) { // it decided that wasn't for it: nothing said or kept; their words show crossed out a moment
                    o.ui { if (current()) { o.answer = prev; o.ignored = Heard(asker?.name, q, System.currentTimeMillis()) } }
                    if (voice) Listening.arm(0, "followup")
                }
                else if (!current()) { /* moved to the background by someone else's conversation: it finished quietly */ }
                else if (voice && ok) {
                    if (t.trim() !in said) { if (t != streamed) { spoken = 0; once.messageEnded() }; speakFrom(t, true) } // else already said as it came
                    Speech.afterSpeaking { Listening.arm(if (ended) 0 else HANDS_FREE_MS, "followup", anyone = Listening.askedQuestion(final)) } // then they can just keep talking, unless it said goodbye (end_conversation)
                } else if (voice) Listening.arm(0, "followup")
                // Typed, and it asked them something back ("Want me to build that?"): the typing box opens again under its
                // question, so they can answer it (a caption alone went away before they could, and showed only its end).
                else if (ok && !ended && Listening.askedQuestion(final) && queued[asker?.name ?: ""].isNullOrEmpty()) o.ui {
                    if (current() && o.typing == null) o.openTyping(note = Answers.speakable(Answers.segments(t).filterIsInstance<Segment.Prose>().joinToString(" ") { it.text }))
                }
                nextFor(asker?.name)?.let { n -> o.ui { ask(n.text, asker?.name, voice = n.voice) } } // their next one (only theirs)
                if (ok) Answers.buildLine(t)?.let { build(it, "Family: $q\n\nAssistant: $t", app) }
                o.loadVoiceStatus()
                o.ui { o.inFlight = o.inFlight.filter { it.id != mine.turnId } }
            }
        }
        running[mine.turnId] = Running(job)
        job.start()
    }

    /** Ask in the open conversation (typed or spoken there). */
    fun sayInConversation(text: String, voice: Boolean = false, onboard: Boolean = false) {
        val q = text.trim(); val c = o.conversation ?: Conversation(null, emptyList())
        if (q.isEmpty() && !onboard) return
        // Said or typed while it's still answering: the next turn, once this one is done (never dropped).
        if (c.turns.lastOrNull()?.live == true) { queueOf(SCREEN).addLast(Next(q, voice)); o.heard = Heard(o.me?.name, "Got it, next: $q", System.currentTimeMillis()); return }
        o.touch(); o.typing = null; o.draft = ""; Speech.hushed = false
        val who = o.me?.name
        val app = o.openAppId
        o.conversation = c.copy(turns = c.turns + (if (onboard) emptyList() else listOf(Turn("user", q, who))) + Turn("assistant", "", live = true, status = "Thinking"))
        fun upd(f: (Turn) -> Turn) = o.ui { o.conversation = o.conversation?.let { cc -> cc.copy(turns = cc.turns.dropLast(1) + f(cc.turns.last())) } }
        val turnId = System.nanoTime()
        val job = o.scope.launch(start = CoroutineStart.LAZY) {
            var spoken = 0; val once = SaidInTurn()
            var cid = c.id; var streamed = ""; var final = ""; var ok = false; var ended = false
            var msgEnded = false // the message being written is complete: the next words begin another
            fun newMessage() { // the last one is said in full; its words stay up until the next message has some
                msgEnded = false; if (streamed.isBlank()) return
                if (voice) { val all = Answers.sentences(prose(streamed), true); while (spoken < minOf(all.size, SPEAK_MAX)) { val s = all[spoken++]; if (once.fresh(s)) Speech.say(s, o.person(who)?.note) } }
                streamed = ""; spoken = 0; once.messageEnded()
            }
            try {
                stream(turnId, JSONObject().put("id", cid).put("text", q).put("who", who).put("about", o.person(who)?.note?.ifEmpty { null }).put("onboard", onboard), onEvent = { ev ->
                    when (ev.optString("type")) {
                        "start" -> { cid = ev.optString("id"); running[turnId]?.convo = cid; o.ui { o.conversation = o.conversation?.copy(id = cid) } }
                        "status" -> { val st = ev.optString("text"); upd { it.copy(status = st) } }
                        "delta" -> {
                            if (msgEnded) newMessage()
                            streamed += ev.optString("text"); val t = streamed; upd { it.copy(text = t, status = "") }
                            if (voice) { val sentences = Answers.sentences(prose(t), false); while (spoken < minOf(sentences.size, SPEAK_MAX)) { val s = sentences[spoken++]; if (once.fresh(s)) Speech.say(s, o.person(who)?.note) } }
                        }
                        "reset" -> newMessage()
                        "message" -> if (streamed.isEmpty()) { val st = ev.optString("text"); upd { it.copy(text = st, status = "") } } else msgEnded = true
                        "progress" -> { val st = ev.optString("text"); upd { it.copy(text = st, status = "") } }
                        "edit" -> { val a = ev.optString("app"); if (a.isNotEmpty() && a != "home" && o.openAppId != a && !ev.optBoolean("inTab")) o.ui { o.openApp(a) } }
                        "done" -> { ok = ev.optBoolean("ok"); final = ev.optString("text"); ended = ev.optBoolean("end") }
                    }
                }, error = { final = "I couldn’t reach the display’s helper."; android.util.Log.w("Openhouse", "turn: $it") })
                if (!running.containsKey(turnId) && !ok) final = "Stopped."
            } catch (e: CancellationException) { final = "Stopped."; throw e
            } finally {
                running.remove(turnId); if (screenTurn == turnId) screenTurn = null
                val t = final.ifEmpty { streamed.ifEmpty { "…" } }
                upd { it.copy(text = t, live = false, ok = ok) }
                if (voice && ok) {
                    val all = Answers.sentences(prose(t), true)
                    while (spoken < minOf(all.size, SPEAK_MAX)) { val s = all[spoken++]; if (once.fresh(s)) Speech.say(s, o.person(who)?.note) } // the last sentence, now it's complete
                    // Then it listens for the answer, from anyone while getting to know the family, else the same voice.
                    Speech.afterSpeaking { Listening.arm(if (ended) 0 else HANDS_FREE_MS, "followup", anyone = Listening.askedQuestion(t)) }
                }
                o.ui { o.conversation = o.conversation?.copy(id = cid) }
                // The notes it put on the home screen, from the saved conversation.
                cid?.let { id -> o.loadConversation(id) }
                if (ok) Answers.buildLine(t)?.let { build(it, "Family: $q\n\nAssistant: $t", app) }
                o.loadConversations(); o.loadVoiceStatus()
                queued[SCREEN]?.pollFirst()?.let { n -> o.ui { sayInConversation(n.text, n.voice) } }
            }
        }
        running[turnId] = Running(job); screenTurn = turnId
        job.start()
    }
    /** The conversation screen's own queue (whoever is at the screen). */
    private const val SCREEN = "\u0000screen"

    /** Change an app ("make the stars bigger"): the agent edits that app. */
    fun changeApp(text: String, appId: String, context: String? = null) {
        o.typing = null; o.draft = ""
        o.postAsync("/request", JSONObject().put("text", text).put("app", appId).put("crash", crashes.remove(appId)).put("context", context))
    }
    /** The assistant decided to make or change something (its BUILD line): the app that was open when it was asked, or a new one. */
    private fun build(line: String, context: String, app: String?) {
        val target = app?.takeIf { it != "home" }
        if (target != null) changeApp(line, target, context) else o.host.makeApp(line, context)
    }

    // ---- the agent at work: bridge /events ----
    private val stages = mapOf("init" to "Thinking", "firstText" to "Thinking", "firstTool" to "Thinking", "thinking" to "Thinking",
        "firstEdit" to "Making changes", "compiling" to "Checking it builds")
    private fun onBuild(ev: JSONObject) {
        val b = o.build
        fun JSONObject.s(k: String) = optString(k).takeIf { has(k) && !isNull(k) && it.isNotEmpty() }
        when (ev.optString("type")) {
            "state" -> if (ev.optString("state") == "working" && (b == null || b.done)) o.build = Build(ev.optString("request"), ev.s("who"), ev.optLong("startedAt", System.currentTimeMillis()))
            "ack" -> o.build = Build(ev.optString("text"), ev.s("who"), System.currentTimeMillis())
            "phase" -> if (b != null) stages[ev.optString("name")]?.let { o.build = b.copy(stage = it) }
            "delta" -> if (b != null && b.plan == null) o.build = b.copy(plan = firstSentence(ev.optString("text")))
            "log" -> if (b != null && ev.optString("kind") == "tool") {
                val t = ev.s("friendly") ?: return // only steps worth reading ("Building the timer app"), not every file it opens
                if (t.isNotBlank() && t !in b.steps) o.build = b.copy(steps = (b.steps + t).takeLast(6))
            }
            "writing" -> if (b != null) o.build = b.copy(live = ev.s("friendly") ?: ev.s("text"))
            // What it says it's doing now ("Making the clock bigger"); the one before becomes a done step.
            "intent" -> if (b != null) { val t = ev.optString("text"); if (t.isNotBlank()) o.build = b.copy(stage = t, live = null, steps = (if (b.stage !in stages.values && b.stage != "Starting" && b.stage !in b.steps) b.steps + b.stage else b.steps).takeLast(6)) }
            "edit" -> { val app = ev.s("app"); if (b != null) o.build = b.copy(app = app ?: b.app)
                if (app != null && app != "home" && o.openAppId != app && !ev.optBoolean("inTab")) o.openApp(app) } // watch it appear (in its tab, if it's showing there)
            "apps" -> o.appsChanged()
            // An app made on the tablet put back (a no, a failed build, or set aside to wait for a grown-up's yes): its
            // page is gone, so it isn't left open on nothing (a black screen until the home screen restarted).
            "gone" -> { val app = ev.s("app"); if (app != null && o.openAppId == app) o.host.closeApp(); o.appsChanged() }
            "home" -> { if (o.openAppId != null) o.host.closeApp(); o.showSettings = false } // a paired computer or Opie put the home screen back (workshop.js, show_on_screen); a PIN or question over it stays
            "done" -> if (b != null) {
                o.build = b.copy(done = true, ok = ev.optBoolean("ok"), summary = ev.optString("text"), endedAt = System.currentTimeMillis(), live = null)
                // Asked for by voice (the assistant's make_change): it says what changed, briefly.
                if (b.who != null || o.speaking || ev.optBoolean("spoken")) Answers.sentences(ev.optString("text"), true).take(2).forEach { Speech.say(it, o.person(b.who)?.note) }
                o.appsChanged()
            }
            "undone" -> o.build = Build(ev.optString("text"), null, System.currentTimeMillis(), done = true, summary = "Undone: “${ev.optString("text")}”", endedAt = System.currentTimeMillis())
        }
    }
    suspend fun buildEvents() {
        while (true) {
            runCatching {
                BridgeClient.lines(BridgeClient.open(o.bridgeUrl + "/events").apply { connectTimeout = 3000; readTimeout = 0 }) { l ->
                    if (l.startsWith("data: ")) runCatching { JSONObject(l.removePrefix("data: ")) }.getOrNull()?.let { ev -> o.ui { onBuild(ev) } }
                }
            }
            delay(3000)
        }
    }
}

/**
 * What has been said aloud in one turn. A turn can be several messages (it answers, uses a tool, writes again), and
 * the second is sometimes the first over again: on the tablet "It's 5:26 p.m." was said, it ended the conversation,
 * and seven seconds later it said "It's 5:26 p.m." again. A sentence said in an earlier message of the turn isn't
 * said twice. Within one message it is ("Row, row, row your boat" comes round again in a song).
 */
internal class SaidInTurn {
    private val earlier = HashSet<String>(); private val now = ArrayList<String>()
    private fun key(s: String) = s.lowercase().filter { it.isLetterOrDigit() }
    /** Whether to say [sentence]: not if an earlier message of this turn already did. */
    fun fresh(sentence: String): Boolean { val k = key(sentence); if (k.isEmpty()) return true; if (k in earlier) return false; now += k; return true }
    /** The message being said is over: what it said counts as said from here on. */
    fun messageEnded() { earlier += now; now.clear() }
}
