package dev.openhouse.shell

import dev.openhouse.shell.UpdateHealth.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateHealthTest {
    private val min = 60_000L
    private val hour = 60 * min
    private fun w(up: Boolean = true, started: Long = 0, proven: Boolean = false, failures: Int = 0, since: Long = 0, rescue: Boolean = true) =
        UpdateHealth.Watch(hasRescue = rescue, healthMs = 5 * min, startedMs = started, upThisBoot = up, proven = proven, failures = failures, sinceInstallMs = since)
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
        // Only failures with a working network, and not the server's own trouble, count.
        assertFalse(UpdateHealth.failureCounts(null, networkValidated = false))
        assertFalse(UpdateHealth.failureCounts(404, networkValidated = false))
        assertFalse(UpdateHealth.failureCounts(503, networkValidated = true))
        assertFalse(UpdateHealth.failureCounts(429, networkValidated = true))
        assertTrue(UpdateHealth.failureCounts(404, networkValidated = true))
        assertTrue(UpdateHealth.failureCounts(null, networkValidated = true)) // no answer, or one that didn't parse
    }
}
