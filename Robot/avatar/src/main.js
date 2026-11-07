// Yunlai Robot 3D 角色面部：three.js + three-vrm 驱动 VRM 模型。
// 状态、情绪、视线、嘴型都来自 brain.js，和 2D 眼睛版用同一套消息协议。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { readConfig, createBrain, approach, clamp, clamp01, wobble } from './brain.js';

const VERSION = '2.0';
const CFG = readConfig();
const Q = CFG.query;
CFG.maxDpr = Number(Q.get('dpr')) || 1.5;          // 7 Plus 是 3 倍屏，3D 限 1.5 倍
const DEFAULT_MODEL = 'models/sample.vrm';

const $ = (id) => document.getElementById(id);
const brain = createBrain(CFG, {
  onBoot: () => boot(),
  onSensing: (cam, mic) => {
    $('pill-cam').className = 'pill' + (cam ? ' on' : '');
    $('pill-mic').className = 'pill' + (mic ? ' on' : '');
  },
  onToggleDebug: () => { CFG.debug = !CFG.debug; $('debug').style.display = CFG.debug ? 'block' : 'none'; },
  onEmotion: (name) => { if (name === 'happy') sparkleBurst = 1; },
});
const S = brain.S;

// ───────────────────────── 表情配方 ─────────────────────────
// VRM 1.0 标准表情：happy angry sad relaxed surprised / aa ih ou ee oh / blink
const STATE_EXPR = {
  idle: {},
  listening: { surprised: 0.12 },
  thinking: { relaxed: 0.2 },
  speaking: {},
  observing: {},
};
const EMOTION_EXPR = {
  neutral: {},
  happy: { happy: 0.9 },
  alert: { surprised: 0.5, angry: 0.3 },
  surprised: { surprised: 1 },
  confused: { sad: 0.35, relaxed: 0.15 },
};
// 姿态：头部侧歪、前倾
const STATE_POSE = {
  idle: { tilt: 0, lean: 0 },
  listening: { tilt: 0.07, lean: 0.06 },
  thinking: { tilt: -0.09, lean: -0.02 },
  speaking: { tilt: 0.02, lean: 0.03 },
  observing: { tilt: 0, lean: 0.02 },
};
const EMOTION_POSE = { confused: { tilt: 0.16 }, alert: { lean: -0.05 }, surprised: { lean: -0.06 } };
const EXPR_KEYS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

// ───────────────────────── 场景 ─────────────────────────
const canvas = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' });
renderer.setClearColor(0x000000, 1);
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, CFG.maxDpr));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 30);

const keyLight = new THREE.DirectionalLight(0xffffff, Math.PI * 0.62);
keyLight.position.set(0.6, 1.2, 1.5);
const rimLight = new THREE.DirectionalLight(0x7fe9ff, Math.PI * 0.3);   // 冰蓝轮廓光
rimLight.position.set(-1.2, 1.4, -1.5);
const ambient = new THREE.AmbientLight(0x9fdfff, 0.18);
scene.add(keyLight, rimLight, ambient);

// 背后冰蓝光晕（贴图，不用实时模糊）
function radialTexture(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; return tx;
}
const haloTex = radialTexture([[0, 'rgba(127,233,255,.55)'], [0.35, 'rgba(43,196,240,.2)'], [0.7, 'rgba(10,92,168,.06)'], [1, 'rgba(0,0,0,0)']]);
const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
halo.renderOrder = -1;
scene.add(halo);

// 能量粒子：思考时绕头流动，平时淡淡漂浮
const dotTex = radialTexture([[0, 'rgba(232,253,255,1)'], [0.3, 'rgba(127,233,255,.8)'], [1, 'rgba(0,0,0,0)']]);
const N = 70;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(N * 3);
const pSeed = [];
for (let i = 0; i < N; i++) pSeed.push({ a: Math.random() * Math.PI * 2, r: 0.18 + Math.random() * 0.22, h: (Math.random() - 0.5) * 0.5, sp: (0.25 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 10 });
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const pMat = new THREE.PointsMaterial({ map: dotTex, size: 0.028, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.2, color: 0xffffff });
const points = new THREE.Points(pGeo, pMat);
points.frustumCulled = false;   // 位置每帧都在变，不做视锥裁剪
scene.add(points);

// 倾听声波：头两侧的扩散圆环
const ringTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'); g.strokeStyle = 'rgba(127,233,255,1)'; g.lineWidth = 6;
  g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.stroke();
  const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; return tx;
})();
const rings = [];
for (let i = 0; i < 3; i++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  rings.push(m); scene.add(m);
}

// 开心：向上飘的小星光（原创图形，冰蓝色）
const starTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(127,233,255,.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(232,253,255,1)';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? 9 : 60, a = i * Math.PI / 4;
    g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; return tx;
})();
const sparkles = [];
for (let i = 0; i < 8; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  sp.userData = { life: 1, vx: 0, vy: 0, x: 0, y: 0, s: 0 };
  sparkles.push(sp); scene.add(sp);
}
let sparkleBurst = 0, sparkleNext = 0;

// ───────────────────────── 模型 ─────────────────────────
let vrm = null, bones = {}, headY = 1.4, rest = {};
const lookTarget = new THREE.Object3D();
scene.add(lookTarget);
const W = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
EXPR_KEYS.forEach((k) => { W[k] = 0; });
const pose = { tilt: 0, lean: 0, yaw: 0, pitch: 0 };

async function modelSource() {
  if (Q.get('model')) return Q.get('model');
  const cached = await idbGet('model').catch(() => null);
  if (cached) return URL.createObjectURL(cached);
  return DEFAULT_MODEL;
}

async function loadModel(url) {
  setLoading(0.02, '正在唤醒…');
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url, (e) => { if (e.total) setLoading(e.loaded / e.total * 0.9, '正在唤醒…'); });
  const v = gltf.userData.vrm;
  if (!v) throw new Error('不是 VRM 模型');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(v);
  v.scene.traverse((o) => { o.frustumCulled = false; });
  if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
  vrm = v;
  scene.add(vrm.scene);
  if (vrm.lookAt) { vrm.lookAt.target = lookTarget; vrm.lookAt.autoUpdate = true; }

  const names = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftShoulder', 'rightShoulder'];
  bones = {};
  names.forEach((n) => { bones[n] = vrm.humanoid.getNormalizedBoneNode(n); });
  vrm.scene.updateMatrixWorld(true);
  const hp = new THREE.Vector3();
  (bones.head || vrm.scene).getWorldPosition(hp);
  headY = hp.y;
  rest = {};
  Object.keys(bones).forEach((n) => { if (bones[n]) rest[n] = bones[n].quaternion.clone(); });
  layout();
  setLoading(1, '');
  boot();
}

function setLoading(p, text) {
  const el = $('loading');
  el.style.display = p >= 1 ? 'none' : 'flex';
  $('bar').style.transform = 'scaleX(' + clamp01(p) + ')';
  $('loading-text').textContent = text;
}

// ───────────────────────── 布局：竖屏看头肩，横屏看上半身 ─────────────────────────
function layout() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const portrait = h > w;
  const frameH = portrait ? 0.52 : 0.46;               // 画面里要容纳的高度（米）
  const fitH = portrait ? Math.max(frameH, 0.36 / camera.aspect) : frameH;
  const dist = (fitH / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const cy = headY - (portrait ? 0.04 : -0.01);
  camera.position.set(0, cy + 0.02, dist);
  camera.lookAt(0, cy, 0);
  camera.updateProjectionMatrix();
  halo.position.set(0, headY - 0.02, -0.35);
  halo.scale.setScalar(portrait ? 1.1 : 1.0);
}
addEventListener('resize', layout);

// ───────────────────────── 开机：从黑暗中亮起、睁眼 ─────────────────────────
let bootT = 99;
function boot() { bootT = 0; }

// ───────────────────────── 每帧 ─────────────────────────
const tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler();
function setBone(name, x, y, z) {
  const b = bones[name];
  if (!b || !rest[name]) return;
  tmpE.set(x, y, z, 'YXZ');
  tmpQ.setFromEuler(tmpE);
  b.quaternion.copy(rest[name]).multiply(tmpQ);
}

function update(dt, t) {
  brain.update(dt);
  bootT += dt;
  const bootK = clamp01((bootT - 0.2) / 1.2);
  $('fade').style.opacity = String(1 - bootK);

  // 表情目标
  const tgt = {};
  EXPR_KEYS.forEach((k) => { tgt[k] = 0; });
  Object.assign(tgt, STATE_EXPR[S.state] || {});
  const em = EMOTION_EXPR[S.emotion] || {};
  Object.keys(em).forEach((k) => { tgt[k] = Math.max(tgt[k] || 0, em[k]); });
  EXPR_KEYS.forEach((k) => { W[k] = approach(W[k], tgt[k], 7, dt); });

  // 嘴型：音量决定开合，元音在 a / o / i / e 之间轮换，看起来像在说话
  const m = S.mouth;
  const v1 = 0.5 + 0.5 * Math.sin(t * 4.1), v2 = 0.5 + 0.5 * Math.sin(t * 2.7 + 1.3);
  const tgtV = { aa: m * (0.55 + 0.45 * v1), oh: m * 0.5 * (1 - v1) * v2, ih: m * 0.35 * (1 - v2), ee: m * 0.25 * v2 * (1 - v1), ou: 0 };
  Object.keys(tgtV).forEach((k) => { W[k] = approach(W[k], tgtV[k], 20, dt); });

  // 姿态
  const sp = STATE_POSE[S.state] || {}, ep = EMOTION_POSE[S.emotion] || {};
  const tilt = (ep.tilt !== undefined ? ep.tilt : sp.tilt || 0);
  const lean = (ep.lean !== undefined ? ep.lean : sp.lean || 0);
  pose.tilt = approach(pose.tilt, tilt, 4, dt);
  pose.lean = approach(pose.lean, lean, 4, dt);
  const headShare = S.state === 'observing' || t - S.gimbal.at < 6 ? 0.75 : 0.45;
  pose.yaw = approach(pose.yaw, S.gaze.x * 0.55 * headShare, 6, dt);
  pose.pitch = approach(pose.pitch, S.gaze.y * 0.35 * headShare, 6, dt);

  if (!vrm) return;
  const em2 = vrm.expressionManager;
  if (em2) {
    const blink = Math.max(S.blink, 1 - clamp01((bootT - 0.9) / 0.35));   // 开机时先闭眼再睁开
    em2.setValue('blink', clamp01(blink * (1 - W.happy * 0.7)));
    EXPR_KEYS.forEach((k) => em2.setValue(k, W[k]));
    ['aa', 'ih', 'ou', 'ee', 'oh'].forEach((k) => em2.setValue(k, clamp01(W[k])));
  }

  // 呼吸、身体轻摆、说话时轻轻点头
  const breath = Math.sin(t * Math.PI * 2 / 4.2);
  const nod = S.state === 'speaking' ? S.mouth * 0.05 * Math.sin(t * 5.2) : 0;
  setBone('spine', pose.lean * 0.5 + breath * 0.012, pose.yaw * 0.15 + wobble(t * 0.3, 1) * 0.02, 0);
  setBone('chest', pose.lean * 0.5 + breath * 0.015, pose.yaw * 0.15, 0);
  setBone('neck', pose.pitch * 0.4, pose.yaw * 0.35, pose.tilt * 0.4);
  setBone('head', pose.pitch * 0.6 + nod + wobble(t * 0.5, 4) * 0.015, pose.yaw * 0.5, pose.tilt * 0.6 + wobble(t * 0.4, 7) * 0.012);
  // 手臂从 T 字放下
  setBone('leftUpperArm', 0, 0, -1.2 + breath * 0.02);
  setBone('rightUpperArm', 0, 0, 1.2 - breath * 0.02);
  setBone('leftLowerArm', 0, -0.25, 0);
  setBone('rightLowerArm', 0, 0.25, 0);
  setBone('leftShoulder', 0, 0, breath * 0.015);
  setBone('rightShoulder', 0, 0, -breath * 0.015);

  // 眼睛看向：镜头位置 + 视线偏移（屏幕坐标：x 右为正，y 下为正）
  lookTarget.position.set(camera.position.x + S.gaze.x * 0.9, camera.position.y - S.gaze.y * 0.6, camera.position.z);

  vrm.update(dt);

  // ── 特效 ──
  const glow = (S.emotion === 'happy' ? 1 : S.emotion === 'alert' ? 0.9 : S.state === 'listening' ? 0.75 : 0.55) + S.flash * 0.4;
  halo.material.opacity = approach(halo.material.opacity, glow * (0.85 + 0.15 * breath) * bootK, 4, dt);
  rimLight.intensity = Math.PI * (0.2 + glow * 0.2 + S.flash * 0.5);
  keyLight.intensity = Math.PI * (0.58 + S.flash * 0.12);
  rimLight.color.setRGB(0.5 + (S.emotion === 'alert' ? 0.4 : 0), 0.91, 1);

  // 粒子
  const thinking = S.state === 'thinking' ? 1 : 0;
  pMat.opacity = approach(pMat.opacity, (0.18 + thinking * 0.7) * bootK, 2.5, dt);
  for (let i = 0; i < N; i++) {
    const p = pSeed[i];
    const a = p.a + p.sp * t * (0.4 + thinking * 0.8);
    const r = p.r * (1 + thinking * 0.15 * Math.sin(t * 0.8 + p.ph));
    pPos[i * 3] = Math.cos(a) * r;
    pPos[i * 3 + 1] = headY + 0.02 + p.h * (0.6 + 0.4 * (1 - thinking)) + Math.sin(t * 0.6 + p.ph) * 0.03;
    pPos[i * 3 + 2] = Math.sin(a) * r * 0.6 - 0.05;
  }
  pGeo.attributes.position.needsUpdate = true;

  // 声波
  const listening = S.state === 'listening' ? 1 : 0;
  const lvl = S.micLevel > 0.02 ? S.micLevel : 0.45 + 0.35 * Math.abs(wobble(t * 1.6, 9));
  rings.forEach((rg, i) => {
    const ph = (t * 0.8 + i / 3) % 1;
    const s = 0.16 + ph * 0.28 * (0.6 + lvl * 0.6);
    rg.scale.set(s, s, 1);
    rg.position.set(0, headY - 0.02, -0.12);
    rg.material.opacity = approach(rg.material.opacity, (1 - ph) * 0.45 * listening * (0.4 + lvl * 0.6), 6, dt);
  });

  // 开心星光
  if (S.emotion === 'happy' && t > sparkleNext) { spawnSparkle(); sparkleNext = t + 0.35; }
  if (sparkleBurst > 0) { for (let i = 0; i < 3; i++) spawnSparkle(); sparkleBurst = 0; }
  sparkles.forEach((sp) => {
    const d = sp.userData;
    d.life += dt / 1.4;
    d.x += d.vx * dt; d.y += d.vy * dt;
    sp.position.set(d.x, d.y, 0.08);
    const k = clamp01(d.life);
    sp.material.opacity = k >= 1 ? 0 : Math.sin(k * Math.PI) * 0.9;
    sp.material.rotation = d.life * 2;
    sp.scale.setScalar(d.s * (0.6 + 0.4 * Math.sin(k * Math.PI)));
  });
}

function spawnSparkle() {
  const sp = sparkles.find((s) => s.userData.life >= 1);
  if (!sp) return;
  const side = Math.random() < 0.5 ? -1 : 1;
  Object.assign(sp.userData, { life: 0, x: side * (0.12 + Math.random() * 0.08), y: headY + (Math.random() - 0.3) * 0.12, vx: side * 0.02, vy: 0.06 + Math.random() * 0.04, s: 0.025 + Math.random() * 0.025 });
}

// ───────────────────────── 帧调度：30 FPS，设备够快升到 60 ─────────────────────────
let interval = CFG.fps === '60' ? 1000 / 60 : 1000 / 30;
let lastDraw = 0, fpsN = 0, fpsAt = 0, fpsShown = 0, statAt = 0, costSum = 0, costN = 0;
function frame(ms) {
  requestAnimationFrame(frame);
  if (ms - lastDraw < interval - 2) return;
  const dt = lastDraw ? Math.min((ms - lastDraw) / 1000, 0.1) : 1 / 30;
  lastDraw = ms;
  const t0 = performance.now();
  update(dt, t0 / 1000);
  renderer.render(scene, camera);
  costSum += performance.now() - t0; costN++; fpsN++;
  if (ms - fpsAt > 1000) { fpsShown = fpsN; fpsN = 0; fpsAt = ms; }
  if (ms - statAt > 3000) {
    const avg = costSum / Math.max(costN, 1);
    if (CFG.fps === 'auto') {
      if (interval > 20 && avg < 4) interval = 1000 / 60;
      else if (interval < 20 && (avg > 10 || fpsShown < 48)) interval = 1000 / 30;
    }
    costSum = 0; costN = 0; statAt = ms;
  }
  if (CFG.debug) {
    $('debug').style.display = 'block';
    $('debug').textContent = 'Yunlai Avatar ' + VERSION + '\nfps ' + fpsShown + ' / 目标 ' + Math.round(1000 / interval) +
      '\nstate ' + S.state + ' · emotion ' + S.emotion + '\ngaze ' + S.gaze.x.toFixed(2) + ', ' + S.gaze.y.toFixed(2) +
      ' · mouth ' + S.mouth.toFixed(2) + '\nlink ' + S.link + (CFG.demo ? ' · demo' : '') +
      '\nmodel ' + (vrm && vrm.meta ? (vrm.meta.name || vrm.meta.title || '') : '—');
  }
}

// ───────────────────────── 换模型：拖入文件，或长按 2 秒选文件 ─────────────────────────
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('yunlai-avatar', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function useFile(file) {
  if (!file || !/\.vrm$/i.test(file.name)) return;
  try { await idbSet('model', file); } catch (e) { /* 存不下也照样加载 */ }
  loadModel(URL.createObjectURL(file)).catch(showError);
}
$('file').addEventListener('change', (e) => useFile(e.target.files[0]));
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); useFile(e.dataTransfer.files[0]); });

let pressAt = 0, taps = [], micAsked = false;
addEventListener('pointerdown', () => { pressAt = performance.now(); });
addEventListener('pointerup', () => {
  brain.unlockAudio();
  if (CFG.mic && !micAsked) { micAsked = true; brain.startMic(); }
  if (performance.now() - pressAt > 2000) { $('file').click(); return; }
  const t = performance.now() / 1000;
  taps = taps.filter((x) => t - x < 0.6); taps.push(t);
  if (taps.length >= 3) { CFG.debug = !CFG.debug; $('debug').style.display = CFG.debug ? 'block' : 'none'; taps = []; return; }
  brain.poke();
});

function showError(err) {
  // 模型加载失败：回退到 2D 眼睛版，机器人不会“没脸”
  console.error(err);
  setLoading(0.999, '模型加载失败，切换到眼睛模式…');
  setTimeout(() => { location.href = '../face/index.html' + location.search.replace(/([?&])model=[^&]*&?/, '$1'); }, 1500);
}

// ───────────────────────── 启动 ─────────────────────────
window.YunlaiFace = {
  version: VERSION,
  apply: brain.apply,
  boot,
  stopDemo: brain.stopDemo,
  get: () => ({ state: S.state, emotion: S.emotion, link: S.link, gaze: { ...S.gaze }, mouth: S.mouth, fps: fpsShown, loaded: !!vrm,
    expr: Object.fromEntries(Object.keys(W).map((k) => [k, +W[k].toFixed(3)])) }),
};

layout();
if (CFG.debug) window.__yunlai = { scene, camera, points, renderer };
if (CFG.debug) $('debug').style.display = 'block';
requestAnimationFrame(frame);
brain.connect();
modelSource().then(loadModel).then(() => brain.startDemo(2400)).catch(showError);
