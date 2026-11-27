package dev.openhouse.shell

import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * House rules: the household's own few lines on how Opie answers here, on top of its defaults (bridge/house-rules.js,
 * docs/assistant.md "In this home"). Empty means only the defaults. A setting: with Change settings asking for the PIN
 * (PinChoices.SETTINGS), it's asked for before the editor opens (straight on within the grace, as from Settings → Voice);
 * Opie changing them asks on the tablet's own card.
 * Kept in its own file so it can move with Settings.
 */
internal object HouseRules {
    fun open(act: MainActivity, back: () -> Unit) = act.lock.withPin { show(act, back) }

    private fun show(act: MainActivity, back: () -> Unit) = thread {
        val now = runCatching { JSONObject(BridgeClient.getText("${act.bridge}/household", 3000, 8000)) }.getOrNull()
        act.runOnUiThread {
            if (now == null) return@runOnUiThread act.toast("The tablet's software isn't answering right now")
            val box = Calm.field(act, "Adults use this too; the news is fine to talk about.", 18f).apply {
                setText(now.optString("rules")); isSingleLine = false; minLines = 4; maxLines = 10
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                gravity = android.view.Gravity.TOP or android.view.Gravity.START
                filters = arrayOf(android.text.InputFilter.LengthFilter(600)) // (bridge RULES_MAX)
            }
            CalmDialog(act).setTitle("House rules").setMessage("Opie already answers as if a kid may be listening.").setView(box).setWidth(1000f)
                .setPositiveButton("Save") { _, _ -> save(act, box.text.toString()) }
                .setNegativeButton("Cancel") { _, _ -> back() }.show()
        }
    }

    private fun save(act: MainActivity, text: String) = thread {
        val (code, _) = CloudSetup.post("${act.bridge}/household/rules", JSONObject().put("text", text))
        act.runOnUiThread { act.toast(if (code == 200) "Saved" else "Not saved. Try again in a minute") }
    }
}
