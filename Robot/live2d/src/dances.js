// 从视频做出来的舞蹈（dances/*.json）：每帧身体主要 20 根骨骼的局部转动和腰的位置。
// 做法见 Robot/README.md「从视频做舞蹈」：MediaPipe 从视频里认出 3D 骨架 → 套到 Yuki 的骨骼上 → 存成这个 JSON。
// 三套衣服的身体骨骼一样，所以同一份数据三套都能用。没有的骨骼（头发、裙子、手指、表情）借用待机动画，
// 头发、裙子照样会动，表情照样眨眼。
import * as THREE from 'three';

export const DANCES = [
  { id: 'video_dance1', file: 'dances/video_dance1.json' },
];

const cache = {};
/// 把所有舞蹈数据下载好（启动时调一次；失败的跳过）
export async function loadDances() {
  await Promise.all(DANCES.map(async (d) => {
    try { const r = await fetch(d.file); if (r.ok) cache[d.id] = await r.json(); } catch (e) { /* 没有就算了 */ }
  }));
}

/// 给一套衣服加上舞蹈动画。clips：这套衣服的动画（会往里加）
export function addDanceClips(clips) {
  const idle = clips.idle;
  for (const d of DANCES) {
    const data = cache[d.id];
    if (!data || clips[d.id]) continue;
    const n = data.frames, times = new Float32Array(n);
    for (let i = 0; i < n; i++) times[i] = i / data.fps;
    const tracks = [], driven = new Set(Object.keys(data.bones));
    for (const [bone, q] of Object.entries(data.bones)) tracks.push(new THREE.QuaternionKeyframeTrack(bone + '.quaternion', times, q));
    tracks.push(new THREE.VectorKeyframeTrack('Root_M.position', times, data.root));
    // 其余的骨骼和表情：借待机动画的前 n 帧
    if (idle) for (const t of idle.tracks) {
      const dot = t.name.lastIndexOf('.'), bone = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
      if (driven.has(bone) && prop === 'quaternion') continue;
      if (bone === 'Root_M' && prop === 'position') continue;
      tracks.push(t);
    }
    const clip = new THREE.AnimationClip(d.id, (n - 1) / data.fps, tracks);
    clips[d.id] = clip;
  }
}
