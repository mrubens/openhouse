package dev.openhouse.shell

// What the display and each app's own window (AppWindow) share for running the family's apps, which are web pages
// (apps/<id>/, served and hot-reloaded by the dev server): the app's web view with its key and its few shell calls,
// reporting its errors, and the swipe in from an edge that goes back.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject

/** What an app's page can ask of the shell (the kit's `phone` and `shell.close`). */
internal interface AppCalls { fun phone(kind: String, arg: String); fun close() }

/**
 * An app's key from the bridge. [shared]: the app came from a link, so it runs on an origin of its own,
 * http://<id>.localhost:<port> (device/vite.config.mjs, where the bridge takes its key: apps.js caller), reaches only
 * [reaches] (https), and gets none of the shell's own calls.
 */
internal class AppKey(val key: String, val shared: Boolean, val reaches: List<String>)

/** The origin an app's pages are on: a shared app's own, else the dev server's ([ui]). */
internal fun appOrigin(ui: String, id: String, shared: Boolean): String {
    val u = android.net.Uri.parse(ui)
    return if (shared) "${u.scheme}://$id.localhost${if (u.port > 0) ":" + u.port else ""}" else "${u.scheme}://${u.authority}"
}

/** Whether [host] is one of [reaches] ("api.example.com", "*.example.com": any name under it), as the bridge reads them. */
internal fun reachMatches(host: String, reaches: List<String>): Boolean = reaches.any { r ->
    val p = r.lowercase(); val h = host.lowercase()
    if (p.startsWith("*.")) h.endsWith(p.substring(1)) && h.length > p.length - 1 else h == p.substringBefore(':')
}

private fun refused() = android.webkit.WebResourceResponse("text/plain", "utf-8", 403, "Not for this app", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))

/**
 * An app's page in a web view. [key]: the app's own key from the bridge (it only opens the house's data, the home screen,
 * timers and speaking; apps.js), handed to the page as `window.OpenhouseApp`. Only pages from the app's own origin get
 * it, and the view never leaves for another site. A shared app's view loads nothing but its own origin and the hosts
 * its card granted (under the dev server's CSP, a second wall), and can't ask for a phone card. Errors it throws go to
 * [onError]. Its renderer going (out of memory) is answered here, so it never ends the app; the view is dropped and
 * [onRendererGone] gets it, to make a new one (RendererGone).
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
internal fun appView(ctx: Context, id: String, key: AppKey?, ui: String, calls: AppCalls, onError: (String) -> Unit, onLoadFailed: (String) -> Unit, onStarted: () -> Unit, onRendererGone: (WebView) -> Unit) = WebView(ctx).apply {
    val shared = key?.shared == true
    val origin = appOrigin(ui, id, shared)
    val ownHost = android.net.Uri.parse(origin).host ?: ""
    var here = false // the page now is the app's own (from the dev server)
    val main = Handler(Looper.getMainLooper())
    setBackgroundColor(Color.BLACK)
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.mediaPlaybackRequiresUserGesture = false
    addJavascriptInterface(object {
        @JavascriptInterface fun app(): String = if (here) id else ""
        @JavascriptInterface fun key(): String = if (here) key?.key ?: "" else ""
        @JavascriptInterface fun phone(kind: String, arg: String): Boolean { val ok = here && !shared; if (ok) main.post { calls.phone(kind, arg) }; return ok }
        @JavascriptInterface fun close() { if (here) main.post { calls.close() } }
    }, "OpenhouseApp")
    webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
            if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) onError("${m.message()} (${m.sourceId().substringAfterLast("/apps/")}:${m.lineNumber()})")
            else Log.d("App", m.message())
            return true
        }
    }
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = !r.url.toString().startsWith("$origin/apps/$id/") // stays in the app
        override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): android.webkit.WebResourceResponse? {
            if (!shared) return null
            val u = r.url; val h = u.host ?: ""
            if (h == ownHost && u.scheme == "http") return null
            if (u.scheme == "https" && reachMatches(h, key!!.reaches)) return null
            if (u.scheme == "data" || u.scheme == "blob") return null
            Log.w("App", "$id: refused ${u.scheme}://$h")
            return refused()
        }
        // A page that didn't load is never shown (the web view's own white error page): the window stays dark under its message.
        var failed = false
        override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) { if (r.isForMainFrame) { failed = true; v.visibility = View.INVISIBLE; onLoadFailed("page failed to load: ${e.description}") } }
        override fun onPageStarted(v: WebView, url: String?, b: android.graphics.Bitmap?) { failed = false; here = url?.startsWith("$origin/apps/$id/") == true; onStarted() }
        override fun onPageFinished(v: WebView, url: String?) { if (!failed) v.visibility = View.VISIBLE }
        override fun onRenderProcessGone(v: WebView, d: android.webkit.RenderProcessGoneDetail?): Boolean {
            here = false; RendererGone.drop("App", id, v, d); onRendererGone(v); return true
        }
    }
}

/** The app's key from the bridge (blocking: call off the main thread), or null when the bridge isn't up. */
internal fun appKey(bridge: String, id: String): AppKey? = runCatching {
    val j = JSONObject(dev.openhouse.ui.BridgeClient.getText("$bridge/apps/key?app=$id", 2000, 5000))
    val k = j.optString("key").ifBlank { null } ?: return@runCatching null
    val r = j.optJSONArray("reaches")
    AppKey(k, j.optBoolean("shared"), if (r == null) emptyList() else (0 until r.length()).map { r.optString(it) })
}.getOrNull()

/** Is [id] still one of the family's apps? Null: the bridge didn't answer. */
internal fun appExists(bridge: String, id: String): Boolean? = runCatching {
    val a = org.json.JSONArray(dev.openhouse.ui.BridgeClient.getText("$bridge/apps", 2000, 5000))
    (0 until a.length()).any { a.getJSONObject(it).optString("id") == id }
}.getOrNull()

/** Tell the bridge an app's page threw, so the agent's next check of it sees the error. */
internal fun reportAppError(bridge: String, app: String, text: String) = Thread {
    dev.openhouse.ui.BridgeClient.post("$bridge/apperror", JSONObject().put("app", app).put("text", text).toString(), connectMs = 2000)
}.start()

/**
 * Back by swiping in from either edge: thin strips along both sides of [parent], also where the system has no back
 * gesture (Samsung's button bar is hidden here). A swipe counts when it goes 70 dp inward and more sideways than up or down.
 */
internal fun addEdgeBack(parent: FrameLayout, onBack: () -> Unit) {
    val dp = parent.resources.displayMetrics.density
    for (side in listOf(Gravity.START, Gravity.END)) parent.addView(View(parent.context).apply {
        var x0 = 0f; var y0 = 0f
        setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { x0 = e.rawX; y0 = e.rawY }
                MotionEvent.ACTION_UP -> { val dx = e.rawX - x0; if (kotlin.math.abs(dx) > 70 * dp && kotlin.math.abs(dx) > kotlin.math.abs(e.rawY - y0) && (dx > 0) == (side == Gravity.START)) onBack() }
            }
            true
        }
    }, FrameLayout.LayoutParams((14 * dp).toInt(), -1, side))
}
