package dev.openhouse.shell

// Settings → Opie → Voice (openhouse-cloud/docs/cloud-beta.md): OpenAI's live voice through Opie cloud, off unless someone
// turns it on here after reading what goes where. The bridge does the work (bridge/cloud.js, /cloud/voice); the
// session runs in the shell (LiveVoice). Its name is heard on the tablet; nothing goes out until then.
// What the household said here is kept (OpieChoice), so a yes made before the tablet was linked, or before its
// household had the voice, turns it on by itself later (CloudSetup.autoVoice). The end of the first setup turns it on
// too (ready), and its Turn off is kept the same way.

import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import kotlin.concurrent.thread

internal class CloudVoiceMenu(private val act: MainActivity) {
    companion object {
        // GPT-Live's voices (OpenAI's guide, "Voice options"): API name, and how it sounds. The cloud keeps the same list (LIVE_VOICES).
        val VOICES = listOf(
            "marin" to "Marin · OpenAI's default",
            "gleam" to "Gleam · North American, feminine", "meridian" to "Meridian · North American, masculine",
            "delta" to "Delta · Southern U.S., feminine", "cinder" to "Cinder · Southern U.S., masculine",
            "willow" to "Willow · Irish, feminine", "stone" to "Stone · Irish, masculine",
            "vesper" to "Vesper · British, masculine",
            "quartz" to "Quartz · Australian, feminine", "ripple" to "Ripple · Australian, masculine",
            "beacon" to "Beacon · Filipino English, masculine",
            "bossa" to "Bossa · Brazilian Portuguese, feminine", "tempo" to "Tempo · Brazilian Portuguese, masculine",
            "brise" to "Brise · French, feminine", "sillage" to "Sillage · French, masculine",
            "nuri" to "Nuri · German, feminine", "juni" to "Juni · German, feminine", "flitz" to "Flitz · German, masculine",
            "nira" to "Nira · Hindi, feminine",
            "harema" to "Harema · Japanese, feminine", "shida" to "Shida · Japanese, masculine",
            "noeul" to "Noeul · Korean, feminine",
        )
        /** Google's voices for Gemini Live (Google's speech guide; bridge own-gemini.js GEMINI_VOICES), offered with a
         *  Gemini key in: picking one is what moves Opie's voice to Google. */
        val GEMINI_VOICES = listOf(
            "kore" to "Kore · Google, firm", "puck" to "Puck · Google, upbeat", "zephyr" to "Zephyr · Google, bright",
            "charon" to "Charon · Google, informative", "aoede" to "Aoede · Google, breezy", "leda" to "Leda · Google, youthful",
            "orus" to "Orus · Google, firm", "achernar" to "Achernar · Google, soft", "schedar" to "Schedar · Google, even",
            "gacrux" to "Gacrux · Google, mature",
        )
    }

    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private fun say(text: String) { CalmDialog(act).setTitle("Live voice").setMessage(text).setPositiveButton("Close", null).show() }
    private val noBridge = "The device's software isn't answering right now. Try again in a minute."
    /** The household's account doesn't have Opie's voice yet (the cloud's voiceState.available, or its not_enabled). */
    private val notYet = "Opie's voice isn't on for your household yet. It turns on here by itself as soon as it is."
    private fun n(x: Int) = String.format(java.util.Locale.US, "%,d", x)
    /** The household's Opie credit (the cloud's credits.ts, through bridge/cloud.js): "$7.40 left · about 6¢ a minute", or
     *  that it's run out or is on hold. null on the household's own key, or on the house. */
    private fun creditLine(v: JSONObject?): String? {
        val c = v?.optJSONObject("credit")?.takeIf { !v.optBoolean("own") } ?: return null
        if (c.optBoolean("frozen")) return "Opie's credit is on hold while we look at a payment."
        if (!c.optBoolean("paid")) return null
        val cents = c.optInt("cents")
        if (cents <= 0) return "Opie's credit has run out. Add more on your account page."
        return String.format(java.util.Locale.US, "$%.2f left · about %d¢ a minute", cents / 100.0, c.optInt("perMinuteCents", 6))
    }
    /** No credit bought yet (a service with credit): how to get Opie's voice. */
    private val needsCredit = "Opie's voice runs on credit you add on your account page. Or use your own OpenAI key."

    /** Settings → Opie → Voice (behind the PIN Lock when it is on; openhouse-cloud/docs/cloud-beta.md): Off, or which of OpenAI's voices it speaks with. Heard from the next
     *  conversation, so it says hello in it at once (a short session just to say it). */
    fun chooseVoice(): Thread = thread {
        val v = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/cloud/voice?check=1", 3000, 8000)) }.getOrNull()
        val now = v?.optString("voiceName")
        // This month (bridge/usage.js): minutes talking, typed questions, apps made or changed, and about what it cost.
        // Only once something's been used: a line nobody needs otherwise.
        val month = v?.optJSONObject("month")?.takeIf { m -> listOf("minutes", "questions", "apps", "cents").any { m.optInt(it) > 0 } }?.optString("text")?.takeIf { it.isNotBlank() }
        val credit = creditLine(v)
        // With a Gemini key in, Google's voices come first, then OpenAI's (where there's an OpenAI key or Opie cloud).
        val google = v?.optBoolean("gemini") == true
        val openai = v == null || v.optBoolean("openaiKey") || v.optBoolean("linked") || !google
        val voices = (if (google) GEMINI_VOICES else emptyList()) + (if (openai) VOICES else emptyList())
        val toGoogle = v?.optString("vendor") == "Google"
        ui {
            if (now == null) return@ui say(noBridge)
            val checked = if (!LiveVoice.chosen) 0 else 1 + voices.indexOfFirst { it.first == now }
            // (whose it is, by the voice picked: the consent names that vendor)
            val said = if (MainActivity.heyOpie(act)) "What's said after “Hey Opie”" else "What's said to Opie"
            val goes = when { toGoogle -> "$said goes to Google, on your own account."
                OwnKey.has() -> "$said goes to OpenAI, on your own account."
                else -> "$said goes to OpenAI." }
            val d = CalmDialog(act).setTitle("Voice").setMessage(goes + (credit?.let { "\n\n$it" } ?: "") + (month?.let { "\n\n$it" } ?: ""))
            // (Check the microphone and House rules are their own rows in Settings → Opie.)
            d.setNeutralButton("Your own keys") { _, _ -> ownKeys() }
                .setSingleChoiceItems((listOf("Off") + voices.map { it.second }).toTypedArray(), checked) { d, i ->
                    d.dismiss()
                    if (i == 0) { OpieChoice.set(act, false); off(); return@setSingleChoiceItems }
                    val id = voices[i - 1].first
                    OpieChoice.set(act, true)
                    thread {
                        val (_, r) = CloudSetup.post("${act.bridge}/cloud/voice/name", JSONObject().put("voice", id))
                        ui {
                            if (r == null || r.has("error")) return@ui say(r?.optString("error")?.ifEmpty { null } ?: noBridge)
                            LiveVoice.gemini = r.optString("vendor") == "Google" // (the next conversation is the new vendor's)
                            dev.openhouse.ui.Openhouse.settingsChanged()
                            if (LiveVoice.chosen) dev.openhouse.ui.Speech.say("Hi, I'm Opie. This is how I sound now.", null)
                            else turnOn() // linking first if need be; on, with Hey Opie listening
                        }
                    }
                }.setNegativeButton("Back", null).show()
        }
    }

    /** Voice → Your own keys: the household's own OpenAI key (the voice and the assistant) or Gemini key (the voice). */
    private fun ownKeys() {
        CalmDialog(act).setTitle("Your own keys")
            .setItems(arrayOf(if (OwnKey.has()) "OpenAI key" else "Add an OpenAI key", if (GeminiKey.has()) "Gemini key" else "Add a Gemini key")) { _, i -> if (i == 0) OwnKey.menu(act) else GeminiKey.menu(act) }
            .setNegativeButton("Back", null).show()
    }

    /** The household doesn't have Opie's voice yet: Ask for it (kept by the service, which emails the household once
     *  it's on: openhouse-cloud docs/beta.md), or, once asked, when. */
    private fun notYetAsk(asked: String?) {
        val d = CalmDialog(act).setTitle("Opie's voice")
        if (asked != null) return d.setMessage("$notYet You asked on ${asked.take(10)}. We'll email you when it's on.").setPositiveButton("Close", null).show().let {}
        d.setMessage("$notYet We're turning it on for households a few at a time. Ask, and we'll email you when yours is on.")
            .setPositiveButton("Ask for Opie's voice") { _, _ ->
                thread {
                    val (code, r) = CloudSetup.post("${act.bridge}/cloud/voice/ask", JSONObject())
                    ui { if (code == 200) act.toast("Asked. We'll email you when it's on") else say(r?.optString("error")?.ifEmpty { null } ?: noBridge) }
                }
            }.setNeutralButton("Use your own OpenAI key") { _, _ -> OwnKey.menu(act) }
            .setNegativeButton("Not now", null).show()
    }

    /** Voice: Off. The live voice, Hey Opie and the microphone all off. */
    private fun off() {
        set(false)
        act.setListening(false); dev.openhouse.ui.Openhouse.setWakeWord(false)
    }


    /** A voice picked in Settings: link first if the tablet isn't, then on, with Hey Opie listening. The yes is kept
     *  (OpieChoice), so if linking doesn't finish now, or the household doesn't have the voice yet, it comes on by
     *  itself once both are true (CloudSetup.autoVoice). */
    fun turnOn(): Thread = thread {
        OpieChoice.set(act, true)
        val v = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/cloud/voice?check=1", 3000, 15_000)) }.getOrNull()
        ui {
            when {
                v == null -> say(noBridge)
                // Not linked and no key: the voice needs Opie's AI, so their own key (accounts aren't offered until they're open to everyone).
                !v.optBoolean("own") && !v.optBoolean("linked") -> OwnKey.menu(act)
                // A service with credit, and none bought yet: where to add it (asking is for older services).
                v.optJSONObject("credit")?.let { !it.optBoolean("paid") } == true -> CalmDialog(act).setTitle("Opie's voice").setMessage(needsCredit)
                    .setPositiveButton("Close", null).setNeutralButton("Your own OpenAI key") { _, _ -> OwnKey.menu(act) }.show()
                v.has("available") && !v.isNull("available") && !v.optBoolean("available") -> notYetAsk(v.optString("asked").takeIf { !v.isNull("asked") && it.isNotBlank() })
                else -> set(true)
            }
        }
    }

    /** Linked, the household has the voice, and nobody here has answered yet (Without Opie at the welcome, or a tablet
     *  from before): the welcome's question once more, now that it can be on (CloudSetup.autoVoice; asked only once). A
     *  person's own yes (Opie's tap does nothing), behind the PIN when the lock is on, as Settings → Opie → Voice is. */
    fun ask() {
        if (OpieChoice.asked(act)) return
        OpieChoice.markAsked(act)
        CalmDialog(act).setForPerson().setTitle("Turn on Opie?")
            .setMessage("Opie's voice is ready for your household. Say “Hey Opie” or just type, and Opie answers. What you say after “Hey Opie” goes to OpenAI.")
            .setPositiveButton("Turn on Opie") { _, _ ->
                if (!DeviceServer.personOnly("Turning on Opie's voice")) act.lock.withPin("Turn on Opie") { OpieChoice.set(act, true); set(true) }
            }
            .setNegativeButton("Not now") { _, _ -> OpieChoice.set(act, false) }.show()
    }

    /** The setup just ended (ui/Setup.kt finish; Host.setupDone). Where Opie's voice can work (the household's own key
     *  in, or a linked tablet whose household has the voice), it's on, with Hey Opie listening, and a small dialog says
     *  so: OK, or Turn off (Settings → Opie → Voice's Off, kept: OpieChoice). Where it can't (no account and no key, or not for
     *  this household yet), nothing shows: Settings → Opie → Voice has it, and a linked household that gets it later is asked
     *  then (CloudSetup.autoVoice). The setup's Done is a person's tap; the dialog's words say what goes to OpenAI. */
    fun ready() = thread {
        if (OpieChoice.get(act) == OpieChoice.OFF) return@thread
        val v = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/cloud/voice?check=1", 3000, 15_000)) }.getOrNull() ?: return@thread
        if (!v.optBoolean("own") && !(v.optBoolean("linked") && v.optBoolean("available"))) return@thread
        val on = v.optBoolean("on") || CloudSetup.post("${act.bridge}/cloud/voice", JSONObject().put("on", true)).second?.optBoolean("on") == true
        if (!on) return@thread
        OpieChoice.set(act, true)
        ui {
            LiveVoice.chosen = true
            dev.openhouse.ui.Openhouse.settingsChanged()
            act.setListening(true); dev.openhouse.ui.Openhouse.setWakeWord(MainActivity.heyOpie(act))
            val vendor = if (v.optString("vendor") == "Google") "Google" else "OpenAI"
            CalmDialog(act).setTitle("Opie is ready").setMessage(if (MainActivity.heyOpie(act)) "Say “Hey Opie” to use it. What follows goes to $vendor." else "Tap Opie to talk. What you say goes to $vendor.")
                .setPositiveButton("OK", null)
                .setNegativeButton("Turn off") { _, _ -> OpieChoice.set(act, false); off() }.show()
        }
    }

    /** On or off here and for the household. [auto]: CloudSetup.autoVoice turning on a yes said earlier, so a refusal
     *  isn't shown (it looks again later). */
    fun set(on: Boolean, auto: Boolean = false) = thread {
        val (_, r) = CloudSetup.post("${act.bridge}/cloud/voice", JSONObject().put("on", on))
        ui {
            if (r == null || r.has("error")) {
                if (auto) return@ui
                return@ui say(if (r?.optString("error") == "not_enabled") notYet else r?.optString("error")?.ifEmpty { null } ?: noBridge)
            }
            LiveVoice.chosen = r.optBoolean("on")
            dev.openhouse.ui.Openhouse.settingsChanged()
            act.toast(if (!r.optBoolean("on")) "Live voice off" else if (auto) (if (MainActivity.heyOpie(act)) "Opie is on. Say “Hey Opie”" else "Opie is on. Tap to talk") else "Live voice on")
            if (r.optBoolean("on")) { // Hey Opie listening (or, with Tap to talk, the pill to tap), and new here: it says hello
                act.setListening(true); dev.openhouse.ui.Openhouse.setWakeWord(MainActivity.heyOpie(act))
                dev.openhouse.ui.Openhouse.assistantReady()
            }
        }
    }
}
