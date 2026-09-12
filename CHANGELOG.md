# 变更记录

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
