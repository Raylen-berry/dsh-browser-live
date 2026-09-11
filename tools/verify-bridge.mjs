// 桥协议离线验证（不依赖 Chrome）：起真 BridgeServer，用真 WebSocket 客户端当"假扩展"。
// 跑法：node tools/verify-bridge.mjs
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { BridgeServer, BRIDGE_FILE } from '../bridge.js'

/** 与 index.js 的 loadWsModule 同款解析：优先 DSH profiles 里的 ws，其次裸 'ws'。 */
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
  throw new Error('解析不到 ws 包（设 DSH_HOME 或 npm i ws）')
}
const wsMod = await loadWsModule()

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-bridge-'))
const events = []
const srv = new BridgeServer({
  wsMod, baseDir: dir, port: 0, hostVersion: 'test',
  log: () => {},
  onStatus: (st) => events.push({ kind: 'status', connected: st.connected, port: st.port }),
})
await srv.start()
const port = srv.port
console.log('桥已起：127.0.0.1:' + port + '（baseDir ' + dir + '）')

const cfg = JSON.parse(readFileSync(BRIDGE_FILE(dir), 'utf8'))

// --- 1. bridge.json ---------------------------------------------------------
ok(cfg.port === port, 'bridge.json 记下了真实端口', JSON.stringify(cfg))
ok(typeof cfg.token === 'string' && cfg.token.length >= 32, 'bridge.json 里有 token')
ok(cfg.url === `ws://127.0.0.1:${port}/bl/bridge`, 'bridge.json 的 url 形状正确', cfg.url)

// --- 2. HTTP 面：/bl/bridge-info -------------------------------------------
const info = await fetch(`http://127.0.0.1:${port}/bl/bridge-info`).then((r) => r.json()).catch(() => null)
ok(info && info.ok === true && info.needsToken === true, '/bl/bridge-info 可用且不泄露 token')
ok(info && !('token' in info), '/bl/bridge-info 响应里没有 token 字段')

// --- 3. 错误 token 必须被拒 -------------------------------------------------
function openSocket({ origin } = {}) {
  const ws = new wsMod.WebSocket(`ws://127.0.0.1:${port}/bl/bridge`, origin ? { headers: { Origin: origin } } : {})
  const inbox = []
  ws.on('error', () => { /* 被拒的连接会以 error/close 结束，测试里吞掉 */ })
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString('utf8'))) } catch { /* ignore */ } })
  return { ws, inbox }
}

const bad = openSocket()
await new Promise((r) => bad.ws.on('open', r))
bad.ws.send(JSON.stringify({ type: 'hello', token: 'wrong-token', version: '9.9.9' }))
const badClose = await new Promise((r) => bad.ws.on('close', (code, reason) => r({ code, reason: reason.toString() })))
ok(badClose.code === 4001, '错误 token → 4001 关闭', JSON.stringify(badClose))
ok(bad.inbox.some((m) => m.type === 'auth-error'), '错误 token → 先收到 auth-error')
ok(srv.connected === false, '错误 token 不产生连接态')

// --- 4. 网页 Origin 必须被拒 ------------------------------------------------
const web = openSocket({ origin: 'https://evil.example' })
const webClosed = await new Promise((r) => {
  const t = setTimeout(() => r('timeout'), 2000)
  web.ws.on('error', () => { clearTimeout(t); r('error') })
  web.ws.on('close', () => { clearTimeout(t); r('closed') })
})
ok(webClosed !== 'timeout', '带 https Origin 的升级请求被拒（' + webClosed + '）')

// --- 5. 正确 token → welcome + 连接态 --------------------------------------
const ext = openSocket({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })
await new Promise((r) => ext.ws.on('open', r))
ext.ws.send(JSON.stringify({ type: 'hello', token: cfg.token, version: '0.1.0', browser: 'chrome' }))
await sleep(120)
ok(ext.inbox.some((m) => m.type === 'welcome'), '正确 token → welcome')
ok(srv.connected === true && srv.alive === true, 'srv.connected/alive 为 true')
const st = srv.status()
ok(st.extension === '0.1.0' && st.browser === 'chrome', 'status() 带扩展版本与浏览器族', JSON.stringify(st))

// --- 6. send() 往返 --------------------------------------------------------
ext.ws.on('message', (d) => {
  const msg = JSON.parse(d.toString('utf8'))
  if (msg.type === 'cdp' && msg.method === 'Page.captureScreenshot') {
    ext.ws.send(JSON.stringify({ type: 'cdp', id: msg.id, result: { data: 'ZmFrZQ==', echo: msg.params } }))
  }
  if (msg.type === 'cdp' && msg.method === 'Runtime.evaluate') {
    ext.ws.send(JSON.stringify({ type: 'cdp', id: msg.id, result: { result: { value: msg.sessionId === 'sess-1' ? 42 : -1 } } }))
  }
  if (msg.type === 'cdp' && msg.method === 'Page.navigate') {
    ext.ws.send(JSON.stringify({ type: 'cdp', id: msg.id, error: { message: '站点未授权：https://x.test' } }))
  }
  if (msg.type === 'ping') ext.ws.send(JSON.stringify({ type: 'pong', t: msg.t }))
})
const shot = await srv.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 'sess-1')
ok(shot.data === 'ZmFrZQ==' && shot.echo.quality === 60, 'send() 往返拿到扩展结果')
const ev = await srv.send('Runtime.evaluate', { expression: '6*7' }, 'sess-1')
ok(ev.result.value === 42, 'sessionId 原样透传（sess-1 → 42）')
let navErr = ''
try { await srv.send('Page.navigate', { url: 'https://x.test' }, 'sess-1') } catch (e) { navErr = e.message }
ok(navErr.includes('未授权'), '扩展侧 error 变成 reject 且保留原文', navErr)

// --- 7. 事件回传 -----------------------------------------------------------
const got = []
srv.on('Page.frameNavigated', (p) => got.push(p))
ext.ws.send(JSON.stringify({ type: 'event', sessionId: 'sess-1', method: 'Page.frameNavigated', params: { url: 'https://a.test' } }))
await sleep(80)
ok(got.length === 1 && got[0].url === 'https://a.test' && got[0].sessionId === 'sess-1', '事件带 sessionId 派发到 host')

// --- 8. 超时 ---------------------------------------------------------------
const t0 = Date.now()
let toErr = ''
try { await srv.send('Runtime.enable', {}, 'sess-1', 400) } catch (e) { toErr = e.message }
ok(toErr.includes('超时') && Date.now() - t0 < 3000, '扩展不回应 → send() 超时 reject', toErr)

// --- 9. 断开 → 状态回落 + 回退 ---------------------------------------------
ext.ws.close()
await sleep(150)
ok(srv.connected === false, '断开后 connected=false')
ok(events.some((e) => e.kind === 'status' && e.connected === true) && events.some((e) => e.kind === 'status' && e.connected === false),
  'onStatus 收到「连上→断开」两次回调')
let deadErr = ''
try { await srv.send('Runtime.enable', {}, 'sess-1', 300) } catch (e) { deadErr = e.message }
ok(deadErr.includes('未连接'), '断开后 send() 立刻 reject（不静默挂起）', deadErr)

// --- 10. 单实例：新连接顶掉旧连接 ------------------------------------------
const a = openSocket(); await new Promise((r) => a.ws.on('open', r))
a.ws.send(JSON.stringify({ type: 'hello', token: cfg.token, version: '0.1.0' }))
await sleep(100)
const b = openSocket(); await new Promise((r) => b.ws.on('open', r))
b.ws.send(JSON.stringify({ type: 'hello', token: cfg.token, version: '0.2.0' }))
await sleep(150)
ok(srv.status().extension === '0.2.0', '第二个连接顶掉第一个（extension=0.2.0）', JSON.stringify(srv.status()))

await srv.stop()
ok(srv.connected === false && srv.http === null, 'stop() 后端口释放')
ok(existsSync(BRIDGE_FILE(dir)), 'bridge.json 保留（token 复用，用户只粘一次）')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail ? '✗' : '✓'} verify-bridge: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
