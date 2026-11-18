package com.langhua98.xiaoju.remote

/**
 * 声音监听（0.41）：判断「现在有没有声音」。麦克风来的每一包（μ-law，80 ms）算一次音量，和底噪比。
 *
 * - 音量：这一包的均方根（先去掉直流），写成分贝（相对最小一格；安静的房间大约 25～40，隔两三米说话 55 以上）。
 * - 底噪自己跟：比底噪小就很快跟下去，比底噪大只慢慢往上涨（大约 30 秒涨到位）。
 *   所以冰箱、风扇这种一直响的声音，响一会儿就变成底噪，不会一直算「有声音」；说话中间的停顿又会把底噪拉回来。
 * - 有声音：音量比底噪高出「门槛」（灵敏度 1…100 → 30…6 分贝），而且最近 4 包里至少 2 包这样（大约 0.2 秒），
 *   电流噪声的一个尖不算；特别响的（再高 12 分贝，比如摔门）一包就算。
 * - 刚开麦克风的 1.5 秒只学底噪，不报（开麦克风时常有「噗」的一声）。
 *
 * 不碰安卓的类，可以在电脑上跑测试。
 */
class SoundDetector {
    /** 灵敏度 1…100，越大越灵敏 */
    @Volatile var sensitivity = 50

    /** 最近一包的音量（分贝） */
    @Volatile var level = 0f
        private set
    /** 现在的底噪（分贝） */
    @Volatile var floor = 0f
        private set

    private var heardMs = 0L     // 开麦克风以后听了多久
    private var recent = 0       // 最近 4 包响不响（一位一包）

    /** 要比底噪高出多少分贝才算有声音 */
    val marginDb: Float get() = MIN_MARGIN + (100 - sensitivity.coerceIn(1, 100)) * MARGIN_STEP

    /** 麦克风重新开了：底噪重新学。 */
    @Synchronized fun reset() {
        heardMs = 0; recent = 0; level = 0f; floor = 0f
    }

    /** 一包声音（μ-law，采样率 rate）。返回 true = 这一包算「有声音」。 */
    @Synchronized fun feed(ulaw: ByteArray, rate: Int): Boolean {
        if (ulaw.isEmpty() || rate <= 0) return false
        val db = levelDb(ulaw)
        level = db
        val ms = ulaw.size * 1000L / rate
        val first = heardMs == 0L
        heardMs += ms
        if (heardMs <= SETTLE_MS) {
            // 还在学：两边都跟得快
            floor = maxOf(MIN_FLOOR, if (first) db else floor + (db - floor) * 0.3f)
            return false
        }
        floor = if (db < floor) floor + (db - floor) * DOWN
        else floor + (db - floor) * minOf(1f, ms.toFloat() / UP_MS)
        if (floor < MIN_FLOOR) floor = MIN_FLOOR
        val over = db - floor
        val margin = marginDb
        val loud = over >= margin
        recent = ((recent shl 1) or (if (loud) 1 else 0)) and 0xF
        return (loud && Integer.bitCount(recent) >= 2) || over >= margin + BURST_DB
    }

    companion object {
        /** 刚开麦克风这么久只学底噪 */
        const val SETTLE_MS = 1_500L
        /** 底噪往上涨的快慢（毫秒，大约这么久涨到位的六成） */
        const val UP_MS = 30_000f
        /** 底噪往下跟的快慢（每包走这么多） */
        const val DOWN = 0.1f
        /** 底噪最低算这么多（麦克风给的全是 0 时别把门槛压到底） */
        const val MIN_FLOOR = 20f
        /** 灵敏度 100 时的门槛（分贝） */
        const val MIN_MARGIN = 6f
        /** 灵敏度每小 1，门槛高这么多分贝（灵敏度 50 → 18 分贝，1 → 约 30 分贝） */
        const val MARGIN_STEP = 0.24f
        /** 比门槛再高这么多：一包就算 */
        const val BURST_DB = 12f

        private val TABLE = ShortArray(256) { Ulaw.decode(it.toByte()).toShort() }

        /** 一包 μ-law 的音量（分贝）：去掉直流后的均方根，20·log10(均方根 + 1)。全是静音 = 0。 */
        fun levelDb(ulaw: ByteArray): Float {
            if (ulaw.isEmpty()) return 0f
            var sum = 0.0
            var sq = 0.0
            for (b in ulaw) {
                val v = TABLE[b.toInt() and 0xFF].toDouble()
                sum += v; sq += v * v
            }
            val mean = sum / ulaw.size
            val rms = Math.sqrt(maxOf(0.0, sq / ulaw.size - mean * mean))
            return (20.0 * Math.log10(rms + 1.0)).toFloat()
        }
    }
}
