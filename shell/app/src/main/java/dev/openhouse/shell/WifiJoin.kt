package dev.openhouse.shell

// Joining a Wi-Fi network from Opie itself, without leaving kiosk mode: a nearby network (or one typed by name), its
// password, Join. It needs no PIN: a new network takes nothing away, and a tablet moved to a new router can still get
// back online (and to its account, which resets a forgotten PIN). Android's own Wi-Fi settings, where saved networks
// are seen and forgotten and the rest of Android's settings are a tap away, stay behind the rule for the ways out
// (SettingsLock.withPinSet): the "Wi-Fi settings" button here. Only the device owner may add networks this way.

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.text.InputType
import android.util.Log
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import kotlin.concurrent.thread

internal object WifiJoin {
    private const val TAG = "WifiJoin"

    private data class Net(val ssid: String, val secure: Boolean, val sae: Boolean, val hidden: Boolean = false)

    /** Nearby networks to choose from, then the password; [settings]: Android's Wi-Fi settings (behind the PIN rule). */
    fun show(act: MainActivity, settings: () -> Unit) = thread {
        val nets = nearby(act)
        act.runOnUiThread { choose(act, nets, settings) }
    }

    private fun choose(act: MainActivity, nets: List<Net>, settings: () -> Unit) {
        val rows = nets.map { CalmDialog.Row(it.ssid, value = if (it.secure) null else "Open") } + CalmDialog.Row("Another network")
        CalmDialog(act).setTitle("Join Wi-Fi").setMessage(if (nets.isEmpty()) "No networks found nearby. Type the network's name." else null)
            .setRows(rows) { _, i -> if (i < nets.size) password(act, nets[i], settings) else byName(act, settings) }
            .setNeutralButton("Wi-Fi settings") { _, _ -> settings() }
            .setNegativeButton("Cancel", null).show()
        act.immersive()
    }

    private fun byName(act: MainActivity, settings: () -> Unit) {
        val box = Calm.field(act, "Network name").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        CalmDialog(act).setTitle("Another network").setView(box).setWidth(760f)
            .setPositiveButton("Next") { _, _ -> box.text.toString().takeIf { it.isNotBlank() }?.let { password(act, Net(it, secure = true, sae = false, hidden = true), settings, optional = true) } }
            .setNegativeButton("Back") { _, _ -> show(act, settings) }.show()
        act.immersive()
    }

    /** The password ([optional]: a network typed by name may be open). */
    private fun password(act: MainActivity, n: Net, settings: () -> Unit, optional: Boolean = false) {
        if (!n.secure) { join(act, n, "", settings); return }
        val box = Calm.field(act, if (optional) "Password (none for an open network)" else "Password").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        CalmDialog(act).setTitle(n.ssid).setView(box).setWidth(760f)
            .setPositiveButton("Join") { _, _ -> join(act, n, box.text.toString(), settings) }
            .setNegativeButton("Back") { _, _ -> show(act, settings) }.show()
        act.immersive()
    }

    private fun join(act: MainActivity, n: Net, pw: String, settings: () -> Unit) = thread {
        val ok = runCatching { add(act, n, pw) }.onFailure { Log.w(TAG, "join: $it") }.getOrDefault(false)
        // Joined once the tablet says it's on that network, within about 20 seconds.
        val on = ok && (0 until 20).any { Thread.sleep(1000); current(act) == n.ssid }
        act.runOnUiThread {
            if (on) return@runOnUiThread act.toast("Joined ${n.ssid}")
            CalmDialog(act).setTitle("Couldn't join ${n.ssid}")
                .setMessage(if (ok) "Check the password and try again." else "The tablet didn't take that network.")
                .setPositiveButton("Try again") { _, _ -> password(act, n, settings, optional = n.hidden) }
                .setNegativeButton("Back") { _, _ -> show(act, settings) }.show()
            act.immersive()
        }
    }

    private fun wifi(c: Context) = c.applicationContext.getSystemService(WifiManager::class.java)

    /** Scanning needs location: the device owner grants it to itself (as SetupDevice does). Empty when it can't. */
    @Suppress("DEPRECATION")
    private fun nearby(c: Context): List<Net> = runCatching {
        val dpm = c.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(c, AdminReceiver::class.java)
        runCatching { dpm.setPermissionGrantState(admin, c.packageName, android.Manifest.permission.ACCESS_FINE_LOCATION, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }
        val wm = wifi(c)
        if (!wm.isWifiEnabled) { wm.isWifiEnabled = true; Thread.sleep(1500) }
        wm.startScan(); Thread.sleep(2500)
        wm.scanResults.filter { it.SSID.isNotBlank() && !it.capabilities.contains("EAP") && !it.capabilities.contains("WEP") }
            .groupBy { it.SSID }.map { (_, rs) -> rs.maxBy { it.level } }.sortedByDescending { it.level }
            .map { r -> val caps = r.capabilities; Net(r.SSID, secure = caps.contains("PSK") || caps.contains("SAE"), sae = caps.contains("SAE") && !caps.contains("PSK")) }
            .take(12)
    }.onFailure { Log.w(TAG, "scan: $it") }.getOrDefault(emptyList())

    /** Add the network and connect to it (Android lets the device owner do this; others get false). */
    @Suppress("DEPRECATION")
    private fun add(c: Context, n: Net, pw: String): Boolean {
        val conf = WifiConfiguration().apply {
            SSID = "\"${n.ssid}\""
            hiddenSSID = n.hidden
            when {
                pw.isEmpty() -> allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
                n.sae -> { allowedKeyManagement.set(WifiConfiguration.KeyMgmt.SAE); preSharedKey = "\"$pw\"" }
                else -> { allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK); preSharedKey = "\"$pw\"" }
            }
        }
        val wm = wifi(c)
        val id = wm.addNetwork(conf)
        if (id < 0) return false
        return wm.enableNetwork(id, true)
    }

    @Suppress("DEPRECATION")
    private fun current(c: Context): String? = runCatching { wifi(c).connectionInfo?.ssid?.removeSurrounding("\"") }.getOrNull()
}
