// 角色的加载、整理和释放。
// 角色是 GLB（models/Yuki_outfit1.glb、Yuki_outfit2.glb，同一个角色两套衣服，由 fetch-assets.sh 下载）：
// ARKit 52 个表情形变 + 几百根骨骼 + 30 个自带动画（带道具：手机、报纸、手柄、爆米花，平时缩到 0 看不见）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyToon, setChin } from './toon.js';
import { TwistHelpers, Correctives, Gaze, FootFix, AnimBase } from './rig.js';
import { SpringSystem, findSpringBones, FOLLOW, FOLLOW_NO_HAIR } from './spring.js';
import { Motion, BANNED } from './motion.js';

// 衣服 id → 模型文件。default 是第一套；以前存的旧 id（heibai、yeye）也回到第一套
export const OUTFITS = { default: 'models/Yuki_outfit1.glb', outfit2: 'models/Yuki_outfit2.glb' };

// 模型文件本身的错位，加载时改回来。
// outfit2（洋装）：身体、外套、裙子的顶点整体比骨架高 6.25 厘米（和第一套比：同一双手的手腕顶点 1.115 对 1.053，
// 手指、脚、腰都差这么多），头、脸、头发、头纱却在骨架的高度。结果头陷进衣服里，像缩着脖子。
// 应该是这套衣服穿高跟鞋，导出时身体按踩高跟的高度放了，骨架和头没有跟着抬。这里把身体和衣服往下挪回骨架上。
// 同一套的高跟靴：脚是平底姿势，下面垫了一根高跟，要在运行时把脚踝压下去才踩得实（heels: true，见 rig.js 的 FootFix）。
const MESH_FIX = {
  outfit2: { meshes: [{ match: /Outfit_02_(Body|ClothingTop|ClothingBott)(?!_Transp)/, dy: -0.0625 }], heels: true },
};

const loader = new GLTFLoader();

function shrinkTextures(root, max) {
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
        if (!w || Math.max(w, h) <= max) continue;
        const r = max / Math.max(w, h);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * r)); c.height = Math.max(1, Math.round(h * r));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        if (img.close) try { img.close(); } catch (e) { /* ImageBitmap */ }
        tx.image = c; tx.needsUpdate = true;
      }
    }
  });
}

/// 整理动画轨道。模型导出时给每根骨骼、每个动画都写了位移、转动、缩放三条轨道，其中大半是不变的常数。
/// 一条轨道如果在所有动画里都是常数，而且就等于绑定姿势的值，就从所有动画里删掉：
/// 动画系统每帧少算一大半，而且这些骨骼（悬挂物、辅助骨骼）正好留给物理和辅助骨骼去驱动。
/// 返回「转动在所有动画里都不变」的节点名字集合。
function trimTracks(root, clips) {
  const nodes = {};
  root.traverse((o) => { if (o.name && !nodes[o.name]) nodes[o.name] = o; });
  const keep = new Map();   // 轨道名 → 是不是有哪个动画里它在变
  const eq = (a, b, tol) => Math.abs(a - b) <= tol;
  for (const clip of clips) {
    for (const tr of clip.tracks) {
      if (keep.get(tr.name)) continue;
      const dot = tr.name.lastIndexOf('.');
      const node = nodes[tr.name.slice(0, dot)], prop = tr.name.slice(dot + 1);
      let moving = !node || !(prop === 'position' || prop === 'quaternion' || prop === 'scale');
      if (!moving) {
        const rest = node[prop].toArray(), n = rest.length, v = tr.values;
        const tol = prop === 'position' ? 1e-5 : 1e-4;
        // 四元数 q 和 -q 是同一个转动
        const sign = prop === 'quaternion' && (v[0] * rest[0] + v[1] * rest[1] + v[2] * rest[2] + v[3] * rest[3]) < 0 ? -1 : 1;
        for (let i = 0; i < v.length && !moving; i++) if (!eq(v[i], rest[i % n] * sign, tol)) moving = true;
      }
      keep.set(tr.name, moving);
    }
  }
  let before = 0, after = 0;
  for (const clip of clips) {
    before += clip.tracks.length;
    clip.tracks = clip.tracks.filter((tr) => keep.get(tr.name));
    after += clip.tracks.length;
  }
  const still = new Set();
  for (const [name, moving] of keep) if (!moving && name.endsWith('.quaternion')) still.add(name.slice(0, -11));
  return { still, before, after };
}

/// 加载一套衣服。cfg：{ tex, toon, outline, spring, helpers }
export function loadAvatar(id, cfg) {
  const file = OUTFITS[id] || OUTFITS.default;
  return new Promise((ok, fail) => {
    loader.load(file, (gltf) => {
      try {
        const root = gltf.scene;
        shrinkTextures(root, cfg.tex);
        const meshFix = MESH_FIX[id] || { meshes: [] };
        for (const fix of meshFix.meshes) {
          const seen = new Set();
          root.traverse((o) => { if (o.isMesh && fix.match.test(o.name) && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.translate(0, fix.dy, 0); } });
        }
        const byName = {}, faces = [];
        let skeleton = null, faceMesh = null;
        root.traverse((o) => {
          if (o.isBone) byName[o.name] = o;
          if (o.isMesh) {
            o.frustumCulled = false;
            if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton;
            if (o.morphTargetDictionary && o.morphTargetDictionary.jawOpen !== undefined) { faces.push(o); if (/Head/i.test(o.material.name)) faceMesh = o; }
          }
        });
        root.updateMatrixWorld(true);

        // 尺寸只按身体算（道具摆在别处，会把包围盒撑大）
        const box = new THREE.Box3();
        root.traverse((o) => {
          if (!o.isMesh || /Gamepad|Newspaper|phone|Popcorn|Cellphone/i.test(o.name + o.material.name)) return;
          o.geometry.computeBoundingBox();
          box.union(o.geometry.boundingBox);
        });
        // 高跟靴：算出脚踝要压多少度、踩实以后鞋底在哪里（那里就是地面）
        let foot = null;
        if ((meshFix.heels || Number.isFinite(cfg.ankle)) && byName.Ankle_L && byName.Toes_L) {
          foot = new FootFix([{ ankle: byName.Ankle_L, toes: byName.Toes_L }, { ankle: byName.Ankle_R, toes: byName.Toes_R }]).solve(root, cfg.ankle);
          box.min.y = foot.sole;
        }
        const head = byName.Head_M;
        // 头的中心（给脸的球面法线用）：脸部网格包围盒的后沿中点，换算到头骨的局部坐标
        const headLocal = new THREE.Vector3(0, 0.08, 0);
        if (head && faceMesh) {
          const fb = faceMesh.geometry.boundingBox, eyeY = byName.Eye_L ? byName.Eye_L.getWorldPosition(new THREE.Vector3()).y : (fb.min.y + fb.max.y) / 2;
          headLocal.set((fb.min.x + fb.max.x) / 2, eyeY, fb.min.z + (fb.max.z - fb.min.z) * 0.35);
          head.worldToLocal(headLocal);
        }
        const headY = head ? head.getWorldPosition(new THREE.Vector3()).y + 0.09 : box.max.y * 0.92;
        // 头的朝上、朝前方向（头骨局部坐标），和下巴尖的位置：下巴的阴影要用。
        // 下巴尖 = 脸正中间、离鼻尖 3.5 厘米以内最低的那个点（脖子在更后面）
        const headWorldInv = head ? head.matrixWorld.clone().invert() : new THREE.Matrix4();
        const headUp = new THREE.Vector3(0, 1, 0).transformDirection(headWorldInv), headFwd = new THREE.Vector3(0, 0, 1).transformDirection(headWorldInv);
        if (head && faceMesh) {
          const pos = faceMesh.geometry.attributes.position, fb = faceMesh.geometry.boundingBox;
          let chinY = Infinity, chinZ = 0;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            if (Math.abs(x) < 0.012 && z > fb.max.z - 0.035 && y < chinY) { chinY = y; chinZ = z; }
          }
          const c = headLocal.clone().applyMatrix4(head.matrixWorld);
          if (chinY < Infinity) setChin(chinY - c.y, chinZ - c.z);
        }
        const clips = {};
        const all = gltf.animations.filter((c) => !BANNED.includes(c.name));
        const trim = trimTracks(root, all);
        for (const c of all) {
          // 身体完全不动（一直是 T 字姿势）、只有表情在变的动画：只留表情轨道，播的时候叠在别的动作上
          const bones = c.tracks.filter((tr) => !tr.name.endsWith('.morphTargetInfluences'));
          const still = bones.every((tr) => { const n = tr.getValueSize(), v = tr.values; for (let i = n; i < v.length; i++) if (Math.abs(v[i] - v[i % n]) > 1e-4) return false; return true; });
          if (still && bones.length < c.tracks.length) { c.tracks = c.tracks.filter((tr) => tr.name.endsWith('.morphTargetInfluences')); c.faceOnly = true; }
          clips[c.name] = c;
        }

        const toon = cfg.toon ? applyToon(root, { outline: cfg.outline, shadow: cfg.shadow }) : { outlines: [] };
        const mixer = new THREE.AnimationMixer(root);
        const bones = skeleton ? skeleton.bones : [];
        const twist = cfg.helpers ? new TwistHelpers(byName) : null;
        const fix = cfg.helpers ? new Correctives(byName) : null;
        const gaze = new Gaze({ chest: byName.Chest_M, neck: byName.Neck_M, head, eyeL: byName.Eye_L, eyeR: byName.Eye_R });
        let spring = null;
        if (cfg.spring) {
          const list = findSpringBones(bones, (b) => trim.still.has(b.name), cfg.hair ? FOLLOW : FOLLOW_NO_HAIR);
          const C = (a, b, radius, offset) => (byName[a] && (!b || byName[b]) ? [{ a: byName[a], b: b ? byName[b] : null, radius, offset }] : []);
          const colliders = [
            ...C('Head_M', null, 0.105, headLocal.clone()),
            // 腿要比真实的细一点：裙子本来就贴着大腿，碰撞体粗了会把裙摆整个撑开、往上顶
            ...C('Chest_M', 'Root_M', 0.105), ...C('Hip_L', 'Knee_L', 0.058), ...C('Hip_R', 'Knee_R', 0.058),
            ...C('Knee_L', 'Ankle_L', 0.045), ...C('Knee_R', 'Ankle_R', 0.045),
            // 头发会碰到的：脖子、肩膀、上臂
            ...C('Neck_M', 'Head_M', 0.048),
            ...C('Scapula_L', 'Shoulder_L', 0.05), ...C('Scapula_R', 'Shoulder_R', 0.05),
            ...C('Shoulder_L', 'Elbow_L', 0.045), ...C('Shoulder_R', 'Elbow_R', 0.045),
          ];
          spring = new SpringSystem(list, colliders, (b) => trim.still.has(b.name));
        }
        // 道具（手柄、手机、报纸、爆米花）：动画用把它们的父节点缩到 0 的办法藏起来。缩到 0 时干脆不画，省绘制调用。
        const props = [];
        const PROP = { Joystick: /Gamepad/i, Phone: /Cellphone|phone/i, Newspaper: /Newspaper/i, Popcorn: /Popcorn/i };
        if (byName.Props) for (const node of byName.Props.children) {
          const re = PROP[node.name.replace(/_\d+$/, '')];
          if (!re) continue;
          const list = [];
          root.traverse((o) => { if (o.isMesh && re.test(o.material.name)) list.push(o); });
          props.push({ node, meshes: list });
        }
        const motion = new Motion(mixer, clips);
        // 我们要在动画之后叠加转动的骨骼：视线、高跟鞋、跟着动画走的裙子
        const animBase = new AnimBase([...gaze.bones, ...(foot ? foot.bones : []), ...(spring ? spring.joints.filter((j) => j.followAnim).map((j) => j.bone) : [])]);
        ok({
          animBase,
          id, root, mixer, clips, faces, box, byName, bones, headLocal, headY, head,
          toonHead: { bone: head, center: headLocal, up: headUp, fwd: headFwd },
          twist, fix, foot, gaze, spring, motion, props, outlines: toon.outlines,
          stats: { heel: foot ? foot.deg : 0, bones: bones.length, tracks: `${trim.after}/${trim.before}`, springs: spring ? spring.joints.length : 0, twists: twist ? twist.items.length : 0 },
        });
      } catch (e) { fail(e); }
    }, undefined, fail);
  });
}

export function disposeAvatar(a) {
  if (!a) return;
  a.mixer.stopAllAction();
  if (a.root.parent) a.root.parent.remove(a.root);
  a.root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.outline) o.geometry.dispose();
    for (const m of [].concat(o.material)) {
      if (m.uniforms && m.uniforms.map && m.uniforms.map.value && m.userData.toonMap) m.uniforms.map.value.dispose();
      if (m.uniforms && m.uniforms.aoMap && m.defines && m.defines.USE_AO) m.uniforms.aoMap.value.dispose();
      for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose();
      m.dispose();
    }
  });
}
