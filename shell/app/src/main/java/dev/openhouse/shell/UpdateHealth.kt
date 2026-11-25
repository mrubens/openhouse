package dev.openhouse.shell

// After a self-update: when the new release counts as good, and when UpdateGuard goes back to its rescue build. The
// rules alone, apart from Android (unit-tested: shell/app/src/test). docs/self-update.md, "Going back".
//
// A tablet can only be fixed by its next update, so a release has to show two things before its rescue goes:
//  1. It comes up: the bridge answers and the home screen's page loads, within healthS (five minutes) of the display
//     getting its chance, and again after every restart while the rescue is kept. That time is on the boot clock
//     (SystemClock.elapsedRealtime), from the install or from the restart, never from the wall clock: a restart in
//     the window gives the display its five minutes again instead of being judged seconds after boot. While someone
//     has left kiosk mode (Android settings, Wi-Fi, "Leave kiosk mode") the display isn't judged at all, even across a
//     restart, and when it's opened again it gets its five minutes from then.
//  2. It can update again: its updater fetches and parses the update manifest, by the same check it makes every day
//     (Updater.check), tried every ten minutes until it works. Only an answer that arrives and that this release reads
//     wrongly, or rejects by the checks it applies to every manifest, counts against it, and only when Android says the
//     network works (validated, so not a captive portal's page). Not reaching the server (offline, DNS, TLS, a
//     timeout) or any HTTP status other than 200 proves nothing either way: the server, the network or the host's
//     setup may be the trouble. It goes back when, a day after the install, no try has worked and at least three
//     counted against it; with fewer, it keeps the rescue and keeps trying, hourly, until one works.
// Even once both are true, the rescue stays staged until a day after the install, then it's thrown away ("settled"),
// unless a newer release comes first: that brings its own rescue. Going back is tried once: if the rescue install
// fails, or hasn't finished within an hour, the release stays, the failure goes in the history, and updates go on.

object UpdateHealth {
    const val KEEP_MS = 24 * 60 * 60_000L
    const val MIN_FAILURES = 3
    /** How long going back may take before it's taken as failed. */
    const val RESCUE_MS = 60 * 60_000L
    private const val RETRY_MS = 10 * 60_000L
    private const val LATE_RETRY_MS = 60 * 60_000L

    /**
     * What's known about the release being watched.
     * [startedMs]: how long, on the boot clock, the display has had to come up since the install or since this boot.
     * [upThisBoot]: it came up (bridge and home screen) since the tablet last started.
     * [proven]: a manifest check by this release worked. [failures]: tries that counted against it.
     * [sinceInstallMs]: wall-clock time since the install (only for the day the rescue is kept).
     * [kioskLeft]: someone has left kiosk mode and the display hasn't been opened again since.
     */
    data class Watch(
        val hasRescue: Boolean,
        val healthMs: Long,
        val startedMs: Long,
        val upThisBoot: Boolean,
        val proven: Boolean,
        val failures: Int,
        val sinceInstallMs: Long,
        val kioskLeft: Boolean = false,
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
        val v = judgeInKiosk(w)
        return if (w.kioskLeft && v is Verdict.GoBack) Verdict.Wait(w.healthMs) else v // not while someone is out of kiosk
    }

    private fun judgeInKiosk(w: Watch): Verdict {
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
     * Does a manifest check that failed count against the release? [badAnswer]: the server's 200 arrived and this
     * release couldn't read it as a manifest or rejected it (false: it couldn't be fetched at all, for any reason, or
     * the server answered with another status). Not while Android hasn't validated the network (offline, or a captive
     * portal's page in place of the answer).
     */
    fun failureCounts(badAnswer: Boolean, networkValidated: Boolean): Boolean = badAnswer && networkValidated

    /**
     * Going back was started [sinceMs] ago (wall clock) and the rescue build hasn't taken over: it's taken as failed
     * after an hour (or when the clock has since been set back by more than that).
     */
    fun rescueStuck(sinceMs: Long): Boolean = sinceMs >= RESCUE_MS || sinceMs <= -RESCUE_MS
}
