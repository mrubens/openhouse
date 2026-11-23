package dev.openhouse.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * After the shell is updated, Android doesn't reopen it: the tablet sat on Samsung's launcher,
 * out of kiosk mode, until someone started it. Reopen the board as the home screen. A device
 * owner may start activities from the background, so this works with nobody at the screen.
 */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        context.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            .setClass(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
