package dev.openhouse.shell

// The parts of asking for the PIN that are plain logic, so the computer can test them (PinLogicTest):
// the short grace after someone unlocks, and what the on-screen pad does with each key.

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
