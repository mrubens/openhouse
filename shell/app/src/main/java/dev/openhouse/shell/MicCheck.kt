package dev.openhouse.shell

// The microphone check (Settings → Opie → Voice, Check the microphone; or Opie's mic_check, DeviceServer /mic-check): does Opie
// hear this room? A level that moves with the room, then someone says "Hey Opie" and it says plainly what it found:
// heard, too quiet, too noisy, or blocked (not allowed, or another app has the microphone). While it runs the bridge's
// listener only measures (bridge/voice.js /voice/check): a "Hey Opie" opens nothing, and nothing heard is kept, recorded
// or sent anywhere. docs/wake-word.md

import android.Manifest
import android.content.pm.PackageManager
import android.view.View
import dev.openhouse.ui.BridgeClient
import dev.openhouse.ui.Calm
import dev.openhouse.ui.CalmDialog
import org.json.JSONObject
import kotlin.concurrent.thread

internal object MicCheck {
    /** A check is running: the microphone is open for it (MainActivity.micCheck). */
    @Volatile var running = false; private set
    /** The last check's answer: {verdict, at, voiceOff}, for Opie's mic_check. */
    @Volatile var last: JSONObject? = null; private set
    private const val LISTEN_MS = 8000L

    /** What each verdict says, on the card. (Opie says it in its own words, from bridge/devices micCheckDo.) */
    private fun words(v: String, voiceOff: Boolean) = when (v) {
        "heard" -> if (voiceOff) "Opie heard you. Voice is Off, so it won't answer yet." else "Opie heard you."
        "quiet" -> "Too quiet. Come closer, or say it a little louder."
        "noisy" -> "Too noisy here. Try again when it's quieter, or come closer."
        "unclear" -> "Opie heard something, but not “Hey Opie”. Try again, a little closer."
        "silent" -> "The microphone hears nothing. It may be turned off, or another app may be using it."
        "busy" -> "Another app is using the microphone. Close it and try again."
        "permission" -> "Opie isn't allowed to use the microphone."
        "notReady" -> "“Hey Opie” is still getting ready on this device. Try again in a few minutes."
        else -> "Opie couldn't reach the microphone just now. Try again in a moment."
    }

    /** Open the check on the screen and start listening ([act]'s main thread). */
    fun open(act: MainActivity) {
        if (running) return
        if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            done("permission", false)
            CalmDialog(act).setTitle("Check the microphone").setMessage(words("permission", false))
                .setPositiveButton("Allow") { _, _ -> act.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1) }
                .setNegativeButton("Not now", null).show()
            return
        }
        val meter = Meter(act)
        val again = Calm.quiet(act, "Try again") {}.apply { visibility = View.INVISIBLE; setPadding(0, paddingTop, paddingRight, paddingBottom) }
        val box = Calm.column(act, 10).apply {
            addView(meter, android.widget.LinearLayout.LayoutParams(-1, Calm.px(act, 14)))
            addView(again, android.widget.LinearLayout.LayoutParams(-2, -2))
        }
        val dialog = CalmDialog(act).setTitle("Check the microphone").setMessage("Say “Hey Opie”")
        dialog.setView(box).setPositiveButton("Done", null).setOnDismissListener { stop(act); meter.stopped = true }
        dialog.show()
        fun start() {
            again.visibility = View.INVISIBLE; dialog.updateMessage("Say “Hey Opie”")
            run(act) { v, off -> act.runOnUiThread { dialog.updateMessage(words(v, off)); again.visibility = View.VISIBLE } }
        }
        again.setOnClickListener { if (!running) start() }
        start()
    }

    private var session = 0
    /** One try: the microphone open for [LISTEN_MS] (or until its name is heard), then [result] with the verdict. */
    private fun run(act: MainActivity, result: (String, Boolean) -> Unit) {
        running = true; val mine = ++session
        thread {
            // A conversation going holds the microphone: it ends first (Opie said its one line, then goes: mic_check).
            val until = System.currentTimeMillis() + 6000
            while (LiveVoice.active && System.currentTimeMillis() < until) Thread.sleep(200)
            if (LiveVoice.active) act.runOnUiThread { LiveVoice.stopNow() }
            val bridge = act.bridge
            val began = post("$bridge/voice/check", true)
            act.micCheck(true)
            var verdict: String? = if (began == null) "none" else if (!began.optBoolean("on")) began.optString("verdict", "notReady") else null
            val start = System.currentTimeMillis(); var opened = false
            while (verdict == null && running && session == mine && System.currentTimeMillis() - start < LISTEN_MS + (if (opened) 0 else 3000)) {
                Thread.sleep(300)
                if (act.micOpen()) opened = true
                if (silenced(act)) { verdict = "busy"; break }
                val now = runCatching { JSONObject(BridgeClient.getText("$bridge/voice/check", 1500, 2500)) }.getOrNull()
                if (now?.optBoolean("heard") == true) verdict = "heard"
            }
            val end = post("$bridge/voice/check", false)
            act.micCheck(false)
            if (session != mine) return@thread
            running = false
            // The microphone never opened (another app has it), or the bridge's verdict.
            val v = verdict ?: if (!opened && act.micFailed() != null) "busy" else end?.optString("verdict")?.ifEmpty { null } ?: "none"
            val off = !MainActivity.listenOn(act) || !LiveVoice.chosen // (Tap to talk isn't off: a tap answers)
            done(v, off); result(v, off)
        }
    }

    private fun stop(act: MainActivity) {
        if (!running) return
        running = false; session++
        thread { post("${act.bridge}/voice/check", false); act.micCheck(false) }
    }

    private fun done(v: String, voiceOff: Boolean) {
        last = JSONObject().put("verdict", v).put("at", System.currentTimeMillis()).put("voiceOff", voiceOff).put("words", words(v, voiceOff))
        dev.openhouse.ui.Openhouse.vlog("mic-check", v)
    }

    private fun post(url: String, on: Boolean) = runCatching { CloudSetup.post(url, JSONObject().put("on", on)).second }.getOrNull()

    /** Android is giving this recorder silence because another app took the microphone (API 29+). */
    private fun silenced(act: MainActivity): Boolean = runCatching {
        val id = act.micSession(); if (id == 0) return false
        val am = act.getSystemService(android.media.AudioManager::class.java)
        am.activeRecordingConfigurations.any { it.clientAudioSessionId == id && it.isClientSilenced }
    }.getOrDefault(false)

    /** The level, as a bar that moves with the room (the same level the assistant's bars move with: MicLevel). */
    private class Meter(c: android.content.Context) : View(c) {
        @Volatile var stopped = false
        private val track = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = Calm.TINT2 }
        private val fill = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = Calm.INK }
        private var shown = 0f
        override fun onDraw(canvas: android.graphics.Canvas) {
            val r = height / 2f
            canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, track)
            val want = if (running) dev.openhouse.ui.MicLevel.shown() else 0f
            shown += (want - shown) * (if (want > shown) 0.6f else 0.15f)
            if (shown > 0.01f) canvas.drawRoundRect(0f, 0f, maxOf(height.toFloat(), width * shown), height.toFloat(), r, r, fill)
            if (!stopped) postInvalidateDelayed(50)
        }
    }
}
