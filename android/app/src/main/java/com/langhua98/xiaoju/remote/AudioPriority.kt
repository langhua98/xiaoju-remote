package com.langhua98.xiaoju.remote

/**
 * 直播时让声音先走（0.38）：声音和画面走同一条连接，网络跟不上时画面先堆在发送队列里，
 * 声音只能排在后面，晚到了就断。这里每发一包声音看一眼队列：
 * - 连着 latePackets 包都压着超过 pressureBytes 字节（声音要等大约半秒以上），就该把画面的码率降下来（onPacket 返回 true）；
 * - 画面码率已经降到 narrowBelow 以下（网络很差），声音也改成 8 kHz（码率减半，看的一端本来就认这个格式），
 *   码率回到 wideAbove 以上再换回 16 kHz。两个门槛隔开，免得来回切。
 * 不碰安卓的类，电脑上能直接测（见 src/test）。
 */
class AudioPriority(
    private val pressureBytes: Long = 24 * 1024,
    private val latePackets: Int = 4,
    private val narrowBelow: Double = 0.5,
    private val wideAbove: Double = 0.8,
) {
    private var lateRun = 0
    /** 现在声音用 8 kHz 吗 */
    @Volatile var narrow = false
        private set

    /** 发了一包声音，发送队列里最多压着 queued 字节。返回 true = 声音一直在等，该降画面码率了。 */
    fun onPacket(queued: Long): Boolean {
        if (queued <= pressureBytes) { lateRun = 0; return false }
        if (++lateRun < latePackets) return false
        lateRun = 0
        return true
    }

    /** 画面码率比例变了（1.0 = 没降）。返回 true = 声音格式换了（该记一笔日志）。 */
    fun onRate(scale: Double): Boolean {
        val want = if (narrow) scale < wideAbove else scale <= narrowBelow
        if (want == narrow) return false
        narrow = want
        return true
    }

    fun reset() { lateRun = 0; narrow = false }
}
