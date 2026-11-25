package dev.openhouse.shell

import dev.openhouse.shell.UpdateHealth.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateHealthTest {
    private val min = 60_000L
    private val hour = 60 * min
    private fun w(up: Boolean = true, started: Long = 0, proven: Boolean = false, failures: Int = 0, since: Long = 0, rescue: Boolean = true, kioskLeft: Boolean = false) =
        UpdateHealth.Watch(hasRescue = rescue, healthMs = 5 * min, startedMs = started, upThisBoot = up, proven = proven, failures = failures, sinceInstallMs = since, kioskLeft = kioskLeft)
    private fun goesBack(v: Verdict) = v is Verdict.GoBack

    @Test fun notUpGoesBackOnlyAfterItsTimeOnTheBootClock() {
        assertEquals(Verdict.Wait(5 * min - 10_000), UpdateHealth.judge(w(up = false, started = 10_000)))
        assertTrue(goesBack(UpdateHealth.judge(w(up = false, started = 5 * min))))
        // Restarted hours after the install, seconds into this boot: its five minutes again, not judged at once.
        assertFalse(goesBack(UpdateHealth.judge(w(up = false, started = 20_000, since = 3 * hour, proven = true))))
    }

    @Test fun rescueKeptADayEvenWhenProven() {
        assertEquals(Verdict.Wait(UpdateHealth.KEEP_MS - hour), UpdateHealth.judge(w(proven = true, since = hour)))
        assertEquals(Verdict.Settle, UpdateHealth.judge(w(proven = true, since = UpdateHealth.KEEP_MS)))
        assertEquals(Verdict.Settle, UpdateHealth.judge(w(rescue = false))) // nothing to keep
    }

    @Test fun anUpdaterThatCantCheckGoesBackButOfflineDoesnt() {
        val day = UpdateHealth.KEEP_MS
        assertFalse(goesBack(UpdateHealth.judge(w(failures = 10, since = hour)))) // not before the day is out
        assertTrue(goesBack(UpdateHealth.judge(w(failures = UpdateHealth.MIN_FAILURES, since = day))))
        assertFalse(goesBack(UpdateHealth.judge(w(failures = 0, since = 3 * day)))) // offline the whole time: keep waiting
        assertFalse(goesBack(UpdateHealth.judge(w(failures = 10, proven = true, since = day))))
        // Only an answer that arrived and couldn't be read as a manifest counts, and only on a validated network:
        // not reaching the server at all (DNS, TLS, any HTTP status) proves nothing.
        assertTrue(UpdateHealth.failureCounts(badAnswer = true, networkValidated = true))
        assertFalse(UpdateHealth.failureCounts(badAnswer = true, networkValidated = false)) // a captive portal's page
        assertFalse(UpdateHealth.failureCounts(badAnswer = false, networkValidated = true))
        assertFalse(UpdateHealth.failureCounts(badAnswer = false, networkValidated = false))
    }

    @Test fun notJudgedWhileKioskModeIsLeft() {
        // Out of kiosk (Android settings, "Leave kiosk mode", a restart meanwhile): never goes back for it.
        assertEquals(Verdict.Wait(5 * min), UpdateHealth.judge(w(up = false, started = 2 * hour, kioskLeft = true)))
        assertEquals(Verdict.Wait(5 * min), UpdateHealth.judge(w(failures = 10, since = UpdateHealth.KEEP_MS, kioskLeft = true)))
        assertEquals(Verdict.Settle, UpdateHealth.judge(w(proven = true, since = UpdateHealth.KEEP_MS, kioskLeft = true))) // a good one still settles
    }

    @Test fun aStuckRescueExpiresAfterAnHour() {
        assertFalse(UpdateHealth.rescueStuck(10 * min))
        assertTrue(UpdateHealth.rescueStuck(UpdateHealth.RESCUE_MS))
        assertFalse(UpdateHealth.rescueStuck(-10_000)) // the clock set back a little: still going
        assertTrue(UpdateHealth.rescueStuck(-2 * hour))
    }

    @Test fun goingBackIsTriedAgainUntilItsTriesRunOut() {
        val R = UpdateHealth.Rescue.Try
        assertEquals(R, UpdateHealth.rescue(tries = 0, inFlight = false, sinceStartMs = 0, sinceFailMs = null))
        assertTrue(UpdateHealth.rescue(1, inFlight = true, sinceStartMs = 10 * min, sinceFailMs = null) is UpdateHealth.Rescue.Wait) // still going
        // Cut off by a restart, or no result within its hour: tried again at once; a failed one, after a wait.
        assertEquals(R, UpdateHealth.rescue(1, inFlight = false, sinceStartMs = 2 * min, sinceFailMs = null))
        assertTrue(UpdateHealth.rescue(1, inFlight = false, sinceStartMs = 2 * min, sinceFailMs = min) is UpdateHealth.Rescue.Wait)
        assertEquals(R, UpdateHealth.rescue(2, inFlight = false, sinceStartMs = hour, sinceFailMs = hour))
        assertTrue(UpdateHealth.rescue(UpdateHealth.RESCUE_TRIES, inFlight = false, sinceStartMs = hour, sinceFailMs = null) is UpdateHealth.Rescue.GiveUp)
        assertFalse(UpdateHealth.rescueAbandoned(6 * hour))
        assertTrue(UpdateHealth.rescueAbandoned(UpdateHealth.KEEP_MS))
    }

    @Test fun aReleaseThatCantFetchAtAllCountsOnlyForItsOwnFault() {
        assertTrue(UpdateHealth.fetchFailureCounts(status = null, ownError = true, networkValidated = true))
        assertTrue(UpdateHealth.fetchFailureCounts(status = 404, ownError = false, networkValidated = true))
        assertFalse(UpdateHealth.fetchFailureCounts(status = 503, ownError = false, networkValidated = true))
        assertFalse(UpdateHealth.fetchFailureCounts(status = 401, ownError = false, networkValidated = true))
        assertFalse(UpdateHealth.fetchFailureCounts(status = null, ownError = false, networkValidated = true)) // a timeout, DNS
        assertFalse(UpdateHealth.fetchFailureCounts(status = null, ownError = true, networkValidated = false))
    }
}
