// Yunlai Robot 的 3D 面部/身体（Yuki）：接入层。
// 角色是 GLB（models/Yuki_outfit1.glb、Yuki_outfit2.glb，同一个角色两套衣服，由 fetch-assets.sh 下载）：
// ARKit 52 个表情形变（eyeBlinkLeft、jawOpen…）+ 骨骼 + 自带动画（idle、Yuki_Idle_listening_v3、hello、Yes、No…）。
// 显示和动画交给 three.js，这里只做两件事：把说明书里的 robot_state 消息翻译成表情形变和头部朝向；连 WebSocket。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ───────── 配置（网址参数） ─────────
const Q = new URLSearchParams(location.search);
const wsParam = Q.get('ws');
const CFG = {
  ws: wsParam === 'auto' ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' : wsParam || '',
  demo: Q.has('demo') ? Q.get('demo') !== '0' : !wsParam,
  fps: Number(Q.get('fps')) || 30,
  idleAfter: (Number(Q.get('idle')) || 45) * 1000,
  tex: Number(Q.get('tex')) || 2048,   // 贴图最长边上限（iPhone 内存小，大图缩小）
};

// 衣服 id → 模型文件。default 是第一套；以前存的旧 id（heibai、yeye）也回到第一套
const OUTFITS = { default: 'models/Yuki_outfit1.glb', outfit2: 'models/Yuki_outfit2.glb' };

// ───────── 状态和情绪 → 表情形变（ARKit 名字，0～1） ─────────
// head：头的额外转动（弧度，yaw 正 = 向屏幕右，pitch 正 = 低头，roll 正 = 向屏幕右歪）
const STATES = {
  idle: {},
  listening: { browInnerUp: 0.3, eyeWideLeft: 0.15, eyeWideRight: 0.15, head: { roll: 0.08 } },
  thinking: { mouthPressLeft: 0.3, mouthPressRight: 0.3, browDownLeft: 0.2, browOuterUpRight: 0.3, mouthLeft: 0.2, head: { roll: -0.1, pitch: -0.05 } },
  speaking: {},
  observing: { browDownLeft: 0.15, browDownRight: 0.15, eyeSquintLeft: 0.15, eyeSquintRight: 0.15 },
};
const EMOTIONS = {
  neutral: {},
  happy: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.45, cheekSquintRight: 0.45, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
  alert: { browDownLeft: 0.7, browDownRight: 0.7, eyeWideLeft: 0.35, eyeWideRight: 0.35, mouthFrownLeft: 0.25, mouthFrownRight: 0.25 },
  surprised: { browInnerUp: 0.8, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.7, eyeWideRight: 0.7, jawOpen: 0.3 },
  confused: { browDownLeft: 0.6, browOuterUpRight: 0.6, mouthFrownLeft: 0.3, mouthFrownRight: 0.1, mouthLeft: 0.3, head: { roll: 0.18 } },
};
const SHAPES = [...new Set([...Object.values(STATES), ...Object.values(EMOTIONS)].flatMap((o) => Object.keys(o)))].filter((k) => k !== 'head');
const DRIVEN = [...new Set([...SHAPES, 'jawOpen', 'mouthFunnel', 'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight'])];

const S = {
  state: 'idle', emotion: 'neutral', emotionUntil: 0, emotionBack: 'neutral',
  gaze: { x: 0, y: 0, at: -1e9 }, gimbal: { x: 0, y: 0, at: -1e9 },
  mouth: 0, mouthAt: -1e9, speaking: false, link: CFG.ws ? 'connecting' : 'none', lastInput: 0,
};
const cur = Object.fromEntries(DRIVEN.map((p) => [p, 0]));
const head = { yaw: 0, pitch: 0, roll: 0 };
const now = () => performance.now() / 1000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ───────── 消息（与说明书一致） ─────────
// {"type":"robot_state","state":"speaking","emotion":"happy","gaze":{"x":0.2,"y":-0.1},"mouth_level":0.65}
function apply(msg) {
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return false; } }
  if (!msg || typeof msg !== 'object') return false;
  const t = now();
  S.lastInput = t;
  const type = msg.type || (msg.state || msg.emotion ? 'robot_state' : '');
  if (type === 'robot_state') {
    if (STATES[msg.state]) S.state = msg.state;
    if (EMOTIONS[msg.emotion]) setEmotion(msg.emotion, Number(msg.duration_ms) || 0);
    if (msg.gaze) { S.gaze = { x: clamp(+msg.gaze.x || 0, -1, 1), y: clamp(+msg.gaze.y || 0, -1, 1), at: t }; }
    if (typeof msg.mouth_level === 'number') { S.mouth = clamp(msg.mouth_level, 0, 1); S.mouthAt = t; }
  } else if (type === 'gimbal') {
    // 云台角度（度）：yaw 负 = 屏幕左，pitch 正 = 抬头；connected:false 表示云台断开
    S.gimbal = { x: clamp((+msg.yaw || 0) / 35, -1, 1), y: clamp(-(+msg.pitch || 0) / 30, -1, 1), at: msg.connected === false ? -1e9 : t };
  } else if (type === 'event') {
    const E = { voice_start: 'listening', sound: 'listening', speech_end: 'thinking', voice_end: 'thinking', answer_start: 'speaking', answer_end: 'idle', idle: 'idle' };
    if (E[msg.name]) S.state = E[msg.name];
    if (msg.name === 'idle') setEmotion('neutral');
    if (msg.name === 'anomaly') setEmotion('alert', Number(msg.duration_ms) || 3000);
    if (msg.name === 'person_detected') { S.gaze = { x: clamp(+msg.x || 0, -1, 1), y: clamp(+msg.y || 0, -1, 1), at: t }; playOnce('hello'); }
  } else if (type === 'speak' && msg.url) {
    S.state = 'speaking'; S.speaking = true;
    speakUrl(String(msg.url));
  } else if (type === 'outfit') {
    // 换装：{"type":"outfit","id":"outfit2"}，"default" 是第一套
    setOutfit(String(msg.id || 'default'));
  } else if (type === 'sensing') {
    if ('camera' in msg) document.getElementById('pill-cam').classList.toggle('on', !!msg.camera);
    if ('mic' in msg) document.getElementById('pill-mic').classList.toggle('on', !!msg.mic);
  } else return false;
  return true;
}
function setEmotion(name, ms) {
  if (ms) { if (!S.emotionUntil) S.emotionBack = S.emotion; S.emotionUntil = now() + ms / 1000; } else S.emotionUntil = 0;
  S.emotion = name;
}
function goIdle() { S.state = 'idle'; setEmotion('neutral'); S.gaze.at = -1e9; S.gimbal.at = -1e9; }

// ───────── 真实语音：用音量驱动嘴型 ─────────
let audio = null, analyser = null, level = new Uint8Array(512);
function endSpeak() { S.speaking = false; if (S.state === 'speaking') S.state = 'idle'; send({ type: 'speak_end' }); }
function speakUrl(url) {
  try {
    if (!audio) {
      audio = new Audio(); audio.crossOrigin = 'anonymous';
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ac.createAnalyser(); analyser.fftSize = 512;
      ac.createMediaElementSource(audio).connect(analyser); analyser.connect(ac.destination);
      audio.ac = ac;
    }
    audio.onended = endSpeak; audio.onerror = endSpeak;
    audio.src = url;
    if (audio.ac.state === 'suspended') audio.ac.resume();
    audio.play().catch(endSpeak);
  } catch (e) { endSpeak(); }
}
function audioMouth() {
  if (!S.speaking || !analyser) return 0;
  analyser.getByteTimeDomainData(level);
  let sum = 0;
  for (let i = 0; i < level.length; i++) { const v = (level[i] - 128) / 128; sum += v * v; }
  return clamp(Math.sqrt(sum / level.length) * 4, 0, 1);
}

// ───────── 画面 ─────────
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
scene.add(new THREE.HemisphereLight(0xdde8ff, 0x403850, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.5, 2.5, 3); scene.add(key);
const rim = new THREE.DirectionalLight(0x7fe9ff, 0.8); rim.position.set(-2, 1.5, -2); scene.add(rim);

let W = 1, H = 1;
function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  layout();
}
addEventListener('resize', resize);

// 角色（当前穿着的那一套）
let avatar = null;   // { id, root, mixer, clips, faces, headBone, base, action, size }
let wantOutfit = 'default';
let loadingId = '';
const loader = new GLTFLoader();

// 显示全身，脚落在背景地板那圈光环上（大约屏幕高度 84% 的地方）
function layout() {
  if (!avatar) return;
  const h = avatar.size.y, fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (h / 0.8) / (2 * Math.tan(fov / 2));
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  // 脚底放在屏幕 84% 高度处：屏幕中心对应世界 y=0，往下 0.34*画面高度
  const viewH = 2 * Math.tan(fov / 2) * dist;
  avatar.root.position.y = -0.34 * viewH + (-avatar.box.min.y);
  avatar.root.position.x = -(avatar.box.min.x + avatar.box.max.x) / 2;
}

function shrinkTextures(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      for (const k of Object.keys(m)) {
        const tx = m[k];
        if (!tx || !tx.isTexture || seen.has(tx)) continue;
        seen.add(tx);
        const img = tx.image;
        const w = img && (img.width || img.naturalWidth), h = img && (img.height || img.naturalHeight);
        if (!w || Math.max(w, h) <= CFG.tex) continue;
        const r = CFG.tex / Math.max(w, h);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * r)); c.height = Math.max(1, Math.round(h * r));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        if (img.close) try { img.close(); } catch (e) { /* ImageBitmap */ }
        tx.image = c; tx.needsUpdate = true;
      }
    }
  });
}

function disposeAvatar(a) {
  if (!a) return;
  a.mixer.stopAllAction();
  scene.remove(a.root);
  a.root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of [].concat(o.material)) {
      for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose();
      m.dispose();
    }
  });
}

const KEEP = ['idle', 'Yuki_Idle_listening_v3', 'hello', 'Yes', 'No'];
function load(id) {
  const file = OUTFITS[id] || OUTFITS.default;
  return new Promise((ok, fail) => {
    loader.load(file, (gltf) => {
      const root = gltf.scene;
      shrinkTextures(root);
      root.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; } });
      const faces = [];
      let headBone = null;
      root.traverse((o) => {
        if (o.isMesh && o.morphTargetDictionary && o.morphTargetDictionary.jawOpen !== undefined) faces.push(o);
        if (o.name === 'Head_M') headBone = o;
      });
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const clips = {};
      for (const c of gltf.animations) if (KEEP.includes(c.name)) clips[c.name] = c;   // 其余 25 个动画不要，省内存
      const mixer = new THREE.AnimationMixer(root);
      ok({ id, root, mixer, clips, faces, headBone, box, size, base: null, action: null });
    }, undefined, fail);
  });
}

async function setOutfit(id) {
  if (!OUTFITS[id]) id = 'default';
  wantOutfit = id;
  if (avatar && avatar.id === id) { send({ type: 'outfit_done', id, ok: true }); return; }
  if (loadingId === id) return;
  loadingId = id;
  try {
    const a = await load(id);
    if (wantOutfit !== id) { disposeAvatar(a); return; }   // 加载期间又换了别的
    const old = avatar;
    avatar = a;
    scene.add(a.root);
    layout();
    disposeAvatar(old);
    document.getElementById('loading').style.display = 'none';
    send({ type: 'outfit_done', id, ok: true });
  } catch (e) {
    console.error('加载角色失败', id, e);
    document.getElementById('loading').textContent = '模型加载失败：先运行 sh fetch-assets.sh';
    send({ type: 'outfit_done', id, ok: false, error: String((e && e.message) || e) });
  } finally {
    if (loadingId === id) loadingId = '';
  }
}

// ───────── 动画：待机循环 + 偶尔的一次性动作 ─────────
function baseClip() { return S.state === 'listening' && avatar.clips.Yuki_Idle_listening_v3 ? 'Yuki_Idle_listening_v3' : 'idle'; }
function syncBase() {
  const name = baseClip();
  if (!avatar.clips[name] || avatar.base === name) return;
  const next = avatar.mixer.clipAction(avatar.clips[name]);
  next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
  if (avatar.action) next.crossFadeFrom(avatar.action, 0.5, false);
  avatar.action = next; avatar.base = name;
}
let oneShotUntil = 0;
function playOnce(name) {
  if (!avatar || !avatar.clips[name] || now() < oneShotUntil) return;
  const a = avatar.mixer.clipAction(avatar.clips[name]);
  a.reset().setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false;
  a.play();
  if (avatar.action) a.crossFadeFrom(avatar.action, 0.3, false);
  oneShotUntil = now() + avatar.clips[name].duration;
  setTimeout(() => {
    if (!avatar) return;
    a.fadeOut(0.4);
    if (avatar.action) avatar.action.reset().fadeIn(0.4).play();
  }, avatar.clips[name].duration * 1000 - 400);
}

// ───────── 每帧：动画之后叠加表情和头部朝向 ─────────
let nextBlink = now() + 2.5, blinkT = -1;
const qTmp = new THREE.Quaternion(), qParent = new THREE.Quaternion(), eTmp = new THREE.Euler();

function frame(dt) {
  if (!avatar) return;
  const t = now();
  if (S.emotionUntil && t > S.emotionUntil) { S.emotionUntil = 0; S.emotion = S.emotionBack; }
  if (!CFG.demo && t - S.lastInput > CFG.idleAfter / 1000 && !S.speaking && (S.state !== 'idle' || S.emotion !== 'neutral')) goIdle();

  syncBase();
  avatar.mixer.update(dt);

  const target = { ...STATES[S.state] };
  const headT = { yaw: 0, pitch: 0, roll: 0, ...(target.head || {}) };
  delete target.head;
  for (const [k, v] of Object.entries(EMOTIONS[S.emotion])) {
    if (k === 'head') { for (const [a, b] of Object.entries(v)) headT[a] += b; } else target[k] = (target[k] || 0) + v;
  }

  // 说话时嘴型：有真实音频用音量；有 mouth_level 用它；都没有时用合成的音节节奏
  let mouth = 0;
  if (S.speaking && analyser) mouth = audioMouth();
  else if (t - S.mouthAt < 0.5) mouth = S.mouth;
  else if (S.state === 'speaking' && !S.speaking) mouth = Math.max(0, Math.sin(t * 9.3) * Math.sin(t * 3.7 + 1)) * 0.9;
  if (mouth > 0) { target.jawOpen = Math.max(target.jawOpen || 0, mouth * 0.7); target.mouthFunnel = mouth * 0.25; }

  // 眨眼
  if (blinkT < 0 && t > nextBlink) { blinkT = t; nextBlink = t + 2.5 + Math.random() * 3; }
  let blink = 0;
  if (blinkT >= 0) {
    const p = (t - blinkT) / 0.18;
    if (p >= 1) blinkT = -1; else blink = Math.sin(p * Math.PI);
  }
  target.eyeBlinkLeft = Math.max(target.eyeBlinkLeft || 0, blink);
  target.eyeBlinkRight = Math.max(target.eyeBlinkRight || 0, blink);

  // 视线：x 向屏幕右为正，y 向下为正
  let gx = 0, gy = 0;
  if (t - S.gaze.at < 4) { gx = S.gaze.x; gy = S.gaze.y; }
  else if (t - S.gimbal.at < 6) { gx = S.gimbal.x; gy = S.gimbal.y; }
  else if (S.state === 'thinking') { gx = 0.5 * Math.sin(t * 0.5); gy = -0.5; }
  else if (S.state === 'observing') { gx = 0.7 * Math.sin(t * 0.45); }
  // 角色的左眼在屏幕右边：看屏幕右 = 左眼往内、右眼往外
  const right = Math.max(0, gx), left = Math.max(0, -gx), down = Math.max(0, gy), up = Math.max(0, -gy);
  target.eyeLookInLeft = right * 0.7; target.eyeLookOutRight = right * 0.7;
  target.eyeLookOutLeft = left * 0.7; target.eyeLookInRight = left * 0.7;
  target.eyeLookDownLeft = down * 0.6; target.eyeLookDownRight = down * 0.6;
  target.eyeLookUpLeft = up * 0.6; target.eyeLookUpRight = up * 0.6;
  headT.yaw += gx * 0.45; headT.pitch += gy * 0.25;

  const kShape = Math.min(1, dt * 8), kMouth = Math.min(1, dt * 20), kHead = Math.min(1, dt * 5);
  for (const p of DRIVEN) {
    const k = (p === 'jawOpen' || p === 'mouthFunnel' || p.startsWith('eyeBlink')) ? kMouth : kShape;
    cur[p] += ((target[p] || 0) - cur[p]) * k;
  }
  head.yaw += (headT.yaw - head.yaw) * kHead;
  head.pitch += (headT.pitch - head.pitch) * kHead;
  head.roll += (headT.roll - head.roll) * kHead;

  // 动画里的表情形变权重会被它自己的轨道改写，所以在动画之后覆盖我们驱动的那几个
  for (const m of avatar.faces) {
    const dict = m.morphTargetDictionary, inf = m.morphTargetInfluences;
    for (const p of DRIVEN) { const i = dict[p]; if (i !== undefined) inf[i] = cur[p]; }
  }

  // 头：在世界坐标里叠加转动（不依赖骨骼的局部轴方向）
  const hb = avatar.headBone;
  if (hb && hb.parent && (Math.abs(head.yaw) + Math.abs(head.pitch) + Math.abs(head.roll)) > 0.001) {
    hb.parent.updateWorldMatrix(true, false);
    hb.parent.getWorldQuaternion(qParent);
    eTmp.set(head.pitch, head.yaw, -head.roll, 'YXZ');
    qTmp.setFromEuler(eTmp);
    // local' = P⁻¹ · delta · P · local
    hb.quaternion.premultiply(qParent).premultiply(qTmp).premultiply(qParent.clone().invert());
  }
}

// 30 FPS 上限（iPhone 7 Plus）
let last = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const ts = performance.now();
  if (ts - last < 1000 / CFG.fps - 2) return;
  const dt = Math.min(0.1, (ts - last) / 1000);
  last = ts;
  frame(dt);
  renderer.render(scene, camera);
}

// ───────── WebSocket：断线回到待机，自动重连 ─────────
let ws = null, backoff = 1000;
function connect() {
  if (!CFG.ws) return;
  ws = new WebSocket(CFG.ws);
  ws.onopen = () => { S.link = 'online'; backoff = 1000; send({ type: 'face_ready', kind: 'yuki' }); };
  ws.onmessage = (e) => apply(e.data);
  ws.onclose = () => { S.link = 'offline'; goIdle(); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); };
  ws.onerror = () => ws.close();
}
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  try { window.webkit.messageHandlers.yunlai.postMessage(obj); } catch (e) { /* 不在 App 里 */ }
}

// ───────── 演示（没接云端时自动播放） ─────────
const DEMO = [
  [3, { state: 'idle', emotion: 'neutral' }], [3, { type: 'event', name: 'voice_start' }],
  [3.5, { type: 'event', name: 'speech_end' }], [4, { state: 'speaking' }], [3, { state: 'speaking', emotion: 'happy' }],
  [2, { state: 'observing', emotion: 'neutral' }], [2, { type: 'gimbal', yaw: -30 }], [2, { type: 'gimbal', yaw: 30 }],
  [2, { type: 'gimbal', yaw: 0 }], [2.5, { type: 'event', name: 'anomaly', duration_ms: 2500 }],
  [2, { state: 'idle', emotion: 'surprised', duration_ms: 1500 }], [3, { state: 'thinking', emotion: 'confused' }],
];
let demoI = 0;
function demo() {
  if (!CFG.demo) return;
  const [sec, msg] = DEMO[demoI++ % DEMO.length];
  if (msg.type !== 'gimbal') S.gimbal.at = -1e9;
  apply(msg);
  setTimeout(demo, sec * 1000);
}

// 点一下：挥手打招呼
addEventListener('pointerup', () => { playOnce('hello'); send({ type: 'touch' }); });
addEventListener('message', (e) => { if (e.data && typeof e.data === 'object' && e.data.type) apply(e.data); });

window.YunlaiFace = {
  apply,
  stopDemo: () => { CFG.demo = false; },
  get: () => ({ state: S.state, emotion: S.emotion, link: S.link, loaded: !!avatar, outfit: avatar && avatar.id }),
};

resize();
tick();
setOutfit(wantOutfit).then(() => {
  send({ type: 'face_ready', kind: 'yuki' });
  connect();
  setTimeout(demo, 2000);
});
