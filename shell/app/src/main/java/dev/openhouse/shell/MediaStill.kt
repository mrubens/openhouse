package dev.openhouse.shell

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * A still for a video in Photos (bridge/stills.js, docs/photos.md "Videos"): a frame half a second in, at most
 * [LONG] px on its long side, upright, as a JPEG. DeviceServer's POST /media/still {path} → {jpeg: <base64>} | {error}.
 * Only files in the display's photos folder; one at a time (a video decoder is heavy). Never logged: which video.
 */
internal object MediaStill {
    private const val TAG = "MediaStill"
    private const val LONG = 1600
    private val one = Object()

    fun still(ctx: Context, path: String): Pair<Int, String> {
        fun error(m: String) = 200 to JSONObject().put("error", m).toString()
        val dir = File(ctx.filesDir, "display/photos").canonicalFile
        val f = runCatching { File(path).canonicalFile }.getOrNull() ?: return error("no such video")
        if (f.parentFile != dir || !f.isFile || !Regex("(?i).+\\.(mp4|mov|m4v)$").matches(f.name)) return error("no such video")
        return synchronized(one) {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(f.path)
                val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                val turn = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                val box = minOf(LONG, maxOf(w, h)) // (a square box: the frame keeps its shape inside it, whichever way up)
                val at = 500_000L
                var bmp = (if (w > 0 && h > 0) r.getScaledFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, box, box)
                    else r.getFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)) ?: r.frameAtTime ?: return@synchronized error("no frame")
                // A phone held upright records sideways with a rotation: turn the frame if the retriever didn't.
                if ((turn == 90 || turn == 270) && w != h && (bmp.width > bmp.height) == (w > h)) {
                    val up = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(turn.toFloat()) }, true)
                    if (up !== bmp) bmp.recycle(); bmp = up
                }
                try {
                    val jpeg = ByteArrayOutputStream().use { o -> bmp.compress(Bitmap.CompressFormat.JPEG, 82, o); Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP) }
                    200 to JSONObject().put("jpeg", jpeg).toString()
                } finally { bmp.recycle() }
            } catch (e: OutOfMemoryError) { error("too big to read") }
            catch (e: Exception) { Log.w(TAG, "still: ${e.javaClass.simpleName}"); error("couldn't read it") }
            finally { runCatching { r.release() } }
        }
    }
}
