package dev.openhouse.shell

// Self-update's rules, apart from Android (unit-tested on the computer: shell/app/src/test). What a release manifest
// says, how versions compare, which tablets a rollout reaches, and when an update may go on. docs/self-update.md.

import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest

/** One APK a manifest points at: the release itself, or its rescue build. */
data class ApkRef(val version: String, val versionCode: Long, val url: String, val sha256: String, val size: Long)

/**
 * A release as its manifest (update.json) describes it.
 *
 * [minVersionCode]: a tablet older than this takes the update whatever the rollout, and at the next quiet moment
 * rather than waiting for the night (a fix every tablet must have).
 * [rescue]: the release before this one, built again with a version code just above this one's, so that a tablet
 * this release breaks can go back to it (Android won't let an app go down a version). None: the update goes on only
 * when someone asks for it.
 */
data class Release(
    val apk: ApkRef,
    val minVersionCode: Long,
    val rollout: Int,
    val notes: String,
    val rescue: ApkRef?,
) {
    val version get() = apk.version
    val versionCode get() = apk.versionCode
}

/**
 * What the update URL answered: a release, or (the managed cloud's endpoint, docs/cloud.md) that nothing is due.
 * [checkAgainSeconds]: when to ask next, if the answer says.
 */
data class Answer(val release: Release?, val checkAgainSeconds: Long?)

sealed class Decision {
    object UpToDate : Decision()
    /** This release failed on this tablet before (it went back): not again. */
    object FailedHere : Decision()
    /** Not this tablet's turn yet: the rollout hasn't reached it. */
    object NotYet : Decision()
    data class Take(val release: Release, val urgent: Boolean) : Decision()
}

object Releases {
    /** 1.2.3 → 1_02_03_00. The last two digits are left for the rescue build (+1). */
    fun versionCode(version: String): Long {
        val p = parts(version) ?: throw IllegalArgumentException("not a version: $version")
        require(p.size == 3 && p[1] < 100 && p[2] < 100 && p[0] < 2000) { "versions are major.minor.patch, minor and patch under 100: $version" }
        return p[0] * 1_000_000L + p[1] * 10_000L + p[2] * 100L
    }

    private fun parts(v: String): List<Long>? = v.trim().removePrefix("v").split('.').map { it.toLongOrNull() ?: return null }.takeIf { it.isNotEmpty() && it.all { n -> n >= 0 } }

    /** Compare "1.10.0" with "1.9.2" as numbers, part by part (a missing part is 0). */
    fun compareVersions(a: String, b: String): Int {
        val x = parts(a) ?: throw IllegalArgumentException("not a version: $a")
        val y = parts(b) ?: throw IllegalArgumentException("not a version: $b")
        for (i in 0 until maxOf(x.size, y.size)) {
            val c = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }

    /**
     * Where this tablet falls in a release's rollout, 0–99: the same answer every time for this tablet and release
     * (raising the percentage only adds tablets), a different sample of tablets for each release.
     */
    fun bucket(deviceId: String, versionCode: Long): Int {
        val h = MessageDigest.getInstance("SHA-256").digest("$deviceId:$versionCode".toByteArray())
        val n = ((h[0].toLong() and 0xff) shl 24) or ((h[1].toLong() and 0xff) shl 16) or ((h[2].toLong() and 0xff) shl 8) or (h[3].toLong() and 0xff)
        return (n % 100).toInt()
    }

    /** May an APK be fetched from [url]? https only, except from the computer a tester serves from (emulator, loopback). */
    fun allowedUrl(url: String, manifestUrl: String): Boolean = runCatching {
        val u = URI(url)
        when (u.scheme) {
            "https" -> !u.host.isNullOrEmpty()
            "http" -> testHost(u.host) && testHost(URI(manifestUrl).host)
            else -> false
        }
    }.getOrDefault(false)

    private fun testHost(h: String?) = h in setOf("10.0.2.2", "127.0.0.1", "localhost")

    /** Read update.json. Relative URLs are taken from where the manifest is (a plain folder on a static host works). */
    fun parse(text: String, manifestUrl: String): Release {
        val j = JSONObject(text)
        require(j.optInt("schema", 1) == 1) { "unknown manifest schema ${j.opt("schema")}" }
        fun apk(o: JSONObject, what: String): ApkRef {
            val version = o.getString("version")
            val code = o.getLong("versionCode")
            val url = URI(manifestUrl).resolve(o.getString("url")).toString()
            val sha = o.getString("sha256").lowercase()
            require(Regex("^[0-9a-f]{64}$").matches(sha)) { "$what: sha256 isn't a SHA-256" }
            require(code > 0) { "$what: versionCode" }
            require(allowedUrl(url, manifestUrl)) { "$what: not an https URL: $url" }
            return ApkRef(version, code, url, sha, o.optLong("size", -1))
        }
        val main = apk(j, "release")
        require(main.versionCode == versionCode(main.version)) { "versionCode ${main.versionCode} doesn't match version ${main.version}" }
        val rescue = j.optJSONObject("rescue")?.let { apk(it, "rescue") }
        require(rescue == null || rescue.versionCode in (main.versionCode + 1)..(main.versionCode + 99)) { "the rescue build's versionCode must be just above the release's" }
        val rollout = j.optInt("rollout", 100)
        require(rollout in 0..100) { "rollout is a percentage" }
        val min = j.optString("minVersion", "").takeIf { it.isNotEmpty() }?.let { versionCode(it) } ?: 0L
        return Release(main, min, rollout, j.optString("notes", ""), rescue)
    }

    /** A static update.json, or the cloud's answer: the same fields, or {"upToDate": true, "checkAgainSeconds": N}. */
    fun parseAnswer(text: String, url: String): Answer {
        val j = JSONObject(text)
        val again = if (j.has("checkAgainSeconds")) j.getLong("checkAgainSeconds").coerceIn(15 * 60L, 7 * 24 * 3600L) else null
        if (j.optBoolean("upToDate")) return Answer(null, again)
        return Answer(parse(text, url), again)
    }

    /**
     * The URL to ask: a static manifest as it is; the cloud's endpoint (a path ending in /v1/update) with what it
     * decides by. [installId] (random, made once on the tablet) goes only there and only when the tablet isn't linked
     * to a family (then its credential says which tablet it is).
     */
    fun requestUrl(base: String, versionCode: Long, channel: String, installId: String?): String {
        val u = URI(base)
        if (u.path?.endsWith("/v1/update") != true) return base
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
        val q = listOfNotNull("component=shell", "versionCode=$versionCode", "channel=${enc(channel)}", installId?.let { "installId=${enc(it)}" })
        return base + (if (u.rawQuery.isNullOrEmpty()) "?" else "&") + q.joinToString("&")
    }

    /** Whether this tablet (on [installedCode]) should take [r]. */
    fun decide(installedCode: Long, r: Release, bucket: Int, failedHere: Set<Long>): Decision {
        if (r.versionCode <= installedCode) return Decision.UpToDate
        if (r.versionCode in failedHere) return Decision.FailedHere
        val urgent = installedCode < r.minVersionCode
        if (!urgent && bucket >= r.rollout) return Decision.NotYet
        return Decision.Take(r, urgent)
    }

    /** "2-5": from 2:00 to 4:59. Wraps past midnight ("23-4"). "0-24": any hour. */
    fun inWindow(hour: Int, window: String): Boolean {
        val (a, b) = window.split('-').map { it.trim().toInt() }
        return when {
            a == b -> false
            a < b -> hour in a until b
            else -> hour >= a || hour < b
        }
    }

    /**
     * May a downloaded update go on now? Never while the family is using the tablet ([quiet]: no turn running, no one
     * talking, nobody at the screen for a while). Someone's "Install now" goes on at once, rescue build or not;
     * otherwise it needs a rescue build to go back to, and waits for the night unless it's urgent or Opie's software
     * has stopped answering for good ([bridgeStuck]: nothing is in use to interrupt, and this may be the fix).
     */
    fun mayInstall(quiet: Boolean, parentAsked: Boolean, urgent: Boolean, hasRescue: Boolean, inNight: Boolean, bridgeStuck: Boolean = false): Boolean = when {
        parentAsked -> true
        !quiet || !hasRescue -> false
        else -> urgent || inNight || bridgeStuck
    }

    /** The installed app's signer must be the new APK's, or one it rotated from (apksigner's lineage). Hex SHA-256s. */
    fun signerAllowed(installed: Collection<String>, newSigners: Collection<String>, newHistory: Collection<String>): Boolean =
        installed.isNotEmpty() && newSigners.isNotEmpty() && installed.all { it in newSigners || it in newHistory }
}
