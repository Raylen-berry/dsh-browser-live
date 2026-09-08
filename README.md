# dsh-browser-live · 看得见的 Agent 浏览器（DSH 标准插件）

让 agent 驱动**本机真实 Chrome/Edge/Brave**（CDP 直连，无 vendored 运行时、无裸 npm 依赖），
并在右下角开一块**实时观察窗**：agent 在网页上干什么，你全程看得见，还能直接接管鼠标键盘。

> 设计灵感来自 [dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)（MIT）。本插件是**自研实现**：
> 不携带 ego-lite 运行时、零裸 import，与 `link:` 本地安装工作流完全兼容（同 dsh-bg-atelier / dsh-cache-control 约定）。

## 它解决什么

DSH 内置的 web_search/web_fetch 只能"读"；凡是**必须真浏览器**的活（登录态、动态渲染、表单、验证码、
需真人会话的站点）就干不了。装上本插件后，agent 获得 15 个 `browser_*` 工具，能真正在页面里
点击、输入、提交、滚动、取快照；你在观察窗里实时看到每一步，卡在验证码时点进面板亲手代打，
完事再把鼠标还给 agent。

## 组成

| 文件 | 职责 |
|---|---|
| `index.js` | Host（ESM）：拉起/接管 Chrome → CDP；注册 15 个 `browser_*` 工具；`/bl/*` 观察窗后端（SSE 帧流 + 输入回传 + 设置 + 下载取回） |
| `client.js` | Client 单文件：侧栏 🌐 按钮（无 slots 环境退化为自建浮球）+ 浮动观察窗（实时帧、标签条、agent 动作条、鼠标键盘接管、FPS/画质、下载快捷取回） |
| `cordis.patch.yml` | bundle 装载声明（行 id == 包名，客户端模块扫描按 manifest name 匹配） |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（platform web，注入 runtime/ui-slots） |

## 安装（本机 link，与 dsh-bg-atelier 同套路）

```powershell
dsh plugin --profile web add link:D:\DeepSeek\dsh-plugins\dsh-browser-live
```

装完**重启一次 DSH Desktop**。设置 → 插件 里可开关；侧栏底部出现 🌐 观察窗按钮。

## 工具一览（agent 侧）

| 工具 | 说明 |
|---|---|
| `browser_open` | 启动/接管浏览器（懒启动），可选 url / newTab |
| `browser_navigate` | 导航并等加载完成 |
| `browser_snapshot` | 结构化快照：可见交互元素清单（ref 编号+坐标）+ 正文节选。**点击前先拿 ref** |
| `browser_click` | ref / CSS selector / 坐标三选一，真实鼠标事件（右键、双击可选） |
| `browser_type` | 聚焦输入框（自动全选便于替换）+ 插入文本，可回车 |
| `browser_press` | 按键/组合键：`Enter`、`ctrl+a`、`alt+ArrowLeft`… |
| `browser_scroll` | 滚轮方向+像素 |
| `browser_wait` | 等文本出现 / 选择器命中 / URL 片段 / 纯等待，带超时 |
| `browser_eval` | 页内 JS 表达式（returnByValue + await 可选） |
| `browser_text` | 正文分块提取（比快照省 token） |
| `browser_screenshot` | 可视区/整页 PNG 落盘，路径可直接交给读图工具 |
| `browser_tabs` | 标签页 list/new/select/close |
| `browser_history` | 前进/后退/刷新（可强刷） |
| `browser_downloads` | 下载目录清单（观察窗里也能一键取回） |
| `browser_close` | 关浏览器（profile 保留，登录态不丢） |

所有工具串行互斥；首次调用自动拉起浏览器并弹观察窗。

## 观察窗

- **直播**：`/bl/stream` SSE 推 JPEG 帧（FPS/画质在窗内可调）。
- **接管**：面板里鼠标点击/滚轮/键盘 → `/bl/input` → CDP Input，作用在同一个页面上；
  坐标按 `vw/渲染宽` 等比映射，缩放窗格不会点偏。
- **透明**：窗底一行"🤖 最近动作"，agent 每步工具调用都可见；标签条可点切换会话页。
- **取回**：下载完成自动出现 ⬇ 链接，点了直接经 `/bl/download` 拿文件。

## 数据与隐私

全部落在 `$DSH_HOME/dsh-browser-live/`：`settings.json`、`state.json`、
`chrome-profile/`（登录态）、`downloads/`、`shots/`。CDP 只绑 `127.0.0.1`；
观察窗路由与宿主其他插件路由（`/bga/*`、`/cc/*`、`/api/*`）互不重叠。
不关闭浏览器时它会一直在——用完调 `browser_close` 或点面板 ⏹。

## 前置条件

- Node ≥ 22（DSH Desktop 自带）；宿主 ≥ 0.1.2（defineTool 解析带 lite 兜底，装不上也只降级不崩）。
- 本机任一 Chromium 系浏览器：Chrome / Edge / Brave（自动探测；探测失败在设置里填 `chromePath`）。
- 无头服务器也可用：设置 `headless=true` 后工具全通，只是画面是虚拟的。
- **调试提示**：若你在受限沙箱终端里跑本插件的 e2e 脚本，Chrome 会因命名管道被拒而
  `FATAL mojo platform_channel (0x5)` 自杀——表现为 CDP 连上后立刻 1006 断开。
  这不是插件问题：宿主内正常运行不受影响；离线验证请用允许命名管道的会话跑
  `node 03-调试临时\bl-e2e.mjs`。

## 已知边界（v0.1.0）

- 观察窗单实例（整个宿主一个浏览器会话，不做多会话隔离）；多 agent 并发浏览请串行使用。
- `Page.captureScreenshot` 取帧（非 screencast 事件流），高 FPS 下 CPU 开销线性上涨，默认 2fps。
- 文件上传、跨 origin iframe 内点击、拖拽（HTML5 DnD）未做，留 v1 增强。

## 许可与致谢

- 本插件源码：MIT © 2026 **Raylen-berry**（作者 / 维护者）。
- **灵感来源（原作者）**：[dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)，
  MIT © **Fisfzy** and dsh-ego-browser contributors。其"把 agent 接进 DSH 的真浏览器 + 观察窗"
  设计（含 ego-lite 运行时，© CitroLabs / ego-lite contributors，MIT）证明了这条路走得通。
- 本仓库是**独立自研的干净实现（clean-room re-implementation）**：不含 ego-browser / ego-lite 的任何一行代码，
  不携带其运行时 vendored 源码，仅借鉴其功能思路与交互范式。商标与名称归各自所有者。

感谢 ego-browser 作者把"接进 DSH 的 agent 浏览器 + 观察窗"这条路趟通。
完整署名与上游声明见仓库根目录 [`NOTICE`](./NOTICE) 文件。
