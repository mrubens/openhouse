package dev.openhouse.ui

// The sheets over the home screen: settings (the gear) and what it opens, what's in flight, and what's been removed.

import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
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
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Lock
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

/** The home screen's quiet look for the shell's own cards: white, dark ink, Inter, a dark button for the main action. */
internal fun quietPalette() = Calm.palette()

/** The shared sheet (Calm): the shell's own questions and lists. */
@Composable
internal fun QuietCard(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(horizontal = 36.u, vertical = 30.u), content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(Calm.R_SHEET.u)
    Column(modifier.shadow(18.u, shape).clip(shape).background(Calm.sheet).padding(padding), verticalArrangement = Arrangement.spacedBy(8.u), content = content)
}

// --- settings (the gear): one list (docs/settings.md) ---------------------------------------------

/**
 * Settings: one list, in two columns, each row its name and what it is now. A row opens its own sheet or dialog over
 * the list, and closing that comes back here; Back goes up one level, Done closes. With the lock on, the rows it
 * locks show a small lock and ask for the PIN.
 */
@Composable
internal fun SettingsSheet() {
    val o = Openhouse
    var vals by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // What the shell's rows show: read now, again whenever something over the list closes, and every few seconds.
    LaunchedEffect(o.settingsV) { vals = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { o.host.settingValues() }.getOrDefault(vals) } }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(3000); vals = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { o.host.settingValues() }.getOrDefault(vals) } } }
    val locked = vals["lock"] == "On"
    fun shell(id: String) = { o.host.setting(id) }
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .3f)).clickable { o.showSettings = false }, contentAlignment = Alignment.Center) {
            QuietCard(Modifier.width(640.u).heightIn(max = 900.u).clickable(enabled = false) {}) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Settings", style = quietText(30, FontWeight.SemiBold), modifier = Modifier.weight(1f))
                    Chip("Done") { o.showSettings = false }
                }
                Spacer(Modifier.height(10.u))
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    SettingsRow("Voice", vals["voice"], locked, shell("voice"))
                    SettingsRow("Family", o.board?.family?.takeIf { it.isNotEmpty() }?.joinToString(", ") { it.name }) { o.showFamily = true }
                    SettingsRow("What Opie remembers", vals["memory"], onClick = shell("memory"))
                    SettingsRow("Linked devices", ((vals["screens"]?.toIntOrNull() ?: 0) + Devices.controllable.size).takeIf { it > 0 }?.toString()) { Devices.open = true; if (Devices.scannedAt == null) Devices.scan() else Devices.refreshStatus() }
                    SettingsRow("Email", vals["email"], locked, shell("email"))
                    SettingsRow("Account", vals["account"], locked, shell("account"))
                    SettingsRow("Advanced", null, locked, shell("tablet"))
                }
            }
        }
    }
}


/** ‹: back to Settings, at the top left of a sheet opened from it (a shared screen has people who don't know the
 *  edge swipe). Nothing on a sheet opened from anywhere else. */
@Composable
internal fun SettingsBack() {
    if (!Openhouse.showSettings) return
    Box(Modifier.size(48.u).clip(CircleShape).clickable { Openhouse.host.back() }.semantics { contentDescription = "Back" }, contentAlignment = Alignment.Center) {
        androidx.compose.foundation.Canvas(Modifier.size(22.u)) {
            val w = size.width; val h = size.height
            drawPath(androidx.compose.ui.graphics.Path().apply { moveTo(w * .62f, h * .12f); lineTo(w * .28f, h * .5f); lineTo(w * .62f, h * .88f) },
                PaperLook.ink, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.4f * density, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
        }
    }
}

/**
 * Back by swiping in from either edge, while something is open over the home screen (the tablet hides Android's own
 * back). Thin strips at both sides; a swipe counts when it goes 70 dp inward, more sideways than up or down.
 */
@Composable
internal fun EdgeBack(onBack: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        for (start in listOf(true, false)) Box(Modifier.align(if (start) Alignment.CenterStart else Alignment.CenterEnd).width(14.u).fillMaxHeight()
            .pointerInput(start) {
                var dx = 0f; var dy = 0f
                detectDragGestures(onDragStart = { dx = 0f; dy = 0f }, onDragEnd = {
                    if (kotlin.math.abs(dx) > 70.dp.toPx() && kotlin.math.abs(dx) > kotlin.math.abs(dy) && (dx > 0) == start) onBack()
                }) { _, d -> dx += d.x; dy += d.y }
            })
    }
}

/** A row of Settings: its name, what it is now (soft, at the right) and, when the lock guards it, a small lock. */
@Composable
internal fun SettingsRow(title: String, value: String? = null, locked: Boolean = false, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.u)).clickable(onClick = onClick).padding(horizontal = 12.u, vertical = 15.u),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.u)) {
        Text(title, style = quietText(21, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        value?.let { Text(it, style = quietText(18, color = PaperLook.inkSoft), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 240.u)) }
        if (locked) Icon(androidx.compose.material.icons.Icons.Filled.Lock, "Locked", tint = PaperLook.inkSoft, modifier = Modifier.size(18.u))
    }
}

// --- welcome (a new tablet) -------------------------------------------------------------------

/**
 * The first thing a new tablet says: what it is, and one choice. Either way the setup's steps come next (Setup.kt):
 * with Opie, it asks them out loud and fills them in; without, they're typed. Turning it on is the consent (the line
 * says what goes to OpenAI).
 */
@Composable
internal fun WelcomeSheet() {
    val o = Openhouse
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        Box(Modifier.fillMaxSize().background(Calm.scrim).clickable(enabled = false) {}, contentAlignment = Alignment.Center) {
            QuietCard(Modifier.width(760.u), padding = PaddingValues(horizontal = 56.u, vertical = 52.u)) {
                Text("Welcome to OpenHouse", style = calmText(Calm.DISPLAY, FontWeight.Medium))
                Spacer(Modifier.height(16.u))
                Text("Say “Hey Opie” or just type, and Opie answers. What you say after “Hey Opie” goes to OpenAI.", style = calmText(Calm.LEAD, color = Calm.soft))
                Spacer(Modifier.height(40.u))
                // A tablet set up somewhere else (a beta tablet we set up and sent) arrives knowing a Wi-Fi that isn't
                // here: joining this one comes first, then the same choice. Android's Wi-Fi settings; Home comes back.
                if (o.net == Net.NoNetwork) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.u)) {
                    Box(Modifier.clip(RoundedCornerShape(99.u)).background(Calm.ink).clickable { o.joinWifi() }.padding(horizontal = 36.u, vertical = 20.u)) {
                        Text("Join Wi-Fi", style = calmText(21, FontWeight.SemiBold, Calm.sheet))
                    }
                    Text("First, connect to your Wi-Fi.", style = calmText(21, color = Calm.soft))
                } else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
                    Box(Modifier.clip(RoundedCornerShape(99.u)).background(Calm.ink).clickable { o.welcomeAssistant() }.padding(horizontal = 36.u, vertical = 20.u)) {
                        Text("Turn on Opie", style = calmText(21, FontWeight.SemiBold, Calm.sheet))
                    }
                    Box(Modifier.clip(RoundedCornerShape(99.u)).clickable { o.welcomeLater() }.padding(horizontal = 24.u, vertical = 20.u)) {
                        Text("Without Opie", style = calmText(21, FontWeight.Medium, Calm.soft))
                    }
                }
            }
        }
    }
}

/** Someone dropped an app's magnet on the trash: the display asks first (part of the shell, so the agent can't change it). */
@Composable
internal fun DeleteAppSheet(a: AppInfo) {
    val o = Openhouse
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .3f)).clickable { o.confirmDelete = null }, contentAlignment = Alignment.Center) {
            QuietCard(Modifier.width(600.u).clickable(enabled = false) {}) {
                Text("Delete ${a.name}?", style = quietText(30, FontWeight.SemiBold))
                Text("It comes off the home screen and the tablet.", style = quietText(18, color = PaperLook.inkSoft))
                Spacer(Modifier.height(22.u))
                Row(horizontalArrangement = Arrangement.spacedBy(10.u)) { Spacer(Modifier.weight(1f)); Chip("Cancel") { o.confirmDelete = null }
                    // Deleting can't simply be taken back: the red button (docs/ux.md).
                    Box(Modifier.height(62.u).clip(RoundedCornerShape(31.u)).background(Color(Calm.DANGER)).clickable { o.deleteApp(a) }.padding(horizontal = 34.u), contentAlignment = Alignment.Center) {
                        Text("Delete", style = quietText(20, FontWeight.SemiBold, Calm.sheet))
                    } }
            }
        }
    }
}

/** What's in flight (tap the note while it works): each thing it's doing for someone, in its own latest words; stop any. */
@Composable
internal fun JobsSheet() {
    val o = Openhouse
    val build = o.build?.takeIf { !it.done }
    LaunchedEffect(o.inFlight.isEmpty() && build == null) { if (o.inFlight.isEmpty() && build == null) o.showJobs = false }
    // What it's working on: white cards rising from the voice button (the bottom-left), like its words, each with Stop.
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .12f)).clickable { o.showJobs = false }, contentAlignment = Alignment.BottomStart) {
            Column(Modifier.padding(start = 24.u, bottom = 100.u).width(560.u).clickable(enabled = false) {}, verticalArrangement = Arrangement.spacedBy(12.u)) {
                o.inFlight.forEach { j ->
                    QuietCard(Modifier.fillMaxWidth(), padding = PaddingValues(start = 26.u, end = 18.u, top = 16.u, bottom = 16.u)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.u)) {
                            Column(Modifier.weight(1f)) {
                                Text("“${j.question}”", style = quietText(20, FontWeight.Medium), maxLines = 2)
                                val mins = ((o.now - j.startedAt) / 60_000).toInt()
                                Text(listOfNotNull(j.who, j.status.ifBlank { null }, if (mins > 0) "$mins min" else null).joinToString(" · "), style = quietText(16, color = PaperLook.inkSoft), maxLines = 2)
                            }
                            StopButton { o.stopJob(j.id) }
                        }
                    }
                }
                build?.let { b ->
                    QuietCard(Modifier.fillMaxWidth(), padding = PaddingValues(start = 26.u, end = 18.u, top = 16.u, bottom = 16.u)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.u)) {
                            Column(Modifier.weight(1f)) {
                                Text("“${b.request}”", style = quietText(20, FontWeight.Medium), maxLines = 2)
                                Text((b.live ?: b.stage), style = quietText(16, color = PaperLook.inkSoft), maxLines = 1)
                            }
                            StopButton { o.cancelBuild() }
                        }
                    }
                }
            }
        }
    }
}

/** Stop: a square in a round button, like a player's. No word. */
@Composable
fun StopButton(size: Int = 44, onClick: () -> Unit) {
    Box(Modifier.size(size.u).clip(androidx.compose.foundation.shape.CircleShape).background(Oh.warnBg).border(1.u, Oh.warn, androidx.compose.foundation.shape.CircleShape)
        .semantics { contentDescription = "Stop" }.clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Box(Modifier.size((size * 0.36f).u).clip(RoundedCornerShape((size * 0.07f).u)).background(Oh.warn))
    }
}
