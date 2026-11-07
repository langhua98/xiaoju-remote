# Yunlai Robot 面部动画

手机是机器人的脸。这里有两个版本，用同一套消息协议：

| 目录 | 内容 | 适合 |
|------|------|------|
| `avatar/` | 3D 角色（three.js + three-vrm，读取 VRM 模型） | 主力版本 |
| `face/` | 2D 冰蓝数字眼睛（单个 HTML，Canvas 2D） | 3D 模型加载失败时自动回退；最省电 |

## 本地试看

```bash
python3 Robot/face_server.py          # 只用 Python 标准库
```
手机和电脑在同一个网络里，手机打开终端打印出来的地址（`http://电脑IP:8765/avatar/?ws=auto`）。
在终端输入 `listening`、`thinking`、`speaking happy`、`gimbal -30`、`event anomaly` 等，脸会跟着变。输入 `help` 看全部指令。

不带 `?ws=` 打开页面时会自动播放演示。

网址参数：`ws=auto|ws://…`、`demo=0|1`、`debug=1`（也可以连点三下屏幕）、`fps=30|60|auto`、`idle=45`（多少秒没消息回待机）、`mic=1`（用本机麦克风驱动倾听声波）、`dpr=1.5`、`model=模型地址`（只对 3D 版有效）。

## 消息协议（WebSocket 文本帧，JSON）

```json
{"type": "robot_state", "state": "speaking", "emotion": "happy", "gaze": {"x": 0.2, "y": -0.1}, "mouth_level": 0.65}
```
- `state`：`idle` / `listening` / `thinking` / `speaking` / `observing`
- `emotion`：`neutral` / `happy` / `alert` / `surprised` / `confused`；加 `duration_ms` 表示临时情绪，到时间自动恢复
- `gaze`：视线，-1 到 1，x 向右为正，y 向下为正
- `mouth_level`：0 到 1，嘴部开合

其他消息：
- `{"type":"gimbal","yaw":-30,"pitch":0}`：云台角度（度），眼睛和头部跟着看过去；`"connected":false` 表示云台断开
- `{"type":"event","name":"…"}`：`boot`、`person_detected`（带 `x`、`y`）、`voice_start`、`speech_end`、`answer_start`、`answer_end`、`anomaly`、`idle` 等，对应说明书第四节
- `{"type":"speak","url":"…"}`：播放一段 TTS 音频，嘴型跟着真实音量动（音频要允许跨域）
- `{"type":"sensing","camera":true,"mic":true}`：屏幕顶部显示「摄像头 / 麦克风工作中」

页面会发回：`face_ready`、`touch`（被点了一下）、`speak_end`。在 App 的 WKWebView 里，也可以直接调用 `window.YunlaiFace.apply({...})`，页面消息会同时发到 `webkit.messageHandlers.yunlai`。

WebSocket 断线时，页面回到待机，并且每隔 1、2、4…15 秒自动重连。

## 换 3D 角色

模型用 VRoid Studio 自己捏，导出 VRM 1.0。为了 iPhone 7 Plus 跑得动：打开「减少多边形」（3 万面左右），贴图图集选 2048，文件最好在 15 MB 以内。
换模型有三种办法：替换 `avatar/models/sample.vrm`；网址加 `?model=…`；在页面上长按 2 秒选 `.vrm` 文件（会存在手机上）。

`avatar/models/sample.vrm` 是 pixiv 的示例模型（VRM1_Constraint_Twist_Sample，VRM Public License 1.0，允许再分发和商用），只是占位用。

## 改 3D 版代码

源码在 `avatar/src/`（`brain.js` 是状态和协议，`main.js` 是 3D 画面）。改完要重新打包，生成的 `avatar.js` 也要提交，这样手机上不用任何构建就能打开：
```bash
cd Robot/avatar && npm install && npm run build
```
打包目标是 Safari 15（iOS 15 不支持 import map，所以打成一个普通脚本）。

## 测试

```bash
node Robot/test/test_face.js      # 需要 playwright
```
它启动 `face_server.py`，用浏览器打开两个版本，从终端发指令，检查状态、情绪、视线、嘴型，以及断线后回到待机。

## 性能（iPhone 7 Plus / A10）

- 目标 30 FPS；设备够快时自动升到 60，掉帧时退回 30。
- 2D 版只用 Canvas 2D，光晕是预先画好的贴图，不做实时模糊；3D 版像素比限 1.5 倍。
