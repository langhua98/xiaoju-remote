# Yuki 逼真度提升：技术方案

这份文档给接手的 AI 对话看。目标：让 iPhone 被控端「机器人模式」里的 3D 角色 Yuki 看起来像活人，尽量接近原作的观感。

开始前先读 `AGENTS.md`（规则）和 `Robot/README.md`（现状）。本文只讲要做什么、为什么、怎么验收。

## 现在做到哪（2026-11-12）

下面第 3 节的六步都做了一版，两套衣服在无头浏览器里截图验证过，**真机还没测**。代码在 `Robot/live2d/src/`，说明在 `Robot/README.md`。

和这份方案写的时候不一样的地方：

- **数据集里的模型换过了**（41 MB / 73 MB，带手机、报纸、手柄、爆米花四个道具）。现在每根骨骼在每个动画里都有轨道，但大半是常数。所以「有没有动画」改成加载时判断「轨道是不是在所有动画里都不变、而且等于绑定姿势」。这样的轨道直接从动画里删掉（3.4 万条剩 7 千多条），动画每帧的计算量少了大半。
- **`Eye_L`、`Eye_R` 确实带动眼球**（各 148 个顶点），视线用骨骼转，`eyeLook*` 形变只用来让眼皮跟一点。
- **带道具的动画能用**：道具的显示和隐藏是动画自己做的（把道具的父节点缩到 0）。
- **`Show`、`Hide`、`Hidden` 不用**：`Show` 从 T 字姿势开始。入场改成画面淡入。
- **`Yuki_Angry_With_Mouth` 只有表情**（身体是 T 字姿势）：只留表情轨道，叠在当前动作上播。
- 辅助骨骼：扭转分担做了；修正骨骼做了近似（根只跟着肢体转一部分）。第二套衣服的肩膀有四成权重绑在修正骨骼上，不驱动的话肩头会挤到脖子两边。
- **第二套衣服的 glb 是错位的**：身体和衣服的顶点比骨架高 6.25 厘米，头没有。加载时在 `avatar.js` 的 `MESH_FIX` 里挪回去。
- 口型频段：实时语音（`Live.swift`）发 `mouth_bands`；普通对话用 `AVAudioPlayer` 播，拿不到波形，只有音量，嘴型自己变化。
- 推近时背景只放大，没做模糊。
- 裙子（两套都是）加了「跟着动画走」的物理：动画姿势当目标，物理带惯性去追，和腿碰撞。
- 没做：被动画驱动的头发跟随我们叠加的转头（第 4 步第 4 条，标了可选）；`titForPhysics*`、`buttocksForPhysics*`。

- 原作是 **animates**。William 发了一张截图（校服、待机），卡通渲染照它重调过：模型里其实带环境遮蔽贴图（衣服褶皱、头发层次），原作拿它当阴影用；皮肤的阴影是橘红色；下巴在脖子上、刘海在额头上有投影；`Yuki_EyesShadow` 是乘在眼睛上沿的阴影片；近景是头到大腿。

还要 William 做的：真机测流畅度和内存；确认模型的来源和授权。

## 0. 约束（不能破）

- 继续用 **three.js 0.160 + WKWebView**，不换 RealityKit / SceneKit。原因：RealityKit 在 iOS 15 上不能运行时控制表情形变，Yuki 的脸全靠它。
- 最低 **iOS 15**，目标机 **iPhone 7 Plus（A10，2 GB 内存）**。打包目标 `safari15`，不能用 WebGPU、import map。
- 对外消息接口不变：`robot_state`、`gimbal`、`event`、`speak`、`outfit`、`sensing`，以及页面发回的 `face_ready`、`touch`、`speak_end`、`outfit_done`。Swift 一侧尽量不改。
- 代码只放 `Robot/live2d/`（文件夹名沿用旧的）。改了 `src/` 要 `npm run build`，把 `yuki.js` 一起提交。
- 模型不进仓库，由 `fetch-assets.sh` 从公开数据集 `langhua1998/yuki-model` 下载。
- 每个新功能都要有网址参数开关（见第 8 节），真机卡了能单独关掉。

## 1. 现状

`Robot/live2d/src/main.js`（约 330 行）已经做到：

- 加载 `Yuki_outfit1.glb` / `Yuki_outfit2.glb`，一次只留一套，贴图缩到最长边 2048。
- 只保留 5 个动画：`idle`、`Yuki_Idle_listening_v3`、`hello`、`Yes`、`No`（后两个还没接上）。
- 表情：按状态和情绪写 ARKit 形变；随机眨眼；嘴型只按音量驱动 `jawOpen`、`mouthFunnel`。
- 视线：用 `eyeLook*` 形变，加上在 `Head_M` 上叠加转动。
- 材质是 glTF 默认的 `MeshStandardMaterial`，一盏半球光加两盏平行光，没有色调映射。

## 2. 模型里实际有什么（已用脚本核实）

| 项目 | outfit1 | outfit2 |
|---|---|---|
| 文件大小 | 31.6 MB | 59.7 MB |
| 蒙皮骨骼 | 377 | 646 |
| 被动画驱动的骨骼 | 215 | 406 |
| 三角面（合计约） | 7.7 万 | 10.2 万 |
| 最重的网格 | `ClothingLower` 2.2 万面 | `ClothingBott` 4.3 万面、4.5 万顶点 |
| 贴图 | 5 张，只有底色 | 5 张，只有底色（裙子那张 2.7 MB） |

共同点：

- 根节点 `Yuki_Rig`，头 `Head_M`，脖子 `Neck_M`、`NeckPart1_M`，脊柱 `Chest_M`、`Spine1_M`、`Spine1Part1_M`、`RootPart1_M`、`Root_M`，眼球 `Eye_L`、`Eye_R`。
- 脸有 3 个网格（`Yuki_Face` 和两个 `Yuki_Face_Eyes`），各带 ARKit 52 个形变，名字标准（`eyeBlinkLeft`、`jawOpen`、`mouthSmileLeft`…）。
- 材质全是「底色 + 金属度 + 粗糙度 + `KHR_materials_specular`」，**没有法线、遮罩、阴影贴图**。原作的卡通效果是它自己的着色器算的，模型里没带。`Yuki_EyesShadow` 是 `MASK` 模式的纯色片。
- 30 个动画，两个文件一样：

| 类别 | 动画（秒） |
|---|---|
| 待机 | `idle` 40.0、`Yuki_Idle_listening_v3` 40.0 |
| 打招呼和回应 | `hello` 4.5、`Yes` 2.6、`No` 2.9、`Yuki_Angry_With_Mouth` 1.0、`Kiss` 3.4、`Peace_hand` 5.6、`Hand_Pose` 3.4 |
| 说话姿态 | `Phone_talking` 8.4、`Popcorn_talking` 13.4、`yuki_popcorn_idle` 15.5、`np` 13.4、`yuki_play` 12.0 |
| 敲屏幕 | `Tapping_Start` 1.8、`Tapping_Idle` 11.6、`Tapping_End` 1.9 |
| 被摸的反应 | `Touch_head` 2.7、`Touch_hand_L/R` 2.0、`Touch_leg_L/R` 2.1，另有 `Touch_breast`、`Touch_pants`（不接） |
| 舞蹈 | `dance_90bpm` 18.2、`dance_120bpm` 20.0、`f_vibe_dance_60_bpm_002` 10.4 |
| 出入场 | `Show` 1.0、`Hide` 0.4、`Hidden` 0.07 |

### 两个关键发现

**发现一：头发和裙子的飘动已经烘焙在动画里。**
`idle` 等动画直接驱动了头发（outfit1 的 `Emi_hair_B_*` 40 根、`bang_*`、`Emi_hair_side_*`；outfit2 的 `y_2_hair_*`、`Y_2_curl_*`）和大部分裙子骨骼（outfit1 `Skirt*` 73 根；outfit2 `Y_2L_Skirt*` 162 根）。所以播动画时它们本来就在动，**不需要对它们做实时物理**。问题只出在两处：
- 我们额外叠加的转头、换动画的过渡，头发不会有反应。
- 有一批悬挂物没有任何动画，现在是硬的：
  - outfit1：`bow_DW_R_*`、`bow_UP_L_*`、`bow_UP_R_*`、`bow*`（8）、`collar_L/R_1`、`earrings_R`、`Emi_hair_side_short_L_*`（4）、`Skirt*`（12）
  - outfit2：`Y_bow_L_*`、`Y_bow_R_*`（各 6）、`Y_ribbon_R_*`（15）、`Y_2_cape_*`（10）、`Y_rose*`（14）、`zipper_*`、`Y_2L_Skirt*`（58）
  - 两套都有：`titForPhysics*`、`buttocksForPhysics*`

**发现二：辅助骨骼完全没人驱动。**
下面这些骨骼不在任何动画里，原作引擎应该是用约束实时算的。现在它们不动，手腕、肩膀、膝盖弯曲或扭转时会出现「糖纸扭曲」和塌陷：
- 扭转分担骨骼：`ShoulderPart1/2_L/R`、`ElbowPart1/2_L/R`、`HipPart1_L/R`、`KneePart1_L/R`
- 修正骨骼：`upperarm*`、`lowerarm*`、`wrist*`、`thigh*`、`calf*`、`clavicle*`、`latissimus*`、`chestFwd*`、`buttocks*` 下面的 `…IN_*` / `…Off_*` / `…CorrectiveRoot*`

## 3. 做什么，按优先级

每一步独立可交付：做完一步就 `npm run build`、提交、推送，让 workflow 出 ipa。

### 第 1 步：卡通渲染（观感提升最大）

现在皮肤发灰发平，是因为用了写实材质去画只有底色的贴图。

1. 渲染器：`outputColorSpace = SRGBColorSpace`，`toneMapping = NoToneMapping`（卡通底色不要被压暗）。
2. 加载后把所有材质换成自写的卡通材质（`ShaderMaterial`，或 `MeshToonMaterial` 加 `onBeforeCompile`），要支持蒙皮和形变：
   - 两段明暗：`step`/`smoothstep(阈值±柔边, N·L)`，暗部颜色 = 底色 × 偏冷的阴影色，不是变黑。
   - 边缘光：`pow(1 - N·V, n)`，只加在背光一侧，颜色用背景的青色（`#7fe9ff`）。
   - 按材质名字分参数：`Yuki_Head`、`*Body*`（皮肤，阴影偏暖红）、`*Hair*`（加一条各向异性高光带）、`*Clothing*`、`Yuki_Eyes`（不受光，直接出底色）。
3. 脸：没有阴影贴图，直接算会在鼻子、嘴角出脏影。做法：脸的法线向「以头骨为中心的球面法线」靠拢（混合 0.6～0.8），让明暗分界平滑。
4. 描边：背面外扩法。每个网格复制一个 `side: BackSide`、顶点沿法线外扩的黑褐色材质。粗细按到镜头的距离缩放，脸上更细。`ClothingBott`（4.5 万顶点）默认不描边。
5. 透明和双面：`ClothingLower` 是双面的，`*_Transp` 和 `Yuki_EyesShadow` 要保持原来的透明方式，渲染顺序放后面。
6. 背景融合：脚下加一个柔和的圆形假阴影（一张径向渐变的平面），不要开实时阴影。

验收：和现在的截图并排比，皮肤干净、有清楚的明暗分界、有描边；两套衣服都不出现黑块或透明错乱。

### 第 2 步：辅助骨骼驱动（修关节变形）

1. 扭转分担：`ElbowPart1/2` 取 `Wrist` 相对 `Elbow` 沿前臂轴的扭转量的 1/3、2/3；`ShoulderPart1/2`、`HipPart1`、`KneePart1` 同理。用 swing-twist 分解。
2. 修正骨骼先不做完整还原。只验证：静止绑定姿势下它们的位置是对的，扭转修好后关节是否还明显塌。还塌，再按「父关节弯曲角 → 沿固定方向推出」做简单驱动。
3. 每帧在 `mixer.update()` 之后、物理之前执行。

验收：`hello`（抬手挥动）、`Peace_hand`、`dance_120bpm` 里手腕、肩膀、膝盖没有糖纸扭曲。

### 第 3 步：眼神、脸、口型

1. 眼球：直接转 `Eye_L`、`Eye_R` 骨骼看向目标点，限幅（左右 ±30°、上下 ±20°）。先确认转骨骼时眼睛网格真的跟着动，不动就继续用 `eyeLook*` 形变。
2. 视线分配：目标角度按 眼 → 头 → 脖子 → 胸 分摊（大约 眼先到位，头 50%、脖子 25%、胸 10%），各自带不同的延迟，眼睛最快。在世界坐标里叠加，沿用现在 `Head_M` 的写法。
3. 眼球微跳：每 0.8～2.5 秒随机小跳 1～3°；大幅转视线时顺带眨一次眼。
4. 眨眼：间隔随机 2～6 秒，偶尔连眨两次；闭眼 80 ms、睁眼 150 ms；笑的时候眼睛半眯。
5. 口型：把 `AnalyserNode` 的频谱分三段，映射成 `jawOpen`（总能量）、`mouthFunnel`/`mouthPucker`（低频占比高，像「哦、呜」）、`mouthStretch*`/`mouthSmile*`（高频占比高，像「衣、诶」），闭口音时带 `mouthClose`。加平滑，避免抖。
   - 注意：App 里对话的声音是 Swift 播的（`Talk.swift`、`Live.swift`），网页只收到 `mouth_level`。要把口型做细，需要 Swift 多发几个频段的能量，比如 `robot_state` 里加可选字段 `mouth_bands: [低, 中, 高]`。旧字段保留。
6. 说话时的小动作：按音量峰值触发轻微点头、抬眉（`browInnerUp`），幅度小、带随机。
7. 动画自带的表情不要被盖掉：现在每帧直接覆盖 `DRIVEN` 里的形变。改成「动画值 + 我们的偏移」再限幅到 0～1；只有眨眼和口型用取最大值。

验收：盯着她看 30 秒不觉得是在循环；说话时嘴型有开合也有圆扁变化；转云台时眼睛先到、头后到。

### 第 4 步：悬挂物物理（只做没被动画驱动的那些）

1. 弹簧骨骼（Verlet，参考 VRM spring bone）：每根骨骼存上一帧和当前帧的末端位置，受惯性、阻力、重力、回弹（拉回动画/绑定姿势）作用，保持骨长。
2. 链的识别：按第 2 节「没有任何动画」的名字前缀建链，沿父子关系走到头。**加载时用代码判断「这根骨骼有没有动画轨道」，不要写死名单**，两套衣服才能通用。
3. 碰撞体：头（球）、胸和腰（胶囊）、两条大腿（胶囊），挂在对应骨骼上。只对裙子和披风做碰撞。
4. 被动画驱动的头发、裙子不加物理。只做一件事：我们叠加转头时，给头发链加一个随头部角速度反向的小偏转，过渡时不至于像硬壳。可选，效果不明显就不做。
5. 固定步长 1/60 秒，每帧最多补 2 步。换装和切前后台时重置状态，避免炸开。

验收：转头、挥手、跳舞时蝴蝶结、丝带、披风会跟着甩，不穿进身体；iPhone 7 Plus 上开物理比关物理帧时间多不超过 3 ms。

### 第 5 步：动作状态机

把现在的 `syncBase` / `playOnce` 换成分层的：

| 层 | 内容 | 混合方式 |
|---|---|---|
| 基础层 | `idle` ↔ `Yuki_Idle_listening_v3` | 交叉淡入 0.5 秒 |
| 动作层 | 一次性动作，播完淡回基础层 | 交叉淡入 0.3 秒 |
| 程序层 | 视线、眨眼、口型、辅助骨骼、物理 | 动画之后叠加 |

1. `KEEP` 名单扩大到第 2 节表里除 `Touch_breast`、`Touch_pants` 之外的动画。内存吃紧时改成用到再从 glb 里取。
2. 触发关系：
   - 情绪/回答：`happy` 偶尔 `Peace_hand`；肯定句 `Yes`；否定句 `No`；`alert` → `Yuki_Angry_With_Mouth`。
   - 新增消息 `{"type":"action","name":"dance"}`（`name` 可以是动画名或 `dance`、`wave`、`nod`、`shake`），大模型用标签或工具触发。Swift 一侧照 `Body.swift` 里云台标签的写法加 `[动作 跳舞]` 和 Gemini 工具 `play_action`。
   - 触摸：用 `Raycaster` 判断点到哪里。头 → `Touch_head`，手 → `Touch_hand_L/R`，腿 → `Touch_leg_L/R`，其他地方 → `hello`。`touch` 消息加一个 `part` 字段。
   - 长时间没人理（约 60～120 秒随机）：插一个 `Tapping_Start → Tapping_Idle → Tapping_End`，或 `yuki_play`。
   - 进入机器人模式播 `Show`。
3. 待机防重复：`idle` 的起始时间随机；每隔 15～40 秒插入一个小动作。
4. 手持道具的动画（`Phone_talking`、`Popcorn_talking`、`yuki_popcorn_idle`、`np`）模型里没有道具，先不用。
5. 一次性动作播放期间，降低程序层对头部的叠加（权重 0.3），避免和动画打架。

验收：用 `?demo=1` 跑 5 分钟，没有姿势跳变，没有卡在某个动作的最后一帧。

### 第 6 步：镜头

1. 两个机位：全身（现在的）和半身（胸口以上，头在屏幕上 1/3 处）。`listening`、`thinking`、`speaking` 时推到半身，回 `idle` 约 10 秒后拉回全身。用缓动，1 秒左右。
2. 镜头轻微漂移：位置加很小的低频噪声（幅度约身高的 0.3%）。
3. 推近时背景 `bg.jpg` 略微放大并模糊（CSS `transform` + `filter`），做出景深感。iPhone 7 Plus 上 `filter: blur` 掉帧就只做放大。

## 4. 每帧的执行顺序

```
状态机更新 → mixer.update(dt) → 辅助骨骼（扭转/修正）
→ 视线分配（眼、头、脖、胸）→ 表情形变（动画值 + 偏移，眨眼、口型）
→ 悬挂物物理 → 镜头 → 渲染
```

顺序不能乱：物理必须在所有骨骼姿势确定之后，表情必须在 `mixer.update` 之后。

## 5. 文件拆分

`main.js` 会变大，拆成：

```
Robot/live2d/src/
  main.js        入口：配置、消息、WebSocket、主循环
  avatar.js      加载、换装、释放
  toon.js        卡通材质、描边
  rig.js         辅助骨骼、视线分配
  face.js        表情、眨眼、口型
  spring.js      弹簧骨骼、碰撞体
  motion.js      动作状态机
  camera.js      机位
```

`spring.js`、`rig.js` 里的数学（swing-twist、Verlet 一步）写成不依赖 DOM 的纯函数，加 `Robot/live2d/test/*.mjs` 用 `node --test` 测。

## 6. 性能预算（iPhone 7 Plus，30 FPS，每帧 33 ms）

| 项目 | 预算 |
|---|---|
| 动画 + 蒙皮矩阵（646 根骨骼） | 6 ms |
| 辅助骨骼 + 视线 + 表情 | 1 ms |
| 物理 | 3 ms |
| 渲染（含描边） | 15 ms |

- 骨骼矩阵用浮点纹理（three.js 默认），确认 iOS 15 的 WebGL2 可用。
- 描边会让绘制调用翻倍，是最先关的一项。
- 像素比上限 2；掉帧时降到 1.5。
- 内存：一套模型常驻。目标是网页进程不超过 600 MB，否则 iOS 会杀掉 WebView。`RobotFace.swift` 要处理 `webViewWebContentProcessDidTerminate`，重新加载并用 `?tex=1024&outline=0` 降级（现在没处理，属于必须补的）。

## 7. 验证方法

1. 电脑上：`sh fetch-assets.sh && npm run build && python3 -m http.server 8000`，用 Playwright 无头 Chromium（加 `--use-gl=swiftshader --enable-unsafe-swiftshader`）打开 `index.html?demo=0`，等 `YunlaiFace.get().loaded`，调用 `YunlaiFace.apply(...)` 后截图看。两套衣服都要截。
2. 加一个 `?debug=1` 面板：显示帧时间（动画、物理、渲染分开）、骨骼数、绘制调用数。
3. 真机只能由 William 测。每步推送后看 Actions，把 ipa 直链发给他：
   https://github.com/langhua98/xiaoju-remote/releases/download/latest/Vania-latest.ipa
4. 无头浏览器看不出手感（物理的软硬、镜头速度），这些参数集中放在文件顶部的常量里，方便按真机反馈调。

## 8. 开关（网址参数）

| 参数 | 默认 | 作用 |
|---|---|---|
| `toon` | 1 | 卡通材质；0 回到原来的标准材质 |
| `outline` | 1 | 描边 |
| `spring` | 1 | 悬挂物物理 |
| `helpers` | 1 | 辅助骨骼驱动 |
| `cam` | 1 | 自动机位 |
| `tex` | 2048 | 贴图最长边 |
| `fps` | 30 | 帧率上限 |
| `debug` | 0 | 调试面板 |

App 里在设置页加一个「画质」选项（高 / 省电），省电 = `outline=0&spring=0&tex=1024`。

## 9. 没解决的问题

- **没有原作的参照画面。** 卡通着色的明暗比例、描边粗细、镜头距离都要参照原作调。向 William 要一段录屏或截图，没有就先按通用二次元手游的风格做。
- **`Eye_L`、`Eye_R` 是否带动眼球网格**没验证（第 3 步第 1 条）。
- **修正骨骼原作是怎么驱动的**不知道，只能近似（第 2 步第 2 条）。
- **模型来源和授权**没确认。`Robot/README.md` 里「William 自己的模型」是上一个对话猜的，要问 William 后改成实际情况。
- **iPhone 7 Plus 上现在这版的流畅度和内存还没人测过。** 动手做第 1 步之前，先请 William 测一次现有 ipa，拿到基线。
