package com.langhua98.xiaoju.remote

import org.json.JSONArray
import org.json.JSONObject

/**
 * 移动侦测的设置（iPhone 发 monitor 指令改，存在手机上，重启后自动接着侦测）。
 * 只有指令里出现的字段才改。不碰安卓的类，可以在电脑上跑测试。
 */
class MonitorConfig(
    val on: Boolean = false,
    val sensitivity: Int = 50,          // 1…100
    val regions: List<FloatArray> = emptyList(),   // 只看这些区域 [x, y, w, h]（转正后的画面，0…1）；空 = 全部
    val preSec: Int = 5,                // 动静前录几秒
    val postSec: Int = 15,              // 最后一次动静后再录几秒
    val notify: Boolean = true,         // 发 Telegram 提醒
    val personOnly: Boolean = false,    // 只在认出人时提醒（别的动静照样录，只是不提醒）
    val cooldownMin: Int = 5,           // 两次提醒至少隔几分钟
    val audio: Boolean = true,          // 录声音
    val upload: Boolean = true,         // 慢慢备份到云盘
    val lens: String = "back",
    val width: Int = 640,
    val fps: Int = 10,
    val quality: Int = 50,
    /**
     * 省电侦测（默认开）：没动静时「守望」，相机降到最低帧率档、每秒只看 4 帧，编码器和麦克风都关着；
     * 有动静才开始录（动静前只有守望时留的几帧，最多 3 秒）。关掉 = 编码器一直开着，能录到动静前 preSec 秒，费电得多。
     */
    val eco: Boolean = true,
    /**
     * 间歇守望（省电侦测里再省一档，默认开，0.18）：守望时相机开 dutyOn 秒看一看，没动静就关掉相机、放掉 CPU 锁，
     * 歇 dutyOff 秒再由闹钟叫醒开相机。歇着的时候发生又结束的动静会漏掉；有动静、有人看直播、要拍照时马上不歇。
     */
    val duty: Boolean = true,
    val dutyOn: Int = 2,
    val dutyOff: Int = 4,
    /**
     * 侦测引擎（0.29）：kotlin = 原来的 Kotlin 版（基准，默认）；native = C++ 超低功耗版（待命 standbyFps 帧/秒，
     * 疑似时 4 帧/秒连续 confirm 帧确认）；ab = 两个同时看同一帧，按 C++ 的结果录像，记下两个哪里不一样（对比用）。
     * 安装包里没有 C++ 库时一律用 Kotlin 版。
     */
    val engine: String = KOTLIN,
    val standbyFps: Int = 2,
    val confirm: Int = 3,
) {
    fun toJson(): JSONObject = JSONObject().put("on", on).put("sensitivity", sensitivity)
        .put("regions", JSONArray().apply { regions.forEach { r -> put(JSONArray().apply { r.forEach { put(it.toDouble()) } }) } })
        .put("pre", preSec).put("post", postSec).put("notify", notify).put("people", personOnly).put("cooldown", cooldownMin)
        .put("audio", audio).put("upload", upload).put("lens", lens).put("width", width).put("fps", fps).put("quality", quality).put("eco", eco)
        .put("duty", duty).put("duty_on", dutyOn).put("duty_off", dutyOff)
        .put("engine", engine).put("standby_fps", standbyFps).put("confirm", confirm)

    /** 省电侦测时动静前留几秒画面（守望时每秒 4 帧，最多 3 秒，内存另外有上限） */
    val ecoPreMs: Long get() = minOf(preSec, 3) * 1000L

    /** 相机设置（交给 LiveSettings.apply）：侦测用 H.264 录像。 */
    fun cameraJson(): JSONObject = JSONObject().put("lens", lens).put("width", width).put("fps", fps)
        .put("quality", quality).put("codec", LiveSettings.H264)

    /** 按指令里出现的字段改，返回新的设置。 */
    fun merge(c: JSONObject) = MonitorConfig(
        on = if (c.has("on")) c.optBoolean("on") else on,
        sensitivity = if (c.has("sensitivity")) c.optInt("sensitivity", sensitivity).coerceIn(1, 100) else sensitivity,
        regions = if (c.has("regions")) parseRegions(c.optJSONArray("regions")) else regions,
        preSec = if (c.has("pre")) c.optInt("pre", preSec).coerceIn(0, 10) else preSec,
        postSec = if (c.has("post")) c.optInt("post", postSec).coerceIn(3, 120) else postSec,
        notify = if (c.has("notify")) c.optBoolean("notify") else notify,
        personOnly = if (c.has("people")) c.optBoolean("people") else personOnly,
        cooldownMin = if (c.has("cooldown")) c.optInt("cooldown", cooldownMin).coerceIn(0, 120) else cooldownMin,
        audio = if (c.has("audio")) c.optBoolean("audio") else audio,
        upload = if (c.has("upload")) c.optBoolean("upload") else upload,
        lens = if (c.has("lens")) (if (c.optString("lens") == "front") "front" else "back") else lens,
        width = if (c.has("width")) c.optInt("width", width).coerceIn(240, 1280) else width,
        fps = if (c.has("fps")) c.optInt("fps", fps).coerceIn(1, 15) else fps,
        quality = if (c.has("quality")) c.optInt("quality", quality).coerceIn(20, 90) else quality,
        eco = if (c.has("eco")) c.optBoolean("eco") else eco,
        duty = if (c.has("duty")) c.optBoolean("duty") else duty,
        dutyOn = if (c.has("duty_on")) c.optInt("duty_on", dutyOn).coerceIn(1, 10) else dutyOn,
        dutyOff = if (c.has("duty_off")) c.optInt("duty_off", dutyOff).coerceIn(1, 60) else dutyOff,
        engine = if (c.has("engine")) c.optString("engine").takeIf { it in ENGINES } ?: engine else engine,
        standbyFps = if (c.has("standby_fps")) c.optInt("standby_fps", standbyFps).coerceIn(1, 4) else standbyFps,
        confirm = if (c.has("confirm")) c.optInt("confirm", confirm).coerceIn(2, 6) else confirm,
    )

    /** 现在要不要间歇守望（只在省电侦测里才有） */
    val dutyActive: Boolean get() = on && eco && duty

    companion object {
        const val KOTLIN = "kotlin"
        const val NATIVE = "native"
        const val AB = "ab"
        val ENGINES = setOf(KOTLIN, NATIVE, AB)

        fun fromJson(s: String?): MonitorConfig = try {
            if (s.isNullOrBlank()) MonitorConfig() else MonitorConfig().merge(JSONObject(s))
        } catch (e: Exception) { MonitorConfig() }

        /** [[x, y, w, h], …]，裁到画面里，太小的（不到 2%）不要。 */
        fun parseRegions(a: JSONArray?): List<FloatArray> {
            if (a == null) return emptyList()
            val out = ArrayList<FloatArray>()
            for (i in 0 until minOf(a.length(), 8)) {
                val r = a.optJSONArray(i) ?: continue
                if (r.length() < 4) continue
                val x = r.optDouble(0).toFloat().coerceIn(0f, 1f)
                val y = r.optDouble(1).toFloat().coerceIn(0f, 1f)
                val w = r.optDouble(2).toFloat().coerceIn(0f, 1f - x)
                val h = r.optDouble(3).toFloat().coerceIn(0f, 1f - y)
                if (w.isNaN() || h.isNaN() || w < 0.02f || h < 0.02f) continue
                out += floatArrayOf(x, y, w, h)
            }
            return out
        }
    }
}
