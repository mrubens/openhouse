package dev.openhouse.ui

// A phone on the home Wi-Fi, for the starting apps: the display shows a QR code, a phone scans it and gets a page
// served by the display itself (dev.openhouse.shell.Handoff: sealed with the key in the code, only while the card is
// open). Nothing leaves the house, except a list's ticks through the relay, sealed, when the family turned on reaching
// the tablet from away from home (bridge/relay.js).
//
//   PhonePhotos(onClose)       pick photos on the phone; they land in the family's photos (House.photos)
//   PhoneFlyer(onClose)        a photo of a flyer; the assistant reads its events (House: flyer)
//   PhoneList(list, onClose)   a list (Groceries) on the phone, to take to the store: check off, copy, text, email
//                              (live away from home too, through the relay, when the family turned it on)
//   PhoneQr(...)               the card itself, for another kind of page (an asset with the same sealing code)

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import dev.openhouse.shell.Handoff
import org.json.JSONArray
import org.json.JSONObject

/**
 * A card with a QR code for a phone on the home Wi-Fi. [page]: the phone page (an asset); [info]: what it shows
 * (sealed); [onData]: each thing the phone sends (on a background thread). It stops when the card closes, or after
 * [minutes]. [onSent]: how many arrived so far, for the card's line.
 */
@Composable
fun PhoneQr(title: String, help: String, page: String, info: JSONObject, maxBytes: Int = 16_384, minutes: Int = 15,
            onData: ((ByteArray) -> Unit)? = null, sent: Int = 0, sentLabel: (Int) -> String = { "" }, shared: Handoff? = null,
            /** Another address for the same page (a list's page on the cloud, which opens anywhere), else the handoff's own. */
            link: String? = null, onClose: () -> Unit) {
    val ctx = LocalContext.current
    // [shared]: one already running that outlives the card (a list on a phone at the store); else the card's own.
    val handoff = remember {
        shared ?: Handoff(ctx, info, minutes = minutes, onEnd = {}, page = page, maxBytes = maxBytes, once = false, onData = onData ?: { _ -> })
    }
    val started = remember { if (shared != null) shared.running else runCatching { handoff.start() }.getOrDefault(false) }
    DisposableEffect(Unit) { onDispose { if (shared == null) handoff.stop() } }
    val url = if (handoff.url != null) link ?: handoff.url else null
    val code = remember(started, url) { url?.let { runCatching { Handoff.qr(it, 520).asImageBitmap() }.getOrNull() } }
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable(MutableInteractionSource(), null) { onClose() }, contentAlignment = Alignment.Center) {
        Column(Modifier.width(820.u).clip(RoundedCornerShape(30.u)).background(Door.paper).clickable(MutableInteractionSource(), null) {}.padding(36.u),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.u)) {
            Text(title, style = roundText(40, FontWeight.ExtraBold), modifier = Modifier.fillMaxWidth())
            if (code != null) {
                Image(code, "QR code", Modifier.size(440.u).clip(RoundedCornerShape(16.u)))
                Text(help, style = roundText(24, FontWeight.SemiBold, Door.inkSoft), modifier = Modifier.fillMaxWidth())
                if (sent > 0) Text(sentLabel(sent), style = roundText(28, FontWeight.ExtraBold, Door.magnets[2]), modifier = Modifier.fillMaxWidth())
            } else Text("The display isn't on Wi-Fi right now, so a phone can't reach it.", style = roundText(26, FontWeight.SemiBold, Door.inkSoft), modifier = Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.u, Alignment.End)) {
                // the same link through Android's share sheet (a message to someone on the Wi-Fi, a nearby phone)
                if (code != null) BigButton("Share", primary = false) { url?.let { House.share(it) } }
                BigButton("Done") { onClose() }
            }
        }
    }
}

/** Photos from a phone on the home Wi-Fi: they're made screen-sized on the phone and land in the family's photos. */
@Composable
fun PhonePhotos(onClose: () -> Unit) {
    var sent by remember { mutableStateOf(0) }
    val main = remember { android.os.Handler(android.os.Looper.getMainLooper()) }
    PhoneQr("Add photos from a phone", "Scan this with a phone on the home Wi-Fi, then pick photos.", "photos.html",
        JSONObject().put("title", "Add photos to the display"),
        maxBytes = 12_000_000, minutes = 20, sent = sent, sentLabel = { if (it == 1) "1 photo added" else "$it photos added" },
        onData = { bytes ->
            if (!House.addPhoto(bytes)) throw IllegalStateException("the display didn't take it")
            main.post { sent++ }
        }, onClose = onClose)
}

/** A flyer or school notice from a phone: one photo, which the assistant reads into events (the Calendar app shows
 *  them to say yes to). The card closes once it's sent. */
@Composable
fun PhoneFlyer(onClose: () -> Unit) {
    val main = remember { android.os.Handler(android.os.Looper.getMainLooper()) }
    PhoneQr("A flyer to the calendar", "Scan this with a phone on the home Wi-Fi, then take a photo of the flyer (or pick one).", "photos.html",
        JSONObject().put("title", "A flyer to the display's calendar").put("label", "Photo of the flyer").put("one", true)
            .put("sent", "Sent. The display is reading it."),
        maxBytes = 12_000_000, minutes = 15,
        onData = { bytes ->
            if (!House.addFlyer(bytes)) throw IllegalStateException("the display didn't take it")
            main.post { onClose() }
        }, onClose = onClose)
}

/** A recipe for a meal from a phone: one photo, which the assistant types into the recipe box. */
@Composable
fun PhoneRecipe(meal: String, onClose: () -> Unit) {
    val main = remember { android.os.Handler(android.os.Looper.getMainLooper()) }
    PhoneQr("The recipe for $meal", "Scan this with a phone on the home Wi-Fi, then take a photo of the recipe (or pick one).", "photos.html",
        JSONObject().put("title", "The recipe for $meal").put("label", "Photo of the recipe").put("one", true).put("sent", "Sent. The display is reading it."),
        maxBytes = 12_000_000, minutes = 15,
        onData = { bytes ->
            if (!House.addRecipePhoto(bytes, meal)) throw IllegalStateException("the display didn't take it")
            main.post { onClose() }
        }, onClose = onClose)
}

/** A list on a phone: live while it's on the home Wi-Fi (ticks and new items both ways), and still there at the
 *  store, where what's ticked waits on the phone until it's home. The link keeps working for a few hours after the
 *  card closes (ListShares), and opening the card again shows the same one. */
@Composable
fun PhoneList(list: HouseList, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val shared = remember(list.id) { ListShares.open(ctx.applicationContext, list.id) }
    var link by remember { mutableStateOf(ListShares.anywhere(list.id)) }
    LaunchedEffect(list.id) { repeat(20) { ListShares.anywhere(list.id)?.let { link = it; return@LaunchedEffect }; kotlinx.coroutines.delay(250) } }
    PhoneQr("${list.name} on your phone",
        if (link != null) "Scan this with a phone. Ticks and new items go both ways, at home or out."
        else "Scan this with a phone on the home Wi-Fi. Ticks and new items go both ways while it's on the Wi-Fi; at the store, keep the page open and they come back with you.",
        "list.html", JSONObject(), shared = shared, link = link, onClose = onClose)
}

/** Lists shared to a phone, by list id: running until a few hours pass (each one a sealed page on the home Wi-Fi). */
object ListShares {
    private const val HOURS = 3
    private val running = mutableMapOf<String, Handoff>()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    fun open(ctx: android.content.Context, listId: String): Handoff? {
        running[listId]?.takeIf { it.running }?.let { if (relays[listId] == null) viaRelay(listId, it); return it }
        lateinit var h: Handoff
        h = Handoff(ctx, JSONObject(), minutes = HOURS * 60, page = "list.html", maxBytes = 4096, once = false,
            onEnd = { if (running[listId] === h) { running.remove(listId); relays.remove(listId) } },
            onData = { bytes -> change(listId, JSONObject(String(bytes, Charsets.UTF_8))) },
            infoNow = { info(listId) })
        if (!runCatching { h.start() }.getOrDefault(false)) return null
        running[listId] = h
        // Away from home too, when the family turned that on (Cloud → Use it away from home): the page learns
        // the relay from its sealed info and goes through it when the Wi-Fi doesn't answer (docs/networking.md).
        viaRelay(listId, h)
        return h
    }
    private fun viaRelay(listId: String, h: Handoff) {
        val base = h.url?.substringBefore("/#") ?: return
        kotlin.concurrent.thread(isDaemon = true) {
            House.relayHandoff(base, HOURS * 60)?.let { r ->
                relays[listId] = r
                h.relayOrigin = Regex("^(wss?://[^/]+)").find(r.optString("url"))?.value
            }
        }
    }
    private val relays = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
    /** This list's page on the cloud, which opens anywhere and goes through the relay (when the family turned
     *  reaching the tablet from away on): <page>#<key>.<relay>.<token>; else null (the page on the Wi-Fi). */
    fun anywhere(listId: String): String? {
        val r = relays[listId] ?: return null
        val page = r.optString("page").takeIf { it.startsWith("https://") || it.startsWith("http://localhost") || it.startsWith("http://10.0.2.2") } ?: return null
        val key = running[listId]?.url?.substringAfter("#", "")?.takeIf { it.isNotEmpty() } ?: return null
        return "$page#$key.${r.optString("relay")}.${r.optString("token")}"
    }

    /** The list as the phone shows it: what's on it, ticked or not. */
    private fun info(listId: String): JSONObject {
        val l = House.list(listId) ?: return JSONObject().put("title", "This list").put("live", true).put("items", JSONArray())
        return JSONObject().put("title", l.name).put("live", true)
            .put("items", JSONArray(l.items.map { JSONObject().put("id", it.id).put("text", it.text).put("done", it.done) }))
            .apply { relays[listId]?.let { r -> put("relay", JSONObject().put("url", r.optString("url")).put("relay", r.optString("relay")).put("token", r.optString("token"))) } }
    }

    /** What the phone did: { check: id, done } or { add: text }. */
    private fun change(listId: String, op: JSONObject) {
        val l = House.list(listId) ?: throw IllegalStateException("no such list")
        when {
            op.has("check") -> {
                val item = l.items.firstOrNull { it.id == op.optString("check") } ?: return // gone meanwhile: nothing to do
                main.post { House.check(l.name, item, op.optBoolean("done", true)) }
            }
            op.has("add") -> op.optString("add").trim().take(80).takeIf { it.isNotEmpty() }?.let { t -> main.post { House.addItem(l.name, t) } }
            else -> throw IllegalArgumentException("what?")
        }
    }
}
