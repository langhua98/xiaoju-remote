// 脸：状态和情绪的表情、眨眼、眼球微跳、口型、说话时的小动作。
// 动画自带的表情不覆盖：我们的值叠加在动画值上面（眨眼和口型取两者中大的）。
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const RAD = Math.PI / 180;

// 状态和情绪 → 表情形变（ARKit 名字，0～1）
// head：头的额外转动（弧度，yaw 正 = 向屏幕右，pitch 正 = 低头，roll 正 = 向屏幕右歪）
export const STATES = {
  idle: {},
  listening: { browInnerUp: 0.3, eyeWideLeft: 0.15, eyeWideRight: 0.15, head: { roll: 0.08 } },
  thinking: { mouthPressLeft: 0.3, mouthPressRight: 0.3, browDownLeft: 0.2, browOuterUpRight: 0.3, mouthLeft: 0.2, head: { roll: -0.1, pitch: -0.05 } },
  speaking: {},
  observing: { browDownLeft: 0.15, browDownRight: 0.15, eyeSquintLeft: 0.15, eyeSquintRight: 0.15 },
};
export const EMOTIONS = {
  neutral: {},
  happy: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.45, cheekSquintRight: 0.45, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
  alert: { browDownLeft: 0.7, browDownRight: 0.7, eyeWideLeft: 0.35, eyeWideRight: 0.35, mouthFrownLeft: 0.25, mouthFrownRight: 0.25 },
  surprised: { browInnerUp: 0.8, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.7, eyeWideRight: 0.7, jawOpen: 0.3 },
  confused: { browDownLeft: 0.6, browOuterUpRight: 0.6, mouthFrownLeft: 0.3, mouthFrownRight: 0.1, mouthLeft: 0.3, head: { roll: 0.18 } },
};

// 口型和眨眼：和动画值取大的；其余：加在动画值上
const MOUTH = ['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthClose'];
const FAST = new Set([...MOUTH, 'eyeBlinkLeft', 'eyeBlinkRight']);
const LIDS = ['eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight'];
const SHAPES = [...new Set([...Object.values(STATES), ...Object.values(EMOTIONS)].flatMap((o) => Object.keys(o)))].filter((k) => k !== 'head');
export const DRIVEN = [...new Set([...SHAPES, ...MOUTH, 'eyeBlinkLeft', 'eyeBlinkRight', ...LIDS])];

// 手感参数
export const FACE = {
  blinkEvery: [2, 6], blinkClose: 0.08, blinkOpen: 0.15, doubleBlink: 0.15,
  saccadeEvery: [0.8, 2.5], saccadeSize: [1 * RAD, 3 * RAD],
  nodEvery: [0.7, 1.8], nodSize: [0.025, 0.06], browSize: [0.15, 0.35],
};

export class Face {
  constructor() {
    this.cur = Object.fromEntries(DRIVEN.map((p) => [p, 0]));
    this.head = { yaw: 0, pitch: 0, roll: 0 };
    this.nextBlink = 1.5; this.blinkT = -1; this.blinkAgain = false;
    this.nextSaccade = 1; this.saccade = [0, 0];
    this.nod = 0; this.brow = 0; this.nextNod = 0; this.prevMouth = 0;
    this.vowel = [0.3, 0.3]; this.lastGaze = [0, 0];
    this.memo = new WeakMap();   // 网格 → 上一帧我们写进去的值和当时的动画值
  }

  /// 马上眨一次眼（视线大幅转动时用）
  blink(t) { if (this.blinkT < 0) this.blinkT = t; }

  /// 每帧调用。in：{ state, emotion, mouth 0～1, bands [低, 中, 高] 或 null, gx, gy 视线 }
  /// 返回头的额外姿态 { yaw, pitch, roll } 和眼球微跳 saccade，交给视线分配去用
  update(t, dt, inp) {
    const target = { ...STATES[inp.state] };
    const headT = { yaw: 0, pitch: 0, roll: 0, ...(target.head || {}) };
    delete target.head;
    for (const [k, v] of Object.entries(EMOTIONS[inp.emotion])) {
      if (k === 'head') { for (const [a, b] of Object.entries(v)) headT[a] += b; } else target[k] = (target[k] || 0) + v;
    }

    // ── 口型：张多大看音量；圆还是扁看声音的频段（低频多 = 「哦、呜」，高频多 = 「衣、诶」）
    const m = inp.mouth;
    if (m > 0.02) {
      let round, wide;
      if (inp.bands) {
        // 「哦、呜」的能量几乎都在低频；「衣、诶」和「丝、西」高频明显；「啊」集中在中频（嘴张大，不圆不扁）
        const [lo, mid, hi] = inp.bands, sum = lo + mid + hi + 1e-6;
        wide = clamp((hi / sum - 0.1) * 5, 0, 1);
        round = clamp((lo / sum - 0.6) * 4, 0, 1) * (1 - wide);
      } else {
        // 只有音量时，嘴型自己慢慢变，不至于一直是同一个口型
        round = 0.5 + 0.5 * Math.sin(t * 5.1 + Math.sin(t * 1.7) * 2); wide = 0.5 + 0.5 * Math.sin(t * 3.7 + 2);
        round *= 0.7; wide *= 0.6;
      }
      this.vowel[0] += (round - this.vowel[0]) * Math.min(1, dt * 14);
      this.vowel[1] += (wide - this.vowel[1]) * Math.min(1, dt * 14);
      const [r, w] = this.vowel;
      target.jawOpen = Math.max(target.jawOpen || 0, m * (0.62 - 0.15 * r));
      target.mouthFunnel = m * r * 0.55; target.mouthPucker = m * r * 0.3;
      target.mouthStretchLeft = target.mouthStretchRight = m * w * 0.4;
      target.mouthLowerDownLeft = target.mouthLowerDownRight = m * (1 - r) * 0.3;
      target.mouthUpperUpLeft = target.mouthUpperUpRight = m * w * 0.2;
    } else if (inp.state === 'speaking') target.mouthClose = 0.05;

    // ── 说话时的小动作：音量突然变大的那一下，轻轻点头、抬眉
    if (m > 0.45 && this.prevMouth < 0.3 && t > this.nextNod) {
      this.nod = rnd(...FACE.nodSize); this.brow = rnd(...FACE.browSize);
      this.nextNod = t + rnd(...FACE.nodEvery);
    }
    this.prevMouth += (m - this.prevMouth) * Math.min(1, dt * 10);
    this.nod *= Math.exp(-dt * 5); this.brow *= Math.exp(-dt * 3.5);
    headT.pitch += this.nod;
    target.browInnerUp = (target.browInnerUp || 0) + this.brow;

    // ── 眨眼：间隔随机，偶尔连眨两下；闭得快、睁得慢
    if (this.blinkT < 0 && t > this.nextBlink) this.blinkT = t;
    let blink = 0;
    if (this.blinkT >= 0) {
      const p = t - this.blinkT;
      if (p < FACE.blinkClose) blink = p / FACE.blinkClose;
      else if (p < FACE.blinkClose + FACE.blinkOpen) blink = 1 - (p - FACE.blinkClose) / FACE.blinkOpen;
      else {
        this.blinkT = -1;
        if (!this.blinkAgain && Math.random() < FACE.doubleBlink) { this.blinkAgain = true; this.nextBlink = t + 0.08; }
        else { this.blinkAgain = false; this.nextBlink = t + rnd(...FACE.blinkEvery); }
      }
    }
    target.eyeBlinkLeft = Math.max(target.eyeBlinkLeft || 0, blink);
    target.eyeBlinkRight = Math.max(target.eyeBlinkRight || 0, blink);

    // ── 眼球微跳：人的眼睛不会一直盯着一个点
    if (t > this.nextSaccade) {
      const a = rnd(0, Math.PI * 2), s = rnd(...FACE.saccadeSize);
      this.saccade = [Math.cos(a) * s, Math.sin(a) * s * 0.5];
      this.nextSaccade = t + rnd(...FACE.saccadeEvery);
    }
    // 视线大幅转动时顺带眨一下
    if (Math.abs(inp.gx - this.lastGaze[0]) + Math.abs(inp.gy - this.lastGaze[1]) > 0.5) this.blink(t);
    this.lastGaze = [inp.gx, inp.gy];

    // ── 眼球由骨骼转，这里只让上下眼皮跟着视线动一点
    const down = Math.max(0, inp.gy), up = Math.max(0, -inp.gy);
    target.eyeLookDownLeft = target.eyeLookDownRight = down * 0.35;
    target.eyeLookUpLeft = target.eyeLookUpRight = up * 0.35;

    const kShape = Math.min(1, dt * 8), kFast = Math.min(1, dt * 24), kHead = Math.min(1, dt * 5);
    for (const p of DRIVEN) this.cur[p] += ((target[p] || 0) - this.cur[p]) * (FAST.has(p) ? kFast : kShape);
    // 眨眼不走平滑（已经是按时间算好的曲线）
    this.cur.eyeBlinkLeft = target.eyeBlinkLeft; this.cur.eyeBlinkRight = target.eyeBlinkRight;
    this.head.yaw += (headT.yaw - this.head.yaw) * kHead;
    this.head.pitch += (headT.pitch - this.head.pitch) * kHead;
    this.head.roll += (headT.roll - this.head.roll) * kHead;
    return this.head;
  }

  /// 动画更新之后调用：把表情写到脸上。inf 里这时是动画刚写的值；
  /// 如果这一帧动画没写（值和我们上一帧写的一样），就用上次记下的动画值，不会越加越多。
  apply(meshes) {
    for (const mesh of meshes) {
      const dict = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
      let memo = this.memo.get(inf);
      if (!memo) {
        const idx = DRIVEN.map((p) => (dict[p] === undefined ? -1 : dict[p]));
        memo = { idx, out: new Float32Array(DRIVEN.length).fill(-1), base: new Float32Array(DRIVEN.length) };
        this.memo.set(inf, memo);
      }
      for (let k = 0; k < DRIVEN.length; k++) {
        const i = memo.idx[k];
        if (i < 0) continue;
        const p = DRIVEN[k];
        const base = inf[i] === memo.out[k] ? memo.base[k] : inf[i];
        const v = FAST.has(p) ? Math.max(base, this.cur[p]) : clamp(base + this.cur[p], 0, 1);
        memo.base[k] = base; memo.out[k] = inf[i] = Math.fround(v);
      }
    }
  }
}
