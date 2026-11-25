package dev.openhouse.shell

// After a self-update: when the new release counts as good, and when UpdateGuard goes back to its rescue build. The
// rules alone, apart from Android (unit-tested: shell/app/src/test). docs/self-update.md, "Going back".
//
// A tablet can only be fixed by its next update, so a release has to show two things before its rescue goes:
//  1. It comes up: the bridge answers and the home screen's page loads, within healthS (five minutes) of the display
//     getting its chance, and again after every restart while the rescue is kept. That time is on the boot clock
//     (SystemClock.elapsedRealtime), from the install or from the restart, never from the wall clock: a restart in
//     the window gives the display its five minutes again instead of being judged seconds after boot. While someone
//     has left kiosk mode (Android settings, Wi-Fi, "Leave kiosk mode") from the new release, the display isn't judged
//     at all, even across a restart, and when it's opened again it gets its five minutes from then. Kiosk mode left
//     before the install doesn't count: a release that crashes before it's ever opened is still judged.
//  2. It can update again: its updater fetches and parses the update manifest, by the same check it makes every day
//     (Updater.check), tried every ten minutes until it works. What counts against it, and only when Android says the
//     network works (validated, so not a captive portal's page): an answer that arrives and that this release reads
//     wrongly, or rejects by the checks it applies to every manifest; and a fetch this release itself got wrong (its
//     own code failing, a request the server calls bad: an HTTP 4xx other than 401, 403, 408 and 429). The rest
//     proves nothing either way (offline, DNS, TLS, a timeout, a 5xx): the server, the network or the host's setup may
//     be the trouble. It goes back when, a day after the install, no try has worked and at least three counted
//     against it; with fewer, it keeps the rescue and keeps trying, hourly, until one works.
// Even once both are true, the rescue stays staged until a day after the install, then it's thrown away ("settled"),
// unless a newer release comes first: that brings its own rescue. Going back, once begun, goes on until the rescue
// build takes over: a try cut off by a restart, one that fails, or one that hasn't finished within an hour is tried
// again (ten minutes after a failure), across restarts, up to RESCUE_TRIES tries. Only after the last of them, or a
// day after going back began, does the release stay, with the failure in the history, and updates go on.

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
     * Does a manifest that couldn't be fetched at all count against the release? Only what this release got wrong
     * itself: [ownError], its own code failed (not the network: a programming or configuration error, not an
     * IOException from the connection), or the server answered [status] 4xx to the request it built, other than
     * the ones about the tablet's credential (401, 403) or the server's load (408, 429). Not while Android hasn't
     * validated the network.
     */
    fun fetchFailureCounts(status: Int?, ownError: Boolean, networkValidated: Boolean): Boolean =
        networkValidated && (ownError || (status != null && status in 400..499 && status !in listOf(401, 403, 408, 429)))

    /**
     * Going back was started [sinceMs] ago (wall clock) and the rescue build hasn't taken over: that try is taken as
     * over after an hour (or when the clock has since been set back by more than that).
     */
    fun rescueStuck(sinceMs: Long): Boolean = sinceMs >= RESCUE_MS || sinceMs <= -RESCUE_MS

    /** How many times going back is tried before the release stays. */
    const val RESCUE_TRIES = 5
    private const val RESCUE_RETRY_MS = 10 * 60_000L

    /** Going back began [sinceMs] ago (wall clock): past a day (or the clock set back as far), it's given up on. */
    fun rescueAbandoned(sinceMs: Long): Boolean = sinceMs >= KEEP_MS || sinceMs <= -KEEP_MS

    sealed class Rescue {
        /** Start a try now. */
        object Try : Rescue()
        /** Look again in [ms]. */
        data class Wait(val ms: Long) : Rescue()
        /** It won't happen: the release stays. */
        data class GiveUp(val why: String) : Rescue()
    }

    /**
     * Going back, once begun. [tries]: tries started so far. [inFlight]: the latest is still going (started this boot,
     * no failure heard, not stuck), started [sinceStartMs] ago. [sinceFailMs]: since the latest failed, if it did (null
     * when it was cut off by a restart or ran out its hour: tried again at once).
     */
    fun rescue(tries: Int, inFlight: Boolean, sinceStartMs: Long, sinceFailMs: Long?): Rescue = when {
        inFlight -> Rescue.Wait((RESCUE_MS - sinceStartMs).coerceIn(5_000, RESCUE_MS))
        tries >= RESCUE_TRIES -> Rescue.GiveUp("it didn't finish in $tries tries")
        sinceFailMs != null && sinceFailMs in 0 until RESCUE_RETRY_MS -> Rescue.Wait(RESCUE_RETRY_MS - sinceFailMs)
        else -> Rescue.Try
    }
}
