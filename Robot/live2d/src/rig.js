// 骨骼上的程序动作：辅助骨骼（扭转分担）和视线分配（眼 → 头 → 脖子 → 胸）。
// 只用 three 的数学类，不碰 DOM，可以用 node --test 测。
import { Quaternion, Vector3, Euler } from 'three';

const _q = new Quaternion(), _q2 = new Quaternion(), _qp = new Quaternion(), _qi = new Quaternion(), _v = new Vector3(), _e = new Euler();
const IDENT = new Quaternion();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RAD = Math.PI / 180;

/// swing-twist 分解：取出 q 绕 axis（单位向量）的那部分转动，写进 out
export function twistAbout(q, axis, out) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const l = out.length();
  if (l < 1e-6) return out.identity();   // 正好转了 180° 且全是摆动
  out.x /= l; out.y /= l; out.z /= l; out.w /= l;
  if (out.w < 0) { out.x = -out.x; out.y = -out.y; out.z = -out.z; out.w = -out.w; }   // 取短的那一边
  return out;
}

// ───────── 辅助骨骼 ─────────
// 模型里 ShoulderPart1/2、ElbowPart1/2、HipPart1、KneePart1 没有动画，原作引擎是实时算的。
// 它们排在上臂、前臂、大腿、小腿中间，作用是把下一个关节（肘、腕、膝、踝）的「拧」分摊开，
// 不然手腕一转，前臂的皮肤会像糖纸一样拧在一处。
const DRIVER = { Shoulder: 'Elbow', Elbow: 'Wrist', Hip: 'Knee', Knee: 'Ankle' };

export class TwistHelpers {
  /// byName：名字 → 骨骼。在绑定姿势下创建。
  constructor(byName) {
    this.items = [];
    const groups = {};
    for (const name of Object.keys(byName)) {
      const m = /^(Shoulder|Elbow|Hip|Knee)Part(\d)_([LR])$/.exec(name);
      if (!m) continue;
      const driver = byName[`${DRIVER[m[1]]}_${m[3]}`];
      if (!driver || driver.parent !== byName[name].parent) continue;
      (groups[`${m[1]}_${m[3]}`] ||= { driver, parts: [] }).parts.push({ bone: byName[name], k: Number(m[2]) });
    }
    for (const g of Object.values(groups)) {
      const n = g.parts.length;
      this.items.push({
        driver: g.driver, restInv: g.driver.quaternion.clone().invert(), axis: g.driver.position.clone().normalize(),
        parts: g.parts.map((p) => ({ bone: p.bone, rest: p.bone.quaternion.clone(), f: p.k / (n + 1) })),
      });
    }
  }

  /// 每帧在动画之后调用
  update() {
    for (const it of this.items) {
      _q.copy(it.driver.quaternion).multiply(it.restInv);   // 相对绑定姿势转了多少（在父骨骼的坐标里）
      twistAbout(_q, it.axis, _q2);
      for (const p of it.parts) p.bone.quaternion.copy(IDENT).slerp(_q2, p.f).multiply(p.rest);
    }
  }
}

// ───────── 修正骨骼 ─────────
// 上臂、前臂、手腕、大腿、小腿各带一组修正骨骼（xxxCorrectiveRoot 下面的 …Off / …IN），挂在那一节肢体上。
// 肩头、腋下、臀部、膝盖这些「关节外面的皮肤和衣服」绑在它们上面。原作引擎实时驱动它们，让这些地方不跟着肢体整个转。
// 模型里没有这部分数据，这里做一个近似：修正骨骼的根只跟着肢体转一部分（follow），其余留在上一节的朝向。
// 不驱动的话：手臂从 T 字姿势放下来时，肩头的衣服会跟着手臂整体转上去，挤到脖子两边（第二套衣服最明显）。
export const CORRECTIVE_FOLLOW = { upperarm: 0.1, lowerarm: 0.5, wrist: 0.5, thigh: 0.35, calf: 0.5 };

export class Correctives {
  constructor(byName) {
    this.items = [];
    for (const [name, bone] of Object.entries(byName)) {
      const m = /^(upperarm|lowerarm|wrist|thigh|calf)CorrectiveRoot_[LR]$/.exec(name);
      if (!m || !bone.parent || !bone.parent.isBone) continue;
      const driver = bone.parent;
      this.items.push({ bone, driver, driverRest: driver.quaternion.clone(), rest: bone.quaternion.clone(), follow: CORRECTIVE_FOLLOW[m[1]] });
    }
  }

  /// 每帧在动画之后调用
  update() {
    for (const it of this.items) {
      // 完全不跟着转时的局部转动：driver⁻¹ · driver 的原始转动 · 自己的原始转动
      _q.copy(it.driver.quaternion).invert().multiply(it.driverRest).multiply(it.rest);
      it.bone.quaternion.copy(_q).slerp(it.rest, it.follow);
    }
  }
}

// ───────── 视线分配 ─────────
// 目标角度先由眼睛到位，头、脖子、胸慢慢跟上各自的份额，眼睛再把多转的让回来。
export const GAZE = {
  maxYaw: 38 * RAD, maxPitch: 22 * RAD,          // gaze = ±1 时的总角度
  share: { chest: 0.1, neck: 0.2, head: 0.4 },   // 身体各段最后分到多少，剩下的归眼睛
  speed: { chest: 2.5, neck: 4, head: 5.5, eye: 22 },   // 跟上的快慢（越大越快）
  eyeYaw: 30 * RAD, eyePitch: 20 * RAD,          // 眼球转动的上限
};

/// 在世界坐标里给骨骼叠加一个转动（不依赖骨骼局部轴的朝向）：local' = P⁻¹ · delta · P · local
export function addWorldRotation(bone, yaw, pitch, roll) {
  if (Math.abs(yaw) + Math.abs(pitch) + Math.abs(roll) < 1e-4) return;
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.matrixWorld.decompose(_v, _qp, _v);
  _e.set(pitch, yaw, -roll, 'YXZ');
  _q.setFromEuler(_e);
  bone.quaternion.premultiply(_qp).premultiply(_q).premultiply(_qi.copy(_qp).invert());
}

export class Gaze {
  /// bones：{ chest, neck, head, eyeL, eyeR }，缺哪个都行
  constructor(bones) {
    this.b = bones;
    this.rest = {};
    for (const [k, v] of Object.entries(bones)) if (v) this.rest[k] = v.quaternion.clone();
    this.cur = { chest: [0, 0], neck: [0, 0], head: [0, 0], eye: [0, 0] };
    this.roll = 0; this.nod = 0;
    this.body = [0, 0];   // 头、脖子、胸现在一共转了多少
  }

  /// 动画更新之前调用：把这几根骨骼放回原始姿势。有动画轨道的会被动画重新写上，没有的不会越叠越多。
  resetBones() {
    for (const [k, v] of Object.entries(this.b)) if (v) v.quaternion.copy(this.rest[k]);
  }

  /// x、y：-1～1（x 正 = 屏幕右，y 正 = 向下）。extra：头的额外姿态 { yaw, pitch, roll }（弧度）。
  /// eyeOffset：眼球微跳 [yaw, pitch]（弧度）。weight：播一次性动作时调低，避免和动画打架。
  update(dt, x, y, extra, eyeOffset, weight) {
    const ty = x * GAZE.maxYaw, tp = y * GAZE.maxPitch;
    let by = 0, bp = 0;
    for (const part of ['chest', 'neck', 'head']) {
      const c = this.cur[part], k = Math.min(1, dt * GAZE.speed[part]), s = GAZE.share[part] * weight;
      let wy = ty * s, wp = tp * s;
      if (part === 'head') { wy += extra.yaw * weight; wp += extra.pitch * weight; }
      c[0] += (wy - c[0]) * k; c[1] += (wp - c[1]) * k;
      by += c[0]; bp += c[1];
    }
    const kr = Math.min(1, dt * GAZE.speed.head);
    this.roll += (extra.roll * weight - this.roll) * kr;
    this.body[0] = by; this.body[1] = bp;
    // 眼睛：目标减去身体已经转过去的，所以一开始眼睛转得多，头跟上以后眼睛回正一些
    const e = this.cur.eye, ke = Math.min(1, dt * GAZE.speed.eye);
    const ey = clamp(ty - (by - extra.yaw * weight) + eyeOffset[0], -GAZE.eyeYaw, GAZE.eyeYaw);
    const ep = clamp(tp - (bp - extra.pitch * weight) + eyeOffset[1], -GAZE.eyePitch, GAZE.eyePitch);
    e[0] += (ey - e[0]) * ke; e[1] += (ep - e[1]) * ke;

    const b = this.b;
    if (b.chest) addWorldRotation(b.chest, this.cur.chest[0], this.cur.chest[1], 0);
    if (b.neck) addWorldRotation(b.neck, this.cur.neck[0], this.cur.neck[1], 0);
    if (b.head) addWorldRotation(b.head, this.cur.head[0], this.cur.head[1] + this.nod, this.roll);
    if (b.eyeL) addWorldRotation(b.eyeL, e[0], e[1], 0);
    if (b.eyeR) addWorldRotation(b.eyeR, e[0], e[1], 0);
  }
}
