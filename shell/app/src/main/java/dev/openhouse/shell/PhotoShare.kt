package dev.openhouse.shell

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import android.widget.ImageView
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

/**
 * "Share to Opie": the household's lasting photo page. One link (a QR code in the Photos app's Add photos,
 * Phones) that the household's phones keep: photos sent from it land in Photos, any time, not only while a card is
 * open on the tablet. Off until someone turns it on; "New link" cuts off every phone that has the old one.
 *
 *   On the home Wi-Fi: http://<tablet>:<port>/#<key>, served here ([Handoff] with a lasting key and port; assets/share.html).
 *   With reaching the tablet from away on (Cloud): https://<service>/p/#<key>.<relay>.<token>, the same page from the
 *   cloud, through the relay (which only passes sealed bytes on). That one can be installed, and on Android it's in
 *   the share sheet (Web Share Target): Photos, Share, Opie. docs/photos.md.
 *
 * The key and the relay token are kept sealed with a Keystore key (no-backup folder), never in the household.
 */
object PhotoShare {
    private const val TAG = "PhotoShare"
    private const val ALIAS = "photo-share"
    private val main = Handler(Looper.getMainLooper())
    private lateinit var ctx: Context
    @Volatile private var h: Handoff? = null
    @Volatile private var relay: JSONObject? = null
    @Volatile private var stopped = false
    private var lastIp: String? = null

    private class State(val key: ByteArray, val token: String, val port: Int)

    fun start(c: Context) {
        ctx = c.applicationContext
        if (stopped || Move.handedOver(c)) return
        main.removeCallbacksAndMessages(null)
        main.postDelayed(::tick, 30_000)
    }
    fun stop() { stopped = true; main.removeCallbacksAndMessages(null); h?.stop(); h = null }

    /** Every 5 minutes: running while it's on, at the tablet's current address; the relay told again every few hours. */
    private var relayAt = 0L
    private fun tick() {
        if (stopped) return
        thread(name = "photo-share") {
            runCatching {
                val st = state()
                val ip = Handoff.lanAddress(ctx)?.hostAddress
                if (st == null) { h?.stop(); h = null; relay = null }
                else {
                    if (h == null || ip != lastIp || h?.running != true) { h?.stop(); h = run(st); lastIp = ip; relayAt = 0 }
                    if (h != null && System.currentTimeMillis() - relayAt > 6 * 3600_000L) { register(st); relayAt = System.currentTimeMillis() }
                }
            }.onFailure { Log.w(TAG, "tick: ${it.javaClass.simpleName}") }
            main.postDelayed(::tick, 5 * 60_000L)
        }
    }

    private fun run(st: State): Handoff? {
        val info = JSONObject().put("title", "Photos for Opie")
        val x = Handoff(ctx, info, minutes = 0, page = "share.html", maxBytes = 4_000_000, once = false, fixedKey = st.key, port = st.port,
            onData = { bytes -> if (!dev.openhouse.ui.House.addPhoto(bytes, "phone.jpg")) throw IllegalStateException("the bridge didn't take it") })
        return if (runCatching { x.start() }.getOrDefault(false)) x else null
    }

    /** The relay (when reaching from away is on): this page may be reached through it, with its own lasting token. */
    private fun register(st: State) {
        val base = h?.url?.substringBefore("/#") ?: return
        val r = dev.openhouse.ui.BridgeClient.post(bridgeUrl() + "/relay/handoff", JSONObject().put("base", base).put("minutes", 24 * 60).put("token", st.token).put("page", "p").toString(), 3000, 10000)
            ?.let { runCatching { JSONObject(it) }.getOrNull() }?.takeIf { it.has("token") && it.has("url") }
        relay = r
        h?.relayOrigin = r?.let { Regex("^(wss?://[^/]+)").find(it.optString("url"))?.value }
    }
    private fun bridgeUrl(): String = runCatching { dev.openhouse.ui.Openhouse.bridgeUrl }.getOrDefault("http://127.0.0.1:8787")

    /** The link for the QR code: the cloud's (works anywhere, installable) when there is one, else the Wi-Fi's. */
    fun link(): String? {
        val lan = h?.url ?: return null
        val r = relay ?: return lan
        val page = r.optString("page").takeIf { it.startsWith("https://") || it.startsWith("http://localhost") || it.startsWith("http://10.0.2.2") } ?: return lan
        return "${page.trimEnd('/')}/#${lan.substringAfter("#")}.${r.optString("relay")}.${r.optString("token")}"
    }

    // --- storage ------------------------------------------------------------------------------------
    private val file get() = File(ctx.noBackupFilesDir, "photo-share")
    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun sealKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }

    @Synchronized private fun state(): State? = runCatching {
        val b = file.readBytes()
        val plain = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, sealKey(), GCMParameterSpec(128, b, 0, 12)) }.doFinal(b, 12, b.size - 12)
        val j = JSONObject(String(plain))
        State(Base64.decode(j.getString("key"), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), j.getString("token"), j.optInt("port"))
    }.getOrNull()

    /** The old link's token off the relay's list at once (not when its day runs out). */
    private fun endRelay() { state()?.let { st -> dev.openhouse.ui.BridgeClient.post(bridgeUrl() + "/relay/handoff/end", JSONObject().put("token", st.token).toString(), 3000, 10000) } }

    /** A new link (turning it on, or cutting off the phones that have the old one). */
    @Synchronized private fun fresh() {
        endRelay()
        val r = SecureRandom()
        val key = ByteArray(32).also { r.nextBytes(it) }; val tok = ByteArray(18).also { r.nextBytes(it) }
        val plain = JSONObject().put("key", b64(key)).put("token", b64(tok)).put("port", 20000 + r.nextInt(30000)).toString().toByteArray()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, sealKey()) }
        val tmp = File(file.path + ".new"); tmp.writeBytes(c.iv + c.doFinal(plain)); tmp.renameTo(file)
    }
    @Synchronized private fun off() { endRelay(); file.delete() }

    private fun restartNow(then: () -> Unit) = thread {
        h?.stop(); h = null; relay = null
        state()?.let { st -> h = run(st); lastIp = Handoff.lanAddress(ctx)?.hostAddress; register(st); relayAt = System.currentTimeMillis() }
        main.post(then)
    }

    // --- Settings ----------------------------------------------------------------------------
    /** Behind the PIN: the link's QR code, or turning it on. */
    fun show(a: Activity, immersive: () -> Unit) {
        init(a)
        thread {
            val on = state() != null
            main.post {
                if (!on) {
                    CalmDialog(a).setTitle("Let phones send photos here?")
                        .setMessage("Anyone with the link can send photos, so give it only to the household.")
                        .setMore("Photos sent from the link go straight into Photos. It works on the home Wi-Fi, or anywhere with Use it away from home on (Account); then on Android it's in the share sheet too.")
                        .setPositiveButton("Turn on") { _, _ -> thread { fresh(); restartNow { show(a, immersive) } } }
                        .setNegativeButton("Not now", null).show().also { immersive() }
                    return@post
                }
                val url = link()
                if (url == null) { CalmDialog(a).setTitle("Connect the device to Wi-Fi first.").setPositiveButton("Close", null).show().also { immersive() }; return@post }
                val anywhere = !url.startsWith("http://") || url.startsWith("http://localhost") || url.startsWith("http://10.0.2.2")
                val qr = ImageView(a).apply { setImageBitmap(Handoff.qr(url, 520)) }
                val line = if (anywhere) "Scan with each phone, then add the page to its home screen."
                    else "Scan with each phone on the home Wi-Fi, then add the page to its home screen."
                // Done is the one button; a new link and turning it off are rare, so quiet links under the code (docs/ux.md).
                var d: android.app.Dialog? = null
                val view = Calm.column(a).apply {
                    gravity = android.view.Gravity.CENTER_HORIZONTAL
                    addView(Calm.qr(a, qr, Calm.caption(a, line), 360) { Handoff.share(a, url) })
                    addView(Calm.row(a, 8).apply {
                        addView(Calm.quiet(a, "New link") {
                            d?.dismiss()
                            CalmDialog(a).setTitle("Make a new link?").setMessage("Phones with the old one stop working until they scan the new one.")
                                .setPositiveButton("New link") { _, _ -> thread { fresh(); restartNow { show(a, immersive) } } }.setNegativeButton("Cancel", null).show().also { immersive() }
                        })
                        addView(Calm.quiet(a, "Turn off") { d?.dismiss(); thread { off(); restartNow {} } })
                    })
                }
                d = CalmDialog(a).setTitle("Photos from phones").setView(view)
                    .setPositiveButton("Done", null)
                    .show().also { immersive() }
            }
        }
    }
    /** Turned on after the same yes as [show], with no code to scan: the setup hands the link to the phone or
     *  computer it was carried on from (ui/Setup.kt). Already on: nothing to ask. */
    fun turnOn(a: Activity, immersive: () -> Unit) {
        init(a)
        thread {
            if (state() != null) return@thread
            main.post {
                CalmDialog(a).setTitle("Let phones send photos here?")
                    .setMessage("Anyone with the link can send photos, so give it only to the household.")
                    .setPositiveButton("Turn on") { _, _ -> thread { fresh(); restartNow {} } }
                    .setNegativeButton("Not now", null).show().also { immersive() }
            }
        }
    }
    private fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }
}
