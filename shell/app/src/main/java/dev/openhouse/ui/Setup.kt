package dev.openhouse.ui

// The first setup, right after the welcome (docs/onboarding.md): who lives here, where (a street address guessed from
// where the tablet is), connecting a phone or a computer (one code; the phone page then follows these steps:
// chat/src/phone.jsx SetupFlow), the household's calendar (Google, iCloud, Outlook or a link sent from that phone or
// computer, or none), photos (an iCloud shared album, Google Photos, or from that phone), a PIN for settings and
// approvals (PIN Lock, which can be skipped), two of Android's own settings a tablet set up by its household would
// otherwise never find (letting Opie use other apps, and the charge limit), and last talking to Opie:
// what to say, which voice, and turning the voice on. One step on screen at a time, each with Back, Skip and Next.
//
// Quiet until that last step: nothing is said aloud and nothing listens (Setup.hushed: no microphone, no wake word,
// no live voice), and everything is done by tapping and typing. The owner, after trying it on a real tablet: "leave
// the voice control out of the setup and add it as the last step".

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.ui.text.withStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal object Setup {
    // Connecting a phone or computer comes before the calendar and photos: their links are copied there, not on the
    // tablet, so those steps send them from the phone or computer already connected (it follows the tablet's step:
    // chat/src/phone.jsx SetupFlow), with one code for it all.
    val STEPS = listOf("people", "place", "devices", "calendar", "photos", "pin", "android", "voice")

    /** A later step that sent someone back to connect a phone or computer: Next there comes back here. */
    private var resume: String? = null
    fun connectFirst() { resume = Openhouse.setupStep; go("devices") }

    /** Where the tablet is, guessed once ({address, town, zip}), for the place step. */
    @Volatile var guess: JSONObject? = null

    /** The phone or computer the setup carries on from, by name, once one has joined (Setup.kt connectedDevice). */
    @Volatile var connected: String? = null

    /** The welcome or a setup step before the voice step is showing: no microphone, no wake word, no live voice and
     *  nothing said aloud (MainActivity.micWanted, LiveVoice, Speech.say). */
    val hushed: Boolean get() = Openhouse.showWelcome || Openhouse.setupStep.let { it != null && it != "voice" }

    fun start() {
        Openhouse.setupStep = STEPS.first(); shown(STEPS.first())
        Openhouse.scope.launch(Dispatchers.IO) { if (guess == null) guess = runCatching { Openhouse.host.guessHome() }.getOrNull() }
    }

    fun go(step: String?) { Openhouse.setupStep = step; shown(step) }
    fun next() {
        resume?.let { r -> resume = null; if (Openhouse.setupStep == "devices") { go(r); return } }
        val i = STEPS.indexOf(Openhouse.setupStep); if (i + 1 < STEPS.size) go(STEPS[i + 1]) else finish()
    }
    fun back(): Boolean {
        resume?.let { r -> resume = null; if (Openhouse.setupStep == "devices") { go(r); return true } }
        val i = STEPS.indexOf(Openhouse.setupStep); if (i <= 0) return false; go(STEPS[i - 1]); return true
    }

    fun finish() {
        resume = null
        go(null)
        Openhouse.scope.launch(Dispatchers.IO) { Openhouse.post("/household", JSONObject()) } // set up: not asked again
        Openhouse.householdDone()
        Openhouse.host.setting("reloadHomeFirst") // the home screen with their names, weather and calendars now, on Home
    }

    /** The bridge hears which step shows (the live voice is told about the voice step: live-tools.js SETUP_STEPS), and
     *  the microphone follows (none before the voice step). */
    private fun shown(step: String?) {
        Openhouse.scope.launch(Dispatchers.IO) { Openhouse.post("/setup/step", JSONObject().put("step", step ?: JSONObject.NULL)) }
        Openhouse.host.micFollow()
    }
}

private class SetupPerson(name: String, note: String) {
    var name by mutableStateOf(name); var note by mutableStateOf(note)
    val focus = androidx.compose.ui.focus.FocusRequester()
}

private fun getJson(path: String, readMs: Int = 4000): JSONObject? = runCatching { JSONObject(BridgeClient.getText(Openhouse.bridgeUrl + path, 2000, readMs)) }.getOrNull()

@Composable
internal fun SetupSheet() {
    val step = Openhouse.setupStep ?: return
    val title = when (step) {
        "people" -> "Who lives here?"; "place" -> "Where do you live?"; "calendar" -> "Do you have a family calendar?"
        "photos" -> "Put your photos on the tablet?"; "pin" -> "Choose a PIN"; "voice" -> "Talk to Opie"
        "android" -> "Two of Android's settings"
        else -> "Connect your phone or computer"
    }
    // The PIN step: its own button chooses one (SettingsLock "setupPin"), and the setup goes on once it's kept; Skip, or
    // Next if one is already set.
    val pinSet = remember(Openhouse.settingsV) { Openhouse.host.locked() }
    val choosePin = step == "pin" && !pinSet
    val save = remember(step) { arrayOf<() -> Unit>({}) } // the step's own: what was typed, saved on Next, Back or Later
    val addPerson = remember(step) { arrayOf<() -> Unit>({}) } // who lives here: + Add someone, beside Next (never scrolled away under the keyboard)
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        // From the top, not centered: the card's top stays put from step to step (the last, the voices, starts higher:
        // it has the most to show, down to the line about OpenAI above its buttons). Every step is the same width. The
        // card never runs past the screen, or past Android's on-screen keyboard when it's up (a tablet with no keyboard
        // cover: imePadding, and nearer the top): what's in it scrolls, and Back, Skip and Next stay below it in reach.
        val ime = androidx.compose.foundation.layout.WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current) > 0
        Box(Modifier.fillMaxSize().background(Calm.scrim).clickable(enabled = false) {}.imePadding(), contentAlignment = Alignment.TopCenter) {
            QuietCard(Modifier.padding(top = if (ime) 16.u else if (step == "voice") 36.u else 110.u, bottom = 16.u).width(860.u), padding = PaddingValues(horizontal = 56.u, vertical = if (ime) 28.u else 48.u)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${Setup.STEPS.indexOf(step) + 1} of ${Setup.STEPS.size}", style = calmText(17, color = Calm.soft), modifier = Modifier.weight(1f))
                    if (step != "voice") Chip("Later") { save[0](); Setup.finish() }
                }
                Spacer(Modifier.height(12.u))
                Text(title, style = calmText(Calm.DISPLAY, FontWeight.Medium))
                Spacer(Modifier.height(20.u))
                if (step == "voice") {
                    val v = remember { VoiceUi() }
                    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) { Spacer(Modifier.height(8.u)); VoiceStep(v) }
                    Spacer(Modifier.height(28.u))
                    VoiceButtons(v) // with its own buttons, below what scrolls
                } else {
                    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                        Spacer(Modifier.height(8.u))
                        when (step) {
                            "people" -> PeopleStep({ addPerson[0] = it }) { save[0] = it }
                            "place" -> PlaceStep { save[0] = it }
                            "calendar" -> CalendarStep()
                            "photos" -> PhotosStep()
                            "pin" -> PinStep(pinSet)
                            "android" -> AndroidStep()
                            else -> DevicesStep()
                        }
                    }
                    Spacer(Modifier.height(28.u))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
                        if (Setup.STEPS.indexOf(step) > 0) TextButton("Back") { save[0](); Setup.back() }
                        if (step == "people") TextButton("+ Add someone") { addPerson[0]() }
                        Spacer(Modifier.weight(1f))
                        if (step != "pin" || choosePin) TextButton("Skip") { Setup.next() }
                        MainButton(if (choosePin) "Choose a PIN" else "Next") { save[0](); if (choosePin) Openhouse.host.setting("setupPin") else Setup.next() }
                    }
                }
            }
        }
    }
}

/** The one filled button on a step: the next thing to do. */
@Composable
private fun MainButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.clip(RoundedCornerShape(99.u)).background(if (enabled) Calm.ink else Calm.faint).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 36.u, vertical = 18.u)) {
        Text(label, style = calmText(21, FontWeight.SemiBold, Calm.sheet))
    }
}

/** A quiet button: words only (Back, Skip, Not now). */
@Composable
private fun TextButton(label: String, onClick: () -> Unit) {
    Box(Modifier.clip(RoundedCornerShape(99.u)).clickable(onClick = onClick).padding(horizontal = 20.u, vertical = 18.u)) {
        Text(label, style = calmText(21, FontWeight.Medium, Calm.soft))
    }
}

/** A step's own action beside the filled Next (Sign in, Paste the link): soft, tinted, never filled. */
@Composable
private fun SoftButton(label: String, onClick: () -> Unit) {
    Box(Modifier.clip(RoundedCornerShape(99.u)).background(Calm.tint).clickable(onClick = onClick).padding(horizontal = 28.u, vertical = 16.u)) {
        Text(label, style = calmText(21, FontWeight.Medium))
    }
}

@Composable
private fun Soft(t: String) = Text(t, style = calmText(19, color = Calm.soft))

/** What to do, a numbered line for each step. */
@Composable
private fun HowTo(lines: List<String>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.u)) {
        lines.forEachIndexed { i, t ->
            Row(horizontalArrangement = Arrangement.spacedBy(14.u)) {
                Text("${i + 1}", style = calmText(21, FontWeight.SemiBold, Calm.soft), modifier = Modifier.width(22.u))
                Text(t, style = calmText(21))
            }
        }
    }
}

/** Rows with hairlines between them. */
@Composable
private fun Rows(rows: List<@Composable () -> Unit>) {
    Column {
        rows.forEachIndexed { i, r ->
            if (i > 0) Box(Modifier.fillMaxWidth().height(1.u).background(Calm.line))
            r()
        }
    }
}

/** What's been added so far: its name, and what it is. */
@Composable
private fun Added(rows: List<Pair<String, String>>) {
    if (rows.isEmpty()) return
    Column {
        Text("Added", style = calmText(19, FontWeight.Medium, Calm.soft), modifier = Modifier.padding(bottom = 4.u))
        Rows(rows.map { (name, what) -> @Composable {
            Row(Modifier.fillMaxWidth().padding(vertical = 10.u), verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = calmText(21, FontWeight.Medium), modifier = Modifier.weight(1f), maxLines = 1)
                Text(what, style = calmText(19, color = Calm.soft), maxLines = 1)
            }
        } })
    }
}

/** Linked to an Opie account (Google's sign-ins go through it), looked at again now and then while a step shows. */
@Composable
private fun linkedNow(): Boolean {
    var linked by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { while (true) { linked = withContext(Dispatchers.IO) { getJson("/cloud/status")?.optBoolean("linked") == true }; delay(5000) } }
    return linked
}

private class HowItGoes(val steps: List<String>, val note: String?, val action: String?, val id: String?, val paste: String? = null)

/** The phone or computer the setup carries on from (joined with the devices step's code), named for people ("Sam's
 *  computer"), or null while there's none. Looked at again every few seconds while a step shows. */
@Composable
private fun connectedDevice(): String? {
    var name by remember { mutableStateOf(Setup.connected) }
    LaunchedEffect(Unit) {
        while (true) {
            name = withContext(Dispatchers.IO) {
                getJson("/screens")?.optJSONArray("screens")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                    .lastOrNull { d -> d.optJSONArray("scopes")?.let { sc -> (0 until sc.length()).any { sc.optString(it) == "setup" } } == true }
                    ?.let { d -> d.optString("name").let { n -> if (n.startsWith("A ") && d.optString("person").isNotBlank()) d.optString("person") + "'s " + n.removePrefix("A ") else n } }
            }
            Setup.connected = name
            delay(2500)
        }
    }
    return name
}

/** A link's step, the way it's sent: from the phone or computer that's connected (the box for it is open there now),
 *  else connect one first; pasting or typing it here is the small way, for a tablet with a keyboard cover. */
@Composable
private fun SendIt(h: HowItGoes, device: String?) {
    if (h.steps.isNotEmpty()) HowTo(h.steps)
    h.note?.let { Soft(it) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.u)) {
        if (h.action != null && h.id != null) SoftButton(h.action) { Openhouse.host.setting(h.id) }
        else if (h.paste != null && device == null) SoftButton("Connect a phone or computer") { Setup.connectFirst() }
        if (h.paste != null) Text("Paste it here instead", style = calmText(19, FontWeight.Medium, Calm.soft),
            modifier = Modifier.clip(RoundedCornerShape(8.u)).clickable { Openhouse.host.setting(h.paste) }.padding(vertical = 8.u))
    }
}

/** Where to send a link from, as the last line of a how-to: the connected one by name, else a phone or computer. */
private fun sendLine(device: String?, what: String) =
    if (device != null) "On $device, paste $what into Opie: the box for it is open there now."
    else "Connect a phone or computer, and paste $what into Opie there."

/** The household's calendar: the tablet's own sign-ins (Google through the account, iCloud with an app-specific
 *  password: CalendarAccounts), a calendar's link sent from the connected phone or computer (where it's copied: the
 *  bridge's /setup/calendar), or none (Opie's own). What's been added shows below as it comes in. */
@Composable
private fun CalendarStep() {
    var pick by remember { mutableStateOf<String?>(null) }
    val linked = linkedNow()
    val device = connectedDevice()
    var added by remember { mutableStateOf(listOf<Pair<String, String>>()) }
    LaunchedEffect(Unit) {
        while (true) {
            added = withContext(Dispatchers.IO) {
                runCatching { dev.openhouse.shell.CalendarAccounts.rows().map { it.first to it.second } }.getOrDefault(emptyList()) +
                    runCatching { dev.openhouse.shell.CalendarLinks.list().map { l -> l.name.ifBlank { dev.openhouse.shell.CalendarLinks.label(l.who) } to "Read only" } }.getOrDefault(emptyList())
            }
            delay(2000)
        }
    }
    val how = when (pick) {
        "google" -> if (linked) HowItGoes(listOf("Tap Sign in with Google.", "Scan the code with a phone on this Wi-Fi, and sign in to Google there.", "Choose which calendars to show."),
            "Two-way: what's added here shows in Google Calendar too.", "Sign in with Google", "calendarGoogle")
            else HowItGoes(listOf("On your computer, open Google Calendar, then Settings.", "Under Settings for my calendars, choose the calendar, then Integrate calendar.", "Copy the Secret address in iCal format.", sendLine(device, "it")),
            "Read only: what's added here stays on the tablet. Once the tablet is linked to an Opie account, it can sign in to Google for two-way.", null, null, "calendarPaste")
        "icloud" -> HowItGoes(listOf("On appleid.apple.com, go to Sign-In and Security, then App-Specific Passwords, and make one.", "Tap Sign in to iCloud, and type your Apple ID and that password.", "Choose which calendars to show."),
            "Two-way: what's added here shows on your iPhone too. The password stays sealed on this tablet.", "Sign in to iCloud", "calendarICloud")
        "outlook" -> HowItGoes(listOf("In Outlook on the web, open Settings, then Calendar, then Shared calendars.", "Under Publish a calendar, choose the calendar and Can view all details, then Publish.", "Copy the ICS link.", sendLine(device, "it")),
            "Read only: what's added here stays on the tablet.", null, null, "calendarPaste")
        "link" -> HowItGoes(listOf("Find the calendar's iCal or ICS link on your phone or computer: a school, team or club calendar usually has one.", sendLine(device, "the link")), "Read only.", null, null, "calendarPaste")
        "none" -> HowItGoes(emptyList(), "Events added on the tablet or a phone go in Opie's own calendar. You can bring one in later in Settings, Calendars.", null, null)
        else -> null
    }
    Column(verticalArrangement = Arrangement.spacedBy(20.u)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.u)) {
            for ((k, label) in listOf("google" to "Google", "icloud" to "iCloud", "outlook" to "Outlook", "link" to "Another link", "none" to "Start one here")) Chip(label, selected = pick == k) { pick = k }
        }
        how?.let { SendIt(it, device) }
        Added(added)
    }
}

/** Photos for the tablet: an iCloud shared album's link sent from the connected phone or computer (PhotoAlbums),
 *  Google Photos' picker when the tablet is linked (GooglePhotos), or photos from that phone (the household's photo
 *  page, PhotoShare: turned on here with a person's yes, then opened there, not a second code). What's come in shows
 *  below. */
@Composable
private fun PhotosStep() {
    var pick by remember { mutableStateOf<String?>(null) }
    val linked = linkedNow()
    val device = connectedDevice()
    var albums by remember { mutableStateOf(0) }
    var page by remember { mutableStateOf<String?>(null) } // the photo page's link, once it's on
    LaunchedEffect(Unit) {
        while (true) {
            albums = withContext(Dispatchers.IO) { runCatching { dev.openhouse.shell.PhotoAlbums.list().size }.getOrDefault(0) }
            val now = runCatching { dev.openhouse.shell.PhotoShare.link() }.getOrNull()
            if (now != page) {
                page = now
                // The connected phone or computer follows this step: with the page on, it offers it there.
                withContext(Dispatchers.IO) { Openhouse.post("/setup/step", JSONObject().put("step", "photos").apply { now?.let { put("photos", it) } }) }
            }
            delay(2000)
        }
    }
    val photos = House.photos
    val how = when (pick) {
        "icloud" -> HowItGoes(listOf("In Photos on your iPhone or Mac, open a shared album, or make one.", "In its sharing settings, turn on Public Website, and copy the link.", sendLine(device, "it")),
            "New photos in the album come to the tablet by themselves.", null, null, "albumPaste")
        "google" -> HowItGoes(listOf("Tap Pick from Google Photos, and scan the code with a phone on this Wi-Fi.", "Sign in to Google there.", "Pick the photos for the tablet."), "They're copied to the tablet.", "Pick from Google Photos", "googlePhotos")
        "phone" -> when {
            device == null -> HowItGoes(listOf("Connect your phone, then choose the photos there."), null, "Connect a phone or computer", "connect")
            page == null -> HowItGoes(listOf("Tap Let phones send photos, and say yes.", "On $device, choose the photos to send."), "Then the household's phones can send photos here any time.", "Let phones send photos", "photoPhonesOn")
            else -> HowItGoes(listOf("On $device, tap Choose photos, and pick the ones for the tablet."), "Any time later, share photos to Opie from the phone.", null, null)
        }
        else -> null
    }
    Column(verticalArrangement = Arrangement.spacedBy(20.u)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.u)) {
            Chip("iCloud album", selected = pick == "icloud") { pick = "icloud" }
            if (linked) Chip("Google Photos", selected = pick == "google") { pick = "google" }
            Chip("From your phone", selected = pick == "phone") { pick = "phone" }
        }
        how?.let { h -> if (h.id == "connect") { HowTo(h.steps); SoftButton(h.action!!) { Setup.connectFirst() } } else SendIt(h, device) }
        if (photos.isNotEmpty() || albums > 0) Column(verticalArrangement = Arrangement.spacedBy(10.u)) {
            Text(listOfNotNull(if (albums > 0) "Albums: $albums" else null, if (photos.isNotEmpty()) "Photos: ${photos.size}" else null).joinToString("    "), style = calmText(19, FontWeight.Medium, Calm.soft))
            Row(horizontalArrangement = Arrangement.spacedBy(8.u)) { photos.take(7).forEach { HousePhoto(it, Modifier.size(96.u).clip(RoundedCornerShape(12.u))) } }
        }
    }
}

/** The last step: talking to Opie. What it is, things to ask in the household's own words, a voice, and the line about
 *  what goes to OpenAI; then Turn on Opie's voice (a person's tap: it's the yes to OpenAI) and a try, or Not now (it
 *  stays off and isn't turned on by itself later; Settings, Voice). Without a voice to turn on (the household doesn't
 *  have it yet, or the tablet isn't linked), it says so and how, and Done. */
private class VoiceUi {
    // looking, ready (it can be turned on), on (the try), notYet, unlinked, noBridge
    var state by mutableStateOf(if (Openhouse.host.hasAssistant()) "on" else "looking")
    var voice by mutableStateOf("marin")
    var problem by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    /** When the household asked for Opie's voice (the service's), while it doesn't have it. */
    var asked by mutableStateOf<String?>(null)
}

@Composable
private fun VoiceStep(v: VoiceUi) {
    val o = Openhouse
    var state by v::state
    var voice by v::voice
    val problem = v.problem
    var example by remember { mutableStateOf(dev.openhouse.shell.PluginsMenu.example(emptyList())) }
    val voices = remember { o.host.voices() }
    LaunchedEffect(Unit) {
        val fam = withContext(Dispatchers.IO) { o.loadHousehold() }?.optJSONArray("family")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
        example = dev.openhouse.shell.PluginsMenu.example(fam)
    }
    // Looked at until it's known; while unlinked (or the bridge is starting), again every few seconds, so linking from
    // here, or from the account page, shows at once.
    LaunchedEffect(Unit) {
        while (true) {
            if (state in setOf("looking", "unlinked", "noBridge")) {
                val st = withContext(Dispatchers.IO) { getJson("/cloud/voice?check=1", 15_000) }
                if (state == "looking") st?.optString("voiceName")?.takeIf { it.isNotBlank() }?.let { voice = it }
                v.asked = st?.optString("asked")?.takeIf { !st.isNull("asked") && it.isNotBlank() }
                state = when {
                    st == null -> "noBridge"
                    st.optBoolean("on") -> "on"
                    !st.optBoolean("linked") -> "unlinked"
                    st.has("available") && !st.isNull("available") && !st.optBoolean("available") -> "notYet"
                    else -> "ready"
                }
            }
            delay(3000)
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(22.u)) {
        when (state) {
            "looking" -> Text("…", style = calmText(Calm.LEAD, color = Calm.soft))
            "notYet" -> {
                Text("Opie's voice isn't on for your household yet. When it is, the tablet asks you here, or you can turn it on in Settings, Voice.", style = calmText(Calm.LEAD))
                // Ask for it: the service keeps the ask under the household and emails it once it's on (openhouse-cloud docs/beta.md).
                val asked = v.asked
                if (asked != null) Soft("You asked on ${asked.take(10)}. We'll email you when it's on.")
                else {
                    Soft("We're turning it on for households a few at a time. Or use your own OpenAI key.")
                    SoftButton("Use your own OpenAI key") { o.host.setting("ownKey") }
                    SoftButton("Ask for Opie's voice") {
                        Openhouse.scope.launch(Dispatchers.IO) {
                            val r = runCatching { JSONObject(Openhouse.post("/cloud/voice/ask") ?: "{}") }.getOrNull()
                            withContext(Dispatchers.Main) { if (r != null && !r.has("error")) v.asked = r.optString("asked").ifBlank { java.time.LocalDate.now().toString() } else v.problem = r?.optString("error")?.ifBlank { null } ?: "The tablet's software isn't answering right now." }
                        }
                    }
                }
            }
            "unlinked" -> {
                Text("Opie's voice comes through an Opie account. Link this tablet to one, then choose a voice in Settings, Voice.", style = calmText(Calm.LEAD))
                Soft("Linking is in Settings, Account, too.")
                SoftButton("Link this tablet") { o.host.setupVoice("link") }
                SoftButton("Use your own OpenAI key") { o.host.setting("ownKey") }
            }
            "noBridge" -> Text("The tablet's software isn't answering right now. Opie's voice is in Settings, Voice, once it is.", style = calmText(Calm.LEAD))
            else -> {
                Text("You can talk to Opie: say “Hey Opie”, then what you'd like.", style = calmText(Calm.LEAD))
                Rows(listOf("Add milk to the list", "What's on tomorrow?", example).map { t -> @Composable {
                    Text("“Hey Opie, ${t.replaceFirstChar { it.lowercase() }}”", style = calmText(21), modifier = Modifier.padding(vertical = 10.u))
                } })
                Column(verticalArrangement = Arrangement.spacedBy(10.u)) {
                    Text("Choose a voice", style = calmText(21, FontWeight.Medium))
                    // All of them in view: rows of six, each name one word on one line (no row running off the edge).
                    Column(verticalArrangement = Arrangement.spacedBy(8.u)) {
                        voices.chunked(6).forEach { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.u)) {
                                row.forEach { (id, about) ->
                                    Chip(about.substringBefore(" · "), Modifier.weight(1f), selected = voice == id) {
                                        voice = id
                                        if (state == "on") o.host.setupVoice("sample", id) // on: it says a line in the new voice
                                    }
                                }
                                repeat(6 - row.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }
                    // Before it's on there's nothing to play them with: they're OpenAI's live voices, heard only in a
                    // session, and a session is for after the yes below.
                    Soft((voices.firstOrNull { it.first == voice }?.second?.substringAfter(" · ", "")?.takeIf { it.isNotBlank() }?.let { "$it. " } ?: "") +
                        if (state == "on") "Tap another to hear it." else "You hear it once the voice is on.")
                }
                if (state == "ready") Column(verticalArrangement = Arrangement.spacedBy(6.u)) {
                    Text("What you say after “Hey Opie” goes to OpenAI.", style = calmText(21))
                    Soft("Not now leaves it off: it's in Settings, Voice.") // (here, not beside the buttons: the card is narrow)
                }
                if (state == "on") Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.u)) {
                    Box(Modifier.size(172.u, 76.u), contentAlignment = Alignment.Center) { dev.openhouse.shell.AssistantFace(onLongPress = {}, wide = true) }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.u)) {
                        Text("Try it: say “Hey Opie, what's the weather?”", style = calmText(Calm.LEAD, FontWeight.Medium))
                        val now by produceState(0L) { while (true) { value = System.currentTimeMillis(); delay(300) } }
                        val said = remember(now) { dev.openhouse.shell.LiveVoice.caption.takeIf { dev.openhouse.shell.LiveVoice.active } }
                        said?.takeIf { it.isNotBlank() }?.let { Soft(it.takeLast(200)) }
                    }
                }
            }
        }
        problem?.let { Soft(it) }
    }
}

/** The voice step's buttons: Turn on Opie's voice (a person's tap: the yes to OpenAI) or Not now; else Done. */
@Composable
private fun VoiceButtons(v: VoiceUi) {
    val o = Openhouse
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
        TextButton("Back") { Setup.back() }
        Spacer(Modifier.weight(1f))
        if (v.state == "ready") {
            TextButton("Not now") { o.host.setupVoice("off"); Setup.finish() }
            MainButton(if (v.busy) "Turning on…" else "Turn on Opie's voice", enabled = !v.busy) {
                v.busy = true; v.problem = null
                o.host.setupVoice("on", v.voice) { r ->
                    v.busy = false
                    when (r) { "on" -> v.state = "on"; "notYet" -> v.state = "notYet"; else -> v.problem = r.ifBlank { null } }
                }
            }
        } else MainButton("Done", enabled = v.state != "looking") { Setup.finish() }
    }
}

/** The PIN: Settings and saying yes to new apps are for the people who know it. Skipping leaves the lock off (PIN
 *  Lock in Settings turns it on later). */
@Composable
private fun PinStep(set: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(14.u)) {
        Text("It guards Settings and saying yes to new apps.", style = calmText(Calm.LEAD))
        Text(if (set) "PIN Lock is on. Settings and approving new apps ask for the PIN."
            else "With a PIN, only someone who knows it can change Settings or approve a new app. Without one, anyone at the tablet can, and the first person to choose a PIN later decides. Best chosen now, while you're setting it up.",
            style = calmText(19, color = Calm.soft))
    }
}

/**
 * Two of Android's own settings that a tablet set up from the code can't turn on by itself (docs/setup.md): letting
 * Opie use other apps (its accessibility service: no device-owner API turns one on) and the charge limit (each maker
 * has its own, with no screen an app can open directly, so Android's settings open and the path for the model shows:
 * docs/tablets.md). Both leave kiosk mode for Android's settings; Home comes back here. Either can be skipped.
 */
@Composable
private fun AndroidStep() {
    var control by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        while (true) { control = withContext(Dispatchers.IO) { Openhouse.host.settingValues()["deviceControl"] == "On" }; delay(2000) }
    }
    val samsung = android.os.Build.MANUFACTURER.equals("samsung", ignoreCase = true)
    Column(verticalArrangement = Arrangement.spacedBy(28.u)) {
        Column(verticalArrangement = Arrangement.spacedBy(10.u)) {
            Text("Let Opie use other apps", style = calmText(21, FontWeight.Medium))
            Soft("So it can open an app or press its buttons when you ask, like a TV remote. Without it, the rest of Opie works.")
            if (control) Text("On", style = calmText(19, FontWeight.Medium, Calm.soft))
            else { HowTo(listOf("Tap Open Android's settings.", "Tap Opie assistant, switch it on and tap Allow.", "Press Home to come back.")); SoftButton("Open Android's settings") { Openhouse.host.setting("setupDeviceControl") } }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.u)) {
            Text("Stop charging at 80%", style = calmText(21, FontWeight.Medium))
            Soft("It's plugged in all day, and a battery kept full wears out sooner.")
            HowTo(if (samsung) listOf("Tap Open Android's settings.", "Tap Battery, then Battery protection, and choose Maximum.", "Press Home to come back.")
                else listOf("Tap Open Android's settings.", "Look in Battery for a charge limit or battery protection. docs/tablets.md has the path for each tablet we know.", "Press Home to come back."))
            SoftButton("Open Android's settings") { Openhouse.host.setting("setupCharge") }
        }
    }
}

/** Who lives here: names and an age or role, typed (what was saved before shows). */
@Composable
private fun PeopleStep(onAdd: (() -> Unit) -> Unit, onSave: (() -> Unit) -> Unit) {
    val o = Openhouse
    val people = remember { mutableStateListOf<SetupPerson>() }
    var edited by remember { mutableStateOf(false) }
    val first = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { delay(300); runCatching { first.requestFocus() } } // keys go here, not to the home screen behind
    // Someone added: their name has the keys, which brings it into view above the keyboard.
    var added by remember { mutableStateOf<SetupPerson?>(null) }
    LaunchedEffect(added) { added?.let { delay(100); runCatching { it.focus.requestFocus() } } }
    LaunchedEffect(Unit) {
        val saved = withContext(Dispatchers.IO) { o.loadHousehold() }?.optJSONArray("family")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
        if (!edited && saved.isNotEmpty()) { people.clear(); saved.forEach { people += SetupPerson(it.optString("name"), it.optString("note")) } }
        if (people.isEmpty()) people += SetupPerson("", "")
    }
    onAdd { SetupPerson("", "").let { people += it; added = it }; edited = true }
    onSave { if (edited) o.saveHousehold(JSONObject().put("family", JSONArray(people.filter { it.name.isNotBlank() }.map { JSONObject().put("name", it.name.trim()).put("note", it.note.trim()) }))) }
    Column(verticalArrangement = Arrangement.spacedBy(12.u)) {
        people.forEachIndexed { i, p ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.u), verticalAlignment = Alignment.CenterVertically) {
                Field(p.name, { p.name = it; edited = true }, "Name", Modifier.weight(1f), focus = if (i == 0) first else p.focus, words = true)
                Field(p.note, { p.note = it; edited = true }, "Age 9, or Mom", Modifier.weight(1f))
                Box(Modifier.size(44.u).clip(CircleShape).clickable { people.remove(p); edited = true; if (people.isEmpty()) people += SetupPerson("", "") }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Close, "Remove", tint = PaperLook.inkSoft, modifier = Modifier.size(20.u))
                }
            }
        }
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
        // What was saved before, else the guess (which may come a moment later).
        val h = withContext(Dispatchers.IO) { o.loadHousehold() }
        val addr = h?.optString("address")?.takeIf { it.isNotBlank() && it != "null" }
        val loc = h?.optString("location")?.takeIf { it.isNotBlank() && it != "null" }
        if (edited) return@LaunchedEffect
        if (addr != null) { value["street"] = addr; return@LaunchedEffect }
        if (loc != null) { if (Regex("^\\d{5}").containsMatchIn(loc)) { value["zip"] = loc; kind = "zip" } else { value["town"] = loc; kind = "town" }; return@LaunchedEffect }
        var waited = 0
        while (Setup.guess == null && waited < 20_000) { delay(500); waited += 500 }
        if (!edited) Setup.guess?.let { g -> if (value["street"].isNullOrEmpty()) { value["street"] = g.optString("address"); value["town"] = g.optString("town"); value["zip"] = g.optString("zip") } }
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

/** Connecting a phone or computer, for the rest of the setup and after: whose it is, then two ways in, each on its
 *  own line: a phone scans the code; a computer goes to the tablet's name (opie.local:8788, answered on the Wi-Fi
 *  while the code lasts: bridge connect-page.js) and types the code. The calendar and photos steps then send their
 *  links from it. What's connected shows here as it comes in. */
@Composable
private fun DevicesStep() {
    val o = Openhouse
    var names by remember { mutableStateOf(listOf<String>()) }
    var who by remember { mutableStateOf<String?>(null) }
    var pair by remember { mutableStateOf<JSONObject?>(null) }
    var count by remember { mutableStateOf(0) }
    val device = connectedDevice()
    LaunchedEffect(Unit) {
        val h = withContext(Dispatchers.IO) { o.loadHousehold() }
        val kidOrPet = { n: String -> Regex("^\\d{1,2}$").matches(n.trim()) || Regex("\\b(dog|cat|pet|fish|bird|hamster|rabbit)\\b", RegexOption.IGNORE_CASE).containsMatchIn(n) }
        names = h?.optJSONArray("family")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty().filter { !kidOrPet(it.optString("note")) }.map { it.optString("name") }
        who = names.firstOrNull() ?: "Me"
    }
    var used by remember { mutableStateOf(0) } // devices joined with a code from here: each code works once, so a new one
    LaunchedEffect(who, used) { val w = who ?: return@LaunchedEffect; pair = null; pair = withContext(Dispatchers.IO) { o.host.setupPair(w) } }
    LaunchedEffect(Unit) {
        while (true) {
            count = withContext(Dispatchers.IO) {
                getJson("/screens")?.optJSONArray("screens")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                    .count { d -> d.optJSONArray("scopes")?.let { sc -> (0 until sc.length()).any { sc.optString(it) == "setup" } } == true }
            }
            if (count > used) used = count
            delay(2000)
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.u)) {
        Text("Then you can send calendars and photos from it, and use Opie from anywhere.", style = calmText(19, color = Calm.soft))
        if (names.size > 1) {
            Spacer(Modifier.height(6.u))
            Text("Whose is it?", style = calmText(19, FontWeight.Medium))
            Row(horizontalArrangement = Arrangement.spacedBy(8.u)) { names.forEach { n -> Chip(n, selected = who == n) { who = n } } }
        }
        Spacer(Modifier.height(10.u))
        Row(horizontalArrangement = Arrangement.spacedBy(32.u), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(232.u).clip(RoundedCornerShape(Calm.R_CARD.u)).background(androidx.compose.ui.graphics.Color.White), contentAlignment = Alignment.Center) {
                val url = pair?.optString("url")
                val bmp = remember(url) { url?.let { runCatching { dev.openhouse.shell.Handoff.qr(it, 480).asImageBitmap() }.getOrNull() } }
                if (bmp != null) Image(bmp, "Code to scan", Modifier.size(212.u)) else Text("…", style = calmText(30, color = Calm.soft))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(18.u)) {
                Text("On a phone, scan the code.", style = calmText(Calm.LEAD))
                pair?.let { p ->
                    // Only the tablet's name, never its raw Wi-Fi address; without a name, a phone it is.
                    p.optString("address").takeIf { it.isNotBlank() }?.let { addr ->
                        Text(androidx.compose.ui.text.buildAnnotatedString {
                            append("On a computer, go to ")
                            withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.SemiBold)) { append(addr) }
                            append(" and type ")
                            withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.SemiBold)) { append(p.optString("code")) }
                        }, style = calmText(Calm.LEAD))
                    }
                }
            }
        }
        device?.let {
            Spacer(Modifier.height(6.u))
            Text("Connected: $it" + if (count > 1) " and ${count - 1} more" else "", style = calmText(19, FontWeight.Medium))
        }
    }
}
