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
 * Spotify on the tablet itself, without its app coming up (docs/music.md): Spotify's own player for websites (its
 * Embed), on Home, worked through Spotify's iFrame API by the home screen's page (chat/src/spotify-player.jsx). Signed in
 * to Spotify in Opie once ([signIn]: Spotify's own page, in the web views the home screen shares), it plays whole songs
 * for a Premium account; signed out, Spotify plays 30-second previews, so Opie uses it only once signed in. Opie finds
 * the thing's Spotify link (bridge devices/index.js) and [play]s it; Media.kt sends the buttons here while it's the one
 * in use. What it plays is what the page reports from the player's own events ([onState]).
 */
object SpotifyEmbed {
    private const val TAG = "SpotifyEmbed"
    private val main by lazy { Handler(Looper.getMainLooper()) }
    @Volatile private var state = JSONObject()
    @Volatile private var title: String? = null
    @Volatile private var usedAt = 0L

    /** Signed in to Spotify in Opie's web views (its session cookie). */
    fun signedIn() = runCatching { CookieManager.getInstance().getCookie("https://open.spotify.com")?.contains("sp_dc=") == true }.getOrDefault(false)

    /** The home screen's page, as the player's state changes (HomeView's spotifyState). */
    fun onState(j: String) { runCatching { state = JSONObject(j).put("got", SystemClock.elapsedRealtime()) } }

    /** What it plays, while it has something: as Media.describe's. */
    fun now(): JSONObject? {
        val s = state
        if (!s.has("uri") || s.optBoolean("stopped")) return null
        val st = when { s.optBoolean("buffering") -> "starting"; s.optBoolean("paused", true) -> "paused"; else -> "playing" }
        return JSONObject().put("app", "Spotify").put("state", st).put("embed", true)
            .putOpt("title", s.optString("title").ifBlank { title })
            .putOpt("positionS", s.optDouble("pos", -1.0).takeIf { it >= 0 }?.toLong())
            .putOpt("lengthS", s.optDouble("len", -1.0).takeIf { it > 0 }?.toLong())
    }
    fun playing() = now()?.optString("state").let { it == "playing" || it == "starting" }
    /** The one in use: playing, or the last thing played and played since any other app (Media.kt). */
    fun inUse(lastOther: Long) = now() != null && (playing() || usedAt > lastOther)

    private fun send(cmd: JSONObject): Boolean { val h = MainActivity.live?.homeView ?: return false; main.post { h.spotify(cmd) }; return true }

    /** Plays an open.spotify.com link (a song, album, playlist, artist, show, episode or audiobook) in the player on
     *  Home; waits up to [ms] for it to be playing. The result as Media's. */
    fun play(link: String, name: String?, ms: Long = 20_000): JSONObject {
        val m = Regex("open\\.spotify\\.com/(?:intl-[\\w-]+/)?(track|album|playlist|artist|show|episode|audiobook)/([A-Za-z0-9]{10,40})").find(link)
            ?: return JSONObject().put("error", "That isn't a Spotify link.")
        if (!signedIn()) return JSONObject().put("error", "Spotify isn't signed in on the tablet's own player.").put("signIn", true)
        val uri = "spotify:${m.groupValues[1]}:${m.groupValues[2]}"
        title = name?.take(200); state = JSONObject(); usedAt = SystemClock.elapsedRealtime(); pausedForVoice = false
        Media.pauseOthers(); takeSpeaker() // (one thing playing: the app that was, paused, and stays so)
        if (!send(JSONObject().put("do", "load").put("uri", uri).putOpt("title", title))) return JSONObject().put("error", "The tablet's screen isn't up.")
        val end = SystemClock.elapsedRealtime() + ms
        var start = -1.0
        while (SystemClock.elapsedRealtime() < end) {
            val s = state
            if (s.optString("uri") == uri || s.has("pos")) {
                val pos = s.optDouble("pos", -1.0)
                if (!s.optBoolean("paused", true) && !s.optBoolean("buffering") && pos >= 0) {
                    if (start < 0) start = pos else if (pos > start) { // moving: it's playing
                        val len = s.optDouble("len", -1.0)
                        if (len in 1.0..31.0) return done("Spotify is playing only a 30-second preview: the tablet's Spotify sign-in may have ended (Settings → Advanced → Spotify), or the account isn't Premium.")
                        return done("Spotify is playing on the tablet.")
                    }
                }
            }
            SystemClock.sleep(400)
        }
        send(JSONObject().put("do", "stop")); leaveSpeaker() // (so it can't start later, over whatever plays instead)
        return JSONObject().put("error", "Spotify's player on the tablet didn't start.").putOpt("now", now())
    }
    private fun done(t: String) = JSONObject().put("done", t).putOpt("now", now())

    /** play, pause, stop, seek (seconds, + or -), previous (from the start); Spotify's player takes no next. */
    fun button(what: String, seconds: Double = 0.0): JSONObject {
        pausedForVoice = false // (asked for: what they asked stays after the conversation)
        if (now() == null) return JSONObject().put("error", "Spotify isn't playing on the tablet.")
        usedAt = SystemClock.elapsedRealtime()
        when (what) {
            "play" -> { Media.pauseOthers(); takeSpeaker(); send(JSONObject().put("do", "play")) }
            "pause" -> send(JSONObject().put("do", "pause"))
            "stop" -> { send(JSONObject().put("do", "stop")); leaveSpeaker(); return JSONObject().put("done", "Spotify stopped.") }
            "seek" -> send(JSONObject().put("do", "seek").put("seconds", seconds))
            "previous" -> send(JSONObject().put("do", "restart"))
            "next" -> return JSONObject().put("error", "Spotify's player on the tablet can't skip ahead: ask for the next thing to play by name instead.")
        }
        SystemClock.sleep(900)
        return JSONObject().put("done", "Spotify: $what.").putOpt("now", now())
    }

    /** Opie's live voice: the player pauses while it talks, as other apps do for Android's audio focus (which doesn't
     *  reach a page of Opie's own), and plays on after it, unless someone paused it or played something else meanwhile. */
    @Volatile private var pausedForVoice = false
    fun holdForVoice(on: Boolean) {
        if (on) { if (playing()) { pausedForVoice = true; send(JSONObject().put("do", "pause")) } }
        else if (pausedForVoice) { pausedForVoice = false; if (!playing() && state.has("uri")) send(JSONObject().put("do", "play")) }
    }

    // The speaker, as an app takes it (Android's audio focus): a page of Opie's own doesn't ask for it by itself, so an
    // app that Opie's voice had paused for a moment played on over it once the voice let go (the user). Held while it's
    // in use; another app taking it for good pauses this one.
    private var focus: android.media.AudioFocusRequest? = null
    private fun takeSpeaker() = main.post {
        if (focus != null) return@post
        val am = DeviceServer.ctx.getSystemService(android.media.AudioManager::class.java)
        val f = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener { if (it == android.media.AudioManager.AUDIOFOCUS_LOSS) { focus = null; if (playing()) send(JSONObject().put("do", "pause")) } }
            .build()
        if (am.requestAudioFocus(f) == android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focus = f
    }
    private fun leaveSpeaker() = main.post {
        val f = focus ?: return@post
        focus = null; runCatching { DeviceServer.ctx.getSystemService(android.media.AudioManager::class.java).abandonAudioFocusRequest(f) }
    }

    /** An app plays while this is paused: it goes from Home (the app's card shows instead). */
    fun yieldTo() { if (now() != null && !playing()) { state = JSONObject(state.toString()).put("stopped", true); send(JSONObject().put("do", "stop")); leaveSpeaker() } }

    /** Another app started: this one pauses (one thing playing). */
    fun pauseForOther() { if (playing()) send(JSONObject().put("do", "pause")) }

    /** As Chrome: Spotify turns web views away. (The home screen's too: HomeView.) */
    fun spotifyUa(def: String) = def.replace("; wv", "").replace(Regex("Version/[\\d.]+ "), "")

    /** Spotify's songs are protected (Widevine): its own pages and frames may play them. */
    fun grant(r: PermissionRequest) {
        if (r.origin?.host?.endsWith("spotify.com") == true && PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID in r.resources) r.grant(arrayOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID)) else r.deny()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUp(w: WebView) {
        w.settings.javaScriptEnabled = true; w.settings.domStorageEnabled = true
        w.settings.userAgentString = spotifyUa(w.settings.userAgentString)
        CookieManager.getInstance().setAcceptCookie(true)
        w.webChromeClient = object : WebChromeClient() { override fun onPermissionRequest(r: PermissionRequest) = grant(r) }
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
    fun signOut() { send(JSONObject().put("do", "stop")); runCatching {
        val cm = CookieManager.getInstance()
        for (host in listOf("https://open.spotify.com", "https://accounts.spotify.com", "https://spotify.com"))
            cm.getCookie(host)?.split(';')?.map { it.substringBefore('=').trim() }?.forEach { n -> cm.setCookie(host, "$n=; Max-Age=0"); cm.setCookie(".spotify.com", "$n=; Max-Age=0; Domain=.spotify.com; Path=/") }
        cm.flush()
    } }
}
