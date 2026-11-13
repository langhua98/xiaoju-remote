// 镜头。三个景别（全身、半身、特写），可以绕着她转（orbit）、抬高或压低（tilt）。
// 自动模式：固定在半身（中景：头顶到大腿），不再推拉。手动指定景别后一直保持，直到改回自动。
// 带一点很轻的漂移，像有人拿着在呼吸。
// 相机一直在胸口的高度平视（正视）。全身时要把脚也拍进去，但不是把相机放低（那样看脸是仰视），
// 也不是低头拍（那样是俯视），而是像移轴镜头一样把画面整体往下挪（改投影矩阵），所以竖直的线还是竖直的。
import * as THREE from 'three';

export const CAM = {
  fullHeight: 1 / 0.8,     // 全身：画面高度是身高的多少倍
  feetAt: 0.84,            // 全身：脚落在屏幕从上往下多少的地方（背景地板上那圈光环）
  eyeAt: 0.74,             // 全身：相机在身高的多少（胸口到脖子之间），平视
  bustHeight: 0.66,        // 半身（头到大腿，和原作的机位一样）：画面高度是身高的多少倍
  headAt: 0.27,            // 半身：头落在屏幕从上往下多少的地方
  faceHeight: 0.3,         // 特写：画面高度是身高的多少倍
  faceAt: 0.5,             // 特写：头落在屏幕从上往下多少的地方
  ease: 2.6,               // 推拉的快慢（越大越快，大约 1 秒到位）
  turnEase: 2.0,           // 绕着转的快慢
  backAfter: 10,           // 自动模式：回到待机多少秒后拉回全身
  drift: 0.003,            // 漂移幅度（身高的多少）
  bgZoom: 0.12,            // 比半身更近（特写）时背景放大多少；半身和全身不放大
  maxOrbit: 180, minTilt: -25, maxTilt: 45,   // 度
};
export const SHOTS = ['auto', 'full', 'bust', 'face'];

const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class CameraRig {
  constructor(camera, bg) {
    this.camera = camera; this.bg = bg;
    this.shot = 'auto';     // 现在的景别设置
    this.closeAt = -1e9;    // 自动模式：最后一次需要近景的时间
    this.shots = { full: { dist: 5, y: 0, eye: 1 }, bust: { dist: 2, y: 1, eye: 1 }, face: { dist: 1, y: 1.5, eye: 1.5 } };
    this.cur = null;        // 现在的 { dist, y, eye }（平滑过去）。y：画面正中对着的高度；eye：相机自己的高度
    this.orbit = 0; this.orbitT = 0;   // 绕她转的角度（度）：正 = 镜头往屏幕右边绕，看到她的左侧
    this.tilt = 0; this.tiltT = 0;     // 镜头高低（度）：正 = 从上往下看
    this.h = 1.7; this.lastZoom = -1;
  }

  /// 换了模型或者窗口大小变了。height：身高；headY：头顶往下一点的高度（脚底为 0）
  layout(height, headY) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov), tan = 2 * Math.tan(fov / 2);
    this.h = height;
    const fullView = height * CAM.fullHeight;
    // 竖屏很窄时半身和特写不要推得太近，保证肩膀在画面里
    const narrow = (v, min) => Math.max(v, min / Math.max(0.3, this.camera.aspect));
    const bustView = narrow(height * CAM.bustHeight, height * 0.3);
    const faceView = narrow(height * CAM.faceHeight, height * 0.12);
    this.shots = {
      full: { dist: fullView / tan, y: (CAM.feetAt - 0.5) * fullView, eye: height * CAM.eyeAt },
      bust: { dist: bustView / tan, y: headY - (0.5 - CAM.headAt) * bustView },
      face: { dist: faceView / tan, y: headY - (0.5 - CAM.faceAt) * faceView },
    };
    // 半身和特写：画面正中本来就在胸口、脸上，相机就放在那个高度
    this.shots.bust.eye = this.shots.bust.y; this.shots.face.eye = this.shots.face.y;
    this.tanHalf = Math.tan(fov / 2);
    if (!this.cur) this.cur = { ...(this.shot === 'auto' ? this.shots.bust : this.shots[this.shot]) };
  }

  /// 设镜头。v：{ shot: auto/full/bust/face, orbit: 度, tilt: 度 }，没给的不变。返回现在的设置
  set(v) {
    if (v.shot && SHOTS.includes(v.shot)) this.shot = v.shot;
    if (Number.isFinite(+v.orbit) && v.orbit !== null && v.orbit !== '') this.orbitT = clamp(+v.orbit, -CAM.maxOrbit, CAM.maxOrbit);
    if (Number.isFinite(+v.tilt) && v.tilt !== null && v.tilt !== '') this.tiltT = clamp(+v.tilt, CAM.minTilt, CAM.maxTilt);
    return this.get();
  }

  get() { return { shot: this.shot, orbit: Math.round(this.orbitT), tilt: Math.round(this.tiltT) }; }

  /// 每帧调用。close：自动模式下现在该不该是近景；enabled：网址参数 cam=0 时只固定全身
  update(t, dt, close, enabled) {
    if (!this.cur) return;
    let want;
    if (!enabled) want = this.shots.full;
    else if (this.shot !== 'auto') want = this.shots[this.shot];
    else {
      if (close) this.closeAt = t;
      want = this.shots.bust;   // William 定的：平时就是中景，不拉回全身
    }
    const k = Math.min(1, dt * CAM.ease), kt = Math.min(1, dt * CAM.turnEase);
    this.cur.dist += (want.dist - this.cur.dist) * k;
    this.cur.y += (want.y - this.cur.y) * k;
    this.cur.eye += (want.eye - this.cur.eye) * k;
    const orbitT = enabled ? this.orbitT : 0, tiltT = enabled ? this.tiltT : 0;
    this.orbit += (orbitT - this.orbit) * kt;
    this.tilt += (tiltT - this.tilt) * kt;

    const d = enabled ? this.h * CAM.drift : 0;
    const dx = d * (Math.sin(t * 0.31) + 0.5 * Math.sin(t * 0.73 + 1.3));
    const dy = d * (Math.sin(t * 0.43 + 2.1) + 0.5 * Math.sin(t * 0.89));
    const a = this.orbit * RAD, e = this.tilt * RAD, dist = this.cur.dist, y = this.cur.eye;
    this.camera.position.set(dist * Math.sin(a) * Math.cos(e) + dx, y + dist * Math.sin(e) + dy, dist * Math.cos(a) * Math.cos(e));
    this.camera.lookAt(dx * 0.3, y + dy * 0.3, 0);
    // 移轴：让高度 cur.y 落在画面正中（相机在 cur.eye，比它高）。投影矩阵第 2 行第 3 列是画面上下挪多少
    const P = this.camera.projectionMatrix;
    P.elements[9] = -(this.cur.eye - this.cur.y) / (dist * this.tanHalf);
    this.camera.projectionMatrixInverse.copy(P).invert();

    // 背景跟着放大一点，做出景深感（只在数值变了的时候改样式）
    const full = this.shots.full.dist, bust = this.shots.bust.dist;
    const near = clamp((bust - dist) / Math.max(1e-3, full - bust), 0, 0.6);   // 半身和全身时是 0，背景原样铺满
    const zoom = Math.round((1 + CAM.bgZoom * near) * 500) / 500;
    if (this.bg && zoom !== this.lastZoom) { this.bg.style.transform = `scale(${zoom})`; this.lastZoom = zoom; }
  }
}
