package dev.openhouse.ui

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** What the shell does for the board (timers, apps, video, conversations). */
interface Host {
    val context: android.content.Context
    val bridge: String
    fun startTimer(label: String, seconds: Int)
    fun cancelTimer(id: Int)
    /** A timer taken off the home screen a moment ago, put back: the same label, ending when it would have. */
    fun restoreTimer(label: String, total: Int, endAt: Long) = startTimer(label, ((endAt - System.currentTimeMillis()) / 1000).toInt().coerceAtLeast(1))
    fun timers(): List<TimerInfo>
    /** The house's timers as the bridge has them (some started on other screens): the shell matches its own to them. */
    fun syncTimers(timers: List<TimerInfo>) {}
    fun openApp(id: String)
    /** Back to the home screen from a family app open full screen (a paired computer's show_on_tablet). */
    fun closeApp() {}
    /** The family's app on screen (not the home screen), or null. */
    val openAppId: String?
    fun playVideo(url: String, title: String)
    fun makeApp(request: String, context: String)
    /** The first setup: where the tablet is, as a street address, town and zip ({address, town, zip}), or null. Blocking. */
    fun guessHome(): JSONObject? = null
    /** The first setup: a code for [person]'s phone or computer ({url, code, address}), or null. Blocking. */
    fun setupPair(person: String): JSONObject? = null
    /** Up one level (MainActivity.back): a sheet, then Settings, then an app. */
    fun back() {}
    /** A row of Settings that the shell opens (its dialogs over the list): "voice", "screens",
     *  "account", "backups", "plugins", "updates", "lock", "tablet", "calendars" (docs/settings.md). */
    fun setting(id: String) {}
    /** What the rows the shell keeps show ("live" to "On", "updates" to the version...), read off the main thread. */
    fun settingValues(): Map<String, String> = emptyMap()
    /** The lock is on (a PIN is set): the rows it locks show a small lock. */
    fun locked(): Boolean = false
    /** Android's Wi-Fi screen, behind the PIN when the lock is on (a moved tablet joins its new home's Wi-Fi here). */
    fun wifi() {}
    /** With the lock on, the PIN, then [ok]; with it off, straight to [ok]. */
    fun withPin(title: String, ok: () -> Unit) { ok() }
    /** The setup's last step, Talk to Opie (Setup.kt VoiceStep): [action] "on" ([voice] chosen, then the live voice and
     *  Hey Opie on: a person's tap, behind the PIN when the lock is on), "off" (Not now: it stays off, not turned on by
     *  itself later), "sample" (on already: [voice] chosen, and Opie says a line in it), "link" (link the tablet to an
     *  account). [done] gets "on", "notYet" (the household doesn't have the voice yet), or what went wrong, to show. */
    fun setupVoice(action: String, voice: String = "", done: (String) -> Unit = {}) {}
    /** OpenAI's live voices: API name to how it sounds ("Gleam · North American, feminine"). */
    fun voices(): List<Pair<String, String>> = emptyList()
    /** The welcome or the setup came or went: the microphone follows (none until the setup's voice step: Setup.hushed). */
    fun micFollow() {}
    /** The assistant is on (OpenAI's live voice and text model, through the family's account). */
    fun hasAssistant(): Boolean = true
    /** Settings → Voice (no PIN): which of OpenAI's voices it speaks with; it says hello in the new one. */
    fun chooseVoice() {}
}

/** The tablet's way out: [Online]; [NoInternet], on a network that doesn't reach the internet (or a hotel's sign-in
 *  page); [NoNetwork], on none at all (a new house, the router off). */
enum class Net { Online, NoInternet, NoNetwork }

/**
 * The home board's connection to everything: the family's data, the home screen, asking (Conversations.kt: streamed
 * answers with generated UI, read aloud when asked by voice, Speech.kt), voice (Listening.kt: who's talking, tap
 * to talk), timers and apps. Fixed in the shell: the board the family's agent edits only draws what's here.
 */
object Openhouse : AnswerActions {
    // ---- state (Compose reads these) ----
    var board by mutableStateOf<BoardData?>(null); private set
    var apps by mutableStateOf(listOf<AppInfo>()); private set
    var timers by mutableStateOf(listOf<TimerInfo>()); private set
    var answer by mutableStateOf<Answer?>(null); internal set
    /** The home screen: the notes the assistant (and the family) put up, and where everything else sits. */
    var homeScreen by mutableStateOf<HomeData?>(null); private set
    /** The note opened up close, full screen. */
    var fullNote by mutableStateOf<String?>(null)
    var speaker by mutableStateOf<Speaker?>(null); internal set
    var heard by mutableStateOf<Heard?>(null); internal set
    /** The words heard so far while someone is talking to the display (live), or null. */
    var partial by mutableStateOf<String?>(null); internal set
    /** The typing box's mic: what's heard goes into the draft (to fix, then send) instead of being asked. */
    var dictating by mutableStateOf(false); internal set
    var voice by mutableStateOf(VoiceStatus(false, false, null)); private set
    /** Someone started talking (ms). */
    var hearingAt by mutableStateOf(0L); internal set
    /** Until when a test recording of the microphone runs (0: none). Shown as a dot. */
    var recordingUntil by mutableStateOf(0L); internal set
    /** Tapped the microphone: listening for one request until this time. */
    var awaitingUntil by mutableStateOf(0L); internal set
    /** Hands-free: listening for the asker's voice without the wake words until this time (a task underway, or just after a reply). */
    var handsFreeUntil by mutableStateOf(0L); internal set
    /** The display is reading an answer aloud. */
    var speaking by mutableStateOf(false); internal set
    /** Typing box open (with an optional note), or null. */
    var typing by mutableStateOf<String?>(null); internal set
    /** Text typed before the typing box opened (a keyboard's first keys). */
    var draft by mutableStateOf(""); internal set
    /** The settings sheet (the home screen's gear): the voice, family, devices, the home screen. */
    var showSettings by mutableStateOf(false)
    /** The family setup sheet (who lives here, where, calendars, chores). */
    var showFamily by mutableStateOf(false)
    /** A text field on the home screen's page (or an app in a tab) has the keyboard (HomeView's editing()). */
    @Volatile var webEditing = false
    /** What's been taken off the home screen (Settings → Off the home screen): put any of it back. */
    /** The assistant. It wakes to "Hey Opie", the same in every home (docs/wake-word.md). */
    val assistantName: String get() = "Opie"
    /** How to wake it, for hints. */
    val wakeHint: String get() = "Hey Opie"
    /** Wake to "Hey Opie", or only to a tap (the default). */
    fun setWakeWord(on: Boolean) = scope.launch { ui { voice = voice.copy(wakeOn = on) }; post("/voice/wake", JSONObject().put("on", on)); loadVoiceStatus() }
    /** Whether the household is set up yet (no: setup opens by itself, once). */
    var householdSetUp by mutableStateOf(true); private set

    // ---- the household ----
    /** What the bridge knows about the family; null if it couldn't be read. */
    suspend fun loadHousehold(): JSONObject? = withContext(Dispatchers.IO) { runCatching { JSONObject(get("/household")) }.getOrNull() }
    fun saveHousehold(h: JSONObject) = scope.launch {
        post("/household", h)
        loadBoard(); loadVoiceStatus(); ui { householdSetUp = true }
    }
    private suspend fun checkHousehold() {
        var h = loadHousehold()
        while (h == null) { delay(3000); h = loadHousehold() } // the bridge may still be starting
        if (!h.optBoolean("setup", true)) ui { householdSetUp = false; showWelcome = true; host.micFollow() }
    }

    // ---- the first screen (a new tablet) ----
    /** Welcome: what this is, then the setup. Quiet, like the setup: the voice is its last step (Setup.kt). */
    var showWelcome by mutableStateOf(false); private set
    /** Welcome → "Get started": the setup's steps, by touch and typing. */
    fun welcomeStart() { showWelcome = false; Setup.start() }
    /** The setup's step on screen (Setup.kt), or null. */
    var setupStep by mutableStateOf<String?>(null); internal set
    /** The setup finished or was left: the home screen as it comes, not asked again. */
    fun householdDone() = ui { householdSetUp = true }
    /** The assistant was turned on (Settings, or the setup's last step). New here (nobody saved yet, outside the
     *  setup), the setup starts. */
    fun assistantReady() = scope.launch {
        if (setupStep != null || showWelcome) return@launch
        val h = loadHousehold() ?: return@launch
        val met = (h.optJSONArray("family")?.length() ?: 0) > 0
        if (!met) ui { householdSetUp = false; Setup.start() }
    }

    // ---- Settings (docs/settings.md) ----
    /** Bumped when something in Settings may have changed (a dialog over it closed, the lock went on or off): the
     *  list reads its values again. */
    var settingsV by mutableStateOf(0); private set
    fun settingsChanged() = ui { settingsV++ }

    // ---- the speech log (off unless someone turns it on in Settings) ----
    var speechLog by mutableStateOf(false); private set
    fun setSpeechLog(on: Boolean) = scope.launch { if (post("/voice/log/setting", JSONObject().put("on", on)) != null) ui { speechLog = on } }
    /** While the first conversation (getting to know the family) is open. */
    var onboarding by mutableStateOf(false); internal set
    /** The first conversation: the assistant introduces itself and asks who lives here and where, out loud. */
    fun startOnboarding() {
        onboarding = true; showFamily = false
        showConversation = true; conversation = Conversation(null, emptyList())
        Turns.sayInConversation("", voice = true, onboard = true)
    }
    /** The agent at work (or just finished), or null. */
    var build by mutableStateOf<Build?>(null); internal set
    /** What's asked to be made after it, in turn (bridge builder.js: a request made while one is being made). */
    var buildQueue by mutableStateOf(listOf<String>()); internal set
    /** The conversation screen: open, its conversation, and the list of earlier ones. */
    var showConversation by mutableStateOf(false); private set
    var conversation by mutableStateOf<Conversation?>(null); internal set
    var conversations by mutableStateOf(listOf<ConversationInfo>()); private set
    /** Nobody has touched or talked to it for a while: show something calm. */
    var idle by mutableStateOf(false); private set
    /** The current time, updated every second (read it to tick a clock). */
    var now by mutableStateOf(System.currentTimeMillis()); private set

    const val PERSON_MS = 4 * 60_000L
    const val IDLE_MS = 8 * 60_000L

    fun person(name: String?) = board?.family?.firstOrNull { it.name == name }
    /** Whoever spoke in the last few minutes (null if nobody, or if it wasn't sure who). */
    val me: Person? get() = speaker?.takeIf { !it.unsure && now - it.at < PERSON_MS }?.let { person(it.name) }

    // ---- setup ----
    internal lateinit var host: Host
    /** The tablet's connection (the shell watches Android's), and since when it is what it is. */
    var net by mutableStateOf(Net.Online); private set
    var netSince = 0L; private set
    fun setNet(n: Net) = ui { if (n != net) { net = n; netSince = System.currentTimeMillis() } }
    fun joinWifi() = host.wifi()
    private val main = Handler(Looper.getMainLooper())
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var lastTouch = System.currentTimeMillis()
    /** An app is in use hands-free until then (the home screen's handsFree: the Recipes app while cooking): no resting screen. */
    @Volatile private var appInUseUntil = 0L
    /** The latest "show this" from the bridge (home-screen.js showTab/showApp) already seen. */
    @Volatile private var shownAt = 0L
    private var started = false
    internal fun ui(f: () -> Unit) = main.post(f)

    /**
     * In an app's own window (AppWindow, the app's installed Android app, another process): no
     * display here, just the family's data from the bridge, so `Openhouse.board?.family` works.
     */
    fun startInApp(bridge: String) {
        if (started) return; started = true
        appBridge = bridge
        scope.launch { while (true) { loadBoard(); delay(60_000) } }
    }
    private var appBridge: String? = null
    private val bridge: String get() = appBridge ?: host.bridge

    fun start(h: Host) {
        host = h
        dev.openhouse.shell.AppStore.onChanged = { appsChanged() }
        if (started) return; started = true
        Speech.init(h.context)
        PaperLook.loadFonts(h.context.assets)
        scope.launch { while (true) { loadBoard(); delay(15_000) } }
        scope.launch { while (true) { loadWeather(); delay(if (weather == null) 15_000 else 5 * 60_000) } } // quickly until the bridge is up
        scope.launch { while (true) { loadApps(); delay(if (apps.isEmpty()) 4_000 else 60_000) } } // the bridge may still be starting
        scope.launch { while (true) { loadVoiceStatus(); delay(20_000) } }
        scope.launch { Listening.events() }
        scope.launch { Turns.buildEvents() }
        scope.launch { homeEvents() }
        House.start() // the family's things: reminders show over everything, whatever app is open
        scope.launch { delay(4000); checkHousehold() }
        main.post(object : Runnable {
            override fun run() {
                now = System.currentTimeMillis()
                timers = runCatching { host.timers() }.getOrDefault(emptyList())
                if (timers.any { it.ringing }) touch()
                if (now < appInUseUntil) lastTouch = now // an app in use hands-free (cooking): the screen stays as it is
                if (!idle && now - lastTouch > IDLE_MS && answer?.live != true && !speaking) idle = true
                main.postDelayed(this, 1000)
            }
        })
    }

    /** Reminders already seen (each chimes once, and is said once if the family wants them said). */
    private val remindSeen = mutableSetOf<String>()
    /** New reminders from the bridge: the screen wakes and a soft chime plays, unless it's dark (night, Sleep now);
     *  then the card waits quietly for the morning or a touch. Said aloud only when the family turned that on. */
    fun reminded(list: List<HouseReminder>) {
        val fresh = list.filter { remindSeen.add(it.key) }
        if (remindSeen.size > 300) remindSeen.retainAll(list.map { it.key }.toSet())
        if (fresh.isEmpty() || dark || sleeping || House.isNight()) return
        touch()
        if (House.remindAloud && answer?.live != true && !speaking) Speech.say(remindWords(fresh.first()), null)
        else chime()
    }
    /** "Swim in 15 minutes, for Maya" / "Swim now". */
    fun remindWords(r: HouseReminder, at: Long = System.currentTimeMillis()): String {
        val min = Math.ceil((r.start - at) / 60000.0).toInt()
        val whenText = when {
            min <= 0 -> "now"
            min == 1 -> "in a minute"
            min < 60 -> "in $min minutes"
            min % 60 == 0 && min < 180 -> if (min == 60) "in an hour" else "in ${min / 60} hours"
            else -> "at " + java.text.SimpleDateFormat("h:mm", java.util.Locale.getDefault()).format(java.util.Date(r.start))
        }
        return "${r.title} $whenText" + (r.who?.let { ", for $it" } ?: "")
    }
    private fun chime() = runCatching {
        val uri = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION) ?: return@runCatching
        android.media.RingtoneManager.getRingtone(host.context, uri)?.apply {
            audioAttributes = android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_EVENT).build()
            play()
        }
    }

    /** Someone touched the screen (the shell calls this). */
    fun touch() { lastTouch = System.currentTimeMillis(); sleepUntil = 0L; if (idle) idle = false }

    /** The Calendar app, with the lock on, asks: the PIN, then apps may change the calendar for a couple of minutes. */
    fun unlockCalendar() = host.withPin("PIN") { scope.launch { post("/house/unlock") } }

    /** A phone card over the home (an app in a tab asked): kind ("photos", "flyer", "list") and its arg, or null. */
    var phoneCard by mutableStateOf<Pair<String, String>?>(null)

    /** The home screen is dark (night hours, or "Sleep now"): the page says so with the backlight (HomeView.dim). */
    var dark by mutableStateOf(false); internal set

    /** "Sleep now": dark at once, as at night, until someone touches it or morning (the night's end, else 6:30). */
    private var sleepUntil = 0L
    val sleeping: Boolean get() = idle && System.currentTimeMillis() < sleepUntil
    fun sleepNow() {
        val (h, m) = (House.night?.second ?: "06:30").split(":").map { it.toIntOrNull() ?: 0 }
        val c = java.util.Calendar.getInstance()
        c.set(java.util.Calendar.HOUR_OF_DAY, h); c.set(java.util.Calendar.MINUTE, m); c.set(java.util.Calendar.SECOND, 0)
        if (c.timeInMillis <= System.currentTimeMillis()) c.add(java.util.Calendar.DAY_OF_MONTH, 1)
        showSettings = false
        // (after the finger that tapped it is lifted, so that touch doesn't wake it straight away)
        main.postDelayed({ sleepUntil = c.timeInMillis; idle = true }, 600)
    }

    // ---- http ----
    /** The bridge's address (for Devices.kt and House.kt). */
    val bridgeUrl: String get() = bridge
    private fun get(path: String, base: String = bridge): String = BridgeClient.getText(base + path)
    fun post(path: String, body: JSONObject = JSONObject()): String? = BridgeClient.post(bridge + path, body.toString())
    internal fun postAsync(path: String, body: JSONObject = JSONObject()) = scope.launch { post(path, body) }

    private val iso = ThreadLocal.withInitial { SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") } }
    private fun time(s: String?): Long = s?.let { runCatching { iso.get()!!.parse(it)!!.time }.getOrNull() } ?: 0L
    private fun JSONObject.s(k: String) = optString(k).takeIf { has(k) && !isNull(k) && it.isNotEmpty() }
    private fun <T> JSONArray?.map(f: (JSONObject) -> T?): List<T> = this?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(f) } } ?: emptyList()

    /** The weather where the family lives (the bridge asks Open-Meteo), for the home screen's weather card. */
    var weather by mutableStateOf<Weather?>(null); private set
    /** The weather, full screen (tap the weather card). */
    var showWeather by mutableStateOf(false)
    private fun loadWeather() {
        val j = runCatching { JSONObject(get("/weather")) }.getOrNull() ?: return
        fun JSONObject.intOrNull(k: String) = if (has(k) && !isNull(k)) optInt(k) else null
        if (j.has("temp")) ui { weather = Weather(j.optString("place"), j.optInt("temp"), j.optInt("code"), j.optString("condition"), j.optBoolean("isDay", true), j.optInt("high"), j.optInt("low"),
            j.intOrNull("feels"), j.intOrNull("humidity"), j.intOrNull("wind"), j.s("sunrise"), j.s("sunset"),
            j.optJSONArray("hours").map { WeatherHour(it.optString("time"), it.optInt("temp"), it.optInt("code"), it.optBoolean("isDay", true), it.intOrNull("rain")) },
            j.optJSONArray("days").map { WeatherDay(it.optString("date"), it.optInt("high"), it.optInt("low"), it.optInt("code"), it.optString("condition"), it.intOrNull("rain")) }) }
    }
    private fun loadBoard() {
        val j = runCatching { JSONObject(get("/board")) }.getOrNull() ?: return
        val a = j.optJSONObject("assistant")
        val family = j.optJSONArray("family").map { it }.mapIndexed { i, p -> Person(p.optString("name"), p.optString("note"), Oh.people[i % Oh.people.size]) }
        val data = BoardData(
            headline = a?.s("headline"), weather = a?.s("weather"), updatedAt = a?.optLong("at")?.takeIf { it > 0 },
            curating = j.optBoolean("curating"), error = j.s("error"),
            family = family,
            events = j.optJSONArray("events").map { CalEvent(it.optString("who"), it.optString("title"), time(it.s("start")), it.s("bring")) },
            chores = j.optJSONArray("chores").map { Chore(it.optString("who"), it.optString("task")) },
        )
        ui { board = data }
    }
    private fun loadApps() {
        val a = runCatching { JSONArray(get("/apps")) }.getOrNull() ?: return
        val all = a.map { AppInfo(it.optString("id"), it.optJSONObject("meta")?.s("name") ?: it.optString("id"), it.optJSONObject("meta")?.s("emoji") ?: "", it.s("icon"), it.optJSONObject("meta")?.optBoolean("screensaver") == true) }
        // Plus Android apps added through Aurora Store (newest first; the sticker shows its icon).
        val added = dev.openhouse.shell.AppStore.homeApps().take(3).map { (pkg, label) -> AppInfo("android:$pkg", label, "") }
        val web = a.map { it.optBoolean("web", true) }
        val list = all.filterIndexed { i, _ -> web[i] } // an app from before apps were web pages: not on the home screen, but its window stays (AppStubs)
        ui { apps = added + list.filter { it.id != "home" } }
        // Each app is also an installed Android app (its own icon, task and back gesture): see AppStubs.
        dev.openhouse.shell.AppStubs.sync(all.map { dev.openhouse.shell.AppStubs.Spec(it.id, it.name, stickerColor(it.id), it.icon) })
    }
    /** An app's sticker color (also its launcher icon's). */
    fun stickerColor(id: String): Int = PaperLook.magnets[(id.hashCode() and 0xff) % PaperLook.magnets.size].toArgb()
    fun appsChanged() { scope.launch { loadApps() } }
    internal fun loadVoiceStatus(): VoiceStatus? {
        val j = runCatching { JSONObject(get("/voice/status")) }.getOrNull() ?: return null
        val v = VoiceStatus(j.optBoolean("ready"), j.optBoolean("listening"), j.s("error"),
            j.optJSONArray("wake")?.let { a -> (0 until a.length()).map { a.optString(it) } }?.ifEmpty { null } ?: listOf("hey opie"), j.optBoolean("wakeOn", false))
        val log = j.optBoolean("log", false); val rec = j.optBoolean("recording", false)
        ui { voice = v; speechLog = log; if (!rec) recordingUntil = 0 else if (recordingUntil == 0L) recordingUntil = Long.MAX_VALUE }
        return v
    }

    // ---- the board's actions ----
    /** Ask the assistant to look at the day again now (its notes on the home screen, the headline). */
    fun refresh() { board = board?.copy(curating = true); postAsync("/board/refresh") }
    fun dismissAnswer() { answer = null; stopSpeaking() }

    // ---- the home screen ----
    fun openNote(id: String) { touch(); fullNote = id; postAsync("/home/touch", JSONObject().put("id", id)) }
    fun closeNote() { fullNote = null }
    /** Take a note down (it goes in the trash, so it can be put back). */
    fun takeDown(id: String) { trash(id) }
    fun keepNote(id: String, keep: Boolean = true) { homeScreen = homeScreen?.let { d -> d.copy(notes = d.notes.map { if (it.id == id) it.copy(keep = keep, until = if (keep) null else it.until) else it }) }; postAsync("/home/keep", JSONObject().put("id", id).put("keep", keep)) }
    fun note(id: String?) = homeScreen?.notes?.firstOrNull { it.id == id }
    /** The last thing taken off the home screen, and when (Settings, Off the home screen, puts it back). */
    var trashed by mutableStateOf<Pair<String, Long>?>(null); private set
    private val trashedTimers = mutableMapOf<String, TimerInfo>()

    /**
     * Take something off the home screen, the same for everything: a note (kept a while in the trash), a timer (stopped),
     * or anything else (the clock, the weather, an app: hidden). Settings (Off the home screen) or the assistant (put_back)
     * puts it back. (On the home screen itself, the page does this: dropping on its trash.)
     */
    fun trash(key: String) {
        touch()
        when {
            key.startsWith("timer:") -> timers.firstOrNull { "timer:${it.endAt}" == key }?.let { t -> trashedTimers[key] = t; host.cancelTimer(t.id) }
            note(key) != null -> {
                homeScreen = homeScreen?.let { d -> val n = d.notes.first { it.id == key }; d.copy(notes = d.notes - n, trash = listOf(TrashedNote(n.id, n.title)) + d.trash.filter { it.id != key }) }
                if (fullNote == key) fullNote = null
                postAsync("/home/remove", JSONObject().put("id", key))
            }
            else -> {
                homeScreen = homeScreen?.let { d -> d.copy(places = d.places + (key to (d.places[key] ?: Place()).copy(hidden = true))) }
                postAsync("/home/place", JSONObject().put("key", key).put("hidden", true))
            }
        }
        trashed = key to System.currentTimeMillis()
    }
    /** Put back something that was dropped on the trash, where it was. */
    fun putBack(key: String) {
        touch()
        if (trashed?.first == key) trashed = null
        if (key.startsWith("timer:")) { trashedTimers.remove(key)?.takeIf { it.endAt > System.currentTimeMillis() }?.let { t -> host.restoreTimer(t.label, t.total, t.endAt) }; return }
        homeScreen = homeScreen?.let { d -> d.places[key]?.let { p -> d.copy(places = d.places + (key to p.copy(hidden = false))) } ?: d } // a note comes back with the home screen's next update
        postAsync("/home/putback", JSONObject().put("key", key))
    }
    /** Delete an app or game the family made ("undo" brings it back). From Settings → Off the home screen, after asking. */
    var confirmDelete by mutableStateOf<AppInfo?>(null)
    fun deleteApp(a: AppInfo) {
        confirmDelete = null
        apps = apps.filter { it.id != a.id }
        scope.launch { post("/apps/delete", JSONObject().put("id", a.id).put("who", me?.name)); loadApps() }
    }
    private fun parseHomeScreen(j: JSONObject) = HomeData(
        j.optJSONObject("grid")?.optInt("cols") ?: 8, j.optJSONObject("grid")?.optInt("rows") ?: 5,
        j.optJSONArray("reserved").map { HomeCell(it.optInt("x"), it.optInt("y"), it.optInt("w", 1), it.optInt("h", 1), it.optString("what")) },
        j.optJSONArray("notes").map { n -> HomeNote(n.optString("id"), n.optString("title"), n.optString("content"), n.optString("size", "wide"), n.s("paper"), n.s("color"), n.s("for"),
            n.optBoolean("keep"), n.optLong("until").takeIf { it > 0 }, n.optString("by"), n.s("conversation"), n.optLong("at"), n.int("page"), n.int("col"), n.int("row"), n.optBoolean("refitting")) },
        j.optInt("v"),
        j.optJSONObject("places")?.let { o -> o.keys().asSequence().associateWith { k -> o.optJSONObject(k).let { Place(it.optInt("page"), it.int("col"), it.int("row"), it.int("w"), it.int("h"), it.optBoolean("hidden")) } } } ?: emptyMap(),
        j.optJSONArray("trash").map { TrashedNote(it.optString("id"), it.optString("title")) },
        j.optJSONObject("widgets")?.optJSONObject("native")?.let { o -> o.keys().asSequence().associateWith { o.optString(it) } } ?: emptyMap(),
        j.optJSONObject("widgets")?.optJSONObject("content")?.let { o -> o.keys().asSequence().associateWith { k -> o.optJSONObject(k).let { w ->
            AppWidget(w.s("content"), w.optJSONObject("shapes")?.let { sh -> sh.keys().asSequence().associateWith { sh.optString(it) } } ?: emptyMap()) } } } ?: emptyMap())
    private fun JSONObject.int(k: String) = if (has(k) && !isNull(k)) optInt(k) else null
    /** Waits for the home screen to change (the bridge answers when it does), so notes appear the moment they go up. */
    private suspend fun homeEvents() {
        var v = -1
        while (true) {
            val j = runCatching { JSONObject(BridgeClient.getText(bridge + "/home/wait?v=$v", readMs = 40_000)) }.getOrNull()
            if (j == null) { delay(3000); continue }
            val d = parseHomeScreen(j); v = d.v
            appInUseUntil = j.optJSONObject("handsFree")?.optLong("until", 0L) ?: 0L
            // Opie opened a tab or an app ("find a bolognese" shows Recipes): a resting screen wakes, so it's seen.
            j.optJSONObject("show")?.optLong("at", 0L)?.let { at -> if (at > shownAt) { val fresh = shownAt > 0L && System.currentTimeMillis() - at < 30_000; shownAt = at; if (fresh) ui { touch() } } }
            j.optJSONArray("timers")?.let { a -> runCatching { host.syncTimers((0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { TimerInfo(0, it.optString("label"), it.optInt("total"), it.optLong("endAt"), false) }) } }
            ui { homeScreen = d; if (fullNote != null && d.notes.none { it.id == fullNote }) fullNote = null }
        }
    }

    // ---- apps ----
    fun openApp(id: String) = host.openApp(id)
    /** The app on screen (not the board), or null. */
    internal val openAppId: String? get() = host.openAppId
    /** An app or game is open over the home screen (set by the shell; observable, so the overlay redraws: the assistant tucks away). */
    var appOpen by mutableStateOf(false)
    /** Change the app that's open ("make the stars bigger"): the agent edits that app. */
    fun changeApp(text: String, appId: String, context: String? = null) = Turns.changeApp(text, appId, context)
    /** The shell: an app crashed. The next request about it carries the crash, so "fix it" works. */
    fun appCrashed(id: String, msg: String) { Turns.crashes[id] = msg; heard = Heard(null, "That app crashed. Say “fix it” and it will be repaired.", System.currentTimeMillis()) }

    // ---- conversations ----
    fun openConversation(id: String?) {
        touch(); showConversation = true; conversation = Conversation(id, emptyList())
        scope.launch { loadConversations(); if (id != null) loadConversation(id) }
    }
    /** Read a saved conversation into the screen (the notes its answers put up, as they were then). */
    internal fun loadConversation(id: String) {
        runCatching { JSONObject(get("/chats/$id")) }.getOrNull()?.let { c ->
            val turns = c.optJSONArray("turns").map { t ->
                Turn(t.optString("role"), t.optString("text"), t.s("who"), notes = t.optJSONArray("notes").map { TurnNote(it.optString("id"), it.optString("title"), it.optString("content")) })
            }
            ui { if (conversation?.id == id) conversation = Conversation(id, turns) }
        }
    }
    fun newConversation() { if (conversation?.turns?.lastOrNull()?.live != true) conversation = Conversation(null, emptyList()) }
    fun closeConversation() { showConversation = false; onboarding = false; scope.launch { loadHousehold()?.let { h -> ui { householdSetUp = h.optBoolean("setup", true) } } } }
    internal fun loadConversations() {
        val a = runCatching { JSONArray(get("/chats")) }.getOrNull() ?: return
        val list = a.map { ConversationInfo(it.optString("id"), it.optString("title"), it.optLong("updated"), it.s("who")) }
        ui { conversations = list }
    }
    /** Ask in the open conversation (typed or spoken there). */
    fun sayInConversation(text: String, voice: Boolean = false) = Turns.sayInConversation(text, voice)
    /** "Stick it on the home screen": an answer from the conversation goes on the home screen as a kept note. */
    fun pinFromConversation(question: String, answer: String) {
        val id = conversation?.id
        scope.launch { post("/board/pin", JSONObject().put("title", question).put("text", answer).put("conversation", id).put("who", me?.name)) }
    }

    // ---- asking ----
    /** Everything in flight: each question it's answering or working on, including ones moved to the background. */
    var inFlight by mutableStateOf(listOf<InFlight>()); internal set
    /** The jobs list (tap the note while it works). */
    var showJobs by mutableStateOf(false)
    /** Something it heard but decided wasn't for it (shown briefly, crossed out, so nothing is silently dropped). */
    var ignored by mutableStateOf<Heard?>(null); internal set
    fun ask(text: String, who: String?, voice: Boolean = false) = Turns.ask(text, who, voice)
    fun send(text: String) = ask(text, me?.name)
    /** "Undo that": put back the latest change the agent made. */
    fun undo(voice: Boolean = false) = Turns.undo(voice)
    /** Stop the answer on screen. */
    fun stopAnswer() = Turns.stopAnswer()
    /** Stop one thing it's working on. */
    fun stopJob(id: Long) = Turns.stopJob(id)
    /** Stop the app build running in the background (the bridge puts the code back as it was). */
    fun cancelBuild() { vlog("stop-job", build?.request); postAsync("/cancel") }
    fun cancelTimer(id: Int) = host.cancelTimer(id)
    /** What the display decided about speech (the bridge's speech log, if it's on). */
    internal fun vlog(event: String, text: String? = null, who: String? = null) = postAsync("/voice/log", JSONObject().put("event", event).put("text", text).put("who", who))

    // AnswerActions: what generated UI can do.
    override fun ask(text: String) = ask(text, me?.name)
    override fun startTimer(label: String, seconds: Int) = host.startTimer(label, seconds)
    override fun makeApp(request: String) { host.makeApp(request, answer?.let { "Family: ${it.question}\n\nAssistant: ${it.text}" } ?: ""); answer = null }
    override fun playVideo(url: String, title: String) = host.playVideo(url, title)

    // ---- speaking (Speech.kt) ----
    /** The voice it speaks with, chosen in Settings (kept on the device); null picks the best US English one. */
    var voiceName by mutableStateOf<String?>(null); internal set
    /** The English voices it can use without the internet, for the picker. */
    var speechVoices by mutableStateOf<List<SpeechVoice>>(emptyList()); internal set
    /** Speak a sample in this voice, and use it from now on. */
    fun chooseVoice(name: String) = Speech.chooseVoice(name)
    /** Say this aloud a moment from now, a sentence at a time, as the answer to a spoken request is (a test from adb: ConfigReceiver). Nothing to say: stop talking. */
    fun sayAloud(text: String) = if (text.isBlank()) ui { Speech.stop() } /* (nothing: cut it off, as when it's talked over) */ else ui { Speech.hushed = false; Speech.waitingSince = System.currentTimeMillis(); main.postDelayed({ Answers.sentences(text, true).forEach { Speech.say(it, null) } }, 1500) }
    fun stopSpeaking() = Speech.stop()

    // ---- voice and typing (Listening.kt) ----
    /** When someone last tapped it quiet: what it heard or said before then is put away at once. */
    var quietAt by mutableStateOf(0L); internal set
    /** A tap on the note (see Listening.tapToTalk). */
    fun tapToTalk() = Listening.tapToTalk() // (with the assistant off, the bridge says how to turn it on)
    fun dictate() = Listening.dictate()
    /** Typing: nothing listens for speech while the box is open (only its own mic, or the wake word, starts that). */
    fun openTyping(note: String = "", seed: String = "") { touch(); awaitingUntil = 0; handsFreeUntil = 0; draft = seed; typing = note; Listening.arm(0, "typing") }
    /** Keys typed before the typing box has focus (the first one opens it): kept, so nothing is lost. */
    var typingFocused = false
    /** A key typed on a keyboard while the typing box is closed (the shell routes these here). */
    fun typed(ch: String) { if (typing == null && (setupStep != null || showWelcome)) return; if (typing == null) { typingFocused = false; openTyping(seed = ch) } else draft += ch }
    fun closeTyping() { if (dictating) Listening.dictate(); typing = null; draft = "" }
    /** The typing box's text changed on screen (the on-screen keyboard). */
    fun editDraft(text: String) { draft = text }
    /**
     * A keyboard key for the assistant, wherever it was pressed (on the display, over an app or game, or over
     * another app): with the typing box open it types there; while it's listening, the first letter opens the box
     * (and it stops listening). True: the key was used.
     */
    fun typeKey(e: android.view.KeyEvent): Boolean {
        val t = System.currentTimeMillis()
        val listening = awaitingUntil > t // just tapped or the AI key (not the follow-up window: then they may be typing into an app)
        if (typing == null && !listening) return false
        val down = e.action == android.view.KeyEvent.ACTION_DOWN
        when (e.keyCode) {
            android.view.KeyEvent.KEYCODE_ESCAPE -> { if (typing == null) return false; if (down) closeTyping(); return true }
            android.view.KeyEvent.KEYCODE_DEL -> { if (typing == null) return false; if (down) draft = if (e.isCtrlPressed || e.isAltPressed) draft.trimEnd().substringBeforeLast(' ', "") else draft.dropLast(1); return true }
            android.view.KeyEvent.KEYCODE_ENTER, android.view.KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (typing == null) return false
                if (down) { val q = draft.trim(); if (q.isNotEmpty()) send(q) } // while it answers, it's the next thing to do
                return true
            }
        }
        if (e.isCtrlPressed || e.isMetaPressed || e.isAltPressed) return false
        val c = e.unicodeChar
        if (c <= 0 || (c == ' '.code && typing == null)) return false
        if (down) { if (typing == null) { typingFocused = false; openTyping(seed = c.toChar().toString()); Listening.arm(0, "tap") } else draft += c.toChar() }
        return true
    }
}
