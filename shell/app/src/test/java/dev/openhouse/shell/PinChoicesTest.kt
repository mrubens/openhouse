package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// What asks for the PIN (PinChoices): a choice turned on still asks, what isn't a choice always asks and can't be
// turned off, and changing a choice takes the PIN.
class PinChoicesTest {
    private val kept = mutableMapOf<String, Boolean>()
    private val saved: (String) -> Boolean? = { kept[it] }

    @Test fun aChoiceTurnedOnAsks() {
        for (c in PinChoices.ALL) {
            kept[c.key] = true; assertTrue(c.key, PinChoices.asks(c.key, saved))
            kept[c.key] = false; assertFalse(c.key, PinChoices.asks(c.key, saved))
        }
    }

    @Test fun permissiveByDefaultButSettings() {
        assertFalse(PinChoices.asks(PinChoices.APPS, saved))
        assertTrue(PinChoices.asks(PinChoices.SETTINGS, saved))
    }

    @Test fun addAppsAsksOnceAGoogleAccountIsOn() {
        assertTrue(PinChoices.asks(PinChoices.APPS, PinChoices.withAccount(true, saved)))
        assertFalse(PinChoices.asks(PinChoices.PHOTOS, PinChoices.withAccount(true, saved)))
        kept[PinChoices.APPS] = false // someone turned it off: that holds
        assertFalse(PinChoices.asks(PinChoices.APPS, PinChoices.withAccount(true, saved)))
    }

    @Test fun whatIsNotAChoiceAlwaysAsksAndCannotBeTurnedOff() {
        for (k in listOf(null, "", "advanced", "account", "kiosk", "erase", "pair", "pin", "choices", "Apps")) {
            kept[k ?: "null"] = false
            assertTrue("$k asks", PinChoices.asks(k, saved))
            var asked = false; var wrote = false
            assertEquals(PinChoices.Changed.NOT_A_CHOICE, PinChoices.change(k ?: "", false, true, saved, { asked = true; true }, { _, _ -> wrote = true }))
            assertFalse(asked); assertFalse(wrote)
            assertTrue("$k still asks", PinChoices.asks(k, saved))
        }
    }

    @Test fun changingAChoiceTakesThePin() {
        val save: (String, Boolean) -> Unit = { k, v -> kept[k] = v }
        // No PIN on the card (or a no): nothing changes.
        assertEquals(PinChoices.Changed.NOT_CONFIRMED, PinChoices.change(PinChoices.SETTINGS, false, true, saved, { false }, save))
        assertTrue(PinChoices.asks(PinChoices.SETTINGS, saved))
        // No PIN set: nothing to change, and nobody is asked.
        var asked = false
        assertEquals(PinChoices.Changed.NO_PIN, PinChoices.change(PinChoices.SETTINGS, false, false, saved, { asked = true; true }, save))
        assertFalse(asked); assertTrue(PinChoices.asks(PinChoices.SETTINGS, saved))
        // The PIN typed: changed, both ways.
        assertEquals(PinChoices.Changed.DONE, PinChoices.change(PinChoices.SETTINGS, false, true, saved, { true }, save))
        assertFalse(PinChoices.asks(PinChoices.SETTINGS, saved))
        assertEquals(PinChoices.Changed.DONE, PinChoices.change(PinChoices.APPS, true, true, saved, { true }, save))
        assertTrue(PinChoices.asks(PinChoices.APPS, saved))
    }
}
