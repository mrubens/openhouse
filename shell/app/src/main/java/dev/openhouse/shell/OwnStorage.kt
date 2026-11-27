package dev.openhouse.shell

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.text.InputType
import android.util.Log
import android.widget.ImageView
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

/**
 * The household's own storage bucket for backups (docs/backups.md, "Your own storage"): anything that speaks S3
 * (Amazon S3, Cloudflare R2, Backblaze B2, MinIO...). Its access key and secret are kept here, sealed with a key in
 * Android's keystore, in the shell's no-backup files, as [OwnKey] keeps the OpenAI key: never in the bridge's files, a
 * backup or a report. The bridge asks [sign] for one presigned request at a time (AWS Signature V4: one method, one
 * object under the household's prefix, or that prefix's listing, for a few minutes), sends it itself and reads the
 * answer, so the secret never leaves here. The keeper does the same (hub/s3.mjs), with the same requests and answers.
 * Setting it up, changing and removing it are an adult's (Settings → Backups, behind the PIN); the fields come from
 * a phone or computer on the home Wi-Fi ([Handoff]), or typed here.
 */
object OwnStorage {
    private const val TAG = "OwnStorage"
    private const val ALIAS = "openhouse-own-storage"
    const val EXPIRES = 900
    private val PRIVATE = Regex("^(localhost|127\\.\\d+\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+|\\[::1]|[a-z0-9-]+\\.local)$", RegexOption.IGNORE_CASE)
    private val NAME = Regex("^[A-Za-z0-9._-]{1,200}$")

    data class Config(val endpoint: String, val region: String, val bucket: String, val prefix: String, val keyId: String, val secret: String) {
        fun json(): JSONObject = JSONObject().put("endpoint", endpoint).put("region", region).put("bucket", bucket).put("prefix", prefix).put("keyId", keyId).put("secret", secret)
        /** What may be said about it: never the key or the secret. */
        fun shown(): JSONObject = JSONObject().put("set", true).put("endpoint", endpoint).put("region", region).put("bucket", bucket).put("prefix", prefix)
    }

    private lateinit var ctx: Context
    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }
    private val file get() = File(ctx.noBackupFilesDir, "own-storage")

    private fun secret(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    @Synchronized fun read(): Config? = if (!::ctx.isInitialized) null else runCatching {
        val b = file.readBytes()
        val j = JSONObject(String(Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, b, 0, 12)) }.doFinal(b, 12, b.size - 12)))
        Config(j.getString("endpoint"), j.getString("region"), j.getString("bucket"), j.getString("prefix"), j.getString("keyId"), j.getString("secret"))
    }.getOrNull()
    @Synchronized private fun write(cfg: Config) {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(cfg.json().toString().toByteArray()))
        tmp.renameTo(file)
    }
    @Synchronized private fun forget() { if (::ctx.isInitialized) file.delete() }

    /** What the household typed, made plain, or what's wrong with it in their words. */
    fun clean(b: JSONObject): Pair<Config?, String?> {
        fun t(k: String, n: Int) = b.optString(k).trim().take(n)
        val region = t("region", 40).lowercase().ifEmpty { "us-east-1" }
        if (!Regex("^[a-z0-9-]{2,40}$").matches(region)) return null to "That region doesn’t look right (like us-east-1, or auto)."
        var endpoint = t("endpoint", 300).ifEmpty { "https://s3.$region.amazonaws.com" }
        if (!Regex("^[a-zA-Z]+://.*").matches(endpoint)) endpoint = "https://$endpoint"
        val u = runCatching { URL(endpoint) }.getOrNull() ?: return null to "That address doesn’t look right (like https://s3.us-east-1.amazonaws.com)."
        if (u.userInfo != null || u.query != null || u.ref != null || (u.path != "" && u.path != "/") || u.host.isEmpty()) return null to "The address is only the storage’s own, with no bucket or folder in it."
        if (!(u.protocol == "https" || (u.protocol == "http" && PRIVATE.matches(u.host)))) return null to "The address needs https:// (http:// only for storage on the home network)."
        val bucket = t("bucket", 63)
        if (!Regex("^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$").matches(bucket)) return null to "That bucket name doesn’t look right."
        val prefix = t("prefix", 200).trim('/')
        if (prefix.isNotEmpty() && (!Regex("^[A-Za-z0-9._/-]{1,200}$").matches(prefix) || prefix.split('/').any { it.isEmpty() || it == "." || it == ".." })) return null to "A folder may have letters, digits, - _ . and /."
        val keyId = t("keyId", 200); val sec = t("secret", 300)
        if (!Regex("^[^\\s/]{3,200}$").matches(keyId)) return null to "That access key ID doesn’t look right."
        if (!Regex("^\\S{8,300}$").matches(sec)) return null to "That secret doesn’t look right."
        val defaultPort = (u.protocol == "https" && u.port == 443) || (u.protocol == "http" && u.port == 80)
        val host = u.host.lowercase() + if (u.port != -1 && !defaultPort) ":${u.port}" else ""
        return Config("${u.protocol}://$host", region, bucket, if (prefix.isEmpty()) "" else "$prefix/", keyId, sec) to null
    }

    // --- signing (AWS Signature V4, query-string presigning; the keeper's hub/s3.mjs is the same) ----------------

    /** The S3 way of escaping (RFC 3986): everything but letters, digits and - _ . ~ ; '/' too unless it's a path's. */
    private fun enc(s: String, path: Boolean = false) = buildString {
        for (byte in s.toByteArray(Charsets.UTF_8)) {
            val c = byte.toInt() and 0xff; val ch = c.toChar()
            if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '-' || ch == '_' || ch == '.' || ch == '~' || (path && ch == '/')) append(ch) else append('%').append("%02X".format(c))
        }
    }
    private fun hmac(k: ByteArray, s: String): ByteArray = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(k, "HmacSHA256")) }.doFinal(s.toByteArray())
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private val AMZ: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)

    /** A presigned URL: signed headers host only, the payload unsigned. Amazon's own addresses use the bucket's own
     *  name (virtual-hosted), everything else the bucket in the path. */
    fun presign(cfg: Config, method: String, key: String = "", query: Map<String, String> = emptyMap(), expires: Int = EXPIRES, now: java.time.Instant = java.time.Instant.now()): String {
        val u = URL(cfg.endpoint)
        val hostPort = u.host + if (u.port != -1) ":${u.port}" else ""
        val virtual = Regex("(^|\\.)amazonaws\\.com$").containsMatchIn(u.host) && !cfg.bucket.contains('.')
        val host = if (virtual) "${cfg.bucket}.$hostPort" else hostPort
        val path = if (virtual) "/" + enc(key, true) else "/" + enc(cfg.bucket) + (if (key.isNotEmpty()) "/" + enc(key, true) else "")
        val amz = AMZ.format(now); val day = amz.take(8)
        val scope = "$day/${cfg.region}/s3/aws4_request"
        val q = query + mapOf("X-Amz-Algorithm" to "AWS4-HMAC-SHA256", "X-Amz-Credential" to "${cfg.keyId}/$scope", "X-Amz-Date" to amz, "X-Amz-Expires" to expires.toString(), "X-Amz-SignedHeaders" to "host")
        val qs = q.map { enc(it.key) to enc(it.value) }.sortedBy { it.first }.joinToString("&") { "${it.first}=${it.second}" }
        val canonical = listOf(method, path, qs, "host:$host", "", "host", "UNSIGNED-PAYLOAD").joinToString("\n")
        val toSign = listOf("AWS4-HMAC-SHA256", amz, scope, hex(MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray()))).joinToString("\n")
        val k = hmac(hmac(hmac(hmac("AWS4${cfg.secret}".toByteArray(), day), cfg.region), "s3"), "aws4_request")
        return "${u.protocol}://$host$path?$qs&X-Amz-Signature=${hex(hmac(k, toSign))}"
    }

    /** The bridge's request (DeviceServer /storage/sign): only what a backup needs, only under the prefix. */
    fun sign(cfg: Config, b: JSONObject): Pair<Int, String> {
        val method = b.optString("method").uppercase()
        if (b.optBoolean("list")) {
            if (method != "GET") return 400 to JSONObject().put("error", "a listing is a GET").toString()
            val token = b.optString("token").take(1024).takeIf { it.isNotEmpty() && !b.isNull("token") }
            val q = mutableMapOf("list-type" to "2", "prefix" to cfg.prefix, "max-keys" to "1000").apply { token?.let { put("continuation-token", it) } }
            return 200 to JSONObject().put("url", presign(cfg, method, query = q)).toString()
        }
        if (method !in setOf("GET", "PUT", "DELETE", "HEAD")) return 400 to JSONObject().put("error", "not a request this route signs").toString()
        val name = b.optString("name")
        if (!NAME.matches(name) || name.all { it == '.' }) return 400 to JSONObject().put("error", "not a name this route signs").toString()
        return 200 to JSONObject().put("url", presign(cfg, method, cfg.prefix + name)).toString()
    }

    /** What the storage's answer means, in the household's words; null when it's fine. */
    fun said(status: Int, xml: String, cfg: Config, step: String): String? {
        if (status in 200..299) return null
        val c = Regex("<Code>([^<]{1,80})</Code>").find(xml)?.groupValues?.get(1).orEmpty()
        val b = "“${cfg.bucket}”"
        return when {
            c == "InvalidAccessKeyId" -> "That access key ID isn’t known there. Check you copied all of it."
            c == "SignatureDoesNotMatch" -> "The secret doesn’t fit that access key. Check you copied all of it."
            c == "NoSuchBucket" -> "There’s no bucket called $b there."
            status == 301 || c in setOf("PermanentRedirect", "AuthorizationHeaderMalformed", "IllegalLocationConstraintException") ->
                "$b is in another region${Regex("<Region>([^<]{1,40})</Region>").find(xml)?.groupValues?.get(1)?.let { " ($it)" } ?: ""}. Check the region."
            status == 403 || c == "AccessDenied" -> "That key isn’t allowed to ${when (step) { "write" -> "write to"; "read" -> "read from"; else -> "delete in" }} $b. It needs to read, write and delete there."
            else -> "The storage answered $status${if (c.isNotEmpty()) " ($c)" else ""}. Try again in a minute."
        }
    }

    /** The Check: write a small file, read it back, delete it. null when all three work, else what went wrong. */
    fun check(cfg: Config): String? {
        val name = "opie-check-${hex(ByteArray(6).also { SecureRandom().nextBytes(it) })}.txt"
        val text = "Opie checked this storage at ${java.time.Instant.now()}."
        fun go(method: String, step: String, body: ByteArray? = null): Pair<String?, String> = runCatching {
            val c = URL(presign(cfg, method, cfg.prefix + name)).openConnection() as HttpURLConnection
            try {
                c.requestMethod = method; c.connectTimeout = 10_000; c.readTimeout = 20_000; c.instanceFollowRedirects = false
                if (body != null) { c.doOutput = true; c.setFixedLengthStreamingMode(body.size); c.outputStream.use { it.write(body) } }
                val code = c.responseCode
                val t = runCatching { (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() }.getOrNull().orEmpty()
                said(code, t, cfg, step) to t
            } finally { c.disconnect() }
        }.getOrElse { Log.d(TAG, "check: ${it.javaClass.simpleName}"); "Couldn’t reach ${URL(cfg.endpoint).host}. Check the address and the internet." to "" }
        go("PUT", "write", text.toByteArray()).first?.let { return it }
        val (why, got) = go("GET", "read"); why?.let { return it }
        if (got != text) return "What was written didn’t read back the same. Check the address."
        return go("DELETE", "delete").first
    }

    // --- the host's requests (DeviceServer) -----------------------------------------------------------------

    fun handle(path: String, b: JSONObject): Pair<Int, String> = when (path) {
        "/storage/status" -> 200 to (read()?.shown() ?: JSONObject().put("set", false)).toString()
        "/storage/sign" -> read()?.let { sign(it, b) } ?: (409 to """{"error":"no_storage"}""")
        "/storage/remove" -> { forget(); 200 to """{"ok":true}""" }
        else -> 405 to ""
    }

    /** Fields sent from a settings page through the bridge (DeviceServer /storage/set): the PIN first with the lock on,
     *  then the Check, then kept. [done]: null once it's in, else what went wrong. */
    fun offer(act: MainActivity, b: JSONObject, done: (String?) -> Unit) {
        val (cfg, why) = clean(b)
        if (cfg == null) return done(why)
        val go = { thread { val w = check(cfg); if (w == null) write(cfg); done(w) }; Unit }
        if (!act.lock.on) return go()
        PinPrompt.ask(act, act, "Use the storage sent from the other device?", { go() }, cancelled = { done("Nobody typed the PIN on the device, so it wasn't kept.") })
    }

    // --- the adult's screens (Settings → Backups, already behind the PIN) -------------------------------------

    private val FIELDS = listOf(
        Triple("endpoint", "Address", "https://s3.us-east-1.amazonaws.com"), Triple("region", "Region", "us-east-1"), Triple("bucket", "Bucket", ""),
        Triple("prefix", "Folder (optional)", ""), Triple("keyId", "Access key ID", ""), Triple("secret", "Secret access key", ""))
    private const val HELP = "Any storage that works like Amazon S3: Amazon S3, Cloudflare R2, Backblaze B2, MinIO. Make a bucket and a key that can read, write and delete in it. Backups are locked with your recovery code before they leave the device, so the storage only ever holds locked files."

    /** Set it up: the fields from a phone or computer on this Wi-Fi, or typed here; [done] once it's checked and kept. */
    fun setUp(act: MainActivity, done: () -> Unit) {
        var dialog: android.app.Dialog? = null
        var got: JSONObject? = null
        val info = JSONObject().put("title", "Your own storage").put("done", "Sent. Check the device.")
            .put("fields", JSONArray(FIELDS.map { (id, label, hint) -> JSONObject().put("id", id).put("label", label).put("hint", hint).put("optional", id == "prefix" || id == "region").put("secret", id == "secret") }))
        val h = Handoff(act, info, minutes = 15, onSecret = { got = it; dialog?.dismiss() }, onEnd = { if (got == null) dialog?.dismiss() })
        if (!h.start()) return type(act, JSONObject(), done)
        val qr = ImageView(act).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
        val col = Calm.column(act, 12).apply {
            gravity = android.view.Gravity.CENTER_HORIZONTAL
            addView(Calm.qr(act, qr, Calm.caption(act, "Scan with a phone on this Wi-Fi, then fill it in there."), 360) { Handoff.share(act, h.url!!) })
            addView(Calm.quiet(act, "Type it here instead") { dialog?.dismiss(); type(act, JSONObject(), done) })
            addView(Calm.more(act, HELP))
        }
        dialog = CalmDialog(act).setTitle("Your own storage").setView(col).setNegativeButton("Cancel", null)
            .setOnDismissListener { h.stop(); got?.let { m -> checkThenKeep(act, m.optJSONObject("fields") ?: JSONObject(), done) } }.show()
    }

    /** Typed on the tablet (a keyboard cover), or again after a Check that didn't pass, with what was there. */
    private fun type(act: MainActivity, was: JSONObject, done: () -> Unit) {
        val boxes = FIELDS.associate { (id, label, _) ->
            id to Calm.field(act, if (id == "region") "Region (us-east-1)" else label, 22f).apply {
                setText(was.optString(id))
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or (if (id == "secret") InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_URI)
            }
        }
        val col = Calm.column(act, 10).apply { boxes.values.forEach { addView(it) } }
        CalmDialog(act).setTitle("Your own storage").setView(col).setWidth(760f).setMore(HELP)
            .setPositiveButton("Check and use it") { _, _ -> checkThenKeep(act, JSONObject().apply { boxes.forEach { (k, v) -> put(k, v.text.toString()) } }, done) }
            .setNegativeButton("Cancel", null).show()
    }

    private fun checkThenKeep(act: MainActivity, fields: JSONObject, done: () -> Unit) {
        val (cfg, why) = clean(fields)
        if (cfg == null) return notYet(act, why!!, fields, done)
        act.toast("Checking it…")
        thread {
            val w = check(cfg)
            if (w == null) write(cfg)
            act.runOnUiThread { if (w == null) done() else notYet(act, w, fields, done) }
        }
    }

    private fun notYet(act: MainActivity, why: String, fields: JSONObject, done: () -> Unit) {
        CalmDialog(act).setTitle("That didn’t work").setMessage(why)
            .setPositiveButton("Try again") { _, _ -> type(act, fields, done) }.setNegativeButton("Cancel", null).show()
    }
}
