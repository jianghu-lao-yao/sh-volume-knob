# sh-volume-knob

> 朗读 + 音量，一个按钮。· Read the page aloud and control volume from the composer.
> 作者 / by **江湖老妖**

DeepSeek Harness Web GUI 的输入框工具行里、**话筒按钮右边**的一个扬声器按钮：

- **单击** → 朗读页面内容（最新一条助手回复）；**再单击停止**。
- **按住并向上拖拽** → 调出**竖式**音量混音台：页内音量 + 系统音量，各自可静音。
- **点击页面任何其他地方 / Esc** → 收起混音台。

```
[ 话筒 ] [ 🔊 ]   ← order 30 / 40 in the composer tool row
```

## 安装

```sh
# 从 GitHub 直接安装（把 buhtig111 换成仓库所有者）
dsh plugin --profile web add github:buhtig111/sh-volume-knob
```

也可以在 `dsh-market`（插件市场）里搜索安装。

装完重启一次 `dsh web`（插件在启动时组入 boot graph），然后刷新页面。

## 交互

| 手势 | 行为 |
| --- | --- |
| 单击图标 | 朗读页面内容；再单击 → 停止 |
| 按住并向上拖拽（≥18px） | 调出音量混音台（从图标上方弹出） |
| 点击其他地方 / Esc | 收起混音台 |
| 长按不拖（>400ms） | 不朗读（防误触） |
| 混音台开着时单击图标 | 只收起混音台 |
| Enter / Space | 朗读 / 停止 |
| Alt + ↑ | 开关混音台 |

朗读中图标变蓝并多一道声波弧；页内静音时图标变红带斜线。

## 两个音量有什么区别

| 推子 | 管什么 | 不管什么 |
| --- | --- | --- |
| **页内音量** | 本标签页里所有 `<audio>`/`<video>` 元素的 `volume`：语音朗读、提示音、网页播放器 | 系统音量、其他 App、其他标签页 |
| **系统音量** | 系统输出音量与静音（macOS `osascript`，Linux `pactl`） | 单个页面的元素音量上限 |

两者串联：系统音量是天花板。系统静音时页内开满也没声；页内拉到 0 只静这一页。

## 朗读实现

- 文本来源：`[data-chat-flow-kind="assistant"]` 里**最新一条可见**的助手消息；取不到时依次回退到任意 `[data-chat-flow]` 节点、整个会话区。
- 合成：按 ~220 字切句块，逐块 `POST /dsh-tts/speak`（复用 [dsh-tts](https://github.com/GooDAnDReaDY/dsh-tts) 已配置的 provider 链，例如 Edge `zh-CN-XiaoxiaoNeural`），顺序播放；**未安装 dsh-tts 或合成失败时回退浏览器 `speechSynthesis`**。
- 点按钮时会先暂停页面上正在播放的音频，所以和 dsh-tts 的自动朗读（`speakReplies`）不会重叠。

## 结构

```
package.json         dsh.bundle.patch + dsh.client.platform=web
cordis.patch.yml     bundle 层
lib/index.js         host 半：GET/POST /sh-volume-knob/system、诊断 /sh-volume-knob/diag
lib/client.js        浏览器半：slot 按钮 + 朗读器 + 竖式混音台（无需构建步骤）
```

## 要求

- DSH `>= 0.1.5-rc.2`，Web GUI。
- 系统音量路由：macOS（`osascript`，内置）/ Linux（`pactl`）。其他平台该行置灰并显示原因。
- 可选：[dsh-tts](https://github.com/GooDAnDReaDY/dsh-tts) —— 没装也能用，只是回退到浏览器语音。

## 已知边界

- 页内音量是**母音量**，会覆盖插件自己设过的 `element.volume`；默认 100% 时行为不变。
- 浏览器 `speechSynthesis` 没有音量 API，只能在静音时 `cancel()`。
- 混音台路由只接受回环地址或同源请求，避免任意网页改你机器音量。

## 许可

MIT © 江湖老妖
