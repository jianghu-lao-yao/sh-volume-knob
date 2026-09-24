# sh-volume-knob

> 朗读 + 音量，一个按钮。从**你最新那条提问的开头**开始朗读。· Read aloud from the start of your newest question — one button.
> 作者 / by **江湖老妖**

DeepSeek Harness Web GUI 的输入框工具行里、**话筒按钮右边**的一个扬声器按钮：

- **单击** → 页面自动翻动到**朗读起点**（默认＝你最新那条提问的第一个字），在起点闪烁一根**光标**，然后从那里一直读到最新回复结尾；**再单击停止**。
- **按住并向右拖拽** → 在页面上**挑朗读起点**：光标跟着鼠标走，旁边给出提示（第几字 + 预览）；松手即定，提示消失，再单击就从这里开始读。
- **按住并向上拖拽** → 调出**竖式**音量混音台：页内音量 + 系统音量，各自可静音。
- **点击页面任何其他地方 / Esc** → 收起混音台 / 取消挑选。

```
[ 话筒 ] [ 🔊 ]   ← order 30 / 40 in the composer tool row
```

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add sh-volume-knob
```

也可以直接从 GitHub 装（等价，取的是仓库源码）：

```sh
dsh plugin --profile web add github:jianghu-lao-yao/sh-volume-knob
```

收录进社区列表后，还能在 `dsh-market`（设置 → 插件市场）里搜到并一键安装。

装完重启一次 `dsh web`（插件在启动时组入 boot graph），然后刷新页面。

## 交互

| 手势 | 行为 |
| --- | --- |
| 单击图标 | 翻到起点、闪烁光标、从起点朗读；再单击 → 停止 |
| 按住并向右拖拽（≥16px） | 进入挑起点模式：光标跟手，显示提示；松手定下起点 |
| 按住并向上拖拽（≥18px） | 调出音量混音台（从图标上方弹出） |
| 点击其他地方 / Esc | 收起混音台 / 取消挑选 |
| 长按不拖（>400ms） | 不朗读（防误触） |
| 混音台开着时单击图标 | 只收起混音台 |
| Enter / Space | 朗读 / 停止 |
| Alt + ↑ | 开关混音台 |
| ← / → | 光标左右移 1 字（挑选模式下同样可微调） |
| Shift + ← / → | 光标左右移 20 字 |

朗读中图标变蓝并多一道声波弧；页内静音时图标变红带斜线。挑选起点时光标变**琥珀色**，朗读时光标是主题色。

## 朗读起点

- **默认起点**：你**最新那条提问**的第一个字。单击即翻到那里，并在那里闪一根光标，读的顺序是「这条提问 → 之后的助手回复（含最新那条）」。
- **自定义起点**：按住图标**向右拖**，把鼠标移到想开始读的文字上松手。光标会吸附到最近的可读字符上，越界（拖到空白/代码块外面的糊边上）会夹到最近的可读位置。
- 起点**按会话记录保存**（`localStorage`），刷新页面后仍在；出现新回复时自动回到「最新提问开头」。
- 光标只是标记，不是 MD 编辑器里的选区：它不会选中文字、不影响复制。

## 两个音量有什么区别

| 推子 | 管什么 | 不管什么 |
| --- | --- | --- |
| **页内音量** | 本标签页里所有 `<audio>`/`<video>` 元素的 `volume`：语音朗读、提示音、网页播放器 | 系统音量、其他 App、其他标签页 |
| **系统音量** | 系统输出音量与静音（macOS `osascript`，Linux `pactl`） | 单个页面的元素音量上限 |

两者串联：系统音量是天花板。系统静音时页内开满也没声；页内拉到 0 只静这一页。

## 朗读实现

- 文本来源：会话流节点 `[data-chat-flow]`（`data-chat-flow-kind="user" | "assistant"`）。起点所在节点**从起点字符**开始取，之后每个可见节点整段取，直到最新节点结束；更早的轮次不读。
- 每个字符都有对应的 DOM 位置：插件把节点按 `innerText` 语义打平成文本串，同时记录「第 n 个字落在哪个文本节点的第几个字符」，所以光标、翻页、按字符微调都精确到字。
- 节点内会跳过按钮（复制/重试等）和 `tokens` 之类的时间/计数徽标，所以它们不会被念出来。
- 合成：按 ~220 字切句块，逐块 `POST /dsh-tts/speak`（复用 [dsh-tts](https://github.com/GooDAnDReaDY/dsh-tts) 已配置的 provider 链，例如 Edge `zh-CN-XiaoxiaoNeural`），顺序播放；**未安装 dsh-tts 或某个分块合成失败时，剩下的部分回退浏览器 `speechSynthesis`**（不会从头重念）。
- 点按钮时会先暂停页面上正在播放的音频，所以和 dsh-tts 的自动朗读（`speakReplies`）不会重叠。

## 结构

```
package.json         dsh.bundle.patch + dsh.client.platform=web
cordis.patch.yml     bundle 层
lib/index.js         host 半：GET/POST /sh-volume-knob/system、诊断 /sh-volume-knob/diag
lib/client.js        浏览器半：slot 按钮 + 文本/光标定位 + 朗读器 + 竖式混音台（无需构建步骤）
scripts/test.mjs     jsdom 测试：把上面这个 bundle 原样跑在仿真会话 DOM 上
```

## 开发

```sh
npm install
npm test        # 16 项：文本定位、光标、拖右挑选、朗读、回退、混音台
```

测试不引入 React，而是自带一个只实现 `createElement` + 四个 hook 的微型运行时，并用 jsdom 跑**未改动的** `lib/client.js`；只有 jsdom 缺的东西（布局几何、音频、语音合成、宿主 HTTP 路由）是仿真的。

## 要求

- DSH `>= 0.1.5-rc.3`，Web GUI。适配按发布通道**逐级向下兼容**，一次覆盖全部通道：

  | 通道 | 版本 | 说明 |
  | --- | --- | --- |
  | 正式版 | 目前尚无无后缀的稳定版（npm 上全部是 `-rc`/`-alpha`） | 出正式版后本插件无需改动 |
  | `latest` | `0.1.5-rc.3` | 已核对 |
  | `next` | `0.1.7-rc.1` | 已核对（当前本机 GUI 就是这一版） |
  | `alpha` | `0.1.7-alpha.2` | 同系列，随 `next` 一起通过 |

  这三个通道用的契约完全一样，所以插件代码里没有任何按版本分支：`window.__ModuleLoader__.load({id, factory})`、
  `ctx.slots.inject` / `ctx.slots.register`、以及 `conversation.input.right` 和 `[data-chat-flow*]` 标记在
  0.1.5-rc.3 与 0.1.7-rc.1 上逐个比对过，签名一致。
- 系统音量路由：macOS（`osascript`，内置）/ Linux（`pactl`）。其他平台该行置灰并显示原因。
- 可选：[dsh-tts](https://github.com/GooDAnDReaDY/dsh-tts) —— 没装也能用，只是回退到浏览器语音。

## 已知边界

- 页内音量是**母音量**，会覆盖插件自己设过的 `element.volume`；默认 100% 时行为不变。
- 浏览器 `speechSynthesis` 没有音量 API，只能在静音时 `cancel()`。
- 混音台路由只接受回环地址或同源请求，避免任意网页改你机器音量。
- 「起点」是按字符记的：如果回复在起点之后**被重新渲染成不同的文字**（例如流式输出还没结束），起点会按同一节点重新夹取；节点整个换掉时退回默认起点（最新提问开头）。

## 许可

MIT © 江湖老妖
