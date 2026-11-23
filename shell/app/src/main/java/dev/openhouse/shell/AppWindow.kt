package dev.openhouse.shell

import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import kotlin.concurrent.thread

/**
 * Runs one family app inside its own installed Android app (the stub made by [AppStubs]). This code is the shell's,
 * loaded by the stub's activity into the stub's process, so it updates with the display and the stubs never need
 * reinstalling.
 *
 * The app is a web page from the dev server, which reloads it as the agent edits it. It gets its own key to the house's
 * data (appView). Errors go to the bridge, whose fix loop hands them to the agent. Back is the system's: the stub is an
 * ordinary app, so back returns to the display.
 */
class AppWindow private constructor(private val act: Activity, private val shell: Context, private val id: String) :
    Application.ActivityLifecycleCallbacks, LifecycleOwner, SavedStateRegistryOwner {

    companion object {
        private const val TAG = "AppWindow"
        /** Called by the stub (dev.openhouse.stub.StubActivity) from its onCreate. */
        @JvmStatic fun attach(act: Activity, shell: Context, id: String) { AppWindow(act, shell, id).start() }
    }

    private val main = Handler(Looper.getMainLooper())
    private val prefs = act.getSharedPreferences("openhouse", Context.MODE_PRIVATE)
    private val bridge get() = prefs.getString("bridge", null) ?: "http://127.0.0.1:8787"
    private val ui get() = prefs.getString("ui", null) ?: "http://127.0.0.1:5173/"

    private val root = FrameLayout(act).apply { setBackgroundColor(dev.openhouse.ui.Calm.PAPER) }
    private val content = FrameLayout(act)
    private val banner = TextView(act).apply {
        setBackgroundColor(dev.openhouse.ui.Calm.INK); setTextColor(dev.openhouse.ui.Calm.SHEET); textSize = 18f
        setPadding(32, 20, 32, 20); visibility = View.GONE
    }
    private var web: WebView? = null
    private var sheet: View? = null
    private var watching = false
    private var lastError = ""

    private val reg = LifecycleRegistry(this)
    private val saved = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = reg
    override val savedStateRegistry: SavedStateRegistry get() = saved.savedStateRegistry

    private fun start() {
        act.intent?.let { i -> listOf("bridge", "ui").forEach { k -> i.getStringExtra(k)?.takeIf(::localUrl)?.let { prefs.edit().putString(k, it).apply() } } } // anyone can start a stub: only this device's servers
        act.intent?.getStringExtra("token")?.takeIf { Regex("[0-9a-f]{48}").matches(it) }?.let { prefs.edit().putString("token", it).apply() } // the bridge's secret (from the display)
        dev.openhouse.ui.BridgeClient.token = prefs.getString("token", null)
        saved.performRestore(null)
        reg.currentState = Lifecycle.State.CREATED
        act.registerActivityLifecycleCallbacks(this)
        root.setViewTreeLifecycleOwner(this); root.setViewTreeSavedStateRegistryOwner(this)
        root.addView(content, FrameLayout.LayoutParams(-1, -1))
        // Swipe in from either edge to go back, also where the system has no back gesture (Samsung's button bar is hidden here).
        addEdgeBack(root) { if (!closeSheet()) (act as? androidx.activity.ComponentActivity)?.onBackPressedDispatcher?.onBackPressed() ?: @Suppress("DEPRECATION") act.onBackPressed() }
        root.addView(banner, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        act.setContentView(root)
        act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        runCatching { dev.openhouse.ui.Door.loadFonts(shell.assets) }
        runCatching { dev.openhouse.ui.Openhouse.startInApp(bridge) }
        thread { handOver(); val key = appKey(bridge, id); main.post { open(key) } }
        Log.i(TAG, "$id open in ${act.packageName}")
    }

    private fun open(key: AppKey?) {
        if (reg.currentState == Lifecycle.State.DESTROYED) return
        if (key == null) showError("The display's helper isn't answering yet, so the family's things won't load. Go back and try again in a moment.")
        val w = appView(act, id, key, ui, calls,
            onError = { report(it, "The app hit an error") },
            onLoadFailed = { report(it, "The app didn't load"); main.postDelayed({ web?.reload() }, 3000) },
            onStarted = { if (key != null) banner.visibility = View.GONE })
        content.removeAllViews()
        content.addView(w, FrameLayout.LayoutParams(-1, -1))
        web = w
        w.loadUrl(appOrigin(ui, id, key?.shared == true) + "/apps/$id/")
    }

    /**
     * Once, the first time this app opens as a web page: what it saved when it was a native app (its files and
     * preferences, here in its own Android package, where nothing else can read them) goes to the bridge as its
     * `legacy` data, for the web app to take in (the kit's store.legacy()). The old files stay where they are.
     */
    private fun handOver() {
        val done = java.io.File(act.filesDir, ".handed-over")
        if (done.exists()) return
        val files = org.json.JSONObject()
        act.filesDir.listFiles()?.filter { it.isFile && !it.name.startsWith(".") && it.length() in 1..8_000_000L && Regex("[\\w.-]+\\.(json|txt)").matches(it.name) }
            ?.forEach { runCatching { files.put(it.name, it.readText()) } }
        val prefs = org.json.JSONObject()
        java.io.File(act.applicationInfo.dataDir, "shared_prefs").listFiles()?.map { it.name.removeSuffix(".xml") }
            ?.filter { it != "openhouse" && !it.startsWith("WebView") && !it.startsWith("Aw") }
            ?.forEach { name -> prefs.put(name, org.json.JSONObject(act.getSharedPreferences(name, Context.MODE_PRIVATE).all.mapValues { it.value?.toString() })) }
        if (files.length() == 0 && prefs.length() == 0) { done.writeText(""); return }
        val body = org.json.JSONObject().put("files", files).put("prefs", prefs).toString()
        if (dev.openhouse.ui.BridgeClient.post("$bridge/appdata/import?app=$id", body, readMs = 15000)?.contains("\"ok\":true") == true) {
            done.writeText(""); Log.i(TAG, "$id: handed over what it saved as a native app")
        } // else: the bridge wasn't up; try again next time
    }

    /** The kit's calls that only the display can do: a phone page (QR code), or back to the door. */
    private val calls = object : AppCalls {
        override fun phone(kind: String, arg: String) {
            // The links are the display's (its own keystore): back to it, which asks for the PIN and shows the paste box.
            if (kind == "calendar") { closeSheet(); runCatching { act.startActivity(android.content.Intent().setClassName(shell.packageName, MainActivity::class.java.name).putExtra("add_calendar", true).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }; return }
            if (kind == "album" || kind == "share" || kind == "google") { closeSheet(); runCatching { act.startActivity(android.content.Intent().setClassName(shell.packageName, MainActivity::class.java.name).putExtra(when (kind) { "album" -> "add_album"; "share" -> "share_photos"; else -> "google_photos" }, true).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }; return }
            if (kind == "unlink") { closeSheet(); runCatching { act.startActivity(android.content.Intent().setClassName(shell.packageName, MainActivity::class.java.name).putExtra("stop_album", arg.take(80)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }; return }
            if (kind == "pin") { askPin(act, shell, "PIN") { thread { dev.openhouse.ui.Openhouse.post("/house/unlock") } }; return }
            closeSheet()
            val close = { closeSheet(); Unit }
            val view = ComposeView(act).apply {
                setContent {
                    dev.openhouse.ui.OhScreen {
                        when (kind) {
                            "photos" -> dev.openhouse.ui.PhonePhotos(onClose = close)
                            "flyer" -> dev.openhouse.ui.PhoneFlyer(onClose = close)
                            "recipe" -> dev.openhouse.ui.PhoneRecipe(arg, onClose = close)
                            "list" -> dev.openhouse.ui.House.list(arg)?.let { dev.openhouse.ui.PhoneList(it, onClose = close) } // shown once the house has loaded
                            else -> close()
                        }
                    }
                }
            }
            if (kind == "list") dev.openhouse.ui.House.start() // before it's drawn: the list comes from the house
            root.addView(view, FrameLayout.LayoutParams(-1, -1)); sheet = view
        }
        override fun close() { act.finish() }
    }
    private fun closeSheet(): Boolean { val s = sheet ?: return false; root.removeView(s); sheet = null; return true }

    private fun immersive() {
        act.window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_DEFAULT // back acts on the first edge swipe (not "swipe to show the bars, then again")
        }
    }

    // --- lifecycle (the stub's activity) ------------------------------------------------------
    override fun onActivityStarted(a: Activity) { reg.currentState = Lifecycle.State.STARTED; web?.onResume(); watching = true; watch() }
    override fun onActivityResumed(a: Activity) { reg.currentState = Lifecycle.State.RESUMED; immersive() }
    override fun onActivityPaused(a: Activity) { reg.currentState = Lifecycle.State.STARTED }
    override fun onActivityStopped(a: Activity) { reg.currentState = Lifecycle.State.CREATED; web?.onPause(); watching = false }
    override fun onActivityDestroyed(a: Activity) {
        watching = false
        web?.destroy(); web = null
        reg.currentState = Lifecycle.State.DESTROYED
        act.unregisterActivityLifecycleCallbacks(this)
    }
    override fun onActivityCreated(a: Activity, b: Bundle?) {}
    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}

    /** The app deleted (or undone away) while it's open: close it (its stub goes next). */
    private fun watch() {
        if (!watching) return
        thread { if (appExists(bridge, id) == false) main.post { act.finishAndRemoveTask() } else main.postDelayed(::watch, 5000) }
    }

    // --- errors -------------------------------------------------------------------------------
    private fun report(msg: String, what: String) {
        Log.w(TAG, "$id: $msg")
        showError("$what: $msg\nAsk to fix it, or go back.")
        if (msg == lastError) return
        lastError = msg
        reportAppError(bridge, id, msg)
    }

    private fun showError(msg: String) {
        banner.text = msg.lines().filter { it.isNotBlank() }.take(5).joinToString("\n")
        banner.visibility = View.VISIBLE; banner.bringToFront()
    }
}
