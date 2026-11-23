package dev.openhouse.shell

// Settings → Voice (openhouse-cloud/docs/cloud-beta.md): OpenAI's live voice through OpenHouse cloud, off unless someone
// turns it on here after reading what goes where. The bridge does the work (bridge/cloud.js, /cloud/voice); the
// session runs in the shell (LiveVoice). Its name is heard on the tablet; nothing goes out until then.

import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import kotlin.concurrent.thread

internal class CloudVoiceMenu(private val act: MainActivity) {
    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private fun say(text: String) { CalmDialog(act).setTitle("Live voice").setMessage(text).setPositiveButton("Close", null).show() }
    private val noBridge = "The tablet's software isn't answering right now. Try again in a minute."
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
                    if (i == 0) { off(); return@setSingleChoiceItems }
                    val id = VOICES[i - 1].first
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

    /** Voice: Off. The live voice, Hey Opie and the microphone all off. */
    private fun off() {
        set(false)
        act.setListening(false); dev.openhouse.ui.Openhouse.setWakeWord(false)
    }

    // GPT-Live's voices (OpenAI's guide, "Voice options"): API name, and how it sounds. The cloud keeps the same list (LIVE_VOICES).
    private val VOICES = listOf(
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

    /** The welcome's "Turn on Opie" (its words already say what goes where): link first if the tablet isn't, then on,
     *  with Hey Opie listening. */
    fun turnOn(linkNow: Boolean = true): Thread = thread {
        val v = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/cloud/voice?check=1", 3000, 15_000)) }.getOrNull()
        ui {
            when {
                v == null -> say(noBridge)
                // In the first setup, linking waits for its phone-or-computer step (the user: "Don't need to pop the phone
                // up right away"): ui/Setup.kt asks for it there.
                !v.optBoolean("linked") && !linkNow -> dev.openhouse.ui.Setup.wantsLink = true
                !v.optBoolean("linked") -> CloudMenu(act).startLink("Opie's voice comes through your OpenHouse account.") { turnOn() }
                v.has("available") && !v.isNull("available") && !v.optBoolean("available") -> say("This tablet's cloud service doesn't offer it.")
                else -> set(true)
            }
        }
    }

    private fun set(on: Boolean) = thread {
        val (_, r) = CloudSetup.post("${act.bridge}/cloud/voice", JSONObject().put("on", on))
        ui {
            if (r == null || r.has("error")) return@ui say(r?.optString("error")?.ifEmpty { null } ?: noBridge)
            LiveVoice.chosen = r.optBoolean("on")
            dev.openhouse.ui.Openhouse.settingsChanged()
            act.toast(if (r.optBoolean("on")) "Live voice on" else "Live voice off")
            if (r.optBoolean("on")) { // Hey Opie listening (there's no button to tap), and new here: it says hello
                act.setListening(true); dev.openhouse.ui.Openhouse.setWakeWord(true)
                dev.openhouse.ui.Openhouse.assistantReady()
            }
        }
    }
}
