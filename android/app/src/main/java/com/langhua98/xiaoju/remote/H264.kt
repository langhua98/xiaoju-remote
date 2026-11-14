package com.langhua98.xiaoju.remote

/**
 * H.264 直播用的小工具（不碰安卓的类，可以在电脑上跑测试）。
 * 码流是 Annex-B：每个 NAL 前面是 00 00 01 或 00 00 00 01。NAL 类型 5 = 关键帧（IDR），7 = SPS，8 = PPS。
 */
object H264 {
    const val NAL_IDR = 5
    const val NAL_SPS = 7
    const val NAL_PPS = 8

    /** 码流里每个 NAL 的类型，按出现顺序。 */
    fun nalTypes(b: ByteArray, off: Int = 0, len: Int = b.size - off): List<Int> {
        val out = ArrayList<Int>()
        val end = off + len
        var i = off
        while (i + 3 < end) {
            if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
                out += b[i + 3].toInt() and 0x1f
                i += 3
            } else i++
        }
        return out
    }

    fun hasKeyframe(b: ByteArray) = NAL_IDR in nalTypes(b)

    /** 开头已经带了 SPS（编码器自己在关键帧前面放了参数），就不用再补。 */
    fun startsWithSps(b: ByteArray) = nalTypes(b).firstOrNull() == NAL_SPS

    /**
     * 相机给的 NV21（Y 平面 + VU 交错）→ 编码器要的 NV12（Y 平面 + UV 交错）：Y 原样，色度两两对调。
     * dst 至少 w*h*3/2。
     */
    fun nv21ToNv12(src: ByteArray, dst: ByteArray, w: Int, h: Int) {
        val y = w * h
        System.arraycopy(src, 0, dst, 0, y)
        var i = y
        val end = y + y / 2
        while (i + 1 < end) {
            dst[i] = src[i + 1]
            dst[i + 1] = src[i]
            i += 2
        }
    }

    /** NV21 → I420（Y 平面 + U 平面 + V 平面）。 */
    fun nv21ToI420(src: ByteArray, dst: ByteArray, w: Int, h: Int) {
        val y = w * h
        val q = y / 4
        System.arraycopy(src, 0, dst, 0, y)
        var u = y
        var v = y + q
        var i = y
        val end = y + 2 * q
        while (i + 1 < end) {
            dst[v++] = src[i]
            dst[u++] = src[i + 1]
            i += 2
        }
    }

    /**
     * 码率（比特/秒）：按看的一端选的「清晰度」（宽度，4:3）和画质算，和相机实际分辨率无关——
     * 清晰度选「流畅」就是要少用流量。画质 20…90 对应每像素 0.12…0.45 比特。
     * 0.33 以前是 0.06…0.30、最低 150 kbps：相机实际出的是 640×480，「标准」档算下来不到 300 kbps，画面全是马赛克。
     */
    fun bitrate(targetWidth: Int, fps: Int, quality: Int): Int {
        val px = targetWidth.toLong() * targetWidth * 3 / 4
        val bpp = 0.12 + (quality.coerceIn(20, 90) - 20) / 70.0 * 0.33
        return (px * fps.coerceIn(1, 30) * bpp).toLong().coerceIn(MIN_BITRATE.toLong(), 4_000_000L).toInt()
    }

    const val MIN_BITRATE = 300_000

    /**
     * 编码器实际出的码率比要的低很多时，把给它的码率调高多少倍（返回新的倍数，最多 MAX_BOOST）。
     * 有的老硬件编码器（S4）不管我们一秒喂几帧，都按每秒 30 帧来分码率：要 300 kbps、一秒喂 6 帧，实际只出 40 kbps，
     * 画面糊成一片。所以量实际出了多少，差得多（不到要的 60%）就多要一些，一次最多翻倍。
     * 画面本来就简单（对着白墙）时编码器也用不完码率，调高了也没坏处：它还是用不完。
     */
    fun boost(now: Double, wantBps: Int, actualBps: Long): Double {
        if (actualBps <= 0 || actualBps >= wantBps * 0.6 || now >= MAX_BOOST) return now
        return minOf(MAX_BOOST, now * minOf(2.0, wantBps.toDouble() / actualBps))
    }

    const val MAX_BOOST = 6.0

    /**
     * 硬件编码器肯定能吃的尺寸：宽高都是 16 的倍数，而且 Y 平面大小是 2048 的倍数
     * （有些老高通编码器要求色度从 2048 对齐的地方开始；这样的尺寸不用补齐，不管编码器要不要求都对）。
     */
    fun sizeOk(w: Int, h: Int) = w > 0 && h > 0 && w % 16 == 0 && h % 16 == 0 && (w * h) % 2048 == 0
}
