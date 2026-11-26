package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnKeyTest {
    @Test fun theRouteReachesOnlyOpenAisFixedCalls() {
        for (k in listOf("", "responses/../../evil", "https://example.com", "anything")) assertNull(OwnKey.target(k))
        // A kind it does know (none yet, until the requests move here) only ever goes to OpenAI's own address.
        for (k in listOf("live", "hangup", "responses", "decide")) OwnKey.target(k)?.let { assertTrue(it.startsWith("${OwnKey.OPENAI}/")) }
        assertEquals(404, OwnKey.forward("https://example.com", "{}").first) // refused before any key is read or anything sent
    }

    @Test fun onlyAKeyShapedPasteIsTaken() {
        assertEquals("sk-proj-abcdefghijklmnopqrstuvwxyz", OwnKey.clean("  sk-proj-abcdefghijklmnopqrstuvwxyz \n"))
        for (x in listOf("", "hello", "sk-short", "sk-proj-abc def ghi jkl mno pqr stu", "https://example.com/?k=sk-proj-abcdefghijklmnopqrstuvwxyz")) assertNull(OwnKey.clean(x))
    }
}
