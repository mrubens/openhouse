package dev.openhouse.shell

import android.accounts.AccountManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.util.Log

/**
 * A Google account on a shared device (Google Play, or YouTube TV's own sign-in) reaches everything of that person's in
 * Google's apps. So while one is signed in, Opie, as device owner, keeps their mail, photos, files, contacts and
 * calendar out of reach (docs/device-control.md, "A Google account on the device"):
 *  - the Google apps that open them are hidden (nobody can open them, Opie included), unless someone chose to show them
 *    (Settings → Connections → Google Play, a person's own, with the PIN);
 *  - the account's mail, contacts and calendar don't sync to the device (so the device's own Contacts and Calendar,
 *    a Samsung's too, don't get them);
 *  - Chrome stays, but can't sign in to Google or sync, and won't open Gmail: Google's sites open signed out.
 * YouTube TV, YouTube and Play keep the account. Applied when the shell starts and whenever accounts change.
 */
object GooglePrivacy {
    private const val TAG = "GooglePrivacy"
    private const val GOOGLE = "com.google"
    private const val CHROME = "com.android.chrome"

    /** Gmail, Google Photos, Drive, Contacts, Calendar. */
    private val HIDE = listOf("com.google.android.gm", "com.google.android.apps.photos", "com.google.android.apps.docs",
        "com.google.android.contacts", "com.google.android.calendar")
    /** Mail, contacts and calendar sync for the account. */
    private val NO_SYNC = listOf("gmail-ls", "com.google.android.gm.email", "com.android.contacts", "com.android.calendar")

    private var listening = false

    fun start(c: Context) {
        val app = c.applicationContext
        apply(app)
        if (listening) return
        listening = true
        runCatching { AccountManager.get(app).addOnAccountsUpdatedListener({ apply(app) }, null, false) }
            .onFailure { Log.w(TAG, "accounts listener: $it") }
    }

    /** Someone chose to have the Google apps showing (Settings → Connections → Google Play). */
    fun shown(c: Context) = c.getSharedPreferences("shell", Context.MODE_PRIVATE).getBoolean("googleAppsShown", false)

    fun setShown(c: Context, on: Boolean) {
        c.getSharedPreferences("shell", Context.MODE_PRIVATE).edit().putBoolean("googleAppsShown", on).apply()
        apply(c)
    }

    @Synchronized fun apply(c: Context) {
        val dpm = c.getSystemService(DevicePolicyManager::class.java) ?: return
        if (!dpm.isDeviceOwnerApp(c.packageName)) return
        val admin = ComponentName(c, AdminReceiver::class.java)
        val accounts = runCatching { AccountManager.get(c).getAccountsByType(GOOGLE).toList() }.getOrDefault(emptyList())
        val hide = accounts.isNotEmpty() && !shown(c)
        for (p in HIDE) runCatching { if (dpm.isApplicationHidden(admin, p) != hide) dpm.setApplicationHidden(admin, p, hide) }
        for (a in accounts) for (auth in NO_SYNC) runCatching { ContentResolver.setSyncAutomatically(a, auth, false); ContentResolver.setIsSyncable(a, auth, 0) }
            .onFailure { Log.w(TAG, "sync $auth: $it") }
        // Chrome's own policies (its managed configuration): no Google sign-in or sync, and no Gmail.
        runCatching {
            dpm.setApplicationRestrictions(admin, CHROME, Bundle().apply {
                putInt("BrowserSignin", 0)
                putBoolean("SyncDisabled", true)
                putStringArray("URLBlocklist", arrayOf("mail.google.com", "gmail.com", "inbox.google.com"))
            })
        }.onFailure { Log.w(TAG, "chrome: $it") }
        Log.i(TAG, "${accounts.size} Google account(s); apps ${if (hide) "hidden" else "showing"}")
    }
}
