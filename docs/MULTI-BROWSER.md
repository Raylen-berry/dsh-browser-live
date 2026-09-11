# 多浏览器桥协议（v2）· 冻结规格

> 目的：让 `browser_*` 工具**同时**驱动用户日常 Chrome **和** Edge 里的已登录标签页，
> 每次调用由 agent 显式指定用哪个浏览器。
>
> 本文件是 host / bridge / extension 三边必须共同遵守的**唯一契约**。
> 改协议先改这里，再改代码。实现进度与验证见文末 §6。

## 1. 为什么需要 v2

v1 的桥（`bridge.js` 的 `BridgeServer`）只保留**一个**扩展连接槽（`this.sock` / `this.ext`）：
Chrome 连着的时候 Edge 再连上会把它踢掉，host 也只有一份 `browser.tabs`。
所以"同时可控"必须同时解决两件事：

1. 桥要能同时挂 N 个扩展连接（按浏览器身份区分）；
2. host 要有**每浏览器一份**会话状态（tabs / selected / cdp），而不是一份全局的。

## 2. 身份（kind）

扩展在握手时上报 `browser` 字段，取值来自 UA 嗅探：

| UA 特征 | kind |
| --- | --- |
| 含 `Edg/` | `edge` |
| 含 `Brave/` | `brave` |
| 含 `OPR/` | `opera` |
| 含 `Chrome/`（且无以上） | `chrome` |
| 其它 | `unknown` |

`kind` 是**浏览器种类**，不是连接槽。同一 kind 若有多条连接（用户开了两个 Edge profile），
host 保留**最新**连接并把旧的以 `4002 superseded` 关闭，并把这件事写进 `/bl/state`。
不做同 kind 多开支持 —— 逐站点授权与 `use:"edge"` 的语义都会变得含糊，收益不值得复杂度。

**握手字段的形状（钉死，别两头猜）**：`hello.browser` 上报的是**纯 kind**（`edge` / `chrome` /
`brave` / `opera` / `unknown`），不是完整 UA。桥为了兼容手工测试与旧脚本，
**两种都接受**：先按整串匹配 kind 词表，再退到上表的 UA 正则（`bridge.js` 的 `kindOfBrowser`）。

## 3. sessionId 命名空间（v2 的核心）

host 侧必须能把任意 `sessionId`（来自工具参数、`browser.tabs`、CDP 事件）唯一地映射回
**属于哪个浏览器**。做法：

```
host 看到的 sessionId      = `${kind}:${extSid}`        例：edge:3
扩展内 chrome.debugger 的 sessionId = extSid            例：3
```

- 扩展**所有**出口消息（`cdp` 回包、`event`、`detach`）里的 `sessionId` 一律带 `<kind>:` 前缀；
- 扩展收到 host 下发的 `sessionId` 时**剥掉**前缀再喂给 `chrome.debugger`；
- host 的 `BridgeServer.send(..., sessionId)` 用前缀路由到对应 socket，**原样**下发带前缀的值
  （由扩展负责剥），并在 `pending` 里用 `(kind, id)` 复合键配对回包。

兼容：host 遇到**无前缀**的 sessionId 时，若当前只有一条扩展连接则投给它（v1 扩展仍可用）；
`hello.protocol` 缺省视为 1。v2 扩展一律带前缀。

## 4. 桥（host）对外 API

```
srv.alive            // 任一扩展已接入
srv.connected        // 同上（v1 兼容）
srv.list()           // [{ kind, version, connectedAt, allowAll, allowInput, origins, lastPong }]
srv.defaultKind()    // 有连接时返回某一个 kind（settings.userDefault);用于 use:'user'
srv.status()         // { enabled, port, count, browsers:[...], connected, kind, browser, extension, ... }
                     //   前 6 个键保持 v1 形状，避免 client.js / verify 脚本一起改
srv.send(method, params, sessionId, timeoutMs)   // 按 sessionId 前缀路由；无前缀→单连接时投给它
srv.on(method, fn)   // fn(params, sessionId, kind)；sessionId 带前缀
```

host → 扩展新增消息：

```
→ {type:'config', origins, allowAll, allowInput, defaultKind}   // defaultKind 仅用于弹窗显示"这台是默认"
```

## 5. 扩展弹窗新增

- 顶部显示本浏览器身份：`Microsoft Edge` / `Google Chrome` / …（来自 §2 嗅探）；
- 新增 **「允许当前所有标签页」**：把 `chrome.tabs.query({})` 里所有 `http(s)` 标签页的 origin
  去重后并入 `origins`（等价于逐个「允许此站点」，不打开 `allowAll`）；
- 新增 **「撤销全部授权」**：清空 `origins`；
- 保留：token/端口/连接状态/允许操作/允许所有网站/断开。

## 6. 实现进度（v0.7.0 已完成，Edge 真机验证待做）

| 部件 | 文件 | 状态 |
| --- | --- | --- |
| 协议冻结（本文件） | `docs/MULTI-BROWSER.md` | ✅ |
| 扩展（身份 + 前缀 + 弹窗按钮） | `extension/background.js`, `extension/sid.js`, `extension/popup.*` | ✅ v0.3.0 |
| 桥（多扩展槽 + 路由 + `cdpFor`） | `bridge.js` | ✅ |
| host（每浏览器会话 + `use:"chrome"\|"edge"`） | `index.js` | ✅ v0.7.0 |
| 观察窗/设置页显示已连接浏览器 | `client.js`, `/bl/state`, `/bl/bridge` | ✅ |
| 离线验证 | `verify-bridge-v2`(74) · `verify-extension-v2`(146) · `verify-browsers`(35) 等 6 套件 | ✅ 403 项全绿 |
| Edge 真机验证 | 装扩展 + 读一个已登录页 + 真点击 | ⏳ 待做（见下） |

### Edge 侧装机步骤（一次性）

扩展必须**在 Edge 里再装一次**（Chrome 那份不会共享）——扩展是 per-browser 的，
就像登录态不会跨浏览器共享一样：

1. 地址栏 `edge://extensions` → 打开「开发人员模式」；
2. 「加载解压缩的扩展」→ 选 `D:\DeepSeek\dsh-plugins\dsh-browser-live\extension`；
3. 点工具栏扩展图标 → 粘 token（与 Chrome 同一个，`bridge.json` 里的那个）→ 点「连接」；
4. 点「允许当前所有标签页」（或逐个允许你要交给 agent 的站点）；
5. 需要真点击/打字时再打开「允许操作」。

**注意顺序**：先重启 DSH（让 host 侧跑到 v0.7.0），再连 Edge ——
旧 host（v0.6.4）的桥只有一个连接槽，Chrome + Edge 同时连会互相顶掉，
而 v0.7.0 的桥才是"两台一起挂"。


### 实况与原设计的差异（实现时改的，留档）

| 设计 | 实况 | 为什么 |
| --- | --- | --- |
| §4 只列了 `list/status/send/on` | 桥另外实现了 `kinds()` / `has(kind)` / `drop(kind)` / `cdpFor(kind)` | host 侧按会话取传输需要它们；`cdpFor` 让"某台浏览器的专属 CDP 传输"有了统一形状 |
| `status().kinds` 语义 | = **当前已接入**的 kind（不是固定词表；词表另导出 `KNOWN_KINDS`） | `onBridgeStatus` 拿它判断"哪些在线" |
| `hello.browser` 形状未钉死 | 钉死为**纯 kind**，但桥两种形状都接受 | 双端各嗅探一次容易漂移；接受完整 UA 让手工测试与旧脚本不至于连不上 |
| `config` 消息带 `defaultKind` | 未消费（弹窗不显示"这台是默认"） | 与 `use` 的优先级容易让人误解；收益小，先不做 |
| 同 kind 多开 | 保留最新连接，旧的 4002 关闭 | 逐站点授权与 `use:"edge"` 在"两个 Edge profile"下语义含糊 |

### 已知边界（诚实记录）

1. **v1 扩展 + 多连接**：无前缀请求能靠 kind 提示发出，但 v1 扩展无前缀回包时桥无法归属 → 该请求超时。
   v2 扩展一律带前缀，生产路径无此问题。
2. **`unknown` kind**：非 Chromium（Firefox）装上这份扩展会报 `unknown:`，且 `chrome.debugger` 不存在，
   会四处报错。未加"非 Chromium 直接提示"的守卫。
3. **用户浏览器档的下载**：`browser_downloads` 仍只列插件实例的目录（接 `chrome.downloads` 仍未做）。

