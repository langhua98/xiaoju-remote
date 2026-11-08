package com.langhua98.xiaoju.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/** 「装傻」省电（0.18）：间歇守望的设置、侦测跨过相机关掉的那段、守望时的对焦、留帧记下钟点。 */
class DutyCycleTest {
    private val w = 640
    private val h = 480
    private val rnd = Random(7)

    private fun frame(box: Pair<Int, Int>? = null, light: Int = 0): ByteArray {
        val f = ByteArray(w * h * 3 / 2)
        for (y in 0 until h) for (x in 0 until w) {
            var v = 60 + x / 8 + y / 10 + light + (rnd.nextGaussian() * 6.0).toInt()
            if (box != null && x in box.first until box.first + 90 && y in box.second until box.second + 120) v = 220
            f[y * w + x] = v.coerceIn(0, 255).toByte()
        }
        return f
    }

    @Test fun dutyIsOnByDefaultAndClamped() {
        val m = MonitorConfig()
        assertTrue(m.duty); assertFalse("侦测没开就不算", m.dutyActive)
        assertTrue("老设置里没有 duty：默认间歇", MonitorConfig.fromJson("{\"on\":true}").dutyActive)
        assertFalse(MonitorConfig.fromJson("{\"on\":true,\"duty\":false}").dutyActive)
        assertEquals(2, m.dutyOn); assertEquals(4, m.dutyOff)
        val d = m.merge(JSONObject().put("on", true).put("duty", true).put("duty_on", 0).put("duty_off", 999))
        assertTrue(d.dutyActive)
        assertEquals(1, d.dutyOn); assertEquals(60, d.dutyOff)
        val back = MonitorConfig.fromJson(d.toJson().toString())
        assertTrue(back.duty); assertEquals(1, back.dutyOn); assertEquals(60, back.dutyOff)
        // 只在省电侦测里才间歇
        assertFalse(d.merge(JSONObject().put("eco", false)).dutyActive)
        assertFalse(d.merge(JSONObject().put("on", false)).dutyActive)
    }

    @Test fun detectorIsReadyOnlyAfterWarmUp() {
        val d = MotionDetector()
        assertFalse(d.ready)
        repeat(MotionDetector.WARM) { d.analyze(frame(), w, h) }
        assertFalse("第一帧只是拿来当背景", d.ready)
        d.analyze(frame(), w, h)
        assertTrue(d.ready)
        d.reset()
        assertFalse(d.ready)
    }

    @Test fun pauseKeepsBackgroundSoNextRoundCanDetectRightAway() {
        val d = MotionDetector()
        repeat(15) { assertFalse(d.analyze(frame(), w, h)) }
        d.pause()
        assertTrue("背景还在", d.ready)
        // 相机歇了一会儿再开：同样的场景不算动静
        repeat(4) { assertFalse(d.analyze(frame(), w, h)) }
        d.pause()
        // 一开相机就有东西在动：两帧就能报，不用重新学 2.5 秒背景
        assertFalse(d.analyze(frame(100 to 200), w, h))
        assertTrue("看到一半，不能歇", d.pending)
        assertTrue(d.analyze(frame(130 to 200), w, h))
    }

    @Test fun pauseBreaksTheConsecutiveCount() {
        val d = MotionDetector()
        repeat(15) { d.analyze(frame(), w, h) }
        assertFalse(d.analyze(frame(100 to 200), w, h))
        d.pause()   // 中间隔了几秒：上一轮的那一次不能和这一轮的连起来
        assertFalse(d.pending)
        assertFalse(d.analyze(frame(400 to 200), w, h))
    }

    @Test fun watchFocusIsFixedWhenPossible() {
        val s4 = listOf("auto", "infinity", "macro", "continuous-picture", "continuous-video")
        assertEquals("infinity", LiveSettings.pickFocus(s4, watch = true))
        assertEquals("continuous-video", LiveSettings.pickFocus(s4, watch = false))
        assertEquals("fixed", LiveSettings.pickFocus(listOf("fixed"), watch = true))
        assertNull("前置镜头常常只有固定焦：不改", LiveSettings.pickFocus(listOf("auto"), watch = true))
        assertEquals("continuous-picture", LiveSettings.pickFocus(listOf("auto", "continuous-picture"), watch = false))
        assertNull(LiveSettings.pickFocus(emptyList(), watch = false))
    }

    @Test fun preRollRemembersWhenEachFrameWasTaken() {
        val n = w * h * 3 / 2
        val pr = PreRoll()
        pr.add(ByteArray(n), w, h, ts = 1_000, wall = 1_700_000_000_000)
        pr.add(ByteArray(n), w, h, ts = 1_250, wall = 1_700_000_000_250)
        val walls = ArrayList<Long>()
        pr.drain(w, h) { walls.add(it.wall) }
        assertEquals(listOf(1_700_000_000_000, 1_700_000_000_250), walls)
    }
}
