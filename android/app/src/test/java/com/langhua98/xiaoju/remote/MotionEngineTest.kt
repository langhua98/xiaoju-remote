package com.langhua98.xiaoju.remote

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class MotionEngineTest {
    @Test fun engineSetting() {
        val m = MonitorConfig()
        assertEquals(MonitorConfig.KOTLIN, m.engine)   // 默认还是基准版
        val n = m.merge(JSONObject("""{"engine":"native","standby_fps":9,"confirm":1}"""))
        assertEquals(MonitorConfig.NATIVE, n.engine)
        assertEquals(4, n.standbyFps)
        assertEquals(2, n.confirm)
        assertEquals(MonitorConfig.NATIVE, n.merge(JSONObject("""{"engine":"rust"}""")).engine)   // 不认识的不改
        val back = MonitorConfig.fromJson(n.merge(JSONObject("""{"engine":"ab"}""")).toJson().toString())
        assertEquals(MonitorConfig.AB, back.engine)
        assertEquals(4, back.standbyFps)
    }

    @Test fun pacerFollowsFpsChange() {
        // 待命 2 帧/秒 → 疑似 4 帧/秒：下一帧 250 毫秒后就要，不用等满 500
        val p = FramePacer()
        assertTrue(p.due(1000, 2))
        assertFalse(p.due(1250, 2))
        assertTrue(p.due(1250, 4))
        assertTrue(p.due(1500, 4))
        assertFalse(p.due(1600, 4))
    }

    @Test fun abCompare() {
        val a = AbCompare()
        var t = 0L
        // 两个都报（差 1 秒）
        a.see(t, true, false); t += 1000; a.see(t, false, true)
        // 只有 C++ 报
        t += 10_000; a.see(t, false, true)
        // 只有 Kotlin 报
        t += 10_000; a.see(t, true, false)
        t += 10_000; a.see(t, false, false)
        assertEquals(1, a.both)
        assertEquals(1, a.nativeOnly)
        assertEquals(1, a.kotlinOnly)
    }

    @Test fun cpuTimeReadable() {
        // Linux 上读得到 /proc/self/stat（手机上也一样）
        assertTrue(MotionStats.cpuMs() >= 0)
    }

    /** 通过 JNI 跑 C++ 引擎（要先 sh tests/motion/run.sh，再 XJ_NATIVE_LIB=/tmp/xj-motion-test/lib 跑测试；没有就跳过） */
    @Test fun nativeEngineThroughJni() {
        assumeTrue("没有电脑版 libxjmotion.so", MotionNative.available)
        val buf = ByteArray(MotionScenes.W * MotionScenes.H * 3 / 2)
        fun run(name: String, regions: List<FloatArray> = emptyList()): Pair<Int, Int> {
            val s = MotionScenes.all.first { it.name == name }
            val e = NativeMotion()
            e.configure(MonitorConfig())
            e.setRegions(regions, 0)
            var t = 0L
            var events = 0
            var rec = false
            var recUntil = 0L
            var standbyLooks = 0
            while (t < s.durMs) {
                MotionScenes.render(s, (t * 15 / 1000).toInt(), t.toInt(), buf)
                if (e.stage == "standby") standbyLooks++
                if (e.analyze(buf, MotionScenes.W, MotionScenes.H, t, rec)) {
                    if (!rec) events++
                    rec = true; recUntil = t + 15_000
                }
                if (rec && t >= recUntil) rec = false
                // 和手机上一样：按引擎要的间隔看下一帧
                t += e.minGapMs * 5 / 4
            }
            e.close()
            return events to standbyLooks
        }
        val (walk, _) = run("walk")
        assertTrue("有人走过要报，报了 $walk 次", walk >= 1)
        val (still, looks) = run("still")
        assertEquals("静止的房间不能报", 0, still)
        assertTrue("待命时 2 帧/秒：2 分钟大约 240 帧，看了 $looks", looks in 200..260)
        assertEquals("电视一直在变，不能报", 0, run("tv").first)
        // 只看画面最上面一条（人不经过）：不能报
        assertEquals(0, run("walk", listOf(floatArrayOf(0f, 0f, 1f, 0.2f))).first)
    }
}
