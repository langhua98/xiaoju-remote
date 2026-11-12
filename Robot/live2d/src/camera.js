// 镜头：两个机位。聊天时推到半身近景，待机一会儿后拉回全身；带一点很轻的漂移，像有人拿着在呼吸。
import * as THREE from 'three';

export const CAM = {
  fullHeight: 1 / 0.8,     // 全身：画面高度是身高的多少倍
  feetAt: 0.84,            // 全身：脚落在屏幕从上往下多少的地方（背景地板上那圈光环）
  bustHeight: 0.66,        // 近景（头到大腿，和原作的机位一样）：画面高度是身高的多少倍
  headAt: 0.27,            // 近景：头落在屏幕从上往下多少的地方
  ease: 2.6,               // 推拉的快慢（越大越快，大约 1 秒到位）
  backAfter: 10,           // 回到待机多少秒后拉回全身
  drift: 0.003,            // 漂移幅度（身高的多少）
  bgZoom: 0.12,            // 推近时背景放大多少
};

export class CameraRig {
  constructor(camera, bg) {
    this.camera = camera; this.bg = bg;
    this.k = 0;            // 0 全身，1 半身
    this.want = 0; this.idleSince = 0;
    this.full = { dist: 5, y: 0 }; this.bust = { dist: 2, y: 1 };
    this.h = 1.7; this.lastZoom = -1;
  }

  /// 换了模型或者窗口大小变了。box：模型的包围盒；headY：头的高度（绑定姿势，世界坐标，脚底为 0）
  layout(height, headY) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov), tan = 2 * Math.tan(fov / 2);
    this.h = height;
    const fullView = height * CAM.fullHeight;
    // 屏幕中心对应的世界高度：脚在 feetAt 处
    this.full = { dist: fullView / tan, y: (CAM.feetAt - 0.5) * fullView };
    // 竖屏很窄时半身不要推得太近，保证肩膀在画面里
    const bustView = Math.max(height * CAM.bustHeight, (height * 0.3) / Math.max(0.3, this.camera.aspect));
    this.bust = { dist: bustView / tan, y: headY - (0.5 - CAM.headAt) * bustView };
  }

  /// 每帧调用。close：现在该不该是近景；t：秒
  update(t, dt, close, enabled) {
    if (close) { this.want = 1; this.idleSince = t; }
    else if (t - this.idleSince > CAM.backAfter) this.want = 0;
    if (!enabled) this.want = 0;
    this.k += (this.want - this.k) * Math.min(1, dt * CAM.ease);
    const e = this.k * this.k * (3 - 2 * this.k);   // 两头慢中间快
    const dist = this.full.dist + (this.bust.dist - this.full.dist) * e;
    const y = this.full.y + (this.bust.y - this.full.y) * e;
    const d = enabled ? this.h * CAM.drift : 0;
    const dx = d * (Math.sin(t * 0.31) + 0.5 * Math.sin(t * 0.73 + 1.3));
    const dy = d * (Math.sin(t * 0.43 + 2.1) + 0.5 * Math.sin(t * 0.89));
    this.camera.position.set(dx, y + dy, dist);
    this.camera.lookAt(dx * 0.3, y + dy * 0.3, 0);
    // 背景跟着放大一点，做出景深感（只在数值变了的时候改样式）
    const zoom = Math.round((1 + CAM.bgZoom * e) * 500) / 500;
    if (this.bg && zoom !== this.lastZoom) { this.bg.style.transform = `scale(${zoom})`; this.lastZoom = zoom; }
  }
}
