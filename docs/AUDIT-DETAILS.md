# 留痕细节（从 README「数据与隐私」拆出）

README 的「数据与隐私 → 留痕」只留口径摘要；这里放完整细节：脱敏规则、链尾修复史、能力边界。
对应代码：`audit.js`（`redactAuditArgs`、trim）+ `index.js` 注册循环里的 `withAudit()` 包装。

## 敏感输入脱敏（P1 隐私泄漏修复）

原来 `args` 是**原文落盘**，而 `browser_type` 的返回值虽然把 password 字段处理成"只回长度不回显"，
参数里的 `text` 仍是明文 —— 于是"往密码框里打的字"被持久化写进了审计日志。现在**写之前**先过一遍
`redactAuditArgs()`（`audit.js`，纯函数、离线可断言），口径是"敏感输入只留字段名、长度和摘要"：

- `browser_type` 打进的如果是 **password 字段**（判据来自工具返回值里的 `field.type`，
  是浏览器回读出来的事实，不靠正则猜密码串），`text` 落盘为
  `{ redacted: true, field: 'text', len: N, sha256: '前12位' }` —— 够日后比对"是不是同一个值"，
  但不含内容。**普通输入保持原文**：留痕的价值就在于能看出当时打了什么，不做一刀切。
- 兜底：`args` 里**键名**命中 `password` / `passwd` / `secret` / `token` / `authorization` /
  `apikey` / `api_key` / `cookie` / `credential` / `session_id` / `otp` 的值（含嵌套）一律同样脱敏，
  与是哪个工具无关。只按键名判，**不按内容扫**（否则 `D:\secrets\a.png` 这类正常路径也会被吃掉）。
- `tool` / `ok` / `ms` / `backend` / `urlBefore` / `urlAfter` / `err` / `result` 全部照旧保留。
- 残留口子：**没走 `browser_type` 的输入不受影响**（例如用 `browser_eval` 直接给
  `input.value` 赋值 —— 键名不敏感时它就是普通脚本文本，不会被脱敏）。要打密码就用
  `browser_type`，它才会被认成 password 字段。

`tools/verify-audit-redact.mjs` 把上面这些钉成断言（含"真包装器 `withAudit` 落盘后不含明文"
和"普通输入必须还能看到原文"两条），跑法：

```powershell
node tools/verify-audit-redact.mjs   # 期望 0 failed（条数以该命令输出为准）<!-- doc-numbers-ok -->
```

收口点只有一个：所有工具都在 `index.js` 的注册循环里被 `withAudit()` 包了一层
（不是逐个工具加埋点 —— 那样必然会漏，新增工具时还会再漏）。

## 链尾以文件为准，不信进程内存（v0.12.0 修）

原来只在"跨天"时读一次文件尾，同一天里默认内存里的 `prev` 是对的 —— 但同一天里可能有**第二个写入者**。
2026-09-14 真踩到：插件被重新 apply 后旧实例的 AUDIT 仍在写，两条线各自记链尾，第 16 行接回了第 14 行
⇒ 链断，**看起来和"有人删了一行"完全一样**（哈希链最不该误报的就是这个）。现在每次写之前读一次
文件末尾（16KB）取链尾，`prev` 是文件的事实；`apply()` 开头也会先收回上一个实例
（注册项与定时器，不动浏览器进程/登录态）。

> 那一处历史断点**按"只追加不重写"保留原样**（重写就等于毁掉证据），并在文件里用一条
> `type:"note"` 记录写清了诊断与修法（`kind:"chain-break-diagnosis"`）。所以：
> `npm run audit:check` 对那份历史数据仍会报这一处；**第二天换文件即恢复全绿**。
> 代码测试（`npm test`）不再包含"实时链检查" —— 它检查的是你的数据、不是代码，
> 混在一起会让"改了代码跑测试"因为历史数据而失败。

## 能力边界（别把它当保险箱）

追加写 + 哈希链能查出"删了一行 / 改了一行"—— `tools/verify-audit.mjs` 里就有这两条断链断言。
但日志和 agent 在同一台机器、同一个用户下，**拥有完整写权限的人可以把整条链重算一遍**，
因此它挡的是"顺手抹掉一两步"，不是防篡改。真要不可抹，得把这条 JSONL 实时送到 agent 够不到的地方
（另一个进程 / 另一台机器）。

另外，**"关掉 agent 自己开的页面"这个权限本来就不在 agent 手里**：它由浏览器右上角扩展弹窗里的
「允许关闭 agent 自己打开的标签页」开关控制（`extension/popup.js` + `background.js` 的
`allowCloseOwn` 判定，默认开；关掉之后连它自己开的也关不了），你手动开的页面任何情况下都不在范围内。
