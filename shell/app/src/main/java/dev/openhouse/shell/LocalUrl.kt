package dev.openhouse.shell

/**
 * A URL of one of the display's own servers: on this device, at the dev server's or bridge's
 * port (any other loopback port could be another app listening), or, on the emulator only, the computer
 * running it (10.0.2.2 is an ordinary LAN address on a real network). The only servers taken from outside.
 */
fun localUrl(url: String): Boolean = runCatching {
    val u = java.net.URI(url)
    val emulator = android.os.Build.HARDWARE == "ranchu" || android.os.Build.HARDWARE == "goldfish"
    u.scheme == "http" && u.port in setOf(5173, 8787) &&
        (u.host in setOf("127.0.0.1", "localhost") || (emulator && u.host == "10.0.2.2"))
}.getOrDefault(false)
