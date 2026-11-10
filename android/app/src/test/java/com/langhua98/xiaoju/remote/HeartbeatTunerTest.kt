package com.langhua98.xiaoju.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 智能心跳（0.19）：撑住就把间隔调长，撑不住就记住并退回下面一档。 */
class HeartbeatTunerTest {
    @Test fun startsAtStartWithinBounds() {
        val t = HeartbeatTuner(minMs = 20_000, maxMs = 540_000, startMs = 60_000)
        assertEquals(60_000, t.intervalMs)
        assertEquals(20_000, HeartbeatTuner(minMs = 20_000, startMs = 5_000).intervalMs) // 夹到 min
    }

    @Test fun growsWhenSurviving() {
        val t = HeartbeatTuner(startMs = 60_000)
        t.survived()
        assertTrue("survive 后要变长", t.intervalMs > 60_000)
        val a = t.intervalMs
        t.survived()
        assertTrue(t.intervalMs > a)
    }

    @Test fun neverGrowsPastMax() {
        val t = HeartbeatTuner(minMs = 20_000, maxMs = 120_000, startMs = 60_000)
        repeat(50) { t.survived() }
        assertEquals(120_000, t.intervalMs)
    }

    @Test fun backsOffAndStaysBelowDeadValue() {
        val t = HeartbeatTuner(minMs = 20_000, maxMs = 540_000, startMs = 120_000)
        t.died()                       // 120 秒撑不住
        assertTrue("死了要退回去", t.intervalMs < 120_000)
        assertTrue(t.intervalMs >= 20_000)
        // 再怎么涨也别碰到那个撑不住的值
        repeat(50) { t.survived() }
        assertTrue("不能再涨到撑不住的 120 秒", t.intervalMs < 120_000)
    }

    @Test fun neverBelowMin() {
        val t = HeartbeatTuner(minMs = 20_000, startMs = 20_000)
        repeat(10) { t.died() }
        assertEquals(20_000, t.intervalMs)
    }

    @Test fun resetForgetsCeiling() {
        val t = HeartbeatTuner(minMs = 20_000, maxMs = 540_000, startMs = 120_000)
        t.died()
        t.reset()                      // 换了网络
        repeat(50) { t.survived() }
        assertEquals("忘掉上限后能涨到 max", 540_000, t.intervalMs)
    }
}
