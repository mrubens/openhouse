package dev.openhouse.shell

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * The household's own mailbox (docs/tablet-email.md, "Without our cloud"): an address at any provider with IMAP, kept
 * here sealed with a Keystore key in the no-backup folder, as [CalendarAccounts] keeps iCloud's password, and only
 * ever sent to that server. Every 2 minutes (and right after it's added) the inbox is checked for messages that came
 * after it was added; each goes to the bridge (POST /mail/incoming, which makes the same checks the cloud's gate
 * would), and is marked read on the server once the bridge says ok.
 *
 * Never logged: the password, the address, the server, or anything in a message.
 */
object MailAccount {
    private const val TAG = "MailAccount"
    private const val ALIAS = "mail-account"
    const val MAX_MESSAGE = 25 shl 20
    private lateinit var ctx: Context
    private lateinit var bridge: () -> String

    /** [lastUid]: the newest message handed over (or there when it was added); -1 until the first look. */
    data class Account(val host: String, val port: Int, val user: String, val password: String, val addedAt: Long, val lastUid: Long, val uidValidity: Long)

    // --- storage ---------------------------------------------------------------------------------
    private val file get() = File(ctx.noBackupFilesDir, "mail-account")
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    @Synchronized fun get(): Account? = runCatching {
        if (!file.exists()) return null
        val b = file.readBytes()
        val plain = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12)) }.doFinal(b, 12, b.size - 12)
        val j = JSONObject(String(plain))
        Account(j.getString("host"), j.optInt("port", 993), j.getString("user"), j.getString("password"), j.optLong("addedAt"), j.optLong("lastUid", -1), j.optLong("uidValidity"))
    }.getOrNull()
    @Synchronized private fun save(a: Account) {
        val plain = JSONObject().put("host", a.host).put("port", a.port).put("user", a.user).put("password", a.password)
            .put("addedAt", a.addedAt).put("lastUid", a.lastUid).put("uidValidity", a.uidValidity).toString().toByteArray()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(plain))
        tmp.renameTo(file)
    }
    /** Where it's got to, only if it's still the same mailbox (not removed or replaced meanwhile). */
    @Synchronized private fun advance(a: Account, lastUid: Long, uidValidity: Long): Account? {
        val now = get() ?: return null
        if (now.addedAt != a.addedAt) return null
        return now.copy(lastUid = lastUid, uidValidity = uidValidity).also { save(it) }
    }
    @Synchronized fun remove() { file.delete(); lastError = null }

    // --- checking --------------------------------------------------------------------------------
    private val worker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "mail-imap").apply { isDaemon = true } }
    private var started = false
    /** What went wrong at the last look (for Settings), or null. */
    @Volatile var lastError: String? = null
        private set
    @Volatile var lastChecked: Long = 0
        private set

    fun init(c: Context) = synchronized(this) { if (!::ctx.isInitialized) ctx = c.applicationContext }

    fun start(c: Context, bridgeUrl: () -> String) = synchronized(this) {
        ctx = c.applicationContext; bridge = bridgeUrl
        if (started || Move.handedOver(c)) return@synchronized // the old display, after the handover
        started = true
        worker.scheduleWithFixedDelay({ runCatching { check() } }, 30, 120, TimeUnit.SECONDS) // the bridge is still starting
    }

    /** A look now (just added). */
    fun checkSoon() { if (::ctx.isInitialized) worker.execute { runCatching { check() } } }

    private fun check() {
        val a = get() ?: return
        lastChecked = System.currentTimeMillis()
        lastError = try { round(a); null }
        catch (e: Imap.No) { if (e.login) "The server didn't accept the address and password" else "The server said no" }
        catch (e: Exception) { Log.w(TAG, "check: ${e.javaClass.simpleName}"); "Couldn't reach the server" }
    }

    /** One look: the inbox's new messages, oldest first, to the bridge. Stops at the bridge's first error (next time). */
    private fun round(start: Account) {
        var a = start
        Imap.open(a.host, a.port).use { m ->
            m.login(a.user, a.password)
            val box = m.select("INBOX")
            if (a.lastUid < 0 || (a.uidValidity != 0L && box.uidValidity != a.uidValidity)) {
                // First look (or the server renumbered the inbox): only what comes after now counts.
                advance(a, box.uidNext - 1, box.uidValidity); return
            }
            if (a.uidValidity == 0L) a = advance(a, a.lastUid, box.uidValidity) ?: return
            val uids = m.searchFrom(a.lastUid + 1).filter { it > a.lastUid }.sorted().take(50)
            for (uid in uids) {
                val size = m.size(uid)
                if (size == null || size > MAX_MESSAGE) { Log.i(TAG, "skipped one over 25 MB"); a = advance(a, uid, box.uidValidity) ?: return; continue }
                val raw = m.fetch(uid)
                if (raw == null) { a = advance(a, uid, box.uidValidity) ?: return; continue } // gone meanwhile
                if (!handOver(raw)) return
                a = advance(a, uid, box.uidValidity) ?: return
                runCatching { m.seen(uid) }.onFailure { Log.w(TAG, "seen: ${it.javaClass.simpleName}") }
            }
            runCatching { m.logout() }
        }
    }

    /** POST /mail/incoming {raw, source: "imap"}: true only on {ok: true}. */
    private fun handOver(raw: ByteArray): Boolean = runCatching {
        val head = "{\"source\":\"imap\",\"raw\":\"".toByteArray(); val tail = "\"}".toByteArray()
        val b64 = Base64.encode(raw, Base64.NO_WRAP)
        val c = dev.openhouse.ui.BridgeClient.open(bridge() + "/mail/incoming")
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = 180_000
        c.setRequestProperty("Content-Type", "application/json")
        c.setFixedLengthStreamingMode(head.size + b64.size + tail.size)
        c.outputStream.use { it.write(head); it.write(b64); it.write(tail) }
        val code = c.responseCode
        val text = ((if (code < 400) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: "")
        code == 200 && JSONObject(text).optBoolean("ok")
    }.getOrDefault(false)

    /** Settings' "Use your own mailbox": signs in and opens the inbox (so a typo is said now), then keeps it, starting
     *  from the messages that come after now. Off the main thread. Null when it's kept, else what went wrong. */
    fun add(host: String, port: Int, user: String, password: String): String? {
        val uidNext: Long; val validity: Long
        try {
            Imap.open(host, port).use { m -> m.login(user, password); val b = m.select("INBOX"); uidNext = b.uidNext; validity = b.uidValidity; runCatching { m.logout() } }
        } catch (e: Imap.No) { return if (e.login) "The server didn't accept them. Use an app password, not the account's own." else "The server has no inbox for it." }
        catch (e: Exception) { Log.w(TAG, "add: ${e.javaClass.simpleName}"); return "Couldn't reach that server. Check its name." }
        save(Account(host, port, user, password, System.currentTimeMillis(), uidNext - 1, validity))
        lastError = null
        checkSoon()
        return null
    }
}

/**
 * The little IMAP (RFC 3501) the mailbox needs, over TLS with the host's certificate checked: LOGIN, SELECT, UID SEARCH,
 * UID FETCH (literals read to their length, no further) and UID STORE. One command at a time.
 */
internal class Imap private constructor(private val s: SSLSocket) : AutoCloseable {
    class No(m: String, val login: Boolean = false) : IOException(m)
    class Box(val uidValidity: Long, val uidNext: Long)
    /** One response: its text, with each literal's place in it marked {n}, and the literals. */
    class Resp(val text: String, val literals: List<ByteArray>)

    private val inp = BufferedInputStream(s.inputStream)
    private val out: OutputStream = s.outputStream
    private var n = 0

    companion object {
        private const val MAX_LINE = 1 shl 20
        fun open(host: String, port: Int): Imap {
            val raw = Socket().apply { connect(InetSocketAddress(host, port), 15_000); soTimeout = 60_000 }
            val s = try { (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, host, port, true) as SSLSocket }
                catch (e: Exception) { raw.close(); throw e }
            try {
                s.startHandshake()
                if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, s.session)) throw IOException("certificate")
                val m = Imap(s)
                val hi = m.read()
                if (!hi.text.startsWith("* OK") && !hi.text.startsWith("* PREAUTH")) throw IOException("greeting")
                return m
            } catch (e: Exception) { s.close(); throw e }
        }

        /** A string as IMAP takes it: quoted when it's plain ASCII, else a literal (the caller sends those). */
        fun quote(v: String): String = "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        fun plain(v: String) = v.all { it.code in 0x20..0x7e }
    }

    override fun close() { runCatching { s.close() } }

    fun login(user: String, password: String) {
        // Either may need a literal (a password with non-ASCII in it): sent after the server's "+".
        val parts = listOf("LOGIN ", user, " ", password)
        run(parts, values = setOf(1, 3), login = true)
    }

    fun select(box: String): Box {
        val rs = run(listOf("SELECT ", box), values = setOf(1))
        var validity = 0L; var next = 0L
        for (r in rs) {
            Regex("\\[UIDVALIDITY (\\d+)]", RegexOption.IGNORE_CASE).find(r.text)?.let { validity = it.groupValues[1].toLong() }
            Regex("\\[UIDNEXT (\\d+)]", RegexOption.IGNORE_CASE).find(r.text)?.let { next = it.groupValues[1].toLong() }
        }
        if (next == 0L) { // not said on SELECT (it's optional): one past the newest there
            next = (searchFrom(1).maxOrNull() ?: 0L) + 1
        }
        return Box(validity, next)
    }

    fun searchFrom(uid: Long): List<Long> = run(listOf("UID SEARCH UID $uid:*")).filter { it.text.startsWith("* SEARCH", true) }
        .flatMap { it.text.substring(8).trim().split(' ').mapNotNull { t -> t.toLongOrNull() } }

    fun size(uid: Long): Long? = run(listOf("UID FETCH $uid (RFC822.SIZE)")).firstNotNullOfOrNull { r ->
        if (!Regex("^\\* \\d+ FETCH", RegexOption.IGNORE_CASE).containsMatchIn(r.text) || !uidIs(r.text, uid)) null
        else Regex("RFC822\\.SIZE (\\d+)", RegexOption.IGNORE_CASE).find(r.text)?.groupValues?.get(1)?.toLongOrNull()
    }

    fun fetch(uid: Long): ByteArray? = run(listOf("UID FETCH $uid BODY.PEEK[]")).firstNotNullOfOrNull { r ->
        if (!Regex("^\\* \\d+ FETCH", RegexOption.IGNORE_CASE).containsMatchIn(r.text) || !uidIs(r.text, uid)) null
        else r.literals.maxByOrNull { it.size }
    }

    fun seen(uid: Long) { run(listOf("UID STORE $uid +FLAGS (\\Seen)")) }

    fun logout() { run(listOf("LOGOUT")) }

    /** A FETCH response is for this message (a server may also send others' flag changes in between). */
    private fun uidIs(text: String, uid: Long) = Regex("UID (\\d+)", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toLongOrNull()?.let { it == uid } ?: true

    /** Sends one command ([parts], those at [values] are strings to quote or send as literals) and reads to its tagged
     *  answer: the untagged responses on OK, [No] otherwise. */
    private fun run(parts: List<String>, values: Set<Int> = emptySet(), login: Boolean = false): List<Resp> {
        val tag = "a${++n}"
        val line = ByteArrayOutputStream()
        line.write("$tag ".toByteArray())
        val got = mutableListOf<Resp>()
        parts.forEachIndexed { i, p ->
            if (i !in values) { line.write(p.toByteArray(Charsets.US_ASCII)); return@forEachIndexed }
            if (plain(p)) { line.write(quote(p).toByteArray(Charsets.US_ASCII)); return@forEachIndexed }
            val bytes = p.toByteArray(Charsets.UTF_8)
            line.write("{${bytes.size}}\r\n".toByteArray()); out.write(line.toByteArray()); out.flush(); line.reset()
            while (true) { // the server's go-ahead for the literal
                val r = read()
                if (r.text.startsWith("+")) break
                if (r.text.startsWith("$tag ")) throw No("refused", login)
                got += r
            }
            out.write(bytes)
        }
        line.write("\r\n".toByteArray()); out.write(line.toByteArray()); out.flush()
        while (true) {
            val r = read()
            if (r.text.startsWith("$tag ")) {
                if (!r.text.substring(tag.length + 1).startsWith("OK", true)) throw No("no", login)
                return got
            }
            if (r.text.startsWith("+")) continue
            if (r.text.startsWith("* BYE", true) && parts.firstOrNull() != "LOGOUT") throw IOException("bye")
            got += r
        }
    }

    /** One response, its literals read to exactly their length (and never past [MailAccount.MAX_MESSAGE] + a little). */
    private fun read(): Resp {
        val text = StringBuilder(); val lits = mutableListOf<ByteArray>()
        while (true) {
            val l = line()
            text.append(l)
            val m = Regex("\\{(\\d{1,10})\\+?}$").find(l) ?: return Resp(text.toString(), lits)
            val len = m.groupValues[1].toLong()
            if (len > MailAccount.MAX_MESSAGE + (1 shl 20)) throw IOException("too big")
            val b = ByteArray(len.toInt()); var o = 0
            while (o < b.size) { val r = inp.read(b, o, b.size - o); if (r < 0) throw IOException("closed"); o += r }
            lits += b
        }
    }

    private fun line(): String {
        val sb = ByteArrayOutputStream()
        while (true) {
            val c = inp.read()
            if (c < 0) throw IOException("closed")
            if (c == '\n'.code) return sb.toString("UTF-8").trimEnd('\r')
            sb.write(c)
            if (sb.size() > MAX_LINE) throw IOException("line too long")
        }
    }
}
