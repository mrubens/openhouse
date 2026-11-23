package dev.openhouse.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlbumLinkTest {
    @Test fun onlyApplesOwnHosts() {
        assertNull(AlbumLink.clean("https://evil.example.com/sharedalbum/#B0aGWZuqDGKXQ8n"))
        assertNull(AlbumLink.clean("https://www.icloud.com/sharedalbum/#B0a/../x"))
        assertNull(AlbumLink.shareKey("https://photos.icloud.com.evil.example/shared/album/02baOs9AYqNpFTPIDI_4UyAeA"))
        assertNull(AlbumLink.shareKey("https://photos.icloud.com/shared/album/02ba/../x"))
        assertTrue(AlbumLink.okPartition("https://p105-ckdatabasews.icloud.com:443"))
        assertFalse(AlbumLink.okPartition("https://p105-ckdatabasews.icloud.com.evil.example"))
    }

    @Test fun followsOnlyApplesOwnRedirect() {
        assertEquals("p123-sharedstreams.icloud.com", AlbumLink.movedTo("""{"X-Apple-MMe-Host":"p123-sharedstreams.icloud.com"}"""))
        assertTrue(AlbumLink.okHost("p123-sharedstreams.icloud.com"))
        assertFalse(AlbumLink.okHost("p123-sharedstreams.icloud.com.evil.example"))
        assertNull(AlbumLink.movedTo("""{"X-Apple-MMe-Host":"evil.example.com"}"""))
    }
}
