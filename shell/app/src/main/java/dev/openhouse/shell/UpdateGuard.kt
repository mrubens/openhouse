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
            RESULT -> {
                val st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -99)
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                Log.i(TAG, "rescue install: $st $msg")
                // Success replaces this app (the rescue build takes over); waiting on a person can't happen for an
                // owner, and if it does the hour runs out (UpdateHealth.rescueStuck). Anything else: that try failed.
                if (st != PackageInstaller.STATUS_SUCCESS && st != PackageInstaller.STATUS_PENDING_USER_ACTION) tryFailed(c, "the install failed (${msg ?: st})")
            }
            Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_BOOT_COMPLETED -> {
                if (intent.action == Intent.ACTION_BOOT_COMPLETED) booted(c)
                val p = watching(c) ?: return
                // Going back, once begun, carries on after a restart (a try cut off by it is tried again).
                val v = if (goingBack(p)) UpdateHealth.Verdict.Wait(30_000) else UpdateHealth.judge(watch(c, p))
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

        /** The update being watched: the one installed now, not yet settled, and not one whose going back failed. */
        fun watching(c: Context): JSONObject? {
            val p = pending(c) ?: return null
            if (code(c) != p.optLong("to") || File(dir(c), "healthy").exists() || rescueOver(p) != null) return null
            return p
        }

        /** Going back has begun (it goes on until the rescue build takes over or it's given up: UpdateHealth.rescue). */
        fun goingBack(p: JSONObject) = p.optBoolean("rescuing") || p.optInt("rescueTries", 0) > 0

        /**
         * Going back was tried and won't happen: why (its tries ran out, there's nothing to install, or a day passed
         * since it began). Null while it hasn't begun or is still going. The display notes it and stops watching
         * (Updater).
         */
        fun rescueOver(p: JSONObject): String? {
            p.optString("rescueFailed").takeIf { it.isNotEmpty() }?.let { return it }
            val began = p.optLong("rescueBegan", p.optLong("rescuedAt", 0))
            if (goingBack(p) && UpdateHealth.rescueAbandoned(System.currentTimeMillis() - began)) return "it didn't finish within a day"
            return null
        }

        /** Going back won't happen: say so in pending.json for the display, and take the cover down. */
        private fun rescueFailed(c: Context, why: String) {
            pending(c)?.let { write(c, it.put("rescuing", false).put("rescueFailed", why)) }
            cancel(c)
            UpdateCover.down(c)
            Log.w(TAG, "going back failed: $why")
        }

        /** One try failed (its install's result): take the cover down; the next try comes after a wait (judge). */
        private fun tryFailed(c: Context, why: String) {
            val p = pending(c)?.takeIf { it.optBoolean("rescuing") } ?: return
            write(c, p.put("rescuing", false).put("rescueFailedAt", System.currentTimeMillis()).put("rescueError", why))
            UpdateCover.down(c)
            Log.w(TAG, "going back, try ${p.optInt("rescueTries", 1)}: $why")
            judge(c)
        }

        // Kiosk mode left (DeviceOwner.leaveKiosk) and back (enterKiosk), for this process to see: kiosk.json in the
        // updates folder, with the release that left it. While the release being watched has left it, the display
        // isn't judged (UpdateHealth.judge); once it's back it has its health time from then. Left by the release from
        // before the install doesn't count: the new one may never get as far as opening and coming back to it.
        fun kioskLeft(c: Context) = writeKiosk(c, true)
        fun kioskBack(c: Context) { if (kiosk(c)?.optBoolean("left") == true) writeKiosk(c, false) }
        private fun kiosk(c: Context) = runCatching { JSONObject(File(dir(c), "kiosk.json").readText()) }.getOrNull()
        private fun writeKiosk(c: Context, left: Boolean) = runCatching {
            dir(c).mkdirs()
            val t = File(dir(c), "kiosk.json.tmp")
            t.writeText(JSONObject().put("left", left).put("code", code(c)).put("boot", bootCount(c)).put("elapsed", SystemClock.elapsedRealtime()).toString())
            if (!t.renameTo(File(dir(c), "kiosk.json"))) t.delete()
        }.onFailure { Log.w(TAG, "kiosk.json: $it") }

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
            val k = kiosk(c)
            val kioskLeft = k?.optBoolean("left") == true && k.optLong("code", -1) == p.optLong("to") // by this release
            // Back in kiosk mode this boot: its time starts again then.
            val back = k?.takeIf { !kioskLeft && boot >= 0 && it.optInt("boot", -2) == boot }?.let { el - it.optLong("elapsed") }
            return UpdateHealth.Watch(
                hasRescue = p.optLong("rescueCode", 0) > 0,
                healthMs = p.optInt("healthS", 300) * 1000L,
                startedMs = (if (back != null) minOf(started, back) else started).coerceAtLeast(0),
                upThisBoot = p.has("upBoot") && p.getInt("upBoot") == boot,
                proven = p.optBoolean("proven"),
                failures = p.optInt("failures", 0),
                sinceInstallMs = (now - p.optLong("at", now)).coerceAtLeast(0),
                kioskLeft = kioskLeft,
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

        /** Time to look: wait more, settle, or go back to the rescue build (and, once going back, carry on with it). */
        fun judge(c: Context) {
            val p = watching(c) ?: return
            if (goingBack(p)) return goBack(c, p, p.optString("why", "didn't start properly"))
            when (val v = UpdateHealth.judge(watch(c, p))) {
                is UpdateHealth.Verdict.Wait -> schedule(c, v.ms.coerceAtLeast(5_000))
                UpdateHealth.Verdict.Settle -> settle(c, p)
                is UpdateHealth.Verdict.GoBack -> goBack(c, p, v.why)
            }
        }

        /**
         * Going back: a try now, or a look later while one is going or after one failed (UpdateHealth.rescue). The
         * first try commits the staged rescue build; later ones (the session used or lost) install it from the file.
         */
        private fun goBack(c: Context, p: JSONObject, why: String) {
            if (p.optLong("rescueCode", 0) <= 0) { Log.w(TAG, "version ${p.optString("version")} $why and there's no rescue build to go back to"); return }
            val now = System.currentTimeMillis()
            val boot = bootCount(c)
            val tries = p.optInt("rescueTries", if (p.optBoolean("rescuing")) 1 else 0)
            val started = p.optLong("rescuedAt", now)
            val thisBoot = boot >= 0 && p.optInt("rescueBoot", -2) == boot
            val inFlight = p.optBoolean("rescuing") && thisBoot && !UpdateHealth.rescueStuck(now - started)
            val failedAt = p.optLong("rescueFailedAt", 0).takeIf { it > 0 && !p.optBoolean("rescuing") }
            when (val step = UpdateHealth.rescue(tries, inFlight, now - started, failedAt?.let { now - it })) {
                is UpdateHealth.Rescue.Wait -> return schedule(c, step.ms)
                is UpdateHealth.Rescue.GiveUp -> return rescueFailed(c, p.optString("rescueError").ifEmpty { null }?.let { "${step.why}; the last: $it" } ?: step.why)
                UpdateHealth.Rescue.Try -> {}
            }
            write(c, p.put("rescuing", true).put("rescuedAt", now).put("rescueBoot", boot).put("rescueTries", tries + 1)
                .put("rescueBegan", p.optLong("rescueBegan", now)).put("why", why))
            schedule(c, UpdateHealth.RESCUE_MS) // looked at again if this try never finishes
            Log.w(TAG, "version ${p.optString("version")} $why: going back to ${p.optString("rescueVersion")} (try ${tries + 1})")
            UpdateCover.up(c, face = false)
            val pi = c.packageManager.packageInstaller
            val sender = PendingIntent.getBroadcast(c, 0, Intent(RESULT).setPackage(c.packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE).intentSender
            val staged = p.optInt("session", -1)
            val ok = tries == 0 && staged >= 0 && runCatching { pi.openSession(staged).use { it.commit(sender) }; true }.onFailure { Log.w(TAG, "staged session $staged: $it") }.getOrDefault(false)
            if (ok) return
            val f = File(dir(c), "rescue.apk")
            if (!f.exists()) { rescueFailed(c, "there's no rescue build on the tablet"); return }
            runCatching {
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(c.packageName)
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val id = pi.createSession(params)
                pi.openSession(id).use { s -> f.inputStream().use { i -> s.openWrite("base.apk", 0, f.length()).use { o -> i.copyTo(o, 1 shl 16); s.fsync(o) } }; s.commit(sender) }
            }.onFailure { tryFailed(c, "couldn't install it from the file ($it)") }
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
