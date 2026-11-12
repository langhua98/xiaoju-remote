// 弹簧骨骼的数学：node --test Robot/live2d/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Bone, Quaternion } from 'three';
import { verletStep, constrainLength, pushOutSphere, pushOutCapsule, findSpringBones, SpringSystem, STEP } from '../src/spring.js';

const P = { stiffness: 1.2, drag: 0.4, gravity: 0, radius: 0.01 };

test('静止在原姿势时不会动', () => {
  const center = new Vector3(0, 1, 0), dir = new Vector3(0, -1, 0), rest = new Vector3(0, 0.9, 0), out = new Vector3();
  verletStep(rest, rest, dir, center, 0.1, P, STEP, out);
  assert.ok(out.distanceTo(rest) < 1e-9);
});

test('被拉开以后会回到原姿势，长度一直不变', () => {
  const center = new Vector3(0, 1, 0), dir = new Vector3(0, -1, 0), rest = new Vector3(0, 0.9, 0);
  let cur = new Vector3(0.1, 1, 0), prev = cur.clone();
  const out = new Vector3();
  for (let i = 0; i < 600; i++) {
    verletStep(cur, prev, dir, center, 0.1, P, STEP, out);
    assert.ok(Math.abs(out.distanceTo(center) - 0.1) < 1e-9);
    prev.copy(cur); cur.copy(out);
  }
  assert.ok(cur.distanceTo(rest) < 1e-3, `离原姿势还有 ${cur.distanceTo(rest)}`);
});

test('重力会让它往下垂', () => {
  const center = new Vector3(0, 1, 0), dir = new Vector3(1, 0, 0);
  let cur = new Vector3(0.1, 1, 0), prev = cur.clone();
  const out = new Vector3();
  for (let i = 0; i < 600; i++) { verletStep(cur, prev, dir, center, 0.1, { ...P, gravity: 0.6 }, STEP, out); prev.copy(cur); cur.copy(out); }
  assert.ok(cur.y < 0.99 && cur.x > 0);
});

test('长度为零时退回原方向', () => {
  const p = new Vector3(1, 1, 1);
  constrainLength(p, new Vector3(1, 1, 1), 0.2, new Vector3(0, 1, 0));
  assert.deepEqual(p.toArray(), [1, 1.2, 1]);
});

test('碰撞：球和胶囊都把点推到表面', () => {
  const p = new Vector3(0.01, 0, 0);
  assert.equal(pushOutSphere(p, new Vector3(0, 0, 0), 0.1), true);
  assert.ok(Math.abs(p.length() - 0.1) < 1e-9);
  assert.equal(pushOutSphere(p, new Vector3(0, 0, 0), 0.05), false);
  const q = new Vector3(0.02, 0.5, 0);
  assert.equal(pushOutCapsule(q, new Vector3(0, 0, 0), new Vector3(0, 1, 0), 0.1), true);
  assert.ok(Math.abs(q.x - 0.1) < 1e-9 && Math.abs(q.y - 0.5) < 1e-9);
});

function chain(names, parent) {
  const out = [];
  for (const n of names) { const b = new Bone(); b.name = n; b.position.set(0, -0.1, 0); parent.add(b); out.push(b); parent = b; }
  return out;
}

test('只挑没有动画的悬挂物，不碰修正骨骼和有动画的头发', () => {
  const root = new Bone(); root.name = 'Root_M';
  const bow = chain(['bow_1', 'bow_2'], root);
  const hair = chain(['hair_1', 'hair_2'], root);          // hair_2 有动画
  const skirt = chain(['Skirt_1_1', 'Skirt_1_2'], root);   // 根不动、下面有动画
  const fix = chain(['thighCorrectiveRoot_L', 'thighInOff_L'], root);
  const part = chain(['ElbowPart2_L', 'B_joint_1'], root);
  const all = [root, ...bow, ...hair, ...skirt, ...fix, ...part];
  const moving = new Set(['Root_M', 'hair_2', 'Skirt_1_2']);
  const got = findSpringBones(all, (b) => !moving.has(b.name)).map((b) => b.name);
  assert.deepEqual(got.sort(), ['B_joint_1', 'bow_1', 'bow_2', 'hair_2'].filter((n) => n !== 'hair_2').sort());
});

test('整套系统：父骨骼一甩，悬挂物跟着晃，最后回到原位；数值不炸', () => {
  const root = new Bone(); root.name = 'Root_M'; root.position.set(0, 1, 0);
  const [a, b] = chain(['ribbon_1', 'ribbon_2'], root);
  root.updateMatrixWorld(true);
  const sys = new SpringSystem([a, b], []);
  const restA = a.quaternion.clone();
  sys.update(1 / 30);
  assert.ok(a.quaternion.angleTo(restA) < 1e-6, '第一帧应该保持原姿势');
  // 父骨骼突然横移
  root.position.x = 0.2; root.updateMatrixWorld(true);
  sys.update(1 / 30);
  const swing = a.quaternion.angleTo(restA);
  assert.ok(swing > 0.05, `应该被甩开，实际只有 ${swing}`);
  for (let i = 0; i < 300; i++) { root.updateMatrixWorld(true); sys.update(1 / 30); }
  for (const j of [a, b]) for (const v of j.quaternion.toArray()) assert.ok(Number.isFinite(v));
  assert.ok(a.quaternion.angleTo(restA) < 0.25, '过一会儿应该大致垂回去（有重力，不会完全回到原位）');
  // 长时间没更新（切到后台）之后不炸
  root.position.x = 5; root.updateMatrixWorld(true);
  sys.update(3);
  assert.ok(a.quaternion.angleTo(restA) < 1e-6);
});

test('原姿势就在碰撞体里的骨骼，不和那个碰撞体算碰撞', () => {
  const root = new Bone(); root.name = 'Chest_M'; root.position.set(0, 1, 0);
  const [a] = chain(['bow_1'], root);
  root.updateMatrixWorld(true);
  const sys = new SpringSystem([a], [{ a: root, b: null, radius: 0.3, offset: new Vector3() }]);
  assert.deepEqual(sys.joints[0].ignore, [true]);
  const rest = a.quaternion.clone();
  for (let i = 0; i < 30; i++) sys.update(1 / 30);
  assert.ok(a.quaternion.angleTo(rest) < 0.2);
  assert.ok(new Quaternion().copy(a.quaternion).length() > 0.99);
});

test('头发（有动画的骨骼）：跟着动画走，头一甩有滞后，偏离不超过圆锥，动画不动时不会越叠越歪', () => {
  const head = new Bone(); head.name = 'Head_M'; head.position.set(0, 1.5, 0);
  const bones = chain(['Emi_hair_B_1_0', 'Emi_hair_B_1_1', 'Emi_hair_B_1_2', 'Emi_hair_B_1_3'], head);
  head.updateMatrixWorld(true);
  const sys = new SpringSystem(bones, [], new Set(bones));
  assert.ok(sys.joints.every((j) => j.anim));
  assert.ok(sys.joints[0].follow > sys.joints[3].follow, '发根跟得紧，发梢跟得松');
  // 「动画」把第二节转到一个新姿势，然后一直保持（模拟动画系统数值不变时不重写骨骼）
  const pose = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
  const anim = bones.map((b, i) => (i === 1 ? b.quaternion.clone().multiply(pose) : b.quaternion.clone()));
  const frame = (move) => {
    sys.restore();
    if (move) bones.forEach((b, i) => b.quaternion.copy(anim[i]));   // 动画这一帧写了骨骼
    head.updateMatrixWorld(true);
    sys.update(1 / 60);
  };
  frame(true);
  for (let i = 0; i < 240; i++) frame(false);
  assert.ok(bones[1].quaternion.angleTo(anim[1]) < 0.12, `停下来以后应该贴着动画姿势，实际差 ${bones[1].quaternion.angleTo(anim[1])}`);
  for (const j of sys.joints) assert.ok(j.restQ.angleTo(anim[sys.joints.indexOf(j)]) < 1e-6, '原姿势一直是动画给的，不能被弹簧的结果带歪');
  // 头突然横移：发梢落在后面，但不超过圆锥
  head.position.x = 0.3;
  frame(false);
  const tip = sys.joints[3];
  assert.ok(bones[3].quaternion.angleTo(anim[3]) > 0.02, '应该有滞后');
  for (let i = 0; i < 30; i++) {
    head.position.x += 0.05; frame(false);
    for (const j of sys.joints) {
      const k = sys.joints.indexOf(j);
      const cone = Math.acos(Math.max(-1, j.cosCone));
      assert.ok(bones[k].quaternion.angleTo(anim[k]) <= cone + 1e-3, '偏离不能超过圆锥');
    }
  }
  assert.ok(tip.cosCone < sys.joints[0].cosCone, '发梢的圆锥比发根大');
  for (const b of bones) for (const v of b.quaternion.toArray()) assert.ok(Number.isFinite(v));
});
