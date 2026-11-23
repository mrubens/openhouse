package dev.openhouse.shell

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.util.Log
import java.io.File
import kotlin.concurrent.thread

/**
 * The update cover (the :host app, MainActivity.HOST_PKG): what the tablet shows while the display itself is being
 * replaced. The display carries it and installs it as the device's owner, without asking, when it's missing or not
 * the one carried: a tablet set up from the QR code gets it with no computer. install-display.sh and move-tablet.sh
 * still put it on over adb first, and then it's the same file and left be.
 */
object HostApp {
    private const val TAG = "HostApp"
    @Volatile private var done = false

    fun ensure(c: Context) {
        if (done) return
        done = true
        thread(name = "host-app") {
            runCatching {
                if (!c.getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(c.packageName)) return@thread
                val apk = File(c.codeCacheDir, "host.apk")
                c.assets.open("host.apk").use { i -> apk.outputStream().use { i.copyTo(it) } }
                val there = runCatching { File(c.packageManager.getApplicationInfo(MainActivity.HOST_PKG, 0).sourceDir) }.getOrNull()
                if (there != null && sha(there) == sha(apk)) { apk.delete(); return@thread }
                AppStore.init(c)
                val (ok, msg) = AppStore.install(listOf(apk), "the update cover")
                Log.i(TAG, if (ok) "installed the update cover" else "installing the update cover failed: $msg")
                apk.delete()
            }.onFailure { Log.w(TAG, "the update cover: $it") }
        }
    }

    private fun sha(f: File): String = java.security.MessageDigest.getInstance("SHA-256").let { md ->
        f.inputStream().use { i -> val b = ByteArray(1 shl 16); while (true) { val n = i.read(b); if (n < 0) break; md.update(b, 0, n) } }
        md.digest().joinToString("") { "%02x".format(it) }
    }
}
