// 悬挂物物理（弹簧骨骼）：蝴蝶结、丝带、披风、衣领、耳环，以及裙子上没有烘焙动画的那几段。
// 算法和 VRM spring bone 一样：每根骨骼记住「末端」上一步和这一步的世界坐标，
// 受惯性、阻力、回弹（拉回原来的姿势）、重力作用，再把长度拉回骨长，最后把末端方向换算回骨骼的转动。
// 大部分裙子的飘动已经烘焙在动画里，那些骨骼不在这里处理。
// 头发的飘动也烘焙在动画里，但烘焙的头发不知道我们后加的东西（视线带动的转头、换动作时的过渡、云台转身），
// 也不会被肩膀挡住。所以头发是「跟随式」的：每帧把动画给的姿势当成原姿势，弹簧在它上面加惯性和碰撞，
// 越靠发梢跟得越松（follow → followTip）。动画里的造型还在，只是多了真实的滞后和甩动。
// 这个文件只用 three 的数学类，不碰 DOM，可以用 node --test 测。
import { Vector3, Quaternion, Matrix4 } from 'three';

// 手感参数集中在这里，按真机反馈调。stiffness 回弹、drag 阻力（0～1）、gravity 重力，radius 是碰撞半径（米）
export const SPRING_PRESETS = [
  [/skirt/i, { stiffness: 1.1, drag: 0.45, gravity: 0.12, radius: 0.02 }],
  [/cape/i, { stiffness: 1.0, drag: 0.45, gravity: 0.1, radius: 0.02 }],
  [/ribbon/i, { stiffness: 0.7, drag: 0.35, gravity: 0.15, radius: 0.012 }],
  [/bow/i, { stiffness: 1.6, drag: 0.4, gravity: 0.05, radius: 0.012 }],
  [/collar|zipper|rose/i, { stiffness: 2.4, drag: 0.5, gravity: 0.02, radius: 0.01 }],
  [/earring|B_joint/i, { stiffness: 0.9, drag: 0.3, gravity: 0.2, radius: 0.008 }],
  // 下面两项只对有动画的骨骼（头发）起作用，都是「发根的值 → 发梢的值」，中间按位置过渡：
  // follow / followTip：每一步往动画姿势靠多少（0～1）；cone / coneTip：最多偏离动画姿势多少度（防止发束折起来）
  [/bang/i, { stiffness: 1.2, drag: 0.4, gravity: 0.03, radius: 0.008, follow: 0.5, followTip: 0.22, cone: 6, coneTip: 14 }],
  [/hair/i, { stiffness: 0.8, drag: 0.32, gravity: 0.05, radius: 0.01, follow: 0.4, followTip: 0.07, cone: 8, coneTip: 28 }],
  [/./, { stiffness: 1.4, drag: 0.4, gravity: 0.06, radius: 0.012 }],
];
export const STEP = 1 / 60;      // 固定步长
export const MAX_STEPS = 2;      // 每帧最多补几步

// 修正骨骼、扭转骨骼、道具：虽然没有动画，但不是悬挂物，不能加弹簧
const NOT_DANGLING = /Corrective|(Off|IN)_[LR]$|Part\d+_[LR]$|ForPhysics|^np_joint|^root_Newspaper$|^Joystick|^Cellphone$|^Gamepad|^Popcorn|^phone|^Newspaper|^Props$/;

export function presetFor(name) {
  for (const [re, p] of SPRING_PRESETS) if (re.test(name)) return p;
  return SPRING_PRESETS[SPRING_PRESETS.length - 1][1];
}

/// 一步积分。cur、prev 是末端的世界坐标，restDir 是原姿势的方向（单位向量），center 是骨骼根部，len 是骨长。
/// 结果写进 out，返回 out。
export function verletStep(cur, prev, restDir, center, len, p, dt, out) {
  const k = 1 - p.drag;
  out.set(
    cur.x + (cur.x - prev.x) * k + restDir.x * p.stiffness * dt,
    cur.y + (cur.y - prev.y) * k + restDir.y * p.stiffness * dt - p.gravity * dt,
    cur.z + (cur.z - prev.z) * k + restDir.z * p.stiffness * dt,
  );
  return constrainLength(out, center, len, restDir);
}

/// 把 p 拉回到离 center 正好 len 的地方
export function constrainLength(p, center, len, fallbackDir) {
  const dx = p.x - center.x, dy = p.y - center.y, dz = p.z - center.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-8) return p.copy(center).addScaledVector(fallbackDir, len);
  const s = len / d;
  return p.set(center.x + dx * s, center.y + dy * s, center.z + dz * s);
}

/// 点在球里就推到球面上。返回有没有推
export function pushOutSphere(p, c, r) {
  const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r || d2 < 1e-12) return false;
  const s = r / Math.sqrt(d2);
  p.set(c.x + dx * s, c.y + dy * s, c.z + dz * s);
  return true;
}

const _c = new Vector3();
/// 线段 a–b 上离 p 最近的点
export function closestOnSegment(p, a, b, out) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 < 1e-12 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2;
  t = Math.min(1, Math.max(0, t));
  return out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}
/// 点在胶囊（线段 a–b，半径 r）里就推出去
export function pushOutCapsule(p, a, b, r) {
  return pushOutSphere(p, closestOnSegment(p, a, b, _c), r);
}

/// 找出要加弹簧的骨骼，父在前子在后。
/// bones：全部蒙皮骨骼；isStatic(bone)：这根骨骼在所有动画里都不动。
/// 只收「自己和所有子孙都不动」的骨骼，这样被动画驱动的头发、裙子不会被碰。
export function findSpringBones(bones, isStatic) {
  const inSkin = new Set(bones);
  const ok = new Map();
  const allStatic = (b) => {
    if (ok.has(b)) return ok.get(b);
    let r = isStatic(b) && !NOT_DANGLING.test(b.name);
    if (r) for (const c of b.children) if (c.isBone && inSkin.has(c) && !allStatic(c)) { r = false; break; }
    ok.set(b, r);
    return r;
  };
  const out = [];
  const walk = (b) => {
    out.push(b);
    for (const c of b.children) if (c.isBone && inSkin.has(c) && allStatic(c)) walk(c);
  };
  for (const b of bones) {
    if (!allStatic(b)) continue;
    const p = b.parent;
    if (p && p.isBone && inSkin.has(p) && allStatic(p)) continue;   // 不是链的开头
    // 挂在修正骨骼、道具下面的不要
    let bad = false;
    for (let a = b.parent; a && a.isBone; a = a.parent) if (NOT_DANGLING.test(a.name) && !/Part\d+_[LR]$/.test(a.name)) { bad = true; break; }
    if (!bad) walk(b);
  }
  return out;
}

const _m = new Matrix4(), _mi = new Matrix4(), _q = new Quaternion();
const _center = new Vector3(), _rest = new Vector3(), _dir = new Vector3(), _next = new Vector3(), _a = new Vector3(), _b = new Vector3();
const ONE = new Vector3(1, 1, 1);

export class SpringSystem {
  /// bones：要加弹簧的骨骼，父在前子在后。colliders：[{ a: 骨骼, b: 骨骼或 null, offset: Vector3（a 的局部坐标）, radius }]
  /// animated：其中有动画的骨骼（头发）。它们的原姿势不是绑定姿势，而是每帧动画给的姿势。
  /// 调用前要先 updateMatrixWorld，这里按当前（绑定）姿势记下原始转动。
  constructor(bones, colliders = [], animated = null) {
    const set = new Set(bones);
    this.colliders = colliders.map((c) => ({ ...c, pa: new Vector3(), pb: new Vector3() }));
    this.joints = bones.map((bone) => {
      const child = bone.children.find((c) => c.isBone && set.has(c));
      // 末端：有子骨骼就指向它；没有就顺着自己的方向伸出一小段（和 VRM 的做法一样）
      const tail = child ? child.position.clone() : bone.position.clone().normalize().multiplyScalar(0.05);
      if (tail.lengthSq() < 1e-10) tail.set(0, 0.05, 0);
      const p = presetFor(bone.name);
      return {
        bone, p, restQ: bone.quaternion.clone(), axis: tail.clone().normalize(), localLen: tail.length(),
        cur: new Vector3(), prev: new Vector3(), ignore: null,
        anim: !!(animated && animated.has(bone)), follow: 0, cosCone: -1, sinCone: 0,
      };
    });
    // 跟随的松紧：按骨骼在这条链上的位置，从根（follow）过渡到梢（followTip）
    const byBone = new Map(this.joints.map((j) => [j.bone, j]));
    for (const j of this.joints) {
      if (!j.anim) continue;
      let up = 0, down = 0;
      for (let b = j.bone.parent; byBone.has(b) && byBone.get(b).anim; b = b.parent) up++;
      for (let b = j.bone; ;) { const c = b.children.find((x) => byBone.has(x)); if (!c) break; down++; b = c; }
      const t = up + down > 0 ? up / (up + down) : 1;
      const a = j.p.follow === undefined ? 0.4 : j.p.follow, z = j.p.followTip === undefined ? a : j.p.followTip;
      j.follow = a + (z - a) * t;
      const c0 = j.p.cone === undefined ? 180 : j.p.cone, c1 = j.p.coneTip === undefined ? c0 : j.p.coneTip;
      const cone = (c0 + (c1 - c0) * t) * Math.PI / 180;
      j.cosCone = Math.cos(cone); j.sinCone = Math.sin(cone);
    }
    this.hasAnim = this.joints.some((j) => j.anim);
    this.fresh = true;
    this.acc = 0;
    this._updateColliders();
    // 原姿势就在碰撞体里面的（比如贴在胸口的蝴蝶结），不和那个碰撞体算碰撞，不然会一直被顶开
    for (const j of this.joints) {
      this._restMatrix(j);
      _rest.copy(j.axis).multiplyScalar(j.localLen).applyMatrix4(_m);
      _center.setFromMatrixPosition(_m);
      j.ignore = this.colliders.map((c) => {
        const margin = c.radius + j.p.radius + 0.01;
        const d1 = (c.b ? closestOnSegment(_rest, c.pa, c.pb, _a) : _a.copy(c.pa)).distanceTo(_rest);
        const d2 = (c.b ? closestOnSegment(_center, c.pa, c.pb, _a) : _a.copy(c.pa)).distanceTo(_center);
        return d1 < margin || d2 < margin;
      });
    }
  }

  // 「原姿势」的世界矩阵：父骨骼现在的世界矩阵 × 自己的原始局部变换
  _restMatrix(j) {
    _m.compose(j.bone.position, j.restQ, ONE);
    return _m.premultiply(j.bone.parent.matrixWorld);
  }

  _updateColliders() {
    for (const c of this.colliders) {
      c.pa.copy(c.offset || _a.set(0, 0, 0)).applyMatrix4(c.a.matrixWorld);
      if (c.b) c.pb.setFromMatrixPosition(c.b.matrixWorld);
    }
  }

  /// 换装、切回前台、长时间没画之后调用：下一帧从原姿势重新开始，避免炸开
  reset() { this.fresh = true; this.acc = 0; }

  /// 动画更新之前调用：把有动画的骨骼放回上一帧动画给的姿势。
  /// 动画系统发现数值和上一帧一样时不会重写骨骼，不放回去的话，弹簧的结果会被当成下一帧的原姿势，越叠越歪。
  restore() {
    if (!this.hasAnim) return;
    for (const j of this.joints) if (j.anim) j.bone.quaternion.copy(j.restQ);
  }

  /// 每帧调用一次。调用前骨骼的世界矩阵要是最新的（动画、辅助骨骼、视线都算完之后）。
  update(dt) {
    if (dt > 0.25) this.fresh = true;
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    const steps = this.fresh ? 0 : Math.floor(this.acc / STEP + 1e-6);
    this.acc -= steps * STEP;
    this._updateColliders();
    for (const j of this.joints) {
      const bone = j.bone;
      if (j.anim) j.restQ.copy(bone.quaternion);   // 这一帧动画给的姿势
      this._restMatrix(j);
      _center.setFromMatrixPosition(_m);
      _rest.copy(j.axis).multiplyScalar(j.localLen).applyMatrix4(_m);
      const len = _rest.distanceTo(_center);
      _dir.subVectors(_rest, _center).divideScalar(len || 1);
      if (this.fresh || j.cur.distanceToSquared(_rest) > 0.25) { j.cur.copy(_rest); j.prev.copy(_rest); }
      for (let s = 0; s < steps; s++) {
        verletStep(j.cur, j.prev, _dir, _center, len, j.p, STEP, _next);
        let hit = false;
        for (let i = 0; i < this.colliders.length; i++) {
          if (j.ignore[i]) continue;
          const c = this.colliders[i], r = c.radius + j.p.radius;
          if (c.b ? pushOutCapsule(_next, c.pa, c.pb, r) : pushOutSphere(_next, c.pa, r)) hit = true;
        }
        if (j.follow > 0) {
          // 往动画姿势靠（先靠再算碰撞，被肩膀挡住的地方以碰撞为准）
          _next.lerp(_rest, j.follow);
          for (let i = 0; i < this.colliders.length; i++) {
            if (j.ignore[i]) continue;
            const c = this.colliders[i], r = c.radius + j.p.radius;
            if (c.b ? pushOutCapsule(_next, c.pa, c.pb, r) : pushOutSphere(_next, c.pa, r)) hit = true;
          }
          hit = true;
        }
        if (hit) constrainLength(_next, _center, len, _dir);
        j.prev.copy(j.cur); j.cur.copy(_next);
      }
      // 末端方向 → 骨骼的局部转动
      _mi.copy(_m).invert();
      _b.copy(j.cur).applyMatrix4(_mi).normalize();
      if (j.anim && _b.dot(j.axis) < j.cosCone) {
        // 偏出圆锥了：拉回圆锥边上，并把末端的位置也改过去，免得越攒越多
        _a.copy(_b).addScaledVector(j.axis, -_b.dot(j.axis));
        if (_a.lengthSq() < 1e-12) _a.set(j.axis.y, j.axis.z, j.axis.x).addScaledVector(j.axis, -(j.axis.x * j.axis.y + j.axis.y * j.axis.z + j.axis.z * j.axis.x));
        _b.copy(j.axis).multiplyScalar(j.cosCone).addScaledVector(_a.normalize(), j.sinCone);
        _next.copy(_b).multiplyScalar(j.localLen).applyMatrix4(_m);
        j.prev.add(_next).sub(j.cur); j.cur.copy(_next);   // 速度不变，只挪位置
      }
      bone.quaternion.copy(j.restQ).multiply(_q.setFromUnitVectors(j.axis, _b));
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
    }
    this.fresh = false;
  }
}
