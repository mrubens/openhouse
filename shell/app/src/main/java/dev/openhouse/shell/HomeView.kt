package dev.openhouse.shell

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity

/**
 * The home screen on this tablet: the same web page other screens show (bridge/public/screen, chat/src/screen.jsx), from the
 * bridge on this device. Here it runs as the display itself: it talks to the bridge with the display's secret (no
 * pairing), and the overlay above it (the assistant's note, typing, settings) stays the shell's own. What only the
 * shell can do, the page asks through `window.OpenhouseDisplay`: open an app, the settings, the weather, a video.
 * The page is the bridge's fixed code, not the family's: their apps open in their own windows.
 */
class HomeView(private val act: ComponentActivity, private val ui: () -> String, private val bridge: () -> String) {
    val layer = FrameLayout(act).apply { setBackgroundColor(dev.openhouse.ui.Calm.PAPER) } // the home screen's paper, while its page loads
    private val main = Handler(Looper.getMainLooper())
    private val banner = TextView(act).apply {
        setBackgroundColor(dev.openhouse.ui.Calm.INK); setTextColor(dev.openhouse.ui.Calm.SHEET); textSize = 15f; typeface = dev.openhouse.ui.Calm.face(act, 500)
        setPadding(dp(24), dp(12), dp(24), dp(12)); visibility = View.GONE
    }
    private var web: WebView? = null
    private val o get() = dev.openhouse.ui.Openhouse
    private fun dp(v: Int) = (v * act.resources.displayMetrics.density).toInt()

    /**
     * What the home screen's page can ask the shell for. Android gives this object to every frame inside the page too (an
     * app's live widget, a video), and those must get nothing: so the page's own script, as it starts, says hello()
     * once and gets the display's secret and a word (the gate) that every other call must carry. A frame that comes
     * later gets an empty hello, and doesn't know the word.
     */
    private inner class Calls {
        @Volatile var ours = false
        @Volatile private var gate = ""
        @Volatile private var given = true
        fun fresh() { gate = java.util.UUID.randomUUID().toString(); given = false }
        private fun ok(g: String?) = ours && gate.isNotEmpty() && g == gate
        @JavascriptInterface fun hello(): String {
            if (!ours || given) return ""
            given = true
            return org.json.JSONObject().put("token", dev.openhouse.ui.BridgeClient.token ?: "").put("gate", gate).put("ui", ui().trimEnd('/')).toString()
        }
        @JavascriptInterface fun openApp(g: String?, id: String) { if (ok(g)) main.post { o.openApp(id) } }
        @JavascriptInterface fun settings(g: String?) { if (ok(g)) main.post { o.showSettings = true } }
        /** The Apps tab's "Add apps": OpenHouse's list of plugins (the same as Settings, Plugins); adding asks for the PIN. */
        @JavascriptInterface fun plugins(g: String?) { if (ok(g)) main.post { (act as? MainActivity)?.let { PluginsMenu(it, fromApps = true).gallery() } } }
        @JavascriptInterface fun type(g: String?) { if (ok(g)) main.post { o.openTyping() } } // the sidebar's keyboard button
        @JavascriptInterface fun sleep(g: String?) { if (ok(g)) main.post { o.sleepNow(); dev.openhouse.ui.Heartbeat.sleep() } } // the sidebar's moon
        @JavascriptInterface fun weather(g: String?) { if (ok(g)) main.post { o.showWeather = true } }
        @JavascriptInterface fun touch(g: String?) { if (ok(g)) main.post { o.touch() } }
        @JavascriptInterface fun idle(g: String?): Boolean = ok(g) && o.idle
        /** Put to sleep with "Sleep now": dark like night until touched or morning. */
        @JavascriptInterface fun sleeping(g: String?): Boolean = ok(g) && o.sleeping
        /** A text field in the page (or an app in one of its tabs, which tells the page) has the keyboard: keys go to
         *  it, not to the assistant. */
        @JavascriptInterface fun editing(g: String?, on: Boolean) { if (ok(g)) o.webEditing = on }
        /** Night, and nobody using it: the backlight goes right down (on: true), back to normal on false. */
        @JavascriptInterface fun dim(g: String?, on: Boolean) { if (ok(g)) main.post {
            val w = act.window; val a = w.attributes
            val want = if (on) 0.08f else android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            if (a.screenBrightness != want) { a.screenBrightness = want; w.attributes = a }
            o.dark = on // the voice button fades with it (Overlay.kt)
        } }
        /** Ask the assistant, as if typed (e.g. "remake this app"): the overlay shows the answer. */
        @JavascriptInterface fun ask(g: String?, text: String) { if (ok(g) && text.isNotBlank()) main.post { o.ask(text.take(500), null) } }
        /** Android apps added (Aurora Store), for the home screen: [{id: "android:<package>", name, icon}]. */
        @JavascriptInterface fun androidApps(g: String?): String = if (!ok(g)) "[]" else org.json.JSONArray(o.apps.filter { it.id.startsWith("android:") }.map {
            org.json.JSONObject().put("id", it.id).put("name", it.name).put("icon", androidIcon(it.id.removePrefix("android:")))
        }).toString()
        /** A phone card over the home, for an app in one of its tabs: "photos", "flyer", or "list" (arg: its name). */
        @JavascriptInterface fun phone(g: String?, kind: String, arg: String) { if (ok(g) && kind in setOf("photos", "flyer", "list", "recipe", "pin", "calendar", "album", "share", "google", "unlink")) main.post { when (kind) { "unlink" -> (act as? MainActivity)?.stopAlbum(arg); "share" -> (act as? MainActivity)?.sharePhotos(); "google" -> (act as? MainActivity)?.googlePhotos(); "pin" -> o.unlockCalendar(); "calendar" -> (act as? MainActivity)?.addCalendar(); "album" -> (act as? MainActivity)?.addAlbum(); else -> o.phoneCard = kind to arg.take(80) } } }
        @JavascriptInterface fun video(g: String?, url: String) { if (ok(g)) main.post { (act as? MainActivity)?.playVideo(url) } }
    }
    /** An Android app's own icon as a PNG data URL, for the home screen's page (drawn once per app). */
    private val icons = java.util.concurrent.ConcurrentHashMap<String, String>()
    private fun androidIcon(pkg: String): String? = icons[pkg] ?: runCatching {
        val d = act.packageManager.getApplicationIcon(pkg)
        val px = 192
        val b = android.graphics.Bitmap.createBitmap(px, px, android.graphics.Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, px, px); d.draw(android.graphics.Canvas(b))
        val out = java.io.ByteArrayOutputStream(); b.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
        "data:image/png;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
    }.getOrNull()?.also { icons[pkg] = it }
    private val calls = Calls()

    fun start() {
        if (web != null) return
        layer.addView(make(), 0, FrameLayout.LayoutParams(-1, -1))
        layer.addView(banner, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        load()
    }

    /** The activity is going: the page stops too (else it keeps running, hidden, polling and placing things). */
    fun destroy() { web?.let { it.stopLoading(); it.loadUrl("about:blank"); it.destroy() }; web = null }

    /** Settings: load the home screen again. */
    fun reload() = load()

    private fun load() { web?.loadUrl(bridge().trimEnd('/') + "/screen/?display") }
    private val again = Runnable { load() }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun make() = WebView(act).also { w ->
        web = w
        w.setBackgroundColor(dev.openhouse.ui.Calm.PAPER)
        w.visibility = View.INVISIBLE // until the home screen's page has loaded
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.mediaPlaybackRequiresUserGesture = false
        w.addJavascriptInterface(calls, "OpenhouseDisplay")
        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { Log.d(TAG, "${m.messageLevel()} ${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})"); return true }
        }
        w.webViewClient = object : WebViewClient() {
            private fun ours(url: String?) = url?.startsWith(bridge().trimEnd('/') + "/screen/") == true
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = !ours(r.url.toString()) // the home screen never leaves for another page
            // A frame in the home screen is one of the apps (this device's servers) or a video: never another site, which an
            // app's frame could otherwise go to with what it read in its address. (What the pages fetch is the CSP's.)
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): android.webkit.WebResourceResponse? {
                if (r.isForMainFrame || r.requestHeaders.entries.none { it.key.equals("Accept", true) && it.value.startsWith("text/html") }) return null
                val h = r.url.host?.lowercase() ?: return null
                if (r.url.scheme == "http" && (h == "127.0.0.1" || h == "localhost" || h.endsWith(".localhost") || h == "10.0.2.2")) return null
                if (r.url.scheme == "https" && (h == "www.youtube-nocookie.com" || h == "www.youtube.com")) return null // the Recipes app's and the answers' videos
                Log.w(TAG, "refused a frame on $h")
                return android.webkit.WebResourceResponse("text/plain", "utf-8", 403, "Not here", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
            }
            // The page shows only once it has loaded: until then (the bridge is still starting, or just restarted) it's
            // the home screen's plain color, never the web view's own white "webpage not available" page.
            private var failed = false
            private fun retry(why: String) {
                Log.w(TAG, "homeScreen didn't load: $why") // try again shortly
                failed = true; v().visibility = View.INVISIBLE
                main.removeCallbacks(again); main.postDelayed(again, 2000)
            }
            private fun v() = web!!
            override fun onPageStarted(v: WebView, url: String?, b: android.graphics.Bitmap?) { calls.ours = ours(url); calls.fresh(); failed = false; banner.visibility = View.GONE }
            override fun onPageFinished(v: WebView, url: String?) { if (!failed && ours(url)) { v.visibility = View.VISIBLE; Updater.homeLoaded = true } }
            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) { if (r.isForMainFrame) retry(e.description.toString()) }
            override fun onReceivedHttpError(v: WebView, r: WebResourceRequest, e: android.webkit.WebResourceResponse) { if (r.isForMainFrame) retry("HTTP ${e.statusCode}") }
        }
    }

    companion object { const val TAG = "HomeView" }
}
