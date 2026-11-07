// Yunlai Robot 状态大脑：消息协议、状态机、视线、眨眼、嘴型音量、WebSocket、演示。
// 不管画面怎么画（2D 眼睛或 3D 角色），都读这里的数值。协议和 ../face/index.html 一致。

export const STATE_NAMES = ['idle', 'listening', 'thinking', 'speaking', 'observing'];
export const EMOTION_NAMES = ['neutral', 'happy', 'alert', 'surprised', 'confused'];

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function clamp01(v) { return clamp(v, 0, 1); }
export function rand(a, b) { return a + Math.random() * (b - a); }
export function approach(cur, target, rate, dt) { return cur + (target - cur) * (1 - Math.exp(-rate * dt)); }
export function wobble(t, s) {
  return (Math.sin(t * 1.7 + s) + Math.sin(t * 2.9 + s * 2.3) * 0.6 + Math.sin(t * 5.3 + s * 0.7) * 0.3) / 1.9;
}
export function easeOut(t) { t = clamp01(t); return 1 - (1 - t) * (1 - t) * (1 - t); }
function now() { return performance.now() / 1000; }

export function readConfig() {
  const Q = new URLSearchParams(location.search);
  const ws = Q.get('ws');
  const wsUrl = ws === 'auto' ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' : ws || '';
  return {
    query: Q,
    ws: wsUrl,
    demo: Q.has('demo') ? Q.get('demo') !== '0' : !wsUrl,
    fps: Q.get('fps') || 'auto',
    debug: Q.get('debug') === '1',
    idleAfter: (Number(Q.get('idle')) || 45) * 1000,
    mic: Q.get('mic') === '1',
  };
}

export function createBrain(CFG, hooks = {}) {
  const S = {
    state: 'idle', emotion: 'neutral', emotionUntil: 0, emotionBack: 'neutral',
    lastInput: now(),
    link: CFG.ws ? 'connecting' : 'none',
    ext: { x: 0, y: 0, at: -1e9 },
    gimbal: { x: 0, y: 0, at: -1e9 },
    mouthExt: 0, mouthExtAt: -1e9,
    mouth: 0,
    micLevel: 0, audioLevel: 0, audioPlaying: false,
    flash: 0,
    camera: false, micOn: false,
    gaze: { x: 0, y: 0 },
    blink: 0,
    stateAt: now(),
  };
  const gazeT = { x: 0, y: 0 };
  let gazeRate = 14, nextSaccade = 0, nextBlink = 2, blinkStart = -1, blinkQueue = 0;
  const blinkDur = 0.17;

  function emit(name, ...args) { if (hooks[name]) hooks[name](...args); }

  function setState(name) {
    if (!STATE_NAMES.includes(name) || name === S.state) return;
    const prev = S.state;
    S.state = name; S.stateAt = now();
    if (prev !== 'idle' || name !== 'idle') maybeBlink(0.6);
    if (name === 'thinking') nextSaccade = 0;
    emit('onState', name, prev);
  }

  function setEmotion(name, ms) {
    if (!EMOTION_NAMES.includes(name)) return;
    if (ms) {
      S.emotionBack = S.emotionUntil ? S.emotionBack : S.emotion;
      S.emotionUntil = now() + ms / 1000;
    } else S.emotionUntil = 0;
    if (name !== S.emotion) {
      if (name === 'alert' || name === 'surprised') { S.flash = 1; blinkStart = -1; }
      if (name === 'happy') maybeBlink(0.5);
      const prev = S.emotion;
      S.emotion = name;
      emit('onEmotion', name, prev);
    }
  }

  function setGaze(x, y) {
    S.ext.x = clamp(Number(x) || 0, -1, 1);
    S.ext.y = clamp(Number(y) || 0, -1, 1);
    S.ext.at = now();
  }

  function maybeBlink(p) { if (Math.random() < p && blinkStart < 0) blinkStart = now(); }

  // {"type":"robot_state","state":"speaking","emotion":"happy","gaze":{"x":.2,"y":-.1},"mouth_level":.65}
  function apply(msg) {
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return false; } }
    if (!msg || typeof msg !== 'object') return false;
    const type = msg.type || (msg.state || msg.emotion ? 'robot_state' : '');
    const t = now();
    S.lastInput = t;
    switch (type) {
      case 'robot_state':
        if (msg.state) setState(String(msg.state).toLowerCase());
        if ('emotion' in msg) setEmotion(String(msg.emotion || 'neutral').toLowerCase(), Number(msg.duration_ms) || 0);
        if (msg.gaze && typeof msg.gaze === 'object') setGaze(msg.gaze.x, msg.gaze.y);
        if (typeof msg.mouth_level === 'number') { S.mouthExt = clamp01(msg.mouth_level); S.mouthExtAt = t; }
        break;
      case 'gimbal':
        S.gimbal.x = clamp((Number(msg.yaw) || 0) / 35, -1, 1);
        S.gimbal.y = clamp(-(Number(msg.pitch) || 0) / 30, -1, 1);
        S.gimbal.at = msg.connected === false ? -1e9 : t;
        break;
      case 'event':
        onEvent(String(msg.name || msg.event || ''), msg);
        break;
      case 'speak':
        if (msg.url) playAudio(String(msg.url));
        setState('speaking');
        break;
      case 'sensing':
        if ('camera' in msg) S.camera = !!msg.camera;
        if ('mic' in msg) S.micOn = !!msg.mic;
        emit('onSensing', S.camera, S.micOn);
        break;
      default:
        return false;
    }
    return true;
  }

  function onEvent(name, msg) {
    switch (name) {
      case 'boot': emit('onBoot'); break;
      case 'person_detected':
      case 'object_detected':
        setGaze(msg.x, msg.y);
        if (S.state === 'idle') { S.flash = Math.max(S.flash, 0.35); maybeBlink(0.5); }
        break;
      case 'person_lost': S.ext.at = -1e9; break;
      case 'sound':
      case 'voice_start': setState('listening'); break;
      case 'voice_end':
      case 'speech_end': setState('thinking'); break;
      case 'answer_start': setState('speaking'); break;
      case 'answer_end': setState('idle'); break;
      case 'gimbal_left': S.gimbal.x = -0.8; S.gimbal.y = 0; S.gimbal.at = now(); break;
      case 'gimbal_right': S.gimbal.x = 0.8; S.gimbal.y = 0; S.gimbal.at = now(); break;
      case 'gimbal_center': S.gimbal.x = 0; S.gimbal.y = 0; S.gimbal.at = now(); break;
      case 'gimbal_lost': S.gimbal.at = -1e9; break;
      case 'anomaly': setEmotion('alert', Number(msg.duration_ms) || 3000); break;
      case 'idle': goIdle(); break;
    }
  }

  function goIdle() {
    setState('idle');
    setEmotion('neutral');
    S.ext.at = -1e9;
    S.mouthExtAt = -1e9;
  }

  // ───────── 每帧 ─────────
  function update(dt) {
    const t = now();
    if (S.emotionUntil && t > S.emotionUntil) { S.emotionUntil = 0; setEmotion(S.emotionBack || 'neutral'); }
    if (!CFG.demo && t - S.lastInput > CFG.idleAfter / 1000 && !S.audioPlaying &&
        (S.state !== 'idle' || S.emotion !== 'neutral')) goIdle();
    S.flash = approach(S.flash, 0, 3, dt);
    updateGaze(dt, t);
    updateBlink(t);
    updateMouth(dt, t);
  }

  function updateGaze(dt, t) {
    const extFresh = t - S.ext.at < 4, gimFresh = t - S.gimbal.at < 6, st = S.state;
    if (st === 'thinking' && !extFresh) {
      gazeT.x = 0.42 * Math.sin(t * 0.55) + 0.12 * wobble(t * 0.4, 3);
      gazeT.y = -0.42 + 0.12 * Math.sin(t * 0.9);
      gazeRate = 3;
    } else if (extFresh) {
      gazeT.x = S.ext.x + 0.03 * wobble(t * 2, 1);
      gazeT.y = S.ext.y + 0.03 * wobble(t * 2, 2);
      gazeRate = 12;
    } else if (gimFresh) {
      gazeT.x = S.gimbal.x; gazeT.y = S.gimbal.y; gazeRate = 8;
    } else if (st === 'observing') {
      gazeT.x = 0.7 * Math.sin(t * 0.45); gazeT.y = 0.08 * Math.sin(t * 0.8); gazeRate = 5;
    } else if (st === 'listening' || st === 'speaking') {
      if (t > nextSaccade) { gazeT.x = rand(-0.08, 0.08); gazeT.y = rand(-0.02, 0.1); nextSaccade = t + rand(0.8, 2.2); }
      gazeRate = 12;
    } else {
      if (t > nextSaccade) {
        const back = Math.random() < 0.4;
        const nx = back ? 0 : rand(-0.45, 0.45), ny = back ? 0 : rand(-0.25, 0.2);
        if (Math.abs(nx - gazeT.x) > 0.4) maybeBlink(0.45);
        gazeT.x = nx; gazeT.y = ny;
        nextSaccade = t + rand(1.4, 4.2);
      }
      gazeRate = 12;
    }
    S.gaze.x = approach(S.gaze.x, gazeT.x, gazeRate, dt);
    S.gaze.y = approach(S.gaze.y, gazeT.y, gazeRate, dt);
  }

  function updateBlink(t) {
    if (blinkStart < 0 && t > nextBlink) { blinkStart = t; blinkQueue = Math.random() < 0.15 ? 1 : 0; }
    if (blinkStart >= 0 && t - blinkStart > blinkDur) {
      blinkStart = -1;
      if (blinkQueue > 0) { blinkQueue--; nextBlink = t + 0.09; }
      else nextBlink = t + rand(2.4, 6) * (S.state === 'listening' || S.emotion === 'alert' ? 1.6 : 1);
    }
    if (blinkStart < 0) S.blink = 0;
    else {
      const p = (t - blinkStart) / blinkDur;
      S.blink = p < 0.4 ? easeOut(p / 0.4) : 1 - easeOut((p - 0.4) / 0.6);
    }
  }

  function updateMouth(dt, t) {
    let target = 0;
    if (S.audioPlaying && S.audioLevel > 0) target = S.audioLevel;
    else if (t - S.mouthExtAt < 0.5) target = S.mouthExt;
    else if (S.state === 'speaking') {
      const syl = Math.abs(Math.sin(t * 9.3) * Math.sin(t * 3.7 + 1));
      const pause = Math.sin(t * 0.9) > -0.55 ? 1 : 0.1;
      target = clamp01((0.12 + 0.7 * syl + 0.1 * wobble(t * 3, 5)) * pause);
    }
    if (S.state !== 'speaking' && !S.audioPlaying) target = 0;
    S.mouth = approach(S.mouth, target, target > S.mouth ? 26 : 12, dt);
  }

  // ───────── WebSocket：断线回到待机，自动重连 ─────────
  let ws = null, backoff = 1000;
  function connect() {
    if (!CFG.ws) return;
    S.link = 'connecting';
    try { ws = new WebSocket(CFG.ws); } catch (e) { retry(); return; }
    ws.onopen = () => { S.link = 'online'; backoff = 1000; send({ type: 'face_ready', kind: 'avatar', screen: [innerWidth, innerHeight] }); };
    ws.onmessage = (e) => apply(e.data);
    ws.onclose = () => { ws = null; S.link = 'offline'; goIdle(); S.gimbal.at = -1e9; retry(); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* 忽略 */ } };
  }
  function retry() { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); }
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    try { window.webkit.messageHandlers.yunlai.postMessage(obj); } catch (e) { /* 不在 App 里 */ }
  }

  // ───────── 音频：TTS 振幅驱动嘴型 ─────────
  let actx = null, analyser = null, abuf = null, audioEl = null, micAn = null, micBuf = null;
  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!actx) {
      actx = new AC();
      analyser = actx.createAnalyser(); analyser.fftSize = 512;
      abuf = new Uint8Array(analyser.fftSize);
      analyser.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
  }
  function playAudio(url) {
    try {
      if (audioEl) audioEl.pause();
      audioEl = new Audio();
      audioEl.crossOrigin = 'anonymous';
      audioEl.src = url;
      if (actx) actx.createMediaElementSource(audioEl).connect(analyser);
      audioEl.onplay = () => { S.audioPlaying = true; };
      audioEl.onended = audioEl.onerror = () => {
        S.audioPlaying = false; S.audioLevel = 0;
        if (S.state === 'speaking') setState('idle');
        send({ type: 'speak_end', url });
      };
      const p = audioEl.play();
      if (p && p.catch) p.catch(() => { S.audioPlaying = false; });
    } catch (e) { S.audioPlaying = false; }
  }
  function rmsOf(an, buf) {
    an.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / buf.length);
  }
  setInterval(() => {
    if (S.audioPlaying && analyser) S.audioLevel = clamp01(rmsOf(analyser, abuf) * 4);
    if (micAn) S.micLevel = clamp01(rmsOf(micAn, micBuf) * 6);
  }, 33);
  function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    unlockAudio();
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      micAn = actx.createAnalyser(); micAn.fftSize = 512; micBuf = new Uint8Array(512);
      actx.createMediaStreamSource(stream).connect(micAn);
      S.micOn = true; emit('onSensing', S.camera, S.micOn);
    }).catch(() => {});
  }

  // ───────── 演示 ─────────
  const DEMO = [
    [3.0, { type: 'robot_state', state: 'idle', emotion: 'neutral' }],
    [2.6, { type: 'event', name: 'person_detected', x: -0.45, y: 0.05 }],
    [3.2, { type: 'event', name: 'voice_start' }],
    [3.6, { type: 'event', name: 'speech_end' }],
    [4.4, { type: 'robot_state', state: 'speaking', emotion: 'neutral', gaze: { x: 0, y: 0.05 } }],
    [2.6, { type: 'robot_state', state: 'speaking', emotion: 'happy' }],
    [1.6, { type: 'robot_state', state: 'observing', emotion: 'neutral' }],
    [1.8, { type: 'gimbal', yaw: -30, pitch: 0 }],
    [1.8, { type: 'gimbal', yaw: 30, pitch: 5 }],
    [1.6, { type: 'gimbal', yaw: 0, pitch: 0 }],
    [2.4, { type: 'event', name: 'anomaly', duration_ms: 2400 }],
    [2.4, { type: 'robot_state', state: 'idle', emotion: 'surprised', duration_ms: 1400 }],
    [2.8, { type: 'robot_state', state: 'thinking', emotion: 'confused' }],
    [3.0, { type: 'robot_state', state: 'idle', emotion: 'happy', duration_ms: 2200 }],
  ];
  let demoTimer = null, demoI = 0;
  function demoStep() {
    if (!CFG.demo) return;
    const step = DEMO[demoI % DEMO.length];
    apply(step[1]);
    if (step[1].type !== 'gimbal' && step[1].type !== 'event') S.gimbal.at = -1e9;
    demoI++;
    demoTimer = setTimeout(demoStep, step[0] * 1000);
  }
  function startDemo(delay) { if (CFG.demo) demoTimer = setTimeout(demoStep, delay); }
  function stopDemo() { CFG.demo = false; if (demoTimer) clearTimeout(demoTimer); demoTimer = null; }

  // ───────── 键盘（调试用） ─────────
  const KEYS = { 1: 'idle', 2: 'listening', 3: 'thinking', 4: 'speaking', 5: 'observing' };
  const EKEYS = { 6: 'happy', 7: 'alert', 8: 'surprised', 9: 'confused', 0: 'neutral' };
  let yaw = 0;
  addEventListener('keydown', (e) => {
    const k = e.key;
    if (KEYS[k] || EKEYS[k] || k === 'b' || k === 'ArrowLeft' || k === 'ArrowRight') stopDemo();
    if (KEYS[k]) apply({ type: 'robot_state', state: KEYS[k] });
    else if (EKEYS[k]) apply({ type: 'robot_state', emotion: EKEYS[k] });
    else if (k === 'b') emit('onBoot');
    else if (k === 'd') emit('onToggleDebug');
    else if (k === 'ArrowLeft') { yaw = Math.max(yaw - 15, -45); apply({ type: 'gimbal', yaw, pitch: 0 }); }
    else if (k === 'ArrowRight') { yaw = Math.min(yaw + 15, 45); apply({ type: 'gimbal', yaw, pitch: 0 }); }
  });

  // 原生 App（WKWebView）可调用 window.YunlaiFace.apply(...)，或 postMessage
  addEventListener('message', (e) => { if (e.data && typeof e.data === 'object' && e.data.type) apply(e.data); });

  return {
    S, CFG, apply, setState, setEmotion, goIdle, update, connect, send,
    unlockAudio, startMic, startDemo, stopDemo,
    poke() { blinkStart = now(); if (S.emotion === 'neutral') setEmotion('happy', 1200); send({ type: 'touch' }); },
  };
}
