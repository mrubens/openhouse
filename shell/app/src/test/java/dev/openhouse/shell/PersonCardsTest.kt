package dev.openhouse.shell

import dev.openhouse.ui.PersonCards
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// A card a person answers is up: Opie's device tools are refused, and the card's yes takes only a real touch.
class PersonCardsTest {
    @Test fun toolsRefusedWhileACardIsUp() {
        assertNull(DeviceRules.whileCard(PersonCards.showing()))
        val a = PersonCards.open("Turn on the TV?")
        val b = PersonCards.open("Let “Laptop” change this OpenHouse?")
        assertNotNull(DeviceRules.whileCard(PersonCards.showing()))
        PersonCards.close(b)
        assertNotNull(DeviceRules.whileCard(PersonCards.showing())) // the first is still up
        PersonCards.close(a)
        assertNull(DeviceRules.whileCard(PersonCards.showing()))
    }

    @Test fun aCardThatWentAwayDoesNotHoldOpieUp() {
        var on = true
        val t = PersonCards.open("Add an iCloud shared album?") { on }
        assertNotNull(PersonCards.showing())
        on = false
        assertNull(PersonCards.showing())
        PersonCards.close(t)
    }

    @Test fun onlyARealTouchSaysYes() {
        assertTrue(PersonCards.realTouch(0, 4, virtual = false)) // the touchscreen
        assertFalse(PersonCards.realTouch(0, 0, virtual = false)) // dispatchGesture's device
        assertFalse(PersonCards.realTouch(PersonCards.FLAG_IS_ACCESSIBILITY_EVENT, 4, virtual = false)) // marked as an accessibility service's
        assertFalse(PersonCards.realTouch(0, -1, virtual = true)) // the virtual device
        assertFalse(PersonCards.realTouch(0, 7, virtual = null)) // no such device
    }
}
