package dev.openhouse.shell

// The cloud for beta families (openhouse-cloud/docs/cloud-beta.md), what the shell does for it on its own:
// - a setup code from the family's account page came in the setup QR (Provisioning, or ConfigReceiver for a test):
//   once the runtime is up, the tablet links itself with it (bridge /cloud/link/token). Nobody types a code.
// - nothing more is asked on the day it's linked: reaching it from away and backups are in Settings (Account, Backups).
// - whether OpenAI's live voice takes the conversation after its name (LiveVoice.chosen), from /cloud/voice, once a minute.

import android.content.Context
import android.util.Log
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject

internal object CloudSetup {
    val TOKEN = Regex("^lhs_[A-Za-z0-9_-]{20,}$")
    @Volatile private var trying = false
    @Volatile private var voiceCheckedAt = 0L

    /** From the watchdog's thread once the runtime is ready (MainActivity). */
    fun tick(act: MainActivity) {
        val now = System.currentTimeMillis()
        if (now - voiceCheckedAt > 60_000) { voiceCheckedAt = now; refreshVoice(act.bridge) }
        val p = act.getSharedPreferences("shell", Context.MODE_PRIVATE)
        val token = p.getString("cloud_link_token", null) ?: return
        if (trying) return
        trying = true
        try {
            val (code, r) = post("${act.bridge}/cloud/link/token", JSONObject().put("token", token).put("api", p.getString("cloud_link_api", "") ?: "").put("name", "OpenHouse"))
            when {
                r == null -> {} // the bridge isn't up yet: next time
                r.optBoolean("linked") -> {
                    p.edit().remove("cloud_link_token").remove("cloud_link_api").apply()
                    Log.i("CloudSetup", "linked with the setup code")
                    act.runOnUiThread { act.toast("Linked to ${r.optString("family").ifEmpty { "your family" }}") }
                }
                // Used, expired, or not one: no use trying again. (No answer from the service: keep it and try later.)
                code == 400 && r.optString("code") in setOf("http400", "http404") -> {
                    p.edit().remove("cloud_link_token").remove("cloud_link_api").apply()
                    Log.w("CloudSetup", "setup code refused: ${r.optString("error")}")
                }
            }
        } finally { trying = false }
    }


    fun refreshVoice(bridge: String) {
        val v = runCatching { JSONObject(BridgeClient.getText("$bridge/cloud/voice", 2000, 4000)) }.getOrNull() ?: return
        LiveVoice.chosen = v.optBoolean("on") && v.optString("over") != "month"
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
