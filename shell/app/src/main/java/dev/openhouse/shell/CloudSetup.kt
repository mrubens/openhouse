package dev.openhouse.shell

// The cloud for beta families (openhouse-cloud/docs/cloud-beta.md), what the shell does for it on its own:
// - a setup code from the family's account page came in the setup QR (Provisioning, or ConfigReceiver for a test):
//   once the runtime is up, the tablet links itself with it (bridge /cloud/link/token). Nobody types a code.
// - nothing more is asked on the day it's linked: reaching it from away and backups are in Settings (Account, Backups).
// - whether OpenAI's live voice takes the conversation after its name (LiveVoice.chosen), from /cloud/voice, once a minute.
// - turning the voice on by itself (autoVoice) once the tablet is linked and its household has Opie's voice (the
//   cloud's voiceState.available), for a household that said yes to it here (OpieChoice "on": on at the end of the
//   setup, a voice picked in Settings, or an older welcome's Turn on Opie). One that hasn't answered yet (a household
//   that didn't have the voice when its setup ended, or a tablet from before) is asked once, with the words about
//   OpenAI (CloudVoiceMenu.ask). An Off (Settings, the end of the setup's Turn off, or from the web) stays off. Never
//   during the setup.

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
        if (trying || now < nextLinkAt) return
        trying = true
        try {
            tries++
            val (code, r) = post("$bridge/cloud/link/token", JSONObject().put("token", token).put("api", p.getString("cloud_link_api", "") ?: "").put("name", "Opie"), 45_000) // (longer than the bridge's own 30 s with the service)
            when (linkOutcome(code, r)) {
                Link.LINKED -> {
                    forget(p)
                    Log.i(TAG, "setup code: linked on try $tries")
                    tries = 0; nextLinkAt = 0
                    voiceSoon()
                    MainActivity.live?.let { act -> act.runOnUiThread { act.toast("Linked to ${r?.optString("family")?.ifEmpty { null } ?: "your family"}") } }
                }
                // The service itself said it's used, expired or not one: no use trying again.
                Link.REFUSED -> { forget(p); Log.w(TAG, "setup code: refused by the service on try $tries (${r?.optString("error")?.take(120)}); dropped"); tries = 0 }
                // Anything else (the bridge not up yet, no network, the service busy or down, a timeout): keep it, and
                // try again a little later each time, up to every five minutes, until it links.
                Link.AGAIN -> {
                    val wait = retryWaitMs(tries)
                    nextLinkAt = System.currentTimeMillis() + wait
                    val why = if (r == null) "the bridge didn't answer" else "${r.optString("code").ifEmpty { "http$code" }}: ${r.optString("error").take(120)}"
                    Log.w(TAG, "setup code: not linked on try $tries ($why); kept, again in ${wait / 1000} s")
                }
            }
        } finally { trying = false }
    }

    private const val TAG = "CloudSetup"
    @Volatile private var tries = 0
    @Volatile private var nextLinkAt = 0L
    private fun forget(p: android.content.SharedPreferences) { p.edit().remove("cloud_link_token").remove("cloud_link_api").commit() }

    /** A new setup code came in (ConfigReceiver, Provisioning): try it at the next tick. */
    fun linkSoon() { tries = 0; nextLinkAt = 0 }

    enum class Link { LINKED, REFUSED, AGAIN }

    /** What the bridge's answer to /cloud/link/token means for the setup code: dropped only once linked, or when the
     *  service itself refused it (the bridge's code "refused": used, expired, or not one). Everything else keeps it. */
    fun linkOutcome(status: Int, r: JSONObject?): Link = when {
        r == null -> Link.AGAIN
        status == 200 && r.optBoolean("linked") -> Link.LINKED
        status == 400 && r.optString("code") == "refused" -> Link.REFUSED
        else -> Link.AGAIN
    }

    /** 10 s, 20 s, 40 s… up to five minutes between tries (the service allows a few redeems an hour from one address). */
    fun retryWaitMs(tries: Int): Long = minOf(300_000L, 10_000L shl (tries - 1).coerceIn(0, 5))


    fun refreshVoice(c: Context, bridge: String) {
        val v = runCatching { JSONObject(BridgeClient.getText("$bridge/cloud/voice", 2000, 4000)) }.getOrNull() ?: return
        LiveVoice.chosen = v.optBoolean("on") && v.optString("over") != "month" && v.optString("over") != "credit"
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
                // Never during the welcome or the setup: its end decides (CloudVoiceMenu.ready). After it, the next
                // look (in five minutes) goes on as below.
                o.showWelcome || o.setupStep != null -> {}
                choice == OpieChoice.ON -> { Log.i("CloudSetup", "the household has the voice: on"); CloudVoiceMenu(act).set(true, auto = true) }
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

/** What this tablet's household said about Opie's voice (OpenAI's, through the account). [ON]: on at the end of the
 *  setup (CloudVoiceMenu.ready), a voice picked in Settings → Opie → Voice, yes to CloudVoiceMenu.ask (or an older welcome's
 *  Turn on Opie); [OFF]: Off in Settings → Opie → Voice, Turn off at the end of the setup, or the ask's Not now; null: not
 *  answered (the voice couldn't work yet when the setup ended, or a tablet from before this was kept). */
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
