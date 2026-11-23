package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleasesTest {
    private val sha = "a".repeat(64)
    private val base = "https://updates.example.org/stable/update.json"

    private fun manifest(extra: String = "", version: String = "1.2.3", code: Long = 1_02_03_00) =
        """{"schema":1,"version":"$version","versionCode":$code,"url":"display-$version.apk","sha256":"$sha","size":10$extra}"""

    @Test fun parseRejectsBadManifests() {
        fun bad(text: String, from: String = base) = assertThrows(Exception::class.java) { Releases.parse(text, from) }
        bad(manifest(code = 5)) // code doesn't match the version
        bad(manifest().replace(sha, "1234"))
        bad(manifest(""","rollout":150"""))
        bad(manifest().replace("display-1.2.3.apk", "http://evil.example/x.apk")) // plain http
        bad(manifest().replace("display-1.2.3.apk", "file:///sdcard/x.apk"))
        bad(manifest(""","rescue":{"version":"1.2.2","versionCode":1020200,"url":"r.apk","sha256":"$sha"}""")) // rescue below the release
        bad(manifest().replace("\"schema\":1", "\"schema\":2"))
        bad("not json")
    }

    @Test fun httpOnlyFromATestComputer() {
        val r = Releases.parse(manifest(), "http://10.0.2.2:8820/update.json")
        assertEquals("http://10.0.2.2:8820/display-1.2.3.apk", r.apk.url)
        assertFalse(Releases.allowedUrl("http://10.0.2.2/x.apk", "https://updates.example.org/update.json"))
        assertFalse(Releases.allowedUrl("http://192.168.1.5/x.apk", "http://192.168.1.5/update.json"))
    }

    @Test fun decide() {
        val r = Releases.parse(manifest(""","rollout":30,"minVersion":"1.1.0""""), base)
        assertEquals(Decision.UpToDate, Releases.decide(1_02_03_00, r, 0, emptySet()))
        assertEquals(Decision.UpToDate, Releases.decide(1_02_03_01, r, 0, emptySet())) // on its rescue build
        assertEquals(Decision.FailedHere, Releases.decide(1_01_05_00, r, 0, setOf(1_02_03_00L)))
        assertEquals(Decision.NotYet, Releases.decide(1_01_05_00, r, 30, emptySet()))
        assertEquals(Decision.Take(r, urgent = false), Releases.decide(1_01_05_00, r, 29, emptySet()))
        assertEquals(Decision.Take(r, urgent = true), Releases.decide(1_00_00_00, r, 99, emptySet())) // below the minimum: whatever the rollout
        assertEquals(Decision.Take(r, urgent = true), Releases.decide(1, r, 99, emptySet())) // a debug build
    }

    @Test fun mayInstall() {
        assertTrue(Releases.mayInstall(quiet = false, parentAsked = true, urgent = false, hasRescue = false, inNight = false))
        assertFalse(Releases.mayInstall(quiet = false, parentAsked = false, urgent = true, hasRescue = true, inNight = true))
        assertFalse(Releases.mayInstall(quiet = true, parentAsked = false, urgent = true, hasRescue = false, inNight = true)) // nothing to go back to
        assertFalse(Releases.mayInstall(quiet = true, parentAsked = false, urgent = false, hasRescue = true, inNight = false))
        assertTrue(Releases.mayInstall(quiet = true, parentAsked = false, urgent = false, hasRescue = true, inNight = true))
        assertTrue(Releases.mayInstall(quiet = true, parentAsked = false, urgent = true, hasRescue = true, inNight = false))
    }

    @Test fun signers() {
        assertTrue(Releases.signerAllowed(listOf("rel"), listOf("rel"), emptyList()))
        assertTrue(Releases.signerAllowed(listOf("debug"), listOf("rel"), listOf("debug", "rel"))) // rotated from the debug key
        assertFalse(Releases.signerAllowed(listOf("debug"), listOf("someone"), listOf("someone")))
        assertFalse(Releases.signerAllowed(emptyList(), listOf("rel"), emptyList()))
    }
}
