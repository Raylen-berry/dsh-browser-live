// ============================================================================
// DSH Browser Bridge · MV3 service worker（P0：只读）
//
// 角色：反向 CDP 客户端。host 发 {type:'cdp', id, method, params, sessionId}，
// 这里翻译成 chrome.debugger.sendCommand({tabId}, method, params) 把结果送回。
//
// 三条硬边界（P0）：
//   1. 方法白名单，默认拒绝。Input.* / DOM.setFileInputFiles / 标签页增删 一律拒。
//   2. 逐站点授权：只有用户在弹窗里点过「允许」的 origin 才可被附加（chrome.debugger）。
//   3. 未授权站点的 url/title 对 host 一律打码 —— agent 看不到你在逛什么。
//
// 事件：chrome.debugger.onEvent → {type:'event', sessionId, method, params}
// ============================================================================

import { detectBrowserKind, browserName, extSid, rawSid } from './sid.js'

// v2：多浏览器。hello 上报真实 kind，所有出口 sessionId 带 `<kind>:` 前缀。
// 契约见 docs/MULTI-BROWSER.md（§2 身份、§3 sessionId 命名空间）。
const PROTOCOL = 2
const BRIDGE_PATH = '/bl/bridge'
const WS_URL = (port) => `ws://127.0.0.1:${port}${BRIDGE_PATH}`

// 本扩展所在浏览器的种类：edge / brave / opera / chrome / unknown（UA 嗅探，模块加载时定一次）
const KIND = detectBrowserKind(typeof navigator === 'undefined' ? '' : navigator.userAgent)
const KIND_NAME = browserName(KIND)

// ---- 方法白名单 ------------------------------------------------------------
// 只读层（永远允许）：纯读取 + 会话管理 + 导航（导航是可见动作，只放 http/https/about）
const ALLOWED = new Set([
  'Target.getTargets', 'Target.attachToTarget', 'Target.detachFromTarget',
  'Page.enable', 'Page.getLayoutMetrics', 'Page.captureScreenshot',
  'Page.getNavigationHistory', 'Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry',
  'Runtime.enable', 'Runtime.evaluate',
  'DOM.enable', 'DOM.getDocument', 'DOM.querySelector',
  'Browser.getVersion',
])

// P1 操作层（仅当用户在弹窗里打开「允许操作」时放行）：真鼠标/键盘/滚轮/上传
const INPUT_METHODS = new Set([
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Input.dispatchDragEvent', 'Input.synthesizeScrollGesture', 'DOM.setFileInputFiles',
])
const isInputMethod = (m) => INPUT_METHODS.has(m) || m.startsWith('Input.')

// 永远拒绝：改浏览器/标签页结构、网络与模拟器
// 注意 Target.closeTarget **不在这里** —— 它走 handleCommand 里单独的分支：
// 只允许关 agent 自己开的标签页（见 state.ownedTabs），你手动开的页面一律拒绝。
const DENIED_PREFIX = ['Emulation.', 'Network.setExtraHTTPHeaders', 'Page.setDownloadBehavior',
  'Browser.setDownloadBehavior', 'DOM.setAttributeValue', 'Target.createTarget',
  'Target.activateTarget', 'Page.close', 'Page.bringToFront', 'Runtime.addBinding']

const DENIED_HINT = {
  'Target.createTarget': '暂不允许新建标签页；请自己在浏览器里开好页面（或让 agent 导航当前页）',
}

// ---- 状态 ------------------------------------------------------------------
const state = {
  cfg: { port: 9760, token: '', autoConnect: true, allowAll: false, allowInput: false, allowCloseOwn: true, origins: [] },
  // agent **自己**开出来的标签页（新开标签页去已授权站点时记下）。关标签页只放行这些，
  // 你手动开的页面永远不会被关 —— 这是"允许关自己开的页"与"不碰你的页"的分界线。
  ownedTabs: new Set(),
  ws: null,
  connected: false,
  hostVersion: '',
  lastError: '',
  lastPong: 0,
  retry: null,
  sessions: new Map(),   // extSid（无前缀） -> tabId
  byTab: new Map(),      // tabId -> extSid（无前缀）
  seq: 0,
  log: [],
}

// ---- sessionId 命名空间（v2 核心）------------------------------------------
// 两个边界就是这两个函数，别在别处手写字符串拼接/replace：
//   出口（→host）：ext() 加 `<kind>:`；入口（host→）：raw() 剥前缀。
// 内部 state.sessions / state.byTab / chrome.debugger 回调拿到的 sessionId 一律**无前缀**。
const ext = (s) => extSid(KIND, s)
const raw = (s) => rawSid(s)

function note(msg) {
  state.log.push({ t: Date.now(), msg: String(msg).slice(0, 200) })
  if (state.log.length > 60) state.log.shift()
}

// ---- 配置持久化 -------------------------------------------------------------
async function loadCfg() {
  try {
    const raw = await chrome.storage.local.get(['port', 'token', 'autoConnect', 'allowAll', 'allowInput', 'allowCloseOwn', 'origins'])
    state.cfg.port = Number.isFinite(raw.port) ? raw.port : 9760
    state.cfg.token = typeof raw.token === 'string' ? raw.token : ''
    state.cfg.autoConnect = raw.autoConnect !== false
    state.cfg.allowAll = raw.allowAll === true
    state.cfg.allowInput = raw.allowInput === true
    state.cfg.allowCloseOwn = raw.allowCloseOwn !== false
    state.cfg.origins = Array.isArray(raw.origins) ? raw.origins.filter((x) => typeof x === 'string') : []
  } catch { /* 首用默认 */ }
  return state.cfg
}
async function saveCfg(patch) {
  Object.assign(state.cfg, patch || {})
  try {
    await chrome.storage.local.set({
      port: state.cfg.port, token: state.cfg.token, autoConnect: state.cfg.autoConnect,
      allowAll: state.cfg.allowAll, allowInput: state.cfg.allowInput, allowCloseOwn: state.cfg.allowCloseOwn,
      origins: state.cfg.origins,
    })
  } catch { /* ignore */ }
  // 授权/开关一变就同步给 host：/bl/state 里直接能看到，省得用户复述
  sendToHost({ type: 'config', origins: state.cfg.origins, allowAll: state.cfg.allowAll, allowInput: state.cfg.allowInput, allowCloseOwn: state.cfg.allowCloseOwn })
  return state.cfg
}

// ---- 授权 ------------------------------------------------------------------
export function originOf(url) {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
    return u.protocol + '//' + (u.host || '')   // chrome://、file:// 等也各成一档
  } catch { return '' }
}
export function isAllowed(url) {
  if (state.cfg.allowAll) return true
  const o = originOf(url)
  return !!o && state.cfg.origins.includes(o)
}
function redact(tab) {
  const ok = isAllowed(tab.url)
  return {
    targetId: String(tab.id),
    type: 'page',
    url: ok ? String(tab.url || '') : '',
    title: ok ? String(tab.title || '') : '(未授权站点)',
    allowed: ok,
  }
}

// ---- 标签页 / 会话 ----------------------------------------------------------
async function listTabs() {
  try { return await chrome.tabs.query({}) } catch { return [] }
}

async function attachTab(tabId0, intendedUrl) {
  let tabId = tabId0
  let tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) throw new Error('标签页不存在（可能已关闭）')
  const want = String(intendedUrl || '')
  // ⚠ 顺序很要紧：「要不要换一个标签页」必须判在 byTab 缓存**之前**。
  // v0.8.3 的第一版把它放在缓存之后，于是"已经附着过的未授权前台页"走了缓存直接返回，
  // 就地导航的老行为又回来了 —— 实测踩到（前台先被 browser_navigate 附着过，再 browser_open 就中招）。
  if (!isAllowed(tab.url) && want && isAllowed(want)) {
    // 只放行「去一个已授权站点」这一种情况，而且**绝不动你正在看的那个页面**：
    // 新开一个标签页过去、附加到**新标签页**。（v0.8.1 原来是就地导航，会把你前台的页面顶掉 ——
    // 你只是让 agent 去看一眼别的东西，不该付出"我正在读的页面被换掉"的代价。）
    // 隐私底线不变：agent 拿不到未授权页面的调试器 —— attach 永远发生在"页面已经是已授权站点"之后。
    note(`当前页未授权 → 新开标签页去已授权站点 ${originOf(want)}（不动你现在的页面）`)
    const created = await chrome.tabs.create({ url: want, active: true }).catch(() => null)
    if (!created || created.id === undefined) throw new Error('浏览器拒绝了新开标签页（tabs.create 失败）')
    tabId = created.id
    state.ownedTabs.add(tabId)                 // 这是 agent 自己开的页：以后允许它自己关掉
    for (let i = 0; i < 50; i++) {           // 最多等 5s 落到已授权 origin
      await sleep(100)
      tab = await chrome.tabs.get(tabId).catch(() => null)
      if (tab && isAllowed(tab.url)) break
    }
    if (!tab || !isAllowed(tab.url)) {
      throw new Error(`新开的标签页没能落在已授权站点 ${originOf(want)}（当前 ${originOf(tab && tab.url) || '未知'}），已放弃附加`)
    }
  } else if (state.byTab.has(tabId)) {
    return { sessionId: state.byTab.get(tabId), tabId }   // 这个标签页本来就是已授权且已附着，直接用
  } else if (!isAllowed(tab.url)) {
    const o = originOf(tab.url) || '该页面'
    throw new Error(`站点未授权：${o}。点扩展图标 →「允许此站点」后再试（P0 逐站点授权）`)
  }
  await chrome.debugger.attach({ tabId }, '1.3')
  const sessionId = `bl-${tabId}-${++state.seq}`
  state.sessions.set(sessionId, tabId)
  state.byTab.set(tabId, sessionId)
  try { await chrome.action.setBadgeBackgroundColor({ color: '#c62828' }) } catch { /* ignore */ }
  try { await chrome.action.setBadgeText({ tabId, text: '●' }) } catch { /* ignore */ }
  note(`已附加标签页 #${tabId}`)
  return { sessionId, tabId }
}

async function detachSession(sessionId) {
  const tabId = state.sessions.get(sessionId)
  if (tabId === undefined) return
  state.sessions.delete(sessionId)
  state.byTab.delete(tabId)
  try { await chrome.action.setBadgeText({ tabId, text: '' }) } catch { /* ignore */ }
  try { await chrome.debugger.detach({ tabId }) } catch { /* 可能已经掉了 */ }
  note(`已断开标签页 #${tabId}`)
}

async function detachAll() {
  for (const sid of [...state.sessions.keys()]) await detachSession(sid)
}

// 合成输入必须打在**可见且有焦点**的标签页上：
//  - 隐藏（后台）标签：Chrome 丢弃 Input.*；
//  - 窗口失焦：鼠标事件同样被丢（键盘偶尔能过），实测表现为"点了没反应"。
// 所以只在「允许操作」开着、且真要发输入时，才把目标标签/窗口置前 —— 对应方案 §4
// "接管期间扩展把目标标签置前"那条缓解措施。置前后必须留出稳定时间，否则刚激活的渲染器
// 还没恢复输入通路，事件照样丢。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ensureForeground(tabId) {
  let changed = false
  try {
    const t = await chrome.tabs.get(tabId)
    if (!t) return false
    if (!t.active) { await chrome.tabs.update(tabId, { active: true }); changed = true }
    if (t.windowId != null && chrome.windows && typeof chrome.windows.get === 'function') {
      const w = await chrome.windows.get(t.windowId).catch(() => null)
      if (w && w.focused === false) {
        await chrome.windows.update(t.windowId, { focused: true }).catch(() => {})
        changed = true
        // 等窗口真的拿到焦点：Windows 的前台锁定可能拒绝被抢焦点（最多等 1s，然后照发）
        for (let i = 0; i < 10; i++) {
          const w2 = await chrome.windows.get(t.windowId).catch(() => null)
          if (w2 && w2.focused !== false) break
          await sleep(100)
        }
      }
    }
    if (changed) {
      for (let i = 0; i < 10; i++) {
        const t2 = await chrome.tabs.get(tabId).catch(() => null)
        if (t2 && t2.active) break
        await sleep(50)
      }
      await sleep(300)
      note(`已把标签页 #${tabId} 置前（输入需要前台焦点）`)
    }
    return true
  } catch { return false }   // 没有 windows 权限/窗口已关：静默降级，别把命令打挂
}

// ---- 命令执行 --------------------------------------------------------------
function deniedReason(method) {
  if (isInputMethod(method)) {
    return '点击/输入/上传属于「允许操作」（P1 合成输入），现在开关是关的：'
      + '点浏览器工具栏的扩展图标 → 勾选「允许操作（真点击/打字/上传）」'
  }
  if (DENIED_HINT[method]) return DENIED_HINT[method]
  if (DENIED_PREFIX.some((p) => method.startsWith(p))) return '该方法被拒绝（结构性改动 / 模拟器 / 网络改写不在接管范围）'
  return '方法不在白名单内：' + method
}

export async function handleCommand({ method, params = {}, sessionId }) {
  // 入口边界：host 下发的 sessionId 带 `<kind>:` 前缀（例：chrome:bl-12-1），
  // chrome.debugger 只认无前缀值。这里剥一次，往下全用无前缀 sid。
  const sid = raw(sessionId)
  // 关标签页：只放行 **agent 自己开的** 那些（新开标签页去已授权站点时记进 state.ownedTabs）。
  // 分界线很清楚：agent 开的页，agent 自己收拾；你手动开的页面，任何情况下都不动。
  // 弹窗里的「允许关闭 agent 自己开的页面」关掉之后，连自己开的也不许关（P0 只读优先）。
  if (method === 'Target.closeTarget') {
    const id = Number(params.targetId)
    if (!Number.isInteger(id)) throw new Error('targetId 非法')
    if (state.cfg.allowCloseOwn !== true) {
      throw new Error('已拒绝：关闭标签页需要你在扩展弹窗里打开「允许关闭 agent 自己开的页面」')
    }
    if (!state.ownedTabs.has(id)) {
      throw new Error('已拒绝：只能关闭 agent 自己打开的标签页（你手动开的页面不会被关）')
    }
    await chrome.tabs.remove(id).catch(() => { throw new Error('关闭标签页失败（可能已经被关掉了）') })
    state.ownedTabs.delete(id)
    state.byTab.delete(id)
    note(`已关闭 agent 自己打开的标签页 #${id}`)
    return { success: true }
  }
  const allowedNow = ALLOWED.has(method) || (isInputMethod(method) && state.cfg.allowInput === true)
  if (!allowedNow) throw new Error(deniedReason(method))

  // —— 会话管理：Target.* 由扩展自己实现（chrome.debugger 没有 CDP 的 Target 域）
  if (method === 'Target.getTargets') {
    const tabs = await listTabs()
    return { targetInfos: tabs.filter((t) => t.id != null).map(redact) }
  }
  if (method === 'Target.attachToTarget') {
    const tabId = Number(params.targetId)
    if (!Number.isInteger(tabId)) throw new Error('targetId 非法')
    // intendedUrl（host 给的"这次想去哪"）：当前页未授权、而目标页已授权时，
    // 先导航到目标页再附加 —— 见 attachTab 里的说明。
    // 注意**不能**走 raw()/rawSid()：那个函数剥的是 sessionId 的 kind 前缀，
    // 会把 URL 里的 `https:` 当成前缀剥掉，目标站点于是判成未授权（v0.8.1 踩过）。
    const intendedUrl = typeof params.intendedUrl === 'string' ? params.intendedUrl : ''
    const att = await attachTab(tabId, intendedUrl)
    // 真实 tabId 必须一起报回去：当前页未授权时扩展会**新开标签页**，
    // 附加的很可能不是 host 点名的那个标签页；host 不据此纠正映射的话，
    // 列表里会显示"旧标签页已附加"，而 agent 的截图/点击其实落在新标签页上。
    return { sessionId: att.sessionId, tabId: String(att.tabId) }
  }
  if (method === 'Target.detachFromTarget') {
    // params.sessionId 也来自 host（可能是带前缀的），同样走入口边界
    await detachSession(raw(params.sessionId) || sid)
    return {}
  }
  if (method === 'Browser.getVersion') {
    return { product: navigator.userAgent, protocolVersion: '1.3', jsVersion: '', userAgent: navigator.userAgent }
  }

  if (!sid) throw new Error('缺少 sessionId（先 Target.attachToTarget）')
  const tabId = state.sessions.get(sid)
  if (tabId === undefined) throw new Error('会话已失效（标签页被关或已断开），重新 browser_open')

  if (method === 'Page.navigate') {
    const url = String(params.url || '')
    if (!/^(https?:|about:)/i.test(url)) throw new Error('只允许导航到 http/https/about 页面')
  }

  // 输入类命令：先确保目标标签是前台可见的，否则 Chrome 会静默丢弃
  if (isInputMethod(method)) await ensureForeground(tabId)

  return await chrome.debugger.sendCommand({ tabId }, method, params)
}

// ---- WS 连接 ---------------------------------------------------------------
function sendToHost(obj) {
  if (!state.ws || state.ws.readyState !== 1) return false
  try { state.ws.send(JSON.stringify(obj)); return true } catch { return false }
}

export function status() {
  return {
    connected: state.connected,
    port: state.cfg.port,
    hostVersion: state.hostVersion,
    lastError: state.lastError,
    allowAll: state.cfg.allowAll,
    allowInput: state.cfg.allowInput,
    allowCloseOwn: state.cfg.allowCloseOwn,
    ownedTabs: [...state.ownedTabs],     // agent 自己开的标签页（只有这些页允许被关）
    origins: [...state.cfg.origins],
    autoConnect: state.cfg.autoConnect,
    protocol: PROTOCOL,
    kind: KIND,              // edge / brave / opera / chrome / unknown
    browser: KIND,           // 与 hello 的 browser 字段同名同值，便于 host/弹窗复用
    browserName: KIND_NAME,  // Microsoft Edge / Google Chrome / …（弹窗顶部显示）
    sessions: [...state.sessions.entries()].map(([sid, tabId]) => ({ sessionId: sid, tabId })),
    log: state.log.slice(-12),
  }
}

export async function connect() {
  await loadCfg()
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return status()
  if (!state.cfg.token) { state.lastError = '还没有粘贴 token：打开 $DSH_HOME/dsh-browser-live/bridge.json 复制 token'; return status() }
  clearTimeout(state.retry); state.retry = null
  state.lastError = ''
  let ws
  try { ws = new WebSocket(WS_URL(state.cfg.port)) } catch (e) { state.lastError = String(e?.message || e); return status() }
  state.ws = ws
  // 旧 socket 的 close 事件可能晚于新 socket 的建立 —— 只有"当前 socket"才允许改状态
  const isCurrent = () => state.ws === ws
  ws.onopen = () => {
    if (!isCurrent()) return
    sendToHost({ type: 'hello', protocol: PROTOCOL, token: state.cfg.token, version: chrome.runtime.getManifest().version, browser: KIND, origins: state.cfg.origins, allowAll: state.cfg.allowAll, allowInput: state.cfg.allowInput, allowCloseOwn: state.cfg.allowCloseOwn })
    startPing()
  }
  ws.onmessage = (ev) => {
    if (!isCurrent()) return
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'welcome') { state.connected = true; state.hostVersion = String(msg.version || ''); note('已连接 host'); return }
    if (msg.type === 'auth-error') { state.lastError = 'token 不匹配（bridge.json 里的 token 已更新？重新复制）'; note(state.lastError); return }
    if (msg.type === 'ping') { sendToHost({ type: 'pong', t: msg.t }); state.lastPong = Date.now(); return }
    if (msg.type === 'pong') { state.lastPong = Date.now(); return }
    if (msg.type === 'cdp') { onCommand(msg); return }
  }
  ws.onclose = () => {
    if (!isCurrent()) return
    const was = state.connected
    state.connected = false
    stopPing()
    state.ws = null
    if (was) { detachAll().catch(() => {}); note('与 host 断开') }
    if (state.cfg.autoConnect) scheduleReconnect()
  }
  ws.onerror = () => {
    if (!isCurrent()) return
    state.lastError = `连不上 127.0.0.1:${state.cfg.port}（host 没开桥？设置里 userBridge 需为 true）`
  }
  return status()
}

async function onCommand(msg) {
  const { id, method, params, sessionId } = msg
  const sid = raw(sessionId)
  try {
    const result = await handleCommand({ method, params, sessionId })
    // 出口边界：回包里的 sessionId 一律用带前缀的。attach 的 result 自带 sessionId，
    // 此时请求本身没带 sessionId —— 所以取 result 里的那个来加前缀。
    const wireSid = (result && result.sessionId) || sid
    const out = { type: 'cdp', id, result: result === undefined ? {} : result }
    if (wireSid) out.sessionId = ext(wireSid)
    sendToHost(out)
  } catch (e) {
    const out = { type: 'cdp', id, error: { message: String(e?.message || e) } }
    if (sid) out.sessionId = ext(sid)
    sendToHost(out)
  }
}

export async function disconnect() {
  await saveCfg({ autoConnect: false })
  clearTimeout(state.retry); state.retry = null
  await detachAll()
  const ws = state.ws
  state.ws = null            // 先摘引用：旧 socket 的 close 回调会被 isCurrent() 判为过期
  state.connected = false
  stopPing()
  try { ws?.close(1000, 'user disconnect') } catch { /* ignore */ }
  return status()
}

function scheduleReconnect() {
  clearTimeout(state.retry)
  state.retry = setTimeout(() => { connect().catch(() => {}) }, 5000)
}

let pingTimer = null
function startPing() {
  stopPing()
  // SW 保活：MV3 service worker 30s 空闲会被回收，WS 上持续有流量才能续命。
  // 我们自己每 20s 发一次 ping，host 回 pong。
  pingTimer = setInterval(() => { sendToHost({ type: 'ping', t: Date.now() }) }, 20000)
}
function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null } }

// ---- 弹窗消息面 -------------------------------------------------------------
const POPUP_API = {
  async status() { return status() },
  async connect() { await saveCfg({ autoConnect: true }); return await connect() },
  async disconnect() { return await disconnect() },
  async save(patch) {
    const p = { ...(patch || {}) }
    if (p.port !== undefined) p.port = Math.max(1024, Math.min(65535, Number(p.port) || 9760))
    if (typeof p.token === 'string') p.token = p.token.trim()
    await saveCfg(p)
    return status()
  },
  async tabs() {
    const tabs = await listTabs()
    return tabs.filter((t) => t.id != null).map((t) => ({
      id: t.id, title: String(t.title || ''), url: String(t.url || ''),
      origin: originOf(t.url), allowed: isAllowed(t.url), active: !!t.active,
      attached: state.byTab.has(t.id),
    }))
  },
  async allow(origin) {
    const o = String(origin || '')
    if (o && !state.cfg.origins.includes(o)) await saveCfg({ origins: [...state.cfg.origins, o] })
    return status()
  },
  async revoke(origin) {
    const o = String(origin || '')
    await saveCfg({ origins: state.cfg.origins.filter((x) => x !== o) })
    for (const [sid, tabId] of [...state.sessions.entries()]) {
      const t = await chrome.tabs.get(tabId).catch(() => null)
      if (!t || originOf(t.url) === o) await detachSession(sid)
    }
    return status()
  },
  // 「允许当前所有标签页」：把当前所有 http(s) 标签页的 origin 去重后并入 origins。
  // 只动 origins，**不**打开 allowAll —— 等价于用户逐个点了「允许」，新增站点仍要再点。
  async allowTabs() {
    const tabs = await listTabs()
    const add = []
    for (const t of tabs) {
      const o = originOf(t.url)
      if (!/^https?:/.test(o)) continue          // chrome://、扩展页、about: 不参与
      if (state.cfg.origins.includes(o) || add.includes(o)) continue
      add.push(o)
    }
    if (add.length) await saveCfg({ origins: [...state.cfg.origins, ...add] })
    return { ...status(), added: add.length, addedOrigins: add }
  },
  // 「撤销全部授权」：清空 origins，并把只靠逐站点授权撑着的会话一并断掉
  async revokeAll() {
    const removed = [...state.cfg.origins]
    await saveCfg({ origins: [] })
    for (const [sid, tabId] of [...state.sessions.entries()]) {
      const t = await chrome.tabs.get(tabId).catch(() => null)
      if (!t || !isAllowed(t.url)) await detachSession(sid)
    }
    return { ...status(), removed: removed.length }
  },
  async allowAll(flag) {
    await saveCfg({ allowAll: !!flag })
    if (!flag) {
      // 关掉「全部允许」时，把不再被单独授权的标签页断掉
      for (const [sid, tabId] of [...state.sessions.entries()]) {
        const t = await chrome.tabs.get(tabId).catch(() => null)
        if (!t || !isAllowed(t.url)) await detachSession(sid)
      }
    }
    return status()
  },
  async detachAll() { await detachAll(); return status() },
  async setInput(flag) {
    await saveCfg({ allowInput: !!flag })
    note(flag ? '⚠ 已开启「允许操作」：agent 可以真点击/打字' : '已关闭「允许操作」')
    return status()
  },
  /** 允许 agent 关闭**它自己开的**标签页（你手动开的页面永远不在这个范围内）。 */
  async setCloseOwn(flag) {
    await saveCfg({ allowCloseOwn: !!flag })
    note(flag ? '已允许 agent 关闭它自己打开的标签页' : '已关闭：agent 连自己打开的标签页也不能关')
    return status()
  },
}

export function boot() {
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const fn = POPUP_API[String(msg?.type || '')]
    if (!fn) return false
    Promise.resolve(fn(msg.payload)).then((r) => reply({ ok: true, data: r })).catch((e) => reply({ ok: false, error: String(e?.message || e) }))
    return true
  })

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const sessionId = state.byTab.get(source.tabId)   // 无前缀
    if (!sessionId) return
    sendToHost({ type: 'event', sessionId: ext(sessionId), method, params })
  })
  chrome.debugger.onDetach.addListener((source, reason) => {
    const sessionId = state.byTab.get(source.tabId)   // 无前缀
    if (!sessionId) return
    state.sessions.delete(sessionId)
    state.byTab.delete(source.tabId)
    sendToHost({ type: 'detach', sessionId: ext(sessionId), reason })
    note(`调试器被移除：${reason}`)
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    state.ownedTabs.delete(tabId)                     // 页没了就别再记着它（自己关的、或被别人关的都一样）
    const sessionId = state.byTab.get(tabId)          // 无前缀
    if (!sessionId) return
    state.sessions.delete(sessionId)
    state.byTab.delete(tabId)
    sendToHost({ type: 'detach', sessionId: ext(sessionId), reason: 'tab-closed' })
  })
  chrome.alarms.create('bl-keepalive', { periodInMinutes: 0.5 })
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name !== 'bl-keepalive') return
    if (!state.connected && state.cfg.autoConnect) connect().catch(() => {})
  })
  loadCfg().then(() => { if (state.cfg.autoConnect && state.cfg.token) connect().catch(() => {}) })
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) boot()

export const __internals = { state, listTabs, attachTab, detachSession, detachAll, saveCfg, loadCfg, POPUP_API, KIND, KIND_NAME, ext, raw }
