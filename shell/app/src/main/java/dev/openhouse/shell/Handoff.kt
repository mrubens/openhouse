package dev.openhouse.shell

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

/**
 * A page on the home network for bringing a long secret from a phone or laptop, so nobody types it on the
 * tablet: a private calendar link, an album's link. It listens on the Wi-Fi address only, for [minutes]
 * or until one submission arrives ([once]), then stops. Who may start one is the caller's call: the secrets
 * above start only from Settings.
 *
 * The QR code is http://<tablet>:<port>/#<key>. The key is after #, so the phone never sends it anywhere; the page
 * (assets/handoff.html) uses it to open what the tablet says ([info], sealed) and to seal what it sends back. It's
 * plain http, so ChaCha20-Poly1305 does the work (inlined in the page; here it's Android's own). Anyone else on the
 * Wi-Fi sees only sealed bytes and can't post anything that opens.
 *
 * Nothing is logged or kept: [onSecret] gets the opened JSON ({value, who?}) on the main thread.
 *
 * Other kinds (photos from a phone, say) bring their own [page] (an asset with the same sealing code), a bigger
 * [maxBytes], [once] = false to take many, and [onData], which gets each opened body on the connection's thread
 * (write it somewhere; a throw answers 500). A POST to /s is the sealed body: raw bytes (nonce, ciphertext, tag)
 * when sent as application/octet-stream, else that in base64url text.
 */
class Handoff(
    private val ctx: Context,
    private val info: JSONObject,
    private val minutes: Int = 5,
    private val onSecret: (JSONObject) -> Unit = {},
    private val onEnd: () -> Unit = {},
    private val page: String = "handoff.html",
    private val maxBytes: Int = 16_384,
    private val once: Boolean = true,
    private val onData: ((ByteArray) -> Unit)? = null,
    /** What the page reads at /i, made fresh each time (a live list); else [info]. */
    private val infoNow: (() -> JSONObject)? = null,
    /** A key that outlasts this run (a household's lasting photo page, [PhotoShare]); else a fresh one. */
    fixedKey: ByteArray? = null,
    /** The port to try first (a lasting page keeps its address while the tablet keeps its own); 0: any. */
    private val port: Int = 0,
) {
    private val main = Handler(Looper.getMainLooper())
    private val key = fixedKey?.takeIf { it.size == 32 } ?: ByteArray(32).also { SecureRandom().nextBytes(it) }
    private var server: ServerSocket? = null
    @Volatile private var over = false // takes nothing more
    private var ended = false
    private var misses = 0

    /** The relay's origin (wss://…), when this page may also be reached through it (a list away from home,
     *  bridge/relay.js): the page's connect-src then allows it. */
    @Volatile var relayOrigin: String? = null

    /** Still listening (started, not stopped or timed out). */
    val running: Boolean get() = url != null && !ended
    /** What the QR code holds, or null when the tablet isn't on a network ([start] failed). */
    var url: String? = null; private set

    fun start(): Boolean {
        val ip = lanAddress(ctx) ?: return false
        val s = (if (port > 0) runCatching { ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(ip, port), 8) } }.getOrNull() else null)
            ?: runCatching { ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(ip, 0), 8) } }.getOrNull() ?: return false
        server = s
        url = "http://${ip.hostAddress}:${s.localPort}/#" + b64(key)
        Log.i(TAG, "listening for ${minutes} min") // not the address or key
        thread(name = "handoff", isDaemon = true) {
            while (!over) {
                val c = runCatching { s.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { runCatching { c.use { serve(it) } } }
            }
        }
        if (minutes > 0) main.postDelayed(::stop, minutes * 60_000L) // 0: until stopped (a lasting page)
        return true
    }

    fun stop() {
        if (ended) return
        ended = true; over = true
        runCatching { server?.close() }
        main.removeCallbacksAndMessages(null)
        main.post(onEnd)
    }

    private fun serve(c: Socket) {
        c.soTimeout = 8000
        val inp = BufferedInputStream(c.getInputStream())
        val head = readHead(inp) ?: return
        val (method, path) = head.first.split(' ').let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "").substringBefore('?') }
        val out = c.getOutputStream()
        when {
            method == "GET" && path == "/" -> send(out, 200, "text/html; charset=utf-8", ctx.assets.open(page).use { it.readBytes() })
            method == "GET" && path == "/i" -> send(out, 200, "text/plain", seal("info", (runCatching { infoNow?.invoke() }.getOrNull() ?: info).toString().toByteArray()).toByteArray())
            method == "POST" && path == "/s" -> {
                val n = head.second["content-length"]?.toIntOrNull() ?: -1
                if (n !in 1..maxBytes) return send(out, 413, "text/plain", ByteArray(0))
                val body = ByteArray(n).also { var got = 0; while (got < n) { val r = inp.read(it, got, n - got); if (r < 0) return; got += r } }
                val raw = head.second["content-type"]?.startsWith("application/octet-stream") == true
                val plain = runCatching { if (raw) open("send", body) else open("send", String(body).trim()) }.getOrNull()
                val msg = if (onData != null || plain == null) null else runCatching { JSONObject(String(plain, Charsets.UTF_8)) }.getOrNull()
                if (over || plain == null || (onData == null && msg == null)) {
                    send(out, 400, "text/plain", ByteArray(0))
                    if (++misses >= 10) stop() // someone on the Wi-Fi guessing: stop listening
                    return
                }
                if (once) { over = true; runCatching { server?.close() } } // one secret, then this page is done
                val handle = onData
                if (handle != null) {
                    val ok = runCatching { handle(plain) }.isSuccess
                    send(out, if (ok) 200 else 500, "text/plain", ByteArray(0))
                    if (once) main.post { stop() }
                } else {
                    send(out, 200, "text/plain", ByteArray(0))
                    main.post { onSecret(msg!!); if (once) stop() }
                }
            }
            else -> send(out, 404, "text/plain", ByteArray(0))
        }
    }

    private fun readHead(inp: BufferedInputStream): Pair<String, Map<String, String>>? {
        val lines = mutableListOf<String>(); val line = StringBuilder()
        while (true) {
            val b = inp.read(); if (b < 0) return null
            if (b == '\n'.code) { val l = line.toString().trimEnd('\r'); line.clear(); if (l.isEmpty()) break; lines += l; if (lines.size > 60) return null }
            else { line.append(b.toChar()); if (line.length > 4096) return null }
        }
        val first = lines.firstOrNull() ?: return null
        return first to lines.drop(1).mapNotNull { h -> h.indexOf(':').takeIf { it > 0 }?.let { h.substring(0, it).trim().lowercase() to h.substring(it + 1).trim() } }.toMap()
    }

    private fun send(out: OutputStream, code: Int, type: String, body: ByteArray) {
        val head = "HTTP/1.1 $code ${if (code == 200) "OK" else "No"}\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n" +
            "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n" +
            "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'${relayOrigin?.let { " $it" } ?: ""}; form-action 'none'; frame-ancestors 'none'\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray()); out.write(body); out.flush()
    }

    private fun cipher(mode: Int, nonce: ByteArray, aad: String) = Cipher.getInstance("ChaCha20-Poly1305").apply {
        init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce)); updateAAD(aad.toByteArray())
    }
    private fun seal(aad: String, plain: ByteArray): String {
        val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return b64(nonce + cipher(Cipher.ENCRYPT_MODE, nonce, aad).doFinal(plain))
    }
    private fun open(aad: String, box: String) = open(aad, Base64.decode(box, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
    private fun open(aad: String, b: ByteArray): ByteArray {
        require(b.size >= 28)
        return cipher(Cipher.DECRYPT_MODE, b.copyOfRange(0, 12), aad).doFinal(b, 12, b.size - 12)
    }

    companion object {
        private const val TAG = "Handoff"
        private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

        /** The tablet's address on the home network (Wi-Fi or Ethernet, IPv4, private range), or null. */
        fun lanAddress(ctx: Context): InetAddress? {
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            val fromActive = runCatching { cm.getLinkProperties(cm.activeNetwork)?.linkAddresses?.map { it.address } }.getOrNull().orEmpty()
            val all = runCatching { NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.flatMap { it.inetAddresses.toList() } }.getOrDefault(emptyList())
            return (fromActive + all).firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
        }

        /**
         * The same link through Android's share sheet (Quick Share to a nearby phone or computer, a message, email),
         * for a device that can't scan. Kiosk mode only opens listed apps, so the share sheet and the apps that take
         * text are let in for now; [KioskApps.revokeTemporary] closes them when the display is back in front.
         */
        /** [a]: an Activity, or the shell's own context (an app asked through the bridge: then it opens over that app). */
        fun share(a: Context, url: String) {
            val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, url)
            val pm = a.packageManager
            // Not a browser or a terminal: let into kiosk, either is a way out of it.
            val browsers = runCatching { pm.queryIntentActivities(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("http://example.com")),
                android.content.pm.PackageManager.MATCH_ALL).map { it.activityInfo.packageName } }.getOrDefault(emptyList())
            val never = (browsers + listOf("com.termux", a.packageName)).toSet()
            val targets = runCatching { pm.queryIntentActivities(send, 0).map { it.activityInfo } }.getOrDefault(emptyList())
            val chooser = android.content.Intent.createChooser(send, null).putExtra(android.content.Intent.EXTRA_EXCLUDE_COMPONENTS,
                targets.filter { it.packageName in never }.map { android.content.ComponentName(it.packageName, it.name) }.toTypedArray())
            val pkgs = targets.map { it.packageName }.filter { it !in never } +
                listOfNotNull(runCatching { pm.resolveActivity(chooser, 0)?.activityInfo?.packageName }.getOrNull(), "com.android.intentresolver")
            pkgs.distinct().forEach { runCatching { KioskApps.allowInKiosk(it, temporary = true) } }
            if (a !is android.app.Activity) chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { a.startActivity(chooser) }.onFailure { Log.w(TAG, "share: ${it.javaClass.simpleName}") }
        }

        fun qr(text: String, size: Int = 360): Bitmap {
            val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
            return Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565).apply {
                for (x in 0 until size) for (y in 0 until size) setPixel(x, y, if (m[x, y]) Color.BLACK else Color.WHITE)
            }
        }
    }
}
