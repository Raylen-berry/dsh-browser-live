## 版本与变更记录

- **v0.14.0**：**收起成一条 = 暂停画面流**（用户 2026-09-14 的省资源项）。
  原先 `setMin()` 只切 CSS 类，画面流照旧在跑（仍在拉 JPEG 帧、仍在设 `img.src`，解码也照做），
  只有整块面板被 ✕ 收走才关流。现在加 `applyStreamState()`：`want = S.open && !S.min`，
  收起就断流、展开立即恢复；因为宿主 `/bl/stream` 是"无查看者零开销"，断开即真的停掉截图
  （改在 client 侧即可，不动 host、不用重启）。健康判定新增 `paused`：收起态是**灰实心灯** +
  「已暂停（收起中）」，不会被误报成黄灯"正在重连"。实测：收起 4.5 秒后帧字节一字未变，
  展开后帧字节变化、灯回绿。回归 `verify-panel-health` 21 ⇒ **30 项**。
- **v0.13.0**：**画面健康 —— 绿灯只代表"画面在更新"，断流亮黄灯**（用户 2026-09-14 反馈）。
  原先收到画面就亮绿灯，而断流时**状态不更新**：`es.onerror` 是纯注释、`pollState` 的校灯只在
  `if (!S.es)` 分支里跑 ⇒ 流对象还在时那个绿点永远不会被纠正，用户会把最后一帧当成实时画面。
  现在把"浏览器在运行"（宿主 `/bl/state.alive`）与"画面在更新"（SSE 最近一帧时刻，阈值 3.5s）
  分成两个事实：判定是纯函数 `computeHealth()`，绿灯**只由帧处理器点亮**，
  黄灯时顶部写「正在重连」（从没收到过帧则写「还没收到画面」）、画面中上盖
  「⏸ 画面已停 · 最后更新于 X 秒前」角标、收起态标题行也带「· ⏸ 画面已停 Ns」。
  回归：新增 `tools/verify-panel-health.mjs`（**21 项**：纯函数八种组合 + 两种文案 + 9 条接线断言，
  含"没有退回 `classList.toggle('on', !!st.alive)` 旧口径"），离线套件 12 ⇒ **13 套**。
- **v0.12.0**：**把"尺度"从写死的像素改成百分比，并清掉剩下的写死项** ——
  ①**观察窗面板**：宽/高/宽屏宽改成视口百分比（`panelWidthPct` 等，设置页可调、即时生效）。
  旧写法 `clamp(300px→560px)` 看着像百分比，但**上限 560px 是硬上限** —— 窗口再宽也不变大，
  宽屏上反而相对变小，用起来就是"固定尺寸"；高度更是完全由截图宽高比决定，窄而高的窗口会顶穿视口。
  现在舞台 `flex:1 + min-height:0`、图片 `contain`（**照搬独立页 `/bl/view` 已验证的写法**，两处一致），
  实测 1418×775 视口下面板 597×405 = **42.1%×52.2%**（597px 已超过旧的 560px 上限）。
  ②**浏览器窗口尺寸**支持百分比（`windowSize:"80%,85%"` = 屏幕工作区比例）：启动后按页面里的
  `screen.avail*` 换算并用 `Browser.setWindowBounds` 调整（量不到屏幕就不动，不猜）——
  换显示器/换机器不用改设置。③**其余写死项**：搜索冷却与总预算、面板百分比都进了设置；
  设置导出/导入改为**直接复用插件本体的 DEFAULT_SETTINGS**（原来是手抄一份 + 注释约束，迟早漂移）。
  ④顺手修一个真 bug：`sanitizeSettings` 从默认值出发，导致 PUT 里的**非法值会把该字段静默重置成默认**
  （例如 PUT `windowSize:"八百块"` 会冲掉用户设好的 80%）—— 现在 PUT 以**当前设置**为底，非法值只是被忽略。
  README 新增「配置：哪些可配/是百分比，哪些刻意固定」一节，把"该配的都配上、写死的给出理由"写清楚。
- **v0.11.0**：**把搜索从"菜单"改回"机制"，并把"写镜像"这一类 bug 修到根上** ——
  ①`browser_search` 不再定死引擎：`SEARCH_ENGINES` 降级为**预设**，新增 `engineSpec`（调用时自带
  `{url:'…%s', item, link, title, text}`，任何搜索页/站内搜索都能接，**免改代码、免配置、免重启**，
  有端到端测试）与 `settings.search={engines,order}` 长期配置；报错也改成教你怎么自带引擎。
  ②`viewOf()` 是单向拷贝，导致所有 `browser.xxx = v` 都是写空气 —— 全库排查出的受害面包括
  `browser_tabs{action:'select'}` 与观察窗点标签页（**报 ok 但页面没换**）、拟人鼠标"笔尖"与视口尺寸
  每次调用被重置；现在这些字段是**写透访问器**，该类错误语法上不可能再犯。
  ③空结果分诊补上第四态 `filtered-out`（命中 item 但字段选择器不匹配），并修掉"页面偏短就先判
  没加载完"的优先级 bug（命中了条目本身就证明加载完了）；这同时**更正**了 v0.10.1 里一句我写了却
  没实现的声明。
  ④`browser_read` 不再被徽章淹没：图片 URL >120 字符只留 alt 并记账（`imagesOmitted`）。
- **v0.10.1**：**把 v0.10.0 拉到真网站上跑，两个修复** ——
  ①「**新开标签页后当前页还在旧页**」这个既有 bug（`browser_open {newTab}`／`browser_tabs new` 都中招；
  `browser_search` 因此在旧页上抽取并误报"页面还没加载完"）：`Target.createTarget` 异步生效 +
  `refreshTabs` 会把"列表里找不到的 selected"重置回 `tabs[0]` + `browser.selected` 只是会话字段的镜像，
  三件事叠加；统一改成 `openTabAndSelect()`（等它真的出现在列表里再切），并有回归测试钉住。
  ②「**百度那条链从来就没成功过**」：标题链接是 `baidu.com/link?url=<加密串>`，被"自家内链不算结果"
  的守卫（要求以 `/link` **结尾**）全部误杀 —— 8 条结果 0 条返回，还报成"引擎改版"；
  现在跳转链保留并标 `viaEngineRedirect`，摘要选择器按实测补上 `[class*=summary]`。
  两条教训：**夹具要照抄实测到的 DOM，不能照抄我的推测**（第一版百度夹具是猜的，于是测试全绿、
  线上 0 条）；选择器表 `SEARCH_ENGINES` 改为 export 供测试直接引用，防止"测试里另抄一份"。
- **v0.10.0**：**「读得懂、抓得到、搜得了」+ 把调用方案做成技能** —— 从 7 个同类 MIT 插件（生态索引里
  找的真实等价物；用户给的那 4 个 URL 六条路径全 404）蒸馏出 `browser_read`（正文四级降级 + 噪音剥离 +
  Markdown + **段落感知截断**）、`browser_scrape`（`item`+`fields` 结构化抓取）、`browser_search`
  （真实浏览器里搜 Bing/百度/DDG，跳转链解包 + 三态空结果判定 + 引擎冷却），**零新增依赖**；
  同时修三处观察/动作层短板：**ref 跨快照稳定**（原来每次快照重排编号，"上次的 ref=7" 在页面重排后
  会点到**另一个元素**）、快照内联状态并做**交互恢复**（React 的 onClick 是事件委托，DOM 上没有 onclick
  属性，只按选择器收元素会漏掉一大片真按钮）、点/输入前做**可操作性检查**（含 `elementFromPoint`
  遮挡检测 —— 参考实现两家都没有）与输入后**回读校验**；`browser_snapshot` 里内联人机验证识别
  （Cloudflare/hCaptcha/reCAPTCHA/Turnstile/文本兜底），命中就停下问人。
  调用方案落成 `skills/browser-automation/SKILL.md`（DSH 不会自动发现插件包里的 skills/，
  由 `index.js` 调 `skills.register` 注册 + 免重启重扫路由）。新增 96 条真浏览器断言；
  另修两处与本功能无关、但本机一直红的测试环境假设（改动前 HEAD 同样失败，已用 worktree 取信）。
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
    描述里也写明：`auto`/`plugin` 免授权、可 `newTab`；`user` 档逐站点授权、默认只读，
    新开标签页自扩展 v0.3.2 起也支持（弹窗可控，仅 http/https）。
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

