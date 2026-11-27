package dev.openhouse.shell

// More than one tablet in a household (docs/multi-tablet.md). On the main tablet, Linked devices → Add → Another Opie
// tablet shows a code (Screens.tablet). On the new one, during the welcome or later in Settings → Advanced, this:
// scan that code with the camera, or type it, and say which room this tablet is in. The bridge here joins (POST
// /satellite/join) and starts again as a satellite of the main tablet (bridge/satellite.js): the same household, its
// home screen, its apps and Opie, with nothing of the household kept on this tablet. Leaving (behind the PIN) makes this
// tablet its own again, with whatever it had before it joined.

import android.graphics.ImageFormat
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.concurrent.thread

internal object Satellite {
    private const val TAG = "Satellite"
    private val main = Handler(Looper.getMainLooper())

    /** What the bridge says (GET /satellite): {satellite, brain, name, reachable, removed}, read now and then. */
    @Volatile var state: JSONObject? = null
    val on: Boolean get() = state?.optBoolean("satellite") == true

    fun refresh(bridge: String): JSONObject? = runCatching { JSONObject(BridgeClient.getText("$bridge/satellite", 1500, 3000)) }.getOrNull()?.also { state = it }

    /** Add this tablet to an Opie the household already has: the code from the main tablet, scanned or typed. */
    fun join(a: MainActivity, done: () -> Unit = {}) {
        val code = Calm.field(a, "XXXX-XXXX-XXXX", 30f).apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val room = Calm.field(a, "Which room is it in? (Den)", 22f)
        val col = Calm.column(a, 14).apply {
            addView(Calm.caption(a, "On the tablet you already have, open Settings, Linked devices, Add, then Another Opie tablet. Scan the code it shows, or type it here."))
            addView(code); addView(room)
            addView(Calm.small(a, "This tablet then shows that household: its calendar, lists, chores, apps and Opie. What's on this tablet now is kept, put aside, and comes back if it leaves."))
        }
        CalmDialog(a).setTitle("Add this tablet to your Opie").setView(col).setNegativeButton("Cancel", null)
            .setNeutralButton("Scan the code") { _, _ -> scan(a) { text -> send(a, text, room.text.toString(), done) } }
            .setPositiveButton("Add") { _, _ -> send(a, code.text.toString(), room.text.toString(), done) }
            .show().also { a.immersive() }
    }

    /** The code (or the main tablet's whole link) to the bridge; the main tablet found on the Wi-Fi when only the code was typed. */
    private fun send(a: MainActivity, text: String, room: String, done: () -> Unit) = thread {
        val name = room.trim().ifEmpty { "Tablet" }.let { if (it.endsWith("tablet", ignoreCase = true)) it else "$it tablet" }
        val linked = text.contains("/tablet#")
        main.post { a.toast(if (linked) "Joining…" else "Looking for the main tablet…") }
        val base = if (linked) null else find(a)
        if (!linked && base == null) { main.post { say(a, "Couldn't find the main tablet", "Is it on and on this Wi-Fi? Keep its code showing, or scan the code instead.") }; return@thread }
        val b = JSONObject().put("code", text.trim()).put("name", name).apply { if (base != null) put("base", base) }
        val r = BridgeClient.postAnswer(a.bridge + "/satellite/join", b.toString())
        val j = runCatching { JSONObject(r?.second ?: "") }.getOrNull()
        if (r == null || r.first != 200) { main.post { say(a, "That didn't work", j?.optString("error")?.takeIf { it.isNotEmpty() } ?: "The assistant is starting. Try again in a moment.") }; return@thread }
        Log.i(TAG, "joined the household at ${j?.optString("brain")}")
        Runtime.restart() // the bridge and the apps' server start again, as a satellite
        main.post { a.toast("Added. This tablet shows your household in a moment."); done() }
        Thread.sleep(6000); refresh(a.bridge)
        main.post { dev.openhouse.ui.Openhouse.joinedHousehold(); dev.openhouse.ui.Openhouse.host.setting("reloadHomeFirst") }
    }

    /**
     * The main tablet on the Wi-Fi: it answers as "_openhouse._tcp" (Bonjour) while its code shows (Screens.tablet).
     * Its address, as http://<ip>:<port>, or null after a few seconds.
     */
    private fun find(a: MainActivity): String? {
        val nsd = a.getSystemService(android.net.nsd.NsdManager::class.java) ?: return null
        val wifi = a.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java)
        val lock = runCatching { wifi.createMulticastLock("openhouse-find").apply { setReferenceCounted(false); acquire() } }.getOrNull()
        val found = java.util.concurrent.LinkedBlockingQueue<String>()
        val own = Handoff.lanAddress(a)?.hostAddress
        val listener = object : android.net.nsd.NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) { Log.w(TAG, "discovery failed: $e") }
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceLost(i: android.net.nsd.NsdServiceInfo) {}
            @Suppress("DEPRECATION")
            override fun onServiceFound(i: android.net.nsd.NsdServiceInfo) {
                runCatching { nsd.resolveService(i, object : android.net.nsd.NsdManager.ResolveListener {
                    override fun onResolveFailed(x: android.net.nsd.NsdServiceInfo, e: Int) {}
                    override fun onServiceResolved(x: android.net.nsd.NsdServiceInfo) {
                        val ip = x.host?.hostAddress ?: return
                        if (ip != own && x.host is java.net.Inet4Address) found.offer("http://$ip:${x.port}")
                    }
                }) }
            }
        }
        return try {
            runCatching { nsd.discoverServices("_openhouse._tcp", android.net.nsd.NsdManager.PROTOCOL_DNS_SD, listener) }
            found.poll(10, java.util.concurrent.TimeUnit.SECONDS)
        } finally { runCatching { nsd.stopServiceDiscovery(listener) }; runCatching { lock?.release() } }
    }

    /** The main tablet's code through the camera (CameraX and ZXing): what it says, once read. */
    private fun scan(a: MainActivity, got: (String) -> Unit) {
        if (!CameraLook.granted(a)) { say(a, "The camera isn't allowed", "Type the code instead."); return }
        val preview = PreviewView(a).apply { scaleType = PreviewView.ScaleType.FILL_CENTER; implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
        val col = Calm.column(a, 12).apply {
            addView(preview, LinearLayout.LayoutParams(-1, Calm.px(a, 420)))
            addView(Calm.caption(a, "Hold this tablet's camera up to the code on the main tablet."))
        }
        var provider: ProcessCameraProvider? = null
        val work = Executors.newSingleThreadExecutor()
        var read = false
        val d = CalmDialog(a).setTitle("Scan the code").setView(col).setNegativeButton("Cancel", null)
            .setOnDismissListener { runCatching { provider?.unbindAll() }; work.shutdown() }.show().also { a.immersive() }
        val reader = com.google.zxing.MultiFormatReader().apply { setHints(mapOf(com.google.zxing.DecodeHintType.POSSIBLE_FORMATS to listOf(com.google.zxing.BarcodeFormat.QR_CODE))) }
        val f = ProcessCameraProvider.getInstance(a)
        f.addListener({
            val p = runCatching { f.get() }.getOrElse { d.dismiss(); say(a, "The camera didn't start", "Type the code instead."); return@addListener }
            provider = p
            val sel = if (runCatching { p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) }.getOrDefault(false)) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
            val pv = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
            val an = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            an.setAnalyzer(work) { img ->
                try {
                    if (read || img.format != ImageFormat.YUV_420_888) return@setAnalyzer
                    val y = img.planes[0]; val buf = y.buffer; val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
                    val src = com.google.zxing.PlanarYUVLuminanceSource(bytes, y.rowStride, img.height, 0, 0, img.width, img.height, false)
                    val text = runCatching { reader.decodeWithState(com.google.zxing.BinaryBitmap(com.google.zxing.common.HybridBinarizer(src))).text }.getOrNull()
                    reader.reset()
                    if (text != null && text.contains("/tablet#")) { read = true; main.post { d.dismiss(); got(text) } }
                } finally { img.close() }
            }
            runCatching { p.unbindAll(); p.bindToLifecycle(a, sel, pv, an) }.onFailure { d.dismiss(); say(a, "The camera didn't start", "Type the code instead.") }
        }, a.mainExecutor)
    }

    /** Settings on a satellite: which household it's part of, and leaving it (a person's own, behind the PIN). */
    fun menu(a: MainActivity, lock: SettingsLock) = thread {
        val s = refresh(a.bridge) ?: return@thread
        main.post {
            val where = s.optString("brain").removePrefix("http://").removePrefix("https://")
            val msg = (if (s.optBoolean("removed")) "The main tablet removed this one." else if (s.optBoolean("reachable", true)) "Part of the household on the main tablet ($where)." else "Can't reach the main tablet ($where) just now.") +
                " Its calendar, lists, chores, apps and Opie are the main tablet's; this tablet keeps none of them."
            CalmDialog(a).setTitle(s.optString("name").ifEmpty { "This tablet" }).setMessage(msg)
                .setNeutralButton("Leave the household") { _, _ -> if (!DeviceServer.personOnly("Leaving the household")) lock.withPinSet(back = {}) { leave(a) } }
                .setPositiveButton("Close", null).show().also { a.immersive() }
        }
    }

    private fun leave(a: MainActivity) {
        CalmDialog(a).setTitle("Leave the household?")
            .setMessage("This tablet stops showing the household. What it had before it joined comes back. To join again, show a new code on the main tablet.")
            .setPositiveButton("Leave") { _, _ ->
                thread {
                    val r = BridgeClient.postAnswer(a.bridge + "/satellite/leave", "{}")
                    if (r?.first != 200) { main.post { say(a, "That didn't work", "Try again in a moment.") }; return@thread }
                    Runtime.restart()
                    state = null
                    main.post { a.toast("This tablet is its own again") }
                    Thread.sleep(6000)
                    main.post { dev.openhouse.ui.Openhouse.host.setting("reloadHomeFirst") }
                }
            }.setNegativeButton("Cancel", null).show().also { a.immersive() }
    }

    private fun say(a: MainActivity, title: String, msg: String) {
        CalmDialog(a).setTitle(title).setMessage(msg).setPositiveButton("Close", null).show().also { a.immersive() }
    }
}
