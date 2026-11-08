// Yunlai Robot 的 Live2D 面部：接入层。
// 显示、待机动作、眨眼、物理、视线、口型都交给开源库 pixi-live2d-display（lipsync 分支），
// 这里只做两件事：把说明书里的 robot_state 消息翻译成模型参数；连 WebSocket。
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4';

window.PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

// ───────── 配置（网址参数） ─────────
const Q = new URLSearchParams(location.search);
const wsParam = Q.get('ws');
const CFG = {
  ws: wsParam === 'auto' ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' : wsParam || '',
  model: Q.get('model') || 'models/hiyori_free_zh/runtime/hiyori_free_t08.model3.json',
  demo: Q.has('demo') ? Q.get('demo') !== '0' : !wsParam,
  fps: Number(Q.get('fps')) || 30,
  idleAfter: (Number(Q.get('idle')) || 45) * 1000,
};

// ───────── 状态和情绪 → 模型参数（只写偏移量，其余交给模型自带的待机动作） ─────────
const STATES = {
  idle: {},
  listening: { ParamBrowLForm: 0.4, ParamBrowRForm: 0.4, ParamAngleZ: 6 },
  thinking: { ParamAngleZ: -8, ParamMouthForm: -0.3, ParamBrowLForm: -0.2 },
  speaking: {},
  observing: { ParamBrowLForm: -0.2, ParamBrowRForm: -0.2 },
};
const EMOTIONS = {
  neutral: {},
  happy: { ParamEyeLSmile: 1, ParamEyeRSmile: 1, ParamMouthForm: 1, ParamCheek: 1 },
  alert: { ParamBrowLForm: -1, ParamBrowRForm: -1, ParamMouthForm: -0.6 },
  surprised: { ParamBrowLForm: 1, ParamBrowRForm: 1, ParamMouthOpenY: 0.6 },
  confused: { ParamBrowLForm: -0.7, ParamBrowRForm: 0.7, ParamAngleZ: 12, ParamMouthForm: -0.4 },
};
const PARAMS = [...new Set([...Object.values(STATES), ...Object.values(EMOTIONS)].flatMap(Object.keys))];

const S = {
  state: 'idle', emotion: 'neutral', emotionUntil: 0, emotionBack: 'neutral',
  gaze: { x: 0, y: 0, at: -1e9 }, gimbal: { x: 0, y: 0, at: -1e9 },
  mouth: 0, mouthAt: -1e9, speaking: false, link: CFG.ws ? 'connecting' : 'none', lastInput: 0,
};
const cur = Object.fromEntries(PARAMS.map((p) => [p, 0]));
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
    if (msg.name === 'person_detected') S.gaze = { x: clamp(+msg.x || 0, -1, 1), y: clamp(+msg.y || 0, -1, 1), at: t };
  } else if (type === 'speak' && msg.url && model) {
    // 真实语音：库自己分析音量驱动嘴型
    S.state = 'speaking'; S.speaking = true;
    model.speak(String(msg.url), { crossOrigin: 'anonymous', onFinish: endSpeak, onError: endSpeak });
  } else if (type === 'outfit') {
    // 换装：{"type":"outfit","id":"heibai"}，id 见 outfits/index.json，"default" 是原版
    setOutfit(String(msg.id || 'default'));
  } else if (type === 'sensing') {
    if ('camera' in msg) document.getElementById('pill-cam').classList.toggle('on', !!msg.camera);
    if ('mic' in msg) document.getElementById('pill-mic').classList.toggle('on', !!msg.mic);
  } else return false;
  return true;
}
// ───────── 换装：只换贴图上衣服那几块 ─────────
// outfits/<id>/clothes.png 是 2048×2048 的衣服层（衣服范围内不透明，别处透明，只有 AI 画的衣服，不含 Live2D 原图）。
// 用 source-atop 盖到原贴图上：颜色换成新衣服，透明度沿用原贴图，所以轮廓、动作、物理都不变。
let wantOutfit = 'default';
let originalTexture = null;
const outfitTextures = {};
function loadImage(src) {
  return new Promise((ok, fail) => { const img = new Image(); img.onload = () => ok(img); img.onerror = fail; img.src = src; });
}
async function setOutfit(id) {
  wantOutfit = id;
  if (!model) return;   // 模型加载完会再换
  if (!originalTexture) originalTexture = model.textures[0];
  try {
    if (id !== 'default' && !outfitTextures[id]) {
      const clothes = await loadImage(`outfits/${encodeURIComponent(id)}/clothes.png`);
      const src = originalTexture.baseTexture.resource.source;
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      const g = c.getContext('2d');
      g.drawImage(src, 0, 0);
      g.globalCompositeOperation = 'source-atop';
      g.drawImage(clothes, 0, 0, c.width, c.height);
      outfitTextures[id] = PIXI.Texture.from(c);
    }
    if (wantOutfit !== id) return;   // 加载期间又换了别的
    model.textures[0] = id === 'default' ? originalTexture : outfitTextures[id];
    send({ type: 'outfit_done', id, ok: true });
  } catch (e) {
    console.error('换装失败', id, e);
    send({ type: 'outfit_done', id, ok: false, error: String((e && e.message) || e) });
  }
}

function endSpeak() { S.speaking = false; if (S.state === 'speaking') S.state = 'idle'; send({ type: 'speak_end' }); }
function setEmotion(name, ms) {
  if (ms) { if (!S.emotionUntil) S.emotionBack = S.emotion; S.emotionUntil = now() + ms / 1000; } else S.emotionUntil = 0;
  S.emotion = name;
}
function goIdle() { S.state = 'idle'; setEmotion('neutral'); S.gaze.at = -1e9; S.gimbal.at = -1e9; }

// ───────── 每帧：在模型自带动作之上叠加参数 ─────────
function beforeModelUpdate() {
  const t = now(), dt = 1 / CFG.fps;
  if (S.emotionUntil && t > S.emotionUntil) { S.emotionUntil = 0; S.emotion = S.emotionBack; }
  if (!CFG.demo && t - S.lastInput > CFG.idleAfter / 1000 && !S.speaking && (S.state !== 'idle' || S.emotion !== 'neutral')) goIdle();

  const target = { ...STATES[S.state] };
  for (const [k, v] of Object.entries(EMOTIONS[S.emotion])) target[k] = (target[k] || 0) + v;

  // 说话时嘴型：有 mouth_level 用它；没有真实音频时用合成的音节节奏
  let mouth = 0;
  if (t - S.mouthAt < 0.5) mouth = S.mouth;
  else if (S.state === 'speaking' && !S.speaking) mouth = Math.max(0, Math.sin(t * 9.3) * Math.sin(t * 3.7 + 1)) * 0.9;
  if (mouth > 0) target.ParamMouthOpenY = Math.max(target.ParamMouthOpenY || 0, mouth);

  const core = model.internalModel.coreModel;
  for (const p of PARAMS) {
    cur[p] += ((target[p] || 0) - cur[p]) * Math.min(1, dt * (p === 'ParamMouthOpenY' ? 20 : 6));
    if (Math.abs(cur[p]) > 0.001) core.addParameterValueById(p, cur[p]);
  }

  // 视线：库自带的视线控制（同时转头、转身、转眼珠）。Live2D 的 y 向上为正
  let gx = 0, gy = 0;
  if (t - S.gaze.at < 4) { gx = S.gaze.x; gy = S.gaze.y; }
  else if (t - S.gimbal.at < 6) { gx = S.gimbal.x; gy = S.gimbal.y; }
  else if (S.state === 'thinking') { gx = 0.5 * Math.sin(t * 0.5); gy = -0.5; }
  else if (S.state === 'observing') { gx = 0.7 * Math.sin(t * 0.45); }
  model.internalModel.focusController.focus(gx, -gy);
}

// ───────── 画面 ─────────
const app = new PIXI.Application({
  view: document.getElementById('stage'), resizeTo: window, backgroundAlpha: 0,
  antialias: true, autoDensity: true, resolution: Math.min(devicePixelRatio || 1, 2),
});
PIXI.Ticker.shared.maxFPS = CFG.fps;   // iPhone 7 Plus 默认 30 FPS，?fps=60 可提高
let model = null;

function layout() {
  if (!model) return;
  const W = innerWidth, H = innerHeight;
  const w0 = model.internalModel.originalWidth, h0 = model.internalModel.originalHeight;
  // 显示全身，脚落在背景地板那圈光环上（大约屏幕高度 84% 的地方）
  const scale = Math.min((H * 0.8) / h0, W / (w0 * 0.45));
  model.scale.set(scale);
  model.anchor.set(0.5, 0);
  model.position.set(W / 2, H * 0.06);
}
addEventListener('resize', layout);

// ───────── WebSocket：断线回到待机，自动重连 ─────────
let ws = null, backoff = 1000;
function connect() {
  if (!CFG.ws) return;
  ws = new WebSocket(CFG.ws);
  ws.onopen = () => { S.link = 'online'; backoff = 1000; send({ type: 'face_ready', kind: 'live2d' }); };
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

// 点一下：播放模型自带的「Tap」动作
addEventListener('pointerup', () => { if (model) model.motion('Tap'); send({ type: 'touch' }); });
addEventListener('message', (e) => { if (e.data && typeof e.data === 'object' && e.data.type) apply(e.data); });

window.YunlaiFace = {
  apply,
  stopDemo: () => { CFG.demo = false; },
  get: () => ({ state: S.state, emotion: S.emotion, link: S.link, loaded: !!model }),
};

Live2DModel.from(CFG.model, { autoInteract: false }).then((m) => {
  model = m;
  if (Q.get('debug') === '1') window.__live2dModel = m;   // 调试用（比如找贴图上每块衣服的位置）
  app.stage.addChild(model);
  model.internalModel.on('beforeModelUpdate', beforeModelUpdate);
  layout();
  document.getElementById('loading').style.display = 'none';
  if (wantOutfit !== 'default') setOutfit(wantOutfit);
  send({ type: 'face_ready', kind: 'live2d' });
  connect();
  setTimeout(demo, 2000);
}).catch((e) => {
  console.error(e);
  document.getElementById('loading').textContent = '模型加载失败：先运行 sh fetch-assets.sh';
});
