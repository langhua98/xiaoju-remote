package com.langhua98.xiaoju.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioPriorityTest {
    @Test fun shortBacklogIsIgnored() {
        val p = AudioPriority(pressureBytes = 1000, latePackets = 4)
        // 关键帧刚发完压了一下，马上就空了：不算
        for (i in 0 until 50) assertFalse(p.onPacket(if (i % 3 == 0) 5000 else 0))
    }

    @Test fun sustainedBacklogSlowsVideo() {
        val p = AudioPriority(pressureBytes = 1000, latePackets = 4)
        val hits = (0 until 12).count { p.onPacket(5000) }
        assertEquals(3, hits)   // 每连着 4 包压着就报一次
    }

    @Test fun narrowWithHysteresis() {
        val p = AudioPriority(narrowBelow = 0.5, wideAbove = 0.8)
        assertFalse(p.onRate(1.0)); assertFalse(p.narrow)
        assertFalse(p.onRate(0.7)); assertFalse(p.narrow)
        assertTrue(p.onRate(0.49)); assertTrue(p.narrow)
        assertFalse(p.onRate(0.7)); assertTrue(p.narrow)     // 升到 70% 还不换回去
        assertTrue(p.onRate(0.875)); assertFalse(p.narrow)
        p.onRate(0.3); p.reset(); assertFalse(p.narrow)
    }

    @Test fun halveDownsamples() {
        // 16 kHz 的 1 kHz 正弦 → 8 kHz：长度减半，形状还在（误差在 μ-law 的量化范围里）
        val n = 1600
        val src = ByteArray(n) { Ulaw.encode((10000 * Math.sin(2 * Math.PI * 1000 * it / 16000.0)).toInt()) }
        val out = Ulaw.halve(src)
        assertEquals(n / 2, out.size)
        for (i in out.indices) {
            val want = 10000 * Math.sin(2 * Math.PI * 1000 * (2 * i + 0.5) / 16000.0) * Math.cos(Math.PI * 1000 / 16000.0)
            val got = Ulaw.decode(out[i])
            assertTrue("i=$i want=$want got=$got", Math.abs(got - want) < 800)
        }
        assertEquals(0, Ulaw.halve(ByteArray(1)).size)
    }
}
