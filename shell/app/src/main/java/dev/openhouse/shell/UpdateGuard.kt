package dev.openhouse.shell

// After a self-update (Updater): watch the new display, and go back to the release's rescue build, staged before the
// update, if it doesn't come up or can't check for updates (the rules, and why: UpdateHealth). The rescue is kept a
// day either way. This runs in its own process (":guard"), apart from everything the display does on screen, so a
// display that crashes as it starts still gets taken back. It's kept small, and changes rarely.

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
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.File

/** The new display arrived (or the tablet restarted mid-update): watch it. Also the rescue install's result. */
class UpdateGuard : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        when (intent.action) {
            RESULT -> Log.i(TAG, "rescue install: ${intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -99)} ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
            Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_BOOT_COMPLETED -> {
                if (intent.action == Intent.ACTION_BOOT_COMPLETED) booted(c)
                val p = watching(c) ?: return
                val v = UpdateHealth.judge(watch(c, p))
                val after = (v as? UpdateHealth.Verdict.Wait)?.ms?.coerceAtLeast(5_000) ?: 5_000
                schedule(c, after)
                Log.i(TAG, "watching version ${p.optString("version")}: looking again in ${after / 1000} s")
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
        /** Android's count of this tablet's starts: tells one boot's clock from the next. -1 if it isn't there. */
        fun bootCount(c: Context) = Settings.Global.getInt(c.contentResolver, Settings.Global.BOOT_COUNT, -1)

        /** The update being watched: the one installed now, not yet settled. */
        fun watching(c: Context): JSONObject? {
            val p = pending(c) ?: return null
            if (code(c) != p.optLong("to") || File(dir(c), "healthy").exists()) return null
            return p
        }

        /** Written whole (through a temporary file): the display and this process both read it. */
        fun write(c: Context, p: JSONObject) {
            val t = File(dir(c), "pending.json.tmp")
            t.writeText(p.toString())
            if (!t.renameTo(File(dir(c), "pending.json"))) { File(dir(c), "pending.json").writeText(p.toString()); t.delete() }
        }

        /**
         * When, on the boot clock, this boot was first seen (BOOT_COMPLETED, or the guard or display looking before it
         * came): after a restart, the display's time starts here, not when the tablet was switched on (it may have
         * sat locked).
         */
        private fun booted(c: Context): Long {
            val f = File(dir(c), "booted.json")
            val boot = bootCount(c)
            runCatching { JSONObject(f.readText()) }.getOrNull()?.takeIf { it.optInt("boot", -2) == boot }?.let { return it.optLong("elapsed") }
            val el = SystemClock.elapsedRealtime()
            runCatching { dir(c).mkdirs(); f.writeText(JSONObject().put("boot", boot).put("elapsed", el).toString()) }
            return el
        }

        /** Where the update being watched stands now (UpdateHealth.Watch). */
        fun watch(c: Context, p: JSONObject): UpdateHealth.Watch {
            val boot = bootCount(c)
            val el = SystemClock.elapsedRealtime()
            val now = System.currentTimeMillis()
            val started = when {
                boot >= 0 && p.has("boot") && p.has("atElapsed") ->
                    if (p.getInt("boot") == boot) el - p.getLong("atElapsed") // installed in this boot
                    else el - booted(c) // installed before a restart: since this boot was first seen
                else -> minOf(el - booted(c), now - p.optLong("at", now)) // written by a release from before the boot clock
            }
            return UpdateHealth.Watch(
                hasRescue = p.optLong("rescueCode", 0) > 0,
                healthMs = p.optInt("healthS", 300) * 1000L,
                startedMs = started.coerceAtLeast(0),
                upThisBoot = p.has("upBoot") && p.getInt("upBoot") == boot,
                proven = p.optBoolean("proven"),
                failures = p.optInt("failures", 0),
                sinceInstallMs = (now - p.optLong("at", now)).coerceAtLeast(0),
            )
        }

        fun schedule(c: Context, afterMs: Long) {
            val js = c.getSystemService(JobScheduler::class.java)
            js.schedule(JobInfo.Builder(JOB, ComponentName(c, GuardJob::class.java))
                .setMinimumLatency(afterMs).setOverrideDeadline(afterMs + 30_000).setPersisted(true).build())
        }

        fun cancel(c: Context) = c.getSystemService(JobScheduler::class.java).cancel(JOB)

        /** Good: throw away the staged rescue (session and file) and stop watching. From the display or this process. */
        fun settle(c: Context, p: JSONObject) {
            p.optInt("session", -1).takeIf { it >= 0 }?.let { runCatching { c.packageManager.packageInstaller.abandonSession(it) } }
            File(dir(c), "rescue.apk").delete()
            File(dir(c), "healthy").writeText(p.optLong("to").toString())
            File(dir(c), "pending.json").delete()
            cancel(c)
            Log.i(TAG, "version ${p.optString("version")} settled: its rescue build is thrown away")
        }

        /** Time to look: wait more, settle, or go back to the rescue build. */
        fun judge(c: Context) {
            val p = watching(c) ?: return
            when (val v = UpdateHealth.judge(watch(c, p))) {
                is UpdateHealth.Verdict.Wait -> schedule(c, v.ms.coerceAtLeast(5_000))
                UpdateHealth.Verdict.Settle -> settle(c, p)
                is UpdateHealth.Verdict.GoBack -> goBack(c, p, v.why)
            }
        }

        /** Commit the staged rescue build (or, if the session was lost, install it from the file). */
        private fun goBack(c: Context, p: JSONObject, why: String) {
            if (p.optLong("rescueCode", 0) <= 0) { Log.w(TAG, "version ${p.optString("version")} $why and there's no rescue build to go back to"); return }
            if (p.optBoolean("rescuing")) { Log.w(TAG, "already went back once: not again"); return }
            write(c, p.put("rescuing", true).put("rescuedAt", System.currentTimeMillis()).put("why", why))
            Log.w(TAG, "version ${p.optString("version")} $why: going back to ${p.optString("rescueVersion")}")
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

/** The check itself, when it's time to look at the new display again. */
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
