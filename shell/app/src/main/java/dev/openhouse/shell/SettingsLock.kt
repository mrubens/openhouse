package dev.openhouse.shell

// The shell's rows of Settings (the list is ui/Sheets.kt, SettingsSheet; docs/settings.md) and the optional lock:
// off by default, so nothing asks for a PIN. Turned on, it is a PIN (ParentPin), and the rows it locks ask for it
// before they open. The dialogs open over the list, so closing one comes back to it.

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

    /** With the lock on, the PIN, then [ok]; with it off, straight to [ok]. */
    fun withPin(title: String = "PIN", ok: () -> Unit) {
        if (!on) return ok()
        PinPrompt.ask(act, act, title, ok)
    }

    /** A row of Settings (the ids are SettingsSheet's). */
    fun open(id: String) {
        if (id.startsWith("unlink:")) return withPin { Screens.remove(act, id.removePrefix("unlink:")) }
        when (id) {
            "voice" -> withPin { CloudVoiceMenu(act).chooseVoice() }
            "calendars" -> withPin { CalendarLinks.manage(act, act::immersive) }
            "addLinked" -> withPin { Screens.addMenu(act) }
            "account" -> withPin { CloudMenu(act).show() }
            "email" -> withPin { EmailMenu(act).show() }
            "lock" -> if (on) turnOff() else turnOn()
            "tablet" -> withPin { tablet() }
            "memory" -> memory()
            "addCalendar" -> act.addCalendar() // the setup's steps (ui/Setup.kt)
            "addAlbum" -> act.addAlbum()
            "photoPhones" -> act.sharePhotos()
            "computer" -> withPin { Screens.computer(act) }
            "linkForOpie" -> CloudVoiceMenu(act).turnOn(linkNow = true) // the setup's phone step, when Turn on Opie needs the account
            "reloadHome" -> act.reloadHome()
        }
    }

    /** Send a report (docs/beta.md): after a yes, the shell's own log goes to the bridge, which adds the runtime's logs
     *  and the waiting app fixes and sends them to the service (bridge/cloud.js sendReport). */
    private fun report() {
        CalmDialog(act).setTitle("Send a report?")
            .setMessage("It sends this tablet's recent logs to OpenHouse, so we can see what went wrong. They can include things said to Opie and your household's names. We keep them 30 days.")
            .setPositiveButton("Send") { _, _ ->
                thread {
                    val log = runCatching { java.lang.Runtime.getRuntime().exec(arrayOf("logcat", "-d", "-t", "5000")).inputStream.bufferedReader().readText() }.getOrDefault("")
                    val (code, r) = CloudSetup.post("${act.bridge}/cloud/report", JSONObject().put("shellLog", log.takeLast(600_000)).put("version", Updater.installedVersion(act)), 60_000)
                    act.runOnUiThread {
                        when {
                            code == 200 -> act.toast("Sent. Thank you")
                            r?.optString("code") == "unlinked" -> CalmDialog(act).setTitle("Not linked").setMessage("Reports go through your OpenHouse account: link this tablet first, in Settings → Account.").setPositiveButton("OK", null).show()
                            else -> CalmDialog(act).setTitle("Couldn't send it").setMessage(r?.optString("error")?.takeIf { it.isNotBlank() } ?: "The tablet didn't answer. Try again in a minute.").setPositiveButton("OK", null).show()
                        }
                    }
                }
            }.setNegativeButton("Cancel") { _, _ -> tablet() }.show()
    }

    private fun erase() {
        CalmDialog(act).setTitle("Erase this tablet?")
            .setMessage("Everything on it goes: the family, calendars, lists, photos and apps. It's unlinked from the account, whose backups stay there. This can't be undone.")
            .setPositiveButton("Erase") { _, _ -> eraseNow(act) }.setNegativeButton("Cancel") { _, _ -> tablet() }.show()
    }

    // --- the lock ------------------------------------------------------------------------------------------------

    private fun turnOn() = PinPrompt.choose(act, act, then = { changed(); tablet() })

    private fun turnOff() = PinPrompt.ask(act, act, "Turn off the lock", { ParentPin.clear(act); changed(); tablet() })

    /** The lock went on or off (the calendar's own lock goes off with it, never on). */
    fun changed() { syncCalendar(); Openhouse.settingsChanged() }

    /** The Calendar app asks for the PIN only when someone chose that (Calendar needs the PIN, under PIN Lock): off by
     *  default, and off whenever there's no PIN. Until 1.0.24 it followed the lock itself, so a tablet from before has
     *  it turned off once. */
    fun syncCalendar() {
        val prefs = act.getSharedPreferences("settings_lock", android.content.Context.MODE_PRIVATE)
        val fresh = !prefs.getBoolean("calendar_own_choice", false)
        if (fresh || (House.calendarLock && !on)) setCalendarLock(false) { if (fresh) prefs.edit().putBoolean("calendar_own_choice", true).apply() }
    }
    private fun setCalendarLock(want: Boolean, then: () -> Unit = {}) { thread { if (Openhouse.post("/house/lock", JSONObject().put("calendar", want)) != null) then(); Openhouse.settingsChanged() } }

    // --- what the rows show ----------------------------------------------------------------------------------------

    private fun get(path: String): JSONObject? = runCatching { JSONObject(BridgeClient.getText("${act.bridge}$path", 1500, 3000)) }.getOrNull()
    private fun count(n: Int) = if (n == 0) "None" else n.toString()

    /** Off the main thread: what each of the shell's rows shows now. */
    fun values(): Map<String, String> {
        syncCalendar()
        val m = mutableMapOf<String, String>()
        m["lock"] = if (on) "On" else "Off"
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
            .setNegativeButton("Back") { _, _ -> tablet() }.show()
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
        val c = CalmDialog(act).setTitle("Version ${Updater.installedVersion(act)}").setMessage("Checking…").setNegativeButton("Back") { _, _ -> tablet() }
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
        val hb = get("/heartbeat")
        val plugins = get("/plugins")?.optJSONArray("plugins")?.length() ?: 0
        act.runOnUiThread { tabletList(lan, hb, plugins) }
    }

    /** [lan]: other screens and phones on the Wi-Fi reach it (Linked devices); [hb]: the check-ins (bridge /heartbeat). */
    private fun tabletList(lan: Boolean, hb: JSONObject?, plugins: Int) {
        val o = Openhouse
        val deviceOn = DeviceAccess.instance != null
        val granted = act.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED
        fun onOff(b: Boolean) = if (b) "On" else "Off"
        fun again() = android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ tablet() }, 350)
        // A person's own: what Opie may do, ways out of OpenHouse, and what reaches past the tablet (DeviceServer.personOnly).
        fun person(what: String, f: () -> Unit): () -> Unit = { if (!DeviceServer.personOnly(what)) f() }
        // A few sections, each row's value at its right, as the main Settings list (docs/ux.md).
        fun head(t: String) = CalmDialog.Row(t, header = true) to {}
        val items = listOf<Pair<CalmDialog.Row, () -> Unit>>(
            head("Help"),
            CalmDialog.Row("Send a report") to person("Send a report") { report() },
            head("Lock and updates"),
            CalmDialog.Row("PIN Lock", value = onOff(on)) to { if (on) turnOff() else turnOn() },
        ) + (if (on) listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("Calendar needs the PIN", value = onOff(House.calendarLock)) to { withPin { setCalendarLock(!House.calendarLock); again() } },
        ) else emptyList()) + listOf<Pair<CalmDialog.Row, () -> Unit>>(
            CalmDialog.Row("Brightness", value = Brightness.label(act)) to { Brightness.choose(act, act::immersive) { again() } },
            CalmDialog.Row("Updates", value = Updater.installedVersion(act)) to { updates() },
            CalmDialog.Row("Plugins", value = count(plugins)) to { PluginsMenu(act) { tablet() }.show() },
            head("Opie"),
            CalmDialog.Row("Device control", value = onOff(deviceOn)) to person("Device control") {
                if (granted) { DeviceOwner.setDeviceControl(act, !deviceOn); again() }
                else { act.leaveKiosk(); act.startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            },
            // Opie opening, installing and using other apps for someone (docs/device-control.md): off until someone turns it on.
            CalmDialog.Row("Opie uses apps", value = if (!deviceOn) "Needs device control" else onOff(DeviceServer.appsOn(act))) to person("Opie uses apps") {
                if (deviceOn) DeviceServer.setAppsOn(act, !DeviceServer.appsOn(act)); again()
            },
            CalmDialog.Row("Check-ins", value = hb?.let { everyLabel(it) } ?: "") to { hb?.let { checkins(it) } },
            head("For developers"),
            CalmDialog.Row("Home network", value = onOff(lan)) to person("Home network") { thread { CloudSetup.post("${act.bridge}/screens/lan", JSONObject().put("on", !lan)) }; again() },
            CalmDialog.Row("Cloud address") to { CloudMenu(act).address() },
            CalmDialog.Row("Speech log", value = onOff(o.speechLog)) to { o.setSpeechLog(!o.speechLog); again() },
            CalmDialog.Row("USB debugging", value = onOff(Kiosk.debugging(act))) to person("USB debugging") { Kiosk.setDebugging(act, !Kiosk.debugging(act)); again() },
            CalmDialog.Row("Android settings") to person("Android settings") { act.leaveKiosk(); act.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS)) },
            CalmDialog.Row("Leave kiosk mode") to person("Leave kiosk mode") {
                CalmDialog(act).setTitle("Leave kiosk mode?").setMessage("Open OpenHouse from its icon to come back.")
                    .setPositiveButton("Leave") { _, _ -> act.leaveKioskForGood() }.setNegativeButton("Cancel") { _, _ -> tablet() }.show()
            },
            // Kiosk mode blocks Android's own factory reset, so this is the way to hand a tablet on (docs/beta.md).
            CalmDialog.Row("Erase this tablet") to person("Erase this tablet") { erase() },
        )
        CalmDialog(act).setTitle("Advanced").setWidth(760f).setRows(items.map { it.first }) { _, i -> items[i].second() }
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
