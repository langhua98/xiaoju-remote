# Vania（iPhone 被控端，原名「小橘遥控」）

装在一台 iPhone 上，开「待命」后，另一台设备可以通过小橘云盘发指令，调用这台的硬件：拍照、录音、定位、手电筒、震动、响铃。两台设备不需要在同一个网络里。

支持 iOS 15 及以上（含 iPhone 7 / 7 Plus / 6s / SE 一代）。这个 App 只能被控；要发指令，用 iOS 17 上「小橘推送」的「设置 → 遥控 → 控制端」，或者用电脑跑 `scripts/遥控.py`。

> 安卓被控端在 [`android/`](android/README.md)，APK 在 Release「xiaoju-remote-android」。
>
> 给接手的 AI：先看 [AGENTS.md](AGENTS.md)。

## 安装

1. 打开本仓库 Release「latest」，下载 `Vania-latest.ipa`。每次往 `App/`、`project.yml` 推送代码，GitHub 会自动重新编译。
2. 用 SideStore（自己的 Apple ID）或自己的证书签名后安装。用免费 Apple ID 签的话，每 7 天要重签一次。

## 使用

打开 App：
- 填**云盘地址**和**云盘令牌**。令牌是 `xa_` 开头的，要有写权限，因为回执和照片要写回云盘。
- 起一个**设备名**，比如 `测试机B`。控制端发指令时要填同一个名字。
- 定一个**配对口令**，控制端要用同一个口令，口令不对的指令会被拒绝。
- 点**授权硬件**，允许相机、麦克风和定位。
- 点**开始待命**。待命期间屏幕会一直亮着，App 不要切到后台。

在电脑上发指令：

```bash
export XIAOJU_TOKEN=xa_你的令牌
export XIAOJU_PAIR=你定的口令
python3 scripts/遥控.py 测试机B info
python3 scripts/遥控.py 测试机B photo --lens front
```

## iOS 的限制

- App 必须开在前台。iOS 不允许普通 App 在后台或锁屏时用摄像头和麦克风。
- 不能远程看或操作整个屏幕。
- 没有 shell。iOS 不让 App 运行别的程序。
