package dev.openhouse.host

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.FrameLayout

/**
 * A plain cover in the home screen's paper (Calm.PAPER in the display), shown while the display (dev.openhouse.shell) is being updated.
 * This app isn't replaced in that update, so the cover stays on screen while the display is gone,
 * instead of the tablet's own home screen flashing by. Once the new display is installed (or after
 * a few minutes, if no update came), it opens the display again and goes away.
 *
 *   adb shell am start -n dev.openhouse.host/.CoverActivity   (scripts/install-display.sh does this)
 */
class CoverActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val display = ComponentName(BuildConfig.DISPLAY_PKG, "dev.openhouse.shell.MainActivity")
    private var since = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#EFEAE1")) })
        window.insetsController?.let { it.hide(WindowInsets.Type.systemBars()); it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE }
        // When the update asked for it (the display says, in "at"): a cover Android recreates long after, from its old
        // task, knows its update is over.
        since = intent.getLongExtra("at", 0L).takeIf { it > 0 } ?: System.currentTimeMillis()
        // Pin the cover (this app is on the kiosk list): while the display is gone, Android can't bring
        // the tablet's own home screen up over it.
        runCatching { startLockTask() }
        main.postDelayed(check, 1000)
    }

    private fun updated() = runCatching { packageManager.getPackageInfo(display.packageName, 0).lastUpdateTime > since }.getOrDefault(false)

    private val check = object : Runnable {
        override fun run() {
            val waited = System.currentTimeMillis() - since
            if (updated() || waited > 180_000) {
                done = true
                runCatching { startActivity(Intent(Intent.ACTION_MAIN).setComponent(display).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                main.postDelayed({ uncover() }, 2500) // let the display draw first, then uncover it
            } else main.postDelayed(this, 150)
        }
    }

    private var done = false

    /**
     * A cover left over from an earlier update (it stayed in its task) that Android brought back, say when someone
     * came back from the tablet's Settings: it covered the home screen for minutes. Its update is over: open the
     * display and go.
     */
    override fun onResume() {
        super.onResume()
        if (done || System.currentTimeMillis() - since > 180_000) {
            done = true; main.removeCallbacksAndMessages(null)
            runCatching { startActivity(Intent(Intent.ACTION_MAIN).setComponent(display).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            main.postDelayed({ uncover() }, 1000)
        }
    }

    /**
     * Go, leaving no task behind for Android to bring back. The cover is pinned (lock task), and Android won't let a
     * pinned screen close itself: unpin it first, then the display pins itself again (it does on a new intent).
     */
    private fun uncover() {
        runCatching { stopLockTask() }
        finishAndRemoveTask()
        runCatching { startActivity(Intent(Intent.ACTION_MAIN).setComponent(display).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    /** Something came up over the cover before the display was back (the tablet's home): come back on top. */
    override fun onStop() {
        super.onStop()
        if (!done && !isFinishing) runCatching { startActivity(Intent(this, CoverActivity::class.java).putExtra("at", since).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)) }
    }

    override fun onDestroy() { main.removeCallbacksAndMessages(null); super.onDestroy() }
    @Deprecated("Back does nothing here")
    override fun onBackPressed() {}
}
