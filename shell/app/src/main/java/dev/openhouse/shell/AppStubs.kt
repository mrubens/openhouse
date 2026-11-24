package dev.openhouse.shell

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import com.android.apksig.ApkSigner
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import javax.security.auth.x500.X500Principal

/**
 * Every app and game the family makes is also a real installed Android app: its own package
 * (dev.openhouse.app.<id>), launcher icon (its drawn icon, or its first letter), task in Recents and back gesture.
 *
 * The installed app is a stub, made here on the device from a template the shell carries
 * (assets/stub-template.apk, built from the :stub module): the shell rewrites the template's
 * package name, label and app id in its binary manifest, draws the icon over the template's
 * one, signs it with a key kept in the Android keystore, and installs it silently (device owner).
 * The stub loads the shell's own code at run time ([AppWindow]), which hot-reloads the app's
 * latest build, so edits never need a reinstall. Only a new name, icon or template does.
 */
object AppStubs {
    private const val TAG = "AppStubs"
    const val PREFIX = BuildConfig.APP_PREFIX
    private const val TEMPLATE_PKG = BuildConfig.APP_PREFIX + "stubtemplate"
    private const val KEY = "openhouse-apps"
    private const val META = "openhouse.app"

    data class Spec(val id: String, val name: String, val color: Int, val icon: String? = null)

    private lateinit var ctx: Context
    private val prefs by lazy { ctx.getSharedPreferences("stubs", Context.MODE_PRIVATE) }
    private val lock = Any()
    /** Apps missing from the bridge's list once (shut out of kiosk only if still missing next time). */
    private val missing = HashSet<String>()

    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }
    private fun owner(): Boolean = ctx.getSystemService(android.app.admin.DevicePolicyManager::class.java).isDeviceOwnerApp(ctx.packageName)
    /** Stubs need silent installs, so only a device-owner display makes them; elsewhere apps open in the display. */
    fun enabled(): Boolean = ::ctx.isInitialized && owner() && !prefs.getBoolean("off", false)

    fun pkg(id: String): String {
        val s = id.lowercase().map { if (it in 'a'..'z' || it in '0'..'9') it else '_' }.joinToString("").ifEmpty { "app" }
        return PREFIX + (if (s[0].isDigit()) "a$s" else s)
    }

    /** Installed stubs: app id -> package. */
    fun installed(): Map<String, String> {
        val pm = ctx.packageManager
        return pm.getInstalledApplications(PackageManager.GET_META_DATA)
            .filter { it.packageName.startsWith(PREFIX) && it.packageName != TEMPLATE_PKG }
            .mapNotNull { a -> a.metaData?.getString(META)?.let { it to a.packageName } }.toMap()
    }

    /** What the installed stub was made from: template version + name + color + icon. */
    private fun stamp(s: Spec) = "${templateVersion()}|${s.name}|${s.color}|${s.icon?.hashCode() ?: 0}|letter"
    private fun templateVersion(): Long = runCatching { template().let { ctx.packageManager.getPackageArchiveInfo(it.path, 0)!!.longVersionCode } }.getOrDefault(0)

    fun upToDate(s: Spec): Boolean = isInstalled(pkg(s.id)) && prefs.getString(s.id, null) == stamp(s)
    private fun isInstalled(p: String) = runCatching { ctx.packageManager.getPackageInfo(p, 0); true }.getOrDefault(false)

    /** The app whose window is in front (null: the display itself), what it was opened with, and who to tell when it's reopened. */
    @Volatile var front: String? = null
    @Volatile private var lastExtras: Map<String, String> = emptyMap()
    @Volatile var onReopened: ((String) -> Unit)? = null

    /** Make and install (or update) the stub for one app. Blocking; returns null on success, else why not. */
    fun ensure(s: Spec): String? = synchronized(lock) {
        if (upToDate(s)) { KioskApps.allowInKiosk(pkg(s.id)); return null }
        val t = System.currentTimeMillis()
        val p = pkg(s.id)
        // Android closes an app when it's reinstalled (a new name or icon). If they're in it right now, it opens again.
        val reopen = front == s.id && isInstalled(p)
        val dir = File(ctx.cacheDir, "stubs").apply { mkdirs() }
        val unsigned = File(dir, "$p-unsigned.apk"); val signed = File(dir, "$p.apk")
        try {
            patch(template(), unsigned, mapOf(TEMPLATE_PKG to p, "openhouse-stub-label" to s.name, "openhouse-stub-id" to s.id), icon(s))
            sign(unsigned, signed)
            val (ok, msg) = AppStore.install(listOf(signed), s.name)
            // Signed by an older key (the shell was reinstalled): it isn't replaced, since that would take what the app
            // saved in its own package with it. It opens in the display instead (AppHost).
            if (!ok && (msg.contains("INCOMPATIBLE") || msg.contains("signatures", true))) Log.w(TAG, "$p: $msg; keeping the installed one")
            if (!ok) return "install failed: $msg"
            prefs.edit().putString(s.id, stamp(s)).apply()
            KioskApps.allowInKiosk(p)
            Log.i(TAG, "installed $p (${s.name}) in ${System.currentTimeMillis() - t} ms")
            if (reopen) android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                if (launch(s.id, lastExtras)) { onReopened?.invoke(s.id); Log.i(TAG, "${s.id} reopened after its window was updated") }
            }, 400)
            return null
        } catch (e: Throwable) {
            Log.w(TAG, "stub $p failed", e); return "$e"
        } finally { unsigned.delete(); signed.delete() }
    }

    /**
     * Match the installed stubs to the bridge's list of apps (call with every fresh list). New or renamed apps get a
     * stub. A stub whose app is gone (deleted, undone) is never uninstalled here: it may still hold what the app saved
     * before it was a web page, not yet handed over (AppWindow.handOver). Once it's missing from two lists in a row,
     * it's only shut out of kiosk mode, so nobody can open it.
     */
    fun sync(apps: List<Spec>) {
        if (!enabled()) return
        val have = installed()
        apps.filter { it.id != "home" }.forEach { s -> if (!upToDate(s)) ensure(s)?.let { Log.w(TAG, "${s.id}: $it") } }
        val ids = apps.map { it.id }.toSet()
        val gone = have.keys - ids
        if (apps.isNotEmpty()) for (id in gone) if (id in missing) { have[id]?.let { KioskApps.disallowInKiosk(it); Log.i(TAG, "$id is gone: its window stays installed, shut out of kiosk") } } else missing.add(id)
        missing.retainAll(gone)
        have.filterKeys { it in ids }.values.forEach { KioskApps.allowInKiosk(it) }
    }

    /** Open an app's stub, with the addresses it needs (it remembers them for launches from Recents). */
    fun launch(id: String, extras: Map<String, String>): Boolean {
        val p = installed()[id] ?: return false
        front = id; lastExtras = extras
        KioskApps.allowInKiosk(p)
        val i = ctx.packageManager.getLaunchIntentForPackage(p) ?: return false
        extras.forEach { (k, v) -> i.putExtra(k, v) }
        ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
    }

    private fun uninstallPkg(p: String): Boolean {
        val done = CountDownLatch(1); var ok = false
        val action = "dev.openhouse.shell.UNINSTALL.$p"
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                ok = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) == PackageInstaller.STATUS_SUCCESS
                if (!ok) Log.w(TAG, "uninstall $p: ${i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                done.countDown()
            }
        }
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rx, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED) else ctx.registerReceiver(rx, IntentFilter(action))
        try {
            val pend = PendingIntent.getBroadcast(ctx, p.hashCode(), Intent(action).setPackage(ctx.packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            ctx.packageManager.packageInstaller.uninstall(p, pend.intentSender)
            done.await(60, TimeUnit.SECONDS)
        } finally { runCatching { ctx.unregisterReceiver(rx) } }
        return ok
    }

    // --- making the APK ---------------------------------------------------------------------

    private fun template(): File {
        val f = File(ctx.codeCacheDir, "stub-template.apk")
        val apkTime = File(ctx.applicationInfo.sourceDir).lastModified()
        if (!f.exists() || f.lastModified() < apkTime) {
            ctx.assets.open("stub-template.apk").use { i -> f.outputStream().use { i.copyTo(it) } }
        }
        return f
    }

    /** The launcher icon, like its post-it on the home screen: the icon the agent drew, or its first letter, on its color, as the
     *  adaptive icon's full-bleed foreground. */
    private fun icon(s: Spec): ByteArray {
        val n = 432 // 108 dp at xxxhdpi; launchers mask it to the middle 72 dp
        val b = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        c.drawColor(s.color)
        dev.openhouse.ui.SvgIcon.parse(s.icon)?.let { ic -> // the agent's own icon, in the middle the launcher shows
            val inner = n * 72f / 108f; ic.draw(c, (n - inner) / 2, (n - inner) / 2, inner)
            return ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        }
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; textSize = n * 0.40f }
        val text = s.name.take(1).uppercase()
        p.color = android.graphics.Color.WHITE; p.isFakeBoldText = true
        val fm = p.fontMetrics
        c.drawText(text, n / 2f, n / 2f - (fm.ascent + fm.descent) / 2, p)
        return ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    /** Copy the template with its manifest strings replaced and its one PNG (the icon) swapped. */
    private fun patch(src: File, out: File, strings: Map<String, String>, png: ByteArray) {
        ZipFile(src).use { z ->
            ZipOutputStream(out.outputStream().buffered()).use { zo ->
                for (e in z.entries()) {
                    if (e.name.startsWith("META-INF/")) continue // old signature
                    var data = z.getInputStream(e).use { it.readBytes() }
                    if (e.name == "AndroidManifest.xml") data = Axml.replaceStrings(data, strings)
                    else if (e.name.startsWith("res/") && e.name.endsWith(".png")) data = png
                    val ne = ZipEntry(e.name)
                    if (e.method == ZipEntry.STORED) {
                        ne.method = ZipEntry.STORED; ne.size = data.size.toLong(); ne.compressedSize = data.size.toLong()
                        ne.crc = CRC32().also { it.update(data) }.value
                    }
                    zo.putNextEntry(ne); zo.write(data); zo.closeEntry()
                }
            }
        }
    }

    /** APK Signature Scheme v2 (and v3), with a key made once in the Android keystore. apksig aligns the stored entries. */
    private fun sign(src: File, out: File) {
        val (key, cert) = signingKey()
        val cfg = ApkSigner.SignerConfig.Builder("openhouse", key, listOf(cert)).build()
        ApkSigner.Builder(listOf(cfg)).setInputApk(src).setOutputApk(out).setMinSdkVersion(29)
            .setV1SigningEnabled(false).setV2SigningEnabled(true).setV3SigningEnabled(true).build().sign()
    }

    private fun signingKey(): Pair<PrivateKey, X509Certificate> {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(KEY)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_SIGN)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .setCertificateSubject(X500Principal("CN=openhouse family apps"))
                    .setCertificateNotBefore(java.util.Date(0))
                    .setCertificateNotAfter(java.util.Date(4102444800000L)) // 2100
                    .build())
            }.generateKeyPair()
        }
        return (ks.getKey(KEY, null) as PrivateKey) to (ks.getCertificate(KEY) as X509Certificate)
    }

}

/**
 * Android's binary XML (AndroidManifest.xml in an APK): rewrite strings in its string pool.
 * Every other chunk points at strings by index, so replacing whole strings in place is safe;
 * only the pool and the file's total size change.
 */
object Axml {
    fun replaceStrings(src: ByteArray, map: Map<String, String>): ByteArray {
        val b = ByteBuffer.wrap(src).order(ByteOrder.LITTLE_ENDIAN)
        require(b.getShort(0).toInt() == 0x0003) { "not binary XML" }
        val poolAt = b.getShort(2).toInt() and 0xffff
        require(b.getShort(poolAt).toInt() == 0x0001) { "no string pool" }
        val poolHeader = b.getShort(poolAt + 2).toInt() and 0xffff
        val poolSize = b.getInt(poolAt + 4)
        val count = b.getInt(poolAt + 8); val styles = b.getInt(poolAt + 12); val flags = b.getInt(poolAt + 16)
        val stringsStart = b.getInt(poolAt + 20)
        require(styles == 0) { "styled strings in a manifest" }
        val utf8 = flags and 0x100 != 0
        val base = poolAt + stringsStart
        val strings = (0 until count).map { i -> read(b, base + b.getInt(poolAt + poolHeader + i * 4), utf8) }
        val replaced = strings.map { map[it] ?: it }
        require(replaced != strings) { "no placeholders found" }

        val data = ByteArrayOutputStream(); val offsets = IntArray(count)
        replaced.forEachIndexed { i, s -> offsets[i] = data.size(); data.write(encode(s, utf8)) }
        while (data.size() % 4 != 0) data.write(0)
        val newStart = poolHeader + count * 4
        val newSize = newStart + data.size()
        val pool = ByteBuffer.allocate(newSize).order(ByteOrder.LITTLE_ENDIAN)
        pool.put(src, poolAt, poolHeader) // header, fixed up below
        pool.putInt(4, newSize); pool.putInt(20, newStart); pool.putInt(24, 0)
        pool.position(poolHeader); offsets.forEach { pool.putInt(it) }; pool.put(data.toByteArray())

        val rest = src.size - (poolAt + poolSize)
        val out = ByteBuffer.allocate(poolAt + newSize + rest).order(ByteOrder.LITTLE_ENDIAN)
        out.put(src, 0, poolAt); out.put(pool.array()); out.put(src, poolAt + poolSize, rest)
        out.putInt(4, out.capacity())
        return out.array()
    }

    private fun read(b: ByteBuffer, at: Int, utf8: Boolean): String {
        var p = at
        if (utf8) {
            fun len(): Int { val x = b.get(p++).toInt() and 0xff; return if (x and 0x80 != 0) ((x and 0x7f) shl 8) or (b.get(p++).toInt() and 0xff) else x }
            len(); val n = len()
            return String(b.array(), p, n, Charsets.UTF_8)
        }
        var n = b.getShort(p).toInt() and 0xffff; p += 2
        if (n and 0x8000 != 0) { n = ((n and 0x7fff) shl 16) or (b.getShort(p).toInt() and 0xffff); p += 2 }
        return String(CharArray(n) { b.getChar(p + it * 2) })
    }

    private fun encode(s: String, utf8: Boolean): ByteArray {
        val o = ByteArrayOutputStream()
        if (utf8) {
            val bytes = s.toByteArray(Charsets.UTF_8)
            fun len(n: Int) { if (n > 0x7f) { o.write(0x80 or (n shr 8)); o.write(n and 0xff) } else o.write(n) }
            len(s.length); len(bytes.size); o.write(bytes); o.write(0)
        } else {
            val n = s.length
            fun w(v: Int) { o.write(v and 0xff); o.write(v shr 8 and 0xff) }
            if (n > 0x7fff) { w(0x8000 or (n shr 16)); w(n and 0xffff) } else w(n)
            s.forEach { w(it.code) }; w(0)
        }
        return o.toByteArray()
    }
}
