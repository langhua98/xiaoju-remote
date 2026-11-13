#!/bin/sh
# 下载角色模型（不放进仓库，每个约 40～95 MB）：
# Yuki 的三套衣服（校服、洋装、运动装），同一个角色，放在公开数据集 langhua1998/yuki-model。
# 手机模型_含骨骼动画.glb（280 MB）不用，也不下载。
set -e
cd "$(dirname "$0")"
mkdir -p models
BASE=https://huggingface.co/datasets/langhua1998/yuki-model/resolve/main
for f in Yuki_outfit1.glb Yuki_outfit2.glb Yuki_sporty.glb; do
  curl -fL --retry 3 -o "models/$f" "$BASE/$f"
done
ls -l models
echo "完成：models/Yuki_outfit1.glb、Yuki_outfit2.glb、Yuki_sporty.glb"
