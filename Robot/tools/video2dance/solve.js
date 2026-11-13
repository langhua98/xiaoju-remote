// 在页面里跑：把 MediaPipe 的 33 个关键点套到 Yuki 的骨骼上，输出每帧每根骨骼的局部转动和腰的位置。
// 输入 window.__POSE = { fps, frames: [{ w: [[x,y,z,vis]×33], n: [[x,y,z]×33] }] }
(() => {
  const P = window.__POSE, a = YunlaiFace._avatar(), T = a.head.position.constructor;
  const V = (x, y, z) => new T(x, y, z);
  const Q = a.head.quaternion.constructor, M4 = a.head.matrixWorld.constructor;
  const B = a.byName;
  // ── 准备：角色放回原点、绑定姿势
  a.mixer.stopAllAction();
  a.root.position.set(0, 0, 0); a.root.rotation.set(0, 0, 0); a.root.updateMatrixWorld(true);
  let skel = null; a.root.traverse((o) => { if (o.isSkinnedMesh && !skel) skel = o.skeleton; });
  skel.pose(); a.root.updateMatrixWorld(true);
  const rest = {}; for (const b of skel.bones) rest[b.name] = b.quaternion.clone();
  const restPos = {}; for (const b of skel.bones) restPos[b.name] = b.position.clone();
  const wq = (n) => B[n].getWorldQuaternion(new Q());
  const wp = (n) => B[n].getWorldPosition(new T());
  const bindWQ = {}, bindWP = {};
  for (const n of Object.keys(B)) { bindWQ[n] = wq(n); bindWP[n] = wp(n); }

  // ── 关键点：MediaPipe（x 右、y 下、z 离镜头）→ 我们（x 她的左、y 上、z 朝镜头）；时间上平滑一下
  const N = P.frames.length;
  const raw = P.frames.map((f) => f.w.map((p) => V(p[0], -p[1], -p[2])));
  const L = raw.map((_, i) => raw[i].map((_, k) => {
    const acc = V(0, 0, 0); let wsum = 0;
    for (let d = -2; d <= 2; d++) { const j = Math.min(N - 1, Math.max(0, i + d)), w = [1, 2, 3, 2, 1][d + 2]; acc.addScaledVector(raw[j][k], w); wsum += w; }
    return acc.divideScalar(wsum);
  }));
  const mid = (p, q) => p.clone().add(q).multiplyScalar(0.5);

  // 用两根轴（x 轴、y 轴的大致方向）搭一个转动
  const basis = (x, yHint) => {
    const X = x.clone().normalize(), Z = X.clone().cross(yHint).normalize(), Y = Z.clone().cross(X).normalize();
    return new Q().setFromRotationMatrix(new M4().makeBasis(X, Y, Z));
  };
  // 骨骼 b 指向 dir（世界）：在父骨骼现在的朝向上，用最小的转动把骨骼从原来的方向转到 dir
  const aim = (name, childName, dir, out) => {
    const b = B[name];
    b.quaternion.copy(rest[name]); b.updateMatrixWorld(true);
    const cur = wp(childName).sub(wp(name)).normalize();
    const d = new Q().setFromUnitVectors(cur, dir.clone().normalize());
    const wNow = wq(name), target = d.multiply(wNow);
    const parentW = b.parent.getWorldQuaternion(new Q());
    b.quaternion.copy(parentW.invert().multiply(target)); b.updateMatrixWorld(true);
    out[name] = b.quaternion.clone();
  };
  // 骨骼 b 的世界转动 = R × 绑定时的世界转动
  const setWorld = (name, R, out) => {
    const b = B[name];
    const target = R.clone().multiply(bindWQ[name]);
    const parentW = b.parent.getWorldQuaternion(new Q());
    b.quaternion.copy(parentW.invert().multiply(target)); b.updateMatrixWorld(true);
    out[name] = b.quaternion.clone();
  };

  // 第 0 帧当成「站直、看前面」，算出头部关键点和真实头部朝向之间的固定偏差，后面每帧扣掉
  const hipsR = (l) => basis(l[23].clone().sub(l[24]), mid(l[11], l[12]).sub(mid(l[23], l[24])));
  const chestR = (l) => basis(l[11].clone().sub(l[12]), mid(l[11], l[12]).sub(mid(l[23], l[24])));
  const headR = (l) => {
    const ears = mid(l[7], l[8]), fwd = l[0].clone().sub(ears);
    const X = l[7].clone().sub(l[8]).normalize();
    const up = fwd.clone().cross(X).negate();   // 朝前 × 朝左 = 朝下，取反朝上
    return basis(X, up);
  };
  const cal = {
    hips: hipsR(L[0]).invert(), chest: chestR(L[0]).invert(),
    headRel: chestR(L[0]).invert().multiply(headR(L[0])).invert(),
  };
  // 第 0 帧的朝向扣掉以后只留「左右转了多少」的部分在 hips 上（不想把第 0 帧的 10° 歪也扣掉太多）
  const keep = { hips: hipsR(L[0]), chest: chestR(L[0]) };
  const yawOnly = (q) => { const f = V(0, 0, 1).applyQuaternion(q); return new Q().setFromAxisAngle(V(0, 1, 0), Math.atan2(f.x, f.z)); };
  const y0 = yawOnly(keep.hips);

  const hinge = {};
  for (const side of ['L', 'R']) {
    const name = 'Elbow_' + side; let best = null, bestA = 0;
    for (const c of Object.values(a.clips)) for (const t of c.tracks) {
      if (t.name !== name + '.quaternion') continue;
      for (let i = 0; i < t.values.length; i += 4) {
        const dq = rest[name].clone().invert().multiply(new Q(t.values[i], t.values[i + 1], t.values[i + 2], t.values[i + 3])).normalize();
        if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
        const ang = 2 * Math.acos(Math.min(1, dq.w));
        if (ang > bestA) { bestA = ang; best = V(dq.x, dq.y, dq.z).normalize(); }
      }
    }
    hinge[side] = best;
  }
  window.__HINGE = { L: hinge.L && hinge.L.toArray(), R: hinge.R && hinge.R.toArray() };
  // 只保留 q 里绕 axis（单位向量）的那部分转动
  const twistOnly = (q, axis) => {
    const d = q.x * axis.x + q.y * axis.y + q.z * axis.z, t = new Q(axis.x * d, axis.y * d, axis.z * d, q.w);
    const len = Math.hypot(t.x, t.y, t.z, t.w); return len < 1e-6 ? new Q() : t.set(t.x / len, t.y / len, t.z / len, t.w / len);
  };
  // 一条胳膊：大臂指向肘，再绕大臂转，让肘的铰链轴和视频里胳膊弯曲的平面对上；小臂只绕铰链轴弯
  const arm = (side, s, e, w, f) => {
    const sh = 'Shoulder_' + side, el = 'Elbow_' + side;
    aim(sh, el, e.clone().sub(s), f);
    const u = e.clone().sub(s).normalize(), fw = w.clone().sub(e).normalize();
    const cr = u.clone().cross(fw), bend = cr.length();
    if (hinge[side] && bend > 0.05) {
      const H = cr.normalize();   // 想要的铰链轴（世界）：绕它正着转，小臂从顺着大臂转向手腕
      B[el].quaternion.copy(rest[el]); B[el].updateMatrixWorld(true);
      const hW = hinge[side].clone().applyQuaternion(wq(el));
      const proj = (v) => v.clone().addScaledVector(u, -v.dot(u)).normalize();
      const from = proj(hW), to = proj(H);
      let ang = Math.acos(Math.max(-1, Math.min(1, from.dot(to))));
      if (from.clone().cross(to).dot(u) < 0) ang = -ang;
      ang *= Math.min(1, bend / 0.35);   // 胳膊快伸直时铰链方向不可靠，少转一点
      const b = B[sh], target = new Q().setFromAxisAngle(u, ang).multiply(wq(sh));
      b.quaternion.copy(b.parent.getWorldQuaternion(new Q()).invert().multiply(target)); b.updateMatrixWorld(true);
      f[sh] = b.quaternion.clone();
    }
    aim(el, 'Wrist_' + side, fw, f);
    if (hinge[side]) {
      const local = rest[el].clone().invert().multiply(f[el]);
      B[el].quaternion.copy(rest[el].clone().multiply(twistOnly(local, hinge[side]))); B[el].updateMatrixWorld(true);
      f[el] = B[el].quaternion.clone();
    }
  };
  const DRIVE = ['Root_M', 'RootPart1_M', 'Spine1_M', 'Spine1Part1_M', 'Chest_M', 'Neck_M', 'NeckPart1_M', 'Head_M',
    'Shoulder_L', 'Elbow_L', 'Wrist_L', 'Shoulder_R', 'Elbow_R', 'Wrist_R', 'Hip_L', 'Knee_L', 'Ankle_L', 'Hip_R', 'Knee_R', 'Ankle_R'];
  const out = {}; for (const n of DRIVE) out[n] = [];
  const rootPos = [];
  const midA = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const hip0 = midA(P.frames[0].n[23], P.frames[0].n[24]);
  // 视频里人的高度（归一化）→ 米：用第 0 帧头顶到脚底的距离对应角色身高
  const n0 = P.frames[0].n, bodyN = Math.max(n0[31][1], n0[32][1], n0[29][1], n0[30][1]) - n0[0][1];
  const bodyM = bindWP.Head_M.y + 0.12 - 0;   // 角色从脚底到头顶大约多高
  const pxToM = bodyM / (bodyN * 1.12);
  const aspect = P.w / P.h;

  for (let i = 0; i < N; i++) {
    const l = L[i], f = {};
    for (const b of skel.bones) b.quaternion.copy(rest[b.name]);
    B.Root_M.position.copy(restPos.Root_M);
    a.root.updateMatrixWorld(true);
    // 躯干
    const Rh = hipsR(l).multiply(cal.hips).premultiply(y0);
    const Rc = chestR(l).multiply(cal.chest).premultiply(y0);
    setWorld('Root_M', Rh, f);
    setWorld('RootPart1_M', Rh.clone().slerp(Rc, 0.15), f);
    setWorld('Spine1_M', Rh.clone().slerp(Rc, 0.4), f);
    setWorld('Spine1Part1_M', Rh.clone().slerp(Rc, 0.7), f);
    setWorld('Chest_M', Rc, f);
    // 头：相对胸口的转动，扣掉第 0 帧的偏差，脖子分 40%
    const rel = cal.headRel.clone().premultiply(chestR(l).invert().multiply(headR(l))).normalize();
    const relFix = chestR(l).invert().multiply(headR(l)).multiply(cal.headRel);
    const Rhead = Rc.clone().multiply(relFix);
    setWorld('Neck_M', Rc.clone().slerp(Rhead, 0.25), f);
    setWorld('NeckPart1_M', Rc.clone().slerp(Rhead, 0.5), f);
    setWorld('Head_M', Rhead, f);
    // 四肢：骨骼指向关键点之间的方向
    arm('L', l[11], l[13], l[15], f);
    arm('R', l[12], l[14], l[16], f);
    f.Wrist_L = rest.Wrist_L.clone(); f.Wrist_R = rest.Wrist_R.clone();
    aim('Hip_L', 'Knee_L', l[25].clone().sub(l[23]), f);
    aim('Knee_L', 'Ankle_L', l[27].clone().sub(l[25]), f);
    const fwd = V(0, 0, 1).applyQuaternion(Rh); fwd.y = 0; fwd.normalize();
    const footDir = (toe, heel) => {
      const d = toe.clone().sub(heel), h = V(d.x, 0, d.z);
      if (h.length() < 0.06 || h.normalize().dot(fwd) < 0.2) return fwd.clone().add(V(0, -0.25, 0));
      return d.add(V(0, 0.035, 0));
    };
    aim('Ankle_L', 'Toes_L', footDir(l[31], l[29]), f);
    aim('Hip_R', 'Knee_R', l[26].clone().sub(l[24]), f);
    aim('Knee_R', 'Ankle_R', l[28].clone().sub(l[26]), f);
    aim('Ankle_R', 'Toes_R', footDir(l[32], l[30]), f);
    // 腰的位置：左右跟着视频里胯的移动；高低让低的那只脚踩在地上
    const nh = midA(P.frames[i].n[23], P.frames[i].n[24]);
    a.root.updateMatrixWorld(true);
    const sole = Math.min(wp('Ankle_L').y - 0.085, wp('Toes_L').y - 0.03, wp('Ankle_R').y - 0.085, wp('Toes_R').y - 0.03);
    const world = wp('Root_M').add(V((nh[0] - hip0[0]) * pxToM * aspect, -sole, 0));
    B.Root_M.parent.updateMatrixWorld(true);
    rootPos.push(B.Root_M.parent.worldToLocal(world));
    for (const n of DRIVE) out[n].push(f[n] || B[n].quaternion.clone());
  }
  // 四元数正负号连续（不然插值会绕远路），高度再平滑一下
  const res = { fps: P.fps, frames: N, bones: {}, root: [] };
  const SMOOTH = { Elbow_L: 0.45, Elbow_R: 0.45, Ankle_L: 0.35, Ankle_R: 0.35, Shoulder_L: 0.55, Shoulder_R: 0.55 };
  for (const n of DRIVE) {
    const arr = out[n];
    for (let i = 1; i < arr.length; i++) if (arr[i].dot(arr[i - 1]) < 0) arr[i].set(-arr[i].x, -arr[i].y, -arr[i].z, -arr[i].w);
    const k = SMOOTH[n] || 0.6;
    for (let i = 1; i < arr.length; i++) arr[i] = arr[i - 1].clone().slerp(arr[i], k);
    for (let i = arr.length - 2; i >= 0; i--) arr[i] = arr[i + 1].clone().slerp(arr[i], k);
    res.bones[n] = arr.flatMap((q) => [q.x, q.y, q.z, q.w].map((v) => Math.round(v * 1e4) / 1e4));
  }
  for (let i = 0; i < N; i++) {
    const acc = V(0, 0, 0); let ws = 0;
    for (let d = -2; d <= 2; d++) { const j = Math.min(N - 1, Math.max(0, i + d)); acc.add(rootPos[j]); ws++; }
    acc.divideScalar(ws);
    res.root.push(...[acc.x, acc.y, acc.z].map((v) => Math.round(v * 1e4) / 1e4));
  }
  return res;
})()
