// 卡通渲染：模型的贴图只有底色，原作的明暗是着色器算的。这里自己写一个：
// 两段明暗（暗部是底色乘一个带颜色的阴影色，不是变黑）、背光一侧的边缘光、头发高光带、背面外扩描边。
// 脸没有阴影贴图，直接按法线算会在鼻子、嘴角出脏影，所以脸的法线往「以头为中心的球面」靠。
import * as THREE from 'three';

// 观感参数集中在这里，按真机和原作的画面调
export const TOON = {
  light: new THREE.Vector3(0.45, 0.55, 0.7).normalize(),    // 主光方向（镜头坐标：右、上、朝镜头）
  rimDir: new THREE.Vector3(-0.75, 0.25, -0.2).normalize(), // 边缘光打在背光的这一侧
  rimColor: new THREE.Color(0x7fe9ff),                       // 和背景的青色一致
  outlineWidth: 0.0011,                                      // 描边粗细（乘以到镜头的距离）
  kinds: {
    //        阴影色（乘在底色上）   明暗分界 柔边   边缘光 描边粗细 描边颜色（乘在底色上）
    skin:  { shade: [0.90, 0.70, 0.70], thr: 0.05, soft: 0.04, rim: 0.30, line: 0.8, lineCol: [0.45, 0.22, 0.20] },
    face:  { shade: [0.93, 0.76, 0.75], thr: -0.05, soft: 0.10, rim: 0.12, line: 0.45, lineCol: [0.50, 0.25, 0.22] },
    hair:  { shade: [0.76, 0.64, 0.70], thr: 0.10, soft: 0.03, rim: 0.45, line: 0.9, lineCol: [0.32, 0.20, 0.18] },
    cloth: { shade: [0.70, 0.68, 0.82], thr: 0.08, soft: 0.03, rim: 0.40, line: 1.0, lineCol: [0.22, 0.18, 0.24] },
    prop:  { shade: [0.74, 0.72, 0.84], thr: 0.08, soft: 0.03, rim: 0.2, line: 0, lineCol: [0, 0, 0] },
    eye:   { shade: [1, 1, 1], thr: 0, soft: 0.1, rim: 0, line: 0, lineCol: [0, 0, 0] },
  },
  sphere: 0.75,        // 脸的法线往球面靠多少（0 不靠，1 完全是球）
  hairSpec: 0.22,      // 头发高光带的强度
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
varying vec3 vN;
varying vec3 vP;
uniform float uOutline;
void main() {
  vUv = uv;
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
  vN = n;
  vP = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}`;

const FRAG = /* glsl */`
uniform sampler2D map;
uniform vec3 uShade;
uniform vec3 uLineCol;
uniform vec3 uLight;
uniform vec3 uRimDir;
uniform vec3 uRimCol;
uniform float uThr;
uniform float uSoft;
uniform float uRim;
uniform float uSpec;
uniform float uOpacity;
uniform vec3 uHeadC;
uniform float uSphere;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
void main() {
  vec4 tex = texture2D(map, vUv);
  #ifdef CUTOUT
    if (tex.a < 0.5) discard;
  #endif
  #ifdef OUTLINE
    gl_FragColor = vec4(tex.rgb * uLineCol, 1.0);
  #else
    vec3 base = tex.rgb;
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
      vec3 col = base * mix(uShade, vec3(1.0), lit);
      float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
      col += uRimCol * (fres * smoothstep(0.0, 0.6, dot(N, uRimDir)) * uRim);
      #ifdef HAIR
        // 高光带：把法线横向压扁，高光就连成一圈
        vec3 Ns = normalize(vec3(N.x * 0.25, N.y, N.z));
        float s = pow(max(dot(Ns, normalize(uLight + V)), 0.0), 48.0);
        col += base * (smoothstep(0.35, 0.55, s) * uSpec * lit);
      #endif
    #endif
    gl_FragColor = vec4(col, tex.a * uOpacity);
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

// 所有脸部材质共用这个值：头的中心在镜头坐标里的位置，每帧更新
const headCenter = { value: new THREE.Vector3(0, 0, -5) };

function makeMaterial(src, kind, outline) {
  const k = TOON.kinds[kind];
  const blend = src.transparent === true;
  const defines = {};
  if (outline) defines.OUTLINE = 1;
  if (src.alphaTest > 0) defines.CUTOUT = 1;
  if (kind === 'eye') defines.UNLIT = 1;
  if (kind === 'face') defines.FACE = 1;
  if (kind === 'hair') defines.HAIR = 1;
  const m = new THREE.ShaderMaterial({
    name: src.name + (outline ? '_line' : '_toon'),
    defines, vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      map: { value: src.map || white() },
      uShade: { value: new THREE.Vector3(...k.shade) },
      uLineCol: { value: new THREE.Vector3(...k.lineCol) },
      uLight: { value: TOON.light }, uRimDir: { value: TOON.rimDir }, uRimCol: { value: TOON.rimColor },
      uThr: { value: k.thr }, uSoft: { value: k.soft }, uRim: { value: blend ? 0 : k.rim },   // 半透明的薄纱不加边缘光，不然发蓝
      uSpec: { value: TOON.hairSpec }, uOpacity: { value: src.opacity === undefined ? 1 : src.opacity },
      uHeadC: headCenter, uSphere: { value: TOON.sphere },
      uOutline: { value: TOON.outlineWidth * k.line },
    },
    side: outline ? THREE.BackSide : src.side,
    transparent: !outline && blend,
    depthWrite: outline ? true : src.depthWrite,
  });
  m.userData.toonMap = src.map || null;
  return m;
}

/// 把模型的材质全部换成卡通材质。opts：{ outline: 0 不描边 / 1 描边（顶点特别多的网格不描）/ 2 全部描边 }
/// 返回 { outlines: 描边网格, update(camera, headBone, headLocal) }
export function applyToon(root, opts) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const done = new Map();
  const outlines = [];
  for (const mesh of meshes) {
    const src = mesh.material;
    // 完全透明的片（Yuki_EyesShadow：底色的不透明度是 0，又按 0.5 裁切）本来就画不出东西，直接不画
    if (src.alphaTest > 0 && !src.map && src.opacity < src.alphaTest) { mesh.visible = false; continue; }
    const kind = kindOf(src.name);
    if (!done.has(src)) {
      done.set(src, makeMaterial(src, kind, false));
      // 用不到的贴图（环境遮蔽等）马上放掉，省内存
      for (const key of Object.keys(src)) {
        const tx = src[key];
        if (tx && tx.isTexture && tx !== src.map) { if (tx.image && tx.image.close) try { tx.image.close(); } catch (e) { /* 已经关了 */ } tx.dispose(); }
      }
      src.dispose();
    }
    mesh.material = done.get(src);
    if (src.transparent) mesh.renderOrder = 2;

    const verts = mesh.geometry.attributes.position.count;
    const want = opts.outline >= 2 || (opts.outline === 1 && verts < 30000);
    if (want && k0(kind) && !src.transparent && mesh.isSkinnedMesh) {
      const line = new THREE.SkinnedMesh(mesh.geometry, makeMaterial(src, kind, true));
      line.name = mesh.name + '_line';
      line.bind(mesh.skeleton, mesh.bindMatrix);
      // 表情形变和原网格共用同一个数组，脸变形时描边跟着变
      if (mesh.morphTargetInfluences) { line.morphTargetInfluences = mesh.morphTargetInfluences; line.morphTargetDictionary = mesh.morphTargetDictionary; }
      line.frustumCulled = false;
      line.userData.outline = true;
      mesh.parent.add(line);
      outlines.push(line);
    }
  }
  return { outlines };
}

const _v = new THREE.Vector3();
/// 每帧调用：算出头的中心在镜头坐标里的位置（脸的球面法线要用）
export function updateToon(camera, headBone, headLocal) {
  if (!headBone) return;
  _v.copy(headLocal).applyMatrix4(headBone.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
  headCenter.value.copy(_v);
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
