// 弹簧骨骼的数学：node --test Robot/live2d/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Bone, Quaternion } from 'three';
import { limitAngle, verletStep, constrainLength, pushOutSphere, pushOutCapsule, findSpringBones, SpringSystem, STEP } from '../src/spring.js';

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

test('挑骨骼：没有动画的悬挂物和整条裙子；不碰修正骨骼和有动画的头发', () => {
  const root = new Bone(); root.name = 'Root_M';
  const bow = chain(['bow_1', 'bow_2'], root);
  const hair = chain(['hair_1', 'hair_2'], root);          // hair_2 有动画
  const skirt = chain(['Skirt_1_1', 'Skirt_1_2'], root);   // 根不动、下面有动画
  const fix = chain(['thighCorrectiveRoot_L', 'thighInOff_L'], root);
  const part = chain(['ElbowPart2_L', 'B_joint_1'], root);
  const all = [root, ...bow, ...hair, ...skirt, ...fix, ...part];
  const moving = new Set(['Root_M', 'hair_2', 'Skirt_1_2']);
  const got = findSpringBones(all, (b) => !moving.has(b.name)).map((b) => b.name);
  assert.deepEqual(got.sort(), ['B_joint_1', 'Skirt_1_1', 'Skirt_1_2', 'bow_1', 'bow_2'].sort());
  const order = findSpringBones(all, (b) => !moving.has(b.name)).map((b) => b.name);
  assert.ok(order.indexOf('Skirt_1_1') < order.indexOf('Skirt_1_2'), '父在前子在后');
});

test('裙子跟着动画走：动画姿势变了，裙子带着惯性追过去，最后停在动画的姿势上', () => {
  const root = new Bone(); root.name = 'Root_M'; root.position.set(0, 1, 0);
  const [a, b] = chain(['Skirt_1_1', 'Skirt_1_2'], root);
  root.updateMatrixWorld(true);
  const sys = new SpringSystem([a, b], [], (bone) => bone.name === 'Skirt_1_1');   // 第二段有动画
  assert.equal(sys.joints[1].followAnim, true);
  const anim = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.8);   // 动画把第二段往前摆了 0.8 弧度
  const step = () => { b.quaternion.copy(anim); root.updateMatrixWorld(true); sys.update(1 / 30); };   // 每帧 mixer 先写动画值
  step();
  assert.ok(b.quaternion.angleTo(anim) < 1e-6, '第一帧直接是动画的样子');
  anim.setFromAxisAngle(new Vector3(1, 0, 0), -0.8);   // 动画突然摆到另一边
  step();
  const lag = b.quaternion.angleTo(anim);
  assert.ok(lag > 0.02, `应该带着惯性慢一拍，实际只差 ${lag}`);
  assert.ok(lag < 0.13, `两节加起来偏离动画不能超过两倍上限（上限 0.06 弧度），实际 ${lag}`);
  for (let i = 0; i < 200; i++) step();
  assert.ok(b.quaternion.angleTo(anim) < 0.1, `最后要回到动画的样子附近，还差 ${b.quaternion.angleTo(anim)}`);
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

test('偏离上限：超过了拉回到上限，没超过不动', () => {
  const center = new Vector3(0, 1, 0), dir = new Vector3(0, -1, 0);
  const cur = new Vector3(0.1, 1, 0), prev = cur.clone();   // 偏了 90°
  assert.equal(limitAngle(cur, prev, center, dir, 0.1, 0.2), true);
  const d = cur.clone().sub(center);
  assert.ok(Math.abs(d.length() - 0.1) < 1e-9);
  assert.ok(Math.abs(d.normalize().angleTo(dir) - 0.2) < 1e-6);
  const ok = new Vector3(0.005, 0.9, 0);
  assert.equal(limitAngle(ok, ok.clone(), center, dir, 0.1, 0.2), false);
});
