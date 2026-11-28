package dev.openhouse.shell

import android.app.Activity
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.CalmDialog
import dev.openhouse.ui.Openhouse
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Settings → Screen → Tabs: each tab with a switch, then Home's own cards. Off takes a tab out of the sidebar (a card off
 * Home); on puts it back where it was (bridge home-screen.js switchOne, POST /home/look {switch}). Home can't be switched
 * off, so it isn't listed. Moving and renaming tabs, and the colors, stay with Opie (set_home). No PIN: it's how Home
 * looks, as the Apps tab's own Make it a tab.
 */
object TabSwitches {
    private val sends = java.util.concurrent.Executors.newSingleThreadExecutor()
    private fun url(p: String) = Openhouse.bridgeUrl + p
    private fun load(): JSONObject? = runCatching { JSONObject(BridgeClient.getText(url("/home/switches"), 3000, 8000)) }.getOrNull()

    /** What the row shows: how many tabs are on (Home among them). */
    fun label(): String? = load()?.optJSONArray("tabs")?.let { a -> "${(0 until a.length()).count { a.optJSONObject(it)?.optBoolean("on") == true }} on" }

    fun choose(a: Activity, immersive: () -> Unit, done: () -> Unit) {
        thread { val s = load(); a.runOnUiThread { if (s != null) page(a, s, immersive, done) else android.widget.Toast.makeText(a, "Try again in a moment", android.widget.Toast.LENGTH_SHORT).show() } }
    }

    private fun page(a: Activity, s: JSONObject, immersive: () -> Unit, done: () -> Unit) {
        val items = mutableListOf<Pair<CalmDialog.Row, JSONObject?>>()
        val tabs = s.optJSONArray("tabs"); val cards = s.optJSONArray("cards")
        for (i in 0 until (tabs?.length() ?: 0)) tabs!!.optJSONObject(i)?.takeIf { !it.optBoolean("fixed") }?.let {
            items += CalmDialog.Row(it.optString("name"), value = if (it.optBoolean("on")) "On" else "Off") to JSONObject().put("tab", it.optString("id")).put("on", !it.optBoolean("on"))
        }
        items += CalmDialog.Row("Cards on Home", header = true) to null
        for (i in 0 until (cards?.length() ?: 0)) cards!!.optJSONObject(i)?.let {
            items += CalmDialog.Row(it.optString("name"), value = if (it.optBoolean("on")) "On" else "Off") to JSONObject().put("card", it.optString("id")).put("on", !it.optBoolean("on"))
        }
        CalmDialog(a).setTitle("Tabs").setRows(items.map { it.first }) { _, i ->
            val sw = items[i].second ?: return@setRows
            // Shown switched at once, while the change goes to the bridge (one after another, in the order tapped).
            val list = if (sw.has("tab")) tabs else cards; val k = if (sw.has("tab")) "tab" else "card"
            for (j in 0 until (list?.length() ?: 0)) list!!.optJSONObject(j)?.takeIf { it.optString("id") == sw.optString(k) }?.put("on", sw.optBoolean("on"))
            page(a, s, immersive, done)
            sends.execute {
                BridgeClient.post(url("/home/look"), JSONObject().put("switch", sw).toString(), 3000, 15000)
                a.runOnUiThread { done() }
            }
        }.setNegativeButton("Close", null).show().also { immersive() }
    }
}
