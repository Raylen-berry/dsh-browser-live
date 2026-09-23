# 接管三层开关与硬约束（从 README「接管你自己的浏览器」拆出）

README 只留"怎么开、怎么用"；这里放逐层开关明细、实机测出的硬约束、被拒清单与已知缺口。
代码对应：`extension/popup.js`（开关 UI）、`extension/background.js`（白名单与 `Input.*` 放行判定）。

## 三层开关（都在扩展弹窗里，逐层收紧；两台浏览器各自一套）

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 逐站点「允许」 | 无授权 | 没点过的站点，url/标题对 agent 一律打码，调试器也附加不上 |
| 「允许当前所有标签页」 | — | 一次性把该浏览器里所有 http(s) 标签页的 origin 并入白名单（不打开「允许所有网站」） |
| 「撤销全部授权」 | — | 清空白名单（有二次确认） |
| **允许操作**（v0.6.0 / P1） | **关** | 打开后才放行 `Input.*` 与 `DOM.setFileInputFiles`（真点击/打字/按键/滚轮/上传） |
| 允许所有网站 | 关 | 高风险：放弃逐站点确认 |

## 能力分层

**只读能力（永远可用）**：`browser_snapshot` / `browser_text` / `browser_screenshot` /
`browser_tabs list` / `browser_navigate` / `browser_wait`。观察窗照样直播（帧也是经扩展回的
`Page.captureScreenshot`），`/bl/view` 与内嵌面板会亮红标：只读时「🔴 正在读取你的 Edge」，
打开「允许操作」后变成「🔴 正在操作你的 Edge（可点击/打字）」。

**P1 操作能力**（需打开「允许操作」）：`browser_click` / `browser_move` / `browser_type` /
`browser_press` / `browser_scroll` / `browser_upload` —— 事件经 `chrome.debugger` 注入
（`isTrusted:true`，与真人同层），拟人鼠标轨迹照旧生效。

## 实机测出来的三条硬约束（v0.6.0 已处理，但你必须知道）

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

## 仍然被拒（扩展侧硬拒，会以错误结果返回，不会静默）

| 被拒 | 原因 |
| --- | --- |
| `browser_tabs new/close` | `new` 需扩展 v0.3.2+ 且弹窗「允许 agent 新开标签页」开着（自带实例档无条件允许）；`close` 只关 agent 自己开的页（`Target.closeTarget`，你手动开的一律拒绝） |
| `browser_downloads` | 用户浏览器档走扩展的 `chrome.downloads`（v0.3.4）：只回文件名/大小/状态，本地路径不外泄；需「允许操作」开着。插件自带实例档仍列 `$DSH_HOME/dsh-browser-live/downloads/` |
| 未授权站点 | 逐 origin 授权；没授权时连调试器都附加不上，开了「允许操作」也进不去 |
| 改网络 / 模拟器 / 改属性 | `Network.setExtraHTTPHeaders`、`Emulation.*`、`DOM.setAttributeValue` 不在接管范围 |

## 兜底

扩展掉线 → 下一次工具调用自动回退插件实例（行为与 v0.4.3 完全一致）；
`browser_close` 在用户浏览器模式下**只拆调试器，绝不关你的浏览器**；
扩展侧会话失效（SW 重启 / DevTools 抢走调试器）时 host 会自动清 session 重试一次。

## 已知缺口（v0.3.4 已收窄）

~~`Runtime.evaluate` 在扩展白名单里，`browser_eval` 理论上仍能代打。~~ **已修**：裸
`Runtime.evaluate` 移出白名单，host 注入页面的脚本一律走 `BL.evaluate` + 扩展侧**登记表哈希校验**
（`autoTrustScripts` 默认开 —— host 固定脚本首见即登记；关掉则每条都要在弹窗「脚本登记表」人工批准）。
agent 现编的表达式没被任何工具登记过 → 到不了你的浏览器。仍要清楚的两条边界：
① 插件自带实例档不受此限制（那条通道本来就是全权限）；② 页面自己的 JS 仍可点按钮，
护栏是逐站点授权 + 「允许操作」+ Chrome 那条无法隐藏的「正在调试此浏览器」横幅。
