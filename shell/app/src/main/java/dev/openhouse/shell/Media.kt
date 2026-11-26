package dev.openhouse.shell

// Music and audiobooks (docs/music.md): what's playing in the tablet's media apps, their buttons, and playing something
// from a search, for Opie's "music" tool (bridge/devices/index.js mediaDo, through DeviceServer's /media). Nothing here
// knows any one app: the media apps are the ones that take a search to play or offer a media browser, and whatever has
// a media session. Android only shows another app's media sessions to a notification listener, so the shell is one
// ([MediaListener]); it never reads the notifications themselves.

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.browse.MediaBrowser
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.service.notification.NotificationListenerService
import android.util.Log
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Only so Android lets the shell see the media apps' sessions (MediaSessionManager.getActiveSessions). It ignores
 *  every notification: no onNotificationPosted. */
class MediaListener : NotificationListenerService()

object Media {
    private const val TAG = "Media"
    private val ctx get() = DeviceServer.ctx
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val prefs get() = ctx.getSharedPreferences("shell", Context.MODE_PRIVATE)

    fun listener(c: Context) = ComponentName(c, MediaListener::class.java)
    fun listening(c: Context = ctx) = runCatching { c.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(listener(c)) }.getOrDefault(false)

    // Nothing lets the shell grant itself listener access, device owner or not: there's no owner API for it, the
    // system's own call is hidden from apps, and Android 15 puts enabled_notification_listeners back when an app with
    // WRITE_SECURE_SETTINGS changes it (tried on an emulator, docs/music.md). So adb grants it at setup
    // (scripts/tablet-setup.sh: cmd notification allow_listener), or a person on Android's own page, from Settings →
    // Advanced → Now playing, with the PIN.

    /** Android's page for it, with ours picked when it can be. */
    fun settingsIntent(c: Context): Intent =
        if (android.os.Build.VERSION.SDK_INT >= 30) Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(android.provider.Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, listener(c).flattenToString())
        else Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)

    // --- the media apps ---------------------------------------------------------------------------------------------
    data class App(val pkg: String, val label: String, val search: Boolean, val browser: ComponentName?)

    /** Apps with a launcher icon that take a search to play, or offer a media browser (as cars and watches use). A
     *  system app with only a browser is the tablet's own plumbing (its voice search, Bluetooth), not a media app. */
    fun apps(): List<App> {
        val pm = ctx.packageManager
        val searchers = pm.queryIntentActivities(Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH), 0).map { it.activityInfo.packageName }.toSet()
        val browsers = pm.queryIntentServices(Intent(MediaBrowserServiceAction), 0).associate { it.serviceInfo.packageName to ComponentName(it.serviceInfo.packageName, it.serviceInfo.name) }
        fun system(pkg: String) = runCatching { pm.getApplicationInfo(pkg, 0).flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0 }.getOrDefault(true)
        return KioskApps.launchable().filter { it.second in searchers || (it.second in browsers && !system(it.second)) }
            .map { (label, pkg) -> App(pkg, label, pkg in searchers, browsers[pkg]) }
    }
    private const val MediaBrowserServiceAction = "android.media.browse.MediaBrowserService"

    /** The app someone named (by its label, as installed), or null. */
    private fun named(name: String, among: List<App>): App? {
        val n = name.trim().lowercase(); if (n.isEmpty()) return null
        return among.firstOrNull { it.label.lowercase() == n || it.pkg == n }
            ?: among.firstOrNull { it.label.lowercase().startsWith(n) || n.startsWith(it.label.lowercase()) }
    }
    private fun label(pkg: String) = AppStore.label(pkg)

    private fun last(): String? = prefs.getString("media_last", null)
    private fun remember(pkg: String) { if (pkg != last()) prefs.edit().putString("media_last", pkg).apply() }

    // --- sessions ---------------------------------------------------------------------------------------------------
    private fun sessions(): List<MediaController> = if (!listening()) emptyList() else runCatching {
        ctx.getSystemService(MediaSessionManager::class.java).getActiveSessions(listener(ctx))
    }.getOrElse { Log.w(TAG, "sessions: $it"); emptyList() }.filter { it.packageName != ctx.packageName }

    private fun playing(c: MediaController) = c.playbackState?.state.let { it == PlaybackState.STATE_PLAYING || it == PlaybackState.STATE_BUFFERING || it == PlaybackState.STATE_CONNECTING }
    /** Something to say about: playing, or paused with a title (not a session left over with nothing in it). */
    private fun real(c: MediaController) = playing(c) || (c.playbackState?.state == PlaybackState.STATE_PAUSED && c.metadata?.getString(MediaMetadata.METADATA_KEY_TITLE) != null)
    /** The one playing, else the latest paused one (Android lists them newest first); for an app, any of its own. */
    private fun current(pkg: String? = null): MediaController? = sessions().filter { pkg == null || it.packageName == pkg }
        .let { l -> l.firstOrNull(::playing) ?: l.firstOrNull(::real) ?: if (pkg != null) l.firstOrNull() else null }

    private fun position(s: PlaybackState): Long {
        if (s.position < 0) return -1
        if (s.state != PlaybackState.STATE_PLAYING) return s.position
        return s.position + ((SystemClock.elapsedRealtime() - s.lastPositionUpdateTime) * s.playbackSpeed).toLong()
    }

    /** Playing on another device the app controls (Spotify Connect, a cast): its session says so as remote playback. */
    private fun away(c: MediaController) = c.playbackInfo?.playbackType == MediaController.PlaybackInfo.PLAYBACK_TYPE_REMOTE

    private fun describe(c: MediaController): JSONObject {
        val m = c.metadata; val s = c.playbackState
        fun t(k: String) = m?.getString(k)?.takeIf { it.isNotBlank() }
        val state = when (s?.state) {
            PlaybackState.STATE_PLAYING -> "playing"; PlaybackState.STATE_PAUSED -> "paused"; PlaybackState.STATE_STOPPED, PlaybackState.STATE_NONE, null -> "stopped"
            PlaybackState.STATE_BUFFERING, PlaybackState.STATE_CONNECTING -> "starting"; PlaybackState.STATE_ERROR -> "error"; else -> "other"
        }
        return JSONObject().put("app", label(c.packageName)).put("state", state)
            .putOpt("elsewhere", true.takeIf { away(c) })
            .putOpt("title", t(MediaMetadata.METADATA_KEY_TITLE) ?: t(MediaMetadata.METADATA_KEY_DISPLAY_TITLE))
            .putOpt("artist", t(MediaMetadata.METADATA_KEY_ARTIST) ?: t(MediaMetadata.METADATA_KEY_AUTHOR) ?: t(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE))
            .putOpt("album", t(MediaMetadata.METADATA_KEY_ALBUM))
            .putOpt("error", s?.errorMessage?.toString()?.takeIf { s.state == PlaybackState.STATE_ERROR })
            .putOpt("positionS", s?.let { position(it) }?.takeIf { it >= 0 }?.let { it / 1000 })
            .putOpt("lengthS", m?.getLong(MediaMetadata.METADATA_KEY_DURATION)?.takeIf { it > 0 }?.let { it / 1000 })
    }

    fun status(): JSONObject {
        val apps = apps(); val s = sessions()
        s.firstOrNull(::playing)?.let { remember(it.packageName) }
        val now = current()
        return JSONObject()
            .put("sees", listening())
            .put("apps", JSONArray(apps.map { JSONObject().put("name", it.label).put("search", it.search) }))
            .putOpt("last", last()?.let { p -> apps.firstOrNull { it.pkg == p }?.label })
            .putOpt("now", now?.let(::describe))
            .put("others", JSONArray(s.filter { it.sessionToken != now?.sessionToken && playing(it) }.map(::describe)))
            .put("anyPlaying", runCatching { ctx.getSystemService(AudioManager::class.java).isMusicActive }.getOrDefault(false))
    }

    /** After someone opens Android's page for it: Opie comes back to the front as soon as it's on (Android's page
     *  never goes back by itself), for three minutes. */
    fun backWhenOn(c: Context) = Thread {
        val end = SystemClock.elapsedRealtime() + 180_000
        while (SystemClock.elapsedRealtime() < end) { if (listening(c)) { SystemClock.sleep(500); main.post { KioskApps.goHome() }; return@Thread }; SystemClock.sleep(400) }
    }.start()

    // --- Home's Now playing card (chat/src/home.jsx NowPlaying, through HomeView's media call) ----------------------
    private var artFor: String? = null
    private var artUrl: String? = null

    /** What's playing for Home's card: as for Opie's status, with the app's package (a tap opens it) and its cover,
     *  small, as a data: URL (made again only when the title changes). Nothing when the tablet can't see the apps. */
    fun forHome(): JSONObject {
        val c = current() ?: return JSONObject().put("sees", listening())
            .put("anyPlaying", runCatching { ctx.getSystemService(AudioManager::class.java).isMusicActive }.getOrDefault(false))
        val o = describe(c).put("pkg", c.packageName)
        val m = c.metadata
        val key = c.packageName + "|" + (m?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: "")
        if (key != artFor) { artFor = key; artUrl = runCatching { m?.let(::cover) }.getOrNull() }
        artUrl?.let { o.put("art", it) }
        return JSONObject().put("sees", true).put("now", o)
    }

    private fun cover(m: MediaMetadata): String? {
        val b = m.getBitmap(MediaMetadata.METADATA_KEY_ART) ?: m.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: m.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON) ?: return null
        val side = 240; val k = side.toFloat() / maxOf(b.width, b.height)
        val small = if (k < 1) android.graphics.Bitmap.createScaledBitmap(b, (b.width * k).toInt().coerceAtLeast(1), (b.height * k).toInt().coerceAtLeast(1), true) else b
        val out = java.io.ByteArrayOutputStream(); small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, out)
        return "data:image/jpeg;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
    }

    /** A button on Home's card: at once, without waiting to see the new state (the page asks again just after). */
    fun tapFromHome(what: String) {
        val c = current()
        if (c == null) { if (what == "play") key(KeyEvent.KEYCODE_MEDIA_PLAY); return }
        val tc = c.transportControls
        when (what) { "play" -> tc.play(); "pause" -> tc.pause(); "next" -> tc.skipToNext(); "previous" -> tc.skipToPrevious(); else -> return }
        remember(c.packageName)
    }

    // --- doing ------------------------------------------------------------------------------------------------------
    /** {do: status|play|pause|next|previous|seek|stop|search, app?, query?, focus?, seconds?} */
    fun handle(b: JSONObject): JSONObject = runCatching { act(b) }.getOrElse { Log.w(TAG, "media: $it"); JSONObject().put("error", it.message ?: it.toString()) }

    private fun act(b: JSONObject): JSONObject {
        val what = b.optString("do", "status")
        if (what == "status") return status()
        val apps = apps()
        val want = b.optString("app").trim()
        val app = if (want.isEmpty()) null else named(want, apps)
            ?: return JSONObject().put("error", "$want isn't one of the media apps on the tablet.").put("missing", true)
                .put("apps", JSONArray(apps.map { JSONObject().put("name", it.label).put("search", it.search) }))
        return when (what) {
            "search" -> search(b.optString("query").trim(), b.optString("focus").trim(), app, apps)
            "play" -> play(app)
            "pause", "stop", "next", "previous" -> button(what, app)
            "seek" -> seek(b.optDouble("seconds", 0.0), app)
            else -> JSONObject().put("error", "do is one of status, play, pause, next, previous, seek, stop, search.")
        }
    }

    private fun done(text: String, c: MediaController? = null) = JSONObject().put("done", text).putOpt("now", c?.let(::describe))

    /** No app named and no session to see: the key goes to whichever app Android gives media keys to. */
    private fun key(code: Int) {
        val am = ctx.getSystemService(AudioManager::class.java)
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code)); am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    private fun button(what: String, app: App?): JSONObject {
        val c = current(app?.pkg)
        if (c == null) {
            if (app != null && listening()) return JSONObject().put("error", "${app.label} isn't playing anything.")
            key(when (what) { "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE; "stop" -> KeyEvent.KEYCODE_MEDIA_STOP; "next" -> KeyEvent.KEYCODE_MEDIA_NEXT; else -> KeyEvent.KEYCODE_MEDIA_PREVIOUS })
            return done("Sent $what to whatever was playing (the tablet can't see which app).")
        }
        val tc = c.transportControls
        when (what) { "pause" -> tc.pause(); "stop" -> tc.stop(); "next" -> tc.skipToNext(); else -> tc.skipToPrevious() }
        remember(c.packageName)
        SystemClock.sleep(if (what == "next" || what == "previous") 1200 else 400) // its new state, or the next title
        return done("${label(c.packageName)}: $what.", c)
    }

    private fun seek(seconds: Double, app: App?): JSONObject {
        if (seconds == 0.0) return JSONObject().put("error", "How many seconds, back (negative) or forward?")
        val c = current(app?.pkg) ?: return JSONObject().put("error", if (listening()) "Nothing is playing." else "The tablet can't see what's playing, so it can't skip by seconds.")
        val s = c.playbackState; val pos = s?.let { position(it) } ?: -1
        if (pos < 0 || s!!.actions and PlaybackState.ACTION_SEEK_TO == 0L) {
            if (seconds > 0) c.transportControls.fastForward() else c.transportControls.rewind()
            return done("${label(c.packageName)} doesn't say where it is, so it skipped ${if (seconds > 0) "forward" else "back"} by its own step.", c)
        }
        val len = c.metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION)?.takeIf { it > 0 } ?: Long.MAX_VALUE
        c.transportControls.seekTo((pos + (seconds * 1000).toLong()).coerceIn(0, len))
        SystemClock.sleep(400)
        return done("${label(c.packageName)}: ${if (seconds > 0) "forward" else "back"} ${Math.abs(seconds).toInt()} seconds.", c)
    }

    /** Resume: the app's own session if there is one; after a restart, its media browser's, or its play key. */
    private fun play(app: App?): JSONObject {
        current(app?.pkg)?.let { c -> c.transportControls.play(); return waitPlaying(c.packageName, "${label(c.packageName)} is playing.") }
        val target = app ?: apps().firstOrNull { it.pkg == last() }
        if (target == null) {
            key(KeyEvent.KEYCODE_MEDIA_PLAY)
            return done("Sent play to the tablet's last media app (the tablet can't see which).")
        }
        browse(target)?.let { c -> c.transportControls.play(); return waitPlaying(target.pkg, "${target.label} is playing.") }
        // A play key, as a headset's after a restart: Android gives it to the app that last played, and lets that app
        // start its player from it (an app can't start one from a broadcast the shell sends it).
        // (An explicit media-button broadcast to the app doesn't do: Android 12+ won't let it start its player from one.)
        if (!listening()) { key(KeyEvent.KEYCODE_MEDIA_PLAY); val r = waitPlaying(target.pkg, "${target.label} is playing.", 4000); return if (r.has("done")) r else openInstead(target, "It didn't start on its own") }
        if (sessions().none(::playing)) { // (with something playing, the key would go to that)
            key(KeyEvent.KEYCODE_MEDIA_PLAY)
            val r = waitPlaying(target.pkg, "${target.label} is playing.", 4000)
            if (r.has("done")) return r
            sessions().filter { it.packageName != target.pkg && playing(it) }.forEach { it.transportControls.pause() } // another app took it
        }
        return openInstead(target, "It didn't start on its own")
    }

    private fun search(query: String, focus: String, app: App?, apps: List<App>): JSONObject {
        if (query.isEmpty()) return play(app)
        val target = app ?: apps.firstOrNull { it.pkg == last() && it.search } ?: apps.singleOrNull { it.search }
            ?: return JSONObject().put("error", if (apps.isEmpty()) "No media app is on the tablet." else "Which app?")
                .put("apps", JSONArray(apps.map { JSONObject().put("name", it.label).put("search", it.search) }))
        val extras = Bundle().apply {
            putString(android.app.SearchManager.QUERY, query)
            focusOf(focus)?.let { putString(MediaStore.EXTRA_MEDIA_FOCUS, it) }
            when (focus) { "artist" -> putString(MediaStore.EXTRA_MEDIA_ARTIST, query); "album" -> putString(MediaStore.EXTRA_MEDIA_ALBUM, query)
                "song" -> putString(MediaStore.EXTRA_MEDIA_TITLE, query); "playlist" -> putString("android.intent.extra.playlist", query) }
        }
        // Without its screen first: a session it already has, or its media browser's, that takes a search.
        val quiet = current(target.pkg)?.takeIf { it.playbackState?.actions?.and(PlaybackState.ACTION_PLAY_FROM_SEARCH) != 0L } ?: browse(target)?.takeIf { it.playbackState?.actions?.and(PlaybackState.ACTION_PLAY_FROM_SEARCH) != 0L }
        if (quiet != null) {
            quiet.transportControls.playFromSearch(query, extras)
            val r = waitPlaying(target.pkg, "${target.label} is playing.")
            if (r.has("done")) return r
        }
        if (!target.search) return openInstead(target, "${target.label} can't be asked for something to play")
        if (KioskApps.needsParent(target.pkg)) return JSONObject().put("error", "${target.label} is one of the tablet's own apps, so it opens only for someone: they open it from Apps.")
        val home = MainActivity.live?.inFront == true
        KioskApps.allowInKiosk(target.pkg)
        val i = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH).setPackage(target.pkg).putExtras(extras).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
        val r = waitPlaying(target.pkg, "${target.label} is playing.", 10_000)
        // It came up over Opie to start: Opie back in front, the music going on behind it.
        if (home && r.has("done")) { SystemClock.sleep(if (listening()) 800 else 1500); main.post { KioskApps.goHome() } }
        return if (r.has("done")) r else JSONObject().put("error", "${target.label} opened but isn't playing: it may need someone to sign in on the tablet, or it didn't find that.")
    }

    private fun focusOf(f: String) = when (f) {
        "artist" -> MediaStore.Audio.Artists.ENTRY_CONTENT_TYPE; "album" -> MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE
        "song" -> "vnd.android.cursor.item/audio"; "playlist" -> MediaStore.Audio.Playlists.ENTRY_CONTENT_TYPE
        "genre" -> MediaStore.Audio.Genres.ENTRY_CONTENT_TYPE; else -> null
    }

    private fun openInstead(app: App, why: String): JSONObject {
        if (KioskApps.needsParent(app.pkg)) return JSONObject().put("error", "$why, and ${app.label} opens only for someone: they open it from Apps.")
        main.post { KioskApps.openApp(app.pkg) }
        return JSONObject().put("opened", app.label).put("done", "$why, so ${app.label} is open on the screen to choose there.")
    }

    /** Wait until [pkg] plays (when the shell can see it); then it's the app they last played from. */
    private fun waitPlaying(pkg: String, text: String, ms: Long = 5000): JSONObject {
        // Without the listener (Now playing off) it can't see the app, but it can hear whether the tablet makes sound:
        // that, not a guess, says whether it started.
        if (!listening()) {
            val am = ctx.getSystemService(AudioManager::class.java); val end = SystemClock.elapsedRealtime() + ms
            while (SystemClock.elapsedRealtime() < end) { if (am.isMusicActive) { remember(pkg); return done("$text (The tablet hears it playing; it can't see what: Settings → Advanced → Now playing.)") }; SystemClock.sleep(400) }
            return JSONObject().put("error", "${label(pkg)} didn't start playing on the tablet: no sound from it. It may be playing on another device it used last (a phone: its device list switches it to this tablet), or need someone to sign in to it on the tablet, or it didn't find that.")
        }
        val end = SystemClock.elapsedRealtime() + ms
        while (SystemClock.elapsedRealtime() < end) {
            sessions().firstOrNull { it.packageName == pkg && playing(it) }?.let { remember(pkg)
                return done(if (away(it)) "${label(pkg)} is playing, but on another device (its last one, such as a phone), not the tablet. ${label(pkg)}'s device list on the tablet (or on that phone) switches it to this tablet." else text, it) }
            SystemClock.sleep(400)
        }
        return JSONObject().put("error", "${label(pkg)} didn't start playing.").putOpt("now", current(pkg)?.let(::describe))
    }

    /** The app's media session through its media browser (when it lets the tablet connect; many only let cars in). */
    private fun browse(app: App): MediaController? {
        val cn = app.browser ?: return null
        val got = CountDownLatch(1); var browser: MediaBrowser? = null; var c: MediaController? = null
        main.post {
            runCatching {
                browser = MediaBrowser(ctx, cn, object : MediaBrowser.ConnectionCallback() {
                    override fun onConnected() { c = runCatching { MediaController(ctx, browser!!.sessionToken) }.getOrNull(); got.countDown() }
                    override fun onConnectionFailed() { got.countDown() }
                    override fun onConnectionSuspended() { got.countDown() }
                }, null).also { it.connect() }
            }.onFailure { got.countDown() }
        }
        got.await(4, TimeUnit.SECONDS)
        // The controller keeps working after the browser lets go; the session is the app's.
        if (c == null) main.post { runCatching { browser?.disconnect() } }
        else main.postDelayed({ runCatching { browser?.disconnect() } }, 15_000)
        Log.i(TAG, "browser ${app.pkg}: ${if (c != null) "connected" else "no"}")
        return c
    }
}
