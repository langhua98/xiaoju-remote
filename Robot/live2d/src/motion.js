// 动作状态机。三层：
//   基础层：idle ↔ Yuki_Idle_listening_v3（循环，交叉淡入 0.5 秒）
//   动作层：一次性动作（打招呼、点头、跳舞、被摸的反应…），播完淡回基础层；可以排队连着播
//   程序层：视线、眨眼、口型、辅助骨骼、物理（在别的文件里，动画之后叠加）
import * as THREE from 'three';

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// 不用的动画：两个不合适的；Show / Hide / Hidden 是原作出入场用的，从 T 字姿势开始，单独播很怪
export const BANNED = ['Touch_breast', 'Touch_pants', 'Show', 'Hide', 'Hidden'];
// 好记的名字 → 动画（数组表示随机挑一个，嵌套数组表示连着播）
export const ACTIONS = {
  wave: ['hello'], hello: ['hello'], nod: ['Yes'], yes: ['Yes'], shake: ['No'], no: ['No'],
  angry: ['Yuki_Angry_With_Mouth'], kiss: ['Kiss'], peace: ['Peace_hand'], pose: ['Hand_Pose'],
  dance: ['dance_90bpm', 'dance_120bpm', 'f_vibe_dance_60_bpm_002'],
  phone: [['Tapping_Start', 'Tapping_Idle', 'Tapping_End']], call: ['Phone_talking'],
  play: ['yuki_play'], read: ['np'], popcorn: ['yuki_popcorn_idle'],
  touch_head: ['Touch_head'], touch_hand_l: ['Touch_hand_L'], touch_hand_r: ['Touch_hand_R'],
  touch_leg_l: ['Touch_leg_L'], touch_leg_r: ['Touch_leg_R'],
};
// 待机时每隔一会儿随机插入的小动作，和很久没人理时做的事
export const MOTION = {
  fidgetEvery: [15, 40], fidgets: ['pose', 'peace', 'pose', 'wave'],
  boredAfter: [60, 120], bored: ['phone', 'play', 'read', 'popcorn'],
  fadeIn: 0.3, fadeOut: 0.45, baseFade: 0.5,
};

export class Motion {
  constructor(mixer, clips) {
    this.mixer = mixer; this.clips = clips;
    this.baseName = ''; this.base = null;   // 基础层现在的动作
    this.one = null; this.queue = [];       // 动作层：正在播的和排着队的
    this.current = null;                    // 现在权重最高的那个动作
    this.overlay = 1;                       // 程序层对头部的叠加权重（播一次性动作时降到 0.3）
    this.wide = false;                      // 正在播的动作幅度大（跳舞、道具），镜头要拉回全身
    const t = performance.now() / 1000;
    this.nextFidget = t + rnd(...MOTION.fidgetEvery);
    this.boredAt = t + rnd(...MOTION.boredAfter);
  }

  get busy() { return !!this.one; }

  _fadeTo(next, dur) {
    next.enabled = true; next.setEffectiveTimeScale(1); next.setEffectiveWeight(1); next.play();
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, dur, false);
    this.current = next;
  }

  /// 基础层换成哪个循环动画
  setBase(name) {
    if (!this.clips[name] || this.baseName === name) return;
    const first = !this.base;
    const next = this.mixer.clipAction(this.clips[name]);
    next.setLoop(THREE.LoopRepeat, Infinity);
    if (first) next.time = Math.random() * this.clips[name].duration;   // 每次从不同的地方开始，不至于总是同一段
    else if (this.base) next.time = this.base.time % this.clips[name].duration;   // 两个待机一样长，接着同一个位置
    const old = this.base;
    this.base = next; this.baseName = name;
    if (this.one) { next.enabled = false; next.play(); if (old) old.stop(); }
    else this._fadeTo(next, MOTION.baseFade);
  }

  /// 播一个动作。name 可以是 ACTIONS 里的名字，也可以直接是动画名。force：打断正在播的。
  play(name, force) {
    if (this.one && !force) return false;
    let seq = ACTIONS[String(name).toLowerCase()] ? pick(ACTIONS[String(name).toLowerCase()]) : name;
    seq = [].concat(seq).filter((n) => this.clips[n] && !BANNED.includes(n));
    if (!seq.length) return false;
    if (this.clips[seq[0]].faceOnly) return this.playFace(seq[0]);
    this.queue = seq.slice(1);
    this._start(seq[0]);
    this.touch();
    return true;
  }

  /// 只有表情的动画（生气）：叠在现在的动作上面播，不占动作层
  playFace(name) {
    const a = this.mixer.clipAction(this.clips[name]);
    a.reset().setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = false;
    a.setEffectiveWeight(3);   // 和待机的表情轨道按权重混合，3 比 1 = 生气的表情占四分之三
    a.fadeIn(0.15).play();
    return true;
  }

  _start(name) {
    const clip = this.clips[name];
    const a = this.mixer.clipAction(clip);
    a.reset().setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    this._fadeTo(a, this.one ? 0.2 : MOTION.fadeIn);
    this.one = a;
    this.wide = /dance|play|np|popcorn|Tapping|Phone|Peace|Hand_Pose/i.test(name);
  }

  /// 停掉动作层，回基础层（比如开始听人说话时）
  stopAction() {
    if (!this.one) return;
    this.queue = [];
    this.one = null; this.wide = false;
    if (this.base) this._fadeTo(this.base, MOTION.fadeOut);
  }

  /// 有人理她了：重新计时
  touch() {
    const t = performance.now() / 1000;
    this.nextFidget = t + rnd(...MOTION.fidgetEvery);
    this.boredAt = t + rnd(...MOTION.boredAfter);
  }

  /// 每帧在 mixer.update 之前调用。idle：现在是不是闲着（待机、没说话）
  update(t, dt, idle) {
    if (this.one) {
      const left = this.one.getClip().duration - this.one.time;
      if (this.queue.length ? left <= 0.2 : left <= MOTION.fadeOut) {
        if (this.queue.length) this._start(this.queue.shift());
        else this.stopAction();
      }
    } else if (idle) {
      if (t > this.boredAt) { this.play(pick(MOTION.bored)); this.boredAt = t + rnd(...MOTION.boredAfter); }
      else if (t > this.nextFidget) { const keep = this.boredAt; this.play(pick(MOTION.fidgets)); this.boredAt = keep; }
    } else {
      this.nextFidget = Math.max(this.nextFidget, t + 8);
    }
    this.overlay += ((this.one ? 0.3 : 1) - this.overlay) * Math.min(1, dt * 4);
  }
}
