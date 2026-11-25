package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PinnedTest {
    private val bytes = "{\"schema\":1}".toByteArray()
    private val sha = Pinned.sha256(bytes)

    @Test fun takesOnlyWhatTheBuildPinned() {
        assertEquals(64, sha.length)
        Pinned.check("x", sha, sha, unpinnedOk = false)
        Pinned.check("x", sha.uppercase(), sha, unpinnedOk = false)
        assertThrows(IllegalStateException::class.java) { Pinned.check("x", sha, Pinned.sha256("{\"schema\":2}".toByteArray()), unpinnedOk = false) }
        // A pin is a pin, in a debug build too.
        assertThrows(IllegalStateException::class.java) { Pinned.check("x", sha, "0".repeat(64), unpinnedOk = true) }
    }

    @Test fun noPinIsOnlyForDebugBuilds() {
        assertThrows(IllegalStateException::class.java) { Pinned.check("x", "", sha, unpinnedOk = false) }
        Pinned.check("x", "", sha, unpinnedOk = true)
    }

    @Test fun fileAndBytesHashAlike() {
        val f = java.io.File.createTempFile("pinned", ".bin").apply { deleteOnExit(); writeBytes(bytes) }
        assertEquals(sha, Pinned.sha256(f))
    }
}
