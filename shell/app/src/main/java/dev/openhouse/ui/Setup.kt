package dev.openhouse.ui

// The first setup, right after the welcome (docs/onboarding.md): who lives here, where (a street address guessed from
// where the tablet is), then carrying on from a phone or a computer, where calendars, photos, invites for the family
// and making apps are done (the phone page's own setup, chat/src/phone.jsx), and last a PIN for settings and
// approvals (PIN Lock, which can be skipped). One step on screen at a time, each with Skip and Next. With Opie on, it
// asks each step out loud, and what's said fills in the fields here as it's saved (the bridge's /setup/step tells the
// live voice which step is showing, and lends it update_household).

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

internal object Setup {
    val STEPS = listOf("people", "place", "devices", "pin")

    private var greeted = false
    /** Bumped when the bridge has an answer Opie heard (GET /setup/wait): the step reads what's saved at once. */
    var tick by mutableStateOf(0)
    /** Turn on Opie was chosen but the tablet isn't linked yet: the phone-or-computer step asks for it (not before),
     *  each time it shows, until it's linked (CloudVoiceMenu.turnOn clears it then). */
    @Volatile var wantsLink = false
    /** Where the tablet is, guessed once ({address, town, zip}), for the place step and Opie's question. */
    @Volatile var guess: JSONObject? = null

    /** What Opie says as a step comes up: only what it needs to ask, never what the screen already says (the user: "It
     *  is just really dumb for opie to just narrate what's already on the screen"). Nothing for the phone step. */
    private fun line(step: String): String? = when (step) {
        "people" -> "Who's in the family?"
        "place" -> if (guess?.optString("address").isNullOrBlank()) "And your address?" else "Is that right?"
        else -> null
    }

    fun start() {
        Openhouse.setupStep = STEPS.first(); shown(STEPS.first())
        Openhouse.scope.launch(Dispatchers.IO) { if (guess == null) guess = runCatching { Openhouse.host.guessHome() }.getOrNull() }
    }

    fun go(step: String?) { Openhouse.setupStep = step; shown(step) }
    fun next() { val i = STEPS.indexOf(Openhouse.setupStep); if (i + 1 < STEPS.size) go(STEPS[i + 1]) else finish() }
    fun back(): Boolean { val i = STEPS.indexOf(Openhouse.setupStep); if (i <= 0) return false; go(STEPS[i - 1]); return true }

    fun finish() {
        go(null)
        Openhouse.scope.launch(Dispatchers.IO) { Openhouse.post("/household", JSONObject()) } // set up: not asked again
        Openhouse.householdDone()
        Openhouse.host.setting("reloadHomeFirst") // the home screen with their names, weather and calendars now, on Home
        if (Openhouse.host.hasAssistant()) Speech.say("All set.", null)
    }

    /** Opie was just turned on (the welcome's Turn on Opie, after linking): it says the step that's showing. */
    fun opieOn() { Openhouse.setupStep?.let { say(it) } }

    private fun shown(step: String?) {
        Openhouse.scope.launch(Dispatchers.IO) {
            Openhouse.post("/setup/step", JSONObject().put("step", step ?: JSONObject.NULL).put("guess", guess?.optString("address") ?: ""))
        }
        if (step != null) say(step)
    }

    private fun say(step: String) {
        if (!Openhouse.host.hasAssistant()) return
        val l = line(step) ?: return
        Speech.say((if (!greeted) "Hi, I'm Opie. " else "") + l, null)
        greeted = true
    }
}

private class SetupPerson(name: String, note: String) { var name by mutableStateOf(name); var note by mutableStateOf(note) }

private fun getJson(path: String): JSONObject? = runCatching { JSONObject(BridgeClient.getText(Openhouse.bridgeUrl + path, 2000, 4000)) }.getOrNull()

@Composable
internal fun SetupSheet() {
    val step = Openhouse.setupStep ?: return
    val opie = Openhouse.host.hasAssistant()
    val title = when (step) { "people" -> "Who lives here?"; "place" -> "Where do you live?"; "pin" -> "Choose a PIN"; else -> "Connect your phone or computer to Opie" }
    val last = step == Setup.STEPS.last()
    // The PIN step: its own button chooses one (SettingsLock "setupPin"), and the setup ends once it's kept; Skip, or
    // Done if one is already set.
    val pinSet = remember(Openhouse.settingsV) { Openhouse.host.locked() }
    val choosePin = step == "pin" && !pinSet
    val save = remember(step) { arrayOf<() -> Unit>({}) } // the step's own: what was typed, saved on Next, Back or Later
    // Answers Opie heard (the bridge reads them: live-tools.js setupHeard), as they come: the step shows them, and Opie
    // says them back in a few words.
    LaunchedEffect(Unit) {
        var v = -1
        while (true) {
            val j = withContext(Dispatchers.IO) { runCatching { JSONObject(BridgeClient.getText(Openhouse.bridgeUrl + "/setup/wait?v=$v", 2000, 30_000)) }.getOrNull() }
            if (j == null) { delay(2000); continue }
            if (v >= 0 && j.optInt("v") != v) {
                Setup.tick++
                j.optString("said").takeIf { it.isNotBlank() && Openhouse.host.hasAssistant() }?.let { Speech.say(it, null) }
            }
            v = j.optInt("v")
        }
    }
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        // From the top, not centered: the card's top stays put from step to step. Above Android's on-screen keyboard
        // when it's up (a tablet with no keyboard cover), nearer the top, and scrolling if it still doesn't fit, so
        // Next stays in reach.
        val ime = androidx.compose.foundation.layout.WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current) > 0
        Box(Modifier.fillMaxSize().background(Calm.scrim).clickable(enabled = false) {}.imePadding().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
            QuietCard(Modifier.padding(top = if (ime) 24.u else 110.u, bottom = 24.u).width(if (step == "devices") 1080.u else 860.u), padding = PaddingValues(horizontal = 56.u, vertical = 48.u)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${Setup.STEPS.indexOf(step) + 1} of ${Setup.STEPS.size}", style = calmText(17, color = Calm.soft), modifier = Modifier.weight(1f))
                    Chip("Later") { save[0](); Setup.finish() }
                }
                Spacer(Modifier.height(12.u))
                Text(title, style = calmText(Calm.DISPLAY, FontWeight.Medium))
                if (opie && step != "devices" && step != "pin") Text("Tell Opie, or type it.", style = calmText(Calm.LEAD, color = Calm.soft))
                Spacer(Modifier.height(28.u))
                when (step) {
                    "people" -> PeopleStep { save[0] = it }
                    "place" -> PlaceStep { save[0] = it }
                    "pin" -> PinStep(pinSet)
                    else -> DevicesStep()
                }
                Spacer(Modifier.height(36.u))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
                    if (Setup.STEPS.indexOf(step) > 0) Box(Modifier.clip(RoundedCornerShape(99.u)).clickable { save[0](); Setup.back() }.padding(horizontal = 20.u, vertical = 18.u)) {
                        Text("Back", style = calmText(21, FontWeight.Medium, Calm.soft))
                    }
                    Spacer(Modifier.weight(1f))
                    if (!last || choosePin) Box(Modifier.clip(RoundedCornerShape(99.u)).clickable { Setup.next() }.padding(horizontal = 20.u, vertical = 18.u)) {
                        Text("Skip", style = calmText(21, FontWeight.Medium, Calm.soft))
                    }
                    Box(Modifier.clip(RoundedCornerShape(99.u)).background(Calm.ink).clickable { save[0](); if (choosePin) Openhouse.host.setting("setupPin") else Setup.next() }.padding(horizontal = 36.u, vertical = 18.u)) {
                        Text(if (choosePin) "Choose a PIN" else if (last) "Done" else "Next", style = calmText(21, FontWeight.SemiBold, Calm.sheet))
                    }
                }
            }
        }
    }
}

/** The last step: a PIN, so Settings and saying yes to new apps are for the people who know it. Skipping leaves the
 *  lock off (PIN Lock in Settings turns it on later). */
@Composable
private fun PinStep(set: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(14.u)) {
        Text("It guards Settings and saying yes to new apps.", style = calmText(Calm.LEAD))
        Text(if (set) "PIN Lock is on. Settings and approving new apps ask for the PIN."
            else "With a PIN, only someone who knows it can change Settings or approve a new app. Without one, anyone at the tablet can. You can set it later in Settings, PIN Lock.",
            style = calmText(19, color = Calm.soft))
    }
}

/** Who lives here: names and an age or role. What Opie saves shows here as it's saved, until someone types. */
@Composable
private fun PeopleStep(onSave: (() -> Unit) -> Unit) {
    val o = Openhouse
    val people = remember { mutableStateListOf<SetupPerson>() }
    var edited by remember { mutableStateOf(false) }
    val first = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { delay(300); runCatching { first.requestFocus() } } // keys go here, not to the home screen behind
    LaunchedEffect(Unit) {
        while (true) {
            val h = withContext(Dispatchers.IO) { o.loadHousehold() }
            if (h != null && !edited) {
                val saved = h.optJSONArray("family")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty().map { it.optString("name") to it.optString("note") }
                val now = people.map { it.name.trim() to it.note.trim() }.filter { it.first.isNotEmpty() }
                if (saved != now && (saved.isNotEmpty() || people.isEmpty())) { people.clear(); saved.forEach { people += SetupPerson(it.first, it.second) } }
            }
            if (people.isEmpty()) people += SetupPerson("", "")
            val t0 = Setup.tick
            kotlinx.coroutines.withTimeoutOrNull(5000) { snapshotFlow { Setup.tick }.first { it != t0 } }
        }
    }
    onSave { if (edited) o.saveHousehold(JSONObject().put("family", JSONArray(people.filter { it.name.isNotBlank() }.map { JSONObject().put("name", it.name.trim()).put("note", it.note.trim()) }))) }
    Column(verticalArrangement = Arrangement.spacedBy(12.u)) {
        people.forEachIndexed { i, p ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.u), verticalAlignment = Alignment.CenterVertically) {
                Field(p.name, { p.name = it; edited = true }, "Name", Modifier.weight(1f), focus = if (i == 0) first else null, words = true)
                Field(p.note, { p.note = it; edited = true }, "Age 9, or Mom", Modifier.weight(1f))
                Box(Modifier.size(44.u).clip(CircleShape).clickable { people.remove(p); edited = true; if (people.isEmpty()) people += SetupPerson("", "") }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Close, "Remove", tint = PaperLook.inkSoft, modifier = Modifier.size(20.u))
                }
            }
        }
        Text("+ Add someone", style = calmText(19, FontWeight.Medium, Calm.soft), modifier = Modifier.clip(RoundedCornerShape(8.u)).clickable { people += SetupPerson("", ""); edited = true }.padding(vertical = 6.u))
    }
}

/** Where: a street address by default (guessed from where the tablet is), or just the town or the zip code. A street
 *  address is Home on the Map (directions, how long to get somewhere); the town or zip is the weather's. */
@Composable
private fun PlaceStep(onSave: (() -> Unit) -> Unit) {
    val o = Openhouse
    var kind by remember { mutableStateOf("street") }
    val value = remember { mutableStateMapOf("street" to "", "town" to "", "zip" to "") }
    var edited by remember { mutableStateOf(false) }
    val first = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { delay(300); runCatching { first.requestFocus() } }
    LaunchedEffect(Unit) {
        while (true) {
            if (!edited) {
                Setup.guess?.let { g -> if (value["street"].isNullOrEmpty()) { value["street"] = g.optString("address"); value["town"] = g.optString("town"); value["zip"] = g.optString("zip") } }
                // What Opie heard: a street address (held by the bridge until Next), or a town or zip it saved as the location.
                withContext(Dispatchers.IO) { getJson("/setup/step") }?.optString("home_address")?.takeIf { it.isNotBlank() }?.let { value["street"] = it; kind = "street" }
                withContext(Dispatchers.IO) { o.loadHousehold() }?.optString("location")?.takeIf { it.isNotBlank() && it != "null" && value["street"].isNullOrBlank() }?.let { loc ->
                    if (Regex("^\\d{5}").containsMatchIn(loc)) { value["zip"] = loc; kind = "zip" } else { value["town"] = loc; kind = "town" }
                }
            }
            val t0 = Setup.tick
            kotlinx.coroutines.withTimeoutOrNull(5000) { snapshotFlow { Setup.tick }.first { it != t0 } }
        }
    }
    onSave {
        val v = value[kind].orEmpty().trim()
        if (v.isEmpty()) return@onSave
        val loc = if (kind != "street") v else Regex("\\b\\d{5}\\b").find(v)?.value ?: value["town"]?.takeIf { it.isNotBlank() } ?: v.substringAfter(",").trim().ifEmpty { v }
        // The address stays with the household (Opie's, and the Map's once it's on: it looks it up then, not before).
        o.saveHousehold(JSONObject().put("location", loc).put("address", if (kind == "street") v else ""))
    }
    Column(verticalArrangement = Arrangement.spacedBy(14.u)) {
        Field(value[kind].orEmpty(), { value[kind] = it; edited = true }, when (kind) { "street" -> "Street address"; "town" -> "Town"; else -> "Zip code" }, focus = first)
        Row(horizontalArrangement = Arrangement.spacedBy(8.u)) {
            for ((k, label) in listOf("street" to "Street address", "town" to "Just the town", "zip" to "Just the zip code")) Chip(label, selected = kind == k) { kind = k }
        }
    }
}

/** Carrying on from a phone or computer: whose it is, then a code to scan or type. What's been done there shows
 *  here as it comes in. */
@Composable
private fun DevicesStep() {
    val o = Openhouse
    var names by remember { mutableStateOf(listOf<String>()) }
    var who by remember { mutableStateOf<String?>(null) }
    var pair by remember { mutableStateOf<JSONObject?>(null) }
    var done by remember { mutableStateOf(listOf<String>()) }
    LaunchedEffect(Unit) {
        val h = withContext(Dispatchers.IO) { o.loadHousehold() }
        val kidOrPet = { n: String -> Regex("^\\d{1,2}$").matches(n.trim()) || Regex("\\b(dog|cat|pet|fish|bird|hamster|rabbit)\\b", RegexOption.IGNORE_CASE).containsMatchIn(n) }
        names = h?.optJSONArray("family")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty().filter { !kidOrPet(it.optString("note")) }.map { it.optString("name") }
        who = names.firstOrNull() ?: "Me"
        // Linking for Opie, now that they're here with a phone. Kept until it's linked: closed, or the account not
        // reached, it asks again the next time this step shows (and a yes made here turns Opie on whenever it links).
        if (Setup.wantsLink) o.host.setting("linkForOpie")
    }
    var used by remember { mutableStateOf(0) } // devices joined with a code from here: each code works once, so a new one
    LaunchedEffect(who, used) { val w = who ?: return@LaunchedEffect; pair = null; pair = withContext(Dispatchers.IO) { o.host.setupPair(w) } }
    LaunchedEffect(Unit) {
        while (true) {
            done = withContext(Dispatchers.IO) {
                val s = getJson("/screens")
                val devs = s?.optJSONArray("screens")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                    .filter { d -> d.optJSONArray("scopes")?.let { sc -> (0 until sc.length()).any { sc.optString(it) == "setup" } } == true }
                val dev = devs.lastOrNull()
                if (devs.size > used) withContext(Dispatchers.Main) { used = devs.size }
                val cals = o.loadHousehold()?.optJSONArray("calendars")?.length() ?: 0
                val albums = runCatching { o.host.settingValues()["albums"] }.getOrNull()?.toIntOrNull() ?: 0
                val invited = s?.optJSONArray("invites")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
                listOfNotNull(
                    dev?.let { d -> "Connected: " + d.optString("name").let { n -> if (n.startsWith("A ") && d.optString("person").isNotBlank()) d.optString("person") + "'s " + n.removePrefix("A ") else n } },
                    if (cals > 0) "Calendars: $cals" else null,
                    if (albums > 0) "Photo albums: $albums" else null,
                    if (invited.isNotEmpty()) "Invited: ${invited.joinToString(", ")}" else null,
                )
            }
            delay(2000)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(40.u)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.u)) {
            if (names.size > 1) {
                Text("Whose is it?", style = calmText(19, FontWeight.Medium))
                Row(horizontalArrangement = Arrangement.spacedBy(8.u)) { names.forEach { n -> Chip(n, selected = who == n) { who = n } } }
                Spacer(Modifier.height(10.u))
            }
            // What connecting is for, before how: the setup carries on there, where their calendars and photos already are.
            Text("So you can:", style = calmText(19, FontWeight.Medium))
            listOf("Use Opie on the go: lists, chores and the calendar from anywhere",
                "Bring in your calendars and photo albums from where they already are",
                "Use the AI you already have, like Claude or ChatGPT, to change and add to Opie").forEach { Text("·  $it", style = calmText(19, color = Calm.soft)) }
            Spacer(Modifier.height(14.u))
            Text("On a phone, scan the code.", style = calmText(Calm.LEAD))
            pair?.let { p ->
                Text("On a computer, go to ${p.optString("address")} and type", style = calmText(Calm.LEAD))
                Text(p.optString("code"), style = calmText(34, FontWeight.SemiBold))
            }
            if (done.isNotEmpty()) { Spacer(Modifier.height(10.u)); done.forEach { Text(it, style = calmText(19, color = Calm.soft)) } }
        }
        Box(Modifier.size(320.u).clip(RoundedCornerShape(Calm.R_CARD.u)).background(androidx.compose.ui.graphics.Color.White), contentAlignment = Alignment.Center) {
            val url = pair?.optString("url")
            val bmp = remember(url) { url?.let { runCatching { dev.openhouse.shell.Handoff.qr(it, 600).asImageBitmap() }.getOrNull() } }
            if (bmp != null) Image(bmp, "Code to scan", Modifier.size(296.u)) else Text("…", style = calmText(30, color = Calm.soft))
        }
    }
}
