package dev.openhouse.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Video apps: Android apps in Apps that an adult marked (the app's hold menu in Apps, or Opie asking: video_app, the
 * PIN when Add apps asks for it). Going Home while one plays leaves its video floating in a small window (Android's
 * picture-in-picture) over Opie's home screen.
 *
 * Android ends picture-in-picture whenever lock task (kiosk mode) starts, so opening a video app lifts lock task for
 * as long as it's in front or floating, and nothing else: Opie stays the device's Home, the status bar and
 * notifications stay off (setStatusBarDisabled), Kiosk's restrictions stay on, and Opie's own screen doesn't lock
 * again while the video floats ([holding], DeviceOwner.enterKiosk).
 *
 * While it's lifted a person can reach Android's Home and Back (both land on Opie or the video app), and the recent
 * apps screen; the floating window's own menu can open the app's Android settings. Anything other than Opie and the
 * video app coming to the front (recents, those settings, another app the video app opens) ends it at once.
 *
 * Lock task comes back ([end]) when: the floating window is closed and the app isn't in front; the screen sleeps
 * (Sleep now, night hours, the screen going off); nothing has played for [QUIET_MS]; or something else comes to the
 * front. What was playing is paused, so it doesn't go on playing unseen behind Opie.
 *
 * It needs device control (DeviceAccess, Android accessibility): its list of windows is what says one is in
 * picture-in-picture (AccessibilityWindowInfo.isInPictureInPictureMode) and which app is in front. Without it a
 * video app opens inside kiosk mode like any other app, and doesn't float.
 */
object VideoFloat {
    private const val TAG = "VideoFloat"
    /** Nothing played for this long, floating or not: back to kiosk. */
    const val QUIET_MS = 10 * 60_000L
    /** How long the app has to come up after it's opened, and to start floating after Home (Android animates it). */
    private const val GRACE_MS = 4_000L
    /** Something else in front this long ends it (the Home gesture's animation passes through the recents screen). */
    private const val OTHER_MS = 800L

    private val main = Handler(Looper.getMainLooper())
    private fun prefs(c: Context) = c.getSharedPreferences("store", Context.MODE_PRIVATE)

    /** Every app that can float its video (Android's picture-in-picture) does, unless someone turned it off for it. */
    fun isVideo(c: Context, pkg: String) = pkg !in prefs(c).getStringSet("video_off", emptySet())!! && canFloat(c, pkg)
    /** Does any of [pkg]'s screens support picture-in-picture (ActivityInfo.FLAG_SUPPORTS_PICTURE_IN_PICTURE)? */
    fun canFloat(c: Context, pkg: String): Boolean = runCatching {
        @Suppress("DEPRECATION") val acts = c.packageManager.getPackageInfo(pkg, android.content.pm.PackageManager.GET_ACTIVITIES).activities
        acts?.any { it.flags and 0x400000 != 0 } == true
    }.getOrDefault(false)
    fun setVideo(c: Context, pkg: String, on: Boolean) {
        val now = prefs(c).getStringSet("video_off", emptySet())!!.toMutableSet()
        if (if (on) now.remove(pkg) else now.add(pkg)) prefs(c).edit().putStringSet("video_off", now).apply()
        Log.i(TAG, "$pkg ${if (on) "is" else "isn't"} a video app")
        if (!on && floating == pkg) end("no longer a video app", pause = false)
    }

    /** The video app lock task is lifted for, while it's in front or floating. */
    @Volatile var floating: String? = null; private set
    /** Opie's screen mustn't lock while this is set (lock task would end the floating window). */
    fun holding() = floating != null
    private var seenAt = 0L     // the app last seen in front or floating
    private var playedAt = 0L   // something last heard playing
    private var otherSince = 0L // something else first seen in front (0: nothing else)

    /**
     * Before opening [pkg]: if it's a video app (and device control is on), lift lock task for it. From any thread
     * (Opie's open_app calls from its server's). False: open it as any other app, inside kiosk mode.
     */
    fun liftFor(c: Context, pkg: String): Boolean {
        if (!isVideo(c, pkg) || DeviceAccess.instance == null) return false
        val a = MainActivity.live ?: return false
        if (!DeviceOwner.isOwner(a)) return false
        watchScreen(c)
        val done = CountDownLatch(1)
        var ok = false
        val lift = Runnable {
            ok = runCatching { a.stopLockTask(); true }.onFailure { Log.w(TAG, "stopLockTask: $it") }.getOrDefault(false)
            if (ok) { val t = SystemClock.elapsedRealtime(); floating = pkg; seenAt = t; playedAt = t; otherSince = 0L; tick() }
            done.countDown()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) lift.run() else { main.post(lift); done.await(3, TimeUnit.SECONDS) }
        if (ok) Log.i(TAG, "lock task lifted for $pkg")
        return ok
    }

    private val ticker = Runnable { tick() }
    /** The windows changed (DeviceAccess), or a second went by: still floating? */
    fun check() { if (floating != null) main.post { tick() } }

    private fun tick() {
        main.removeCallbacks(ticker)
        val pkg = floating ?: return
        val acc = DeviceAccess.instance ?: return end("device control off", pause = true)
        val o = dev.openhouse.ui.Openhouse
        if (o.sleeping || o.dark) return end("the screen is asleep", pause = true)
        val t = SystemClock.elapsedRealtime()
        val wins = runCatching { acc.windows }.getOrDefault(emptyList())
        val pip = wins.any { runCatching { it.isInPictureInPictureMode }.getOrDefault(false) }
        val front = acc.foregroundPackage()
        val ours = front == null || front == acc.packageName || front == pkg || front == MainActivity.HOST_PKG || front.startsWith(AppStubs.PREFIX)
        if (pip || front == pkg) seenAt = t
        if (ours) otherSince = 0L else if (otherSince == 0L) otherSince = t
        val playing = runCatching { acc.getSystemService(AudioManager::class.java).isMusicActive }.getOrDefault(false)
        if (playing) playedAt = t
        when {
            otherSince > 0L && t - otherSince >= OTHER_MS -> return end("$front came to the front", pause = true)
            t - seenAt > GRACE_MS -> return end("not floating any more", pause = true)
            t - playedAt > QUIET_MS -> return end("nothing played for ${QUIET_MS / 60_000} minutes", pause = false)
        }
        if (pip && playing) o.videoPlaying(5_000) // Opie's resting screen waits while a video floats over it
        main.postDelayed(ticker, if (otherSince > 0L) (OTHER_MS - (t - otherSince)).coerceIn(100L, OTHER_MS) else 1000L)
    }

    /** Back to kiosk mode: the floating video paused (if [pause]), and Opie's screen locks again. */
    fun end(why: String, pause: Boolean) {
        val pkg = floating ?: return
        floating = null
        main.removeCallbacks(ticker)
        Log.i(TAG, "lock task back: $why")
        if (pause) runCatching { Media.pause(pkg) }
        val relock = Runnable {
            val a = MainActivity.live ?: return@Runnable
            // Android's own Home (Opie is Home) lands at once; starting Opie's activity from behind took seconds
            // (its onResume locks)
            if (a.inFront) a.relock()
            else if (DeviceAccess.instance?.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME) != true) KioskApps.goHome()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) relock.run() else main.post(relock)
    }

    /** Another Android app is opening while a video floats: kiosk mode first, as for anything else. From any thread. */
    fun beforeOther(pkg: String) {
        if (floating == null || floating == pkg) return
        if (Looper.myLooper() == Looper.getMainLooper()) { end("$pkg opened", pause = true); return }
        val done = CountDownLatch(1)
        main.post { end("$pkg opened", pause = true); done.countDown() }
        done.await(3, TimeUnit.SECONDS)
    }

    /** Someone left kiosk mode (Settings): nothing to put back. */
    fun forget() { floating = null; main.removeCallbacks(ticker) }

    @Volatile private var watching = false
    private fun watchScreen(c: Context) {
        if (watching) return
        watching = true
        c.applicationContext.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) { end("the screen went off", pause = true) }
        }, IntentFilter(Intent.ACTION_SCREEN_OFF))
    }

    /** For Opie (DeviceServer video_app) and the hold menu: is [pkg] one of the apps in Apps? */
    fun inApps(pkg: String) = AppStore.homeApps().any { it.first == pkg }
}
