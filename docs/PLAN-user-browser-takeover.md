# 方案：接管用户自己的浏览器（扩展路线）

> **状态（2026-09-11 更新）：P0 + P1（输入接管）+ P2 的一部分已落地；v0.7.0 起 Chrome / Edge 可同时接入。**
>
> - **v0.6.0 / 扩展 v0.2.0**：P0（只读）+ P1（输入接管：点击/打字/按键/滚轮/上传，弹窗「允许操作」默认关）。
> - **v0.7.0 / 扩展 v0.3.0**：**多浏览器**——桥支持同挂 N 条扩展连接、按 `<kind>:` 前缀路由；
>   host 每浏览器一份会话；所有 `browser_*` 工具新增 `use`（`plugin`/`chrome`/`edge`/`user`/`auto`）；
>   弹窗新增身份显示 +「允许当前所有标签页」+「撤销全部授权」。
>   协议与实现实况见 [`MULTI-BROWSER.md`](./MULTI-BROWSER.md)（本文件保留原始设计与"为什么这么做"）。
> - **仍未做**：下载接管（`chrome.downloads`，用户浏览器档的 `browser_downloads` 仍只列插件目录）、
>   `evaluate` 收窄（换成固定脚本下发）、与 `dsh-approval-gate` 的联动。
> - 离线验证：`tools/verify-bridge.mjs` + `verify-bridge-v2.mjs` + `verify-extension.mjs` +
>   `verify-extension-v2.mjs` + `verify-browsers.mjs`（两个 Worker 扮演两台浏览器）；
>   `verify-host.mjs` 另跑（会真起浏览器，不在 `npm test` 门禁里）。逐套件条数以 `npm test` 输出为准。
> - 设置页开关已存在（设置 → 浏览器观察窗 → 用户浏览器），不再是"放一个不工作的开关"。

## 0. 为什么要这条路线

现状：`browser_*` 工具驱动的是插件自己拉起的 Chrome 实例（`--user-data-dir=$DSH_HOME/dsh-browser-live/chrome-profile`，
CDP `--remote-debugging-port`）。它的好处是隔离、稳定、可持久登录态；痛点正如用户反馈：

- 用户日常浏览器里的**代理 / IP / 内网 hosts / 已装扩展 / 已登录账号**都带不过来；
- 观察窗里看到的“不是我的那个浏览器”。

已排除的替代方案：

| 方案 | 结论 |
| --- | --- |
| 让用户浏览器带 `--remote-debugging-port` 重启后 CDP attach | Chrome 136+ 出于安全**禁止在默认 profile 上开远程调试**（要求自定义 user-data-dir），且需要用户改快捷方式重启，做不到“静默接管”。留作兜底：设置项 `attachPort`（有则接管该端口，无则自拉）。 |
| OS 级 SendInput + 屏幕捕获 | 拿不到 DOM，snapshot/click(ref) 全退化，焦点/DPI/遮挡脆弱，工程量最大。只适合特殊兜底。 |
| **MV3 扩展 + 本地 WebSocket 桥**（本方案） | 能用用户真实 profile/代理/登录态；`chrome.debugger` 直接就是 CDP，能复用现有 Input/Page 语义。 |

## 1. 目标与非目标

**目标**
1. agent 的 17 个 `browser_*` 工具**语义不变**，只是执行后端可选：插件自拉 Chrome（默认）/ 用户浏览器里的扩展。
2. 观察窗（内嵌面板 + `/bl/view`）在两种后端下都能直播与接管输入。
3. 用户在扩展弹窗里一键“允许/断开”，断开后 agent 立刻退回插件实例。

**非目标**
- 不做静默接管、不做隐身绕过、不承诺跨设备。
- 不改宿主（DSH Desktop 本体）。

## 2. 架构

```
DSH host (dsh-browser-live/index.js)
  ├─ 现有 CDP client（自拉 Chrome）           ← driveTarget=plugin（现状）
  └─ BridgeServer  ws://127.0.0.1:<port>      ← driveTarget=user-extension
        ▲
        │  WS(JSON: {id, method, params} / {id, result|error} / {event})
        │
Chrome 扩展 (MV3, service worker)
  chrome.debugger.attach({tabId}) → send('Page.startScreencast'|'Input.dispatch*'|'Runtime.evaluate'…)
  chrome.tabs.* / chrome.downloads.*
```

要点：扩展用 `chrome.debugger` 当“反向 CDP 客户端”，把 CDP 消息原样转发给 DSH host。
这样 host 侧 `browser.cdp.send(method, params, sessionId)` 的调用面**几乎不用改**——
只需把 transport 从 `WebSocket→Chrome` 换成 `WebSocket→扩展→Chrome`。

## 3. 需要动的代码（估 1.5–2 天）

| # | 改动 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1 | transport 抽象 | `index.js`（`attachCdp`/`browser.cdp`） | 抽 `send(method, params, sessionId) → Promise`，两种实现：现有 `ws` 直连、以及 bridge 转发（带 `tabId→sessionId` 映射） |
| 2 | WS 桥 + 鉴权 | `index.js` 新增 | 监听 `127.0.0.1` 随机端口，端口写入 `$DSH_HOME/dsh-browser-live/bridge.json`；握手用一次性 token（DSH 侧生成，用户在扩展里粘贴/或从 `/bl/bridge-token` 同源取，带 cookie） |
| 3 | 标签页模型 | `refreshTabs()/attachTab()/waitTargetGone()` | 现在依赖 CDP `Target.getTargets`；扩展模式下改用 `chrome.tabs.query` 结果（tabId 当 targetId，`sessionId` 用 debugger attach 句柄） |
| 4 | 截屏/帧流 | `ensureTicker()` | `Page.startScreencast` 经扩展回传帧；无头时不可用→扩展模式下要求真实窗口存在 |
| 5 | 下载捕获 | 现有 `Browser.setDownloadBehavior` | 扩展模式改 `chrome.downloads.onChanged` 事件 |
| 6 | 扩展本体 | 新目录 `extension/` | manifest v3（`debugger`, `tabs`, `downloads`, `scripting`, `storage`）+ service worker + 弹窗（连接状态/允许/断开/当前标签） |
| 7 | 设置页开关 | `client.js` 设置分区 | `观察目标: 插件实例 / 我的浏览器(扩展)`；扩展未连接时置灰 + 安装指引 |
| 8 | 工具描述/README | `index.js` 注释、`README.md` | 说明两种后端差异与限制 |

## 4. 安全与体验风险（必须正面处理）

1. **权限面巨大**：接管真实 profile = agent 能看到网银/邮箱/公司系统会话。必须：
   - 扩展侧显式“允许本标签/允许全部”，并每次 DSH 会话首次接管都弹确认；
   - DSH 侧把“接管用户浏览器”视作**高危能力**：与 dsh-approval-gate 的 `credential/remote` 硬类别联动，默认转人工确认；
   - 观察窗里常驻红标：“正在操作你的日常浏览器”。
2. **焦点争抢**：人和 agent 同时操作同一个窗口会互相踩。缓解：接管期间扩展把目标标签置前 + agent 每次动作前 `Input.dispatchMouseEvent` 打时间戳，检测到人 3s 内动过 ⇒ agent 暂停并提示。
3. **chrome.debugger 横幅**：Chrome 会显示“正在调试此浏览器”提示条，无法隐藏（这是好事，别绕）。
4. **MV3 service worker 休眠**：WS 断开要自动重连 + 心跳；扩展用 `chrome.alarms` 保活（有限）。
5. **端口/防火墙**：只绑 `127.0.0.1`；握手必须带 token，否则本机任意进程可驱动用户浏览器。

## 5. 分期

- **P0（0.5 天）**：只做“用户浏览器里的页面**可读**（截图+文本+snapshot）”，不接管输入 —— 先验证桥与权限体验。**✅ 已落地（v0.5.0）**
- **P1（1 天）**：接入 Input 接管 + 标签页选择 + 下载事件。**✅ 输入接管 + 标签页选择已落地（v0.6.0）；下载事件未做**
- **P2（0.5 天）**：设置页开关、approval-gate 联动、README、失败回退（扩展掉线自动切回插件实例）。**设置页开关/README/失败回退已提前做；approval-gate 联动未做**

验收：在用户日常 Chrome（含代理/登录态）里，agent 完成“登录态抓取 + 表单填写 + 下载”各一例，
观察窗（内嵌与 `/bl/view`）均可直播与接管；断开扩展后所有 `browser_*` 自动回到插件实例且行为与现在一致。

## 6. 落地实况（v0.5.0 / v0.6.0）

与原设计的差异，都是实现时改的，记在这里免得下次踩同一坑：

| 原设计 | 实况 | 为什么 |
| --- | --- | --- |
| `driveTarget: plugin \| user-extension` 设置项 | `settings.userBridge: boolean` + `bridgePort` | 同一件事，布尔更小；后端由"扩展是否连上"自动决定，用户不需要选 |
| 端口写 `bridge.json`，握手用一次性 token | 同，但 token **持久化复用**（不是每次启动换） | 一次性 token 意味着每次重启 DSH 都要重新粘贴；持久化后"粘一次"。轮换留到 P2 |
| token 由用户在扩展里粘贴 | 同，但设置页直接显示 + 一键复制（`/bl/bridge` 也返回） | 少一步找文件。`/bl/bridge` 无 CORS 头，网页 origin 读不到；WS 升级只认 `chrome-extension://` |
| 扩展模式改 `chrome.tabs.query` 当 target 列表 | 在扩展里**模拟** `Target.getTargets/attachToTarget/detachFromTarget` | host 侧 `refreshTabs/attachTab` 一行没改，17 个工具调用面零改动 |
| P1 直接放行 `Input.*` | 加了一层 **「允许操作」开关（默认关）**，且只在已授权站点上生效 | P0 已经交付了只读体验，直接默认开输入等于把只读承诺作废；开关让"看"和"动"分开授权 |
| 下载走 `chrome.downloads.onChanged` | 未做（仍是 P2） | 输入接管优先；用户浏览器模式下 `browser_downloads` 目前仍指向插件自己的 downloads 目录（README 已标注） |
| 观察窗红标 | 已做：`/bl/state` 带 `backend` + `allowInput`，`/bl/view` 顶部红标随开关换文案（读取 / 操作） | 安全项，便宜就先做 |
| approval-gate 联动 | 未做 | 待 P2；当前护栏 = 逐站点授权 + 允许操作开关 + Chrome 调试横幅 |

**实现里发现的三个真坑**（都已修，留档）：

1. **MV3 SW 30s 空闲会被回收** —— 靠 WS 上每 20s 的 `ping/pong` 双向流量续命（host 15s 心跳 + 扩展 20s 自 ping）。
2. **旧 socket 的 close 会晚于新 socket 建立** —— 重连时旧 `onclose` 把新连接的状态清掉。
   解法：所有回调先 `isCurrent()`（`state.ws === ws`）判定，`disconnect()` 先摘引用再 close。
3. **host 侧的 tab 缓存会把扩展的打码"复活"** —— 撤销授权后扩展回 url=''，但 host 的
   `t.url = p.url || t.url` 把空串当成"无更新"，于是打码前的真实 URL 留在 `/bl/state` 里；
   同时 host 还留着扩展已经丢掉的 sessionId，授权问题被伪装成"会话已失效"。
   解法：扩展回 `allowed:false` 时**强制覆盖**本地缓存并作废 sessionId；监听 `detach` 事件；
   工具层遇到会话失效自动清 session 重试一次。

**仍未关掉的缺口（诚实记录）**：`Runtime.evaluate` 在扩展白名单里（snapshot/text 靠它取正文），
所以扩展拦得住 `Input.*` 这类合成输入，拦不住页面内 JS 自己点按钮（`browser_eval` 理论上仍能代打）。
收窄 evaluate（换成固定脚本下发）待做 —— 这是"允许操作开关"之外唯一能绕过的路径。

## 7. P1 实机验证记录（v0.6.0）

在真实 Chrome（152.0.7977.83）+ 番茄渠道商后台（`channel.novellairs.com`，已授权）上跑通：

| 动作 | 证据 |
| --- | --- |
| 真点击输入框 | `mousedown`/`mouseup`/`click`，`isTrusted:true`，`elementFromPoint` 命中同一 input |
| 真 ctrl+a | `keydown Control` + `keydown a`，`isTrusted:true` |
| 真打字 | `beforeinput` + `input`，`data:"7611855200462048309"`，`isTrusted:true`，`value` 落 19 位 |
| 真删除 | `keydown Delete` → `input` → `change`，`value` 变回 `''`（清掉演示数据） |
| 真点击下拉 | 点「选择包」→ popper 打开 → 点 `novelbar` → 表单值变 `novelbar` |
| 只读不抢焦点 | `Page.captureScreenshot` 不触发 `tabs.update` |

**实机踩到的四个坑**（都写进 README / extension/README 了）：

1. **后台标签页收不到输入**：`document.hidden=true` 时 `Input.dispatchMouseEvent` 被静默丢弃，
   工具却回 `ok:true`。→ 发输入前 `chrome.tabs.update({active:true})`。
2. **窗口失焦同样丢鼠标事件**（键盘偶尔能过，所以症状是"半好"）。
   → `chrome.windows.update({focused:true})` + 等焦点到手 + 300ms 稳定期。
3. **Windows 前台锁定**：后台进程抢焦点可能被系统拒绝（任务栏闪烁）。无法绕过，只能提示用户手动点一下 Chrome。
4. **`disabled` 控件收不到鼠标事件**：番茄「新增推广链」里的「书籍ID + 搜书」搜索框是
   `disabled:true`，真点击它没有任何事件（`mousemove` 却能到）——一度被我误判成接管失败。
   这是 Chrome 的规范行为 + 页面的状态，不是 bug。此前 P0 阶段用 `evaluate` 直接赋值绕过了
   disabled，所以"能搜"；真输入才暴露了这一点。

**由此定下的产品行为**：agent 动手（`Input.*` / 上传）时会把目标标签+窗口置前；
只读操作绝不抢焦点。用户侧可感知的代价是"agent 干活时 Chrome 会跳到前台"。
