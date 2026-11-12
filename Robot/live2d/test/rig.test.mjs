// 辅助骨骼和视线分配的数学：node --test Robot/live2d/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion, Bone, Euler } from 'three';
import { twistAbout, TwistHelpers, Gaze, addWorldRotation, GAZE } from '../src/rig.js';

const Y = new Vector3(0, 1, 0), X = new Vector3(1, 0, 0);

test('swing-twist：纯扭转原样取出', () => {
  const q = new Quaternion().setFromAxisAngle(Y, 1.2), out = new Quaternion();
  twistAbout(q, Y, out);
  assert.ok(out.angleTo(q) < 1e-9);
});

test('swing-twist：纯摆动的扭转是零', () => {
  const q = new Quaternion().setFromAxisAngle(X, 0.9), out = new Quaternion();
  twistAbout(q, Y, out);
  assert.ok(out.angleTo(new Quaternion()) < 1e-9);
});

test('swing-twist：摆动加扭转，取出的扭转绕着轴，角度对', () => {
  const twist = new Quaternion().setFromAxisAngle(Y, 0.8), swing = new Quaternion().setFromAxisAngle(X, 0.5);
  const out = new Quaternion();
  twistAbout(swing.clone().multiply(twist), Y, out);
  assert.ok(out.angleTo(twist) < 1e-6);
  twistAbout(new Quaternion().setFromAxisAngle(X, Math.PI), Y, out);   // 180° 纯摆动：退回不转
  assert.ok(out.angleTo(new Quaternion()) < 1e-9);
});

test('扭转分担：手腕拧 90°，前臂两段各拧 1/3 和 2/3', () => {
  const elbow = new Bone(); elbow.name = 'Elbow_L';
  const mk = (name, y) => { const b = new Bone(); b.name = name; b.position.set(0, y, 0); elbow.add(b); return b; };
  const wrist = mk('Wrist_L', 0.24), p1 = mk('ElbowPart1_L', 0.08), p2 = mk('ElbowPart2_L', 0.16);
  p1.quaternion.setFromAxisAngle(Y, Math.PI);   // 模型里这两根骨骼本身就带着 180° 的初始转动
  const rest1 = p1.quaternion.clone();
  const h = new TwistHelpers({ Elbow_L: elbow, Wrist_L: wrist, ElbowPart1_L: p1, ElbowPart2_L: p2 });
  assert.equal(h.items.length, 1);
  h.update();
  assert.ok(p1.quaternion.angleTo(rest1) < 1e-9, '没拧的时候保持原样');
  wrist.quaternion.setFromEuler(new Euler(0.4, Math.PI / 2, 0, 'XYZ'));   // 弯一点再拧 90°
  h.update();
  const a1 = p1.quaternion.angleTo(rest1), a2 = p2.quaternion.angleTo(new Quaternion());
  assert.ok(Math.abs(a2 / a1 - 2) < 0.02, `两段的比例应该是 2，实际 ${a2 / a1}`);
  assert.ok(a2 > 0.8 && a2 < 1.2, `第二段大约 60°，实际 ${a2}`);
});

test('世界坐标叠加：不管父骨骼怎么歪，向右转就是绕世界的竖直轴', () => {
  const parent = new Bone(); parent.quaternion.setFromEuler(new Euler(0.7, -1.1, 0.4));
  const b = new Bone(); parent.add(b);
  parent.updateMatrixWorld(true);
  const before = b.getWorldQuaternion(new Quaternion());
  addWorldRotation(b, 0.5, 0, 0);
  parent.updateMatrixWorld(true);
  const after = b.getWorldQuaternion(new Quaternion());
  const delta = after.multiply(before.invert());
  assert.ok(delta.angleTo(new Quaternion().setFromAxisAngle(Y, 0.5)) < 1e-6);
});

test('视线分配：眼睛先到，头后到，最后眼睛让回一部分', () => {
  const mk = (p) => { const b = new Bone(); if (p) p.add(b); return b; };
  const root = mk(), chest = mk(root), neck = mk(chest), head = mk(neck), eyeL = mk(head), eyeR = mk(head);
  root.updateMatrixWorld(true);
  const g = new Gaze({ chest, neck, head, eyeL, eyeR });
  const none = { yaw: 0, pitch: 0, roll: 0 };
  g.resetBones(); g.update(1 / 30, 1, 0, none, [0, 0], 1);
  const eyeEarly = g.cur.eye[0], headEarly = g.cur.head[0];
  assert.ok(eyeEarly > headEarly * 2, '一开始眼睛转得比头多');
  for (let i = 0; i < 120; i++) { g.resetBones(); g.update(1 / 30, 1, 0, none, [0, 0], 1); }
  const body = g.body[0], eye = g.cur.eye[0];
  assert.ok(Math.abs(body - GAZE.maxYaw * 0.7) < 0.01, '头、脖子、胸一共转 70%');
  assert.ok(Math.abs(body + eye - GAZE.maxYaw) < 0.01, '加上眼睛正好看到目标');
  assert.ok(eye < eyeEarly, '头跟上以后眼睛回正一些');
  // 每帧先 resetBones，骨骼上的转动不会越叠越多
  const q1 = head.quaternion.clone();
  g.resetBones(); g.update(1 / 30, 1, 0, none, [0, 0], 1);
  assert.ok(head.quaternion.angleTo(q1) < 1e-3);
});
