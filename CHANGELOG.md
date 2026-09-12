# 变更记录

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
