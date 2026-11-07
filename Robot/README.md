# Yunlai Robot 面部（Live2D）

手机是机器人的脸。角色用 **Live2D 桃濑日和（Hiyori）**，也就是开源项目 [AIRI](https://github.com/moeru-ai/airi) 默认带的 Live2D 角色。

显示、待机动作、眨眼、头发物理、视线、语音口型都交给开源库：
- [pixi.js](https://github.com/pixijs/pixijs) 7（MIT）
- [pixi-live2d-display-lipsyncpatch](https://github.com/RaSan147/pixi-live2d-display)（MIT，带口型同步）

我们自己只写了一层接入代码 `live2d/src/main.js`：把说明书里的 `robot_state` 消息翻译成模型参数，再连上 WebSocket。

## 第一次使用

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
