// 卡通渲染：模型的贴图只有底色（外加衣服和头发的环境遮蔽贴图），原作的明暗是着色器算的。这里照着原作的画面自己写一个：
// - 两段明暗，暗部是底色乘一个带颜色的阴影色（皮肤的阴影是橘红色），分界锐利
// - 环境遮蔽贴图当成阴影用：衬衫的褶皱、裙子的褶、头发的层次都从这里来
// - 脸没有阴影贴图，直接按法线算会在鼻子、嘴角出脏影，所以脸的法线往「以头为中心的球面」靠
// - 下巴在脖子上的阴影、刘海在额头上的投影、眼睛上沿的阴影片
// - 背面外扩的细描边
import * as THREE from 'three';

// 观感参数集中在这里，照原作（animates）的截图调的
export const TOON = {
  light: new THREE.Vector3(-0.42, 0.42, 0.8).normalize(),   // 主光方向（镜头坐标：右、上、朝镜头）。原作的光从左前上方来
  rimDir: new THREE.Vector3(0.8, 0.2, -0.2).normalize(),    // 边缘光打在背光的这一侧
  rimColor: new THREE.Color(1.0, 0.93, 0.82),
  grade: new THREE.Vector3(1.0, 0.975, 0.94),                // 整体偏暖一点
  outlineWidth: 0.0008,                                      // 描边粗细（乘以到镜头的距离）
  kinds: {
    //        底色再乘一个颜色（原作的皮肤和头发更暖）  阴影色（乘在底色上）   明暗分界 柔边   边缘光 描边粗细 描边颜色（乘在底色上）  环境遮蔽从多暗到多亮算阴影
    skin:  { tint: [0.99, 0.955, 0.90], shade: [0.93, 0.66, 0.57], thr: 0.22, soft: 0.012, rim: 0.10, line: 0.8, lineCol: [0.42, 0.20, 0.16], ao: [0.45, 0.8] },
    face:  { tint: [0.99, 0.955, 0.90], shade: [0.93, 0.68, 0.60], thr: -0.35, soft: 0.05, rim: 0.0, line: 0.5, lineCol: [0.45, 0.22, 0.18], ao: [0.45, 0.8] },
    hair:  { tint: [1.0, 0.93, 0.76], shade: [0.82, 0.60, 0.46], thr: 0.18, soft: 0.02, rim: 0.12, line: 0.9, lineCol: [0.30, 0.17, 0.12], ao: [0.35, 0.75] },
    cloth: { tint: [1, 1, 1], shade: [0.74, 0.68, 0.72], thr: 0.12, soft: 0.02, rim: 0.10, line: 1.0, lineCol: [0.20, 0.15, 0.17], ao: [0.5, 0.92] },
    prop:  { tint: [1, 1, 1], shade: [0.76, 0.70, 0.74], thr: 0.12, soft: 0.02, rim: 0.10, line: 0, lineCol: [0, 0, 0], ao: [0.5, 0.9] },
    eye:   { tint: [1, 1, 1], shade: [1, 1, 1], thr: 0, soft: 0.1, rim: 0, line: 0, lineCol: [0, 0, 0], ao: [0, 1] },
  },
  sphere: 0.8,         // 脸的法线往球面靠多少（0 不靠，1 完全是球）
  hairSpec: 0.3,       // 头发高光带的强度
  hairShadow: { color: [0.93, 0.70, 0.62], offset: [0.004, -0.013], back: 0.004 },   // 刘海的投影：颜色、往哪偏（米）、往后退多少
  eyeShadow: [0.80, 0.74, 0.80],   // 眼睛上沿那片阴影的颜色（乘在眼睛上）
  neck: { slope: 0.45, radius: 0.11 },   // 下巴的阴影：下巴往后阴影面抬高的斜率、影响范围（米）
};

export function kindOf(name) {
  if (/Eyes/i.test(name)) return 'eye';
  if (/^M_/.test(name)) return 'prop';
  if (/Head/i.test(name)) return 'face';
  if (/Hair/i.test(name)) return 'hair';
  if (/Body/i.test(name)) return 'skin';
  return 'cloth';
}

const VERT = /* glsl */`
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying vec2 vUv;
varying vec2 vUvAo;
varying vec3 vN;
varying vec3 vP;
uniform float uOutline;
uniform vec3 uShadowOff;
#ifdef AO_UV1
  attribute vec2 uv1;
#endif
void main() {
  vUv = uv;
  #ifdef AO_UV1
    vUvAo = uv1;
  #else
    vUvAo = uv;
  #endif
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vec3 n = normalize(transformedNormal);
  #ifdef OUTLINE
    vec3 nOut = n;
    #ifdef FLIP_SIDED
      nOut = -n;
    #endif
    mvPosition.xyz += nOut * uOutline * clamp(-mvPosition.z, 0.3, 10.0);
  #endif
  #ifdef CAST
    mvPosition.xyz += uShadowOff;
  #endif
  vN = n;
  vP = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}`;

const FRAG = /* glsl */`
uniform sampler2D map;
uniform vec3 uColor;   // 材质的底色系数（没有贴图的材质全靠它，比如运动装的外套、袜子）
uniform sampler2D aoMap;
uniform vec3 uShade;
uniform vec3 uTint;
uniform vec3 uLineCol;
uniform vec3 uLight;
uniform vec3 uRimDir;
uniform vec3 uRimCol;
uniform vec3 uGrade;
uniform vec3 uFlat;
uniform vec2 uAo;
uniform float uThr;
uniform float uSoft;
uniform float uRim;
uniform float uSpec;
uniform float uOpacity;
uniform vec3 uHeadC;
uniform vec3 uHeadUp;
uniform vec3 uHeadFwd;
uniform vec3 uChin;
uniform float uSphere;
varying vec2 vUv;
varying vec2 vUvAo;
varying vec3 vN;
varying vec3 vP;
void main() {
  #ifdef FLAT
    // 只出一个颜色，乘在已经画好的画面上（刘海的投影、眼睛上沿的阴影）
    gl_FragColor = vec4(uFlat, 1.0);
  #else
  vec4 tex = texture2D(map, vUv);
  tex.rgb *= uColor;
  #ifdef CUTOUT
    if (tex.a < 0.5) discard;
  #endif
  #ifdef OUTLINE
    gl_FragColor = vec4(tex.rgb * uTint * uLineCol, 1.0);
  #else
    vec3 base = tex.rgb * uTint;
    #ifdef UNLIT
      vec3 col = base;
    #else
      vec3 N = normalize(vN);
      #ifdef DOUBLE_SIDED
        if (!gl_FrontFacing) N = -N;
      #endif
      #ifdef FACE
        N = normalize(mix(N, normalize(vP - uHeadC), uSphere));
      #endif
      vec3 V = normalize(-vP);
      float lit = smoothstep(uThr - uSoft, uThr + uSoft, dot(N, uLight));
      #ifdef USE_AO
        lit = min(lit, smoothstep(uAo.x, uAo.y, texture2D(aoMap, vUvAo).r));
      #endif
      #ifdef NECK
        // 下巴的阴影：下巴尖往后、一个向后抬高的斜面以下的皮肤都算在阴影里
        vec3 r = vP - uHeadC;
        float h = dot(r, uHeadUp), f = dot(r, uHeadFwd);
        float under = smoothstep(0.0, 0.004, uChin.x - 0.003 + uChin.z * max(0.0, uChin.y - f) - h);
        under *= smoothstep(0.004, 0.012, uChin.y - f);
        under *= 1.0 - smoothstep(0.75, 1.0, length(r - uHeadUp * (uChin.x - 0.03)) / 0.11);
        lit *= 1.0 - under;
      #endif
      vec3 col = base * mix(uShade, vec3(1.0), lit);
      float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
      col += uRimCol * (fres * smoothstep(0.0, 0.6, dot(N, uRimDir)) * uRim);
      #ifdef HAIR
        // 高光带：把法线横向压扁，高光就连成一圈
        vec3 Ns = normalize(vec3(N.x * 0.25, N.y, N.z));
        float s = pow(max(dot(Ns, normalize(uLight + V)), 0.0), 40.0);
        col += base * (smoothstep(0.3, 0.6, s) * uSpec * lit);
      #endif
    #endif
    gl_FragColor = vec4(col * uGrade, tex.a * uOpacity);
  #endif
  #endif
  #include <colorspace_fragment>
}`;

const k0 = (kind) => TOON.kinds[kind].line > 0;   // 眼睛和道具不描边
let whiteTex = null;
function white() {
  if (!whiteTex) {
    whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteTex.colorSpace = THREE.SRGBColorSpace; whiteTex.needsUpdate = true;
  }
  return whiteTex;
}

// 所有材质共用：头的中心、朝上和朝前的方向（镜头坐标，每帧更新），下巴相对头中心的位置（上、前、斜率）
const shared = {
  headC: { value: new THREE.Vector3(0, 0, -5) }, headUp: { value: new THREE.Vector3(0, 1, 0) }, headFwd: { value: new THREE.Vector3(0, 0, 1) },
  chin: { value: new THREE.Vector3(-0.08, 0.06, TOON.neck.slope) },
};

/// mode：'' 正常、'outline' 描边、'cast' 刘海的投影、'eyeshadow' 眼睛上沿的阴影片
function makeMaterial(src, kind, mode) {
  const k = TOON.kinds[kind];
  const outline = mode === 'outline', flat = mode === 'cast' || mode === 'eyeshadow';
  const blend = src.transparent === true;
  const defines = {};
  if (outline) defines.OUTLINE = 1;
  if (flat) defines.FLAT = 1;
  if (mode === 'cast') defines.CAST = 1;
  if (src.alphaTest > 0 && !flat) defines.CUTOUT = 1;
  // 眼睛不受光；半透明的薄纱也不算明暗，不然盖在皮肤上的那层会把胸口染成蓝灰色
  if (kind === 'eye' || (blend && !outline)) defines.UNLIT = 1;
  if (kind === 'face') defines.FACE = 1;
  if (kind === 'face' || kind === 'skin') defines.NECK = 1;
  if (kind === 'hair') defines.HAIR = 1;
  if (src.aoMap && !outline && !flat) { defines.USE_AO = 1; if (src.aoMap.channel === 1) defines.AO_UV1 = 1; }
  const hs = TOON.hairShadow;
  const m = new THREE.ShaderMaterial({
    name: src.name + '_' + (mode || 'toon'),
    defines, vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      map: { value: src.map || white() }, uColor: { value: src.color ? src.color.clone() : new THREE.Color(1, 1, 1) }, aoMap: { value: src.aoMap || white() },
      uShade: { value: new THREE.Vector3(...k.shade) }, uTint: { value: new THREE.Vector3(...k.tint) },
      uLineCol: { value: new THREE.Vector3(...k.lineCol) },
      uLight: { value: TOON.light }, uRimDir: { value: TOON.rimDir }, uRimCol: { value: TOON.rimColor }, uGrade: { value: TOON.grade },
      uFlat: { value: new THREE.Vector3(...(mode === 'cast' ? hs.color : TOON.eyeShadow)) },
      uAo: { value: new THREE.Vector2(...k.ao) },
      uThr: { value: k.thr }, uSoft: { value: k.soft }, uRim: { value: k.rim },
      uSpec: { value: TOON.hairSpec }, uOpacity: { value: src.opacity === undefined ? 1 : src.opacity },
      uHeadC: shared.headC, uHeadUp: shared.headUp, uHeadFwd: shared.headFwd, uChin: shared.chin, uSphere: { value: TOON.sphere },
      uOutline: { value: TOON.outlineWidth * k.line },
      uShadowOff: { value: new THREE.Vector3(hs.offset[0], hs.offset[1], -hs.back) },
    },
    side: outline ? THREE.BackSide : flat ? THREE.DoubleSide : src.side,
    transparent: flat || (!outline && blend),
    depthWrite: flat ? false : outline ? true : src.depthWrite,
  });
  if (flat) m.blending = THREE.MultiplyBlending;
  if (kind === 'face' && !mode) {
    // 脸画到哪里就在模板缓冲里记 1，刘海的投影只画在记了 1 的地方（不会画到衣服和背景上）
    m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilZPass = THREE.ReplaceStencilOp;
  }
  if (mode === 'cast') {
    // 画过一次就把模板加 1，几缕头发的投影叠在一起也只暗一次
    m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.EqualStencilFunc; m.stencilZPass = THREE.IncrementStencilOp;
  }
  m.userData.toonMap = src.map || null;
  return m;
}

function skinnedCopy(mesh, material, tag) {
  const c = new THREE.SkinnedMesh(mesh.geometry, material);
  c.name = mesh.name + '_' + tag;
  c.bind(mesh.skeleton, mesh.bindMatrix);
  // 表情形变和原网格共用同一个数组，脸变形时跟着变
  if (mesh.morphTargetInfluences) { c.morphTargetInfluences = mesh.morphTargetInfluences; c.morphTargetDictionary = mesh.morphTargetDictionary; }
  c.frustumCulled = false;
  c.userData.outline = true;   // 几何体是借的，释放时不要重复放
  mesh.parent.add(c);
  return c;
}

/// 把模型的材质全部换成卡通材质。
/// opts：{ outline: 0 不描边 / 1 描边（顶点特别多的网格不描）/ 2 全部描边, shadow: 要不要刘海和眼睛的阴影 }
export function applyToon(root, opts) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const done = new Map();
  const outlines = [];
  for (const mesh of meshes) {
    const src = mesh.material;
    // 眼睛上沿的阴影片（Yuki_EyesShadow）：模型里它的不透明度是 0，原作是用自己的着色器把它乘在眼睛上的
    if (src.alphaTest > 0 && !src.map && src.opacity < src.alphaTest) {
      if (!opts.shadow || !mesh.isSkinnedMesh) { mesh.visible = false; continue; }
      mesh.material = makeMaterial(src, 'eye', 'eyeshadow');
      mesh.renderOrder = 1;
      src.dispose();
      continue;
    }
    const kind = kindOf(src.name);
    if (!done.has(src)) {
      done.set(src, makeMaterial(src, kind, ''));
      // 用不到的贴图马上放掉，省内存（底色和环境遮蔽留着）
      for (const key of Object.keys(src)) {
        const tx = src[key];
        if (tx && tx.isTexture && tx !== src.map && tx !== src.aoMap) { if (tx.image && tx.image.close) try { tx.image.close(); } catch (e) { /* 已经关了 */ } tx.dispose(); }
      }
      src.dispose();
    }
    mesh.material = done.get(src);
    if (src.transparent) mesh.renderOrder = 2;
    if (!mesh.isSkinnedMesh) continue;

    const verts = mesh.geometry.attributes.position.count;
    const want = opts.outline >= 2 || (opts.outline === 1 && verts < 30000);
    if (want && k0(kind) && !src.transparent) outlines.push(skinnedCopy(mesh, makeMaterial(src, kind, 'outline'), 'line'));
    // 刘海在额头上的投影：把前发往光的反方向挪一点再画一遍，只画在脸上
    if (opts.shadow && kind === 'hair' && /Front/i.test(src.name)) {
      const cast = skinnedCopy(mesh, makeMaterial(src, kind, 'cast'), 'cast');
      cast.renderOrder = 1;
      outlines.push(cast);
    }
  }
  return { outlines };
}

const _v = new THREE.Vector3();
/// 加载后调用一次：下巴尖相对头中心的位置（米，绑定姿势下：往上、往前）
export function setChin(up, forward) { shared.chin.value.set(up, forward, TOON.neck.slope); }

/// 每帧调用：头的中心和朝向换算到镜头坐标（脸的球面法线、下巴的阴影要用）
/// head：{ bone, center, up, fwd }，后三个是头骨局部坐标里的点和方向
export function updateToon(camera, head) {
  if (!head || !head.bone) return;
  const m = head.bone.matrixWorld, v = camera.matrixWorldInverse;
  shared.headC.value.copy(head.center).applyMatrix4(m).applyMatrix4(v);
  shared.headUp.value.copy(head.up).transformDirection(m).transformDirection(v);
  shared.headFwd.value.copy(head.fwd).transformDirection(m).transformDirection(v);
}

/// 脚下的假阴影：一张径向渐变的椭圆片，不开实时阴影
export function makeGroundShadow(radius) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(8,12,40,0.55)'); grad.addColorStop(0.6, 'rgba(8,12,40,0.22)'); grad.addColorStop(1, 'rgba(8,12,40,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.scale.set(1, 0.2, 1);   // 镜头几乎平视地面，所以画成一个朝着镜头的扁椭圆
  m.renderOrder = -1;
  return m;
}
