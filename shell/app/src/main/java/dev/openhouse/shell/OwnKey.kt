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
 * The household's own OpenAI key (docs/assistant.md): Opie's voice and assistant on their own OpenAI account, with
 * nothing passing through our cloud. Kept here, sealed with a key in Android's keystore, in the shell's no-backup
 * files: never in the bridge's files, device.json, any store, a backup or a report (a restored tablet asks again,
 * since the keystore's key doesn't travel). The bridge hears only whether one is in (POST /cloud/own {on}) and asks
 * OpenAI through [forward], which reaches only OpenAI's own address and only the calls in [CALLS]. Entering, changing
 * and removing it are an adult's, behind the PIN.
 * The key comes in from a phone on the Wi-Fi by the QR code, or typed or pasted here ([menu]: Settings → Opie → Voice, Your
 * own OpenAI key, or Today's card while there's no voice: [fromToday]), or sent from a hub's settings page ([offer]: bridge
 * /setup/openai): sealed, straight here. The menu also sets the key's monthly stop (kept and checked by the bridge, cloud.js).
 * What each call carries is built by the bridge (bridge/own-openai.js, the cloud's requests).
 */
object OwnKey {
    private const val TAG = "OwnKey"
    private const val ALIAS = "openhouse-own-openai-key"
    const val OPENAI = "https://api.openai.com"

    /** The kinds of call the bridge may make with the key, each to one fixed path at [OPENAI]: the live voice's start,
     *  the assistant's next step, Decisions. (A live session ends by its idle timeout or when the tablet hangs up.) */
    private val CALLS: Map<String, String> = mapOf("live" to "/v1/live/sessions", "responses" to "/v1/responses", "decisions" to "/v1/decisions")

    private lateinit var ctx: Context
    fun init(c: Context) { if (!::ctx.isInitialized) ctx = c.applicationContext }
    private val file get() = File(ctx.noBackupFilesDir, "own-openai-key")

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

    /** What someone pasted, if it looks like an OpenAI key (sk-, letters, digits, - and _), else null. */
    fun clean(raw: String): String? = raw.trim().takeIf { Regex("^sk-[A-Za-z0-9_-]{20,300}$").matches(it) }

    /** The answer to checking a key, as the household sees it. */
    sealed class Check { object Ok : Check(); class No(val say: String) : Check() }

    private const val NO_CREDIT = "OpenAI says that account is out of credit or over its limit. Add credit on OpenAI's site, then try again."
    private const val NO_ACCESS = "That key can't be used from here. On OpenAI's site, give it access to all models, or make a new one."

    /**
     * Two calls with the key: the list of models (free: a wrong key and an unreachable OpenAI each get their own words),
     * then the smallest answer from the assistant's model (a few tokens, a tiny fraction of a cent), the only call that
     * sees an account with no credit left. (bridge/own-openai.js MODELS.text is the same model.)
     */
    fun check(key: String): Check = runCatching {
        val c = URL("$OPENAI/v1/models").openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 10_000; c.readTimeout = 15_000
            c.setRequestProperty("authorization", "Bearer $key")
            when (c.responseCode) {
                200 -> credit(key)
                401 -> Check.No("OpenAI didn't accept that key. Check you copied all of it, or make a new one.")
                403 -> Check.No(NO_ACCESS)
                429 -> Check.No(NO_CREDIT)
                else -> Check.No("OpenAI didn't answer properly (${c.responseCode}). Try again in a minute.")
            }
        } finally { c.disconnect() }
    }.getOrElse { Log.d(TAG, "check: ${it.javaClass.simpleName}"); Check.No("The tablet couldn't reach OpenAI. Check the Wi-Fi and try again.") }

    /** The billed half of [check]: out of credit (429) or no access to the model (403) is said; anything else lets it in. */
    private fun credit(key: String): Check = runCatching {
        val c = URL("$OPENAI/v1/responses").openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 10_000; c.readTimeout = 30_000; c.instanceFollowRedirects = false
            c.setRequestProperty("authorization", "Bearer $key"); c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(JSONObject().put("model", "gpt-6-luna").put("input", "OK").put("max_output_tokens", 16).put("store", false).toString().toByteArray()) }
            when (c.responseCode) { 429 -> Check.No(NO_CREDIT); 403 -> Check.No(NO_ACCESS); else -> Check.Ok }
        } finally { c.disconnect() }
    }.getOrDefault(Check.Ok)

    /** Where a call of [kind] may go: only a fixed path at OpenAI's own address, else null. */
    fun target(kind: String): String? = CALLS[kind]?.let { "$OPENAI$it" }

    /**
     * The bridge's call with the key (DeviceServer /openai): [kind] picks the fixed path, [body] is sent as it is with
     * the key added here. OpenAI's status and answer come back; the key never does. Refused with no key or an unknown kind.
     */
    fun forward(kind: String, body: String): Pair<Int, String> {
        val to = target(kind) ?: return 404 to JSONObject().put("error", "not a call this route makes").toString()
        val key = if (::ctx.isInitialized) read() else null
        key ?: return 409 to JSONObject().put("error", "no_key").toString()
        return runCatching {
            val c = URL(to).openConnection() as HttpURLConnection
            try {
                c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 10_000; c.readTimeout = 120_000
                c.instanceFollowRedirects = false // only OpenAI's own address, never where it might send us
                c.setRequestProperty("authorization", "Bearer $key"); c.setRequestProperty("content-type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
                val code = c.responseCode
                code to ((if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: "{}")
            } finally { c.disconnect() }
        }.getOrElse { 502 to JSONObject().put("error", "openai unreachable").toString() }
    }

    /** Tells the bridge whether a key is in (only that); the voice follows at once (on with a key, CloudSetup.refreshVoice). */
    private fun tellBridge(bridge: String, on: Boolean) = runCatching { CloudSetup.post("$bridge/cloud/own", JSONObject().put("on", on)); CloudSetup.refreshVoice(ctx, bridge) }

    // --- the adult's screens: put a key in, change it, take it out (behind the PIN) -------------------------

    /** Why the key isn't working, from the bridge (cloud.js voiceNeed), as Settings says it. */
    private val NEED = mapOf(
        "own_key_refused" to "OpenAI stopped accepting this key. Put in a new one.",
        "own_key_limit" to "OpenAI says this account is out of credit or over its limit. Add credit on OpenAI's site.",
        "no_key" to "The key isn't on this device any more. Put it in again.",
        "own_stop" to "This month's stop is reached, so Opie's voice and assistant wait for next month or a higher stop.",
    )
    /** The monthly stops on offer, in cents (bridge cloud.js STOPS, which refuses any other). */
    private val STOPS = listOf(500, 1000, 2000, 5000, 10000, 20000)
    private fun dollars(cents: Int) = "$${cents / 100}"
    private const val MORE = "Make a key at platform.openai.com, under API keys. What's said after “Hey Opie” then goes to OpenAI on your own account, not through Opie's cloud, and OpenAI bills you. Opie stops for the month at the monthly stop set here."

    /** Today's card (the home page: HomeView ownKey) while the voice can't answer: [why] is the bridge's voiceNeed. */
    fun fromToday(act: MainActivity, why: String) {
        if (why.startsWith("gemini_")) return GeminiKey.fromToday(act, why) // (Google's voice, on the household's Gemini key)
        if (why == "own_stop" && has()) act.lock.withPin("Monthly stop") { stop(act) } else menu(act)
    }

    /** Settings → Opie → Voice → Your own keys → OpenAI key, and turning the voice on where Opie cloud's voice isn't available:
     *  with a key in, its monthly stop, changing it and taking it out. */
    fun menu(act: MainActivity) = act.lock.withPin("Your own OpenAI key") {
        if (!has()) return@withPin enter(act)
        thread {
            val v = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("${act.bridge}/cloud/voice", 3000, 8000)) }.getOrNull()
            val stop = v?.optInt("stopCents", 0) ?: 0
            val why = v?.takeIf { !it.isNull("need") }?.optString("need")
            act.runOnUiThread {
                val rows = listOfNotNull(if (stop > 0) "Monthly stop: ${dollars(stop)}" else null, "Change the key", "Remove the key")
                CalmDialog(act).setTitle("Your own OpenAI key")
                    .setMessage(NEED[why] ?: "Opie uses your OpenAI account for its voice and assistant, and OpenAI bills you.")
                    .setItems(rows.toTypedArray()) { _, i -> when (i - (rows.size - 2)) { 0 -> enter(act); 1 -> remove(act); else -> stop(act) } }
                    .setNegativeButton("Back", null).show()
            }
        }
    }

    /** The monthly stop: what this month may cost on the key at most, from the estimate (bridge usage.js); then the voice,
     *  the assistant and Decisions wait until next month (cloud.js ownLeft). Behind the PIN, as the menu is. */
    private fun stop(act: MainActivity) = thread {
        val v = runCatching { JSONObject(dev.openhouse.ui.BridgeClient.getText("${act.bridge}/cloud/voice", 3000, 8000)) }.getOrNull()
        val now = v?.optInt("stopCents", 0) ?: 0
        act.runOnUiThread {
            CalmDialog(act).setTitle("Monthly stop").setMessage("Opie stops using your key for the rest of the month once it has cost about this much.")
                .setSingleChoiceItems(STOPS.map { dollars(it) }.toTypedArray(), STOPS.indexOf(now)) { d, i ->
                    d.dismiss()
                    thread {
                        val (_, r) = CloudSetup.post("${act.bridge}/cloud/own/stop", JSONObject().put("cents", STOPS[i]))
                        act.runOnUiThread { if (r == null || r.has("error")) act.toast("That wasn't saved. Try again") else { act.toast("Stops at ${dollars(STOPS[i])} a month"); dev.openhouse.ui.Openhouse.settingsChanged() } }
                    }
                }.setNegativeButton("Back", null).show()
        }
    }

    /**
     * Put a key in: from a phone on this Wi-Fi (the QR code: [Handoff], sealed, straight to the shell, as their own
     * storage's key comes: OwnStorage.setUp), or typed here with a keyboard. A person's own tap (Opie's does nothing:
     * DeviceServer.personOnly), behind the PIN as the menu is; the key never reaches the bridge or Opie.
     */
    private fun enter(act: MainActivity) {
        if (DeviceServer.personOnly("Putting in an OpenAI key")) return
        var dialog: android.app.Dialog? = null
        var got: String? = null
        val info = JSONObject().put("title", "Your OpenAI key").put("field", "OpenAI key").put("hint", "sk-…")
            .put("link", "https://platform.openai.com/api-keys").put("linkText", "Make a key at OpenAI").put("done", "Sent. Check the device.")
        val h = Handoff(act, info, minutes = 15, onSecret = { got = it.optString("value"); dialog?.dismiss() }, onEnd = { if (got == null) dialog?.dismiss() })
        if (!h.start()) return type(act)
        val qr = android.widget.ImageView(act).apply { setImageBitmap(Handoff.qr(h.url!!, 520)) }
        val col = Calm.column(act, 12).apply {
            gravity = android.view.Gravity.CENTER_HORIZONTAL
            addView(Calm.qr(act, qr, Calm.caption(act, "Scan with a phone on this Wi-Fi, then paste the key there."), 360) { Handoff.share(act, h.url!!) })
            addView(Calm.quiet(act, "Type it here instead") { dialog?.dismiss(); type(act) })
            addView(Calm.more(act, MORE))
        }
        dialog = CalmDialog(act).setTitle("Add an OpenAI key").setView(col).setNegativeButton("Cancel", null)
            .setOnDismissListener { h.stop(); got?.let { use(act, it) } }.show()
    }

    /** Typed or pasted on the device (a keyboard cover). */
    private fun type(act: MainActivity) {
        val box = Calm.field(act, "sk-…").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        val col = Calm.column(act, 12).apply { addView(box) }
        CalmDialog(act).setTitle("Add an OpenAI key").setView(col).setWidth(760f).setMore(MORE)
            .setPositiveButton("Check and use it") { _, _ -> use(act, box.text.toString()) }
            .setNegativeButton("Cancel", null).show()
    }

    /** Checked ([check]), then kept and the bridge told; else why not. */
    private fun use(act: MainActivity, raw: String) {
        val key = clean(raw) ?: return say(act, "That isn't an OpenAI key", "A key starts with sk- and is one long line. Copy all of it.")
        act.toast("Checking it…")
        thread {
            when (val r = check(key)) {
                is Check.Ok -> { write(key); tellBridge(act.bridge, true); act.runOnUiThread { act.toast("Your key works. Opie uses it now") } }
                is Check.No -> act.runOnUiThread { say(act, "That key didn't work", r.say) }
            }
        }
    }

    /**
     * A key sent from the phone or computer the tablet is being set up from (DeviceServer /ownkey): checked, then kept,
     * with the PIN first if the lock is on. [done]: null once it's in, else what went wrong, in words for that phone.
     */
    fun offer(act: MainActivity, raw: String, done: (String?) -> Unit) {
        val key = clean(raw) ?: return done("That isn't an OpenAI key. A key starts with sk- and is one long line: copy all of it.")
        val go = {
            thread {
                when (val r = check(key)) {
                    is Check.Ok -> { write(key); tellBridge(act.bridge, true); act.runOnUiThread { act.toast("Your OpenAI key works. Opie uses it now") }; done(null) }
                    is Check.No -> done(r.say)
                }
            }
            Unit
        }
        if (!act.lock.asks(PinChoices.SETTINGS)) return go()
        PinPrompt.ask(act, act, "Use the OpenAI key sent from the phone?", { go() }, cancelled = { done("Nobody typed the PIN on the device, so the key wasn't kept.") })
    }

    private fun remove(act: MainActivity) {
        CalmDialog(act).setTitle("Remove your key?").setMessage("Opie stops using your OpenAI account at once.")
            .setPositiveButton("Remove") { _, _ ->
                synchronized(this) { file.delete() }
                thread { tellBridge(act.bridge, false) }
            }.setNegativeButton("Cancel", null).show()
    }

    private fun say(act: Activity, title: String, text: String) { CalmDialog(act).setTitle(title).setMessage(text).setPositiveButton("Close", null).show() }
}
