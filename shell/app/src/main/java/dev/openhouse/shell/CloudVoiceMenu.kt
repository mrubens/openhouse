package dev.openhouse.shell

// Settings → Voice (openhouse-cloud/docs/cloud-beta.md): OpenAI's live voice through Opie cloud, off unless someone
// turns it on here after reading what goes where. The bridge does the work (bridge/cloud.js, /cloud/voice); the
// session runs in the shell (LiveVoice). Its name is heard on the tablet; nothing goes out until then.
// What the household said here is kept (OpieChoice), so a yes made before the tablet was linked, or before its
// household had the voice, turns it on by itself later (CloudSetup.autoVoice). The first setup's last step turns it
// on too (fromSetup), and its Not now is kept the same way.

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
    }

    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private fun say(text: String) { CalmDialog(act).setTitle("Live voice").setMessage(text).setPositiveButton("Close", null).show() }
    private val noBridge = "The tablet's software isn't answering right now. Try again in a minute."
    /** The household's account doesn't have Opie's voice yet (the cloud's voiceState.available, or its not_enabled). */
    private val notYet = "Opie's voice isn't on for your household yet. It turns on here by itself as soon as it is."
    private fun n(x: Int) = String.format(java.util.Locale.US, "%,d", x)

    /** Settings → Voice (behind the PIN Lock when it is on; openhouse-cloud/docs/cloud-beta.md): Off, or which of OpenAI's voices it speaks with. Heard from the next
     *  conversation, so it says hello in it at once (a short session just to say it). */
    fun chooseVoice() = thread {
        val now = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/cloud/voice", 3000, 8000)).optString("voiceName") }.getOrNull()
        ui {
            if (now == null) return@ui say(noBridge)
            val checked = if (!LiveVoice.chosen) 0 else 1 + VOICES.indexOfFirst { it.first == now }
            CalmDialog(act).setTitle("Voice").setMessage("What's said after “Hey Opie” goes to OpenAI.")
                .setSingleChoiceItems((listOf("Off") + VOICES.map { it.second }).toTypedArray(), checked) { d, i ->
                    d.dismiss()
                    if (i == 0) { OpieChoice.set(act, false); off(); return@setSingleChoiceItems }
                    val id = VOICES[i - 1].first
                    OpieChoice.set(act, true)
                    thread {
                        val (_, r) = CloudSetup.post("${act.bridge}/cloud/voice/name", JSONObject().put("voice", id))
                        ui {
                            if (r == null || r.has("error")) return@ui say(r?.optString("error")?.ifEmpty { null } ?: noBridge)
                            dev.openhouse.ui.Openhouse.settingsChanged()
                            if (LiveVoice.chosen) dev.openhouse.ui.Speech.say("Hi, I'm Opie. This is how I sound now.", null)
                            else turnOn() // linking first if need be; on, with Hey Opie listening
                        }
                    }
                }.setNegativeButton("Back", null).show()
        }
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
            }.setNegativeButton("Not now", null).show()
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
                !v.optBoolean("linked") -> CloudMenu(act).startLink("Opie's voice comes through your Opie account.") { turnOn() }
                v.has("available") && !v.isNull("available") && !v.optBoolean("available") -> notYetAsk(v.optString("asked").takeIf { !v.isNull("asked") && it.isNotBlank() })
                else -> set(true)
            }
        }
    }

    /** Linked, the household has the voice, and nobody here has answered yet (Without Opie at the welcome, or a tablet
     *  from before): the welcome's question once more, now that it can be on (CloudSetup.autoVoice; asked only once). A
     *  person's own yes (Opie's tap does nothing), behind the PIN when the lock is on, as Settings → Voice is. */
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

    /** The setup's last step (ui/Setup.kt VoiceStep; Host.setupVoice). "on": the step's Turn on Opie's voice, whose
     *  words say what goes to OpenAI, a person's tap (Opie's does nothing) behind the PIN when the lock is on, as
     *  Settings → Voice is: [voice] chosen, then on, with Hey Opie listening. "off": Not now, kept (OpieChoice), so it
     *  isn't turned on by itself later. "sample": on already, [voice] chosen and a line said in it (the session going
     *  ends first: a session keeps the voice it started with). "link": linking the tablet to an account. [done]: "on",
     *  "notYet", or what went wrong, to show. */
    fun fromSetup(action: String, voice: String, done: (String) -> Unit) {
        val named = { thread { CloudSetup.post("${act.bridge}/cloud/voice/name", JSONObject().put("voice", voice)) } }
        when (action) {
            "off" -> OpieChoice.set(act, false)
            "link" -> CloudMenu(act).startLink("Opie's voice comes through your Opie account.")
            "sample" -> if (LiveVoice.chosen) thread {
                val (_, r) = CloudSetup.post("${act.bridge}/cloud/voice/name", JSONObject().put("voice", voice))
                if (r != null && !r.has("error")) ui { LiveVoice.stopNow(); dev.openhouse.ui.Speech.say("Hi, I'm Opie. This is how I sound.", null) }
            }
            "on" -> {
                if (DeviceServer.personOnly("Turning on Opie's voice")) return done("Turning on the voice is for a person to tap.")
                val go: () -> Unit = {
                    OpieChoice.set(act, true)
                    thread {
                        named().join()
                        val (_, r) = CloudSetup.post("${act.bridge}/cloud/voice", JSONObject().put("on", true))
                        ui {
                            when {
                                r == null -> done(noBridge)
                                r.optString("error") == "not_enabled" -> done("notYet")
                                r.has("error") -> done(r.optString("error").ifEmpty { noBridge })
                                !r.optBoolean("on") -> done("notYet")
                                else -> {
                                    LiveVoice.chosen = true
                                    dev.openhouse.ui.Openhouse.settingsChanged()
                                    act.setListening(true); dev.openhouse.ui.Openhouse.setWakeWord(true)
                                    done("on")
                                }
                            }
                        }
                    }
                }
                // The PIN box closed without it: the step's button comes back.
                if (act.lock.on) PinPrompt.ask(act, act, "Turn on Opie", go, cancelled = { done("") }) else go()
            }
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
            act.toast(if (!r.optBoolean("on")) "Live voice off" else if (auto) "Opie is on. Say “Hey Opie”" else "Live voice on")
            if (r.optBoolean("on")) { // Hey Opie listening (there's no button to tap), and new here: it says hello
                act.setListening(true); dev.openhouse.ui.Openhouse.setWakeWord(true)
                dev.openhouse.ui.Openhouse.assistantReady()
            }
        }
    }
}
