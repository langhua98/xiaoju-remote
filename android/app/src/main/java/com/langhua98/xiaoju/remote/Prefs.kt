package com.langhua98.xiaoju.remote

import android.content.Context

/** 设置存在 App 私有的 SharedPreferences 里，别的 App 读不到。 */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("xiaoju-remote", Context.MODE_PRIVATE)

    /** 云盘地址固定（0.20 起界面上不用填） */
    val base: String get() = DEFAULT_BASE

    /** 云盘令牌：编译时打进 App（BuildConfig.CLOUD_TOKEN，workflow 用 secret XIAOJU_TOKEN）。
     *  本地编、没带令牌的包才用界面上填的。 */
    var token: String
        get() = BuildConfig.CLOUD_TOKEN.ifBlank { sp.getString("token", "")!! }
        set(v) { sp.edit().putString("token", v.trim()).apply() }

    /** 设备名只能是 A、B、C、D，默认 A（以前存的别的名字也当 A） */
    var device: String
        get() = sp.getString("device", "")!!.takeIf { it in DEVICES } ?: DEVICES[0]
        set(v) { sp.edit().putString("device", v.takeIf { it in DEVICES } ?: DEVICES[0]).apply() }

    /** 配对口令，默认 0 */
    var pair: String
        get() = sp.getString("pair", DEFAULT_PAIR)!!
        set(v) { sp.edit().putString("pair", v.trim()).apply() }

    /** 移动侦测的设置（JSON，见 MonitorConfig） */
    var monitor: MonitorConfig
        get() = MonitorConfig.fromJson(sp.getString("monitor", ""))
        set(v) { sp.edit().putString("monitor", v.toJson().toString()).apply() }

    /** 画面上下翻转（手机倒着装） */
    var flip: Boolean
        get() = sp.getBoolean("flip", false)
        set(v) { sp.edit().putBoolean("flip", v).apply() }

    /** 画面上印日期时间 */
    var stamp: Boolean
        get() = sp.getBoolean("stamp", true)
        set(v) { sp.edit().putBoolean("stamp", v).apply() }

    /** Telegram 提醒发给哪个聊天（服务端第一次找到后告诉我们） */
    var tgChat: Long
        get() = sp.getLong("tgChat", 0L)
        set(v) { sp.edit().putLong("tgChat", v).apply() }

    /** 用户开着待命（更新完 App 被重启后，要接着待命）。用户点「停止」才变 false。 */
    var standby: Boolean
        get() = sp.getBoolean("standby", false)
        set(v) { sp.edit().putBoolean("standby", v).apply() }

    /** 上次自动查更新的时间（毫秒） */
    var updateCheckedAt: Long
        get() = sp.getLong("updateCheckedAt", 0L)
        set(v) { sp.edit().putLong("updateCheckedAt", v).apply() }

    /** 已经下好的安装包是云盘上哪个文件（同一个不再下） */
    var updateFile: String
        get() = sp.getString("updateFile", "")!!
        set(v) { sp.edit().putString("updateFile", v).apply() }

    /** 自动更新已经为哪个安装包装过 / 弹过安装界面（同一个只弹一次，不烦人） */
    var updatePrompted: String
        get() = sp.getString("updatePrompted", "")!!
        set(v) { sp.edit().putString("updatePrompted", v).apply() }

    /** 处理过的文件信箱指令 id（避免重复执行），最多记 500 条 */
    /** 云盘「软件包」里名字不规范、下载看过不比手机上新的安装包（按云盘文件 id 记），不再下载。 */
    fun updateSkipped(id: String) = sp.getString("updateSkipped", "")!!.split("\n").contains(id)
    fun markUpdateSkipped(id: String) {
        val list = sp.getString("updateSkipped", "")!!.split("\n").filter { it.isNotBlank() } + id
        sp.edit().putString("updateSkipped", list.takeLast(50).joinToString("\n")).apply()
    }

    fun isSeen(id: String) = seen().contains(id)
    fun markSeen(id: String) {
        val list = seen().toMutableList().apply { add(id) }
        sp.edit().putString("seen", list.takeLast(500).joinToString("\n")).apply()
    }
    private fun seen(): List<String> = sp.getString("seen", "")!!.split("\n").filter { it.isNotBlank() }

    companion object {
        const val DEFAULT_BASE = "https://langhua1998-xiaoju-cloud.hf.space"
        val DEVICES = listOf("A", "B", "C", "D")
        const val DEFAULT_PAIR = "0"
    }
}
