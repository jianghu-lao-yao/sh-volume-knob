# 发布指南 / Publishing dsh-volume-knob

作者名用 **混世老妖**，仓库名用 `dsh-volume-knob`。
（GitHub 用户名只允许字母、数字和连字符，所以「混世老妖」写在 `package.json` 的 `author`、`LICENSE` 和 README 抬头——不可能是账号名。）

---

## 1. 建仓库并推送

先在 GitHub 网页上新建一个**空**仓库 `dsh-volume-knob`（不要勾 README/.gitignore），然后：

```sh
cd ~/Desktop/harness/dsh-volume-knob

# 本地已初始化并提交好；只需加远端、推送
git remote add origin https://github.com/hunshi-lao-yao/dsh-volume-knob.git
git branch -M main
git push -u origin main
```

有 `gh` CLI 的话更快：

```sh
gh repo create dsh-volume-knob --public --source=. --remote=origin --push \
  --description "Read the page aloud and control volume from the DSH composer"
```

## 2. 给仓库加 topic

仓库页面右上 **About → ⚙ → Topics**，加 `dsh-plugin`（`dsh`、`deepseek-harness` 也可以顺手加上）。
`dsh-plugin` 是社区列表的收录要求之一。

## 3. 等一天，再提交收录 PR

社区插件库（`dsh-market` 的数据源）是
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
它的列表数据在 `data/plugins/`，**一个插件一个 YAML 文件**。

- ⚠️ **仓库必须创建满 1 天**才能通过 CI（自动检查，专门过滤"PR 前几分钟才建好"的仓库）。
  所以今天先建仓库推送，明天再提 PR。
- 提交方式：fork 那个仓库 → 新增文件 `data/plugins/hunshi-lao-yao__dsh-volume-knob.yml`
  → 开 PR。内容就是本仓库根目录的 `catalog/hunshi-lao-yao__dsh-volume-knob.yml`（记得把 `hunshi-lao-yao` 换成你的用户名）：

```yaml
url: https://github.com/hunshi-lao-yao/dsh-volume-knob
name: hunshi-lao-yao/dsh-volume-knob
category: voice
description:
  en: Speaker button beside the composer microphone — one click reads the newest agent reply aloud through dsh-tts (browser voice as fallback), the next click stops, and a press-then-drag-up opens a vertical mixer for in-page media volume and system output volume.
  zh: 输入框话筒旁的扬声器按钮——单击朗读最新一条智能体回复（走 dsh-tts，回退浏览器语音），再单击停止，按住上滑调出竖式混音台，分别控制页内媒体音量与系统输出音量。
```

**不要手工编辑那两个 README**——它们由 `data/plugins/*.yml` 生成，合并后自动重建。

收录前会核对（见仓库的 `contributing.md`）：

| 检查项 | 本仓库状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` | ✅ `{"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web"}}` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 有真实可用的代码（非占位） | ✅ `lib/index.js` + `lib/client.js` |
| 仓库创建满 1 天 | ⏳ 建好后的第二天再提 PR |
| 加了 `dsh-plugin` topic | ⏳ 第 2 步 |
| 描述与实际功能一致、不含营销词 | ✅ 逐条对照过代码 |
| 分类贴合 | `voice`（朗读 + 音量） |

## 5. 发到 npm（要「不带 github:」的安装命令就靠这步）

`dsh plugin --profile web add dsh-volume-knob` 这种短命令是**从 npm 解析**的，所以必须发一次 npm。

**名字已确认可用**：`dsh-volume-knob` 在 registry.npmjs.org 上是 404（未被占用）。

```sh
cd ~/Desktop/harness/dsh-volume-knob

npm login                       # 网页登录或粘贴 token
npm whoami                      # 确认已登录

npm pack --dry-run              # 预演：应只打包 6 个文件
#   LICENSE  README.md  cordis.patch.yml  lib/client.js  lib/index.js  package.json

npm publish --access public
```

发布后立刻可用：

```sh
dsh plugin --profile web add dsh-volume-knob
```

说明：

- 包名没占用，但**先发先得**——想占住就尽早 `npm publish`。
- `private` 字段已从 `package.json` 去掉；`files` 只列了 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE`（`PUBLISH.md`、`catalog/`、`.gitignore` 不会进 tarball）。
- 后续更新：改 `version`（如 `0.4.1`）→ `git commit` → `npm publish`。
- npm 上发了之后，市场条目里的安装命令会自动变成短的 `dsh plugin --profile web add dsh-volume-knob`（第 3 步的收录条目本身不用改，仍只交那一个 YAML）。

## 6. 收录之后

列表合并后，`dsh-market` 会自动同步目录，用户就能在**设置 → 插件市场**里搜到并一键安装：

```sh
dsh plugin --profile web add dsh-volume-knob          # 已发 npm
dsh plugin --profile web add github:hunshi-lao-yao/dsh-volume-knob   # 未发 npm 时的等价写法
```

