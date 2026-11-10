package com.langhua98.xiaoju.remote

import android.annotation.TargetApi
import android.app.PendingIntent
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File

/**
 * 静默安装（0.30）：没有 root 也不用人点，用系统的 PackageInstaller 装新版本。两种情况系统允许：
 *
 *  1. 法莉娅是「设备所有者」（Android 5 起）。手机上不能登录任何账号，用 adb 设一次：
 *       adb shell dpm set-device-owner com.langhua98.xiaoju.remote/.AdminReceiver
 *     取消：发 {"do":"update","owner":"release"}（之后要先取消才能卸载法莉娅）。
 *  2. Android 12 起，App 更新自己可以不要人确认（setRequireUserAction）。条件是上一次是法莉娅自己装的
 *     （「安装来源」是法莉娅），并且允许了「安装未知应用」。第一次用文件管理器装的，系统会要人确认一次，
 *     之后就都不用了。Android 14 起还要 UPDATE_PACKAGES_WITHOUT_USER_ACTION 权限（普通权限，清单里有）。
 *
 * Android 4.2（S4）没有这些，只能靠 root。
 * 结果由系统异步交给 InstallResultReceiver：装好了进程被杀，UpdateReceiver 把待命开回来。
 */
@TargetApi(21)
object SilentInstall {
    const val ACTION = "com.langhua98.xiaoju.remote.INSTALL_RESULT"

    fun isOwner(ctx: Context): Boolean = runCatching {
        (ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager).isDeviceOwnerApp(ctx.packageName)
    }.getOrDefault(false)

    /** 这台手机能不能试静默安装。 */
    fun possible(ctx: Context) = isOwner(ctx) || Build.VERSION.SDK_INT >= 31

    /** 把安装包写进一个安装会话并提交。返回 null = 已提交（结果等 InstallResultReceiver），否则是没开始的原因。 */
    fun start(ctx: Context, f: File, label: String): String? {
        val installer = ctx.packageManager.packageInstaller
        var id = -1
        return try {
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= 31) SilentApi31.noUserAction(params)
            id = installer.createSession(params)
            val session = installer.openSession(id)
            try {
                session.openWrite("falia.apk", 0, f.length()).use { out ->
                    f.inputStream().use { it.copyTo(out, 64 * 1024) }
                    session.fsync(out)
                }
                val intent = Intent(ctx, InstallResultReceiver::class.java).setAction(ACTION).putExtra(EXTRA_LABEL, label)
                // 系统要往这个 PendingIntent 里填结果，Android 12 起要明说可以改（FLAG_MUTABLE）
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) 0x02000000 else 0)
                session.commit(PendingIntent.getBroadcast(ctx, 7, intent, flags).intentSender)
            } finally {
                session.close()
            }
            null
        } catch (e: Exception) {
            if (id >= 0) runCatching { installer.abandonSession(id) }
            e.message ?: e.javaClass.simpleName
        }
    }

    /** 不再当设备所有者（之后才能正常卸载法莉娅）。返回给控制端看的话。 */
    fun releaseOwner(ctx: Context): String {
        if (!isOwner(ctx)) return "法莉娅本来就不是设备所有者"
        return try {
            @Suppress("DEPRECATION")
            (ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager).clearDeviceOwnerApp(ctx.packageName)
            "已经不是设备所有者了：以后没有 root 的话，更新又要人点（Android 12 以上除外）"
        } catch (e: Exception) {
            "取消设备所有者失败：${e.message ?: e.javaClass.simpleName}"
        }
    }

    const val EXTRA_LABEL = "label"
}

@TargetApi(31)
private object SilentApi31 {
    fun noUserAction(p: PackageInstaller.SessionParams) {
        p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }
}

/** 静默安装的结果。 */
class InstallResultReceiver : BroadcastReceiver() {
    @Suppress("DEPRECATION")
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != SilentInstall.ACTION || Build.VERSION.SDK_INT < 21) return
        val label = intent.getStringExtra(SilentInstall.EXTRA_LABEL).orEmpty()
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // 系统要人确认一次（上一次不是法莉娅自己装的，或者还没允许「安装未知应用」）。确认这一次以后就不用了。
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: run {
                    Updater.askUser(ctx, null, label); return
                }
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                Bus.push("系统要人确认一次安装（以后法莉娅自己更新就不用了）")
                Updater.notifyUpdate(ctx, "新版本 $label 下好了，点这里确认安装", confirm)
                if (Build.VERSION.SDK_INT < 29) runCatching { ctx.startActivity(confirm) }
            }
            PackageInstaller.STATUS_SUCCESS -> Bus.push("静默装好了，法莉娅马上重启")
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "状态 $status"
                Bus.push("静默安装失败（$msg），改成弹安装界面")
                Updater.askUser(ctx, null, label)
            }
        }
    }
}

/** 设备管理员入口：只为了能用 adb 把法莉娅设成设备所有者（静默安装），不用任何管理权限。 */
class AdminReceiver : DeviceAdminReceiver()
