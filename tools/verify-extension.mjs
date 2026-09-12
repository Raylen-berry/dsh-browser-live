// 扩展逻辑离线验证（不装 Chrome）：用 mock chrome.* 把 background.js 跑在 Node 里，
// 让它真连上 BridgeServer，再从 host 侧发 CDP 命令，断言白名单/授权/转发/事件。
// 跑法：node tools/verify-extension.mjs
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { BridgeServer, BRIDGE_FILE } from '../bridge.js'

async function loadWsModule() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness')
  const cands = [pathToFileURL(path.join(home, 'profiles', 'node_modules', 'ws', 'index.js')).href, 'ws']
  for (const c of cands) {
    try {
      const m = await import(c)
      const W = m.default || m.WebSocket
      const WSS = m.WebSocketServer || m.default?.WebSocketServer
      if (typeof W === 'function' && typeof WSS === 'function') return { WebSocket: W, WebSocketServer: WSS }
    } catch { /* next */ }
  }
  throw new Error('解析不到 ws 包')
}

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- manifest 完整性
const extDir = path.join(import.meta.dirname, '..', 'extension')
const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))
ok(manifest.manifest_version === 3, 'manifest 是 MV3')
ok(manifest.background?.service_worker === 'background.js' && manifest.background?.type === 'module', 'service worker 声明为 ESM')
ok((manifest.permissions || []).includes('debugger'), '声明了 debugger 权限（chrome.debugger 必需）')
ok(manifest.action?.default_popup === 'popup.html', '声明了弹窗')
ok(manifest.options_ui?.page === 'popup.html' && manifest.options_ui?.open_in_tab === true,
  '声明了「扩展程序选项」（同一 popup.html，工具栏找不到图标时的第二条入口）')
const referenced = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, 'popup.js']
const missing = referenced.filter((f) => !existsSync(path.join(extDir, f)))
ok(missing.length === 0, 'manifest 引用的文件都存在', missing.join(','))
ok((manifest.host_permissions || []).some((h) => h.includes('127.0.0.1')), 'host_permissions 限定本机回环')

// ---------------------------------------------------------------- mock chrome
const TABS = [
  { id: 11, url: 'https://allowed.test/page', title: 'Allowed page', active: false, windowId: 1 },
  { id: 12, url: 'https://secret.test/private', title: 'Secret dashboard', active: true, windowId: 1 },
  { id: 13, url: 'chrome://settings', title: '设置', active: false, windowId: 1 },
]
const storage = {}
let windowFocused = true
const calls = { attach: [], detach: [], sendCommand: [], badge: [], tabsUpdate: [], windowsUpdate: [] }
const listeners = { debuggerEvent: [], debuggerDetach: [], tabRemoved: [], alarm: [], message: [] }

// 这套件扮演 Chrome：扩展在装载时按 UA 嗅探身份（Edg/ → edge），Node 里没有 navigator，
// 不预置就会退化成 'unknown'，于是下面所有 sessionId 前缀断言都会失真。
// Node ≥21 的 globalThis.navigator 是 getter-only，必须用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' },
  configurable: true, writable: true,
})

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.3.0' }),
    onMessage: { addListener: (f) => listeners.message.push(f) },
    lastError: null,
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys || {})).filter((k) => k in storage).map((k) => [k, storage[k]])),
      set: async (obj) => { Object.assign(storage, obj) },
    },
  },
  tabs: {
    query: async () => TABS.map((t) => ({ ...t })),
    get: async (id) => { const t = TABS.find((x) => x.id === id); if (!t) throw new Error('no tab'); return { ...t } },
    update: async (id, props) => {
      calls.tabsUpdate.push({ id, props })
      const t = TABS.find((x) => x.id === id)
      if (t && props && props.active) { TABS.forEach((x) => { x.active = false }); t.active = true }
      return t ? { ...t } : undefined
    },
    onRemoved: { addListener: (f) => listeners.tabRemoved.push(f) },
  },
  windows: {
    get: async (id) => ({ id, focused: windowFocused }),
    update: async (id, props) => {
      calls.windowsUpdate.push({ id, props })
      if (props && props.focused) windowFocused = true
      return { id }
    },
  },
  debugger: {
    attach: async (target, version) => { calls.attach.push({ target, version }) },
    detach: async (target) => { calls.detach.push(target) },
    sendCommand: async (target, method, params) => {
      calls.sendCommand.push({ target, method, params })
      if (method === 'Runtime.evaluate') return { result: { value: (params?.expression || '') === '6*7' ? 42 : null } }
      if (method === 'Page.captureScreenshot') return { data: 'UE5H' }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1440, clientHeight: 900 } }
      return {}
    },
    onEvent: { addListener: (f) => listeners.debuggerEvent.push(f) },
    onDetach: { addListener: (f) => listeners.debuggerDetach.push(f) },
  },
  action: {
    setBadgeBackgroundColor: async (o) => { calls.badge.push({ color: o.color }) },
    setBadgeText: async (o) => { calls.badge.push(o) },
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: (f) => listeners.alarm.push(f) },
  },
}

// ---------------------------------------------------------------- 起桥 + 载扩展
const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-ext-'))
const srv = new BridgeServer({ wsMod: await loadWsModule(), baseDir: dir, port: 0, hostVersion: 'test', log: () => {} })
await srv.start()
const cfg = JSON.parse(readFileSync(BRIDGE_FILE(dir), 'utf8'))

const extUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'extension', 'background.js')).href
const ext = await import(extUrl)
ok(listeners.debuggerEvent.length === 1 && listeners.message.length === 1, 'background.js 装载后注册了 debugger.onEvent 与 runtime.onMessage')
ok(ext.__internals.state.connected === false, '装载后默认未连接')

// ---------------------------------------------------------------- 连接
await ext.__internals.saveCfg({ port: cfg.port, token: cfg.token, autoConnect: false })
await ext.connect()
await sleep(200)
ok(ext.__internals.state.connected === true, '扩展连上桥（真实 WS 握手）')
ok(srv.connected === true, 'host 侧看到扩展已接入')
ok(srv.status().extension === '0.3.0', 'host 拿到扩展版本')

// 错误 token 连不上
await ext.__internals.saveCfg({ token: 'bad-token' })
await ext.disconnect()
await ext.connect()
await sleep(300)
ok(ext.__internals.state.connected === false && /token/.test(ext.__internals.state.lastError), '错误 token → 未连接且给出 token 提示', ext.__internals.state.lastError)
await ext.__internals.saveCfg({ token: cfg.token, autoConnect: false })
await ext.connect()
await sleep(200)
ok(srv.connected === true, '换回正确 token 后重连成功')

// ---------------------------------------------------------------- Target.getTargets 打码
await ext.__internals.POPUP_API.allow('https://allowed.test')
const targets = await srv.send('Target.getTargets', {})
const byId = Object.fromEntries((targets.targetInfos || []).map((t) => [t.targetId, t]))
ok(targets.targetInfos.length === 3, 'getTargets 返回 3 个标签页')
ok(byId['11'] && byId['11'].url === 'https://allowed.test/page' && byId['11'].allowed === true, '已授权站点：url/title 原样返回')
ok(byId['12'] && byId['12'].url === '' && byId['12'].title === '(未授权站点)' && byId['12'].allowed === false, '未授权站点：url/title 打码（agent 看不到你在逛什么）')
ok(byId['13'] && byId['13'].allowed === false, 'chrome:// 页面同样需要授权')

// ---------------------------------------------------------------- 未授权不可附加
let err12 = ''
try { await srv.send('Target.attachToTarget', { targetId: '12', flatten: true }) } catch (e) { err12 = e.message }
ok(/未授权/.test(err12) && calls.attach.length === 0, '未授权标签页：拒绝附加且没调 chrome.debugger.attach', err12)

// ---------------------------------------------------------------- 授权后可附加
await ext.__internals.POPUP_API.allow('https://secret.test')
await sleep(80)
ok((srv.status().origins || []).includes('https://secret.test'), '授权变化实时同步到 host（/bl/state 里能直接看到）', JSON.stringify(srv.status().origins))
const att = await srv.send('Target.attachToTarget', { targetId: '12', flatten: true })
// v2 起 sessionId 在**跨 WS 边界**上带浏览器前缀（docs/MULTI-BROWSER.md §3）：
// host 下发的请求和扩展上抛的事件都是 `chrome:bl-12-1`，扩展内部仍用裸 id。
// 本套件直连桥（不经 index.js），所以 `srv.send` 拿回的是 CDP 原生形状的裸 id ——
// 加前缀是 host 侧边界（index.js 的 prefixSid）做的事，这里用回环断言钉住两侧一致。
const rawSid = (s) => String(s || '').replace(/^[a-z]+:/, '')
const sid = att.sessionId
ok(/^bl-12-/.test(sid), '附加成功并返回合成 sessionId（裸 id，CDP 原生形状）', sid)
let prefixedOk = ''
try {
  // 带前缀下发：桥必须按前缀路由到这条连接，扩展必须剥掉前缀用裸 id 命中会话。
  const prefixed = await srv.send('Runtime.evaluate', { expression: '6*7', returnByValue: true }, 'chrome:' + rawSid(sid))
  prefixedOk = String(prefixed?.result?.value)
} catch (e) { prefixedOk = 'ERR: ' + e.message }
ok(prefixedOk === '42', '带 `<kind>:` 前缀下发的命令能命中同一条会话（扩展剥前缀，桥按前缀选连接）', prefixedOk)
ok(calls.attach.length === 1 && calls.attach[0].target.tabId === 12 && calls.attach[0].version === '1.3', 'chrome.debugger.attach({tabId:12}, "1.3") 被调用')
ok(calls.badge.some((b) => b.tabId === 12 && b.text === '●'), '被接管的标签页打了红点角标')

// 重复附加复用同一个 sessionId
const att2 = await srv.send('Target.attachToTarget', { targetId: '12', flatten: true })
ok(att2.sessionId === sid && calls.attach.length === 1, '重复附加复用 sessionId（不重复 attach）')

// ---------------------------------------------------------------- 只读方法透传
const ev1 = await srv.send('Runtime.evaluate', { expression: '6*7', returnByValue: true }, sid)
ok(ev1.result.value === 42, 'Runtime.evaluate 透传到 chrome.debugger.sendCommand 并回传结果')
const shot = await srv.send('Page.captureScreenshot', { format: 'jpeg' }, sid)
ok(shot.data === 'UE5H', 'Page.captureScreenshot 透传（观察窗帧流可用）')
const lm = await srv.send('Page.getLayoutMetrics', {}, sid)
ok(lm.cssVisualViewport.clientWidth === 1440, 'Page.getLayoutMetrics 透传')
const nav = await srv.send('Page.navigate', { url: 'https://secret.test/next' }, sid)
ok(nav && Object.keys(nav).length === 0, 'Page.navigate(https) 允许')
ok(calls.sendCommand.filter((c) => c.method === 'Page.navigate')[0].target.tabId === 12, 'sendCommand 带的是正确 tabId')

// ---------------------------------------------------------------- 默认只读：输入被拒
const denied = async (method, params, label, re) => {
  let msg = ''
  try { await srv.send(method, params, sid, 4000) } catch (e) { msg = e.message }
  ok(re.test(msg), label, msg)
}
ok(ext.__internals.state.cfg.allowInput === false, '「允许操作」默认关')
await denied('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, 'Input.dispatchMouseEvent 被拒（开关关）', /允许操作/)
await denied('Input.dispatchKeyEvent', { type: 'keyDown' }, 'Input.dispatchKeyEvent 被拒', /允许操作/)
await denied('Input.insertText', { text: 'hi' }, 'Input.insertText 被拒', /允许操作/)
await denied('DOM.setFileInputFiles', { files: ['C:\\x'] }, 'DOM.setFileInputFiles 被拒', /允许操作/)
await denied('Target.createTarget', { url: 'https://x.test' }, 'Target.createTarget 仍被拒', /不允许新建/)
await denied('Target.closeTarget', { targetId: '12' }, 'Target.closeTarget：不是 agent 开的页 → 拒绝', /只能关闭 agent 自己打开的标签页/)
// 关标签页是**有条件的白名单**：只放行 agent 自己开的页（见 verify-extension-v2 的 D 段测放行）。
// 弹窗开关关掉之后，连自己开的也不许关 —— P0 只读优先。
await ext.__internals.POPUP_API.setCloseOwn(false)
await denied('Target.closeTarget', { targetId: '12' }, '「允许关闭 agent 自己开的页」关掉后：一律拒', /弹窗里打开/)
await ext.__internals.POPUP_API.setCloseOwn(true)
await denied('Network.enable', {}, '白名单外方法一律拒', /白名单/)
await denied('Page.navigate', { url: 'javascript:alert(1)' }, 'javascript: 导航被拒', /http/)
await denied('Page.navigate', { url: 'file:///C:/secret.txt' }, 'file: 导航被拒', /http/)

// ---------------------------------------------------------------- P1：打开「允许操作」后真输入放行
await ext.__internals.POPUP_API.setInput(true)
await sleep(80)
ok(ext.__internals.state.cfg.allowInput === true, '「允许操作」开关已开')
ok(srv.status().allowInput === true, '开关状态实时同步到 host（/bl/state 可见）')
const before = calls.sendCommand.length
const md = await srv.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 1 }, sid)
ok(md && Object.keys(md).length === 0, 'Input.dispatchMouseEvent 放行（真点击）')
const kt = await srv.send('Input.insertText', { text: 'hello 番茄' }, sid)
ok(kt && Object.keys(kt).length === 0, 'Input.insertText 放行（真打字）')
const kd = await srv.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
ok(kd && Object.keys(kd).length === 0, 'Input.dispatchKeyEvent 放行（真按键）')
const fi = await srv.send('DOM.setFileInputFiles', { nodeId: 3, files: ['C:\\tmp\\a.png'] }, sid)
ok(fi && Object.keys(fi).length === 0, 'DOM.setFileInputFiles 放行（真上传）')
const lastCalls = calls.sendCommand.slice(before)
ok(lastCalls.every((c) => c.target.tabId === 12), '输入命令带的是正确 tabId', JSON.stringify(lastCalls.map((c) => c.method)))
ok(lastCalls[0].params.x === 12 && lastCalls[0].params.y === 34, '鼠标坐标原样透传')
// 未授权站点即使开了「允许操作」也进不去（先决条件仍是逐站点授权）
let crossMsg = ''
try { await srv.send('Input.insertText', { text: 'x' }, 'bl-99-9', 2000) } catch (e) { crossMsg = e.message }
ok(/会话已失效/.test(crossMsg), '没有会话（未授权/未附加）时输入依旧进不去', crossMsg)
// 后台标签页收不到输入事件 → 发输入前必须把目标标签置前（Chrome 丢弃隐藏渲染器的 Input.*）
TABS.forEach((t) => { t.active = false })
calls.tabsUpdate.length = 0
await srv.send('Input.insertText', { text: 'fg' }, sid)
ok(calls.tabsUpdate.some((u) => u.id === 12 && u.props?.active === true), '输入前把后台标签页置前（否则事件被静默丢弃）', JSON.stringify(calls.tabsUpdate))
calls.tabsUpdate.length = 0
await srv.send('Input.insertText', { text: 'fg2' }, sid)
ok(calls.tabsUpdate.length === 0, '已经是前台标签时不再重复置前', JSON.stringify(calls.tabsUpdate))
// 窗口失焦：鼠标事件会被 Chrome 丢弃 → 必须先把窗口拉前，并留出稳定时间
windowFocused = false
calls.windowsUpdate.length = 0
const fgT0 = Date.now()
await srv.send('Input.insertText', { text: 'fg3' }, sid)
const fgMs = Date.now() - fgT0
ok(calls.windowsUpdate.some((u) => u.props?.focused === true), '窗口失焦时输入前把 Chrome 窗口拉前', JSON.stringify(calls.windowsUpdate))
ok(fgMs >= 150, '置前后留出稳定时间再发事件（实测不等会丢）', fgMs + 'ms')
// 只读命令不抢焦点
TABS.forEach((t) => { t.active = false })
calls.tabsUpdate.length = 0
await srv.send('Page.captureScreenshot', {}, sid)
ok(calls.tabsUpdate.length === 0, '只读命令不会抢你的前台标签', JSON.stringify(calls.tabsUpdate))
// 关掉开关立刻回到只读
await ext.__internals.POPUP_API.setInput(false)
await sleep(80)
await denied('Input.insertText', { text: 'again' }, '关掉开关后输入又被拒', /允许操作/)

// ---------------------------------------------------------------- 事件回传
const got = []
srv.on('Page.frameNavigated', (p) => got.push(p))
listeners.debuggerEvent[0]({ tabId: 12 }, 'Page.frameNavigated', { frame: { url: 'https://secret.test/next' } })
await sleep(120)
ok(got.length === 1 && String(got[0].sessionId) === 'chrome:' + rawSid(sid) && got[0].frame.url === 'https://secret.test/next', 'chrome.debugger.onEvent → host 收到带 sessionId 的事件', JSON.stringify({ got: got[0]?.sessionId, sid }))

// 非本会话的 tabId 事件不外发
listeners.debuggerEvent[0]({ tabId: 999 }, 'Page.frameNavigated', { frame: { url: 'https://x' } })
await sleep(80)
ok(got.length === 1, '未附加的 tabId 事件不外发')

// ---------------------------------------------------------------- 撤销授权 → 自动断开
await ext.__internals.POPUP_API.revoke('https://secret.test')
await sleep(120)
ok(calls.detach.some((d) => d.tabId === 12), '撤销站点授权 → chrome.debugger.detach 被调用')
ok(calls.badge.some((b) => b.tabId === 12 && b.text === ''), '断开后清掉角标')
let errAfter = ''
try { await srv.send('Runtime.evaluate', { expression: '1' }, sid, 2000) } catch (e) { errAfter = e.message }
ok(/会话已失效/.test(errAfter), '撤销后旧 sessionId 立刻失效', errAfter)

// ---------------------------------------------------------------- allowAll 开关
await ext.__internals.POPUP_API.allowAll(true)
const att3 = await srv.send('Target.attachToTarget', { targetId: '12', flatten: true })
ok(/^([a-z]+:)?bl-12-/.test(att3.sessionId), '「允许所有网站」开关生效（无需逐站点授权）')
await ext.__internals.POPUP_API.detachAll()
await sleep(80)
ok(ext.__internals.state.sessions.size === 0, 'detachAll 清空所有会话')

// ---------------------------------------------------------------- 断桥 → 会话清空
await ext.disconnect()
await sleep(150)
ok(srv.connected === false, '扩展 disconnect() → host 侧 connected=false')
ok(ext.__internals.state.connected === false && ext.__internals.state.ws === null, '扩展侧状态也清干净了')

// ---------------------------------------------------------------- 弹窗消息面
const replied = await new Promise((r) => { listeners.message[0]({ type: 'status' }, {}, r) })
ok(replied && replied.ok === true && replied.data.port === cfg.port, '弹窗消息面 status 可用')
const bad = listeners.message[0]({ type: 'nope' }, {}, () => {})
ok(bad === false, '未知消息类型不接管（返回 false）')

await srv.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail ? '✗' : '✓'} verify-extension: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
