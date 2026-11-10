// 超低功耗移动侦测引擎（C++ 版）。Kotlin 版 MotionDetector.kt 留着当基准，两个可以切换、也可以同时跑来比。
//
// 只看 NV21 前面的 Y（亮度）平面，不转 RGB。画面分成 cols×rows 个格子，每格只取 P×P 个点（稀疏采样），
// 和慢慢更新的背景比。所有数组在构造时一次分配好，analyze() 里不分配内存、不复制图像。
//
// 和 Kotlin 版的区别（都在电脑上用同样的模拟场景测过，见 android/tests/motion）：
//   - 每格自己记噪点：电视、树叶、闪的灯这些一直在变的格子门槛自己升高，不老是误报；
//   - 整体亮度补偿同时试「加一个数」和「乘一个数」（相机自动曝光是乘的），取残差小的那个，用中位数不怕前景；
//   - 孤立的单个格子不算（要和旁边的格子连着），过滤噪点；
//   - 只采检测区域（ROI）里的格子，区域外的像素一个都不读；
//   - 四个阶段自己定下一帧什么时候看：待命 2 帧/秒 → 疑似 4 帧/秒连续确认 → 确认（交给 Kotlin 录像、AI）→ 冷却后回待命。
//
// 不依赖安卓，电脑上能编能测。线程：analyze 在相机线程，moved 在 AI 线程，内部有锁。
#pragma once

#include <stdint.h>
#include <mutex>
#include <vector>

namespace xjm {

enum Stage { STANDBY = 0, SUSPECT = 1, ACTIVE = 2, COOLDOWN = 3 };

// analyze() 返回值的位
enum Flags {
    F_MOVING = 1,      // 这一帧有变化（还没确认）
    F_CONFIRMED = 2,   // 确认有动静：该录像、跑 AI、提醒了
    F_READY = 4,       // 背景学好了
    F_REBASED = 8,     // 整个画面都变了（碰了相机、开关灯），背景重来
};

struct Config {
    int sensitivity = 50;    // 1…100，越大越灵敏
    int standbyMs = 500;     // 待命：多久看一帧（2 帧/秒）
    int suspectMs = 250;     // 疑似 / 冷却：4 帧/秒
    int activeMs = 200;      // 录像中：5 帧/秒（和 Kotlin 版一样，事件能接着延长）
    int confirm = 3;         // 疑似阶段要看到几帧有变化才算（包括待命时发现的那一帧）
    int cooldownMs = 10000;  // 录像停了以后，4 帧/秒再看这么久才回待命
};

struct Stats {
    int64_t analyzed = 0;    // 看了几帧
    int64_t samples = 0;     // 一共读了多少个像素
    int64_t suspects = 0;    // 进了几次疑似
    int64_t aborted = 0;     // 疑似后来没确认（光线闪、噪点、飞虫…被过滤掉的）
    int64_t confirms = 0;    // 确认了几次（= 交给 Kotlin 开始录的次数）
    int64_t rebases = 0;     // 背景重来几次
    float score = 0;         // 最近一帧变了的格子占比
    float noise = 0;         // 整体噪点（亮度级）
    int hits = 0;            // 疑似阶段已经看到几帧
};

class MotionEngine {
public:
    explicit MotionEngine(int cols = 32, int rows = 24, int perSide = 4);

    void configure(const Config& c);
    // 只检测 mask 里非 0 的格子（cols*rows 个，相机原始方向）；nullptr = 整个画面
    void setMask(const uint8_t* mask);
    // 换镜头、调亮度：重新学背景
    void reset();
    // 相机关了一会儿又开（间歇守望）：背景留着，只把疑似清零（隔着空白的两帧不算连续）
    void pause();

    // 看一帧。y = Y 平面（stride 一般就是 w），now = 毫秒，recording = Kotlin 那边正在录。
    int analyze(const uint8_t* y, int w, int h, int stride, int64_t now, bool recording);

    // 这个框（0…1，相机原始方向）里最近一帧有没有格子变了（AI 线程上用）
    bool moved(float x1, float y1, float x2, float y2);

    int stage() const { return stage_; }
    // 下一帧过多久再看（毫秒）
    int nextMs() const;
    // 相机每秒该给几帧（待命 2、疑似 / 冷却 4、录像时 0 = 交给 Kotlin 按录像帧率）
    int cameraFps() const;
    bool ready() const { return ready_; }
    // 正看到一半（疑似、冷却）：间歇守望这时候不能歇
    bool pending() const { return stage_ == SUSPECT || stage_ == COOLDOWN; }
    Stats stats();

private:
    int sample(const uint8_t* y, int w, int h, int stride);
    void compensate(int& mode, int& shift, int& gain);
    static int histMedian(const int* hist, int bins, int total);

    const int cols_, rows_, n_, per_;
    Config cfg_;
    std::mutex mu_;

    // 全部预先分配
    std::vector<int32_t> cur_;      // 每格平均亮度（Q4：×16）
    std::vector<int32_t> bg_;       // 背景（Q8：×256）
    std::vector<int32_t> nv_;       // 每格噪点（Q4）
    std::vector<int32_t> res_;      // 残差（Q4）
    std::vector<uint8_t> mask_;
    std::vector<uint8_t> changed_;  // 这一帧哪些格子变了
    std::vector<uint8_t> moved_;    // 给 AI 线程看的副本
    std::vector<int> hist_;         // 求中位数用的直方图
    std::vector<int> hist2_;

    int c0_ = 0, c1_ = 0, r0_ = 0, r1_ = 0;   // 检测区域的格子范围（含）
    int masked_ = 0;
    bool hasBg_ = false;
    int bgW_ = 0, bgH_ = 0;
    bool ready_ = false;
    int64_t warmUntil_ = 0;
    int warmFrames_ = 0;
    int gn_ = 3 * 16;               // 整体噪点（Q4）

    int stage_ = STANDBY;
    int hits_ = 0;
    int misses_ = 0;
    int64_t cooldownUntil_ = 0;
    Stats st_;
};

}  // namespace xjm
