package dev.openhouse.shell

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.os.PersistableBundle

/** Lets the shell be device owner, which is what kiosk mode (lock task) needs. */
class AdminReceiver : DeviceAdminReceiver() {
    /** The old display handed the tablet over (Move.kt): Home and kiosk mode are this display's now. */
    override fun onTransferOwnershipComplete(context: Context, bundle: PersistableBundle?) = Move.becameOwner(context)
}
