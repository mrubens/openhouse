package dev.openhouse.shell

// After a self-update: when the new release counts as good, and when UpdateGuard goes back to its rescue build. The
// rules alone, apart from Android (unit-tested: shell/app/src/test). docs/self-update.md, "Going back".
//
// A tablet can only be fixed by its next update, so a release has to show two things before its rescue goes:
//  1. It comes up: the bridge answers and the home screen's page loads, within healthS (five minutes) of the display
//     getting its chance, and again after every restart while the rescue is kept. That time is on the boot clock
//     (SystemClock.elapsedRealtime), from the install or from the restart, never from the wall clock: a restart in
//     the window gives the display its five minutes again instead of being judged seconds after boot.
//  2. It can update again: its updater fetches and parses the update manifest, by the same check it makes every day
//     (Updater.check), tried every ten minutes until it works. Being offline proves nothing either way, so a try counts
//     against the release only when Android says the network works (validated) and the server isn't the trouble (no
//     5xx or 429). It goes back when, a day after the install, no try has worked and at least three counted against
//     it; with fewer (offline all day), it keeps the rescue and keeps trying, hourly, until one works.
// Even once both are true, the rescue stays staged until a day after the install, then it's thrown away ("settled"),
// unless a newer release comes first: that brings its own rescue.

object UpdateHealth {
    const val KEEP_MS = 24 * 60 * 60_000L
    const val MIN_FAILURES = 3
    private const val RETRY_MS = 10 * 60_000L
    private const val LATE_RETRY_MS = 60 * 60_000L

    /**
     * What's known about the release being watched.
     * [startedMs]: how long, on the boot clock, the display has had to come up since the install or since this boot.
     * [upThisBoot]: it came up (bridge and home screen) since the tablet last started.
     * [proven]: a manifest check by this release worked. [failures]: tries that counted against it.
     * [sinceInstallMs]: wall-clock time since the install (only for the day the rescue is kept).
     */
    data class Watch(
        val hasRescue: Boolean,
        val healthMs: Long,
        val startedMs: Long,
        val upThisBoot: Boolean,
        val proven: Boolean,
        val failures: Int,
        val sinceInstallMs: Long,
    )

    sealed class Verdict {
        /** Look again in [ms]. */
        data class Wait(val ms: Long) : Verdict()
        /** Go back to the rescue build. */
        data class GoBack(val why: String) : Verdict()
        /** Good: throw the rescue away and stop watching. */
        object Settle : Verdict()
    }

    fun judge(w: Watch): Verdict {
        if (!w.upThisBoot) return if (w.startedMs >= w.healthMs) Verdict.GoBack("didn't start properly") else Verdict.Wait(w.healthMs - w.startedMs)
        if (!w.hasRescue) return Verdict.Settle // nothing to keep or go back to
        val left = KEEP_MS - w.sinceInstallMs
        return when {
            left > 0 -> Verdict.Wait(left)
            w.proven -> Verdict.Settle
            w.failures >= MIN_FAILURES -> Verdict.GoBack("couldn't check for updates")
            else -> Verdict.Wait(LATE_RETRY_MS)
        }
    }

    /** How long after the last manifest try the display tries again, while the release isn't proven. */
    fun retryMs(sinceInstallMs: Long) = if (sinceInstallMs < KEEP_MS) RETRY_MS else LATE_RETRY_MS

    /**
     * Does a manifest check that failed count against the release? [httpCode]: the server's answer, if it gave one
     * other than 200 (null: no answer, or a 200 that didn't parse). Not while Android hasn't validated the network
     * (offline, or a captive portal), and not when the server says it's the trouble.
     */
    fun failureCounts(httpCode: Int?, networkValidated: Boolean): Boolean = when {
        !networkValidated -> false
        httpCode == 429 || (httpCode != null && httpCode in 500..599) -> false
        else -> true
    }
}
