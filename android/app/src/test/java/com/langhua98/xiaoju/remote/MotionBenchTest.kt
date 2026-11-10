package com.langhua98.xiaoju.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Kotlin 基准版移动侦测（MotionDetector）在模拟场景里的漏检率、误报率。
 * 场景和 C++ 版的测试（android/tests/motion）一模一样，两张表可以直接比。
 * 按手机上省电侦测的实际节奏：守望时相机每秒 4 帧、每帧都看；录像时 200 毫秒看一帧。录到最后一次动静后 15 秒。
 * 环境变量 XJ_MOTION_TSV 给了文件名，就把结果表也写进去（CI 里和 C++ 的拼在一起）。
 */
class MotionBenchTest {
    class Result(var looks: Int = 0, var events: Int = 0, var walkers: Int = 0, var detected: Int = 0, var latencySum: Long = 0, var us: Double = 0.0)

    private fun run(s: MotionScenes.Scene): Result {
        val buf = ByteArray(MotionScenes.W * MotionScenes.H * 3 / 2)
        val d = MotionDetector()
        val r = Result(walkers = s.walkers.size)
        val found = IntArray(s.walkers.size) { -1 }
        var rec = false
        var recUntil = 0
        var ns = 0L
        var t = 0
        while (t < s.durMs) {
            MotionScenes.render(s, t * 15 / 1000, t, buf)
            val t0 = System.nanoTime()
            val moving = d.analyze(buf, MotionScenes.W, MotionScenes.H)
            ns += System.nanoTime() - t0
            r.looks++
            if (moving) {
                if (!rec) r.events++
                rec = true; recUntil = t + 15000
                for (i in s.walkers.indices) {
                    val w = s.walkers[i]
                    if (found[i] < 0 && t >= w.startMs && t <= w.endMs + 1000) found[i] = t - w.startMs
                }
            }
            if (rec && t >= recUntil) rec = false
            t += if (rec) 200 else 250
        }
        for (v in found) if (v >= 0) { r.detected++; r.latencySum += v }
        r.us = ns / 1000.0 / maxOf(1, r.looks)
        return r
    }

    @Test fun scenesMatchCpp() {
        // 和 C++ 测试画出来的同一帧比校验和（test_motion.cpp 里打印的那个数），保证两边测的是同一套画面
        val buf = ByteArray(MotionScenes.W * MotionScenes.H)
        val s = MotionScenes.all.first { it.name == "walk+exp" }
        MotionScenes.render(s, 100, 6666, buf)
        var h = 2166136261L
        for (b in buf) { h = h xor (b.toLong() and 0xff); h = (h * 16777619L) and 0xffffffffL }
        assertEquals(SCENE_HASH, h)
    }

    @Test fun kotlinBaseline() {
        val tsv = System.getenv("XJ_MOTION_TSV")?.takeIf { it.isNotBlank() }?.let { File(it) }
        val sb = StringBuilder()
        var walkers = 0; var detected = 0; var nEvents = 0; var nMs = 0L; var nLooks = 0L
        println("Kotlin 基准（守望每秒 4 帧，连续 2 帧确认）")
        for (s in MotionScenes.all) {
            val r = run(s)
            val lat = if (r.detected > 0) (r.latencySum / r.detected).toInt() else -1
            println(String.format("%-10s %-28s %6d %6s %5d/%-2d %10d %8.1f", s.name, s.what, r.looks,
                if (s.nuisance) (if (r.events > 0) "有" else "0") else "-", r.detected, r.walkers, lat, r.us))
            sb.append("Kotlin\t${s.name}\t${s.what}\t${r.looks}\t${if (s.nuisance) r.events else 0}\t${r.walkers}\t${r.detected}\t$lat\t${String.format("%.1f", r.us)}\n")
            if (s.nuisance) { nEvents += r.events; nMs += s.durMs; nLooks += r.looks } else { walkers += r.walkers; detected += r.detected }
        }
        val miss = if (walkers > 0) 100.0 * (walkers - detected) / walkers else 0.0
        println(String.format("合计：漏检 %d/%d（%.1f%%），没人时误报 %d 次（折合每小时 %.1f 次），没人时平均每秒看 %.2f 帧",
            walkers - detected, walkers, miss, nEvents, nEvents * 3600000.0 / nMs, nLooks * 1000.0 / nMs))
        tsv?.appendText(sb.toString())
        // 基准版不改，只防着以后有人改坏了它：正常走过的人都要能发现
        assertTrue("漏检 $miss%", miss <= 30.0)
    }

    companion object {
        /** test_motion.cpp 打印的「场景校验和」 */
        const val SCENE_HASH = 3721555179L
    }
}
