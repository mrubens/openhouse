package dev.openhouse.shell

import java.net.InetAddress

/**
 * Whether an address someone else chose (a calendar link) stays off the home network: the same rules as the bridge's
 * privateIp and localName (bridge/app-web.js). Plain Kotlin (no Android) so the JVM tests can check it.
 */
object PublicAddress {
    private fun v4Private(a: Int, b: Int, c: Int): Boolean =
        a == 0 || a == 10 || a == 127 || (a == 100 && b in 64..127) || (a == 169 && b == 254) || (a == 172 && b in 16..31) ||
            (a == 192 && b == 0 && c == 0) || (a == 192 && b == 168) || (a == 198 && (b == 18 || b == 19)) || a >= 224

    private fun v4Of(hi: Int, lo: Int) = v4Private(hi shr 8, hi and 255, lo shr 8)

    /**
     * Whether [addr] (4 or 16 bytes) isn't a public address: the home network, this device, link-local, multicast,
     * reserved; in IPv6 also every form that carries an IPv4 address (mapped, translated, compatible, NAT64, 6to4,
     * Teredo) judged by that IPv4, and anything outside global unicast. Anything else counts as not public.
     */
    fun isPrivate(addr: ByteArray): Boolean {
        val u = addr.map { it.toInt() and 255 }
        if (u.size == 4) return v4Private(u[0], u[1], u[2])
        if (u.size != 16) return true
        val g = IntArray(8) { (u[2 * it] shl 8) or u[2 * it + 1] }
        fun zeros(n: Int) = (0 until n).all { g[it] == 0 }
        return when {
            zeros(5) && g[5] == 0xffff -> v4Of(g[6], g[7]) // ::ffff:a.b.c.d
            zeros(4) && g[4] == 0xffff && g[5] == 0 -> v4Of(g[6], g[7]) // ::ffff:0:a.b.c.d
            zeros(6) -> true // ::, ::1 and ::a.b.c.d
            g[0] == 0x64 && g[1] == 0xff9b -> (2..5).any { g[it] != 0 } || v4Of(g[6], g[7]) // NAT64 (64:ff9b:1::/48 is local use)
            g[0] == 0x2002 -> v4Of(g[1], g[2]) // 6to4
            g[0] == 0x2001 && g[1] == 0 -> v4Of(g[2], g[3]) || v4Of(g[6] xor 0xffff, g[7] xor 0xffff) // Teredo: its server and its client
            g[0] == 0x2001 && g[1] == 0xdb8 -> true // documentation
            else -> (g[0] and 0xe000) != 0x2000 // only global unicast (2000::/3) is public: not ULA, link-local, multicast
        }
    }

    fun isPrivate(a: InetAddress): Boolean = isPrivate(a.address)

    private val LOCAL = Regex("^(localhost|.*\\.localhost|.*\\.local|.*\\.lan|.*\\.home|.*\\.home\\.arpa|.*\\.internal|.*\\.intranet|.*\\.corp)$", RegexOption.IGNORE_CASE)

    /** Names that are only ever on the home network. */
    fun localName(host: String): Boolean = LOCAL.matches(host.removeSuffix("."))

    /** A name or address literal, as in a URL (brackets around IPv6 taken off). */
    fun bare(host: String): String = host.removePrefix("[").removeSuffix("]")
}
