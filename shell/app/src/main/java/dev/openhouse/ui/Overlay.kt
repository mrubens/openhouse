package dev.openhouse.ui

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow

/**
 * The fixed layer over the home board: the microphone button, what it's hearing, the typing
 * box and the Voices screen. Part of the shell, so it keeps working whatever the board does.
 */
@Composable
fun ShellOverlay() {
    OhScreen {
        val o = Openhouse
        Box(Modifier.fillMaxSize()) {
            // A test recording of the microphone is on (bridge/voice.js): always visible, so nobody is recorded unawares.
            if (o.recordingUntil > o.now) Box(Modifier.align(Alignment.TopStart).padding(18.u).size(14.u).clip(CircleShape).background(Color(0xFFE5484D)))
            if (o.showConversation) ConversationScreen()
            // Reminders due now ("Swim in 15 minutes"), over whatever is on screen, until put away or a few minutes past the start.
            if (House.reminders.isNotEmpty() && !o.dark && !o.sleeping) Reminders(Modifier.align(Alignment.TopCenter).padding(top = 22.u))
            o.note(o.fullNote)?.let { FullNote(it) }
            val awaiting = o.awaitingUntil > o.now
            val hearing = o.hearingAt > 0 && o.now - o.hearingAt < 8000
            val heard = o.heard?.takeIf { o.now - it.at < 6000 && it.at > o.quietAt }
            // Stay up through short pauses instead of flickering in and out between words.
            // After that, what the assistant is doing (looking, writing a note) and then what it said.
            val a = o.answer
            // While it works, each new thing it says shows for a few seconds, then gets out of the way (the face keeps working).
            val newWords = a?.let { it.status + "|" + it.text.length / 40 }
            var wordsAt by remember { mutableStateOf(0L) }
            LaunchedEffect(newWords) { wordsAt = System.currentTimeMillis() }
            val reply = a?.takeIf { (if (it.live) o.speaking || o.now - wordsAt < 5000 else o.now - it.at < shownFor(it)) && (if (it.live) it.startedAt else it.at) > o.quietAt } // tapped quiet: put away
            // Making or changing something: what it's doing, then what it did, in the same caption.
            // Making or changing something: a small note that it started, and what it did, each for a few seconds (the face stays green meanwhile).
            val building = o.build?.takeIf { it.done && o.now - it.endedAt < 4000 } // while it works, only the spinner on the note; then what it did
            // One indicator: the assistant's button (Buddy.kt's Face) shows listening, thinking and talking. Captions are only
            // words: what they're saying (theirs, along the bottom) and what it says (by the button). No dots, no
            // "Searching…" thoughts: while it thinks, the button alone shows it.
            val replyWords = a?.let { Answers.speakable(Answers.segments(it.text).filterIsInstance<Segment.Prose>().joinToString(" ") { s -> s.text }) }.orEmpty()
            val dotsOnly = a != null && a.live && replyWords.isBlank() // thinking, nothing said yet: no caption at all
            val want = o.typing == null && ((reply != null && !dotsOnly) || building != null)
            var shownUntil by remember { mutableStateOf(0L) }
            if (want) shownUntil = o.now + 2500
            if (shownUntil - 2500 < o.quietAt) shownUntil = 0 // tapped quiet: gone now, not after the pause
            // What they're saying, as they say it, at the left (the assistant's words are by the note on the right), apart from
            // what the assistant says; what it heard stays a moment, and words it decided weren't for it are crossed out.
            val live = o.partial?.takeIf { it.isNotBlank() && (awaiting || hearing || o.handsFreeUntil > o.now) }
            val said = live ?: heard?.text?.takeIf { it != "…" && !it.startsWith("Got it") }
            val dropped = o.ignored?.takeIf { o.now - it.at < 3000 }
            // Their words: along the bottom, centred under the sheet, never where the assistant's words are (at the left).
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = (if (isCompact()) 16 else 260).u).padding(bottom = (if (isCompact()) 140 else 96).u), contentAlignment = Alignment.Center) { // (a phone: above its tabs)
                AnimatedVisibility(o.typing == null && (said != null || dropped != null), enter = fadeIn(), exit = fadeOut()) {
                    TheirWords(said ?: dropped?.text ?: "", crossed = said == null)
                }
            }
            // The assistant's words rise from its button, above it at the bottom-left (their own words take the same
            // spot while they talk; the two never show at once).
            Column(Modifier.align(Alignment.BottomCenter).padding(bottom = 96.u), verticalArrangement = Arrangement.spacedBy(12.u), horizontalAlignment = Alignment.CenterHorizontally) {
                // While it answers or works, that wins; when someone is saying something new, its finished answer steps aside
                // (their words are in their own bubble at the left, never here too).
                val saying = !o.partial.isNullOrBlank()
                val mine = (if (saying && reply?.live != true) null else reply)?.takeIf { !dotsOnly } // thinking: only the button shows it
                val built = if (reply?.live == true) null else building
                AnimatedVisibility(o.typing == null && (mine != null || built != null || (o.now < shownUntil && !saying && !dotsOnly)), enter = fadeIn(), exit = fadeOut()) {
                    Caption(false, null, mine, built)
                }
                // The live voice couldn't connect, or ended before it answered: said here, as over apps (Buddy), not just
                // the button going away. A tap puts it away.
                val trouble = dev.openhouse.shell.LiveVoice.problemNow(o.now)?.takeIf { o.typing == null && mine == null }
                AnimatedVisibility(trouble != null, enter = fadeIn(), exit = fadeOut()) {
                    val bubble = AssistantCardShape
                    Text(trouble ?: "", style = quietText(20, FontWeight.Normal, PaperLook.ink), maxLines = 3,
                        modifier = Modifier.widthIn(max = 560.u).shadow(18.u, bubble).clip(bubble).background(Color.White)
                            .clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null) { dev.openhouse.shell.LiveVoice.putProblemAway() }
                            .padding(horizontal = 26.u, vertical = 18.u))
                }
                // Off the internet for more than a moment (not a blip): why it can't answer, and the way back on.
                if (o.net != Net.Online && o.now - o.netSince > 15_000 && o.typing == null && mine == null) OfflineNote()
                // Part of another tablet's household, and that tablet isn't answering (docs/multi-tablet.md): this one shows
                // what it last showed, and changes wait until it's back. Asked every 10 s.
                var brainAway by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) { while (true) { brainAway = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { dev.openhouse.shell.Satellite.refresh(o.bridgeUrl)?.let { it.optBoolean("satellite") && (!it.optBoolean("reachable", true) || it.optBoolean("removed")) } == true }; kotlinx.coroutines.delay(10_000) } }
                if (brainAway && o.net == Net.Online && o.typing == null && mine == null) {
                    val bubble = AssistantCardShape
                    Text(if (dev.openhouse.shell.Satellite.state?.optBoolean("removed") == true) "The main device removed this one" else "Can't reach the main device. Showing what it last showed.",
                        style = quietText(19, FontWeight.Medium, PaperLook.ink),
                        modifier = Modifier.shadow(18.u, bubble).clip(bubble).background(Color.White).padding(horizontal = 22.u, vertical = 14.u))
                }
            }
            // The assistant: no button at rest (the user: "it would be cleaner to just get rid of it"). Say "Hey Opie", or
            // just type; it shows in the bottom-left corner only while it listens, works or answers.
            // 24u from the left and from the bottom: its 58u circle's centre at (53u, 53u) of the 92u box.
            // With Tap to talk (no "Hey Opie") it stays at rest too, saying so: it's the way to start talking.
            val engaged = awaiting || hearing || o.handsFreeUntil > o.now
            AnimatedVisibility(engaged || dev.openhouse.shell.assistantEngaged(o.now) || tapToTalk(),Modifier.align(Alignment.BottomCenter).padding(bottom = 10.u), enter = fadeIn(), exit = fadeOut()) {
                MicButton(engaged)
            }
            // An app being made: a quiet chip in the corner, not the face (it's at rest; the tablet says when it's ready).
            if (!o.dark && !o.sleeping && !o.showConversation && o.typing == null)
                BuildChip(Modifier.align(Alignment.BottomEnd).padding(end = 24.u, bottom = 24.u))
            // Typing: a tap anywhere outside the box puts it away (so does a tap on the assistant).
            if (o.typing != null) Box(Modifier.fillMaxSize().clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null) { o.closeTyping() })
            // Above the on-screen keyboard (the window doesn't shrink for it: MainActivity.immersive), never under it.
            // On a phone upright, above its bar of tabs too (whichever is higher: the keyboard or the bar).
            val cfg = androidx.compose.ui.platform.LocalConfiguration.current
            val belowBox = if (isCompact() && cfg.screenHeightDp > cfg.screenWidthDp) WindowInsets.ime.union(WindowInsets(bottom = 90.u)) else WindowInsets.ime
            AnimatedVisibility(o.typing != null, Modifier.align(Alignment.BottomCenter).windowInsetsPadding(belowBox).padding(horizontal = (if (isCompact()) 16 else 260).u), enter = fadeIn() + slideInVertically { it / 2 }, exit = fadeOut() + slideOutVertically { it / 2 }) {
                TypeBox(o.typing ?: "")
            }
            LaunchedEffect(Unit) { Devices.ensureLoaded() }
            if (o.showSettings) SettingsScreen()
            if (o.showFamily) FamilySheet()
            o.confirmDelete?.let { DeleteAppSheet(it) }
            if (o.showJobs) JobsSheet()
            if (o.showWeather) o.weather?.let { w -> WeatherFull(w) { o.showWeather = false } }
            if (Devices.open) CompositionLocalProvider(LocalPalette provides quietPalette()) { DevicesSheet() }
            // A phone card an app in a home tab asked for (its own window shows its own: AppWindow).
            o.phoneCard?.let { (kind, arg) ->
                val close = { o.phoneCard = null }
                when (kind) {
                    "photos" -> PhonePhotos(onClose = close)
                    "flyer" -> PhoneFlyer(onClose = close)
                    "recipe" -> PhoneRecipe(arg, onClose = close)
                    "link" -> WebPage(arg, onClose = close)
                    "list" -> House.list(arg)?.let { PhoneList(it, onClose = close) }
                }
            }
            if (o.setupStep != null) SetupSheet()
            if (o.showWelcome && !o.showSettings) WelcomeSheet()
            if (o.setupStep != null || o.showSettings || o.showFamily || Devices.open || o.confirmDelete != null || o.showWeather)
                EdgeBack { o.host.back() }
        }
    }
}

/** The assistant's button: the same one that floats over other apps (Buddy.kt). */
@Composable
@Suppress("UNUSED_PARAMETER")
private fun MicButton(active: Boolean) {
    val o = Openhouse
    // Over an app or game it stays off to the side (only a sliver shows) unless a conversation is going:
    // it slides out while it listens, works or answers. Tap the sliver to talk.
    val tucked = o.appOpen && !(active || dev.openhouse.shell.assistantEngaged(o.now))
    val shift by animateDpAsState(if (tucked) (-68).u else 0.u, label = "tuck")
    // On the dark screen at night (or "Sleep now") it all but goes too: a bright button there was the only light.
    val faded by animateFloatAsState(if (o.dark && !(active || dev.openhouse.shell.assistantEngaged(o.now))) 0.08f else 1f, label = "dark")
    Box(Modifier.size(172.u, 76.u).graphicsLayer { alpha = faded }, contentAlignment = Alignment.Center) {
        dev.openhouse.shell.AssistantFace(onLongPress = { o.openTyping() }, wide = true, label = if (tapToTalk()) "Tap to talk" else null)
    }
}

/** Opie's voice is on and "Hey Opie" isn't: nothing listens until a tap, so the pill shows at rest and says so. */
private fun tapToTalk() = !Openhouse.heyOpie && Openhouse.host.hasAssistant() && !Setup.hushed

/** What someone is saying: a dark pill along the bottom, apart from the assistant's own words (a white card at the left). */
@Composable
fun TheirWords(text: String, crossed: Boolean = false) {
    val shape = RoundedCornerShape(28.u)
    Text(tail(text, 110), maxLines = 2,
        style = quietText(20, FontWeight.Normal, Color(0xFFFBF9F5).copy(alpha = if (crossed) .6f else 1f)).let { if (crossed) it.copy(textDecoration = androidx.compose.ui.text.style.TextDecoration.LineThrough) else it },
        modifier = Modifier.widthIn(max = 760.u).shadow(10.u, shape).clip(shape).background(Color(0xFF2A2826).copy(alpha = .9f)).padding(horizontal = 26.u, vertical = 12.u))
}

/** The assistant's own words: a white card rising from its button at the bottom-left. */
val AssistantCardShape @Composable get() = RoundedCornerShape(22.u)

/** The newest words of a long transcript, so it grows at the end instead of reflowing. */
/**
 * How long a finished answer stays up. Said aloud: 8 s, longer for a long one (about a word every quarter second), at
 * most 25 s. Typed: the words on screen are the whole answer (nothing says it; with the live voice on too), and someone
 * who typed may look up a while later, so at least 20 s and up to a minute; a tap on it puts it away sooner.
 */
internal fun shownFor(a: Answer): Long =
    if (a.stays) Long.MAX_VALUE / 4 else if (a.voice) (4000L + a.text.length * 50L).coerceIn(8000L, 25_000L) else (8000L + a.text.length * 80L).coerceIn(20_000L, 60_000L)

private fun tail(t: String, max: Int = 90): String {
    if (t.length <= max) return t
    val cut = t.length - max
    val sp = t.indexOf(' ', cut).takeIf { it in cut..(cut + 20) } ?: cut
    return "…" + t.substring(sp).trimStart()
}

/** Not on the internet: a small note by the face with the way back on (Android's Wi-Fi screen, behind the PIN). */
@Composable
private fun Reminders(modifier: Modifier) {
    val o = Openhouse
    Column(modifier.widthIn(max = 720.u), verticalArrangement = Arrangement.spacedBy(10.u), horizontalAlignment = Alignment.CenterHorizontally) {
        for (r in House.reminders.take(3)) {
            val bubble = AssistantCardShape
            Row(Modifier.shadow(18.u, bubble).clip(bubble).background(Color.White).padding(start = 22.u, end = 12.u, top = 12.u, bottom = 12.u),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
                Box(Modifier.size(14.u).clip(CircleShape).background(House.color(r.who?.substringBefore(" & "))))
                Column(Modifier.weight(1f, fill = false)) {
                    Text(o.remindWords(r, o.now).substringBefore(", for "), style = quietText(22, FontWeight.Medium, PaperLook.ink), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    listOfNotNull(r.who, r.place).takeIf { it.isNotEmpty() }?.let { Text(it.joinToString(" · "), style = quietText(17, color = PaperLook.inkSoft), maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                CompositionLocalProvider(LocalPalette provides paperPalette()) { Pill("Got it", primary = false) { House.putAway(r.key) } }
            }
        }
    }
}

@Composable
private fun OfflineNote() {
    val o = Openhouse
    val bubble = AssistantCardShape
    Row(Modifier.shadow(18.u, bubble).clip(bubble).background(Color.White).padding(start = 20.u, end = 12.u, top = 10.u, bottom = 10.u),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
        Text(if (o.net == Net.NoNetwork) "Not on Wi-Fi" else "Can't reach the internet", style = quietText(19, FontWeight.Medium, PaperLook.ink))
        Pill("Wi-Fi") { o.joinWifi() }
    }
}

@Composable
private fun Caption(live: Boolean, heard: Heard?, reply: Answer? = null, build: Build? = null) {
    val o = Openhouse
    val words = o.partial
    // One fixed size for listening, live words and the final text, so nothing jumps while they change.
    // Only about a build: small, it's just a heads-up.
    val small = build != null && !live && heard == null && reply == null && words.isNullOrBlank()
    // A card rising from the button, as big as its words.
    val bubble = AssistantCardShape
    Row(
        Modifier.widthIn(max = 560.u).shadow(18.u, bubble).clip(bubble).background(Color.White)
            // a tap on what it said puts it away (as a tap on the listening face does)
            .clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null) { o.quietAt = System.currentTimeMillis() }
            .padding(horizontal = 26.u, vertical = 18.u),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u),
    ) {
        Box {
            when {
                // Working on it: what they asked, then its own words as they come (what it's doing, or the answer itself).
                // Answering: its words as they come (each new message starts afresh), not its last two lines.
                reply != null && reply.live -> Text(tail(Answers.speakable(Answers.segments(reply.text).filterIsInstance<Segment.Prose>().joinToString(" ") { it.text }), 330), style = quietText(20, FontWeight.Normal, PaperLook.ink), maxLines = 7)
                build != null && !build.done -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.u)) {
                    Text((build.live ?: build.stage) + "…", style = quietText(18, FontWeight.Normal, PaperLook.inkSoft), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                build != null && (reply == null || build.endedAt > reply.at) -> Text(build.summary?.ifBlank { null } ?: if (build.ok) "Done." else "That didn’t work.", style = quietText(19, FontWeight.Normal, PaperLook.ink), maxLines = if (small) 1 else 3, overflow = TextOverflow.Ellipsis)
                // The finished answer from its start (as it came, the newest words showed), long enough to read whole.
                reply != null -> Text(Answers.speakable(Answers.segments(reply.text).filterIsInstance<Segment.Prose>().joinToString(" ") { it.text }).ifEmpty { "Done." }, style = quietText(20, FontWeight.Normal, PaperLook.ink), maxLines = 7, overflow = TextOverflow.Ellipsis)
                else -> {}
            }
        }
    }
}

@Composable
private fun TypeBox(note: String) {
    val o = Openhouse
    var value by remember { mutableStateOf(TextFieldValue(o.draft, TextRange(o.draft.length))) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(o.draft) { if (value.text != o.draft) value = TextFieldValue(o.draft, TextRange(o.draft.length)) } // keys come in from the shell (keyboard cover, over apps)
    DisposableEffect(Unit) { onDispose { o.typingFocused = false } }
    fun send() { val t = value.text.trim(); if (t.isNotEmpty()) { o.send(t); value = TextFieldValue(""); o.editDraft("") } } // while it answers, it's the next thing to do
    // The same dark pill as their spoken words (TheirWords): typing is them talking to it too. Centred on the screen,
    // and never wider than the white sheet it sits over.
    val shape = RoundedCornerShape(30.u)
    Column(
        Modifier.padding(bottom = 30.u).widthIn(max = 1000.u).fillMaxWidth().shadow(10.u, shape).clip(shape).background(Color(0xFF2A2826).copy(alpha = .92f))
            .padding(horizontal = 12.u, vertical = 8.u),
        verticalArrangement = Arrangement.spacedBy(6.u),
    ) {
        val soft = Color(0xFFFBF9F5).copy(alpha = .6f)
        if (note.isNotEmpty()) Text(note, style = quietText(17, color = soft), modifier = Modifier.padding(horizontal = 14.u, vertical = 2.u))
        // The words as they're heard, before they land in the draft.
        if (o.dictating && !o.partial.isNullOrBlank()) Text(o.partial!!, style = quietText(19, color = soft), modifier = Modifier.padding(horizontal = 14.u, vertical = 2.u))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.u)) {
            Box(Modifier.weight(1f).padding(horizontal = 14.u)) {
                val cover = coverAttached()
                if (value.text.isEmpty()) Text("Ask ${o.assistantName}", style = quietText(21, color = Color(0xFFFBF9F5).copy(alpha = .5f)), maxLines = 1)
                BasicTextField(
                    value, { value = it; o.editDraft(it.text) }, Modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { if (it.isFocused) o.typingFocused = true }.onPreviewKeyEvent { e ->
                        if (e.key == Key.Escape) { if (e.nativeKeyEvent.action == android.view.KeyEvent.ACTION_DOWN) o.closeTyping(); true }
                        else if ((e.key == Key.Enter || e.key == Key.NumPadEnter) && !e.isShiftPressed) { if (e.nativeKeyEvent.action == android.view.KeyEvent.ACTION_DOWN) send(); true } // Enter sends
                        else if (cover) coverKey(e, value.text, { t -> value = TextFieldValue(t, TextRange(t.length)); o.editDraft(t) }, ::send)
                        else false
                    },
                    readOnly = cover, // with the keyboard cover, its keys come straight in (see coverKey), so no on-screen keyboard or its toolbar
                    textStyle = quietText(21, color = Color(0xFFFBF9F5)), singleLine = false, maxLines = 4, cursorBrush = SolidColor(Color(0xFFFBF9F5)), // one line, growing as they write
                    keyboardOptions = TextKeys.copy(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
                )
            }
            // Send, once there's something to send (nothing on the tablet hears words to dictate now).
            Box(Modifier.size(44.u).clip(CircleShape).background(if (value.text.isNotBlank()) Color(0xFFFBF9F5) else Color(0xFFFBF9F5).copy(alpha = .12f)).clickable(enabled = value.text.isNotBlank()) { send() }, contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = if (value.text.isNotBlank()) Color(0xFF2A2826) else Color(0xFFFBF9F5).copy(alpha = .4f), modifier = Modifier.size(20.u))
            }
        }
    }
}

/** A microphone, drawn (no icon font has one here). On while it's listening for the draft. */
@Composable
private fun MicButton(on: Boolean, dark: Boolean = false, onTap: () -> Unit) {
    val pulse = if (on) rememberInfiniteTransition(label = "mic").animateFloat(1f, .55f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "a").value else 1f
    val idleBg = if (dark) Color(0xFFFBF9F5).copy(alpha = .12f) else Oh.panel
    val onInk = if (dark) Color(0xFFFBF9F5) else Oh.accent
    Box(Modifier.size(if (dark) 44.u else 48.u).clip(CircleShape).background(if (on) onInk.copy(alpha = .25f * pulse + .1f) else idleBg).clickable { onTap() }, contentAlignment = Alignment.Center) {
        val ink = if (on) onInk else if (dark) Color(0xFFFBF9F5).copy(alpha = .7f) else Oh.muted
        androidx.compose.foundation.Canvas(Modifier.size(24.u)) {
            val w = size.width; val h = size.height; val stroke = w * .1f
            drawRoundRect(ink, topLeft = androidx.compose.ui.geometry.Offset(w * .34f, 0f), size = androidx.compose.ui.geometry.Size(w * .32f, h * .6f),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * .16f))
            drawArc(ink, 0f, 180f, false, topLeft = androidx.compose.ui.geometry.Offset(w * .18f, h * .22f), size = androidx.compose.ui.geometry.Size(w * .64f, h * .56f),
                style = androidx.compose.ui.graphics.drawscope.Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
            drawLine(ink, androidx.compose.ui.geometry.Offset(w * .5f, h * .78f), androidx.compose.ui.geometry.Offset(w * .5f, h * .95f), stroke, androidx.compose.ui.graphics.StrokeCap.Round)
        }
    }
}

/**
 * An app being made or changed (the builder: make_app, a typed request, the Apps sheet), and what waits after it: a
 * quiet chip on the home screen and over apps (Buddy.kt), not the assistant's face, which has gone back to rest. Its
 * line fills slowly with the time a build usually takes. A tap opens what's being made (or what's in flight).
 */
@Composable
fun BuildChip(modifier: Modifier = Modifier) {
    val o = Openhouse
    val b = o.build?.takeIf { !it.done && !it.waiting } ?: return // (made: the app is open to try, with its own bar)
    val name = b.app?.let { id -> o.apps.firstOrNull { it.id == id }?.name ?: id.replace('-', ' ').replaceFirstChar { it.uppercase() } }
    val then = o.buildQueue.firstOrNull()
    val shape = RoundedCornerShape(18.u)
    // most builds take a minute or two
    val part = ((o.now - b.startedAt) / 90_000f).coerceIn(0.04f, 0.92f)
    val shown by animateFloatAsState(part, label = "made")
    Column(modifier.widthIn(min = 260.u, max = 420.u).shadow(10.u, shape).clip(shape).background(Color.White)
        .clickable { if (b.app != null && o.openAppId != b.app) o.openApp(b.app) else o.showJobs = true }
        .padding(start = 20.u, end = 20.u, top = 12.u, bottom = 12.u), verticalArrangement = Arrangement.spacedBy(6.u)) {
        Text(if (name != null) "Making $name…" else "Making it…", style = quietText(17, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(listOfNotNull(b.live ?: b.stage, then?.let { "then: $it" + if (o.buildQueue.size > 1) " and ${o.buildQueue.size - 1} more" else "" }).joinToString(" · "),
            style = quietText(14, color = PaperLook.inkSoft), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.fillMaxWidth().height(3.u).clip(RoundedCornerShape(2.u)).background(PaperLook.ink.copy(alpha = .08f))) {
            Box(Modifier.fillMaxWidth(shown).fillMaxHeight().background(PaperLook.ink.copy(alpha = .45f)))
        }
    }
}
