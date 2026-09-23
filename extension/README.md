# DSH Browser Bridge（MV3 扩展 · Chrome / Edge 各装一份）

让 DSH 的 `browser_*` 工具驱动**你日常那个浏览器里的标签页**（带你的登录态 / 代理 / 已装扩展），
而不是插件自己拉起的隔离实例。

> **v0.3.0（多浏览器）**：Chrome 与 Edge **可以各装一份、同时接入**，每条调用用 `use` 指定用哪台
> （`browser_open {use:"edge"}`）。扩展装载时按 UA 嗅探自己的身份并在握手里上报，
> 跨 WS 边界的 `sessionId` 一律带 `<浏览器>:` 前缀，桥靠前缀路由 —— 两台浏览器不会串台。
> 协议见 [`../docs/MULTI-BROWSER.md`](../docs/MULTI-BROWSER.md)。

> **两层能力**
> - **只读（默认）**：看（snapshot / text / screenshot / tabs）+ 导航。
> - **允许操作（P1，默认关）**：在弹窗里勾上后，agent 才能**真点击 / 打字 / 按键 / 滚轮 / 上传**
>   （`Input.*` + `DOM.setFileInputFiles`，经 `chrome.debugger` 注入，`isTrusted: true`，与真人同层）。
>
> 两层的前提都是**逐站点授权**：没点过「允许」的站点，agent 连它的 url/标题都看不到。

## 怎么装（一次性 · Chrome 和 Edge 各做一遍）

> **省事路径**：让 agent 调 **`browser_ext_setup`** —— 它会开桥、取 token 放进剪贴板、
> 在目标浏览器里打开扩展页、并在资源管理器里打开本目录。下面 1~2 步它就替你做了，
> 你只需做 3~6 步。只想手动来就按下面走。

1. DSH 设置 → **浏览器观察窗** → 「用户浏览器」点一下变成 **桥已开启**
   （等价于 `settings.json` 里 `userBridge: true`，或 `PUT /bl/settings.json {"userBridge":true}`）。
   面板上会显示 **端口** 和 **token**，点「复制」（两台浏览器**用同一个 token**）。
   桥没开时面板会先给一个 **「① 启用用户浏览器桥」** 按钮，点它即可 —— 没开桥的话，扩展装了也连不上。
2. 打开扩展页：Chrome 用 `chrome://extensions`，Edge 用 **`edge://extensions`** → 打开 **开发者模式**
   （Edge 上叫「开发人员模式」）。
3. 点 **加载已解压的扩展程序**（Edge：「加载解压缩的扩展」）→ 选本目录（`<插件目录>/extension`）。
4. 点浏览器工具栏里的扩展图标 → 把 **token** 粘进去 → 点 **连接**。
   （找不到图标：扩展页 → 本扩展 **详细信息** → **扩展程序选项**；或工具栏拼图图标里找。）
5. 弹窗里对你要交给 agent 的站点点 **允许**；整批页面直接点 **「允许当前所有标签页」**
   （把当前所有 http(s) 标签页的 origin 去重后一次授权，**不会**打开高风险的「允许所有网站」）。
   点错了可用 **「撤销全部授权」**（有二次确认）。
6. 需要 agent 动手（点击/输入）时，再勾上 **「允许操作」**；用完取消勾选即回到只读。

**每台浏览器各自一套授权**：在 Edge 里允许的站点，Chrome 那边不算数，反之亦然
（这是有意的：你可以在 Edge 上只放开公司后台，在 Chrome 上只放开广告平台）。

连上后：DSH 观察窗亮红标，并**写出是哪台** —— 只读时「🔴 正在读取你的 Edge」，
打开「允许操作」后「🔴 正在操作你的 Edge（可点击/打字）」。
浏览器顶部会出现「DSH Browser Bridge 已开始调试此浏览器」的横幅 —— **这是浏览器自己的硬性提示，
无法隐藏**，它是好事：提醒你 agent 正在看/操作这个标签页（Edge 上同样会出现）。

## 授权模型

| 层面 | 规则 |
| --- | --- |
| 浏览器 | 每个 kind（chrome/edge/brave/opera）占**一个连接槽**；同 kind 再连会顶掉旧连接（旧连接以 4002 关闭） |
| 站点 | 按 `origin` 白名单，**每台浏览器各自一份**。未授权的标签页，**url 和标题对 agent 一律打码**（`(未授权站点)`），也拒绝附加调试器 |
| 标签页 | 只有被你允许的站点才会被 `chrome.debugger.attach`；被接管的标签页在工具栏显示红点角标 |
| 操作 | 「允许操作」默认**关**。关着时 `Input.*` / `DOM.setFileInputFiles` 一律拒绝，并提示去哪里打开 |
| 只读方法 | `Target.getTargets/attachToTarget/detachFromTarget`、`Page.enable/getLayoutMetrics/captureScreenshot/getNavigationHistory/navigate/reload/navigateToHistoryEntry`、`Runtime.enable`、`DOM.enable/getDocument/querySelector`、`Browser.getVersion`。**`Runtime.evaluate` 已移出**（v0.3.4）：页面脚本走 `BL.evaluate` + 登记表哈希校验 |
| 下载记录 | `BL.downloads`（非 CDP，v0.3.4）：`browser_downloads` 在用户浏览器档走它 → `chrome.downloads.search`。**需「允许操作」开着**；只回文件名/大小/状态/来源 URL，本地路径不外泄 |
| 新开标签页 | 弹窗开关「允许 agent 新开标签页」，**默认开**（v0.3.2 起）。只允许开到 `http/https/about`；新开的页记进 `ownedTabs`，即"agent 自己开的页"，只有这些页允许被它关。**新开 ≠ 能看**：未授权站点照旧打码、照旧拒附加调试器 |
| 永远拒绝 | `Target.activateTarget`、`Page.close/bringToFront`、`Network.*`、`Emulation.*`、`DOM.setAttributeValue`（`Target.createTarget` 见上一行，`Target.closeTarget` 只放行 agent 自己开的页） |
| 高危开关 | 「允许所有网站」= 放弃逐站点确认，等于把该浏览器全部登录态交给 agent，默认关 |

**已知缺口（v0.3.4 已收窄）**：裸 `Runtime.evaluate` 已从白名单移除 —— host 注入页面的脚本一律走
`BL.evaluate`，扩展只执行**登记表哈希命中**的表达式（默认自动登记 host 固定脚本；弹窗「脚本登记表」
可改为逐条人工批准）。agent 现编的 JS 进不了你的浏览器。剩下的护栏仍是
「逐站点授权 + 允许操作开关 + Chrome 调试横幅 + 你看得见」。

## 运行时约束（实测，v0.6.0）

| 约束 | 现象 | 本扩展的处理 |
| --- | --- | --- |
| 后台标签页 | `document.hidden=true` 时 Chrome **静默丢弃** `Input.*`（工具却回 ok） | 发输入前 `chrome.tabs.update({active:true})` |
| 窗口失焦 | 鼠标事件被丢（键盘偶尔能过） | 发输入前 `chrome.windows.update({focused:true})`，等焦点到手 + 300ms 再发 |
| Windows 前台锁定 | 后台进程抢焦点可能被系统拒绝（任务栏闪烁） | 无法绕过；此时需要你手动点一下 Chrome 窗口 |
| `disabled` 控件 | Chrome 不给 disabled 表单控件派发 mousedown/click（`mousemove` 仍会到） | 不管；这是页面状态，点击"没反应"属正常 |
| 页面重排 | 测量坐标后元素被重排 → 点击落空 | 用 `instant:true` 压缩"测量→下发"间隔 |

只读命令（截图 / 取文本 / 快照）不会触发置前，不会抢你的前台标签。

## 协议（扩展 ↔ host · protocol 2）

```
扩展 ──WS──> ws://127.0.0.1:<port>/bl/bridge        （端口/token 在 $DSH_HOME/dsh-browser-live/bridge.json）

→ {type:'hello', protocol:2, token, version, browser:'edge'|'chrome'|…, origins, allowAll, allowInput}
← {type:'welcome', version, readOnly:true}
→ {type:'config', origins, allowAll, allowInput}     授权/开关变化实时同步（/bl/state 可见）
→ {type:'cdp', id, method, params, sessionId?}       host 下发（sessionId 带 `<kind>:` 前缀）
← {type:'cdp', id, sessionId?, result|error}         扩展回包（带前缀；attach 的回包用 result.sessionId）
← {type:'event', sessionId, method, params}          chrome.debugger.onEvent 转发（带前缀）
← {type:'detach', sessionId, reason}                 标签页被关/调试器被移除（带前缀）
→ {type:'ping'} ← {type:'pong'}                       双向保活（MV3 SW 30s 空闲会被回收）
```

**sessionId 命名空间**（v2 的核心）：host 侧看到的是 `<kind>:<扩展内 sessionId>`（例 `edge:bl-12-1`）；
扩展内部（`state.sessions` / `state.byTab` / `chrome.debugger`）一律用**裸 id**，
前缀只在跨 WS 边界时加（出口）与剥（入口）。这样桥能同时挂多条连接而不串台。

安全：只绑 `127.0.0.1`；握手必须带 token；升级请求只接受无 Origin 或 `chrome-extension://`
（网页里的 `ws://127.0.0.1` 连不进来）。

## 调试

- 扩展后台日志：Chrome 在 `chrome://extensions`、Edge 在 `edge://extensions` → 本扩展 →
  **Service worker**（Edge：「服务工作线程」）→ 控制台。
- host 侧状态：`GET http://<DSH_WEB_URL>/bl/bridge`（端口、token、连接状态、**已接入的浏览器列表**、
  各台已授权站点、允许操作开关）；`/bl/state` 多一个 `browsers[]` 与当前活跃的 `use`。
- 离线自测（不需要真浏览器）：`node tools/verify-extension.mjs`、`node tools/verify-extension-v2.mjs`、
  `node tools/verify-bridge-v2.mjs`、`node tools/verify-browsers.mjs`（两个 Worker 扮演两台浏览器）。
  逐套件条数以 `npm test` 输出为准（不写死在这里 —— 写死必然陈旧）。
- 改了扩展文件后必须回扩展页点一次 **⟳ Reload**（Edge：「重新加载」），浏览器不会自动重载未打包扩展；
  **每台浏览器各点一次**。
- 扩展文件清单：`background.js`（SW）+ `sid.js`（纯函数，三边共用）+ `popup.html/js` + `manifest.json`。
