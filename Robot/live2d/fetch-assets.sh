#!/bin/sh
# 下载第三方素材（不放进仓库，各有各的授权）：
# - Live2D Cubism Core：Live2D 官方运行库，属于「可再分发代码」，
#   授权见 https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
# - 桃濑日和（Hiyori）FREE：Live2D 官方示例模型，个人和小规模企业可商用，
#   授权见 https://www.live2d.com/zh-CHS/download/sample-data/ 。这里用 AIRI 项目的镜像下载。
set -e
cd "$(dirname "$0")"
mkdir -p vendor models
curl -fL -o vendor/live2dcubismcore.min.js https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
curl -fL -o models/hiyori.zip https://dist.ayaka.moe/live2d-models/hiyori_free_zh.zip
rm -rf models/hiyori_free_zh
unzip -q -o models/hiyori.zip -d models
rm models/hiyori.zip
echo "完成：vendor/live2dcubismcore.min.js、models/hiyori_free_zh/"
