package dev.openhouse.shell

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

/**
 * The household's own Gemini key (docs/assistant.md): Opie's voice on Google's Gemini Live, on their own Google
 * account, with nothing passing through our cloud. Only the voice: typed questions stay with the OpenAI key or Opie's
 * cloud. Kept as [OwnKey] keeps the OpenAI key: sealed with a key in Android's keystore, in the shell's no-backup files,
 * never in the bridge's files, a backup or a report. The bridge hears only whether one is in (POST /cloud/gemini {on})
 * and, for each conversation, asks through [forward] for a one-use token (Google's auth_tokens, only that call, only at
 * Google's own address), which the session's page connects with (chat/live/gemini-session.cjs): the key itself never
 * leaves here. Entering, changing and removing it are an adult's, behind the PIN; each way in says it goes to Google.
 * The key comes in as the OpenAI key does: by the QR code from a phone on the Wi-Fi, typed here, or sent from a
 * settings page ([offer]: bridge /setup/gemini), with a yes here. The menu also sets its own monthly stop (bridge cloud.js).
 */
object GeminiKey {
    private const val TAG = "GeminiKey"
    private const val ALIAS = "openhouse-own-gemini-key"
    const val GOOGLE = "https://generativelanguage.googleapis.com"
    /** The model the bridge asks tokens for (bridge/own-gemini.js MODEL), used here only to check a key. */
    private const val MODEL = "models/gemini-3.8-live"

    /** The kinds of call the bridge may make with the key, each to one fixed path at [GOOGLE]: a one-use token for a
     *  live conversation. */
    private val CALLS: Map<String, String> = mapOf("token" to "/v1beta/auth_tokens")

    private lateinit var ctx: Context
    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }
    private val file get() = File(ctx.noBackupFilesDir, "own-gemini-key")

    private fun secret(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }

    @Synchronized private fun read(): String? = runCatching {
        val b = file.readBytes()
        String(Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, b, 0, 12)) }.doFinal(b, 12, b.size - 12))
    }.getOrNull()

    @Synchronized private fun write(key: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val tmp = File(file.path + ".new")
        tmp.writeBytes(c.iv + c.doFinal(key.toByteArray()))
        tmp.renameTo(file)
    }

    fun has(): Boolean = ::ctx.isInitialized && read() != null

    /** What someone pasted, if it looks like a Google API key (one line of letters, digits, -, _ and .), else null. */
    fun clean(raw: String): String? = raw.trim().takeIf { Regex("^[A-Za-z0-9_.-]{30,200}$").matches(it) }

    sealed class Check { object Ok : Check(); class No(val say: String) : Check() }

    private const val REFUSED = "Google didn't accept that key. Check you copied all of it, or make a new one."
    private const val LIMIT = "Google says that project is over its limit or out of credit. Check it in AI Studio, then try again."
    private const val BILLING = "That key's project needs billing turned on. Turn it on in AI Studio, then try again."

    /** Google's answer, in words (bridge own-gemini.js says the same for a session). */
    private fun said(code: Int, body: String): Check = when {
        code in 200..299 -> Check.Ok
        body.contains("API_KEY_INVALID") || code == 401 -> Check.No(REFUSED)
        code == 403 -> Check.No("Google won't let that key be used. Make a new one in AI Studio.")
        body.contains("FAILED_PRECONDITION") || body.contains("billing", ignoreCase = true) -> Check.No(BILLING)
        code == 429 || code == 402 -> Check.No(LIMIT)
        code == 400 -> Check.No(REFUSED)
        else -> Check.No("Google didn't answer properly ($code). Try again in a minute.")
    }

    /**
     * Two calls with the key, neither billed: the list of models (a wrong key and an unreachable Google each get their
     * own words), then a one-use token for Opie's model, the call every conversation makes. Whether the project pays
     * (Google keeps a free project's conversations to improve its products) can't be asked: the words say it must.
     */
    fun check(key: String): Check = runCatching {
        val c = URL("$GOOGLE/v1beta/models?pageSize=1").openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 10_000; c.readTimeout = 15_000; c.instanceFollowRedirects = false
            c.setRequestProperty("x-goog-api-key", key)
            val code = c.responseCode
            if (code != 200) return@runCatching said(code, c.errorStream?.bufferedReader()?.readText().orEmpty())
        } finally { c.disconnect() }
        val body = JSONObject().put("uses", 1).put("liveConnectConstraints", JSONObject().put("model", MODEL)
            .put("config", JSONObject().put("responseModalities", org.json.JSONArray().put("AUDIO"))))
        val (code, text) = post(key, "$GOOGLE${CALLS["token"]}", body.toString())
        said(code, text)
    }.getOrElse { Log.d(TAG, "check: ${it.javaClass.simpleName}"); Check.No("The device couldn't reach Google. Check the Wi-Fi and try again.") }

    private fun post(key: String, to: String, body: String): Pair<Int, String> {
        val c = URL(to).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 10_000; c.readTimeout = 20_000
            c.instanceFollowRedirects = false // only Google's own address, never where it might send us
            c.setRequestProperty("x-goog-api-key", key); c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            return code to ((if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: "{}")
        } finally { c.disconnect() }
    }

    fun target(kind: String): String? = CALLS[kind]?.let { "$GOOGLE$it" }

    /**
     * The bridge's call with the key (DeviceServer /gemini): [kind] picks the fixed path, [body] is sent as it is with
     * the key added here. Google's status and answer come back (for a token: the token, good for one conversation);
     * the key never does. Refused with no key or an unknown kind.
     */
    fun forward(kind: String, body: String): Pair<Int, String> {
        val to = target(kind) ?: return 404 to JSONObject().put("error", "not a call this route makes").toString()
        val key = if (::ctx.isInitialized) read() else null
        key ?: return 409 to JSONObject().put("error", "no_key").toString()
        return runCatching { post(key, to, body) }.getOrElse { 502 to JSONObject().put("error", "google unreachable").toString() }
    }

    private fun tellBridge(bridge: String, on: Boolean) = runCatching { CloudSetup.post("$bridge/cloud/gemini", JSONObject().put("on", on)); CloudSetup.refreshVoice(ctx, bridge) }

    // --- the adult's screens: put a key in, its stop, change it, take it out (behind the PIN) -----------------

    /** Why the key isn't working, from the bridge (cloud.js voiceNeed), as Settings says it. */
    private val NEED = mapOf(
        "gemini_key_refused" to "Google stopped accepting this key. Put in a new one.",
        "gemini_key_limit" to "Google says this project is over its limit or out of credit. Check it in AI Studio.",
        "gemini_key_billing" to "Google says this project needs billing turned on. Turn it on in AI Studio.",
        "gemini_no_key" to "The key isn't on this device any more. Put it in again.",
        "gemini_stop" to "This month's stop is reached, so Opie's voice waits for next month or a higher stop.",
    )
    private val STOPS = listOf(500, 1000, 2000, 5000, 10000, 20000) // (bridge cloud.js STOPS)
    private fun dollars(cents: Int) = "$${cents / 100}"
    private const val MORE = "Make a key in Google's AI Studio (aistudio.google.com, API keys), in a project with billing turned on: on a free project Google may use what's said to improve its products. What's said to Opie then goes to Google on your own account, not through Opie's cloud, and Google bills you. Opie's voice stops for the month at the monthly stop set here."

    /** Today's card while the voice can't answer ([why]: the bridge's voiceNeed, one of [NEED]'s). */
    fun fromToday(act: MainActivity, why: String) {
        if (why == "gemini_stop" && has()) act.lock.withPin("Monthly stop") { stop(act) } else menu(act)
    }

    /** Settings → Opie → Voice → Your own keys → Gemini: with a key in, its monthly stop, changing it, taking it out. */
    fun menu(act: MainActivity) = act.lock.withPin("Your own Gemini key") {
        if (!has()) return@withPin enter(act)
        thread {
            val v = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("${act.bridge}/cloud/voice", 3000, 8000)) }.getOrNull()
            val stop = v?.optInt("geminiStopCents", 0) ?: 0
            val why = v?.takeIf { !it.isNull("need") }?.optString("need")
            act.runOnUiThread {
                val rows = listOfNotNull(if (stop > 0) "Monthly stop: ${dollars(stop)}" else null, "Change the key", "Remove the key")
                CalmDialog(act).setTitle("Your own Gemini key")
                    .setMessage(NEED[why] ?: "Opie's voice can use your Google account: pick one of Google's voices in Voice. Google bills you.")
                    .setItems(rows.toTypedArray()) { _, i -> when (i - (rows.size - 2)) { 0 -> enter(act); 1 -> remove(act); else -> stop(act) } }
                    .setNegativeButton("Back", null).show()
            }
        }
    }

    private fun stop(act: MainActivity) = thread {
        val v = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("${act.bridge}/cloud/voice", 3000, 8000)) }.getOrNull()
        val now = v?.optInt("geminiStopCents", 0) ?: 0
        act.runOnUiThread {
            CalmDialog(act).setTitle("Monthly stop").setMessage("Opie stops using your Gemini key for the rest of the month once it has cost about this much.")
                .setSingleChoiceItems(STOPS.map { dollars(it) }.toTypedArray(), STOPS.indexOf(now)) { d, i ->
                    d.dismiss()
                    thread {
                        val (_, r) = CloudSetup.post("${act.bridge}/cloud/gemini/stop", JSONObject().put("cents", STOPS[i]))
                        act.runOnUiThread { if (r == null || r.has("error")) act.toast("That wasn't saved. Try again") else { act.toast("Stops at ${dollars(STOPS[i])} a month"); dev.openhouse.ui.Openhouse.settingsChanged() } }
                    }
                }.setNegativeButton("Back", null).show()
        }
    }

    /** Put a key in, from a phone on this Wi-Fi (the QR code, sealed: [Handoff]) or typed here. A person's own tap. */
    private fun enter(act: MainActivity) {
        if (DeviceServer.personOnly("Putting in a Gemini key")) return
        var dialog: android.app.Dialog? = null
        var got: String? = null
        val info = JSONObject().put("title", "Your Gemini key").put("field", "Gemini key").put("hint", "AIza…")
            .put("link", "https://aistudio.google.com/apikey").put("linkText", "Make a key in AI Studio").put("done", "Sent. Check the device.")
        val h = Handoff(act, info, minutes = 15, onSecret = { got = it.optString("value"); dialog?.dismiss() }, onEnd = { if (got == null) dialog?.dismiss() })
        if (!h.start()) return type(act)
        val qr = android.widget.ImageView(act).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
        val col = Calm.column(act, 12).apply {
            gravity = android.view.Gravity.CENTER_HORIZONTAL
            addView(Calm.qr(act, qr, Calm.caption(act, "Scan with a phone on this Wi-Fi, then paste the key there."), 360) { Handoff.share(act, h.url!!) })
            addView(Calm.quiet(act, "Type it here instead") { dialog?.dismiss(); type(act) })
            addView(Calm.more(act, MORE))
        }
        dialog = CalmDialog(act).setTitle("Add a Gemini key").setView(col).setNegativeButton("Cancel", null)
            .setOnDismissListener { h.stop(); got?.let { use(act, it) } }.show()
    }

    private fun type(act: MainActivity) {
        val box = Calm.field(act, "AIza…").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        val col = Calm.column(act, 12).apply { addView(box) }
        CalmDialog(act).setTitle("Add a Gemini key").setView(col).setWidth(760f).setMore(MORE)
            .setPositiveButton("Check and use it") { _, _ -> use(act, box.text.toString()) }
            .setNegativeButton("Cancel", null).show()
    }

    private fun use(act: MainActivity, raw: String) {
        val key = clean(raw) ?: return say(act, "That isn't a Gemini key", "A key is one long line from AI Studio. Copy all of it.")
        act.toast("Checking it…")
        thread {
            when (val r = check(key)) {
                is Check.Ok -> { write(key); tellBridge(act.bridge, true); act.runOnUiThread { act.toast("Your key works. Opie talks with Google's voice now") } }
                is Check.No -> act.runOnUiThread { say(act, "That key didn't work", r.say) }
            }
        }
    }

    /**
     * A key sent from a phone or computer (DeviceServer /geminikey): a person's yes here first, naming Google (the PIN
     * with the lock on), then checked and kept. [done]: null once it's in, else what went wrong, in words for that phone.
     */
    fun offer(act: MainActivity, raw: String, done: (String?) -> Unit) {
        val key = clean(raw) ?: return done("That isn't a Gemini key. A key is one long line from AI Studio: copy all of it.")
        val go = {
            thread {
                when (val r = check(key)) {
                    is Check.Ok -> { write(key); tellBridge(act.bridge, true); act.runOnUiThread { act.toast("Your Gemini key works. Opie talks with Google's voice now") }; done(null) }
                    is Check.No -> done(r.say)
                }
            }
            Unit
        }
        if (act.lock.asks(PinChoices.SETTINGS)) return PinPrompt.ask(act, act, "Use the Gemini key sent from the phone? What's said to Opie then goes to Google.", { go() }, cancelled = { done("Nobody typed the PIN on the device, so the key wasn't kept.") })
        var answered = false
        CalmDialog(act).setForPerson().setTitle("Use the Gemini key sent from the phone?")
            .setMessage("What's said to Opie then goes to Google, on your own account, and Google bills you.")
            .setPositiveButton("Use it") { _, _ -> if (!DeviceServer.personOnly("Putting in a Gemini key")) { answered = true; go() } }
            .setNegativeButton("Not now", null)
            .setOnDismissListener { if (!answered) done("Nobody said yes on the device, so the key wasn't kept.") }.show()
    }

    private fun remove(act: MainActivity) {
        CalmDialog(act).setTitle("Remove your key?").setMessage("Opie stops using your Google account at once.")
            .setPositiveButton("Remove") { _, _ ->
                synchronized(this) { file.delete() }
                thread { tellBridge(act.bridge, false) }
            }.setNegativeButton("Cancel", null).show()
    }

    private fun say(act: Activity, title: String, text: String) { CalmDialog(act).setTitle(title).setMessage(text).setPositiveButton("Close", null).show() }
}
