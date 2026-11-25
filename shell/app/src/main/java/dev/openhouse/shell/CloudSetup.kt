package dev.openhouse.shell

// The cloud for beta families (openhouse-cloud/docs/cloud-beta.md), what the shell does for it on its own:
// - a setup code from the family's account page came in the setup QR (Provisioning, or ConfigReceiver for a test):
//   once the runtime is up, the tablet links itself with it (bridge /cloud/link/token). Nobody types a code.
// - nothing more is asked on the day it's linked: reaching it from away and backups are in Settings (Account, Backups).
// - whether OpenAI's live voice takes the conversation after its name (LiveVoice.chosen), from /cloud/voice, once a minute.
// - turning the voice on by itself (autoVoice) once the tablet is linked and its household has Opie's voice (the
//   cloud's voiceState.available), for a household that said yes to it here (OpieChoice "on": the welcome's Turn on
//   Opie, a voice picked in Settings). One that hasn't answered yet (Without Opie, or a tablet from before) is asked
//   once, with the welcome's words about OpenAI (CloudVoiceMenu.ask). An Off, here or from the web, stays off.

import android.content.Context
import android.util.Log
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject

internal object CloudSetup {
    val TOKEN = Regex("^lhs_[A-Za-z0-9_-]{20,}$")
    @Volatile private var trying = false
    @Volatile private var voiceCheckedAt = 0L
    /** When the cloud was last asked whether the household has the voice (autoVoice): every five minutes at most. */
    @Volatile private var cloudVoiceAt = 0L
    @Volatile private var wasLinked: Boolean? = null
    private const val CLOUD_VOICE_EVERY_MS = 5 * 60_000L

    /** Just linked (Settings → Account, the setup's code): look at the voice at the next tick, not in a minute. */
    fun voiceSoon() { voiceCheckedAt = 0; cloudVoiceAt = 0 }

    /** From the watchdog's thread once the runtime is ready (Watchdog). */
    fun tick(c: Context, bridge: String) {
        val now = System.currentTimeMillis()
        if (now - voiceCheckedAt > 60_000) { voiceCheckedAt = now; refreshVoice(c, bridge) }
        val p = c.getSharedPreferences("shell", Context.MODE_PRIVATE)
        val token = p.getString("cloud_link_token", null) ?: return
        if (trying) return
        trying = true
        try {
            val (code, r) = post("$bridge/cloud/link/token", JSONObject().put("token", token).put("api", p.getString("cloud_link_api", "") ?: "").put("name", "Opie"))
            when {
                r == null -> {} // the bridge isn't up yet: next time
                r.optBoolean("linked") -> {
                    p.edit().remove("cloud_link_token").remove("cloud_link_api").apply()
                    Log.i("CloudSetup", "linked with the setup code")
                    voiceSoon()
                    MainActivity.live?.let { act -> act.runOnUiThread { act.toast("Linked to ${r.optString("family").ifEmpty { "your family" }}") } }
                }
                // Used, expired, or not one: no use trying again. (No answer from the service: keep it and try later.)
                code == 400 && r.optString("code") in setOf("http400", "http404") -> {
                    p.edit().remove("cloud_link_token").remove("cloud_link_api").apply()
                    Log.w("CloudSetup", "setup code refused: ${r.optString("error")}")
                }
            }
        } finally { trying = false }
    }


    fun refreshVoice(c: Context, bridge: String) {
        val v = runCatching { JSONObject(BridgeClient.getText("$bridge/cloud/voice", 2000, 4000)) }.getOrNull() ?: return
        LiveVoice.chosen = v.optBoolean("on") && v.optString("over") != "month"
        runCatching { autoVoice(c, bridge, v) }.onFailure { Log.d("CloudSetup", "voice: ${it.message}") }
    }

    private fun offWhy(v: JSONObject) = v.optString("offWhy").takeIf { it.isNotEmpty() && !v.isNull("offWhy") }

    /** Linked, off, and not turned off on purpose: ask the cloud (now if it was just linked, else every five minutes)
     *  whether the household has the voice, and once it does, turn it on, or ask the once. */
    private fun autoVoice(c: Context, bridge: String, local: JSONObject) {
        val linked = local.optBoolean("linked")
        val justLinked = linked && wasLinked == false
        wasLinked = linked
        if (!linked || local.optBoolean("on") || offWhy(local) != null) return
        val choice = OpieChoice.get(c)
        if (choice == OpieChoice.OFF || (choice == null && OpieChoice.asked(c))) return
        val now = System.currentTimeMillis()
        if (!justLinked && now - cloudVoiceAt < CLOUD_VOICE_EVERY_MS) return
        cloudVoiceAt = now
        val v = runCatching { JSONObject(BridgeClient.getText("$bridge/cloud/voice?check=1", 3000, 15_000)) }.getOrNull() ?: return
        if (!v.optBoolean("linked") || v.optBoolean("on") || offWhy(v) != null || v.isNull("available") || !v.optBoolean("available")) return
        val act = MainActivity.live ?: return
        act.runOnUiThread {
            val o = dev.openhouse.ui.Openhouse
            when {
                choice == OpieChoice.ON -> { Log.i("CloudSetup", "the household has the voice: on"); CloudVoiceMenu(act).set(true, auto = true) }
                // The welcome is the same question, and the setup is busy: after them (the next look, in five minutes).
                o.showWelcome || o.setupStep != null -> {}
                else -> CloudVoiceMenu(act).ask()
            }
        }
    }

    /** POST to the bridge: its status and answer (with "error" on a refusal), or null if it didn't answer. */
    fun post(url: String, body: JSONObject, readMs: Int = 30_000): Pair<Int, JSONObject?> = runCatching {
        val c = BridgeClient.open(url)
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = readMs
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = c.responseCode
        code to JSONObject((if (code < 400) c.inputStream else c.errorStream).use { it.readBytes().toString(Charsets.UTF_8) })
    }.getOrElse { 0 to null }
}

/** What this tablet's household said about Opie's voice (OpenAI's, through the account). [ON]: the welcome's Turn on
 *  Opie, a voice picked in Settings → Voice, or yes to CloudVoiceMenu.ask; [OFF]: Off in Settings → Voice, or Not now;
 *  null: not answered (Without Opie at the welcome, or a tablet from before this was kept). */
internal object OpieChoice {
    const val ON = "on"
    const val OFF = "off"
    private fun p(c: Context) = c.getSharedPreferences("shell", Context.MODE_PRIVATE)
    fun get(c: Context): String? = p(c).getString("opie_choice", null)
    fun set(c: Context, on: Boolean) { p(c).edit().putString("opie_choice", if (on) ON else OFF).apply() }
    /** The once (CloudVoiceMenu.ask) was shown. */
    fun asked(c: Context) = p(c).getBoolean("opie_asked", false)
    fun markAsked(c: Context) { p(c).edit().putBoolean("opie_asked", true).apply() }
}
