package dev.openhouse.ui

// The conversation screen (earlier conversations, and this one on the home screen) and a note up close.

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

// --- conversations ----------------------------------------------------------------------------

/** A conversation with the assistant, full screen: earlier ones on the left, this one on the home screen. */
@Composable
internal fun ConversationScreen() {
    val o = Openhouse
    val c = o.conversation
    val scroll = androidx.compose.foundation.rememberScrollState()
    LaunchedEffect(c?.turns?.size, c?.turns?.lastOrNull()?.text?.length) { scroll.animateScrollTo(scroll.maxValue) }
    // Quiet, like the rest of the shell's screens: the sheet, sans type, the answers as plain text, what was said in a
    // soft bubble (with the name when the tablet knew who it was).
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        Box(Modifier.fillMaxSize().background(Calm.sheet).clickable(enabled = false) {}) {
            Row(Modifier.fillMaxSize().padding(start = 56.u, end = 56.u, top = 40.u, bottom = 30.u), horizontalArrangement = Arrangement.spacedBy(48.u)) {
                // earlier conversations, once there are some (not in the first one)
                val earlier = o.conversations.filter { it.title.isNotBlank() }.take(30)
                if (!o.onboarding && earlier.size > 1) Column(Modifier.width(300.u).fillMaxHeight()) {
                    Text("Earlier", style = calmText(18, FontWeight.SemiBold, Calm.soft))
                    Spacer(Modifier.height(14.u))
                    Column(Modifier.weight(1f).verticalScroll(androidx.compose.foundation.rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.u)) {
                        earlier.forEach { ci ->
                            val here = ci.id == c?.id
                            Text(ci.title, style = calmText(19, if (here) FontWeight.SemiBold else FontWeight.Normal, if (here) Calm.ink else Calm.soft), maxLines = 2, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.u)).background(if (here) Calm.tint else Color.Transparent).clickable { o.openConversation(ci.id) }.padding(horizontal = 14.u, vertical = 10.u))
                        }
                    }
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.u)) {
                        Text(if (o.onboarding) "Getting to know you" else c?.turns?.firstOrNull()?.takeIf { it.role == "user" }?.text ?: o.conversations.firstOrNull { it.id == c?.id }?.title ?: "Ask me anything",
                            style = calmText(28, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (!o.onboarding) Chip("New") { o.newConversation() }
                        Chip("Close") { o.closeConversation() }
                    }
                    Spacer(Modifier.height(24.u))
                    Column(Modifier.weight(1f).verticalScroll(scroll).padding(end = (if (isCompact()) 0 else 150).u), verticalArrangement = Arrangement.spacedBy(26.u)) {
                        val turns = c?.turns ?: emptyList()
                        turns.forEachIndexed { i, t ->
                            if (t.role == "user") Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
                                t.who?.let { Text(it, style = calmText(15, FontWeight.Medium, Calm.soft), modifier = Modifier.padding(end = 8.u, bottom = 4.u)) }
                                Text(t.text, style = calmText(22), modifier = Modifier.widthIn(max = 760.u).clip(RoundedCornerShape(24.u)).background(Calm.tint).padding(horizontal = 24.u, vertical = 14.u))
                            }
                            else if (t.live && t.text.isEmpty()) {} // thinking: the assistant's button shows it (one indicator), no card of dots
                            else Column(Modifier.fillMaxWidth()) {
                                AnswerView(t.text, done = !t.live)
                                // What it put on the home screen, as it was then.
                                t.notes.forEach { n ->
                                    Column(Modifier.padding(top = 14.u).fillMaxWidth().clip(RoundedCornerShape(16.u)).background(Calm.tint).padding(20.u), verticalArrangement = Arrangement.spacedBy(10.u)) {
                                        Text(n.title, style = calmText(22, FontWeight.SemiBold))
                                        CompositionLocalProvider(LocalView provides "full") { AnswerView(n.content) }
                                    }
                                }
                                if (!t.live && t.ok && !o.onboarding) Row(Modifier.padding(top = 12.u), horizontalArrangement = Arrangement.spacedBy(10.u)) {
                                    val q = turns.getOrNull(i - 1)?.text ?: ""
                                    val onHome = t.notes.firstOrNull { n -> o.note(n.id) != null }
                                    if (onHome != null) Chip(if (o.note(onHome.id)?.keep == true) "Kept on Home" else "Keep it on Home") { o.keepNote(onHome.id) }
                                    else if (t.notes.isNotEmpty() || Answers.hasUi(t.text)) Chip("Put it on Home") { o.pinFromConversation(q, t.notes.firstOrNull()?.content ?: t.text) }
                                    if (t.notes.isNotEmpty() || Answers.hasUi(t.text)) Chip("Make it an app") { o.makeApp("Make an app from this: $q") }
                                }
                                if (t.live) Row(Modifier.padding(top = 12.u)) { StopButton { o.stopAnswer() } }
                            }
                        }
                    }
                }
            }
        }
    }
}

// --- a note up close -----------------------------------------------------------------------------

/** A note from the home screen, full screen: about three times the room, and what can be done with it. */
@Composable
internal fun FullNote(n: HomeNote) {
    val o = Openhouse
    CompositionLocalProvider(LocalPalette provides paperPalette(), LocalView provides "full", LocalTwoColumns provides true, LocalAnswerActions provides o) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .45f)).clickable { o.closeNote() }) {
            Paper(
                Modifier.align(Alignment.Center).size(fit(1340.u), fit(860.u, height = true)).clickable(enabled = false) {}, kind = PaperKind.Card,
                magnet = o.person(n.forWho)?.color ?: PaperLook.magnets[(n.id.hashCode() and 0xff) % PaperLook.magnets.size], fill = true,
                padding = PaddingValues(horizontal = 48.u, vertical = 34.u),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.u)) {
                    Text(n.title, style = roundText(40, FontWeight.ExtraBold), maxLines = 2, modifier = Modifier.weight(1f))
                    Chip(if (n.keep) "Kept on Home" else "Keep it") { o.keepNote(n.id, !n.keep) }
                    n.conversation?.let { c -> Chip("Conversation") { o.closeNote(); o.openConversation(c) } }
                    Chip("Take it down") { o.takeDown(n.id) }
                    Chip("Close") { o.closeNote() }
                }
                Spacer(Modifier.height(18.u))
                FitToBox(Modifier.weight(1f).fillMaxWidth(), minScale = 0.6f) { AnswerView(n.content) }
            }
        }
    }
}
