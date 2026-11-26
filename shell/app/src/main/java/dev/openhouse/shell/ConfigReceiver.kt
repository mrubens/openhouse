package dev.openhouse.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Settings only a person at a computer may change: from adb only, since the receiver requires the DUMP
 * permission that the shell user has and other apps can't get. (MainActivity is exported, so it takes no
 * settings from its intent any more.)
 *
 *   adb shell am broadcast -n dev.openhouse.shell/.ConfigReceiver -a dev.openhouse.shell.CONFIG \
 *     [--es pin 1234 | --es pin ""] [--es bridge http://127.0.0.1:8787] [--es ui http://127.0.0.1:5173/] \
 *     [--es runtime http://127.0.0.1:8000/runtime.tar.gz] [--ei mic 1] [--ei micPlain 9] [--es micFx agc,ns,aec] [--ez listen true] [--ez token true] [--es say "A sentence. Another."] [--es partial "words being heard"]
 *     [--es update_url https://…/update.json | --es update_url ""] [--es update_hours 2-5] [--ei update_health_s 300] [--es update_channel beta]
 *     [--ez update_check true] [--ez update_install true]
 *     [--ez cloud_checkin true] [--es voice_url https://…/voice.json | --es voice_url ""] [--ez voice_get true]
 *
 * `--ez token true` prints the bridge's secret as the broadcast's result data (scripts/bridge-token.sh).
 * `--ez listen …` is the microphone (Settings, Hey Opie; an emulator starts with it off).
 * `--es say …` has the display say that aloud (`--es say ""` cuts it off), sentence by sentence as an answer is said: for testing how it
 * speaks and hears itself, with nobody asking anything.
 * `update_*`: self-update (Updater, docs/self-update.md): where its manifest is ("" for the build's own), the hours it
 * may install in ("0-24": any), how long a new display has to come up healthy; check now; install what's ready now
 * (Settings, Updates, "Install now").
 * `voice_url`: where the listening models' set is (VoiceModels, docs/voice-models.md; "" for the build's own);
 * `--ez voice_get true` gets it now if it isn't in place (it's otherwise fetched while listening is on).
 * `--ez cloud_checkin true` sends a health check-in now (CloudHealth; only if the tablet is linked).
 * `--ez settings true` opens Settings.
 * `--es pin` with digits turns the lock on with that PIN; `--es pin ""` turns it off.
 * `--es mail_host imap.example.com --es mail_user tablet@example.com --es mail_password <app password> [--ei mail_port 993]`:
 * the household's own mailbox (MailAccount, docs/tablet-email.md), as Settings → Email's form adds it (signed in first,
 * sealed, from the mail after now); the result data says "ok" or what went wrong. `--ez mail_remove true` removes it.
 */
class ConfigReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val prefs = ctx.getSharedPreferences("shell", Context.MODE_PRIVATE)
        intent.getStringExtra("pin")?.let { pin -> if (pin.isEmpty()) ParentPin.clear(ctx) else if (ParentPin.valid(pin)) ParentPin.set(ctx, pin); MainActivity.live?.lock?.changed() }
        val e = prefs.edit()
        for (k in listOf("ui", "bridge")) intent.getStringExtra(k)?.let { if (localUrl(it)) e.putString(k, it) } // the token goes to the bridge
        intent.getStringExtra("runtime")?.let { if (it.startsWith("http")) e.putString("runtime_url", it) }
        intent.getStringExtra("voice_url")?.let { if (it.isEmpty() || it.startsWith("http")) e.putString("voice_url", it) } // "" for the build's own
        if (intent.hasExtra("mic")) e.putInt("mic", intent.getIntExtra("mic", 7))
        // As the setup QR would (Provisioning): link with this setup code once the runtime is up (an emulator has no QR setup).
        intent.getStringExtra("cloud_link_token")?.takeIf { CloudSetup.TOKEN.matches(it) }?.let { e.putString("cloud_link_token", it); CloudSetup.linkSoon(); android.util.Log.i("CloudSetup", "setup code saved (adb)") }
        intent.getStringExtra("cloud_link_api")?.takeIf { it.startsWith("https://") || it.startsWith("http://10.0.2.2:") }?.let { e.putString("cloud_link_api", it) }
        intent.getStringExtra("micFx")?.let { e.putString("micFx", it) } // the platform effects listening adds: agc, ns, aec, comma-separated ("" none)
        if (intent.hasExtra("micPlain")) e.putInt("micPlain", intent.getIntExtra("micPlain", -1)) // the source while the bridge cancels echo (-1: the plainest the device has)
        e.commit()
        intent.getStringExtra("update_channel")?.let { ch -> if (Regex("^[a-z0-9-]{1,32}$").matches(ch)) ctx.getSharedPreferences("update", Context.MODE_PRIVATE).edit().putString("channel", ch).commit() }
        if (intent.hasExtra("update_url") || intent.hasExtra("update_hours") || intent.hasExtra("update_health_s"))
            Updater.configure(ctx, intent.getStringExtra("update_url")?.takeIf { it.isEmpty() || it.startsWith("http") }, intent.getStringExtra("update_hours"),
                if (intent.hasExtra("update_health_s")) intent.getIntExtra("update_health_s", 300) else null)
        if (intent.getBooleanExtra("update_check", false)) Updater.checkNow(ctx, install = intent.getBooleanExtra("update_install", false)) { android.util.Log.i("Updater", "check: $it") }
        else if (intent.getBooleanExtra("update_install", false)) Updater.installNow(ctx)
        if (intent.getBooleanExtra("cloud_checkin", false)) kotlin.concurrent.thread { runCatching { CloudHealth.checkIn(ctx, MainActivity.live?.bridge ?: "http://127.0.0.1:8787") } }
        if (intent.getBooleanExtra("voice_get", false)) VoiceModels.ensure(ctx, MainActivity.live?.bridge ?: "http://127.0.0.1:8787", now = true)
        if (intent.getBooleanExtra("mail_remove", false) || intent.hasExtra("mail_host")) return mailbox(ctx, intent)
        if (intent.getBooleanExtra("token", false)) resultData = BridgeToken.get(ctx)
        if (intent.getBooleanExtra("settings", false)) dev.openhouse.ui.Openhouse.ui { dev.openhouse.ui.Openhouse.showSettings = true }
        if (intent.hasExtra("listen")) MainActivity.live?.setListening(intent.getBooleanExtra("listen", true))
        if (android.os.Build.HARDWARE == "ranchu") intent.getStringExtra("liveMood")?.let { LiveVoice.pretend(it); return } // emulator only: a live session's look, for screenshots
        if (android.os.Build.HARDWARE == "ranchu") intent.getStringExtra("setupStep")?.let { s -> dev.openhouse.ui.Openhouse.ui { dev.openhouse.ui.Setup.go(s.ifEmpty { null }) }; return } // emulator only: a setup step, for screenshots
        intent.getStringExtra("say")?.let { dev.openhouse.ui.Openhouse.sayAloud(it); return }
        // As if someone were saying this right now (for checking how it looks; it goes nowhere).
        intent.getStringExtra("partial")?.let { t -> dev.openhouse.ui.Openhouse.ui { val o = dev.openhouse.ui.Openhouse; o.partial = t; o.hearingAt = System.currentTimeMillis() }; return }
        MainActivity.live?.configChanged()
    }

    /** The own mailbox from adb: signing in takes a few seconds, so off the main thread. Never logs the password. */
    private fun mailbox(ctx: Context, intent: Intent) {
        val done = goAsync()
        val bridge = MainActivity.live?.bridge ?: "http://127.0.0.1:8787"
        MailAccount.init(ctx)
        kotlin.concurrent.thread {
            try {
                val tell = { own: Boolean -> runCatching { CloudSetup.post("$bridge/mail/set", org.json.JSONObject().put("own", own)) } }
                if (intent.getBooleanExtra("mail_remove", false)) { MailAccount.remove(); tell(false); done.resultData = "ok"; return@thread }
                val host = intent.getStringExtra("mail_host")?.trim()?.lowercase().orEmpty()
                val user = intent.getStringExtra("mail_user")?.trim().orEmpty(); val pass = intent.getStringExtra("mail_password").orEmpty()
                val port = intent.getIntExtra("mail_port", 993)
                done.resultData = when {
                    !Regex("^[a-z0-9.-]+\\.[a-z]{2,}$").matches(host) || port !in 1..65535 -> "bad mail_host or mail_port"
                    user.isEmpty() || pass.isEmpty() -> "mail_user and mail_password are both needed"
                    else -> MailAccount.add(host, port, user, pass) ?: "ok".also { tell(true) }
                }
            } finally { done.finish() }
        }
    }
}
