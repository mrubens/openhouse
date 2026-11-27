package dev.openhouse.shell

import android.content.Context

/**
 * Which everyday things ask for the PIN: Settings → Advanced → Ask for the PIN (docs/settings.md, "The lock"). They
 * matter only while PIN Lock is on; with no PIN nothing asks (the ways out wait for one to be set: withPinSet).
 *
 * The choices, permissive by default (the user, 2026-11-27: the PIN to install apps was annoying), except Settings:
 *   apps      adding apps: an Android app (install_app, Aurora Store and what it hands over), a plugin (add, an update,
 *             an app reaching a website), an app Opie made going in, Apps' plugin gallery
 *   photos    photo albums: adding or removing one, phones sending photos, Google Photos
 *   calendar  changing the calendar (the bridge keeps this one: House.calendarLock, /house/lock)
 *   rewards   giving a reward, and changing the rewards
 *   settings  Settings' Voice, Calendars, Time and Email, the house rules (HouseRules, and Opie's house_rules), removing a
 *             linked device, the household's OpenAI key
 *
 * Always the PIN, whatever the choices ([ALWAYS]; callers use SettingsLock.always / withPinSet, or name no choice):
 * changing these choices, PIN Lock itself (turning it off, a new recovery code, Forgot PIN?), Advanced (device control,
 * Opie uses apps, Tailscale, the home network, Plugins...), Account and Backups (link, unlink, restore, the backups'
 * code, your own storage), adding a linked device (a computer that changes the apps, a phone, a screen, a TV, another
 * tablet) and joining another household, the ways out of Opie (leaving kiosk mode, Android's settings and Wi-Fi
 * settings, system apps and stores, USB debugging), erasing the tablet, and a plugin update from somewhere new. A card
 * that names no choice, or one this shell doesn't know (a newer bridge), asks as it always did.
 *
 * "No PIN" never means Opie can say yes: a card that waits for a person (ApprovalCard) still takes a real finger, and
 * what's DeviceServer.personOnly stays a person's own tap.
 */
object PinChoices {
    data class Choice(val key: String, val label: String, val default: Boolean)

    const val APPS = "apps"
    const val PHOTOS = "photos"
    const val CALENDAR = "calendar"
    const val REWARDS = "rewards"
    const val SETTINGS = "settings"

    /** The switches, in the order shown. [Choice.label] finishes "Ask for the PIN to…". */
    val ALL = listOf(
        Choice(APPS, "Add apps", false),
        Choice(PHOTOS, "Add photo albums", false),
        Choice(CALENDAR, "Change the calendar", false),
        Choice(REWARDS, "Give rewards", false),
        Choice(SETTINGS, "Change settings", true),
    )

    /** What always asks for the PIN (for Opie's pin_choices and the docs; the code's own callers use always/withPinSet). */
    val ALWAYS = listOf(
        "changing these choices", "PIN Lock, the PIN and its recovery code", "Advanced", "Account and backups",
        "adding a linked device", "the house rules", "leaving kiosk mode, Android's settings and other ways out of Opie", "erasing the device",
    )

    fun isChoice(key: String?) = ALL.any { it.key == key }

    /** Does [key] ask for the PIN (when one is set)? [saved]: what someone chose, null if never. Anything that isn't one
     *  of the choices always asks. */
    fun asks(key: String?, saved: (String) -> Boolean?): Boolean {
        val c = ALL.firstOrNull { it.key == key } ?: return true
        return saved(c.key) ?: c.default
    }

    enum class Changed { DONE, SAME, NOT_A_CHOICE, NO_PIN, NOT_CONFIRMED }

    /**
     * Turn [key] on or off. Only one of the choices, only with a PIN set, and only after [confirm]: the PIN typed on the
     * tablet (a card only a person answers; within ParentGrace, a real finger on its yes). A no leaves it as it was.
     */
    fun change(key: String, on: Boolean, pinSet: Boolean, saved: (String) -> Boolean?, confirm: () -> Boolean, save: (String, Boolean) -> Unit): Changed {
        if (!isChoice(key)) return Changed.NOT_A_CHOICE
        if (!pinSet) return Changed.NO_PIN
        if (asks(key, saved) == on) return Changed.SAME
        if (!confirm()) return Changed.NOT_CONFIRMED
        save(key, on)
        return Changed.DONE
    }

    // --- on the tablet ---------------------------------------------------------------------------------------------

    private fun prefs(c: Context) = c.getSharedPreferences("shell", Context.MODE_PRIVATE)

    /** What this tablet's people chose (the calendar's is the bridge's: House.calendarLock). */
    fun saved(c: Context): (String) -> Boolean? = { k ->
        if (k == CALENDAR) dev.openhouse.ui.House.calendarLock
        else prefs(c).takeIf { it.contains("pin_for_$k") }?.getBoolean("pin_for_$k", false)
    }

    /** Does [key] need the PIN now: one is set, and it asks. */
    fun needed(c: Context, key: String?) = ParentPin.isSet(c) && asks(key, saved(c))

    /** Keep a choice (callers asked for the PIN first: [change], or SettingsLock.always). Off the main thread. */
    fun save(c: Context, key: String, on: Boolean) {
        if (!isChoice(key)) return
        if (key == CALENDAR) dev.openhouse.ui.Openhouse.post("/house/lock", org.json.JSONObject().put("calendar", on))
        else prefs(c).edit().putBoolean("pin_for_$key", on).commit()
        dev.openhouse.ui.Openhouse.settingsChanged()
    }
}
