// 多浏览器（Chrome + Edge 同时接入）host 侧端到端验证，不起真浏览器：
//   真 index.js 的 apply() + 真 BridgeServer + 真 extension/background.js（chrome.* 用 mock）
//   两个 Worker 各自扮演一台浏览器（独立 realm = 独立 globalThis，等价于两个浏览器进程）
// 跑法：node tools/verify-browsers.mjs
//
// 为什么要单独一个套件：verify-host.mjs 只接一条扩展连接，无法暴露"串台"类故障
// （在 Edge 上取快照、却把点击打到 Chrome 的标签页）。这个套件就是钉住这类串台。
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = mkdtempSync(path.join(os.tmpdir(), 'bl-browsers-'))
process.env.DSH_HOME = home

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.4191.66',
}
const CHROME_TABS = [
  { id: 101, url: 'https://chrome.test/p', title: 'chrome page', active: true, windowId: 1 },
  { id: 102, url: 'https://chrome-other.test/q', title: 'chrome other', active: false, windowId: 1 },
]
const EDGE_TABS = [
  { id: 201, url: 'https://edge.test/p', title: 'edge page', active: true, windowId: 2 },
]

/** 一台"假浏览器"：Worker 里跑一份真扩展代码 + 它自己的 chrome.*。 */
class FakeBrowser {
  constructor(kind, ua, tabs) {
    this.kind = kind
    this.tabs = tabs
    this.dump = { calls: {} }
    this.seq = 0
    this.waiting = new Map()
    this.worker = new Worker(path.join(import.meta.dirname, 'fake-browser-worker.mjs'), {
      workerData: { extDir: path.join(import.meta.dirname, '..', 'extension'), kind, ua, tabs },
    })
    this.ready = new Promise((resolve) => { this._resolveReady = resolve })
    this.worker.on('message', (m) => {
      if (m.type === 'ready') { this.kindSeen = m.kindSeen; this._resolveReady(m) ; return }
      if (m.state) this.dump = m.state
      const w = this.waiting.get(m.id)
      if (w) { this.waiting.delete(m.id); w(m) }
    })
    this.worker.on('error', (e) => { console.log('  [worker error]', kind, e.message) })
  }
  ask(fn, args) {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.worker.postMessage({ type: 'call', id, fn, args })
    })
  }
  async call(fn, args) { const r = await this.ask(fn, args); if (!r.ok) throw new Error(r.error); return r }
  /** 拉一次记账快照（Worker 里的 chrome.* 调用记录） */
  async refresh() { await this.ask('status'); return this.dump }
  sendCommandTabIds() { return [...new Set((this.dump.calls?.sendCommand || []).map((c) => c.target.tabId))] }
  attachTabIds() { return (this.dump.calls?.attach || []).map((c) => c.target.tabId) }
  async stop() { try { this.worker.postMessage({ type: 'exit' }); await this.worker.terminate() } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- 假 cordis ctx + 真 index.js
const tools = new Map()
const routes = new Map()
const CTX_SERVICES = {
  webServer: { port: 52479, register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
  connection: { authenticatedUrl: (base) => `${String(base).replace(/\/+$/, '')}/?token=TEST-LAUNCH-TOKEN` },
}
const ctx = {
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
  get: (k) => CTX_SERVICES[k],
  inject: (deps, cb) => { if (deps.every((d) => CTX_SERVICES[d] !== undefined)) cb(Object.assign({ get: (k) => CTX_SERVICES[k] }, CTX_SERVICES)) },
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
}

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
        try { json = JSON.parse(out) } catch { /* 非 JSON */ }
        resolve({ status, text: out, json })
      },
    }
    const p = r.handler(req, res)
    if (opts.body !== undefined) {
      setTimeout(() => { req.emit('data', Buffer.from(JSON.stringify(opts.body))); req.emit('end') }, 0)
    }
    if (p && typeof p.then === 'function') p.catch(() => {})
  })
}

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)
await mod.apply(ctx, { userBridge: false })

console.log('多浏览器（Chrome + Edge 同时接入，两台浏览器各自独立 realm）')

// 只检查"调用被路由到哪台"，返回值语义由 verify-host / verify-extension 各自覆盖
ok(tools.size === 18, '18 个 browser_* 工具已注册（use 参数是统一注入的）', String(tools.size))
const useProp = tools.get('browser_navigate').parameters?.properties?.use
ok(!!useProp && /edge/i.test(useProp.description || ''), '每个工具都注入了 use 参数（可在同一会话里切到另一台）')

// ---------------------------------------------------------------- 开桥，把"两台浏览器"接进来
const put = await callRoute('/bl/settings.json', { method: 'PUT', body: { userBridge: true } })
ok(put.status === 200 && put.json?.settings?.userBridge === true, 'PUT 打开桥')
const cfg = JSON.parse(readFileSync(path.join(home, 'dsh-browser-live', 'bridge.json'), 'utf8'))

const chromeB = new FakeBrowser('chrome', UA.chrome, CHROME_TABS)
const edgeB = new FakeBrowser('edge', UA.edge, EDGE_TABS)
await Promise.all([chromeB.ready, edgeB.ready])
ok(chromeB.kindSeen === 'chrome' && edgeB.kindSeen === 'edge',
  '两份扩展各自认出自己的身份（UA 嗅探：Edg/ → edge）', JSON.stringify({ chrome: chromeB.kindSeen, edge: edgeB.kindSeen }))

for (const b of [chromeB, edgeB]) { await b.call('saveCfg', { port: cfg.port, token: cfg.token, autoConnect: false }); await b.call('connect') }
await sleep(400)
// 逐站点授权：本套件要测的是"路由到哪台"，所以两台都把站点放开（授权模型由
// verify-extension / verify-extension-v2 覆盖）。必须 await —— saveCfg 是异步落盘的。
const allowedChrome = (await chromeB.ask('allowTabs')).value
const allowedEdge = (await edgeB.ask('allowTabs')).value
await sleep(200)
ok(allowedChrome?.added === 2 && allowedEdge?.added === 1,
  '两台扩展各自「允许当前所有标签页」（Chrome 2 个站点 / Edge 1 个）',
  JSON.stringify({ chrome: allowedChrome?.added, edge: allowedEdge?.added }))
ok(allowedChrome?.origins?.join() === 'https://chrome.test,https://chrome-other.test' && allowedEdge?.origins?.join() === 'https://edge.test',
  '各台只看到自己的站点（替身隔离正确，否则后面全是假绿）',
  JSON.stringify({ chrome: allowedChrome?.origins, edge: allowedEdge?.origins }))

let st = (await callRoute('/bl/state')).json
ok(st.bridge?.connected === true && st.bridge?.count === 2, '桥同时挂着两条扩展连接（不再互相踢掉）', JSON.stringify({ connected: st.bridge?.connected, count: st.bridge?.count, kinds: st.bridge?.kinds }))
ok(JSON.stringify(st.bridge?.kinds) === JSON.stringify(['chrome', 'edge']), 'bridge.kinds 按固定顺序给出两台浏览器', JSON.stringify(st.bridge?.kinds))
ok(st.backend === 'plugin' && st.use === 'plugin', '两条连接都在时，默认仍是插件自带实例（不擅自碰你的浏览器）', JSON.stringify({ backend: st.backend, use: st.use }))

const br = (await callRoute('/bl/bridge')).json
const liveRows = (br.browsers || []).filter((b) => b.kind !== 'plugin')
ok(liveRows.map((b) => b.kind).join() === 'chrome,edge' && liveRows.every((b) => b.connected === true),
  '/bl/bridge 列出两台已接入浏览器（给设置页显示）', JSON.stringify(br.browsers))
ok((br.browsers || []).some((b) => b.kind === 'plugin' && b.label === '插件自带实例'), '/bl/bridge 也列出插件自带实例这一档', JSON.stringify(br.browsers))

// ---------------------------------------------------------------- 按调用指定浏览器
const edgeTabs = JSON.parse(await tools.get('browser_tabs').execute({ use: 'edge', action: 'list' }, {}))
ok(edgeTabs.tabs.length === 1 && edgeTabs.tabs[0].url === 'https://edge.test/p', 'use:"edge" 读的是 Edge 的标签页', JSON.stringify(edgeTabs.tabs))
const chromeTabs = JSON.parse(await tools.get('browser_tabs').execute({ use: 'chrome', action: 'list' }, {}))
ok(chromeTabs.tabs.length === 2 && chromeTabs.tabs[0].url === 'https://chrome.test/p', 'use:"chrome" 读的是 Chrome 的标签页（两者互不覆盖）', JSON.stringify(chromeTabs.tabs))

const edgeSnap = JSON.parse(await tools.get('browser_snapshot').execute({ use: 'edge' }, {}))
ok(edgeSnap.url === 'https://edge.test/p' && /edge-书籍ID/.test(edgeSnap.elements?.[0]?.text || ''),
  'use:"edge" 的 snapshot 落在 Edge 页面上（内容带 edge 标记）', JSON.stringify(edgeSnap).slice(0, 140))
const chromeSnap = JSON.parse(await tools.get('browser_snapshot').execute({ use: 'chrome' }, {}))
ok(chromeSnap.url === 'https://chrome.test/p' && /chrome-书籍ID/.test(chromeSnap.elements?.[0]?.text || ''),
  'use:"chrome" 的 snapshot 落在 Chrome 页面上（内容带 chrome 标记）', JSON.stringify(chromeSnap).slice(0, 140))

// 关键：CDP 命令必须只打在对应那台浏览器的标签页上（串台检测）
await Promise.all([chromeB.refresh(), edgeB.refresh()])
const edgeTargets = edgeB.sendCommandTabIds()
const chromeTargets = chromeB.sendCommandTabIds()
ok(edgeTargets.length > 0 && edgeTargets.every((id) => EDGE_TABS.some((t) => t.id === id)), '发给 Edge 扩展的命令只打在 Edge 自己的标签页上', JSON.stringify(edgeTargets))
ok(chromeTargets.length > 0 && chromeTargets.every((id) => CHROME_TABS.some((t) => t.id === id)), '发给 Chrome 扩展的命令只打在 Chrome 自己的标签页上', JSON.stringify(chromeTargets))
ok(edgeB.attachTabIds().includes(201) && chromeB.attachTabIds().includes(101), '两台浏览器各自被附加了调试器（各自一份 chrome.debugger 会话）', JSON.stringify({ edge: edgeB.attachTabIds(), chrome: chromeB.attachTabIds() }))

const stEdge = (await callRoute('/bl/state')).json
ok(stEdge.use === 'chrome' && stEdge.browserLabel === 'Chrome', '最后活跃的浏览器被记住（/bl/state 反映当前会话）', JSON.stringify({ use: stEdge.use, browserLabel: stEdge.browserLabel }))

// ---------------------------------------------------------------- 未接入/非法 use：必须明确报错，不许静默换车
const braveRes = JSON.parse(await tools.get('browser_navigate').execute({ use: 'brave', url: 'https://x.test' }, {}))
ok(braveRes.ok === false && /Brave/.test(braveRes.error || ''), 'use:"brave" 未接入 → 明确报错（不静默改用别的浏览器）', JSON.stringify(braveRes).slice(0, 160))
ok(/Chrome|Edge/.test(braveRes.error || ''), '报错里带上"当前连着哪几台"（便于自愈）', JSON.stringify(braveRes).slice(0, 200))

const fakeRes = JSON.parse(await tools.get('browser_navigate').execute({ use: 'firefox', url: 'https://x.test' }, {}))
ok(fakeRes.ok === false && /use 只能是/.test(fakeRes.error || '') && /firefox/.test(fakeRes.error || ''), 'use 值非法 → 报错列出合法取值并回显收到的值', JSON.stringify(fakeRes).slice(0, 200))

// ---------------------------------------------------------------- use 缺省 = 沿用上一次
const again = JSON.parse(await tools.get('browser_tabs').execute({ action: 'list' }, {}))
ok(again.tabs.length === 2 && again.tabs[0].url === 'https://chrome.test/p', '不写 use 时沿用上一次用的浏览器（上次是 chrome）', JSON.stringify(again.tabs.map((t) => t.url)))

// ---------------------------------------------------------------- userDefault：use:"user" 指哪台
const putEdge = await callRoute('/bl/settings.json', { method: 'PUT', body: { userDefault: 'edge', backendMode: 'user' } })
ok(putEdge.json?.settings?.userDefault === 'edge', 'PUT userDefault=edge 落盘')
const userTabs = JSON.parse(await tools.get('browser_tabs').execute({ use: 'user', action: 'list' }, {}))
ok(userTabs.tabs.length === 1 && userTabs.tabs[0].url === 'https://edge.test/p', 'use:"user" 听 userDefault（这里指到 Edge）', JSON.stringify(userTabs.tabs))
const stUser = (await callRoute('/bl/state')).json
ok(stUser.use === 'edge' && stUser.browserLabel === 'Edge', '/bl/state 报告当前是 Edge（观察窗红标据此显示）', JSON.stringify({ use: stUser.use, browserLabel: stUser.browserLabel }))

// ---------------------------------------------------------------- 一台掉线不影响另一台
await edgeB.call('disconnect')
await sleep(300)
st = (await callRoute('/bl/state')).json
ok(JSON.stringify(st.bridge?.kinds) === JSON.stringify(['chrome']), 'Edge 掉线后桥只剩 Chrome', JSON.stringify(st.bridge?.kinds))
ok(st.use === 'plugin' && st.alive === false, '掉线的正是活跃会话 → 退回插件实例（不留在"对着空气发指令"的状态）', JSON.stringify({ use: st.use, alive: st.alive }))
const stillChrome = JSON.parse(await tools.get('browser_tabs').execute({ use: 'chrome', action: 'list' }, {}))
ok(stillChrome.tabs.length === 2, 'Edge 掉线不影响 Chrome 这条连接', JSON.stringify(stillChrome.tabs.map((t) => t.url)))
const edgeGone = JSON.parse(await tools.get('browser_tabs').execute({ use: 'edge', action: 'list' }, {}))
ok(edgeGone.ok === false && /Edge/.test(edgeGone.error || ''), 'Edge 掉线后 use:"edge" 明确报错', JSON.stringify(edgeGone).slice(0, 160))

// ---------------------------------------------------------------- 同 kind 重连（旧连接被顶掉，不会出现两条 edge）
const edge2 = new FakeBrowser('edge', UA.edge, [{ id: 301, url: 'https://edge2.test/p', title: 'edge2 page', active: true, windowId: 3 }])
await edge2.ready
await edge2.call('saveCfg', { port: cfg.port, token: cfg.token, autoConnect: false })
await edge2.call('connect')
await edge2.ask('allowTabs')
await sleep(400)
st = (await callRoute('/bl/state')).json
ok(JSON.stringify(st.bridge?.kinds) === JSON.stringify(['chrome', 'edge']), '同 kind 重连后仍只占一个 Edge 槽（旧连接被顶掉，不会出现两条 edge）', JSON.stringify(st.bridge?.kinds))
ok(st.bridge?.count === 2, '同 kind 重连后总数仍是 2', String(st.bridge?.count))
const edgeNew = JSON.parse(await tools.get('browser_tabs').execute({ use: 'edge', action: 'list' }, {}))
ok(edgeNew.tabs?.length === 1 && edgeNew.tabs[0].url === 'https://edge2.test/p', '重连后的 Edge 槽指向新连接（新标签页）', JSON.stringify(edgeNew.tabs))

// ---------------------------------------------------------------- 收尾
ok(tools.size === 18, '收尾自检：工具表仍是 18 个（没被中途替换）', String(tools.size))
await callRoute('/bl/settings.json', { method: 'PUT', body: { userBridge: false } })
await sleep(200)
await edge2.stop()
await chromeB.stop()
await edgeB.stop()
let cleaned = true
try { rmSync(home, { recursive: true, force: true }) } catch { cleaned = false }
ok(cleaned, '临时 DSH_HOME 清理干净（没有残留进程占着目录）')
console.log(`\n${fail ? '✗' : '✓'} verify-browsers: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
