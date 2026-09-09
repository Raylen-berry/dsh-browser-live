# dsh-browser-live · 看得见的 Agent 浏览器（DSH 标准插件）

让 agent 驱动**本机真实 Chrome/Edge/Brave**（CDP 直连，无 vendored 运行时、无裸 npm 依赖），
并在右下角开一块**实时观察窗**：agent 在网页上干什么，你全程看得见，还能直接接管鼠标键盘。

> 设计灵感来自 [dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)（MIT）。本插件是**自研实现**：
> 不携带 ego-lite 运行时、零裸 import，与 `link:` 本地安装工作流完全兼容（同 dsh-bg-atelier / dsh-cache-control 约定）。

## 它解决什么

DSH 内置的 web_search/web_fetch 只能"读"；凡是**必须真浏览器**的活（登录态、动态渲染、表单、验证码、
需真人会话的站点）就干不了。装上本插件后，agent 获得 17 个 `browser_*` 工具，能真正在页面里
点击、输入、提交、滚动、取快照；你在观察窗里实时看到每一步，卡在验证码时点进面板亲手代打，
完事再把鼠标还给 agent。

## 组成

| 文件 | 职责 |
|---|---|
| `index.js` | Host（ESM）：拉起/接管 Chrome → CDP；注册 17 个 `browser_*` 工具；`/bl/*` 观察窗后端（SSE 帧流 + 输入回传 + 设置/代理 + 下载取回 + `/bl/view` 独立网页） |
| `client.js` | Client 单文件：侧栏 🌐 按钮（无 slots 环境退化为自建浮球；与 bg-atelier 宝珠叠列共存）+ 观察窗（实时帧、标签条、agent 动作条、鼠标键盘接管、FPS/画质、下载取回；内嵌面板可拖动贴边，或切成独立网页） |
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
| `browser_click` | ref / CSS selector / 坐标三选一，真实鼠标事件（右键、双击可选）；**默认走拟人贝塞尔轨迹**（`instant:true` 可瞬移） |
| `browser_move` | 拟人移动鼠标（触发 :hover/下拉/tooltip）；`hold` 按住左键、`instant` 瞬移 |
| `browser_type` | 聚焦输入框（自动全选便于替换）+ 插入文本，可回车 |
| `browser_upload` | 本机文件塞进 `<input type=file>`（不弹系统对话框）；ref/selector 可指上传按钮/拖拽区容器，自动解析其中隐藏 input（Meta Ads 等 React 自定义上传组件适用）；触发 change 事件 |
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

## 拟人轨迹（v0.3.0）

agent 的鼠标移动（`browser_click` / `browser_move`）默认不再是"瞬移出现"：
三次贝塞尔弧线 + 两端慢中间快的缓动 + 随进度衰减的正弦抖动 + 偶发微停顿，
事件仍从 CDP 输入管线注入（`isTrusted === true`，与真鼠标同层）。

- 设置项：`humanize`（默认 true，关掉回到瞬移）、`humanSpeed`（0.3~4，默认 1，约 0.15~0.45s/中程）。
- 单点距离 < 6px 自动走直线，不做无意义插值。
- **观察窗接管的实时输入不走插值**（你的手感必须即时），它本身就是真人轨迹。
- 注意：插值只作用于**页面感知到的鼠标**，Windows 系统光标不会跟着动（OS 级注入是另一层，未做）。

## 观察窗

两种形态（设置页「观察窗形态」可切换，面板标题栏 ⧉ 也能随时弹出独立页）：

- **内嵌面板**：DSH 右下角浮动窗，可按住标题栏拖动、拖近边缘自动贴边、位置记忆在 localStorage；
- **独立网页 `/bl/view`**：新标签/新窗口里的全屏观察窗，适合丢到副屏或 F11 盯着看；
  选了这个形态后，🌐 与 agent 冷启动自动弹的都走独立页（浏览器拦弹窗时自动退回内嵌面板）。

共同能力：

- **直播**：`/bl/stream` SSE 推 JPEG 帧（FPS/画质在窗内可调）。
- **接管**：窗里鼠标点击/滚轮/键盘 → `/bl/input` → CDP Input，作用在同一个页面上；
  坐标按 `vw/渲染宽` 等比映射，缩放窗格不会点偏。
- **透明**：窗底一行"🤖 最近动作"，agent 每步工具调用都可见；标签条可点切换会话页。
- **取回**：下载完成自动出现 ⬇ 链接，点了直接经 `/bl/download` 拿文件。
- **不常驻**：agent 冷启动浏览器时自动弹一次；你主动 ✕ 收走后，本页生命周期内不再自动打扰。

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

## 已知边界（v0.4.0）

- 观察窗单实例（整个宿主一个浏览器会话，不做多会话隔离）；多 agent 并发浏览请串行使用
  （多个会话共用同一受控 Chrome 时会互相抢标签页，这是设计如此，不是 bug）。
- 驱动的是插件自己拉起的 Chrome/Edge profile；**接管你日常浏览器**需要走扩展路线，
  方案与分期见 `docs/PLAN-user-browser-takeover.md`（尚未实现，所以设置页里没有这个开关）。
- `Page.captureScreenshot` 取帧（非 screencast 事件流），高 FPS 下 CPU 开销线性上涨，默认 2fps。
- `browser_upload` 支持 `<input type=file>`（含隐藏 input、React 自定义组件的 label 包裹）；纯 HTML5 拖拽（无 input）与跨 origin iframe 内交互未做。
- 拟人轨迹 = 页面侧事件流仿真；**系统光标位置不动**，比对 `screenX` 与 OS 光标高阶风控理论上可辨（极少数场景）。
- agent 靠 DOM 快照决策，"看不懂" Canvas 图表/图片内容——视觉闭环留 v1（DOM 为主、截图+视觉模型为辅）。

## 投放/运营场景模板（开箱即用）

把下面这些当 prompt 直接发给带本插件的 agent 即可；它们都遵循"只读→半自动→人工终审"的稳妥节奏。

- **竞对情报（零风险，先跑这个）**
  > 用 browser_open 打开 Meta 广告资料库，搜 "GoodNovel"，snapshot 后把近 7 天投放的
  > 文案钩子 / 素材形式 / 起量日期 / 落地页 URL 抽成表格存成 csv。
  公开数据、无登录墙、无风控。抽出的结构化数据可直接喂给 LLM 产素材变体。
- **落地页巡检（真浏览器 + 真地区才有价值）**
  > 依次用 `--window-size=390,844`（iPhone 视口）打开这几条落地页，每张存图并检查：
  > 付费按钮是否存在、首章文案有无截断、深链是否 404、像素有无发起请求。
  需要查地区差异时，在设置页「代理服务器」填 `http://<国家代理>`（或 `socks5://…`）——
  它直接翻成 Chrome 的 `--proxy-server`，等价于以前往 `extraArgs` 里手写参数，下次拉起浏览器生效。
- **半自动发布（人机协作，别全自动点 Publish）**
  > 在 Ads Manager 建好 Ad Set（预算/国家/兴趣词/落地页），素材用 browser_upload 传入，
  > 填完文案后**停在 Publish 前**，打开观察窗等我人工确认。
  配合已装的 **dsh-approval-gate**：可配成 browser_click 默认放行、唯独命中 Publish 转人工审批。

**风控纪律**：主账户只走"前端 UI 自动化"（等价真人点击）；`browser_eval` 打内部 GraphQL 取 JSON
属于灰色地带，仅限**只读**且**用独立测试账户隔离**——"能拿到数据" ≠ "应该这么做"。Google Ads 对此更敏感。

## 许可与致谢

- 本插件源码：MIT © 2026 **Raylen-berry**（作者 / 维护者）。
- **灵感来源（原作者）**：[dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)，
  MIT © **Fisfzy** and dsh-ego-browser contributors。其"把 agent 接进 DSH 的真浏览器 + 观察窗"
  设计（含 ego-lite 运行时，© CitroLabs / ego-lite contributors，MIT）证明了这条路走得通。
- 本仓库是**独立自研的干净实现（clean-room re-implementation）**：不含 ego-browser / ego-lite 的任何一行代码，
  不携带其运行时 vendored 源码，仅借鉴其功能思路与交互范式。商标与名称归各自所有者。

感谢 ego-browser 作者把"接进 DSH 的 agent 浏览器 + 观察窗"这条路趟通。
完整署名与上游声明见仓库根目录 [`NOTICE`](./NOTICE) 文件。
