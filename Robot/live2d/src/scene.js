// 背景（场景）：每张背景图记下「地板上人站的那个点」在图里的位置，换算到屏幕上，让她的脚踩在地板上。
// 背景用 CSS 的 cover 铺满屏幕，不同手机长宽比不一样，裁掉的部分也不一样，所以每次窗口变了都重新算。
// 还会按场景给角色调一下光（夜里偏冷偏暗、黄昏偏暖），免得像贴上去的。
import { CAM } from './camera.js';
import { TOON } from './toon.js';

// fx、fy：人站的点在图里的位置（0～1，从左、从上量）。size：全身时人占屏幕高度的多少。grade：给角色的光乘上的颜色
export const SCENES = {
  city: { src: 'bg.jpg', fx: 0.5, fy: 0.84, size: 0.8, grade: [1.0, 0.975, 0.94], rim: [1.0, 0.93, 0.82] },
  room_dawn: { src: 'bg/room_dawn.jpg', fx: 0.52, fy: 0.915, size: 0.74, grade: [1.03, 0.95, 0.95], rim: [1.0, 0.85, 0.85] },
  room_day: { src: 'bg/room_day.jpg', fx: 0.52, fy: 0.915, size: 0.74, grade: [1.04, 0.97, 0.9], rim: [1.0, 0.86, 0.6] },
  room_night: { src: 'bg/room_night.jpg', fx: 0.52, fy: 0.915, size: 0.74, grade: [0.74, 0.78, 0.98], rim: [1.0, 0.75, 0.45] },
  room_lamp: { src: 'bg/room_lamp.jpg', fx: 0.5, fy: 0.93, size: 0.78, grade: [0.92, 0.86, 0.95], rim: [1.0, 0.78, 0.55] },   // 书架和床、暖色小灯（William 发的）
  gothic: { src: 'bg/gothic.jpg', fx: 0.58, fy: 0.92, size: 0.72, grade: [0.72, 0.7, 0.9], rim: [0.75, 0.8, 1.0] },
};
// auto：卧室跟着手机的时间变（早上、白天、傍晚、夜里）
export const SCENE_IDS = ['auto', ...Object.keys(SCENES)];

export function autoScene(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 6 && h < 9.5) return 'room_dawn';
  if (h >= 9.5 && h < 17) return 'room_day';
  if (h >= 17 && h < 19) return 'room_dawn';
  return 'room_night';
}

export class Scene {
  constructor(el, onLayout) {
    this.el = el; this.onLayout = onLayout;
    this.want = 'auto'; this.id = ''; this.img = null; this.sizes = {};
    setInterval(() => { if (this.want === 'auto') this.set('auto'); }, 60000);   // 自动模式每分钟看一眼时间
  }

  get current() { return this.id; }

  /// 换背景。id 是 SCENE_IDS 里的一个；不认识的当成 auto。返回实际用的场景
  set(id) {
    if (!SCENE_IDS.includes(id)) id = 'auto';
    this.want = id;
    const real = id === 'auto' ? autoScene() : id;
    if (real === this.id) return real;
    this.id = real;
    const s = SCENES[real];
    const img = new Image();
    img.onload = () => {
      if (this.id !== real) return;
      this.sizes[real] = [img.naturalWidth, img.naturalHeight];
      this.el.style.backgroundImage = `url(${s.src})`;
      this.layout();
    };
    img.src = s.src;
    // 光的颜色马上换（材质共用这两个对象）
    TOON.grade.set(...s.grade);
    TOON.rimColor.setRGB(...s.rim);
    return real;
  }

  /// 窗口大小变了、换了背景：重新算背景怎么摆，以及脚该落在屏幕的哪里
  layout() {
    const s = SCENES[this.id], size = this.sizes[this.id];
    if (!s || !size) return;
    const W = innerWidth, H = innerHeight, [iw, ih] = size;
    const k = Math.max(W / iw, H / ih), dw = iw * k, dh = ih * k;
    // 横向：尽量让人站的点在屏幕正中间（角色就站在中间），不能露出图外面的空白
    const ox = Math.min(0, Math.max(W - dw, W / 2 - s.fx * dw));
    const oy = (H - dh) / 2;   // 竖直方向居中裁
    this.el.style.backgroundSize = `${dw}px ${dh}px`;
    this.el.style.backgroundPosition = `${ox}px ${oy}px`;
    CAM.feetAt = (oy + s.fy * dh) / H;
    CAM.fullHeight = 1 / s.size;
    // 人站的点因为图到边了没法放到正中间时，把角色往那边挪（屏幕坐标里的偏移，0 = 正中）
    this.shiftX = (ox + s.fx * dw) / W - 0.5;
    if (this.onLayout) this.onLayout();
  }
}
