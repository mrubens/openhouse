package dev.openhouse.shell

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Spotify on the tablet itself, without its app coming up (docs/music.md): Spotify's own player for websites (the
 * Embed, open.spotify.com/embed/...) in a WebView nobody sees. Signed in to Spotify in Opie once (its sign-in page,
 * [signIn]), it plays whole songs for a Premium account; signed out, Spotify plays 30-second previews, so it's used
 * only once signed in. Opie finds the thing's Spotify link (bridge devices/index.js) and [play]s it; Media.kt routes
 * the buttons and the Now playing card here while it's the one in use. The embed page's own play button and its media
 * element are what it works: nothing of Spotify's private service.
 */
object SpotifyEmbed {
    private const val TAG = "SpotifyEmbed"
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private var web: WebView? = null
    @Volatile private var state = JSONObject()
    @Volatile private var title: String? = null
    @Volatile private var usedAt = 0L

    /** Signed in to Spotify in Opie's web views (its session cookie). */
    fun signedIn() = runCatching { CookieManager.getInstance().getCookie("https://open.spotify.com")?.contains("sp_dc=") == true }.getOrDefault(false)

    /** What it plays, while it has something: as Media.describe's. */
    fun now(): JSONObject? {
        if (web == null || !state.has("at")) return null
        val s = state
        val st = when { s.optBoolean("buffering") -> "starting"; s.optBoolean("paused", true) -> "paused"; else -> "playing" }
        return JSONObject().put("app", "Spotify").put("state", st).put("embed", true)
            .putOpt("title", s.optString("title").ifBlank { title })
            .putOpt("artist", s.optString("artist").ifBlank { null })
            .putOpt("art", s.optString("art").ifBlank { null })
            .putOpt("positionS", s.optDouble("pos", -1.0).takeIf { it >= 0 }?.toLong())
            .putOpt("lengthS", s.optDouble("len", -1.0).takeIf { it > 0 }?.toLong())
    }
    fun playing() = now()?.optString("state").let { it == "playing" || it == "starting" }
    /** The one in use: playing, or the last thing played and played since any other app (Media.kt). */
    fun inUse(lastOther: Long) = web != null && (playing() || usedAt > lastOther)

    private fun spotifyUa(def: String) = def.replace("; wv", "").replace(Regex("Version/[\\d.]+ "), "")

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUp(w: WebView) {
        w.settings.javaScriptEnabled = true; w.settings.domStorageEnabled = true; w.settings.mediaPlaybackRequiresUserGesture = false
        w.settings.userAgentString = spotifyUa(w.settings.userAgentString) // (as Chrome: Spotify turns web views away)
        CookieManager.getInstance().setAcceptCookie(true)
        w.webChromeClient = object : WebChromeClient() {
            // Spotify's songs are protected (Widevine): its own pages may play them.
            override fun onPermissionRequest(r: PermissionRequest) {
                if (r.origin?.host?.endsWith("spotify.com") == true && PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID in r.resources) r.grant(arrayOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID)) else r.deny()
            }
        }
    }

    // What the page reports, each second: its media element and the media session Spotify's player sets.
    private const val WATCH = """(function(){ if (window.__oh) return; window.__oh = 1; setInterval(function(){ try {
        var m = document.querySelector('audio,video'), s = navigator.mediaSession && navigator.mediaSession.metadata;
        var a = s && s.artwork && s.artwork.length ? s.artwork[s.artwork.length-1].src : '';
        OpieSpotify.state(JSON.stringify({ paused: !m || m.paused, buffering: !!m && !m.paused && m.readyState < 3, pos: m ? m.currentTime : -1, len: m && isFinite(m.duration) ? m.duration : -1,
          title: s ? s.title : '', artist: s ? s.artist : '', art: a, preview: !!document.querySelector('[data-testid="preview-badge"],[aria-label="Preview"]') }));
      } catch (e) {} }, 1000); })();"""
    private const val PRESS = """(function(){ var b = document.querySelector('[data-testid="play-pause-button"]') || document.querySelector('button[aria-label="Play"],button[aria-label="Pause"]'); if (b) { b.click(); return 'ok'; } return 'none'; })()"""

    private class Bridge { @android.webkit.JavascriptInterface fun state(j: String) { runCatching { state = JSONObject(j).put("at", SystemClock.elapsedRealtime()) } } }

    /** Plays an open.spotify.com link (a song, album, playlist, artist, show, episode or audiobook): its embed in a
     *  WebView nobody sees, then its play button. Waits up to [ms] for sound; the result as Media's. */
    fun play(link: String, name: String?, ms: Long = 15_000): JSONObject {
        val m = Regex("open\\.spotify\\.com/(?:intl-[\\w-]+/)?(track|album|playlist|artist|show|episode|audiobook)/([A-Za-z0-9]{10,40})").find(link)
            ?: return JSONObject().put("error", "That isn't a Spotify link.")
        if (!signedIn()) return JSONObject().put("error", "Spotify isn't signed in on the tablet's own player.").put("signIn", true)
        val act = MainActivity.live ?: return JSONObject().put("error", "The tablet's screen isn't up.")
        val url = "https://open.spotify.com/embed/${m.groupValues[1]}/${m.groupValues[2]}"
        title = name?.take(200); state = JSONObject(); usedAt = SystemClock.elapsedRealtime()
        val loaded = CountDownLatch(1)
        main.post {
            Media.pauseOthers() // (one thing playing: the app that was, paused)
            val w = web ?: WebView(act).also { w ->
                setUp(w); w.addJavascriptInterface(Bridge(), "OpieSpotify")
                w.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = r.isForMainFrame && r.url.host != "open.spotify.com" // stays on the player
                    override fun onPageFinished(v: WebView, u: String?) { v.evaluateJavascript(WATCH, null); loaded.countDown() }
                    override fun onRenderProcessGone(v: WebView, d: android.webkit.RenderProcessGoneDetail?): Boolean { RendererGone.drop(TAG, "Spotify", v, d); drop(); return true }
                }
                w.alpha = 0f // (on the screen but unseen: a web view off it doesn't play)
                act.root.addView(w, FrameLayout.LayoutParams(2, 2, Gravity.TOP or Gravity.START))
                web = w
            }
            w.loadUrl(url)
        }
        loaded.await(15, TimeUnit.SECONDS)
        // Its button comes once the page has drawn: pressed as soon as it's there, and again if it didn't start.
        val end = SystemClock.elapsedRealtime() + ms
        var pressedAt = 0L
        while (SystemClock.elapsedRealtime() < end) {
            if (playing() && !state.optBoolean("buffering")) {
                if (state.optBoolean("preview")) return done("Spotify is playing only a preview: the tablet's Spotify sign-in may have ended (Settings → Advanced → Spotify).")
                return done("Spotify is playing on the tablet.")
            }
            if (!playing() && SystemClock.elapsedRealtime() - pressedAt > 4000) { press(); pressedAt = SystemClock.elapsedRealtime() }
            SystemClock.sleep(400)
        }
        return JSONObject().put("error", "Spotify's player didn't start.").putOpt("now", now())
    }
    private fun done(t: String) = JSONObject().put("done", t).putOpt("now", now())

    private fun press() { val l = CountDownLatch(1); main.post { web?.evaluateJavascript(PRESS) { l.countDown() } ?: l.countDown() }; l.await(3, TimeUnit.SECONDS) }

    /** play, pause, stop, seek (seconds, + or -); next and previous only where its page has them. */
    fun button(what: String, seconds: Double = 0.0): JSONObject {
        if (web == null) return JSONObject().put("error", "Spotify isn't playing on the tablet.")
        usedAt = SystemClock.elapsedRealtime()
        when (what) {
            "play" -> { if (!playing()) { Media.pauseOthers(); press() } }
            "pause" -> if (playing()) press()
            "stop" -> { main.post { drop() }; return JSONObject().put("done", "Spotify stopped.") }
            "seek" -> js("(function(){var m=document.querySelector('audio,video'); if(m) m.currentTime=Math.max(0,m.currentTime+($seconds));})()")
            "next", "previous" -> js("(function(){var b=document.querySelector('[data-testid=\"${if (what == "next") "skip-forward-button" else "skip-back-button"}\"],button[aria-label=\"${if (what == "next") "Next" else "Previous"}\"]'); if(b) b.click(); else { var m=document.querySelector('audio,video'); if(m) m.currentTime=${if (what == "next") "m.duration-0.5" else "0"}; }})()")
        }
        SystemClock.sleep(900)
        return JSONObject().put("done", "Spotify: $what.").putOpt("now", now())
    }
    private fun js(s: String) = main.post { web?.evaluateJavascript(s, null) }

    /** Another app started: this one pauses (one thing playing). */
    fun pauseForOther() { if (playing()) press() }

    private fun drop() {
        val w = web ?: return
        web = null; state = JSONObject()
        runCatching { (w.parent as? android.view.ViewGroup)?.removeView(w); w.loadUrl("about:blank"); w.destroy() }
    }

    // --- signing in ------------------------------------------------------------------------------------------------
    /** Spotify's own sign-in page, full screen with a close button, in Opie's web views (the person types there; Opie
     *  never sees it). It closes by itself once signed in. [done]: signed in or not. */
    @SuppressLint("SetJavaScriptEnabled")
    fun signIn(act: MainActivity, done: (Boolean) -> Unit = {}) {
        val box = FrameLayout(act).apply { setBackgroundColor(Color.WHITE); isClickable = true; tag = MainActivity.OWN_FIELDS } // (the keyboard cover's keys reach its fields)
        lateinit var close: () -> Unit
        val w = WebView(act).apply {
            setUp(this)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(v: WebView, u: String?) {
                    // Signed in once Spotify's session cookie is there and it has left the sign-in pages.
                    if (signedIn() && u?.contains("accounts.spotify.com") != true) { CookieManager.getInstance().flush(); close() }
                }
                override fun onRenderProcessGone(v: WebView, d: android.webkit.RenderProcessGoneDetail?): Boolean { RendererGone.drop(TAG, "Spotify sign-in", v, d); close(); return true }
            }
            loadUrl("https://accounts.spotify.com/login?continue=" + android.net.Uri.encode("https://open.spotify.com/"))
        }
        val x = android.widget.ImageView(act).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel); setColorFilter(Color.DKGRAY); contentDescription = "Close"
            val p = (14 * resources.displayMetrics.density).toInt(); setPadding(p, p, p, p)
            setOnClickListener { close() }
        }
        val d = resources(act)
        box.addView(w, FrameLayout.LayoutParams(-1, -1))
        box.addView(x, FrameLayout.LayoutParams(d * 64, d * 64, Gravity.TOP or Gravity.END).apply { setMargins(0, d * 12, d * 12, 0) })
        var gone = false
        close = { if (!gone) { gone = true; act.root.removeView(box); runCatching { w.destroy() }; Log.i(TAG, "sign-in closed: ${signedIn()}"); done(signedIn()) } }
        act.root.addView(box, FrameLayout.LayoutParams(-1, -1))
    }
    private fun resources(act: MainActivity) = act.resources.displayMetrics.density.toInt().coerceAtLeast(1)

    /** Signing out: Spotify's cookies go (and its player). */
    fun signOut() { main.post { drop() }; runCatching {
        val cm = CookieManager.getInstance()
        for (host in listOf("https://open.spotify.com", "https://accounts.spotify.com", "https://spotify.com"))
            cm.getCookie(host)?.split(';')?.map { it.substringBefore('=').trim() }?.forEach { n -> cm.setCookie(host, "$n=; Max-Age=0"); cm.setCookie(".spotify.com", "$n=; Max-Age=0; Domain=.spotify.com; Path=/") }
        cm.flush()
    } }
}
