package dev.openhouse.shell

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Range
import android.util.Size
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import dev.openhouse.ui.House
import dev.openhouse.ui.Openhouse
import java.util.concurrent.Executors

/**
 * Wake when someone walks up (Settings → Brightness, docs/settings.md "Wake when someone walks up"): while the sleep
 * screen shows by day, the front camera watches for movement and wakes the home screen as a touch would.
 *
 * Tablets have no sensor that sees a person across a room: most have no proximity sensor at all, and the ones that do
 * see only a few centimetres (a face on a phone call). So it's the front camera, cheaply: the smallest stream it
 * offers, at its lowest frame rate, a few frames a second turned into a 16 × 12 grid of brightness, compared with the
 * one before. Movement in enough of the grid, two looks in a row, is someone there. No picture is made, kept or sent:
 * each frame is gone once its grid is taken, and nothing leaves the tablet.
 *
 * Off by default, and only on a tablet with a front camera. The camera is on only while it can wake something: the
 * sleep screen up, Opie in front, not at night, not after Sleep now, and not while Opie's own camera sheet
 * (CameraLook) has it. Night hours and Sleep now stay dark until a touch, as before.
 */
object WalkUp {
    private const val TAG = "WalkUp"
    private const val KEY = "walkup_wake"
    private const val GRID_W = 16
    private const val GRID_H = 12
    private const val LOOK_MS = 300L

    fun available(c: Context) = c.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FRONT)
    fun on(c: Context) = available(c) && c.getSharedPreferences("shell", Context.MODE_PRIVATE).getBoolean(KEY, false)
    fun set(c: Context, on: Boolean) {
        c.getSharedPreferences("shell", Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply()
        Log.i(TAG, if (on) "turned on" else "turned off")
        main.post { check() }
    }
    fun label(c: Context) = if (on(c)) "On" else "Off"

    private val main = Handler(Looper.getMainLooper())
    private var started = false
    private var provider: ProcessCameraProvider? = null
    private var analysis: ImageAnalysis? = null
    private val work = Executors.newSingleThreadExecutor()

    /** From MainActivity, once: every couple of seconds, whether the camera should be watching now. */
    fun start() {
        if (started) return; started = true
        main.post(object : Runnable { override fun run() { check(); main.postDelayed(this, 2000) } })
    }

    private fun wanted(a: MainActivity): Boolean = on(a) && a.inFront && !a.isFinishing &&
        Openhouse.idle && !Openhouse.dark && !Openhouse.sleeping && !House.isNight() && !CameraLook.showing

    private fun check() {
        val a = MainActivity.live
        val want = a != null && runCatching { wanted(a) }.getOrDefault(false)
        if (want && analysis == null) watch(a!!) else if (!want && analysis != null) stop()
    }

    private fun stop() {
        val use = analysis ?: return
        analysis = null
        if (use === starting) return
        runCatching { provider?.unbind(use) } // only ours: CameraLook's own use of the camera is left alone
        use.clearAnalyzer()
        Log.i(TAG, "camera off")
    }

    /** Marks a start in progress (the camera provider comes back later), so [check] doesn't start a second. */
    private val starting = ImageAnalysis.Builder().build()

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun watch(a: MainActivity) {
        if (!CameraLook.granted(a)) { Log.w(TAG, "no camera permission"); return }
        analysis = starting
        val f = ProcessCameraProvider.getInstance(a)
        f.addListener({
            if (analysis !== starting) return@addListener // turned off meanwhile
            analysis = null
            val p = runCatching { f.get() }.getOrNull() ?: return@addListener
            provider = p
            val front = p.availableCameraInfos.firstOrNull { it.lensFacing == CameraSelector.LENS_FACING_FRONT } ?: return@addListener
            // The slowest frame rate the camera offers (often 5-15 a second): less power and heat than the usual 30.
            val slow = runCatching { Camera2CameraInfo.from(front).getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) }
                .getOrNull()?.minWithOrNull(compareBy<Range<Int>>({ it.upper }, { it.lower }))
            val b = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                    ResolutionStrategy(Size(320, 240), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
            if (slow != null) Camera2Interop.Extender(b).setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, slow)
            val use = b.build()
            use.setAnalyzer(work, Motion { main.post { if (analysis === use) wake() } })
            runCatching { p.bindToLifecycle(a, CameraSelector.DEFAULT_FRONT_CAMERA, use) }
                .onSuccess { analysis = use; Log.i(TAG, "camera watching${slow?.let { " at $it fps" } ?: ""}") }
                .onFailure { Log.w(TAG, "camera didn't start: $it"); use.clearAnalyzer() }
        }, androidx.core.content.ContextCompat.getMainExecutor(a))
    }

    private fun wake() {
        Log.i(TAG, "someone walked up")
        stop()
        Openhouse.touch() // as a touch: the home screen, at its usual brightness (the page's dim follows the night only)
    }

    /** Movement in the picture, from a few frames a second: each frame's grid of mean brightness against the last
     *  one's, after taking away the frame's overall change (a light switched on, the camera's exposure settling). */
    private class Motion(val moved: () -> Unit) : ImageAnalysis.Analyzer {
        private var last: FloatArray? = null
        private var lastAt = 0L
        private var frames = 0
        private var hits = 0
        override fun analyze(img: ImageProxy) {
            try {
                val now = System.currentTimeMillis()
                if (now - lastAt < LOOK_MS) return
                lastAt = now
                val grid = grid(img)
                val prev = last; last = grid
                if (prev == null || ++frames < 4) return // (the first looks, while the exposure settles)
                var mean = 0f
                for (i in grid.indices) mean += grid[i] - prev[i]
                mean /= grid.size
                var changed = 0
                for (i in grid.indices) if (kotlin.math.abs(grid[i] - prev[i] - mean) > 14f) changed++
                hits = if (changed >= grid.size * 6 / 100) hits + 1 else 0
                if (hits >= 2) { hits = 0; moved() }
            } catch (e: Exception) { Log.w(TAG, "frame: $e") } finally { img.close() }
        }

        /** The Y (brightness) plane, as a coarse grid of means, sampling every fourth pixel each way. */
        private fun grid(img: ImageProxy): FloatArray {
            val plane = img.planes[0]
            val buf = plane.buffer
            val rs = plane.rowStride; val ps = plane.pixelStride
            val w = img.width; val h = img.height
            val sum = FloatArray(GRID_W * GRID_H); val n = IntArray(GRID_W * GRID_H)
            var y = 0
            while (y < h) {
                val gy = y * GRID_H / h
                var x = 0
                while (x < w) {
                    val i = gy * GRID_W + x * GRID_W / w
                    sum[i] += (buf.get(y * rs + x * ps).toInt() and 0xFF); n[i]++
                    x += 4
                }
                y += 4
            }
            for (i in sum.indices) if (n[i] > 0) sum[i] /= n[i]
            return sum
        }
    }
}
