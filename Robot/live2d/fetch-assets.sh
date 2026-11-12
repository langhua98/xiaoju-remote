#!/bin/sh
# 下载角色模型（不放进仓库，每个约 30～60 MB）：
# Yuki 的两套衣服，同一个角色，放在公开数据集 langhua1998/yuki-model。
# 手机模型_含骨骼动画.glb（280 MB）不用，也不下载。
set -e
cd "$(dirname "$0")"
mkdir -p models
BASE=https://huggingface.co/datasets/langhua1998/yuki-model/resolve/main
for f in Yuki_outfit1.glb Yuki_outfit2.glb; do
  curl -fL --retry 3 -o "models/$f" "$BASE/$f"
done
ls -l models
echo "完成：models/Yuki_outfit1.glb、models/Yuki_outfit2.glb"
