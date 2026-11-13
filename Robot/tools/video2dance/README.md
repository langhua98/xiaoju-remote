# 从视频做舞蹈

把一段单人跳舞的视频变成 Yuki 能跳的动画（`Robot/live2d/dances/*.json`）。三套衣服都能用。

## 对视频的要求

- 一个人、全身都在画面里、镜头不动、背景干净。
- 10～20 秒为宜。转身可以（MediaPipe 认背面还算准），但脚朝镜头时脚的方向读不出来，会自动改用身体朝向。
- 视频要有权用（自己拍的、AI 生成的）。

## 步骤

```bash
# 1. 装 MediaPipe（只在电脑上用，不进 App）
python3 -m venv mpenv && ./mpenv/bin/pip install mediapipe opencv-python-headless
curl -L -o pose_landmarker_heavy.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
# Linux 上还要：apt-get install libegl1 libgles2

# 2. 认出每帧 33 个 3D 关键点
./mpenv/bin/python detect.py 视频.mp4 pose_landmarker_heavy.task pose.json
# 再在 pose.json 里补上视频的宽高："w": 768, "h": 1152

# 3. 在真的角色上把关键点套到骨骼（要先 sh ../../live2d/fetch-assets.sh，在 Robot/live2d 里开 python3 -m http.server 8123）
node run_solve.cjs pose.json solve.js ../../live2d/dances/新舞蹈.json

# 4. 在 Robot/live2d/src/dances.js 的 DANCES 里加一行，src/motion.js 的 ACTIONS 里加个名字，
#    App/Body.swift 的 actions 和 menu「舞蹈」里加一项；然后 npm run build
```

## solve.js 做了什么

- 胯、胸：用两边胯、两边肩的连线搭出完整朝向（转身就是这么来的）；腰椎在胯和胸之间按比例分。
- 头：用两只耳朵和鼻子；第 0 帧当成「站直看前面」，扣掉关键点和真实头部朝向的固定偏差。
- 胳膊：大臂指向肘，再绕大臂转，让肘的铰链轴（从角色自带动画里找出来的）和视频里胳膊弯曲的平面对上；小臂只绕铰链轴弯。
  不这样做，肘会每帧绕自己拧来拧去。
- 腿：大腿、小腿指向关键点；脚尖方向读不出来或朝后时用身体朝向。
- 手腕、手指：视频里手部的点太抖，不用，手腕跟着小臂。
- 腰的位置：左右跟着视频里胯的移动；高低按每帧低的那只脚踩在地上算。
- 最后每根骨骼前后两个方向各平滑一遍（不会拖慢）。

头发、裙子、手指、表情不从视频里来，借用待机动画（见 `src/dances.js`），裙子还有物理。
