package dev.openhouse.shell

import java.io.File
import java.security.MessageDigest

/**
 * The SHA-256s a build carries for what it downloads and runs: the Linux runtime (Runtime.setup) and the voice set's
 * manifest (VoiceModels; its files are checked against the manifest). A release gets them from shell/gradle.properties
 * (openhouse.runtimeSha256, openhouse.voiceSha256) through scripts/release.sh; they are inside the signed APK, so the
 * download's host alone can't change what a tablet runs.
 *
 * A debug build carries none and takes what it's given (a runtime from the computer, a voice set from a test server).
 * A release with none takes nothing.
 */
object Pinned {
    val runtime: String get() = BuildConfig.RUNTIME_SHA256
    val voice: String get() = BuildConfig.VOICE_SHA256
    private val unpinnedOk get() = BuildConfig.DEBUG

    /** Throws unless [actual] is [pin], or there's no pin and [unpinnedOk] (debug builds). */
    fun check(what: String, pin: String, actual: String, unpinnedOk: Boolean = this.unpinnedOk) {
        if (pin.isEmpty()) { if (unpinnedOk) return; error("$what: this build has no checksum for it") }
        if (!actual.equals(pin, ignoreCase = true)) error("$what: checksum didn't match")
    }

    fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun sha256(f: File): String = f.inputStream().use { i ->
        val d = MessageDigest.getInstance("SHA-256"); val b = ByteArray(1 shl 16)
        while (true) { val n = i.read(b); if (n < 0) break; d.update(b, 0, n) }
        hex(d.digest())
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
}
