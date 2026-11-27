package dev.openhouse.shell

// Adding Android apps: Google Play, with the household's own Google account signed in on the tablet (Settings →
// Advanced → Google Play, always behind the PIN). Apps and Opie open one app's Play page; a person taps Install there,
// Play installs it, and it goes into Apps (AppStore.addToHome, from the package-added broadcast). docs/device-control.md.

import android.accounts.AccountManager
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

object PlayStore {
    const val PKG = "com.android.vending"
    /** Google's account type, and the apps its sign-in pages are in (let into kiosk only while someone signs in). */
    private const val GOOGLE = "com.google"
    private val SIGN_IN_PKGS = listOf("com.google.android.gms", "com.google.android.gsf.login")
    private const val TAG = "PlayStore"

    /** Google Play is on this device and turned on. */
    fun available(c: Context): Boolean = runCatching { c.packageManager.getApplicationInfo(PKG, 0).enabled }.getOrDefault(false)

    /** The Google accounts signed in on the tablet (a device owner sees them all). */
    fun accounts(c: Context): List<String> = runCatching { AccountManager.get(c).getAccountsByType(GOOGLE).map { it.name } }.getOrDefault(emptyList())
    fun signedIn(c: Context) = accounts(c).isNotEmpty()

    /** Why Android apps can't be added now, as Opie and Add apps say it; null when they can. */
    fun notReady(c: Context): String? = when {
        !available(c) -> "Adding Android apps needs Google Play, and this tablet doesn't have it."
        !signedIn(c) -> "Google Play isn't signed in on this tablet yet. Someone signs in at Settings, Advanced, Google Play."
        else -> null
    }

    /**
     * Android's own Google sign-in (the PIN already asked: Settings → Advanced). Its pages are let into kiosk only until
     * the display is back in front. [done]: the account's name, or null if it wasn't added.
     */
    fun signIn(act: Activity, done: (String?) -> Unit) {
        SIGN_IN_PKGS.forEach { p -> if (AppStore.installed(p)) KioskApps.allowInKiosk(p, temporary = true) }
        runCatching {
            AccountManager.get(act).addAccount(GOOGLE, null, null, null, act, { f ->
                val name = runCatching { f.result.getString(AccountManager.KEY_ACCOUNT_NAME) }.onFailure { Log.i(TAG, "sign-in: $it") }.getOrNull()
                act.runOnUiThread { done(name) }
            }, null)
        }.onFailure { Log.w(TAG, "sign-in didn't start: $it"); done(null) }
    }

    /** Take a Google account off the tablet. False: Android didn't let the shell (the person uses Android's settings). */
    fun signOut(c: Context, name: String): Boolean = runCatching {
        val am = AccountManager.get(c)
        val a = am.getAccountsByType(GOOGLE).firstOrNull { it.name == name } ?: return true
        am.removeAccountExplicitly(a) || am.removeAccount(a, null, null, null).getResult(20, java.util.concurrent.TimeUnit.SECONDS).getBoolean(AccountManager.KEY_BOOLEAN_RESULT)
    }.onFailure { Log.w(TAG, "sign out: $it") }.getOrDefault(false)

    /**
     * One app's page on Google Play, in front of Opie (someone already said yes). Play is let into kiosk until the
     * display is back in front, so Home or Back returns to Opie and it can't be reached again without a new yes.
     * Opie never taps inside it (DeviceRules.handsOff): Install, Buy and the rest are the person's.
     */
    fun openPage(c: Context, pkg: String): Boolean {
        val uri = DeviceRules.playPage(pkg) ?: return false
        if (!available(c)) return false
        KioskApps.allowInKiosk(PKG, temporary = true)
        return runCatching {
            c.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(PKG)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            true
        }.onFailure { Log.w(TAG, "open $pkg: $it") }.getOrDefault(false)
    }

    /** Play itself (its settings, for purchases to need the password), right after someone signed in. */
    fun openPlay(c: Context): Boolean {
        if (!available(c)) return false
        KioskApps.allowInKiosk(PKG, temporary = true)
        val i = c.packageManager.getLaunchIntentForPackage(PKG) ?: return false
        return runCatching { c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)); true }.getOrDefault(false)
    }

    /** Who installed [pkg] (Play, the shell, ...), or null. */
    fun installer(c: Context, pkg: String): String? = runCatching { c.packageManager.getInstallSourceInfo(pkg).installingPackageName }.getOrNull()
}
