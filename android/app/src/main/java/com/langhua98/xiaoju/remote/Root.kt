package com.langhua98.xiaoju.remote

import android.content.Context
import android.os.Build
import java.io.DataOutputStream

/**
 * 有 root 时用来保活：让系统别在息屏时断 Wi-Fi、别把我们当后台回收。都是「锦上添花」，没 root（拿不到 su）就跳过，
 * App 照常能用，只是没这么稳。每条命令都包着 try，失败只记一句，不影响待命。
 *
 * - Wi-Fi 休眠策略设成「始终保持」：老系统息屏后默认会断 Wi-Fi（就收不到指令），这条最关键。
 * - 加进省电 / Doze 白名单：Android 6+ 的 Doze 会推迟后台的网络和闹钟；加了白名单就不推迟。4.2 没有 Doze，这条是给以后换新手机留的。
 */
object Root {
    @Volatile var available: Boolean? = null   // null = 还没试过
        private set
    @Volatile var note = ""
        private set

    /** 在后台线程上跑（有 su 的话会弹授权框，别卡住待命）。 */
    fun apply(ctx: Context) {
        val pkg = ctx.packageName
        val cmds = buildList {
            // Wi-Fi 休眠策略：2 = 始终不休眠。老系统在 Settings.System，新系统在 Settings.Global，两处都写一下。
            add("settings put global wifi_sleep_policy 2")
            add("settings put system wifi_sleep_policy 2")
            if (Build.VERSION.SDK_INT >= 23) {
                add("dumpsys deviceidle whitelist +$pkg")
                add("cmd deviceidle whitelist +$pkg")
            }
        }
        val ok = runAsRoot(cmds)
        available = ok
        note = if (ok) "已用 root 保活：Wi-Fi 不休眠" + (if (Build.VERSION.SDK_INT >= 23) " + 省电白名单" else "")
               else "没有 root（或被拒），用普通保活"
        Bus.push(note)
    }

    /** 把几条命令一次喂给 su。拿不到 su 或执行失败返回 false。 */
    private fun runAsRoot(cmds: List<String>): Boolean = try {
        val p = Runtime.getRuntime().exec("su")
        DataOutputStream(p.outputStream).use { out ->
            for (c in cmds) { out.writeBytes("$c\n"); out.flush() }
            out.writeBytes("exit\n"); out.flush()
        }
        p.waitFor() == 0
    } catch (e: Exception) { false }
}
