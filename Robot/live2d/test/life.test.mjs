// 活气的数学：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Quaternion, Vector3 } from 'three';
import { Life, LIFE, EXPRESSIONS, addBodyRotation, applyLife } from '../src/life.js';

// 固定的随机数，结果每次一样
function seeded(seed = 1) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
const DEG = 180 / Math.PI;

function run(secs, state, life = new Life(seeded(7))) {
  const rows = [];
  for (let i = 0; i < secs * 60; i++) {
    const o = life.update(i / 60, 1 / 60, state);
    rows.push({ t: i / 60, breath: o.breath, gx: o.gx, gy: o.gy, glance: o.glance, yaw: o.head.yaw, pitch: o.head.pitch, roll: o.head.roll, smile: o.shapes.mouthSmileLeft, expr: o.expr, sway: o.sway.yaw });
  }
  return rows;
}

test('呼吸：一直在起伏，周期在设定的范围里，吸气比呼气快', () => {
  const rows = run(60, { idle: true, speaking: false, busy: false, lookFree: true });
  const b = rows.map((r) => r.breath);
  assert.ok(Math.max(...b) > 0.95 && Math.min(...b) < -0.95);
  let peaks = 0, up = 0, down = 0;
  for (let i = 1; i < b.length - 1; i++) { if (b[i] > b[i - 1] && b[i] >= b[i + 1] && b[i] > 0.9) peaks++; if (b[i] > b[i - 1]) up++; else if (b[i] < b[i - 1]) down++; }
  assert.ok(peaks >= 60 / LIFE.breath.period[1] - 1 && peaks <= 60 / LIFE.breath.period[0] + 1, `一分钟呼吸 ${peaks} 次`);
  assert.ok(up < down, '吸气的时间应该比呼气短');
});

test('眼神：闲着时会看向别处再看回来，大部分时间还是看着人；视线被占着或不闲时不乱看', () => {
  const rows = run(120, { idle: true, speaking: false, busy: false, lookFree: true });
  const away = rows.filter((r) => r.glance).length / rows.length;
  let starts = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].glance && !rows[i - 1].glance) starts++;
  assert.ok(starts >= 8 && starts <= 40, `两分钟看别处 ${starts} 次`);
  assert.ok(away > 0.08 && away < 0.45, `看别处的时间占 ${away}`);
  for (const r of rows) { assert.ok(Math.abs(r.gx) <= 0.75 + 1e-9 && r.gy >= -0.2 - 1e-9 && r.gy <= 0.4 + 1e-9); if (!r.glance) assert.equal(r.gx, 0); }
  for (const st of [{ idle: true, lookFree: false }, { idle: false, lookFree: true }, { idle: true, lookFree: true, busy: true }]) {
    assert.ok(run(60, { speaking: false, busy: false, ...st }).every((r) => !r.glance));
  }
});

test('头和上身一直有很轻的动，幅度不超过设定；小表情会出现也会消失，种类不止一个', () => {
  const rows = run(180, { idle: true, speaking: false, busy: false, lookFree: true });
  const range = (k) => (Math.max(...rows.map((r) => r[k])) - Math.min(...rows.map((r) => r[k]))) * DEG;
  assert.ok(range('yaw') > 2 && range('yaw') < 2 * LIFE.head.yaw + 1);
  assert.ok(range('roll') > 2 && range('roll') < 2 * (LIFE.head.roll + LIFE.head.tilt[1] + 3) + 1);
  assert.ok(range('sway') > 1.5 && range('sway') <= 2 * LIFE.sway.yaw + 1e-6);
  // 相邻两帧不能跳（没有突变）
  for (let i = 1; i < rows.length; i++) for (const k of ['yaw', 'pitch', 'roll']) assert.ok(Math.abs(rows[i][k] - rows[i - 1][k]) * DEG < 0.6, `${k} 在 ${rows[i].t} 秒跳了`);
  const kinds = new Set(rows.map((r) => r.expr).filter(Boolean));
  assert.ok(kinds.size >= 3, `出现过的小表情：${[...kinds]}`);
  assert.ok(rows.some((r) => !r.expr), '小表情之间要有空档');
  for (const r of rows) assert.ok(r.smile >= 0 && r.smile <= 1);
  assert.ok(EXPRESSIONS.every((e) => Object.values(e[3]).every((v) => v > 0 && v <= 1)));
});

test('播大动作时整体收小；被碰一下马上看回来', () => {
  const life = new Life(seeded(3));
  const calm = run(30, { idle: true, speaking: false, busy: true, lookFree: true }, life);
  const amp = Math.max(...calm.slice(600).map((r) => Math.abs(r.yaw))) * DEG;
  assert.ok(amp < LIFE.head.yaw * 0.5, `播动作时头还在晃 ${amp}°`);
  const l2 = new Life(seeded(5));
  let t = 0, o;
  do { o = l2.update(t, 1 / 60, { idle: true, speaking: false, busy: false, lookFree: true }); t += 1 / 60; } while (!o.glance && t < 60);
  assert.ok(o.glance, '一分钟里应该看过别处');
  l2.attend(t);
  o = l2.update(t, 1 / 60, { idle: true, speaking: false, busy: false, lookFree: true });
  assert.ok(!o.glance && o.gx === 0);
});

test('在角色自己的坐标里转：角色转了身，前倾还是往她自己的前面倾', () => {
  for (const turn of [0, 90, 200]) {
    const root = new Bone(); root.rotation.y = turn * Math.PI / 180;
    const spine = new Bone(); spine.position.set(0, 1, 0); root.add(spine);
    const tip = new Bone(); tip.position.set(0, 0.3, 0); spine.add(tip);
    root.updateMatrixWorld(true);
    addBodyRotation(spine, root.quaternion, 10 / DEG, 0, 0);   // 往前低 10°
    root.updateMatrixWorld(true);
    const p = tip.getWorldPosition(new Vector3()).sub(spine.getWorldPosition(new Vector3()));
    const fwd = new Vector3(0, 0, 1).applyQuaternion(root.quaternion);
    assert.ok(Math.abs(p.dot(fwd) - 0.3 * Math.sin(10 / DEG)) < 1e-6, `转身 ${turn}° 时前倾的方向不对`);
    assert.ok(Math.abs(p.length() - 0.3) < 1e-9);
  }
});

test('呼吸写到骨骼上：吸气时胸口往后仰、两边肩膀都抬高，头保持水平', () => {
  const root = new Bone();
  const mk = (parent, x, y, z) => { const b = new Bone(); b.position.set(x, y, z); parent.add(b); return b; };
  const spine = mk(root, 0, 1, 0), chest = mk(spine, 0, 0.12, 0), head = mk(chest, 0, 0.3, 0);
  const scapL = mk(chest, 0.04, 0.12, 0), scapR = mk(chest, -0.04, 0.12, 0), shL = mk(scapL, 0.07, 0, 0), shR = mk(scapR, -0.07, 0, 0);
  const top = mk(head, 0, 0.1, 0);
  const b = { spine, chest, head, scapL, scapR };
  const pose = (breath) => {
    for (const x of [spine, chest, head, scapL, scapR]) x.quaternion.identity();
    root.updateMatrixWorld(true);
    applyLife(b, root.quaternion, { breath, sway: { yaw: 0, roll: 0 } });
    root.updateMatrixWorld(true);
    const w = (x) => x.getWorldPosition(new Vector3());
    return { shL: w(shL), shR: w(shR), head: w(head), up: w(top).sub(w(head)).normalize() };
  };
  const out = pose(-1), inn = pose(1);
  assert.ok(inn.shL.y > out.shL.y + 0.0005 && inn.shR.y > out.shR.y + 0.0005, '吸气时肩膀要抬高');
  assert.ok(inn.head.z < out.head.z, '吸气时胸口往后仰');
  assert.ok(Math.abs(inn.up.z) < 0.01, '头应该保持水平');
  assert.ok(new Quaternion().angleTo(spine.quaternion) * DEG <= LIFE.breath.spine + 1e-6);
});
