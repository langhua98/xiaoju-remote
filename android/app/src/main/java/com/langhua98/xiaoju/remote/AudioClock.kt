package com.langhua98.xiaoju.remote

/**
 * 直播声音的时间戳：按「录了多少个样本」算，不按每次读到数据的钟点算。
 *
 * 以前每一包的时间 = 读到的时刻 − 这包的长度。录音线程被别的事耽误一下（老手机上很常见），
 * 读到的时刻就晚了，几包挤在一起读出来，时间戳一会儿挤、一会儿空。看的一端按时间戳排声音，
 * 就会一会儿重叠、一会儿留空当，听起来一卡一卡的。
 *
 * 现在：第一包按钟点定起点，后面每包 = 起点 + 已录样本数 / 采样率，一包接一包严丝合缝。
 * 只有麦克风真丢了数据（钟点比样本时间晚了 resyncMs 以上，而且持续 holdMs 以上，
 * 不是一下子读出积压的那种）或者两边的钟走得不一样快，才重新对一次钟。
 * 不碰安卓的类，电脑上能直接测（见 src/test）。
 */
class AudioClock(private val rate: Int, private val resyncMs: Long = 250, private val holdMs: Long = 1_000) {
    private var base = -1L
    private var samples = 0L
    private var lagSince = -1L
    /** 重新对过几次钟（日志、测试用） */
    var resyncs = 0
        private set

    /**
     * 一包 n 个样本刚读到，现在是 now（毫秒，单调时钟）。返回这包第一个样本的时间。
     */
    fun stamp(n: Int, now: Long): Long {
        val wall = now - n * 1000L / rate          // 按钟点估的这包开头（积压时偏晚）
        if (base < 0) { base = wall; samples = 0 }
        var ts = base + samples * 1000L / rate
        val lag = wall - ts
        when {
            // 样本时间跑到钟点前面去了（麦克风的钟比手机快）：马上对齐，免得声音越来越早
            lag < -resyncMs -> { resync(wall); ts = wall }
            lag > resyncMs -> {
                // 晚了：可能只是一下子读出积压（很快就追上），也可能真丢了数据（一直追不上）
                if (lagSince < 0) lagSince = now
                else if (now - lagSince >= holdMs) { resync(wall); ts = wall }
            }
            else -> lagSince = -1
        }
        samples += n
        return ts
    }

    private fun resync(wall: Long) {
        base = wall; samples = 0; lagSince = -1; resyncs++
    }
}
