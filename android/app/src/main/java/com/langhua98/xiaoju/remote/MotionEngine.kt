package com.langhua98.xiaoju.remote

import org.json.JSONObject
import java.io.File

/**
 * 移动侦测引擎（0.29）。CameraHub 只认这个接口，monitor 指令的 engine 字段选用哪个：
 * - kotlin：原来的 MotionDetector（基准，行为一点没变）：守望时每秒看 4 帧，连续 2 帧算动；
 * - native：C++ 超低功耗版（cpp/motion）：待命 2 帧/秒 → 疑似 4 帧/秒连续 3 帧确认 → 录像 → 冷却 10 秒回待命；
 * - ab：两个都看同一帧，按 C++ 的结果录，记下两个的结论哪里不一样（MotionStats.ab）。
 * 只在相机线程上 analyze；moved 在 AI 线程上，实现里自己加锁。
 */
interface MotionEngine {
    val name: String
    val ready: Boolean
    /** 正看到一半（疑似 / 冷却）：间歇守望不能歇 */
    val pending: Boolean
    val score: Float
    val noise: Float
    /** off / standby / suspect / active / cooldown */
    val stage: String
    /** 两次看之间至少隔多久（毫秒） */
    val minGapMs: Long
    /** 守望（不录、没直播）时相机每秒交几帧给我们 */
    val watchFps: Int
    fun configure(m: MonitorConfig)
    fun setRegions(rects: List<FloatArray>, rot: Int)
    /** 看一帧，返回「确认有动静」（该开始录 / 接着录了） */
    fun analyze(nv21: ByteArray, w: Int, h: Int, now: Long, recording: Boolean): Boolean
    fun moved(x1: Float, y1: Float, x2: Float, y2: Float): Boolean
    fun reset()
    fun pause()
    fun close() {}
}

/** 基准：原来的 Kotlin 版，一点不改，只是包一层。 */
class KotlinMotion(val d: MotionDetector = MotionDetector()) : MotionEngine {
    override val name = MonitorConfig.KOTLIN
    private var rec = false
    override val ready get() = d.ready
    override val pending get() = d.pending
    override val score get() = d.score
    override val noise get() = d.noise
    override val stage get() = if (rec) "active" else if (d.pending) "suspect" else "standby"
    override val minGapMs = 200L
    override val watchFps = LiveSettings.WATCH_FPS
    override fun configure(m: MonitorConfig) { d.sensitivity = m.sensitivity }
    override fun setRegions(rects: List<FloatArray>, rot: Int) = d.setRegions(rects, rot)
    override fun analyze(nv21: ByteArray, w: Int, h: Int, now: Long, recording: Boolean): Boolean {
        rec = recording
        return d.analyze(nv21, w, h)
    }
    override fun moved(x1: Float, y1: Float, x2: Float, y2: Float) = d.moved(x1, y1, x2, y2)
    override fun reset() = d.reset()
    override fun pause() = d.pause()
}

/** C++ 库（libxjmotion.so）。安装包里没有时 available = false，侦测退回 Kotlin 版。 */
object MotionNative {
    val available: Boolean = try { System.loadLibrary("xjmotion"); true } catch (e: Throwable) { false }

    @JvmStatic external fun nativeCreate(cols: Int, rows: Int): Long
    @JvmStatic external fun nativeFree(h: Long)
    @JvmStatic external fun nativeConfig(h: Long, sensitivity: Int, standbyMs: Int, suspectMs: Int, activeMs: Int, confirm: Int, cooldownMs: Int)
    @JvmStatic external fun nativeSetMask(h: Long, mask: ByteArray?)
    @JvmStatic external fun nativeReset(h: Long)
    @JvmStatic external fun nativePause(h: Long)
    @JvmStatic external fun nativeAnalyze(h: Long, nv21: ByteArray, w: Int, height: Int, now: Long, recording: Boolean): Int
    @JvmStatic external fun nativeMoved(h: Long, x1: Float, y1: Float, x2: Float, y2: Float): Boolean
    @JvmStatic external fun nativeStats(h: Long, out: LongArray)

    const val F_CONFIRMED = 2
    const val F_READY = 4
    val STAGES = arrayOf("standby", "suspect", "active", "cooldown")
}

/** C++ 超低功耗版。画面不复制（JNI 直接读相机缓冲区），统计写进预先分配好的数组。 */
class NativeMotion(private val cols: Int = 32, private val rows: Int = 24) : MotionEngine {
    override val name = MonitorConfig.NATIVE
    private var h = MotionNative.nativeCreate(cols, rows)
    private val st = LongArray(11)
    @Volatile private var last = 0                 // 最近一次 analyze 的返回值
    @Volatile private var standbyMs = 500
    @Volatile private var statsAt = 0L

    private val stageNo get() = (last shr 8) and 0xf
    private val nextMs get() = ((last shr 16) and 0x7fff).let { if (it > 0) it else standbyMs }

    override val ready get() = (last and MotionNative.F_READY) != 0
    override val pending get() = stageNo == 1 || stageNo == 3
    override val stage get() = MotionNative.STAGES.getOrElse(stageNo) { "standby" }
    // 留 1/5 的余量：相机按 watchFps 交帧，早到几十毫秒的那帧也要看（不然 2 帧/秒会变成 1 帧/秒）
    override val minGapMs get() = nextMs * 4L / 5
    override val watchFps get() = when (stageNo) { 0 -> (1000 + standbyMs - 1) / standbyMs; else -> 4 }
    override val score get() = stats()[6] / 1e6f
    override val noise get() = stats()[7] / 1000f

    @Synchronized fun stats(): LongArray {
        val now = System.currentTimeMillis()
        if (h != 0L && now - statsAt > 200) { MotionNative.nativeStats(h, st); statsAt = now }
        return st
    }

    @Synchronized override fun configure(m: MonitorConfig) {
        if (h == 0L) return
        standbyMs = 1000 / m.standbyFps.coerceIn(1, 4)
        MotionNative.nativeConfig(h, m.sensitivity, standbyMs, 250, 200, m.confirm, 10_000)
    }

    @Synchronized override fun setRegions(rects: List<FloatArray>, rot: Int) {
        if (h == 0L) return
        val m = MotionDetector.regionMask(cols, rows, rects, rot)
        MotionNative.nativeSetMask(h, m?.let { b -> ByteArray(b.size) { if (b[it]) 1 else 0 } })
    }

    @Synchronized override fun analyze(nv21: ByteArray, w: Int, h: Int, now: Long, recording: Boolean): Boolean {
        if (this.h == 0L) return false
        val r = MotionNative.nativeAnalyze(this.h, nv21, w, h, now, recording)
        last = r
        return (r and MotionNative.F_CONFIRMED) != 0
    }

    @Synchronized override fun moved(x1: Float, y1: Float, x2: Float, y2: Float) =
        h != 0L && MotionNative.nativeMoved(h, x1, y1, x2, y2)

    @Synchronized override fun reset() { if (h != 0L) MotionNative.nativeReset(h); last = 0 }
    @Synchronized override fun pause() { if (h != 0L) MotionNative.nativePause(h) }
    @Synchronized override fun close() { if (h != 0L) { MotionNative.nativeFree(h); h = 0L } }
}

/**
 * 对比：两个引擎看同一帧（按 C++ 的节奏，Kotlin 版也只看到这些帧），按 C++ 的结论录像。
 * 每次「有动静」（隔 5 秒以上算新的一次）记下来，3 秒里另一个也报了就算两个都发现，不然记成只有一个发现。
 */
class DualMotion(val k: KotlinMotion, val n: NativeMotion, private val stats: () -> MotionStats) : MotionEngine {
    override val name = MonitorConfig.AB
    override val ready get() = n.ready
    override val pending get() = n.pending
    override val score get() = n.score
    override val noise get() = n.noise
    override val stage get() = n.stage
    override val minGapMs get() = n.minGapMs
    override val watchFps get() = n.watchFps
    override fun configure(m: MonitorConfig) { k.configure(m); n.configure(m) }
    override fun setRegions(rects: List<FloatArray>, rot: Int) { k.setRegions(rects, rot); n.setRegions(rects, rot) }
    override fun analyze(nv21: ByteArray, w: Int, h: Int, now: Long, recording: Boolean): Boolean {
        val s = stats()
        val t0 = System.nanoTime()
        val kk = k.analyze(nv21, w, h, now, recording)
        s.timed(MonitorConfig.KOTLIN, System.nanoTime() - t0)
        val t1 = System.nanoTime()
        val nn = n.analyze(nv21, w, h, now, recording)
        s.timed(MonitorConfig.NATIVE, System.nanoTime() - t1)
        s.ab.see(now, kk, nn)
        return nn
    }
    override fun moved(x1: Float, y1: Float, x2: Float, y2: Float) = n.moved(x1, y1, x2, y2)
    override fun reset() { k.reset(); n.reset() }
    override fun pause() { k.pause(); n.pause() }
    override fun close() = n.close()
}

/** 两个引擎的结论对比（ab 模式）。不碰安卓的类，可以在电脑上测。 */
class AbCompare {
    var both = 0; private set
    var kotlinOnly = 0; private set
    var nativeOnly = 0; private set
    private var kLast = -1L; private var nLast = -1L      // 上一次「报」的时间
    private var kOpen = -1L; private var nOpen = -1L      // 还没配上对的那一次从什么时候开始

    @Synchronized fun see(now: Long, k: Boolean, n: Boolean) {
        // 先把等了 3 秒还没配上对的结掉，再记这一帧的
        if (kOpen >= 0 && now - kOpen > MATCH_MS) { kotlinOnly++; kOpen = -1 }
        if (nOpen >= 0 && now - nOpen > MATCH_MS) { nativeOnly++; nOpen = -1 }
        if (k) { if (kLast < 0 || now - kLast > EPISODE_GAP) start(now, true); kLast = now }
        if (n) { if (nLast < 0 || now - nLast > EPISODE_GAP) start(now, false); nLast = now }
    }

    private fun start(now: Long, kotlin: Boolean) {
        if (kotlin) { if (nOpen >= 0) { both++; nOpen = -1 } else kOpen = now }
        else { if (kOpen >= 0) { both++; kOpen = -1 } else nOpen = now }
    }

    fun json(): JSONObject = JSONObject().put("both", both).put("kotlin_only", kotlinOnly).put("native_only", nativeOnly)

    companion object {
        const val EPISODE_GAP = 5_000L
        const val MATCH_MS = 3_000L
    }
}

/**
 * 侦测耗电的实测（从打开侦测 / 换引擎开始算）：每个阶段占多少时间、相机实际每秒交几帧（传感器有没有真的降下来）、
 * 每看一帧 CPU 用多少微秒、整个 App 用了多少 CPU、掉电速度、报了几次、过滤掉几次。monitor_status 和「设备信息」里看。
 */
class MotionStats(val engine: String, private val battery: () -> Pair<Int, Boolean>?) {
    val since = System.currentTimeMillis()
    private val cpu0 = cpuMs()
    private val bat0 = battery()
    private val stageMs = HashMap<String, Long>()
    private val stageLooks = HashMap<String, Long>()
    private val stageCallbacks = HashMap<String, Long>()
    private val ns = HashMap<String, Long>()
    private val n = HashMap<String, Long>()
    private var lastAt = 0L
    private var lastStage = ""
    private var lastCallbacks = 0L
    var events = 0; private set
    val ab = AbCompare()

    /** 每看一帧（相机线程）：上一帧到这一帧的时间、相机回调次数记到上一帧的阶段上。 */
    @Synchronized fun look(now: Long, stage: String, callbacks: Long) {
        if (lastAt > 0 && now > lastAt && now - lastAt < 10_000) {
            stageMs[lastStage] = (stageMs[lastStage] ?: 0) + (now - lastAt)
            stageCallbacks[lastStage] = (stageCallbacks[lastStage] ?: 0) + (callbacks - lastCallbacks)
        }
        stageLooks[stage] = (stageLooks[stage] ?: 0) + 1
        lastAt = now; lastStage = stage; lastCallbacks = callbacks
    }

    @Synchronized fun timed(engine: String, nanos: Long) {
        ns[engine] = (ns[engine] ?: 0) + nanos
        n[engine] = (n[engine] ?: 0) + 1
    }

    @Synchronized fun event() { events++ }

    /** 每看一帧平均多少微秒 */
    @Synchronized fun us(engine: String): Double = (ns[engine] ?: 0) / 1000.0 / maxOf(1L, n[engine] ?: 0)

    @Synchronized fun json(e: MotionEngine): JSONObject {
        val now = System.currentTimeMillis()
        val up = maxOf(1L, now - since)
        val total = maxOf(1L, stageMs.values.sum())
        val o = JSONObject().put("engine", engine).put("stage", e.stage).put("since_min", up / 60_000)
            .put("events", events).put("watch_fps", e.watchFps)
        for (s in listOf("standby", "suspect", "active", "cooldown")) {
            val ms = stageMs[s] ?: 0
            o.put("${s}_pct", ms * 100 / total)
            // 这个阶段相机实际每秒交几帧（回调次数 / 时间）：比我们要的多很多 = 传感器没真的降下来
            if (ms > 5_000) o.put("${s}_sensor_fps", Math.round((stageCallbacks[s] ?: 0) * 10_000.0 / ms) / 10.0)
                .put("${s}_looks_per_s", Math.round((stageLooks[s] ?: 0) * 10_000.0 / ms) / 10.0)
        }
        for (k in n.keys) o.put("${k}_us", Math.round(us(k) * 10) / 10.0)
        if (e is NativeMotion || e is DualMotion) {
            val nm = (e as? NativeMotion) ?: (e as DualMotion).n
            val st = nm.stats()
            o.put("suspects", st[2]).put("filtered", st[3]).put("confirms", st[4]).put("rebases", st[5])
                .put("pixels_per_look", if (st[0] > 0) st[1] / st[0] else 0)
        }
        if (e is DualMotion) o.put("ab", ab.json())
        val c1 = cpuMs()
        if (cpu0 >= 0 && c1 >= 0) o.put("app_cpu_pct", Math.round((c1 - cpu0) * 1000.0 / up) / 10.0)
        val b1 = battery()
        if (bat0 != null && b1 != null) {
            o.put("battery_start", bat0.first).put("battery_now", b1.first)
            if (!bat0.second && !b1.second && up > 30 * 60_000L)
                o.put("battery_pct_per_h", Math.round((bat0.first - b1.first) * 36_000_000.0 / up) / 10.0)
        }
        return o
    }

    /** 「设备信息」里的一两句话 */
    fun text(e: MotionEngine): String {
        val j = json(e)
        val name = when (engine) { MonitorConfig.NATIVE -> "C++ 超低功耗版"; MonitorConfig.AB -> "C++ 和 Kotlin 对比"; else -> "Kotlin 基准版" }
        val sb = StringBuilder("侦测引擎：$name，开了 ${j.optLong("since_min")} 分钟，报了 ${j.optInt("events")} 次")
        if (j.has("filtered")) sb.append("（疑似 ${j.optLong("suspects")} 次，过滤掉 ${j.optLong("filtered")} 次）")
        sb.append("\n侦测时间：待命 ${j.optLong("standby_pct")}%、疑似 ${j.optLong("suspect_pct")}%、录像 ${j.optLong("active_pct")}%、冷却 ${j.optLong("cooldown_pct")}%")
        if (j.has("standby_sensor_fps")) sb.append("；待命时相机实际每秒出 ${j.optDouble("standby_sensor_fps")} 帧、我们看 ${j.optDouble("standby_looks_per_s")} 帧")
        val us = listOf(MonitorConfig.KOTLIN, MonitorConfig.NATIVE).filter { j.has("${it}_us") }
            .joinToString("，") { (if (it == MonitorConfig.NATIVE) "C++" else "Kotlin") + " 每帧 ${j.optDouble("${it}_us")} 微秒" }
        if (us.isNotEmpty()) sb.append("\n计算：$us")
        if (j.has("app_cpu_pct")) sb.append("；整个 App 用了 ${j.optDouble("app_cpu_pct")}% 的 CPU（一个核算 100%）")
        if (j.has("battery_pct_per_h")) sb.append("\n掉电：每小时 ${j.optDouble("battery_pct_per_h")}%（${j.optInt("battery_start")}% → ${j.optInt("battery_now")}%）")
        j.optJSONObject("ab")?.let { sb.append("\n对比：两个都发现 ${it.optInt("both")} 次，只有 C++ ${it.optInt("native_only")} 次，只有 Kotlin ${it.optInt("kotlin_only")} 次") }
        return sb.toString()
    }

    companion object {
        /** 这个 App 启动以来用了多少 CPU 时间（毫秒，用户态 + 内核态）。读不到返回 -1。 */
        fun cpuMs(): Long = try {
            val s = File("/proc/self/stat").readText()
            val f = s.substring(s.lastIndexOf(')') + 2).split(' ')
            (f[11].toLong() + f[12].toLong()) * 10   // utime、stime，单位 1/100 秒
        } catch (e: Exception) { -1L }
    }
}
