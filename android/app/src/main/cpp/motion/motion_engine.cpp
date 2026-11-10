// 说明见 motion_engine.h。数都用整数（Q4 = ×16，Q8 = ×256），S4 的 32 位 ARM 上不用浮点。
#include "motion_engine.h"

#include <string.h>

namespace xjm {

namespace {
const int HBINS = 512;      // 直方图格数
const int WARM_MS = 2000;   // 背景重新学的头 2 秒不报（刚开相机曝光还在变）
const int WARM_FRAMES = 4;
inline int iabs(int v) { return v < 0 ? -v : v; }
inline int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
// 补偿后这一格「应该」有多亮（Q4）。超过 255 / 低于 0 的截掉：变亮以后亮的地方过曝成全白，不能算变化
inline int predict(int b, int mode, int shift, int gain) {
    return clampi(mode ? (b * gain) >> 7 : b + shift, 0, 255 * 16);
}
}  // namespace

MotionEngine::MotionEngine(int cols, int rows, int perSide)
    : cols_(cols), rows_(rows), n_(cols * rows), per_(perSide < 1 ? 1 : perSide),
      cur_(n_), bg_(n_), nv_(n_, 3 * 16), res_(n_), mask_(n_, 1), changed_(n_), moved_(n_),
      hist_(HBINS * 2), hist2_(HBINS) {
    setMask(nullptr);
}

void MotionEngine::configure(const Config& c) {
    std::lock_guard<std::mutex> l(mu_);
    cfg_ = c;
    cfg_.sensitivity = clampi(c.sensitivity, 1, 100);
    if (cfg_.confirm < 1) cfg_.confirm = 1;
}

void MotionEngine::setMask(const uint8_t* m) {
    std::lock_guard<std::mutex> l(mu_);
    masked_ = 0;
    c0_ = cols_; c1_ = -1; r0_ = rows_; r1_ = -1;
    for (int i = 0; i < n_; i++) {
        mask_[i] = (m == nullptr || m[i]) ? 1 : 0;
        if (!mask_[i]) continue;
        masked_++;
        int c = i % cols_, r = i / cols_;
        if (c < c0_) c0_ = c;
        if (c > c1_) c1_ = c;
        if (r < r0_) r0_ = r;
        if (r > r1_) r1_ = r;
    }
    memset(changed_.data(), 0, n_);
}

void MotionEngine::reset() {
    std::lock_guard<std::mutex> l(mu_);
    hasBg_ = false; ready_ = false;
    stage_ = STANDBY; hits_ = 0; misses_ = 0;
    st_.score = 0;
}

void MotionEngine::pause() {
    std::lock_guard<std::mutex> l(mu_);
    hits_ = 0; misses_ = 0;
    if (stage_ == SUSPECT) stage_ = STANDBY;
}

int MotionEngine::nextMs() const {
    switch (stage_) {
        case SUSPECT: case COOLDOWN: return cfg_.suspectMs;
        case ACTIVE: return cfg_.activeMs;
        default: return cfg_.standbyMs;
    }
}

int MotionEngine::cameraFps() const {
    if (stage_ == ACTIVE) return 0;
    int ms = nextMs();
    if (ms <= 0) return 15;
    return (1000 + ms - 1) / ms;
}

Stats MotionEngine::stats() {
    std::lock_guard<std::mutex> l(mu_);
    Stats s = st_;
    s.noise = gn_ / 16.0f;
    s.hits = hits_;
    return s;
}

// 每格的平均亮度：格子里每隔 step 个点取一个（P×P 个点），只采检测区域里的格子。返回读了多少个点。
int MotionEngine::sample(const uint8_t* y, int w, int h, int stride) {
    const int cw = w / cols_, ch = h / rows_;
    int step = (cw < ch ? cw : ch) / per_;
    if (step < 1) step = 1;
    int total = 0;
    for (int r = r0_; r <= r1_; r++) {
        for (int c = c0_; c <= c1_; c++) {
            const int i = r * cols_ + c;
            if (!mask_[i]) continue;
            int sum = 0, k = 0;
            const int x0 = c * cw + step / 2, x1 = (c + 1) * cw;
            for (int yy = r * ch + step / 2; yy < (r + 1) * ch; yy += step) {
                const uint8_t* row = y + (size_t)yy * stride;
                for (int xx = x0; xx < x1; xx += step) { sum += row[xx]; k++; }
            }
            cur_[i] = k > 0 ? (sum << 4) / k : 0;
            total += k;
        }
    }
    return total;
}

int MotionEngine::histMedian(const int* hist, int bins, int total) {
    int half = total / 2, acc = 0;
    for (int b = 0; b < bins; b++) { acc += hist[b]; if (acc > half) return b; }
    return bins - 1;
}

// 整体亮度补偿：试「加一个数」和「乘一个数」两种（相机自动曝光是乘的，开灯更像加的），
// 都用中位数（有人走进来、占了画面三成也不会把它带偏），取残差中位数小的那个。残差写进 res_。
void MotionEngine::compensate(int& mode, int& shift, int& gain) {
    int* ha = hist_.data();            // 加：差值（亮度级）+256
    int* hm = hist_.data() + HBINS;    // 乘：比值 ×128，最多 4 倍
    memset(ha, 0, sizeof(int) * HBINS * 2);
    for (int r = r0_; r <= r1_; r++) for (int c = c0_; c <= c1_; c++) {
        const int i = r * cols_ + c;
        if (!mask_[i]) continue;
        const int b = bg_[i] >> 4;    // Q4
        ha[clampi(((cur_[i] - b) >> 4) + 256, 0, HBINS - 1)]++;
        hm[clampi((cur_[i] << 7) / (b < 16 ? 16 : b), 0, HBINS - 1)]++;
    }
    shift = ((histMedian(ha, HBINS, masked_) - 256) << 4) + 8;   // Q4
    gain = histMedian(hm, HBINS, masked_);                       // ×128

    // 两种补偿后的残差中位数（亮度级）
    int* ea = hist2_.data();
    memset(ea, 0, sizeof(int) * HBINS);
    int* em = hist_.data();            // 上面的直方图用完了，重复用
    memset(em, 0, sizeof(int) * HBINS);
    for (int r = r0_; r <= r1_; r++) for (int c = c0_; c <= c1_; c++) {
        const int i = r * cols_ + c;
        if (!mask_[i]) continue;
        const int b = bg_[i] >> 4;
        ea[clampi(iabs(cur_[i] - predict(b, 0, shift, gain)) >> 4, 0, HBINS - 1)]++;
        em[clampi(iabs(cur_[i] - predict(b, 1, shift, gain)) >> 4, 0, HBINS - 1)]++;
    }
    const int medA = histMedian(ea, HBINS, masked_);
    const int medM = histMedian(em, HBINS, masked_);
    mode = medM < medA ? 1 : 0;
    for (int r = r0_; r <= r1_; r++) for (int c = c0_; c <= c1_; c++) {
        const int i = r * cols_ + c;
        if (!mask_[i]) continue;
        const int b = bg_[i] >> 4;
        res_[i] = iabs(cur_[i] - predict(b, mode, shift, gain));
    }
}

int MotionEngine::analyze(const uint8_t* y, int w, int h, int stride, int64_t now, bool recording) {
    std::lock_guard<std::mutex> l(mu_);
    if (y == nullptr || w < cols_ * 2 || h < rows_ * 2 || masked_ == 0) return 0;
    if (stride < w) stride = w;
    st_.samples += sample(y, w, h, stride);
    st_.analyzed++;

    if (!hasBg_ || bgW_ != w || bgH_ != h) {
        for (int i = 0; i < n_; i++) { bg_[i] = cur_[i] << 4; nv_[i] = 3 * 16; }
        hasBg_ = true; bgW_ = w; bgH_ = h;
        ready_ = false; warmUntil_ = now + WARM_MS; warmFrames_ = 0;
        stage_ = recording ? ACTIVE : STANDBY; hits_ = 0; misses_ = 0;
        st_.score = 0;
        memset(changed_.data(), 0, n_);
        return 0;
    }

    int mode, shift, gain;
    compensate(mode, shift, gain);

    // 这一帧的整体噪点：残差的中位数
    int* hr = hist2_.data();
    memset(hr, 0, sizeof(int) * HBINS);
    for (int r = r0_; r <= r1_; r++) for (int c = c0_; c <= c1_; c++) {
        const int i = r * cols_ + c;
        if (mask_[i]) hr[clampi(res_[i] >> 2, 0, HBINS - 1)]++;   // Q2
    }
    const int med = (histMedian(hr, HBINS, masked_) << 2) + 2;    // Q4

    // 门槛（Q4）：灵敏度定的基本值 + 3 倍噪点（整体噪点和这一格自己的噪点取大的）
    const int s = cfg_.sensitivity;
    // 已经在疑似 / 录像了：基本门槛降到 3/4（迟滞），衣服颜色和背景差不多的人也确认得快、录像不容易断。
    // 噪点那一项不降：电视、树叶这些自己就在变的格子不能因为迟滞变得好报
    const bool hyst = stage_ == SUSPECT || stage_ == ACTIVE;
    const int base = (5 * 16 + (100 - s) * 4) * (hyst ? 3 : 4) / 4;
    const int k = 12;   // 3 倍噪点（×4）
    int changed = 0;
    for (int r = r0_; r <= r1_; r++) for (int c = c0_; c <= c1_; c++) {
        const int i = r * cols_ + c;
        if (!mask_[i]) { changed_[i] = 0; continue; }
        const int nz = nv_[i] > gn_ ? nv_[i] : gn_;
        const uint8_t ch = res_[i] > base + k * nz / 4 ? 1 : 0;
        changed_[i] = ch;
        changed += ch;
    }
    // 孤立的格子不算：要至少和上下左右一个变了的格子连着
    int supported = 0;
    for (int r = r0_; r <= r1_; r++) for (int c = c0_; c <= c1_; c++) {
        const int i = r * cols_ + c;
        if (!changed_[i]) continue;
        if ((c > 0 && changed_[i - 1]) || (c + 1 < cols_ && changed_[i + 1]) ||
            (r > 0 && changed_[i - cols_]) || (r + 1 < rows_ && changed_[i + cols_])) supported++;
    }
    const int frac1000 = changed * 1000 / masked_;
    st_.score = frac1000 / 1000.0f;
    int need = masked_ * (3 + (100 - s) * 3 / 10) / 1000;   // 0.3% + (100-灵敏度)×0.03%
    if (need < 2) need = 2;
    const bool moving = supported >= need;
    int flags = 0;
    warmFrames_++;

    if (frac1000 > 600) {
        // 整个画面都变了：相机被碰了、灯开关了。直接当新背景，不报
        for (int i = 0; i < n_; i++) bg_[i] = cur_[i] << 4;
        memset(changed_.data(), 0, n_);
        st_.rebases++;
        hits_ = 0; misses_ = 0;
        if (stage_ == SUSPECT) stage_ = STANDBY;
        return F_REBASED | (ready_ ? F_READY : 0);
    }

    // 噪点、背景慢慢跟上现在的画面。有变化时都放慢（有人站着不动，过一会儿也会变成背景）
    if (!moving) gn_ += (med - gn_) / 10;
    const int nshift = (moving || stage_ != STANDBY) ? 6 : 3;
    const int bshift = moving ? 6 : 3;
    const int ncap = 30 * 16;
    for (int r = r0_; r <= r1_; r++) for (int c = c0_; c <= c1_; c++) {
        const int i = r * cols_ + c;
        if (!mask_[i]) continue;
        const int d = res_[i] < ncap ? res_[i] : ncap;
        nv_[i] += (d - nv_[i]) >> nshift;
        if (nv_[i] < 8) nv_[i] = 8;
        bg_[i] += ((cur_[i] << 4) - bg_[i]) >> bshift;
    }

    if (!ready_) {
        if (warmFrames_ >= WARM_FRAMES && now >= warmUntil_) ready_ = true;
        else return 0;
    }
    flags |= F_READY;
    if (moving) flags |= F_MOVING;

    // 四个阶段
    switch (stage_) {
        case STANDBY:
        case COOLDOWN:
            if (moving) {
                stage_ = SUSPECT; hits_ = 1; misses_ = 0; st_.suspects++;
                if (hits_ >= cfg_.confirm) { stage_ = ACTIVE; st_.confirms++; flags |= F_CONFIRMED; }
            } else if (stage_ == COOLDOWN && now >= cooldownUntil_) {
                stage_ = STANDBY;
            }
            break;
        case SUSPECT:
            if (moving) {
                hits_++; misses_ = 0;
                if (hits_ >= cfg_.confirm) { stage_ = ACTIVE; st_.confirms++; flags |= F_CONFIRMED; hits_ = 2; }
            } else if (++misses_ >= 2) {
                // 连着两帧没变化：是光线闪了一下、噪点、飞虫，回待命
                stage_ = STANDBY; hits_ = 0; misses_ = 0; st_.aborted++;
            }
            break;
        case ACTIVE:
            // 录像中：连着两帧有变化就让 Kotlin 把录像往后延
            hits_ = moving ? hits_ + 1 : 0;
            if (hits_ >= 2) flags |= F_CONFIRMED;
            if (recording) { misses_ = -1; }                         // 看到 Kotlin 在录了
            else if (misses_ == -1) {                                // 录完了：冷却
                stage_ = COOLDOWN; cooldownUntil_ = now + cfg_.cooldownMs; hits_ = 0; misses_ = 0;
            } else if (++misses_ > 15) {                             // 一直没开始录（Kotlin 没接）：也回去
                stage_ = COOLDOWN; cooldownUntil_ = now + cfg_.cooldownMs; hits_ = 0; misses_ = 0;
            }
            break;
    }
    return flags;
}

bool MotionEngine::moved(float x1, float y1, float x2, float y2) {
    std::lock_guard<std::mutex> l(mu_);
    int a = clampi((int)(x1 * cols_), 0, cols_ - 1), b = clampi((int)(x2 * cols_), 0, cols_ - 1);
    int p = clampi((int)(y1 * rows_), 0, rows_ - 1), q = clampi((int)(y2 * rows_), 0, rows_ - 1);
    for (int r = p; r <= q; r++) for (int c = a; c <= b; c++) if (changed_[r * cols_ + c]) return true;
    return false;
}

}  // namespace xjm
