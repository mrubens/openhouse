package dev.openhouse.shell

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle

/**
 * Setting a freshly reset tablet up from a QR code (docs/self-update.md, "Setup without a cable"): Android's setup
 * downloads the display, then asks it how to be set up (GET_PROVISIONING_MODE: as the device's owner, the whole
 * tablet) and, once it is owner, to finish (ADMIN_POLICY_COMPLIANCE). Nothing to ask the family here: the display's
 * own first start does the rest (kiosk mode, the runtime, signing in).
 */
class ProvisioningActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent.action) {
            DevicePolicyManager.ACTION_GET_PROVISIONING_MODE ->
                setResult(RESULT_OK, Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE))
            DevicePolicyManager.ACTION_ADMIN_POLICY_COMPLIANCE -> { takeExtras(); setResult(RESULT_OK) }
            else -> setResult(RESULT_CANCELED)
        }
        finish()
    }

    /**
     * What the QR code's admin extras carry (scripts/provision-qr.sh): where the runtime image is (it's too big for the
     * APK) and where updates are, when not the build's own. https only. The microphone is granted here (device owner);
     * the rest of tablet-setup.sh's adb-only steps are in docs/self-update.md.
     */
    private fun takeExtras() {
        @Suppress("DEPRECATION")
        val x = intent.getParcelableExtra<android.os.PersistableBundle>(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        val e = getSharedPreferences("shell", MODE_PRIVATE).edit()
        x?.getString("runtime_url")?.takeIf { it.startsWith("https://") }?.let { e.putString("runtime_url", it) }
        x?.getString("voice_url")?.takeIf { it.startsWith("https://") }?.let { e.putString("voice_url", it) } // the listening models, when not the build's own
        // A setup code made on the family's account page (openhouse-cloud/docs/cloud-beta.md): the tablet links itself once it's up (CloudSetup).
        x?.getString("cloud_link_token")?.takeIf { CloudSetup.TOKEN.matches(it) }?.let { e.putString("cloud_link_token", it) }
        x?.getString("cloud_api")?.takeIf { it.startsWith("https://") }?.let { e.putString("cloud_link_api", it) }
        e.commit()
        x?.getString("update_url")?.takeIf { it.startsWith("https://") }?.let { Updater.configure(this, it, null, null) }
        val dpm = getSystemService(DevicePolicyManager::class.java)
        val admin = android.content.ComponentName(this, AdminReceiver::class.java)
        runCatching { dpm.setPermissionGrantState(admin, packageName, android.Manifest.permission.RECORD_AUDIO, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }
        // A setup code made for testing (admin.ts household --setup --debug): USB debugging comes on, and stays allowed
        // under kiosk mode (Kiosk.debugging). A family's own code leaves it off; Settings can still turn it on behind the PIN.
        if (x?.getString("debug") == "1") {
            getSharedPreferences("shell", MODE_PRIVATE).edit().putBoolean("debugging", true).commit()
            runCatching { dpm.setGlobalSetting(admin, android.provider.Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, "1") }
            runCatching { dpm.setGlobalSetting(admin, android.provider.Settings.Global.ADB_ENABLED, "1") }
        }
        // Home is the display from now on: when Android's setup finishes it goes Home, and the display starts (and sets
        // the rest up: DeviceOwner.setUp). Not started from here: this runs inside Android's setup, which must finish first.
        runCatching {
            dpm.addPersistentPreferredActivity(admin, android.content.IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) },
                android.content.ComponentName(this, MainActivity::class.java))
        }
    }
}
