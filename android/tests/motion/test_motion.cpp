// 电脑上测 C++ 移动侦测引擎（app/src/main/cpp/motion）：用 scenes.h 的模拟场景算漏检率、误报率、反应时间，
// 顺便检查 analyze() 里一次内存都不分配。Kotlin 基准版用同一套场景在 MotionBenchTest.kt 里测，两边的表可以直接比。
//   sh run.sh
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <chrono>
#include <new>

#include "motion_engine.h"
#include "scenes.h"

// 数一数分配了几次内存（analyze 里应该是 0）
static long g_allocs = 0;
void* operator new(size_t n) { g_allocs++; void* p = malloc(n ? n : 1); if (!p) throw std::bad_alloc(); return p; }
void operator delete(void* p) noexcept { free(p); }
void operator delete(void* p, size_t) noexcept { free(p); }

static int fails = 0;
#define CHECK(c, ...) do { if (!(c)) { printf("  没通过：" __VA_ARGS__); printf("\n"); fails++; } } while (0)

struct Result {
    int looks = 0, events = 0, walkers = 0, detected = 0;
    long latencySum = 0;
    double us = 0;
    long allocs = 0;
};

// 模拟一个场景。相机每秒 15 帧（帧号 = t*15/1000，只用来做随机数种子），引擎自己定多久看一帧；
// 录像：确认以后录到最后一次确认后 15 秒（和手机上默认的 post 一样）
static Result run(const scenes::Scene& s, const xjm::Config& cfg) {
    static uint8_t buf[scenes::W * scenes::H * 3 / 2];
    xjm::MotionEngine e;
    e.configure(cfg);
    Result r;
    r.walkers = (int)s.walkers.size();
    std::vector<int> found(s.walkers.size(), -1);
    bool rec = false;
    int recUntil = 0;
    double ns = 0;
    for (int t = 0; t < s.durMs;) {
        scenes::render(s, t * 15 / 1000, t, buf);
        long a0 = g_allocs;
        auto t0 = std::chrono::steady_clock::now();
        int f = e.analyze(buf, scenes::W, scenes::H, scenes::W, t, rec);
        ns += std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count();
        r.allocs += g_allocs - a0;
        r.looks++;
        if (f & xjm::F_CONFIRMED) {
            if (!rec) r.events++;
            rec = true; recUntil = t + 15000;
            for (size_t i = 0; i < s.walkers.size(); i++) {
                const scenes::Walker& w = s.walkers[i];
                if (found[i] < 0 && t >= w.startMs && t <= scenes::walkerEnd(w) + 1000) found[i] = t - w.startMs;
            }
        }
        if (rec && t >= recUntil) rec = false;
        t += e.nextMs();
    }
    for (int v : found) if (v >= 0) { r.detected++; r.latencySum += v; }
    r.us = ns / 1000.0 / (r.looks ? r.looks : 1);
    return r;
}

int main(int argc, char** argv) {
    const char* tsv = argc > 1 ? argv[1] : nullptr;   // 结果另外写一份表（CI 里和 Kotlin 的拼在一起看）
    FILE* out = tsv ? fopen(tsv, "w") : nullptr;
    if (out) fprintf(out, "引擎\t场景\t说明\t看了几帧\t误报\t人数\t发现\t平均反应毫秒\t每帧微秒\n");

    {
        // 场景校验和：Kotlin 那边（MotionBenchTest.SCENE_HASH）画同一帧要得到同一个数
        static uint8_t f[scenes::W * scenes::H];
        scenes::Scene s = scenes::all()[13];   // walk+exp
        scenes::render(s, 100, 6666, f);
        uint32_t h = 2166136261u;
        for (int i = 0; i < scenes::W * scenes::H; i++) { h ^= f[i]; h *= 16777619u; }
        printf("场景校验和 %u\n", h);
    }

    xjm::Config cfg;
    int walkers = 0, detected = 0, nuisanceEvents = 0;
    long nuisanceMs = 0, nuisanceLooks = 0, allocs = 0;
    printf("C++ 引擎（待命 %d 毫秒一帧，疑似 %d 毫秒一帧，连续 %d 帧确认）\n", cfg.standbyMs, cfg.suspectMs, cfg.confirm);
    printf("%-10s %-28s %6s %6s %8s %10s %8s\n", "场景", "说明", "帧数", "误报", "发现", "反应(ms)", "微秒/帧");
    for (const scenes::Scene& s : scenes::all()) {
        Result r = run(s, cfg);
        allocs += r.allocs;
        int lat = r.detected ? (int)(r.latencySum / r.detected) : -1;
        printf("%-10s %-28s %6d %6s %5d/%-2d %10d %8.1f\n", s.name, s.what, r.looks,
               s.nuisance ? (r.events ? "有" : "0") : "-", r.detected, r.walkers, lat, r.us);
        if (s.nuisance) { nuisanceEvents += r.events; nuisanceMs += s.durMs; nuisanceLooks += r.looks; }
        else { walkers += r.walkers; detected += r.detected; }
        if (out) fprintf(out, "C++\t%s\t%s\t%d\t%d\t%d\t%d\t%d\t%.1f\n", s.name, s.what, r.looks,
                         s.nuisance ? r.events : 0, r.walkers, r.detected, lat, r.us);
    }
    double miss = walkers ? 100.0 * (walkers - detected) / walkers : 0;
    double perHour = nuisanceMs ? nuisanceEvents * 3600000.0 / nuisanceMs : 0;
    double fps = nuisanceMs ? nuisanceLooks * 1000.0 / nuisanceMs : 0;
    printf("合计：漏检 %d/%d（%.1f%%），没人时误报 %d 次（折合每小时 %.1f 次），没人时平均每秒看 %.2f 帧\n",
           walkers - detected, walkers, miss, nuisanceEvents, perHour, fps);
    if (out) fclose(out);

    // 要求：C++ 版不能比这些差（Kotlin 基准的数在 MotionBenchTest 里）
    CHECK(allocs == 0, "analyze() 里分配了 %ld 次内存（应该一次都不分配）", allocs);
    CHECK(miss <= 15.0, "漏检率 %.1f%% 太高", miss);
    CHECK(nuisanceEvents <= 1, "没人的场景误报了 %d 次", nuisanceEvents);
    CHECK(fps <= 2.2, "没人时每秒看了 %.2f 帧（待命应该是 2 帧）", fps);

    // 别的档位只打一行合计（给选 standby_fps / confirm 参考，不做要求）
    struct Alt { const char* name; int standbyMs, confirm; };
    const Alt alts[] = {{"待命 1 帧/秒", 1000, 3}, {"待命 2 帧/秒、连续 2 帧确认", 500, 2}, {"待命 1 帧/秒、连续 2 帧确认", 1000, 2}};
    for (const Alt& a : alts) {
        xjm::Config c;
        c.standbyMs = a.standbyMs; c.confirm = a.confirm;
        int wk = 0, dt = 0, ev = 0;
        long ms = 0, lk = 0, lat = 0;
        for (const scenes::Scene& s : scenes::all()) {
            Result r = run(s, c);
            if (s.nuisance) { ev += r.events; ms += s.durMs; lk += r.looks; }
            else { wk += r.walkers; dt += r.detected; lat += r.latencySum; }
        }
        printf("%s：漏检 %d/%d（%.1f%%），没人时误报 %d 次，没人时每秒看 %.2f 帧，平均反应 %ld 毫秒\n", a.name,
               wk - dt, wk, 100.0 * (wk - dt) / wk, ev, lk * 1000.0 / ms, dt ? lat / dt : -1);
    }

    // 检测区域：区域外动不报，区域里动要报
    {
        static uint8_t buf[scenes::W * scenes::H * 3 / 2];
        scenes::Scene s = scenes::all()[7];   // walk
        std::vector<uint8_t> mask(32 * 24, 0);
        for (int r = 0; r < 24; r++) for (int c = 0; c < 6; c++) mask[r * 32 + c] = 1;   // 只看最左边一条
        xjm::MotionEngine e;
        e.setMask(mask.data());
        int hits = 0;
        // 第一个人从左边进来：在区域里，要报。只跑第一个人
        for (int t = 0; t < 9000; t += e.nextMs()) {
            scenes::render(s, t * 15 / 1000, t, buf);
            if (e.analyze(buf, scenes::W, scenes::H, scenes::W, t, false) & xjm::F_CONFIRMED) hits++;
        }
        CHECK(hits > 0, "检测区域里有人走过，没报");
        // 第二个人（右往左）最后才走到左边：区域外那段不能报
        xjm::MotionEngine e2;
        std::vector<uint8_t> right(32 * 24, 0);
        for (int r = 0; r < 24; r++) for (int c = 0; c < 32; c++) right[r * 32 + c] = r < 6 ? 1 : 0;   // 只看最上面（人不经过）
        e2.setMask(right.data());
        int hits2 = 0;
        for (int t = 0; t < 30000; t += e2.nextMs()) {
            scenes::render(s, t * 15 / 1000, t, buf);
            if (e2.analyze(buf, scenes::W, scenes::H, scenes::W, t, false) & xjm::F_CONFIRMED) hits2++;
        }
        CHECK(hits2 == 0, "检测区域外的动静报了 %d 次", hits2);
    }

    if (fails) { printf("C++ 移动侦测测试有 %d 项没通过\n", fails); return 1; }
    printf("C++ 移动侦测测试全部通过\n");
    return 0;
}
