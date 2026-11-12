# Yunlai Robot 角色（Yuki，3D）

手机是机器人的身体和脸。角色是 **Yuki**（3D，GLB 格式，模型放在公开数据集 [langhua1998/yuki-model](https://huggingface.co/datasets/langhua1998/yuki-model)）：
- `Yuki_outfit1.glb`（校服，默认）和 `Yuki_outfit2.glb`（洋装）是同一个角色的两套衣服，各是一个完整模型。
- 带 ARKit 的 52 个表情形变（`eyeBlinkLeft`、`jawOpen`、`mouthSmileLeft`…）、几百根骨骼，和 30 个自带动画（用其中 25 个，见下面「动作」）。动画里带道具：手机、报纸、手柄、爆米花，平时缩到 0 看不见。
- 数据集里的 `Yuki_手机模型_含骨骼动画.glb`（280 MB）不用。

显示用 [three.js](https://threejs.org/)（MIT，`GLTFLoader`）。我们自己的代码在 `live2d/src/`（文件夹名沿用旧的 `live2d`），打包成 `live2d/yuki.js`：

| 文件 | 做什么 |
|---|---|
| `main.js` | 入口：网址参数、消息、WebSocket、主循环、点击、调试面板 |
| `avatar.js` | 加载和换装、整理动画轨道、释放 |
| `toon.js` | 卡通渲染（照原作 animates 的截图调的）：两段明暗、环境遮蔽贴图当褶皱阴影、下巴和刘海的投影、眼睛上沿的阴影、头发高光、细描边、脚下的假阴影 |
| `rig.js` | 辅助骨骼（把手腕、脚踝的「拧」分摊到前臂、小腿；肩头、臀部等处的修正骨骼）和视线分配（眼 → 头 → 脖子 → 胸） |
| `face.js` | 表情、眨眼、眼球微跳、口型、说话时的点头和抬眉 |
| `spring.js` | 物理：裙子（带着惯性追动画，碰到腿会被推开）、蝴蝶结、丝带、披风、衣领、耳环 |
| `motion.js` | 动作状态机：待机循环、一次性动作、待机时自己做小动作 |
| `camera.js` | 镜头：全身和半身两个机位、轻微漂移 |

手感和观感的参数都在各文件开头的常量里（`TOON`、`SPRING_PRESETS`、`GAZE`、`FACE`、`MOTION`、`CAM`），按真机上的感觉调。设计思路和模型里查到的数据见 [YUKI_REALISM_PLAN.md](YUKI_REALISM_PLAN.md)。

## 在「小橘遥控」App 里使用（机器人模式）

打开 App 就是 Yuki（`MainView`），设置在左上角的齿轮里。

最下面是聊天框（`RobotFace.swift` 的 `ChatBar`）：
- 打字发送：她用声音回答，字幕显示在聊天框上面（闲下来 10 秒后消失）。实时语音聊天进行中，打的字会发给 Gemini。
- 短指令直接做，不问大模型，没填密钥也能用：动作名（「跳舞」「挥手」…）、镜头（「特写」「全身」「半身」「自动」）、「转身 左 90」「背对」「转回来」、「重置」，前面加 `/` 也行（`Body.quickCommand`）。
- 左边的 ✦ 按钮是快捷菜单，所有短指令都在里面，点一下就执行，不用打字（`Body.menu`）：动作、舞蹈、道具、互动（摸头、摸手、摸腿）、表情、镜头（景别、左右侧、背面、俯视仰视）、转身、视线、换装、停下 / 重置。菜单里的名字原样打在聊天框里也能执行。
- 右边没打字时是麦克风：点一下开始语音聊天（填了 Gemini 密钥就是实时语音），聊天中变成停止键。
- 点一下画面：打字时收起键盘；她在想、在说、在实时聊天时打断或结束；闲着时点她的头或手，她会有反应。第一次用、什么密钥都没填时自动打开设置；设置里可以开「打开 App 时自动待命」。点一下屏幕开始聊天；闲着的时候点她的头或手，她会有对应的反应（这一下不算开始聊天）。

- GitHub Actions 编译前先运行 `fetch-assets.sh`，从数据集下载两个 glb（约 90 MB，不进仓库），再把 `Robot/live2d` 整个打进 App。数据集要保持公开，否则编译下载会 401。
- App 用 `yunlai://face/index.html` 打开这个网页（`App/RobotFace.swift`），通过 `window.YunlaiFace.apply(...)` 发消息。
- 待命收到指令时：拍照 → 观察，并提示「摄像头工作中」；录音 → 倾听，并提示「麦克风工作中」；响铃 → 说话；其他 → 思考。完成后开心一下，口令不对就疑惑。
- 屏幕底部一直有一行淡淡的「● 待命中 · 设备名」，被远程使用时看得出来。
- 内存：iPhone 7 Plus 只有 2 GB。贴图最长边缩到 2048（`?tex=1024` 可再小），一次只加载一套衣服，换装时先加载新的再释放旧的。
- 画质：设置页「机器人模式 → 画质」选「高」或「省电」。省电 = 不描边、不算物理、贴图缩到 1024（网址参数 `outline=0&spring=0&tex=1024`）。
- 网页进程被系统关掉（多半是内存不够，屏幕会变黑）时，`RobotFace.swift` 会用省电画质自动重新打开，最多 3 次，并在「记录」里写一条。

### 对话（`App/Talk.swift`）

1. 在设置页「对话（大模型）」填 API 密钥。接口地址默认 DeepSeek（`https://api.deepseek.com/v1`，也能改成别的 OpenAI 兼容接口），模型二选一：`deepseek-chat`（快）或 `deepseek-reasoner`（先想再答，慢）。密钥只存钥匙串。
2. 进入机器人模式，点一下屏幕开始说话（屏幕上方显示「麦克风工作中」），停顿约 0.8 秒自动结束。
3. iOS 语音识别把话转成文字 → 大模型流式回答 → 写出一句就交给 Kokoro 合成一句、马上播，后面的边播边合成。脸的状态依次是倾听 → 思考 → 说话，嘴跟着真实音量动。
   - 声音：默认是 Cloudflare Workers AI 上的 MeloTTS 中文女声（`langhua98/xiaoju-music` 的 `yunlai-tts/`，地址 `https://yunlai-tts.langhua98.workers.dev`，免费额度每天 1 万 Neurons，合成过的句子缓存一天）。8 秒没回音就改问备用：小橘视频流式服务 Space 上的 Kokoro（`langhua98/xiaoju-video` 的 `streamer/tts_proxy.py`，`https://langhua1998-douyin-proxy.hf.space/tts`，音色 `zf_088` 或 `melo`，闲 10 分钟会关）。
   - 两个都连不上或没回音频时，那一句改用 iOS 自带中文语音读。两个地址都固定写在 `App/Talk.swift` 的 `Voice` 里，设置页不让改。
4. 大模型被要求在回答前写一个情绪标签（`[happy]` 等），脸按这个情绪变表情，标签不会被读出来。
5. **连续对话**：点一下开始，之后她说完自动接着听，不用每句都点；说「再见」「拜拜」「不聊了」（她会道个别）或者 8 秒不说话就结束。她在想或在说的时候点一下可以打断，她马上停下来听你说。最近 12 句对话会作为上下文。

### 实时语音（`App/Live.swift`，Gemini Live）

- 设置页「实时语音」填了 Gemini API 密钥（aistudio.google.com 免费申请）就优先用它：点一下开始，像打电话一样聊，再点一下结束；说「再见」或 30 秒没人说话也结束。
- 麦克风一直开着，iOS 回声消除（`.voiceChat` + `setVoiceProcessingEnabled`）让她说话时不会把自己的声音当成你说的，所以能直接开口打断她（服务器发 `interrupted`，排着的声音全扔掉）。
- 协议和官方 `@google/genai` SDK 一样：`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=…`，先发 `setup`（模型、`responseModalities: AUDIO`、声音 `Leda`、系统提示、要两边的文字稿），再不断发 `realtimeInput.audio`（16 kHz 16 位 PCM，每 100 毫秒一段），收 `serverContent.modelTurn` 里 24 kHz PCM。
- 模型名不写死：每次连接前 `GET /v1beta/models`，挑支持 `bidiGenerateContent`、名字里有 live / native-audio、版本最新的（谷歌经常换预览模型名）。
- 嘴型跟正在播放的声音音量动；文字稿记在 App 的「记录」里；说「换上…」照样换装。
- 连不上（密钥不对、免费额度用完、10 秒没 setupComplete）就自动改用 DeepSeek + 语音合成的普通连续对话。
- 免费档有用量上限；免费档的数据谷歌可能用来改进产品。

### 让她自己转云台（`App/Body.swift`）

- 普通模式（DeepSeek）：系统提示让她在回答里写动作标签 `[左转 30]` `[右转 30]` `[抬头 15]` `[低头 15]` `[回正]`。App 边念边转（一个转完再转下一个），标签不念出来。
- 实时模式（Gemini Live）：`setup.tools` 里声明 `move_gimbal(direction, degrees)`；服务器发 `toolCall.functionCalls`，App 转完回 `toolResponse.functionResponses`（带同一个 `id`），她再告诉你转好了。
- 左右 5～90°，上下 5～45°，`center` 回到归位点。云台没连上就告诉她「转不了」，不会装作转了。
- 每次转动都记在「记录」里（`云台（left 30）：…`）。真机上左右反了就改 `Body.perform` 里的正负号。

### 动作（`Robot/live2d/src/motion.js`）

- 消息 `{"type":"action","name":"dance"}`，页面回 `{"type":"action_done","name":"dance","ok":true}`。`name` 可以是下表的名字，也可以直接是动画名。

| name | 动画 | name | 动画 |
|---|---|---|---|
| `wave` | `hello` 挥手 | `dance` | 三个舞蹈里随机一个 |
| `nod` | `Yes` 点头 | `phone` | 掏出手机敲一会儿（`Tapping_Start/Idle/End` 连着播） |
| `shake` | `No` 摇头 | `play` | `yuki_play` 打游戏（手柄） |
| `peace` | `Peace_hand` 比耶 | `read` | `np` 看报纸 |
| `kiss` | `Kiss` 飞吻 | `popcorn` | `yuki_popcorn_idle` 吃爆米花 |
| `pose` | `Hand_Pose` | `call` | `Phone_talking` 打电话 |
| `angry` | `Yuki_Angry_With_Mouth`（只有表情，叠在当前动作上） | `touch_head`、`touch_hand_l/r`、`touch_leg_l/r` | 被摸的反应 |

- 镜头和转身也一样：`[镜头 特写]`（全身、半身、特写、自动）、`[转身 左 90]`（右、背对、回正）；实时模式的工具是 `set_camera(shot)`、`turn_body(direction, degrees)`。
- 大模型怎么触发：普通模式在回答里写 `[动作 跳舞]`（名字见 `Body.actions`：挥手、点头、摇头、跳舞、比耶、飞吻、生气、玩手机、打游戏、看报纸、吃爆米花）；实时模式调用工具 `play_action(name)`。
- 自己会做的：待机时每 15～40 秒随机做个小动作；60～120 秒没人理就掏手机、打游戏、看报纸或吃爆米花；情绪变成 `alert` 时做生气的表情；`happy` 时偶尔比耶。开始听人说话时，自己做的小动作会停下来（别人要求的动作会播完）。
- 不用的动画：`Touch_breast`、`Touch_pants`（不合适）；`Show`、`Hide`、`Hidden`（原作出入场用，从 T 字姿势开始）。
- 播一次性动作时，视线和头部的叠加降到 30%，避免和动画打架；幅度大的动作（跳舞、道具）镜头保持全身。

### 换装

- 页面收到 `{"type":"outfit","id":"outfit2"}` 时，加载另一个 glb 换上，旧的释放。`"default"` 是校服（`Yuki_outfit1.glb`）；不认识的 id（比如以前存的 `heibai`、`yeye`）回到校服。
- App：设置页「机器人模式」里选衣服；或者对她说「换上洋装」「换回校服」（`Store.outfitCommand`，不经过大模型）。
- 新加一套：把 glb 传到数据集，在 `fetch-assets.sh`、`src/avatar.js` 的 `OUTFITS`、`App/Store.swift` 的 `Store.outfits` 里各加一行，再重新打包。物理和辅助骨骼是按「哪些骨骼在所有动画里都不动」自动找的，新衣服不用另外配置。
- App 打开页面时在网址里带 `outfit=<id>`，直接加载要穿的那套，不用先加载校服再换。

## 在电脑上调试网页



```bash
cd Robot/live2d
sh fetch-assets.sh     # 下载两个 Yuki 模型到 models/（不放进仓库）
npm install && npm run build   # 只有改了 src/ 才需要；yuki.js 已经提交
npm test                       # 物理和骨骼的数学测试（node --test）
python3 -m http.server 8000 -d ..   # 然后打开 http://电脑IP:8000/live2d/
```

不带 `?ws=` 打开时自动播放演示。网址参数：`ws=ws://…/ws`（或 `ws=auto`，同一主机的 `/ws`）、`demo=0`、`idle=45`（多少秒没消息回待机）、`outfit=outfit2`（一开始穿哪套），以及下面的开关。

### 开关（网址参数）

每个效果都能单独关，真机上卡了可以逐个试。

| 参数 | 默认 | 作用 |
|---|---|---|
| `toon` | 1 | 卡通材质；0 回到原来的写实材质加灯光 |
| `outline` | 1 | 描边；0 不描；2 连顶点特别多的网格（第二套的裙子，4.5 万顶点）也描 |
| `shadow` | 1 | 刘海在额头上的投影、眼睛上沿的阴影片 |
| `spring` | 1 | 悬挂物物理 |
| `helpers` | 1 | 辅助骨骼（扭转分担、修正骨骼） |
| `cam` | 1 | 自动机位和镜头漂移；0 固定全身 |
| `fidget` | 1 | 待机时自己做小动作 |
| `tex` | 2048 | 贴图最长边上限 |
| `fps` | 30 | 帧率上限 |
| `debug` | 0 | 1 = 左上角显示每帧各部分花的毫秒数、骨骼数、绘制次数 |

没有真机时用无头浏览器看效果：Playwright 的 Chromium 加 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`，等 `YunlaiFace.get().loaded`，调用 `YunlaiFace.apply(...)` 后截图。`YunlaiFace._pose('hello', 1.2)` 可以把某个动画定在某一秒。

## 消息协议（WebSocket 文本帧，JSON）

```json
{"type": "robot_state", "state": "speaking", "emotion": "happy", "gaze": {"x": 0.2, "y": -0.1}, "mouth_level": 0.65, "mouth_bands": [0.5, 0.3, 0.1]}
```
- `state`：`idle` / `listening` / `thinking` / `speaking` / `observing`
- `emotion`：`neutral` / `happy` / `alert` / `surprised` / `confused`；加 `duration_ms` 表示临时情绪
- `gaze`：-1 到 1，x 向右为正，y 向下为正
- `mouth_level`：0 到 1，管嘴张多大
- `mouth_bands`：可选，声音低（700 Hz 以下）、中、高（2500 Hz 以上）三个频段的音量。低频占得多是「哦、呜」的圆嘴，高频多是「衣、诶」的扁嘴。不带时嘴型自己慢慢变。实时语音（`Live.swift`）会发；普通对话用的 `AVAudioPlayer` 拿不到波形，只发音量

其他消息：
- `{"type":"gimbal","yaw":-30,"pitch":0}`：云台角度，角色跟着看过去；`"connected":false` 表示云台断开
- `{"type":"event","name":"…"}`：`voice_start`、`speech_end`、`answer_start`、`answer_end`、`anomaly`、`person_detected`（带 `x`、`y`）、`idle`
- `{"type":"speak","url":"…"}`：播放 TTS 音频，按真实音量和频段对口型（音频要允许跨域）
- `{"type":"action","name":"dance"}`：做一个动作，见上面「动作」
- `{"type":"view","shot":"face","orbit":30,"tilt":10}`：镜头。`shot` 是 `auto`（聊天时半身、闲着全身）/ `full` / `bust` / `face`；`orbit` 绕着她转（度，-180～180，正 = 往屏幕右边绕）；`tilt` 俯仰（度，-25～45，正 = 从上往下看）。没给的不变
- `{"type":"turn","yaw":90}` 或 `{"type":"turn","by":-30}`：身体转身（度，0 面向屏幕，正 = 转向屏幕右边，180 背对）。身体转开、又没有别的视线目标时，她会回头看屏幕前的人
- `{"type":"look","x":0.5,"y":-0.2,"ms":8000}`：看哪里，保持 `ms`（默认 10 秒，0 一直看）；`{"type":"look","free":true}` 放开
- `{"type":"reset"}`：自动镜头、面向屏幕、视线放开、平静、停下动作
- `{"type":"outfit","id":"outfit2"}`：换装
- `{"type":"sensing","camera":true,"mic":true}`：屏幕顶部显示「摄像头 / 麦克风工作中」

`apply` 有返回值：`action` 返回做没做成（true / false），`view` 返回现在的镜头设置，`turn` 返回朝向，`look` 返回视线；App 的 `robot` 遥控指令（`App/RobotCommand.swift`，参数见 AGENTS.md）就是靠这个拿结果的。`window.YunlaiFace.get()` 返回整体状态。

页面发回 `face_ready`、`touch`（带 `part`：`head`、`hand_l`、`hand_r`、`body`、`other`）、`speak_end`、`outfit_done`、`action_done`。在 App 的 WKWebView 里也可以直接调用 `window.YunlaiFace.apply({...})`。WebSocket 断线时回到待机，并自动重连。

## 授权

| 东西 | 授权 | 是否放进仓库 |
|------|------|------|
| three.js | MIT | 打包在 `yuki.js` 里 |
| Yuki 模型 | **来源和授权还没确认**（以前这里写「William 自己的模型」是 AI 猜的）。自己用问题不大；如果是从别的产品里取出来的，公开发布 App 或公开模型会有版权问题 | 否，用脚本下载 |

## 还没确认的事

- iPhone 7 Plus（iOS 15）上的流畅度和内存还没实测，默认限 30 FPS。卡的话先把画质改成「省电」，再用 `?debug=1` 看是哪一部分慢。头转动的正负号、嘴型大小也要真机上看一眼。
- 卡通渲染的颜色、明暗、描边粗细、近景机位是照 William 发的一张原作截图调的（校服、待机、正面）。原作的背景偏暗偏暖，我们的背景是亮的蓝色夜景，所以整体还是比原作亮。要再调就改 `toon.js`、`camera.js` 开头的常量。
- **第二套衣服的高跟靴**：模型里脚是平底姿势，下面垫了一根高跟（绑定姿势下鞋跟尖着地、前脚掌悬空约 6 厘米），动画又是平底鞋的，直接播脚是歪的。`rig.js` 的 `FootFix` 每帧把脚踝往下压（脚尖朝下）、脚趾反向掰平，角度按顶点算（鞋跟尖和前脚掌一样高，算出来是 30°），再按踩实以后的鞋底让她站到地上。`avatar.js` 的 `MESH_FIX` 里 `heels: true` 打开；网址参数 `ankle=` 可以强制用别的角度。
- **第二套衣服的模型文件是错位的**：身体、外套、裙子的顶点整体比骨架高 6.25 厘米（头、脸、头发没有），不处理的话头会陷进衣服里。`avatar.js` 的 `MESH_FIX` 在加载时把它们挪回去。数据集里的 glb 重新导出、修好以后，要把这一条删掉。
- 第二套衣服胸口那片蓝白色是身体贴图里画的一层薄纱，不是渲染错误。
- 物理的软硬、镜头推拉的速度在无头浏览器里看不出手感，要按真机反馈调。
- 修正骨骼（`…CorrectiveRoot` 下面的 `…Off`、`…IN`，肩头、腋下、臀部、膝盖处的皮肤和衣服绑在上面）原作怎么驱动的不知道。现在是近似：修正骨骼的根只跟着那一节肢体转一部分（`rig.js` 的 `CORRECTIVE_FOLLOW`，上臂 10%）。不驱动的话，手臂放下来时肩头的衣服会整体转上去挤到脖子两边，第二套衣服尤其明显。
- 裙子有动画也有物理：每一帧把动画摆出来的姿势当成「原来的姿势」，物理带着惯性去追，所以转身、跳、踢腿时裙摆会甩、会慢半拍；动画里本来就贴着身体、腿的地方不算碰撞（不然会被一直往外顶，整条裙子翻起来）。腿的碰撞体故意比真腿细一点。
- 头发还是只用动画里烘焙的飘动，我们叠加的转头不会带动头发。
- 云台已经接上（`App/Gimbal.swift`，大疆 OM6）：App 连着云台时每秒把朝向发给脸，远程用 `gimbal` 指令转。
  真机上还没一起试过：脸的左右方向如果和云台转的方向反了，改 `RemoteEngine` 里发 `gimbal` 消息的正负号。
