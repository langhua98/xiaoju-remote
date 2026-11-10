package com.langhua98.xiaoju.remote

/**
 * 模拟场景（给移动侦测算漏检率、误报率），逐句对着 android/tests/motion/scenes.h 翻译：
 * 同样的随机数、同样的整数算法，画面和 C++ 测试里一模一样。改这里一定要两边一起改。
 */
object MotionScenes {
    const val W = 640
    const val H = 480

    class Rng(seed: Int) {
        private var s = if (seed == 0) 1 else seed
        fun next(): Int { s = s xor (s shl 13); s = s xor (s ushr 17); s = s xor (s shl 5); return s }
    }

    class Walker(val startMs: Int, val x0: Int, val x1: Int, val y: Int, val w: Int, val h: Int, val pxPerSec: Int, val contrast: Int) {
        val endMs get() = startMs + Math.abs(x1 - x0) * 1000 / pxPerSec
    }

    class Scene(
        val name: String, val what: String, val nuisance: Boolean, val durMs: Int, val noise: Int, val dimQ8: Int,
        val lightEveryMs: Int, val lightOffset: Int, val rampMs: Int, val gainEveryMs: Int, val gainQ8: Int,
        val flicker: Int, val tv: Boolean, val glitchEveryMs: Int, val walkers: List<Walker>,
    )

    private fun toggle(t: Int, every: Int, ramp: Int): Int {
        if (every <= 0) return 0
        val k = t / every
        val inside = t % every
        val on = k % 2
        var v = if (on != 0) 1024 else 0
        if (ramp > 0 && inside < ramp) {
            val from = if (on != 0) 0 else 1024
            v = from + (v - from) * inside / ramp
        }
        return v
    }

    private fun umod(v: Int, m: Int): Int = ((v.toLong() and 0xffffffffL) % m).toInt()

    /** 画一帧的 Y 平面（y 至少 W*H 字节）。 */
    fun render(s: Scene, frame: Int, t: Int, y: ByteArray) {
        val rng = Rng((frame.toLong() * 2654435761L + 12345L).toInt())
        val light = s.lightOffset * toggle(t, s.lightEveryMs, s.rampMs) / 1024
        val gain = 256 + (s.gainQ8 - 256) * toggle(t, s.gainEveryMs, s.rampMs) / 1024
        val fl = if (s.flicker > 0) umod(rng.next(), 2 * s.flicker + 1) - s.flicker else 0
        val tvv = 40 + umod(rng.next(), 161)
        var glitch = false
        var gx = 0
        var gy = 0
        if (s.glitchEveryMs > 0 && t % s.glitchEveryMs < 70 && t >= s.glitchEveryMs) {
            glitch = true
            gx = 100 + (t / s.glitchEveryMs * 97) % 400; gy = 100 + (t / s.glitchEveryMs * 53) % 250
        }
        // 这一帧每个人在哪（-1 = 不在画面里）
        val wx = IntArray(s.walkers.size) { i ->
            val w = s.walkers[i]
            if (t < w.startMs) Int.MIN_VALUE else {
                val dist = ((t - w.startMs).toLong() * w.pxPerSec / 1000).toInt()
                if (dist > Math.abs(w.x1 - w.x0)) Int.MIN_VALUE else if (w.x1 >= w.x0) w.x0 + dist else w.x0 - dist
            }
        }
        for (yy in 0 until H) {
            val row = yy * W
            for (xx in 0 until W) {
                var v = 60 + xx / 8 + yy / 10 + ((xx * 7 + yy * 13) % 23)
                v = v * s.dimQ8 / 256
                if (s.tv && xx >= 40 && xx < 160 && yy >= 40 && yy < 130) v = tvv * s.dimQ8 / 256
                for (i in s.walkers.indices) {
                    val x = wx[i]
                    if (x == Int.MIN_VALUE) continue
                    val w = s.walkers[i]
                    if (xx >= x && xx < x + w.w && yy >= w.y && yy < w.y + w.h) v += w.contrast
                }
                if (glitch && xx >= gx && xx < gx + 40 && yy >= gy && yy < gy + 40) v += 90
                v = v * gain / 256 + light + fl
                val r = rng.next()
                val n = (r and 255) + ((r ushr 8) and 255) + ((r ushr 16) and 255) + (r ushr 24) - 510
                v += n * s.noise / 148
                y[row + xx] = (if (v < 0) 0 else if (v > 255) 255 else v).toByte()
            }
        }
    }

    private fun walkers(n: Int, everyMs: Int, x0: Int, x1: Int, y: Int, w: Int, h: Int, speed: Int, contrast: Int) =
        (0 until n).map { i -> Walker(5000 + i * everyMs, if (i % 2 != 0) x1 else x0, if (i % 2 != 0) x0 else x1, y, w, h, speed, contrast) }

    val all: List<Scene> = listOf(
        Scene("still", "静止的房间（噪点 6）", true, 120000, 6, 256, 0, 0, 0, 0, 256, 0, false, 0, emptyList()),
        Scene("dark", "很暗、噪点大（夜里）", true, 120000, 14, 90, 0, 0, 0, 0, 256, 0, false, 0, emptyList()),
        Scene("exposure", "相机自动曝光（整体 ×1.5）", true, 120000, 6, 256, 0, 0, 0, 20000, 384, 0, false, 0, emptyList()),
        Scene("lights", "开灯关灯（整体 +60）", true, 120000, 6, 256, 30000, 60, 800, 0, 256, 0, false, 0, emptyList()),
        Scene("flicker", "灯光闪烁（每帧 ±12）", true, 60000, 6, 256, 0, 0, 0, 0, 256, 12, false, 0, emptyList()),
        Scene("tv", "画面里有台电视一直在变", true, 120000, 6, 256, 0, 0, 0, 0, 256, 0, true, 0, emptyList()),
        Scene("glitch", "偶尔闪一下（飞虫、反光）", true, 60000, 6, 256, 0, 0, 0, 0, 256, 0, false, 9000, emptyList()),
        Scene("walk", "有人走过（正常速度）", false, 125000, 6, 256, 0, 0, 0, 0, 256, 0, false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 60)),
        Scene("fast", "有人很快跑过（1.3 秒）", false, 125000, 6, 256, 0, 0, 0, 0, 256, 0, false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 540, 60)),
        Scene("slow", "有人慢慢挪（30 像素/秒）", false, 125000, 6, 256, 0, 0, 0, 0, 256, 0, false, 0, walkers(6, 20000, 200, 350, 200, 60, 140, 30, 60)),
        Scene("faint", "衣服和背景颜色差不多", false, 125000, 6, 256, 0, 0, 0, 0, 256, 0, false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 24)),
        Scene("darkwalk", "夜里有人走过", false, 125000, 14, 90, 0, 0, 0, 0, 256, 0, false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 40)),
        Scene("small", "远处的小人（25×60）", false, 125000, 6, 256, 0, 0, 0, 0, 256, 0, false, 0, walkers(8, 15000, -25, 640, 260, 25, 60, 120, 60)),
        Scene("walk+exp", "有人走过，同时自动曝光在变", false, 125000, 6, 256, 0, 0, 0, 15000, 340, 0, false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 60)),
        Scene("walk+tv", "开着电视，有人走过", false, 125000, 6, 256, 0, 0, 0, 0, 256, 0, true, 0, walkers(8, 15000, 160, 640, 220, 60, 140, 160, 60)),
    )
}
