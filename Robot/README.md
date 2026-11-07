# Yunlai Robot 面部：直接使用开源项目 AIRI

机器人的脸不自己写代码，直接用开源项目 **Project AIRI**（[moeru-ai/airi](https://github.com/moeru-ai/airi)，MIT 协议，可以免费使用和修改）。

## 它能做什么

- 3D（VRM）和 Live2D 角色，自带待机动作、眨眼、表情。
- 嘴型跟着 TTS 语音动，支持语音输入和聊天。
- 默认角色和动作都放在它的服务器上，不用另外找素材。

## 在 iPhone 上用

1. 用 Safari 打开 https://airi.moeru.ai 。
2. 点「分享 → 添加到主屏幕」，以后从主屏幕打开就是全屏。
3. 在设置里填大模型接口（OpenAI 兼容接口、Claude、智谱、ModelScope 等都可以），选一个语音合成（TTS），再选角色。

也可以用 AIRI README 里的移动端 App。

## 还没确认的事

- **iPhone 7 Plus（最高 iOS 15）能不能流畅运行，还没有实测。** 先在真机上打开网址试一下，再决定后面怎么做。
- **云台联动还没做。** AIRI 不知道 DJI 云台和 Yunlai Cloud Brain 的存在：
  - 如果 Yunlai Cloud Brain 能提供 OpenAI 兼容接口，直接填进 AIRI 的大模型设置就能接上。
  - 云台转头、检测到人这类联动，以后要加一小段对接代码，优先用 AIRI 自带的插件接口，不另起炉灶。
