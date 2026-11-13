// Yunlai Robot 的 3D 角色（Yuki）：入口。配置、消息、主循环；其余在同目录的模块里：
//   avatar.js 加载和换装   toon.js 卡通渲染   rig.js 辅助骨骼和视线   face.js 表情和口型
//   spring.js 悬挂物物理   motion.js 动作状态机   camera.js 机位
// 每帧的顺序不能乱：状态机 → 动画 → 辅助骨骼 → 视线 → 表情 → 物理 → 镜头 → 渲染。
import * as THREE from 'three';
import { OUTFITS, loadAvatar, disposeAvatar } from './avatar.js';
import { updateToon, makeGroundShadow } from './toon.js';
import { Face, STATES, EMOTIONS } from './face.js';
import { CameraRig, SHOTS } from './camera.js';
import { ACTIONS } from './motion.js';
import { Scene, SCENE_IDS } from './scene.js';
import { loadDances } from './dances.js';

// ───────── 配置（网址参数），每个新功能都能单独关掉 ─────────
const Q = new URLSearchParams(location.search);
const wsParam = Q.get('ws');
const flag = (k, d) => (Q.has(k) ? Number(Q.get(k)) : d);
const CFG = {
  ws: wsParam === 'auto' ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' : wsParam || '',
  demo: Q.has('demo') ? Q.get('demo') !== '0' : !wsParam,
  fps: Number(Q.get('fps')) || 30,
  idleAfter: (Number(Q.get('idle')) || 45) * 1000,
  tex: Number(Q.get('tex')) || 2048,   // 贴图最长边上限（iPhone 内存小，大图缩小）
  toon: flag('toon', 1),       // 卡通材质；0 回到标准材质
  outline: flag('outline', 1), // 描边；2 = 连顶点特别多的裙子也描
  shadow: flag('shadow', 1),   // 刘海在额头上的投影、眼睛上沿的阴影
  spring: flag('spring', 1),   // 悬挂物物理
  helpers: flag('helpers', 1), // 辅助骨骼
  cam: flag('cam', 1),         // 自动机位
  fidget: flag('fidget', 1),   // 待机时自己做小动作
  debug: flag('debug', 0),     // 调试面板
  ankle: Q.has('ankle') ? Number(Q.get('ankle')) : NaN,   // 高跟鞋脚踝掰多少度（调试用，默认按 avatar.js 的 MESH_FIX）
};

const S = {
  state: 'idle', emotion: 'neutral', emotionUntil: 0, emotionBack: 'neutral',
  gaze: { x: 0, y: 0, at: -1e9 }, gimbal: { x: 0, y: 0, at: -1e9 },
  mouth: 0, bands: null, mouthAt: -1e9, speaking: false, link: CFG.ws ? 'connecting' : 'none', lastInput: 0,
  look: { x: 0, y: 0, until: 0 },   // 指定的视线，一直保持到 until（秒，Infinity = 直到放开）
  turn: 0, turnCur: 0,              // 身体朝向（度）：0 = 面向屏幕，正 = 转向屏幕右边
};
const now = () => performance.now() / 1000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180;   // 角度换到 -180～180
const face = new Face();

// ───────── 消息（与说明书一致） ─────────
// {"type":"robot_state","state":"speaking","emotion":"happy","gaze":{"x":0.2,"y":-0.1},"mouth_level":0.65,"mouth_bands":[0.5,0.3,0.1]}
function apply(msg) {
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return false; } }
  if (!msg || typeof msg !== 'object') return false;
  const t = now();
  S.lastInput = t;
  const type = msg.type || (msg.state || msg.emotion ? 'robot_state' : '');
  if (type === 'robot_state') {
    if (STATES[msg.state]) setState(msg.state);
    if (EMOTIONS[msg.emotion]) setEmotion(msg.emotion, Number(msg.duration_ms) || 0);
    if (msg.gaze) { S.gaze = { x: clamp(+msg.gaze.x || 0, -1, 1), y: clamp(+msg.gaze.y || 0, -1, 1), at: t }; }
    if (typeof msg.mouth_level === 'number') {
      S.mouth = clamp(msg.mouth_level, 0, 1); S.mouthAt = t;
      // 可选：声音低、中、高三个频段的能量，用来分出圆嘴和扁嘴
      S.bands = Array.isArray(msg.mouth_bands) && msg.mouth_bands.length === 3 ? msg.mouth_bands.map((v) => clamp(+v || 0, 0, 1)) : null;
    }
  } else if (type === 'gimbal') {
    // 云台角度（度）：yaw 负 = 屏幕左，pitch 正 = 抬头；connected:false 表示云台断开
    S.gimbal = { x: clamp((+msg.yaw || 0) / 35, -1, 1), y: clamp(-(+msg.pitch || 0) / 30, -1, 1), at: msg.connected === false ? -1e9 : t };
  } else if (type === 'event') {
    const E = { voice_start: 'listening', sound: 'listening', speech_end: 'thinking', voice_end: 'thinking', answer_start: 'speaking', answer_end: 'idle', idle: 'idle' };
    if (E[msg.name]) setState(E[msg.name]);
    if (msg.name === 'idle') setEmotion('neutral');
    if (msg.name === 'anomaly') setEmotion('alert', Number(msg.duration_ms) || 3000);
    if (msg.name === 'person_detected') { S.gaze = { x: clamp(+msg.x || 0, -1, 1), y: clamp(+msg.y || 0, -1, 1), at: t }; act('wave'); }
  } else if (type === 'action') {
    // {"type":"action","name":"dance"}：name 是 wave、nod、shake、dance、peace、kiss、angry、phone、play、read… 或者动画名
    // name 是 stop：停下正在做的动作
    if (msg.name === 'stop') { if (avatar) avatar.motion.stopAction(); send({ type: 'action_done', name: 'stop', ok: true }); return true; }
    const ok = act(String(msg.name || ''), true);
    send({ type: 'action_done', name: String(msg.name || ''), ok });
    return ok;
  } else if (type === 'bg') {
    // 背景：{"type":"bg","id":"room_night"}；auto = 卧室跟着时间变
    return { id: scene3.set(String(msg.id || 'auto')), want: scene3.want };
  } else if (type === 'view') {
    // 镜头：{"type":"view","shot":"auto|full|bust|face","orbit":30,"tilt":10}，没给的不变
    return rig.set(msg);
  } else if (type === 'turn') {
    // 转身：{"type":"turn","yaw":45}（转到某个朝向）或 {"type":"turn","by":-30}（在现在的基础上再转）
    drag.spin = 0;
    if (msg.by !== undefined && Number.isFinite(+msg.by)) S.turn += +msg.by;
    else if (msg.yaw !== undefined && Number.isFinite(+msg.yaw)) {
      const yaw = clamp(+msg.yaw, -180, 180);
      S.turn = yaw + 360 * Math.round((S.turnCur - yaw) / 360);
    }
    return { yaw: Math.round(wrapDeg(S.turn)) };
  } else if (type === 'look') {
    // 看哪里：{"type":"look","x":0.5,"y":-0.2,"ms":8000}；x、y 是 -1～1；ms 不给默认 10 秒，0 = 一直看；{"type":"look","free":true} 放开
    if (msg.free) S.look.until = 0;
    else {
      const ms = msg.ms === undefined ? 10000 : +msg.ms || 0;
      S.look = { x: clamp(+msg.x || 0, -1, 1), y: clamp(+msg.y || 0, -1, 1), until: ms > 0 ? t + ms / 1000 : Infinity };
    }
    return { x: S.look.x, y: S.look.y, hold: S.look.until > t };
  } else if (type === 'reset') {
    // 回到默认：自动镜头、面向屏幕、视线放开、平静、停下动作
    rig.set({ shot: 'auto', orbit: 0, tilt: 0 });
    S.turn = 360 * Math.round(S.turnCur / 360); drag.spin = 0; S.look.until = 0; S.gaze.at = -1e9;
    setEmotion('neutral');
    if (avatar) avatar.motion.stopAction();
  } else if (type === 'speak' && msg.url) {
    setState('speaking'); S.speaking = true;
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
function setState(name) {
  if (S.state === name) return;
  S.state = name;
  // 开始听、想、说的时候，把正在做的小动作停下来，专心对着人
  if (name !== 'idle' && avatar && avatar.motion.busy && !avatar.motion.keep) avatar.motion.stopAction();
}
function setEmotion(name, ms) {
  if (ms) { if (!S.emotionUntil) S.emotionBack = S.emotion; S.emotionUntil = now() + ms / 1000; } else S.emotionUntil = 0;
  const changed = S.emotion !== name;
  S.emotion = name;
  // 情绪带动作：生气时跺一下，开心时偶尔比个耶（聊天中不比，免得挡住对话）
  if (changed && name === 'alert') act('angry');
  if (changed && name === 'happy' && S.state === 'idle' && Math.random() < 0.3) act('peace');
}
function goIdle() { S.state = 'idle'; setEmotion('neutral'); S.gaze.at = -1e9; S.gimbal.at = -1e9; }
/// 播一个动作。byUser：大模型或人要求的（可以打断别的动作，聊天中也播完）
function act(name, byUser) {
  if (!avatar) return false;
  const ok = avatar.motion.play(name, !!byUser);
  if (ok) avatar.motion.keep = !!byUser;
  return ok;
}

// ───────── 真实语音：音量管张嘴，频段管嘴型 ─────────
let audio = null, analyser = null, level = new Uint8Array(512), freq = new Uint8Array(256), audioBands = [0, 0, 0];
function endSpeak() { S.speaking = false; if (S.state === 'speaking') S.state = 'idle'; send({ type: 'speak_end' }); }
function speakUrl(url) {
  try {
    if (!audio) {
      audio = new Audio(); audio.crossOrigin = 'anonymous';
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ac.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.5;
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
  // 三个频段的音量：约 700 Hz 以下（圆嘴）、700～2500 Hz、2500 Hz 以上（扁嘴）。
  // 频谱是按分贝给的（0～255 对应 -100～-30 dB），先换回能量再加起来，和 App 发来的 mouth_bands 是同一种量
  analyser.getByteFrequencyData(freq);
  const hz = audio.ac.sampleRate / analyser.fftSize;
  const band = (a, b) => { let e = 0; for (let i = Math.round(a / hz); i < Math.min(freq.length, Math.round(b / hz)); i++) e += Math.pow(10, (freq[i] / 255 * 70 - 100) / 10); return Math.sqrt(e); };
  audioBands = [band(80, 700), band(700, 2500), band(2500, 8000)];
  return clamp(Math.sqrt(sum / level.length) * 4, 0, 1);
}

// ───────── 画面 ─────────
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, stencil: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;   // 卡通底色不要被压暗
const scene = new THREE.Scene();
scene.matrixWorldAutoUpdate = false;   // 世界矩阵我们自己在物理之前更新一次，渲染时不再重复算
const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
if (!CFG.toon) {
  scene.add(new THREE.HemisphereLight(0xdde8ff, 0x403850, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.5, 2.5, 3); scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fe9ff, 0.8); rim.position.set(-2, 1.5, -2); scene.add(rim);
}
const rig = new CameraRig(camera, document.getElementById('bg'));
const scene3 = new Scene(document.getElementById('bg'), () => layout());
scene3.set(Q.get('bg') || 'auto');
const shadow = makeGroundShadow(0.42);
scene.add(shadow);

let W = 1, H = 1;
function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  scene3.layout();
  layout();
}
addEventListener('resize', resize);

// 角色（当前穿着的那一套）
let avatar = null;
let wantOutfit = OUTFITS[Q.get('outfit')] ? Q.get('outfit') : 'default';   // 网址可以直接指定穿哪套，省得先加载默认的再换
let loadingId = '';

// 脚底放在世界 y = 0，左右居中；镜头怎么摆交给 camera.js
function layout() {
  if (!avatar) return;
  avatar.root.position.set(-(avatar.box.min.x + avatar.box.max.x) / 2, -avatar.box.min.y, 0);
  rig.layout(avatar.box.max.y - avatar.box.min.y, avatar.headY - avatar.box.min.y);
  // 背景里站的点没能放到屏幕正中时（图到边了），把人往那边挪
  const viewH = rig.shots.full.dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const dx = (scene3.shiftX || 0) * viewH * camera.aspect;
  avatar.root.position.x += dx;
  shadow.position.set(dx, 0.012, -0.12);
}

async function setOutfit(id) {
  if (!OUTFITS[id]) id = 'default';
  wantOutfit = id;
  if (avatar && avatar.id === id) { send({ type: 'outfit_done', id, ok: true }); return; }
  if (loadingId === id) return;
  loadingId = id;
  try {
    const a = await loadAvatar(id, CFG);
    if (wantOutfit !== id) { disposeAvatar(a); return; }   // 加载期间又换了别的
    const old = avatar;
    avatar = a;
    scene.add(a.root);
    layout();
    disposeAvatar(old);
    a.motion.setBase(baseClip());
    document.getElementById('loading').style.display = 'none';
    canvas.style.opacity = 1;   // 第一次出现：淡入
    send({ type: 'outfit_done', id, ok: true });
  } catch (e) {
    console.error('加载角色失败', id, e);
    document.getElementById('loading').textContent = '模型加载失败：先运行 sh fetch-assets.sh';
    send({ type: 'outfit_done', id, ok: false, error: String((e && e.message) || e) });
  } finally {
    if (loadingId === id) loadingId = '';
  }
}

function baseClip() { return S.state === 'listening' && avatar.clips.Yuki_Idle_listening_v3 ? 'Yuki_Idle_listening_v3' : 'idle'; }

// ───────── 每帧 ─────────
const perf = { anim: 0, rig: 0, phys: 0, draw: 0, n: 0 };
const eyeNone = [0, 0];

function frame(dt) {
  if (!avatar) return;
  const t = now(), a = avatar, dbg = CFG.debug;
  let t0 = dbg ? performance.now() : 0;
  if (S.emotionUntil && t > S.emotionUntil) { S.emotionUntil = 0; S.emotion = S.emotionBack; }
  if (!CFG.demo && t - S.lastInput > CFG.idleAfter / 1000 && !S.speaking && (S.state !== 'idle' || S.emotion !== 'neutral')) goIdle();

  // 1. 状态机和动画
  const idle = S.state === 'idle' && !S.speaking;
  a.motion.setBase(baseClip());
  a.motion.update(t, dt, idle && CFG.fidget && t - S.lastInput > 6);
  a.mixer.update(dt);
  a.animBase.restore();   // 动画这一帧没重新写的骨骼，放回动画的值，再往上叠加
  let t1 = dbg ? performance.now() : 0;

  // 2. 高跟鞋掰平、辅助骨骼；没拿在手上的道具不画
  if (a.foot) a.foot.update();
  if (a.twist) a.twist.update();
  if (a.fix) a.fix.update();
  const nowClip = a.motion.one ? a.motion.one.getClip().name : '';
  for (const p of a.props) { const on = p.clips ? p.clips.includes(nowClip) : p.node.scale.x > 0.01; for (const m of p.meshes) m.visible = on; }

  // 3. 嘴：有真实音频用它；有 mouth_level 用它；都没有时用合成的音节节奏
  let mouth = 0, bands = null;
  if (S.speaking && analyser) { mouth = audioMouth(); bands = audioBands; }
  else if (t - S.mouthAt < 0.5) { mouth = S.mouth; bands = S.bands; }
  else if (S.state === 'speaking' && !S.speaking) mouth = Math.max(0, Math.sin(t * 9.3) * Math.sin(t * 3.7 + 1)) * 0.9;

  // 4. 身体朝向（整个角色绕竖直轴转），视线：x 向屏幕右为正，y 向下为正
  if (drag.on) S.turnCur = S.turn;   // 手指拖着转：直接跟手
  else if (Math.abs(drag.spin) > 2) {   // 松手后带着惯性转一会儿，慢慢停
    S.turn += drag.spin * dt; S.turnCur = S.turn;
    drag.spin *= Math.exp(-dt * DRAG.friction);
  } else S.turnCur += (S.turn - S.turnCur) * Math.min(1, dt * 2.2);
  a.root.rotation.y = S.turnCur * Math.PI / 180;
  let gx = 0, gy = 0;
  if (t < S.look.until) { gx = S.look.x; gy = S.look.y; }
  else if (t - S.gaze.at < 4) { gx = S.gaze.x; gy = S.gaze.y; }
  else if (t - S.gimbal.at < 6) { gx = S.gimbal.x; gy = S.gimbal.y; }
  else if (S.state === 'thinking') { gx = 0.5 * Math.sin(t * 0.5); gy = -0.5; }
  else if (S.state === 'observing') { gx = 0.7 * Math.sin(t * 0.45); }
  else {
    // 身体转开了：回头看着屏幕前的人（转到背对时就不回头了，脖子拧不过去）
    const w = wrapDeg(S.turnCur);
    if (Math.abs(w) > 3 && Math.abs(w) < 100) gx = clamp(-w / 38, -1, 1) * 0.8;
  }

  // 5. 表情（算出头的额外姿态和眼球微跳），再做视线分配
  const head = face.update(t, dt, { state: S.state, emotion: S.emotion, mouth, bands, gx, gy });
  a.gaze.update(dt, gx, gy, head, a.motion.busy ? eyeNone : face.saccade, a.motion.overlay);
  face.apply(a.faces);

  // 6. 世界矩阵（整棵树只在这里算一次），然后是物理
  let t2 = dbg ? performance.now() : 0;
  scene.updateMatrixWorld();
  if (a.spring) a.spring.update(dt);
  a.animBase.commit();
  let t3 = dbg ? performance.now() : 0;

  // 7. 镜头
  const close = (S.state === 'listening' || S.state === 'thinking' || S.state === 'speaking' || S.speaking) && !a.motion.wide;
  rig.update(t, dt, close, !!CFG.cam);
  camera.updateMatrixWorld();
  if (CFG.toon) updateToon(camera, a.toonHead);

  renderer.render(scene, camera);
  if (dbg) {
    const t4 = performance.now();
    perf.anim += t1 - t0; perf.rig += t2 - t1; perf.phys += t3 - t2; perf.draw += t4 - t3;
    if (++perf.n >= 30) showDebug();
  }
}

// 调试面板（?debug=1）：各部分每帧花多少毫秒
let debugEl = null;
function showDebug() {
  if (!debugEl) {
    debugEl = document.createElement('pre');
    debugEl.style.cssText = 'position:fixed;left:6px;top:40px;margin:0;padding:6px 8px;font:11px/1.4 Menlo,monospace;color:#7fe9ff;background:rgba(0,0,0,.6);border-radius:6px;pointer-events:none;z-index:9';
    document.body.appendChild(debugEl);
  }
  const n = perf.n, f = (v) => (v / n).toFixed(1).padStart(5);
  const st = avatar.stats, info = renderer.info.render;
  debugEl.textContent = `动画 ${f(perf.anim)} ms\n骨骼和表情 ${f(perf.rig)} ms\n矩阵和物理 ${f(perf.phys)} ms\n镜头和渲染 ${f(perf.draw)} ms\n` +
    `骨骼 ${st.bones}  轨道 ${st.tracks}\n弹簧 ${st.springs}  扭转 ${st.twists}\n绘制 ${info.calls} 次  三角 ${info.triangles}\n${S.state} / ${S.emotion}`;
  perf.anim = perf.rig = perf.phys = perf.draw = perf.n = 0;
}

// 30 FPS 上限（iPhone 7 Plus）
let last = performance.now();
function tick() {
  requestAnimationFrame(tick);
  const ts = performance.now();
  if (ts - last < 1000 / CFG.fps - 2) return;
  const dt = Math.min(0.1, (ts - last) / 1000);
  // 切到后台再回来、或者卡了很久：物理从原姿势重新开始，不要炸开
  if (ts - last > 500 && avatar && avatar.spring) avatar.spring.reset();
  last = ts;
  frame(dt);
}
document.addEventListener('visibilitychange', () => { if (avatar && avatar.spring) avatar.spring.reset(); });

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
  [2, { type: 'gimbal', yaw: 0 }], [3, { type: 'event', name: 'anomaly', duration_ms: 2500 }],
  [2, { state: 'idle', emotion: 'surprised', duration_ms: 1500 }], [3, { state: 'thinking', emotion: 'confused' }],
  [3, { state: 'idle', emotion: 'neutral' }], [5, { type: 'action', name: 'wave' }], [3, { type: 'action', name: 'nod' }],
  [12, { type: 'action', name: 'dance' }],
];
let demoI = 0;
function demo() {
  if (!CFG.demo) return;
  const [sec, msg] = DEMO[demoI++ % DEMO.length];
  if (msg.type !== 'gimbal') S.gimbal.at = -1e9;
  apply(msg);
  setTimeout(demo, sec * 1000);
}

// ───────── 点她：点到头、手有对应的反应，别处是打招呼 ─────────
// 不做精确的射线检测（几万个蒙皮三角形太慢），把几根关键骨骼投影到屏幕上，看点在谁附近。
const _p = new THREE.Vector3(), _p2 = new THREE.Vector3();
function screenOf(bone, out, up) {
  out.setFromMatrixPosition(bone.matrixWorld); out.y += up || 0;
  out.project(camera);
  out.x = (out.x * 0.5 + 0.5) * W; out.y = (0.5 - out.y * 0.5) * H;
  return out;
}
function partAt(x, y) {
  if (!avatar) return 'none';
  const b = avatar.byName;
  if (!b.Head_M || !b.Root_M) return 'other';
  // 屏幕上 1 米有多少像素（按头和腰的距离估）
  const px = screenOf(b.Head_M, _p).distanceTo(screenOf(b.Root_M, _p2)) / Math.max(0.2, b.Head_M.getWorldPosition(new THREE.Vector3()).distanceTo(b.Root_M.getWorldPosition(new THREE.Vector3())));
  const near = (bone, up, r) => bone && Math.hypot(screenOf(bone, _p, up).x - x, _p.y - y) < r * px;
  if (near(b.Head_M, 0.09, 0.13)) return 'head';
  if (near(b.Wrist_L, -0.04, 0.09)) return 'hand_l';
  if (near(b.Wrist_R, -0.04, 0.09)) return 'hand_r';
  // 大致在身体范围内
  const top = screenOf(b.Head_M, _p, 0.25).y, cx = screenOf(b.Root_M, _p2).x;
  if (y > top && Math.abs(x - cx) < 0.3 * px) return 'body';
  return 'other';
}
// ───────── 手指左右滑：转动角色（所有衣服都一样，转的是整个角色） ─────────
// 往右滑，她的正面跟着手指往右转。滑得快松手后会带着惯性转一会儿。只是轻点（几乎没动）才算点击。
const DRAG = { degPerPx: 0.6, startPx: 10, friction: 3.5, maxSpin: 900 };
const drag = { id: null, x: 0, y: 0, lastX: 0, lastT: 0, on: false, spin: 0, v: 0 };
addEventListener('pointerdown', (e) => {
  if (drag.id !== null) return;   // 第二根手指不管
  drag.id = e.pointerId; drag.x = drag.lastX = e.clientX; drag.y = e.clientY; drag.lastT = performance.now();
  drag.on = false; drag.v = 0; drag.spin = 0;
});
addEventListener('pointermove', (e) => {
  if (e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.on && Math.abs(dx) > DRAG.startPx && Math.abs(dx) > Math.abs(dy)) {
    drag.on = true; drag.lastX = e.clientX; drag.lastT = performance.now();
    if (avatar) avatar.motion.touch();
  }
  if (!drag.on) return;
  const now2 = performance.now(), step = e.clientX - drag.lastX;
  S.turn += step * DRAG.degPerPx;
  const dtm = Math.max(1, now2 - drag.lastT);
  drag.v = drag.v * 0.6 + (step * DRAG.degPerPx / dtm * 1000) * 0.4;   // 度每秒，平滑一下
  drag.lastX = e.clientX; drag.lastT = now2;
});
function endDrag(e) {
  if (e.pointerId !== drag.id) return false;
  drag.id = null;
  if (!drag.on) return false;
  drag.on = false;
  // 停下来再松手就没有惯性
  drag.spin = performance.now() - drag.lastT > 120 ? 0 : clamp(drag.v, -DRAG.maxSpin, DRAG.maxSpin);
  return true;
}
addEventListener('pointercancel', (e) => { endDrag(e); });
addEventListener('pointerup', (e) => {
  if (endDrag(e)) return;   // 是滑动，不算点击
  const part = partAt(e.clientX, e.clientY);
  // 闲着的时候才有反应；正在聊天时点一下是「打断」，不要乱动
  if (S.state === 'idle' && !S.speaking && avatar && !avatar.motion.busy) {
    if (part === 'head') act('touch_head');
    else if (part === 'hand_l') act('touch_hand_l');
    else if (part === 'hand_r') act('touch_hand_r');
    else act('wave');
  }
  if (avatar) avatar.motion.touch();
  send({ type: 'touch', part });
});
addEventListener('message', (e) => { if (e.data && typeof e.data === 'object' && e.data.type) apply(e.data); });

window.YunlaiFace = {
  apply,
  stopDemo: () => { CFG.demo = false; },
  get: () => ({
    state: S.state, emotion: S.emotion, link: S.link, loaded: !!avatar, outfit: avatar && avatar.id,
    action: avatar && avatar.motion.one ? avatar.motion.one.getClip().name : '', stats: avatar && avatar.stats,
    bg: scene3.current, bgWant: scene3.want, bgs: SCENE_IDS, view: rig.get(), turn: Math.round(wrapDeg(S.turn)), look: S.look.until > now() ? { x: S.look.x, y: S.look.y } : null,
    actions: Object.keys(ACTIONS), shots: SHOTS, clips: avatar ? Object.keys(avatar.clips) : [],
  }),
  // 调试用：把某个动画定在某一秒（截图看姿势）
  _pose: (clip, time) => { if (!avatar || !avatar.clips[clip] || avatar.clips[clip].faceOnly) return false; CFG.fidget = 0; avatar.motion.play(clip, true); avatar.motion.one.time = time; avatar.motion.one.paused = true; return true; },
  _avatar: () => avatar, _camera: () => rig,
};

resize();
tick();
loadDances().then(() => setOutfit(wantOutfit)).then(() => {
  send({ type: 'face_ready', kind: 'yuki' });
  connect();
  setTimeout(demo, 2000);
});
