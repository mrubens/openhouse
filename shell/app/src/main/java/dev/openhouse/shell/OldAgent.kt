package dev.openhouse.shell

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.File

/**
 * Until 1.0.9 the assistant ran pi in an Android app of its own (<id>.agent), which the display installed and kept
 * from being stopped. There's no coding agent on the tablet now (making apps is a computer's: bridge/workshop.js), so
 * an updated display removes that app, once.
 *
 * Nothing of the household's is in it: the conversations, the apps, the household and its data live in the display's
 * own folder (the bridge's chats/, webapp/, household.json), which stay as they are, so the chats stay readable. The
 * agent's app held only its own copy of the apps, pi's sessions (the same turns the chats keep) and its AI sign-in.
 * It goes once the bridge has answered since this update (the display's data is there and being served), and the
 * files the display kept for it (agent-box.json, its status) go with it.
 */
internal object OldAgent {
    private const val TAG = "OldAgent"
    private const val PKG = BuildConfig.AGENT_PKG

    private fun installed(c: Context) = runCatching { c.packageManager.getPackageInfo(PKG, 0); true }.getOrDefault(false)

    /** Called by the watchdog with whether the bridge answered just now. Does its work at most once per launch. */
    @Volatile private var done = false
    fun retire(c: Context, bridgeAnswered: Boolean) {
        if (done || !bridgeAnswered) return
        done = true
        val p = c.getSharedPreferences("shell", Context.MODE_PRIVATE)
        for (f in listOf("display/agent-box.json", "display/agent-box-status.json", "display/agent-model.json")) File(c.filesDir, f).delete()
        p.edit().remove("agent_box_secret").remove("agent_box_from").remove("agent").remove("agent_box_image").apply()
        if (!installed(c)) return
        val dpm = c.getSystemService(DevicePolicyManager::class.java)
        if (!dpm.isDeviceOwnerApp(c.packageName)) { Log.i(TAG, "$PKG is still installed; not the owner, so it stays"); return }
        val admin = ComponentName(c, AdminReceiver::class.java)
        runCatching { // the display kept it from being stopped or removed: let go first
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val kept = dpm.getUserControlDisabledPackages(admin)
                if (PKG in kept) dpm.setUserControlDisabledPackages(admin, kept - PKG)
            }
            if (dpm.isApplicationHidden(admin, PKG)) dpm.setApplicationHidden(admin, PKG, false)
        }.onFailure { Log.w(TAG, "letting go of $PKG: $it") }
        runCatching {
            val i = Intent(c, MainActivity::class.java).setAction("removed")
            c.packageManager.packageInstaller.uninstall(PKG, PendingIntent.getActivity(c, PKG.hashCode(), i, PendingIntent.FLAG_IMMUTABLE).intentSender)
            Log.i(TAG, "removing $PKG (and its data)")
        }.onFailure { Log.w(TAG, "removing $PKG: $it") }
    }
}
