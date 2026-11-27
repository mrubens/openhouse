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
 * and removing it are a grown-up's, behind the PIN.
 * The key comes in typed or pasted here ([menu]: Settings → Voice, Your own OpenAI key) or sent from a settings page
 * ([offer]: bridge /setup/openai): sealed, straight here.
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

    /**
     * One cheap call with the key: the list of models, which costs nothing. A wrong key and an unreachable OpenAI each get
     * their own words. (Whether the account has money left and the live voice model is known only from a billed call or
     * the live model's name, which come with the requests: see [CALLS].)
     */
    fun check(key: String): Check = runCatching {
        val c = URL("$OPENAI/v1/models").openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 10_000; c.readTimeout = 15_000
            c.setRequestProperty("authorization", "Bearer $key")
            when (c.responseCode) {
                200 -> Check.Ok
                401 -> Check.No("OpenAI didn't accept that key. Check you copied all of it, or make a new one.")
                403 -> Check.No("That key can't be used from here. On OpenAI's site, give it access to all models, or make a new one.")
                429 -> Check.No("OpenAI says that account is out of credit or over its limit. Add credit on OpenAI's site, then try again.")
                else -> Check.No("OpenAI didn't answer properly (${c.responseCode}). Try again in a minute.")
            }
        } finally { c.disconnect() }
    }.getOrElse { Log.d(TAG, "check: ${it.javaClass.simpleName}"); Check.No("The tablet couldn't reach OpenAI. Check the Wi-Fi and try again.") }

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

    // --- the grown-up's screens: put a key in, change it, take it out (behind the PIN) -------------------------

    /** Settings → Voice → Your own OpenAI key, and turning the voice on where Opie cloud's voice isn't available. */
    fun menu(act: MainActivity) = act.lock.withPin("Your own OpenAI key") {
        if (!has()) return@withPin enter(act)
        CalmDialog(act).setTitle("Your own OpenAI key")
            .setMessage("Opie uses your OpenAI account for its voice and assistant, and OpenAI bills you. Set a monthly budget on the key at OpenAI too.")
            .setPositiveButton("Change it") { _, _ -> enter(act) }
            .setNeutralButton("Remove it") { _, _ -> remove(act) }
            .setNegativeButton("Close", null).show()
    }

    private fun enter(act: MainActivity) {
        val box = Calm.field(act, "sk-…").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        val col = Calm.column(act, 12).apply { addView(box) }
        CalmDialog(act).setTitle("Use your own OpenAI key")
            .setMessage("Make a key at platform.openai.com, under API keys, then paste it here. What you say after “Hey Opie” then goes to OpenAI on your own account, not through Opie's cloud.")
            .setView(col).setWidth(760f)
            .setPositiveButton("Check and use it") { _, _ ->
                val key = clean(box.text.toString()) ?: return@setPositiveButton say(act, "That isn't an OpenAI key", "A key starts with sk- and is one long line. Copy all of it.")
                thread {
                    when (val r = check(key)) {
                        is Check.Ok -> { write(key); tellBridge(act.bridge, true); act.runOnUiThread { act.toast("Your key works. Opie uses it now") } }
                        is Check.No -> act.runOnUiThread { say(act, "That key didn't work", r.say) }
                    }
                }
            }.setNegativeButton("Cancel", null).show()
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
        PinPrompt.ask(act, act, "Use the OpenAI key sent from the phone?", { go() }, cancelled = { done("Nobody typed the PIN on the tablet, so the key wasn't kept.") })
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
