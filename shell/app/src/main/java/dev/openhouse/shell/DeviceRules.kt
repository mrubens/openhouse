package dev.openhouse.shell

// What Opie never does in another app (docs/device-control.md): it stops at the last step and the person taps it.
// Plain functions of the words on screen, so they're tested on their own (DeviceRulesTest) and DeviceServer only asks.

internal object DeviceRules {
    /**
     * Buttons that finish something: paying, ordering, buying, sending a message, deleting an account. Matched on a
     * button's own short label ("Place order", "Pay $24.10", "Send"), not on a row that mentions the word.
     */
    private val FINAL = Regex(
        "^\\W*(" +
            "pay\\b.*|pay now|pay with.*|confirm (and|&) pay.*|.*\\bpay \\$.*|" +
            "place (my |your )?order.*|submit order.*|confirm order.*|complete order.*|order now.*|" +
            "buy\\b.*|purchase\\b.*|complete purchase.*|confirm purchase.*|subscribe\\b.*|start (free )?trial.*|" +
            "checkout and pay.*|book now.*|reserve now.*|donate\\b.*|tip\\b.*|send money.*|transfer\\b.*|" +
            "send( (it|now|message|messages|sms|mms|text|email|reply|invite|invitation|request|payment|\\$.*))?|send money.*|" +
            "reply( all| now)?|post( it| now| review| comment)?|publish( now)?|share now|" +
            "delete (my |your |this )?account.*|close (my |your )?account.*|deactivate.*" +
        ")\\W*$", RegexOption.IGNORE_CASE)

    /** The final action [label] stands for, or null. Long labels (a sentence, a menu row) are never one. */
    fun finalAction(label: String?): String? {
        val t = label?.replace(Regex("\\s+"), " ")?.trim() ?: return null
        if (t.isEmpty() || t.split(' ').size > 6) return null
        return if (FINAL.matches(t)) t else null
    }

    /** A field for a card or a password, from its hint, description or resource id. */
    private val SECRET_FIELD = Regex("card ?number|credit|debit|cvv|cvc|security code|expir|mm ?/ ?yy|iban|routing|account number|password|passcode|\\bpin\\b|ssn|social security",
        RegexOption.IGNORE_CASE)
    fun secretField(vararg about: String?): Boolean = about.filterNotNull().any { SECRET_FIELD.containsMatchIn(it) }

    /** Text that looks like a card number (13 to 19 digits, with spaces or dashes between). */
    fun looksLikeCard(text: String): Boolean = Regex("(?:\\d[ -]?){13,19}").findAll(text).any { m ->
        val d = m.value.filter { it.isDigit() }; d.length in 13..19 && luhn(d)
    }

    private fun luhn(d: String): Boolean {
        var sum = 0
        d.reversed().forEachIndexed { i, c -> var n = c - '0'; if (i % 2 == 1) { n *= 2; if (n > 9) n -= 9 }; sum += n }
        return sum % 10 == 0
    }

    /** Settings and the stores: ways out of kiosk mode, never opened by Opie (install_app has its own way in). */
    fun neverOpen(pkg: String, settingsPkgs: Collection<String>): Boolean = pkg in settingsPkgs || pkg == "com.android.settings" ||
        pkg in setOf("com.android.vending", "com.sec.android.app.samsungapps", "com.amazon.venezia", "org.fdroid.fdroid",
            "com.huawei.appmarket", "com.google.android.packageinstaller", "com.android.packageinstaller", AppStore.AURORA)

    /** A card waiting for a person's own answer is up ([card], its title; dev.openhouse.ui.PersonCards): every device
     *  tool is refused until it's gone, so nothing Opie does on screen can answer it. Null when none is up. */
    fun whileCard(card: String?): String? = card?.let {
        "Not done: the tablet is asking the people here “${it.trimEnd('?')}?”, and a person needs to answer the card on screen. " +
            "Tell them it's theirs to answer on the tablet; nothing on screen can be done until it's gone."
    }

    /** What the refusal says, for the assistant to pass on. */
    fun refusal(what: String) = "Not done: Opie never taps “$what” (paying, ordering, buying, sending or deleting an account is the person's own tap). " +
        "Stop here. Tell them it's ready and that they can tap “$what” themselves when they're happy with it."
}
