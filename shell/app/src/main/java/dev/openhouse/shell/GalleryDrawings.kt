package dev.openhouse.shell

// The drawings the old native Drawing app saved to the tablet's gallery (Pictures/Drawings/Drawing-*.png), copied
// into the family's Photos once, so the web Drawing app (and the photos on the door) can show them and open them
// again. Copied, never moved or deleted: the gallery keeps its own. The shell (device owner) grants itself read access
// to the gallery for this. The grant stays (taking it back would stop the display's process), set back to the
// default state so it isn't locked on.

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import kotlin.concurrent.thread

internal object GalleryDrawings {
    private const val TAG = "GalleryDrawings"
    private val READ = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE

    private val running = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Once per tablet (until every drawing is copied): waits for the bridge, then copies what isn't there yet. */
    fun copyOnce(ctx: Context, bridge: () -> String) { if (running.compareAndSet(false, true)) thread(name = "gallery-drawings", isDaemon = true) { try { copy(ctx, bridge) } finally { running.set(false) } } }

    private fun copy(ctx: Context, bridge: () -> String) {
        val prefs = ctx.getSharedPreferences("shell", Context.MODE_PRIVATE)
        if (prefs.getBoolean("drawings_copied", false)) return
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        if (!dpm.isDeviceOwnerApp(ctx.packageName)) return
        while (runCatching { dev.openhouse.ui.BridgeClient.getText("${bridge()}/state", 2000, 4000) }.isFailure) Thread.sleep(10_000)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        val done = (prefs.getStringSet("drawings_copied_names", emptySet()) ?: emptySet()).toMutableSet()
        // Already in the family's photos (the bridge keeps the name after its own "<time>-"): not copied again.
        runCatching { org.json.JSONObject(dev.openhouse.ui.BridgeClient.getText("${bridge()}/house", 3000, 10000)).optJSONArray("photos") }.getOrNull()?.let { a ->
            for (i in 0 until a.length()) Regex("Drawing-\\d+\\.png$").find(a.optString(i))?.let { done += it.value }
        }
        var failed = 0
        try {
            dpm.setPermissionGrantState(admin, ctx.packageName, READ, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
            val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            ctx.contentResolver.query(uri, arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME),
                "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ? AND ${MediaStore.Images.Media.DISPLAY_NAME} LIKE ?",
                arrayOf("Pictures/Drawings%", "Drawing-%.png"), "${MediaStore.Images.Media.DATE_ADDED} ASC")?.use { c ->
                while (c.moveToNext()) {
                    val name = c.getString(1)
                    if (name in done || !Regex("Drawing-\\d+\\.png").matches(name)) continue
                    val bytes = runCatching { ctx.contentResolver.openInputStream(ContentUris.withAppendedId(uri, c.getLong(0)))?.use { it.readBytes() } }.getOrNull()
                    if (bytes != null && bytes.size in 1..25_000_000 && post(bridge(), name, bytes)) { done += name; prefs.edit().putStringSet("drawings_copied_names", done.toSet()).apply() } else failed++
                }
            }
        } catch (e: Throwable) { Log.w(TAG, "copying the gallery's drawings: $e"); failed++ }
        // Back to the default state, not denied: taking a granted permission away makes Android stop the display's
        // process (and with it the runtime), so the read access stays granted, no longer locked on.
        finally { runCatching { dpm.setPermissionGrantState(admin, ctx.packageName, READ, DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT) } }
        prefs.edit().putStringSet("drawings_copied_names", done).putBoolean("drawings_copied", failed == 0).apply()
        Log.i(TAG, "${done.size} drawings in the family's photos" + if (failed > 0) ", $failed not yet (next start)" else "")
    }

    private fun post(bridge: String, name: String, bytes: ByteArray): Boolean = runCatching {
        dev.openhouse.ui.BridgeClient.open("$bridge/house/photo?name=" + java.net.URLEncoder.encode(name, "UTF-8")).run {
            requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 30000
            setRequestProperty("content-type", "application/octet-stream"); setFixedLengthStreamingMode(bytes.size)
            outputStream.use { it.write(bytes) }; responseCode in 200..299
        }
    }.getOrDefault(false)
}
