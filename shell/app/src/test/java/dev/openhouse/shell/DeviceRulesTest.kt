package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceRulesTest {
    @Test fun finalButtons() {
        for (l in listOf("Place order", "PLACE ORDER", "Place Order • $24.10", "Pay", "Pay now", "Pay $12.00", "Buy", "Buy now", "Purchase",
            "Confirm purchase", "Complete purchase", "Send", "Send message", "Reply", "Post", "Delete account", "Delete my account",
            "Subscribe", "Order now", "Send SMS", "Send $5", "Reply all", "Post review", "Publish", "Submit order", "Confirm order", "Donate", "Confirm and pay"))
            assertNotNull(l, DeviceRules.finalAction(l))
    }

    @Test fun secretFields() {
        assertTrue(DeviceRules.secretField("Card number"))
        assertTrue(DeviceRules.secretField(null, "com.doordash:id/cvv_input"))
        assertTrue(DeviceRules.secretField("Password"))
        assertTrue(DeviceRules.secretField("MM/YY"))
        assertFalse(DeviceRules.secretField("Search stores", "com.app:id/search"))
        assertFalse(DeviceRules.secretField("Delivery instructions"))
    }

    @Test fun cardNumbers() {
        assertTrue(DeviceRules.looksLikeCard("4111 1111 1111 1111"))
        assertTrue(DeviceRules.looksLikeCard("my card is 4111-1111-1111-1111 ok"))
        assertFalse(DeviceRules.looksLikeCard("1234 5678 9012 3456")) // not a card (Luhn)
        assertFalse(DeviceRules.looksLikeCard("pepperoni pizza, large"))
        assertFalse(DeviceRules.looksLikeCard("555-0100"))
    }

    @Test fun neverOpensTheStore() {
        assertEquals(true, DeviceRules.neverOpen("com.android.vending", emptyList()))
        assertEquals(false, DeviceRules.neverOpen("com.google.android.deskclock", emptyList()))
    }
}
