// 活气：让她闲着的时候也像活人。动画只给了很慢的身体晃动，脸上没有表情，眼睛一直盯着镜头。
// 这里在动画上面再叠一层自己算的小动作：
//   呼吸      胸口和肩膀一起一伏，吸气快、呼气慢，说话时浅而快
//   眼神      大部分时间看着屏幕前的人，隔几秒看向别处一下（有时只是眼睛瞟一眼，有时头也跟过去），再看回来
//   头        一直有很轻的晃动；偶尔歪一下头
//   上身      很慢的左右转和侧倾（重心在两只脚之间来回换的感觉）
//   微表情    嘴角一直带一点笑，深浅在变；隔几秒来一个小表情（笑一下、挑眉、抿嘴、单边嘴角）
// 这个文件只算数，不碰骨骼和 DOM；结果由 main.js 交给视线、表情和 applyLife() 去用。可以用 node --test 测。
import { Quaternion, Euler, Vector3 } from 'three';

const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

// 手感参数，按真机反馈调。角度都是度，时间都是秒
export const LIFE = {
  breath: { period: [3.4, 4.6], inhale: 0.4, chest: 1.3, spine: 0.6, shoulder: 1.1, head: 0.5, talkRate: 1.5, talkDepth: 0.6 },
  glance: { stay: [2.5, 7], away: [0.6, 2.2], big: 0.35, x: [0.2, 0.75], y: [-0.2, 0.4] },   // big：头也跟过去的那种占多少
  head: { yaw: 2.4, pitch: 1.6, roll: 1.8, tiltEvery: [7, 18], tilt: [4, 8], tiltHold: [1.5, 4] },
  sway: { yaw: 1.6, roll: 1.1 },
  smile: { base: 0.14, wave: 0.08 },
  expr: { every: [4, 10] },
};

// 小表情：[名字, 相对出现的多少, 持续多久, 表情形变（0～1）, 头的额外姿态（度）]
export const EXPRESSIONS = [
  ['smile', 5, [1.6, 3.2], { mouthSmileLeft: 0.6, mouthSmileRight: 0.6, cheekSquintLeft: 0.35, cheekSquintRight: 0.35, eyeSquintLeft: 0.25, eyeSquintRight: 0.25 }, { pitch: 1.5 }],
  ['brow', 3, [0.5, 1.0], { browInnerUp: 0.45, browOuterUpLeft: 0.3, browOuterUpRight: 0.3, eyeWideLeft: 0.12, eyeWideRight: 0.12 }, { pitch: -1.5 }],
  ['smirk', 2, [1.2, 2.4], { mouthSmileLeft: 0.55, mouthSmileRight: 0.15, cheekSquintLeft: 0.25, mouthLeft: 0.15, browOuterUpLeft: 0.2 }, { roll: 3 }],
  ['press', 2, [0.8, 1.6], { mouthPressLeft: 0.4, mouthPressRight: 0.4, mouthSmileLeft: 0.2, mouthSmileRight: 0.2 }, {}],
  ['soft', 2, [2.0, 3.5], { mouthSmileLeft: 0.35, mouthSmileRight: 0.35, eyeSquintLeft: 0.35, eyeSquintRight: 0.35, browInnerUp: 0.15 }, { roll: -2.5, pitch: 1 }],
];

export class Life {
  /// rand：随机数（测试时可以换成固定的）
  constructor(rand = Math.random) {
    this.rand = rand;
    this.rnd = (r) => r[0] + rand() * (r[1] - r[0]);
    this.phase = rand();                       // 呼吸走到一个周期的哪里（0～1）
    this.period = this.rnd(LIFE.breath.period);
    this.seed = [rand() * 100, rand() * 100, rand() * 100, rand() * 100, rand() * 100, rand() * 100];
    this.gaze = { x: 0, y: 0, until: -1, next: -1, big: false };
    this.tilt = { v: 0, cur: 0, until: -1, next: -1 };
    this.expr = { shapes: {}, head: {}, start: 0, end: -1, next: -1, name: '' };
    this.w = 0;                                // 整体的权重：播大动作时收小
    this.out = {
      breath: 0,                               // -1 呼到底 … +1 吸满
      gx: 0, gy: 0, glance: false, big: false, // 眼神往哪看（-1～1），是不是正看着别处
      head: { yaw: 0, pitch: 0, roll: 0 },     // 头的额外姿态（弧度）
      sway: { yaw: 0, roll: 0 },               // 上身（弧度）
      shapes: {},                              // 表情形变
      expr: '',
    };
  }

  /// 有人碰她、跟她说话：马上看回来
  attend(t) { this.gaze.until = -1; this.gaze.next = t + this.rnd(LIFE.glance.stay); this.out.gx = this.out.gy = 0; }

  /// 每帧调用。s：{ idle 闲着, speaking 在说话, busy 正在播一次性动作, lookFree 视线没被别的东西占着 }
  update(t, dt, s) {
    const o = this.out, L = LIFE;
    this.w += ((s.busy ? 0.35 : 1) - this.w) * Math.min(1, dt * 3);
    const w = this.w;

    // ── 呼吸：吸气占周期的 inhale，用平滑曲线，呼气慢慢放
    const rate = s.speaking ? L.breath.talkRate : 1;
    this.phase += dt * rate / this.period;
    if (this.phase >= 1) { this.phase -= Math.floor(this.phase); this.period = this.rnd(L.breath.period); }
    const p = this.phase, k = L.breath.inhale;
    const lung = p < k ? smooth(p / k) : 1 - smooth((p - k) / (1 - k));
    o.breath = (lung * 2 - 1) * (s.speaking ? L.breath.talkDepth : 1);

    // ── 眼神：只在闲着、视线没被占着的时候自己到处看
    const g = this.gaze;
    if (g.next < 0) g.next = t + this.rnd(L.glance.stay);
    if (!s.idle || !s.lookFree || s.busy) { g.until = -1; g.next = Math.max(g.next, t + 1.5); }
    else if (g.until < 0 && t > g.next) {
      const side = this.rand() < 0.5 ? -1 : 1;
      g.big = this.rand() < L.glance.big;
      g.x = side * this.rnd(L.glance.x) * (g.big ? 1 : 0.55);
      g.y = this.rnd(L.glance.y) * (g.big ? 1 : 0.6);
      g.until = t + this.rnd(L.glance.away);
    } else if (g.until >= 0 && t > g.until) { g.until = -1; g.next = t + this.rnd(L.glance.stay); }
    o.glance = g.until >= 0; o.big = o.glance && g.big;
    o.gx = o.glance ? g.x : 0; o.gy = o.glance ? g.y : 0;

    // ── 头：几个周期不一样的正弦叠起来，看不出重复；偶尔歪一下
    const n = (i, f) => Math.sin(t * f + this.seed[i]);
    const T = this.tilt;
    if (T.next < 0) T.next = t + this.rnd(L.head.tiltEvery);
    if (T.until < 0 && t > T.next && s.idle) { T.v = (this.rand() < 0.5 ? -1 : 1) * this.rnd(L.head.tilt); T.until = t + this.rnd(L.head.tiltHold); }
    else if (T.until >= 0 && t > T.until) { T.until = -1; T.v = 0; T.next = t + this.rnd(L.head.tiltEvery); }
    T.cur += (T.v - T.cur) * Math.min(1, dt * 2.5);

    // ── 小表情：到点挑一个，淡入、保持、淡出
    const E = this.expr;
    if (E.next < 0) E.next = t + this.rnd(L.expr.every) * 0.5;
    if (E.end < 0 && t > E.next && !s.busy) {
      let total = 0; for (const e of EXPRESSIONS) total += e[1];
      let pick = this.rand() * total, chosen = EXPRESSIONS[0];
      for (const e of EXPRESSIONS) { pick -= e[1]; if (pick <= 0) { chosen = e; break; } }
      E.name = chosen[0]; E.shapes = chosen[3]; E.head = chosen[4]; E.start = t; E.end = t + this.rnd(chosen[2]);
    } else if (E.end >= 0 && t > E.end + 0.6) { E.end = -1; E.next = t + this.rnd(L.expr.every); }
    let ek = 0;
    if (E.end >= 0) ek = Math.min(smooth((t - E.start) / 0.35), 1 - smooth((t - E.end) / 0.6));
    o.expr = ek > 0.05 ? E.name : '';

    const head = o.head, eh = E.head || {};
    head.yaw = (L.head.yaw * (0.6 * n(0, 0.47) + 0.4 * n(1, 1.13)) + (eh.yaw || 0) * ek) * RAD * w;
    head.pitch = (L.head.pitch * (0.6 * n(2, 0.39) + 0.4 * n(3, 0.97)) + (eh.pitch || 0) * ek + L.breath.head * o.breath) * RAD * w;
    head.roll = (L.head.roll * (0.7 * n(4, 0.31) + 0.3 * n(5, 0.83)) + T.cur + (eh.roll || 0) * ek) * RAD * w;

    // ── 上身：很慢的转和倾
    o.sway.yaw = L.sway.yaw * (0.7 * n(1, 0.23) + 0.3 * n(4, 0.61)) * RAD * w;
    o.sway.roll = L.sway.roll * (0.7 * n(3, 0.19) + 0.3 * n(0, 0.53)) * RAD * w;

    // ── 表情：嘴角的底色 + 小表情
    const sh = o.shapes;
    for (const key of Object.keys(sh)) sh[key] = 0;
    const base = (L.smile.base + L.smile.wave * n(2, 0.27)) * w;
    sh.mouthSmileLeft = base; sh.mouthSmileRight = base;
    for (const [key, v] of Object.entries(E.shapes)) sh[key] = (sh[key] || 0) + v * ek * w;
    return o;
  }
}

const _q = new Quaternion(), _qp = new Quaternion(), _qi = new Quaternion(), _qr = new Quaternion(), _e = new Euler(), _v = new Vector3(), _s = new Vector3();

/// 在「角色自己的坐标」里给骨骼叠加一个转动（角色整个转了身也不会歪）：x 轴是她的左右，y 竖直，z 是她的正前方。
/// rootQ：角色根节点的世界转动。rx 正 = 往前低，ry 正 = 转向她的左边，rz 正 = 她的左边抬高
export function addBodyRotation(bone, rootQ, rx, ry, rz) {
  if (Math.abs(rx) + Math.abs(ry) + Math.abs(rz) < 1e-5) return;
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.matrixWorld.decompose(_v, _qp, _s);
  _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ'));
  _q.premultiply(rootQ).multiply(_qr.copy(rootQ).invert());         // 换到世界坐标
  bone.quaternion.premultiply(_qp).premultiply(_q).premultiply(_qi.copy(_qp).invert());
}

/// 把呼吸和上身的晃动写到骨骼上。b：{ waist, spine, chest, head, scapL, scapR }（缺哪个都行），life：Life.update 的结果
/// 要在动画之后、视线之前调用；这些骨骼要交给 AnimBase 管。
export function applyLife(b, rootQ, life) {
  const B = LIFE.breath, br = life.breath * 0.5 + 0.5;   // 0 呼到底 … 1 吸满
  const sw = life.sway;
  if (b.waist) addBodyRotation(b.waist, rootQ, 0, sw.yaw * 0.5, sw.roll * 0.6);
  if (b.spine) addBodyRotation(b.spine, rootQ, -B.spine * RAD * br, sw.yaw * 0.5, sw.roll * 0.4);
  if (b.chest) addBodyRotation(b.chest, rootQ, -B.chest * RAD * br, 0, 0);
  // 胸口往后仰了，头往回低一点，视线才不会跟着呼吸上下飘
  if (b.head) addBodyRotation(b.head, rootQ, (B.spine + B.chest) * RAD * br * 0.8, 0, -sw.roll * 0.5);
  // 肩膀：吸气时两边一起抬（左肩在她的 +x 一侧，绕前后轴正转是抬高；右肩反过来）
  const up = B.shoulder * RAD * br;
  if (b.scapL) addBodyRotation(b.scapL, rootQ, 0, 0, up);
  if (b.scapR) addBodyRotation(b.scapR, rootQ, 0, 0, -up);
}
