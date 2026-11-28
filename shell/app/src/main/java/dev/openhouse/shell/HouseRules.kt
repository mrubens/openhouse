package dev.openhouse.shell

import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * House rules: how Opie answers here (bridge/house-rules.js, docs/assistant.md "House rules"). The editor opens on the
 * rules in force, the defaults until the household changes them; Defaults puts those back. Always the PIN when one is
 * set (PinChoices.ALWAYS); Opie changing them asks on the device's own card.
 * Kept in its own file so it can move with Settings.
 */
internal object HouseRules {
    fun open(act: MainActivity, back: () -> Unit) = act.lock.always("PIN") { show(act, back) } // always the PIN when one is set (PinChoices.ALWAYS)

    private fun show(act: MainActivity, back: () -> Unit) = thread {
        val now = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/household/rules", 3000, 8000)) }.getOrNull()
        act.runOnUiThread {
            if (now == null) return@runOnUiThread act.toast("The device's software isn't answering right now")
            val box = Calm.field(act, "One rule a line", 18f).apply {
                setText(now.optString("text")); isSingleLine = false; minLines = 6; maxLines = 12
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                gravity = android.view.Gravity.TOP or android.view.Gravity.START
                filters = arrayOf(android.text.InputFilter.LengthFilter(1500)) // (bridge RULES_MAX)
            }
            val d = CalmDialog(act).setTitle("House rules").setView(box).setWidth(1000f)
                .setPositiveButton("Save") { _, _ -> save(act, JSONObject().put("text", box.text.toString())) }
                .setNegativeButton("Cancel") { _, _ -> back() }
            // Back to the original rules, only once they've been changed.
            if (!now.optBoolean("defaults")) d.setNeutralButton("Defaults") { _, _ -> save(act, JSONObject().put("defaults", true)) }
            d.show()
        }
    }

    private fun save(act: MainActivity, body: JSONObject) = thread {
        val (code, _) = CloudSetup.post("${act.bridge}/household/rules", body)
        act.runOnUiThread { act.toast(if (code == 200) "Saved" else "Not saved. Try again in a minute") }
    }
}
