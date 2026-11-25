package dev.openhouse.shell

// Settings → Plugins (docs/plugins.md §6, §11, §19). What's on the tablet: plugins from Opie's list or a link, and
// the household's versions of Opie's own apps ("Yours, based on Calendar 1.0"), with Remove, Put ours back, and an
// update's three choices when the household changed one (keep yours, take theirs, or both). "Add a plugin" opens
// Opie's list (the gallery), with "From a link" for anything else. The bridge does the work (bridge/plugins.js);
// this is only the dialogs. Adding gets the tablet's own card, the same one the assistant's add_plugin gets (the
// bridge asks it through DeviceServer /approve), so what someone says yes to is what goes in.

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

// From the Apps tab ([fromApps]): the gallery alone, nobody has given the PIN yet, so adding, removing and updating ask
// for it (askPin; none set, none asked), and Back closes it.
internal class PluginsMenu(private val act: MainActivity, private val fromApps: Boolean = false, private val onBack: (() -> Unit)? = null) {
    companion object {
        /** "Make an app" (here, and the Apps tab's): Settings put away, the typing box open with [note] over it and
         *  "Make " already typed, so they say what. Opie's make_app does the rest (bridge/live-tools.js). */
        fun makeApp(note: String) {
            val o = dev.openhouse.ui.Openhouse
            o.showSettings = false
            o.openTyping(note = note, seed = "Make ")
        }

        /** An app to ask for, in the household's own names: the children's (an age for a note), else anyone's
         *  (chat/src/home.jsx makeExample says the same on the Apps tab and the phone). */
        fun example(family: List<JSONObject>): String {
            val people = family.filter { !Regex("\\b(dog|cat|pet|fish|bird|hamster|rabbit)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it.optString("note")) && it.optString("name").isNotBlank() }
            val kids = people.filter { it.optString("note").trim().toIntOrNull()?.let { n -> n < 18 } == true && it.optString("note").trim().length <= 2 }
            val names = (kids.ifEmpty { people }).take(2).map { it.optString("name") }
            return if (names.isEmpty()) "Make a countdown to our next trip" else "Make a reading streak for ${names.joinToString(" and ")}"
        }
    }

    /** Where a dialog goes back to: Settings' list of plugins, or (from the Apps tab) the gallery. */
    private fun home() { if (fromApps) gallery() else show() }
    private fun guard(f: () -> Unit) { if (fromApps) askPin(act, act, "PIN", f) else f() }
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
        CalmDialog(act).setTitle(title).setMessage(text).setPositiveButton("Close") { _, _ -> then?.invoke() }.show()
    }
    /** A card's rights, (kind, words) ([Calm.rights]). */
    private fun rightsOf(a: JSONArray?) = objs(a).map { it.optString("kind") to it.optString("text") }
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
        return if (p.optBoolean("reviewed")) "From Opie's list$v" else "From ${p.optString("source").removePrefix("git:")}$v"
    }

    private fun menu(all: List<JSONObject>) {
        val rows = all.map { p ->
            CalmDialog.Row(p.optString("title"), standing(p) + (p.str("update")?.let { " · $it is out" } ?: "")) to { one(p) }
        } + listOf(CalmDialog.Row("Add a plugin") to { gallery() })
        CalmDialog(act).setTitle("Plugins").setWidth(860f)
            .setRows(rows.map { it.first }) { _, i -> rows[i].second() }.setNegativeButton("Back") { _, _ -> onBack?.invoke() }.show()
    }

    private fun one(p: JSONObject) {
        val title = p.optString("title")
        // The household's version of one of ours: put ours back (theirs stays in the history of changes).
        if (p.optString("kind") == "local") {
            CalmDialog(act).setTitle(title).setMessage("Yours, based on Opie's ${p.optString("basedOn", title)}.")
                .setNegativeButton("Back") { _, _ -> home() }
                .setPositiveButton("Put ours back") { _, _ -> guard { thread {
                    val r = post("/plugins/reset", JSONObject().put("name", p.optString("name")), 30_000)
                    ui { when { r == null -> say("Plugins", noBridge); r.has("error") -> say("Plugins", r.optString("error")); else -> { act.toast("Opie's $title is back"); act.reloadHome(); home() } } }
                } } }.show()
            return
        }
        // What it may do, then two quiet rows for the rarer things (docs/ux.md: no third button).
        val update = p.str("update")
        val rows = listOf(
            CalmDialog.Row(if (update != null) "Update to $update" else "Look for an update") to { checkUpdate(p) },
            CalmDialog.Row("Remove $title") to { remove(p) },
        )
        CalmDialog(act).setTitle(title).setMessage(standing(p) + ".").setWidth(860f)
            .setRights(rightsOf(p.optJSONArray("rightsCard")))
            .setRows(rows.map { it.first }) { _, i -> rows[i].second() }
            .setNegativeButton("Back") { _, _ -> home() }.show()
    }

    private fun remove(p: JSONObject) {
        val title = p.optString("title")
        CalmDialog(act).setTitle("Remove $title?").setDanger()
            .setPositiveButton("Remove") { _, _ -> guard { thread {
                val r = post("/plugins/remove", JSONObject().put("name", p.optString("name")), 30_000)
                ui { when { r == null -> say("Plugins", noBridge); r.has("error") -> say("Plugins", r.optString("error")); else -> { act.toast("Removed $title"); act.reloadHome(); home() } } }
            } } }
            .setNegativeButton("Cancel") { _, _ -> one(p) }.show()
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
                    !r.optBoolean("newer") -> say(p.optString("title"), "This is the newest version.") { home() }
                    // the bridge asks on the tablet's own card (what's new, everything it may do, the PIN), as Add does
                    strs(r.optJSONArray("changedHere")).isEmpty() -> choose(r, "theirs")
                    else -> choices(r)
                }
            }
        }
    }

    private fun choices(r: JSONObject) {
        val title = r.optString("title"); val v = r.optString("version")
        val msg = "You changed it here. Version $v is out."
        val rows = listOf(
            CalmDialog.Row("Keep yours", "Leave this update out") to "keep",
            CalmDialog.Row("Take theirs", "Version $v in place of your changes") to "theirs",
            CalmDialog.Row("Both", "Their changes added to yours") to "both",
        )
        CalmDialog(act).setTitle("Update $title?").setMessage(msg).setWidth(860f)
            .setRights(rightsOf(r.optJSONArray("rights")).filter { it.first == "new" })
            .setRows(rows.map { it.first }) { _, i -> choose(r, rows[i].second) }
            .setNegativeButton("Cancel") { _, _ -> home() }.show()
    }

    private fun choose(c: JSONObject, choice: String) = guard {
        val title = c.optString("title"); val v = c.optString("version")
        if (choice == "both") act.toast("Putting the two together…")
        thread {
            val r = post("/plugins/update", JSONObject().put("name", c.optString("name")).put("hash", c.optString("hash")).put("choice", choice), 240_000)
            ui {
                when {
                    r == null -> say("Plugins", noBridge)
                    r.optBoolean("declined") -> home()
                    r.optBoolean("kept") && r.has("error") -> say("Kept yours", r.optString("error")) { home() }
                    r.has("error") -> say("That didn't work", r.optString("error")) { home() }
                    choice == "keep" -> { act.toast("Kept yours"); home() }
                    choice == "both" -> { act.toast("Updated $title"); act.reloadHome(); home() }
                    else -> { act.toast("Updated $title"); act.reloadHome(); home() }
                }
            }
        }
    }

    // ---- the gallery: Opie's list, then a link for anything else ----
    fun gallery() {
        act.toast("Getting the list…")
        thread {
            val g = get("/plugins/gallery", 30_000)
            val list = objs(g?.optJSONArray("plugins"))
            val pics = list.filter { it.has("image") }.associate { it.optString("name") to picture(it.optString("name")) }
            val family = objs(get("/household")?.optJSONArray("family"))
            ui { if (g == null) say("Plugins", noBridge) else galleryList(list, g.str("error"), pics, family) }
        }
    }

    /**
     * Two halves (one above the other on a narrow screen): "Find an app", Opie's list with a search box that
     * filters by name and description as you type (a tap goes on to the card, as before), and "Make your own":
     * asking Opie, with an example in the household's names and "Make an app" (the typing box, ready for it), then
     * connecting Claude or ChatGPT on a computer for bigger work, with a button for that pairing step.
     */
    private fun galleryList(list: List<JSONObject>, error: String?, pics: Map<String, Bitmap?>, family: List<JSONObject>) {
        val c = act
        val u = Calm.u(c)
        val wide = c.resources.displayMetrics.widthPixels / u >= 1300
        var dialog: android.app.Dialog? = null
        fun go(f: () -> Unit) { dialog?.dismiss(); f() }

        // ---- Find an app ----
        val rows = Calm.column(c)
        fun line(title: String, detail: String?, image: Bitmap?, onTap: () -> Unit) = Calm.row(c).apply {
            val rr = 16 * u
            background = Calm.pressable(c, Calm.rounded(0x00FFFFFF, rr), rr); isClickable = true
            minimumHeight = Calm.px(c, 72); setPadding(Calm.px(c, 16), Calm.px(c, 12), Calm.px(c, 16), Calm.px(c, 12))
            image?.let { b -> addView(android.widget.ImageView(c).apply { setImageBitmap(b); scaleType = android.widget.ImageView.ScaleType.CENTER_CROP; clipToOutline = true; background = Calm.rounded(Calm.TINT2, 12 * u) },
                android.widget.LinearLayout.LayoutParams(Calm.px(c, 96), Calm.px(c, 66)).apply { rightMargin = Calm.px(c, 18) }) }
            addView(Calm.column(c, 4).apply {
                addView(Calm.text(c, title, 22f, 500))
                detail?.takeIf { it.isNotEmpty() }?.let { addView(Calm.text(c, it, 17f, 400, Calm.SOFT).apply { maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END }) }
            }, android.widget.LinearLayout.LayoutParams(0, -2, 1f))
            setOnClickListener { go(onTap) }
        }
        fun fill(q: String) {
            rows.removeAllViews()
            val words = q.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
            val shown = list.filter { e -> val hay = (e.optString("title") + " " + e.optString("description")).lowercase(); words.all { hay.contains(it) } }
            for (e in shown) {
                val here = e.optJSONObject("installed")
                val detail = when { here == null -> e.optString("description"); e.optBoolean("update") -> "On this tablet · a newer version is out"; else -> "On this tablet" }
                rows.addView(line(e.optString("title"), detail, pics[e.optString("name")]) { if (here != null) installedOne(here.optString("name")) else look(e.optString("name")) })
            }
            if (shown.isEmpty()) rows.addView(Calm.text(c, error ?: if (list.isEmpty()) "Opie's list is empty right now." else "Nothing called that.", 19f, 400, Calm.SOFT).apply { setPadding(Calm.px(c, 16), Calm.px(c, 16), 0, Calm.px(c, 16)) })
            rows.addView(line("From a link", "A git or .tgz link someone shared", null) { askLink() })
        }
        val search = Calm.field(c, "Search", 22f).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(e: android.text.Editable?) { fill(e?.toString().orEmpty()) }
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, n: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, n: Int) {}
            })
        }
        fill("")
        val screenH = c.resources.displayMetrics.let { minOf(it.widthPixels, it.heightPixels) }
        val find = Calm.column(c).apply {
            addView(Calm.eyebrow(c, "Find an app"))
            addView(search, android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 14) })
            addView(Calm.Capped(c, (screenH * (if (wide) .52f else .3f)).toInt()).apply { addView(rows); isVerticalScrollBarEnabled = false },
                android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 10); leftMargin = -Calm.px(c, 16); rightMargin = -Calm.px(c, 16) })
        }

        // ---- Make your own: ask Opie (it builds it here, bridge/builder.js); a computer for bigger work ----
        val first = example(family)
        val make = Calm.column(c).apply {
            setPadding(Calm.px(c, 32), Calm.px(c, 28), Calm.px(c, 32), Calm.px(c, 32))
            background = Calm.rounded(Calm.TINT, 24 * u)
            addView(Calm.eyebrow(c, "Make your own"))
            addView(Calm.text(c, "Ask Opie for the app you want, out loud or typed, and it builds it here.", 21f, 400).apply { setPadding(0, Calm.px(c, 14), 0, Calm.px(c, 18)) })
            for (ex in listOf(first, "Make a chore chart with stars for the week")) {
                addView(Calm.text(c, "\u201C$ex\u201D", 19f, 400, Calm.SOFT).apply { setPadding(0, Calm.px(c, 6), 0, Calm.px(c, 6)) })
            }
            addView(Calm.primary(c, "Make an app") { go { makeApp("Say what app to make, like \u201C$first\u201D") } },
                android.widget.LinearLayout.LayoutParams(-2, -2).apply { topMargin = Calm.px(c, 18) })
            addView(Calm.text(c, "For bigger work, connect Claude or ChatGPT on a computer (the connector is cloud.opie.house/mcp).", 17f, 400, Calm.SOFT).apply { setPadding(0, Calm.px(c, 28), 0, 0) })
            addView(Calm.quiet(c, "Pair a computer") { go { Screens.computer(act) } }.apply { setPadding(0, Calm.px(c, 12), 0, 0) },
                android.widget.LinearLayout.LayoutParams(-2, -2).apply { topMargin = Calm.px(c, 4) })
        }

        val both = if (wide) Calm.row(c).apply {
            gravity = android.view.Gravity.TOP
            addView(find, android.widget.LinearLayout.LayoutParams(0, -2, 1.15f))
            addView(Calm.gap(c, 32, 1))
            addView(make, android.widget.LinearLayout.LayoutParams(0, -2, 1f))
        } else Calm.column(c).apply {
            addView(find, android.widget.LinearLayout.LayoutParams(-1, -2))
            addView(make, android.widget.LinearLayout.LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 24) })
        }
        dialog = CalmDialog(act).setTitle("Add apps").setWidth(if (wide) 1320f else 760f).setView(both)
            .setNegativeButton(if (fromApps) "Close" else "Back") { _, _ -> if (!fromApps) show() }.show()
        // the search box shouldn't bring up the keyboard by itself (CalmDialog focuses the first field)
        search.clearFocus(); dialog?.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN or android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    private fun installedOne(name: String) = thread {
        val p = objs(get("/plugins")?.optJSONArray("plugins")).find { it.optString("name") == name }
        ui { if (p == null) home() else one(p) }
    }

    private fun askLink() {
        val box = Calm.field(act, "A git or .tgz link").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        CalmDialog(act).setTitle("Add from a link").setMessage("Only from someone you trust.").setView(box)
            .setPositiveButton("Next") { _, _ -> look(box.text.toString().trim()) }.setNegativeButton("Cancel") { _, _ -> gallery() }.show()
    }

    /** [source]: a link, or the name of a plugin on Opie's list (the bridge fetches only its pinned tarball). The
     *  bridge puts up the tablet's own card for it, the one add_plugin gets (its rights, a person's own tap, the PIN
     *  when it's on), made from exactly what it then adds: no card of our own here. */
    private fun look(source: String) {
        if (source.isEmpty()) return
        act.toast("Getting it…")
        thread {
            val r = post("/plugins/install", JSONObject().put("source", source))
            ui {
                when {
                    r == null -> say("Plugins", noBridge)
                    r.has("error") -> say("That didn't work", r.optString("error"))
                    r.optBoolean("already") -> { act.toast("${r.optString("title")} is already here"); installedOne(r.optString("name")) }
                    r.optBoolean("declined") -> gallery()
                    else -> { act.toast("Added ${r.optString("title")}"); act.reloadHome(); if (!fromApps) show() } // from Apps: back to Apps, where it now is
                }
            }
        }
    }
}
