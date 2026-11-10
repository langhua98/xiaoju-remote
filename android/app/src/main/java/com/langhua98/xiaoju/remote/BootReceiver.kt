package com.langhua98.xiaoju.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机自启：手机开机后，如果上次开着「待命」（Prefs.standby），就把服务拉起来，接着收指令、接着侦测。
 * 没开过待命就不动（装了没用的人不会被它打扰）。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") return
        if (Prefs(context).standby) RemoteService.start(context)
    }
}
