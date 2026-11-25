package dev.openhouse.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log

/**
 * Keeps Opie on the network while another app is in front of it.
 *
 * Recent Android cuts a background app's UID off the network (the "background" firewall chain): every socket of the
 * UID is destroyed and its DNS fails. The bridge, the voice models and the relay are this process's children (Runtime:
 * proot and Node, in the same UID), so the moment a family app, a streaming app, or one of the household's own built
 * apps (AppHost.openStub) came in front, the bridge's requests died mid-way (ECONNABORTED, EAI_AGAIN), and an app
 * built on the tablet failed every time. A UID with a foreground service is let through, so this keeps one up.
 *
 * It runs for as long as the display's watchdog does (Watchdog.start/stop), not only while the shell is behind: it's
 * started while the display is in front, where Android lets any app start one (a device owner is exempt from the
 * background limits too, but a tablet set up without being one isn't); there's no gap at the switch while it comes up,
 * in which the first requests would already die; and nothing has to notice the shell going behind. A tablet with
 * device control on was kept important by its accessibility service (DeviceAccess), which is why it worked there;
 * this covers it with that off. Its notification is quiet ("Opie is running"); kiosk mode hides the shade anyway.
 */
class KeepOnline : Service() {
    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Opie running", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Keeps Opie connected while another app is open"; setShowBadge(false)
            })
            val n = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_running).setContentTitle("Opie is running")
                .setOngoing(true).setCategory(Notification.CATEGORY_SERVICE).build()
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(ID, n)
            Log.i(TAG, "in the foreground: the network stays on while another app is in front")
        } catch (t: Throwable) {
            Log.w(TAG, "couldn't go to the foreground; the network may be cut while another app is in front: $t")
            stopSelf()
        }
        // Not sticky: it lives in the display's process, which Android brings back as the home app; a service brought
        // back on its own would make a process with no display and no watchdog.
        return START_NOT_STICKY
    }

    companion object {
        private const val TAG = "KeepOnline"
        private const val CHANNEL = "running"
        private const val ID = 1

        fun start(c: Context) {
            runCatching { c.startForegroundService(Intent(c, KeepOnline::class.java)) }
                .onFailure { Log.w(TAG, "not started; the network may be cut while another app is in front: $it") }
        }

        fun stop(c: Context) { runCatching { c.stopService(Intent(c, KeepOnline::class.java)) } }
    }
}
