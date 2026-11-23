package dev.openhouse.shell

// Settings → Plugins (docs/plugins.md §6, §11, §19). What's on the tablet: plugins from OpenHouse's list or a link, and
// the household's versions of OpenHouse's own apps ("Yours, based on Calendar 1.0"), with Remove, Put ours back, and an
// update's three choices when the household changed one (keep yours, take theirs, or both). "Add a plugin" opens
// OpenHouse's list (the gallery), with "From a link" for anything else. The bridge does the work (bridge/plugins.js);
// this is only the dialogs. Whoever opened it is already here (the lock's PIN, if it's on), so adding from here asks
// no second time; the assistant's add_plugin shows the tablet's own card instead.

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.text.InputType
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import kotlin.concurrent.thread

internal class PluginsMenu(private val act: MainActivity, private val onBack: (() -> Unit)? = null) {
    private fun get(path: String, readMs: Int = 15_000) = runCatching { JSONObject(BridgeClient.getText("${act.bridge}$path", 3000, readMs)) }.getOrNull()
    /** The answer (with "error" on a refusal), or null if the bridge didn't answer. */
    private fun post(path: String, body: JSONObject, readMs: Int = 120_000): JSONObject? = runCatching {
        val c = BridgeClient.open("${act.bridge}$path")
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 3000; c.readTimeout = readMs
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        JSONObject((if (c.responseCode < 400) c.inputStream else c.errorStream).use { it.readBytes().toString(Charsets.UTF_8) })
    }.getOrNull()
    private fun picture(name: String): Bitmap? = runCatching {
        val c = BridgeClient.open("${act.bridge}/plugins/gallery/image?name=${URLEncoder.encode(name, "UTF-8")}")
        c.connectTimeout = 3000; c.readTimeout = 15_000
        if (c.responseCode != 200) null else c.inputStream.use { BitmapFactory.decodeStream(it) }
    }.getOrNull()
    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private fun say(title: String, text: String, then: (() -> Unit)? = null) {
        CalmDialog(act).setTitle(title).setMessage(text).setPositiveButton("OK") { _, _ -> then?.invoke() }.show()
    }
    private val noBridge = "The tablet's software isn't answering right now. Try again in a minute."
    private fun objs(a: JSONArray?) = a?.let { x -> (0 until x.length()).map { x.getJSONObject(it) } }.orEmpty()
    private fun strs(a: JSONArray?) = a?.let { x -> (0 until x.length()).map { x.getString(it) } }.orEmpty()
    private fun JSONObject.str(k: String) = optString(k).takeIf { has(k) && !isNull(k) && it.isNotEmpty() }

    fun show(): Thread = thread {
        val s = get("/plugins")
        ui { if (s == null) say("Plugins", noBridge) else menu(objs(s.optJSONArray("plugins"))) }
    }

    /** Where one stands, in a line: "Yours, based on Laundry 1.0.0", or where it came from. */
    private fun standing(p: JSONObject): String {
        p.str("basedOn")?.let { return "Yours, based on $it" }
        val v = p.str("version")?.let { ", version $it" } ?: ""
        return if (p.optBoolean("reviewed")) "From OpenHouse's list$v" else "From ${p.optString("source").removePrefix("git:")}$v"
    }

    private fun menu(all: List<JSONObject>) {
        val rows = all.map { p ->
            CalmDialog.Row(p.optString("title"), standing(p) + (p.str("update")?.let { " · $it is out" } ?: "")) to { one(p) }
        } + listOf(CalmDialog.Row("Add a plugin", "From OpenHouse's list, or from a link") to { gallery() })
        CalmDialog(act).setTitle("Plugins").setWidth(860f)
            .setMessage(if (all.isEmpty()) "None added yet." else null)
            .setRows(rows.map { it.first }) { _, i -> rows[i].second() }.setNegativeButton("Back") { _, _ -> onBack?.invoke() }.show()
    }

    private fun one(p: JSONObject) {
        val title = p.optString("title")
        // The household's version of one of ours: put ours back (theirs stays in the history of changes).
        if (p.optString("kind") == "local") {
            CalmDialog(act).setTitle(title).setMessage("Yours, based on OpenHouse's ${p.optString("basedOn", title)}.")
                .setPositiveButton("Back") { _, _ -> show() }
                .setNeutralButton("Put ours back") { _, _ -> thread {
                    val r = post("/plugins/reset", JSONObject().put("name", p.optString("name")), 30_000)
                    ui { when { r == null -> say("Plugins", noBridge); r.has("error") -> say("Plugins", r.optString("error")); else -> { act.toast("OpenHouse's $title is back"); act.reloadHome(); show() } } }
                } }.show()
            return
        }
        val text = standing(p) + ".\n\n" + strs(p.optJSONArray("rights")).joinToString("\n")
        val update = p.str("update")
        CalmDialog(act).setTitle(title).setMessage(text).setWidth(860f)
            .setPositiveButton("Back") { _, _ -> show() }
            .setNegativeButton(if (update != null) "Update to $update" else "Look for an update") { _, _ -> checkUpdate(p) }
            .setNeutralButton("Remove") { _, _ -> thread {
                val r = post("/plugins/remove", JSONObject().put("name", p.optString("name")), 30_000)
                ui { when { r == null -> say("Plugins", noBridge); r.has("error") -> say("Plugins", r.optString("error")); else -> { act.toast("Removed $title"); act.reloadHome(); show() } } }
            } }.show()
    }

    // ---- an update: what it is, then (if the household changed it) their choice ----
    private fun checkUpdate(p: JSONObject) {
        act.toast("Looking…")
        thread {
            val r = post("/plugins/check", JSONObject().put("name", p.optString("name")), 60_000)
            ui {
                when {
                    r == null -> say("Plugins", noBridge)
                    r.has("error") -> say("That didn't work", r.optString("error"))
                    !r.optBoolean("newer") -> say(p.optString("title"), "This is the newest version.") { show() }
                    strs(r.optJSONArray("changedHere")).isEmpty() ->
                        CalmDialog(act).setTitle("Update ${r.optString("title")}?").setMessage(r.optString("text")).setWidth(860f)
                            .setPositiveButton("Update") { _, _ -> choose(r, "theirs") }.setNegativeButton("Cancel") { _, _ -> show() }.show()
                    else -> choices(r)
                }
            }
        }
    }

    private fun choices(r: JSONObject) {
        val title = r.optString("title"); val v = r.optString("version")
        val more = strs(r.optJSONArray("newRights"))
        val msg = "You changed $title here. Version $v is out." + (if (more.isEmpty()) "" else "\n\nIt now also asks for:\n" + more.joinToString("\n") { "- $it" })
        val rows = listOf(
            CalmDialog.Row("Keep yours", "Leave this update out") to "keep",
            CalmDialog.Row("Take theirs", "Version $v in place of your changes") to "theirs",
            CalmDialog.Row("Both", "Their changes added to yours") to "both",
        )
        CalmDialog(act).setTitle("Update $title?").setMessage(msg).setWidth(860f)
            .setRows(rows.map { it.first }) { _, i -> choose(r, rows[i].second) }
            .setNegativeButton("Cancel") { _, _ -> show() }.show()
    }

    private fun choose(c: JSONObject, choice: String) {
        val title = c.optString("title"); val v = c.optString("version")
        if (choice == "both") act.toast("Putting the two together…")
        thread {
            val r = post("/plugins/update", JSONObject().put("name", c.optString("name")).put("choice", choice), 240_000)
            ui {
                when {
                    r == null -> say("Plugins", noBridge)
                    r.optBoolean("kept") && r.has("error") -> say("Kept yours", r.optString("error")) { show() }
                    r.has("error") -> say("That didn't work", r.optString("error")) { show() }
                    choice == "keep" -> { act.toast("Kept yours"); show() }
                    choice == "both" -> say("Updated", "$title now has the changes in $v, along with yours." + (r.str("note")?.let { "\n\n$it" } ?: "")) { act.reloadHome(); show() }
                    else -> say("Updated", "$title is version $v now.") { act.reloadHome(); show() }
                }
            }
        }
    }

    // ---- the gallery: OpenHouse's list, then a link for anything else ----
    private fun gallery() {
        act.toast("Getting the list…")
        thread {
            val g = get("/plugins/gallery", 30_000)
            val list = objs(g?.optJSONArray("plugins"))
            val pics = list.filter { it.has("image") }.associate { it.optString("name") to picture(it.optString("name")) }
            ui { if (g == null) say("Plugins", noBridge) else galleryList(list, g.str("error"), pics) }
        }
    }

    private fun galleryList(list: List<JSONObject>, error: String?, pics: Map<String, Bitmap?>) {
        val rows = list.map { e ->
            val here = e.optJSONObject("installed")
            // What it uses and reaches, in the card's words (the list's own; the card says what the plugin itself asks for).
            val uses = strs(e.optJSONArray("rights")).take(2).joinToString(" ")
            val detail = listOfNotNull(
                when { here == null -> null; e.optBoolean("update") -> "On this tablet · a newer version is out"; else -> "On this tablet" },
                e.optString("description"), uses,
            ).filter { it.isNotEmpty() }.joinToString("\n")
            CalmDialog.Row(e.optString("title"), detail, image = pics[e.optString("name")]) to {
                if (here != null) installedOne(here.optString("name")) else look(e.optString("name"))
            }
        } + listOf(CalmDialog.Row("From a link", "A git link or a .tgz someone shared") to { askLink() })
        CalmDialog(act).setTitle("Add a plugin").setWidth(900f)
            .setMessage(error ?: if (list.isEmpty()) "OpenHouse's list is empty right now." else "Plugins OpenHouse has looked over.")
            .setRows(rows.map { it.first }) { _, i -> rows[i].second() }.setNegativeButton("Back") { _, _ -> show() }.show()
    }

    private fun installedOne(name: String) = thread {
        val p = objs(get("/plugins")?.optJSONArray("plugins")).find { it.optString("name") == name }
        ui { if (p == null) show() else one(p) }
    }

    private fun askLink() {
        val box = Calm.field(act, "github.com/someone/something").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        CalmDialog(act).setTitle("From a link").setMessage("A git link, or an https link to a .tgz. Only from someone you trust.").setView(box)
            .setPositiveButton("Look at it") { _, _ -> look(box.text.toString().trim()) }.setNegativeButton("Cancel") { _, _ -> gallery() }.show()
    }

    /** [source]: a link, or the name of a plugin on OpenHouse's list (the bridge fetches only its pinned tarball). */
    private fun look(source: String) {
        if (source.isEmpty()) return
        act.toast("Getting it…")
        thread {
            val r = post("/plugins/inspect", JSONObject().put("source", source))
            ui {
                when {
                    r == null -> say("Plugins", noBridge)
                    r.has("error") -> say("That didn't work", r.optString("error"))
                    r.optBoolean("already") -> say(r.optString("title"), r.optString("text"))
                    else -> CalmDialog(act).setTitle("Add ${r.optString("title")}?").setMessage(r.optString("text")).setWidth(860f)
                        .setPositiveButton("Add it") { _, _ -> add(source, r.optString("title")) }.setNegativeButton("Cancel") { _, _ -> gallery() }.show()
                }
            }
        }
    }

    private fun add(source: String, title: String) = thread {
        val r = post("/plugins/install", JSONObject().put("source", source))
        ui {
            when {
                r == null -> say("Plugins", noBridge)
                r.has("error") -> say("That didn't work", r.optString("error"))
                else -> say("Added", "$title is on the tablet.") { act.reloadHome(); show() }
            }
        }
    }
}
