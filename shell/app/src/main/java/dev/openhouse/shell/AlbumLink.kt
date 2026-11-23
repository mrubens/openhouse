package dev.openhouse.shell

/**
 * An iCloud shared album's public-website link, as people paste it: https://www.icloud.com/sharedalbum/#B0aGWZuqDGKXQ8n
 * (sometimes with a language, /sharedalbum/en-us/#…). The part after # is the album's token; Apple's (undocumented)
 * service for it lives on one of its partitions, which the token names in its first characters. If that guess is
 * wrong Apple says where to go (HTTP 330, X-Apple-MMe-Host). docs/photos.md has the whole conversation.
 *
 * New albums (iOS 27) have links like https://photos.icloud.com/shared/album/02baOs9AYqNpFTPIDI_4UyAeA and live in
 * CloudKit instead: the key resolves (no sign-in) to the album's zone, a short-lived public access token and the
 * partition to ask, which answers with the album's records ([shareKey], [resolveUrl], [queryUrl]).
 *
 * Plain Kotlin (no Android) so the JVM tests can check it.
 */
object AlbumLink {
    private val LINK = Regex("^https?://(www\\.)?icloud\\.com/sharedalbum/(?:[a-z]{2}(?:-[a-z]{2,4})?/)?#([A-Za-z0-9]{10,40})$", RegexOption.IGNORE_CASE)
    private const val B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

    private val SHARE = Regex("^https?://(www\\.|photos\\.)?icloud\\.com/shared/album/([A-Za-z0-9_-]{15,40})/?(\\?.*)?$", RegexOption.IGNORE_CASE)

    /** The link cleaned up (https://www.icloud.com/sharedalbum/#token, or https://photos.icloud.com/shared/album/key), or null if it isn't one. */
    fun clean(raw: String): String? = token(raw)?.let { "https://www.icloud.com/sharedalbum/#$it" } ?: shareKey(raw)?.let { "https://photos.icloud.com/shared/album/$it" }

    /** A new-style album's key, or null. */
    fun shareKey(raw: String): String? = SHARE.matchEntire(raw.trim().replace(Regex("\\s"), ""))?.groupValues?.get(2)

    private const val CK = "/database/1/com.apple.photos.cloud/production/"
    fun resolveUrl(key: String) = "https://ckdatabasews.icloud.com${CK}public/records/resolve?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=$key"
    fun queryUrl(partition: String, key: String, token: String) = partition.removeSuffix(":443").trimEnd('/') + "${CK}shared/records/query?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=$key&publicAccessAuthToken=" + java.net.URLEncoder.encode(token, "UTF-8")
    /** Only Apple's own CloudKit partitions are asked. */
    fun okPartition(p: String?): Boolean = p != null && Regex("^https://p[0-9]{1,3}-ckdatabasews\\.icloud\\.com(:443)?/?$", RegexOption.IGNORE_CASE).matches(p)
    /** The fields of a record the bridge reads (the rest stays here). */
    fun keepField(name: String): Boolean = Regex("^res(JPEG(Thumb|Med|Large|Full)|Original)(Res|Width|Height|FileType)$|^(itemType|addedDate|assetDate|captionEnc|masterRef|duration)$").matches(name)

    fun token(raw: String): String? = LINK.matchEntire(raw.trim().replace(Regex("\\s"), ""))?.groupValues?.get(2)

    /** The partition the token points at: "A" + one base-62 digit, else two after the first character. */
    fun host(token: String): String {
        val digits = if (token.startsWith("A")) token.substring(1, 2) else token.substring(1, 3)
        var n = 0
        for (ch in digits) { val v = B62.indexOf(ch); if (v < 0) return "p01-sharedstreams.icloud.com"; n = n * 62 + v }
        return "p%02d-sharedstreams.icloud.com".format(n.coerceAtLeast(1))
    }

    fun webstream(host: String, token: String) = "https://$host/$token/sharedstreams/webstream"
    fun assetUrls(host: String, token: String) = "https://$host/$token/sharedstreams/webasseturls"

    /** Where Apple says the album really is, from a 330's body ({"X-Apple-MMe-Host": "p123-sharedstreams.icloud.com"}). */
    fun movedTo(body: String): String? = Regex("\"X-Apple-MMe-Host\"\\s*:\\s*\"([a-z0-9-]+\\.icloud\\.com)\"", RegexOption.IGNORE_CASE).find(body)?.groupValues?.get(1)

    /** Only Apple's own hosts are followed. */
    fun okHost(h: String?): Boolean = h != null && Regex("^p[0-9]{1,3}-sharedstreams\\.icloud\\.com$", RegexOption.IGNORE_CASE).matches(h)
}
