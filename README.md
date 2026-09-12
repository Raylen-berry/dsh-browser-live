# dsh-browser-live · 看得见的 Agent 浏览器（DSH 标准插件）

让 agent 驱动**本机真实 Chrome/Edge/Brave**（CDP 直连，无 vendored 运行时、无裸 npm 依赖），
并在右下角开一块**实时观察窗**：agent 在网页上干什么，你全程看得见，还能直接接管鼠标键盘。
v0.5.0 起还可选**接管你自己的日常浏览器**（装一个 MV3 扩展，带你的登录态/代理，P0 只读）。

> 设计灵感来自 [dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)（MIT）。本插件是**自研实现**：
> 不携带 ego-lite 运行时、零裸 import，与 `link:` 本地安装工作流完全兼容（同 dsh-bg-atelier / dsh-cache-control 约定）。

## 它解决什么

DSH 内置的 web_search/web_fetch 只能"读"；凡是**必须真浏览器**的活（登录态、动态渲染、表单、验证码、
需真人会话的站点）就干不了。装上本插件后，agent 获得 18 个 `browser_*` 工具，能真正在页面里
点击、输入、提交、滚动、取快照；你在观察窗里实时看到每一步，卡在验证码时点进面板亲手代打，
完事再把鼠标还给 agent。

## 组成

| 文件 | 职责 |
|---|---|
| `index.js` | Host（ESM）：拉起/接管 Chrome → CDP；注册 18 个 `browser_*` 工具；`/bl/*` 观察窗后端（SSE 帧流 + 输入回传 + 设置/代理 + 下载取回 + `/bl/view` 独立网页 + `/bl/bridge` 桥状态） |
| `bridge.js` | 用户浏览器桥（P0）：127.0.0.1 WS 服务端 + token 握手 + 与 `Cdp` 同形的 `send/on/alive/close` |
| `extension/` | Chrome MV3 扩展（P0）：service worker 当"反向 CDP 客户端"（`chrome.debugger`），弹窗逐站点授权；见 `extension/README.md` |
| `client.js` | Client 单文件：侧栏 🌐 按钮（无 slots 环境退化为自建浮球；与 bg-atelier 宝珠叠列共存）+ 观察窗（实时帧、标签条、agent 动作条、鼠标键盘接管、FPS/画质、下载取回；内嵌面板可拖动贴边，或切成独立网页） |
| `cordis.patch.yml` | bundle 装载声明（行 id == 包名，客户端模块扫描按 manifest name 匹配） |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（platform web，注入 runtime/ui-slots） |

## 安装（本机 link，与 dsh-bg-atelier 同套路）

```powershell
dsh plugin --profile web add link:D:\DeepSeek\dsh-plugins\dsh-browser-live
```

装完**重启一次 DSH Desktop**。设置 → 插件 里可开关；侧栏底部出现 🌐 观察窗按钮。

## 换台机器：可迁移性与**必须手动的步骤**

> 给后续在任何一台机器上接手的人或 agent —— **本插件有一部分能力拿不到就是拿不到，必须人手动做**，
> 别在换了机器之后以为"克隆+重启就完事"。起因：用户 2026-09-12 反馈
> "工作电脑上传，回家发现可用性很差，一定需要手动操作，比如到浏览器安装本地插件"。

**分两档能力，先认清你要哪一档：**

| 能力 | 需要什么 | 能自动吗 |
|---|---|---|
| **插件自带实例**（独立窗口 + 独立 profile，免逐站点授权） | 只要插件装好 + 重启 | ✅ 全自动，`browser_open` 直接开 |
| **接管你的日常浏览器**（要你的登录态：后台/飞书/公司系统） | **必须装浏览器扩展**（MV3，本仓库 `extension/` 里）+ 粘 token + 逐站点授权 | ❌ 扩展安装与授权只能在浏览器里点 |

**B 档的四步手工操作（agent 只能把现场备好，点不了）**

1. 打开扩展管理页：Chrome `chrome://extensions` / Edge `edge://extensions` → 开**开发者模式**
2. **加载解压缩的扩展** → 选中本仓库的 `extension/` 目录
3. 点扩展图标打开弹窗 → 粘贴 **token** → 「连接」
   - token 在哪：`$DSH_HOME/dsh-browser-live/bridge.json` 的 `token` 字段
   - **省事做法**：让 agent 调 **`browser_ext_setup`** —— 它会置 `userBridge=true`、把 token 放进剪贴板、
     打开扩展页、并在文件管理器里打开 `extension/` 目录；人只剩"开发者模式 + 加载 + 粘贴 + 连接"这四下
4. 在扩展弹窗里逐站点授权：每个要操作的站点点「允许」（默认**只读**）；要真点击/打字/上传，
   还得打开「**允许操作**」（`allowInput`），否则 agent 只能看不能动

**其余换机事实（都不随仓库走）**
- 状态与凭据全在 `$DSH_HOME/dsh-browser-live/`：`settings.json`（含 `userBridge` / `headless` /
  浏览器路径 / 代理等）、`bridge.json`（端口 + token）、`chrome-profile/`（登录态）、
  `downloads/`、`shots/`、`audit/`（留痕）。**换机器后 `userBridge` 是空的 ⇒ 桥不会自己开**，
  要重跑一次 `browser_ext_setup` 或手动置 `userBridge: true`。
- 扩展是 MV3 **本地加载**的，不是商店包 ⇒ 换机器/换浏览器/换 profile 都要重装一遍（第 1–3 步）。
  扩展掉线时 host 会自动回退到"插件自带实例"这一档，所以"接管失败"往往表现为**换了个后端**而不是报错。
- 浏览器探测：本机装了 Chrome/Edge/Brave 任一即可；`headless=true` 时无头也能全通，但画面是虚拟的
  （观察窗看的是渲染结果）。首选浏览器起不来会自动降级到下一个候选，并补试兼容参数 `--in-process-gpu`。
- 留痕（v0.9.0 起）：所有 `browser_*` 调用与页面自身跳转都追加到
  `$DSH_HOME/dsh-browser-live/audit/YYYY-MM-DD.jsonl`（append-only + 哈希链）。
  `node tools/verify-audit-chain.mjs` 验链；`node tools/verify-audit.mjs` 离线自检 15 项。
- **已知宿主坑（三个插件共有）**：部分 DSH Desktop 版本启动时的 `installGeneration` 迁移会把
  `link:` 挂载的插件重新 stage，并把**绝对路径当相对路径拼接** ⇒ `ENOENT`、迁移 defer、
  插件可能不加载。本机靠应用 bundle 的本地补丁（`KEEP_IN_SHARED_TREE`）绕过，**该补丁不在本仓库**；
  识别：启动日志 `migration deferred` / `could not stage`。DSH 每次升级都会覆盖它，升级后要重跑。

**设置导出/导入（换机器一键搬配置，v0.9.0 新增）**

```powershell
node tools/settings.mjs export --out D:\bl-settings.json   # 旧机器
node tools/settings.mjs import D:\bl-settings.json --yes   # 新机器（覆盖前自动备份 settings.json.bak-*）
```
`show` 看当前值；不带 `--yes` 演练。会搬 fps / 质量 / 无头 / 窗口尺寸 / 代理 / 观察窗形态 /
拟人轨迹与速度 / `userBridge` / `backendMode` / `userDefault` / 端口，并**主动提示两件换机后必须人做的事**：
`userBridge=true` 说明还要人工装扩展 + 重跑 `browser_ext_setup`；`chromePath` 指向的路径在新机器上可能不存在（空了会自动探测）。
**不含**：浏览器扩展、`bridge.json` 的 token、`chrome-profile/` 登录态、`audit/` 留痕 —— 这四样本就该每台机器各自一份。

**换机后自查**

```powershell
node tools/verify-audit.mjs         # 期望 PASS 15 项
node tools/verify-host.mjs          # 期望 58 passed（3 项 fail 是套件无真 Chrome 的既有失败）
node tools/verify-audit-chain.mjs   # 期望 0 = 链完整（还没留痕时会跳过并返回 0）
```

## 工具一览（agent 侧）

| 工具 | 说明 |
|---|---|
| `browser_open` | 启动/接管浏览器（懒启动），可选 url / newTab / `use` |
| `browser_ext_setup` | **一键备好"接管你日常浏览器"的现场**：开桥（`userBridge=true`）→ token 进剪贴板 → 打开目标浏览器的扩展页 → 资源管理器里打开 `extension/` 目录，并把步骤列出。`kind` 选 `edge`/`chrome`，`open:false` 只返回路径与 token |
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
| `browser_downloads` | 下载目录清单（观察窗里也能一键取回；用户浏览器那档仍只列插件实例的目录） |
| `browser_close` | 关浏览器（profile 保留，登录态不丢）；用户浏览器那档**只断开调试器，不关你的浏览器** |

**每个工具都带一个 `use` 参数**（v0.7.0）——`'plugin'` / `'chrome'` / `'edge'` / `'user'` / `'auto'`，
用来在同一个会话里指定这次调用落在哪台浏览器上（详见「接管你自己的浏览器」一节）。
不写 `use` = 沿用上一次调用用的那台。

所有工具串行互斥（一次只跑一个）；首次调用自动拉起浏览器并弹观察窗。

## 拟人轨迹（v0.3.0）

agent 的鼠标移动（`browser_click` / `browser_move`）默认不再是"瞬移出现"：
三次贝塞尔弧线 + 两端慢中间快的缓动 + 随进度衰减的正弦抖动 + 偶发微停顿，
事件仍从 CDP 输入管线注入（`isTrusted === true`，与真鼠标同层）。

- 设置项：`humanize`（默认 true，关掉回到瞬移）、`humanSpeed`（0.3~4，默认 1，约 0.15~0.45s/中程）。
- 单点距离 < 6px 自动走直线，不做无意义插值。
- **观察窗接管的实时输入不走插值**（你的手感必须即时），它本身就是真人轨迹。
- 注意：插值只作用于**页面感知到的鼠标**，Windows 系统光标不会跟着动（OS 级注入是另一层，未做）。

## 观察窗

两种形态（设置页「观察窗形态」可切换，**切换当场就把窗口交接过去**、不用退出重进；面板标题栏 ⧉ 也能随时弹出独立页）：

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
- **不挡路**（v0.4.2 浮球 / v0.4.3 面板）：
  - **浮球**：侧栏 🌐 与叠列地球钮是 `position:fixed` + 近上限 z-index，正常页面上必须
    盖住侧栏才点得到；设置页/对话框开着时它会**沉到那层遮罩底下**（不是消失）——和壁纸宝珠同一待遇：
    宝珠没有任何特殊样式，它看着朦胧只是因为被设置页那层半透明 + `backdrop-filter` 的遮罩盖着。
    做法：在浮球中心做一次 `elementsFromPoint`，取"盖住 ≥1/4 视口"的那个元素，沿祖先链找最大数值
    z-index，浮球 z 设成它 − 1，同一层磨砂把它一起糊掉；弹层关掉自动浮回原层级。量不到遮罩层级时
    （设置页不是带层级的固定遮罩那一类）退回**就地磨砂**：`opacity .3 + blur(2px)` 再垫一块自带
    `backdrop-filter` 的小玻璃板，看着仍是一层影而不是硬压在内容上。
  - **面板**：560px 那块窗沉下去就等于什么都看不见，所以 v0.4.3 改成**收进独立页**：设置页一开，
    摊着的内嵌面板自动收掉并弹 `/bl/view`（可丢副屏、F11，与设置页互不干扰）；离开设置页时，你已经
    把独立页关了才还回面板，还开着就不动 —— 不会出现同一画面两份。`window.open` 被浏览器拦掉时
    （非用户手势有可能）**不收**，面板留着至少还能看。`showPanel` 也认这个状态，所以在设置页里
    agent 冷启动浏览器时同样直接弹独立页，不会把面板摊在设置内容上。

## 数据与隐私

全部落在 `$DSH_HOME/dsh-browser-live/`：`settings.json`、`state.json`、`bridge.json`（用户浏览器桥的端口与 token）、
`chrome-profile/`（登录态）、`downloads/`、`shots/`、`audit/`（留痕，见下）。CDP 只绑 `127.0.0.1`；
观察窗路由与宿主其他插件路由（`/bga/*`、`/cc/*`、`/api/*`）互不重叠。
不关闭浏览器时它会一直在——用完调 `browser_close` 或点面板 ⏹。

### 留痕（v0.9.0：agent 用浏览器做过的每一步都落盘）

动机很直接：agent 完全可以"开浏览器 → 操作 → 自己关掉"，事后你只剩一个空窗口。
v0.9.0 起，**每一次 `browser_*` 工具调用**（含 `browser_open` / `browser_close`）和
**每一次页面自己发起的跳转**都会追加到 `$DSH_HOME/dsh-browser-live/audit/YYYY-MM-DD.jsonl`：

| 字段 | 含义 |
|---|---|
| `type` | `boot`（宿主启动）/ `tool`（工具调用）/ `nav`（页面发起的跳转） |
| `tool` / `args` | 工具名与参数原文（超 4000 字截断并标注原文长度，不假装完整） |
| `ok` / `err` / `ms` | 成功与否、错误信息、耗时 |
| `urlBefore` / `urlAfter` | 调用前后所在页面的 URL —— "他点了什么、落到哪一页"看这里 |
| `prev` / `h` | 哈希链：`h` 是本条内容的 sha256，`prev` 指向上一条的 `h` |

收口点只有一个：所有工具都在 `index.js` 的注册循环里被 `withAudit()` 包了一层
（不是逐个工具加埋点 —— 那样必然会漏，新增工具时还会再漏）。

```powershell
node tools/verify-audit-chain.mjs                  # 校验今天的留痕链是否完整
node tools/verify-audit-chain.mjs <文件或目录>
```

**能力边界（别把它当保险箱）**：追加写 + 哈希链能查出"删了一行 / 改了一行"——
`tools/verify-audit.mjs` 里就有这两条断链断言。但日志和 agent 在同一台机器、同一个用户下，
**拥有完整写权限的人可以把整条链重算一遍**，因此它挡的是"顺手抹掉一两步"，不是防篡改。
真要不可抹，得把这条 JSONL 实时送到 agent 够不到的地方（另一个进程 / 另一台机器）。

另外，**"关掉 agent 自己开的页面"这个权限本来就不在 agent 手里**：它由浏览器右上角扩展弹窗里的
「允许关闭 agent 自己打开的标签页」开关控制（`extension/popup.js` + `background.js` 的
`allowCloseOwn` 判定，默认开；关掉之后连它自己开的也关不了），你手动开的页面任何情况下都不在范围内。


## 前置条件

- Node ≥ 22（DSH Desktop 自带）；宿主 ≥ 0.1.2（defineTool 解析带 lite 兜底，装不上也只降级不崩）。
- 本机任一 Chromium 系浏览器：Chrome / Edge / Brave（自动探测；探测失败在设置里填 `chromePath`）。
- 无头服务器也可用：设置 `headless=true` 后工具全通，只是画面是虚拟的。
- **调试提示**：若你在受限沙箱终端里跑本插件的 e2e 脚本，Chrome 会因命名管道被拒而
  `FATAL mojo platform_channel (0x5)` 自杀——表现为 CDP 连上后立刻 1006 断开。
  这不是插件问题：宿主内正常运行不受影响；离线验证请用允许命名管道的会话跑
  `node 03-调试临时\bl-e2e.mjs`。

## 接管你自己的浏览器（v0.5.0 起；v0.7.0 起 Chrome / Edge 可**同时**接入）

默认后端是**插件自拉的隔离实例**（独立 profile，登录态是插件自己的）。
想要 agent 用**你日常那个浏览器的登录态/代理/扩展**，走扩展路线：

```
host(index.js) ──WS──> 扩展（extension/, MV3，Chrome 和 Edge 各装一份）
                          └── chrome.debugger ──> 各自真实的标签页
```

**Chrome 与 Edge 各装一份扩展，两条连接可以同时挂在桥上**；每次工具调用用 `use` 指定用哪台。
会话状态（标签页列表、当前标签、CDP 会话）按浏览器分开存，不会串台；
`sessionId` 一律带 `<浏览器>:` 前缀，桥靠这个前缀把请求和事件路由到正确的那条连接
（协议见 [`docs/MULTI-BROWSER.md`](./docs/MULTI-BROWSER.md)）。

为什么必须装扩展、不能直接 CDP attach 你的浏览器：Chrome/Edge 136+ 在**默认 user-data-dir** 上
直接忽略 `--remote-debugging-port` / `--remote-debugging-pipe`（安全加固，CVE-2025-4051/4052）。
本机 Chrome 153、Edge 152 都早就过了这道线，`chrome.debugger` 是唯一像样的路。

**开启**：设置页「浏览器观察窗 → 用户浏览器」点成「桥已开启」（面板显示端口 + token，可一键复制），
然后按 [`extension/README.md`](./extension/README.md) 在 **Chrome 和 Edge 里各加载一次**扩展并粘 token。
同一个 token 两边通用；桥只绑 `127.0.0.1`，握手要 token，升级请求只认 `chrome-extension://` 的 Origin
（网页里的 `ws://127.0.0.1` 连不进来）。设置页会列出**当前已接入的浏览器**，并可指定
`use:"user"` 默认用哪台（直接写 `use:"edge"` / `use:"chrome"` 永远优先于这个默认值）。

**日常用法（"免登录页 / 要登录的页"分工）**：默认档 `auto` 下，免登录的网页一律走插件自带实例
（不受逐站点授权限制、可 `newTab` 新开页）；只有确实要你的登录态时才切到你的浏览器：

1. 在**那台浏览器**的扩展弹窗里给该站点点「允许」（整批页面可点「允许当前所有标签页」；
   要真点击/打字再打开「允许操作」）；
2. `browser_open { url, use: "edge" }` → agent 在 Edge 当前标签页里导航/操作（用户浏览器档**不能新开标签页**）；
3. 完事 `browser_open { use: "plugin" }` 切回独立窗口，后面的免登录活继续不受授权限制。

`use` 取值：`plugin`（自带实例）/ `chrome` / `edge`（你的浏览器，必须已接入）/ `user`（settings.userDefault 那台）/
`auto`（桥连着就用你的浏览器）。**不写 `use` = 沿用上一次调用用的那台**，冷启动默认 `plugin`；
显式指定的浏览器没接入时会**明确报错并列出当前已接入的** —— 绝不静默换到另一台去操作。

`browser_open` 的返回值里 `browser` 字段告诉你当前实际用的是哪个（`插件自带实例` / `你的 Edge`），
`connected` 列出当前已接入的浏览器，`hint` 直接给出下一步该传什么。

**三层开关**（都在扩展弹窗里，逐层收紧；两台浏览器各自一套）：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 逐站点「允许」 | 无授权 | 没点过的站点，url/标题对 agent 一律打码，调试器也附加不上 |
| 「允许当前所有标签页」 | — | 一次性把该浏览器里所有 http(s) 标签页的 origin 并入白名单（不打开「允许所有网站」） |
| 「撤销全部授权」 | — | 清空白名单（有二次确认） |
| **允许操作**（v0.6.0 / P1） | **关** | 打开后才放行 `Input.*` 与 `DOM.setFileInputFiles`（真点击/打字/按键/滚轮/上传） |
| 允许所有网站 | 关 | 高风险：放弃逐站点确认 |

**只读能力（永远可用）**：`browser_snapshot` / `browser_text` / `browser_screenshot` /
`browser_tabs list` / `browser_navigate` / `browser_wait`。观察窗照样直播（帧也是经扩展回的
`Page.captureScreenshot`），`/bl/view` 与内嵌面板会亮红标：只读时「🔴 正在读取你的 Edge」，
打开「允许操作」后变成「🔴 正在操作你的 Edge（可点击/打字）」。

**P1 操作能力**（需打开「允许操作」）：`browser_click` / `browser_move` / `browser_type` /
`browser_press` / `browser_scroll` / `browser_upload` —— 事件经 `chrome.debugger` 注入
（`isTrusted:true`，与真人同层），拟人鼠标轨迹照旧生效。

**实机测出来的三条硬约束**（v0.6.0 已处理，但你必须知道）：

1. **输入只送到「可见 + 窗口有焦点」的标签页**。后台标签、失焦窗口下 Chrome 会静默丢弃
   `Input.dispatchMouseEvent`（键盘偶尔能过，所以看起来"半好"）。扩展在发任何输入前会
   `chrome.tabs.update({active:true})` + `chrome.windows.update({focused:true})`，
   等窗口真的拿到焦点后再等 300ms 才发事件 —— 也就是说 **agent 动手时会把 Chrome 拉到前台**。
   Windows 的前台锁定可能拒绝被抢焦点（任务栏闪烁而不切换），这时需要你手动点一下 Chrome 窗口。
   只读命令（截图 / 取文本 / 快照）**不会**抢你的前台标签。
2. **`disabled` 的表单控件收不到鼠标事件**（Chrome 行为，不是接管失败）：真点击一个 disabled
   输入框会"没反应"。实测番茄渠道商后台「新增推广链」里的「书籍ID + 搜书」搜索框就是
   `disabled:true`（要先选「选择包」等前置项），点它没反应是页面状态；同对话框里可用的
   「书籍ID」表单项真点击/真打字正常。
3. **坐标必须一次到位**：元素若在测量后被页面重排（Element UI 的对话框滚动），点击会落空。
   用 `instant:true` 可把"测量→下发"的间隔压到一个往返，成功率高得多。

**仍然被拒**（扩展侧硬拒，会以错误结果返回，不会静默）：

| 被拒 | 原因 |
| --- | --- |
| `browser_tabs new/close` | 不新建/关闭你的标签页（`Target.createTarget/closeTarget`） |
| `browser_downloads` | 列的仍是插件实例的 `downloads/` 目录，看不到你 Chrome 自己的下载（接 `chrome.downloads` 属 P2） |
| 未授权站点 | 逐 origin 授权；没授权时连调试器都附加不上，开了「允许操作」也进不去 |
| 改网络 / 模拟器 / 改属性 | `Network.setExtraHTTPHeaders`、`Emulation.*`、`DOM.setAttributeValue` 不在接管范围 |

**兜底**：扩展掉线 → 下一次工具调用自动回退插件实例（行为与 v0.4.3 完全一致）；
`browser_close` 在用户浏览器模式下**只拆调试器，绝不关你的浏览器**；
扩展侧会话失效（SW 重启 / DevTools 抢走调试器）时 host 会自动清 session 重试一次。

**已知缺口**：`Runtime.evaluate` 在扩展白名单里（snapshot/text 靠它取正文），所以扩展拦得住
"合成输入"，拦不住页面内 JS 自己点按钮 —— 也就是说 `browser_eval` 理论上仍能代打。
真正的护栏是逐站点授权 + 「允许操作」开关 + Chrome 那条无法隐藏的「正在调试此浏览器」横幅。
收窄 evaluate（改成固定脚本下发）仍是待办。

## 已知边界（v0.5.0）

- 观察窗单实例（整个宿主一个浏览器会话，不做多会话隔离）；多 agent 并发浏览请串行使用
  （多个会话共用同一受控 Chrome 时会互相抢标签页，这是设计如此，不是 bug）。
- 默认后端仍是插件自拉实例；**接管你日常浏览器**是 v0.5.0 的扩展路线（P0 只读，见上），
  P1（输入接管）/ P2（审批联动、evaluate 收窄）未做。
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

## 版本与变更记录

- **v0.8.3**：**「不动你正在看的页面」＋「Chrome 起不来不是提权，是安全软件拦了 GPU 沙箱」** ——
  ① 接管你的浏览器时，"当前页未授权、目标站已授权"不再**就地导航**（那会把你正在读的页面换掉），
  改成 **`chrome.tabs.create` 新开一个标签页**、附加到新标签页，你原来的页面一个字都不动；
  扩展把真实 `tabId` 报回 host，host 据此纠正映射（否则列表显示"旧标签页已附加"、操作却落在新标签页上）。
  ② **更正 v0.8.2 的错误归因**：Chrome 静默退出不是"DSH 以管理员运行"—— 本机用计划任务
  （干净父进程、中完整性、脱离 DSH 作业对象）复测照样起不来，而加 `--in-process-gpu` 就正常；
  真凶是**火绒 HipsDaemon 拦掉 Chrome GPU 进程的沙箱初始化**（Edge 因微软签名被放行）。
  启动链因此改成"先常规试 → 失败补试 `--in-process-gpu` → 成功就记进 `state.json` 下次直接用"，
  并刻意**不**用 `--no-sandbox`（渲染器沙箱要留着），`verify-launcher` 有断言钉死这条底线。
- **v0.8.2**：**「Chrome 起不来 = 整个插件不可用」＋「中文用户名下浏览器根本拉不起来」** ——
  启动链上两个只在真实机器暴露的坑。① VBS 独立启动器原来用 UTF-8 写、wscript 按 ANSI 读，
  中文用户名（`C:\Users\陈道云\…`）被读成乱码路径 → 浏览器一个进程都不起，对外只报「未响应 CDP 端口」，
  还在 `C:\Users` 下留下乱码目录；现在写 **UTF-16LE + BOM**。
  ② 首选浏览器起不来时不再全盘失败：`findChromiumExes()` 返回候选列表
  （`chromePath` → 环境变量 → Chrome → Edge → Brave）逐个尝试并**自动降级**。
  这条是实测逼出来的：**DSH Desktop 以管理员身份运行时，Chrome 会因无法在提权父进程下初始化沙箱
  而静默退出（加 `--no-sandbox` 才起，但默认不关沙箱），Edge 不受影响** —— 也就是说"装了个 Chrome"
  反而可能让插件彻底不可用。同时：端口改成跳过"已有别的 CDP 在听"的（避免附加到错误的浏览器），
  每个浏览器各自一个 profile 目录（`chrome-profile-chrome` / `-msedge` / …）。
  新增回归测试 `tools/verify-launcher.mjs`（10 条）。
- **v0.8.1**：**「我允许了目标站点，你却还在报未授权」** —— 用户浏览器档的判权用的是标签页**当前** URL，
  于是"允许了 github.com、前台却开着别的页"这种最常见用法必然被闸死。
  现在 `browser_open {use:"edge", url}` / `browser_navigate {url}` 会把目标 URL 传进 `Target.attachToTarget`
  的 `intendedUrl`，扩展在**当前页未授权、目标页已授权**时**先导航、再附加**（最多等 5s 落在已授权 origin）。
  隐私底线不变：attach 永远在导航之后，agent 拿不到未授权页面的调试器。- **v0.8.0**：**装扩展不再靠“看文档”** —— 新增 `browser_ext_setup`，并把“桥没开”和“扩展没装”分开报。
  - 背景：接管你的浏览器要三件事同时成立（桥开着 / 扩展装着 / token 粘对），而 v0.7.x 只把它们写成文字说明：
    `use:"edge"` 在**桥没开**时也报“扩展还没连接”，把人引去装一个装了也连不上的扩展；
    报错不给 `extension/` 绝对路径、不说 token 在哪；面板在桥没开时显示空 token，步骤却照旧摆着。
  - 新工具 `browser_ext_setup`：开桥（`userBridge=true`，即时生效）→ token 进剪贴板 →
    打开目标浏览器的扩展页 → 资源管理器里打开本包 `extension/` 目录，并把 5 步操作原样列出。
    `kind:'edge'|'chrome'`（默认 `settings.userDefault`），`open:false` 只返回路径与 token、不动 UI。
  - `browser_open {use:"edge"}` 的失败信息分两种情况：**桥没开** → 指向 `browser_ext_setup`；
    **扩展没装** → 给出扩展页地址 + `extension/` 绝对路径 + `bridge.json` 位置（token 在那）。
  - 面板：桥没开时出现 **「① 启用用户浏览器桥」** 按钮（一键 `PUT {userBridge:true}` 并刷新状态），
    安装步骤加序号，并注明“也可以直接交给 agent：调 `browser_ext_setup`”。
  - `/bl/bridge` 的 hint 带上 `extension/` 绝对路径；`browser_open` 在“一台都没接入”时提示该调谁。
  - 边界（没变）：「加载已解压缩的扩展程序」是**原生文件选择框，无法自动化** —— 那一下永远得人点；
    本版做的是把“点哪儿、选哪个目录、粘什么”全部摆到眼前，而不是绕过它。- **v0.7.1（2026-09-11 修）**：真圆的方圆角豁免。DSH 主题自带全局规则
  `*,:before,:after{corner-shape:var(--dsw-corner-shape)}`，而默认值是 `superellipse(1.5)`；
  新版 Chromium 支持 `corner-shape` 后，凡 `border-radius:50%` 的元素都会被画成方圆块
  （用户报的是底图工坊的宝珠，本插件的 `.bl-fab` hover 底衬、`.bl-dot`、
  独立网页 `/bl/view` 里的 `.dot` 同理）。宿主自己的圆形控件都写了 `corner-shape:round` 豁免，
  本插件已照做（`client.js` 三处 + `index.js` 的 `/bl/view` 一处）。旧内核自动忽略该属性。
  注意 `index.js` 是宿主侧文件：改完要重启桌面端，`/bl/view` 页面才会换新。
- v0.7.0：**Chrome / Edge 同时可控，每次调用指定用哪台（`use`）**
  - 需求：日常两个浏览器（Chrome 153 / Edge 152）各有登录态，agent 要能操作 **Edge 里已登录的页面**，
    而且要能在同一个会话里来回切，不必断开重连。
  - 桥（`bridge.js`）：单个连接槽（`this.sock/this.ext`）→ `conns: Map<kind, BridgeChannel>`，
    **每个 kind 一条连接、各自的 pending/seq/心跳**（同 kind 重复连接保留最新，旧的以 `4002 superseded` 关掉）。
    回包按 `sessionId` 的 `<kind>:` 前缀找连接再配对，找不到就忽略（不抛）。
    `kindOfBrowser` 现在**纯 kind 与完整 UA 两种形状都认**（原先只认 UA，"opera" 这种族名会静默落进 unknown）。
  - 扩展（`extension/`，v0.3.0）：装载时按 UA 嗅探身份（`Edg/`→edge…）并在 hello 里上报；
    **所有跨 WS 边界的 sessionId 一律带 `<kind>:` 前缀**（出口加、入口剥，内部仍用裸 id）；
    弹窗新增身份行 + **「允许当前所有标签页」**（批量并入 origin，不打开 allowAll）+「撤销全部授权」。
  - host（`index.js`）：新增**每浏览器一份会话**（tabs / selected / cdp 分开存），
    `browser` 单例退化为"当前活跃会话的视图"，于是 19 个工具里上百处 `browser.xxx` 读法一行没改；
    每个工具注入 `use` 参数（`plugin`/`chrome`/`edge`/`user`/`auto`，缺省**沿用上一次**）；
    `/bl/state` 与 `/bl/bridge` 新增 `browsers[]`，观察窗红标带上浏览器名；`settings.userDefault` 决定 `use:"user"` 指哪台。
  - 隐私/安全边界不变：仍是逐站点授权 + 「允许操作」开关 + Chrome/Edge 自带且无法隐藏的调试横幅。
    多浏览器只扩大"能连几台"，不放松任何一层。
  - 行为修正（都是这次改造暴露出来的真问题）：
    · `browser_close` 之后 `browser_open` 接不回来（外层守卫抢在 `browser_open` 自己的 `useSession/launch` 之前判死）；
    · 没写 `use` 时若"上一次那台"已掉线，会一路报错 → 现在退回插件实例并记录一行提示；
      显式写了 `use:"edge"` 而它掉线时**仍然报错**（明示意图不该被静默改写）；
    · `use` 取值校验用错了判定（`isUserKind` 把 `firefox` 当成"未接入的浏览器"）→ 新增 `isKnownKind`；
    · `onBridgeStatus` 的兜底分支曾把完整 UA 当 kind 塞进 Set（子代理 review 抓到）→ 改为读 `browsers[].kind`；
    · `backendMode='user'` 时桥从 0→N 接入会把活跃会话切到你的浏览器（恢复 v0.6 的档位语义）。
  - 验证：新增 `tools/verify-browsers.mjs`（**35 项**）——真 `index.js` + 真桥 + 真扩展，
    **两台"浏览器"各跑在一个 Worker 里**（独立 realm = 独立 `globalThis`），断言"发给 Edge 的命令只打在
    Edge 的标签页上""两台各自一份调试器会话""同 kind 重连只占一个槽""掉线不影响另一台"等串台类故障。
    另有 `tools/verify-bridge-v2.mjs`（74 项）、`tools/verify-extension-v2.mjs`（146 项）。
    五个套件合计 **23 + 74 + 66 + 146 + 59 + 35 = 403 项全绿**（v1 那两个套件也一并保留通过）。
  - 记一笔踩过的坑（替身层面，但东西是真的）：在**同一个 realm** 里加载两份扩展副本时，
    模块级自由变量 `chrome` 指向同一个 `globalThis`，靠"副本开头重新赋值"隔离不了 ——
    表现是 Chrome 扩展读到 Edge 的标签页，断言全绿但全是假的。两个 Worker 才是与"两个浏览器进程"同构的替身。
  - 提醒：改 `index.js` / `client.js` 后要**重启 DSH Desktop** 才加载新代码与新的设置页控件。
- v0.6.2：**把"免登录页走自带实例、授权后才切你的浏览器"这条默认路做成看得见的一档**
  - 背景：v0.6.1 已经有 `backendMode='auto'`，但设置页只有「自带实例（推荐）/ 我的浏览器」两档，
    文案也没写清"免登录页 vs 要登录的页"各走谁 —— 于是很容易被设成 `user`，
    之后**每一个免登录页面都撞逐站点授权**（表现为"连 example.com 都开不了"）。
  - 设置页三档，标签直接写明用途：**免登录用自带实例（推荐，=auto）/ 只用自带实例（=plugin）/ 只用我的浏览器（=user）**；
    下面那行说明按档位分别讲清"免登录页去哪、要登录的页怎么办"。
  - `browser_open` 的返回值新增 `mode`（当前档位）与 `hint`（下一步该 `use:"plugin"` 还是 `use:"user"`），
    描述里也写明：`auto`/`plugin` 免授权、可 `newTab`；`user` 档逐站点授权、只读、**不能新开标签页**。
  - `PUT /bl/settings.json` 改 `backendMode` **当场换后端**（原来要等下一次工具调用才切）；
    桥/扩展还没连上时切 `user` 只存设置并回 `backendWarn`，等扩展接入后由 `onBridgeStatus` 自愈。
  - `tools/verify-host.mjs` 跟着修：**原来的用例假设"桥一连上就切 user"（v0.6.0 旧行为），在 `auto` 档下必然红**；
    改成先显式设 `backendMode:'user'` 再验用户浏览器那条链路，并新增两条用例
    （`auto` 档下桥连着也不抢后端、`PUT` 切档当场生效）。47 项全绿。
  - 提醒：改 `index.js` / `client.js` 后要**重启 DSH Desktop** 才加载新代码与新的设置页按钮（工具描述在插件装载时定型）。
- v0.6.4：**能在插件实例里打开 DSH 自己的 GUI（`browser_open {gui:true}`）**
  - 症状：在插件自带实例（独立 profile）里访问 `http://127.0.0.1:<端口>/` 只会得到
    `dsh web authentication required; reopen the URL printed by dsh web.`。
  - 机制（`@deepseek-ai/dsh-client-connection` 的 `authorizeIndex`）：GUI 根路径只认两样东西 ——
    ① URL 查询串里的**一次性 launch token**（`?token=…`，仅 `GET /`）会 303 落地并种一个**按 Host 绑定的签名 cookie**；
    ② 之后靠那个 cookie。插件 Chrome 是干净 profile，两样都没有 → 必然 401。
    token 由进程生成、只在"DSH 启动时打印的 URL"里下发，凭据库（`.credentials.yaml`）只存 cookie 签名密钥，不存 URL。
  - 改法：**不绕过门禁**，改用宿主自己的接口 —— 与 `dsh-web-app` 打印 dsh web URL 用的是同一个：
    `ctx.inject(['connection'], c => c.connection.authenticatedUrl('http://127.0.0.1:<webServer.port>'))`。
    - 启动时取一次并缓存（拿不到只警告，不影响任何既有功能）；
    - 新增路由 `POST /bl/gui` `{need:'gui-url'}` → `{ok,url}`；可带 `base` 换成 LAN 地址（同一套 token 规则重签）；
    - `browser_open {gui:true}` 用它打开 GUI；
    - 取向：**只认 POST + JSON**（裸 GET 会被 `<img>/<script>` 这类跨站请求捎带上 token；POST+JSON 触发预检，
      而本服务不返回 CORS 头，跨站读不到结果），且 token **不进入**工具失败结果的错误文本（有测试钉住）。
  - `tools/verify-host.mjs` 新增 6 项（400 / 405 / 正确 URL / LAN 重签 / gui:true 走到启动 / 不泄露 token），
    套件 **58 项全绿**；为此把假 ctx 扩成 `get/inject/effect` 齐全，并给假 `webServer` 补上 `port`。
  - 前提：宿主 web profile 里要有 `connection` 服务（本机 DSH Desktop 有；纯 headless 且没配它的场景拿不到 URL，
    此时按提示改用"启动时打印的 dsh web URL"）。


- v0.6.3：**让插件自拉实例真的有一个"能看见的窗口"（`launchDetached`）**
  - 症状（用户报回来的）：免登录页在插件实例里打开一切正常（工具全返回 ok、观察窗有画面），
    但**屏幕上根本看不到那个浏览器窗口**，只能靠观察窗看。user32 枚举证实：插件实例的 8 个 chrome
    进程（同一 Windows 会话、`headless=false`、页面自报 `outer 1440x900`）**没有任何一个持有窗口句柄**，
    而用户自己的 Chrome 有 —— 即窗口没在系统里注册，不是被最小化。
  - 根因：`spawn(exe, args, { detached: false })` 把 Chrome 拉成 DSH 进程树的子进程；在带作业对象/
    受限桌面的宿主里，Chrome 的窗口不注册。`detached: true` 也不够（Windows 上子进程仍留在同一作业对象）。
  - 改法：默认 `launchDetached: true` —— 写一个极小的 VBScript 启动器到数据目录
    （`launch-chrome-detached.vbs`，`WScript.Shell.Run(cmd, 1, False)`），用 `wscript` 起 Chrome，
    使它成为**没有父作业对象的独立进程**，从而拿到真实可见窗口。启动器写失败/起不来时**自动回退**
    老的子进程 spawn，所以不会把浏览器整体打死。
  - 顺手把"窗口是否可见"变成**可观测事实**：启动后用 CDP 的 `Browser.getWindowForTarget` +
    `Browser.getWindowBounds` 自查（Chrome 自己报的，不依赖宿主能不能枚举 Win32 窗口），结论写进
    观察窗动作条：`🪟 ✓ 启动后自查：窗口存在且可见（windowId=…，state=normal，1440x900）`；
    窗口尺寸小于设置值时自动 `Browser.setWindowBounds` 修正。
  - `browser_close` / `shutdown` 在独立启动下只走 CDP `Browser.close`（`proc` 此时是启动器，杀它没用）；
    `process.on('exit')` 也不再对启动器做无意义 kill。
  - 新增 `tools/verify-launch.mjs`（**14 项**）：VBS 生成逐条断言（含空格的 `Program Files` 路径、
    带空格的 `--user-data-dir`、参数含引号时的 `""` 转义、`Run` 的可见样式=1/不等待）+ 假 CDP
    （HTTP `/json/list` + 真 WS 帧）验证窗口自查的三种结局（可见 / 最小化 / 不可达）。
    这条测试当场抓出一个真 bug：`writeDetachedLauncher` 假设数据目录已存在，**全新安装首次启动会抛错**
    （已修：先 `mkdirSync`）。`npm test` 现含 4 个套件（23 + 65 + 47 + 14 = 149 项）。
  - 局限（说清楚）：沙箱终端里**无法验证窗口真的出现**（该环境禁止从 shell 拉起 Chrome：
    `Start-Process` / `cmd start` / `wscript` 三条路径的 Chrome 都没起来、连 profile 目录都没被创建），
    所以这条改动靠"启动后自查 + 你实际看一眼"来确认；不行就把设置里 `launchDetached` 设回 `false`
    即回到老行为。

- v0.6.1：**默认不再抢占你的日常浏览器（`backendMode`）**
  - 问题：只要桥连着，`onBridgeStatus` 就把后端切成"用户浏览器"，于是**连不需要登录态的页面**
    也会撞上 P0 的逐站点授权（没在扩展里点过「允许」就直接报"站点未授权"）——
    实际上插件自拉实例本来没有这层限制，白白绕远了。
  - 新增设置 `backendMode`（设置页「用哪个浏览器」，三档）：
    - `auto`（默认）= 默认用**插件自拉实例**（独立窗口 + 独立 profile，不碰你的浏览器、不受逐站点授权限制）；
      只有确实需要"你的登录态"时，由 agent 显式 `browser_open { use: "user" }` 切到你的日常浏览器。
    - `plugin` = 只用插件实例。
    - `user` = 与 v0.6.0 旧行为一致：默认就在你的浏览器里操作。
  - `browser_open` 新增 `use` 参数，返回值里带上实际用的是哪个浏览器（`browser` 字段）。
  - 桥连着不再等于"必须用它"；切后端会重建标签页清单（两个浏览器的 tab 列表本来就不通用）。
  - 迁移：**默认值保持"自带实例"，因此升级后你原来的 `user` 行为会变**。若你就是要 agent 一直在
    你的浏览器里干活，去设置页点一下「我的浏览器」（或把 `settings.json` 的 `backendMode` 设为 `"user"`）。

- v0.6.0：**P1 —— 真输入接管（点击/打字/按键/滚轮/上传）**
  - 扩展新增「允许操作」开关（默认关、持久化）：关着时 `Input.*` 与 `DOM.setFileInputFiles`
    一律拒绝并提示去弹窗打开；打开后经 `chrome.debugger` 注入（`isTrusted:true`），
    拟人鼠标轨迹照旧生效。前提仍是逐站点授权 —— 没授权的站点连调试器都附加不上。
  - **输入前自动把目标标签/窗口置前**（`chrome.tabs.update` + `chrome.windows.update`，
    并等焦点真正到手 + 300ms 稳定期）：实测后台标签、失焦窗口下 Chrome 会**静默丢弃**鼠标事件，
    键盘偶尔能过 —— 不置前就会出现"工具说 ok、页面没反应"。只读命令不抢前台。
  - 开关状态实时回传 host：`/bl/state`、`/bl/bridge`、设置页、观察窗红标（只读→「正在读取」，
    可操作→「正在操作你的日常浏览器（可点击/打字）」）全部同步。
  - 弹窗新增「已授权 N 个站点 / 允许操作：开|关」状态行 + 操作成功的绿色提示 + 消息失败自动重试
    （MV3 SW 休眠时第一条消息会丢，旧版把错误吞了，表现为"点了没反应"）。
  - host 加固：撤销授权后**清掉本地缓存的 url/标题**（原来会把打码前的真实 URL 留在 `/bl/state` 里）、
    监听扩展 `detach` 事件作废 sessionId、遇到「会话已失效」自动清 session 重试一次。
  - 验证：`verify-bridge` 23 + `verify-extension` 65 + `verify-host` 43 = **131 项**，`npm test` 全跑；
    并在真实 Chrome + 番茄渠道商后台用真点击/真 ctrl+a/真打字跑通（事件全 `isTrusted:true`）。
  - 仍未做：`chrome.downloads` 接管（`browser_downloads` 在用户浏览器模式下仍指向插件目录）、
    收窄 `Runtime.evaluate`、与 approval-gate 联动。
- v0.5.0：**接管你自己的浏览器（P0 只读）—— 扩展路线落地**
  - 新增 `bridge.js`（WS 桥：只绑 127.0.0.1、token 握手、Origin 只认 `chrome-extension://`、
    心跳 + 单实例顶替、端口顺延、`bridge.json` 持久化 token）与 `extension/`（MV3 扩展：
    service worker 当"反向 CDP 客户端"、`chrome.debugger` 转发、弹窗逐站点授权 + 红点角标）。
  - host 侧零改调用面：`browser.cdp` 直接换成桥对象，17 个工具的 `send/on/alive/close` 语义不变；
    桥断自动回退插件实例；`browser_close` 在用户浏览器模式下只拆调试器。
  - P0 硬拒：`Input.*` / `DOM.setFileInputFiles` / `Target.createTarget|closeTarget` /
    `javascript:` 与 `file:` 导航；未授权站点的 url/title 对 agent 打码。
  - 设置页新增「用户浏览器」开关（即时生效）+ 端口/token 展示与复制；`/bl/bridge` 路由；
    `/bl/view` 与 `/bl/state` 带 `backend`，用户浏览器模式下常驻红标。
  - 验证：`tools/verify-bridge.mjs`（23 项）、`tools/verify-extension.mjs`（41 项，mock chrome 跑真扩展）、
    `tools/verify-host.mjs`（29 项，真 index.js + 真桥 + 真扩展代码）。`npm test` 全跑。
  - 未做（P1/P2）：输入接管、下载事件、`Runtime.evaluate` 收窄、与 approval-gate 联动。
- v0.4.3：**设置页开着时，内嵌面板自动收进独立网页 `/bl/view`**
  - 浮球（v0.4.2）沉底就够好看了，但那块 560px 的窗沉下去等于看不见 —— 所以面板换做法：设置页一开
    就 `foldPanelToStandalone()`（收面板 + 弹独立页），两边各看各的。
  - 离开设置页 `unfoldPanelIfNeeded()`：独立页**已被你关掉**才还原面板；还开着就不动，避免同一画面
    出现两份。`window.open` 被拦（非用户手势有可能）时**不收**，面板留着还能看。
  - `showPanel()` 的判断从 `S.liveView` 扩成 `S.liveView || S.settingsUi > 0`：所以在设置页里
    agent 冷启动浏览器时也是直接弹独立页，不会先摊一个面板在设置内容上。
  - 验证：`03-调试临时\verify-bl-liveview.mjs` **19 项**（真 React SSR + 假 DOM/假接口，用一个
    立即执行 effect 的 React 垫片把"挂载/卸载设置页分区"变成可驱动的测试点），覆盖
    "panelWanted → 面板摊开" → "打开设置页 → `window.open('/bl/view')` + 面板 `display:none`" →
    "独立页被关 + 离开设置页 → 面板还原 flex" → "弹窗被拦 → 不收面板"。
    同一次排查还发现测试桩自己踩的坑：`S.liveView` 只在 boot/`loadCfg`/`put` 三条路径刷新，
    光改盘上副本不生效 —— 断言前要先借一次设置页挂载让它重读。
- v0.4.2：**浮球让位从"消失"改成"沉底"**（用户反馈 v0.4.1 隐藏的做法"效果还是很差"）
  - 不再 `display:none`。改成量出盖住浮球那层的 z-index、把浮球降到它 − 1，于是浮球和壁纸宝珠
    一起被设置页那层半透明 + `backdrop-filter` 的遮罩糊掉：位置不动、轮廓还在，只是沉在下面。
  - 层级不用猜也不用写死：`overlayZAt()` 在浮球中心 `elementsFromPoint` → 跳过我们自己的元素 →
    只认覆盖 ≥1/4 视口的层 → 沿祖先链取最大数值 `z-index`。遮罩撤掉后 `zIndex=''` 回到样式表基值。
  - 兜底球（无 slots 环境）的 `position/z-index` 从行内样式搬进 `.bl-fab-fallback` 类 —— 否则
    还原时把 `style.zIndex` 置空会把基值一起清没，浮球会真沉到侧栏底下去（这是改的过程中发现的）。
  - 量不到层级时退回 `.bl-fab-ghost`：`opacity .3 + blur(2px) saturate(.7)` + 一块自带
    `backdrop-filter` 的小玻璃板（`::before`），仍然是"一层影"，不会硬压在设置内容上。
  - 验证：`03-调试临时\verify-bl-liveview.mjs` 16 项，含"沉底时 `display` 绝不能是 none"、
    "z 变成 1999"、"量不到→ghost"、"关掉→全部还原"；另用真 Chrome 跑
    `03-调试临时\bl-fab-sink-probe.html` 验证机制本身：命中链 `["#fab","#scrim","html"]` →
    量到遮罩 2000 → 设 1999 后该点最上层变成 `#scrim`（浮球确实在磨砂之下），置空后回到 2147483049。
- v0.4.1：**两个用户报回来的 bug**
  - **选了「独立网页」却掉回内嵌面板**：根因是客户端 `api()` 返回的是 `Response`，而
    `fetchSettings()` / `loadCfg()` 两处直接把它当设置对象读 —— `j.liveView` 恒为 `undefined`，
    于是盘上明明存着 `standalone`，开机算出来仍是 `panel`：地球钮弹内嵌面板，设置页里
    「内嵌面板」还一直被画成选中态。改成先 `.json()`（并带 `cache:no-store`），选中态在
    `cfg` 未落地前用已知状态顶上、不再闪成面板；`put` 换形态时新增 `applyLiveView()`
    当场交接（原来开着窗 → 立刻在两种形态间搬迁，不重复开窗）。
  - **左下角 🌐 浮在设置页之上**：叠列地球钮与兜底浮球都是 `position:fixed` + 近上限 z-index。
    新增 `fabShouldYield()/syncFabYield()`：设置页开着（以本插件 `settings.section` 挂载为信号）
    或页面有 `role=dialog`/`aria-modal` 弹层时隐藏浮球，弹层关掉自动回来。
     （**这个"隐藏"在 v0.4.2 被"沉底"取代** —— 判断信号沿用，做法换了。）
  - 验证：`03-调试临时\verify-bl-liveview.mjs` 11 项真 React SSR + 假 DOM/假接口，覆盖"存着
    standalone 时设置页必须高亮独立网页"与"弹层开→浮球消失→弹层关→浮球回来"；另用
    `03-调试临时\make-bl-buggy.mjs` 复原旧写法跑同一测试，确认它**会红**（3 项 FAIL），
    不是只会绿的摆设。
- v0.4.0：观察窗双形态（可拖动贴边的内嵌面板 + 独立网页 `/bl/view`，设置项 `liveView`）、
  代理设置映射 Chrome `--proxy-server`、面板本会话被关后不再自动重开、与底图工坊宝珠叠列共存。
  更早历史见 git log。

## 许可与致谢

- 本插件源码：MIT © 2026 **Raylen-berry**（作者 / 维护者）。
- **灵感来源（原作者）**：[dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)，
  MIT © **Fisfzy** and dsh-ego-browser contributors。其"把 agent 接进 DSH 的真浏览器 + 观察窗"
  设计（含 ego-lite 运行时，© CitroLabs / ego-lite contributors，MIT）证明了这条路走得通。
- 本仓库是**独立自研的干净实现（clean-room re-implementation）**：不含 ego-browser / ego-lite 的任何一行代码，
  不携带其运行时 vendored 源码，仅借鉴其功能思路与交互范式。商标与名称归各自所有者。

感谢 ego-browser 作者把"接进 DSH 的 agent 浏览器 + 观察窗"这条路趟通。
完整署名与上游声明见仓库根目录 [`NOTICE`](./NOTICE) 文件。
