package dev.openhouse.shell

// What the first setup (ui/Setup.kt) needs from the tablet itself: a guess at the home's street address, from where
// the tablet is (Android's own location and geocoder; only with location on), and the code a phone scans or a computer
// types to carry on there (bridge screens.js, a 'setup' pairing: it joins at once, as that person's).

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.location.Geocoder
import android.location.LocationManager
import android.os.Build
import android.util.Log
import dev.openhouse.ui.BridgeClient
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal object SetupDevice {
    private const val TAG = "SetupDevice"

    /** Off the main thread: {address, town, zip} where the tablet is, or null (location off, nothing found). */
    fun guessHome(c: Context): JSONObject? = runCatching {
        val dpm = c.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(c, AdminReceiver::class.java)
        for (p in listOf(android.Manifest.permission.ACCESS_COARSE_LOCATION, android.Manifest.permission.ACCESS_FINE_LOCATION))
            runCatching { dpm.setPermissionGrantState(admin, c.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }
        val lm = c.getSystemService(LocationManager::class.java)
        if (!lm.isLocationEnabled) { Log.i(TAG, "location is off: no guess"); return null }
        val got = LinkedBlockingQueue<android.location.Location>()
        // Every provider that's on at once (Wi-Fi's is quick indoors; GPS, if any, can take a while): the first answer wins.
        @Suppress("MissingPermission")
        if (Build.VERSION.SDK_INT >= 30) for (p in listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).filter { lm.isProviderEnabled(it) })
            runCatching { lm.getCurrentLocation(p, null, c.mainExecutor) { it?.let { l -> got.offer(l) } } }
        @Suppress("MissingPermission")
        val loc = got.poll(15, TimeUnit.SECONDS) ?: listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
            .firstNotNullOfOrNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() } ?: run { Log.i(TAG, "no location: no guess"); return null }
        if (!Geocoder.isPresent()) return null
        val found = LinkedBlockingQueue<List<android.location.Address>>()
        if (Build.VERSION.SDK_INT >= 33) Geocoder(c).getFromLocation(loc.latitude, loc.longitude, 1) { found.offer(it) }
        else @Suppress("DEPRECATION") found.offer(Geocoder(c).getFromLocation(loc.latitude, loc.longitude, 1).orEmpty())
        val a = found.poll(8, TimeUnit.SECONDS)?.firstOrNull() ?: return null
        val street = listOfNotNull(a.subThoroughfare, a.thoroughfare).joinToString(" ").trim()
        val town = listOfNotNull(a.locality ?: a.subAdminArea, a.adminArea).joinToString(", ")
        val zip = a.postalCode.orEmpty()
        val line = listOf(street, town + (if (zip.isNotEmpty()) " $zip" else "")).filter { it.isNotBlank() }.joinToString(", ")
        Log.i(TAG, "guessed an address")
        JSONObject().put("address", line.ifBlank { a.getAddressLine(0) ?: "" }).put("town", town).put("zip", zip)
    }.onFailure { Log.w(TAG, "guess: $it") }.getOrNull()

    /**
     * Off the main thread: a new setup code for [person]'s phone or computer: {url} for the phone to scan, {code} and
     * {address} ("openhouse.local:8788/phone") for a computer to type. null: no Wi-Fi, or the bridge didn't answer.
     */
    fun pair(c: Context, bridge: String, person: String): JSONObject? = runCatching {
        val ip = Handoff.lanAddress(c)?.hostAddress ?: return null
        val r = JSONObject(BridgeClient.post("$bridge/screens/pair", JSONObject().put("setup", true).put("person", person).put("address", ip).toString()) ?: return null)
        val port = r.optInt("port")
        val url = "http://$ip:$port/phone/?for=${android.net.Uri.encode(person)}#${r.optString("pair")}.${r.optString("key")}"
        val host = r.optString("host").takeIf { it.isNotEmpty() && !r.isNull("host") } ?: ip
        JSONObject().put("url", url).put("code", r.optString("code")).put("address", "$host:$port/phone").put("ip", "$ip:$port/phone")
    }.onFailure { Log.w(TAG, "pair: $it") }.getOrNull()
}
