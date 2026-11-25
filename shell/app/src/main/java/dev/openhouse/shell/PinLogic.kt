package dev.openhouse.shell

// The parts of asking for the PIN that are plain logic, so the computer can test them (PinLogicTest):
// the short grace after someone unlocks, what the on-screen pad does with each key, and the recovery code.

/**
 * After someone unlocks with the PIN, the PIN isn't asked again for [WINDOW_MS], so Settings, an
 * approval and the next setting don't each want it. It ends early when the screen sleeps or someone closes the
 * Settings. Kept in memory only: a restart asks again.
 */
object ParentGrace {
    const val WINDOW_MS = 2 * 60_000L
    @Volatile private var until = 0L
    /** For tests: the clock. */
    @Volatile var now: () -> Long = { android.os.SystemClock.elapsedRealtime() }

    fun open() { until = now() + WINDOW_MS }
    fun close() { until = 0L }
    fun isOpen(): Boolean = now() < until
}

/**
 * What's typed on the pad. With the PIN's [length] known, the last digit checks it (no OK key); without (a PIN set
 * before its length was kept, or choosing a new one, which is 4 to 8 digits), an OK key appears once there are 4.
 */
class PinEntry(val length: Int?, private val max: Int = 8) {
    private val digits = StringBuilder()
    val text: String get() = digits.toString()
    val count: Int get() = digits.length
    /** Show an OK key: the length isn't known and there are enough digits to try. */
    val wantsOk: Boolean get() = length == null && digits.length >= 4

    /** A digit; true when that was the last one, so it's time to check. */
    fun digit(d: Char): Boolean {
        require(d.isDigit())
        val cap = length ?: max
        if (digits.length >= cap) return false
        digits.append(d)
        return length != null && digits.length == length
    }

    fun delete() { if (digits.isNotEmpty()) digits.setLength(digits.length - 1) }
    fun clear() = digits.setLength(0)
}

/**
 * The PIN's recovery code (docs/settings.md, "Forgot the PIN"): shown once when a PIN is chosen, and only a salted
 * PBKDF2 hash of it is kept (ParentPin), like the PIN. Typed after "Forgot PIN?", it lets someone choose a new PIN. 16
 * characters of Crockford base32 (no I, L, O, U: the alphabet of the backups' and pairing codes), 80 random bits, shown
 * as XXXX-XXXX-XXXX-XXXX; typing forgives case, spaces, dashes, and O for 0 or I and L for 1.
 */
object RecoveryCode {
    const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const val LENGTH = 16
    private const val ITER = 20_000

    fun new(rand: java.security.SecureRandom = java.security.SecureRandom()): String =
        CharArray(LENGTH) { ALPHABET[rand.nextInt(ALPHABET.length)] }.concatToString().chunked(4).joinToString("-")

    private fun forgiving(typed: String) = typed.uppercase().filter { it.isLetterOrDigit() }.replace('O', '0').replace('I', '1').replace('L', '1')

    /** What was typed as the code's 16 characters, or null if it can't be one. */
    fun clean(typed: String): String? = forgiving(typed).takeIf { it.length == LENGTH && it.all { c -> c in ALPHABET } }

    fun newSalt(): ByteArray = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }

    /** The hash that's kept for [code] (typed or as shown); null if it isn't a code. */
    fun hash(code: String, salt: ByteArray): ByteArray? = clean(code)?.let {
        javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(javax.crypto.spec.PBEKeySpec(it.toCharArray(), salt, ITER, 256)).encoded
    }

    /** Is [typed] the code whose hash is [kept]? */
    fun matches(typed: String, salt: ByteArray, kept: ByteArray): Boolean =
        hash(typed, salt)?.let { java.security.MessageDigest.isEqual(it, kept) } ?: false

    /** Is [typed] the backups' recovery code [backup] (26 characters, bridge/backup-format.js), spelled any forgiving way? */
    fun sameBackupCode(typed: String, backup: String): Boolean {
        val a = forgiving(typed); val b = forgiving(backup)
        return b.length == 26 && java.security.MessageDigest.isEqual(a.toByteArray(), b.toByteArray())
    }
}
