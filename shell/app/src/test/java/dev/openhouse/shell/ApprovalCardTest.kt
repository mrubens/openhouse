package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

/** The approval card shows everything the voice model is told, or says no: never a cut list (DeviceServer /approve). */
class ApprovalCardTest {
    // The longest voice action the bridge lets through (bridge/plugins.js ACTION_LIMITS), in the card's words
    // (actionWords): a 600-character description, 8 parameters of 200 characters with 20 choices of 60 each.
    private val longestAction = "x".repeat(600) + " (as \"" + "a".repeat(31) + "\", with " +
        (1..8).joinToString("; ") { "p${"a".repeat(29)}$it: ${"d".repeat(200)}, one of ${(1..20).joinToString(", ") { "c".repeat(60) }}" } + ")"

    @Test fun theBridgesLongestFits() {
        val rights = List(16 * 20) { "voice" to "The voice can ask it to: $longestAction (an app's name)." }
        assertNull(ApprovalCard.tooLong("Add a plugin?", "", "v1.0.0", rights))
    }

    @Test fun moreThanItCanShowIsRefused() {
        assertNotNull(ApprovalCard.tooLong("Add?", "", null, listOf("voice" to "x".repeat(ApprovalCard.Limits.RIGHT + 1))))
        assertNotNull(ApprovalCard.tooLong("Add?", "", null, List(ApprovalCard.Limits.RIGHTS + 1) { "data" to "Uses lists." }))
        assertNotNull(ApprovalCard.tooLong("Add?", "x".repeat(ApprovalCard.Limits.DETAIL + 1), null, emptyList()))
        assertNotNull(ApprovalCard.tooLong("Add?", "", "x".repeat(ApprovalCard.Limits.MORE + 1), emptyList()))
    }

    // A name can't push what the card says it may do out of sight, or reorder or hide its words.
    @Test fun wordsOnTheCardStayInPlace() {
        val name = "Dino" + "\n".repeat(40) + "‮evil‬​ Eggs\u0007"
        val one = ApprovalCard.plain(name)
        assertFalse(one.any { it == '\n' || it == '‮' || it == '‬' || it == '​' || it == ' ' || it.isISOControl() })
        assertTrue(one.startsWith("Dino") && one.contains("evil") && one.contains("Eggs"))
        val text = ApprovalCard.plain("A line\n\n\n\n\nand the next⁦ one", lines = true)
        assertEquals(2, text.lines().size)
        assertFalse(text.contains('⁦'))
    }
}
