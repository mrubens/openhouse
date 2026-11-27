package dev.openhouse.shell

// Settings → Account → Email (docs/tablet-email.md): the tablet's address at Opie's cloud, who may send to it, mail waiting
// for an Allow, what came in, and the household's own mailbox (MailAccount). The bridge keeps the rules and the mail
// (bridge/mail.js, GET /mail and its POSTs); the own mailbox's password stays here. Behind the PIN when the lock is on.

import android.text.InputType
import android.text.format.DateUtils
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

internal class EmailMenu(private val act: MainActivity) {
    private fun get(path: String) = runCatching { JSONObject(BridgeClient.getText("${act.bridge}$path", 3000, 15_000)) }.getOrNull()
    private fun post(path: String, body: JSONObject): JSONObject? = CloudSetup.post("${act.bridge}$path", body).second
    private fun ui(f: () -> Unit) = act.runOnUiThread(f)
    private fun say(title: String, text: String, then: (() -> Unit)? = null) {
        CalmDialog(act).setTitle(title).setMessage(text).setPositiveButton("Close") { _, _ -> then?.invoke() }.show()
    }
    private val noBridge = "The device's software isn't answering right now. Try again in a minute."
    /** Saying yes to mail, or widening who's read, is a person's to tap, not Opie's (DeviceServer.personOnly). */
    private fun person(what: String, f: () -> Unit): () -> Unit = { if (!DeviceServer.personOnly(what)) f() }

    /** A change for the bridge, then the menu again (or why not). */
    private fun change(path: String, body: JSONObject, title: String = "Email") = thread {
        val r = post(path, body)
        ui { if (r == null || r.has("error")) say(title, r?.optString("error")?.ifBlank { null } ?: noBridge) { show() } else show() }
    }

    fun show() = thread {
        val m = get("/mail")
        val names = familyNames()
        MailAccount.init(act)
        val own = MailAccount.get()
        ui { if (m == null) say("Email", noBridge) else menu(m, names, own) }
    }

    private fun objects(a: JSONArray?) = a?.let { (0 until it.length()).mapNotNull { i -> it.optJSONObject(i) } }.orEmpty()

    private fun menu(m: JSONObject, names: List<String>, own: MailAccount.Account?) {
        val cloud = m.optJSONObject("cloud")
        val senders = objects(m.optJSONArray("senders"))
        val held = objects(m.optJSONArray("held"))
        val recent = objects(m.optJSONArray("recent"))
        val notes = m.optJSONArray("notes")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty().filter { it.isNotBlank() }
        val rows = mutableListOf<Pair<CalmDialog.Row, (() -> Unit)?>>()
        fun head(t: String) { rows += CalmDialog.Row(t, header = true) to null }

        if (cloud != null) {
            head("Address")
            rows += CalmDialog.Row(cloud.optString("address").ifBlank { "No address yet" }, value = if (cloud.optBoolean("on")) "On" else "Off") to { address(cloud) }
        }
        if (held.isNotEmpty()) {
            head("Waiting")
            held.forEach { h -> rows += CalmDialog.Row(h.optString("from"), listOf(h.optString("subject").ifBlank { "No subject" }, `when`(h)).filter { it.isNotBlank() }.joinToString(" · ")) to { held(h) } }
        }
        head("Who can send")
        senders.forEach { s -> rows += CalmDialog.Row(s.optString("address"), value = s.optString("who").takeIf { it.isNotBlank() && it != "null" }) to { sender(s, senders) } }
        rows += CalmDialog.Row("Add someone") to person("Add someone") { addSender(senders, names) }
        if (recent.isNotEmpty()) {
            head("Came in")
            recent.forEach { r ->
                val got = listOfNotNull(r.optInt("photos").takeIf { it > 0 }?.let { if (it == 1) "1 photo" else "$it photos" },
                    r.optInt("events").takeIf { it > 0 }?.let { if (it == 1) "1 event" else "$it events" })
                rows += CalmDialog.Row(r.optString("subject").ifBlank { "No subject" }, (listOf(r.optString("from"), `when`(r)) + got).filter { it.isNotBlank() }.joinToString(" · ")) to null
            }
        }
        head("Your own mailbox")
        rows += CalmDialog.Row(if (own != null) own.user else "Use your own mailbox", if (own != null) MailAccount.lastError else null, value = if (own != null) "On" else "Off") to { if (own != null) ownSet(own) else person("Use your own mailbox") { addOwn() }() }

        val d = CalmDialog(act).setTitle("Email").setWidth(860f)
        if (cloud == null && own == null) d.setMessage("Email photos and invitations to the device: link it to your account (Settings, Account), or use a mailbox of your own.")
        else if (notes.isNotEmpty()) d.setMessage(notes.joinToString("\n"))
        d.setRows(rows.map { it.first }) { _, i -> rows[i].second?.invoke() }.setNegativeButton("Back", null).show()
    }

    /** "3 hours ago", from ms since 1970 or an ISO time. */
    private fun `when`(j: JSONObject): String {
        val v = j.opt("at") ?: return ""
        val ms = (v as? Number)?.toLong() ?: runCatching { java.time.Instant.parse(v.toString()).toEpochMilli() }.getOrNull() ?: return ""
        return DateUtils.getRelativeTimeSpanString(ms, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
    }

    // --- the cloud's address ----------------------------------------------------------------------------------------

    private fun address(cloud: JSONObject) {
        val on = cloud.optBoolean("on")
        CalmDialog(act).setTitle("The device's address").setMessage(cloud.optString("address").ifBlank { "No address yet." } + if (on) "" else "\nOff: mail to it isn't taken.")
            .setMore("Mail from the people on the list comes straight in. From anyone else it waits here 3 days for someone to allow it.")
            .setPositiveButton(if (on) "Turn off" else "Turn on") { _, _ -> if (on || !DeviceServer.personOnly("Turning on email")) change("/mail/set", JSONObject().put("on", !on)) }
            .setNeutralButton("New address") { _, _ -> newAddress() }
            .setNegativeButton("Back") { _, _ -> show() }.show()
    }

    private fun newAddress() {
        CalmDialog(act).setTitle("Get a new address?").setMessage("The old one stops working. Anyone who sends to it will need the new one.")
            .setPositiveButton("New address") { _, _ -> change("/mail/set", JSONObject().put("address", "new")) }
            .setNegativeButton("Cancel") { _, _ -> show() }.show()
    }

    // --- held mail ---------------------------------------------------------------------------------------------------

    private fun held(h: JSONObject) {
        CalmDialog(act).setTitle(h.optString("from")).setMessage(h.optString("subject").ifBlank { "No subject" })
            .setMore("It isn't from anyone on the list, so nothing has read it. It's deleted after 3 days unless someone allows it.")
            .setPositiveButton("Allow") { _, _ -> if (!DeviceServer.personOnly("Allowing an email")) change("/mail/held", JSONObject().put("id", h.optString("id")).put("allow", true)) }
            .setNeutralButton("Delete") { _, _ -> change("/mail/held", JSONObject().put("id", h.optString("id")).put("allow", false)) }
            .setNegativeButton("Back") { _, _ -> show() }.show()
    }

    // --- senders -----------------------------------------------------------------------------------------------------

    private fun senderJson(list: List<JSONObject>) = JSONArray(list.map { JSONObject().put("address", it.optString("address")).put("who", it.optString("who").takeIf { w -> w != "null" } ?: "") })

    private fun sender(s: JSONObject, all: List<JSONObject>) {
        CalmDialog(act).setTitle(s.optString("address")).setMessage(s.optString("who").takeIf { it.isNotBlank() && it != "null" }?.let { "$it's" } ?: "Mail from this address comes straight in.")
            .setDanger()
            .setPositiveButton("Remove") { _, _ -> change("/mail/set", JSONObject().put("senders", senderJson(all.filter { it.optString("address") != s.optString("address") }))) }
            .setNegativeButton("Back") { _, _ -> show() }.show()
    }

    private fun addSender(all: List<JSONObject>, names: List<String>) {
        val addr = Calm.field(act, "Email address").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val who = Calm.field(act, if (names.isEmpty()) "Whose is it? (optional)" else "Whose? " + names.take(4).joinToString(", "))
        val col = Calm.column(act, 12).apply { addView(addr); addView(who) }
        CalmDialog(act).setTitle("Who can send").setView(col).setWidth(760f)
            .setPositiveButton("Add") { _, _ ->
                val a = addr.text.toString().trim().lowercase()
                if (!Regex("^[^\\s@]{1,64}@[^\\s@]{1,190}\\.[^\\s@]{2,}$").matches(a)) return@setPositiveButton say("Who can send", "That isn't an email address.") { addSender(all, names) }
                val w = who.text.toString().trim().let { t -> names.firstOrNull { it.equals(t, true) } ?: t }.take(40)
                val rest = all.filter { it.optString("address").lowercase() != a }
                change("/mail/set", JSONObject().put("senders", senderJson(rest + JSONObject().put("address", a).put("who", w))))
            }.setNegativeButton("Cancel") { _, _ -> show() }.show()
    }

    private fun familyNames(): List<String> = runCatching {
        val a = get("/household")?.optJSONArray("family") ?: JSONArray()
        (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("name")?.takeIf { n -> n.isNotBlank() } }
    }.getOrDefault(emptyList())

    // --- the household's own mailbox (MailAccount) --------------------------------------------------------------------

    private fun ownSet(own: MailAccount.Account) {
        val checked = MailAccount.lastChecked.takeIf { it > 0 }?.let { DateUtils.getRelativeTimeSpanString(it, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString() }
        val now = MailAccount.lastError ?: checked?.let { "Last looked $it." } ?: "Looks every 2 minutes."
        CalmDialog(act).setTitle(own.user).setMessage("${own.host}\n$now")
            .setMore("The device looks in its inbox every 2 minutes, for mail that came after it was added, and marks what it takes as read. The password stays sealed on this device and only reaches that server.")
            .setDanger()
            .setPositiveButton("Remove") { _, _ -> thread { MailAccount.remove(); post("/mail/set", JSONObject().put("own", false)); ui { act.toast("Removed"); show() } } }
            .setNegativeButton("Back") { _, _ -> show() }.show()
    }

    private fun addOwn() {
        val addr = Calm.field(act, "Address").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val pass = Calm.field(act, "App password").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        val server = Calm.field(act, "Server (imap.example.com)").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        addr.setOnFocusChangeListener { _, has -> if (!has && server.text.isBlank()) guessServer(addr.text.toString())?.let { server.setText(it) } }
        val col = Calm.column(act, 12).apply {
            addView(addr); addView(pass); addView(server)
            addView(Calm.more(act, "A mailbox just for the device, at any provider with IMAP. Make an app password in the account's security settings. The device looks in the inbox every 2 minutes, for mail that comes after now. The password stays sealed on this device and only reaches that server."))
        }
        CalmDialog(act).setTitle("Use your own mailbox").setView(col).setWidth(760f)
            .setPositiveButton("Add") { _, _ ->
                val u = addr.text.toString().trim(); val p = pass.text.toString().trim()
                val (host, port) = hostPort(server.text.toString().ifBlank { guessServer(u) ?: "" }) ?: return@setPositiveButton say("Use your own mailbox", "That server's name doesn't look right.") { addOwn() }
                if (u.length < 3 || p.isEmpty()) return@setPositiveButton say("Use your own mailbox", "The address and an app password are both needed.") { addOwn() }
                val wait = CalmDialog(act).setTitle("Signing in…").setCancelable(false).show()
                thread {
                    val err = MailAccount.add(host, port, u, p)
                    if (err == null) post("/mail/set", JSONObject().put("own", true))
                    ui { wait.dismiss(); if (err != null) say("That didn't sign in", err) { addOwn() } else { act.toast("Added"); show() } }
                }
            }.setNegativeButton("Cancel") { _, _ -> show() }.show()
    }

    /** The usual IMAP server for a few big providers; else imap.<domain>. */
    private fun guessServer(address: String): String? {
        val d = address.substringAfter('@', "").trim().lowercase().takeIf { it.contains('.') } ?: return null
        return when (d) {
            "gmail.com", "googlemail.com" -> "imap.gmail.com"
            "icloud.com", "me.com", "mac.com" -> "imap.mail.me.com"
            "outlook.com", "hotmail.com", "live.com" -> "outlook.office365.com"
            "fastmail.com", "fastmail.fm" -> "imap.fastmail.com"
            "yahoo.com" -> "imap.mail.yahoo.com"
            else -> "imap.$d"
        }
    }

    /** "imap.example.com" or "imap.example.com:993" → (host, port); 993 unless said. */
    private fun hostPort(s: String): Pair<String, Int>? {
        val t = s.trim().lowercase().removePrefix("imaps://").trimEnd('/')
        val host = t.substringBefore(':'); val port = if (t.contains(':')) t.substringAfter(':').toIntOrNull() ?: return null else 993
        if (!Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$").matches(host) || port !in 1..65535) return null
        return host to port
    }
}
