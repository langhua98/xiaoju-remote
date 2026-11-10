// 模拟场景：给移动侦测算漏检率、误报率。
// Kotlin 版在 app/src/test/.../MotionScenes.kt，一字一句对着这个写（同样的随机数、同样的整数算法，画面一模一样），
// 两个引擎看到的是同一套画面。改这里一定要两边一起改。
#pragma once

#include <stdint.h>
#include <string.h>
#include <vector>

namespace scenes {

const int W = 640, H = 480;

struct Rng {
    uint32_t s;
    explicit Rng(uint32_t seed) : s(seed ? seed : 1) {}
    uint32_t next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
};

// 一个在动的东西（人）：从 (x0, y) 走到 (x1, y)，startMs 进画面，速度 pxPerSec，亮度比背景高 contrast
struct Walker { int startMs, x0, x1, y, w, h, pxPerSec, contrast; };

struct Scene {
    const char* name;
    const char* what;      // 中文说明
    bool nuisance;         // true = 里面没有真的移动，报了就是误报
    int durMs;
    int noise;             // 噪点（标准差，亮度级）
    int dimQ8;             // 背景亮度 ×dim/256（暗的场景）
    // 整体光线：每 lightEveryMs 毫秒在 0 和 lightOffset 之间切一次（rampMs 毫秒里慢慢变）
    int lightEveryMs, lightOffset, rampMs;
    // 自动曝光：每 gainEveryMs 在 256 和 gainQ8 之间切（rampMs 里慢慢变）
    int gainEveryMs, gainQ8;
    int flicker;           // 每帧整体亮度随机 ±flicker
    bool tv;               // 画面里有一台一直在变的电视（120×90）
    int glitchEveryMs;     // 每隔这么久闪一下（一帧，40×40，飞虫 / 反光）
    std::vector<Walker> walkers;
};

inline int iabs(int v) { return v < 0 ? -v : v; }

// 0…1024：t 在一个周期里的位置（0 → 1 用 rampMs 慢慢变，再慢慢变回 0）
inline int toggle(int t, int every, int ramp) {
    if (every <= 0) return 0;
    int k = t / every, in = t % every;
    int on = k % 2;                       // 这一段是开着还是关着
    int v = on ? 1024 : 0;
    if (ramp > 0 && in < ramp) {          // 刚切换：慢慢变过去
        int from = on ? 0 : 1024;
        v = from + (v - from) * in / ramp;
    }
    return v;
}

// 画一帧（只画 Y 平面，NV21 后面的 UV 不管）。frame = 第几帧（做随机数种子），t = 毫秒
inline void render(const Scene& s, int frame, int t, uint8_t* y) {
    Rng rng((uint32_t)frame * 2654435761u + 12345u);
    const int light = s.lightOffset * toggle(t, s.lightEveryMs, s.rampMs) / 1024;
    const int gain = 256 + (s.gainQ8 - 256) * toggle(t, s.gainEveryMs, s.rampMs) / 1024;
    const int fl = s.flicker > 0 ? (int)(rng.next() % (uint32_t)(2 * s.flicker + 1)) - s.flicker : 0;
    const int tvv = 40 + (int)(rng.next() % 161u);
    bool glitch = false;
    int gx = 0, gy = 0;
    if (s.glitchEveryMs > 0 && t % s.glitchEveryMs < 70 && t >= s.glitchEveryMs) {
        glitch = true;
        gx = 100 + (t / s.glitchEveryMs * 97) % 400; gy = 100 + (t / s.glitchEveryMs * 53) % 250;
    }
    for (int yy = 0; yy < H; yy++) {
        uint8_t* row = y + yy * W;
        for (int xx = 0; xx < W; xx++) {
            int v = 60 + xx / 8 + yy / 10 + ((xx * 7 + yy * 13) % 23);
            v = v * s.dimQ8 / 256;
            if (s.tv && xx >= 40 && xx < 160 && yy >= 40 && yy < 130) v = tvv * s.dimQ8 / 256;
            for (const Walker& w : s.walkers) {
                if (t < w.startMs) continue;
                int dist = (int)((int64_t)(t - w.startMs) * w.pxPerSec / 1000);
                if (dist > iabs(w.x1 - w.x0)) continue;
                int x = w.x1 >= w.x0 ? w.x0 + dist : w.x0 - dist;
                if (xx >= x && xx < x + w.w && yy >= w.y && yy < w.y + w.h) v += w.contrast;
            }
            if (glitch && xx >= gx && xx < gx + 40 && yy >= gy && yy < gy + 40) v += 90;
            v = v * gain / 256 + light + fl;
            uint32_t r = rng.next();
            int n = (int)(r & 255) + (int)((r >> 8) & 255) + (int)((r >> 16) & 255) + (int)(r >> 24) - 510;
            v += n * s.noise / 148;
            row[xx] = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
        }
    }
}

// 一个人从什么时候到什么时候在画面里（真的移动）
inline int walkerEnd(const Walker& w) { return w.startMs + iabs(w.x1 - w.x0) * 1000 / w.pxPerSec; }

inline std::vector<Walker> walkers(int n, int everyMs, int x0, int x1, int y, int w, int h, int speed, int contrast) {
    std::vector<Walker> v;
    for (int i = 0; i < n; i++) v.push_back({5000 + i * everyMs, i % 2 ? x1 : x0, i % 2 ? x0 : x1, y, w, h, speed, contrast});
    return v;
}

inline std::vector<Scene> all() {
    std::vector<Scene> v;
    //          name           what                         nuis  dur     noise dim  lEvery lOff ramp gEvery gain flick tv     glitch walkers
    v.push_back({"still",      "静止的房间（噪点 6）",        true, 120000, 6,  256, 0,     0,   0,   0,     256, 0,  false, 0, {}});
    v.push_back({"dark",       "很暗、噪点大（夜里）",        true, 120000, 14, 90,  0,     0,   0,   0,     256, 0,  false, 0, {}});
    v.push_back({"exposure",   "相机自动曝光（整体 ×1.5）",   true, 120000, 6,  256, 0,     0,   0,   20000, 384, 0,  false, 0, {}});
    v.push_back({"lights",     "开灯关灯（整体 +60）",        true, 120000, 6,  256, 30000, 60,  800, 0,     256, 0,  false, 0, {}});
    v.push_back({"flicker",    "灯光闪烁（每帧 ±12）",        true, 60000,  6,  256, 0,     0,   0,   0,     256, 12, false, 0, {}});
    v.push_back({"tv",         "画面里有台电视一直在变",      true, 120000, 6,  256, 0,     0,   0,   0,     256, 0,  true,  0, {}});
    v.push_back({"glitch",     "偶尔闪一下（飞虫、反光）",    true, 60000,  6,  256, 0,     0,   0,   0,     256, 0,  false, 9000, {}});
    v.push_back({"walk",       "有人走过（正常速度）",        false, 125000, 6, 256, 0,     0,   0,   0,     256, 0,  false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 60)});
    v.push_back({"fast",       "有人很快跑过（1.3 秒）",      false, 125000, 6, 256, 0,     0,   0,   0,     256, 0,  false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 540, 60)});
    v.push_back({"slow",       "有人慢慢挪（30 像素/秒）",    false, 125000, 6, 256, 0,     0,   0,   0,     256, 0,  false, 0, walkers(6, 20000, 200, 350, 200, 60, 140, 30, 60)});
    v.push_back({"faint",      "衣服和背景颜色差不多",        false, 125000, 6, 256, 0,     0,   0,   0,     256, 0,  false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 24)});
    v.push_back({"darkwalk",   "夜里有人走过",                false, 125000, 14, 90, 0,     0,   0,   0,     256, 0,  false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 40)});
    v.push_back({"small",      "远处的小人（25×60）",         false, 125000, 6, 256, 0,     0,   0,   0,     256, 0,  false, 0, walkers(8, 15000, -25, 640, 260, 25, 60, 120, 60)});
    v.push_back({"walk+exp",   "有人走过，同时自动曝光在变",  false, 125000, 6, 256, 0,     0,   0,   15000, 340, 0,  false, 0, walkers(8, 15000, -60, 640, 200, 60, 140, 160, 60)});
    v.push_back({"walk+tv",    "开着电视，有人走过",          false, 125000, 6, 256, 0,     0,   0,   0,     256, 0,  true,  0, walkers(8, 15000, 160, 640, 220, 60, 140, 160, 60)});
    return v;
}

}  // namespace scenes
