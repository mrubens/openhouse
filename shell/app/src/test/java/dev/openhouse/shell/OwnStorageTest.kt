package dev.openhouse.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnStorageTest {
    /** Amazon's own presigned GET example: the signer is right, or every backup to the household's storage fails. */
    @Test fun theSignerMatchesAmazonsExample() {
        val cfg = OwnStorage.Config("https://s3.amazonaws.com", "us-east-1", "examplebucket", "", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        val u = OwnStorage.presign(cfg, "GET", "test.txt", expires = 86400, now = java.time.Instant.parse("2013-05-24T00:00:00Z"))
        assertTrue(u, u.startsWith("https://examplebucket.s3.amazonaws.com/test.txt?"))
        assertTrue(u, u.endsWith("&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"))
    }

    /** The bridge gets a URL only for what a backup needs, only under the household's prefix. */
    @Test fun onlyWhatABackupNeedsIsSigned() {
        val cfg = OwnStorage.Config("http://10.0.2.2:9000", "us-east-1", "b", "opie/", "key", "secret-secret")
        for (n in listOf("../x", "a/b", "..", "", "x".repeat(201))) assertEquals(n, 400, OwnStorage.sign(cfg, JSONObject().put("method", "GET").put("name", n)).first)
        for (m in listOf("POST", "PATCH", "")) assertEquals(m, 400, OwnStorage.sign(cfg, JSONObject().put("method", m).put("name", "a")).first)
        val put = JSONObject(OwnStorage.sign(cfg, JSONObject().put("method", "PUT").put("name", "a.backup")).second).getString("url")
        assertTrue(put, put.startsWith("http://10.0.2.2:9000/b/opie/a.backup?") && !put.contains("secret-secret"))
    }
}
