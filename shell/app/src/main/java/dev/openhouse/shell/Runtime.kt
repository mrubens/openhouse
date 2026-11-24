package dev.openhouse.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * The display's own Linux runtime (replaces Termux). The shell ships proot as a native library
 * (jniLibs, so it may be executed) and unpacks a small Ubuntu image (runtime/Dockerfile) into its
 * private files. Vite and the bridge run inside it as this app's user.
 *
 *   files/rootfs/     the image
 *   files/display/    bridge, start.sh (copied from the APK on each update), webapp/
 */
object Runtime {
    private const val TAG = "Runtime"
    private lateinit var ctx: Context
    val root get() = File(ctx.filesDir, "rootfs")
    val display get() = File(ctx.filesDir, "display")
    private val lib get() = ctx.applicationInfo.nativeLibraryDir
    private val tmp get() = File(ctx.cacheDir, "proot").apply { mkdirs() }

    fun init(c: Context) { ctx = c.applicationContext }

    fun ready() = File(root, ".ready").exists()
    // The link points at /root/... inside the runtime, so look for the installed version instead.

    /** A process inside the runtime. The display folder and device config keep their real paths. */
    fun command(args: List<String>, cwd: String = "/root", env: Map<String, String> = emptyMap()): ProcessBuilder {
        val device = File(ctx.filesDir, "device-mcp.json")
        val token = BridgeToken.get(ctx)
        val tokenFile = BridgeToken.file(ctx)
        val argv = mutableListOf("$lib/libproot.so", "--link2symlink", "-0", "-r", root.path,
            "-b", "/dev", "-b", "/proc", "-b", "/sys", "-b", "${tmp.path}:/dev/shm",
            "-b", "${display.path}:${display.path}")
        if (device.exists()) argv += listOf("-b", "${device.path}:${device.path}")
        // TZ: the runtime has no zone of its own; the assistant must know the family's local time.
        argv += listOf("-w", cwd, "/usr/bin/env", "-i", "HOME=/root", "LANG=C.UTF-8", "TERM=dumb", "TMPDIR=/tmp",
            "TZ=" + java.util.TimeZone.getDefault().id,
            "OPENHOUSE_TOKEN=$token", "OPENHOUSE_TOKEN_FILE=${tokenFile.path}", // the bridge's secret (BridgeToken)
            "PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
        argv += env.map { (k, v) -> "$k=$v" }
        argv += args
        return ProcessBuilder(argv).redirectErrorStream(true).apply {
            environment().apply {
                put("PROOT_LOADER", "$lib/libproot-loader.so")
                put("PROOT_TMP_DIR", tmp.path)
                put("LD_LIBRARY_PATH", lib)
            }
        }
    }

    /** Run to completion, streaming each output line to [onLine]. Returns the exit code. */
    fun run(args: List<String>, cwd: String = "/root", onLine: (String) -> Unit = {}): Int {
        val p = command(args, cwd).start()
        p.outputStream.close()
        p.inputStream.bufferedReader().forEachLine { Log.d(TAG, it); onLine(it) }
        return p.waitFor()
    }

    // --- first-time setup ----------------------------------------------------
    /**
     * Download and unpack the image.
     * [progress] gets 0 to 100 for the setup screen's bar; [failed], what went wrong. Safe to re-run after a failure.
     */
    // One setup at a time: the display can be recreated mid-setup (a setting sent to it, an update), and two at once
    // left an empty rootfs marked unpacked (one deleted the folder the other had just marked), which never recovered.
    private val setupLock = Any()
    fun setup(imageUrl: String, progress: (Int) -> Unit, failed: (String) -> Unit): Boolean = synchronized(setupLock) { setupOnce(imageUrl, progress, failed) }

    // The family sees one step ("Getting OpenHouse ready") and one bar: the download is most of it (to 85%), then
    // unpacking. (Until 1.0.9 Claude Code was installed after, for the agent's app: no more.)
    private fun setupOnce(imageUrl: String, progress: (Int) -> Unit, failed: (String) -> Unit): Boolean = runCatching {
        // Marked unpacked but not there (that race, or a folder cleared by hand): unpack again.
        if (File(root, ".unpacked").exists() && !File(root, "usr/bin/env").exists()) File(root, ".unpacked").delete()
        if (!File(root, ".unpacked").exists()) {
            val tgz = File(ctx.cacheDir, "runtime.tar.gz")
            progress(0)
            download(imageUrl, tgz) { pct -> progress(pct * 85 / 100) }
            progress(86)
            val stage = File(ctx.filesDir, "rootfs.new").apply { deleteRecursively(); mkdirs() }
            val p = ProcessBuilder("/system/bin/tar", "xzf", tgz.path, "-C", stage.path).redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().readText()
            if (p.waitFor() != 0 && !File(stage, "usr/bin/env").exists()) error("unpack failed: ${out.takeLast(300)}")
            root.deleteRecursively()
            if (!stage.renameTo(root)) error("couldn't put the unpacked software in place")
            File(root, "etc/resolv.conf").apply { delete(); writeText("nameserver 8.8.8.8\nnameserver 1.1.1.1\n") }
            File(root, "etc/hosts").apply { delete(); writeText("127.0.0.1 localhost\n::1 localhost\n") }
            File(root, "tmp").apply { mkdirs(); setWritable(true, false) }
            File(root, ".unpacked").writeText("ok")
            tgz.delete()
        }
        File(root, ".ready").writeText("ok")
        progress(100)
        true
    }.getOrElse { Log.e(TAG, "setup failed", it); failed(it.message ?: it.toString()); false }

    private fun download(url: String, to: File, progress: (Int) -> Unit) {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 60000
        val total = c.contentLengthLong
        var got = 0L; var last = -1
        c.inputStream.use { inp -> to.outputStream().use { out ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = inp.read(buf); if (n < 0) break
                out.write(buf, 0, n); got += n
                if (total > 0) { val pct = (got * 100 / total).toInt(); if (pct != last) { last = pct; progress(pct) } }
            }
        } }
        if (total > 0 && got != total) error("download incomplete ($got of $total)")
    }

    // --- services --------------------------------------------------------------
    /** Copy the bridge and start script out of the APK when the APK changed. */
    private fun installAssets() {
        val stamp = File(display, ".assets")
        val version = ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime.toString()
        if (stamp.exists() && stamp.readText() == version) return
        fun copy(asset: String) {
            val kids = ctx.assets.list(asset) ?: emptyArray()
            if (kids.isEmpty()) {
                val out = File(display, asset.removePrefix("runtime/"))
                out.parentFile?.mkdirs()
                ctx.assets.open(asset).use { i -> out.outputStream().use { i.copyTo(it) } }
                if (out.name.endsWith(".sh")) out.setExecutable(true)
            } else kids.forEach { copy("$asset/$it") }
        }
        display.mkdirs()
        copy("runtime")
        stamp.writeText(version)
        Log.i(TAG, "installed bridge from the APK")
    }

    private var lastStart = 0L

    /** Start whatever isn't running (start.sh is idempotent). Returns at once. */
    fun startServices(now: Boolean = false) {
        if (!ready() || (!now && System.currentTimeMillis() - lastStart < 20000)) return
        lastStart = System.currentTimeMillis()
        thread(name = "runtime-start") {
            runCatching {
                installAssets()
                // proot stays alive as long as the servers it started do; we don't wait for it.
                command(listOf("/bin/bash", "${display.path}/start.sh"), display.path).start().also { p ->
                    p.outputStream.close()
                    thread(isDaemon = true) { p.inputStream.bufferedReader().forEachLine { Log.d(TAG, it) } }
                }
                Log.i(TAG, "starting services")
            }.onFailure { Log.w(TAG, "start failed: $it") }
        }
    }

    // --- recovery (Settings) and supervision ------------------------------------------------

    /** Processes of this app other than the shell itself: the runtime (proot, Node, the agent). */
    private fun ours(match: (String) -> Boolean = { true }): List<Int> {
        val me = android.os.Process.myPid(); val uid = android.os.Process.myUid()
        return File("/proc").listFiles { f -> f.name.all(Char::isDigit) }.orEmpty().mapNotNull { d ->
            val pid = d.name.toInt()
            if (pid == me) return@mapNotNull null
            val owner = runCatching { File(d, "status").readLines().first { it.startsWith("Uid:") }.split(Regex("\\s+"))[1].toInt() }.getOrNull()
            if (owner != uid) return@mapNotNull null
            val cmd = runCatching { File(d, "cmdline").readText().replace('\u0000', ' ') }.getOrDefault("")
            pid.takeIf { cmd.isNotBlank() && match(cmd) }
        }
    }

    private fun kill(pids: List<Int>) { pids.forEach { android.os.Process.killProcess(it) }; if (pids.isNotEmpty()) Log.i(TAG, "stopped ${pids.size} runtime processes") }

    /** Stop everything in the runtime (a running agent too). */
    fun stopAll() = kill(ours())

    /** Settings: stop everything and start it again. */
    fun restart() = thread(name = "runtime-restart") { stopAll(); Thread.sleep(800); startServices(now = true) }

    /**
     * Settings: put the fixed software back as the APK has it (the bridge, start script and
     * starting board), keeping the family's things: household, chats, the home screen, voices, devices and apps. Then start
     * again.
     */
    fun reset() = thread(name = "runtime-reset") {
        stopAll(); Thread.sleep(800)
        for (f in listOf("bridge", "buildserver", "home", "build", "start.sh", "webapp.tgz", ".assets", ".start.lock")) File(display, f).deleteRecursively()
        display.listFiles { f -> f.name.endsWith(".log") || f.name.endsWith(".log.1") }?.forEach { it.delete() }
        Log.i(TAG, "runtime reset to the APK's software")
        startServices(now = true)
    }

    /** Safe mode: the bridge runs no agent while files/display/safe-mode exists (agents/off.js). */
    fun setSafeMode(on: Boolean) { val f = File(display, "safe-mode"); if (on) { display.mkdirs(); f.writeText("on") } else f.delete() }

    private val strikes = HashMap<Int, Int>()
    private val services = mapOf(8787 to "/state", 5173 to "/")
    private val processOf = mapOf<Int, (String) -> Boolean>(
        8787 to { c -> c.contains("node server.js") || c.contains("voice-worker") },
        5173 to { c -> c.contains("vite") })

    /**
     * Every few seconds (the shell's watchdog): each server separately. One that's gone is started again; one
     * that takes connections but stops answering (hung) for half a minute is stopped and started. Logs are
     * kept short.
     */
    fun supervise() {
        if (!ready()) return
        var start = false
        for ((port, path) in services) {
            val r = runCatching { (URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection).run {
                connectTimeout = 2000; readTimeout = 4000; responseCode } }
            val e = r.exceptionOrNull()
            when {
                e == null -> strikes.remove(port)
                e is java.net.ConnectException -> { strikes.remove(port); start = true } // not running
                else -> { // listening, not answering
                    val n = (strikes[port] ?: 0) + 1; strikes[port] = n
                    if (n >= 6) { Log.w(TAG, "the server on $port is stuck: restarting it"); kill(ours(processOf.getValue(port))); strikes.remove(port); start = true }
                }
            }
        }
        if (start) startServices()
        rotateLogs()
    }

    /** start.log, bridge.log, vite.log... grew forever. Past 2 MB, keep the last 512 KB as name.1 and start over (writers append). */
    private fun rotateLogs() = runCatching {
        val logs: List<File> = display.listFiles { f: File -> f.name.endsWith(".log") }.orEmpty().toList() + listOf(File(display, "bridge/runs.jsonl"), File(display, "bridge/chats.jsonl"))
        for (f in logs) if (f.length() > 2_000_000) {
            java.io.RandomAccessFile(f, "rw").use { raf: java.io.RandomAccessFile ->
                val keep = 512 * 1024L; val buf = ByteArray(keep.toInt())
                raf.seek(raf.length() - keep); raf.readFully(buf)
                File(f.path + ".1").writeBytes(buf)
                raf.setLength(0)
            }
            Log.i(TAG, "rotated ${f.name}")
        }
    }
}
