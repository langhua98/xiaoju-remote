#!/usr/bin/env python3
"""画「运动套装」的贴图：黑色拉链外套 + 黑色百褶裙 + 灰色条纹中筒袜 + 白鞋。

这套不是新模型，是第一套（Yuki_outfit1.glb）换三张贴图：上衣、下装（裙子和鞋）、身体（腿和手臂）。
版型和第一套一样（衬衫 → 外套，百褶裙 → 黑裙，过膝袜 → 中筒袜），所以网格、骨骼、动画、物理都不用动。

画法：先把贴图的每个像素还原成它在 3D 里的位置（光栅化 UV 展开图），再按位置上色
（比如「小腿上 y 在 0.40～0.47 之间画三道白条」），所以不用手工对展开图。
原贴图的明暗（褶皱、阴影）留着，只换颜色。

用法：先跑 Robot/live2d/fetch-assets.sh，再
    python3 Robot/tools/build_sport.py Robot/live2d/models Robot/live2d/outfits
写出 outfits/sport_upper.png、sport_lower.png、sport_body.png（要提交进仓库，avatar.js 加载时换上）。
依赖：numpy、Pillow。
"""
import json, struct, sys, io, os
import numpy as np
from PIL import Image

BLACK = np.array([0.085, 0.085, 0.095])    # 外套、裙子
GOLD = np.array([0.80, 0.62, 0.25])        # 拉链
SOCK = np.array([0.50, 0.50, 0.52])        # 袜子
WHITE = np.array([0.93, 0.93, 0.94])       # 袜子的白条、鞋
SOCK_TOP = 0.50                            # 袜口高度（膝盖 0.546 下面一点），单位米
STRIPES = [(0.455, 0.470), (0.425, 0.440), (0.395, 0.410)]
SHOE_TOP = 0.135                           # 这个高度以下的下装网格是鞋


def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    return json.loads(b[20:20 + jl]), b[20 + jl + 8:]


def accessor(j, bin_, i):
    a = j['accessors'][i]
    bv = j['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    dt = np.dtype({5126: '<f4', 5123: '<u2', 5125: '<u4', 5121: 'u1'}[a['componentType']])
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    isz = dt.itemsize * n
    stride = bv.get('byteStride') or isz
    raw = np.frombuffer(bin_, dtype=np.uint8, count=(a['count'] - 1) * stride + isz, offset=off)
    if stride != isz:
        raw = np.lib.stride_tricks.as_strided(raw, shape=(a['count'], isz), strides=(stride, 1)).copy().reshape(-1)
    return raw.view(dt).reshape(a['count'], n).copy()


def mesh(j, bin_, name):
    m = next(m for m in j['meshes'] if m['name'] == name)
    p = m['primitives'][0]
    return accessor(j, bin_, p['attributes']['POSITION']), accessor(j, bin_, p['attributes']['TEXCOORD_0']), \
        accessor(j, bin_, p['indices']).reshape(-1, 3).astype(np.int64)


def texture(j, bin_, name):
    im = next(i for i in j['images'] if i['name'] == name)
    v = j['bufferViews'][im['bufferView']]
    return Image.open(io.BytesIO(bin_[v['byteOffset']:v['byteOffset'] + v['byteLength']])).convert('RGBA')


def position_map(pos, uv, idx, S):
    """展开图上每个像素对应的 3D 位置；没有网格盖到的像素是 NaN。"""
    out = np.full((S, S, 3), np.nan, dtype=np.float32)
    for t in idx:
        u = uv[t].astype(np.float64) * S
        P = pos[t]
        x0, y0 = np.maximum(np.floor(u.min(0)).astype(int) - 1, 0)
        x1, y1 = np.minimum(np.ceil(u.max(0)).astype(int) + 1, S - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + .5, np.arange(y0, y1 + 1) + .5)
        d = (u[1, 1] - u[2, 1]) * (u[0, 0] - u[2, 0]) + (u[2, 0] - u[1, 0]) * (u[0, 1] - u[2, 1])
        if abs(d) < 1e-9:
            continue
        l0 = ((u[1, 1] - u[2, 1]) * (xs - u[2, 0]) + (u[2, 0] - u[1, 0]) * (ys - u[2, 1])) / d
        l1 = ((u[2, 1] - u[0, 1]) * (xs - u[2, 0]) + (u[0, 0] - u[2, 0]) * (ys - u[2, 1])) / d
        l2 = 1 - l0 - l1
        m = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)   # 稍微放宽一点，盖住三角形的边
        pt = l0[..., None] * P[0] + l1[..., None] * P[1] + l2[..., None] * P[2]
        out[y0:y1 + 1, x0:x1 + 1][m] = pt[m]
    return out


def ss(a, b, v):
    t = np.clip((v - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def mix(base, color, w):
    return base * (1 - w[..., None]) + color * w[..., None]


def grow(valid, n):
    v = valid.copy()
    for _ in range(n):
        v = v | np.roll(v, 1, 0) | np.roll(v, -1, 0) | np.roll(v, 1, 1) | np.roll(v, -1, 1)
    return v


def save(out, name, rgb, alpha):
    im = np.dstack([np.clip(rgb, 0, 1), alpha])
    p = os.path.join(out, name)
    Image.fromarray((im * 255 + 0.5).astype(np.uint8)).save(p, optimize=True)
    print('写出', p, os.path.getsize(p) // 1024, 'KB')


def main():
    models, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    j, b = read_glb(os.path.join(models, 'Yuki_outfit1.glb'))

    # —— 上衣：白衬衫 → 黑外套，前面正中一条金色拉链，腰两边各一条斜的口袋拉链 ——
    im = texture(j, b, 'Yuki_Outfit01_ClothingUpper_BaseColor')
    S = im.size[0]
    a = np.asarray(im).astype(np.float32) / 255
    rgb = a[..., :3]
    pm = position_map(*mesh(j, b, 'ClothingUpper'), S)
    hit = ~np.isnan(pm[..., 0])
    on = grow(hit, 3)                       # 只改上衣网格盖到的地方（手镯、耳环也用这张贴图，不动）
    x, y, z = [np.nan_to_num(pm[..., i]) for i in range(3)]
    lum = rgb.mean(2)
    sat = rgb.max(2) - rgb.min(2)
    cloth = on & (lum > 0.45) & (sat < 0.25)          # 白布；原来就是黑的（领结、手套）不动
    sh = np.clip((lum - 0.55) / 0.45, 0, 1)           # 白布上的褶皱阴影
    new = BLACK[None, None, :] * (0.55 + 0.75 * sh)[..., None]
    front = ss(-0.01, 0.01, z)
    zipper = ss(0.0065, 0.0045, np.abs(x)) * front * ss(1.03, 1.05, y) * ss(1.40, 1.38, y)
    teeth = 0.8 + 0.2 * np.sign(np.sin(y * 900))

    def pocket(sx):
        x0, y0, x1, y1 = sx * 0.085, 1.165, sx * 0.068, 1.105
        dx, dy = x1 - x0, y1 - y0
        t = np.clip(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy), 0, 1)
        return ss(0.004, 0.0028, np.hypot(x - (x0 + t * dx), y - (y0 + t * dy))) * front
    zip_all = np.maximum.reduce([zipper, pocket(1), pocket(-1)]) * hit
    new = mix(new, GOLD * teeth[..., None], zip_all)
    rgb2 = np.where((cloth | (zip_all > 0.3))[..., None], new, rgb)
    save(out, 'sport_upper.png', rgb2, a[..., 3])

    # —— 下装：裙子、腰带、挂带全部变黑（留明暗），鞋变白 ——
    im = texture(j, b, 'Yuki_Outfit01_ClothingLower_BaseColor')
    S = im.size[0]
    a = np.asarray(im).astype(np.float32) / 255
    rgb = a[..., :3]
    pm = position_map(*mesh(j, b, 'ClothingLower'), S)
    hit = ~np.isnan(pm[..., 0])
    y = np.nan_to_num(pm[..., 1], nan=9.0)
    lum = rgb.mean(2)
    dark = BLACK[None, None, :] * np.clip(0.5 + lum * 1.6, 0.5, 1.5)[..., None]
    shoe = grow(hit & (y < SHOE_TOP), 4) & (~hit | (y < SHOE_TOP))
    sole = ss(0.035, 0.028, y)                         # 鞋底一圈略深
    white = WHITE[None, None, :] * np.clip(0.80 + lum * 0.9, 0.8, 1.05)[..., None]
    white = mix(white, WHITE * 0.86, sole * 0.6)
    rgb2 = np.where(shoe[..., None], white, dark)
    save(out, 'sport_lower.png', rgb2, a[..., 3])

    # —— 身体：大腿露出来（原来画着过膝袜），小腿画灰色中筒袜加三道白条，前臂画成外套的长袖 ——
    im = texture(j, b, 'Yuki_Body_BaseColor_Light')
    S = im.size[0]
    a = np.asarray(im).astype(np.float32) / 255
    rgb = a[..., :3]
    pm = position_map(*mesh(j, b, 'Yuki_Outfit01_Body'), S)
    valid = ~np.isnan(pm[..., 0])
    x, y, z = [np.nan_to_num(pm[..., i]) for i in range(3)]
    ax = np.abs(x)
    leg = valid & (ax < 0.215) & (y < 1.05)
    arm = valid & (ax > 0.25) & (y > 1.0)
    skin = rgb[arm & (rgb.mean(2) > 0.7)].mean(0)      # 肤色取手臂上的
    print('肤色', np.round(skin, 3))
    # 腿先全部换成肤色，膝盖后面加一点点红晕
    blush = np.exp(-((y - 0.546) / 0.035) ** 2) * ss(-0.06, 0.02, z) * 0.10
    legskin = skin[None, None, :] * (1 - blush[..., None] * np.array([0.0, 0.9, 1.0]))
    rgb2 = np.where((leg | (grow(leg, 6) & ~valid))[..., None], legskin, rgb)
    # 袜子：针织的竖纹用角度算（绕小腿一圈约 40 条）
    cx = np.where(x > 0, 0.071, -0.071)
    rib = 0.94 + 0.06 * np.sin(np.arctan2(z + 0.04, x - cx) * 40)
    sock = ss(SOCK_TOP + 0.003, SOCK_TOP - 0.003, y) * leg
    sockc = SOCK[None, None, :] * rib[..., None] * (1 - 0.10 * ss(SOCK_TOP - 0.02, SOCK_TOP, y))[..., None]   # 袜口略深
    for lo, hi in STRIPES:
        sockc = mix(sockc, WHITE, ss(lo - 0.002, lo + 0.002, y) * ss(hi + 0.002, hi - 0.002, y))
    rgb2 = mix(rgb2, sockc, sock)
    # 长袖：到手腕为止（手臂斜着放，沿手臂方向量：肩 (0.112, 1.394) → 手腕 (0.459, 1.068)，全长 0.476）
    along = (ax - 0.112) * 0.729 + (1.394 - y) * 0.685
    sleeve = ss(0.492, 0.482, along) * arm
    rgb2 = mix(rgb2, BLACK, sleeve)
    save(out, 'sport_body.png', rgb2, a[..., 3])


if __name__ == '__main__':
    main()
