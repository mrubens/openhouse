package dev.openhouse.shell

// Adding an Android app for the family: the assistant finds it in Aurora Store and presses Install (after a
// yes on the card); the shell installs what Aurora downloads (AppStore).

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.UUID
import kotlin.concurrent.thread

internal object AuroraInstall {
    private const val TAG = "DeviceServer"
    private val ctx get() = DeviceServer.ctx
    /** Aurora Store itself, opened from Apps (someone already said yes, with the PIN when it's on): got and set up
     *  first if need be. What they install there still asks on the shell's card (AppStore). null: open. */
    fun openStore(acc: DeviceAccess): String? {
        AppStore.ensureAurora { acc.status(it) }?.let { return it }
        setUpAurora(acc)?.let { return "Aurora Store's first run didn't finish. Try again." }
        if (!AppStore.auroraMayInstall()) allowAuroraInstalls(acc)
        return if (KioskApps.openApp(AppStore.AURORA, parentOk = true)) null else "Aurora Store didn't open."
    }

    /** Find the app in Aurora Store and press Install; the shell installs what Aurora downloads (see AppStore). */
    fun installApp(acc: DeviceAccess, pkg: String, given: String): JSONObject {
        if (!Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+").matches(pkg)) return DeviceServer.text("Give the app's name; install_app finds it.", true)
        if (AppStore.installed(pkg)) { AppStore.addToHome(pkg); return DeviceServer.text("${AppStore.label(pkg)} is already installed, and on the home screen. open_app opens it.") }
        val name = given.ifBlank { pkg }
        acc.status("Waiting for a yes: add $name?")
        if (!acc.approve("Add $name?", "", parent = PinChoices.needed(ctx, PinChoices.APPS), yes = "Add", rights = listOf("from" to "From Google Play"), more = pkg))
            return DeviceServer.text("Nobody said yes, so $name wasn't added. Say so; don't try again.", true).put("declined", true)
        AppStore.approve(pkg)
        AppStore.ensureAurora { acc.status(it) }?.let { return DeviceServer.text(it, true) }
        setUpAurora(acc)?.let { return DeviceServer.text(it, true) }
        if (!AppStore.auroraMayInstall() && !allowAuroraInstalls(acc))
            return DeviceServer.text("Aurora Store needs Android's \"Install unknown apps\" switch on, and it couldn't be turned on here. " +
                "Someone at the device can turn it on: Settings > Advanced > Android settings > Apps > Aurora Store > Install unknown apps.", true)
        acc.status("Finding $name in Aurora Store")
        ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=$pkg")).setPackage(AppStore.AURORA)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
        // Its page loads after Aurora signs in (anonymously); press Install (or Update/Download) when it appears.
        var pressed = false
        var cleared = false
        val until = System.currentTimeMillis() + 45_000
        while (!pressed && System.currentTimeMillis() < until) {
            Thread.sleep(1000)
            if (acc.foregroundPackage() != AppStore.AURORA) continue
            if (find(acc, "Continue to Aurora Store?") != null) { find(acc, "Open")?.let { acc.click(it) }; continue } // Aurora checks outside links
            // Left "Installing" by an earlier install nobody approved: Aurora waits for it forever. Clear
            // its download list, then open the page again.
            if (!cleared && find(acc, "Installing") != null) {
                cleared = true
                clearAuroraDownloads(acc)
                ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=$pkg")).setPackage(AppStore.AURORA)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                continue
            }
            val b = find(acc, "Install") ?: find(acc, "Download") ?: continue
            acc.status("Pressing Install", Rect().also { b.getBoundsInScreen(it) }.let { android.graphics.PointF(it.exactCenterX(), it.exactCenterY()) })
            Thread.sleep(450)
            pressed = acc.click(b, false)
        }
        if (!pressed) return DeviceServer.text("Aurora Store didn't show an Install button for $name. It may need its one-time setup: use screen/tap to finish it " +
            "(sign in with the Anonymous option only, never a Google account), then call install_app again." +
            "\n\nOn screen now:\n${acc.describe()}", true)
        val (ok, msg) = AppStore.await(pkg, 10 * 60_000L) {
            // Aurora shows the download's progress on the page ("45%"); show it on the assistant too.
            val pct = acc.rootInActiveWindow?.findAccessibilityNodeInfosByText("%")?.firstNotNullOfOrNull { n ->
                Regex("(\\d{1,3})\\s?%").find(n.text?.toString() ?: "")?.groupValues?.get(1) }
            acc.status(if (pct != null) "Downloading $name: $pct%" else "Downloading $name")
        }
        if (!ok) return DeviceServer.text("$name wasn't installed: $msg\n\nOn screen now:\n${acc.describe()}", true)
        KioskApps.goHome()
        return DeviceServer.text("${AppStore.label(pkg)} is installed and on the home screen's stickers. Tell them; open_app opens it.")
    }

    /** An element whose text or description is exactly [w] (or starts with it), on the screen now. */
    private fun find(acc: DeviceAccess, w: String, prefix: Boolean = false): AccessibilityNodeInfo? {
        val roots = acc.windows.filter { it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION }.sortedByDescending { it.layer }.mapNotNull { it.root }
        // A plain walk: Compose apps (Aurora is one) don't answer findAccessibilityNodeInfosByText.
        fun walk(n: AccessibilityNodeInfo, depth: Int): AccessibilityNodeInfo? {
            val t = (n.text ?: n.contentDescription)?.toString()?.trim()
            if (t != null && n.isEnabled && (t.equals(w, true) || (prefix && t.startsWith(w, true)))) return n
            if (depth > 40) return null
            for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }?.let { return it }
            return null
        }
        return roots.firstNotNullOfOrNull { walk(it, 0) }
    }

    /**
     * Aurora's first run, done once: past the welcome pages, signed in with its Anonymous option (a
     * shared account from Aurora's dispenser; never anyone's Google account), and switched to the
     * Native installer so the APKs it downloads come to the shell to install.
     */
    private fun setUpAurora(acc: DeviceAccess): String? {
        if (AppStore.auroraReady()) return null
        acc.status("Setting up Aurora Store")
        ctx.packageManager.getLaunchIntentForPackage(AppStore.AURORA)?.let { ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        val steps = listOf("More", "Settings", "Installation", "Installation method", "Native installer")
        var step = -1 // -1: welcome pages and sign-in
        val until = System.currentTimeMillis() + 90_000
        while (System.currentTimeMillis() < until) {
            Thread.sleep(1200)
            if (step < 0) {
                val b = find(acc, "Anonymous") ?: find(acc, "Finish") ?: find(acc, "Next")
                Log.i(TAG, "aurora setup: ${b?.text ?: "-"} (in ${acc.foregroundPackage()})")
                if (b != null) { acc.click(b); continue }
                if (find(acc, "More") != null && find(acc, "Updates") != null) step = 0 // signed in: Aurora's home
                continue
            }
            val b = find(acc, steps[step], prefix = step == steps.lastIndex) ?: continue
            acc.click(b)
            if (++step == steps.size) {
                Thread.sleep(800)
                AppStore.auroraReady(true)
                return null
            }
        }
        return "Aurora Store's first-run setup didn't finish. Use screen/tap to finish it: sign in with the Anonymous option only " +
            "(never a Google account), then under More > Settings > Installation > Installation method choose Native installer. " +
            "Then call install_app again.\n\nOn screen now:\n${acc.describe()}"
    }

    /** Aurora's Downloads > menu > "Force clear all" (forgets downloads, including ones stuck "Installing"). */
    private fun clearAuroraDownloads(acc: DeviceAccess) {
        acc.status("Tidying up Aurora Store")
        ctx.packageManager.getLaunchIntentForPackage(AppStore.AURORA)?.let {
            ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        }
        val steps = listOf("Downloads", "Menu", "Force clear all")
        var step = 0
        val until = System.currentTimeMillis() + 20_000
        while (step < steps.size && System.currentTimeMillis() < until) {
            Thread.sleep(1000)
            find(acc, steps[step])?.let { if (acc.click(it)) step++ }
        }
        Thread.sleep(800)
        Log.i(TAG, "cleared Aurora's downloads: ${step == steps.size}")
    }

    /**
     * Aurora won't start an install until Android's "Install unknown apps" switch is on for it (an
     * app-op, which no device-owner API sets). Flip it in Settings, let into kiosk just for that.
     * Aurora's APKs still come to the shell, which installs them only after someone's yes.
     */
    private fun allowAuroraInstalls(acc: DeviceAccess): Boolean {
        val i = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, android.net.Uri.parse("package:${AppStore.AURORA}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val settings = ctx.packageManager.resolveActivity(i, 0)?.activityInfo?.packageName ?: return false
        acc.status("Letting Aurora Store install apps")
        KioskApps.allowInKiosk(settings)
        try {
            ctx.startActivity(i)
            val until = System.currentTimeMillis() + 15_000
            while (System.currentTimeMillis() < until) {
                Thread.sleep(800)
                if (AppStore.auroraMayInstall()) break
                if (acc.foregroundPackage() != settings) continue
                fun walk(n: AccessibilityNodeInfo, d: Int): AccessibilityNodeInfo? {
                    if (n.isCheckable) return n // the "Allow from this source" switch (a Switch, or a checkable row)
                    if (d > 30) return null
                    for (k in 0 until n.childCount) n.getChild(k)?.let { walk(it, d + 1) }?.let { return it }
                    return null
                }
                val sw = acc.windows.filter { it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION }
                    .mapNotNull { it.root }.firstNotNullOfOrNull { walk(it, 0) } ?: continue
                if (!sw.isChecked) { acc.click(sw); Thread.sleep(800) }
            }
        } finally {
            acc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            KioskApps.disallowInKiosk(settings)
        }
        return AppStore.auroraMayInstall()
    }

}
