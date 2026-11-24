package dev.openhouse.shell

// The family's apps and games, opened from the display. Each is its own installed Android app (AppStubs: its own
// icon, task and back gesture) where the display is device owner; otherwise, or if its app window can't be made, it
// opens here, in a full-screen layer over the home screen. Either way it's a web page from the dev server (WebApps.kt).

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.concurrent.thread

internal class AppHost(private val act: Activity, private val bridge: () -> String, private val uiUrl: () -> String) {
    private val main = Handler(Looper.getMainLooper())
    private fun dp(v: Int) = (v * act.resources.displayMetrics.density).toInt()
    private val o get() = dev.openhouse.ui.Openhouse

    /** The layer apps open in over the home screen (with the error banner at the top). */
    val layer = FrameLayout(act).apply { setBackgroundColor(dev.openhouse.ui.Calm.PAPER); visibility = View.GONE; isClickable = true }
    private val banner = TextView(act).apply {
        setBackgroundColor(dev.openhouse.ui.Calm.INK); setTextColor(dev.openhouse.ui.Calm.SHEET); textSize = 16f; typeface = dev.openhouse.ui.Calm.face(act, 500)
        setPadding(dp(24), dp(14), dp(24), dp(14)); visibility = View.GONE
    }
    /** Views at the top of [layer] that stay: the banner and the two back strips. Apps go underneath them. */
    private val fixedViews = 3

    init {
        layer.addView(banner, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        // No Home button over the app: the back gesture (swipe in from either edge) returns to the home screen. The system
        // handles it where gesture navigation is on; these thin strips do the same where it isn't.
        addEdgeBack(layer) { close() }
    }

    /** The app open here (not in its own window), or null. */
    var appId: String? = null
        private set(v) { field = v; o.appOpen = v != null } // the overlay redraws (the assistant tucks away over apps)
    /** The family app open in its own installed Android app, until the display is back in front. */
    var stubAppId: String? = null
    init { AppStubs.onReopened = { stubAppId = it } }
    private var stubOpening: String? = null
    private var web: WebView? = null
    private var lastError = ""

    /** Open a family app: in its own window, else here. [onShown]: it's on screen here (bring the overlay above it). */
    fun open(id: String, onShown: () -> Unit) { if (!openStub(id, onShown)) openHere(id, onShown) }

    private fun openHere(id: String, onShown: () -> Unit) {
        if (appId == id) return
        destroy(); appId = id
        layer.visibility = View.VISIBLE
        layer.bringToFront(); onShown()
        thread {
            val key = appKey(bridge(), id)
            main.post {
                if (appId != id) return@post
                val w = appView(act, id, key, uiUrl(), object : AppCalls {
                    override fun phone(kind: String, arg: String) {} // phone pages open from an app's own window
                    override fun close() { this@AppHost.close() }
                }, onError = { error(id, it) }, onLoadFailed = { error(id, it) }, onStarted = { banner.visibility = View.GONE })
                layer.addView(w, 0, FrameLayout.LayoutParams(-1, -1))
                web = w
                w.loadUrl(appOrigin(uiUrl(), id, key?.shared == true) + "/apps/$id/")
            }
        }
    }

    /**
     * Open a family app as its own Android app: its stub, made and installed first if needed (about a second).
     * False when this display doesn't make stubs (not device owner); then it opens here.
     */
    private fun openStub(id: String, onShown: () -> Unit): Boolean {
        if (!AppStubs.enabled()) return false
        if (appId != null) close()
        if (stubOpening == id) return true
        val info = o.apps.firstOrNull { it.id == id }
        val extras = mapOf("bridge" to bridge(), "ui" to uiUrl(), "token" to BridgeToken.get(act))
        stubOpening = id
        thread(name = "stub-$id") {
            // A brand-new app (the agent just wrote it) may not be in the home screen's list yet: read its app.json, so the
            // stub gets its real name and icon now instead of being reinstalled (and closed) a minute later.
            val entry = if (info != null) null else runCatching {
                val a = org.json.JSONArray(dev.openhouse.ui.BridgeClient.getText("${bridge()}/apps", 1000, 5000))
                (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optString("id") == id }
            }.getOrNull()
            val meta = entry?.optJSONObject("meta")
            val spec = AppStubs.Spec(id, info?.name ?: meta?.optString("name")?.takeIf { it.isNotBlank() } ?: id.replace('-', ' ').replaceFirstChar { it.uppercase() },
                o.stickerColor(id), info?.icon ?: entry?.optString("icon")?.ifBlank { null })
            val err = if (AppStubs.upToDate(spec)) null else AppStubs.ensure(spec)
            main.post {
                stubOpening = null
                if (err == null && AppStubs.launch(id, extras)) { stubAppId = id; return@post }
                Log.w(TAG, "no app window for $id ($err); opening it in the display")
                openHere(id, onShown)
            }
        }
        return true
    }

    fun close() {
        destroy(); appId = null
        layer.visibility = View.GONE
    }

    private fun destroy() {
        web?.let { it.stopLoading(); it.loadUrl("about:blank"); it.destroy() }; web = null
        while (layer.childCount > fixedViews) layer.removeViewAt(0)
        banner.visibility = View.GONE
    }

    /** An app's page threw: show it, and tell the bridge (its fix loop sends it back to the agent). */
    private fun error(id: String, msg: String) {
        Log.w(TAG, "app $id: $msg")
        if (appId != id) return
        banner.text = "The app hit an error: $msg\nAsk to fix it, or swipe back.".lines().take(4).joinToString("\n")
        banner.visibility = View.VISIBLE
        if (msg != lastError) { lastError = msg; o.appCrashed(id, msg) }
        reportAppError(bridge(), id, msg)
    }

    companion object { const val TAG = "Shell" }
}
