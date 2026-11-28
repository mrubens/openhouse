package dev.openhouse.ui

// Settings (the gear): one full-screen page, its tabs down the left and the chosen one on the right (docs/settings.md).
// A row that needs more opens in the same pane (SettingsPages), with a ‹ back; only a question and the PIN pad float.
// On a phone the tabs are a list, and a tab opens full screen with a ‹ back to it.

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** A tab: its [id], its [name] and, for one that is a page of the shell's (Connections, Account, Advanced), the row that opens it. */
private data class SettingsTab(val id: String, val name: String, val page: String? = null)

private val TABS = listOf(
    SettingsTab("household", "Household"), SettingsTab("opie", "Opie"), SettingsTab("connections", "Connections", "connections"),
    SettingsTab("screen", "Screen"), SettingsTab("devices", "Devices"), SettingsTab("account", "Account", "account"),
    SettingsTab("advanced", "Advanced", "tablet"),
)
/** A tablet that's part of another tablet's household (shell Satellite.kt): the household's settings are on that one. */
private val SATELLITE_TABS = listOf(SettingsTab("household", "Household"), SettingsTab("screen", "Screen"), SettingsTab("advanced", "Advanced", "tablet"))

object SettingsNav {
    /** The tab showing, or null for the list of tabs (a phone). */
    var tab by mutableStateOf<String?>(null)
    internal var compact = false

    internal fun choose(id: String?, page: String?) {
        SettingsPages.clear()
        tab = id
        SettingsPages.openRoot(page?.let { p -> { Openhouse.host.setting(p) } })
    }

    /** Up one level, inside Settings: a page, then (on a phone) the list of tabs. False: nothing left, Settings closes. */
    fun back(): Boolean {
        SettingsPages.top?.takeIf { it.canBack }?.let { it.goBack(); return true }
        if (compact && tab != null) { choose(null, null); return true }
        return false
    }
}

@Composable
internal fun SettingsScreen() {
    val o = Openhouse
    var vals by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // What the shell's rows show: read now, again whenever something closes, and every few seconds.
    LaunchedEffect(o.settingsV) { vals = withContext(Dispatchers.IO) { runCatching { o.host.settingValues() }.getOrDefault(vals) } }
    LaunchedEffect(Unit) { while (true) { delay(3000); vals = withContext(Dispatchers.IO) { runCatching { o.host.settingValues() }.getOrDefault(vals) } } }
    var sat by remember { mutableStateOf(dev.openhouse.shell.Satellite.on) }
    LaunchedEffect(Unit) { while (true) { sat = withContext(Dispatchers.IO) { dev.openhouse.shell.Satellite.refresh(o.bridgeUrl)?.optBoolean("satellite") == true }; delay(5000) } }
    val compact = isCompact()
    SettingsNav.compact = compact
    DisposableEffect(Unit) { onDispose { SettingsPages.clear(); SettingsNav.tab = null; SettingsPages.openRoot(null) } }
    val tabs = if (sat) SATELLITE_TABS else TABS
    // A tablet shows a tab from the start; a phone, the list.
    val current = tabs.firstOrNull { it.id == SettingsNav.tab } ?: if (compact) null else tabs[0]
    val lockOn = vals["lock"] == "On"
    val asks = vals["settingsLock"] == "On"
    fun tabLocked(t: SettingsTab) = when (t.id) { "account", "advanced" -> lockOn; else -> false } // (Connections: no PIN to look; its calendars ask)

    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        Row(Modifier.fillMaxSize().background(Calm.sheet).clickable(enabled = false) {}) {
            if (!compact || current == null) Column(
                (if (compact) Modifier.fillMaxSize() else Modifier.width(360.u).fillMaxHeight()).background(Calm.paper)
                    .padding(start = 28.u, end = 20.u, top = 28.u, bottom = 24.u)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Settings", style = quietText(30, FontWeight.SemiBold), modifier = Modifier.weight(1f))
                    Chip("Done") { o.showSettings = false }
                }
                Spacer(Modifier.height(24.u))
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.u)) {
                    tabs.forEach { t ->
                        val on = !compact && t.id == current?.id
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.u)).background(if (on) Calm.sheet else androidx.compose.ui.graphics.Color.Transparent)
                            .clickable { if (t.id != current?.id || compact) SettingsNav.choose(t.id, t.page) }.padding(horizontal = 16.u, vertical = 15.u),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text(t.name, style = quietText(21, if (on) FontWeight.SemiBold else FontWeight.Medium), modifier = Modifier.weight(1f))
                            if (tabLocked(t)) Icon(androidx.compose.material.icons.Icons.Filled.Lock, "Locked", tint = PaperLook.inkSoft, modifier = Modifier.size(18.u))
                        }
                    }
                }
                // The version is the way to updates (no PIN: seeing it and getting ours is everyone's).
                Text("Version ${vals["updates"] ?: ""}", style = quietText(18, color = PaperLook.inkSoft),
                    modifier = Modifier.clip(RoundedCornerShape(8.u)).clickable { o.host.setting("updates") }.padding(horizontal = 16.u, vertical = 8.u))
            }
            if (current != null) Box(Modifier.weight(1f).fillMaxHeight().imePadding()) {
                Pane(current, vals, compact, lockOn, asks, sat)
            }
        }
    }
}

/** The chosen tab, or the page opened from it. */
@Composable
private fun Pane(t: SettingsTab, vals: Map<String, String>, compact: Boolean, lockOn: Boolean, asks: Boolean, sat: Boolean) {
    val o = Openhouse
    fun shell(id: String) = { o.host.setting(id) }
    val page = SettingsPages.top
    val back: (() -> Unit)? = if (compact || page?.canBack == true) ({ SettingsNav.back() }) else null
    Column(Modifier.fillMaxSize().padding(start = (if (compact) 20 else 56).u, end = (if (compact) 20 else 48).u, top = 28.u, bottom = 0.u)) {
        if (page == null && t.id == "household" && !sat) { FamilyContent(inSettings = true, onBack = back); return@Column }
        if (page == null && t.id == "devices") { DevicesContent(inSettings = true, onBack = back); return@Column }
        Row(Modifier.heightIn(min = 48.u), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.u)) {
            back?.let { SettingsArrow(it) }
            Text(page?.title?.ifBlank { null } ?: t.name, style = quietText(30, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(12.u))
        if (page != null) {
            // The shell's page, as views (CalmDialog.showPage); the pane scrolls it.
            AndroidView({ c -> android.widget.ScrollView(c).apply { isVerticalScrollBarEnabled = false; isFillViewport = false } },
                Modifier.widthIn(max = 900.u).fillMaxWidth().weight(1f), update = { sv ->
                    if (sv.getChildAt(0) !== page.content) {
                        sv.removeAllViews(); (page.content.parent as? android.view.ViewGroup)?.removeView(page.content)
                        sv.addView(page.content, android.view.ViewGroup.LayoutParams(-1, -2)); sv.scrollTo(0, 0)
                    }
                })
            return@Column
        }
        Column(Modifier.offset(x = (-12).u).widthIn(max = 924.u).weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 40.u)) { // (rows' own inset: their words line up with the title)
            when (t.id) {
                "household" -> SettingsRow("Household", "On the main device", onClick = shell("satellite")) // (a satellite: docs/multi-tablet.md)
                "opie" -> {
                    SettingsRow("Voice", vals["voice"], asks, shell("voice"))
                    if (vals["voice"].let { it != null && it != "Off" }) SettingsRow("Talk to Opie", vals["talk"], onClick = shell("talk")) // "Hey Opie" or Tap to talk (no PIN: everyday)
                    SettingsRow("House rules", vals["houseRules"], lockOn, shell("houseRules")) // always the PIN when one is set (HouseRules.kt)
                    SettingsRow("Check the microphone", onClick = shell("micCheck"))
                    SettingsRow("What Opie remembers", vals["memory"], onClick = shell("memory"))
                    SettingsRow("Check-ins", vals["checkins"], lockOn, shell("checkins"))
                    SettingsRow("Device control", vals["deviceControl"], lockOn, shell("deviceControl"))
                    SettingsRow("Opie uses apps", vals["appsOn"], lockOn, shell("appsOn"))
                    if (vals["nowPlaying"] == "Off") SettingsRow("Now playing", "Off", lockOn, shell("nowplaying")) // (shown only while it's off)
                }
                "screen" -> {
                    SettingsRow("Brightness", vals["brightness"], onClick = shell("brightness")) // not behind the PIN: anyone can see the screen better
                    SettingsRow("Volume", vals["volume"], onClick = shell("volume")) // (nor this: anyone can hear it)
                    SettingsRow("Time", vals["time"], asks, shell("time"))
                    SettingsRow("Night hours", vals["night"], onClick = shell("night")) // (no PIN, as Opie's night_hours)
                }
                else -> Waiting(t, lockOn && t.id != "connections")
            }
        }
    }
}

/** A tab that is a page of the shell's, before it shows (its PIN, or the bridge answering), or when the PIN was cancelled. */
@Composable
private fun Waiting(t: SettingsTab, locked: Boolean) {
    var waited by remember(t.id) { mutableStateOf(false) }
    LaunchedEffect(t.id) { waited = false; delay(2500); waited = true }
    if (SettingsPages.dialogs > 0) return // (the PIN pad is up over it)
    if (!waited) { Dots(); return }
    Spacer(Modifier.height(8.u))
    Chip(if (locked) "Unlock" else "Try again") { SettingsNav.choose(t.id, t.page) }
}

/** ‹: up one level in Settings. */
@Composable
internal fun SettingsArrow(onClick: () -> Unit) {
    Box(Modifier.size(48.u).clip(CircleShape).clickable(onClick = onClick).semantics { contentDescription = "Back" }, contentAlignment = Alignment.Center) {
        androidx.compose.foundation.Canvas(Modifier.size(22.u)) {
            val w = size.width; val h = size.height
            drawPath(androidx.compose.ui.graphics.Path().apply { moveTo(w * .62f, h * .12f); lineTo(w * .28f, h * .5f); lineTo(w * .62f, h * .88f) },
                PaperLook.ink, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.4f * density, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
        }
    }
}
