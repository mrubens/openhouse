package dev.openhouse.shell

import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Bluetooth for the bridge's home devices (bridge/devices/bluetooth.js, docs/bluetooth.md), through the device server's
 * POST /bt {op, ...} (same token). The bridge decides what a device is and what to do; this side only does the radio
 * work, one thing at a time, and keeps its own limits that nothing in the bridge can change:
 *  - a firmware-update or security service is never written to (BLOCKED), whatever a recipe says;
 *  - pairing happens only when the bridge asks after a yes on the tablet, and Android's own pairing dialog is let into
 *    kiosk mode just for that minute;
 *  - every pairing, write and audio switch goes to the speech log.
 *
 * ops: state | scan {ms} | pair {mac} | unpair {mac} | services {mac} | gatt {mac, steps} | audio {mac, do} | volume {do, level}
 */
@SuppressLint("MissingPermission") // granted to itself as device owner (perms()), checked before each op
object Bluetooth {
    private const val TAG = "Bluetooth"
    private val lock = java.util.concurrent.locks.ReentrantLock()
    private val ctx get() = DeviceServer.ctx
    private val manager get() = ctx.getSystemService(BluetoothManager::class.java)
    private val adapter: BluetoothAdapter? get() = manager?.adapter

    /** Services nothing here writes to: firmware updates (a bricked or hijacked device) and the link's own security. */
    private val BLOCKED = setOf(
        "0000fe59-0000-1000-8000-00805f9b34fb", // Nordic Secure DFU
        "00001530-1212-efde-1523-785feabcd123", // Nordic legacy DFU
        "1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0", // Silicon Labs OTA
        "f000ffc0-0451-4000-b000-000000000000", // TI OAD
        "0000fef5-0000-1000-8000-00805f9b34fb", // Dialog SUOTA
        "00001800-0000-1000-8000-00805f9b34fb", // Generic Access (the device's name and pairing parameters)
        "00001801-0000-1000-8000-00805f9b34fb", // Generic Attribute
        "00001812-0000-1000-8000-00805f9b34fb", // HID (keyboards and mice: never typed into from here)
    )
    fun blocked(service: String) = full(service) in BLOCKED

    /** "180f", "0x180F" or a full UUID -> the full lowercase form. */
    fun full(u: String): String {
        val s = u.trim().lowercase().removePrefix("0x")
        return when {
            Regex("^[0-9a-f]{4}$").matches(s) -> "0000$s-0000-1000-8000-00805f9b34fb"
            Regex("^[0-9a-f]{8}$").matches(s) -> "$s-0000-1000-8000-00805f9b34fb"
            else -> s
        }
    }

    private fun log(what: String) {
        Log.i(TAG, what)
        runCatching { dev.openhouse.ui.Openhouse.vlog("bluetooth", what.take(240)) }
    }

    /** The runtime permissions Bluetooth needs, granted by the device owner to itself. */
    private fun perms(): String? {
        val need = if (Build.VERSION.SDK_INT >= 31) listOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT")
            else listOf(android.Manifest.permission.ACCESS_FINE_LOCATION)
        val missing = need.filter { ctx.checkSelfPermission(it) != android.content.pm.PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return null
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        if (dpm.isDeviceOwnerApp(ctx.packageName)) missing.forEach { p ->
            runCatching { dpm.setPermissionGrantState(admin, ctx.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }
        }
        val still = need.filter { ctx.checkSelfPermission(it) != android.content.pm.PackageManager.PERMISSION_GRANTED }
        return if (still.isEmpty()) null else "The tablet hasn't allowed OpenHouse to use Bluetooth (${still.joinToString { it.substringAfterLast('.') }})."
    }

    /** Bluetooth on, or why not. Turning it on is fine: someone asked for a Bluetooth device. */
    private fun ready(): String? {
        perms()?.let { return it }
        val a = adapter ?: return "This tablet has no Bluetooth."
        if (!a.isEnabled) {
            @Suppress("DEPRECATION") val asked = runCatching { a.enable() }.getOrDefault(false) // device owners still may
            if (asked) repeat(40) { if (a.isEnabled) return null; Thread.sleep(150) }
            if (!a.isEnabled) return "Bluetooth is off on the tablet and couldn't be turned on."
        }
        return null
    }

    fun handle(b: JSONObject): JSONObject {
        if (!lock.tryLock(30, TimeUnit.SECONDS)) return JSONObject().put("error", "Bluetooth is busy with something else; try again in a moment.")
        return try { runCatching { op(b) }.getOrElse { Log.w(TAG, "op", it); JSONObject().put("error", it.message ?: it.toString()) } } finally { lock.unlock() }
    }

    private fun op(b: JSONObject): JSONObject {
        val op = b.optString("op")
        if (op == "state") return JSONObject().put("supported", adapter != null).put("on", adapter?.isEnabled == true).put("why", perms())
        if (op == "volume") return volume(b.optString("do", "get"), b.optInt("level", -1)) // the tablet's own volume: no Bluetooth needed
        ready()?.let { return JSONObject().put("error", it) }
        val mac = b.optString("mac").uppercase()
        val dev = if (BluetoothAdapter.checkBluetoothAddress(mac)) adapter!!.getRemoteDevice(mac) else null
        if (op != "scan" && op != "volume" && dev == null) return JSONObject().put("error", "Not a Bluetooth address: ${b.optString("mac")}")
        return when (op) {
            "scan" -> JSONObject().put("devices", scan(b.optLong("ms", 8000).coerceIn(2000, 20000)))
            "pair" -> pair(dev!!)
            "unpair" -> unpair(dev!!)
            "services" -> Gatt(dev!!).use { it.open()?.let { e -> JSONObject().put("error", e) } ?: JSONObject().put("services", it.tree()) }
            "gatt" -> gatt(dev!!, b.optJSONArray("steps") ?: JSONArray())
            "audio" -> audio(dev!!, b.optString("do", "status"))
            "volume" -> volume(b.optString("do", "get"), b.optInt("level", -1))
            else -> JSONObject().put("error", "unknown op $op")
        }
    }

    // --- finding ------------------------------------------------------------------------------
    private fun describe(d: BluetoothDevice, into: JSONObject = JSONObject()): JSONObject {
        into.put("mac", d.address.lowercase())
        runCatching { d.name }.getOrNull()?.takeIf { it.isNotBlank() }?.let { into.put("name", it) }
        into.put("type", when (d.type) { BluetoothDevice.DEVICE_TYPE_LE -> "le"; BluetoothDevice.DEVICE_TYPE_CLASSIC -> "classic"; BluetoothDevice.DEVICE_TYPE_DUAL -> "dual"; else -> "unknown" })
        into.put("bonded", d.bondState == BluetoothDevice.BOND_BONDED)
        d.bluetoothClass?.let { c ->
            into.put("major", when (c.majorDeviceClass) {
                BluetoothClass.Device.Major.AUDIO_VIDEO -> "audio"; BluetoothClass.Device.Major.PHONE -> "phone"
                BluetoothClass.Device.Major.COMPUTER -> "computer"; BluetoothClass.Device.Major.PERIPHERAL -> "input"
                BluetoothClass.Device.Major.WEARABLE -> "wearable"; BluetoothClass.Device.Major.HEALTH -> "health"
                BluetoothClass.Device.Major.TOY -> "toy"; BluetoothClass.Device.Major.IMAGING -> "imaging"
                BluetoothClass.Device.Major.NETWORKING -> "network"; else -> "other" })
            val audio = when (c.deviceClass) {
                BluetoothClass.Device.AUDIO_VIDEO_LOUDSPEAKER, BluetoothClass.Device.AUDIO_VIDEO_PORTABLE_AUDIO, BluetoothClass.Device.AUDIO_VIDEO_HIFI_AUDIO -> "speaker"
                BluetoothClass.Device.AUDIO_VIDEO_HEADPHONES, BluetoothClass.Device.AUDIO_VIDEO_WEARABLE_HEADSET, BluetoothClass.Device.AUDIO_VIDEO_HANDSFREE -> "headphones"
                BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO -> "car"
                BluetoothClass.Device.AUDIO_VIDEO_VIDEO_DISPLAY_AND_LOUDSPEAKER -> "tv"
                else -> if (c.hasService(BluetoothClass.Service.RENDER) && c.majorDeviceClass == BluetoothClass.Device.Major.AUDIO_VIDEO) "speaker" else null
            }
            audio?.let { into.put("audio", it) }
        }
        val uuids = into.optJSONArray("services") ?: JSONArray().also { into.put("services", it) }
        val have = (0 until uuids.length()).map { uuids.getString(it) }.toMutableSet()
        d.uuids?.forEach { if (have.add(it.uuid.toString())) uuids.put(it.uuid.toString()) }
        return into
    }

    private fun scan(ms: Long): JSONArray {
        val a = adapter!!
        val found = ConcurrentHashMap<String, JSONObject>()
        fun merge(d: BluetoothDevice, rssi: Int?, adv: ScanResult? = null) {
            val j = found.getOrPut(d.address) { JSONObject() }
            synchronized(j) {
                describe(d, j)
                rssi?.let { j.put("rssi", maxOf(it, j.optInt("rssi", -200))) }
                adv?.scanRecord?.let { r ->
                    r.deviceName?.takeIf { it.isNotBlank() && !j.has("name") }?.let { j.put("name", it) }
                    val uuids = j.getJSONArray("services")
                    val have = (0 until uuids.length()).map { uuids.getString(it) }.toMutableSet()
                    r.serviceUuids?.forEach { if (have.add(it.uuid.toString())) uuids.put(it.uuid.toString()) }
                    val makers = r.manufacturerSpecificData
                    if (makers != null && makers.size() > 0) j.put("makers", JSONArray((0 until makers.size()).map { makers.keyAt(it) }))
                    if (Build.VERSION.SDK_INT >= 26) j.put("connectable", adv.isConnectable)
                }
            }
        }
        a.bondedDevices?.forEach { merge(it, null) }
        val le = a.bluetoothLeScanner
        val cb = object : ScanCallback() {
            override fun onScanResult(type: Int, r: ScanResult) = merge(r.device, r.rssi, r)
            override fun onBatchScanResults(rs: MutableList<ScanResult>) = rs.forEach { merge(it.device, it.rssi, it) }
            override fun onScanFailed(code: Int) { Log.w(TAG, "le scan failed $code") }
        }
        val classic = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val d = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java) else @Suppress("DEPRECATION") i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                d?.let { merge(it, i.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt().takeIf { r -> r > -200 }) }
            }
        }
        val f = IntentFilter(BluetoothDevice.ACTION_FOUND)
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(classic, f, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(classic, f)
        try {
            runCatching { le?.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb) }.onFailure { Log.w(TAG, "le scan: $it") }
            runCatching { a.startDiscovery() }
            Thread.sleep(ms)
        } finally {
            runCatching { le?.stopScan(cb) }; runCatching { a.cancelDiscovery() }; runCatching { ctx.unregisterReceiver(classic) }
        }
        val a2dp = profile(BluetoothProfile.A2DP) as? BluetoothA2dp
        val connected = runCatching { a2dp?.connectedDevices?.map { it.address } }.getOrNull().orEmpty()
        for ((addr, j) in found) j.put("connected", addr in connected)
        Log.i(TAG, "scan: ${found.size} in $ms ms")
        return JSONArray(found.values.toList())
    }

    // --- pairing ------------------------------------------------------------------------------
    /** Pair (the bridge has already had its yes). Android's own dialog may ask to confirm a code: it's let into kiosk mode
     *  for that minute only, and taken out again after. */
    private fun pair(d: BluetoothDevice): JSONObject {
        if (d.bondState == BluetoothDevice.BOND_BONDED) return describe(d).put("paired", true)
        val got = LinkedBlockingQueue<Int>()
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val x = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java) else @Suppress("DEPRECATION") i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                if (x?.address == d.address) got.offer(i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1))
            }
        }
        val f = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, f, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(r, f)
        val dialogs = (KioskApps.settingsPackages() + listOf("com.android.settings", "com.android.bluetooth")).distinct()
        val added = letIn(dialogs)
        log("pairing ${d.name ?: d.address}")
        try {
            adapter!!.cancelDiscovery()
            if (!d.createBond()) return JSONObject().put("paired", false).put("why", "Android wouldn't start pairing. Is it in pairing mode?")
            val until = System.currentTimeMillis() + 60_000
            while (System.currentTimeMillis() < until) {
                when (got.poll(1, TimeUnit.SECONDS)) {
                    BluetoothDevice.BOND_BONDED -> { log("paired ${d.name ?: d.address}"); return describe(d).put("paired", true) }
                    BluetoothDevice.BOND_NONE -> { log("pairing ${d.name ?: d.address} didn't work"); return JSONObject().put("paired", false).put("why", "It didn't pair (refused, a wrong code, or it wasn't in pairing mode).") }
                }
            }
            return JSONObject().put("paired", false).put("why", "Nothing happened for a minute.")
        } finally {
            runCatching { ctx.unregisterReceiver(r) }
            letOut(added)
            KioskApps.goHome()
        }
    }

    /** Add packages to the kiosk's allowed list; returns the ones that weren't there (to take out again). */
    private fun letIn(pkgs: List<String>): List<String> {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        if (!dpm.isDeviceOwnerApp(ctx.packageName)) return emptyList()
        return runCatching {
            val cur = dpm.getLockTaskPackages(admin).toMutableSet()
            val added = pkgs.filter { cur.add(it) }
            if (added.isNotEmpty()) dpm.setLockTaskPackages(admin, cur.toTypedArray())
            added
        }.getOrDefault(emptyList())
    }
    private fun letOut(pkgs: List<String>) { pkgs.forEach { KioskApps.disallowInKiosk(it) } }

    private fun unpair(d: BluetoothDevice): JSONObject {
        if (d.bondState != BluetoothDevice.BOND_BONDED) return JSONObject().put("unpaired", true)
        val ok = runCatching { d.javaClass.getMethod("removeBond").invoke(d) as Boolean }.getOrDefault(false)
        log("forget ${d.name ?: d.address}: ${if (ok) "done" else "refused"}")
        return JSONObject().put("unpaired", ok).apply { if (!ok) put("why", "Android didn't let OpenHouse forget it; it can be forgotten in the tablet's Bluetooth settings.") }
    }

    // --- GATT ---------------------------------------------------------------------------------
    /** One connection to a BLE device, used in order and closed. */
    private class Gatt(val d: BluetoothDevice) : BluetoothGattCallback(), AutoCloseable {
        private var g: BluetoothGatt? = null
        private val events = LinkedBlockingQueue<Pair<String, Any?>>()
        private val notes = LinkedBlockingQueue<ByteArray>()

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, state: Int) { events.offer("conn" to (state == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS)) }
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) { events.offer("services" to (status == BluetoothGatt.GATT_SUCCESS)) }
        override fun onCharacteristicRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) { events.offer("read" to (if (status == BluetoothGatt.GATT_SUCCESS) value else null)) }
        @Deprecated("before Android 13") override fun onCharacteristicRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION") events.offer("read" to (if (status == BluetoothGatt.GATT_SUCCESS) c.value else null))
        }
        override fun onCharacteristicWrite(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) { events.offer("write" to (status == BluetoothGatt.GATT_SUCCESS)) }
        override fun onDescriptorWrite(gatt: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) { events.offer("desc" to (status == BluetoothGatt.GATT_SUCCESS)) }
        override fun onCharacteristicChanged(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) { notes.offer(value) }
        @Deprecated("before Android 13") override fun onCharacteristicChanged(gatt: BluetoothGatt, c: BluetoothGattCharacteristic) { @Suppress("DEPRECATION") notes.offer(c.value) }

        private fun await(kind: String, ms: Long): Any? {
            val until = System.currentTimeMillis() + ms
            while (true) {
                val left = until - System.currentTimeMillis(); if (left <= 0) return null
                val e = events.poll(left, TimeUnit.MILLISECONDS) ?: return null
                if (e.first == "conn" && e.second == false) throw IllegalStateException("The device disconnected.")
                if (e.first == kind) return e.second
            }
        }

        /** Connect and find its services; null, or why not. */
        fun open(): String? {
            g = d.connectGatt(DeviceServer.ctx, false, this, BluetoothDevice.TRANSPORT_LE)
            if (await("conn", 15_000) != true) return "Couldn't connect to it (out of range, asleep, or connected to something else)."
            if (g?.discoverServices() != true || await("services", 12_000) != true) return "Connected, but it didn't say what it can do."
            return null
        }

        fun tree(): JSONArray = JSONArray().apply {
            g?.services?.forEach { s ->
                put(JSONObject().put("uuid", s.uuid.toString()).put("blocked", blocked(s.uuid.toString())).put("characteristics", JSONArray().apply {
                    s.characteristics.forEach { c ->
                        val p = c.properties
                        put(JSONObject().put("uuid", c.uuid.toString()).put("can", JSONArray(listOfNotNull(
                            "read".takeIf { p and BluetoothGattCharacteristic.PROPERTY_READ != 0 },
                            "write".takeIf { p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0 },
                            "write_no_response".takeIf { p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0 },
                            "notify".takeIf { p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0 },
                            "indicate".takeIf { p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0 },
                        ))))
                    }
                }))
            }
        }

        private fun chr(svc: String, c: String): BluetoothGattCharacteristic {
            val s = g?.getService(UUID.fromString(full(svc))) ?: throw IllegalArgumentException("It has no service $svc.")
            return s.getCharacteristic(UUID.fromString(full(c))) ?: throw IllegalArgumentException("Service $svc has no characteristic $c.")
        }

        fun read(svc: String, c: String): ByteArray {
            val ch = chr(svc, c)
            if (g?.readCharacteristic(ch) != true) throw IllegalStateException("It wouldn't let $c be read.")
            return await("read", 8_000) as? ByteArray ?: throw IllegalStateException("Reading $c didn't work.")
        }

        fun write(svc: String, c: String, bytes: ByteArray, response: Boolean) {
            if (blocked(svc)) throw SecurityException("OpenHouse never writes to that service (firmware updates, security or typing).")
            val ch = chr(svc, c)
            val type = if (response) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            val started = if (Build.VERSION.SDK_INT >= 33) g?.writeCharacteristic(ch, bytes, type) == BluetoothGatt.GATT_SUCCESS
                else @Suppress("DEPRECATION") run { ch.writeType = type; ch.value = bytes; g?.writeCharacteristic(ch) == true }
            if (!started) throw IllegalStateException("It wouldn't take a write to $c.")
            val ok = await("write", if (response) 8_000 else 1_500)
            if (response && ok != true) throw IllegalStateException("Writing to $c didn't work.")
        }

        /** Turn on its notifications for [c] and keep what arrives for [ms]. */
        fun listen(svc: String, c: String, ms: Long): List<ByteArray> {
            val ch = chr(svc, c)
            g?.setCharacteristicNotification(ch, true)
            ch.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))?.let { desc ->
                val v = if (ch.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) BluetoothGattDescriptor.ENABLE_INDICATION_VALUE else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                if (Build.VERSION.SDK_INT >= 33) g?.writeDescriptor(desc, v) else @Suppress("DEPRECATION") run { desc.value = v; g?.writeDescriptor(desc) }
                await("desc", 4_000)
            }
            val out = mutableListOf<ByteArray>()
            val until = System.currentTimeMillis() + ms
            while (true) { val left = until - System.currentTimeMillis(); if (left <= 0) break; notes.poll(left, TimeUnit.MILLISECONDS)?.let(out::add) }
            return out
        }

        /** Arm notifications first, so the reply to a write that follows isn't missed. */
        fun arm(svc: String, c: String) { listen(svc, c, 0); notes.clear() }
        fun drain(ms: Long): List<ByteArray> { val out = mutableListOf<ByteArray>(); val until = System.currentTimeMillis() + ms; while (true) { val left = until - System.currentTimeMillis(); if (left <= 0) break; notes.poll(left, TimeUnit.MILLISECONDS)?.let(out::add) }; return out }

        override fun close() { runCatching { g?.disconnect() }; runCatching { g?.close() } }
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun unhex(s: String): ByteArray {
        require(Regex("^([0-9a-fA-F]{2}){0,512}$").matches(s)) { "not hex bytes: $s" }
        return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    /** Steps (bridge recipe.js fills them in): {read: {service, characteristic}} | {write: {service, characteristic, hex, response}}
     *  | {listen: {service, characteristic, ms}} | {wait: ms}. Answers each read and listen, in hex. */
    private fun gatt(d: BluetoothDevice, steps: JSONArray): JSONObject {
        if (steps.length() !in 1..12) return JSONObject().put("error", "1-12 steps")
        // Refused before connecting: a write or a listen on a firmware-update, security or keyboard service.
        for (i in 0 until steps.length()) {
            val s = steps.getJSONObject(i)
            val w = s.optJSONObject("write") ?: s.optJSONObject("listen") ?: continue
            if (blocked(w.optString("service"))) return JSONObject().put("error", "OpenHouse never writes to that service (firmware updates, security or typing).")
        }
        val out = JSONArray()
        Gatt(d).use { g ->
            g.open()?.let { return JSONObject().put("error", it) }
            // A listen after a write (the usual BLE command and reply) is armed before the write.
            val listens = (0 until steps.length()).mapNotNull { steps.getJSONObject(it).optJSONObject("listen") }
            listens.forEach { runCatching { g.arm(it.getString("service"), it.getString("characteristic")) } }
            for (i in 0 until steps.length()) {
                val s = steps.getJSONObject(i)
                when {
                    s.has("wait") -> Thread.sleep(s.optLong("wait").coerceIn(1, 5000))
                    s.has("read") -> s.getJSONObject("read").let { out.put(JSONObject().put("read", hex(g.read(it.getString("service"), it.getString("characteristic"))))) }
                    s.has("write") -> s.getJSONObject("write").let {
                        val bytes = unhex(it.getString("hex"))
                        g.write(it.getString("service"), it.getString("characteristic"), bytes, it.optBoolean("response", true))
                        log("write ${d.name ?: d.address} ${it.getString("characteristic").take(8)} ${hex(bytes).take(40)}")
                    }
                    s.has("listen") -> s.getJSONObject("listen").let { out.put(JSONObject().put("listen", JSONArray(g.drain(it.optLong("ms", 1000).coerceIn(100, 5000)).map(::hex)))) }
                }
            }
        }
        return JSONObject().put("results", out)
    }

    // --- audio --------------------------------------------------------------------------------
    private fun profile(which: Int, ms: Long = 3000): BluetoothProfile? {
        val got = LinkedBlockingQueue<BluetoothProfile>()
        val ok = adapter?.getProfileProxy(ctx, object : BluetoothProfile.ServiceListener {
            override fun onServiceConnected(p: Int, proxy: BluetoothProfile) { got.offer(proxy) }
            override fun onServiceDisconnected(p: Int) {}
        }, which) ?: false
        return if (ok) got.poll(ms, TimeUnit.MILLISECONDS) else null
    }

    private val am get() = ctx.getSystemService(AudioManager::class.java)
    /** The Bluetooth speaker media plays through now, if any. */
    private fun routed(): String? = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || (Build.VERSION.SDK_INT >= 31 && it.type == AudioDeviceInfo.TYPE_BLE_SPEAKER) }
        ?.let { if (Build.VERSION.SDK_INT >= 28) it.address.lowercase() else it.productName.toString() }

    /** status | connect | disconnect: the speaker as where the tablet's sound goes. */
    private fun audio(d: BluetoothDevice, what: String): JSONObject {
        val a2dp = profile(BluetoothProfile.A2DP) as? BluetoothA2dp ?: return JSONObject().put("error", "The tablet's Bluetooth audio isn't available.")
        fun state() = JSONObject().put("paired", d.bondState == BluetoothDevice.BOND_BONDED)
            .put("connected", a2dp.getConnectionState(d) == BluetoothProfile.STATE_CONNECTED)
            .put("playing", runCatching { a2dp.isA2dpPlaying(d) }.getOrDefault(false))
            .put("routed", routed()?.let { it == d.address.lowercase() } ?: false)
            .put("volume", vol())
        try {
            if (what == "status") return state()
            if (d.bondState != BluetoothDevice.BOND_BONDED) return state().put("error", "It isn't paired with the tablet yet.")
            val name = if (what == "connect") "connect" else "disconnect"
            // Hidden in the SDK (system apps use it); Android may refuse, and then the speaker connects by itself when it comes on.
            val ok = runCatching { BluetoothA2dp::class.java.getMethod(name, BluetoothDevice::class.java).invoke(a2dp, d) as Boolean }
                .onFailure { Log.w(TAG, "a2dp $name: $it") }.getOrDefault(false)
            log("audio $name ${d.name ?: d.address}: ${if (ok) "asked" else "refused"}")
            if (!ok) return state().put("error", if (what == "connect") "Android didn't let OpenHouse switch to it directly. Turn the speaker off and on again: a paired speaker connects to the tablet by itself." else "Android didn't let OpenHouse disconnect it. Turning the speaker off sends the sound back to the tablet.")
            val want = if (what == "connect") BluetoothProfile.STATE_CONNECTED else BluetoothProfile.STATE_DISCONNECTED
            repeat(40) { if (a2dp.getConnectionState(d) == want) return state(); Thread.sleep(250) }
            return state().put("error", if (what == "connect") "It didn't connect within 10 seconds (is it on, and near?)." else "It's still connected.")
        } finally { adapter?.closeProfileProxy(BluetoothProfile.A2DP, a2dp) }
    }

    private fun vol() = am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100 / am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    /** The tablet's media volume (a Bluetooth speaker follows it, with absolute volume): get | set {level 0-100} | up | down. */
    private fun volume(what: String, level: Int): JSONObject {
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        when (what) {
            "set" -> am.setStreamVolume(AudioManager.STREAM_MUSIC, (level.coerceIn(0, 100) * max + 50) / 100, 0)
            "up" -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, 0)
            "down" -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, 0)
        }
        if (what != "get") log("volume $what ${if (what == "set") level else ""} -> ${vol()}")
        return JSONObject().put("volume", vol()).put("routed", routed())
    }
}
