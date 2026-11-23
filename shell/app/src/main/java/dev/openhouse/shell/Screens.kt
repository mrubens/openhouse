package dev.openhouse.shell

// Other screens on the home network (bridge/screens.js, docs/brain-screens.md), from Settings: which ones
// there are, removing one, adding one by QR code (the screen asks; someone says yes here), and the home-network
// listener on or off. Only reached through the PIN. Also a computer (someone's own Claude or ChatGPT, which then
// changes the apps: bridge/workshop.js, docs/workshop-mcp.md): an address and a code to type, then Allow here.

import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.concurrent.thread

internal object Screens {
    private val main = Handler(Looper.getMainLooper())

    private fun get(a: MainActivity): JSONObject? = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText(a.bridge + "/screens")) }.getOrNull()
    private fun post(path: String, body: JSONObject = JSONObject()) = dev.openhouse.ui.Openhouse.post(path, body)

    /** Linked devices' Add (ui/Devices.kt): which kind, then its own way of joining. */
    fun addMenu(a: MainActivity) {
        CalmDialog(a).setTitle("Add").setItems(arrayOf("A tablet, iPad or frame", "A TV", "Someone's phone", "A computer, to change the apps")) { _, i -> when (i) { 0 -> add(a); 1 -> tv(a); 2 -> phone(a); else -> computer(a) } }
            .setNegativeButton("Back", null).show().also { a.immersive() }
    }

    /** Linked devices' Remove for one (its id): asks first. */
    fun remove(a: MainActivity, id: String) = thread {
        val x = get(a)?.optJSONArray("screens")?.let { l -> (0 until l.length()).mapNotNull { l.optJSONObject(it) } }?.firstOrNull { it.optString("id") == id } ?: return@thread
        main.post {
            CalmDialog(a).setTitle("Remove ${x.optString("name")}?")
                .setPositiveButton("Remove") { _, _ -> thread { post("/screens/revoke", JSONObject().put("id", id)) } }
                .setNegativeButton("Cancel", null).show().also { a.immersive() }
        }
    }

    fun manage(a: MainActivity) = thread {
        val s = get(a)
        main.post {
            if (s == null) { a.toast("The assistant is starting"); return@post }
            val list = s.optJSONArray("screens")
            val screens = (0 until (list?.length() ?: 0)).mapNotNull { list!!.optJSONObject(it) }
            val lan = s.optBoolean("lan")
            val b = CalmDialog(a).setTitle("Screens and computers")
            if (screens.isEmpty()) b.setMessage("None yet.")
            else b.setItems(screens.map { it.optString("name") + (when (it.optString("kind")) { "computer" -> "  ·  computer"; "tv" -> "  ·  TV"; "phone" -> "  ·  phone"; else -> "" }) + seen(it.optLong("seen")) + fromAway(it.optLong("away")) }.toTypedArray()) { _, i ->
                    val x = screens[i]
                    CalmDialog(a).setTitle("Remove ${x.optString("name")}?").setMessage(when (x.optString("kind")) { "computer" -> "It can't change the apps any more. It can be connected again."; "tv" -> "It stops showing the photos and calendar now. It can be added again."; "phone" -> "It stops getting the lists, calendar and notes now. It can be added again."; else -> "It stops showing the home screen now. It can be added again." })
                        .setPositiveButton("Remove") { _, _ -> thread { post("/screens/revoke", JSONObject().put("id", x.optString("id"))) } }
                        .setNegativeButton("Cancel", null).show().also { a.immersive() }
                }
            b.setPositiveButton("Add a screen") { _, _ ->
                CalmDialog(a).setTitle("Add a screen").setItems(arrayOf("A tablet, iPad or frame", "A TV", "Someone's phone", "A computer, to change the apps")) { _, i -> when (i) { 0 -> add(a); 1 -> tv(a); 2 -> phone(a); else -> computer(a) } }
                    .setNegativeButton("Cancel", null).show().also { a.immersive() }
            }
                .setNegativeButton("Back", null)
            if (lan) b.setNeutralButton("Home network off") { _, _ -> thread { post("/screens/lan", JSONObject().put("on", false)) } }
            else if (screens.isNotEmpty()) b.setNeutralButton("Home network on") { _, _ -> thread { post("/screens/lan", JSONObject().put("on", true)) } }
            b.show().also { a.immersive() }
        }
    }

    private fun seen(t: Long): String {
        if (t <= 0) return ""
        val m = (System.currentTimeMillis() - t) / 60_000
        return "  ·  " + when { m < 2 -> "now"; m < 60 -> "$m min"; m < 1440 -> "${m / 60} h"; else -> "${m / 1440} d" }
    }

    /** When it last came in from away from home, through the relay (Cloud → Reach from away from home), within a week. */
    private fun fromAway(t: Long): String {
        if (t <= 0 || System.currentTimeMillis() - t > 7 * 86_400_000L) return ""
        return "  ·  from away" + seen(t).removePrefix("  ·  ").let { if (it == "now") " now" else ", $it ago" }
    }

    /** A QR code for one screen to join; when it asks, someone says yes or no here. */
    private fun add(a: MainActivity) = thread {
        val ip = Handoff.lanAddress(a)
        val p = if (ip == null) null else runCatching { JSONObject(post("/screens/pair") ?: "") }.getOrNull()
        main.post {
            if (ip == null || p == null) { CalmDialog(a).setTitle(if (ip == null) "Connect the tablet to Wi-Fi first." else "The assistant is starting").setPositiveButton("OK", null).show().also { a.immersive() }; return@post }
            val pair = p.optString("pair")
            val url = "http://${ip.hostAddress}:${p.optInt("port")}/screen/#$pair.${p.optString("key")}"
            val col = Calm.qr(a, ImageView(a).apply { setImageBitmap(Handoff.qr(url, 520)) }, Calm.caption(a, "Scan with the other screen, on this Wi-Fi."), 360) { Handoff.share(a, url) }
            var open = true
            val d = CalmDialog(a).setTitle("Add a screen").setView(col).setNegativeButton("Cancel", null)
                .setOnDismissListener { open = false }.show().also { a.immersive() }
            val until = System.currentTimeMillis() + 10 * 60_000L
            thread { // until the screen asks (or the code runs out)
                while (open && System.currentTimeMillis() < until) {
                    val asking = get(a)?.optJSONArray("asking")?.let { arr -> (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.firstOrNull { it.optString("pair") == pair } }
                    if (asking != null) { main.post { d.dismiss(); confirm(a, pair, asking.optString("name")) }; return@thread }
                    Thread.sleep(1000)
                }
                main.post { d.dismiss() }
            }
        }
    }

    /**
     * Someone's phone (docs/phones-and-tv.md): whose it is, then a QR code to scan with it. Someone's phone sees,
     * ticks, asks and gets notes; a kid's sees, ticks and gets notes. When it asks, someone says yes here.
     */
    fun phone(a: MainActivity) = thread {
        val family = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText(a.bridge + "/household")).optJSONArray("family") }.getOrNull()
        val names = (0 until (family?.length() ?: 0)).mapNotNull { family!!.optJSONObject(it)?.optString("name")?.takeIf { n -> n.isNotBlank() } }
        main.post {
            if (names.isEmpty()) { CalmDialog(a).setTitle("Add the family first").setMessage("Settings, Family: then each person can have their phone here.").setPositiveButton("OK", null).show().also { a.immersive() }; return@post }
            CalmDialog(a).setTitle("Whose phone?").setItems(names.toTypedArray()) { _, i ->
                val who = names[i]
                CalmDialog(a).setTitle("Can $who's phone ask Opie?")
                    .setPositiveButton("Yes") { _, _ -> phoneQr(a, who, true) }
                    .setNegativeButton("No") { _, _ -> phoneQr(a, who, false) }
                    .show().also { a.immersive() }
            }.setNegativeButton("Cancel", null).show().also { a.immersive() }
        }
    }

    private fun phoneQr(a: MainActivity, who: String, grownup: Boolean) = thread {
        val ip = Handoff.lanAddress(a)
        val p = if (ip == null) null else runCatching { JSONObject(post("/screens/pair", JSONObject().put("kind", "phone").put("person", who).put("grownup", grownup)) ?: "") }.getOrNull()
        main.post {
            if (ip == null || p == null) { CalmDialog(a).setTitle(if (ip == null) "Connect the tablet to Wi-Fi first." else "The assistant is starting").setPositiveButton("OK", null).show().also { a.immersive() }; return@post }
            val pair = p.optString("pair")
            val url = "http://${ip.hostAddress}:${p.optInt("port")}/phone/?for=${android.net.Uri.encode(who)}#$pair.${p.optString("key")}"
            val col = Calm.qr(a, ImageView(a).apply { setImageBitmap(Handoff.qr(url, 520)) }, Calm.caption(a, "Scan with $who's phone, on this Wi-Fi."), 360) { Handoff.share(a, url) }
            var open = true
            val d = CalmDialog(a).setTitle("$who's phone").setView(col).setNegativeButton("Cancel", null)
                .setOnDismissListener { open = false }.show().also { a.immersive() }
            val since = System.currentTimeMillis()
            val until = since + 10 * 60_000L
            thread { // scanning this code is the yes (docs/phones.md): the phone joins at once, and this closes when it has
                while (open && System.currentTimeMillis() < until) {
                    val joined = get(a)?.optJSONArray("screens")?.let { arr -> (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.any { it.optString("kind") == "phone" && it.optString("person") == who && it.optLong("added") >= since - 5_000 } } == true
                    if (joined) { main.post { d.dismiss() }; return@thread }
                    Thread.sleep(1000)
                }
                main.post { d.dismiss() }
            }
        }
    }

    /**
     * A TV (docs/phones-and-tv.md): its browser, at <tablet>:8788/tv, shows a code; typed here (the tablet has the
     * keyboard, the TV only a remote), the TV joins at once, showing only (photos, Today, the week).
     */
    fun tv(a: MainActivity) {
        val ip = Handoff.lanAddress(a)
        if (ip == null) { CalmDialog(a).setTitle("Connect the tablet to Wi-Fi first.").setPositiveButton("OK", null).show().also { a.immersive() }; return }
        thread { post("/screens/lan", JSONObject().put("on", true)) } // so the TV can open the page
        val code = Calm.field(a, "XXXX-XXXX-XXXX", 30f).apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val name = Calm.field(a, "Which TV? (Living room)", 22f)
        val col = Calm.column(a).apply {
            addView(Calm.caption(a, "On the TV, open its web browser and go to"))
            addView(Calm.text(a, "${ip.hostAddress}:8788/tv", 26f, 500).apply { setTextIsSelectable(true); setPadding(0, 8, 0, 28) })
            addView(Calm.caption(a, "Then type the code the TV shows"))
            addView(code); addView(name)
        }
        CalmDialog(a).setTitle("Add a TV").setView(col).setNegativeButton("Cancel", null)
            .setPositiveButton("Add") { _, _ ->
                thread {
                    val r = runCatching { JSONObject(post("/screens/pair", JSONObject().put("kind", "tv").put("code", code.text.toString()).put("name", name.text.toString())) ?: "") }.getOrNull()
                    main.post {
                        val err = r?.optString("error")?.takeIf { it.isNotEmpty() }
                        if (r == null || err != null) CalmDialog(a).setTitle(err ?: "The assistant is starting").setPositiveButton("OK", null).show().also { a.immersive() }
                        else a.toast("The TV joins in a few seconds")
                    }
                }
            }.show().also { a.immersive() }
    }

    /**
     * A computer: a code to type into Claude or ChatGPT there (and the address, if it doesn't find the tablet by
     * itself), plus the same as a QR code. While it shows, the tablet answers on the Wi-Fi as "_openhouse._tcp" (Bonjour),
     * so the computer finds it with the code alone. When the computer asks, someone says yes here.
     */
    fun computer(a: MainActivity) = thread {
        val ip = Handoff.lanAddress(a)
        val p = if (ip == null) null else runCatching { JSONObject(post("/screens/pair", JSONObject().put("kind", "computer").put("address", ip.hostAddress)) ?: "") }.getOrNull()
        // claude.ai and ChatGPT, from anywhere (a phone too), while the tablet is reachable from away: the service's
        // connector address, which pairs with the same code (openhouse-cloud/lambda/connector.ts, docs/web-chat-building.md).
        val cloudConnector = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText(a.bridge + "/relay")).optString("connector").takeIf { it.startsWith("http") } }.getOrNull()
        // Or the tablet's own, behind the household's own https address (web-mcp.js): no OpenHouse cloud needed.
        val ownConnector = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText(a.bridge + "/webmcp")).optString("connector").takeIf { it.startsWith("http") } }.getOrNull()
        val connector = ownConnector ?: cloudConnector
        main.post {
            if (ip == null || p == null) { CalmDialog(a).setTitle(if (ip == null) "Connect the tablet to Wi-Fi first." else "The assistant is starting").setPositiveButton("OK", null).show().also { a.immersive() }; return@post }
            val pair = p.optString("pair"); val code = p.optString("code"); val port = p.optInt("port")
            val address = "${ip.hostAddress}:$port"
            // The page to add OpenHouse to Claude (bridge/connect-page.js), at the bridge's own name when it has one.
            val named = p.optString("host").takeIf { it.isNotEmpty() && !p.isNull("host") }?.let { "$it:$port" }
            // Two steps, left; the page's QR code, right.
            fun step(n: Int, head: String, body: android.view.View) = Calm.row(a).apply {
                gravity = Gravity.TOP
                addView(Calm.text(a, "$n", 22f, 600, Calm.SOFT), LinearLayout.LayoutParams(Calm.px(a, 40), -2))
                addView(Calm.column(a, 8).apply { addView(Calm.text(a, head, 22f, 500)); addView(body) }, LinearLayout.LayoutParams(0, -2, 1f))
            }
            val left = Calm.column(a, 32).apply {
                addView(step(1, "On the computer, open", Calm.column(a, 4).apply {
                    addView(Calm.text(a, named ?: address, 34f, 600).apply { setTextIsSelectable(true) })
                    if (named != null) addView(Calm.text(a, "or $address", 17f, 400, Calm.SOFT).apply { setTextIsSelectable(true) })
                    addView(Calm.text(a, "It shows what to add to Claude or ChatGPT.", 17f, 400, Calm.SOFT))
                    if (connector != null) {
                        addView(Calm.text(a, "Or in Claude or ChatGPT, anywhere (a phone too), add a connector at", 17f, 400, Calm.SOFT).apply { setPadding(0, Calm.px(a, 12), 0, 0) })
                        addView(Calm.text(a, connector, 22f, 600).apply { setTextIsSelectable(true) })
                    }
                }))
                addView(step(2, "Then give it this code", Calm.text(a, code, 52f, 600).apply { letterSpacing = .08f; setTextIsSelectable(true) }))
                addView(Calm.small(a, if (connector != null) "The computer on the same Wi-Fi as this tablet; Claude or ChatGPT from anywhere. The code lasts 10 minutes, while this shows." else "On the same Wi-Fi as this tablet. The page and the code last 10 minutes, while this shows."))
            }
            val col = Calm.row(a, 48).apply {
                gravity = Gravity.TOP
                addView(left, LinearLayout.LayoutParams(0, -2, 1f))
                addView(Calm.qr(a, ImageView(a).apply { setImageBitmap(Handoff.qr("http://$address/", 260)) }, Calm.caption(a, "Or scan it"), 220))
            }
            // Findable on the Wi-Fi while the code shows.
            val nsd = a.getSystemService(android.net.nsd.NsdManager::class.java)
            val advert = object : android.net.nsd.NsdManager.RegistrationListener {
                override fun onServiceRegistered(i: android.net.nsd.NsdServiceInfo) {}
                override fun onRegistrationFailed(i: android.net.nsd.NsdServiceInfo, e: Int) { android.util.Log.w("Screens", "Bonjour advert failed: $e") }
                override fun onServiceUnregistered(i: android.net.nsd.NsdServiceInfo) {}
                override fun onUnregistrationFailed(i: android.net.nsd.NsdServiceInfo, e: Int) {}
            }
            // Multicast reaches the bridge's name (openhouse.local) and the Bonjour advert only while this lock is held.
            val wifi = a.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java)
            val multicast = runCatching { wifi.createMulticastLock("openhouse-connect").apply { setReferenceCounted(false); acquire() } }.getOrNull()
            val advertised = runCatching { nsd.registerService(android.net.nsd.NsdServiceInfo().apply { serviceName = "OpenHouse"; serviceType = "_openhouse._tcp"; setPort(port) }, android.net.nsd.NsdManager.PROTOCOL_DNS_SD, advert) }.isSuccess
            var open = true
            val d = CalmDialog(a).setTitle(if (connector != null) "Connect Claude or ChatGPT" else "Connect a computer").setWidth(980f).setView(col).setNegativeButton("Cancel", null)
                .setNeutralButton("Your own address") { _, _ -> ownAddress(a, ownConnector) }
                .setOnDismissListener {
                    open = false; if (advertised) runCatching { nsd.unregisterService(advert) }; runCatching { multicast?.release() }
                    thread { post("/screens/pair/end", JSONObject().put("pair", pair)) } // its page and name go with it
                }.show().also { a.immersive() }
            val until = System.currentTimeMillis() + 10 * 60_000L
            thread {
                while (open && System.currentTimeMillis() < until) {
                    val asking = get(a)?.optJSONArray("asking")?.let { arr -> (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.firstOrNull { it.optString("pair") == pair } }
                    if (asking != null) { main.post { d.dismiss(); confirm(a, pair, asking.optString("name"), computer = true) }; return@thread }
                    Thread.sleep(1000)
                }
                main.post { d.dismiss() }
            }
        }
    }

    /**
     * The tablet's own connector (web-mcp.js), for a household with its own networking and no OpenHouse cloud: their
     * https address (a Tailscale Funnel, a tunnel) that reaches this tablet's port 8789. Claude or ChatGPT then adds
     * <address>/mcp as a connector, and signs in with the code, as with the cloud's.
     */
    private fun ownAddress(a: MainActivity, now: String?) = main.post {
        val field = Calm.field(a, "https://kitchen.tail1234.ts.net", 22f).apply { setText(now?.removeSuffix("/mcp") ?: "") }
        val col = Calm.column(a, 16).apply {
            addView(Calm.text(a, "If your network gives this tablet an https address of its own (Tailscale Funnel, a Cloudflare tunnel, your own proxy), pointing at port 8789, Claude or ChatGPT can reach it there, with no OpenHouse cloud. Type that address.", 18f, 400, Calm.SOFT))
            addView(field)
        }
        CalmDialog(a).setTitle("Your own address").setView(col)
            .setPositiveButton("Turn on") { _, _ -> thread {
                val r = runCatching { JSONObject(post("/webmcp", JSONObject().put("on", true).put("url", field.text.toString().trim())) ?: "") }.getOrNull()
                main.post { CalmDialog(a).setTitle(if (r?.optString("connector")?.startsWith("http") == true) "On" else "That didn't work").setMessage(r?.optString("connector")?.takeIf { it.startsWith("http") }?.let { "In Claude or ChatGPT, add a connector at $it, then give it the code from \"A computer, to change the apps\"." } ?: (r?.optString("error") ?: "The tablet didn't answer.")).setPositiveButton("OK", null).show().also { a.immersive() } }
            } }
            .setNeutralButton("Turn off") { _, _ -> thread { post("/webmcp", JSONObject().put("on", false)) } }
            .setNegativeButton("Cancel", null).show().also { a.immersive() }
    }

    private fun confirm(a: MainActivity, pair: String, name: String, computer: Boolean = false, tv: Boolean = false) {
        if (tv) {
            CalmDialog(a).setTitle("Let “$name” show the photos and calendar?").setMessage("A TV only shows: the photos, the calendar, today's chores, dinner and the grocery list. It can't change anything. Remove it any time in Screens.")
                .setPositiveButton("Allow") { _, _ -> thread { post("/screens/answer", JSONObject().put("pair", pair).put("yes", true)) } }
                .setNegativeButton("No") { _, _ -> thread { post("/screens/answer", JSONObject().put("pair", pair).put("yes", false)) } }
                .setCancelable(false).show().also { a.immersive() }
            return
        }
        if (computer) {
            CalmDialog(a).setTitle("Let “$name” use this OpenHouse?").setMessage("It can use the lists, calendar, chores, notes, timers and devices, and make and change apps and tabs. Every change can be undone. Remove it any time in Screens.")
                .setPositiveButton("Allow") { _, _ -> thread { post("/screens/answer", JSONObject().put("pair", pair).put("yes", true)) } }
                .setNegativeButton("No") { _, _ -> thread { post("/screens/answer", JSONObject().put("pair", pair).put("yes", false)) } }
                .setCancelable(false).show().also { a.immersive() }
            return
        }
        CalmDialog(a).setTitle("Let “$name” show the home screen?").setMessage("It can see the home screen, tick lists and ask the assistant. Not Settings or apps.")
            .setPositiveButton("Allow") { _, _ -> thread { post("/screens/answer", JSONObject().put("pair", pair).put("yes", true)) } }
            .setNegativeButton("No") { _, _ -> thread { post("/screens/answer", JSONObject().put("pair", pair).put("yes", false)) } }
            .setCancelable(false).show().also { a.immersive() }
    }
}
