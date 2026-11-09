package com.langhua98.xiaoju.remote

import android.content.Context

/** 设置存在 App 私有的 SharedPreferences 里，别的 App 读不到。 */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("xiaoju-remote", Context.MODE_PRIVATE)

    var base: String
        get() = sp.getString("base", "")!!.ifBlank { DEFAULT_BASE }
        set(v) { sp.edit().putString("base", v.trim().trimEnd('/')).apply() }

    var token: String
        get() = sp.getString("token", "")!!
        set(v) { sp.edit().putString("token", v.trim()).apply() }

    var device: String
        get() = sp.getString("device", "")!!.ifBlank { android.os.Build.MODEL }
        set(v) { sp.edit().putString("device", v.trim()).apply() }

    var pair: String
        get() = sp.getString("pair", "")!!
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

    /** 自动更新：待命时每 6 小时看一次云盘「软件包」，有新版本就下载、安装 */
    var autoUpdate: Boolean
        get() = sp.getBoolean("autoUpdate", true)
        set(v) { sp.edit().putBoolean("autoUpdate", v).apply() }

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
    fun isSeen(id: String) = seen().contains(id)
    fun markSeen(id: String) {
        val list = seen().toMutableList().apply { add(id) }
        sp.edit().putString("seen", list.takeLast(500).joinToString("\n")).apply()
    }
    private fun seen(): List<String> = sp.getString("seen", "")!!.split("\n").filter { it.isNotBlank() }

    companion object {
        const val DEFAULT_BASE = "https://langhua1998-xiaoju-cloud.hf.space"
    }
}
