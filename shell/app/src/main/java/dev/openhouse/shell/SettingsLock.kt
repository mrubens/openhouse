package dev.openhouse.shell

// The shell's rows of Settings (the page is ui/SettingsScreen.kt; docs/settings.md) and the optional lock:
// off by default, so nothing everyday asks for a PIN. Turned on, it is a PIN (ParentPin), and the rows it locks ask for
// it before they open, those that PinChoices says still ask (Advanced → Ask for the PIN); Advanced, Account, adding a
// linked device and PIN Lock's own rows always do (always). Erasing the tablet, the ways out of Opie, unlinking and
// restoring need one set first (withPinSet); a forgotten PIN is reset with its recovery code (PinPrompt.forgot). The
// dialogs open over the list, so closing one comes back to it.

import android.content.Intent
import android.content.pm.PackageManager
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.CalmDialog
import dev.openhouse.ui.House
import dev.openhouse.ui.Openhouse
import org.json.JSONObject
import kotlin.concurrent.thread

internal class SettingsLock(private val act: MainActivity) {
    val on: Boolean get() = ParentPin.isSet(act)

    /** With the lock on and [choice] asking (PinChoices: Settings' rows by default), the PIN, then [ok]; else straight to [ok]. */
    fun withPin(title: String = "PIN", choice: String = PinChoices.SETTINGS, ok: () -> Unit) {
        if (!asks(choice)) return ok()
        PinPrompt.ask(act, act, title, ok)
    }

    /** Does [choice] ask for the PIN now (the lock on, and it asks: PinChoices)? */
    fun asks(choice: String?) = PinChoices.needed(act, choice)

    /** What always takes the PIN with the lock on, whatever PinChoices says (Advanced, Account, adding a linked device,
     *  PIN Lock's own rows, the ways out before a household is saved). */
    fun always(title: String = "PIN", ok: () -> Unit) {
        if (!on) return ok()
        PinPrompt.ask(act, act, title, ok)
    }

    /** Erasing the tablet, the ways out of Opie (leaving kiosk mode, Android settings, USB debugging, Wi-Fi
     *  settings after the first setup), unlinking and restoring a backup: with the lock on, the PIN (straight on within
     *  the two minutes after it, as when This tablet just asked). With it off, they wait for someone to set a PIN
     *  (firstPin), so taps alone never reach them; once it's chosen, [ok]. [back]: they didn't. */
    /** A person's own: what Opie may do, ways out of Opie, and what reaches past the tablet (DeviceServer.personOnly). */
    private fun person(what: String, f: () -> Unit): () -> Unit = { if (!DeviceServer.personOnly(what)) f() }

    /** Settings → Opie's rows that widen what Opie may do or see (they were Advanced's: always the PIN, a person's tap). */
    private fun opie(id: String) {
        val deviceOn = DeviceAccess.instance != null
        when (id) {
            "deviceControl" -> person("Device control") { always {
                if (act.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED) { DeviceOwner.setDeviceControl(act, !deviceOn); changed() }
                else withPinSet(back = {}) { act.leaveKiosk(); act.startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            } }()
            // Opie opening, installing and using other apps for someone (docs/device-control.md): off until someone turns it on.
            "appsOn" -> person("Opie uses apps") { if (deviceOn) always { DeviceServer.setAppsOn(act, !DeviceServer.appsOn(act)); changed() } }()
            // The tablet's own Spotify player (SpotifyEmbed, docs/music.md): signed in on Spotify's own page; signing out is the person's too.
            "spotify" -> person("Spotify") { always {
                if (!SpotifyEmbed.signedIn()) SpotifyEmbed.signIn(act) { changed() }
                else CalmDialog(act).setTitle("Sign out of Spotify?").setMessage("Opie then plays Spotify through its app again, until someone signs in here.")
                    .setPositiveButton("Sign out") { _, _ -> SpotifyEmbed.signOut(); changed() }.setNegativeButton("Cancel", null).show()
            } }()
            "checkins" -> always { thread { get("/heartbeat")?.let { hb -> act.runOnUiThread { checkins(hb) } } } }
        }
    }

    /** Android's own page for Now playing (Media.kt), and back to Opie by itself the moment it's switched on. */
    private fun nowPlaying() { act.leaveKiosk(); act.startActivity(Media.settingsIntent(act)); Media.backWhenOn(act) }

    fun withPinSet(back: () -> Unit = { tablet() }, ok: () -> Unit) {
        if (on) return PinPrompt.ask(act, act, "PIN", ok, cancelled = back)
        CalmDialog(act).setTitle("Set a PIN first")
            .setMessage("This needs PIN Lock on, so only someone who knows the PIN can do it.")
            .setPositiveButton("Set a PIN") { _, _ -> firstPin(then = { changed(); ok() }, back = back) }
            .setNegativeButton("Cancel") { _, _ -> back() }.show()
    }

    /** A row of Settings (the ids are SettingsScreen's, and the setup's and other callers'). */
    fun open(id: String) {
        if (id.startsWith("unlink:")) return withPin { Screens.remove(act, id.removePrefix("unlink:")) }
        when (id) {
            "voice" -> withPin { CloudVoiceMenu(act).chooseVoice() }
            "calendars" -> withPin { CalendarLinks.manage(act, act::immersive) }
            "addLinked" -> always { Screens.addMenu(act) } // (adding any device changes who reaches the household: always)
            "addTablet" -> always { Screens.tablet(act) } // (Opie: show_settings, docs/opie-parity.md)
            "satellite" -> Satellite.menu(act, this) // a tablet that's part of another's household (docs/multi-tablet.md)
            "joinOther" -> if (Openhouse.showWelcome) Satellite.join(act) else withPinSet(back = {}) { Satellite.join(act) } // (from the welcome: nothing set up yet, no PIN to ask for)
            "account" -> always { CloudMenu(act).show() } // (backups, restore, unlink: always)
            "email" -> withPin { EmailMenu(act).show() }
            "lock" -> if (on) turnOff() else turnOn()
            "googlePlay" -> person("Google Play") { always { googlePlay() } }() // (a real account on a shared screen: always)
            "tablet" -> always { tablet() } // (Advanced: what Opie may do, the ways out, these choices: always)
            "updates" -> updates() // (no PIN: seeing the version and getting ours is everyone's)
            "nowplaying" -> if (!Media.listening(act)) person("Now playing") { withPinSet(back = {}) { nowPlaying() } }() // Settings → Opie, and Home's Now playing card
            "deviceControl", "appsOn", "spotify", "checkins" -> opie(id) // Settings → Opie
            "micCheck" -> MicCheck.open(act)
            "houseRules" -> HouseRules.open(act) {}
            "memory" -> memory()
            "brightness" -> Brightness.choose(act, act::immersive) { Openhouse.settingsChanged() }
            "volume" -> VolumeSetting.choose(act, act::immersive) { Openhouse.settingsChanged() }
            "time" -> withPin { Clock.choose(act, act::immersive) { Openhouse.settingsChanged() } }
            "addCalendar" -> act.addCalendar() // the setup's steps (ui/Setup.kt)
            "addAlbum" -> act.addAlbum()
            "photoPhones" -> act.sharePhotos()
            "computer" -> always { Screens.computer(act) }
            // The setup's calendar and photos steps (ui/Setup.kt): the same screens as Settings' and the Photos app's.
            "calendarGoogle" -> CalendarAccounts.google(act, act::immersive)
            "calendarICloud" -> CalendarAccounts.addICloud(act, act::immersive)
            "calendarLink" -> CalendarLinks.add(act, act::immersive)
            "calendarPaste" -> CalendarLinks.paste(act, act::immersive) // pasted or typed here (a keyboard cover)
            "albumPaste" -> withPin(choice = PinChoices.PHOTOS) { PhotoAlbums.paste(act, act::immersive) }
            "photoPhonesOn" -> act.sharePhotosOn()
            "googlePhotos" -> act.googlePhotos()
            // The setup's last step: PIN Lock on (with a recovery code unless linked), then the setup ends. Only while that
            // step is showing: anywhere else a first PIN is firstPin's.
            "setupPin" -> if (on) dev.openhouse.ui.Setup.next() else if (Openhouse.setupStep == "pin") PinPrompt.choose(act, act, then = { changed(); dev.openhouse.ui.Setup.next() })
            // The setup's Android step (ui/Setup.kt AndroidStep): only while it shows, a first setup's way out to Android's
            // own settings, as Join Wi-Fi is before the first setup (MainActivity.wifi); behind the PIN if one was chosen.
            "setupDeviceControl" -> if (Openhouse.setupStep == "android") {
                if (act.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED) { DeviceOwner.setDeviceControl(act, true); changed() }
                else always { act.leaveKiosk(); act.startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            }
            "setupCharge" -> if (Openhouse.setupStep == "android") always { act.leaveKiosk(); act.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS)) }
            "ownKey" -> OwnKey.menu(act) // Settings → Opie → Voice (behind the PIN in OwnKey)
            "reloadHome" -> act.reloadHome()
            "reloadHomeFirst" -> act.reloadHome(first = true) // the setup's end: on Home, whichever tab showed during it
        }
    }

    /** Send a report (docs/beta.md): after a yes, the shell's own log goes to the bridge, which adds the runtime's logs
     *  and the waiting app fixes and sends them to the service (bridge/cloud.js sendReport). */
    private fun report() {
        CalmDialog(act).setTitle("Send a report?")
            .setMessage("It sends this tablet's recent logs to us, the people who make Opie, so we can see what went wrong. They can include things said to Opie and your household's names. We keep them 30 days.")
            .setPositiveButton("Send") { _, _ ->
                thread {
                    val log = runCatching { java.lang.Runtime.getRuntime().exec(arrayOf("logcat", "-d", "-t", "5000")).inputStream.bufferedReader().readText() }.getOrDefault("")
                    val (code, r) = CloudSetup.post("${act.bridge}/cloud/report", JSONObject().put("shellLog", log.takeLast(600_000)).put("version", Updater.installedVersion(act)), 60_000)
                    act.runOnUiThread {
                        when {
                            code == 200 -> act.toast("Sent. Thank you")
                            r?.optString("code") == "unlinked" -> CalmDialog(act).setTitle("Not linked").setMessage("Reports go through your Opie account: link this tablet first, in Settings → Account.").setPositiveButton("OK", null).show()
                            else -> CalmDialog(act).setTitle("Couldn't send it").setMessage(r?.optString("error")?.takeIf { it.isNotBlank() } ?: "The tablet didn't answer. Try again in a minute.").setPositiveButton("OK", null).show()
                        }
                    }
                }
            }.setNegativeButton("Cancel") { _, _ -> tablet() }.show()
    }

    /** Android's child-process limit, after it seems to have stopped the runtime (Runtime.childLimitHit): the steps to
     *  switch it off, which only Developer options can (docs/setup.md). Android settings, behind the PIN as always. */
    private fun childLimit() {
        CalmDialog(act).setTitle("Android stopped Opie's software")
            .setMessage("Android limits how much an app may run in the background, and it stopped part of Opie. Opie started it again, but it can happen again. To switch the limit off, once:\n\n" +
                "1. In Android's settings, open About tablet (on a Samsung, then Software information) and tap Build number seven times.\n" +
                "2. Go back, open Developer options, and switch on Disable child process restrictions.\n" +
                "3. Press Home to come back.")
            .setPositiveButton("Open Android's settings") { _, _ -> withPinSet { act.leaveKiosk(); act.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS)) } }
            .setNegativeButton("Not now") { _, _ -> tablet() }.show()
    }

    private fun erase() {
        CalmDialog(act).setTitle("Erase this tablet?")
            .setMessage("Everything on it goes: the family, calendars, lists, photos and apps. It's unlinked from the account, whose backups stay there. This can't be undone.")
            .setPositiveButton("Erase") { _, _ -> eraseNow(act) }.setNegativeButton("Cancel") { _, _ -> tablet() }.show()
    }

    // --- the lock ------------------------------------------------------------------------------------------------

    private fun turnOn() = firstPin(then = { changed(); tablet() }, back = { tablet() })

    /**
     * A first PIN, outside the setup's own step: only on a tablet linked to an account, whose Reset with your account
     * gets an adult back in (PinPrompt.forgot). On an unlinked tablet anyone at it could choose one and tap past its
     * recovery code, keeping everyone else out of Account, Erase and Android's settings, so it asks to link first.
     * Changing or resetting a PIN that's set is PinPrompt's, as before.
     */
    private fun firstPin(then: () -> Unit, back: () -> Unit) = thread {
        val linked = get("/cloud/status")?.optBoolean("linked") == true
        act.runOnUiThread {
            if (linked) return@runOnUiThread PinPrompt.choose(act, act, then = then, back = back)
            // Not linked (set up without an account, as a do-it-yourself tablet may be): the PIN still comes with a
            // recovery code to keep, its only way back, so say that first rather than refusing a PIN outright. With no
            // account behind it, whoever chooses the first PIN holds the tablet's settings (setup's PIN step is the time
            // meant for it, docs/settings.md), so this says so: a warning, not a wall, as nothing at the tablet tells an
            // adult from anyone else.
            CalmDialog(act).setTitle("Choose a PIN")
                .setMessage("Whoever chooses this PIN decides who can change Settings and approve apps, so it's for an adult of the household.\n\nThis tablet isn't linked to an Opie account, so a forgotten PIN can only be reset with the recovery code shown next. Keep it somewhere safe, away from the tablet.")
                .setPositiveButton("Continue") { _, _ -> PinPrompt.choose(act, act, then = then, back = back) }
                .setNegativeButton("Link it first") { _, _ -> CloudMenu(act).show() }.show()
            act.immersive()
        }
    }

    private fun turnOff() = PinPrompt.ask(act, act, "Turn off the lock", { ParentPin.clear(act); changed(); tablet() })

    /** A new recovery code for the PIN (one set before codes, or the old one lost): after the PIN; the old code stops
     *  working once they've kept the new one. */
    private fun newCode() = always {
        PinPrompt.showCode(act, RecoveryCode.new(), keep = { ParentPin.setRecovery(act, it); act.toast("New recovery code kept"); tablet() }, back = { tablet() })
    }

    /** The lock went on or off (the calendar's own lock goes off with it, never on). */
    fun changed() { syncCalendar(); Openhouse.settingsChanged() }

    /** The Calendar app asks for the PIN only when someone chose that (Advanced → Ask for the PIN → Change the calendar: PinChoices): off by
     *  default, and off whenever there's no PIN. Until 1.0.24 it followed the lock itself, so a tablet from before has
     *  it turned off once. */
    fun syncCalendar() {
        val prefs = act.getSharedPreferences("settings_lock", android.content.Context.MODE_PRIVATE)
        val fresh = !prefs.getBoolean("calendar_own_choice", false)
        if (fresh || (House.calendarLock && !on)) setCalendarLock(false) { if (fresh) prefs.edit().putBoolean("calendar_own_choice", true).apply() }
    }
    private fun setCalendarLock(want: Boolean, then: () -> Unit = {}) { thread { if (Openhouse.post("/house/lock", JSONObject().put("calendar", want)) != null) then(); Openhouse.settingsChanged() } }

    // --- Ask for the PIN to… (PinChoices) ---------------------------------------------------------------------------

    /** Advanced's row: which ask, in a word or two. */
    private fun choicesLabel(): String {
        val saved = PinChoices.saved(act)
        val on = PinChoices.ALL.filter { PinChoices.asks(it.key, saved) }
        return when (on.size) { 0 -> "Nothing more"; 1 -> on[0].label; else -> "${on.size} things" }
    }

    /** One switch for each choice; a tap turns it over, behind the PIN (always: changing them is never optional). A
     *  person's own tap (Opie's pin_choices asks on its own card instead), so nothing Opie taps here within the two
     *  minutes after the PIN changes them. */
    private fun choices() {
        val saved = PinChoices.saved(act)
        val rows = PinChoices.ALL.map { CalmDialog.Row(it.label, value = if (PinChoices.asks(it.key, saved)) "On" else "Off") }
        CalmDialog(act).setTitle("Ask for the PIN to…").setSettingsLook().setRows(rows) { _, i ->
            val c = PinChoices.ALL[i]
            if (DeviceServer.personOnly("Changing what asks for the PIN")) { choices(); return@setRows }
            always {
                val want = !PinChoices.asks(c.key, PinChoices.saved(act))
                thread { PinChoices.save(act, c.key, want); act.runOnUiThread { android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ choices() }, 350) } }
            }
        }.setNegativeButton("Back") { _, _ -> tablet() }.show()
    }

    // --- what the rows show ----------------------------------------------------------------------------------------

    private fun get(path: String): JSONObject? = runCatching { JSONObject(BridgeClient.getText("${act.bridge}$path", 1500, 3000)) }.getOrNull()
    private fun count(n: Int) = if (n == 0) "None" else n.toString()

    /** Off the main thread: what each of the shell's rows shows now. */
    fun values(): Map<String, String> {
        syncCalendar()
        val m = mutableMapOf<String, String>()
        m["lock"] = if (on) "On" else "Off"
        m["settingsLock"] = if (asks(PinChoices.SETTINGS)) "On" else "Off" // the small lock on Voice, Calendars, Time, Email
        m["updates"] = Updater.installedVersion(act)
        val deviceOn = DeviceAccess.instance != null
        m["deviceControl"] = if (deviceOn) "On" else "Off" // Settings → Opie, and the setup's Android step (ui/Setup.kt)
        m["appsOn"] = if (!deviceOn) "Needs device control" else if (DeviceServer.appsOn(act)) "On" else "Off"
        m["nowPlaying"] = if (Media.listening(act)) "On" else "Off"
        m["spotify"] = if (SpotifyEmbed.signedIn()) "Signed in" else "Sign in"
        get("/heartbeat")?.let { m["checkins"] = everyLabel(it) }
        m["brightness"] = Brightness.label(act)
        m["volume"] = VolumeSetting.label(act)
        m["time"] = Clock.label(act)
        m["albums"] = count(runCatching { PhotoAlbums.list().size }.getOrDefault(0)) // the setup's progress (ui/Setup.kt)
        // Voice: Off, or the voice it speaks with (Hey Opie listening too); while the listening models come, how that's going.
        val name = get("/cloud/voice")?.optString("voiceName")?.takeIf { it.isNotEmpty() }?.replaceFirstChar { c -> c.uppercase() } ?: "On"
        m["voice"] = if (!LiveVoice.chosen) "Off" else when (VoiceModels.describe()?.substringBefore(" ")) {
            "Getting", "Putting" -> "Getting ready"; "The" -> "Waits for Wi-Fi"; "Couldn't" -> "Not ready yet"; else -> name }
        get("/screens")?.optJSONArray("screens")?.let { m["screens"] = count(it.length()) }
        get("/cloud/status")?.let { m["account"] = if (it.optBoolean("linked")) it.optString("family").ifEmpty { "Linked" } else "Off" }
        get("/mail")?.let { e -> // Email: how many wait for an Allow, else whether mail comes in at all
            val held = e.optJSONArray("held")?.length() ?: 0
            m["email"] = if (held > 0) "$held waiting" else if (e.optJSONObject("cloud")?.optBoolean("on") == true || e.optBoolean("own")) "On" else "Off"
        }
        get("/memory")?.let { m["memory"] = count(it.optJSONArray("remembered")?.length() ?: 0) }
        // Calendars: how many are shown (a signed-in account's ones that aren't hidden, and links)
        val synced = get("/calendar/sync")?.optJSONArray("calendars")?.let { a -> (0 until a.length()).count { a.optJSONObject(it)?.optString("mode") != "off" } } ?: 0
        m["calendars"] = count(synced + runCatching { CalendarLinks.list().size }.getOrDefault(0))
        return m
    }



    // --- Check-ins: the heartbeat's review (bridge heartbeat.js), how often and what it looks for ---------------------

    private val EVERY = listOf(30 to "Every 30 minutes", 60 to "Every hour", 120 to "Every 2 hours", 240 to "Every 4 hours")
    private fun everyLabel(hb: JSONObject) = if (hb.optString("level") == "off") "Off" else EVERY.firstOrNull { it.first == hb.optInt("every", 60) }?.second ?: "Every hour"

    private fun checkins(hb: JSONObject) {
        val items = listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("How often", value = everyLabel(hb)) to { howOften(hb) },
            CalmDialog.Row("What it looks for", value = if (hb.optBoolean("ownPrompt")) "Yours" else "Ours") to { prompt(hb) },
        )
        CalmDialog(act).setTitle("Check-ins").setRows(items.map { it.first }) { _, i -> items[i].second() }
            .setNegativeButton("Back", null).show()
    }

    private fun saveCheckins(b: JSONObject) = thread {
        val (_, r) = CloudSetup.post("${act.bridge}/heartbeat/settings", b)
        act.runOnUiThread { if (r != null && !r.has("error")) checkins(r) }
    }

    private fun howOften(hb: JSONObject) {
        val off = hb.optString("level") == "off"
        val labels = listOf("Off") + EVERY.map { it.second }
        val now = if (off) 0 else 1 + EVERY.indexOfFirst { it.first == hb.optInt("every", 60) }.coerceAtLeast(0)
        CalmDialog(act).setTitle("How often").setSingleChoiceItems(labels.toTypedArray(), now) { d, i ->
            d.dismiss()
            saveCheckins(if (i == 0) JSONObject().put("level", "off")
                else JSONObject().put("every", EVERY[i - 1].first).apply { if (off) put("level", "tidy") })
        }.setNegativeButton("Back") { _, _ -> checkins(hb) }.show()
    }

    /** Its instructions in full, to read and change. */
    private fun prompt(hb: JSONObject) {
        val box = dev.openhouse.ui.Calm.field(act, "", 18f).apply {
            setText(hb.optString("prompt")); isSingleLine = false; minLines = 8; maxLines = 14
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
        }
        // Putting ours back is rare: a quiet link under the box, not a third button (docs/ux.md).
        var d: android.app.Dialog? = null
        val view = dev.openhouse.ui.Calm.column(act).apply {
            addView(box, android.widget.LinearLayout.LayoutParams(-1, -2))
            if (hb.optBoolean("ownPrompt")) addView(dev.openhouse.ui.Calm.quiet(act, "Put ours back") { d?.dismiss(); saveCheckins(JSONObject().put("prompt", "")) }.apply { setPadding(0, 0, 0, 0) },
                android.widget.LinearLayout.LayoutParams(-2, -2).apply { topMargin = dev.openhouse.ui.Calm.px(act, 8) })
        }
        d = CalmDialog(act).setTitle("What it looks for").setView(view).setWidth(1000f)
            .setPositiveButton("Save") { _, _ -> saveCheckins(JSONObject().put("prompt", box.text.toString())) }
            .setNegativeButton("Cancel") { _, _ -> checkins(hb) }.show()
    }

    // --- What Opie remembers ----------------------------------------------------------------------------------------

    /** What it keeps (bridge /memory): lasting things, then a few lines for each day. Tap one to forget it. */
    private fun memory(): Thread = thread {
        val j = get("/memory")
        act.runOnUiThread {
            if (j == null) { CalmDialog(act).setTitle("What Opie remembers").setMessage("The tablet's software isn't answering right now.").setPositiveButton("Close", null).show(); return@runOnUiThread }
            val things = j.optJSONArray("remembered")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty().filter { it.isNotBlank() }
            val days = j.optJSONArray("days")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
            val items = mutableListOf<Pair<CalmDialog.Row, JSONObject?>>()
            things.forEach { items += CalmDialog.Row(it) to JSONObject().put("text", it) }
            if (days.isNotEmpty()) { items += CalmDialog.Row("Each day", header = true) to null; days.forEach { d -> items += CalmDialog.Row(dayName(d.optString("day")), d.optString("text")) to JSONObject().put("day", d.optString("day")) } }
            val c = CalmDialog(act).setTitle("What Opie remembers").setWidth(860f).setNegativeButton("Back", null)
            if (items.isEmpty()) c.setMessage("Nothing yet.") else c.setRows(items.map { it.first }) { _, i -> items[i].second?.let { forget(it, items[i].first.title.toString()) } }
            c.show()
        }
    }

    private fun forget(what: JSONObject, label: String) {
        CalmDialog(act).setTitle("Forget this?").setMessage(label).setDanger()
            .setPositiveButton("Forget") { _, _ -> thread { CloudSetup.post("${act.bridge}/memory/forget", what); act.runOnUiThread { memory() } } }
            .setNegativeButton("Cancel") { _, _ -> memory() }.show()
    }

    /** "2026-11-20" as "Today", "Yesterday" or "Wednesday". */
    private fun dayName(day: String): String = runCatching {
        val d = java.time.LocalDate.parse(day); val today = java.time.LocalDate.now()
        when (d) { today -> "Today"; today.minusDays(1) -> "Yesterday"; else -> d.dayOfWeek.getDisplayName(java.time.format.TextStyle.FULL, java.util.Locale.getDefault()) }
    }.getOrDefault(day)

    // --- Updates ---------------------------------------------------------------------------------------------------

    /** The version, check now, and install what's ready. */
    private fun updates() {
        val c = CalmDialog(act).setTitle("Version ${Updater.installedVersion(act)}").setMessage("Checking…").setNegativeButton("Done", null)
        val d = c.show()
        Updater.checkNow(act, install = false) { st ->
            act.runOnUiThread {
                if (!d.isShowing) return@runOnUiThread
                c.updateMessage(st)
                Updater.readyVersion(act)?.let { v ->
                    d.dismiss()
                    CalmDialog(act).setTitle("Install version $v?").setMessage("The screen goes blank for about a minute.")
                        .setPositiveButton("Install") { _, _ -> Updater.installNow(act); act.toast("Installing $v") }
                        .setNegativeButton("Not now", null).show()
                }
            }
        }
    }

    // --- This tablet -----------------------------------------------------------------------------------------------

    /** Device control, the speech log, USB debugging, Android's settings, leaving kiosk mode. A switch here shows the
     *  list again, so it stays where you were. */
    private fun tablet(): Thread = thread {
        val lan = get("/screens")?.optBoolean("lan") == true
        val plugins = get("/plugins")?.optJSONArray("plugins")?.length() ?: 0
        val ts = get("/tailscale")
        act.runOnUiThread { tabletList(lan, plugins, ts) }
    }

    /**
     * Settings → Advanced → Google Play (and Add apps before anyone signed in): Android's own Google sign-in, then
     * Play's purchase setting, so nothing can be bought with a tap. Signed in: the account, and signing out.
     */
    fun googlePlay(back: () -> Unit = {}) {
        val name = PlayStore.accounts(act).firstOrNull()
        if (name != null) {
            CalmDialog(act).setTitle("Google Play").setMessage(name)
                .setPositiveButton("Done") { _, _ -> back() }
                .setNegativeButton("Sign out") { _, _ ->
                    thread { val ok = PlayStore.signOut(act, name); act.runOnUiThread {
                        changed()
                        if (ok) back() else CalmDialog(act).setTitle("Couldn't sign out here").setMessage("Sign out in Android settings, under Accounts.").setPositiveButton("OK") { _, _ -> back() }.show()
                    } }
                }.show()
            return
        }
        CalmDialog(act).setTitle("Sign in to Google Play").setMessage("A Google account just for this tablet works best.")
            .setPositiveButton("Sign in") { _, _ ->
                PlayStore.signIn(act) { added ->
                    changed()
                    if (added == null) return@signIn back()
                    // Play's own setting: purchases ask for the account's password (it can't be set from outside Play).
                    CalmDialog(act).setTitle("Ask for the password to buy")
                        .setMessage("In Google Play: your picture, Settings, Authentication, Require authentication for purchases, For all purchases.")
                        .setPositiveButton("Open Google Play") { _, _ -> PlayStore.openPlay(act) }
                        .setNegativeButton("Later") { _, _ -> back() }.show()
                }
            }.setNegativeButton("Cancel") { _, _ -> back() }.show()
    }

    /** Settings → Advanced: the lock, plugins, this tablet's household, a report; then what's for developers. [lan]:
     *  other screens and phones on the Wi-Fi reach it (Devices). */
    private fun tabletList(lan: Boolean, plugins: Int, ts: JSONObject?) {
        val o = Openhouse
        fun onOff(b: Boolean) = if (b) "On" else "Off"
        fun again() = android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ tablet() }, 350)
        // A few sections, each row's value at its right, as Settings' tabs (docs/ux.md).
        fun head(t: String) = CalmDialog.Row(t, header = true) to {}
        val items = listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("PIN Lock", value = onOff(on)) to { if (on) turnOff() else turnOn() },
        ) + (if (on) listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("PIN recovery code", value = if (ParentPin.hasRecovery(act)) null else "None") to person("PIN recovery code") { newCode() },
            CalmDialog.Row("Ask for the PIN", value = choicesLabel()) to { always { choices() } },
        ) else emptyList()) + listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("Plugins", value = count(plugins)) to { PluginsMenu(act) { tablet() }.show() },
        ) + (if (!PlayStore.available(act)) emptyList() else listOf<Pair<CalmDialog.Row, () -> Unit>>(
            // The household's Google account, for adding Android apps (PlayStore): a person's own, inside Advanced's PIN.
            CalmDialog.Row("Google Play", value = PlayStore.accounts(act).firstOrNull() ?: "Sign in") to person("Google Play") { googlePlay { tablet() } },
        )) + (if (Satellite.on) listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("Part of another tablet's household") to { Satellite.menu(act, this) },
        ) else listOf<Pair<CalmDialog.Row, () -> Unit>>(
            // Another Opie tablet's household, for a second room (docs/multi-tablet.md): that tablet shows the code.
            CalmDialog.Row("Add this tablet to another Opie") to person("Add this tablet to another Opie") { withPinSet { Satellite.join(act) } },
        )) + listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("Send a report") to person("Send a report") { report() },
        ) + (if (!Runtime.childLimitHit(act)) emptyList() else listOf<Pair<CalmDialog.Row, () -> Unit>>(
            // Shown only once Android seems to have stopped the runtime with its child-process limit (Runtime.lost).
            CalmDialog.Row("Opie's software was stopped by Android") to { childLimit() },
        )) + listOf<Pair<CalmDialog.Row, () -> Unit>>(
            head("For developers"),
            CalmDialog.Row("Home network", value = onOff(lan)) to person("Home network") { thread { CloudSetup.post("${act.bridge}/screens/lan", JSONObject().put("on", !lan)) }; again() },
            // Away from home through the household's own Tailscale (TailscaleMenu, bridge/tailscale.js): it changes who can
            // reach the tablet, so it's a person's own, as pairing is.
            CalmDialog.Row("Tailscale", value = when { ts?.optBoolean("on") != true -> "Off"; ts.optString("state") == "on" -> "On"; ts.optString("state") == "signin" -> "Sign in"; else -> "Starting" }) to person("Tailscale") { TailscaleMenu(act) { tablet() }.show() },
            CalmDialog.Row("Cloud address") to { CloudMenu(act).address() },
            CalmDialog.Row("Speech log", value = onOff(o.speechLog)) to { o.setSpeechLog(!o.speechLog); again() },
            CalmDialog.Row("USB debugging", value = onOff(Kiosk.debugging(act))) to person("USB debugging") {
                if (Kiosk.debugging(act)) { Kiosk.setDebugging(act, false); again() } else withPinSet { Kiosk.setDebugging(act, true); again() }
            },
            CalmDialog.Row("Android settings") to person("Android settings") { withPinSet { act.leaveKiosk(); act.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS)) } },
            CalmDialog.Row("Leave kiosk mode") to person("Leave kiosk mode") { withPinSet {
                CalmDialog(act).setTitle("Leave kiosk mode?").setMessage("Open Opie from its icon to come back.")
                    .setPositiveButton("Leave") { _, _ -> act.leaveKioskForGood() }.setNegativeButton("Cancel") { _, _ -> tablet() }.show()
            } },
            // Kiosk mode blocks Android's own factory reset, so this is the way to hand a tablet on (docs/beta.md).
            CalmDialog.Row("Erase this tablet") to person("Erase this tablet") { withPinSet { erase() } },
        )
        CalmDialog(act).setTitle("Advanced").setSettingsLook().setRows(items.map { it.first }) { _, i -> items[i].second() }
            .setNegativeButton("Back", null).show()
    }
}

/** Unlink from the account, then a factory reset: everything on the tablet goes, and it starts again at Android's
 *  welcome screen, ready for the setup code. Backups stay in the account (deleting the account deletes them). */
private fun SettingsLock.eraseNow(act: MainActivity) {
    thread {
        runCatching { CloudSetup.post("${act.bridge}/cloud/unlink", JSONObject()) } // not linked, or offline: erase anyway
        act.runOnUiThread {
            val dpm = act.getSystemService(android.app.admin.DevicePolicyManager::class.java)
            runCatching { if (android.os.Build.VERSION.SDK_INT >= 34) dpm.wipeDevice(0) else @Suppress("DEPRECATION") dpm.wipeData(0) }
                .onFailure { CalmDialog(act).setTitle("Couldn't erase it").setMessage(it.message ?: "Android said no.").setPositiveButton("OK", null).show() }
        }
    }
}

/** The PIN, asked for over any activity (an app's own window too) when the lock is on; [pins]: the shell's context,
 *  where it's kept. With the lock off, straight to [ok]. */
internal fun askPin(act: android.app.Activity, pins: android.content.Context, title: String, ok: () -> Unit) {
    if (!ParentPin.isSet(pins)) return ok()
    PinPrompt.ask(act, pins, title, ok)
}

/** "Try again in 40 seconds." for a PIN locked after wrong guesses. */
internal fun tryAgainIn(ms: Long): String = ((ms + 999) / 1000).let { s -> if (s < 90) "Too many tries. Try again in $s seconds." else "Too many tries. Try again in ${(s + 59) / 60} minutes." }
