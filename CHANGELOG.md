# 变更记录

## 未发布 — 文档数字不再陈旧（口径：不许写跑出来的数）；CI 装测试依赖 + 恢复 6 套测试；修 `loadWs()` 的导出形状缺陷；verify-manifest 改口径

### ① 产品缺陷：`loadWs()` 的导出形状只对了一半（"本机全绿、CI 全红"的根因）

**核实**（先只读复现，再改）：`index.js` 的 `loadWs()` 返回 `m.default || m`，而调用处是
`const { WebSocket } = await loadWs()`（约 `index.js:847`）。npm `ws` 的两种布局导出形状不同 ——
实测（真实 `ws@8.21.3`）：

| 入口 | 命名空间 | `m.default` | `m.default.WebSocket` | 解构 `{ WebSocket }` |
| --- | --- | --- | --- | --- |
| 裸包名 `import('ws')`（走 `exports` → `wrapper.mjs`） | 有具名 `WebSocket` | **类本身** | **undefined** | **undefined ⇒ 报"WebSocket 不可用"** |
| 直接文件路径 `import('<…>/ws/index.js')`（DSH 安装目录那种布局） | 只有 `default` | `module.exports` | 有（`index.js` 尾部 `WebSocket.WebSocket = WebSocket` 自引用） | 恰好能用 |

于是"干净机器 / CI 上 npm 装好 `ws` 之后，`reportWindowState()` 仍然报 WebSocket 不可用"。

**改了两处**（最小改动，同一个缺陷的两半）：
1. `loadWs()`：`const W = m?.WebSocket ?? m?.default?.WebSocket ?? m?.default`，
   并写清两种布局的差异；`loadWsModule()` 用同一套取法（原来两个分支也是散的）。
2. 调用处 `reportWindowState()`：`const WS = await loadWs()`（原来是解构 `{ WebSocket }`）。
   不能只改 ① —— ① 之后 `loadWs()` 返回的是**构造器本身**，再去解构 `.WebSocket` 就两种布局都取不到。

顺带：`loadWs()` 现在 `export` 出来，测试能直接调它。新增测试缝 `DSH_BROWSER_LIVE_WS`
（带路径分隔符的当直接文件路径、否则当裸包名），让套件用临时夹具把两种布局各测一遍，
不依赖本机装没装 `ws`。

**数字**（`tools/verify-launch.mjs`，本机装了真 npm `ws`）：

| | verify-launch |
| --- | --- |
| 改动前（原 `index.js`）+ 新断言 | **14 passed / 10 failed** |
| 改动后 | **24 passed / 0 failed** |

其中 4 项是窗口自查（`Browser.getWindowForTarget`/`getWindowBounds`/`setWindowBounds` 那几条），
与任务描述里的"稳定 13 passed / 4 failed"是同一件事。

**同类问题排查**（"靠 `dirname(execPath)` 猜路径"这一类，就是本地绿、CI 红的根因）——列表见下，结论都给了：

| 位置 | 写法 | 结论 |
| --- | --- | --- |
| `index.js:337`（`loadWs`）、`index.js:355`（`loadWsModule`） | `path.join(path.dirname(process.execPath),'..','..','ws','index.js')` | **不修**。它只是候选表里的一项，是"DSH 安装目录那种布局"的真实兜底；候选表第一位是裸包名 `ws`，干净环境/CI 由 `npm ci` 解析到，不依赖它。 |
| `index.js:230`（`loadDefineTool`） | 同款 `dirname(execPath)` 猜 `@deepseek-ai/dsh-tools` | **不修**。有 `defineToolLite` 兜底，且套件不依赖真包（本轮实测无 `@deepseek-ai/*` 也能全绿）。 |
| `index.js:334/353/342/359` | `dshHome()` / `%APPDATA%` 下的 `profiles/node_modules/ws` | **不修**。同上，是兜底候选，不是唯一来源。 |
| `tools/verify-manifest.mjs` | 无（读的是仓库文件） | 本轮的耦合断言问题，见 ②。 |
| `tools/selfcheck`（**不在本仓库**） | 见 dsh-video-prompt 的 CHANGELOG | 那个仓库已改成"`DSH_APP_DIR` 指向仓库根"。 |

> 这一类写法的共同风险是：**它们让"本机恰好能用"看起来像"代码是对的"**。
> 本轮的处理原则是——候选表可以留兜底，但**主路径必须在干净环境可解析**，
> 并且每个候选形状都要有断言钉住（`verify-launch` 的两种布局断言就是干这个的）。

### ② `verify-manifest.mjs` 的耦合断言改成"等价且更强"的口径，并从 KNOWN_FAILING 挪回 SUITES

**核实**：它原来读 `package.json` 的 `scripts.test` **字符串**，断言每个 `verify-*.mjs` 都逐个出现在
那个长串里。`npm test` 现在只是 `node tools/run-all.mjs`，长串本身不存在了 ⇒ 14 项「npm test 覆盖了 X」失败
（另 17 项通过，`✗ verify-manifest: 17 passed, 14 failed`）。

**改法**（只允许同强度或更强，不许放宽）：改成检查 `tools/run-all.mjs` 的三个清单本身 ——
① 每个套件文件都登记进 `SUITES`/`EXCLUDED`/`KNOWN_FAILING` 三选一（无遗漏，原意图）；
② 三份清单两两不重叠、清单内部无重复（新增，旧口径查不出）；
③ 登记的名字都对应 `tools/` 下真实存在的文件（无幽灵条目，新增）；
④ 排除项必须写明原因（新增）；
⑤ `verify-audit-chain.mjs` 仍由 `npm run audit:check` 覆盖。

**数字**：`✗ 17 passed, 14 failed` → **`✓ 26 passed, 0 failed`**（从 `KNOWN_FAILING` 挪进 `SUITES`）。
反向证据：从 `SUITES` 里删掉一套 ⇒ 报「verify-bridge-v2.mjs 未登记」（25 passed / 1 failed）；
把同一套同时放进 `SUITES` 与 `EXCLUDED` ⇒ 报「SUITES ∩ EXCLUDED」（25 passed / 1 failed）。

### ③ CI 装测试依赖（只装 devDependencies），恢复 6 套；测试执行期间仍不出网

- `package.json`：`devDependencies: {"ws": "^8.18.0"}`，并加 `engines.node >= 22`（理由见下）。
- 新增 `.npmrc`：`legacy-peer-deps=true`（peerDependencies 是宿主 DSH 运行时提供的，
  npm 7+ 会自动去装 35 个 `@deepseek-ai/*`，测试一个都不需要）+ 显式钉 `registry.npmjs.org`
  （本机 `~/.npmrc` 是 npmmirror 镜像，不钉的话 lockfile 里会写镜像 URL，换公网 runner 取不到包）。
- 新增 `.gitignore`（本仓库此前**没有**，依赖目录会被 `git status` 当成待提交内容）+ 提交 `package-lock.json`。
- `tools/run-all.mjs`：6 套从 `EXCLUDED` 挪进 `SUITES`；`KNOWN_FAILING` 清空。
- `.github/workflows/ci.yml`：加 `npm ci --no-audit --no-fund` 与 `cache: npm`，
  并在注释里写明**测试执行期间不出网**（允许出网的只有 `npm ci` 那一步）。

**恢复的 6 套与干净环境实测**（`DSH_HOME`/`APPDATA`/`LOCALAPPDATA`/`USERPROFILE` 全指空目录）：

| 套件 | 项数 |
| --- | --- |
| `tools/verify-bridge.mjs` | 23 |
| `tools/verify-bridge-v2.mjs` | 74 |
| `tools/verify-extension.mjs` | 77 |
| `tools/verify-browsers.mjs` | 35 |
| `tools/verify-result-cap.mjs` | 67 |
| `tools/verify-launch.mjs` | 24 |

**CI 矩阵从 20/22/24 改成 22/24**（这一条是实测纠正，不是省事）：

Node 20 **没有全局 `WebSocket`**（实测 `node20 globalThis.WebSocket = undefined`，
`node22/24 = function`），而扩展代码 `extension/background.js:397` 用的是裸 `new WebSocket(...)`，
`index.js` 也有"没有 ws 包就退回 `globalThis.WebSocket`"这条兜底。于是
`verify-extension` / `verify-browsers` / `verify-result-cap` 三套在 Node 20 上必红
（干净环境实测：8/8 语法门禁过，套件 9/12，其中 `verify-result-cap` **49 passed / 18 failed**）。
所以把真实下限写进 `engines.node >= 22`，矩阵写 22/24，并在 CI 注释、README 里写明原因 ——
而不是把红的套件藏起来。

**干净环境实测（独立下载的 node）**：Node 22 与 Node 24 均为
**8/8 语法门禁 + 12/12 套件**，`npm test` 退出码 **0**。

### ④ 仍未纳入 CI 的 3 套（原因）

| 套件 | 原因 |
| --- | --- |
| `tools/verify-host.mjs` | 会**真的拉起浏览器**：`browser_open{gui:true}` 在有 Chromium 的机器上断言"启动成功"（真窗口 + 真 CDP），CI runner 自带 Edge |
| `tools/verify-page-fns.mjs` | 会拉无头 Chromium（Edge/Chrome）做 CDP 实测 |
| `tools/verify-web-tools.mjs` | 同上，会拉真 Chromium 做 CDP 实测 |

### ⑤ 文档里的「套件数字」清陈旧 + 加一道防陈旧的机制（本轮）

**为什么会有这一轮**：README 与 docs 里散着一堆"某套件通过多少条"，而它们**只能跑出来**才对得上；
其中 `verify-host` / `verify-page-fns` / `verify-web-tools` 三套**根本不在 CI 门禁里**（要起真浏览器），
所以文档里的数连"跑一遍看对不对"这一步都没人做过 —— 于是反复陈旧。

**取数方式**（重要）：门禁内的套件跑 `npm test`（= `node tools/run-all.mjs`）取真数；
**门禁外的三套不许为了取数字去跑**（会拉真 Chromium / 要真实环境），改用**代码里的断言计数**
（`tools/verify-*.mjs` 里 `^\s*ok\(` 的行数）。所以下表门禁外的"实测"一列是**静态断言数**，
不是运行结果 —— 它可能偏高（断言写在分支/循环里时，运行期不一定每条都跑到），
这也是本轮定"以后干脆不写这类数"的直接理由。

**对照表（文档写的 vs 实测）**

| 位置 | 文档写 | 实测 | 处理 |
| --- | --- | --- | --- |
| README「发布前检查」 | `verify-audit` 期望 15 | 17（跑） | 改写为不写条数 |
| README「发布前检查」 | `verify-host` 期望 73 | 94（静态断言数；不在门禁） | 改写为不写条数 |
| README「数据与隐私」 | `verify-audit-redact` 期望 56 | 56（跑，56 是"项"数） | 改写为不写条数 |
| README「网页理解与搜索」 | `verify-page-fns` 96 条断言 | 121（静态；不在门禁） | 改写为不写条数 |
| README「网页理解与搜索」 | `verify-host` 12 条 | 94（静态；不在门禁） | 改写为不写条数 |
| README「单次结果上限」 | `verify-result-cap` 67 项 | 67（跑） | 改写为不写条数 |
| README「组成/工具一览」 | 21 个 `browser_*` 工具 | 21（静态，`index.js` 注册项） | 保留并加相等断言 |
| README「网页理解与搜索」 | SKILL.md **19 节** | **14**（`## N.` 编号标题数） | 改成 14 并加相等断言 |
| README「接管你自己的浏览器」 | v0.12.1 前 6 套因缺 `ws` 被排除 | 6 套（`git log`，当前 `EXCLUDED` 是 3 套） | 是历史，保留 |
| docs/MULTI-BROWSER.md | `verify-extension-v2`(146)、6 套件、403 项全绿 | 160 / 12 套 / — | 删数字，指向 `npm test` |
| docs/PLAN-user-browser-takeover.md | `verify-extension`(66)、`verify-host`(59)、6 套 | 77 / 94 / — | 删数字，指向 `npm test` |
| extension/README.md | `verify-extension`(66)、`verify-extension-v2`(146) | 77 / 160 | 删数字，指向 `npm test` |

> 说明：门禁内的 12 套里，多数"静态 `ok(` 行数"与运行通过数恰好相等（23/74/77/35/67/24/15/56/17），
> 所以能跑的那几套直接看 `npm test` 输出的真数最稳。`verify-manifest` 自己的条数**不写进文档** ——
> 它是"文档数字的守门人"，把自己写进被校验的文档会变成自引用（改一条断言就要改文档）。

**口径（本轮定，二选一里选了这个）**：**现状文档一律不写"某套件通过多少条"，只留不跑就能静态核对的清单数字；
逐套件条数以 `npm test` 输出为准。**
不选"把文档数字改成实测值再靠断言维持相等"的理由：那要求断言自己拿到每个套件的运行结果，
而最容易陈旧的 `verify-host` / `verify-page-fns` / `verify-web-tools` **在 CI 里拿不到**（要起真浏览器），
"相等"这条口径对它们天然失效 —— 只能改成"禁写"，才是有牙的收口。

**落地**：`tools/verify-manifest.mjs` 新增 **D 段**（职责就是"登记与文档一致性"）：

1. **禁写**：现状文档（README 的「版本与变更记录」之前 + `docs/*.md` 全文）里，
   "套件名 + 通过数"（含中文"项/条"、`passed/failed`、表格里的 `套件名(74)` 写法）与 `M/N` 结果分数一律判红。
   豁免范围是显式的：README 的「版本与变更记录」之后、`CHANGELOG.md`、`extension/README.md`、
   `skills/**/SKILL.md`、`.github/workflows/*.yml` 注释
   （它们写的是"当时测出来是多少"，改它等于伪造历史）。
   逃生口只有一个且无后门：写"输出长什么样"时可以带 `<!-- doc-numbers-ok -->` 标记，
   **且该行数字必须全是 0**（`0 failed` 放行，`93 passed` 照样抓 —— 有专门的自检钉这条）。
2. **相等校验**（能静态推出来的清单事实，出现就必须与代码相等）：
   语法门禁条数 ←→ `run-all.mjs` 的 `CHECKS`；离线套件数 ←→ `SUITES`；未纳入 CI 套件数 ←→ `EXCLUDED`；
   `browser_*` 工具数 ←→ `index.js` 注册项；**SKILL.md 节数 ←→ 它的 `## N.` 编号标题数**；
   SKILL.md 剧本数 ←→ 它的 `**A.` 标号数。另加"节号/标号必须从 0、从 A 连续排下来"（编号乱了就没人能核对）。
3. **自检**：把正/负样本直接喂给判定函数（12 条断言：6 条正样本、3 条负样本、3 条标记相关），
   规则被改松当场红 —— 含"标记不是后门"那条（打标记 + 非零通过数照样判红）。

**反向验证**（故意改错，逐条实测，每条都应红）：

| 故意改错 | 结果 |
| --- | --- |
| README `8 项语法门禁` → `9 项` | ✗ exit=1：`{"doc":[9],"actual":8}`（53 passed / 1 failed） |
| README `21 个 browser_* 工具` → `22 个` | ✗ exit=1：`{"doc":[22,21],"actual":21}`（53/1） |
| README `SKILL.md（14 节` → `19 节` | ✗ exit=1：`{"doc":[19],"actual":14}`（53/1） |
| README 加回 `verify-host 期望 93 passed / 0 failed`（带标记也带非零数） | ✗ exit=1：被"禁写通过数"抓到（53/1） |
| README `12 套离线测试` → `13 套` | ✗ exit=1：`{"doc":[13,12],"actual":12}`（53/1） |
| README `4 个现成剧本` → `5 个` | ✗ exit=1：`{"doc":[5],"actual":4}`（53/1） |

改回后：`✓ verify-manifest: 54 passed, 0 failed`，`npm test` 退出码 0（8/8 语法门禁 + 12/12 套件）。

**未覆盖**：`extension/README.md`、`skills/**/SKILL.md`、`.github/workflows/*.yml` 与「版本与变更记录」
之后的内容若再写"套件名 + 数字"，D 段**管不到** —— 这是上面那张豁免清单的代价；
扫描范围只有 README 的现状章节 + `docs/*.md` 全文。收窄或放宽都要先想清楚：
放宽会把"设计文档里的历史叙述"一起禁掉，收窄则等于留下同样的陈旧口子。

## 0.12.1 — 长结果被截坏：超限改成"序列化前裁剪"，声明上限与实测对齐（20k 正文 / 24k 整体）

缺陷（另一轮只读审计的发现，已自行核实并复现）
  `browser_text` / `browser_read` 的 `limit` 声明"上限 40000"（`index.js:2184` / `2212`，
  clamp 在 `2190` / `2223`，注入页面的 `READ_FN` 同样夹 40000，`page-read.js:427`），
  而外层 `safeJson`（`index.js:1608`）切的是**序列化之后的字符串**：
  `s.length > 24000 ? s.slice(0, 24000) + '\n…(截断…)' : s`。
  两者一叠加，3 万字材料下的表现是：JSON **被拦腰切断、无法解析**，而且 `offset` / `charsStart`
  这些续读信息正好落在切口之后 —— 一起丢失。用户看到的是坏 JSON，而不是"内容长、请续读"。
  真链路复现（改前 worktree + 离线假浏览器，3 万字页面）：
  `JSON.parse` → `Bad control character in string literal in JSON at position 24000 (line 1 column 24001)`。

改了什么
  1) `index.js`：`safeJson` 里的"切字符串"整段删掉，改成 `fitResult(v, maxChars)` —— **在序列化之前**
     裁剪，返回值永远是合法 JSON；`safeJson` 只负责 `JSON.stringify`。新导出两个常量：
     `MAX_TEXT_CHARS = 20000`（正文单次上限，也就是 `limit` 的声明上限）与
     `MAX_RESULT_CHARS = 24000`（整个结果硬上限）。裁剪顺序是"先裁正文、后丢行数据"：
     反过来的话，一个特别大的链接清单会把正文预算挤成 0，于是正文被整段丢掉、链接反而留着 ——
     对读长文来说那是最坏的结果。（`tools/verify-result-cap.mjs` 的 A6/B4 钉住这条。）
  2) 截断显式记账（不再静默丢，也不再靠一句"…(截断)"）：结果里带 `truncated`、
     `truncation.originalChars`（正文原始长度）、`truncation.originalResultChars`（裁之前整串多长）、
     `truncation.nextOffset`（下次从哪续读）、`next`（人话提示），以及 `truncation.fields`
     （被裁的字段 / 丢了几条）与 `linksDropped` 这类计数。
  3) **声明与实际一致**：`limit` 上限从走不通的 40000 调到 `MAX_TEXT_CHARS`（20000），
     三处同一个数（工具 schema 说明、`index.js` 的 clamp、`page-read.js` READ_FN 的字面量 ——
     注入函数读不到模块常量，所以有一条断言专门钉那个字面量）；`browser_eval` 的说明里那句
     "结果 JSON 截断 24k"改成描述真行为。README 的"单次结果上限"一节同步。
  4) 同一类问题的第二处（都一并修，走的就是 3) 这道收口）：`browser_scrape`（300 行 × 每格 400 字）、
     `browser_search`（50 条 × 标题 200 + 摘要 400）、`browser_snapshot`（140 元素 + 2600 字正文）
     都没有声明 40000，但同样会撑过 24000 —— 改前一样是被切断的坏 JSON，现在同样"合法 + 记账"。
  5) 测试夹具（`tools/fake-browser-worker.mjs`）新增**可选**的"长页模式"（`workerData.pageText` /
     `readLinks`，缺省时行为与 v0.12.0 完全一致）：把工具**真正生成的表达式**放进 `node:vm`
     配一个假 DOM 真跑，于是 `browser_text` 的 offset/limit 语义是**真代码**执行的，不是替身自己算的。

验证
  - 新增 `tools/verify-result-cap.mjs`（**67 项全绿，离线、不起真浏览器**）：① 3 万字材料 ⇒ JSON 可解析、
    长度受限而结构完整；② 带截断标记 + 原始长度 + 续读 offset；③ 续读一两次取完全文，
    拼起来**逐字等于原文 30000 字**（不重不漏）；④ 短结果一个字都没变（防修过头）；
    ⑤ 声明上限 == 实测上限 == READ_FN 字面量。另含 scrape/search/snapshot 三处同类形状。
  - **反向验证**（`git worktree` 指到改前 HEAD，跑同一份断言，事后移除）：**55 failed / 12 passed**
    （共 67）。真链路层跑的是改前的真代码，失败里最关键的那条正是缺陷本身：
    `Bad control character in string literal in JSON at position 24000`；反向跑里有 3 条通过
    属垫片语义所致（改前不导出 `fitResult` 与那两个常量，垫片按改前语义逐字照抄，于是
    "声明 vs 声明"那几条自洽通过）—— 载荷性的断言（可解析 / 进限额 / 有记账 / 能续读）全红。
  - `npm test` 全套：改前基线与本改动后均全绿（各套件数字见提交说明）。

## 0.12.0 — 尺度改成百分比；剩下的写死项清一遍；顺带修掉一个"静默重置"的真 bug

用户的原话："我记得我之前说过要你把一些页面或者尺度作为百分比类的量，然后你这个浏览器观察窗的
面板并没有做到这点，你还是固定尺寸。再就是其他的定死项……都改了吗。你再验验bug。"

三条都对。逐条落地：

### 1. 观察窗面板：宽/高改成**视口百分比**（原来那个"看起来像百分比"的写法其实是假百分比）

`clamp(300px,42vw,560px)` —— **560px 是硬上限**：窗口再宽面板也不变大，宽屏上反而相对变小，
用起来就是"固定尺寸"。高度更糟：面板高度**完全由截图的宽高比决定**，窄而高的窗口里会顶穿视口。
（独立页 `/bl/view` 一直是 `flex:1 + min-height:0` + `img{max-width:100%;max-height:100%}`，
所以"异类"只有内嵌面板一个 —— 现在两处写法一致。）

- 新增设置 `panelWidthPct`(42) / `panelHeightPct`(52) / `panelWidePct`(66)，设置页可直接改，**即时生效**。
- CSS 走 `--bl-pw` / `--bl-ph` / `--bl-pww` 变量 + `vw/vh`；只剩两个兜底：`min-width:min(280px,90vw)`
  （可读下限，它自己也随视口缩）与 `max-width:calc(100vw - 24px)`（不越出视口）。
- 舞台 `flex:1 1 auto; min-height:0`，图片 `max-width/max-height:100%`（contain、居中、不变形）——
  点击坐标映射仍用 `img` 的 `getBoundingClientRect()`，两轴同比例，所以**坐标语义没变**。
- 连带的固定像素也收了：标签页/下载项宽度改成 `min(150px,18vw)` / `min(160px,20vw)`，收起态上限跟着百分比走。
- **联网实测**（DSH GUI 跑在插件自带实例里，1418×775 视口）：面板 `597×405px` = **42.1%×52.2%**，
  计算样式 `width:595.7px`(42vw) / `max-height:403.1px`(52vh)。
  597px **已经超过旧的 560px 上限** —— 旧写法不可能到这个尺寸，这就是"不再固定"的直接证据。

### 2. 浏览器窗口尺寸也支持百分比

`windowSize` 现在接受 `"1440,900"`（像素，向后兼容）或 `"80%,85%"`（屏幕工作区百分比）。
Chrome 的 `--window-size` 只认像素，所以：先按默认尺寸起来 → 从页面读 `screen.availWidth/availHeight`
→ `Browser.getWindowForTarget` + `Browser.setWindowBounds` 调到目标像素；**量不到屏幕就不动**（不猜）。
只对"插件自带实例"做 —— 接管你日常浏览器时**不动你的窗口**（那是你的东西）。

### 3. 其余写死项

- `searchCooldownMs`(30s) / `searchBudgetMs`(20s)：原来是代码里的常量，现在进设置（慢网络/常被拦时可调）。
- 设置导出/导入工具改为**直接 import 插件本体的 `DEFAULT_SETTINGS`**：原来手抄一份 + 注释
  "改那边时这里跟着改" —— 那种约定迟早漂移，漂移的后果是"导出再导入，设置被悄悄改回默认"。
  数值范围也改成表驱动（`NUMS`），漏掉字段不会丢。
- `node tools/settings.mjs show` 改为显示**生效值**（盘上值叠默认值），并且导出时的版本号不再是写死的 `0.9.0`。
- README 新增「配置：哪些可配/是百分比，哪些刻意固定」：把"该配的都配上；写死的（浏览器候选、
  验证码特征、安全阀）给出理由"，并写明面板可读下限为什么不是纯百分比。

### 4. 顺手修掉一个真 bug：设置里的**非法值会被静默重置成默认**

`sanitizeSettings()` 原来固定从 `DEFAULT_SETTINGS` 出发，于是 PUT 里一个非法值会把该字段**重置成默认值**
而不是保留原值：`PUT {windowSize:"八百块"}` 会把用户之前设好的 `80%,85%` 冲掉。
现在清洗函数接受 `base` 参数：从磁盘加载用默认值当底（坏文件 → 回默认，合理），
PUT 用**当前设置**当底 ⇒ 非法值只是被忽略。回归用例已加（verify-host）。

### 5. 联网实测中又抓到一个"定死"类 bug：引擎自家内链

自带引擎（`engineSpec`）实测接了搜狗，两个 bug 当场暴露，根因是同一个 ——
"引擎自家内链"原来按**写死的引擎域名清单**（bing/baidu/ddg/google/microsoft/msn）判：

- 搜狗的「相关搜索」内链（`sogou.com/web?query=…`）被当成搜索结果混进来；
- 它真正的跳转链（`sogou.com/link?url=<加密串>`）没被标 `viaEngineRedirect`。

改成**与引擎无关**的判据：拿链接域名跟"**这个搜索页自己的域名**"比（归一化 www；页面文件用
`spec.selfHost` 兜底），跳转链形态仍放行。真实搜狗结果页上验证：旧规则留 11 条、新规则留 10 条，
**只剔除那一条自家内链、零误杀**；夹具（照抄实测 DOM）已钉进 verify-page-fns。

### 6. 留痕哈希链：修掉一个"看起来像有人删行"的假断链（v0.12.0 实测踩到）

`npm test` 跑到最后一步时，今天（2026-09-14）的留痕链报**第 16 行 prev 对不上** —— 这正是
哈希链存在的意义所在的告警，所以没有当成噪声跳过，而是逐行核了一遍：

```
行14 tool browser_eval 16:16:37 h=fe4ec485 ✓
行15 boot              16:20:48 prev=fe4ec485 ✓（插件重新 apply）
行16 tool browser_open 16:21:07 prev=fe4ec485 ✗ ← 接回了第 14 行，绕过了第 15 行
行17 tool browser_eval 16:21:11 prev=477d4acd ✓
```

结论：**没有人删行**，是同一进程里出现了两个 AUDIT 写入者（插件被重新 apply，旧实例的工具
仍在写），两条线各记各的链尾。旧实现只在"跨天"时读一次文件尾、之后信内存里的 `prev`，
于是第二个写入者的链尾永远落后一条。

- `audit.js`：**每次写之前读文件末尾 16KB 取链尾**，`prev` 以文件为准（不信进程记忆）——
  多写入者、跨进程、手工续写都不会再造成"假断链"；防篡改能力不变（改行/删行照样查得出）。
- `index.js`：`apply()` 开头先收回上一个实例（`globalThis.__dshBrowserLiveDispose`，收注册项、
  帧循环、SSE 连接；**不动浏览器进程与登录态**），减少"两份实例同时活着"的机会。
- 历史断点**按"只追加不重写"保留原样**（重写就等于毁证据），并在文件里追加一条
  `type:"note"`、`kind:"chain-break-diagnosis"` 记录写明诊断与修法。
- `npm test` 不再包含"实时链检查"：它检查的是**用户的数据**而不是代码，混在一起会让
  "改了代码跑测试"因为历史数据而失败。新增 `npm run audit:check` 专门跑它。
- 新增回归用例：两个 AUDIT 实例**交替写同一文件**，链必须仍然自洽（这是线上真实场景，
  原来的实现必挂）。

### 7. 修掉"关掉浏览器之后再也打不开"的死锁（v0.12.0 收尾验证时实测踩到）

用户重启后我做收尾验证，`browser_close` → 立刻 `browser_open`，结果**再也起不来了**：
连报两次「10 秒内没响应 CDP 端口（含 `--in-process-gpu`）」，而机器上**多出 10 个 msedge 进程**
占着 `chrome-profile-msedge`、却**没有进程在听调试端口**。

根因是两个 bug 叠在一起：

1. `shutdown()` 只等 150ms 就返回 —— 而 Chromium 的 `Browser.close` 是异步的，profile 锁要
   几百 ms~几秒才释放 ⇒ **紧接着重开**时，新进程发现同一 `user-data-dir` 已有实例，
   就把请求**转交**过去、**不开新的调试端口** ⇒ 插件永远等不到 CDP。
2. 失败路径里 `browser.proc.kill()` 杀的是 **VBS 启动器**（`launchDetached: true` 的默认路径下
   浏览器早已脱离我们的进程树）⇒ 浏览器本身还活着、继续锁着 profile ⇒ **每试一次多一个窗口**，
   越试越糟（自锁死循环）。

修法：

- 新增 `profileOwnerProbeScript()` / `profileOwnerCount()` / `killProfileOwners()` /
  `waitProfileReleased()`：用 PowerShell 列出（或结束）**命令行里带本插件数据目录**的
  chrome/msedge/brave 进程 —— 只匹配本插件 profile，**你自己的浏览器绝不会被碰到**。
- `shutdown(kill)`：`Browser.close` 后**等 profile 真释放**（最多 6s），没释放才强清，并记一条
  `🧹 …已强制结束` 的动作提示（不静默）。
- `launch()`：起进程**之前**先清残留（走到这一步说明连不上任何 CDP，那些进程只会让新实例被转交）；
  启动失败时按 profile 清掉**真正起来的进程**，并记动作提示。
- 离线断言（verify-host）：探针只匹配本插件 profile、覆盖 chrome/msedge、查询版不含
  `Stop-Process`（只有 kill 版才杀）。

> 真踩到时的恢复办法见 README「浏览器起不来怎么办」：一条 PowerShell 清干净，不用重启 DSH。

## 0.11.0 — 搜索改成「机制」而不是「菜单」+ 把"写镜像"这一类 bug 修干净

两件事，都不只是改措辞：

### 1. `browser_search` 不再定死引擎（用户指出的真问题）

原话是："我让你蒸馏的是关键技术，不是定死的技术……指定用百度，那这个就等于定死的选项。"
**这是对的，而且是我做的**：我蒸出来的其实是三个**写死在代码里的引擎名**（bing/baidu/ddg），
而真正可迁移的技术是这套**与引擎无关**的机制 ——

> 打开一个"搜索 URL 模板" → 用 `{item, link, title, text}` 四个选择器抽取 → 跳转链能解就解、
> 解不开就标记 → 空结果按病因分诊 → 失败冷却 → 换下一个。

现在机制与数据分开了：

- `SEARCH_ENGINES` 降级为**预设**（并改名 `SEARCH_PRESETS`，让"机制 vs 预设"在命名上就分清）；
  它只是"开箱即用"的默认值，不再是"可用引擎清单"；
- 新增 `engineSpec` 参数：调用时直接给出 `{url:"…/search?q=%s", item, link, title, text}`，
  **任何搜索页/站内搜索都能接，不用改代码、不用写配置、不用重启**（有端到端测试：用本地
  一个形状与 bing/百度完全不同的"站内搜索页"跑通）；
- 新增 `settings.search = { engines: {...}, order: [...] }`：长期复用与"auto 的顺序"都归你，
  改完下次调用即生效（设置按调用读盘，不等重启）；
- `url` 支持 `%s` / `{q}` 占位符，缺占位符或缺 `item` 时**明确报错并给示例**，不猜；
- 报错与提示不再教人"去改 SEARCH_ENGINES"：现在是"传 engineSpec，或写进 settings.search.engines"。

### 2. "写镜像不生效"这一类 bug 全库修完（4 处，症状各不相同）

根因只有一个：`viewOf()` 是**单向拷贝**（把会话字段拷进 `browser` 单例），所以 `browser.xxx = v`
全是写空气 —— 下一次 `viewOf`（几乎每个工具调用都会经过）就覆盖回来。v0.10.1 只修了 `selected`
的三个调用点，这一版把**根**修掉：`browser.selected / lastPos / meta / tabs / cdp / backend / userClosed`
改成**写透访问器**（读写都落到当前会话），这类错误从此在语法层面不可能再犯。

| 字段 | 原来的症状 | 现在 |
| --- | --- | --- |
| `selected` | `browser_tabs{action:'select'}`、观察窗点标签页、两处 close 清理：**报 ok:true 但页面没换**（连我输出里"用 select 切回原页"这句建议都是坏的） | 切换真的生效（双向，有回归测试） |
| `lastPos` | 拟人鼠标的"笔尖"每次调用被重置 ⇒ 跨调用不连贯、鼠标跳回老位置 | 跨调用连续 |
| `meta` | 量到的视口尺寸每次调用都丢 ⇒ 按旧的 1280×800 算悬停/落点 | 用实际视口 |
| `cdp` | 传输入口同源 | 一致 |

### 3. 空结果分诊：补上第四态 `filtered-out`（并纠正上一版的不实声明）

v0.10.1 的 CHANGELOG 里我写过"抓到 item 但 0 条结果不再被误报成改版"——**当时没实现**。
现在真的实现了，而且分诊顺序也修对了：

- `hits > 0` ⇒ 页面**已经加载**、`item` **已经命中** ⇒ 问题在 `link/title/text`（或链接被
  "引擎内链"守卫挡了）⇒ `filtered-out`，建议指向字段选择器；
- `hits === 0 && 页面有内容` ⇒ `layout-changed`，建议指向 `item`；
- `blocked` / `not-loaded` 各给各的处置。

顺序修的是一个真 bug：原来 `thin`（正文<300字）先判，于是"命中 2 条但字段不匹配"的极简站内
搜索页会被说成"页面还没加载完"——命中了条目本身就证明它加载完了。

### 4. `browser_read` 不再被徽章淹（观感问题，上一版标注未改）

实测读 GitHub README 时，徽章行是 `[![alt](camo.githubusercontent.com/<64位hex>/<编码后原图>)](链接)`，
几百字符纯噪音。现在：图片 URL > 120 字符只留 `![alt]`；无 alt 的图片直接丢并**记账**
（结果里返回 `imagesOmitted` + `imagesNote`，并说明"要图片地址用 browser_eval/browser_scrape"）；
短 URL 的正常配图照旧保留完整 Markdown。外链里的徽章变成 `[![alt]](href)`（链接保留）。

### 测试

`verify-page-fns` 96→117、`verify-web-tools` 28→44，新增的都是这几类回归：自带引擎端到端、
切标签页双向、四态分诊（含极短页优先级）、图片省略与记账、`searchFailHint` 的分诊建议。
全套 9 个既有套件仍全绿。

## 0.10.1 — 联网实测逼出来的两个修复（一个既有 bug，一个"没实测就等于没有"）

v0.10.0 交付时我明确标注了两处**只在静态层面成立**的东西：搜索的引擎选择器没在联网环境跑过、
新工具只经本地夹具验证。这一版就是把它们拉到真网站上跑，结果两处都出事。

### 修复 1：新开标签页后，当前页其实还停在旧页（既有 bug，三处调用点）

现象：`browser_tabs {action:'new'}` 返回 `ok:true`，但紧随的调用仍落在**旧标签页**上；
`browser_search` 因此在旧页（当时是 `about:blank`）上抽取，如实报成"页面还没加载完" ——
一个看起来像"网络慢/被反爬"的现象，实际是选页错了。

根因是三件事叠加：

1. `Target.createTarget` **异步生效**，紧接着那一次 `refreshTabs` 可能还看不到新 target；
2. 而 `refreshTabs` 结尾会把"在列表里找不到的 selected"**重置回 `tabs[0]`**；
3. `browser.selected` 只是活跃会话 `s.selected` 的**镜像**（`viewOf` 里同步），写镜像会被下一次同步覆盖 ——
   所以要写的是 `s.selected`。

`browser_open {newTab:true}` 与 `browser_tabs {action:'new'}` 是同一条老路（v0.9.2 只修了扩展档：
"等着陆"是扩展实现的行为，插件自带实例这条从来没等过）。现在统一走 `openTabAndSelect()`：
建 target → 轮询等它出现在列表（≤3s）→ 写 `s.selected` → 附加 → 再同步镜像。

回归测试（`tools/verify-web-tools.mjs`）：新开页后 `location.href` 必须是新页、标题必须是新页的、
标签页列表里选中的必须是新页；`browser_open {newTab:true}` 同验。

### 修复 2：百度那条链从来就没成功过（且会把人引向错误的排查方向）

百度的实测结果：**8 条结果被全部丢掉**，工具报 `layout-changed`（"引擎改版了，去改选择器"）——
而真实原因跟选择器无关：

- 标题链接是 `http://www.baidu.com/link?url=<加密串>`，页内**解不开**成真实 URL；
- `SEARCH_FN` 里"引擎自家内链不算结果"的守卫写的是 `/\/url$|\/link$/` —— 要求**以 `/link` 结尾**，
  带查询参数就匹配不上，于是把真结果当内链全杀了。它的本意只是滤掉"图片/更多"这类内链。
- 另外，新卡片版的摘要已经不在 `.c-abstract`（实测 0 命中），而在 `[class*=summary]`（哈希后缀类名）。

修法：守卫改成"引擎域名 **且** 不是跳转链形态"才丢（`[\/?](url|link|redirect)=`、`\/ck\/a`、`uddg=`）；
解不开的跳转链**保留**并标 `viaEngineRedirect: true`，工具输出里补 `redirectNote` 说明"要真实地址就
navigate 过去再看 location.href"；百度 spec 的 text 补 `[class*="summary"]`（保留 `.c-abstract` 兼容老版式）。

### 这两件事共同的教训

**夹具必须照抄实测到的 DOM，不能照抄我的推测。** 我第一版百度夹具就是按"通用约定"写的，
于是测试全绿、线上 0 条 —— 绿得毫无意义。现在夹具里的百度结构是从真实 SERP 上量下来的
（含加密跳转链与 `[class*=summary]`），并且 `SEARCH_ENGINES` 改为 **export** 供测试直接引用，
避免"测试里另抄一份选择器表"（抄一份的后果是：表改了测试照样绿）。

同时把"选择器腐烂"这件事变成一条**可自查**的路径：`layout-changed` 的返回里带着命中数、
样例文本与修复指引。

> **更正（v0.11.0 补记）**：这一版我还写过一句"抓到 item 但 0 条结果这种中间态不再被误报成改版"——
> **当时并没有实现**（三态判定里就没有这一态），我把"应该做"写成了"已经做"。v0.11.0 才真正补上：
> 新增 `filtered-out`，并按 `hits` 把"item 选错"与"字段选错"分开。

### 实测记录（2026-09-13，插件自带实例 + 无头 Edge）

| 项目 | 结果 |
| --- | --- |
| `browser_search` Bing | ✅ 5 条结构化结果（`li.b_algo` 一次命中） |
| `browser_search` 百度 | ❌→✅（修复 2；修复前 0 条并误报 layout-changed） |
| `browser_read` 真实文章 | ✅ `source:"article"`、Markdown、17 个标题大纲、链接清单、12k 字符按段续读 |
| `browser_scrape` 真实 SERP | ✅ 8 命中 / 5 返回，标题+链接+摘要字段全对 |
| `browser_snapshot` | ✅ 140 元素带稳定 ref、`refsInfo{known:140,reused:0}`、视口外 `outside`、重名 `ctx` 消歧 |
| 点击被遮挡元素 | ✅ `{ok:false,reason:"covered"}`（不再"报成功但页面没反应"） |
| 点击禁用元素 | ✅ `{ok:false,reason:"disabled"}` |
| 输入后回读 | ✅ `matches:true` + 回显值 |
| 人机验证识别 | ✅ Cloudflare 拦页识别出 `challenge.kind="cloudflare"` 并给出"停下问人"的指引 |

未覆盖：DDG 未实测；`browser_read` 读 GitHub README 时会把徽章图片链接原样保留（内容正确、
观感偏吵）—— 已知观感问题，未改。

## 0.10.0 — 网页理解三件套 + 调用方案技能（从 7 个同类插件蒸馏，零新依赖）

起因：用户要的是"**读得懂、抓得到、搜得了**"，以及"后续所有 agent 都能方便快捷地调用"。
手上那 4 个参考插件的 URL 是编造的（`github.com/deepseek-ai/plugin-*` 六条路径全 404、
`org:deepseek-ai` 零个含 plugin/dsh 的仓库），所以改成在生态索引（3632 个插件）里找**真实等价物**，
克隆 7 个 MIT 仓库读源码，按"在浏览器上下文里成立"的标准蒸馏 —— 不是搬运。

新增三个工具（都靠注入脚本 + 现有 CDP 通道实现，**没有新增任何 npm 依赖**）：

- `browser_read`：正文结构化读取。四级正文降级（多 `article` ≥200 字 / `role=main` / `main` /
  最大文本块）、噪音剥离（raw 元素 + 结构噪音 + **只在容器标签上生效**的类名黑名单 + 链接密度
  `<300 字且链接占比 >65%` 判推荐位）、Markdown 输出（标题层级/列表/表格/代码块/链接，表格 25 行封顶）、
  段落感知截断（offset 续读不会把句子劈开）、元信息（meta/og/**JSON-LD 递归**/`articleBody` 反爬兜底）。
- `browser_scrape`：`item` + `fields`（`"a@href"` 取链接并绝对化、`@html`、`@text`）把重复结构抓成行数据，
  命中不到时自适应重试并回报匹配数 —— 相当于"不用写 JS 的 browser_eval"。
- `browser_search`：在**真实浏览器**里搜（Bing/百度/DDG HTML），结果解析成 `{title,url,snippet}`；
  内置跳转链解包（`uddg=`、`u=`、`bing.com/ck/a?u=`）、引擎内链过滤、URL 归一化去重（剥 utm/fragment/www）、
  三态空结果判定（**被拦 / 没加载完 / 引擎改版**）、引擎级 30s 冷却与 20s 总预算。
  刻意不用 Google（验证码同样中招）、不用 Bing RSS（浏览器里变 XML）、不用 SearXNG json（实例多已关闭）。

观察与动作层补强（都不是新工具，是修既有短板）：

- **ref 改成跨快照稳定**：原来每次快照重置 `window.__BL_REFS`，于是"上次拿的 ref=7"在页面重排后
  **会指向另一个元素** —— agent 会安静地点错东西。现在用「元素 → id」WeakMap + 只增不减的计数器，
  id 永不复用，元素没了就明确报"ref 失效"。已脱离文档的旧条目顺手清掉。
- **快照状态内联 + 交互恢复**：每行带 `flags`（disabled/readonly/checked/pointer-events-none/
  outside/covered-by:X）；React/Vue 的 `onClick` 走事件委托、DOM 上**没有** onclick 属性，
  只按选择器收元素会漏掉一大片真按钮 ⇒ 对"有名字的叶子块"做一次有上限的 `cursor:pointer` 探测。
  重名元素补 `ctx`（三个"编辑"只有上下文能分辨）。顺带修隐私问题：**password 的值不再进快照**。
- **点/输入前做可操作性检查**（`browser_click`/`browser_type`/`browser_move`）：自身与祖先可见性、
  零尺寸、pointer-events、disabled、视口外，以及 `elementFromPoint` 命中检测（遮挡）；
  中心点被盖住在矩形内换 4 个候选点再试。失败返回**确定性原因**而不是静默点空（`force:true` 可跳过）。
  参考实现两家都**没有**命中检测，这是补它们的缺口。
- **输入后回读**：`browser_type` 会读回字段值确认"真的进去了"（受控组件回滚/富文本编辑器 reconcile
  会让"工具报成功、字段其实是空的"），password 只回长度。
- **人机验证识别**内联进 `browser_snapshot` 的 `challenge` 字段：Cloudflare 拦页 → hCaptcha →
  reCAPTCHA → Turnstile → 文本双条件兜底；文本采集穿透**同源 iframe 与 shadow DOM**。
  命中后只做一件事：提示"停下、请人完成、不要反复重试"，并诚实标注这是"基于特征的最佳努力"。

**调用方案做成了 skill**（`skills/browser-automation/SKILL.md`）：19 节的路由表 + 纪律 + 故障处置表 +
4 个现成剧本。关键实现细节：DSH 的技能发现只扫项目/用户/bundled 三类根目录，**不会**自动发现插件包里的
`skills/`，所以 `index.js` 自己调 `skills.register`（与已装插件 dsh-video-prompt 同套路），
并开了 `POST /bl/skills/reload` 让新增技能免重启生效。技能常驻的只有 name+description，
正文按需加载 —— 21 个工具不该配一份常驻长文。

测试：新增 `tools/verify-page-fns.mjs`（**真起无头 Chromium**，CDP 直连，本地 fixture 页面）96 条断言 ——
页面侧函数吃真 DOM（getComputedStyle/elementFromPoint/innerText/shadow），替身测出来的绿是假绿。
它当场抓出三个真缺陷：Markdown 围栏只给 2 个反引号（Markdown 里根本不是代码块，且内容自带 ``` 时会破）、
`<aside>` 的剥离被我自己写的豁免条件绕过、pointer-events 检查把元素自己当成了"祖先"。
`verify-host.mjs` 增加 12 条：技能必须真被注册上去（name/description/正文/provider/invocation/资源目录），
以及重扫路由的 GET/POST 语义。

另修两处**与本功能无关、但本机一直红**的测试环境假设（改动前 HEAD 上同样失败，已用 worktree 复现取信）：
`verify-host` 断言"18 个工具"已随版本更新为 21；三条断言原本假设"本机没有可启动的 Chromium"，
本机装了 Edge 就会误报，改成按能力分两支断言（两支都照常断言、标签写明走了哪支），
并在末尾把真启动的浏览器关掉，免得跑一次测试在机器上留一个窗口/进程。

## 0.9.2 — 修 v0.3.2「新开标签页」的竞态：附加调试器时页面还是 about:blank

起因：用户重载扩展后实测 `browser_open {use:"edge", newTab:true}` 仍报「站点未授权：该页面」。
根因**不是授权配置**，是我自己 v0.3.2 的实现缺陷：host 调 `Target.createTarget` 后**立刻**附加调试器，
而那一刻新标签页的 `url` 还是 `about:blank`（真实地址在 `pendingUrl` 里）⇒ 授权门禁误判、整次调用白跑。

- 扩展 v0.3.3：新增 `effectiveUrl(tab)`（**`pendingUrl` 优先**），判权限 / 判打码 / 判归属全部改用它
  （`attachTab` 三处判定 + `redact`）。
- `Target.createTarget` 建页后**等它真正落到目标地址**再回报（最多 5s；`about:blank` 不等待），
  从源头消除竞态，而不是只在下游打补丁。
- 回归测试（`tools/verify-extension.mjs`）两条：① 构造"新页 url 仍是 about:blank、pendingUrl 才是目标"
  的替身，断言 `createTarget` 后能**立刻** `attachToTarget` 成功（旧代码在这条上必报未授权）；
  ② 反向断言 pendingUrl 指向**未授权**站点时依旧拒绝 —— 别把"看 pendingUrl"变成放水。

## 0.9.1 — 用户浏览器档放开 `Target.createTarget`：agent 可以新开标签页了（弹窗可控）

起因（用户 2026-09-12）："扩展不允许新开标签页，这个还是很有必要"。之前那句"可随意 newTab"
指的是**插件自带实例**那一档；用户日常浏览器那一档一直是硬拒的。

- 扩展 v0.3.2：`Target.createTarget` 从 `DENIED_PREFIX` 移出，改走 `handleCommand` 单独分支：
  只允许开到 `http/https/about`（不许 `file://`/`chrome://`），走 `chrome.tabs.create`，
  返回 CDP 形状的 `{ targetId }`，并把新页记进 `state.ownedTabs` —— 于是"agent 自己开的页可被它关"
  这条既有边界自然延续到新开的页上。
- 新开关 `allowNewTab`（弹窗「允许 agent 新开标签页」，**默认开**）：关掉后 createTarget 立刻回到
  拒绝并提示去哪里打开。`status()` / `hello` / `config` 三条上报都带上它，`/bl/state` 与 DSH 里都能看到。
- **隐私底线没变**：新开 ≠ 能看。未授权站点的 url/title 照旧打码、调试器照旧拒附加，
  所以 agent 新开一个未授权站点对它毫无用处；要读页面仍必须用户逐站点「允许」。
- 插件自带实例那一档不受影响（它本来就能 `newTab`）。顺带确认：该档在 Chrome 被卸载后
  **会自动改用 msedge.exe**（探测顺序 chromePath → 环境变量 → Chrome → Edge → Brave），
  即"免授权 + 可新开页"这个能力不依赖装了 Chrome。
- 文档同步：`extension/README.md` 授权表、`README.md` 隐私表与工具描述里的"用户浏览器档不能新开标签页"
  全部改掉，避免下一台机器上的 agent 继续按旧描述行事。

## 0.9.0 — 留痕：agent 用浏览器做过的每一步都落盘（append-only + 哈希链）

起因（用户 2026-09-12 的原话）：同意我关掉我自己打开的网页之后，他意识到
"这岂不是他偷偷打开浏览器操作一些东西后又自己关闭" —— 于是要留痕。

- 新增 `audit.js`（独立模块，可用 `node tools/verify-audit.mjs` 离线自检）+ `audit/` 目录：
  `$DSH_HOME/dsh-browser-live/audit/YYYY-MM-DD.jsonl`，**只 appendFileSync，没有任何
  read-modify-write 路径**。
- **收口点只有一个**：`index.js` 的工具注册循环里，每个工具都过一遍新函数 `withAudit()`
  —— 记录工具名、参数（>4000 字截断并标注原文长度）、成功/失败与错误、耗时、
  **调用前后的 URL / backend**。逐个工具加埋点必然会漏，新增工具时还会再漏，所以不做。
  `browser_open` / `browser_close` 也走这条路，所以"开 → 操作 → 关"整条链都留得下。
- 补第二条口子：`Page.frameNavigated`（只记主框架）—— **页面自己发起**的跳转不在任何工具参数里，
  只靠工具埋点会看到"点了个按钮"却看不到"最后落在哪一页"。
- 每条记录带 `h`（本条内容 sha256 前 20 位）与 `prev`（上一条的 `h`），连成哈希链：
  `tools/verify-audit-chain.mjs` 一验就知道有没有删行/改行。
- 启动时写一条 `boot` 记录（版本/工具数），于是"某天他到底开过几次、每次干了什么"能按 boot 分段读；
  启动日志里也会打印留痕目录。
- 自检 `tools/verify-audit.mjs` **14 项**：追加写、链自洽、**删一行能查出**、**改一行能查出**、
  同一天重启续写链仍自洽（这一条当初真抓到 bug：`h` 只返回没落盘 ⇒ 续写时 `prev` 接不上）、
  超长参数截断标注、目录不可写时不抛错、空文件/缺文件的处理。
- host 侧回归：`tools/verify-host.mjs` 与本改动前**同为 58 passed / 3 failed**（那 3 项是套件缺真
  Chrome 导致的既有失败，不是回归）。
- **能力边界写在 README 与 audit.js 顶部**：同机同用户下，有完整写权限的人能把整条链重算一遍；
  它挡的是"顺手抹掉一两步"，真不可抹要把 JSONL 实时送到 agent 够不到的地方。
- 「关闭 agent 自己开的标签页」这个权限**本来就不在 agent 手里**（扩展弹窗 `allowCloseOwn`，
  v0.8.5 已有），本次只是把它与该权限的位置写进文档，没有改动它。

## 0.8.5 — 关标签页：只放行 agent **自己开的**页（弹窗可整个关掉）

原来 `Target.closeTarget` 在"永远拒绝"名单里，谁开的都关不了 —— 于是 agent 自己开的标签页
留在你浏览器里收不了尾（实测：我开的两张页只能请你手动关）。现在改成**有条件白名单**：

- 扩展记 `state.ownedTabs`：只有 `chrome.tabs.create` 开出来的页（"未授权前台页 → 新开标签页"那条路径）
  才在这个集合里；**你手动开的页面永远不在范围内**，任何情况下都拒；
- 扩展弹窗新增开关「允许关闭 agent 自己打开的标签页」（**默认开**）——关掉之后连它自己开的也不许关，
  P0 只读语义优先；
- host 侧不再 `.catch(() => {})` 吞错误：被拒时 `browser_tabs {action:"close"}` 明确报错，
  而不是返回 `ok:true` 看着像关成功了（`waitTargetGone` 现在返回布尔值来判定）；
- 测试：verify-extension 断言"不是自己开的页一律拒 + 开关关掉后一律拒"，
  verify-extension-v2 的 D 段断言"自己开的页能关掉、真的从列表消失、`ownedTabs` 跟着清掉"。
- 扩展版本号 0.3.0 → 0.3.1（重载扩展后桥会报 `扩展 v0.3.1`，可用来确认新代码真的生效了）。

## 0.8.4（同日补）— 「新开标签页」的第一版有个顺序漏洞

v0.8.3 把"未授权页 + 已授权目标站"改成新开标签页，但 `attachTab` 里**判断顺序错了**：
"要不要换标签页"被放在 `state.byTab` 缓存**之后**。于是只要那个前台页**已经附着过**
（比如 agent 先 `browser_navigate` 过一次），就会命中缓存直接返回 —— 老的就地导航行为复活，
你正在看的页面照样被改写。本机实测踩到：新标签页没开、前台页被换成了目标站点。

- 扩展：把授权判断提到缓存的**前面**；只有"本来就是已授权且已附着"才走缓存。
- host：`selectedTab` 改为返回 `attachTab` 的返回值（第一版返回了旧的 tab，
  于是 `browser_open` 又把前台那个未授权页导航了一遍 —— 新标签页开了也白开）。
- 回归测试（verify-extension-v2 新增 3 条）：造出"已附着 → 再撤销授权"的前台页，
  断言它仍然**新开标签页**、且那个已附着的页**没有被导航**。
## 0.8.3 — 「不动你正在看的页面」＋「Chrome 起不来不是提权，是安全软件拦了 GPU 沙箱」

**① 用户浏览器档：未授权页 + 已授权目标站 → 改成"新开标签页"**

0.8.1 解决"我允许了 github.com 却被闸死"时用的是**就地导航** —— 把你当前前台那个标签页改成目标站点。
可你只是让 agent 去看一眼别的东西，不该付出"我正在读的页面被换掉"的代价。现在：

- 扩展 `attachTab` 在当前页未授权、目标页已授权时 **`chrome.tabs.create` 新开一个标签页**，
  等它落到已授权 origin 之后才附加 —— **你原来的标签页一个字都不动**；
- 附加的是新标签页，所以 `handleCommand` 把**真实 tabId** 一并报回 host；host 据此纠正映射
  （不纠正的话：列表显示"旧标签页已附加"，而 agent 的截图/点击其实落在新标签页上，排查极难）；
- 隐私底线不变：attach 永远发生在"页面已经是已授权站点"之后；目标站未授权则**既不新开也不导航**。

**② Chrome 起不来的真凶（v0.8.2 的归因是错的，这里更正）**

v0.8.2 把"Chrome 起来又立刻静默退出"归因于 **DSH 以管理员身份运行**。**这个归因是错的**：
本机改用计划任务复测（干净父进程、`/rl LIMITED` 中完整性、完全脱离 DSH 的作业对象）Chrome 照样起不来，
而**加 `--in-process-gpu` 就正常**。真正的拦路者是安全软件：

> 火绒 `D:\Huorong\Sysdiag\bin\HipsDaemon.exe` 拦掉了 Chrome **GPU 进程**的沙箱初始化。
> Edge 因微软签名被放行，所以只有 Chrome 中招；`--no-sandbox` 也能绕开，但那等于把沙箱整个关掉。

于是启动链改成"**先常规试，失败补一轮兼容参数，成功就记住**"：

- 每个候选浏览器先按"记住的成功参数 / 无参数"跑一次；失败后用 `COMPAT_FLAGS = ['--in-process-gpu']` 再试一次；
- 成功则把 `{exe → flags}` 记进 `state.json` 的 `compat`，下次直接用（不必每轮先白等 10 秒）；
- **刻意不用 `--no-sandbox`**：渲染器沙箱必须留着，`--in-process-gpu` 只把 GPU 挪进浏览器进程 ——
  `verify-launcher` 里有一条断言专门钉死这条底线；
- 全部候选都失败时的错误信息据此改写（不再提"管理员运行"）。

## 0.8.2 — 「Chrome 起不来 = 整个插件不可用」＋「中文用户名下浏览器根本拉不起来」

两个只在**真实机器**上才暴露的坑，都在启动链上。

**① VBS 独立启动器的编码（静默失效，最坑）**：启动器脚本原来用 UTF-8 写出，而 wscript 默认按
本机 ANSI 代码页读 `.vbs`。于是用户名/路径里只要有中文，脚本里的
`C:\Users\陈道云\…\chrome.exe` 就被读成 `C:\Users\闄堥亾浜慭\…\chrome.exe` —— 一条不存在的路径，
浏览器**一个进程都不会起**，而对外只表现为「未响应 CDP 端口」，极难定位。
实测证据：本机 `C:\Users` 下真的留下了 `闄堥亾浜慭AppData` 这样的乱码目录（历史启动的产物）。
现在写成 **UTF-16LE + BOM**，wscript 按 Unicode 读，中文路径原样保留。

**② 首选浏览器起不来时不再全盘失败**：原来 `findChrome()` 只挑"第一个存在的"，它起不来就直接抛错。
实测场景：**DSH Desktop 以管理员身份（高完整性级别）运行时，Chrome 因无法在提权父进程下初始化
沙箱而静默退出**（加 `--no-sandbox` 就正常，但我们不会默认关沙箱），而 Edge 的沙箱不受影响、
一切正常。于是这台机器上"装了个 Chrome"反而让插件彻底不可用。现在：

- `findChromiumExes()` 返回**候选列表**（`chromePath` → 环境变量 → Chrome → Edge → Brave），
  逐个尝试、每个等 10 秒；首个起来的就是它，并在观察窗留一条「⚠ X 起不来，已自动改用 Y」；
- 端口不再纯随机：在 9600~9899 里挑一个**本机没有别的 CDP 在听**的 —— 否则 `probePort` 会返回
  **别的浏览器**的 WebSocket，插件就附加到错误的那台上了（实测撞到过 Edge 的调试实例）；
- 每个浏览器用**各自的** profile 目录（`chrome-profile-chrome` / `-msedge` / …），
  避免 Chrome 与 Edge 共用一个目录互相改数据；
- 候选全失败时，错误信息直接点明"Chrome 起来又立刻退出"最常见的原因是 DSH 以管理员运行，
  并给两条解法：以普通权限启动 DSH，或在设置里把 `chromePath` 指向 Edge 等其它 Chromium。

**回归测试**：新增 `tools/verify-launcher.mjs`（10 条断言）—— VBS 必须以 `FF FE` 开头、
中文 exe 路径与 `--user-data-dir`（含空格）原样保留、脚本里没有替换字符、仍可执行的
`sh.Run …, 1, False`；候选列表存在、去重、稳定、环境变量优先。

## 0.8.1 — 「我允许了目标站点，你却还在报未授权」

**问题**：用户浏览器档的判权发生在 `Target.attachToTarget`，而扩展用的是**标签页当前 URL**。
于是最常见的那种用法必然撞墙：你在扩展弹窗里允许了 github.com，但 Edge 的前台标签页开着别的
（未授权）站点 → agent 连"切到你的浏览器"这一步都过不去，目标站授权了等于白允许。

**改法**：把"这次想去哪个站点"从工具一路带到扩展，扩展在**当前页未授权、目标页已授权**时
**先导航过去、再附加调试器**：

- `browser_open {use:"edge", url}` 与 `browser_navigate {url}` 把目标 URL 传进
  `Target.attachToTarget` 的 `intendedUrl` 参数（**只在用户浏览器档加**，插件自带实例不受影响）；
- 扩展 `attachTab(tabId, intendedUrl)`：未授权页 + 目标站已授权 → `chrome.tabs.update` 导航 →
  轮询到落在已授权 origin（最多 5s）→ 才 `chrome.debugger.attach`；若导航后仍未落在已授权站点，
  报错并放弃附加；目标站也没授权 → 仍报原来的「站点未授权」。

**隐私底线没有放宽**：attach 永远发生在导航**之后**，agent 拿不到未授权页面的调试器，
P0 逐站点授权的语义一字未改。

**边界（没变）**：`browser_tabs {action:"select"}` 切到一个未授权的标签页仍会被拒
（那条路径没有"目标站点"可依据）；要让它可用，先在扩展弹窗里「允许此站点」。
## 0.8.0 — 装扩展从"看文档"变成"一条命令摆好现场"

**问题**：接管用户日常浏览器要三件事同时成立 —— 桥开着、扩展装着、token 粘对了。
v0.7.0 只把它们写成文字说明，而且：

- `browser_open {use:"edge"}` 在**桥没开**时也报"扩展还没连接"，把人引去装一个装了也连不上的扩展；
- 报错只说"选插件目录下的 extension"，不给绝对路径、不说 token 从哪来；
- 面板在桥没开时显示空 token，安装步骤照旧摆着 —— 等于骗人。

**改法**：

- 新增工具 **`browser_ext_setup`**：打开桥（`userBridge=true`，即时生效）→ 取 token 放进剪贴板 →
  在目标浏览器里打开它的扩展页 → 在资源管理器里打开本包 `extension/` 目录，并把操作步骤原样列出。
  用户只剩几下点击：开发者模式 → 加载解压缩的扩展 → 选目录 → 粘 token → 连接。
  参数：`kind`（`'edge'` / `'chrome'`，默认 `settings.userDefault`）、`open:false`（只返回路径与 token，不动 UI）。
- `browser_open {use:"edge"}` 的失败信息**分清两种情况**：桥没开（指向 `browser_ext_setup`）/
  扩展没装（给出扩展页地址 + `extension/` 绝对路径 + `bridge.json` 位置）。
- 面板：桥没开时多一个 **「① 启用用户浏览器桥」** 按钮（一键 `PUT {userBridge:true}` 并刷新状态），
  并注明"扩展装了也连不上"；安装步骤加序号，补上"也可以直接交给 agent：调 `browser_ext_setup`"。
- `/bl/bridge` 的 hint 带上 `extension/` 绝对路径；`browser_open` 在"一台都没接入"时提示该调谁。
- `extension/README.md` 补一条"让 agent 一条命令摆好现场"；版本 0.7.0 → 0.8.0。

**兼容性**：`browser_ext_setup` 只做"打开 / 复制 / 列出"这类无害动作，不改授权策略、不碰已接入的浏览器；
桥的开关语义不变（仍是 `settings.userBridge`，面板与 `PUT /bl/settings.json` 都能改）。

**已知边界**：Chrome/Edge 的「加载已解压缩的扩展程序」是**原生文件选择框，无法自动化** ——
所以这一步永远需要人点一下。本版本的目标是把"点哪儿、选哪个目录、粘什么"全部摆到眼前，而不是绕过它。
