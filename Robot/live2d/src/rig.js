// 骨骼上的程序动作：辅助骨骼（扭转分担）和视线分配（眼 → 头 → 脖子 → 胸）。
// 只用 three 的数学类，不碰 DOM，可以用 node --test 测。
import { Quaternion, Vector3, Euler } from 'three';

const _q = new Quaternion(), _q2 = new Quaternion(), _qp = new Quaternion(), _qi = new Quaternion(), _v = new Vector3(), _e = new Euler();
const IDENT = new Quaternion();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RAD = Math.PI / 180;

// ───────── 动画的值和我们叠加的值分开记 ─────────
// 动画系统（AnimationMixer）有个省事的做法：一条轨道这一帧算出来的值和上一帧一样，就不往骨骼上写。
// 我们又要在动画之后往骨骼上叠加转动（视线、高跟鞋、裙子物理）。动画不重新写的那些帧，叠加就会叠在自己上一帧的结果上，
// 越转越多（高跟鞋的脚趾轨道是常数，于是一直在翻）。
// 办法：每根要叠加的骨骼记下「我上一帧写的结果」和「当时动画的值」。动画之后先看一眼：
// 骨骼上还是我写的那个结果，说明动画这一帧没写，就放回记下的动画值；不是，说明动画写了新值，记下来。
export class AnimBase {
  constructor(bones) {
    this.items = [...new Set(bones.filter(Boolean))].map((bone) => ({ bone, out: new Quaternion(NaN, 0, 0, 1), base: bone.quaternion.clone() }));
  }

  /// 动画更新之后、叠加之前调用：骨骼回到动画的值
  restore() {
    for (const it of this.items) {
      const q = it.bone.quaternion, o = it.out;
      if (q.x === o.x && q.y === o.y && q.z === o.z && q.w === o.w) q.copy(it.base); else it.base.copy(q);
    }
  }

  /// 这一帧全部叠加完之后调用：记下结果
  commit() {
    for (const it of this.items) it.out.copy(it.bone.quaternion);
  }
}

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

// ───────── 高跟鞋：让脚踩实 ─────────
// 洋装的靴子是在「平底姿势」的脚下面加了一根高跟：绑定姿势下鞋跟尖着地，前脚掌悬空约 6 厘米。
// 动画又是平底鞋的，直接播就成了鞋跟戳地、脚掌翘在半空，看起来是歪的。
// 真人穿高跟的姿势：脚踝往下压（脚尖朝下），脚趾反向掰回水平。这里就这么做：
//   脚踝绕左右轴转 +θ（脚尖朝下），脚趾转 −θ（保持水平），θ 取「鞋跟尖和前脚掌一样高」的那个角度（按顶点算出来）。
// 转动换算到骨骼自己的坐标里，每帧在动画之后叠加，走路、踢腿时也跟着脚走。
const X_AXIS = new Vector3(1, 0, 0);
export class FootFix {
  /// feet：[{ ankle, toes }]（骨骼）。在绑定姿势、世界矩阵是新的时候创建，然后调 solve(root)
  constructor(feet) {
    this.feet = feet.filter((f) => f.ankle && f.toes).map((f) => ({
      ankle: f.ankle, toes: f.toes,
      aPos: f.ankle.getWorldPosition(new Vector3()), tPos: f.toes.getWorldPosition(new Vector3()),
      aW: f.ankle.getWorldQuaternion(new Quaternion()), tW: f.toes.getWorldQuaternion(new Quaternion()),
      qa: new Quaternion(), qt: new Quaternion(),
    }));
    this.deg = 0; this.sole = 0;
  }

  /// 按顶点算出角度和踩实以后鞋底的高度。forceDeg：不算，直接用这个角度（调试）
  solve(root, forceDeg) {
    // 收集每只脚上「主要跟脚踝」和「主要跟脚趾」的顶点
    const pts = this.feet.map(() => ({ a: [], t: [] }));
    const v = new Vector3();
    root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const P = o.geometry.attributes.position, SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight, bones = o.skeleton.bones;
      for (let i = 0; i < P.count; i++) {
        for (let c = 0; c < 4; c++) {
          const w = SW.getComponent(i, c);
          if (w < 0.6) continue;
          const b = bones[SI.getComponent(i, c)];
          const k = this.feet.findIndex((f) => f.ankle === b || f.toes === b);
          if (k >= 0) (this.feet[k].ankle === b ? pts[k].a : pts[k].t).push(v.fromBufferAttribute(P, i).clone());
        }
      }
    });
    // 转 θ 以后：脚踝上的点绕脚踝转；脚趾上的点先反转再跟着转，合起来只是跟着脚趾关节平移
    const lows = (k, rad) => {
      const f = this.feet[k], c = Math.cos(rad), s = Math.sin(rad);
      const rotY = (p) => f.aPos.y + (p.y - f.aPos.y) * c - (p.z - f.aPos.z) * s;
      let la = Infinity, lt = Infinity;
      for (const p of pts[k].a) la = Math.min(la, rotY(p));
      const shift = rotY(f.tPos) - f.tPos.y;
      for (const p of pts[k].t) lt = Math.min(lt, p.y + shift);
      return [la, lt];
    };
    let best = 0, bestErr = Infinity;
    if (Number.isFinite(forceDeg)) best = forceDeg;
    else if (pts.every((p) => p.a.length && p.t.length)) {
      for (let d = 0; d <= 50; d += 0.5) {
        let err = 0;
        for (let k = 0; k < this.feet.length; k++) { const [la, lt] = lows(k, d * Math.PI / 180); err += Math.abs(la - lt); }
        if (err < bestErr - 1e-6) { bestErr = err; best = d; }
      }
    }
    this.deg = best;
    const rad = best * Math.PI / 180;
    let sole = Infinity;
    for (let k = 0; k < this.feet.length; k++) { const [la, lt] = lows(k, rad); sole = Math.min(sole, la, lt); }
    this.sole = Number.isFinite(sole) ? sole : 0;
    const rx = new Quaternion().setFromAxisAngle(X_AXIS, rad), rxInv = rx.clone().invert();
    for (const f of this.feet) {
      f.qa.copy(f.aW).invert().multiply(rx).multiply(f.aW);
      f.qt.copy(f.tW).invert().multiply(rxInv).multiply(f.tW);
    }
    return this;
  }

  /// 每帧在动画之后调用。脚踝、脚趾要先由 AnimBase 放回动画的值（见 bones），不然会越转越多
  get bones() { return this.feet.flatMap((f) => [f.ankle, f.toes]); }

  update() {
    if (!this.deg) return;
    for (const f of this.feet) { f.ankle.quaternion.multiply(f.qa); f.toes.quaternion.multiply(f.qt); }
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

  /// 要叠加转动的骨骼（交给 AnimBase 管，保证每帧从动画的值开始叠）
  get bones() { return Object.values(this.b).filter(Boolean); }

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
