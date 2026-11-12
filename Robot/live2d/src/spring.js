// 悬挂物物理（弹簧骨骼）：裙子、蝴蝶结、丝带、披风、衣领、耳环。
// 算法和 VRM spring bone 一样：每根骨骼记住「末端」上一步和这一步的世界坐标，
// 受惯性、阻力、回弹（拉回原来的姿势）、重力作用，再把长度拉回骨长，最后把末端方向换算回骨骼的转动。
// 两种骨骼：
//   没有动画的（蝴蝶结、丝带…）：「原来的姿势」是绑定姿势。
//   有动画的裙子（follow）：「原来的姿势」是这一帧动画摆出来的姿势。物理让它带着惯性追动画，
//   身体转、跳、踢腿时裙摆会甩、会滞后，碰到腿会被推开，不再是硬贴着动画走。
// 这个文件只用 three 的数学类，不碰 DOM，可以用 node --test 测。
import { Vector3, Quaternion, Matrix4 } from 'three';

// 手感参数集中在这里，按真机反馈调。stiffness 回弹、drag 阻力（0～1）、gravity 重力，radius 是碰撞半径（米）
export const SPRING_PRESETS = [
  // 注意顺序：从上往下第一个对上的生效。「跟着动画走」的要排在最前面（名字是 follow:骨骼名）
  // 裙子跟着动画走时用这一组：回弹要强一点，不然会离动画的样子太远；重力小一点，动画里已经是垂着的
  // limit：最多偏离动画姿势多少弧度。动画里的裙子是照着不穿模摆的，物理偏多了大腿就会从裙子里露出来，
  // 所以只让每一节在动画姿势附近小幅度晃（约 3.5°，一条链七八节，加起来裙摆末端能晃二十多度）；重力也不加，动画里已经是垂着的。
  [/^follow:/, { stiffness: 5.0, drag: 0.55, gravity: 0, radius: 0.012, limit: 0.06 }],
  [/skirt/i, { stiffness: 1.1, drag: 0.45, gravity: 0.12, radius: 0.02 }],
  [/cape/i, { stiffness: 1.0, drag: 0.45, gravity: 0.1, radius: 0.02 }],
  [/ribbon/i, { stiffness: 2.2, drag: 0.6, gravity: 0.25, radius: 0.012 }],   // 长丝带太软会甩到身前，收紧一些
  [/bow/i, { stiffness: 1.6, drag: 0.4, gravity: 0.05, radius: 0.012 }],
  [/collar|zipper|rose/i, { stiffness: 2.4, drag: 0.5, gravity: 0.02, radius: 0.01 }],
  [/earring|B_joint/i, { stiffness: 0.9, drag: 0.3, gravity: 0.2, radius: 0.008 }],
  [/hair/i, { stiffness: 1.4, drag: 0.4, gravity: 0.06, radius: 0.012 }],
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

const _d = new Vector3(), _perp = new Vector3();
/// 末端偏离原方向超过 max（弧度）就拉回到 max 的位置，并把速度收掉一半（prev 往 cur 靠）
export function limitAngle(cur, prev, center, restDir, len, max) {
  _d.subVectors(cur, center).normalize();
  const cos = _d.dot(restDir);
  if (cos >= Math.cos(max)) return false;
  _perp.copy(_d).addScaledVector(restDir, -cos);
  if (_perp.lengthSq() < 1e-12) { cur.copy(center).addScaledVector(restDir, len); prev.copy(cur); return true; }
  _perp.normalize();
  cur.copy(center).addScaledVector(restDir, len * Math.cos(max)).addScaledVector(_perp, len * Math.sin(max));
  prev.lerp(cur, 0.5);
  return true;
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

/// 跟着动画走、也要加物理的骨骼（名字）
export const FOLLOW = /skirt/i;

/// 找出要加弹簧的骨骼，父在前子在后。
/// bones：全部蒙皮骨骼；isStatic(bone)：这根骨骼在所有动画里都不动。
/// 收两种：「自己和所有子孙都不动」的悬挂物；名字合 follow 的整条链（有没有动画都收，比如裙子）。
export function findSpringBones(bones, isStatic, follow = FOLLOW) {
  const inSkin = new Set(bones);
  const ok = new Map();
  const allStatic = (b) => {
    if (ok.has(b)) return ok.get(b);
    let r = isStatic(b) && !NOT_DANGLING.test(b.name);
    if (r) for (const c of b.children) if (c.isBone && inSkin.has(c) && !allStatic(c)) { r = false; break; }
    ok.set(b, r);
    return r;
  };
  const out = [], taken = new Set();
  const isFollow = (b) => follow && follow.test(b.name) && !NOT_DANGLING.test(b.name);
  const ok2 = (b) => allStatic(b) || isFollow(b);
  const walk = (b) => {
    if (taken.has(b)) return;
    taken.add(b); out.push(b);
    for (const c of b.children) if (c.isBone && inSkin.has(c) && ok2(c)) walk(c);
  };
  for (const b of bones) {
    if (!ok2(b)) continue;
    if (isFollow(b)) {
      const p = b.parent;
      if (p && p.isBone && inSkin.has(p) && ok2(p)) continue;   // 不是链的开头
      walk(b);
      continue;
    }
    const p = b.parent;
    if (p && p.isBone && inSkin.has(p) && allStatic(p)) continue;   // 不是链的开头
    // 挂在修正骨骼、道具下面的不要
    let bad = false;
    for (let a = b.parent; a && a.isBone; a = a.parent) if (NOT_DANGLING.test(a.name) && !/Part\d+_[LR]$/.test(a.name)) { bad = true; break; }
    if (!bad) walk(b);
  }
  return out;
}

const _m = new Matrix4(), _mi = new Matrix4(), _q = new Quaternion(), _qa = new Quaternion();
const _center = new Vector3(), _rest = new Vector3(), _dir = new Vector3(), _next = new Vector3(), _a = new Vector3(), _b = new Vector3();
const ONE = new Vector3(1, 1, 1);

export class SpringSystem {
  /// bones：findSpringBones 的结果。colliders：[{ a: 骨骼, b: 骨骼或 null, offset: Vector3（a 的局部坐标）, radius }]
  /// 调用前要先 updateMatrixWorld，这里按当前（绑定）姿势记下原始转动。
  /// isStatic(bone)：这根骨骼没有动画（不给就当全都没有）。有动画的每帧拿动画的姿势当「原来的姿势」。
  constructor(bones, colliders = [], isStatic = () => true) {
    const set = new Set(bones);
    this.colliders = colliders.map((c) => ({ ...c, pa: new Vector3(), pb: new Vector3() }));
    this.joints = bones.map((bone) => {
      const child = bone.children.find((c) => c.isBone && set.has(c));
      // 末端：有子骨骼就指向它；没有就顺着自己的方向伸出一小段（和 VRM 的做法一样）
      const tail = child ? child.position.clone() : bone.position.clone().normalize().multiplyScalar(0.05);
      if (tail.lengthSq() < 1e-10) tail.set(0, 0.05, 0);
      const followAnim = !isStatic(bone);
      // 裙子整条链都用「跟着动画走」的参数（裙腰那一节没有动画，但它一晃整片裙子都跟着歪）
      const p = followAnim || FOLLOW.test(bone.name) ? presetFor('follow:' + bone.name) : presetFor(bone.name);
      return {
        bone, p, followAnim, restQ: bone.quaternion.clone(), axis: tail.clone().normalize(), localLen: tail.length(),
        cur: new Vector3(), prev: new Vector3(), ignore: null,
      };
    });
    this.fresh = true;
    this.acc = 0;
    this._updateColliders();
    // 原姿势就在碰撞体里面的（比如贴在胸口的蝴蝶结），不和那个碰撞体算碰撞，不然会一直被顶开
    for (const j of this.joints) {
      this._restMatrix(j, j.restQ);
      _rest.copy(j.axis).multiplyScalar(j.localLen).applyMatrix4(_m);
      _center.setFromMatrixPosition(_m);
      j.ignore = this.colliders.map((c) => {
        // 跟着动画走的（裙子）不在这里定，每一帧看动画的姿势再定（见 update）
        if (j.followAnim) return false;
        const margin = c.radius + j.p.radius + 0.01;
        const d1 = (c.b ? closestOnSegment(_rest, c.pa, c.pb, _a) : _a.copy(c.pa)).distanceTo(_rest);
        const d2 = (c.b ? closestOnSegment(_center, c.pa, c.pb, _a) : _a.copy(c.pa)).distanceTo(_center);
        return d1 < margin || d2 < margin;
      });
    }
  }

  // 「原姿势」的世界矩阵：父骨骼现在的世界矩阵 × 自己的原始局部变换
  _restMatrix(j, q) {
    _m.compose(j.bone.position, q, ONE);
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

  /// 每帧调用一次。调用前骨骼的世界矩阵要是最新的（动画、辅助骨骼、视线都算完之后）。
  update(dt) {
    if (dt > 0.25) this.fresh = true;
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    const steps = this.fresh ? 0 : Math.floor(this.acc / STEP + 1e-6);
    this.acc -= steps * STEP;
    this._updateColliders();
    for (const j of this.joints) {
      const bone = j.bone;
      // 有动画的：这一帧动画刚摆好的姿势就是「原来的姿势」（mixer 每帧都会重新写，所以不会被上一帧的物理带偏）
      const restQ = j.followAnim ? _qa.copy(bone.quaternion) : j.restQ;
      this._restMatrix(j, restQ);
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
          // 裙子：动画摆出来的位置本身就在碰撞体里（裙腰贴着身体、裙摆贴着腿），就不和它算碰撞，
          // 不然会被一直往外顶，整条裙子撑开、往上翻。只有物理把裙摆甩进腿里时才推出来。
          // 但如果只是末端插进了腿里、这一节的根还在外面，就照样推出来（不然抬腿时大腿会从裙子里穿出来）
          if (j.followAnim && (c.b ? closestOnSegment(_rest, c.pa, c.pb, _a) : _a.copy(c.pa)).distanceTo(_rest) < r
            && (c.b ? closestOnSegment(_center, c.pa, c.pb, _a) : _a.copy(c.pa)).distanceTo(_center) < r) continue;
          if (c.b ? pushOutCapsule(_next, c.pa, c.pb, r) : pushOutSphere(_next, c.pa, r)) hit = true;
        }
        if (hit) constrainLength(_next, _center, len, _dir);
        j.prev.copy(j.cur); j.cur.copy(_next);
      }
      if (j.p.limit) limitAngle(j.cur, j.prev, _center, _dir, len, j.p.limit);
      // 末端方向 → 骨骼的局部转动
      _mi.copy(_m).invert();
      _b.copy(j.cur).applyMatrix4(_mi).normalize();
      bone.quaternion.copy(restQ).multiply(_q.setFromUnitVectors(j.axis, _b));
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
    }
    this.fresh = false;
  }
}
