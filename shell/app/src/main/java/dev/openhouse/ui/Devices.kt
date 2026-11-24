package dev.openhouse.ui

// The devices in the house (TVs, speakers, the printer…), found on the display's Wi-Fi and over
// Bluetooth by the bridge (bridge/devices, docs/bluetooth.md) and controlled directly. On the board: `DevicesPaper()`, a note on the
// home screen; tapping it opens the devices sheet. The agent can do the same things by voice.

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class HomeDevice(
    val id: String, val name: String, val kind: String, val maker: String?, val model: String?, val room: String?,
    val address: String, val actions: List<String>, val present: Boolean, val self: Boolean,
    /** A recipe the agent wrote for it, and the actions that need no parameters (they get buttons). */
    val recipe: String? = null, val simple: List<String> = emptyList(),
    /** "wifi" or "bluetooth"; a Bluetooth one is paired with the tablet or not. */
    val transport: String = "wifi", val bonded: Boolean = false,
) { val bluetooth get() = transport == "bluetooth" }

/** What the bridge knows about the devices in the house. Compose reads the state. */
object Devices {
    var list by mutableStateOf(listOf<HomeDevice>()); private set
    var scannedAt by mutableStateOf<String?>(null); private set
    var scanning by mutableStateOf(false); private set
    var open by mutableStateOf(false)
    /** Last status per device id (e.g. "On", "Playing · Little Grey Squirrel", ink levels). */
    val status = mutableStateMapOf<String, String>()
    val ink = mutableStateMapOf<String, List<Pair<String, Int>>>()
    /** A device id → what it's doing right now ("Turning off…"), or the last error. */
    val busy = mutableStateMapOf<String, String>()
    var error by mutableStateOf<String?>(null); private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loaded = false

    /** The devices worth a button: something openhouse can control, and not the display itself. */
    val controllable get() = list.filter { it.present && !it.self && it.actions.any { a -> a !in setOf("status", "apps", "pair", "forget") } || it.kind == "printer" && it.present }

    private fun call(method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 20_000): JSONObject? = runCatching {
        BridgeClient.open(Openhouse.bridgeUrl + path).run {
            requestMethod = method; connectTimeout = 3000; readTimeout = timeoutMs
            if (body != null) { doOutput = true; setRequestProperty("content-type", "application/json"); outputStream.use { it.write(body.toString().toByteArray()) } }
            JSONObject(inputStream.use { it.readBytes().toString(Charsets.UTF_8) })
        }
    }.getOrNull()

    private fun parse(j: JSONObject) {
        val a = j.optJSONArray("devices") ?: JSONArray()
        list = (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { d ->
            val acts = d.optJSONArray("actions"); val simple = d.optJSONArray("simple")
            HomeDevice(d.optString("id"), d.optString("name"), d.optString("kind", "other"), d.opt("maker") as? String, d.opt("model") as? String,
                d.opt("room") as? String, d.optString("address"), (0 until (acts?.length() ?: 0)).map { acts!!.optString(it) },
                d.optBoolean("present", true), d.optBoolean("self"), d.opt("recipe") as? String,
                (0 until (simple?.length() ?: 0)).map { simple!!.optString(it) }, d.optString("transport", "wifi"), d.optBoolean("bonded"))
        }
        scannedAt = j.opt("scannedAt") as? String
    }

    private fun loadList(): Boolean = call("GET", "/devices")?.let { parse(it); loaded = true; true } ?: false
    fun load() { scope.launch { if (loadList()) statuses() } }
    /** Keep the list current: retry until the bridge answers (it may still be starting), then each
     *  minute, so a scan the agent ran by voice shows up. Only the list; statuses when it's opened. */
    suspend fun ensureLoaded() { while (true) { scope.launch { loadList() }; kotlinx.coroutines.delay(if (loaded) 60_000 else 5_000) } }

    fun scan() {
        if (scanning) return
        scanning = true; error = null
        scope.launch {
            val j = call("POST", "/devices/scan", JSONObject(), 60_000)
            if (j?.has("devices") == true) { parse(j); statuses() } else error = j?.optString("error") ?: "Couldn’t look for devices."
            scanning = false
        }
    }

    /** Opening the sheet: the latest list (a scan may have run by voice), then each device's state. */
    fun refreshStatus() { scope.launch { loadList(); statuses() } }
    private fun statuses() { controllable.filter { "status" in it.actions }.forEach { d -> scope.launch { readStatus(d) } } }

    private fun readStatus(d: HomeDevice) {
        val r = call("POST", "/devices/action", JSONObject().put("device", d.id).put("action", "status")) ?: return
        val res = r.optJSONObject("result")
        if (!r.optBoolean("ok") || res == null) { status[d.id] = if (r.optString("text").contains("isn't answering")) "Not answering" else "—"; return }
        status[d.id] = describe(d, res)
        res.optJSONArray("ink")?.let { a -> ink[d.id] = (0 until a.length()).map { a.getJSONObject(it).let { m -> m.optString("name") to m.optInt("percent") } } }
    }

    private fun describe(d: HomeDevice, r: JSONObject): String {
        val power = r.optString("power").lowercase()
        return when {
            r.optBoolean("bluetooth") -> listOfNotNull(
                if (r.optBoolean("sound_here")) "Playing the tablet’s sound" else if (r.optBoolean("connected")) "Connected" else if (r.optBoolean("paired")) "Paired" else "Not paired",
                (r.opt("volume") as? Number)?.let { "volume $it" },
                (r.opt("battery") as? Number)?.let { "battery $it%" },
                (r.opt("temperature_c") as? Number)?.let { "%.1f°".format(it.toDouble()) },
                (r.opt("humidity") as? Number)?.let { "${it.toInt()}% humidity" },
            ).joinToString(" · ")
            r.has("state") && r.has("volume") -> { // a speaker
                val state = r.optString("state").replaceFirstChar { it.uppercase() }
                val what = listOfNotNull((r.opt("title") as? String)?.takeIf { it.isNotBlank() }).joinToString()
                listOf(state, what, "volume ${r.optInt("volume")}${if (r.optBoolean("muted")) " (muted)" else ""}").filter { it.isNotBlank() }.joinToString(" · ")
            }
            d.kind == "printer" -> listOfNotNull(r.optString("state").replaceFirstChar { it.uppercase() }, r.optJSONArray("problems")?.takeIf { it.length() > 0 }?.join(", ")?.replace("\"", "")).joinToString(" · ")
            r.has("app") -> listOfNotNull(if (power.contains("on")) "On" else "Off", (r.opt("app") as? String)?.takeIf { it != "nothing" }).joinToString(" · ")
            power.startsWith("on") -> "On"
            power.isNotBlank() -> "Off"
            else -> ""
        }
    }

    /** Do an action. Risky ones show the shell's "Is this OK?" card before anything happens. */
    fun act(d: HomeDevice, action: String, params: JSONObject = JSONObject(), doing: String) {
        if (busy[d.id] != null && busy[d.id]!!.endsWith("…")) return
        busy[d.id] = doing
        scope.launch {
            val r = call("POST", "/devices/action", JSONObject().put("device", d.id).put("action", action).put("params", params), 120_000)
            if (r?.optBoolean("ok") == true) { busy.remove(d.id); if (action == "pair" || action == "forget") loadList(); readStatus(d) }
            else busy[d.id] = r?.optString("text")?.take(140) ?: "Couldn’t reach it."
        }
    }
}

// --- drawing ---------------------------------------------------------------------------------

/** A small line drawing of what a device is: tv, speaker, printer, console, light, other. */
@Composable
fun DeviceGlyph(kind: String, modifier: Modifier = Modifier, color: Color = PaperLook.ink) {
    Canvas(modifier) {
        val w = size.width; val h = size.height; val s = Stroke(width = w * .07f, cap = StrokeCap.Round)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(color, Offset(x1 * w, y1 * h), Offset(x2 * w, y2 * h), s.width, StrokeCap.Round)
        fun box(x: Float, y: Float, bw: Float, bh: Float, r: Float = .06f) = drawRoundRect(color, Offset(x * w, y * h), Size(bw * w, bh * h), CornerRadius(r * w), style = s)
        when (kind) {
            "tv", "streamer" -> { box(.08f, .16f, .84f, .56f); line(.38f, .88f, .62f, .88f); line(.5f, .72f, .5f, .88f) }
            "speaker" -> { box(.24f, .08f, .52f, .84f, .1f); drawCircle(color, w * .14f, Offset(w * .5f, h * .6f), style = s); drawCircle(color, w * .04f, Offset(w * .5f, h * .24f)) }
            "printer" -> { box(.08f, .36f, .84f, .36f); box(.26f, .1f, .48f, .26f, .02f); box(.26f, .62f, .48f, .3f, .02f) }
            "console" -> { box(.06f, .3f, .88f, .44f, .2f); line(.22f, .52f, .36f, .52f); line(.29f, .45f, .29f, .59f); drawCircle(color, w * .045f, Offset(w * .68f, h * .47f)); drawCircle(color, w * .045f, Offset(w * .78f, h * .57f)) }
            "headphones" -> { drawArc(color, 180f, 180f, false, Offset(w * .18f, h * .14f), Size(w * .64f, h * .64f), style = s); box(.12f, .5f, .16f, .32f, .05f); box(.72f, .5f, .16f, .32f, .05f) }
            "tag" -> { drawCircle(color, w * .3f, Offset(w * .5f, h * .56f), style = s); drawCircle(color, w * .07f, Offset(w * .5f, h * .2f), style = s) }
            "light" -> { drawCircle(color, w * .26f, Offset(w * .5f, h * .4f), style = s); line(.4f, .78f, .6f, .78f); line(.42f, .9f, .58f, .9f) }
            else -> { box(.16f, .16f, .68f, .68f, .14f); drawCircle(color, w * .08f, Offset(w * .5f, h * .5f)) }
        }
    }
}

/** A sticker in the home screen's bottom row (beside the apps): opens the devices sheet. Takes no cell of the grid. */
@Composable
fun DevicesSticker(modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { Devices.ensureLoaded() }
    val n = Devices.controllable.size
    Sticker("Devices", if (Devices.scannedAt == null) "find them" else "$n to use", PaperLook.magnets[5], modifier, tilt = -2f,
        onClick = { Devices.open = true; if (Devices.scannedAt == null) Devices.scan() else Devices.load() }) {
        DeviceGlyph("tv", Modifier.size(58.u), Color.White)
    }
    if (Devices.open) DevicesSheet()
}

/** The note on the home screen: the devices openhouse can use, and a way to look for more. */
@Composable
fun DevicesPaper(modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { Devices.ensureLoaded() }
    val ds = Devices.controllable
    Paper(modifier.clickable { Devices.open = true; Devices.refreshStatus() }, kind = PaperKind.Plain, tilt = 1.1f, magnet = PaperLook.magnets[5]) {
        Text("Devices", style = handText(40, weight = FontWeight.Bold))
        Spacer(Modifier.height(6.u))
        when {
            Devices.scannedAt == null -> Text(if (Devices.scanning) "Looking around the house…" else "Tap to find the TVs, speakers and printers here.", style = roundText(18, FontWeight.Medium, PaperLook.inkSoft))
            ds.isEmpty() -> Text("Nothing here to control yet.", style = roundText(18, FontWeight.Medium, PaperLook.inkSoft))
            else -> ds.take(5).forEach { d ->
                Row(Modifier.padding(vertical = 4.u), verticalAlignment = Alignment.CenterVertically) {
                    DeviceGlyph(d.kind, Modifier.size(30.u))
                    Spacer(Modifier.width(12.u))
                    Text(d.name, style = roundText(20, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Devices.status[d.id]?.takeIf { it.isNotBlank() }?.let { Text("  ${it.substringBefore(" · ")}", style = roundText(16, FontWeight.Medium, PaperLook.inkSoft), maxLines = 1) }
                }
            }
        }
    }
    if (Devices.open) DevicesSheet()
}

@Composable
private fun DeviceButton(label: String, primary: Boolean = false, onClick: () -> Unit) {
    Box(Modifier.clip(RoundedCornerShape(999.u)).background(if (primary) Calm.ink else Calm.tint2).clickable(onClick = onClick).padding(horizontal = 24.u, vertical = 14.u)) {
        Text(label, style = calmText(19, FontWeight.SemiBold, if (primary) Calm.sheet else Calm.ink))
    }
}

/** A device paired with the tablet: another screen, a TV, someone's phone, a computer (bridge /screens). */
private data class Linked(val id: String, val name: String, val kind: String)

/** Linked devices: those paired with the tablet (screens, TVs, phones, computers and the AIs on them), then everything
 *  found on the Wi-Fi, with the buttons each one has. Adding or removing a paired one asks for the PIN when the PIN
 *  Lock is on. */
@Composable
fun DevicesSheet() {
    var linked by remember { mutableStateOf(listOf<Linked>()) }
    LaunchedEffect(Unit) {
        while (true) {
            linked = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { org.json.JSONObject(BridgeClient.getText(Openhouse.bridgeUrl + "/screens", 2000, 4000)).optJSONArray("screens") }.getOrNull()
                    ?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { Linked(it.optString("id"), it.optString("name"), it.optString("kind", "screen")) } }.orEmpty()
            }
            kotlinx.coroutines.delay(3000)
        }
    }
    Dialog(onDismissRequest = { Devices.open = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Calm.scrim).clickable { Devices.open = false }, contentAlignment = Alignment.Center) {
            QuietCard(Modifier.fillMaxWidth(.86f).fillMaxHeight(.86f).clickable(enabled = false) {}) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SettingsBack()
                    Text("Linked devices", style = calmText(Calm.TITLE, FontWeight.SemiBold), modifier = Modifier.weight(1f))
                    DeviceButton("Add") { Openhouse.host.setting("addLinked") }
                    Spacer(Modifier.width(12.u))
                    DeviceButton("Done", primary = true) { Devices.open = false }
                }
                // Looking again is a quiet line under the title, not a third button (docs/ux.md).
                Text(Devices.error ?: if (Devices.scanning) "Looking on the Wi-Fi and Bluetooth…" else "Look again",
                    style = calmText(18, FontWeight.Medium, Calm.soft),
                    modifier = Modifier.clip(RoundedCornerShape(8.u)).clickable(enabled = !Devices.scanning) { Devices.scan() }.padding(vertical = 4.u))
                Spacer(Modifier.height(18.u))
                val ds = Devices.list.filter { it.present }
                val (useful, rest) = ds.partition { it in Devices.controllable }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.u)) {
                    linked.forEach { l ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.u)) {
                            DeviceGlyph(if (l.kind == "tv") "tv" else l.kind, Modifier.size(30.u))
                            Spacer(Modifier.width(14.u))
                            Text(l.name, style = calmText(21, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(when (l.kind) { "computer" -> "Computer"; "tv" -> "TV"; "phone" -> "Phone"; else -> "Screen" }, style = calmText(17, FontWeight.Normal, Calm.soft))
                            Spacer(Modifier.width(16.u))
                            DeviceButton("Remove") { Openhouse.host.setting("unlink:" + l.id) }
                        }
                    }
                    if (linked.isNotEmpty() && useful.isNotEmpty()) Spacer(Modifier.height(8.u))
                    useful.chunked(2).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(14.u)) {
                            row.forEach { DeviceCard(it, Modifier.weight(1f)) }
                            if (row.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                    if (rest.isNotEmpty()) {
                        Spacer(Modifier.height(6.u))
                        Text("ALSO HERE", style = calmText(Calm.EYEBROW, FontWeight.SemiBold, Calm.soft).copy(letterSpacing = androidx.compose.ui.unit.TextUnit(.08f, androidx.compose.ui.unit.TextUnitType.Em)))
                        rest.forEach { d ->
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.u)) {
                                DeviceGlyph(d.kind, Modifier.size(24.u), Calm.soft)
                                Spacer(Modifier.width(10.u))
                                Text(d.name + listOfNotNull(d.model?.takeIf { it != d.name }, if (d.self) "this display" else null, if (d.bluetooth) "Bluetooth" else null).joinToString("") { " · $it" },
                                    style = calmText(18, FontWeight.Normal, Calm.soft), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                // A Bluetooth device nearby: pairing is a tap here (Android may show a code to check).
                                if ("pair" in d.actions) {
                                    Spacer(Modifier.width(16.u))
                                    Devices.busy[d.id]?.let { Text(it, style = calmText(16, FontWeight.Medium, Calm.soft), maxLines = 1) }
                                        ?: DeviceButton("Pair") { Devices.act(d, "pair", doing = "Pairing…") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private val KNOWN = setOf("play", "pause", "volume_up", "volume_down", "press", "power_off", "power_on", "pair", "forget", "play_here", "stop_here", "beep", "stop_beep", "set_volume")

@Composable
private fun DeviceCard(d: HomeDevice, modifier: Modifier) {
    val st = Devices.status[d.id]
    val busy = Devices.busy[d.id]
    Column(modifier.clip(RoundedCornerShape(Calm.R_CARD.u)).background(Calm.tint).padding(24.u)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            DeviceGlyph(d.kind, Modifier.size(46.u))
            Spacer(Modifier.width(16.u))
            Column(Modifier.weight(1f)) {
                Text(d.name, style = calmText(23, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(d.model?.takeIf { it != d.name }, d.room?.takeIf { it != d.name }).joinToString(" · ").ifBlank { d.maker ?: d.kind },
                    style = calmText(16, FontWeight.Normal, Calm.soft), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.height(8.u))
        Text(busy ?: st ?: " ", style = calmText(17, FontWeight.Medium, if (busy != null && !busy.endsWith("…")) Calm.accent else Calm.ink), maxLines = 2)
        Devices.ink[d.id]?.let { levels ->
            Spacer(Modifier.height(8.u))
            levels.forEach { (name, pct) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, style = calmText(15, FontWeight.Normal, Calm.soft), modifier = Modifier.width(80.u))
                    Box(Modifier.weight(1f).height(12.u).clip(RoundedCornerShape(6.u)).background(Color.Black.copy(alpha = .08f))) {
                        Box(Modifier.fillMaxWidth(pct.coerceIn(0, 100) / 100f).fillMaxHeight().background(if (pct < 15) Calm.accent else Calm.soft))
                    }
                    Text("  $pct%", style = calmText(15, FontWeight.Medium))
                }
            }
        }
        Spacer(Modifier.height(12.u))
        Row(horizontalArrangement = Arrangement.spacedBy(10.u)) {
            val a = d.actions
            val playing = st?.startsWith("Playing") == true
            // A Bluetooth speaker: where the tablet's sound goes, and its volume while it plays there.
            if ("play_here" in a) {
                val here = st?.startsWith("Playing the tablet") == true
                if (here) DeviceButton("Back to the tablet") { Devices.act(d, "stop_here", doing = "Switching…") }
                else DeviceButton("Play here", primary = true) { Devices.act(d, "play_here", doing = "Connecting…") }
                if (here) { DeviceButton("Quieter") { Devices.act(d, "volume_down", doing = "Quieter…") }; DeviceButton("Louder") { Devices.act(d, "volume_up", doing = "Louder…") } }
            }
            if ("beep" in a) DeviceButton("Beep") { Devices.act(d, "beep", doing = "Beeping…") }
            if (d.bluetooth && "pair" in a) DeviceButton("Pair", primary = true) { Devices.act(d, "pair", doing = "Pairing…") }
            if (!d.bluetooth) { // (a Bluetooth speaker's volume is above, only while it plays there)
                if ("pause" in a && playing) DeviceButton("Pause") { Devices.act(d, "pause", doing = "Pausing…") }
                else if ("play" in a) DeviceButton("Play") { Devices.act(d, "play", doing = "Playing…") }
                if ("volume_down" in a) DeviceButton("Quieter") { Devices.act(d, "volume_down", doing = "Quieter…") }
                if ("volume_up" in a) DeviceButton("Louder") { Devices.act(d, "volume_up", doing = "Louder…") }
            }
            if ("press" in a && d.kind == "streamer") DeviceButton("Home") { Devices.act(d, "press", JSONObject().put("button", "home"), "Going home…") }
            val isOn = st?.startsWith("On") == true
            if ("power_off" in a && st?.startsWith("Off") != true) DeviceButton("Turn off", primary = true) { Devices.act(d, "power_off", doing = "Turning off…") }
            else if ("power_on" in a && !isOn) DeviceButton("Turn on", primary = true) { Devices.act(d, "power_on", doing = "Asking first…") }
            // A device the agent taught (a recipe): its actions that need nothing filled in.
            if (d.recipe != null) d.simple.filter { it != "status" && it !in KNOWN }.take(4).forEach { name ->
                DeviceButton(name.replace('_', ' ').replaceFirstChar { it.uppercase() }) { Devices.act(d, name, doing = "Working…") }
            }
        }
    }
}
