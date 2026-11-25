package dev.openhouse.shell

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Opie looking through the camera (the bridge's look_with_camera, DeviceServer /camera). A sheet on the tablet says Opie
 * wants the camera and why, and nothing opens the camera until a person taps Allow. Opie can't: while the sheet is up
 * its screen tools are refused (DeviceServer.call1, so it can't see the sheet or tap it), and an Allow its own tap set
 * off does nothing (DeviceServer.personOnly). Cancel, or no answer in 30 seconds, is a no.
 *
 * After Allow: the live preview, marked "Camera on", one picture when a person taps Take picture (never by itself: no
 * countdown, and Opie's own taps can't take it), and the camera
 * closed at once. The picture is only ever in memory, handed to the bridge once (which sends it to the household's
 * own cloud AI and keeps nothing).
 */
object CameraLook {
    private const val TAG = "CameraLook"
    private const val ASK_MS = 30_000L
    /** The camera's sheet is on the screen: Opie's screen tools wait (DeviceServer). */
    @Volatile var showing = false; private set

    sealed class Result {
        class Picture(val jpeg: ByteArray) : Result()
        class No(val why: String) : Result()
    }

    /** Ask, show, take one picture. Blocks the calling (server) thread until there's a picture or a no. */
    fun ask(why: String): Result {
        synchronized(this) { if (showing) return Result.No("The camera is already asking."); showing = true }
        try {
            val a = MainActivity.live ?: return Result.No("The display isn't showing.")
            if (!a.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) return Result.No("This tablet has no camera.")
            val got = LinkedBlockingQueue<Result>()
            val main = Handler(Looper.getMainLooper())
            main.post { runCatching { KioskApps.goHome(); dev.openhouse.ui.Openhouse.touch() } } // OpenHouse in front, awake
            main.postDelayed({
                runCatching { Sheet(a, why) { got.offer(it) }.show() }.onFailure { Log.w(TAG, "sheet: $it"); got.offer(Result.No("The camera didn't start.")) }
            }, 400)
            val r = got.poll(3, TimeUnit.MINUTES) ?: Result.No("The camera didn't answer.")
            runCatching { dev.openhouse.ui.Openhouse.vlog("camera", if (r is Result.No) "no picture: ${r.why}" else "one picture taken, after Allow") }
            return r
        } finally { showing = false }
    }

    /** The camera permission, granted by the device owner to itself (asked once, at Allow). */
    private fun granted(a: MainActivity): Boolean {
        val p = android.Manifest.permission.CAMERA
        if (a.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) return true
        runCatching {
            val dpm = a.getSystemService(DevicePolicyManager::class.java)
            if (dpm.isDeviceOwnerApp(a.packageName))
                dpm.setPermissionGrantState(ComponentName(a, AdminReceiver::class.java), a.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        }
        return a.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    }

    private class Sheet(val a: MainActivity, val why: String, val done: (Result) -> Unit) {
        val K = dev.openhouse.ui.Calm
        val h = Handler(Looper.getMainLooper())
        val layer = FrameLayout(a).apply { setBackgroundColor(K.SCRIM); isClickable = true } // swallows taps meant for what's under it
        var finished = false
        var provider: ProcessCameraProvider? = null
        var capture: ImageCapture? = null
        var front = true
        var taking = false
        lateinit var preview: PreviewView
        lateinit var count: TextView
        val work = Executors.newSingleThreadExecutor()

        fun card() = K.column(a).apply {
            setPadding(K.px(a, 44), K.px(a, 40), K.px(a, 44), K.px(a, 32))
            background = K.rounded(K.SHEET, K.R_SHEET * K.u(a)); elevation = 24f
        }
        fun put(card: LinearLayout, w: Int) {
            layer.removeAllViews()
            layer.addView(card, FrameLayout.LayoutParams(K.px(a, w), -2, Gravity.CENTER))
        }

        fun show() {
            a.root.addView(layer, FrameLayout.LayoutParams(-1, -1))
            runCatching { // a keyboard left up (a field below in focus) would hide Allow
                a.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(a.window.decorView.windowToken, 0)
                a.currentFocus?.clearFocus()
            }
            val c = card()
            // docs/ux.md: the title is the question; Opie's reason, then one line that changes the decision.
            c.addView(K.title(a, "Let Opie take a picture?"))
            if (why.isNotBlank()) c.addView(K.text(a, why, K.BODY, 400, K.INK).apply { setPadding(0, K.px(a, 12), 0, 0) })
            c.addView(K.text(a, "One picture, and none is kept.", 18f, 400, K.SOFT).apply { setPadding(0, K.px(a, 12), 0, 0) })
            val row = K.row(a, 8).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL; setPadding(0, K.px(a, 28), 0, 0) }
            row.addView(K.quiet(a, "Not now") { finish(Result.No("They tapped Not now.")) })
            var byHand: () -> Boolean = { false } // a finger on the glass, not an injected tap (dev.openhouse.ui.PersonCards)
            row.addView(K.primary(a, "Allow") { if (byHand()) allow() }.also { byHand = dev.openhouse.ui.PersonCards.yesOnlyByHand(it) })
            c.addView(row)
            put(c, 760)
            h.postDelayed({ finish(Result.No("Nobody answered on the screen.")) }, ASK_MS)
            a.lifecycle.addObserver(gone)
        }
        /** The display went away meanwhile (restarted, or another app in front): the camera is off, and that's a no. */
        val gone = androidx.lifecycle.LifecycleEventObserver { _, e ->
            if (e == androidx.lifecycle.Lifecycle.Event.ON_STOP || e == androidx.lifecycle.Lifecycle.Event.ON_DESTROY) finish(Result.No("The camera closed before a picture was taken."))
        }

        fun allow() {
            if (finished || DeviceServer.personOnly("Turning on the camera")) return
            h.removeCallbacksAndMessages(null)
            if (!granted(a)) { finish(Result.No("The tablet hasn't let OpenHouse use the camera.")); return }
            val c = card()
            val top = K.row(a).apply { gravity = Gravity.CENTER_VERTICAL }
            top.addView(K.text(a, "Camera on", K.LABEL, 600, K.INK), LinearLayout.LayoutParams(0, -2, 1f))
            count = K.text(a, "Starting the camera", 18f, 500, K.SOFT)
            top.addView(count)
            c.addView(top)
            preview = PreviewView(a).apply { scaleType = PreviewView.ScaleType.FILL_CENTER; implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                clipToOutline = true; outlineProvider = object : android.view.ViewOutlineProvider() {
                    override fun getOutline(v: android.view.View, o: android.graphics.Outline) { o.setRoundRect(0, 0, v.width, v.height, K.R_SHEET * K.u(a) * .6f) } } }
            c.addView(preview, LinearLayout.LayoutParams(-1, K.px(a, 470)).apply { topMargin = K.px(a, 18) })
            c.addView(K.text(a, "Hold it up to the camera, then tap Take picture.", 18f, 400, K.SOFT).apply { setPadding(0, K.px(a, 14), 0, 0) })
            val row = K.row(a, 8).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL; setPadding(0, K.px(a, 20), 0, 0) }
            row.addView(K.quiet(a, "Cancel") { finish(Result.No("They tapped Cancel.")) })
            val switch = K.quiet(a, "Switch camera") { if (!taking) { front = !front; bind() } }.apply { visibility = android.view.View.GONE } // shown once both are found
            row.addView(switch)
            row.addView(K.primary(a, "Take picture") { if (!DeviceServer.personOnly("Taking a picture")) take() })
            c.addView(row)
            put(c, 900)
            h.postDelayed({ finish(Result.No("Nobody took a picture.")) }, 90_000) // nobody tapped: closed with none
            val f = ProcessCameraProvider.getInstance(a)
            f.addListener({
                if (finished) return@addListener
                val p = runCatching { f.get() }.getOrElse { finish(Result.No("The camera didn't start.")); return@addListener }
                provider = p
                val has = { s: CameraSelector -> runCatching { p.hasCamera(s) }.getOrDefault(false) }
                if (has(CameraSelector.DEFAULT_FRONT_CAMERA) && has(CameraSelector.DEFAULT_BACK_CAMERA)) switch.visibility = android.view.View.VISIBLE
                bind()
            }, a.mainExecutor)
        }

        fun bind() {
            val p = provider ?: return
            runCatching {
                val has = { s: CameraSelector -> runCatching { p.hasCamera(s) }.getOrDefault(false) }
                val sel = when {
                    front && has(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
                    has(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                    else -> CameraSelector.DEFAULT_FRONT_CAMERA
                }
                val pv = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
                val cap = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                        ResolutionStrategy(Size(2048, 1536), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)).build())
                    .apply { preview.display?.rotation?.let { setTargetRotation(it) } }.build()
                p.unbindAll()
                p.bindToLifecycle(a, sel, pv, cap)
                capture = cap
            }.onFailure { Log.w(TAG, "bind: $it"); finish(Result.No("The camera didn't start.")); return }
            if (!taking) count.text = ""
        }

        fun take() {
            val cap = capture ?: return
            if (finished || taking) return
            taking = true; count.text = "Taking it"
            cap.takePicture(work, object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(img: ImageProxy) {
                    val jpeg = runCatching { small(img) }.getOrNull()
                    img.close()
                    h.post { finish(if (jpeg != null) Result.Picture(jpeg) else Result.No("The camera couldn't take it.")) }
                }
                override fun onError(e: ImageCaptureException) { Log.w(TAG, "capture: $e"); h.post { finish(Result.No("The camera couldn't take it.")) } }
            })
        }

        /** The picture upright, at most 1600 px on its long side, as a JPEG (in memory only). */
        fun small(img: ImageProxy): ByteArray {
            val buf = img.planes[0].buffer
            val raw = ByteArray(buf.remaining()).also { buf.get(it) }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1600) sample *= 2
            val b = BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })
            val scale = minOf(1f, 1600f / maxOf(b.width, b.height))
            val m = Matrix().apply { postScale(scale, scale); postRotate(img.imageInfo.rotationDegrees.toFloat()) }
            val out = Bitmap.createBitmap(b, 0, 0, b.width, b.height, m, true)
            if (out !== b) b.recycle()
            return ByteArrayOutputStream().use { s -> out.compress(Bitmap.CompressFormat.JPEG, 85, s); out.recycle(); s.toByteArray() }
        }

        fun finish(r: Result) {
            if (finished) return
            finished = true
            h.removeCallbacksAndMessages(null)
            a.lifecycle.removeObserver(gone)
            runCatching { provider?.unbindAll() } // the camera off now
            capture = null
            runCatching { a.root.removeView(layer) }
            work.shutdown()
            done(r)
        }
    }
}
