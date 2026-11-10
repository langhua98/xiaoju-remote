package com.langhua98.xiaoju.remote

import android.annotation.TargetApi
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * 法莉娅自动更新。
 *
 * 新安装包在哪：GitHub workflow 每次编好都传到小橘云盘 `/软件包/xiaoju-remote-android-<版本>-build<构建号>.apk`
 * （文件夹里只留最新一个）。手机用自己的云盘令牌（要能读 /软件包/）列这个文件夹，比手机上装的新就下载。
 *
 * 怎么装：
 *  - 手机有 root（找得到 su）：`su -c pm install -r` 直接装，不用人点。装完系统会把 App 杀掉，
 *    UpdateReceiver 收到「自己被更新了」再把待命开回来。
 *  - 没有 root：安卓不让普通 App 自己装，只能打开系统的安装界面，要有人点一下「安装」。
 *    Android 10 以下直接弹出安装界面；10 以上后台不能弹界面，只发一条通知「点这里安装」。
 *    Android 8 以上第一次还要在设置里允许法莉娅「安装未知应用」。
 *
 * 下载前先看文件名里的版本，下载后再用系统读一遍安装包：包名要一样、版本不能更旧、签名要和手机上装的一样
 * （签名不一样系统也装不上，提前说清楚）。
 */
class Updater(private val ctx: Context, base: String, private val token: String) {
    private val api = base.trimEnd('/') + "/api/agent/v1"

    class Prepared(val ok: Boolean, val text: String, val pkg: UpdateVersion.Pkg? = null, val file: File? = null)

    /** 云盘「软件包」里的一个安装包。updated 是云盘上的修改时间（字符串，ISO 格式，可以直接比大小）。 */
    class Remote(val id: String, val name: String, val updated: String)

    /** 列云盘「软件包」里所有 .apk。读不了云盘就抛异常。 */
    fun listApks(): List<Remote> {
        val out = ArrayList<Remote>()
        var cursor: String? = null
        do {
            var url = "$api/items?path=${q(FOLDER)}&limit=1000"
            cursor?.let { url += "&cursor=${q(it)}" }
            val j = JSONObject(String(Net.request("GET", url, token), Charsets.UTF_8))
            val arr = j.optJSONArray("children")
            if (arr != null) for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (o.optString("type") != "folder" && UpdateVersion.isApk(o.optString("name")))
                    out.add(Remote(o.optString("id"), o.optString("name"), o.optString("updated_at")))
            }
            cursor = j.optString("next_cursor").ifBlank { null }.takeIf { it != "null" }
        } while (cursor != null)
        return out
    }

    /**
     * 看有没有新的；有就下载并检查好（download = false 时只看不下载）。
     * 返回的 file 不是 null 就是可以装的安装包。
     *
     * 先看 workflow 传的规范名字（`xiaoju-remote-android-<版本>-build<构建号>.apk`），文件名就能比新旧，不用下载。
     * 没有更新的，再看名字不规范的（比如手动传的 app-release.apk）：只能下载下来让系统读版本号和构建号，
     * 不比手机上新的记下来（Prefs.updateSkipped），下次不再下。
     */
    fun prepare(download: Boolean = true): Prepared {
        val prefs = Prefs(ctx)
        val now = currentLabel(ctx)
        val all = try { listApks() } catch (e: HttpError) {
            return Prepared(false, if (e.code == 401 || e.code == 403) "云盘令牌读不了 $FOLDER，查不了更新（${e.message}）"
                                   else "查更新失败：${e.message}")
        } catch (e: Exception) {
            return Prepared(false, "查更新失败：${e.message ?: e.javaClass.simpleName}")
        }
        if (all.isEmpty()) return Prepared(true, "云盘 $FOLDER 里没有安装包，现在是 $now")

        val named = UpdateVersion.newest(all.map { it.name })
        if (named != null && UpdateVersion.isNewer(named, versionName(ctx), BuildConfig.BUILD_NUMBER)) {
            val id = all.first { it.name == named.name }.id
            if (!download) return Prepared(true, "有新版本：${named.label}，现在是 $now", named)
            return fetch(id, named.name) { f ->
                check(f)?.let { err -> Prepared(false, "新版本 ${named.label} 装不了：$err", named) }
                    ?: Prepared(true, "新版本 ${named.label} 下好了（现在是 $now）", named, f)
            } ?: Prepared(false, "新版本 ${named.label} 没下好", named)
        }

        // 名字不规范的：新传的先看，一次最多看 3 个
        val others = all.filter { UpdateVersion.parse(it.name) == null && !prefs.updateSkipped(it.id) }
            .sortedByDescending { it.updated }.take(3)
        for (r in others) {
            if (!download) return Prepared(true, "云盘上有个没看过的安装包 ${r.name}，要下载下来才知道是不是新版本（现在是 $now）")
            val res = fetch(r.id, r.name) { f ->
                val info = archiveInfo(f)
                val err = check(f)
                when {
                    // 别的 App 的包、签名不对的、坏的：记下来跳过，接着看下一个
                    info == null || err != null -> { prefs.markUpdateSkipped(r.id); Bus.push("${r.name} 跳过：${err ?: "安装包坏了"}"); null }
                    !UpdateVersion.isNewerBuild(info.code, info.build, myCode(), BuildConfig.BUILD_NUMBER) -> {
                        prefs.markUpdateSkipped(r.id); null
                    }
                    else -> {
                        val pkg = UpdateVersion.Pkg(r.name, info.name, info.build)
                        Prepared(true, "新版本 ${pkg.label}（${r.name}）下好了（现在是 $now）", pkg, f)
                    }
                }
            }
            if (res == null) { apkFile(ctx).delete(); prefs.updateFile = ""; continue }
            if (res.file != null || !res.ok) return res
        }
        apkFile(ctx).delete()
        return Prepared(true, "已经是最新：$now" + (named?.let { "（云盘上是 ${it.label}）" } ?: ""), named)
    }

    /**
     * 把云盘文件 id 下载成 apkFile（上次已经下好同一个就不再下），再交给 use 判断。
     * 下载失败返回失败；use 返回失败（ok = false）时删掉下好的文件。
     */
    private fun fetch(id: String, name: String, use: (File) -> Prepared?): Prepared? {
        val prefs = Prefs(ctx)
        val f = apkFile(ctx)
        if (!(prefs.updateFile == id && f.exists())) {
            Bus.push("下载安装包 $name…")
            val part = File(ctx.filesDir, PART_NAME)
            try {
                val bytes = Net.download("$api/items/$id/content", token, part)
                f.delete()
                if (!part.renameTo(f)) throw java.io.IOException("存不下安装包")
                prefs.updateFile = id
                Bus.push("下好了：${bytes / 1024} KB")
            } catch (e: Exception) {
                part.delete()
                return Prepared(false, "安装包 $name 下载失败：${e.message ?: e.javaClass.simpleName}")
            }
        }
        // Android 7 以下系统安装界面直接读这个文件，要让别的 App 读得到（files 目录本来就能进）
        if (Build.VERSION.SDK_INT < 24) f.setReadable(true, false)
        val r = use(f)
        if (r != null && r.file == null) { f.delete(); prefs.updateFile = "" }
        return r
    }

    private class ApkInfo(val code: Int, val name: String, val build: Int)

    /** 系统读安装包：versionCode、versionName、构建号（meta-data xiaoju.build，老包没有当 0）。 */
    @Suppress("DEPRECATION")
    private fun archiveInfo(f: File): ApkInfo? {
        val info = ctx.packageManager.getPackageArchiveInfo(f.absolutePath, PackageManager.GET_META_DATA) ?: return null
        val build = info.applicationInfo?.metaData?.get("xiaoju.build")?.toString()?.toIntOrNull() ?: 0
        return ApkInfo(info.versionCode, info.versionName ?: "?", build)
    }

    @Suppress("DEPRECATION")
    private fun myCode(): Int = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionCode }.getOrDefault(0)

    /** 下好的安装包能不能装：返回 null = 能装，否则是原因。 */
    @Suppress("DEPRECATION")
    private fun check(f: File): String? {
        val pm = ctx.packageManager
        val info: PackageInfo = pm.getPackageArchiveInfo(f.absolutePath, PackageManager.GET_SIGNATURES)
            ?: return "安装包坏了（系统读不出来）"
        if (info.packageName != ctx.packageName) return "不是法莉娅的安装包（${info.packageName}）"
        val mine = runCatching { pm.getPackageInfo(ctx.packageName, PackageManager.GET_SIGNATURES) }.getOrNull()
        if (mine != null && info.versionCode < mine.versionCode) return "版本比手机上的还旧（${info.versionName}）"
        val a = info.signatures?.map { it.toCharsString() }?.toSet().orEmpty()
        val b = mine?.signatures?.map { it.toCharsString() }?.toSet().orEmpty()
        // 有的老系统读安装包时不给签名，读不到就交给系统安装时再查
        if (a.isNotEmpty() && b.isNotEmpty() && a != b) return "签名和手机上的不一样（不是用固定密钥签的），要先卸载再手动装"
        return null
    }

    /** 接下来会怎么装（先回执告诉控制端，再真的去装：用 root 装的话装完 App 就被系统杀了，来不及回执）。 */
    fun plan(fromUi: Boolean): String = when {
        hasSu() -> "这台手机有 root，直接装，不用人点；装好后法莉娅自己重启接着待命（大约半分钟），之后发 info 看版本。" +
                   "（root 装不上的话改成弹安装界面）"
        Build.VERSION.SDK_INT >= 26 && !UpdateApi26.canInstall(ctx) ->
            "要先在手机上允许法莉娅「安装未知应用」：" + (if (fromUi || Build.VERSION.SDK_INT < 29) "已经打开了设置页" else "点通知栏里的「更新」去设置") +
            "，允许后再点一次通知装"
        fromUi || Build.VERSION.SDK_INT < 29 -> "手机上弹出了安装界面，要有人点一下「安装」；装好后法莉娅自己重启接着待命"
        else -> "通知栏里有一条「点这里安装」，要有人点一下（Android 10 以上后台不能直接弹安装界面）；装好后自己重启接着待命"
    }

    /** 装。ui 不是 null 时是用户在 App 里点的，可以直接弹界面。 */
    fun install(prepared: Prepared, ui: Activity?) {
        val f = prepared.file ?: return
        val pkg = prepared.pkg
        if (hasSu()) {
            Bus.push("用 root 安装 ${pkg?.label.orEmpty()}…")
            val out = rootInstall(f)
            if (out.contains("Success")) {
                // 装好了，系统马上会杀掉这个进程；脚本会把待命拉起来
                Bus.push("root 装好了，法莉娅马上重启")
                return
            }
            // 装好了系统会杀掉这个进程，一般走不到这里；走到这里就是没装上
            Bus.push("root 没装上（${out.lineSequence().lastOrNull { it.isNotBlank() && !it.startsWith("exit=") } ?: "没有输出"}），改成弹安装界面")
        }
        val text = "新版本 ${pkg?.label.orEmpty()} 下好了，点这里安装"
        if (Build.VERSION.SDK_INT >= 26 && !UpdateApi26.canInstall(ctx)) {
            val settings = UpdateApi26.unknownSourcesSettings(ctx)
            notifyUpdate("法莉娅要更新：先允许「安装未知应用」，再回来点安装", settings)
            if (ui != null || Build.VERSION.SDK_INT < 29) runCatching { (ui ?: ctx).startActivity(settings) }
            return
        }
        val intent = installIntent(f)
        notifyUpdate(text, intent)
        if (ui != null || Build.VERSION.SDK_INT < 29) {
            runCatching { (ui ?: ctx).startActivity(intent) }.onFailure { Bus.push("打不开安装界面：${it.message}") }
        }
    }

    private fun installIntent(f: File): Intent {
        val i = Intent(Intent.ACTION_VIEW).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 24) {
            // Android 7 起不能把 file:// 给别的 App，用自己的 ApkProvider 给 content://
            i.setDataAndType(ApkProvider.uri(ctx), MIME).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } else {
            i.setDataAndType(Uri.fromFile(f), MIME)
        }
        return i
    }

    @Suppress("DEPRECATION")
    private fun notifyUpdate(text: String, intent: Intent) {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) 0x04000000 else 0)
        val pi = PendingIntent.getActivity(ctx, 3, intent, flags)
        val b = if (Build.VERSION.SDK_INT >= 26) UpdateApi26.builder(ctx) else Notification.Builder(ctx)
        b.setContentTitle(ctx.getString(R.string.app_name) + " · 更新")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentIntent(pi)
            .setAutoCancel(true)
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, b.build())
    }

    /**
     * 用 root 装，返回 pm 的输出。最多等 2 分钟。
     *
     * 装的命令写成脚本，交给 root 在后台跑（不挂在本进程下面）：装的时候系统会杀掉法莉娅，
     * 脚本不会跟着死。装好后脚本再用 root 把待命服务拉起来（更新前在待命的话），
     * 这样就算系统没发「自己被更新了」（UpdateReceiver），也能接着待命。
     * 先把安装包复制到 /data/local/tmp：新系统的 pm 读不了 App 自己的目录。
     */
    private fun rootInstall(f: File): String = try {
        val log = File(ctx.filesDir, "falia-install.log")
        log.delete(); log.createNewFile(); log.setWritable(true, false); log.setReadable(true, false)
        val script = File(ctx.filesDir, "falia-install.sh")
        script.writeText(UpdateVersion.rootScript(f.absolutePath, log.absolutePath, ctx.packageName,
            restart = Prefs(ctx).standby))
        script.setReadable(true, false)
        val p = ProcessBuilder("su").redirectErrorStream(true).start()
        p.outputStream.bufferedWriter().use { it.write("sh \"${script.absolutePath}\" </dev/null >/dev/null 2>&1 &\nexit\n") }
        runCatching { p.inputStream.readBytes() }
        p.waitFor()
        // 等脚本写完 exit=…（装好了的话这个进程一般等不到，已经被系统杀了）
        val deadline = System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(2)
        var out = ""
        while (System.currentTimeMillis() < deadline) {
            out = runCatching { log.readText() }.getOrDefault("")
            if (out.contains("exit=")) break
            Thread.sleep(500)
        }
        out.ifBlank { "root 没反应（是不是 root 管理器没允许法莉娅？）" }
    } catch (e: Exception) { e.message ?: e.javaClass.simpleName }

    private fun q(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    companion object {
        const val FOLDER = "/软件包"
        const val MIME = "application/vnd.android.package-archive"
        const val APK_NAME = "falia-update.apk"
        private const val PART_NAME = "falia-update.part"
        const val NOTIF_ID = 43
        const val CHANNEL = "xiaoju-update"
        /** 自动检查多久一次 */
        const val CHECK_EVERY_MS = 6 * 60 * 60_000L

        fun apkFile(ctx: Context) = File(ctx.filesDir, APK_NAME)

        fun versionName(ctx: Context): String =
            runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "0"

        /** 「0.19（构建 57）」；本地编的没有构建号 */
        fun currentLabel(ctx: Context): String =
            versionName(ctx) + if (BuildConfig.BUILD_NUMBER > 0) "（构建 ${BuildConfig.BUILD_NUMBER}）" else "（本地编译）"

        private val SU = listOf("/system/xbin/su", "/system/bin/su", "/sbin/su", "/su/bin/su", "/system/sbin/su", "/vendor/bin/su",
            "/debug_ramdisk/su", "/data/adb/magisk/su")
        fun hasSu() = SU.any { File(it).exists() }
    }
}

/** Android 7 起把下好的安装包交给系统安装界面用（content://），只给这一个文件。 */
class ApkProvider : ContentProvider() {
    override fun onCreate() = true

    private fun file(uri: Uri): File {
        val c = context ?: throw FileNotFoundException()
        if (uri.lastPathSegment != Updater.APK_NAME) throw FileNotFoundException(uri.toString())
        return Updater.apkFile(c).takeIf { it.exists() } ?: throw FileNotFoundException(uri.toString())
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY)

    override fun getType(uri: Uri) = Updater.MIME

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val f = file(uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val c = MatrixCursor(cols)
        c.addRow(cols.map { when (it) { OpenableColumns.DISPLAY_NAME -> f.name; OpenableColumns.SIZE -> f.length(); else -> null } }.toTypedArray())
        return c
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        fun uri(ctx: Context): Uri = Uri.parse("content://${ctx.packageName}.apk/${Updater.APK_NAME}")
    }
}

/** 装好新版本后系统发「自己被更新了」：删掉下好的安装包；更新前在待命，就接着待命。 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Updater.apkFile(ctx).delete()
        val p = Prefs(ctx)
        p.updateFile = ""
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(Updater.NOTIF_ID)
        Bus.push("更新好了：现在是 ${Updater.currentLabel(ctx)}")
        if (p.standby && p.token.isNotBlank()) RemoteService.start(ctx)
    }
}

@TargetApi(26)
private object UpdateApi26 {
    fun canInstall(ctx: Context) = ctx.packageManager.canRequestPackageInstalls()
    fun unknownSourcesSettings(ctx: Context): Intent =
        Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    fun builder(ctx: Context): Notification.Builder {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(Updater.CHANNEL, "更新", NotificationManager.IMPORTANCE_DEFAULT))
        return Notification.Builder(ctx, Updater.CHANNEL)
    }
}
