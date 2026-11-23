package dev.openhouse.ui

// The heartbeat (bridge/heartbeat.js, docs/heartbeat.md) runs by itself at its default level, with nothing in
// Settings: all the tablet does here is put it to sleep with the screen (the home screen's moon).

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

object Heartbeat {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    /** Sleep now: no check-ins until morning (or until someone talks to the assistant). */
    fun sleep() = scope.launch { Openhouse.post("/heartbeat/sleep") }
}
