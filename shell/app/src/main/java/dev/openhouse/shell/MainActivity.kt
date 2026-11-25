package dev.openhouse.shell

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The display: the fixed shell, which the agent never edits. Layers, bottom to top:
 *  - the home screen (HomeView: the bridge's home screen page, the same one other screens show);
 *  - the family's apps opened inside the display (AppHost; usually they open as their own Android apps instead);
 *  - the overlay (ui/Overlay.kt: the assistant's note, what it hears, typing, sheets);
 *  - the first-time setup screen, and the timers' pills (shown over apps).
 * It also starts the runtime (Runtime: the bridge, the dev server for the family's apps, the agent) and the watchdog that keeps it running (Watchdog: one per process, not per activity), sets the tablet
 * up as a kiosk (DeviceOwner) and holds the shell's rows of Settings and the optional lock (SettingsLock).
 */
class MainActivity : androidx.activity.ComponentActivity() { // ComponentActivity: Compose views need its lifecycle owners
    internal lateinit var root: FrameLayout
    private lateinit var setupLayer: FrameLayout
    private lateinit var setupText: TextView
    private lateinit var setupNote: TextView
    private lateinit var setupBar: android.widget.ProgressBar

    /** First run: one step and one bar ("Getting Opie ready"), the name in the corner, nothing technical. */
    private fun buildSetupLayer() {
        val C = dev.openhouse.ui.Calm
        setupLayer.addView(C.wordmark(this), FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { leftMargin = C.px(this@MainActivity, 56); topMargin = C.px(this@MainActivity, 44) })
        setupText = C.display(this, "Getting Opie ready")
        setupNote = C.lead(this, "This takes a few minutes. Keep the tablet plugged in and on Wi-Fi.")
        setupBar = android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100; isIndeterminate = false
            progressDrawable = android.graphics.drawable.LayerDrawable(arrayOf(
                C.rounded(C.TINT2, 99f),
                android.graphics.drawable.ClipDrawable(C.rounded(C.INK, 99f), Gravity.START, android.graphics.drawable.ClipDrawable.HORIZONTAL),
            )).apply { setId(0, android.R.id.background); setId(1, android.R.id.progress) }
        }
        val col = C.column(this).apply {
            addView(setupText)
            addView(setupNote, android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = C.px(this@MainActivity, 14) })
            addView(setupBar, android.widget.LinearLayout.LayoutParams(-1, C.px(this@MainActivity, 8)).apply { topMargin = C.px(this@MainActivity, 48) })
        }
        setupLayer.addView(col, FrameLayout.LayoutParams(C.px(this, 900), -2, Gravity.CENTER))
    }
    private val main = Handler(Looper.getMainLooper())
    /**
     * The dev server (the family's apps and games) and the bridge: on this tablet in a release (a tablet set up from
     * a QR code has nothing else to go on); a debug build on an emulator talks to the computer's (10.0.2.2) until adb
     * sets them (ConfigReceiver, tablet-setup.sh).
     */
    private var uiUrl = if (BuildConfig.DEBUG) "http://10.0.2.2:5173/" else "http://127.0.0.1:5173/"
    internal var bridge = DEFAULT_BRIDGE
    // The microphone, streamed to the bridge on this device. Audio source MIC: on the Tab S10 FE it was
    // ~40x louder than VOICE_COMMUNICATION and ~2x VOICE_RECOGNITION, and caught the wake words.
    // ConfigReceiver's `mic` overrides it (see Voice.kt for the level log).
    /** The tablet's own listening, paused while OpenAI's live voice has the microphone (LiveVoice). */
    internal fun micPaused(on: Boolean) { voice.paused = on }
    /** Pause the tablet's own listening and wait (off the main thread) until its microphone is let go. */
    internal fun micReleased(ms: Long) = voice.pauseAndRelease(ms)
    /** The tablet's own listening has the microphone now (so what's said can be kept from this moment: LiveVoice). */
    internal fun micHeld() = voice.holding && !voice.paused
    internal fun micRecent(ms: Int) = voice.recent(ms)
    internal fun micTap(f: ((ByteArray, Int) -> Unit)?) { voice.tap = f }
    private val voice = Voice({ bridge }, { getSharedPreferences("shell", MODE_PRIVATE).getInt("mic", MediaRecorder.AudioSource.MIC) }, {
        // While the bridge cancels echo: the source with nothing done to the sound, where the device has one (the plain
        // microphone source may still have the maker's noise suppression in it); else the one for voice recognition,
        // which Android requires to be free of gain control and noise suppression. `--ei micPlain N` (adb) overrides.
        getSharedPreferences("shell", MODE_PRIVATE).getInt("micPlain", -1).takeIf { it >= 0 }
            ?: if ((getSystemService(AUDIO_SERVICE) as android.media.AudioManager).getProperty(android.media.AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true") MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.VOICE_RECOGNITION
    })
    // On by default, except on the emulator, where opening the Mac's microphone hangs it (test there
    // by feeding recordings to /voice/utterance instead).
    internal val listenOn get() = listenOn(this)
    private lateinit var timers: Timers
    private lateinit var home: HomeView
    private lateinit var apps: AppHost
    private lateinit var overlay: androidx.compose.ui.platform.ComposeView
    internal val lock by lazy { SettingsLock(this) }
    /** The system's folder picker for a backup USB drive (BackupDrive): registered here so its answer survives a recreate. */
    internal val drivePicker = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) { BackupDrive.picked(this, it) }
    private var kioskPaused = false // someone left kiosk; resumes when the display is reopened

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PinPrompt.watchScreen(this) // the PIN's two-minute grace ends when the screen sleeps
        // Moving to Opie's IDs (Move.kt): the new display takes over first; the old one, once it has handed over,
        // only steps aside.
        if (Move.takeOverNeeded(this)) { startActivity(Intent(this, MoveActivity::class.java)); finish(); return }
        if (Move.handedOver(this)) { Move.stepAside(this); finish(); return }
        // Any app can start this activity, so it takes no settings from its intent: the servers, microphone and
        // PIN come from adb only (ConfigReceiver).
        val prefs = getSharedPreferences("shell", MODE_PRIVATE)
        watchNetwork()
        prefs.getString("ui", null)?.let { uiUrl = it }
        prefs.getString("bridge", null)?.let { bridge = it }
        live = this
        dev.openhouse.ui.BridgeClient.token = BridgeToken.get(this) // every request to the bridge carries it
        Runtime.init(this)
        CalendarAccounts.init(this) // two-way calendars: the sign-ins (the bridge syncs, through DeviceServer)
        CalendarLinks.start(this) { bridge } // the family's calendar links: kept by the shell, read every 15 minutes
        PhotoAlbums.start(this) { bridge }
        MailAccount.start(this) { bridge } // the household's own mailbox (Settings → Email), looked at every 2 minutes once set
        PhotoShare.start(this) // the household's lasting photo page for phones, when someone turned it on // shared albums (iCloud): kept by the shell like the calendars, read every 30 minutes
        BackupDrive.start(this) // the USB drive for backups, for the bridge (only once someone picks one)
        CloudHealth.start(this) { bridge } // health check-ins, only once the tablet is linked (Settings → Account)
        GalleryDrawings.copyOnce(this) { bridge } // the old Drawing app's pictures into the family's photos, once
        AppStubs.init(this)
        DeviceServer.bind(this) // kiosk setup asks which apps lead out of kiosk (KioskApps), before the server starts
        DeviceOwner.setUp(this)
        HostApp.ensure(this) // the update cover, from this APK, when the tablet hasn't got it (set up from the QR code)
        DeviceOwner.enableDeviceControl(this)
        DeviceOwner.keepAlive(this)
        DeviceServer.start(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        root = FrameLayout(this)
        LiveVoice.install(this) // OpenAI's live voice, when the family chose it
        LiveVoice.onChosen = { liveChanged() }
        home = HomeView(this, { uiUrl }) { bridge }
        Runtime.setSafeMode(safeMode)
        root.addView(home.layer, FrameLayout.LayoutParams(-1, -1))
        dev.openhouse.ui.Openhouse.start(OpenhouseHost())
        apps = AppHost(this, { bridge }, { uiUrl })
        root.addView(apps.layer, FrameLayout.LayoutParams(-1, -1))
        // Over the board and apps: the overlay (the assistant's note, what it hears, typing, the agent at work,
        // conversations, settings).
        overlay = androidx.compose.ui.platform.ComposeView(this).apply { setContent { dev.openhouse.ui.ShellOverlay() } }
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        setupLayer = FrameLayout(this).apply { setBackgroundColor(dev.openhouse.ui.Calm.SHEET); visibility = View.GONE; isClickable = true }
        buildSetupLayer()
        root.addView(setupLayer, FrameLayout.LayoutParams(-1, -1))
        timers = Timers(this, root)
        mirrorTimers()
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) { override fun handleOnBackPressed() = back() })
        immersive()
        startServices()

        home.layer.visibility = View.VISIBLE; home.start()
        timers.showPills(false) // the home screen draws the timers itself; the pills are for over apps
        Watchdog.start(this) // once per process: an activity recreated keeps the one that's running

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        else startVoice()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (Manifest.permission.RECORD_AUDIO in perms) startVoice()
    }

    /** ConfigReceiver (adb) changed the settings. */
    fun configChanged() = main.post {
        val prefs = getSharedPreferences("shell", MODE_PRIVATE)
        prefs.getString("ui", null)?.let { uiUrl = it }
        prefs.getString("bridge", null)?.let { bridge = it }
        voice.restart()
    }

    /** The microphone runs only while it's switched on and the live voice is on: without the live voice nothing would
     *  hear the request, so nothing listens for the name either (the user, 2026-11-20: "Why wake word with no live voice?"). */
    internal fun micWanted() = micWanted(this)
    private fun startVoice() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        voice.enabled = micWanted()
        voice.start()
    }
    /** The live voice went on or off: the microphone follows, and the wake model comes if this display has none yet. */
    private fun liveChanged() = main.post {
        voice.enabled = micWanted()
        if (micWanted()) { startVoice(); VoiceModels.ensure(this, bridge, now = true) }
    }
    /** The microphone (Settings, Hey Opie, with the wake word). */
    internal fun setListening(on: Boolean) {
        getSharedPreferences("shell", MODE_PRIVATE).edit().putBoolean("listen", on).apply()
        voice.enabled = micWanted()
        if (!on) LiveVoice.stopNow()
        if (micWanted()) { startVoice(); VoiceModels.ensure(this, bridge, now = true) } // the models, if this display has none yet
    }

    // --- the runtime (the bridge, the dev server, the agent) -------------------------------------
    private var settingUp = false
    private fun onDevice() = onDevice(bridge)

    /** Start whatever of the runtime isn't running (idempotent); the first time, set it up (Watchdog asks too). */
    internal fun startServices() {
        if (!onDevice()) return
        if (Runtime.ready()) { Runtime.startServices(); return }
        firstTimeSetup(getSharedPreferences("shell", MODE_PRIVATE).getString("runtime_url", null))
    }

    /** First boot without the bundled runtime unpacked: fetch and unpack it. */
    private fun firstTimeSetup(image: String?) {
        if (settingUp) return
        settingUp = true
        setupLayer.visibility = View.VISIBLE; setupLayer.bringToFront()
        if (image == null) { setupText.text = "This tablet isn't set up yet"; setupNote.text = "Set it up again from opie.house/setup."; setupBar.visibility = View.GONE; settingUp = false; return }
        setupText.text = "Getting Opie ready"; setupNote.text = "This takes a few minutes. Keep the tablet plugged in and on Wi-Fi."; setupBar.visibility = View.VISIBLE
        thread(name = "setup") {
            val ok = Runtime.setup(image, { pct -> main.post { setupBar.progress = pct } }) { why ->
                Log.w("Setup", "runtime: $why"); main.post { setupText.text = "Still getting ready"; setupNote.text = "Check the Wi-Fi. It tries again in half a minute." }
            }
            main.post {
                settingUp = false
                if (ok) { setupLayer.visibility = View.GONE; Runtime.startServices() }
                else main.postDelayed({ startServices() }, 30000) // try again
            }
        }
    }

    /**
     * Each watchdog tick (Watchdog: the servers, updates and the move run there, once per process), on the main thread:
     * what only the display's window can do.
     */
    internal fun watchTick(moving: Boolean) {
        if (isFinishing || isDestroyed) return
        if (Move.toPkg != null) Move.offer(this) // under the old ID: open the new display once it's installed
        if (moving) return
        // Just moved: the display can come to the front a moment before the tablet is handed to it, too early for kiosk
        // mode (onResume); for the first minutes after, it goes into kiosk mode once it's the owner.
        if (Move.fromPkg != null && !kioskPaused && hasWindowFocus() &&
            System.currentTimeMillis() - Move.prefs(this).getLong("owner_at", 0L) < 10 * 60_000L &&
            getSystemService(android.app.ActivityManager::class.java).lockTaskModeState == android.app.ActivityManager.LOCK_TASK_MODE_NONE)
            DeviceOwner.enterKiosk(this, false)
    }

    // --- kiosk and the lock -------------------------------------------------------------------
    internal fun leaveKiosk() { kioskPaused = true; DeviceOwner.leaveKiosk(this) }
    /** "Add a calendar" from the Calendar app (or anywhere): behind the PIN when the lock is on, then the paste box. */
    internal fun addCalendar() = CalendarAccounts.choose(this, ::immersive) // Google, iCloud, or a link: no PIN (adding one is everyday; removing one stays behind it)
    /** A calendar link from the computer or the assistant (DeviceServer /calendar): the tablet's card, a person's yes, no PIN. */
    internal fun offerCalendar(who: String, url: String, from: String, done: (Boolean) -> Unit, trusted: Boolean = false, name: String = "", only: String = "") =
        // From the setup's own phone or computer, with the lock off: in at once (it was set up from there a moment ago).
        if (trusted) thread { CalendarLinks.add(who, url, name, only); CalendarLinks.sync(); main.post { done(true) } }
        else CalendarLinks.offer(this, { ok -> ok() }, who, url, from, ::immersive, done, name, only)
    /** "Add an iCloud album" from the Photos app: behind the PIN when the lock is on, then the paste box. */
    internal fun addAlbum() = lock.withPin { PhotoAlbums.add(this, ::immersive) }
    /** "Photos from phones, any time": behind the PIN when the lock is on, the lasting link's QR code (PhotoShare). */
    internal fun sharePhotos() = lock.withPin { PhotoShare.show(this, ::immersive) }
    /** "Add photos from Google": behind the PIN when the lock is on, the phone page for Google Photos' picker (GooglePhotos). */
    internal fun googlePhotos() = lock.withPin { GooglePhotos.show(this, ::immersive) }
    /** An album link from the computer or the assistant (DeviceServer /album): the tablet's card, then the PIN. */
    /** A linked album taken off, from the Photos app (it asked first): behind the PIN when the lock is on. */
    internal fun stopAlbum(id: String) = lock.withPin { thread { PhotoAlbums.remove(id) } }
    internal fun offerAlbum(url: String, from: String, done: (Boolean) -> Unit, trusted: Boolean = false) =
        if (trusted && !lock.on) thread { PhotoAlbums.add(url); PhotoAlbums.sync(); main.post { done(true) } }
        else PhotoAlbums.offer(this, { ok -> lock.withPin(ok = ok) }, url, from, ::immersive, done)
    /** Out of kiosk until the display is opened again from its icon (the tablet's own home screen meanwhile). */
    internal fun leaveKioskForGood() { kioskPaused = true; DeviceOwner.leaveForGood(this) }
    internal val safeMode get() = getSharedPreferences("shell", MODE_PRIVATE).getBoolean("safe_mode", false)
    /** Safe mode: no agent (the bridge reads display/safe-mode). */
    internal fun setSafeMode(on: Boolean) {
        getSharedPreferences("shell", MODE_PRIVATE).edit().putBoolean("safe_mode", on).apply()
        Runtime.setSafeMode(on)
        if (on) thread { dev.openhouse.ui.BridgeClient.post("$bridge/cancel") }
    }
    internal fun reloadHome(first: Boolean = false) = home.reload(first)
    internal fun toast(t: String) = android.widget.Toast.makeText(this, t, android.widget.Toast.LENGTH_SHORT).show()

    override fun onResume() {
        super.onResume(); DeviceOwner.enterKiosk(this, kioskPaused); apps.stubAppId = null; AppStubs.front = null // back from an app's own window
        KioskApps.revokeTemporary() // Settings or a store opened with a yes: not reachable from kiosk any more
        Buddy.covering = false // an update that didn't happen (the display is still this one)
    }
    // Another app in front (the agent at work, the Play Store...): the assistant floats over it instead.
    override fun onStart() { super.onStart(); Buddy.activityStarted() }
    override fun onStop() { Buddy.activityStopped(); super.onStop() }

    override fun onNewIntent(intent: Intent) { // Home pressed while someone was out: back to kiosk
        super.onNewIntent(intent); kioskPaused = false; DeviceOwner.enterKiosk(this, false)
        // e.g. `am start ... --es app star-basket`: a family app only (any app can send this intent).
        val open = intent.getStringExtra("app")?.takeIf { Regex("[a-z0-9][a-z0-9-]{0,60}").matches(it) }
        if (open != null) openApp(open)
        else if (apps.appId != null) closeApp() // Home always means the family screen
        // The Calendar app's "Add a calendar", from its own window (AppWindow): the PIN, then the paste box. Any app can
        // send this intent; all it can do is ask for the PIN.
        if (intent.getBooleanExtra("add_calendar", false)) addCalendar()
        if (intent.getBooleanExtra("add_album", false)) addAlbum()
        if (intent.getBooleanExtra("share_photos", false)) sharePhotos()
        if (intent.getBooleanExtra("google_photos", false)) googlePhotos()
        intent.getStringExtra("stop_album")?.let { stopAlbum(it) }
    }

    internal fun immersive() {
        window.setDecorFitsSystemWindows(false)
        window.insetsController?.apply {
            hide(WindowInsets.Type.systemBars())
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    /** The key that woke the screen: its release is swallowed too. */
    private var wakeKey: Int? = null

    /** A keyboard (the tablet's keyboard cover) types into the board, whatever was tapped last. */
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        val o = dev.openhouse.ui.Openhouse
        val fields = o.showFamily || o.setupStep != null // these sheets have their own text fields
        val onBoard = (apps.appId == null || o.showConversation) && !fields
        if (event.action == android.view.KeyEvent.ACTION_DOWN && !event.isPrintingKey) Log.d("Keys", "key ${event.keyCode} ${android.view.KeyEvent.keyCodeToString(event.keyCode)} scan ${event.scanCode}")
        // A key wakes it as a touch does (asleep, the night's dark or the photos): that key only wakes it, as a tap
        // on a sleeping screen does. The volume keys still turn the volume.
        val volume = event.keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN
        if (event.action == android.view.KeyEvent.ACTION_DOWN) {
            val asleep = o.idle
            o.touch()
            if (asleep && !volume) { wakeKey = event.keyCode; return true }
        } else if (event.action == android.view.KeyEvent.ACTION_UP && event.keyCode == wakeKey) { wakeKey = null; return true }
        // During OpenAI's live voice the keys turn its loudness too (LiveVoice.volumeKey): the media stream, which it follows.
        if (event.keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) {
            if (event.action == android.view.KeyEvent.ACTION_DOWN && LiveVoice.volumeKey(this, event.keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP)) return true
            if (event.action == android.view.KeyEvent.ACTION_UP && LiveVoice.active) return true
        }
        if (event.keyCode in AI_KEYS) { if (event.action == android.view.KeyEvent.ACTION_UP) o.tapToTalk(); return true } // when device control is off
        // Typing to the assistant (its box is open, or it's listening): over apps and games too, wherever focus is.
        if (!o.showConversation && !fields && !(o.webEditing && o.typing == null) && o.typeKey(event)) return true
        if (onBoard && !o.webEditing && (o.typing == null || !o.typingFocused) && event.action == android.view.KeyEvent.ACTION_DOWN && !event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed) {
            val c = event.unicodeChar
            if (c > ' '.code || (c == ' '.code && o.typing != null)) { o.typed(c.toChar().toString()); return true }
        }
        if (onBoard && o.typing != null && event.keyCode == android.view.KeyEvent.KEYCODE_ESCAPE) { if (event.action == android.view.KeyEvent.ACTION_UP) o.closeTyping(); return true }
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchTouchEvent(ev: android.view.MotionEvent): Boolean {
        if (ev.actionMasked == android.view.MotionEvent.ACTION_DOWN) dev.openhouse.ui.Openhouse.touch()
        return super.dispatchTouchEvent(ev)
    }

    // The house's timers live in the bridge too, so other screens show them and can start or stop them. The shell
    // still rings them. It tells the bridge of its own, starts the ones a screen started, and stops the ones a screen
    // stopped (never bringing back one stopped here).
    private val listedTimers = mutableSetOf<Long>()
    private val stoppedHere = mutableSetOf<Long>()
    private fun mirrorTimers() {
        val o = dev.openhouse.ui.Openhouse
        timers.onStart = { label, total, endAt -> stoppedHere.remove(endAt); thread { o.post("/home/timer", JSONObject().put("start", JSONObject().put("label", label).put("total", total).put("endAt", endAt))) } }
        timers.onStop = { endAt -> stoppedHere += endAt; thread { o.post("/home/timer", JSONObject().put("cancel", endAt)) } }
    }
    private fun syncTimers(list: List<dev.openhouse.ui.TimerInfo>) {
        val ends = list.map { it.endAt }.toSet()
        val now = System.currentTimeMillis()
        for (t in list) {
            listedTimers += t.endAt
            if (!timers.has(t.endAt) && t.endAt !in stoppedHere && t.endAt > now - 60_000) timers.start(t.label, t.total.coerceAtLeast(1), t.endAt, quiet = true)
        }
        for (t in timers.list()) if (t.endAt in listedTimers && t.endAt !in ends) timers.stopped(t.endAt)
    }

    /** What the native board can ask the shell for. */
    inner class OpenhouseHost : dev.openhouse.ui.Host {
        override fun setting(id: String) { main.post { lock.open(id) } }
        override fun settingValues() = lock.values()
        override fun locked() = lock.on
        // Android's Wi-Fi settings leave kiosk mode (Home brings it back), so after the first setup they're behind the
        // same rule as the other ways out (SettingsLock.withPinSet). Before it (no household saved yet: the welcome
        // screen's Join Wi-Fi, a tablet arriving from elsewhere), there's no PIN to ask for and they open as they are.
        // Joining a network needs no PIN: after the first setup it's Opie's own Join Wi-Fi (WifiJoin), whose Wi-Fi
        // settings button (saved networks, forgetting one) is under the rule.
        override fun wifi() {
            thread {
                val firstSetup = runCatching { !JSONObject(dev.openhouse.ui.BridgeClient.getText("$bridge/household", 1500, 3000)).optBoolean("setup", true) }
                    .getOrDefault(dev.openhouse.ui.Openhouse.showWelcome)
                main.post {
                    val open = { leaveKiosk(); startActivity(Intent(android.provider.Settings.ACTION_WIFI_SETTINGS)) }
                    val settings = { lock.withPinSet(back = {}) { open() } }
                    when {
                        firstSetup -> lock.withPin { open() }
                        DeviceOwner.isOwner(this@MainActivity) -> WifiJoin.show(this@MainActivity, settings)
                        else -> settings()
                    }
                }
            }
        }
        // The assistant is OpenAI's, through the family's account (Settings → Voice): no sign-in on the tablet.
        override fun setUpAssistant() { main.post { CloudVoiceMenu(this@MainActivity).turnOn(linkNow = dev.openhouse.ui.Openhouse.setupStep == null) } } // first run: no lock yet; in setup, linking waits for its last step
        override fun hasAssistant() = LiveVoice.chosen
        override fun chooseVoice() { main.post { CloudVoiceMenu(this@MainActivity).chooseVoice() } }
        override fun withPin(title: String, ok: () -> Unit) { main.post { askPin(this@MainActivity, this@MainActivity, title, ok) } }
        override val context: android.content.Context get() = this@MainActivity
        override val bridge get() = this@MainActivity.bridge
        override fun startTimer(label: String, seconds: Int) { main.post { timers.start(label, seconds) } }
        override fun cancelTimer(id: Int) { main.post { timers.cancel(id) } }
        override fun restoreTimer(label: String, total: Int, endAt: Long) { main.post { timers.start(label, total, endAt) } }
        override fun timers(): List<dev.openhouse.ui.TimerInfo> = timers.list()
        override fun syncTimers(timers: List<dev.openhouse.ui.TimerInfo>) { main.post { this@MainActivity.syncTimers(timers) } }
        override fun openApp(id: String) { main.post { this@MainActivity.openApp(id) } }
        // Back to the home screen: an app in the shell's window closes; one running as its own Android app (a stub) goes
        // behind, the home screen coming to the front.
        override fun back() { main.post { this@MainActivity.back() } }
        override fun guessHome() = SetupDevice.guessHome(this@MainActivity)
        override fun setupPair(person: String) = SetupDevice.pair(this@MainActivity, bridge, person)
        override fun closeApp() { main.post { val stub = apps.stubAppId != null; this@MainActivity.closeApp(); if (stub) { apps.stubAppId = null; KioskApps.goHome() } } }
        override val openAppId: String? get() = apps.appId ?: apps.stubAppId
        override fun playVideo(url: String, title: String) { main.post { this@MainActivity.playVideo(url) } }
        override fun makeApp(request: String, context: String) {
            thread { dev.openhouse.ui.Openhouse.post("/request", JSONObject().put("text", request).put("context", context)) }
        }
    }

    /** Back, from Android's back (the gesture or button, when the system shows one), the edge swipe (Overlay.kt's
     *  EdgeBack, CalmDialog's) or a ‹: up one level. Dialogs over the screen take their own back first. */
    internal fun back() {
        val o = dev.openhouse.ui.Openhouse
        if (closeVideo()) return
        if (o.showWeather) { o.showWeather = false; return }
        // Settings and what it opens: up one level (the dialogs over it close themselves on Back).
        when {
            dev.openhouse.ui.Devices.open -> { dev.openhouse.ui.Devices.open = false; return }
            o.confirmDelete != null -> { o.confirmDelete = null; return }
            o.showFamily && o.householdSetUp -> { o.showFamily = false; return }
            o.showSettings -> { o.showSettings = false; return }
            o.setupStep != null -> { dev.openhouse.ui.Setup.back(); return }
        }
        if (o.showConversation) { o.closeConversation(); return }
        if (apps.appId != null) closeApp() /* else kiosk: ignore */
    }

    // --- the family's apps ----------------------------------------------------------------------------
    fun openApp(id: String) {
        if (id.isBlank()) return
        if (id.startsWith("android:")) { openAndroidApp(id.removePrefix("android:")); return } // an app added from Aurora Store
        apps.open(id) { overlay.bringToFront(); timers.view.bringToFront(); timers.showPills(true) }
    }

    fun closeApp() { apps.close(); timers.showPills(false) }

    /** An Android app from the board. One that leads out of kiosk mode (Settings, a store) needs the PIN on the card. */
    private fun openAndroidApp(pkg: String) {
        if (!KioskApps.needsParent(pkg)) { KioskApps.openApp(pkg); return }
        val acc = DeviceAccess.instance ?: return lock.withPin { KioskApps.openApp(pkg, parentOk = true) }
        thread { if (acc.approve("Open ${AppStore.label(pkg)}?", "", parent = ParentPin.isSet(this), yes = "Open")) main.post { KioskApps.openApp(pkg, parentOk = true) } }
    }

    // --- video: YouTube full screen over everything, with a close button (a note's Video, from the home screen) ---------
    private var player: FrameLayout? = null

    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    internal fun playVideo(url: String) {
        val id = Regex("(?:v=|youtu\\.be/|shorts/|embed/)([\\w-]{11})").find(url)?.groupValues?.get(1) ?: return
        closeVideo()
        val box = FrameLayout(this).apply { setBackgroundColor(Color.BLACK); isClickable = true }
        val web = android.webkit.WebView(this).apply {
            settings.javaScriptEnabled = true; settings.mediaPlaybackRequiresUserGesture = false; settings.domStorageEnabled = true
            setBackgroundColor(Color.BLACK)
            webViewClient = object : android.webkit.WebViewClient() {
                override fun shouldOverrideUrlLoading(v: android.webkit.WebView, r: android.webkit.WebResourceRequest) = r.isForMainFrame // the player never leaves for YouTube's site
                // Its renderer went (the app's one, shared with the home screen): answered, so the app lives on; the video closes.
                override fun onRenderProcessGone(v: android.webkit.WebView, d: android.webkit.RenderProcessGoneDetail?): Boolean {
                    RendererGone.drop(TAG, "the video", v, d)
                    if (player === box) { root.removeView(box); player = null }
                    return true
                }
            }
            loadDataWithBaseURL("https://www.youtube-nocookie.com", """<html><body style="margin:0;background:#000">
                <iframe style="border:0;width:100vw;height:100vh" src="https://www.youtube-nocookie.com/embed/$id?autoplay=1&rel=0&playsinline=1"
                allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></body></html>""", "text/html", "utf-8", null)
        }
        val close = android.widget.ImageView(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel); setColorFilter(Color.WHITE); contentDescription = "Close"; setPadding(dp(14), dp(14), dp(14), dp(14))
            background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = dp(26).toFloat(); setColor(Color.argb(170, 0, 0, 0)) }
            setOnClickListener { closeVideo() }
        }
        box.addView(web, FrameLayout.LayoutParams(-1, -1))
        box.addView(close, FrameLayout.LayoutParams(dp(64), dp(64), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(20), dp(20), 0) })
        root.addView(box, FrameLayout.LayoutParams(-1, -1)); player = box
    }
    private fun closeVideo(): Boolean {
        val p = player ?: return false
        (p.getChildAt(0) as? android.webkit.WebView)?.let { it.loadUrl("about:blank"); it.destroy() }
        root.removeView(p); player = null; return true
    }

    /** The tablet's connection, for the board (Openhouse.net): validated internet, a network without it, or none. */
    private var netWatch: android.net.ConnectivityManager.NetworkCallback? = null
    private fun watchNetwork() {
        val cm = getSystemService(android.net.ConnectivityManager::class.java)
        fun of(c: android.net.NetworkCapabilities?) = when {
            c == null || !c.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) -> dev.openhouse.ui.Net.NoNetwork
            c.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> dev.openhouse.ui.Net.Online
            else -> dev.openhouse.ui.Net.NoInternet
        }
        dev.openhouse.ui.Openhouse.setNet(of(runCatching { cm.getNetworkCapabilities(cm.activeNetwork) }.getOrNull()))
        Screens.tellAddress(this) // (the tablet's https name at home follows its address: bridge/lan-tls.js)
        netWatch = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(n: android.net.Network, c: android.net.NetworkCapabilities) { dev.openhouse.ui.Openhouse.setNet(of(c)); Screens.tellAddress(this@MainActivity) }
            override fun onLost(n: android.net.Network) { dev.openhouse.ui.Openhouse.setNet(dev.openhouse.ui.Net.NoNetwork) }
        }.also { runCatching { cm.registerDefaultNetworkCallback(it) } }
    }

    // (The watchdog isn't stopped here: it's the process's, and the next activity uses the same one. What this one had
    // waiting on the main thread goes with it.)
    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        netWatch?.let { runCatching { getSystemService(android.net.ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        if (live === this) live = null
        voice.stop()
        if (::home.isInitialized) home.destroy() // (not made when onCreate stepped aside for the move)
        super.onDestroy()
    }

    companion object {
        const val TAG = "Shell"
        private val DEFAULT_BRIDGE = if (BuildConfig.DEBUG) "http://10.0.2.2:8787" else "http://127.0.0.1:8787"
        /** The bridge this display talks to: adb's (ConfigReceiver) or the default. */
        fun bridgeUrl(shellPrefs: android.content.SharedPreferences) = shellPrefs.getString("bridge", null) ?: DEFAULT_BRIDGE
        /** The bridge runs on this tablet (so the shell runs and watches it). */
        fun onDevice(bridge: String) = Regex("^https?://(127\\.0\\.0\\.1|localhost)[:/]").containsMatchIn(bridge)
        fun listenOn(c: android.content.Context) = c.getSharedPreferences("shell", android.content.Context.MODE_PRIVATE).getBoolean("listen", android.os.Build.HARDWARE != "ranchu")
        fun micWanted(c: android.content.Context) = listenOn(c) && LiveVoice.chosen
        const val HOST_PKG = BuildConfig.HOST_PKG
        /** The display, while it's running (ConfigReceiver tells it about new settings). */
        @Volatile var live: MainActivity? = null
    }
}
