package dev.openhouse.shell

// After a self-update (Updater): if the new display hasn't come up healthy (the bridge answering, the door's page
// loaded) in a few minutes, go back to the release's rescue build, staged before the update. This runs in its own
// process (":guard"), apart from everything the display does on screen, so a display that crashes as it starts still
// gets taken back. It's kept small, and changes rarely.

import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.File

/** The new display arrived (or the tablet restarted mid-update): watch it. Also the rescue install's result. */
class UpdateGuard : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        when (intent.action) {
            RESULT -> Log.i(TAG, "rescue install: ${intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -99)} ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
            Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_BOOT_COMPLETED -> {
                val p = pending(c) ?: return
                if (code(c) != p.optLong("to")) return // not the update being watched (the rescue build, or the update didn't land)
                if (File(dir(c), "healthy").exists()) return
                val left = p.optLong("at") + p.optInt("healthS", 300) * 1000L - System.currentTimeMillis()
                schedule(c, left.coerceAtLeast(5_000))
                Log.i(TAG, "watching version ${p.optString("version")}: ${left / 1000} s to come up healthy")
            }
        }
    }

    companion object {
        private const val TAG = "UpdateGuard"
        private const val JOB = 0x0e0e
        const val RESULT = "dev.openhouse.shell.RESCUE_RESULT"
        fun dir(c: Context) = File(c.filesDir, "updates")
        fun pending(c: Context) = runCatching { JSONObject(File(dir(c), "pending.json").readText()) }.getOrNull()
        fun code(c: Context) = c.packageManager.getPackageInfo(c.packageName, 0).longVersionCode

        fun schedule(c: Context, afterMs: Long) {
            val js = c.getSystemService(JobScheduler::class.java)
            js.schedule(JobInfo.Builder(JOB, ComponentName(c, GuardJob::class.java))
                .setMinimumLatency(afterMs).setOverrideDeadline(afterMs + 30_000).setPersisted(true).build())
        }

        fun cancel(c: Context) = c.getSystemService(JobScheduler::class.java).cancel(JOB)

        /** Healthy by now? Else commit the staged rescue build (or, if the session was lost, install it from the file). */
        fun judge(c: Context) {
            val p = pending(c) ?: return
            if (code(c) != p.optLong("to") || File(dir(c), "healthy").exists()) return
            val rescueCode = p.optLong("rescueCode", 0)
            if (rescueCode <= 0) { Log.w(TAG, "version ${p.optString("version")} isn't healthy and there's no rescue build to go back to"); return }
            if (p.optBoolean("rescuing")) { Log.w(TAG, "already went back once: not again"); return }
            File(dir(c), "pending.json").writeText(p.put("rescuing", true).put("rescuedAt", System.currentTimeMillis()).toString())
            Log.w(TAG, "version ${p.optString("version")} didn't come up healthy: going back to ${p.optString("rescueVersion")}")
            UpdateCover.up(c, face = false)
            val pi = c.packageManager.packageInstaller
            val sender = PendingIntent.getBroadcast(c, 0, Intent(RESULT).setPackage(c.packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE).intentSender
            val staged = p.optInt("session", -1)
            val ok = staged >= 0 && runCatching { pi.openSession(staged).use { it.commit(sender) }; true }.onFailure { Log.w(TAG, "staged session $staged: $it") }.getOrDefault(false)
            if (ok) return
            val f = File(dir(c), "rescue.apk")
            if (!f.exists()) { Log.w(TAG, "no rescue build on the tablet"); UpdateCover.down(c); return }
            runCatching {
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(c.packageName)
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val id = pi.createSession(params)
                pi.openSession(id).use { s -> f.inputStream().use { i -> s.openWrite("base.apk", 0, f.length()).use { o -> i.copyTo(o, 1 shl 16); s.fsync(o) } }; s.commit(sender) }
            }.onFailure { Log.w(TAG, "rescue from file: $it"); UpdateCover.down(c) }
        }
    }
}

/** The check itself, when the new display's time is up. */
class GuardJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            runCatching { UpdateGuard.judge(this) }.onFailure { Log.w("UpdateGuard", "judge: $it") }
            jobFinished(params, false)
        }.start()
        return true
    }
    override fun onStopJob(params: JobParameters) = true
}
