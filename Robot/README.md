# Yunlai Robot 面部（Live2D）

手机是机器人的脸。角色用 **Live2D 桃濑日和（Hiyori）**，也就是开源项目 [AIRI](https://github.com/moeru-ai/airi) 默认带的 Live2D 角色。

显示、待机动作、眨眼、头发物理、视线、语音口型都交给开源库：
- [pixi.js](https://github.com/pixijs/pixijs) 7（MIT）
- [pixi-live2d-display-lipsyncpatch](https://github.com/RaSan147/pixi-live2d-display)（MIT，带口型同步）

我们自己只写了一层接入代码 `live2d/src/main.js`：把说明书里的 `robot_state` 消息翻译成模型参数，再连上 WebSocket。

## 在「小橘遥控」App 里使用（机器人模式）

App 设置页有「机器人模式 → 打开机器人的脸」。打开后整个屏幕是 Hiyori 的脸，待命照常进行，连点三下退出。

- GitHub Actions 编译前先运行 `fetch-assets.sh`，把模型和 Live2D 运行库下载下来，再把 `Robot/live2d` 整个打进 App。
- App 用 `yunlai://face/index.html` 打开这个网页（`App/RobotFace.swift`），通过 `window.YunlaiFace.apply(...)` 发消息。
- 待命收到指令时：拍照 → 观察，并提示「摄像头工作中」；录音 → 倾听，并提示「麦克风工作中」；响铃 → 说话；其他 → 思考。完成后开心一下，口令不对就疑惑。
- 屏幕底部一直有一行淡淡的「● 待命中 · 设备名」，被远程使用时看得出来。

### 对话（`App/Talk.swift`）

1. 在设置页「对话（大模型）」填接口地址、模型名、API 密钥（OpenAI 兼容接口，比如 `https://api.deepseek.com/v1` + `deepseek-chat`）。密钥只存钥匙串。
2. 进入机器人模式，点一下屏幕开始说话（屏幕上方显示「麦克风工作中」），停顿约 0.8 秒自动结束。
3. iOS 语音识别把话转成文字 → 大模型流式回答 → 写出一句就交给 Kokoro 合成一句、马上播，后面的边播边合成。脸的状态依次是倾听 → 思考 → 说话，嘴跟着真实音量动。
   - 声音：Kokoro-82M 中文版（Apache-2.0），女声 `zf_088`，跑在小橘视频流式服务的 Space 上（`langhua98/xiaoju-video` 的 `streamer/tts_proxy.py`，地址 `https://langhua1998-douyin-proxy.hf.space/tts`）。它闲 10 分钟会关，进机器人模式时 App 先叫醒它。
   - Kokoro 连不上或没回音频时，那一句改用 iOS 自带中文语音读。设置页可以改语音服务地址和音色（`zf_001`…`zf_099` 等 Kokoro 音色，或 `melo` 换 MeloTTS 女声），地址空着就一直用 iOS 自带语音。
4. 大模型被要求在回答前写一个情绪标签（`[happy]` 等），脸按这个情绪变表情，标签不会被读出来。
5. 她在想或在说的时候，点一下可以打断。最近 12 句对话会作为上下文。

## 在电脑上调试网页



```bash
cd Robot/live2d
sh fetch-assets.sh     # 下载 Live2D 运行库和 Hiyori 模型（不放进仓库）
npm install && npm run build   # 只有改了 src/main.js 才需要；live2d.js 已经提交
python3 -m http.server 8000 -d ..   # 然后打开 http://电脑IP:8000/live2d/
```

不带 `?ws=` 打开时自动播放演示。网址参数：`ws=ws://…/ws`（或 `ws=auto`，同一主机的 `/ws`）、`demo=0`、`fps=30|60`、`idle=45`（多少秒没消息回待机）、`model=其他 model3.json 地址`。

## 消息协议（WebSocket 文本帧，JSON）

```json
{"type": "robot_state", "state": "speaking", "emotion": "happy", "gaze": {"x": 0.2, "y": -0.1}, "mouth_level": 0.65}
```
- `state`：`idle` / `listening` / `thinking` / `speaking` / `observing`
- `emotion`：`neutral` / `happy` / `alert` / `surprised` / `confused`；加 `duration_ms` 表示临时情绪
- `gaze`：-1 到 1，x 向右为正，y 向下为正
- `mouth_level`：0 到 1

其他消息：
- `{"type":"gimbal","yaw":-30,"pitch":0}`：云台角度，角色跟着看过去；`"connected":false` 表示云台断开
- `{"type":"event","name":"…"}`：`voice_start`、`speech_end`、`answer_start`、`answer_end`、`anomaly`、`person_detected`（带 `x`、`y`）、`idle`
- `{"type":"speak","url":"…"}`：播放 TTS 音频，库根据真实音量对口型（音频要允许跨域）
- `{"type":"sensing","camera":true,"mic":true}`：屏幕顶部显示「摄像头 / 麦克风工作中」

页面发回 `face_ready`、`touch`、`speak_end`。在 App 的 WKWebView 里也可以直接调用 `window.YunlaiFace.apply({...})`。WebSocket 断线时回到待机，并自动重连。

## 授权

| 东西 | 授权 | 是否放进仓库 |
|------|------|------|
| pixi.js、pixi-live2d-display-lipsyncpatch | MIT | 打包在 `live2d.js` 里 |
| Live2D Cubism Core | Live2D 专有软件许可，属于「可再分发代码」 | 否，用脚本下载 |
| 桃濑日和 FREE | Live2D 免费素材许可：个人和小规模企业可商用，中大型企业只能内部试用 | 否，用脚本下载 |

## 还没确认的事

- iPhone 7 Plus（iOS 15）上的流畅度还没实测，默认限 30 FPS。
- 云台控制端还没接，现在只是脸跟着 `gimbal` 消息转。
