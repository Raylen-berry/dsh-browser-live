# dsh-browser-live · 看得见的 Agent 浏览器（DSH 标准插件）

让 agent 驱动**本机真实 Chrome/Edge/Brave**（CDP 直连，无 vendored 运行时、无裸 npm 依赖），
并在右下角开一块**实时观察窗**：agent 在网页上干什么，你全程看得见，还能直接接管鼠标键盘。
v0.5.0 起还可选**接管你自己的日常浏览器**（装一个 MV3 扩展，带你的登录态/代理，P0 只读）。

> 设计灵感来自 [dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)（MIT）。本插件是**自研实现**：
> 不携带 ego-lite 运行时、零裸 import，与 `link:` 本地安装工作流完全兼容（同 dsh-bg-atelier / dsh-cache-control 约定）。

## 它解决什么

DSH 内置的 web_search/web_fetch 只能"读"；凡是**必须真浏览器**的活（登录态、动态渲染、表单、验证码、
需真人会话的站点）就干不了。装上本插件后，agent 获得 21 个 `browser_*` 工具，能真正在页面里
点击、输入、提交、滚动、取快照；你在观察窗里实时看到每一步，卡在验证码时点进面板亲手代打，
完事再把鼠标还给 agent。

## 组成

| 文件 | 职责 |
|---|---|
| `index.js` | Host（ESM）：拉起/接管 Chrome → CDP；注册 21 个 `browser_*` 工具；`/bl/*` 观察窗后端（SSE 帧流 + 输入回传 + 设置/代理 + 下载取回 + `/bl/view` 独立网页 + `/bl/bridge` 桥状态） |
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

## 发布前检查（CI 与本地同一条命令）

push / PR 都会跑 `.github/workflows/ci.yml`，它做两件事：`npm ci`（只装 devDependencies）→ `npm test`。
本地跑的就是同一条命令：

```bash
npm install                    # 只装 devDependencies（就一个 ws）；CI 用 npm ci
npm test                       # = node tools/run-all.mjs
node tools/run-all.mjs --list  # 只看清单：跑哪些、以及哪些被排除、为什么
npm run audit:check            # 只校验留痕哈希链（= node tools/verify-audit-chain.mjs）
```

**出网边界**：只有 `npm ci` / `npm install` 那一步出网（按 `package-lock.json` 装 devDependencies）。
`npm test` 本身**不出网** —— 不做真实下载、不调真实模型、不起真浏览器、不读本机 DSH 安装目录。

`tools/run-all.mjs` 把 9 项语法门禁（`node --check`）和 15 套离线测试都跑完再汇总（原来的 `npm test` 是 `&&` 串，
第一套一失败后面的就不跑了），任一套非 0 退出 ⇒ `npm test` 退出码 1 ⇒ CI 变红。
CI 用 Node **22 / 24** 两档矩阵、windows-latest。

> **文档口径（本轮定）：这里不写"某套件通过多少条"。** 逐套件的通过数只能跑出来 —— 而其中
> `verify-host` / `verify-page-fns` / `verify-web-tools` 三套**根本不在 CI 门禁里**（要起真浏览器），
> 把它们写进文档就没人能核对，已经陈旧过不止一次（具体是哪些数、涨到多少，见 CHANGELOG）。
> 现在只留**不跑就能静态核对**的清单数字（门禁几条、离线几套、工具几个、技能正文几节，
> 都由 `tools/verify-manifest.mjs` 的 D 段当场比对，写错就红）；
> **逐套件条数一律以 `npm test` 的输出为准**（要清单用 `node tools/run-all.mjs --list`）。

> **为什么没有 Node 20**（本轮实测纠正）：扩展代码 `extension/background.js` 里的裸
> `new WebSocket(...)`、以及"没有 ws 包就退回 `globalThis.WebSocket`"那条路，都依赖**全局 WebSocket**，
> 而 Node 20 没有这个全局对象（实测 `node20 globalThis.WebSocket = undefined`，`node22/24 = function`）。
> 于是 `verify-extension` / `verify-browsers` / `verify-result-cap` 三套在 Node 20 上必红
> （干净环境实测：语法门禁全过、离线套件只有一部分通过，`verify-result-cap` 因缺 WebSocket 大面积失败；
> 那次的具体条数见 CHANGELOG）。
> 所以矩阵写 22/24，并在 `package.json` 里声明 `engines.node >= 22` —— 把真实下限写进 manifest，而不是把红藏起来。

**未纳入 CI 的有 3 套**（原因同时写在 `tools/run-all.mjs` 的 `EXCLUDED` 里）：

- `verify-host.mjs` —— 会**真的拉起浏览器**：`browser_open{gui:true}` 在有 Chromium 的机器上断言的是"启动成功"，
  CI runner 自带 Edge ⇒ 会弹真窗口、走真 CDP。
- `verify-page-fns.mjs` / `verify-web-tools.mjs` —— 会拉无头 Chromium（Edge/Chrome）做 CDP 实测，
  测试期不许起真浏览器、不许做真实下载。

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
- **浏览器起不来怎么办**（v0.12.0 起自动处理，这里给手动兜底）：症状是工具报
  「10 秒内没响应 CDP 端口」，而机器上其实有一堆 `msedge.exe`/`chrome.exe` 占着插件的
  `chrome-profile-*` —— 它们让新实例被"转交"、不开调试端口。原因见 CHANGELOG 0.12.0 §7。
  一条 PowerShell 清干净（**只匹配本插件数据目录，不碰你自己的浏览器**；不用重启 DSH）：

  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains(($env:APPDATA + '\dsh-desktop\harness\dsh-browser-live\chrome-profile').ToLower()) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```

  之后再 `browser_open` 即可。v0.12.0 起 `browser_close` 会等 profile 真正释放（最多 6s）、
  启动前与启动失败时都会自动清理这类残留，并记一条 `🧹 …` 动作提示（不静默）。
- 留痕（v0.9.0 起）：所有 `browser_*` 调用与页面自身跳转都追加到
  `$DSH_HOME/dsh-browser-live/audit/YYYY-MM-DD.jsonl`（append-only + 哈希链）。
  `node tools/verify-audit-chain.mjs` 验链；`node tools/verify-audit.mjs` 离线自检（不碰真实留痕目录）。
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
node tools/verify-audit.mjs         # 期望 PASS（离线自检；条数以 npm test 输出为准）
node tools/verify-result-cap.mjs    # 期望 0 failed（离线，不起真浏览器）<!-- doc-numbers-ok -->
node tools/verify-host.mjs          # 期望 0 failed（v0.10.0 起按"有/无真 Chromium"分两支断言；不在 npm test 门禁里）<!-- doc-numbers-ok -->
node tools/verify-audit-chain.mjs   # 期望 0 = 链完整（还没留痕时会跳过并返回 0）
npm test                            # 全套；其中 verify-page-fns / verify-web-tools 会真起一个无头浏览器
```

## 工具一览（agent 侧）

| 工具 | 说明 |
|---|---|
| `browser_open` | 启动/接管浏览器（懒启动），可选 url / newTab / `use` |
| `browser_ext_setup` | **一键备好"接管你日常浏览器"的现场**：开桥（`userBridge=true`）→ token 进剪贴板 → 打开目标浏览器的扩展页 → 资源管理器里打开 `extension/` 目录，并把步骤列出。`kind` 选 `edge`/`chrome`，`open:false` 只返回路径与 token |
| `browser_navigate` | 导航并等加载完成 |
| `browser_snapshot` | 结构化快照：可见交互元素清单（**跨快照稳定的 ref**、role、文本、坐标、状态标记）+ 正文节选。重名元素带 `ctx` 消歧；页面上有人机验证时结果里会带 `challenge`。**点击前先拿 ref** |
| `browser_click` | ref / CSS selector / 坐标三选一，真实鼠标事件（右键、双击可选）；**默认走拟人贝塞尔轨迹**（`instant:true` 可瞬移）。用 ref/selector 时**先做可操作性检查**（隐藏/零尺寸/disabled/pointer-events/视口外/被遮挡），失败返回确定性原因而不是静默点空（`force:true` 可跳过） |
| `browser_move` | 拟人移动鼠标（触发 :hover/下拉/tooltip）；`hold` 按住左键、`instant` 瞬移；同样带遮挡/可见性检查 |
| `browser_type` | 聚焦输入框（自动全选便于替换）+ 插入文本，可回车；**输入后回读字段值**确认真的写进去了（password 只回长度，不回显） |
| `browser_read` | **读当前页的结构化内容**（v0.10.0）：自动识别正文主体、输出 Markdown（标题/列表/表格/代码块/链接）、附元信息与链接清单；offset/limit 是**段落感知**的，长文续读不会把句子劈开 |
| `browser_scrape` | **把重复结构抓成行数据**（v0.10.0）：`item` + `fields`（`"a@href"` 取链接并绝对化），不用写 JS |
| `browser_search` | **在浏览器里真搜**（v0.10.0）：Bing/百度/DDG → 结构化结果；被反爬拦会自动换引擎并如实回报原因 |
| `browser_upload` | 本机文件塞进 `<input type=file>`（不弹系统对话框）；ref/selector 可指上传按钮/拖拽区容器，自动解析其中隐藏 input（Meta Ads 等 React 自定义上传组件适用）；触发 change 事件 |
| `browser_press` | 按键/组合键：`Enter`、`ctrl+a`、`alt+ArrowLeft`… |
| `browser_scroll` | 滚轮方向+像素 |
| `browser_wait` | 等文本出现 / 选择器命中 / URL 片段 / 纯等待，带超时 |
| `browser_eval` | 页内 JS 表达式（returnByValue + await 可选） |
| `browser_text` | 正文分块提取（**纯字符切片**；要结构就用 `browser_read`） |
| `browser_screenshot` | 可视区/整页 PNG 落盘，路径可直接交给读图工具 |
| `browser_tabs` | 标签页 list/new/select/close |
| `browser_history` | 前进/后退/刷新（可强刷） |
| `browser_downloads` | 下载目录清单（观察窗里也能一键取回；用户浏览器那档仍只列插件实例的目录） |
| `browser_close` | 关浏览器（profile 保留，登录态不丢）；用户浏览器那档**只断开调试器，不关你的浏览器** |

**每个工具都带一个 `use` 参数**（v0.7.0）——`'plugin'` / `'chrome'` / `'edge'` / `'user'` / `'auto'`，
用来在同一个会话里指定这次调用落在哪台浏览器上（详见「接管你自己的浏览器」一节）。
不写 `use` = 沿用上一次调用用的那台。

所有工具串行互斥（一次只跑一个）；首次调用自动拉起浏览器并弹观察窗。

## 配置：哪些是"可配/百分比"，哪些是刻意固定的

**原则：凡是"尺度 / 地址 / 顺序 / 上限"这类会因机器、显示器、网络、站点而异的量，都不该写死在代码里。**
（这条是用户明确要求的，也确实是我先前的毛病：搜索引擎写死三个名字、面板尺寸带硬上限 560px、
搜索冷却写死 30s。）

### 可配（`$DSH_HOME/dsh-browser-live/settings.json`，改完即时生效；`node tools/settings.mjs show` 看全部生效值）

| 设置 | 默认 | 说明 |
|---|---|---|
| `panelWidthPct` / `panelHeightPct` / `panelWidePct` | 42 / 52 / 66 | **观察窗面板的宽 / 高 / 宽屏宽 —— 都是视口百分比** |
| `windowSize` | `1440,900` | 浏览器窗口尺寸：**像素**或**百分比**（`80%,85%` = 屏幕工作区的 80%×85%） |
| `search.engines` / `search.order` | 空 | 自定义搜索引擎（`{url:"…%s", item, link, title, text}`）与 `auto` 的尝试顺序 |
| `searchCooldownMs` / `searchBudgetMs` | 30000 / 20000 | 引擎冷却时长 / 单次搜索总预算 |
| `fps` / `quality` | 2 / 60 | 观察窗帧率与画质 |
| `headless` / `chromePath` / `extraArgs` / `proxy` | — | 浏览器怎么起、走不走代理 |
| `liveView` | `panel` | 内嵌面板 / 独立网页（`/bl/view`，可丢副屏、F11 全屏） |
| `humanize` / `humanSpeed` | true / 1 | 拟人鼠标轨迹开关与速度倍率 |
| `backendMode` / `userDefault` / `userBridge` / `bridgePort` | auto / '' / false / 9760 | 默认用哪档浏览器、桥的端口 |
| `maxTabsWarn` | 12 | 标签页开太多的提醒阈值 |

每次调用还能单独给（不改设置）：`browser_search` 的 `engine` / `engineSpec`、`browser_read` 的
`limit` / `offset` / `linkLimit` / `selector`、`browser_scrape` 的 `limit`、所有工具的 `use`。

### 刻意固定（写死是有理由的，不是漏改）

- **浏览器候选**（Edge → Chrome → Brave）：这几款是"你真的在用、且允许被驱动"的；路径可用 `chromePath` 覆盖。
- **人机验证特征库**：属事实性数据；识别出来是"停下问人"，不该做成可配置开关。
- **安全阀**：工具串行互斥、快照元素上限（140）、单次结果上限（**整个结果 24k 字符**，其中正文单次
  最多 20k —— 抓 300 行 / 搜 50 条这类额度也一样受它约束）—— 防止一次调用把上下文打爆的护栏，
  需要更多就用 `offset`/`limit` 分段取。**超限时是在序列化之前裁剪**：结果仍是合法 JSON，且带着
  `truncated` / `truncation.originalChars`（原始长度）/ `truncation.nextOffset`（下次续读的 offset）
  与 `next` 提示 —— 绝不会把 JSON 拦腰切断，也不会静默丢内容。详见下面「单次结果上限」一节。
- **面板的可读下限**：`min-width:min(280px,90vw)` —— 纯百分比在极窄窗口会把面板压到不可用；
  这个下限本身也随视口缩（90vw），不是固定像素。

## 单次结果上限：声明与实际必须一致（超限在序列化前裁剪）

**数字（只有这三个，别处引用它们）**

| 量 | 值 | 含义 |
|---|---|---|
| `MAX_TEXT_CHARS` | **20000** | **正文**类字段（`text` / `value`）的单次上限 —— 也就是 `browser_text` / `browser_read` 的 `limit` 声明上限 |
| `MAX_RESULT_CHARS` | **24000** | **整个结果**的硬上限（正文 + 元信息 + 链接清单……全算进去） |
| 其它额度 | 抓 300 行 / 搜 50 条 / 快照 140 元素 | 行数类额度照旧，但它们产出的结果同样受 24000 约束 |

**为什么要有这一节**：v0.12.0 之前，`browser_text` / `browser_read` 声明"`limit` 上限 40000"，
而外层安全阀切的是**序列化之后的字符串**（`safeJson` 里 `slice(0, 24000)`）。两者一叠加就是坏结果：
3 万字的页面上，调用方拿到的是被拦腰切断的串（`JSON.parse` 直接抛），而且 `offset` / `charsStart` 这些
续读信息正好落在切口之后 —— "内容长、请续读"实际表现成"结果坏了、也没法续读"。

**现在怎么走**

- **声明 = 实测**：`limit` 上限就是 `MAX_TEXT_CHARS`（20000），三个地方用的是同一个数
  （工具 schema 说明、`index.js` 的 clamp、注入到页面里的 `READ_FN` 的 clamp —— 页面内函数读不到模块常量，
  所以 `tools/verify-result-cap.mjs` 里有一条断言专门钉住那个字面量）。
- **在序列化之前裁剪**：正文按剩余预算（24000 减去元信息/链接等包装开销）先裁到段落边界；正文裁完还超，
  就从尾部整条丢"成片行数据"（链接清单、抓取行），**丢了几条也记账**。返回值永远是合法 JSON。
- **截断显式记账**（不再静默丢，也不再靠一句"…(截断)"）：

  ```json
  {
    "text": "…（已保留的正文）",
    "truncated": true,
    "next": "还有内容：用 offset=20000 续读",
    "truncation": {
      "truncated": true, "limit": 24000,
      "field": "text", "originalChars": 40000, "keptChars": 20000,
      "originalResultChars": 45210,
      "nextOffset": 20000,
      "fields": [{ "field": "links", "original": 100, "kept": 12 }],
      "note": "结果超过单次上限：已在序列化前裁剪（不是把 JSON 切断）。…"
    },
    "linksDropped": 88
  }
  ```

- **续读**：照 `truncation.nextOffset`（或 `next` 里的 offset）接着读即可，分页不重不漏 ——
  3 万字材料两次取完，拼起来与原文逐字一致。
- **短结果一个字都没变**：没超限就原样返回、不加任何记账字段（`tools/verify-result-cap.mjs` 里
  有"防修过头"断言钉住这两条）。

**验证**：`node tools/verify-result-cap.mjs`（**离线、不起真浏览器**）—— 真 `apply()` + 真桥 +
真扩展 + 一个 Worker 假浏览器（长页模式把工具**真正生成的表达式**放进 `node:vm` 真跑）：
解析/限额/记账/续读链/短结果/声明一致，以及 `browser_scrape`、`browser_search`、`browser_snapshot`
这三处同类组合（它们没声明 40000，但同样会撑过 24000，走的是同一道收口）。`npm test` 已包含它。

## 网页理解与搜索（v0.10.0）：读得懂、抓得到、搜得了

v0.10.0 从 7 个同类 MIT 插件里蒸馏出三个工具，**没有新增任何 npm 依赖**（全部靠注入脚本 + 现有 CDP 通道）：

| 工具 | 它解决什么 | 关键实现 |
|---|---|---|
| `browser_read` | 读一篇文章/一个页面 | 四级正文降级（多 `article` ≥200 字 → `role=main` → `main` → 最大文本块）、噪音剥离、Markdown 输出、**段落感知截断**、meta/og/JSON-LD 元信息、链接清单、标题大纲 |
| `browser_scrape` | 把列表/表格/搜索结果抓成行数据 | `item` + `fields`（`"h3 a@href"` 取链接并绝对化、`@html`、`@text`），命中不到时自适应重试 |
| `browser_search` | 在浏览器里真搜（**引擎无关**） | 打开"搜索 URL 模板" → 用 `{item,link,title,text}` 抽取 → 跳转链处理 → **四态空结果分诊** → 冷却换下一个 |

**搜索引擎是"机制 + 数据"，不是一份菜单（v0.11.0）**：可迁移的技术是上面那套流程本身，与具体
是哪个引擎无关。所以：

- **预设**只有三个（`bing` / `baidu` / `ddg`），它们只是"开箱即用的默认值"，**不是**"可用清单"；
- **要接任何别的引擎**（Google、Sogou、公司内网站内搜索、某个文档站的搜索框）不用改代码、不用配置、
  不用重启 —— 调用时自带即可：

```js
browser_search({ query: '关键词', engineSpec: {
  url: 'https://某个站点/search?q=%s',   // %s 或 {q} = 搜索词（缺占位符会明确报错并给示例）
  item: 'li.result', link: 'h3 a', title: 'h3', text: 'p.summary', label: '显示名',
}})
```

- **想长期复用**就写进 `$DSH_HOME/dsh-browser-live/settings.json`：
  `"search": { "engines": { "我的站内搜索": { "url": "…%s", "item": "…", "link": "…", "title": "…", "text": "…" } }, "order": ["我的站内搜索"] }`
  —— 设置按调用读盘，改完下次调用即生效；`order` 就是 `engine:"auto"` 时的尝试顺序。
- 引擎名写错时，报错会**告诉你怎么自带**（而不是甩给你三个名字）。

**为什么"在浏览器里搜"而不是发 HTTP 请求**：用的是你自己浏览器已授权的身份，比服务端抓取更少遇到
反爬。空结果会**按病因分诊**（四态，处置完全不同）：`blocked`（被反爬拦了 → 换引擎 + 冷却，默认 30s 可配）、
`not-loaded`（页面没加载完 → 等一下重试）、`layout-changed`（**item 选择器**没命中 → 改 item）、
`filtered-out`（**命中了条目但字段全没通过** → 改 link/title/text）。最后一态是实测逼出来的：
百度那次 `hits=8` 却没有结果，原来被笼统报成"引擎改版"，把人引到错误的排查方向。

**为什么不做成"自带行动循环的 agent"**：循环是 DSH agent 自己的事。这里只把"看得懂"和"抓得到"补上，
再用一份**调用方案**告诉 agent 怎么组合。所以：

- `skills/browser-automation/SKILL.md` = 完整调用方案（14 节：决策表 → 浏览器档位 → 观察/行动循环 →
  ref 与状态标记 → **故障处置表** → 读/抓/搜的用法 → 人机验证纪律 → 反模式清单 → 4 个现成剧本 → 验收口径）。
- DSH 的技能发现**不会**自动扫插件包里的 `skills/`，所以 `index.js` 自己调 `skills.register` 注册
  （`POST /bl/skills/reload` 可免重启重扫新增技能）。技能真正常驻的只有 name + description，
  正文在 agent 调 `skill` 时才进上下文 —— **21 个工具不该配一份常驻长文**。
- 人机验证、被遮挡、ref 失效这些"卡住"的情形，都做成**工具返回值里的一等公民**
  （`challenge` / `flags.covered-by` / 确定性错误原因），而不是让 agent 自己猜。

验证：`node tools/verify-page-fns.mjs`（**真起无头 Chromium**，本地 fixture 页面；它**不在 `npm test`
门禁里**，自带被起的浏览器）；技能注册与重扫路由的断言在 `node tools/verify-host.mjs` 里。两套的条数
都以各自命令的输出为准（要清单见 `node tools/run-all.mjs --list`）。

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
| `tool` / `args` | 工具名与参数（超 4000 字截断并标注原文长度，不假装完整）。**敏感输入已脱敏**，见下 |
| `ok` / `err` / `ms` | 成功与否、错误信息、耗时 |
| `urlBefore` / `urlAfter` | 调用前后所在页面的 URL —— "他点了什么、落到哪一页"看这里 |
| `prev` / `h` | 哈希链：`h` 是本条内容的 sha256，`prev` 指向上一条的 `h` |

完整细节（password 字段的脱敏判据与兜底键名清单、v0.12.0"链尾以文件为准"的断链诊断史、
"追加写+哈希链挡顺手抹除但不防重算整链"的能力边界）见
[`docs/AUDIT-DETAILS.md`](./docs/AUDIT-DETAILS.md)。


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
2. `browser_open { url, use: "edge" }` → agent 在 Edge 当前标签页里导航/操作。**v0.3.2 扩展起它也能
   `newTab` 新开页**（开到你指定的 http/https，弹窗「允许 agent 新开标签页」控制，默认开）；
   新开的页记在 agent 名下，所以可被它自己关，你原有的标签页一个字都不动；
3. 完事 `browser_open { use: "plugin" }` 切回独立窗口，后面的免登录活继续不受授权限制。

`use` 取值：`plugin`（自带实例）/ `chrome` / `edge`（你的浏览器，必须已接入）/ `user`（settings.userDefault 那台）/
`auto`（桥连着就用你的浏览器）。**不写 `use` = 沿用上一次调用用的那台**，冷启动默认 `plugin`；
显式指定的浏览器没接入时会**明确报错并列出当前已接入的** —— 绝不静默换到另一台去操作。

`browser_open` 的返回值里 `browser` 字段告诉你当前实际用的是哪个（`插件自带实例` / `你的 Edge`），
`connected` 列出当前已接入的浏览器，`hint` 直接给出下一步该传什么。

**三层开关**（逐站点授权 / 允许操作 / 允许所有网站）、只读与 P1 操作的能力分层、实机测出的三条硬约束
（焦点标签才收输入、disabled 控件收不到点击、坐标要一次到位）、被拒清单与兜底、以及
`Runtime.evaluate` 这个已知缺口 —— 全部移到
[`docs/TAKEOVER-CONTROLS.md`](./docs/TAKEOVER-CONTROLS.md)。

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

- 逐版本的完整记录在 [docs/HISTORY.md](./docs/HISTORY.md)（v0.4.0 起至今，含每次的验证方式与回归条数）。
- 当前版本见 package.json 的 ersion；更早历史见 git log。
## 许可与致谢

- 本插件源码：MIT © 2026 **Raylen-berry**（作者 / 维护者）。
- **灵感来源（原作者）**：[dsh-ego-browser](https://github.com/Fisfzy/dsh-ego-browser)，
  MIT © **Fisfzy** and dsh-ego-browser contributors。其"把 agent 接进 DSH 的真浏览器 + 观察窗"
  设计（含 ego-lite 运行时，© CitroLabs / ego-lite contributors，MIT）证明了这条路走得通。
- **v0.10.0 蒸馏来源**（均 MIT；页面侧算法全部按浏览器 DOM 独立重写，搜索引擎 URL/选择器与
  验证码特征属事实性数据）：[dsh-read-url](https://github.com/2672243194/dsh-read-url)
  （正文降级顺序 / 链接密度阈值 / 段落感知截断 / Markdown walker 细节 / JSON-LD 兜底）、
  [wqty123/dsh-browser](https://github.com/wqty123/dsh-browser)（`选择器@属性` 抓取约定 /
  人机验证特征集与判定顺序）、[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser)
  （WeakMap 稳定编号 / 无障碍名字优先级 / 输入后回读 / 页面内容按不可信数据处理）、
  [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)（技能即调用方案的组织骨架）、
  [modsearch](https://github.com/liustack/modsearch) · [dsh-free-search](https://github.com/DDDMUC/dsh-free-search) ·
  [dsh-web-search-pro](https://github.com/anweat/dsh-web-search-pro)（引擎 URL 与选择器 / 空结果三态判定 / 冷却）。
- 本仓库是**独立自研的重实现**：不含 ego-browser / ego-lite 的任何一行代码，不携带其运行时 vendored 源码。
  v0.10.0 起为诚实起见，`NOTICE` 里明确声明了两类"不是纯概念借鉴"的东西：**事实性数据**
  （引擎 URL、SERP 选择器、验证码特征）与**按 DOM 重写的算法**（页面侧函数），并附上各自的 MIT 许可全文。
- 上游未采用的部分也写清楚：`dsh-read-url` 的可选 `@mozilla/readability` 升级路径是 **MPL-2.0**，
  本插件**不引入任何 npm 依赖**，所以那条路直接关闭（好消息是那些判定逻辑本就是它的自研零依赖部分）。

感谢 ego-browser 作者把"接进 DSH 的 agent 浏览器 + 观察窗"这条路趟通。
完整署名与上游声明见仓库根目录 [`NOTICE`](./NOTICE) 文件。
