package dev.openhouse.ui

// The first setup, right after the welcome (docs/onboarding.md), done from a phone or computer: connecting one comes
// first (one code; the phone page then follows these steps: chat/src/phone.jsx SetupFlow), then, typed or sent there,
// who lives here, where (a street address guessed from where the tablet is), the household's calendar (Google, iCloud,
// Outlook or a link, or none), photos (an iCloud shared album, Google Photos, or from that phone) and Opie's AI (the
// household's own OpenAI key, where the account's voice isn't on). Then what only the tablet can do: a PIN for
// settings and approvals (PIN Lock, which can be skipped), two of Android's own settings a tablet set up by its
// household would otherwise never find (letting Opie use other apps, and the charge limit), and last talking to Opie:
// what to say, which voice, and turning the voice on. One step on screen at a time.
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
    // The setup is done from a phone or computer (2026-11-26, the owner: "it's ok to require a phone or computer to set
    // it up", and "all of the steps are supposed to be on the computer"): connecting one comes first, and can't be
    // skipped; every step after is done there, and its Next moves the tablet on (/setup/want; chat/src/phone.jsx
    // SetupFlow follows the tablet's step). Last, the one thing Android lets only the tablet do: two of its settings.
    val STEPS = listOf("devices", "people", "place", "calendar", "photos", "ai", "pin", "voice", "android")
    /** Done on the phone or computer: the tablet shows only how far along it is (the owner: "no need to show a skeleton
     *  thing on the tablet during the flow - it should just be the instructions for how to set things up until it's
     *  ready, maybe with a progress bar"). */
    val ON_PHONE = setOf("people", "place", "calendar", "photos", "ai", "pin", "voice")

    /** A later step that sent someone back to connect a phone or computer: Next there comes back here. */
    private var resume: String? = null
    fun connectFirst() { resume = Openhouse.setupStep; go("devices") }

    /** Where the tablet is, guessed once ({address, town, zip}), for the place step on the phone (bridge /setup/guess). */
    @Volatile var guess: JSONObject? = null

    /** The phone or computer the setup carries on from, by name, once one has joined (Setup.kt connectedDevice). */
    @Volatile var connected: String? = null

    /** The welcome or a setup step before the voice step is showing: no microphone, no wake word, no live voice and
     *  nothing said aloud (MainActivity.micWanted, LiveVoice, Speech.say). */
    val hushed: Boolean get() = Openhouse.showWelcome || Openhouse.setupStep.let { it != null && STEPS.indexOf(it) < STEPS.indexOf("voice") }

    fun start() {
        Openhouse.setupStep = STEPS.first(); shown(STEPS.first())
        Openhouse.scope.launch(Dispatchers.IO) { if (guess == null) guess = runCatching { Openhouse.host.guessHome() }.getOrNull(); guess?.let { Openhouse.post("/setup/guess", it) } }
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

private fun getJson(path: String, readMs: Int = 4000): JSONObject? = runCatching { JSONObject(BridgeClient.getText(Openhouse.bridgeUrl + path, 2000, readMs)) }.getOrNull()

@Composable
internal fun SetupSheet() {
    val step = Openhouse.setupStep ?: return
    val title = when (step) {
        "people" -> "Who lives here?"; "place" -> "Where do you live?"; "calendar" -> "Do you have a family calendar?"
        "photos" -> "Put your photos on the tablet?"; "pin" -> "Choose a PIN"; "voice" -> "Talk to Opie"
        "android" -> "Two Android settings"; "ai" -> "Set up Opie's AI"
        else -> "Set up on your phone or computer"
    }
    val save = remember(step) { arrayOf<() -> Unit>({}) } // the step's own: what was typed, saved on Next, Back or Later
    // The phone or computer's Next (bridge /setup/go): the tablet follows it.
    LaunchedEffect(Unit) {
        while (true) {
            val want = withContext(Dispatchers.IO) { getJson("/setup/want") }?.optString("step")?.takeIf { it in Setup.STEPS }
            if (want != null && want != Openhouse.setupStep) Setup.go(want)
            delay(1500)
        }
    }
    val device = connectedDevice()
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        // From the top, not centered: the card's top stays put from step to step (the last, the voices, starts higher:
        // it has the most to show, down to the line about OpenAI above its buttons). Every step is the same width. The
        // card never runs past the screen, or past Android's on-screen keyboard when it's up (a tablet with no keyboard
        // cover: imePadding, and nearer the top): what's in it scrolls, and Back, Skip and Next stay below it in reach.
        val ime = androidx.compose.foundation.layout.WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current) > 0
        // The setup has the screen to itself: nothing of the home screen behind it.
        val onPhone = step in Setup.ON_PHONE || step == "devices"
        Box(Modifier.fillMaxSize().background(Calm.paper).clickable(enabled = false) {}.imePadding(), contentAlignment = Alignment.TopCenter) {
            QuietCard(Modifier.padding(top = if (ime) 16.u else if (step == "voice") 36.u else 110.u, bottom = 16.u).width(fit(860.u)), padding = PaddingValues(horizontal = 56.u, vertical = if (ime) 28.u else 48.u)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.u)) {
                    Progress(Setup.STEPS.indexOf(step).toFloat() / Setup.STEPS.size, Modifier.weight(1f))
                    if (step != "voice") Chip("Later") { save[0](); Setup.finish() }
                }
                Spacer(Modifier.height(28.u))
                Text(if (!onPhone) title else if (device != null && step != "devices") "Continue on $device" else "Set up on your phone or computer", style = calmText(Calm.DISPLAY, FontWeight.Medium))
                Spacer(Modifier.height(20.u))
                if (onPhone) {
                    // Until a phone or computer is in, how to connect one; then only what's happening there.
                    if (device == null || step == "devices") DevicesStep() else PhoneProgress(step)
                } else {
                    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                        Spacer(Modifier.height(8.u))
                        AndroidStep()
                    }
                    Spacer(Modifier.height(28.u))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
                        if (Setup.STEPS.indexOf(step) > 0) TextButton("Back") { save[0](); Setup.back() }
                        Spacer(Modifier.weight(1f))
                        MainButton("Done") { Setup.finish() } // (the last step: either setting can wait)
                    }
                }
            }
        }
    }
}

/** How far along the setup is: a thin bar. */
@Composable
private fun Progress(f: Float, modifier: Modifier = Modifier) {
    Box(modifier.height(6.u).clip(RoundedCornerShape(3.u)).background(Calm.line)) {
        Box(Modifier.fillMaxWidth(f.coerceIn(0.04f, 1f)).fillMaxHeight().clip(RoundedCornerShape(3.u)).background(Calm.ink))
    }
}

/** A step done on the phone or computer: what's happening there, in a line. The tablet moves on when it does. Photos
 *  from phones need a yes here once (a person's), so that one step keeps its button. */
@Composable
private fun PhoneProgress(step: String) {
    val now = when (step) {
        "people" -> "Who lives here"; "place" -> "Where you live"; "calendar" -> "Your calendars"; "photos" -> "Your photos"
        "pin" -> "A PIN"; "voice" -> "Opie's voice"; else -> "Opie's AI"
    }
    var phonesOn by remember { mutableStateOf(true) }
    LaunchedEffect(step) { if (step == "photos") phonesOn = withContext(Dispatchers.IO) { runCatching { dev.openhouse.shell.PhotoShare.link() }.getOrNull() } != null }
    Column(verticalArrangement = Arrangement.spacedBy(16.u)) {
        Soft(now)
        if (step == "photos" && !phonesOn) SoftButton("Let phones send photos") { Openhouse.host.setting("photoPhonesOn") }
        // The voice on (from the phone): it's heard here, so the try is here.
        if (step == "voice" && remember(Openhouse.settingsV) { Openhouse.host.hasAssistant() }) Text("Try it: say “Hey Opie, what's the weather?”", style = calmText(Calm.LEAD, FontWeight.Medium))
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
            Soft("So it can open apps and press their buttons when you ask.")
            if (control) Text("On", style = calmText(19, FontWeight.Medium, Calm.soft))
            else { HowTo(listOf("Tap Open Android's settings.", "Tap Opie assistant, switch it on, then Allow.", "Press Home to come back.")); SoftButton("Open Android's settings") { Openhouse.host.setting("setupDeviceControl") } }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.u)) {
            Text("Stop charging at 80%", style = calmText(21, FontWeight.Medium))
            Soft("A battery kept full wears out sooner.")
            HowTo(if (samsung) listOf("Tap Open Android's settings.", "Tap Battery, then Battery protection, and choose Maximum.", "Press Home to come back.")
                else listOf("Tap Open Android's settings.", "In Battery, turn on a charge limit or battery protection.", "Press Home to come back."))
            SoftButton("Open Android's settings") { Openhouse.host.setting("setupCharge") }
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
    // Connected for the setup (and not just come back here to connect another): on to the first step done there.
    var hadOne by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(device) { if (hadOne == null) hadOne = device != null else if (device != null && hadOne == false) Setup.next() }
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
        if (names.size > 1) {
            Text("Whose is it?", style = calmText(19, FontWeight.Medium))
            Row(horizontalArrangement = Arrangement.spacedBy(8.u)) { names.forEach { n -> Chip(n, selected = who == n) { who = n } } }
        }
        Spacer(Modifier.height(10.u))
        // The code beside its words; on a phone (Calm.compact) the words under it.
        val stack = androidx.compose.ui.platform.LocalConfiguration.current.smallestScreenWidthDp in 1..599
        val code: @Composable () -> Unit = {
            Box(Modifier.size(232.u).clip(RoundedCornerShape(Calm.R_CARD.u)).background(androidx.compose.ui.graphics.Color.White), contentAlignment = Alignment.Center) {
                val url = pair?.optString("url")
                val bmp = remember(url) { url?.let { runCatching { dev.openhouse.shell.Handoff.qr(it, 480).asImageBitmap() }.getOrNull() } }
                if (bmp != null) Image(bmp, "Code to scan", Modifier.size(212.u)) else Text("…", style = calmText(30, color = Calm.soft))
            }
        }
        val words: @Composable (Modifier) -> Unit = { m ->
            Column(m, verticalArrangement = Arrangement.spacedBy(18.u)) {
                Text("On a phone, scan this code.", style = calmText(Calm.LEAD))
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
        if (stack) Column(verticalArrangement = Arrangement.spacedBy(24.u)) { code(); words(Modifier) }
        else Row(horizontalArrangement = Arrangement.spacedBy(32.u), verticalAlignment = Alignment.CenterVertically) { code(); words(Modifier.weight(1f)) }
        device?.let {
            Spacer(Modifier.height(6.u))
            Text("Connected: $it" + if (count > 1) " and ${count - 1} more" else "", style = calmText(19, FontWeight.Medium))
        }
    }
}
