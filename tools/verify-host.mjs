// host 侧集成验证（不装 Chrome、不起真 Chrome）：
//   真 index.js 的 apply() + 真 BridgeServer + 真 extension/background.js（chrome.* 用 mock）
//   覆盖：工具注册 / 只读面 / P1 输入面 / 回退面 / 路由与观察窗页面
// 跑法：node tools/verify-host.mjs
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- DSH_HOME 指到临时目录
const home = mkdtempSync(path.join(os.tmpdir(), 'bl-host-'))
process.env.DSH_HOME = home

// ---------------------------------------------------------------- mock chrome（给真扩展代码用）
const TABS = [
  { id: 9, url: 'https://allowed.test/p', title: 'Allowed page', active: true, windowId: 1 },
  { id: 10, url: 'https://other.test/q', title: 'Other page', active: false, windowId: 1 },
]
const SNAP = {
  url: 'https://allowed.test/p', title: 'Allowed page', vw: 1280, vh: 720,
  scrollY: 0, docHeight: 1800,
  elements: [{ ref: 'e1', tag: 'input', text: '书籍ID', x: 100, y: 200 }],
  text: 'hello from user browser', textMore: false,
}
const storage = {}
const calls = { attach: [], detach: [], sendCommand: [], badge: [], tabsUpdate: [], windowsUpdate: [] }
const listeners = { debuggerEvent: [], debuggerDetach: [], tabRemoved: [], alarm: [], message: [] }

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.2.0' }),
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
    get: async (id) => ({ id, focused: true }),
    update: async (id, props) => { calls.windowsUpdate.push({ id, props }); return { id } },
  },
  debugger: {
    attach: async (target, version) => { calls.attach.push({ target, version }) },
    detach: async (target) => { calls.detach.push(target) },
    sendCommand: async (target, method, params) => {
      calls.sendCommand.push({ target, method, params })
      if (method === 'Runtime.evaluate') {
        const ex = String(params?.expression || '')
        if (ex === '6*7') return { result: { value: 42 } }
        if (ex === 'location.href') return { result: { value: 'https://allowed.test/p' } }
        // 顺序要紧：SNAPSHOT_FN 里也含 innerText，RESOLVE_FILE_INPUT_FN 里也含 function vis(e)
        if (/input\[type=file\]/.test(ex)) return { result: { value: { ok: true, count: 1, matched: 0, multiple: false, accept: '', current: '', via: 'auto' } } }
        if (/function vis\(e\)/.test(ex)) return { result: { value: SNAP } }
        if (/innerText/.test(ex)) return { result: { value: { found: true, len: 25, text: 'hello from user browser!!' } } }
        return { result: { value: null } }
      }
      if (method === 'Page.captureScreenshot') return { data: 'UE5HRA==' }   // 4 字节
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      return {}
    },
    onEvent: { addListener: (f) => listeners.debuggerEvent.push(f) },
    onDetach: { addListener: (f) => listeners.debuggerDetach.push(f) },
  },
  action: {
    setBadgeBackgroundColor: async (o) => { calls.badge.push({ color: o.color }) },
    setBadgeText: async (o) => { calls.badge.push(o) },
  },
  alarms: { create: () => {}, onAlarm: { addListener: (f) => listeners.alarm.push(f) } },
}

// ---------------------------------------------------------------- 载入真扩展代码
// 扩展在装载时按 UA 嗅探身份（Edg/ → edge、Chrome/ → chrome）。Node 里默认没有 navigator，
// 不预置就会退化成 'unknown'，于是 kind 路由断言全部失真 —— 本套件扮演 Chrome。
// Node ≥21 的 globalThis.navigator 是 getter-only，必须 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' },
  configurable: true, writable: true,
})
const ext = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'extension', 'background.js')).href)
ok(ext.__internals.KIND === 'chrome', 'mock Chrome UA → 扩展身份嗅探为 chrome', ext.__internals.KIND)

// ---------------------------------------------------------------- 假 cordis ctx + 真 index.js
const tools = new Map()
const routes = new Map()
const CTX_SERVICES = {
  webServer: { port: 52479, register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
  // 假 connection 服务：只实现插件真正用到的那一个方法（authenticatedUrl）。
  // 真实现见 @deepseek-ai/dsh-client-connection（dsh-web-app 打印 dsh web URL 用的同一个）。
  connection: { authenticatedUrl: (base) => `${String(base).replace(/\/+$/, '')}/?token=TEST-LAUNCH-TOKEN` },
}
const ctx = {
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
  get: (k) => CTX_SERVICES[k],
  inject: (deps, cb) => { if (deps.every((d) => CTX_SERVICES[d] !== undefined)) cb(Object.assign({ get: (k) => CTX_SERVICES[k] }, CTX_SERVICES)) },
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
}

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)
await mod.apply(ctx, { userBridge: false })

// 假的 req/res，直接调路由 handler（不真起 HTTP 服务）
function callRoute(path_, opts = {}) {
  const r = routes.get(path_)
  if (!r) throw new Error('路由不存在: ' + path_)
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = opts.method || 'GET'
    req.url = path_
    req.headers = {}
    req.resume = () => {}
    req.destroy = () => {}
    let status = 0, out = ''
    const res = {
      writeHead: (c) => { status = c },
      setHeader: () => {},
      write: (s) => { out += String(s) },
      end: (s) => {
        if (s) out += String(s)
        let json = null
        try { json = JSON.parse(out) } catch { /* 非 JSON（/bl/view） */ }
        resolve({ status, text: out, json })
      },
    }
    const p = r.handler(req, res)
    if (opts.body !== undefined) {
      setTimeout(() => {
        req.emit('data', Buffer.from(JSON.stringify(opts.body)))
        req.emit('end')
      }, 0)
    }
    if (p && typeof p.then === 'function') p.catch(() => {})
  })
}

// ---------------------------------------------------------------- 注册面
ok(tools.size === 18, '18 个 browser_* 工具已注册', String(tools.size))
ok(tools.has('browser_ext_setup'), 'browser_ext_setup 已注册（一键备好接管日常浏览器的现场）')
// 非法 kind 必须在"动 UI/开桥"之前就被拒绝：这条用例的价值就在于它不产生任何副作用。
// （桩把工具返回值 JSON.stringify 成字符串，所以要 parse 回来再断言。）
const extBad = JSON.parse(String(await tools.get('browser_ext_setup').execute({ kind: 'firefox' })))
ok(extBad && extBad.ok === false && /edge/.test(extBad.error || ''), 'browser_ext_setup 拒绝非法 kind 且不产生副作用', JSON.stringify(extBad))
ok(routes.has('/bl/bridge'), '/bl/bridge 路由已注册')
ok(!existsSync(path.join(home, 'dsh-browser-live', 'bridge.json')), 'userBridge=false 时不起桥（不写 bridge.json）')
const st0 = (await callRoute('/bl/state')).json
ok(st0.backend === 'plugin' && st0.alive === false, '初始后端 = plugin 且未启动', JSON.stringify({ backend: st0.backend, alive: st0.alive }))
const br0 = (await callRoute('/bl/bridge')).json
ok(br0.enabled === false && /未启用/.test(br0.hint || ''), '未启用时 /bl/bridge 给出启用提示', br0.hint)

// ---------------------------------------------------------------- 打开桥
const put = await callRoute('/bl/settings.json', { method: 'PUT', body: { userBridge: true, backendMode: 'user' } })
ok(put.status === 200 && put.json?.settings?.userBridge === true, 'PUT /bl/settings.json 即时打开桥（无需重启）', JSON.stringify(put.json).slice(0, 120))
// 此刻桥在监听、但扩展还没连上 —— setBase('user') 只能失败：设置照存，后端等扩展接入时自愈（见下面「扩展接入 → 后端自动切到 user」）
ok(put.json?.settings?.backendMode === 'user' && typeof put.json?.backendWarn === 'string', '扩展未接入时切 user 档：设置存下并回 backendWarn（不假装已换后端）', JSON.stringify({ backendMode: put.json?.settings?.backendMode, backend: put.json?.backend, backendWarn: put.json?.backendWarn }))
const bridgeFile = path.join(home, 'dsh-browser-live', 'bridge.json')
const cfg = JSON.parse(readFileSync(bridgeFile, 'utf8'))
ok(Number.isFinite(cfg.port) && cfg.port > 1024, '桥起来后写了 bridge.json', JSON.stringify(cfg).slice(0, 100))
const br1 = (await callRoute('/bl/bridge')).json
ok(br1.enabled === true && br1.token === cfg.token && /extension$/.test(br1.extensionDir || ''), '/bl/bridge 返回端口与 token（供粘贴）', JSON.stringify(br1).slice(0, 160))

// ---------------------------------------------------------------- 扩展接上桥
await ext.__internals.saveCfg({ port: cfg.port, token: cfg.token, autoConnect: false })
await ext.__internals.POPUP_API.allow('https://allowed.test')
await ext.connect()
await sleep(350)
const st1 = (await callRoute('/bl/state')).json
ok(st1.alive === true && st1.backend === 'user', '扩展接入 → 后端自动切到 user 且 alive=true', JSON.stringify({ alive: st1.alive, backend: st1.backend }))
ok(st1.bridge && st1.bridge.connected === true && st1.bridge.extension === '0.2.0', '/bl/state 带桥状态（供观察窗显示红标）', JSON.stringify(st1.bridge).slice(0, 160))

// ---------------------------------------------------------------- backendMode=auto：桥连着也不抢（免登录页走插件实例）
// 这是 v0.6.2 的默认档：v0.6.0 的 verify-host 假设"桥一连上就切 user"，那是旧行为。
const putAuto = await callRoute('/bl/settings.json', { method: 'PUT', body: { backendMode: 'auto' } })
const stAuto = (await callRoute('/bl/state')).json
ok(putAuto.json?.settings?.backendMode === 'auto' && stAuto.backend === 'plugin', 'auto 档：桥连着也只切回插件实例（免登录页不受逐站点授权限制）', JSON.stringify({ backendMode: putAuto.json?.settings?.backendMode, backend: stAuto.backend, bridge: stAuto.bridge?.connected }))
const putBack = await callRoute('/bl/settings.json', { method: 'PUT', body: { backendMode: 'user' } })
ok((await callRoute('/bl/state')).json.backend === 'user', '切回 user 档后仍是用户的日常浏览器（同一台桥，无需重连）')
ok(putBack.json?.backend === 'user' && !putBack.json?.backendWarn, '桥可用时 PUT 切档当场生效（不等下一次工具调用）', JSON.stringify({ backend: putBack.json?.backend, backendWarn: putBack.json?.backendWarn }))

// ---------------------------------------------------------------- 只读面（经桥 + 扩展）
const snapRes = JSON.parse(await tools.get('browser_snapshot').execute({}, {}))
ok(snapRes.url === 'https://allowed.test/p' && snapRes.elements?.[0]?.ref === 'e1', 'browser_snapshot 经「桥+扩展」拿到用户浏览器页面快照', JSON.stringify(snapRes).slice(0, 160))
ok(calls.attach.length >= 1 && calls.attach[0].target.tabId === 9, '扩展对目标标签页调了 chrome.debugger.attach')
ok(calls.sendCommand.some((c) => c.method === 'Runtime.evaluate' && c.target.tabId === 9), '工具链的 evaluate 经 chrome.debugger.sendCommand 下发')

const tabsRes = JSON.parse(await tools.get('browser_tabs').execute({ action: 'list' }, {}))
ok(tabsRes.tabs.length === 2 && tabsRes.tabs[0].url === 'https://allowed.test/p', 'browser_tabs list 读的是用户浏览器标签页', JSON.stringify(tabsRes).slice(0, 160))
ok(tabsRes.tabs[1].url === '' && tabsRes.tabs[1].title === '(未授权站点)' && tabsRes.tabs[1].allowed === false, '未授权标签页对 agent 打码（host 侧也不留真实 URL）', JSON.stringify(tabsRes.tabs[1]))

const textRes = JSON.parse(await tools.get('browser_text').execute({ limit: 100 }, {}))
ok(textRes.url === 'https://allowed.test/p' && /hello from user browser/.test(textRes.text), 'browser_text 经桥取到正文', JSON.stringify(textRes).slice(0, 140))

const shotRes = JSON.parse(await tools.get('browser_screenshot').execute({ name: 'host-verify' }, {}))
ok(shotRes.ok === true && shotRes.bytes === 4 && existsSync(shotRes.path), 'browser_screenshot 落盘（截图走扩展）', JSON.stringify(shotRes))

// ---------------------------------------------------------------- 默认只读：输入被拒
const clickRes = JSON.parse(await tools.get('browser_click').execute({ x: 5, y: 5, instant: true }, {}))
ok(clickRes.ok === false && /允许操作/.test(clickRes.error || ''), 'browser_click 默认只读被拒且以错误结果返回', JSON.stringify(clickRes).slice(0, 200))
const uploadRes = JSON.parse(await tools.get('browser_upload').execute({ files: [path.join(home, 'x.txt')] }, {}))
ok(uploadRes.ok === false, 'browser_upload 默认只读不可用', JSON.stringify(uploadRes).slice(0, 160))

// ---------------------------------------------------------------- P1：打开「允许操作」后真输入打通
await ext.__internals.POPUP_API.setInput(true)
await sleep(150)
const stInput = (await callRoute('/bl/state')).json
ok(stInput.bridge.allowInput === true, '/bl/state 反映「允许操作」已开（观察窗据此换红标文案）')

const beforeInput = calls.sendCommand.length
const typeRes = JSON.parse(await tools.get('browser_type').execute({ text: '番茄渠道' }, {}))
ok(typeRes.ok === true && typeRes.typed === 4, 'browser_type 真打字打通', JSON.stringify(typeRes).slice(0, 140))
const clickOn = JSON.parse(await tools.get('browser_click').execute({ x: 30, y: 40, instant: true }, {}))
ok(clickOn.ok === true, 'browser_click 真点击打通', JSON.stringify(clickOn).slice(0, 140))
const pressOn = JSON.parse(await tools.get('browser_press').execute({ keys: 'Enter' }, {}))
ok(pressOn.ok === true, 'browser_press 真按键打通', JSON.stringify(pressOn).slice(0, 140))
const scrollOn = JSON.parse(await tools.get('browser_scroll').execute({ direction: 'down', amountPx: 300 }, {}))
ok(scrollOn.ok === true, 'browser_scroll 真滚轮打通', JSON.stringify(scrollOn).slice(0, 140))
const upFile = path.join(home, 'upload-test.txt')
writeFileSync(upFile, 'hello')
const uploadOn = JSON.parse(await tools.get('browser_upload').execute({ files: [upFile] }, {}))
ok(uploadOn.ok === true && uploadOn.files?.[0]?.bytes === 5, 'browser_upload 真上传打通（DOM.setFileInputFiles）', JSON.stringify(uploadOn).slice(0, 200))

const inputCalls = calls.sendCommand.slice(beforeInput)
// 后台标签页：输入前扩展必须把标签置前（Chrome 丢弃隐藏渲染器的 Input.*）
TABS[0].active = false
calls.tabsUpdate.length = 0
const fgRes = JSON.parse(await tools.get('browser_type').execute({ text: '前台' }, {}))
ok(fgRes.ok === true && calls.tabsUpdate.some((u) => u.id === 9 && u.props?.active === true), '输入前把后台标签页置前（否则事件被静默丢弃）', JSON.stringify(calls.tabsUpdate))
const usedMethods = inputCalls.map((c) => c.method)
ok(usedMethods.includes('Input.insertText'), '打字命令经 chrome.debugger 下发', JSON.stringify(usedMethods.slice(0, 10)))
ok(usedMethods.filter((m) => m === 'Input.dispatchMouseEvent').length >= 3, '点击下发按下/抬起等多条鼠标事件', String(usedMethods.filter((m) => m === 'Input.dispatchMouseEvent').length))
ok(usedMethods.includes('Input.dispatchKeyEvent'), '按键命令经 chrome.debugger 下发')
ok(usedMethods.includes('DOM.setFileInputFiles'), '上传命令经 chrome.debugger 下发')
ok(inputCalls.filter((c) => c.method.startsWith('Input.') || c.method === 'DOM.setFileInputFiles').every((c) => c.target.tabId === 9), '所有输入命令都打在已授权标签页上', JSON.stringify([...new Set(inputCalls.map((c) => c.target.tabId))]))

// 关掉开关 → 立刻回到只读
await ext.__internals.POPUP_API.setInput(false)
await sleep(150)
const typeOff = JSON.parse(await tools.get('browser_type').execute({ text: 'x' }, {}))
ok(typeOff.ok === false && /允许操作/.test(typeOff.error || ''), '关掉开关后立刻回到只读', JSON.stringify(typeOff).slice(0, 160))

// ---------------------------------------------------------------- browser_close 不关用户的浏览器
const closeRes = JSON.parse(await tools.get('browser_close').execute({}, {}))
ok(closeRes.ok === true, 'browser_close 返回 ok')
ok(calls.detach.length >= 1 && !calls.sendCommand.some((c) => c.method === 'Browser.close'), 'browser_close 只 detach 调试器，绝不 Browser.close', JSON.stringify({ detach: calls.detach.length }))
const st2 = (await callRoute('/bl/state')).json
ok(st2.alive === false && st2.backend === 'user', 'close 后 alive=false 但桥仍在（可再 open）')

const openRes = JSON.parse(await tools.get('browser_open').execute({}, {}))
ok(openRes.ok === true && openRes.url === 'https://allowed.test/p', 'browser_open 重新接回用户浏览器', JSON.stringify(openRes).slice(0, 140))

// ---------------------------------------------------------------- 扩展掉线 → 自动回退插件后端
await ext.disconnect()
await sleep(250)
const st3 = (await callRoute('/bl/state')).json
ok(st3.backend === 'plugin' && st3.alive === false, '扩展掉线 → 自动回退插件后端', JSON.stringify({ backend: st3.backend, alive: st3.alive }))

// ---------------------------------------------------------------- 关桥
const put2 = await callRoute('/bl/settings.json', { method: 'PUT', body: { userBridge: false } })
ok(put2.status === 200 && put2.json?.settings?.userBridge === false, 'PUT 关闭桥成功')
const br2 = (await callRoute('/bl/bridge')).json
ok(br2.enabled === false, '关闭后 /bl/bridge 显示 enabled=false')
ok(existsSync(bridgeFile), 'bridge.json 保留（token 下次复用）')

// ---------------------------------------------------------------- 观察窗页面
const view = await callRoute('/bl/view')
ok(view.status === 200 && /<!doctype html>/i.test(view.text), '/bl/view 返回内联脚本')
const script = view.text.split('<script>').pop().split('</script>')[0]
let syntaxOk = true, syntaxErr = ''
try { new Function(script) } catch (e) { syntaxOk = false; syntaxErr = String(e.message) }
const syntaxErrText = syntaxErr
ok(syntaxOk, '/bl/view 内联脚本语法有效（含新增红标逻辑）', syntaxErrText)
// 全屏曾是个裸 requestFullscreen()：被拒时静默，用户看到的就是"点了没反应"（实测报回来的）。
// 这几条把它钉住，别再退化回去。
ok(/requestFullscreen/.test(script) && /\.catch\(/.test(script), '/bl/view 全屏请求接了 catch（被拒不再静默）', '')
ok(/id="fsmsg"/.test(view.text) && /fsMsg\(/.test(script), '/bl/view 有可见的失败提示元素 + fsMsg 调用', '')
ok(/F11/.test(script), '/bl/view 全屏失败时给出 F11 兜底路径', '')
ok(/allow=fullscreen/.test(script), '/bl/view 区分「iframe 缺 allow=fullscreen」与「浏览器拒绝」两种原因', '')
ok(/webkitRequestFullscreen/.test(script) && /exitFullscreen/.test(script), '/bl/view 兼容 webkit 前缀且支持退出全屏', '')

// ---------------------------------------------------------------- /bl/gui：DSH GUI 的已认证 URL
// 背景：插件 Chrome 是干净 profile，直接开 GUI 根路径会 401（"dsh web authentication required"）。
// 插件用宿主 connection 服务的 authenticatedUrl() 取带 token 的 URL（宿主自己打印 dsh web URL 用的同一个 API）。
{
  const noJson = await callRoute('/bl/gui', { method: 'POST', body: {} })
  ok(noJson.status === 400, 'POST /bl/gui 缺 need 字段 → 400', JSON.stringify(noJson.json))
  const asGet = await callRoute('/bl/gui')
  ok(asGet.status === 405, 'GET /bl/gui 不给 URL（避免被 <img>/<script> 跨站捎带 token）', JSON.stringify(asGet.json))
  const got = await callRoute('/bl/gui', { method: 'POST', body: { need: 'gui-url' } })
  ok(got.status === 200 && got.json?.url === 'http://127.0.0.1:52479/?token=TEST-LAUNCH-TOKEN',
    'POST /bl/gui 回宿主签发的已认证 URL（端口取自 webServer）', JSON.stringify(got.json))
  const lantern = await callRoute('/bl/gui', { method: 'POST', body: { need: 'gui-url', base: 'http://192.168.1.9:52479' } })
  ok(lantern.json?.url === 'http://192.168.1.9:52479/?token=TEST-LAUNCH-TOKEN',
    'POST /bl/gui 可换成 LAN 地址（同一套 token 规则重签）', JSON.stringify(lantern.json))
  // 工具面：browser_open {gui:true} 必须走那个带 token 的 URL。
  // 这个套件不起真 Chrome，所以 launch() 一定会失败 —— 断言点放在"失败前用的是带 token 的 URL"
  // 和"错误信息里不透出 token"（token 不该出现在给模型/日志的错误文本里）。
  // 失败文案两种都接受：本机没有浏览器时是"未响应 CDP 端口"；本机恰好有同端口/竞争进程时
  // 可能是"CDP 未连接"。钉死其中一种会让这套件在别人机器上莫名其妙地红。
  const openGui = JSON.parse(await tools.get('browser_open').execute({ gui: true }, {}))
  ok(/未响应 CDP 端口|CDP 未连接/.test(openGui.error || ''), 'browser_open {gui:true} 走到了启动浏览器这一步（本套件无真 Chrome，预期在此失败）', JSON.stringify(openGui).slice(0, 200))
  ok(!JSON.stringify(openGui).includes('TEST-LAUNCH-TOKEN'), 'browser_open 的失败结果里不泄露 launch token', JSON.stringify(openGui).slice(0, 200))
}
// v0.7：红标文案带浏览器名（"正在读取你的 Edge"），所以断言对浏览器名不敏感
ok(/正在读取你的/.test(view.text) && /正在操作你的/.test(view.text), '/bl/view 红标文案随「允许操作」开关切换', '')

rmSync(home, { recursive: true, force: true })
console.log(`\n${fail ? '✗' : '✓'} verify-host: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
