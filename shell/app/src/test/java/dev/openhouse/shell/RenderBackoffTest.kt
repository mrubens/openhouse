package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/** A renderer that keeps going must not be brought back in a tight loop (each time takes the page's memory again). */
class RenderBackoffTest {
    @Test fun firstAtOnceThenLongerUpToTheCap() {
        val b = RenderBackoff(quietMs = 600_000, steps = longArrayOf(0, 2_000, 10_000, 300_000))
        var t = 1_000L
        val delays = (1..6).map { b.next(t).also { d -> t += d + 1_000 } }
        assertEquals(listOf(0L, 2_000L, 10_000L, 300_000L, 300_000L, 300_000L), delays)
    }

    @Test fun startsOverAfterAQuietSpell() {
        val b = RenderBackoff(quietMs = 600_000, steps = longArrayOf(0, 2_000, 10_000))
        assertEquals(0L, b.next(0))
        assertEquals(2_000L, b.next(5_000))
        assertEquals(0L, b.next(5_000 + 600_000))
    }
}
