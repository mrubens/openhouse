package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The PIN's recovery code (RecoveryCode): the one way back past a PIN someone else chose, so it must check right. */
class PinRecoveryTest {
    @Test fun aNewCodeIsSixteenCharactersOfTheAlphabet() {
        val code = RecoveryCode.new()
        assertEquals(19, code.length) // XXXX-XXXX-XXXX-XXXX
        assertEquals(RecoveryCode.LENGTH, RecoveryCode.clean(code)!!.length)
        assertTrue(RecoveryCode.clean(code)!!.all { it in RecoveryCode.ALPHABET })
    }

    @Test fun theKeptHashChecksTheCodeAsTyped() {
        val code = RecoveryCode.new()
        val salt = RecoveryCode.newSalt()
        val kept = RecoveryCode.hash(code, salt)!!
        assertTrue(RecoveryCode.matches(code, salt, kept))
        // Typed loosely: lower case, spaces for dashes.
        assertTrue(RecoveryCode.matches(code.lowercase().replace('-', ' '), salt, kept))
        assertFalse(RecoveryCode.matches(RecoveryCode.new(), salt, kept))
        assertFalse(RecoveryCode.matches(code, RecoveryCode.newSalt(), kept)) // another salt
        assertFalse(RecoveryCode.matches("", salt, kept))
        assertFalse(RecoveryCode.matches(code.dropLast(1), salt, kept))
    }

    @Test fun notACodeIsNeverHashed() {
        assertNull(RecoveryCode.clean("1234"))
        assertNull(RecoveryCode.clean("UUUU-UUUU-UUUU-UUUU")) // U isn't in the alphabet
        assertEquals("0111" + "A".repeat(12), RecoveryCode.clean("oIlL-aaaa-aaaa-aaaa")) // O for 0, I and L for 1
    }

    @Test fun theBackupsCodeMustMatchInFull() {
        val backup = "0123-4567-89AB-CDEF-GHJK-MNPQ-RS"
        assertTrue(RecoveryCode.sameBackupCode("0123 4567 89ab cdef ghjk mnpq rs", backup))
        assertFalse(RecoveryCode.sameBackupCode("0123-4567-89AB-CDEF-GHJK-MNPQ-RT", backup))
        assertFalse(RecoveryCode.sameBackupCode("", ""))
        assertFalse(RecoveryCode.sameBackupCode("0123", "0123")) // not a backup code at all
    }
}
