package dev.openhouse.shell

import android.content.Context
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * The lock's PIN (docs/settings.md): off unless someone turns the lock on in Settings (or over adb with ConfigReceiver). Opening the
 * tablet's Settings, system apps or app stores, adding apps and Settings all need it.
 *
 * Kept as a salted PBKDF2 hash, not the digits. Wrong guesses lock it for a while (30 s after five, doubling
 * up to 15 minutes), so a child can't just try them all on the keypad. Its length is kept too, so the on-screen pad
 * (PinPad) checks it on the last digit without an OK; a PIN set before that is learned the first time it's right.
 * A right PIN opens ParentGrace: two minutes without asking again.
 */
object ParentPin {
    private const val ITER = 20_000
    private const val FREE_TRIES = 5
    private fun prefs(c: Context) = c.getSharedPreferences("shell", Context.MODE_PRIVATE)

    fun valid(pin: String) = pin.length in 4..8 && pin.all { it.isDigit() }

    fun isSet(c: Context): Boolean { migrate(c); return prefs(c).contains("pin_hash") }

    fun set(c: Context, pin: String) {
        require(valid(pin))
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        prefs(c).edit().putString("pin_hash", hex(hash(pin, salt))).putString("pin_salt", hex(salt))
            .putInt("pin_len", pin.length).remove("pin").putInt("pin_fails", 0).putLong("pin_locked_until", 0).apply()
    }

    fun clear(c: Context) { prefs(c).edit().remove("pin").remove("pin_hash").remove("pin_salt").remove("pin_len").apply(); ParentGrace.close() }

    /** How many digits the PIN has, when known (null: a PIN from before lengths were kept, until it's next right). */
    fun length(c: Context): Int? { migrate(c); return prefs(c).getInt("pin_len", 0).takeIf { valid("0".repeat(it)) } }


    /** How long until the keypad takes guesses again (0: now). */
    fun lockedForMs(c: Context): Long = (prefs(c).getLong("pin_locked_until", 0) - System.currentTimeMillis()).coerceAtLeast(0)

    /** Is [pin] the PIN? Counts wrong guesses; while locked every guess is refused. */
    @Synchronized fun check(c: Context, pin: String): Boolean {
        migrate(c)
        val p = prefs(c)
        val hash = p.getString("pin_hash", null) ?: return false
        if (lockedForMs(c) > 0 || !valid(pin)) return false // nothing typed yet isn't a guess
        val ok = MessageDigest.isEqual(hash(pin, unhex(p.getString("pin_salt", "")!!)), unhex(hash))
        if (ok) { p.edit().putInt("pin_fails", 0).putInt("pin_len", pin.length).apply(); ParentGrace.open(); return true }
        val fails = p.getInt("pin_fails", 0) + 1
        val e = p.edit().putInt("pin_fails", fails)
        if (fails >= FREE_TRIES) e.putLong("pin_locked_until", System.currentTimeMillis() + (30_000L shl (fails - FREE_TRIES).coerceAtMost(5)).coerceAtMost(15 * 60_000L))
        e.apply()
        return false
    }

    /** Devices from before: the PIN was kept as plain digits under "pin". */
    private fun migrate(c: Context) {
        val old = prefs(c).getString("pin", null) ?: return
        if (valid(old)) set(c, old) else prefs(c).edit().remove("pin").apply()
    }

    private fun hash(pin: String, salt: ByteArray): ByteArray =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(PBEKeySpec(pin.toCharArray(), salt, ITER, 256)).encoded
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

/**
 * The bridge's secret, new each time the tablet starts. Every request to the bridge must carry it: the
 * shell's own code sends it as a header (dev.openhouse.ui.BridgeClient), its WebViews as a cookie, and the
 * runtime gets it in its environment (and in files/display/.bridge-token, for a bridge restarted by hand). Other apps
 * on the tablet don't have it, so they can't start the agent, undo, or listen in. A computer gets it over adb:
 *
 *   adb shell am broadcast -n dev.openhouse.shell/.ConfigReceiver -a dev.openhouse.shell.CONFIG --ez token true
 */
object BridgeToken {
    @Volatile private var cached: String? = null

    fun get(c: Context): String = cached ?: synchronized(this) {
        cached ?: run {
            val p = c.getSharedPreferences("shell", Context.MODE_PRIVATE)
            val boot = runCatching { android.provider.Settings.Global.getInt(c.contentResolver, android.provider.Settings.Global.BOOT_COUNT) }.getOrDefault(-1)
            val have = p.getString("bridge_token", null)
            val t = if (have != null && p.getInt("bridge_token_boot", -2) == boot) have
                else ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
                    .also { p.edit().putString("bridge_token", it).putInt("bridge_token_boot", boot).commit() }
            file(c).apply { writeText(t); setReadable(false, false); setReadable(true, true) }
            cached = t; t
        }
    }

    fun file(c: Context) = java.io.File(c.filesDir, "display/.bridge-token").apply { parentFile?.mkdirs() }
}
