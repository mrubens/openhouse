package dev.openhouse.shell

import android.app.Activity
import android.media.AudioManager
import dev.openhouse.ui.CalmDialog
import dev.openhouse.ui.RoomVolume

/**
 * Settings → Screen → Volume: the household's volume (the media stream: music, Opie's voice, the timers, as the keys and Opie's
 * volume tool set it) and "Adjust to the room" (RoomVolume: Opie and the timers a little louder in a noisy room,
 * quieter in a quiet one and at night). Not behind the PIN, like Brightness: anyone in the room can hear it.
 */
object VolumeSetting {
    private val LEVELS = listOf("Low" to 25, "Medium" to 50, "High" to 75, "Full" to 100)

    private fun am(a: Activity) = a.getSystemService(Activity.AUDIO_SERVICE) as AudioManager
    private fun level(a: Activity): Int { val am = am(a); val M = AudioManager.STREAM_MUSIC; return am.getStreamVolume(M) * 100 / am.getStreamMaxVolume(M).coerceAtLeast(1) }

    /** What the row shows: Muted, or the nearest named level. */
    fun label(a: Activity): String { val l = level(a); return if (l == 0) "Muted" else LEVELS.minByOrNull { kotlin.math.abs(it.second - l) }!!.first }

    fun choose(a: Activity, immersive: () -> Unit, done: () -> Unit) {
        val now = label(a)
        val rows = LEVELS.map { (name, _) -> CalmDialog.Row(name, value = if (name == now) "Now" else null) } +
            CalmDialog.Row("Adjust to the room", value = if (RoomVolume.on) "On" else "Off")
        CalmDialog(a).setTitle("Volume").setRows(rows) { _, i ->
            if (i < LEVELS.size) {
                val am = am(a); val M = AudioManager.STREAM_MUSIC
                am.setStreamVolume(M, (LEVELS[i].second * am.getStreamMaxVolume(M) + 50) / 100, 0)
                // A short sound at the new level, so it's heard and not only read.
                runCatching { android.media.ToneGenerator(AudioManager.STREAM_MUSIC, 100).startTone(android.media.ToneGenerator.TONE_PROP_ACK, 150) }
                done()
            } else { RoomVolume.on = !RoomVolume.on; done(); choose(a, immersive, done) }
        }.setNegativeButton("Close", null).show().also { immersive() }
    }
}
