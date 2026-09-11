// 桥协议 v2 离线验证（多扩展槽 + 按 kind 路由，不依赖真浏览器）。
// 起真 BridgeServer，用真 WebSocket 客户端当两个"假扩展"（chrome / edge）。
// 跑法：node tools/verify-bridge-v2.mjs
//
// 断言的不变量见 docs/MULTI-BROWSER.md §3/§4。与 v1 自测（tools/verify-bridge.mjs）并存：
// v1 脚本一个字没改，用来证明向后兼容没破。
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
const extOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
// 扩展上报的 browser 是 UA 嗅探结果：通常整条 UA，也兼容只报族名
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UA_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-bridge-v2-'))
const statusEvents = []
const srv = new BridgeServer({
  wsMod, baseDir: dir, port: 0, hostVersion: 'v2-test',
  log: () => {},
  onStatus: (st) => statusEvents.push({ connected: st.connected, count: st.count, kinds: (st.browsers || []).map((b) => b.kind) }),
})
await srv.start()
const port = srv.port
const cfg = JSON.parse(readFileSync(BRIDGE_FILE(dir), 'utf8'))
console.log('桥已起：127.0.0.1:' + port + '（baseDir ' + dir + '）')

// --- 假扩展客户端 -----------------------------------------------------------
/** 起一条假扩展连接；hello 由调用方发（要测重复 kind）。 */
function makeFakeExt() {
  const ws = new wsMod.WebSocket(`ws://127.0.0.1:${port}/bl/bridge`, { headers: { Origin: extOrigin } })
  const inbox = []        // 桥 → 本客户端的消息（每个客户端独立，验证不串）
  const state = { close: null, ws, inbox, received: [], handlers: [], sent: [] }
  ws.on('error', () => { /* 被 4002/4001 关掉的连接会以 error/close 收尾，测试里吞掉 */ })
  ws.on('message', (d) => {
    let m = null
    try { m = JSON.parse(d.toString('utf8')) } catch { return }
    inbox.push(m)
    state.received.push(m)
    for (const h of state.handlers) { try { h(m) } catch { /* ignore */ } }
  })
  ws.on('close', (code, reason) => { state.close = { code, reason: reason.toString() } })
  state.on = (fn) => state.handlers.push(fn)
  state.send = (obj) => { state.sent.push(obj); ws.send(JSON.stringify(obj)) }
  state.wait = async (n, ms = 2000) => {
    const t0 = Date.now()
    while (inbox.length < n && Date.now() - t0 < ms) await sleep(10)
    return inbox.length >= n
  }
  state.hello = async (fields) => {
    await new Promise((r) => ws.on('open', r))
    state.send({ type: 'hello', token: cfg.token, ...fields })
    await state.wait(1)
    return state
  }
  return state
}

// --- 1. 桥自身形状（v1 的 6 个键 + v2 新增） --------------------------------
{
  const st = srv.status()
  const keys = Object.keys(st).slice(0, 6)
  ok(JSON.stringify(keys) === JSON.stringify(['enabled', 'connected', 'port', 'since', 'extension', 'browser']),
    'status() 前 6 个键仍是 v1 形状与次序', JSON.stringify(keys))
  ok(st.enabled === true && st.connected === false && st.port === port, 'status() 的 enabled/connected/port 正确', JSON.stringify(st))
  ok(st.count === 0 && Array.isArray(st.browsers) && st.browsers.length === 0, '无连接时 count=0、browsers=[]')
  ok(Array.isArray(st.kinds) && st.kinds.length === 0, '无连接时 status().kinds=[]（kinds = 当前在线，host 靠它判断）', JSON.stringify(st.kinds))
  ok(srv.kinds().length === 0 && srv.has('chrome') === false, '无连接时 kinds()=[]、has("chrome")=false')
  ok(srv.alive === false && srv.connected === false, '无连接时 alive/connected 均为 false')
  ok(srv.list().length === 0 && srv.defaultKind() === '', '无连接时 list()=[]、defaultKind()=""')
  let noConn = ''
  try { await srv.send('Runtime.enable', {}, 'chrome:1', 300) } catch (e) { noConn = e.message }
  ok(noConn.includes('未连接'), '无连接时 send() reject 且说明未连接', noConn)
}

// --- 2. 两条连接同时存在（v1 是一连就互相踢） ------------------------------
const chrome = await makeFakeExt().hello({ version: '0.7.0', browser: UA_CHROME, origins: ['https://a.test'], allowAll: false, allowInput: true })
let edge = await makeFakeExt().hello({ version: '0.7.0', browser: UA_EDGE, origins: ['https://b.test'], allowAll: true, allowInput: false })
let chrome2 = chrome   // 被后来的同 kind 连接顶替掉的会换成新连接
{
  ok(chrome.ws.readyState === 1 && edge.ws.readyState === 1, 'chrome 与 edge 两条连接同时 OPEN（不互相踢）')
  const list = srv.list()
  ok(list.length === 2 && srv.status().count === 2, 'list() 与 status().count 都是 2', JSON.stringify(list.map((x) => x.kind)))
  ok(list.map((x) => x.kind).join(',') === 'chrome,edge', 'list() 按 kind 名稳定排序', JSON.stringify(list.map((x) => x.kind)))
  const ch = list.find((x) => x.kind === 'chrome'), ed = list.find((x) => x.kind === 'edge')
  ok(ch && ch.version === '0.7.0' && ch.browser === UA_CHROME && ch.allowInput === true && ch.allowAll === false && ch.origins.join() === 'https://a.test',
    'list() 的 chrome 条目带版本/族名/授权', JSON.stringify(ch))
  ok(ed && ed.browser === UA_EDGE && ed.allowAll === true && ed.origins.join() === 'https://b.test',
    'list() 的 edge 条目带版本/族名/授权', JSON.stringify(ed))
  ok(typeof ch.lastPong === 'number' && ch.lastPong > 0 && typeof ch.connectedAt === 'number' && ch.connectedAt > 0, 'list() 条目带 lastPong / connectedAt')
  const st = srv.status()
  ok(st.connected === true && st.count === 2 && st.browsers.length === 2, 'status() connected=true 且 browsers 有 2 条')
  ok(srv.alive === true && srv.defaultKind() === 'chrome' && srv.defaultKind('edge') === 'edge' && srv.defaultKind('opera') === 'chrome',
    'defaultKind()：无偏好按稳定排序取首个，偏好命中则返回它', srv.defaultKind() + '/' + srv.defaultKind('edge') + '/' + srv.defaultKind('opera'))
  ok(srv.kinds().join() === 'chrome,edge' && srv.status().kinds.join() === 'chrome,edge', 'kinds()/status().kinds 只列当前在线的两条', JSON.stringify(srv.kinds()))
  ok(srv.has('chrome') === true && srv.has('edge') === true && srv.has('opera') === false, 'has(kind)：在线 true、未接入 false')
  ok(chrome.inbox.some((m) => m.type === 'welcome' && m.kind === 'chrome') && edge.inbox.some((m) => m.type === 'welcome' && m.kind === 'edge'),
    'welcome 分别回给各自连接并带自己的 kind')
}

// --- 3. 按 sessionId 前缀路由：同一个 extSid 不能串 -------------------------
{
  const hit = { chrome: [], edge: [] }
  const reply = (label) => (m) => {
    if (m.type === 'cdp' && m.method === 'X') {
      hit[label].push(m.sessionId)
      // 故意把收到的 sessionId 原样回（v2 扩展不做前缀改写）
      const c = label === 'chrome' ? chrome : edge
      c.send({ type: 'cdp', id: m.id, result: { from: label, got: m.sessionId, extSid: String(m.sessionId).split(':')[1] } })
    }
  }
  chrome.on(reply('chrome'))
  edge.on(reply('edge'))

  const toEdge = await srv.send('X', {}, 'edge:7')
  const toChrome = await srv.send('X', {}, 'chrome:7')
  ok(toEdge.from === 'edge' && toEdge.got === 'edge:7' && toEdge.extSid === '7', 'send("edge:7") 只到达 edge，且原样下发带前缀的 sessionId', JSON.stringify(toEdge))
  ok(toChrome.from === 'chrome' && toChrome.got === 'chrome:7' && toChrome.extSid === '7', 'send("chrome:7") 只到达 chrome（同一个数字 extSid 不串）', JSON.stringify(toChrome))
  ok(hit.edge.join() === 'edge:7' && hit.chrome.join() === 'chrome:7', '两个客户端各自只看到本浏览器的那一条请求', JSON.stringify(hit))
  const pEdge = srv.send('X', {}, 'edge:9')
  const pChrome = srv.send('X', {}, 'chrome:9')
  const [rEdge, rChrome] = await Promise.all([pEdge, pChrome])
  ok(rEdge.from === 'edge' && rChrome.from === 'chrome', '并发同 id 请求各回各家（id 只在单连接内唯一）', JSON.stringify([rEdge, rChrome]))
}

// --- 4. 回包配对：故意乱序/交叉，只认带前缀的 sessionId ---------------------
{
  const seen = {}
  chrome.on((m) => { if (m.type === 'cdp' && m.method === 'Y') seen.chrome = m })
  edge.on((m) => { if (m.type === 'cdp' && m.method === 'Y') seen.edge = m })
  const p = srv.send('Y', {}, 'chrome:7')
  let t0 = Date.now()
  while (!seen.chrome && Date.now() - t0 < 2000) await sleep(10)
  ok(!!seen.chrome, '构造交叉：把 chrome:7 的回包投给 edge 客户端')
  if (seen.chrome) {
    const winner = await Promise.race([p.then((v) => ({ v })).catch((e) => ({ e })), sleep(400).then(() => null)])
    ok(winner === null, 'edge 用同一个 id 回包不会 resolve chrome 的 promise（按前缀配对）')
    edge.send({ type: 'cdp', id: seen.chrome.id, sessionId: 'edge:7', result: { orphan: 'edge' } })
    edge.send({ type: 'cdp', id: seen.chrome.id, result: { orphan: 'noprefix' } })
    edge.send({ type: 'cdp', id: 999998, sessionId: 'brave:7', result: { orphan: 'unknown-kind' } })
    await sleep(100)
    const still = await Promise.race([p.then(() => 'resolved').catch(() => 'rejected'), sleep(150).then(() => 'pending')])
    ok(still === 'pending', '同 id / 无前缀 / 未知前缀的孤儿回包都被忽略，且不影响原 promise', still)
    chrome.send({ type: 'cdp', id: seen.chrome.id, sessionId: 'chrome:7', result: { from: 'chrome', ok: true } })
    const done = await p
    ok(done && done.from === 'chrome' && done.ok === true, '真正的回包到达后才 resolve', JSON.stringify(done))
  }
}

// --- 5. Target.attachToTarget 的 sessionId 原样透传（host 不做前缀改写） ----
{
  chrome.on((m) => {
    if (m.type === 'cdp' && m.method === 'Target.attachToTarget') {
      chrome.send({ type: 'cdp', id: m.id, result: { sessionId: '7' } })   // 扩展给的是裸 extSid
    }
  })
  const att = await srv.send('Target.attachToTarget', { targetId: 'T1', flatten: true }, 'chrome:7')
  ok(att.sessionId === '7', 'attach 返回的裸 extSid 原样透传给 host（桥不加前缀）', JSON.stringify(att))
  const raw = chrome.received.find((m) => m.type === 'cdp' && m.method === 'Target.attachToTarget')
  ok(raw && raw.sessionId === 'chrome:7', 'host 下发的仍是带前缀的 chrome:7（剥前缀是扩展的活）', JSON.stringify(raw && raw.sessionId))
}

// --- 6. 无前缀 sessionId：单连接投递，多连接报错 ---------------------------
{
  // 6a. 先测「多条连接 + 无前缀」→ 必须明确报错（chrome + edge 两条）
  const all = srv.list().map((x) => x.kind).sort()
  ok(all.join(',') === 'chrome,edge', '两条连接场景（chrome+edge）', JSON.stringify(all))
  let err2 = ''
  try { await srv.send('Z', {}, 'noprefix-sid', 300) } catch (e) { err2 = e.message }
  ok(err2.includes('前缀') && err2.includes('chrome') && err2.includes('edge'), '两条连接时无前缀 sessionId → reject 且错误信息说清前缀与已接入浏览器', err2)
  let err3 = ''
  try { await srv.send('Z', {}, 'opera:1', 300) } catch (e) { err3 = e.message }
  ok(err3.includes('opera') && err3.includes('未连接'), '前缀指向没接入的浏览器 → reject 且列出当前已接入的', err3)

  // 6b. 把 chrome + edge 都摘掉，只剩一条连接 → 无前缀必须投给它（v1 扩展兼容）
  chrome2.ws.close(); edge.ws.close()
  await sleep(150)
  const solo = await makeFakeExt().hello({ version: '0.7.0', browser: 'Brave/1.70' })
  solo.on((m) => { if (m.type === 'cdp' && m.method === 'Z') solo.send({ type: 'cdp', id: m.id, result: { from: 'solo' } }) })
  ok(srv.list().length === 1 && srv.list()[0].kind === 'brave', '只剩 brave 一条连接', JSON.stringify(srv.list().map((x) => x.kind)))
  const r = await srv.send('Z', {}, 'noprefix-sid')
  ok(r.from === 'solo' && solo.received.some((m) => m.type === 'cdp' && m.sessionId === 'noprefix-sid'),
    'v1 兼容：无前缀 sessionId 在「单连接」时投给它且不改写', JSON.stringify(r))
  const r2 = await srv.send('Z', {})
  ok(r2.from === 'solo', '完全不带 sessionId 时也投给唯一连接')
  solo.ws.close()
  await sleep(100)

  // 6c. 恢复 chrome + edge 两条，供后续用例使用
  chrome2 = await makeFakeExt().hello({ version: '0.7.0', browser: UA_CHROME })
  edge = await makeFakeExt().hello({ version: '0.7.0', browser: UA_EDGE })
  chrome2.on((m) => { if (m.type === 'cdp' && m.method === 'X') chrome2.send({ type: 'cdp', id: m.id, sessionId: m.sessionId, result: { from: 'chrome2' } }) })
  ok(srv.list().map((x) => x.kind).join(',') === 'chrome,edge', '恢复 chrome+edge 两条连接', JSON.stringify(srv.list().map((x) => x.kind)))
}

// --- 7. 同 kind 重复连接：4002 superseded，count 不涨 ----------------------
{
  const before = srv.status().count
  const chrome3 = await makeFakeExt().hello({ version: '0.8.0', browser: UA_CHROME })
  await sleep(120)
  ok(chrome3.ws.readyState === 1, '新的 chrome 连接活着')
  ok(chrome2.close && chrome2.close.code === 4002, '旧的 chrome 连接被 4002 关闭', JSON.stringify(chrome2.close))
  ok(String(chrome2.close?.reason || '') === 'superseded', '4002 的原因是 superseded', JSON.stringify(chrome2.close))
  ok(srv.status().count === before && srv.list().length === 2, 'count 仍是 2（同 kind 不新建槽，只换连接）', String(srv.status().count))
  const chEntry = srv.list().find((x) => x.kind === 'chrome')
  ok(chEntry && chEntry.version === '0.8.0', 'list() 里 chrome 槽指向最新连接（v0.8.0）', JSON.stringify(chEntry && chEntry.version))
  // 新连接仍能收发
  chrome3.on((m) => { if (m.type === 'cdp' && m.method === 'X') chrome3.send({ type: 'cdp', id: m.id, sessionId: m.sessionId, result: { from: 'chrome3' } }) })
  const rr = await srv.send('X', {}, 'chrome:7')
  ok(rr.from === 'chrome3', '被顶掉之后 chrome 槽的新连接照常收发', JSON.stringify(rr))
  chrome2 = chrome3
}

// --- 7b. host 形状：send 的第 5 参 kind 提示 + drop(kind) -------------------
{
  // 注意：用当前活着的 chrome 连接（7 里已经被同 kind 顶替过一次）
  const cur = srv.list().some((x) => x.kind === 'chrome') ? chrome2 : null
  cur.on((m) => { if (m.type === 'cdp' && m.method === 'H') cur.send({ type: 'cdp', id: m.id, sessionId: m.sessionId, result: { from: 'chrome' } }) })
  edge.on((m) => { if (m.type === 'cdp' && m.method === 'H') edge.send({ type: 'cdp', id: m.id, sessionId: m.sessionId, result: { from: 'edge' } }) })
  const rh = await srv.send('H', {}, undefined, 2000, 'chrome')
  ok(rh.from === 'chrome', '不带 sessionId 但有 kind 提示 → 投给该 kind，回包（带前缀）能配对', JSON.stringify(rh))
  // 无前缀 sessionId + kind 提示：能发出去，但扩展若无前缀回包 → 桥按 §4 忽略，请求超时。
  // 这是「v1 扩展 + 多连接」的已知边界（真正往返要么单连接、要么扩展加前缀）。
  const rr2 = await Promise.race([
    srv.send('H', {}, 'noprefix-sid', 800, 'edge').then(() => 'resolved').catch((e) => 'rejected:' + e.message),
    sleep(1200).then(() => 'pending'),
  ])
  ok(String(rr2).startsWith('rejected') && String(rr2).includes('超时'),
    '无前缀请求 + kind 提示：确实投到了 edge（见下条），但无前缀回包无法归属 → 超时（§4 边界）', String(rr2))
  ok(edge.received.some((m) => m.type === 'cdp' && m.method === 'H' && m.sessionId === 'noprefix-sid'),
    '该请求确实到达了 kind 提示指定的 edge 客户端，且 sessionId 原样未改写')
  let bad = ''
  try { await srv.send('H', {}, 'edge:7', 300, 'chrome') } catch (e) { bad = e.message }
  ok(bad.includes('不一致'), '前缀与 kind 提示打架 → 明确拒绝（不发错浏览器）', bad)
  let gone = ''
  try { await srv.send('H', {}, undefined, 300, 'opera') } catch (e) { gone = e.message }
  ok(gone.includes('opera') && gone.includes('未连接'), 'kind 提示指向未接入浏览器 → reject', gone)
}

// --- 8. 事件与 detach：kind 透传给 on() 回调 -------------------------------
{
  const evs = [], dets = []
  srv.on('Page.loadEventFired', (p, sid, kind) => evs.push({ p, sid, kind }))
  srv.on('bl.detached', (p, sid, kind) => dets.push({ p, sid, kind }))
  edge.send({ type: 'event', sessionId: 'edge:7', method: 'Page.loadEventFired', params: { timestamp: 123 } })
  await sleep(80)
  ok(evs.length === 1 && evs[0].kind === 'edge' && evs[0].sid === 'edge:7' && evs[0].p.sessionId === 'edge:7' && evs[0].p.timestamp === 123,
    'srv.on() 回调拿到 kind=edge、sessionId=edge:7、params 展开', JSON.stringify(evs))
  chrome2.send({ type: 'event', sessionId: 'chrome:7', method: 'Page.loadEventFired', params: {} })
  await sleep(80)
  ok(evs.length === 2 && evs[1].kind === 'chrome' && evs[1].sid === 'chrome:7' && evs[0].kind === 'edge',
    '同一 method 的 chrome 事件带 kind=chrome（不串到 edge）', JSON.stringify(evs.map((x) => x.kind)))
  edge.send({ type: 'detach', sessionId: 'edge:7', reason: 'target closed' })
  await sleep(80)
  ok(dets.length === 1 && dets[0].kind === 'edge' && dets[0].sid === 'edge:7' && dets[0].p.reason === 'target closed',
    'detach 也解析 kind 后 emit', JSON.stringify(dets))
}

// --- 9. onStatus：连接表每次变化都回调，且 0→N / N→0 都在 ------------------
{
  ok(statusEvents.some((e) => e.count === 2 && e.kinds.join(',') === 'chrome,edge'), 'onStatus 收到 count=2 的快照', JSON.stringify(statusEvents))
  ok(statusEvents.some((e) => e.count === 1), 'onStatus 收到过 count=1（单连接场景）的快照')
}

// --- 9b. 保活：扩展侧主动 ping → host 回 pong 并刷新该连接 lastPong --------
{
  const before = srv.list().find((x) => x.kind === 'edge').lastPong
  await sleep(30)
  edge.send({ type: 'ping', t: 777 })
  await sleep(80)
  const pong = edge.inbox.find((m) => m.type === 'pong' && m.t === 777)
  ok(!!pong, '扩展侧 ping → host 回 pong（MV3 SW 续命）', JSON.stringify(edge.inbox.filter((m) => m.type === 'pong')))
  const after = srv.list().find((x) => x.kind === 'edge').lastPong
  ok(after >= before && after > 0, '该连接的 lastPong 被刷新（心跳只针对自己那条）', before + '→' + after)
}

// --- 9c. drop(kind)：host 的 close() → 只关被点名的那条 --------------------
{
  ok(srv.drop('edge') === true, 'drop("edge") 返回 true')
  await sleep(120)
  ok(edge.close && edge.close.code === 1000, '被 drop 的连接以 1000 关闭', JSON.stringify(edge.close))
  ok(chrome2.ws.readyState === 1 && srv.has('chrome') === true, 'drop 不会误伤 chrome 那条')
  ok(srv.status().count === 1 && srv.kinds().join() === 'chrome', 'drop 后 kinds()/count 只剩 chrome')
  ok(srv.drop('opera') === false, 'drop 未接入的 kind 返回 false')
}

// --- 9d. cdpFor(kind)：host 会话层的"专属传输" ------------------------------
{
  edge = await makeFakeExt().hello({ version: '0.7.0', browser: UA_EDGE })   // 9c 把 edge drop 了，重新接上
  const tEdge = srv.cdpFor('edge')
  const tChrome = srv.cdpFor('chrome')
  ok(tEdge && tEdge.kind === 'edge' && typeof tEdge.send === 'function' && typeof tEdge.on === 'function' && typeof tEdge.close === 'function',
    'cdpFor(kind) 形状与 Cdp 一致：kind/send/on/close/alive')
  ok(tEdge.alive === true && tChrome.alive === true && srv.cdpFor('opera').alive === false, 'cdpFor 的 alive 只认自己的 kind')
  ok(typeof srv.cdpFor === 'function', '桥自带 cdpFor（host 不会打印"已用兜底实现"并退化成单连接路由）')
  // 事件按 kind 分发
  const mine = [], all = []
  const off = tEdge.on('Page.loadEventFired', (p, sid, k) => mine.push({ sid, k }))
  srv.on('Page.loadEventFired', (p, sid, k) => all.push(k))
  chrome2.send({ type: 'event', sessionId: 'chrome:7', method: 'Page.loadEventFired', params: {} })
  await sleep(80)
  ok(mine.length === 0 && all.join() === 'chrome', 'chrome 的事件不会进 edge 的 cdpFor.on 回调', JSON.stringify({ mine, all }))
  edge.send({ type: 'event', sessionId: 'edge:7', method: 'Page.loadEventFired', params: {} })
  await sleep(80)
  ok(mine.length === 1 && mine[0].sid === 'edge:7' && mine[0].k === 'edge', 'edge 的事件到达 edge 的 cdpFor.on 回调并带 kind', JSON.stringify(mine))
  off()
  edge.send({ type: 'event', sessionId: 'edge:7', method: 'Page.loadEventFired', params: {} })
  await sleep(80)
  ok(mine.length === 1, 'cdpFor.on 的返回值能退订')
  // send 只走自己的 kind
  edge.on((m) => { if (m.type === 'cdp' && m.method === 'K') edge.send({ type: 'cdp', id: m.id, sessionId: m.sessionId, result: { from: 'edge' } }) })
  const rk = await tEdge.send('K', {}, 'edge:7')
  ok(rk.from === 'edge', 'cdpFor(kind).send 走本 kind 的连接', JSON.stringify(rk))
}

// --- 10. 断开：只摘自己那条 ------------------------------------------------
{
  // 9c drop 掉 edge 之后重新接一条 edge，测"断开只摘自己那条"
  edge = await makeFakeExt().hello({ version: '0.7.0', browser: UA_EDGE })
  ok(srv.status().count === 2, '重新接上 edge，回到两条连接', String(srv.status().count))
  edge.ws.close()
  await sleep(150)
  ok(srv.list().length === 1 && srv.list()[0].kind === 'chrome', '断开 edge 后 list() 只剩 chrome', JSON.stringify(srv.list().map((x) => x.kind)))
  ok(srv.status().count === 1 && srv.alive === true && srv.connected === true, 'edge 断开后 alive 仍为 true（chrome 还在）')
  const r = await srv.send('X', {}, 'chrome:7')
  ok(r.from === 'chrome3', '剩下的 chrome 连接照常收发')
  let err = ''
  try { await srv.send('X', {}, 'edge:7', 300) } catch (e) { err = e.message }
  ok(err.includes('edge') && err.includes('未连接'), '指向已断开浏览器的 send() 立刻 reject（不静默挂起）', err)
  chrome2.ws.close()
  await sleep(150)
  ok(srv.list().length === 0 && srv.status().count === 0 && srv.alive === false && srv.connected === false, '全断开后 alive/connected=false、count=0')
  ok(statusEvents.some((e) => e.count === 0) && statusEvents.some((e) => e.count === 2),
    'onStatus 覆盖了 0→N 与 N→0 两个方向（index.js 靠它做回声切换）', JSON.stringify(statusEvents))
}

// --- 11. stop() ------------------------------------------------------------
await srv.stop()
ok(srv.connected === false && srv.http === null && srv.list().length === 0, 'stop() 停心跳、清连接表并释放端口')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail ? '✗' : '✓'} verify-bridge-v2: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
