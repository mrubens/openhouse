package dev.openhouse.shell

// The tablet's health check-in to the cloud service, every five minutes once someone has linked it (the bridge
// keeps the link in display/.cloud/device.json; nothing is sent while there is none). Sent by the shell, not the
// bridge, so a bridge that has stopped answering is reported too.
//
// What it carries, and nothing else: the shell's version, how long the tablet has been up, whether the bridge and
// the assistant answer, which agent and model, free storage, the last error's type (a word like "backup.upload",
// never its text), whether backups are on and which voice was last used (the tablet's, the cloud's, or the tablet's
// because the cloud didn't answer). Never conversations, transcripts or anything the family made.

import android.content.Context
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

object CloudHealth {
    private const val TAG = "CloudHealth"
    private const val EVERY_MS = 5 * 60_000L
    @Volatile private var started = false

    fun start(ctx: Context, bridge: () -> String) {
        if (started) return
        started = true
        val app = ctx.applicationContext
        thread(name = "cloud-health", isDaemon = true) {
            Thread.sleep(60_000) // let the bridge start first
            while (true) {
                runCatching { checkIn(app, bridge()) }.onFailure { Log.d(TAG, "check-in: ${it.message}") }
                Thread.sleep(EVERY_MS)
            }
        }
    }

    private fun device(ctx: Context) = runCatching { JSONObject(File(ctx.filesDir, "display/.cloud/device.json").readText()) }.getOrNull()

    /** One check-in now (also from adb: ConfigReceiver's cloud_checkin, for testing). */
    fun checkIn(ctx: Context, bridge: String): Int? {
        val d = device(ctx) ?: return null
        val api = d.optString("api").takeIf { it.startsWith("https://") || it.startsWith("http://10.0.2.2") } ?: return null
        val bits = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("$bridge/cloud/health-bits", 3000, 5000)) }.getOrNull()
        val agent = bits?.optString("agent")?.takeIf { it.isNotEmpty() && !bits.isNull("agent") }
        // The assistant: the cloud's text model and OpenAI's live voice, once the family turned them on (bridge: agent "cloud").
        val assistant = agent == "cloud"
        val pkg = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        val body = JSONObject()
            .put("versionName", pkg.versionName ?: "")
            .put("versionCode", pkg.longVersionCode)
            .put("uptimeS", SystemClock.elapsedRealtime() / 1000)
            .put("bridge", bits != null)
            .put("assistant", assistant)
            .put("freeBytes", ctx.filesDir.usableSpace)
        if (agent != null) body.put("agent", agent)
        bits?.optString("model")?.takeIf { it.isNotEmpty() && !bits.isNull("model") }?.let { body.put("model", it) }
        bits?.optString("lastErrorType")?.takeIf { it.isNotEmpty() && !bits.isNull("lastErrorType") }?.let { body.put("lastErrorType", it) }
        bits?.optString("backups")?.takeIf { it == "on" || it == "off" }?.let { body.put("backups", it) }
        bits?.optString("voice")?.takeIf { it == "off" || it == "live" }?.let { body.put("voice", it) }
        val c = URL("$api/v1/health").openConnection() as HttpURLConnection
        return try {
            c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 10_000; c.readTimeout = 15_000
            c.setRequestProperty("content-type", "application/json")
            c.setRequestProperty("authorization", "Device " + d.optString("credential"))
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            c.responseCode.also { Log.d(TAG, "check-in: $it") } // a 401 (unlinked from the web): the bridge notices and drops the link
        } finally { c.disconnect() }
    }
}
