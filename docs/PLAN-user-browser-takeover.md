# 方案：接管用户自己的 Chrome（扩展路线，未实现）

> 状态：**设计 + 排期，未写一行实现代码**。设置页里也就没有“接管我的浏览器”开关——
> 放一个不工作的开关比不放更糟。等这条落地时，再在设置页加 `driveTarget: plugin | user-extension`。

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

- **P0（0.5 天）**：只做“用户浏览器里的页面**可读**（截图+文本+snapshot）”，不接管输入 —— 先验证桥与权限体验。
- **P1（1 天）**：接入 Input 接管 + 标签页选择 + 下载事件。
- **P2（0.5 天）**：设置页开关、approval-gate 联动、README、失败回退（扩展掉线自动切回插件实例）。

验收：在用户日常 Chrome（含代理/登录态）里，agent 完成“登录态抓取 + 表单填写 + 下载”各一例，
观察窗（内嵌与 `/bl/view`）均可直播与接管；断开扩展后所有 `browser_*` 自动回到插件实例且行为与现在一致。
