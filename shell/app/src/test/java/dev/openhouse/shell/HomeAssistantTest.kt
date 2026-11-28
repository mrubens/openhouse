package dev.openhouse.shell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The shell's copy of bridge/devices/ha-rules.js: locks, doors, alarms and cameras are never reached. */
class HomeAssistantTest {
    private fun b(vararg kv: Pair<String, Any>) = JSONObject().apply { kv.forEach { (k, v) -> put(k, v) } }

    @Test fun onlyTheFirstSliceIsReachable() {
        assertNull(HomeAssistant.refuse("POST", "/api/services/light/turn_on", b("entity_id" to "light.kitchen", "brightness_pct" to 40)))
        assertNull(HomeAssistant.refuse("GET", "/api/states/climate.hall", null))
        for ((m, p, body) in listOf(
            Triple("POST", "/api/services/lock/unlock", b("entity_id" to "lock.front_door")),
            Triple("POST", "/api/services/cover/open_cover", b("entity_id" to "cover.garage_door")),
            Triple("POST", "/api/services/alarm_control_panel/alarm_disarm", b("entity_id" to "alarm_control_panel.home")),
            Triple("GET", "/api/states/camera.porch", null), Triple("GET", "/api/camera_proxy/camera.porch", null),
            Triple("POST", "/api/services/climate/set_temperature", b("entity_id" to "climate.hall", "temperature" to 30)),
            Triple("POST", "/api/services/light/turn_on", b("entity_id" to "lock.front_door")),
            Triple("POST", "/api/services/light/turn_on", b("entity_id" to "light.kitchen", "code" to "1234")),
            Triple("POST", "/api/services/homeassistant/turn_on", b("entity_id" to "light.kitchen")),
            Triple("POST", "/api/template", b("template" to "{{ states.lock }}")),
            Triple("DELETE", "/api/states/light.kitchen", null),
        )) assertNotNull("$m $p", HomeAssistant.refuse(m, p, body))
    }

    @Test fun aSceneThatSetsALockIsNeverTurnedOn() {
        fun scene(vararg e: String) = b("entity_id" to "scene.x", "attributes" to b("entity_id" to JSONArray(e.toList())))
        assertTrue(HomeAssistant.sceneOk(scene("light.kitchen", "light.porch")))
        assertFalse(HomeAssistant.sceneOk(scene("light.kitchen", "lock.front_door")))
        assertFalse(HomeAssistant.sceneOk(b("entity_id" to "scene.x", "attributes" to b()))) // (what it sets isn't known)
    }

    @Test fun whatComesBackHasNothingShutOutInIt() {
        val all = JSONArray(listOf(b("entity_id" to "light.kitchen"), b("entity_id" to "lock.front_door"), b("entity_id" to "camera.porch"))).toString()
        val shown = HomeAssistant.shown("/api/states", all) as JSONArray
        assertEquals(1, shown.length())
        assertEquals("light.kitchen", shown.getJSONObject(0).getString("entity_id"))
        assertEquals("http://192.168.1.20:8123", HomeAssistant.cleanUrl("192.168.1.20"))
        assertNull(HomeAssistant.cleanUrl("http://user:pw@192.168.1.20:8123/api"))
    }
}
