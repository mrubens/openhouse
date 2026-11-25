package dev.openhouse.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * The shell's watchdog: keeps the runtime up (Runtime.supervise: the bridge and the dev server, each on its own; one
 * that misses six probes is restarted) and runs the shell's other jobs every 10 s: self-update (Updater, whose guard
 * and health rules are its own), the move to Opie's IDs (Move), the cloud link (CloudSetup), the voice models.
 *
 * One per process, not per activity: the display's activity is recreated now and then (Move's abort, a setting), and
 * each recreation used to start one more loop that was never stopped, all of them probing and restarting the bridge at
 * once. It starts with the display (MainActivity.onCreate, after it knows it's the display that runs: not one that has
 * handed the tablet over) and stops only once this display has handed over; its threads are its own, so a slow probe
 * never holds up the screen and a hung one doesn't pile up threads. What only the display's window can do (kiosk mode,
 * first-time setup's screen, opening the new display) it asks of the activity that's live, if there is one.
 *
 * Not itself a service: the runtime is this process's children (proot, Node), which go when the process goes, so
 * nothing in another component can outlive what it watches; a service in this process has the same lifetime as this
 * object. While it runs, though, a foreground service (KeepOnline) does: without one, Android cuts this UID off the
 * network whenever another app is in front, and the runtime, in the same UID, with it.
 */
internal object Watchdog {
    private const val TAG = "Watchdog"
    private const val EVERY_S = 10L
    private lateinit var app: Context
    private val main = Handler(Looper.getMainLooper())
    // Two lanes, as before: the runtime's probes, and the updater's (a check or a download can take minutes).
    private var runtime: ScheduledExecutorService? = null
    private var updates: ScheduledExecutorService? = null

    val running get() = synchronized(this) { runtime != null }

    /** Start it, once per process (again only after [stop]). The first tick comes after [firstS] seconds. */
    fun start(c: Context, firstS: Long = 15) = synchronized(this) {
        app = c.applicationContext
        KeepOnline.start(app) // every time (it's a no-op when up): started from the display, which is in front now
        if (runtime != null) return@synchronized
        fun lane(name: String) = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, name).apply { isDaemon = true } }
        // At a fixed rate: a tick that overruns (a hung server's probes time out) is followed at once, never overlapped.
        runtime = lane("watchdog").also { it.scheduleAtFixedRate({ guarded("runtime", ::runtimeTick) }, firstS, EVERY_S, TimeUnit.SECONDS) }
        updates = lane("updater").also { it.scheduleAtFixedRate({ guarded("updater", ::updaterTick) }, firstS, EVERY_S, TimeUnit.SECONDS) }
        Log.i(TAG, "started")
    }

    fun stop() = synchronized(this) {
        runtime?.shutdownNow(); updates?.shutdownNow()
        if (runtime != null) { Log.i(TAG, "stopped"); KeepOnline.stop(app) }
        runtime = null; updates = null
    }

    /** A scheduled task that throws is never run again: so nothing gets out. */
    private fun guarded(what: String, f: () -> Unit) {
        try { f() } catch (e: InterruptedException) { Thread.currentThread().interrupt() } catch (t: Throwable) { Log.w(TAG, "$what tick: $t") }
    }

    private fun shell() = app.getSharedPreferences("shell", Context.MODE_PRIVATE)
    private fun bridge() = MainActivity.bridgeUrl(shell())
    private fun answers(bridge: String) = runCatching { dev.openhouse.ui.BridgeClient.getText("$bridge/state", 3000, 5000) }.isSuccess

    private fun runtimeTick() {
        // Handed over to the new display (Move): this one only steps aside, and nothing of it runs on.
        if (Move.handedOver(app)) { main.post { MainActivity.live?.let { Move.stepAside(it); it.finish() } }; stop(); return }
        val moving = Move.prefs(app).getBoolean("moving", false)
        main.post { MainActivity.live?.watchTick(moving) }
        if (moving) return // its runtime stays stopped
        val bridge = bridge()
        if (!MainActivity.onDevice(bridge)) return
        val answers = answers(bridge)
        if (Runtime.ready()) {
            Runtime.supervise()
            OldAgent.retire(app, answers)
            if (MainActivity.micWanted(app)) VoiceModels.ensure(app, bridge)
            CloudSetup.tick(app, bridge)
        } else if (!answers) main.post { MainActivity.live?.startServices() } // first-time setup: its screen is the display's
    }

    private fun updaterTick() {
        if (Move.handedOver(app) || Move.prefs(app).getBoolean("moving", false)) return // (as the runtime's lane)
        val bridge = bridge()
        Updater.tick(app, bridge) // self-update: checks, installs when quiet, health after one
        if (Move.fromPkg != null) Move.tick(app, Updater.homeLoaded && answers(bridge))
    }
}
