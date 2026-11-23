package dev.openhouse.shell

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinLogicTest {
    private var clock = 1_000_000L

    @After fun reset() { ParentGrace.close() }

    @Test fun graceLastsTwoMinutes() {
        ParentGrace.now = { clock }
        assertFalse(ParentGrace.isOpen())
        ParentGrace.open()
        clock += 119_000
        assertTrue(ParentGrace.isOpen())
        clock += 2_000
        assertFalse(ParentGrace.isOpen())
    }

    @Test fun graceEndsWhenClosed() {
        ParentGrace.now = { clock }
        ParentGrace.open()
        ParentGrace.close()
        assertFalse(ParentGrace.isOpen())
    }

    @Test fun unlockingAgainRestartsTheWindow() {
        ParentGrace.now = { clock }
        ParentGrace.open()
        clock += 100_000
        ParentGrace.open()
        clock += 100_000
        assertTrue(ParentGrace.isOpen())
    }

    @Test fun knownLengthChecksOnTheLastDigit() {
        val e = PinEntry(4)
        assertFalse(e.digit('1')); assertFalse(e.digit('2')); assertFalse(e.digit('3'))
        assertTrue(e.digit('4'))
        assertEquals("1234", e.text)
        assertFalse(e.wantsOk)
        assertFalse(e.digit('5')) // full: ignored
        assertEquals("1234", e.text)
    }

    @Test fun unknownLengthWantsOkFromFourDigits() {
        val e = PinEntry(null)
        "123".forEach { assertFalse(e.digit(it)) }
        assertFalse(e.wantsOk)
        assertFalse(e.digit('4'))
        assertTrue(e.wantsOk)
        "56789".forEach { e.digit(it) }
        assertEquals("12345678", e.text) // 8 at most
    }
}
