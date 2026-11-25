package dev.openhouse.shell

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.ImageView
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * "Add photos from Google": Google Photos through Google's Picker API (docs/photos.md). Behind the PIN, the
 * tablet shows a QR code for its own page (assets/google.html) on the home Wi-Fi; the phone signs in to Google
 * through Opie's cloud (which holds the OAuth client's secret, /g/start) and hands the access token back here,
 * sealed. Here: a picking session with Google, its link to the phone, and once they've picked, each photo copied
 * straight from Google into the household's photos. The token lives only in this object, in memory, for this one
 * run (an hour at most, no refresh token), and goes when it's done or the card closes.
 */
object GooglePhotos {
    private const val TAG = "GooglePhotos"
    private const val API = "https://photospicker.googleapis.com/v1"
    private const val MAX = 300
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var state = JSONObject().put("state", "start")
    @Volatile private var token: String? = null
    @Volatile private var link: String? = null // the phone's way to Google's sign-in, made when it taps Sign in
    @Volatile private var run = 0

    fun show(a: Activity, immersive: () -> Unit) {
        thread {
            val cloud = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText(bridge() + "/cloud/status")).optString("api") }.getOrNull()?.trimEnd('/')
                ?.takeIf { it.startsWith("https://") || it.startsWith("http://localhost") || it.startsWith("http://10.0.2.2") }
            main.post { card(a, immersive, cloud) }
        }
    }

    private fun card(a: Activity, immersive: () -> Unit, cloud: String?) {
        val me = ++run
        token = null; link = null; state = JSONObject().put("state", "start")
        var self: String? = null // this page's own address, where the sign-in comes back to
        var dialog: android.app.Dialog? = null
        // Beside the code: what to do on the phone, and a line that follows along (waiting, picking, copying, done).
        val status = Calm.text(a, "Waiting for a phone…", 20f, 500, Calm.SOFT)
        val stepViews = listOf("Scan the code with a phone on this Wi-Fi", "Sign in to Google", "Pick the photos for the tablet").mapIndexed { i, t -> step(a, i + 1, t) }
        fun at(n: Int, line: String) = main.post {
            status.text = line
            stepViews.forEachIndexed { i, v -> v.alpha = if (n < 0 || i >= n) 1f else .4f } // done steps fade
        }
        val h = Handoff(a, JSONObject(), minutes = 30, page = "google.html", maxBytes = 8192, once = false,
            infoNow = { JSONObject(state.toString()).apply { if (cloud != null) put("cloud", cloud); link?.let { put("signin", it) } } },
            onData = { bytes ->
                val j = JSONObject(String(bytes, Charsets.UTF_8))
                if (j.optBoolean("start")) { link = signInLink(self ?: throw IllegalStateException("no page"), cal = false) ?: throw IllegalStateException("no link"); return@Handoff }
                val t = j.optString("token").takeIf { it.length in 20..4096 } ?: throw IllegalArgumentException("no token")
                if (run == me) { token = t; at(2, "Signed in. Pick the photos on the phone."); thread(name = "google-photos") { pickAndCopy(me) { n, s -> at(n, s) } } }
            },
            onEnd = { dialog?.dismiss() })
        if (!h.start()) { CalmDialog(a).setTitle("Connect the tablet to Wi-Fi first.").setPositiveButton("Close", null).show().also { immersive() }; return }
        self = h.url!!.substringBefore('#')
        if (cloud == null) status.text = "Google Photos isn't available right now."
        val qr = ImageView(a).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
        val steps = Calm.column(a, 22).apply { stepViews.forEach { addView(it) }; addView(Calm.gap(a, 0, 6)); addView(status) }
        val body = Calm.row(a, 48).apply {
            gravity = android.view.Gravity.CENTER_VERTICAL
            addView(Calm.qr(a, qr, null, 300))
            addView(steps, android.widget.LinearLayout.LayoutParams(0, -2, 1f))
        }
        dialog = CalmDialog(a).setTitle("Photos from Google Photos").setWidth(900f).setView(body)
            .setNegativeButton("Close", null)
            .setOnDismissListener { h.stop(); if (run == me) { run++; token = null } }
            .show().also { immersive() }
    }

    /** One numbered step: a small round number and its words. */
    private fun step(a: Activity, n: Int, t: String) = Calm.row(a, 18).apply {
        val d = Calm.px(a, 40)
        addView(Calm.text(a, n.toString(), 18f, 600).apply { gravity = android.view.Gravity.CENTER; background = Calm.rounded(Calm.TINT, d / 2f) }, android.widget.LinearLayout.LayoutParams(d, d))
        addView(Calm.text(a, t, 22f, 400), android.widget.LinearLayout.LayoutParams(0, -2, 1f))
    }

    /** The session: made, its link to the phone, waited on, then the photos copied and the session deleted. */
    private fun pickAndCopy(me: Int, say: (Int, String) -> Unit) {
        val t = token ?: return
        var session: String? = null
        try {
            val s = JSONObject(call("POST", "$API/sessions", t, "{}"))
            session = s.getString("id")
            state = JSONObject().put("state", "picking").put("pickerUri", s.getString("pickerUri"))
            say(2, "Signed in. Pick the photos on the phone.")
            val every = (s.optJSONObject("pollingConfig")?.optString("pollInterval")?.removeSuffix("s")?.toDoubleOrNull() ?: 5.0).coerceIn(2.0, 30.0)
            val until = System.currentTimeMillis() + 25 * 60_000L
            while (true) {
                if (run != me) return
                if (System.currentTimeMillis() > until) throw Said("That took too long. Start again from the phone.")
                Thread.sleep((every * 1000).toLong())
                if (JSONObject(call("GET", "$API/sessions/$session", t)).optBoolean("mediaItemsSet")) break
            }
            val items = mutableListOf<String>() // base URLs of the photos picked
            var page: String? = null
            do {
                val j = JSONObject(call("GET", "$API/mediaItems?sessionId=$session&pageSize=100" + (page?.let { "&pageToken=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""), t))
                val list = j.optJSONArray("mediaItems")
                if (list != null) for (i in 0 until list.length()) {
                    val m = list.getJSONObject(i)
                    if (m.optString("type") == "PHOTO") m.optJSONObject("mediaFile")?.optString("baseUrl")?.takeIf { it.startsWith("https://") }?.let { items += it }
                }
                page = j.optString("nextPageToken").takeIf { it.isNotEmpty() }
            } while (page != null && items.size < MAX)
            val todo = items.take(MAX)
            var done = 0
            state = JSONObject().put("state", "copying").put("done", 0).put("total", todo.size)
            for (u in todo) {
                if (run != me) return
                val bytes = runCatching { get("$u=w2400-h2400", t) }.getOrNull()
                if (bytes != null && dev.openhouse.ui.House.addPhoto(bytes, "google.jpg")) done++
                state = JSONObject().put("state", "copying").put("done", done).put("total", todo.size)
                say(3, "Copying $done of ${todo.size} to Photos…")
            }
            state = JSONObject().put("state", "done").put("done", done).put("total", todo.size)
            say(-1, if (todo.isEmpty()) "Nothing was picked. Pick again on the phone." else "Added $done ${if (done == 1) "photo" else "photos"} to Photos.")
            Log.i(TAG, "copied $done of ${todo.size}")
        } catch (e: Exception) {
            state = JSONObject().put("state", "error").put("error", (e as? Said)?.message ?: "Google didn't answer. Try again.")
            say(-1, state.optString("error"))
            Log.w(TAG, "picker: ${e.javaClass.simpleName}") // never the token
        } finally {
            session?.let { id -> runCatching { call("DELETE", "$API/sessions/$id", t) } }
            if (token == t) token = null // gone: a new sign-in for more
        }
    }

    private class Said(m: String) : Exception(m)

    private fun open(method: String, url: String, t: String): HttpURLConnection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = method; connectTimeout = 15_000; readTimeout = 60_000; instanceFollowRedirects = true
        setRequestProperty("Authorization", "Bearer $t")
    }

    private fun call(method: String, url: String, t: String, body: String? = null): String {
        val c = open(method, url, t)
        try {
            if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
            val code = c.responseCode
            if (code == 401 || code == 403) throw Said("Google said no. Sign in again from the phone.")
            if (code !in 200..299) throw Said("Google said $code. Try again.")
            return c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } finally { c.disconnect() }
    }

    private fun get(url: String, t: String): ByteArray {
        val c = open("GET", url, t)
        try {
            if (c.responseCode != 200 || c.contentType?.startsWith("image/") != true) throw Said("no image")
            return c.inputStream.use { s -> val o = java.io.ByteArrayOutputStream(); val buf = ByteArray(16384); var n = 0
                while (true) { val r = s.read(buf); if (r < 0) break; n += r; if (n > 25_000_000) throw Said("too big"); o.write(buf, 0, r) }; o.toByteArray() }
        } finally { c.disconnect() }
    }

    /** A Google sign-in for the phone page at [page] (its own address, http://<tablet>:<port>/) and its kind: the cloud's
     *  one-time link for the phone to open, asked through the bridge (which holds the tablet's credential), or null. */
    internal fun signInLink(page: String, cal: Boolean): String? = runCatching {
        // On an emulator the "phone" is a computer reaching the page through adb (Handoff): Google comes back to localhost.
        val back = if (android.os.Build.HARDWARE == "ranchu") page.replace(Regex("^http://[^:/]+"), "http://localhost") else page
        val body = JSONObject().put("r", back).apply { if (cal) put("k", "cal") }
        JSONObject(dev.openhouse.ui.BridgeClient.post(bridge() + "/cloud/google/start", body.toString()) ?: return null).optString("url")
            .takeIf { it.startsWith("https://") || it.startsWith("http://") }
    }.getOrNull()

    private fun bridge(): String = runCatching { dev.openhouse.ui.Openhouse.bridgeUrl }.getOrDefault("http://127.0.0.1:8787")
}
