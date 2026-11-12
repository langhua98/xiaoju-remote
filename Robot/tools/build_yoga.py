#!/usr/bin/env python3
"""用第一、二套模型拼出「瑜伽服」模型 Yuki_yoga.glb（不改骨骼和动画，所以动作、物理、表情都照旧）。

两套的身体网格都不完整（被衣服挡住的部分没做）：
  - 第一套的身体网格有手臂、手、腿、脚，但没有胸腹（被上衣挡住了）。
  - 第二套的身体网格有躯干，但没有上臂和脚。
  所以：以第一套为底（头发、脸、手臂、腿、脚都用它的），去掉它的上衣和下装网格，再从第二套的身体网格里剪出躯干补上。

身体贴图直接画上紧身衣：黑色运动内衣 + 高腰紧身裤，露出肚脐、手臂、手和脚。
画法见 paint()：先把每张贴图的每个像素还原成它在 3D 里的位置（光栅化 UV），再按位置（高度、左右、前后）上色，
所以不需要 AI 画贴图的展开图。布料花纹用 fabric.png（AI 生成的无缝黑色针织布，可选）；没有就用程序画的细针织纹。

用法：先跑 fetch-assets.sh 下载两套模型，再
    python3 Robot/tools/build_yoga.py Robot/live2d/models [fabric.png]
会写出 Robot/live2d/models/Yuki_yoga.glb。依赖：numpy、Pillow。
"""
import json, struct, sys, io, os
import numpy as np
from PIL import Image

S = 1024
# 腰线（紧身裤上沿）、裤脚（脚踝）、内衣的范围，单位是模型的米（脚底 0，头顶约 1.6）
WAIST, ANKLE = 1.10, 0.125
TORSO = (1.09, 1.38, 0.2)       # 上衣网格里取哪一段当躯干：高度下限、上限、左右范围
BAND = (1.205, 1.285)         # 内衣下围带


def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    return json.loads(b[20:20 + jl]), b[20 + jl + 8:]


def accessor(j, bin_, i):
    a = j['accessors'][i]
    bv = j['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    dt = np.dtype({5126: '<f4', 5123: '<u2', 5125: '<u4', 5121: 'u1'}[a['componentType']])
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    isz = dt.itemsize * n
    stride = bv.get('byteStride') or isz
    raw = np.frombuffer(bin_, dtype=np.uint8, count=(a['count'] - 1) * stride + isz, offset=off)
    if stride != isz:
        raw = np.lib.stride_tricks.as_strided(raw, shape=(a['count'], isz), strides=(stride, 1)).copy().reshape(-1)
    return raw.view(dt).reshape(a['count'], n).copy()


def body_mesh(j, bin_, name):
    m = next(m for m in j['meshes'] if name in m['name'])
    p = m['primitives'][0]
    g = {k: accessor(j, bin_, v) for k, v in p['attributes'].items()}
    g['idx'] = accessor(j, bin_, p['indices']).reshape(-1, 3).astype(np.int64)
    return g


def position_map(g):
    """把 UV 展开图上的每个像素还原成 3D 位置（光栅化三角形）。没有网格覆盖的像素是 NaN。"""
    pos, uv, idx = g['POSITION'], g['TEXCOORD_0'], g['idx']
    out = np.full((S, S, 3), np.nan, dtype=np.float32)
    for t in idx:
        u = uv[t].astype(np.float64) * S
        P = pos[t]
        x0, y0 = np.maximum(np.floor(u.min(0)).astype(int), 0)
        x1, y1 = np.minimum(np.ceil(u.max(0)).astype(int), S - 1)
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + .5, np.arange(y0, y1 + 1) + .5)
        d = (u[1, 1] - u[2, 1]) * (u[0, 0] - u[2, 0]) + (u[2, 0] - u[1, 0]) * (u[0, 1] - u[2, 1])
        if abs(d) < 1e-9:
            continue
        l0 = ((u[1, 1] - u[2, 1]) * (xs - u[2, 0]) + (u[2, 0] - u[1, 0]) * (ys - u[2, 1])) / d
        l1 = ((u[2, 1] - u[0, 1]) * (xs - u[2, 0]) + (u[0, 0] - u[2, 0]) * (ys - u[2, 1])) / d
        l2 = 1 - l0 - l1
        m = (l0 >= -1e-4) & (l1 >= -1e-4) & (l2 >= -1e-4)
        pt = l0[..., None] * P[0] + l1[..., None] * P[1] + l2[..., None] * P[2]
        sub = out[y0:y1 + 1, x0:x1 + 1]
        sub[m] = pt[m]
    return out


def ss(a, b, v):
    t = np.clip((v - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def cloth_mask(pos, with_bra=True):
    valid = ~np.isnan(pos[..., 0])
    x, y, z = [np.nan_to_num(pos[..., i]) for i in range(3)]
    ax = np.abs(x)
    leg = ss(WAIST + 0.006, WAIST - 0.006, y) * ss(0.215, 0.19, ax) * ss(ANKLE - 0.008, ANKLE + 0.008, y)
    parts = [leg]
    if with_bra:
        band = ss(BAND[0], BAND[0] + 0.01, y) * ss(BAND[1], BAND[1] - 0.01, y) * ss(0.2, 0.18, ax)

        def cup(cx, cy, rx, ry):
            d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
            return ss(1.0, 0.86, d) * ss(-0.02, 0.0, z)
        cups = np.maximum(cup(0.058, 1.318, 0.082, 0.075), cup(-0.058, 1.318, 0.082, 0.075))
        cups = np.maximum(cups, ss(0.03, 0.02, ax) * ss(1.255, 1.265, y) * ss(1.33, 1.32, y) * ss(-0.02, 0.0, z))

        def strap(x0, y0, x1, y1, w, front):
            dx, dy = x1 - x0, y1 - y0
            t = np.clip(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy), 0, 1)
            d = np.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
            side = ss(-0.02, 0.0, z) if front else ss(0.0, -0.02, z)
            return ss(w, w * 0.7, d) * side
        straps = np.maximum.reduce([
            strap(0.065, 1.37, 0.085, 1.41, 0.0085, True), strap(-0.065, 1.37, -0.085, 1.41, 0.0085, True),
            strap(0.085, 1.41, -0.03, 1.255, 0.0085, False), strap(-0.085, 1.41, 0.03, 1.255, 0.0085, False)])
        parts += [band, cups, straps]
    return np.maximum.reduce(parts) * valid, valid


def skin_color(models):
    """肤色：取脸部贴图里亮的像素的平均值，身体和脸才接得上。"""
    j, b = read_glb(os.path.join(models, 'Yuki_outfit2.glb'))
    im = next(i for i in j['images'] if i['name'] == 'Yuki_Head_BaseColor')
    bv = j['bufferViews'][im['bufferView']]
    a = np.asarray(Image.open(io.BytesIO(b[bv['byteOffset']:bv['byteOffset'] + bv['byteLength']])).convert('RGB')).astype(np.float32) / 255
    lum = a.mean(2)
    m = (lum > 0.6) & (lum < 0.95)
    return a[m].mean(0)


def fabric_tile(path):
    if path and os.path.exists(path):
        f = np.asarray(Image.open(path).convert('RGB').resize((S, S))).astype(np.float32) / 255
        return f
    rng = np.random.default_rng(3)
    i = np.arange(S)
    weave = 1 + 0.07 * np.sin(i[None, :] * np.pi / 2) * np.sin(i[:, None] * np.pi / 2) + 0.03 * rng.standard_normal((S, S))
    return np.clip(np.array([0.075, 0.075, 0.085])[None, None, :] * weave[..., None], 0, 1)


def paint(pos, skin, fabric, with_bra=True, shade=None):
    cloth, valid = cloth_mask(pos, with_bra)
    base = np.broadcast_to(skin, (S, S, 3)).astype(np.float32)
    if shade is not None:
        base = base * shade[..., None]
    c = cloth[..., None]
    out = base * (1 - c) + fabric * c
    # 岛外的像素向外扩 12 圈，防止采样时漏出旧颜色
    vv = valid.copy()
    res = out.copy()
    for _ in range(12):
        acc = np.zeros_like(res)
        cnt = np.zeros((S, S, 1))
        for dy, dx in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            sv = np.roll(vv, (dy, dx), (0, 1))
            sr = np.roll(res, (dy, dx), (0, 1))
            m = (sv & ~vv)[..., None]
            acc += sr * m
            cnt += m
        new = cnt[..., 0] > 0
        res[new] = acc[new] / cnt[new]
        vv = vv | new
    return Image.fromarray((np.clip(res, 0, 1) * 255).astype(np.uint8))


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def orig_body_texture(j, bin_):
    im = next(i for i in j['images'] if 'Body' in i['name'] and 'AO' not in i['name'])
    v = j['bufferViews'][im['bufferView']]
    return np.asarray(Image.open(io.BytesIO(bin_[v['byteOffset']:v['byteOffset'] + v['byteLength']])).convert('RGB')).astype(np.float32) / 255


def main():
    models = sys.argv[1]
    fab = fabric_tile(sys.argv[2] if len(sys.argv) > 2 else None)
    j2, b2 = read_glb(os.path.join(models, 'Yuki_outfit2.glb'))
    j1, bb = read_glb(os.path.join(models, 'Yuki_outfit1.glb'))   # 底：第一套
    body1 = body_mesh(j1, bb, 'Body')
    body2 = body_mesh(j2, b2, 'Body')

    # 第一套的身体贴图：手臂、手、脖子照旧（肤色自然），腿上原来画的丝袜换成肤色 / 紧身裤
    pos1 = position_map(body1)
    orig = orig_body_texture(j1, bb)
    valid1 = ~np.isnan(pos1[..., 0])
    arm = valid1 & (np.abs(np.nan_to_num(pos1[..., 0])) > 0.25) & (np.nan_to_num(pos1[..., 1]) > 1.0)
    skin = orig[arm].mean(0)
    print('肤色', np.round(skin, 3))
    keep_orig = ~(valid1 & (np.abs(np.nan_to_num(pos1[..., 0])) < 0.215) & (np.nan_to_num(pos1[..., 1]) < WAIST + 0.03))
    base = np.where(keep_orig[..., None], orig, skin[None, None, :])
    tex_body = paint(pos1, base, fab, False)

    # 躯干：第一套的上衣网格是完整的一圈（从肩到腰），取中间的躯干部分（去掉袖子、领子），贴图重画成肤色 + 运动内衣
    shirt = body_mesh(j1, bb, 'ClothingUpper')
    p2 = shirt['POSITION'][shirt['idx']]
    c = p2.mean(1)
    sel = (c[:, 1] > TORSO[0]) & (c[:, 1] < TORSO[1]) & (np.abs(c[:, 0]) < TORSO[2])
    tri = shirt['idx'][sel]
    used, inv = np.unique(tri, return_inverse=True)
    feet = {k: shirt[k][used] for k in ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']}
    feet['idx'] = inv.reshape(-1, 3)
    print('躯干：顶点', len(used), '三角形', len(tri))
    g = dict(shirt)
    g['idx'] = tri
    tpos = position_map(g)
    tex_feet = paint(tpos, skin, fab, True)

    # —— 拼 glb ——
    j = json.loads(json.dumps(j1))
    drop = {m['name'] for m in j['meshes'] if m['name'] in ('ClothingUpper', 'ClothingLower')}
    bin_chunks = []   # 新的二进制：重新排
    new_bv, new_acc, new_img = [], [], []

    def add_view(data, target=None):
        pad = (-sum(len(c) for c in bin_chunks)) % 4
        if pad:
            bin_chunks.append(b'\0' * pad)
        off = sum(len(c) for c in bin_chunks)
        bin_chunks.append(bytes(data))
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        new_bv.append(v)
        return len(new_bv) - 1

    acc_map, bv_map = {}, {}

    def copy_acc(i):
        if i in acc_map:
            return acc_map[i]
        a = json.loads(json.dumps(j['accessors'][i]))

        def view(bi):
            if bi not in bv_map:
                v = j['bufferViews'][bi]
                data = bb[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
                nv = add_view(data, v.get('target'))
                if v.get('byteStride'):
                    new_bv[nv]['byteStride'] = v['byteStride']
                bv_map[bi] = nv
            return bv_map[bi]
        if 'bufferView' in a:
            a['bufferView'] = view(a['bufferView'])
        if 'sparse' in a:   # 表情形变（morph target）是稀疏访问器
            a['sparse']['indices']['bufferView'] = view(a['sparse']['indices']['bufferView'])
            a['sparse']['values']['bufferView'] = view(a['sparse']['values']['bufferView'])
        new_acc.append(a)
        acc_map[i] = len(new_acc) - 1
        return acc_map[i]

    def new_accessor(arr, ctype, typ, target=None, minmax=False):
        nv = add_view(np.ascontiguousarray(arr).tobytes(), target)
        a = {'bufferView': nv, 'componentType': ctype, 'count': len(arr), 'type': typ}
        if minmax:
            a['min'] = arr.min(0).astype(float).tolist()
            a['max'] = arr.max(0).astype(float).tolist()
        new_acc.append(a)
        return len(new_acc) - 1

    # 图片：只带还在用的
    mats_used = set()
    meshes = []
    for m in j['meshes']:
        if m['name'] in drop:
            meshes.append(None)
            continue
        for p in m['primitives']:
            mats_used.add(p['material'])
        meshes.append(m)
    body_mat = next(p['material'] for m in j['meshes'] if 'Body' in m['name'] for p in m['primitives'])
    tex_used = set()
    for mi in mats_used:
        mt = j['materials'][mi]
        for key in ('occlusionTexture', 'normalTexture', 'emissiveTexture'):
            if key in mt:
                tex_used.add(mt[key]['index'])
        pb = mt.get('pbrMetallicRoughness', {})
        for key in ('baseColorTexture', 'metallicRoughnessTexture'):
            if key in pb:
                tex_used.add(pb[key]['index'])
    img_map = {}

    def copy_image(ii):
        if ii in img_map:
            return img_map[ii]
        im = dict(j['images'][ii])
        v = j['bufferViews'][im['bufferView']]
        im['bufferView'] = add_view(bb[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']])
        new_img.append(im)
        img_map[ii] = len(new_img) - 1
        return img_map[ii]

    body_tex_index = j['materials'][body_mat]['pbrMetallicRoughness']['baseColorTexture']['index']
    tex_map = {}
    new_tex = []
    for ti in sorted(tex_used):
        t = dict(j['textures'][ti])
        if ti == body_tex_index:
            ii = len(new_img)
            new_img.append({'name': 'Yuki_Yoga_Body_BaseColor', 'mimeType': 'image/png', 'bufferView': add_view(png_bytes(tex_body))})
            t['source'] = ii
        else:
            t['source'] = copy_image(t['source'])
        new_tex.append(t)
        tex_map[ti] = len(new_tex) - 1
    # 脚用的贴图和材质
    feet_img = len(new_img)
    new_img.append({'name': 'Yuki_Yoga_Torso_BaseColor', 'mimeType': 'image/png', 'bufferView': add_view(png_bytes(tex_feet))})
    new_tex.append({'sampler': j['textures'][body_tex_index].get('sampler', 0), 'source': feet_img})
    feet_tex = len(new_tex) - 1

    mat_map, new_mats = {}, []
    for mi in sorted(mats_used):
        mt = json.loads(json.dumps(j['materials'][mi]))
        for key in ('occlusionTexture', 'normalTexture', 'emissiveTexture'):
            if key in mt:
                mt[key]['index'] = tex_map[mt[key]['index']]
        pb = mt.get('pbrMetallicRoughness', {})
        for key in ('baseColorTexture', 'metallicRoughnessTexture'):
            if key in pb:
                pb[key]['index'] = tex_map[pb[key]['index']]
        new_mats.append(mt)
        mat_map[mi] = len(new_mats) - 1
    feet_mat = json.loads(json.dumps(j['materials'][body_mat]))
    feet_mat.pop('occlusionTexture', None)
    feet_mat['name'] = 'Yuki_Yoga_Torso_mat'
    feet_mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': feet_tex}
    for k in ('normalTexture', 'emissiveTexture'):
        feet_mat.pop(k, None)
    new_mats.append(feet_mat)
    feet_mat_i = len(new_mats) - 1

    # 网格
    mesh_map, new_meshes = {}, []
    for k, m in enumerate(meshes):
        if m is None:
            continue
        m = json.loads(json.dumps(m))
        for p in m['primitives']:
            p['attributes'] = {a: copy_acc(i) for a, i in p['attributes'].items()}
            if 'indices' in p:
                p['indices'] = copy_acc(p['indices'])
            if 'targets' in p:
                p['targets'] = [{a: copy_acc(i) for a, i in t.items()} for t in p['targets']]
            p['material'] = mat_map[p['material']]
        new_meshes.append(m)
        mesh_map[k] = len(new_meshes) - 1
    f = feet
    prim = {'attributes': {
        'POSITION': new_accessor(f['POSITION'].astype('<f4'), 5126, 'VEC3', 34962, True),
        'NORMAL': new_accessor(f['NORMAL'].astype('<f4'), 5126, 'VEC3', 34962),
        'TEXCOORD_0': new_accessor(f['TEXCOORD_0'].astype('<f4'), 5126, 'VEC2', 34962),
        'JOINTS_0': new_accessor(f['JOINTS_0'].astype('<u2'), 5123, 'VEC4', 34962),
        'WEIGHTS_0': new_accessor(f['WEIGHTS_0'].astype('<f4'), 5126, 'VEC4', 34962)},
        'indices': new_accessor(f['idx'].reshape(-1).astype('<u4'), 5125, 'SCALAR', 34963), 'material': feet_mat_i}
    new_meshes.append({'name': 'Yuki_Yoga_Torso', 'primitives': [prim]})
    feet_mesh = len(new_meshes) - 1

    # 节点：去掉被删网格的节点，加脚的节点
    nodes = j['nodes']
    removed = {i for i, n in enumerate(nodes) if n.get('mesh') is not None and meshes[n['mesh']] is None}
    body_node = next(i for i, n in enumerate(nodes) if n.get('mesh') is not None and meshes[n['mesh']] is not None and 'Body' in n['name'])
    parent = next(i for i, n in enumerate(nodes) if body_node in n.get('children', []))
    for i, n in enumerate(nodes):
        if 'children' in n:
            n['children'] = [c for c in n['children'] if c not in removed]
        if n.get('mesh') is not None and i not in removed:
            n['mesh'] = mesh_map[n['mesh']]
    nodes.append({'name': 'Yuki_Yoga_Torso', 'mesh': feet_mesh, 'skin': 0})
    nodes[parent]['children'].append(len(nodes) - 1)
    for i in sorted(removed):
        nodes[i].pop('mesh', None)
        nodes[i].pop('skin', None)

    # 动画和皮肤的访问器
    for a in j['animations']:
        for s in a['samplers']:
            s['input'] = copy_acc(s['input'])
            s['output'] = copy_acc(s['output'])
    for sk in j['skins']:
        if 'inverseBindMatrices' in sk:
            sk['inverseBindMatrices'] = copy_acc(sk['inverseBindMatrices'])

    j['meshes'], j['materials'], j['textures'], j['images'] = new_meshes, new_mats, new_tex, new_img
    j['accessors'], j['bufferViews'] = new_acc, new_bv
    blob = b''.join(bin_chunks)
    blob += b'\0' * ((-len(blob)) % 4)
    j['buffers'] = [{'byteLength': len(blob)}]
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((-len(js)) % 4)
    out = os.path.join(models, 'Yuki_yoga.glb')
    with open(out, 'wb') as fo:
        fo.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(blob)))
        fo.write(struct.pack('<I4s', len(js), b'JSON') + js)
        fo.write(struct.pack('<I4s', len(blob), b'BIN\0') + blob)
    tex_body.save(os.path.join(models, 'yoga_body_preview.png'))
    print('写出', out, round(os.path.getsize(out) / 1e6, 1), 'MB')


if __name__ == '__main__':
    main()
