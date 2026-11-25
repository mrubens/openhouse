package dev.openhouse.shell

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** One file of a voice set: where it goes under files/display/voice/, and what it must be. */
data class VoiceFile(val path: String, val url: String, val sha256: String, val size: Long)

/** A voice set as its manifest (voice.json) describes it: the listening models and the library that runs them. */
data class VoiceSet(val version: String, val files: List<VoiceFile>) {
    val total get() = files.sumOf { it.size }
}

/**
 * The wake model, downloaded by the display itself (a release build can't be given it over adb: no run-as).
 * The same files scripts/voice-install.sh puts there: models/wake/ (openWakeWord's front end and our opie.onnx) and
 * onnxruntime-node for the runtime's Node. There are no other speech models. They come from the releases CDN
 * (releases/voice/<version>/voice.json and the files beside it, scripts/voice-bundle.sh), each checked by SHA-256.
 *
 * In the background, once the runtime is set up and listening is on: first run never waits for it. Only on an
 * unmetered network. Files land in voice/.download/ and resume after a restart; the set goes in
 * place only when every file is there and checked, then the bridge loads it (POST /voice/reload). voice/download.json
 * says how it's going (/voice/status).
 * docs/voice-models.md.
 */
object VoiceModels {
    private const val TAG = "VoiceModels"
    private val busy = AtomicBoolean(false)
    @Volatile private var nextTry = 0L
    @Volatile private var failures = 0

    /** The set this display wants: the build's own, or one given over adb (`--es voice_url`) or by the QR code. */
    fun url(ctx: Context): String = ctx.getSharedPreferences("shell", Context.MODE_PRIVATE).getString("voice_url", null)?.takeIf { it.isNotEmpty() } ?: BuildConfig.VOICE_URL

    private fun dir() = File(Runtime.display, "voice")

    /** Installed: the wake model and its runtime are there (from this download, or voice-install.sh). Older sets' models
     *  (Parakeet, sherpa-onnx...) don't count: the bridge removes them. */
    fun installed() = File(dir(), "node_modules/onnxruntime-node").exists() && File(dir(), "models/wake/opie.onnx").exists()

    /** Get the wanted set if it isn't in place. Returns at once; one download at a time; after a failure, later. */
    fun ensure(ctx: Context, bridge: String, now: Boolean = false) {
        val url = url(ctx)
        if (url.isEmpty() || !Runtime.ready()) return
        val marker = File(dir(), ".installed")
        // (The marker alone isn't enough: a restored backup or a half-cleared folder can have it without the files.)
        if (marker.exists() && marker.readText().lineSequence().firstOrNull() == url && installed()) return
        if (!marker.exists() && installed()) { marker.writeText("$url\n(installed over adb)\n"); return } // voice-install.sh's: keep it
        if (!now && System.currentTimeMillis() < nextTry) return
        if (!busy.compareAndSet(false, true)) return
        thread(name = "voice-models", isDaemon = true) {
            try {
                if (metered(ctx)) { status("waiting", error = "waiting for Wi-Fi"); nextTry = System.currentTimeMillis() + 5 * 60_000L; return@thread }
                install(url, bridge)
                failures = 0
            } catch (e: Exception) {
                Log.w(TAG, "voice models: $e")
                status("failed", error = e.message ?: e.toString())
                failures++
                nextTry = System.currentTimeMillis() + minOf(6 * 3600_000L, 10 * 60_000L shl minOf(failures - 1, 5)) // 10 min, 20, 40… up to 6 h
            } finally { busy.set(false) }
        }
    }

    private fun metered(ctx: Context) = runCatching { ctx.getSystemService(android.net.ConnectivityManager::class.java).isActiveNetworkMetered }.getOrDefault(false)

    private fun install(url: String, bridge: String) {
        // The manifest is checked against the SHA-256 this build carries (Pinned); each file then against the manifest.
        val manifest = fetchBytes(url)
        Pinned.check("voice set", Pinned.voice, Pinned.sha256(manifest))
        val set = parse(String(manifest, Charsets.UTF_8), url)
        val voice = dir().apply { mkdirs() }
        val stage = File(voice, ".download").apply { mkdirs() }
        // What's already down (an earlier try) counts; the rest must fit, with room to spare.
        val have = set.files.sumOf { f -> File(stage, f.path).takeIf { it.length() == f.size }?.length() ?: 0L }
        val need = set.total - have + 300_000_000L
        if (voice.usableSpace < need) error("not enough space for the voice models (${need / 1_000_000} MB needed, ${voice.usableSpace / 1_000_000} MB free)")
        Log.i(TAG, "getting voice set ${set.version}: ${set.files.size} files, ${set.total / 1_000_000} MB (${have / 1_000_000} MB already here)")
        var got = have
        var lastStatus = 0L
        fun progress(force: Boolean = false) {
            if (force || System.currentTimeMillis() - lastStatus > 2000) { lastStatus = System.currentTimeMillis(); status("downloading", set.version, got, set.total) }
        }
        progress(true)
        for (f in set.files) {
            val out = File(stage, f.path)
            if (out.length() == f.size) continue // put there only after its checksum matched
            download(f, out) { n -> got += n; progress() }
        }
        status("installing", set.version, set.total, set.total)
        // In place: the library, then the models (the bridge looks for both).
        for (top in listOf("node_modules", "models")) {
            val new = File(stage, top); val cur = File(voice, top); val old = File(voice, ".old-$top")
            if (!new.exists()) continue
            old.deleteRecursively()
            if (cur.exists() && !cur.renameTo(old)) error("couldn't move $cur aside")
            if (!new.renameTo(cur)) error("couldn't put $top in place")
            old.deleteRecursively()
        }
        stage.deleteRecursively()
        File(voice, ".installed").writeText("$url\n${set.version}\n")
        File(voice, "download.json").delete()
        Log.i(TAG, "voice set ${set.version} in place")
        runCatching { dev.openhouse.ui.BridgeClient.post("$bridge/voice/reload") }
    }

    private fun status(state: String, version: String? = null, got: Long? = null, total: Long? = null, error: String? = null) = runCatching {
        val j = JSONObject().put("state", state)
        version?.let { j.put("version", it) }; got?.let { j.put("got", it) }; total?.let { j.put("total", it) }; error?.let { j.put("error", it.take(200)) }
        val f = File(dir().apply { mkdirs() }, "download.json")
        File(f.path + ".tmp").apply { writeText(j.toString()) }.renameTo(f)
    }

    /** For Settings: "Getting the voice models: 40%", or null when there's nothing to say. */
    fun describe(): String? = runCatching {
        val j = JSONObject(File(dir(), "download.json").readText())
        when (j.optString("state")) {
            "downloading" -> "Getting the voice models: ${if (j.optLong("total") > 0) j.optLong("got") * 100 / j.optLong("total") else 0}%."
            "installing" -> "Putting the voice models in place."
            "waiting" -> "The voice models download on Wi-Fi."
            "failed" -> "Couldn't get the voice models (${j.optString("error")}). It tries again later."
            else -> null
        }
    }.getOrNull()

    private fun fetchBytes(url: String): ByteArray {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 30000
        try {
            if (c.responseCode != 200) error("${c.responseCode} from $url")
            if (c.contentLengthLong > 5_000_000L) error("too big for a voice manifest")
            return c.inputStream.use { it.readBytes() }
        } finally { c.disconnect() }
    }

    /** One file, carrying on from a partial one; checked against its SHA-256 before it's kept. */
    private fun download(f: VoiceFile, out: File, onBytes: (Long) -> Unit) {
        out.parentFile?.mkdirs()
        val part = File(out.path + ".part")
        if (part.length() > f.size) part.delete()
        var from = part.length()
        if (from > 0) onBytes(from)
        if (from < f.size || f.size == 0L) {
            val c = URL(f.url).openConnection() as HttpURLConnection
            c.connectTimeout = 15000; c.readTimeout = 60000
            if (from > 0) c.setRequestProperty("Range", "bytes=$from-")
            try {
                val code = c.responseCode
                if (code == 200 && from > 0) { onBytes(-from); from = 0; part.delete() } // the server sent it all again
                else if (code != 200 && code != 206) error("$code for ${f.path}")
                c.inputStream.use { inp -> java.io.FileOutputStream(part, from > 0).use { o ->
                    val buf = ByteArray(1 shl 16)
                    while (true) { val n = inp.read(buf); if (n < 0) break; o.write(buf, 0, n); onBytes(n.toLong()) }
                } }
            } finally { c.disconnect() }
        }
        if (part.length() != f.size) error("${f.path}: ${part.length()} bytes, expected ${f.size}")
        val sha = Pinned.sha256(part)
        if (sha != f.sha256) { onBytes(-f.size); part.delete(); error("${f.path}: checksum didn't match") }
        if (!part.renameTo(out)) error("couldn't keep ${f.path}")
    }

    private val safePath = Regex("^(models|node_modules)(/[A-Za-z0-9._@+-]+)+$")

    /** Read voice.json. File URLs are relative to it (a plain folder on a static host works); https only, as for releases. */
    fun parse(text: String, manifestUrl: String): VoiceSet {
        val j = JSONObject(text)
        require(j.optInt("schema", 1) == 1) { "unknown voice manifest schema ${j.opt("schema")}" }
        require(Releases.allowedUrl(manifestUrl, manifestUrl)) { "not an https URL: $manifestUrl" }
        val version = j.getString("version")
        val a = j.getJSONArray("files")
        val files = (0 until a.length()).map { i ->
            val o = a.getJSONObject(i)
            val path = o.getString("path")
            require(safePath.matches(path) && path.split('/').none { it == "." || it == ".." }) { "not a voice file's path: $path" }
            val sha = o.getString("sha256").lowercase()
            require(Regex("^[0-9a-f]{64}$").matches(sha)) { "$path: sha256 isn't a SHA-256" }
            val size = o.getLong("size")
            require(size >= 0) { "$path: size" }
            val url = URI(manifestUrl).resolve(o.optString("url", path)).toString()
            require(Releases.allowedUrl(url, manifestUrl)) { "$path: not an https URL: $url" }
            VoiceFile(path, url, sha, size)
        }
        require(files.isNotEmpty()) { "no files" }
        require(files.map { it.path }.toSet().size == files.size) { "a file is listed twice" }
        require(files.any { it.path.startsWith("node_modules/onnxruntime-node/") } && files.any { it.path.startsWith("models/wake/") }) { "the set needs onnxruntime-node and models/wake" }
        require(files.sumOf { it.size } < 3_000_000_000L) { "too big for a voice set" }
        return VoiceSet(version, files)
    }
}
