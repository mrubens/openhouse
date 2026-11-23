package dev.openhouse.shell

// Settings → Backups: where backups are kept (the cloud, a USB drive), back up now, restore, the family's
// recovery code (shown with a QR code, or sent to a phone), and whether OpenHouse keeps a copy of that code (off unless
// someone turns it on). The bridge does the work (bridge/backup.js); this is only the dialogs.

import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import android.graphics.Typeface
import android.text.InputType
import android.view.Gravity
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.openhouse.ui.BridgeClient
import org.json.JSONObject
import kotlin.concurrent.thread

internal class BackupMenu(private val act: MainActivity, private val onBack: (() -> Unit)? = null) {
    private fun get(path: String, readMs: Int = 30_000) = runCatching { JSONObject(BridgeClient.getText("${act.bridge}$path", 3000, readMs)) }.getOrNull()
    /** The answer (with "error" on a refusal), or null if the bridge didn't answer. */
    private fun post(path: String, body: JSONObject = JSONObject(), readMs: Int = 30_000): JSONObject? = runCatching {
        val c = BridgeClient.open("${act.bridge}$path")
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = readMs
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        JSONObject((if (c.responseCode < 400) c.inputStream else c.errorStream).use { it.readBytes().toString(Charsets.UTF_8) })
    }.getOrNull()
    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private fun CalmDialog.open(): android.app.Dialog = show() // the shared look (ui/Calm.kt)
    private fun say(title: String, text: String, then: (() -> Unit)? = null) {
        CalmDialog(act).setTitle(title).setMessage(text).setPositiveButton("Close") { _, _ -> then?.invoke() }.open()
    }
    private val noBridge = "The tablet's software isn't answering right now. Try again in a minute."
    private fun pad(v: LinearLayout) = v.apply { orientation = LinearLayout.VERTICAL }

    private fun ago(iso: String?): String {
        val t = runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull() ?: return "never"
        val m = (System.currentTimeMillis() - t) / 60_000
        return when { m < 2 -> "just now"; m < 90 -> "$m minutes ago"; m < 36 * 60 -> "${m / 60} hours ago"; else -> "${m / 1440} days ago" }
    }

    fun show(): Thread = thread {
        val s = get("/backup/status", 10_000)
        ui { if (s == null) say("Backups", noBridge) else menu(s) }
    }

    private fun menu(s: JSONObject) {
        val dests = s.optJSONArray("dests")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) } }.orEmpty()
        val cloud = dests.firstOrNull { it.optString("id") == "cloud" }
        val drive = dests.firstOrNull { it.optString("id") == "drive" }
        val on = dests.filter { it.optBoolean("on") }
        val where = on.joinToString(" and ") { if (it.optString("id") == "cloud") "the cloud" else "the USB drive" + (it.optString("name").takeIf { n -> n.isNotEmpty() && !it.isNull("name") }?.let { n -> " ($n)" } ?: "") }
        val last = s.optJSONObject("last")
        val text = when {
                on.isEmpty() -> "Off."
                last == null -> "Each night, to $where."
                last.optBoolean("ok") -> "Each night, to $where. Last: ${ago(last.optString("at"))}."
                else -> "The last backup didn't work (${ago(last.optString("at"))}): ${last.optString("error")}"
            }
        val escrow = s.optJSONObject("escrow") ?: JSONObject()
        val hasKey = s.optJSONObject("key")?.optBoolean("has") == true
        // Rows with their value at the right, as Settings (docs/ux.md): a switch is its row.
        fun onOff(b: Boolean) = if (b) "On" else "Off"
        val items = mutableListOf<Pair<CalmDialog.Row, () -> Unit>>()
        if (cloud != null) items += CalmDialog.Row("The cloud", value = onOff(cloud.optBoolean("on"))) to {
            if (cloud.optBoolean("on")) setDest("cloud", false) else if (!cloud.optBoolean("ready")) say("The cloud", cloud.optString("why")) else setDest("cloud", true)
        }
        if (drive != null) items += CalmDialog.Row("USB drive", value = onOff(drive.optBoolean("on"))) to {
            if (drive.optBoolean("on")) setDest("drive", false) else if (drive.optBoolean("ready")) setDest("drive", true) else chooseDrive()
        }
        if (drive?.optBoolean("on") == true) items += CalmDialog.Row("Change the USB drive") to { chooseDrive() }
        if (on.isNotEmpty()) items += CalmDialog.Row("Back up now") to { backUpNow() }
        items += CalmDialog.Row("Restore") to { restoreList() }
        if (hasKey) items += CalmDialog.Row("Recovery code") to { showCode(first = false) }
        if (hasKey && escrow.optBoolean("available")) items += CalmDialog.Row("OpenHouse keeps a copy", value = onOff(escrow.optBoolean("on"))) to { escrowAsk(!escrow.optBoolean("on")) }
        CalmDialog(act).setTitle("Backups").setMessage(text)
            .setRows(items.map { it.first }) { _, i -> items[i].second() }.setNegativeButton("Back") { _, _ -> onBack?.invoke() }.open()
    }

    private fun chooseDrive() = BackupDrive.choose(act) { }
    /** After the picker (BackupDrive.picked): backups to that drive on. */
    fun driveChosen() { setDest("drive", true) }

    /** Nightly backups to the cloud on (the first-run offer, CloudSetup): the recovery code, then the copy offer. */
    internal fun turnOnCloud() = setDest("cloud", true)

    private fun setDest(id: String, on: Boolean): Thread = thread {
        // Right after the picker the display may have been restarted, and its software takes a moment to come back.
        var r = post("/backup/dest", JSONObject().put("id", id).put("on", on))
        for (i in 0 until 30) { if (r != null) break; if (i == 0) ui { act.toast("One moment…") }; Thread.sleep(2000); r = post("/backup/dest", JSONObject().put("id", id).put("on", on)) }
        ui {
            if (r == null || r.has("error")) return@ui say("Backups", r?.optString("error") ?: noBridge)
            val code = r.optString("recoveryCode").takeIf { it.isNotEmpty() && !r.isNull("recoveryCode") }
            // The copy with OpenHouse is offered once, when the cloud is first turned on (off unless they say yes).
            val prefs = act.getSharedPreferences("backup_menu", android.content.Context.MODE_PRIVATE)
            val offer = id == "cloud" && on && !prefs.getBoolean("escrow_offered", false)
            val next: () -> Unit = { if (offer) { prefs.edit().putBoolean("escrow_offered", true).apply(); escrowAsk(true, setup = true) } else { show() } }
            if (code != null) showCode(first = true, known = code, then = next)
            else { act.toast(if (on) "Backups on" else "Backups off there"); next() }
        }
    }

    /** The family's recovery code: the only key to the backups, unless they asked OpenHouse to keep a copy. */
    private fun showCode(first: Boolean, known: String? = null, then: () -> Unit = { show() }): Thread = thread {
        val code = known ?: get("/backup/recovery-code")?.optString("code")
        ui {
            if (code.isNullOrEmpty()) return@ui say("Recovery code", noBridge)
            val box = pad(LinearLayout(act))
            box.addView(Calm.text(act, "Without it, nobody can open a backup. Keep it somewhere safe.", 19f, 400, Calm.SOFT))
            val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, 24, 0, 8) }
            runCatching { Handoff.qr(code, 280) }.getOrNull()?.let { bmp -> row.addView(ImageView(act).apply { setImageBitmap(bmp) }, LinearLayout.LayoutParams(280, 280)) }
            row.addView(Calm.text(act, code.split("-").chunked(4).joinToString("\n") { it.joinToString("-") }, 34f, 600).apply { letterSpacing = .06f; setPadding(Calm.px(act, 40), 0, 0, 0); setTextIsSelectable(true) })
            box.addView(row)
            CalmDialog(act).setTitle("Your recovery code").setView(box).setCancelable(!first)
                .setMore("Backups are locked with it before they leave the tablet. Take a photo, print it, keep it in a password manager, or send it to your phone. A backup on another tablet needs it.")
                .setPositiveButton(if (first) "I've saved it" else "Done") { _, _ -> if (first) thread { post("/backup/recovery-code/confirmed"); ui(then) } }
                .setNeutralButton("Send to my phone") { _, _ -> sendToPhone(code) { showCode(first, code, then) } }
                .open()
        }
    }

    /** The code to a phone on the home Wi-Fi (Handoff: sealed with a key that's only in the QR code), for 5 minutes. */
    private fun sendToPhone(code: String, back: () -> Unit) {
        val info = JSONObject().put("title", "Your family's recovery code").put("code", code)
            .put("help", "Backups of the display are locked with this code. You need it to put a backup on another tablet.")
        lateinit var d: android.app.Dialog
        val h = Handoff(act, info, minutes = 5, page = "recovery.html", onEnd = { if (d.isShowing) d.dismiss() })
        if (!h.start()) return say("Send to my phone", "The tablet isn't on Wi-Fi, so it can't reach your phone.") { back() }
        val box = pad(LinearLayout(act))
        box.addView(Calm.text(act, "Scan with a phone on this Wi-Fi.", 19f, 400, Calm.SOFT))
        runCatching { Handoff.qr(h.url!!, 360) }.getOrNull()?.let { bmp -> box.addView(ImageView(act).apply { setImageBitmap(bmp); setPadding(0, 24, 0, 0) }, LinearLayout.LayoutParams(-1, 384)) }
        d = CalmDialog(act).setTitle("Send to my phone").setView(box).setMore("It goes straight to the phone, sealed. Nothing is sent over the internet.").setPositiveButton("Done") { _, _ -> h.stop(); back() }.setCancelable(false).open()
    }

    /** Keep a copy of the code with OpenHouse: off unless someone says yes here, and it says plainly what that means. */
    private fun escrowAsk(on: Boolean, setup: Boolean = false) {
        if (!on) {
            CalmDialog(act).setTitle("Delete OpenHouse's copy of the code?").setMessage("Then only you can open your backups.").setDanger()
                .setPositiveButton("Delete") { _, _ -> escrowSet(false) }.setNegativeButton("Cancel", null).open()
            return
        }
        // At setup the private choice is the main button; asked from Backups, the one they tapped is.
        val d = CalmDialog(act).setTitle("Let OpenHouse keep a copy of the code?")
            .setMessage("Then OpenHouse could open your backups too.")
            .setMore("If you lose the code and the tablet, OpenHouse could still give your backups back: your apps, chats, household and photos. Most households keep the code themselves. This can change later in Backups.")
        if (setup) d.setPositiveButton("Just us") { _, _ -> show() }.setNegativeButton("Keep a copy") { _, _ -> escrowSet(true) }
        else d.setPositiveButton("Keep a copy") { _, _ -> escrowSet(true) }.setNegativeButton("Cancel", null)
        d.setCancelable(false).open()
    }
    private fun escrowSet(on: Boolean): Thread = thread {
        val r = post("/backup/escrow", JSONObject().put("on", on))
        ui { if (r == null || r.has("error")) say("Recovery code", r?.optString("error") ?: noBridge) { show() } else { act.toast(if (on) "OpenHouse keeps a copy of the code" else "OpenHouse's copy deleted"); show() } }
    }

    private fun backUpNow() = thread {
        val r = post("/backup/now")
        if (r == null || r.has("error")) return@thread ui { say("Back up now", r?.optString("error") ?: noBridge) }
        val text = TextView(act)
        var d: android.app.Dialog? = null
        ui { text.apply { this.text = "Packing up…"; setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, Calm.BODY * Calm.u(act)); typeface = Calm.face(act); setTextColor(Calm.SOFT) }; d = CalmDialog(act).setTitle("Backing up").setView(text).setNegativeButton("Hide", null).open() }
        val words = mapOf("packing" to "Packing up…", "locking" to "Locking it with your code…", "sending:cloud" to "Sending it to the cloud…", "sending:drive" to "Copying it to the USB drive…")
        while (true) {
            Thread.sleep(1000)
            val s = get("/backup/status", 10_000) ?: continue
            val job = s.optJSONObject("job")
            if (job != null) { ui { text.text = words[job.optString("step")] ?: "Working…" }; continue }
            val last = s.optJSONObject("last")
            ui { d?.dismiss(); if (last?.optBoolean("ok") == true) act.toast("Backed up") else say("Back up now", "It didn't work: ${last?.optString("error") ?: "unknown"}") }
            return@thread
        }
    }

    private fun restoreList() = thread {
        val r = get("/backup/list", 60_000)
        ui {
            if (r == null || r.has("error")) return@ui say("Restore", r?.optString("error") ?: noBridge)
            val list = r.optJSONArray("backups")
            val missing = r.optJSONArray("missing")?.let { a -> (0 until a.length()).joinToString("\n") { a.getJSONObject(it).optString("why") } }.orEmpty()
            if (list == null || list.length() == 0) return@ui say("Restore", "There are no backups to restore from yet." + if (missing.isNotEmpty()) "\n\n$missing" else "")
            val fmt = java.time.format.DateTimeFormatter.ofPattern("EEE d MMM, h:mm a").withZone(java.time.ZoneId.systemDefault())
            val rows = (0 until list.length()).map { list.getJSONObject(it) }
            val dates = rows.map { runCatching { fmt.format(java.time.Instant.parse(it.optString("createdAt"))) }.getOrDefault(it.optString("createdAt")) }
            val labels = rows.mapIndexed { i, b ->
                listOfNotNull(dates[i], if (b.optString("dest") == "cloud") "cloud" else "USB drive", b.optString("deviceName").takeIf { it.isNotEmpty() && !b.isNull("deviceName") },
                    "%.1f MB".format(b.optLong("size") / 1e6), if (b.optString("kind") == "manual") "by hand" else null).joinToString(" · ")
            }
            CalmDialog(act).setTitle("Restore which backup?").setItems(labels.toTypedArray()) { _, i -> confirmRestore(rows[i], dates[i]) }
                .setNegativeButton("Cancel", null).open()
        }
    }

    private fun confirmRestore(b: JSONObject, date: String) {
        CalmDialog(act).setTitle("Restore the backup from $date?").setMessage("The apps, chats, household and photos here are replaced.").setDanger()
            .setMore("What is here now is kept aside on the tablet until the next restore.")
            .setPositiveButton("Restore") { _, _ -> restore(b, null) }
            .setNegativeButton("Cancel", null).open()
    }

    private fun askCode(b: JSONObject, again: Boolean = false) {
        val box = Calm.field(act, "XXXX-XXXX-…").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS; letterSpacing = .06f }
        CalmDialog(act).setTitle(if (again) "That code doesn't fit" else "Recovery code")
            .setMessage("This backup has another recovery code. Type that one.").setView(box)
            .setPositiveButton("Restore") { _, _ -> restore(b, box.text.toString()) }.setNegativeButton("Cancel", null).open()
    }

    private fun restore(b: JSONObject, code: String?) {
        val text = Calm.text(act, "Restoring. This can take a few minutes; leave the tablet on.", Calm.BODY, 400, Calm.SOFT)
        val d = CalmDialog(act).setTitle("Restoring").setView(text).setCancelable(false).open()
        thread {
            val body = JSONObject().put("dest", b.optString("dest")).put("id", b.optString("id")).apply {
                b.optString("deviceId").takeIf { it.isNotEmpty() && !b.isNull("deviceId") }?.let { put("deviceId", it) }
                if (code != null) put("recoveryCode", code)
            }
            val r = post("/backup/restore", body, readMs = 30 * 60_000)
            ui {
                d.dismiss()
                when {
                    r == null -> say("Restore", noBridge)
                    r.optString("code") == "wrongcode" || r.optString("code") == "needcode" -> askCode(b, again = r.optString("code") == "wrongcode")
                    r.has("error") -> say("Restore", "It didn't work: ${r.optString("error")}")
                    // The bridge starts again on what came back; then the screen reloads.
                    else -> { act.toast("Restored. The screen reloads in a moment."); act.window.decorView.postDelayed({ act.reloadHome() }, 8000) }
                }
            }
        }
    }
}
