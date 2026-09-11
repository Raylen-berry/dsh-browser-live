// ============================================================================
// dsh-browser-live · 用户浏览器桥（v2：多扩展槽 + 按 kind 路由）
//
// 用途：让 host 侧的 browser_* 工具驱动**用户日常浏览器里的标签页**，而不是插件
// 自己拉起的隔离 Chrome 实例。做法见 docs/PLAN-user-browser-takeover.md：
//
//   host(index.js) ── WS ──> Chrome/Edge 扩展(MV3) ── chrome.debugger ──> 真实标签页
//
// 扩展充当"反向 CDP 客户端"：host 发 {id, method, params, sessionId}，扩展翻译成
// chrome.debugger.sendCommand({tabId}, method, params) 再把结果原样送回。于是 host
// 侧 Cdp 的调用面一行不用改（send/on/alive/close 四个方法同名同义）。
//
// v2（协议见 docs/MULTI-BROWSER.md，冻结）：
//   · 同时挂 N 条扩展连接，按浏览器种类 kind（chrome/edge/brave/opera/unknown）分槽；
//   · host 看到的 sessionId = `${kind}:${extSid}`，桥用前缀选连接、**原样**下发（由扩展剥前缀）；
//   · 每条连接有**自己的** pending 表（id 只在单连接内唯一），回包按回包里的 sessionId 前缀配对；
//   · 同 kind 重复连接：保留最新，旧的以 4002 superseded 关闭；
//   · 无前缀 sessionId：只有一条连接时投给它（v1 扩展兼容），多条时明确报错；
//   · 15s 心跳对每条连接单独发 ping，单条超时只关那一条。
//
// 安全边界（P0，v2 未改）：
//   · 只监听 127.0.0.1；端口默认 9760（占用则 +1 顺延，最多 +20）。
//   · 握手必须带 token（一次性粘贴，持久化在 $DSH_HOME/dsh-browser-live/bridge.json）。
//   · 只接受无 Origin 或 chrome-extension:// 的升级请求 —— 网页里的 ws://127.0.0.1 连不进来。
//   · HTTP 面只有一个 /bl/bridge-info（不含 token），供扩展自动发现端口。
// ============================================================================

import http from 'node:http'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export const BRIDGE_FILE = (baseDir) => path.join(baseDir, 'bridge.json')
export const BRIDGE_PATH = '/bl/bridge'
export const DEFAULT_BRIDGE_PORT = 9760

/**
 * §2 身份表：UA 特征 → kind。扩展上报的 browser 一般是完整 UA
 * （`Mozilla/5.0 … Chrome/131 Edg/131 …`），但也接受只报族名（`Microsoft Edge`）：
 * 族名把 'Edg/' 这类标记放宽成单词匹配，否则 Edge 会被误判成 unknown。
 */
const KIND_TABLE = [
  [/Edg[A-Za-z]*[\/ ]|(^|[^a-z])edge([^a-z]|$)/i, 'edge'],
  [/Brave/i, 'brave'],
  [/OPR\//i, 'opera'],
  [/Chrome/i, 'chrome'],
]
export const KNOWN_KINDS = ['chrome', 'edge', 'brave', 'opera', 'unknown']

/** 扩展上报的 browser 字符串 → kind。识别不出 → 'unknown'（§2）。
 *
 * 两种形状都要认（见 docs/MULTI-BROWSER.md §2）：
 *   · **纯 kind**：v2 扩展上报的就是 'edge' / 'chrome' / 'opera' / 'brave' / 'unknown'；
 *   · **完整 UA**：'Mozilla/5.0 … Edg/152 …'，或 'Microsoft Edge' 这类族名。
 * 纯 kind 必须先判：'opera' 这种族名不带 `OPR/`，走正则表会被判成 unknown
 * （而 unknown 又是个合法 kind，于是这个 bug 会静默地只坑 Opera 一家）。
 */
export function kindOfBrowser(browser) {
  const s = String(browser || '')
  const bare = s.trim().toLowerCase()
  if (KNOWN_KINDS.includes(bare)) return bare
  for (const [re, kind] of KIND_TABLE) if (re.test(s)) return kind
  return 'unknown'
}

/** v1 扩展不上报 browser：按 chrome 处理，否则老扩展的 kind 会变成 'unknown' 且与 v2 的 chrome 分槽。 */
function fallbackKind(browser) {
  const k = kindOfBrowser(browser)
  return k === 'unknown' && !String(browser || '').trim() ? 'chrome' : k
}

function strList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
}

function isMissingKindPrefix(sessionId) {
  const s = String(sessionId || '')
  return s === '' || s.indexOf(':') < 0
}

/** 从 sessionId 里取 kind 前缀（§3）。无 `kind:` 前缀 → null。 */
function sessionKind(sessionId) {
  if (isMissingKindPrefix(sessionId)) return null
  const k = String(sessionId).slice(0, String(sessionId).indexOf(':')).toLowerCase()
  return KNOWN_KINDS.includes(k) ? k : null
}

/** 一条扩展连接（一个 kind 槽）。 */
class BridgeChannel {
  constructor(kind, ws) {
    this.kind = kind
    this.ws = ws
    this.browser = ''
    this.version = ''
    this.connectedAt = Date.now()
    this.allowAll = false
    this.allowInput = false
    this.origins = []
    this.lastPong = Date.now()
    this.pending = new Map()   // id -> {resolve, reject, timer}，**每条连接独立**
    this.seq = 0               // 每条连接独立的请求 id 计数器
  }

  get open() {
    return !!this.ws && this.ws.readyState === 1
  }

  info() {
    return {
      kind: this.kind,
      browser: this.browser,
      version: this.version,
      connectedAt: this.connectedAt,
      allowAll: this.allowAll === true,
      allowInput: this.allowInput === true,
      origins: Array.isArray(this.origins) ? this.origins.slice() : [],
      lastPong: this.lastPong || 0,
    }
  }

  failAll(err) {
    for (const [, p] of this.pending) { try { p.reject(err) } catch { /* ignore */ } }
    this.pending.clear()
  }

  request(method, params, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.open) return reject(new Error('用户浏览器桥未连接（扩展没开或已断开）'))
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`用户浏览器桥 ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try { this.ws.send(JSON.stringify({ type: 'cdp', id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
}

/** 读（或首次生成）桥配置。token 持久化，用户只需往扩展里粘一次。 */
export function loadBridgeConfig(baseDir, { port = DEFAULT_BRIDGE_PORT } = {}) {
  try {
    const raw = JSON.parse(readFileSync(BRIDGE_FILE(baseDir), 'utf8'))
    if (raw && typeof raw.token === 'string' && raw.token.length >= 16) {
      return { token: raw.token, port: Number.isFinite(raw.port) ? raw.port : port, rotatedAt: raw.rotatedAt || 0 }
    }
  } catch { /* 首次运行 */ }
  return { token: randomBytes(24).toString('hex'), port, rotatedAt: Date.now() }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ba.length !== bb.length) return false
  try { return timingSafeEqual(ba, bb) } catch { return false }
}

/**
 * WS 桥服务端（v2 多扩展槽）。暴露与 Cdp 同形的 send/on/alive/close，
 * 外加 connected/list/defaultKind/status/stop。
 * @param {object} opts
 * @param {{ WebSocket: Function, WebSocketServer: Function }} opts.wsMod  'ws' 包
 * @param {string} opts.baseDir  $DSH_HOME/dsh-browser-live
 * @param {number} [opts.port]
 * @param {string} [opts.hostVersion]
 * @param {(st: object) => void} [opts.onStatus]  连接表每次变化都会收到新 status()
 */
export class BridgeServer {
  constructor({ wsMod, baseDir, port = DEFAULT_BRIDGE_PORT, hostVersion = '', log = console.log, onStatus = () => {} }) {
    this.wsMod = wsMod
    this.baseDir = baseDir
    this.wantPort = port
    this.hostVersion = hostVersion
    this.log = log
    this.onStatus = onStatus

    this.http = null
    this.wss = null
    /** kind -> BridgeChannel（同 kind 只保留最新一条） */
    this.conns = new Map()
    this.port = 0
    this.token = ''
    this.lastPong = 0            // 任一连接最近一次 pong（v1 status 兼容字段）
    this.startedAt = 0

    this.handlers = new Map()    // method -> Set<fn>
    this.pingTimer = null
  }

  // ---- Cdp 兼容面 -----------------------------------------------------------
  get alive() { return this.connected }
  get connected() { return this._live().length > 0 }

  /** 已握手且 readyState=OPEN 的连接。 */
  _live() {
    const out = []
    for (const c of this.conns.values()) if (c.open) out.push(c)
    return out
  }

  /** 有连接就取；没有则回退到 readiness 未定的那条（便于 v1 status 形状不塌）。 */
  _primary() {
    const live = this._live()
    if (live.length) return live[0]
    for (const c of this.conns.values()) return c
    return null
  }

  /** 已接入的 kind 列表（按 kind 名稳定排序）。host 用它算"哪些浏览器在线"。 */
  kinds() {
    return [...this.conns.values()].map((c) => c.kind).sort()
  }

  has(kind) {
    const c = this.conns.get(String(kind || ''))
    return !!(c && c.open)
  }

  /** 主动断掉某个 kind 的连接（host 的 close() → 只关这一条）。 */
  drop(kind, code = 1000, reason = 'host closed') {
    const c = this.conns.get(String(kind || ''))
    if (!c) return false
    this.conns.delete(c.kind)
    this._closeChannel(c, code, reason)
    if (!this.conns.size) this._stopHeartbeat()
    this.onStatus(this.status())
    this.log(`[dsh-browser-live] 扩展连接被 host 关闭（${c.kind}）`)
    return true
  }

  /**
   * 为某个 kind 造一条"专属 CDP 传输"，形状与 Cdp 一致（send/on/close/alive）。
   * host 侧会话层只认这四个方法，于是"路由到哪台浏览器"完全落在桥上：
   *   · send 第 5 参带上本 kind，桥优先按 sessionId 前缀、其次按该提示选连接；
   *   · on 只把属于本 kind 的事件交给回调；
   *   · close 只断本 kind 那条连接（不是把整个桥关掉）。
   */
  cdpFor(kind) {
    const k = String(kind || '')
    const self = this
    return {
      kind: k,
      get alive() { return self.has(k) },
      send(method, params, sessionId, timeoutMs) { return self.send(method, params, sessionId, timeoutMs, k) },
      on(event, fn) { return self._onForKind(k, event, fn) },
      close() { try { self.drop(k) } catch { /* ignore */ } },
    }
  }

  /** on() 的 kind 过滤版：兼容 fn(params, sessionId, kind) 与只要 params 的老写法。 */
  _onForKind(kind, event, fn) {
    return this.on(event, (params, sessionId, evKind) => {
      if (evKind && kind && evKind !== kind) return
      try { fn(params, sessionId, evKind) } catch { /* 不外溢 */ }
    })
  }

  /** 已接入的浏览器（按 kind 名稳定排序）。 */
  list() {
    return [...this.conns.values()]
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
      .map((c) => c.info())
  }

  /**
   * 有连接时返回一个 kind：preferred 命中就返回它，否则按 kind 名稳定排序取第一个。
   * settings.userDefault → use:'user' 用。
   */
  defaultKind(preferred) {
    const live = this._live()
    if (!live.length) return ''
    const want = String(preferred || '').trim().toLowerCase()
    if (want && live.some((c) => c.kind === want)) return want
    return live.map((c) => c.kind).sort()[0]
  }

  status() {
    const p = this._primary()
    // 前 6 个键（enabled/connected/port/since/extension/browser）保持 v1 形状与次序
    return {
      enabled: !!this.http,
      connected: this.connected,
      port: this.port,
      since: p?.connectedAt || 0,
      extension: p?.version || '',
      browser: p?.browser || '',
      // v1 尾巴（保留，client.js 在显示）
      allowAll: p?.allowAll === true,
      allowInput: p?.allowInput === true,
      origins: p?.origins ? p.origins.slice() : [],
      lastPong: this.lastPong || 0,
      // v2 新增
      count: this.conns.size,
      browsers: this.list(),
      // kinds = **当前已接入**的 kind（host 的 onBridgeStatus/connectedKinds 用它判断在线）；
      // 完整词表请用导出的 KNOWN_KINDS，别把两张表搞混。
      kinds: this.kinds(),
    }
  }

  /**
   * 按 sessionId 前缀选连接（§3）。无前缀时：
   *   · 有 kind 提示（host 的第 5 参 / use:'user' 复包）→ 投给它；
   *   · 只有一条连接 → 投给它；
   *   · 多条连接 → 报错说明缺前缀。
   *
   * 注意（v1 扩展 + 多连接的已知边界）：无前缀请求能靠提示发出去，
   * 但扩展侧也无前缀地回包时，桥无法把它归属到哪条连接 —— 按 §4「找不到就忽略」，
   * 这条请求会走到超时。要真正往返，必须要么只有一条连接，要么扩展给回包加前缀。
   */
  _connFor(sessionId, hintKind) {
    const live = this._live()
    const hint = String(hintKind || '').trim().toLowerCase()
    if (isMissingKindPrefix(sessionId)) {
      if (hint) {
        const c = this.conns.get(hint)
        if (c && c.open) return { conn: c }
        return {
          error: `用户浏览器桥未连接：${hint} 没有扩展连接`
            + (live.length ? `（当前已接入：${live.map((x) => x.kind).sort().join('、')}）` : '（当前没有扩展接入）'),
        }
      }
      if (live.length === 1) return { conn: live[0] }
      if (live.length === 0) return { error: '用户浏览器桥未连接（扩展没开或已断开）' }
      return {
        error: `有多条扩展连接（${live.map((c) => c.kind).sort().join('、')}），sessionId 缺少浏览器前缀；`
          + '请使用 `<浏览器>:<sessionId>`（例：edge:3）',
      }
    }
    const pfx = sessionKind(sessionId)
    // 明确带 known 前缀时必须与 kind 提示一致，否则宁可报错也不发错浏览器
    if (pfx && hint && pfx !== hint) {
      return { error: `sessionId "${sessionId}" 的前缀（${pfx}）与目标浏览器（${hint}）不一致，拒绝下发` }
    }
    const kind = pfx || hint
    const conn = kind ? this.conns.get(kind) : null
    if (!conn || !conn.open) {
      const avail = live.map((c) => c.kind).sort()
      return {
        error: `用户浏览器桥未连接：sessionId "${sessionId}" 指定的 ${kind || '?'} 没有扩展连接`
          + (avail.length ? `（当前已接入：${avail.join('、')}）` : '（当前没有扩展接入）'),
      }
    }
    return { conn }
  }

  send(method, params = {}, sessionId, timeoutMs = 45000, kind) {
    const r = this._connFor(sessionId, kind)
    // sessionId 原样下发（带 kind: 前缀），由扩展负责剥（§3）
    if (r.error) return Promise.reject(new Error(r.error))
    return r.conn.request(method, params, sessionId, timeoutMs)
  }

  /** fn(params, sessionId, kind) —— params 里已含带前缀的 sessionId。 */
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event).add(fn)
    return () => this.handlers.get(event)?.delete(fn)
  }

  emit(method, params, kind) {
    const set = this.handlers.get(method)
    if (!set) return
    const sid = (params && typeof params === 'object' && params.sessionId) ? params.sessionId : ''
    for (const fn of set) {
      try { fn(params || {}, sid, kind || '') } catch { /* 不外溢 */ }
    }
  }

  close() { for (const c of this.conns.values()) { try { c.ws?.close() } catch { /* ignore */ } } }

  // ---- 生命周期 -------------------------------------------------------------
  async start() {
    if (this.http) return this.status()
    const { WebSocketServer } = this.wsMod
    const cfg = loadBridgeConfig(this.baseDir, { port: this.wantPort })
    this.token = cfg.token
    mkdirSync(this.baseDir, { recursive: true })

    const server = http.createServer((req, res) => {
      const url = String(req.url || '')
      if (req.method === 'GET' && url.split('?')[0] === '/bl/bridge-info') {
        const body = JSON.stringify({ ok: true, service: 'dsh-browser-live-bridge', version: this.hostVersion, needsToken: true, path: BRIDGE_PATH })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
        res.end(body)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"error":"not found"}')
    })

    // 端口顺延：9760 被占就试 9761…9780
    const bound = await new Promise((resolve) => {
      let tries = 0
      const attempt = (p) => {
        const onErr = (e) => {
          if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && tries < 20) { tries++; attempt(p + 1); return }
          resolve({ ok: false, error: e })
        }
        server.once('error', onErr)
        server.listen(p, '127.0.0.1', () => {
          server.removeListener('error', onErr)
          const actual = server.address()
          resolve({ ok: true, port: typeof actual === 'object' && actual ? actual.port : p })
        })
      }
      attempt(cfg.port || this.wantPort)
    })
    if (!bound.ok) throw new Error('桥端口无法监听：' + (bound.error?.message || 'unknown'))

    this.port = bound.port
    this.http = server
    const wss = new WebSocketServer({ noServer: true })
    this.wss = wss

    server.on('upgrade', (req, sock, head) => {
      const url = String(req.url || '').split('?')[0]
      if (url !== BRIDGE_PATH) { try { sock.destroy() } catch { /* ignore */ } return }
      const origin = String(req.headers.origin || '')
      // 网页里的 ws://127.0.0.1 一定带 http(s) Origin —— 直接拒掉
      if (origin && !origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')) {
        try { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n') } catch { /* ignore */ }
        try { sock.destroy() } catch { /* ignore */ }
        return
      }
      wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req))
    })

    wss.on('connection', (ws) => this._onConnection(ws))

    writeFileSync(BRIDGE_FILE(this.baseDir), JSON.stringify({
      port: this.port, token: this.token, pid: process.pid, startedAt: Date.now(),
      version: this.hostVersion, url: `ws://127.0.0.1:${this.port}${BRIDGE_PATH}`,
    }, null, 2), 'utf8')

    this.startedAt = Date.now()
    this.log(`[dsh-browser-live] 用户浏览器桥监听 127.0.0.1:${this.port}${BRIDGE_PATH}`)
    return this.status()
  }

  _onConnection(ws) {
    let authed = false
    let chan = null
    const authTimer = setTimeout(() => { if (!authed) { try { ws.close(4001, 'hello timeout') } catch { /* ignore */ } } }, 5000)

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) } catch { return }

      if (!authed) {
        if (msg.type !== 'hello' || !safeEqual(msg.token, this.token)) {
          clearTimeout(authTimer)
          try { ws.send(JSON.stringify({ type: 'auth-error', error: 'token 不匹配' })) } catch { /* ignore */ }
          try { ws.close(4001, 'bad token') } catch { /* ignore */ }
          return
        }
        authed = true
        clearTimeout(authTimer)

        // §2：kind 由 browser 归一化；protocol 缺省视为 1（v1 扩展照样接）
        const kind = fallbackKind(msg.browser)
        chan = new BridgeChannel(kind, ws)
        chan.version = String(msg.version || '')
        chan.browser = String(msg.browser || '')
        chan.origins = strList(msg.origins)
        chan.allowAll = msg.allowAll === true
        chan.allowInput = msg.allowInput === true
        chan.lastPong = Date.now()

        // 同 kind 只保留最新一条，旧的以 4002 superseded 关掉
        const old = this.conns.get(kind)
        if (old && old.ws !== ws) {
          this.conns.delete(kind)
          this._closeChannel(old, 4002, 'superseded')
          this.log(`[dsh-browser-live] ${kind} 同种浏览器重复连接，旧连接已关闭（4002 superseded）`)
        }
        this.conns.set(kind, chan)
        this.lastPong = Date.now()

        try {
          // kind 回给扩展（弹窗显示"这台是 X"）；协议仍是 v1 形状 + 新字段
          ws.send(JSON.stringify({ type: 'welcome', version: this.hostVersion, readOnly: true, path: BRIDGE_PATH, kind }))
        } catch { /* ignore */ }
        this._startHeartbeat()
        this.log(`[dsh-browser-live] 扩展已接入（${kind} · ${chan.browser || 'chromium'} · v${chan.version || '?'}）`)
        this.onStatus(this.status())
        return
      }

      if (msg.type === 'cdp' && msg.id !== undefined) {
        // §3：回包里带 sessionId 就按前缀找到那条连接的 pending；找不到就忽略（不抛）
        let target = chan
        if (msg.sessionId !== undefined && msg.sessionId !== null && msg.sessionId !== '') {
          const kind = sessionKind(msg.sessionId)
          target = (kind && this.conns.get(kind)) || null
          if (!target) return   // 回包无法归属 → 丢掉
        }
        if (!target) return
        const p = target.pending.get(msg.id)
        if (!p) return
        target.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(String(msg.error.message || msg.error)))
        else p.resolve(msg.result)
        return
      }
      if (msg.type === 'event' && msg.method) {
        // 事件归属看前缀；缺前缀（v1 扩展）时退回"发起连接"，避免丢事件
        const kind = sessionKind(msg.sessionId) || chan.kind
        this.emit(msg.method, { ...(msg.params || {}), ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}) }, kind)
        return
      }
      if (msg.type === 'config') {
        // 用户在弹窗里改授权 → 实时同步给 host（/bl/state 立刻能看到）
        if (chan) {
          chan.origins = strList(msg.origins)
          chan.allowAll = msg.allowAll === true
          chan.allowInput = msg.allowInput === true
        }
        this.onStatus(this.status())
        return
      }
      if (msg.type === 'detach') {
        const kind = sessionKind(msg.sessionId) || chan.kind
        this.emit('bl.detached', { sessionId: msg.sessionId, reason: msg.reason || '' }, kind)
        return
      }
      if (msg.type === 'pong') {
        if (chan) chan.lastPong = Date.now()
        this.lastPong = Date.now()
        return
      }
      if (msg.type === 'ping') {
        // 扩展侧主动保活（MV3 SW 续命），host 回 pong
        if (chan) chan.lastPong = Date.now()
        this.lastPong = Date.now()
        try { ws.send(JSON.stringify({ type: 'pong', t: msg.t })) } catch { /* ignore */ }
        return
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      // 只有"当前登记的那条"才需要摘表：被 superseded 掉的旧连接在这里什么都不做
      if (chan && this.conns.get(chan.kind) === chan) {
        this.conns.delete(chan.kind)
        chan.failAll(new Error('用户浏览器桥连接已断开'))
        if (!this.conns.size) this._stopHeartbeat()
        this.onStatus(this.status())
        this.log(`[dsh-browser-live] 扩展已断开（${chan.kind}）`)
      }
    })
    ws.on('error', () => { /* close 会跟着来 */ })
  }

  /** 关闭一条连接（superseded / 心跳超时 / stop）。 */
  _closeChannel(chan, code, reason) {
    chan.failAll(new Error('用户浏览器桥连接已被替换或关闭'))
    try {
      if (chan.ws && typeof chan.ws.readyState === 'number' && chan.ws.readyState <= 1 && typeof chan.ws.close === 'function') chan.ws.close(code, reason)
      else chan.ws?.terminate?.()
    } catch { /* ignore */ }
  }

  /** 15s 对**每条连接**发 ping；单条超过 ~45s 没 pong 只关那一条。 */
  _startHeartbeat() {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      const now = Date.now()
      for (const c of [...this.conns.values()]) {
        if (!c.open) continue
        if (now - c.lastPong > 45000) {
          this.log(`[dsh-browser-live] ${c.kind} 心跳超时（>45s 无 pong），关闭该连接`)
          this._closeChannel(c, 4000, 'heartbeat timeout')
          continue
        }
        try { c.ws.send(JSON.stringify({ type: 'ping', t: now })) } catch { /* ignore */ }
      }
    }, 15000)
    this.pingTimer.unref?.()
  }

  _stopHeartbeat() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
  }

  async stop() {
    this._stopHeartbeat()
    for (const c of this.conns.values()) {
      c.failAll(new Error('桥已关闭'))
      try { c.ws?.close(1001, 'host shutdown') } catch { /* ignore */ }
    }
    this.conns.clear()
    if (this.wss) { try { this.wss.close() } catch { /* ignore */ } this.wss = null }
    if (this.http) {
      const h = this.http
      this.http = null
      await new Promise((r) => h.close(() => r()))
      this.log('[dsh-browser-live] 用户浏览器桥已停止')
    }
    this.onStatus(this.status())
  }
}
