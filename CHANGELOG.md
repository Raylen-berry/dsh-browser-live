# 变更记录

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
