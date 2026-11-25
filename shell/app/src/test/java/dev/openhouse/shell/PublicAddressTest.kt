package dev.openhouse.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

/** A calendar link someone sent can't reach the home network or this tablet (CalendarLinks.fetch). */
class PublicAddressTest {
    private fun private(ip: String) = PublicAddress.isPrivate(InetAddress.getByName(ip))
    private fun v6(ip: String) = PublicAddress.isPrivate(InetAddress.getByName(ip).address.let { if (it.size == 16) it else ByteArray(10) + byteArrayOf(-1, -1) + it })

    @Test fun homeAndThisDeviceAreNot() {
        for (ip in listOf("127.0.0.1", "10.1.2.3", "192.168.1.20", "172.16.0.1", "172.31.255.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1",
                "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "64:ff9b:1::1"))
            assertTrue(ip, private(ip))
        for (ip in listOf("8.8.8.8", "17.253.144.10", "172.32.0.1", "2607:f8b0:4004:c07::64"))
            assertFalse(ip, private(ip))
    }

    @Test fun ipv6CarryingAnIpv4IsJudgedByIt() {
        // ::ffff:a.b.c.d as 16 bytes (InetAddress turns the literal into an IPv4 one, so build it by hand too)
        assertTrue(v6("::ffff:192.168.1.1")); assertTrue(v6("::ffff:127.0.0.1")); assertFalse(v6("::ffff:8.8.8.8"))
        assertTrue(private("::ffff:0:10.0.0.1"))
        assertTrue(private("::10.0.0.1"))
        assertTrue(private("64:ff9b::c0a8:0101")); assertFalse(private("64:ff9b::808:808"))
        assertTrue(private("2002:c0a8:0101::1")); assertFalse(private("2002:0808:0808::1"))
        assertTrue(private("2001:0:c0a8:0101::1"))
    }

    @Test fun homeNames() {
        for (h in listOf("localhost", "printer.local", "nas.lan", "router.home", "x.home.arpa", "db.internal", "nas.local."))
            assertTrue(h, PublicAddress.localName(h))
        assertFalse(PublicAddress.localName("calendar.google.com"))
    }
}
