package dev.openhouse.shell

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

/**
 * What an email brings that the bridge can't read itself (docs/tablet-email.md, "How the parts talk"): a PDF's pages
 * as JPEGs (Android's PdfRenderer) and a HEIC photo as a JPEG (ImageDecoder). DeviceServer's routes, its token:
 *   POST /mail/pdf  {pdf: <base64>, pages: n ≤ 20} → {pages: [<base64 JPEG>]}
 *   POST /mail/heic {heic: <base64>}               → {jpeg: <base64>}
 * Errors are {error}. One at a time (each can hold tens of MB); the PDF's temporary file is deleted after.
 * Never logged: what's in them.
 */
internal object MailConvert {
    private const val TAG = "MailConvert"
    val PATHS = setOf("/mail/pdf", "/mail/heic")
    /** 25 MB as base64 (×4/3), and the JSON around it. */
    const val MAX_BODY = 36 shl 20
    private const val PDF_LONG = 1600
    private const val HEIC_LONG = 2400
    private const val MAX_PAGES = 20
    private val one = Object()

    fun handle(ctx: Context, path: String, body: ByteArray): Pair<Int, String> {
        fun error(code: Int, m: String) = code to JSONObject().put("error", m).toString()
        val key = if (path == "/mail/pdf") "pdf" else "heic"
        val data = runCatching { b64Value(body, key) }.getOrNull() ?: return error(400, "no $key")
        return synchronized(one) {
            try {
                if (path == "/mail/pdf") 200 to JSONObject().put("pages", pdf(ctx, data, (numValue(body, "pages") ?: MAX_PAGES).coerceIn(1, MAX_PAGES))).toString()
                else 200 to JSONObject().put("jpeg", heic(data)).toString()
            } catch (e: OutOfMemoryError) { error(200, "too big to read") }
            catch (e: Exception) { Log.w(TAG, "$key: ${e.javaClass.simpleName}"); error(200, "couldn't read it") }
        }
    }

    private fun pdf(ctx: Context, data: ByteArray, pages: Int): JSONArray {
        val tmp = File.createTempFile("mail-", ".pdf", ctx.cacheDir)
        try {
            tmp.writeBytes(data)
            val out = JSONArray()
            ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                PdfRenderer(fd).use { r ->
                    for (i in 0 until minOf(pages, r.pageCount)) r.openPage(i).use { p ->
                        val s = PDF_LONG.toFloat() / maxOf(p.width, p.height, 1)
                        val w = (p.width * s).toInt().coerceIn(1, PDF_LONG); val h = (p.height * s).toInt().coerceIn(1, PDF_LONG)
                        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        try {
                            bmp.eraseColor(Color.WHITE) // a page is transparent where nothing's drawn
                            p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            out.put(jpeg(bmp, 80))
                        } finally { bmp.recycle() }
                    }
                }
            }
            return out
        } finally { tmp.delete() }
    }

    private fun heic(data: ByteArray): String {
        val src = ImageDecoder.createSource(ByteBuffer.wrap(data))
        val bmp = ImageDecoder.decodeBitmap(src) { d, info, _ ->
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // to compress it
            val w = info.size.width; val h = info.size.height
            if (maxOf(w, h) > HEIC_LONG) { val s = HEIC_LONG.toFloat() / maxOf(w, h); d.setTargetSize((w * s).toInt().coerceAtLeast(1), (h * s).toInt().coerceAtLeast(1)) }
        }
        try { return jpeg(bmp, 85) } finally { bmp.recycle() }
    }

    private fun jpeg(b: Bitmap, q: Int): String = ByteArrayOutputStream().use { o -> b.compress(Bitmap.CompressFormat.JPEG, q, o); Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP) }

    /** The base64 string under "[key]" in a flat JSON object, decoded from the body's bytes without copying it into a
     *  String (a 25 MB attachment is 34 MB of base64). Base64 has no quotes or backslashes; one escaped "\/" is undone. */
    internal fun b64Value(body: ByteArray, key: String): ByteArray? {
        val start = valueStart(body, key) ?: return null
        if (start >= body.size || body[start] != '"'.code.toByte()) return null
        var end = start + 1
        var escaped = false
        while (end < body.size && body[end] != '"'.code.toByte()) { if (body[end] == '\\'.code.toByte()) escaped = true; end++ }
        if (end >= body.size) return null
        if (!escaped) return Base64.decode(body, start + 1, end - start - 1, Base64.DEFAULT)
        val s = String(body, start + 1, end - start - 1, Charsets.US_ASCII).replace("\\/", "/")
        return Base64.decode(s, Base64.DEFAULT)
    }

    private fun numValue(body: ByteArray, key: String): Int? {
        var i = valueStart(body, key) ?: return null
        val sb = StringBuilder()
        while (i < body.size && sb.length < 6 && body[i] in '0'.code.toByte()..'9'.code.toByte()) { sb.append(body[i].toInt().toChar()); i++ }
        return sb.toString().toIntOrNull()
    }

    /** Where the value of "[key]": starts (past the colon and spaces), looking only at keys: never inside a string value. */
    private fun valueStart(body: ByteArray, key: String): Int? {
        val want = "\"$key\"".toByteArray()
        var i = 0
        var depth = 0
        while (i < body.size) {
            val c = body[i].toInt().toChar()
            when (c) {
                '{', '[' -> { depth++; i++ }
                '}', ']' -> { depth--; i++ }
                '"' -> {
                    // A string: a key when a colon follows it.
                    var e = i + 1
                    while (e < body.size && body[e] != '"'.code.toByte()) { if (body[e] == '\\'.code.toByte()) e++; e++ }
                    var j = e + 1
                    while (j < body.size && body[j].toInt().toChar().isWhitespace()) j++
                    if (j < body.size && body[j] == ':'.code.toByte()) {
                        if (depth == 1 && e - i + 1 == want.size && (0 until want.size).all { body[i + it] == want[it] }) {
                            j++; while (j < body.size && body[j].toInt().toChar().isWhitespace()) j++
                            return j
                        }
                        i = j + 1
                    } else i = e + 1
                }
                else -> i++
            }
        }
        return null
    }
}
