package com.langhua98.xiaoju.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioClockTest {
    private val n = 640   // 16 kHz 的 40 ms

    @Test fun steadyChunksAreContiguous() {
        val c = AudioClock(16000)
        // 每包读到的时刻抖来抖去（±15 ms），时间戳还是一包接一包
        val jitter = longArrayOf(0, 15, -10, 12, -15, 3, 9, -7)
        for (i in 0 until 200) {
            val ts = c.stamp(n, 1_000 + 40L * (i + 1) + jitter[i % jitter.size])
            assertEquals(1_000 + 40L * i, ts)
        }
        assertEquals(0, c.resyncs)
    }

    @Test fun backlogBurstKeepsTimeline() {
        // 录音线程被卡了 600 ms，之后一下子读出 15 包积压：时间戳照样连着，不对钟
        val c = AudioClock(16000)
        var t = 1_000L
        for (i in 0 until 10) { t += 40; c.stamp(n, t) }
        t += 600
        for (i in 10 until 25) { val ts = c.stamp(n, t); assertEquals(1_000 + 40L * i, ts); t += 1 }
        assertEquals(0, c.resyncs)
    }

    @Test fun realLossResyncs() {
        // 麦克风真丢了 2 秒数据（缓冲区溢出）：钟点一直比样本时间晚，1 秒后对一次钟
        val c = AudioClock(16000)
        var t = 1_000L
        for (i in 0 until 10) { t += 40; c.stamp(n, t) }
        t += 2_000
        var last = 0L
        for (i in 0 until 40) { t += 40; last = c.stamp(n, t) }
        assertEquals(1, c.resyncs)
        assertEquals(t - 40, last)
    }

    @Test fun clockAheadResyncsAtOnce() {
        val c = AudioClock(8000)
        c.stamp(320, 1_040)
        // 钟点突然往回（不会真发生，但样本时间跑到前面 300 ms 以上就要马上对齐）
        assertEquals(1_000L - 340, c.stamp(320, 700))
        assertEquals(1, c.resyncs)
    }
}
