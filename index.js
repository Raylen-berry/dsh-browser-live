// ============================================================================
// dsh-browser-live · Host half v0.3.0 —— 看得见的 Agent 浏览器（自研，不依赖 ego-lite）
//
// 灵感来自 dsh-ego-browser (MIT, Fisfzy)：把"agent 驱动真实浏览器 + 人实时观察/接管"
// 接进 DSH。区别在于本版**零裸 import**、零 vendored 运行时：
//   · 浏览器 = 本机 Chrome/Edge/Brave，用 --remote-debugging-port 直连 CDP；
//   · 登录态 = 持久 user-data-dir（$DSH_HOME/dsh-browser-live/chrome-profile）；
//   · 工具 = 17 个 browser_* 结构化工具（快照/点击/悬停轨迹/输入/上传/滚动/等待/截图/标签页/下载…）；
//   · 观察窗 = host 侧 /bl/* SSE 帧流 + 前端 client.js 浮动面板（鼠标键盘直接接管）。
//
// 与 link: 安装的兼容性：@deepseek-ai/dsh-tools 的 defineTool 按 bg-atelier 找 sharp 的
// 同款候选路径动态解析（裸 import → DSH_HOME profiles → require.resolve），全部失败
// 再退回本文件内置的 defineToolLite —— 装载永不因解析姿势而崩。
//
// 路由面（与现有插件互不重叠）：
//   GET  /bl/ping              健康检查 {ok, alive}
//   GET  /bl/state             观察窗状态：标签页/当前页/最近动作/下载/是否请求打开面板
//   GET  /bl/stream?fps&q      SSE：JPEG 帧 + 布局元数据（无查看者时零开销）
//   POST /bl/input             面板鼠标/键盘/滚轮 → CDP Input（坐标=CSS px，前端已映射）
//   GET  /bl/settings.json     读设置（fps/质量/无头/窗口/额外启动参数/Chrome 路径/代理/观察形态）
//   PUT  /bl/settings.json     写设置
//   GET  /bl/view              独立网页版观察窗（全屏/丢副屏用；liveView=standalone 时自动用它）
//   GET  /bl/download?file=    取下载目录里的文件（attachment，路径严格校验）
// ============================================================================

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-browser-live'
export const inject = ['tools', 'webServer']
export const version = '0.4.2'

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('payload too large')); req.destroy() } })
    req.on('end', () => { try { resolve(body.trim() === '' ? {} : JSON.parse(body)) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

// ---------------------------------------------------------------- settings

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
const BASE_DIR = () => path.join(dshHome(), 'dsh-browser-live')
const SETTINGS_FILE = () => path.join(BASE_DIR(), 'settings.json')
const STATE_FILE = () => path.join(BASE_DIR(), 'state.json')
const CHROME_PROFILE = () => path.join(BASE_DIR(), 'chrome-profile')
const DOWNLOADS_DIR = () => path.join(BASE_DIR(), 'downloads')
const SHOTS_DIR = () => path.join(BASE_DIR(), 'shots')

const DEFAULT_SETTINGS = Object.freeze({
  fps: 2,            // 观察窗帧率（0.5~10）
  quality: 60,       // SSE JPEG 质量（20~90）
  headless: false,   // true 时 Chrome 无头（观察窗看的是虚拟页面）
  windowSize: '1440,900',
  chromePath: '',    // 空=自动探测
  extraArgs: '',     // 追加到 Chrome 命令行的空格分隔参数
  proxy: '',         // Chrome --proxy-server，例 http://127.0.0.1:7890 / socks5://127.0.0.1:1080；空=跟随系统
  liveView: 'panel', // panel=DSH 内嵌观察窗；standalone=独立网页 /bl/view（可丢到副屏/全屏）
  maxTabsWarn: 12,
  humanize: true,    // agent 鼠标移动走拟人轨迹（贝塞尔+缓动+抖动）；接管面板的实时转发不受影响
  humanSpeed: 1,     // 轨迹速度倍率（0.3~4）：越大越快越不像人，1≈0.25~0.45s 中等距离
})

let settings = { ...DEFAULT_SETTINGS }
function loadSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE(), 'utf8'))
    settings = sanitizeSettings(raw)
  } catch { /* 首用默认 */ }
}
function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS }
  if (raw && typeof raw === 'object') {
    if (Number.isFinite(raw.fps)) s.fps = clamp(raw.fps, 0.5, 10)
    if (Number.isFinite(raw.quality)) s.quality = clamp(raw.quality, 20, 90)
    if (typeof raw.headless === 'boolean') s.headless = raw.headless
    if (typeof raw.windowSize === 'string' && /^\d{3,4},\d{3,4}$/.test(raw.windowSize.trim())) s.windowSize = raw.windowSize.trim()
    if (typeof raw.chromePath === 'string' && raw.chromePath.length < 512) s.chromePath = raw.chromePath
    if (typeof raw.extraArgs === 'string' && raw.extraArgs.length < 2000) s.extraArgs = raw.extraArgs
    if (typeof raw.proxy === 'string' && raw.proxy.length < 512) s.proxy = raw.proxy.trim()
    if (raw.liveView === 'standalone' || raw.liveView === 'panel') s.liveView = raw.liveView
    if (typeof raw.humanize === 'boolean') s.humanize = raw.humanize
    if (Number.isFinite(raw.humanSpeed)) s.humanSpeed = clamp(raw.humanSpeed, 0.3, 4)
  }
  return s
}
function saveSettings() {
  try { mkdirSync(BASE_DIR(), { recursive: true }); writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8') } catch (e) { console.warn('[dsh-browser-live] 设置写入失败:', e?.message) }
}

// ---------------------------------------------------------------- defineTool 解析（bg-atelier 同款候选姿势）

async function loadDefineTool() {
  const candidates = ['@deepseek-ai/dsh-tools']
  try {
    candidates.push(pathToFileURL(path.join(dshHome(), 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href)
    const appNm = path.join(path.dirname(process.execPath), '..', '..')
    candidates.push(pathToFileURL(path.join(appNm, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href)
  } catch { /* ignore */ }
  for (const c of candidates) {
    try {
      const m = await import(c)
      if (m && typeof m.defineTool === 'function') return m.defineTool
    } catch { /* try next */ }
  }
  console.warn('[dsh-browser-live] defineTool 不可解析，使用内置 lite 实现')
  return defineToolLite
}

/** 与 defineTool 兼容的最小实现：编译同一套参数方言（属性内 required:true → 顶层 required 数组）。 */
function defineToolLite(options) {
  const compile = (spec) => {
    if (!spec || typeof spec !== 'object') return spec
    const { required, ...rest } = spec
    if (rest.type === 'object' && rest.properties) {
      const props = {}; const req = []
      for (const [k, v] of Object.entries(rest.properties)) {
        const c = compile(v)
        props[k] = c
        if (v && v.required === true) req.push(k)
      }
      return { ...rest, properties: props, ...(req.length ? { required: req } : {}) }
    }
    if (rest.items) return { ...rest, items: compile(rest.items) }
    return rest
  }
  const parameters = { type: 'object', ...compile({ type: 'object', properties: options.parameters || {} }) }
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output && options.output.schema ? options.output.schema : { type: 'object' },
      render: options.output && options.output.render ? options.output.render : (_a, v) => [{ type: 'text', text: JSON.stringify(v).slice(0, 4000) }],
    },
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    async execute(args, exec) { return options.execute(args, exec) },
  }
}

// ---------------------------------------------------------------- CDP client
// 传输层：优先 npm 'ws'（Chrome DevTools 实战最稳，禁 permessage-deflate 避开
// Node 内置 undici WebSocket 与 Chrome 的 1006 互操作坑）；解析不到再退回全局 WebSocket。

async function loadWs() {
  const candidates = ['ws']
  try { candidates.push(pathToFileURL(path.join(dshHome(), 'profiles', 'node_modules', 'ws', 'index.js')).href) } catch { /* ignore */ }
  try {
    // ① exe 在 <app>/node_modules/node/bin → 上两级即 <app>/node_modules
    const appNm = path.join(path.dirname(process.execPath), '..', '..')
    candidates.push(pathToFileURL(path.join(appNm, 'ws', 'index.js')).href)
  } catch { /* ignore */ }
  try {
    // ② DSH_HOME 被改时，桌面版默认 Roaming 位置兜底
    if (process.env.APPDATA) candidates.push(pathToFileURL(path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'node_modules', 'ws', 'index.js')).href)
  } catch { /* ignore */ }
  for (const c of candidates) {
    try { const m = await import(c); const W = m && (m.default || m); if (typeof W === 'function') return W } catch { /* next */ }
  }
  return null
}

function makeSock(url, WS) {
  if (WS) {
    const s = new WS(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    return {
      onOpen: (f) => s.on('open', f), onClose: (f) => s.on('close', f),
      onError: (f) => s.on('error', f), onMsg: (f) => s.on('message', (d) => f({ data: typeof d === 'string' ? d : d.toString('utf8') })),
      send: (x) => s.send(x), close: () => { try { s.close() } catch { /* ignore */ } },
      get state() { return s.readyState },
    }
  }
  const s = new globalThis.WebSocket(url)
  return {
    onOpen: (f) => { s.onopen = f }, onClose: (f) => { s.onclose = f },
    onError: (f) => { s.onerror = f }, onMsg: (f) => { s.onmessage = f },
    send: (x) => s.send(x), close: () => { try { s.close() } catch { /* ignore */ } },
    get state() { return s.readyState },
  }
}

class Cdp {
  constructor(wsUrl, WS) {
    this.wsUrl = wsUrl
    this.WS = WS || null
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map() // event -> Set<fn>
    this.sock = null
    this.alive = false
    this.connectPromise = null
  }
  connect(timeoutMs = 8000) {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = new Promise((resolve, reject) => {
      const sock = makeSock(this.wsUrl, this.WS)
      this.sock = sock
      let opened = false
      const timer = setTimeout(() => { sock.close(); reject(new Error('CDP 连接超时')) }, timeoutMs)
      sock.onOpen(() => {
        opened = true; clearTimeout(timer)
        this.alive = true
        resolve(this)
      })
      sock.onClose(() => {
        this.alive = false; clearTimeout(timer)
        if (!opened) { reject(new Error('CDP 无法连接')); return }
        for (const [, p] of this.pending) p.reject(new Error('CDP 连接已断开'))
        this.pending.clear()
      })
      sock.onError(() => { this.alive = false })
      sock.onMsg((ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(`${msg.error.message || 'CDP'} ${msg.error.data || ''}`.trim()))
            else p.resolve(msg.result)
          }
          return
        }
        if (msg.method) {
          const set = this.handlers.get(msg.method)
          if (set) for (const fn of set) { try { fn(msg.params || {}) } catch { /* handler 错误不外溢 */ } }
        }
      })
    })
    return this.connectPromise
  }
  send(method, params = {}, sessionId, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.state !== 1) return reject(new Error('CDP 未连接'))
      const id = this.nextId++
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)) }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event).add(fn)
    return () => this.handlers.get(event)?.delete(fn)
  }
  close() { this.alive = false; try { this.sock?.close() } catch {} }
}

// ---------------------------------------------------------------- browser manager

const KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 }, Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 }, End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 }, Space: { key: ' ', code: 'Space', vk: 32 },
  F1: { key: 'F1', code: 'F1', vk: 112 }, F2: { key: 'F2', code: 'F2', vk: 113 }, F3: { key: 'F3', code: 'F3', vk: 114 },
  F4: { key: 'F4', code: 'F4', vk: 115 }, F5: { key: 'F5', code: 'F5', vk: 116 }, F6: { key: 'F6', code: 'F6', vk: 117 },
  F7: { key: 'F7', code: 'F7', vk: 118 }, F8: { key: 'F8', code: 'F8', vk: 119 }, F9: { key: 'F9', code: 'F9', vk: 120 },
  F10: { key: 'F10', code: 'F10', vk: 121 }, F11: { key: 'F11', code: 'F11', vk: 122 }, F12: { key: 'F12', code: 'F12', vk: 123 },
}
// 大小写不敏感查表（parseKeys 会先小写化）
const KEY_LOOKUP = {}
for (const [k, v] of Object.entries(KEY_DEFS)) { KEY_LOOKUP[k.toLowerCase()] = v; KEY_LOOKUP[k] = v }

const browser = {
  proc: null,
  cdp: null,          // browser 级连接（flatten 会话都走它）
  port: 0,
  tabs: [],           // {targetId, sessionId, url, title, type}
  selected: null,     // targetId
  meta: { vw: 1280, vh: 800 },
  frameSeq: 0,
  actionLog: [],      // {t, label}
  panelWanted: false, // 客户端轮询：true 时自动弹观察窗
  downloads: [],      // {file, url, state, t}
  dying: false,
  WS: null,           // ws 包构造器（apply 时解析；null=退回全局 WebSocket）
  lastPos: null,      // 拟人轨迹的"笔尖"：上一次鼠标落点 {x,y}（CSS px）
}

async function probePort(port) {
  const r = await httpGetJson(`http://127.0.0.1:${port}/json/version`)
  return r && r.json && r.json.webSocketDebuggerUrl ? r.json.webSocketDebuggerUrl : null
}

function findChrome() {
  const tries = []
  if (settings.chromePath) tries.push(settings.chromePath)
  if (process.env.DSH_BROWSER_LIVE_CHROME) tries.push(process.env.DSH_BROWSER_LIVE_CHROME)
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles (x86)'] || 'C:\\Program Files (x86)'
  const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  tries.push(
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  )
  for (const t of tries) { try { if (t && existsSync(t)) return t } catch {} }
  return null
}

function parseExtraArgs(s) {
  if (!s || !s.trim()) return []
  return s.trim().split(/\s+/).filter(Boolean)
}

async function attachCdp(wsUrl) {
  const cdp = new Cdp(wsUrl, browser.WS)
  await cdp.connect()
  cdp.on('Browser.downloadWillBegin', (p) => {
    browser.downloads.push({ id: p.guid, file: p.suggestedFilename, url: (p.url || '').slice(0, 200), state: 'started', t: Date.now() })
    browser.downloads = browser.downloads.slice(-40)
    noteAction('下载开始 ' + p.suggestedFilename)
  })
  cdp.on('Browser.downloadProgress', (p) => {
    const d = browser.downloads.find((x) => x.id === p.guid)
    if (d) d.state = p.state === 'completed' ? 'done' : p.state === 'canceled' ? 'canceled' : 'progress'
  })
  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS_DIR(), eventsEnabled: true })
  } catch { /* 老版本浏览器没有 eventsEnabled */ }
  browser.cdp = cdp
}

async function launch() {
  mkdirSync(BASE_DIR(), { recursive: true })
  mkdirSync(CHROME_PROFILE(), { recursive: true })
  mkdirSync(DOWNLOADS_DIR(), { recursive: true })
  mkdirSync(SHOTS_DIR(), { recursive: true })

  // 先看看是不是已有活的 CDP（上次宿主没退干净/手动起的）
  try {
    const last = JSON.parse(readFileSync(STATE_FILE(), 'utf8'))
    if (last && last.port) {
      const ws = await probePort(last.port)
      if (ws) {
        browser.port = last.port
        await attachCdp(ws)
        await refreshTabs().catch(() => {})
        console.log(`[dsh-browser-live] 接管已运行中的浏览器（:${last.port}）`)
        return
      }
    }
  } catch { /* 无状态文件 */ }

  const exe = findChrome()
  if (!exe) throw new Error('未找到 Chrome/Edge/Brave；在设置里填 chromePath，或装一个 Chromium')
  const port = 9600 + Math.floor(Math.random() * 300)
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${CHROME_PROFILE()}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${settings.windowSize}`,
    // 代理：独立实例也走你指定的出口（http://host:port / socks5://host:port）；留空=跟随系统
    ...(settings.proxy ? [`--proxy-server=${settings.proxy}`] : []),
    ...parseExtraArgs(settings.extraArgs),
    ...(settings.headless ? ['--headless=new'] : []),
    'about:blank',
  ]
  browser.proc = spawn(exe, args, { stdio: 'ignore', detached: false })
  browser.proc.on('exit', () => { browser.proc = null })
  let ws = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    ws = await probePort(port)
    if (ws) break
  }
  if (!ws) { try { browser.proc.kill() } catch {}; throw new Error('Chrome 未响应 CDP 端口（可能被安全软件拦截）') }
  browser.port = port
  writeFileSync(STATE_FILE(), JSON.stringify({ port }), 'utf8')
  await attachCdp(ws)
  console.log(`[dsh-browser-live] 浏览器已启动（${path.basename(exe)} :${port}）`)
}

async function shutdown(kill) {
  browser.dying = true
  try { browser.cdp?.send('Browser.close', {}).catch(() => {}) } catch {}
  await sleep(150)
  try { if (kill && browser.proc) browser.proc.kill() } catch {}
  try { browser.cdp?.close() } catch {}
  browser.cdp = null; browser.proc = null; browser.tabs = []; browser.selected = null
  browser.dying = false
}

function alive() {
  return !!(browser.cdp && browser.cdp.alive)
}

async function refreshTabs() {
  const { targetInfos } = await browser.cdp.send('Target.getTargets', {})
  const pages = targetInfos.filter((t) => t.type === 'page')
  // 丢弃已消失的本地 tab 记录
  browser.tabs = browser.tabs.filter((t) => pages.some((p) => p.targetId === t.targetId))
  for (const p of pages) {
    if (!browser.tabs.find((t) => t.targetId === p.targetId)) browser.tabs.push({ targetId: p.targetId, sessionId: null, url: p.url || '', title: p.title || '' })
    else { const t = browser.tabs.find((x) => x.targetId === p.targetId); t.url = p.url || t.url; t.title = p.title || t.title }
  }
  if (!browser.tabs.length || (browser.selected && !browser.tabs.find((t) => t.targetId === browser.selected))) browser.selected = browser.tabs[0]?.targetId || null
  return browser.tabs
}

async function waitTargetGone(targetId, tries = 12) {
  // Target.closeTarget 是异步生效的：轮询确认它真的从 getTargets 消失，避免"刚关完就列表"竞态
  for (let i = 0; i < tries; i++) {
    await refreshTabs()
    if (!browser.tabs.some((t) => t.targetId === targetId)) return
    await sleep(120)
  }
}

async function attachTab(tab) {
  if (tab.sessionId) return tab
  const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true })
  tab.sessionId = sessionId
  const cdp = browser.cdp
  await cdp.send('Page.enable', {}, sessionId).catch(() => {})
  await cdp.send('Runtime.enable', {}, sessionId).catch(() => {})
  await cdp.send('DOM.enable', {}, sessionId).catch(() => {})
  try { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS_DIR(), eventsEnabled: true }, sessionId) } catch {}
  // 标签页 URL/标题变化 → 同步状态
  cdp.on('Page.javascriptDialogOpening', (p) => {
    if (p.sessionId === sessionId) noteAction('⚠ 页面弹出对话框：' + (p.message || p.type))
  })
  return tab
}

async function selectedTab() {
  if (!alive()) throw new Error('浏览器未运行；先 browser_open')
  await refreshTabs()
  if (!browser.tabs.length) {
    const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' })
    browser.tabs.push({ targetId, sessionId: null, url: 'about:blank', title: '' })
    browser.selected = targetId
  }
  if (!browser.selected) browser.selected = browser.tabs[0].targetId
  const tab = browser.tabs.find((t) => t.targetId === browser.selected)
  await attachTab(tab)
  return tab
}

async function evaluate(tab, expression, awaitIt = false) {
  const r = await browser.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitIt }, tab.sessionId)
  if (r.exceptionDetails) throw new Error('页面内脚本异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'unknown').split('\n')[0].slice(0, 300))
  return r.result?.value
}

function noteAction(label) {
  browser.actionLog.push({ t: Date.now(), label })
  if (browser.actionLog.length > 50) browser.actionLog.shift()
}

let lockChain = Promise.resolve()
function withLock(fn) {
  const run = lockChain.then(fn, fn)
  lockChain = run.then(() => {}, () => {})
  return run
}

async function updateMeta(tab) {
  try {
    const m = await browser.cdp.send('Page.getLayoutMetrics', {}, tab.sessionId)
    const v = m.cssVisualViewport || m.visualViewport || {}
    if (v.clientWidth && v.clientHeight) browser.meta = { vw: v.clientWidth, vh: v.clientHeight }
  } catch { /* keep last */ }
  return browser.meta
}

// ------------------------------------------------------------- page scripts
// 统一用 Runtime.callFunctionOn（函数声明 + 参数数组），杜绝字符串拼括号的失衡风险。

const SNAPSHOT_FN = `function(){
function vis(e){var r=e.getBoundingClientRect();var s=window.getComputedStyle(e);return r.width>1&&r.height>1&&s.visibility!=="hidden"&&s.display!=="none"&&parseFloat(s.opacity||"1")>0.02;}
var sel="a[href],button,input,textarea,select,summary,[role=\\"button\\"],[role=\\"link\\"],[role=\\"textbox\\"],[role=\\"checkbox\\"],[role=\\"tab\\"],[onclick],[tabindex=\\"0\\"]";
var nodes=Array.prototype.slice.call(document.querySelectorAll(sel)).filter(vis).slice(0,140);
window.__BL_REFS={};var els=[];
nodes.forEach(function(e,i){var id=String(i+1);window.__BL_REFS[id]=e;var r=e.getBoundingClientRect();
var txt=(e.innerText||e.value||e.getAttribute("placeholder")||e.getAttribute("aria-label")||e.getAttribute("title")||e.getAttribute("alt")||"").trim().replace(/\\s+/g," ").slice(0,64);
els.push({ref:id,tag:e.tagName.toLowerCase(),type:(e.getAttribute("type")||""),text:txt,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});});
var bodyText=document.body?(document.body.innerText||""):"";
return {url:location.href,title:document.title,vw:window.innerWidth,vh:window.innerHeight,scrollY:Math.round(window.scrollY||0),docHeight:document.documentElement.scrollHeight,elements:els,text:bodyText.slice(0,2600),textMore:bodyText.length>2600};
}`

const REF_CENTER_FN = `function(id){var e=window.__BL_REFS&&window.__BL_REFS[id];if(!e||!e.isConnected)return {error:"ref 失效，请重新 browser_snapshot"};e.scrollIntoView({block:"center",inline:"center"});var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:(e.innerText||e.value||"").trim().slice(0,60)};}`

const SELECTOR_CENTER_FN = `function(css){var e=document.querySelector(css);if(!e)return {error:"选择器没有命中元素"};e.scrollIntoView({block:"center",inline:"center"});var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}`

const FOCUS_FN = `function(id){var e=window.__BL_REFS&&window.__BL_REFS[id];if(!e||!e.isConnected)return {error:"ref 失效，请重新 browser_snapshot"};e.scrollIntoView({block:"center",inline:"center"});e.focus();var tag=e.tagName.toLowerCase();if((tag==="input"||tag==="textarea")&&typeof e.select==="function"&&e.type!=="password"&&e.type!=="file"&&!e.readOnly)e.select();return {ok:true,tag:tag};}`

// browser_upload 用：把"上传按钮/拖拽区/自定义 React 组件"解析成真正的 <input type=file>
// 并打上 data-bl-up 标记（隐藏 input 也算——Meta 等后台的上传区多是 label/button 包着的隐藏 input）。
// 返回 {ok,input:{...}} 或 {error,...}；找不到时返回页面上全部 file input 的候选清单供重试。
const RESOLVE_FILE_INPUT_FN = `function(kind,key){
function isFile(e){return e&&e.tagName==="INPUT"&&e.type==="file"}
function searchNear(e){if(!e||!e.isConnected)return null;if(isFile(e))return e;var own=e.querySelector?e.querySelector("input[type=file]"):null;if(own)return own;var lab=e.closest?e.closest("label"):null;if(lab){var li=lab.querySelector?lab.querySelector("input[type=file]"):null;if(li)return li}var p=e;for(var i=0;i<4;i++){p=p&&p.parentElement;if(!p)break;if(isFile(p))return p;var q=p.querySelector?p.querySelector("input[type=file]"):null;if(q)return q}return null}
function vis(e){var r=e.getBoundingClientRect();var s=window.getComputedStyle(e);return r.width>1&&r.height>1&&s.display!=="none"&&s.visibility!=="hidden"}
document.querySelectorAll("input[data-bl-up]").forEach(function(n){n.removeAttribute("data-bl-up")});
var all=Array.prototype.slice.call(document.querySelectorAll("input[type=file]"));
var t=null;
if(kind==="ref"){t=searchNear(window.__BL_REFS&&window.__BL_REFS[key])}
else if(kind==="selector"){t=searchNear(document.querySelector(key))}
if(!t&&all.length){t=all.filter(vis)[0]||all[0]}
if(!t)return {error:"页面没有 <input type=file>（可能是纯 DnD 上传区，未支持）",count:0}
t.setAttribute("data-bl-up","1");
var cur="";try{cur=Array.prototype.slice.call(t.files).map(function(f){return f.name}).join(",")}catch(e){}
return {ok:true,count:all.length,matched:all.indexOf(t),multiple:!!t.multiple,accept:t.accept||"",current:cur,via:kind==="none"?"auto":kind};
}`

async function callOnPage(tab, functionDeclaration, args = []) {
  // Runtime.evaluate + IIFE 包装：函数源用模板字面量书写，参数逐个 JSON 转义，无手工括号失衡风险，
  // 也免去 callFunctionOn 的 executionContextId 要求。
  const expr = '(' + functionDeclaration + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')'
  return evaluate(tab, expr)
}

// ------------------------------------------------------------- CDP input helpers

async function dispatchMouse(tab, type, x, y, opts = {}) {
  const params = {
    type, x: Math.round(x), y: Math.round(y),
    button: opts.button || 'left',
    clickCount: opts.clickCount ?? (type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0),
    buttons: opts.buttons ?? (type === 'mousePressed' ? 1 : 0),
  }
  if (type === 'mouseWheel') { params.deltaX = opts.deltaX || 0; params.deltaY = opts.deltaY || 0; params.clickCount = 0 }
  await browser.cdp.send('Input.dispatchMouseEvent', params, tab.sessionId)
}

// ------------------------------------------------------------- 拟人鼠标轨迹
// 人手动标的特征：① 非直线（先快后慢的弧线）② 两端慢中间快（缓动）
// ③ 垂直方向的低频抖动（越接近目标越小）④ 偶发微停顿。
// 用三次贝塞尔 + easeInOut + 随进度衰减的正视抖动 + 步间随机/偶发停顿建模。
// instant=true（如接管面板的实时转发）时退回单点直达，绝不多插帧拖慢手感。

function lerp(a, b, t) { return a + (b - a) * t }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 }

async function humanMove(tab, toX, toY, { instant = false, steps, button = 'none' } = {}) {
  const from = browser.lastPos || { x: Math.round(browser.meta.vw / 2), y: Math.round(browser.meta.vh / 2) }
  const dx = toX - from.x, dy = toY - from.y
  const dist = Math.hypot(dx, dy)
  if (instant || !settings.humanize || dist < 6) {
    await dispatchMouse(tab, 'mouseMoved', toX, toY, { button, buttons: button === 'none' ? 0 : 1 })
    browser.lastPos = { x: toX, y: toY }
    return { moved: true, interpolated: false, dist: Math.round(dist) }
  }
  // 距离越远步数越多，夹在 8~26；垂直振幅随距离增长但封顶，且终点收敛到 ~1px
  const n = steps || clamp(Math.round(dist / 22) + 6, 8, 26)
  const amp = clamp(dist * 0.16, 6, 46)
  // 弧顶侧向偏移的随机符号，让每次轨迹略有不同
  const sgn = Math.random() < 0.5 ? -1 : 1
  // 两次"犹豫"停顿的插入位置（相对步序号）
  const pauseAt = Math.random() < 0.5 ? Math.floor(n * (0.4 + Math.random() * 0.3)) : -1
  // 三个抖动频率，制造低频摆动而非高频噪声
  const f1 = 1 + Math.random() * 2, f2 = 2 + Math.random() * 3
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const e = easeInOut(t)
    // 沿直线的基础位置
    let x = lerp(from.x, toX, e)
    let y = lerp(from.y, toY, e)
    // 垂直方向 (−dy,dx)/dist，正弦×钟形包络(两端→0)叠加正弦 → 自然蛇形，终点精确收敛
    const nx = -dy / dist, ny = dx / dist
    const env = Math.sin(Math.PI * t)                    // 钟形：两端 0、中间 1
    const wig = Math.sin(t * Math.PI * f1) * 0.7 + Math.sin(t * Math.PI * f2 + 1) * 0.3
    const off = sgn * amp * env * wig
    x += nx * off
    y += ny * off
    // 最后一步强制精确落点
    if (i === n) { x = toX; y = toY }
    await dispatchMouse(tab, 'mouseMoved', x, y, { button, buttons: button === 'none' ? 0 : 1 })
    let d = 8 + Math.random() * 8 + (1 - env) * 6
    if (i === pauseAt) d += 60 + Math.random() * 90
    await sleep(d)
  }
  browser.lastPos = { x: toX, y: toY }
  return { moved: true, interpolated: true, steps: n, dist: Math.round(dist) }
}

async function clickXY(tab, x, y, { button = 'left', clicks = 1, instant = false } = {}) {
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1
  await humanMove(tab, x, y, { instant })
  await dispatchMouse(tab, 'mousePressed', x, y, { button, clickCount: clicks, buttons })
  await sleep(35 + Math.random() * 35)
  await dispatchMouse(tab, 'mouseReleased', x, y, { button, clickCount: clicks, buttons: 0 })
}

const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const MOD_KEYS = {
  alt: { key: 'Alt', code: 'AltLeft', vk: 18 }, ctrl: { key: 'Control', code: 'ControlLeft', vk: 17 },
  meta: { key: 'Meta', code: 'MetaLeft', vk: 91 }, cmd: { key: 'Meta', code: 'MetaLeft', vk: 91 },
  super: { key: 'Meta', code: 'MetaLeft', vk: 91 }, shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
}

function parseKeys(spec) {
  const parts = String(spec || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) throw new Error('press 的 keys 不能为空，如 "Enter" / "ctrl+l"')
  const mods = []
  let main = parts[parts.length - 1]
  for (const p of parts.slice(0, -1)) { if (!(p in MOD_KEYS)) throw new Error('不支持的修饰键: ' + p); mods.push(p) }
  const mdef = MOD_KEYS[main]
  let keyDef
  if (mdef) keyDef = mdef
  else if (KEY_LOOKUP[main]) keyDef = KEY_LOOKUP[main]
  else if (main.length === 1) keyDef = { key: main, code: /^[a-z]$/.test(main) ? 'Key' + main.toUpperCase() : main, vk: main.toUpperCase().charCodeAt(0) }
  else throw new Error('未知按键: ' + spec)
  let mask = 0
  for (const m of mods) mask |= MOD_BITS[m === 'cmd' || m === 'super' ? 'meta' : m]
  return { mods, main: keyDef, mask, single: !mods.length }
}

async function pressKeys(tab, spec) {
  const { mods, main, mask, single } = parseKeys(spec)
  if (single && main.key.length === 1) { await browser.cdp.send('Input.insertText', { text: main.key }, tab.sessionId); return }
  const code = main.code || ''
  const vk = main.vk || 0
  for (const m of mods) await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: MOD_KEYS[m].key, code: MOD_KEYS[m].code, windowsVirtualKeyCode: MOD_KEYS[m].vk, nativeVirtualKeyCode: MOD_KEYS[m].vk, modifiers: mask }, tab.sessionId)
  await browser.cdp.send('Input.dispatchKeyEvent', { type: main.key.length === 1 ? 'keyDown' : 'rawKeyDown', key: main.key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mask, ...(main.key === 'Enter' ? { text: '\r' } : {}) }, tab.sessionId)
  await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: main.key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mask }, tab.sessionId)
  for (const m of [...mods].reverse()) await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: MOD_KEYS[m].key, code: MOD_KEYS[m].code, windowsVirtualKeyCode: MOD_KEYS[m].vk, nativeVirtualKeyCode: MOD_KEYS[m].vk, modifiers: mask ^ (MOD_BITS[m === 'cmd' || m === 'super' ? 'meta' : m]) }, tab.sessionId)
}

async function typeText(tab, text, { enter = false, submitKey = 'Enter' } = {}) {
  await browser.cdp.send('Input.insertText', { text }, tab.sessionId)
  if (enter) await pressKeys(tab, submitKey)
}

async function captureJpeg(tab, quality) {
  const r = await browser.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: clamp(quality, 10, 95) }, tab.sessionId, 15000)
  return r.data
}

// ------------------------------------------------------------- tool plumbing

function brief(args) {
  const s = JSON.stringify(args || {})
  return s.length > 60 ? s.slice(0, 57) + '...' : s
}
const txt = (t) => [{ type: 'text', text: t }]

function makeTool(definer) {
  /** 统一注册入口：lock + action 日志 + 自动拉起浏览器 */
  function tool({ name: tname, description, parameters, execute, autostart = true }) {
    return definer({
      name: tname,
      description,
      parameters,
      output: { schema: { type: 'string' }, render: (_a, v) => txt(typeof v === 'string' ? v : safeJson(v)) },
      presentCall: (args) => ({ card: 'generic', title: tname, kind: 'other', rawInput: args }),
      async execute(args, exec) {
        return withLock(async () => {
          try {
            if (!alive()) {
              if (!autostart) return safeJson({ ok: false, error: '浏览器未运行' })
              browser.panelWanted = true   // 冷启动才请求弹观察窗（客户端 ack 后清除）
              await launch()
            }
            noteAction(tname + ' ' + brief(args))
            const r = await execute(args, exec || {})
            return typeof r === 'string' ? r : safeJson(r)
          } catch (e) {
            return safeJson({ ok: false, error: String(e?.message || e), note: '本次调用失败；若浏览器掉线会自动在下次调用重连，必要时先 browser_open' })
          }
        })
      },
    })
  }
  return tool
}

function safeJson(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 0)
  return s.length > 24000 ? s.slice(0, 24000) + '\n…(截断，必要时用 browser_eval 取局部)' : s
}

// ------------------------------------------------------------- tools

function buildTools(t) {
  const tools = []

  tools.push(t({
    name: 'browser_open',
    description: '启动/接管浏览器（懒启动，profile 持久保留登录态）。给 url 则新开或导航该页；不给则确保浏览器在跑并返回当前标签页。第一次调用后网页会实时出现在右下角观察窗里，用户可随时接管。',
    parameters: { url: { type: 'string', description: '可选，要打开的 URL' }, newTab: { type: 'boolean', description: 'true=新开标签页（默认在当前页导航）' } },
    async execute(args) {
      if (!alive()) await launch()
      const tab = await selectedTab()
      if (args.url) {
        if (args.newTab) { const { targetId } = await browser.cdp.send('Target.createTarget', { url: args.url }); browser.selected = targetId; await refreshTabs(); await attachTab(browser.tabs.find((x) => x.targetId === targetId)) }
        else { await gotoUrl(tab, args.url) }
      } else if (/^about:blank$/.test(tab.url || '')) {
        await gotoUrl(tab, 'about:blank')
      }
      await refreshTabs()
      const cur = browser.tabs.find((x) => x.targetId === browser.selected)
      return { ok: true, url: cur?.url, title: cur?.title, tabs: browser.tabs.length }
    },
  }))

  tools.push(t({
    name: 'browser_close',
    description: '关闭浏览器（不删用户数据目录，登录态保留）。任务做完后调用。',
    parameters: {},
    autostart: false,
    async execute() {
      if (!alive()) return { ok: true, note: '浏览器本来就没在跑' }
      await shutdown(true)
      return { ok: true }
    },
  }))

  tools.push(t({
    name: 'browser_navigate',
    description: '导航到 URL（自动等加载完成）。',
    parameters: { url: { type: 'string', required: true, description: '目标 URL；无 scheme 时自动补 https://' } },
    async execute(args) { const tab = await selectedTab(); return gotoUrl(tab, args.url) },
  }))

  tools.push(t({
    name: 'browser_snapshot',
    description: '抓取页面结构化快照：URL/标题/可视区尺寸 + 可见交互元素清单（编号 ref、tag、文本、中心坐标）+ 正文节选。点击/输入前必须先拿 ref；坐标点击不需要。',
    parameters: {},
    async execute() {
      const tab = await selectedTab()
      const snap = await callOnPage(tab, SNAPSHOT_FN)
      if (snap && snap.vw) browser.meta = { vw: snap.vw, vh: snap.vh }
      return snap
    },
  }))

  tools.push(t({
    name: 'browser_click',
    description: '真实鼠标点击。三选一：ref=快照编号（自动 scrollIntoView+元素中心）；selector=CSS 选择器；x/y=页面 CSS 坐标。button: left|right|middle；double=true 双击。',
    parameters: {
      ref: { type: 'string', description: 'browser_snapshot 里的元素编号' },
      selector: { type: 'string', description: 'CSS 选择器（ref 之后页面变动时用）' },
      x: { type: 'number', description: '页面 CSS 横坐标' },
      y: { type: 'number', description: '页面 CSS 纵坐标' },
      button: { type: 'string', description: 'left(默认)/right/middle' },
      double: { type: 'boolean', description: 'true=双击' },
      instant: { type: 'boolean', description: 'true=鼠标瞬移过去（默认走拟人轨迹）' },
    },
    async execute(args) {
      const tab = await selectedTab()
      let x = args.x, y = args.y
      if (args.ref != null && args.ref !== '') { const r = await callOnPage(tab, REF_CENTER_FN, [String(args.ref)]); if (r.error) return r; x = r.x; y = r.y }
      else if (args.selector) { const r = await callOnPage(tab, SELECTOR_CENTER_FN, [String(args.selector)]); if (r.error) return r; x = r.x; y = r.y }
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要 ref / selector / x+y 三者之一')
      await clickXY(tab, x, y, { button: args.button, clicks: args.double ? 2 : 1, instant: !!args.instant })
      await sleep(250) // 让点击触发的跳转/重绘先起飞
      await refreshTabs()
      const cur = browser.tabs.find((z) => z.targetId === browser.selected)
      return { ok: true, at: [x, y], url: cur?.url, title: cur?.title }
    },
  }))

  tools.push(t({
    name: 'browser_move',
    description: '把鼠标移到目标处（默认走拟人轨迹）：触发 :hover、下拉菜单、tooltip 用这个。ref/selector/坐标三选一；hold=true 按住左键移动（拖拽起手）；instant=true 瞬移跳过轨迹。',
    parameters: {
      ref: { type: 'string', description: 'browser_snapshot 元素编号' },
      selector: { type: 'string', description: 'CSS 选择器' },
      x: { type: 'number', description: '页面 CSS 横坐标' },
      y: { type: 'number', description: '页面 CSS 纵坐标' },
      hold: { type: 'boolean', description: 'true=按住左键移动（配合后续 click/release 场景）' },
      instant: { type: 'boolean', description: 'true=瞬移（默认拟人）' },
    },
    async execute(args) {
      const tab = await selectedTab()
      let x = args.x, y = args.y
      if (args.ref != null && args.ref !== '') { const r = await callOnPage(tab, REF_CENTER_FN, [String(args.ref)]); if (r.error) return r; x = r.x; y = r.y }
      else if (args.selector) { const r = await callOnPage(tab, SELECTOR_CENTER_FN, [String(args.selector)]); if (r.error) return r; x = r.x; y = r.y }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '需要 ref / selector / x+y 三者之一' }
      const m = await humanMove(tab, x, y, { instant: !!args.instant, button: args.hold ? 'left' : 'none' })
      return { ok: true, at: [Math.round(x), Math.round(y)], path: m.interpolated ? 'humanized' : 'instant', steps: m.steps || 1, held: !!args.hold }
    },
  }))

  tools.push(t({
    name: 'browser_type',
    description: '往输入框打字：给 ref 时先 scrollIntoView+focus+全选（清掉选中值），再插入 text；enter=true 在末尾补发回车（提交/确认）。粘贴大段文本也走这个。',
    parameters: {
      ref: { type: 'string', description: '输入框的快照编号（先 browser_snapshot）' },
      text: { type: 'string', required: true, description: '要输入的文本' },
      enter: { type: 'boolean', description: '输入后回车（默认 false）' },
    },
    async execute(args) {
      const tab = await selectedTab()
      if (args.ref != null && args.ref !== '') { const f = await callOnPage(tab, FOCUS_FN, [String(args.ref)]); if (f.error) return f }
      await typeText(tab, String(args.text ?? ''), { enter: !!args.enter })
      await sleep(150)
      return { ok: true, typed: String(args.text ?? '').length, enter: !!args.enter }
    },
  }))

  tools.push(t({
    name: 'browser_upload',
    description: '给页面文件上传控件塞入本机文件（CDP DOM.setFileInputFiles，不弹系统对话框）。ref/selector 可指上传按钮、拖拽区或自定义组件容器——自动解析其内部/label/祖先容器里的隐藏 <input type=file>（Meta Ads 等后台的 React 上传组件就是这么命中的）；不给则取页面第一个可见 file input。会触发页面 change/input 事件；大文件传完后用 browser_wait 等"上传完成/处理中"等状态文字。',
    parameters: {
      files: { type: 'array', required: true, items: { type: 'string' }, description: '要上传的本机文件绝对路径，JSON 数组（单个文件也要包一层数组，如 ["D:\\\\assets\\\\a.png"]）' },
      ref: { type: 'string', description: 'browser_snapshot 元素编号（上传区非 input 也没关系）' },
      selector: { type: 'string', description: 'CSS 选择器，指向上传区域' },
    },
    async execute(args) {
      const tab = await selectedTab()
      const raw = Array.isArray(args.files) ? args.files : (args.files ? [args.files] : [])
      const abs = raw.map((f) => path.resolve(String(f))).filter(Boolean)
      if (!abs.length) return { ok: false, error: 'files 为空' }
      const missing = abs.filter((f) => !existsSync(f))
      if (missing.length) return { ok: false, error: '文件不存在：' + missing.join(' , ') }
      const kind = args.ref != null && args.ref !== '' ? 'ref' : (args.selector ? 'selector' : 'none')
      const key = kind === 'ref' ? String(args.ref) : kind === 'selector' ? String(args.selector) : ''
      const r = await callOnPage(tab, RESOLVE_FILE_INPUT_FN, [kind, key])
      if (r.error) return r
      if (abs.length > 1 && !r.multiple) return { ok: false, error: '该上传控件是单文件（multiple=false）：一次只传一个，或换多选上传区' }
      const { root } = await browser.cdp.send('DOM.getDocument', {}, tab.sessionId)
      const q = await browser.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[data-bl-up]' }, tab.sessionId)
      if (!q.nodeId) return { ok: false, error: '标记丢失（页面刚好重渲染了），重试 browser_upload' }
      const setParams = { files: abs, ...(q.backendNodeId ? { backendNodeId: q.backendNodeId } : { nodeId: q.nodeId }) }
      await browser.cdp.send('DOM.setFileInputFiles', setParams, tab.sessionId)
      await evaluate(tab, 'document.querySelectorAll("input[data-bl-up]").forEach(function(n){n.removeAttribute("data-bl-up")})').catch(() => {})
      return {
        ok: true,
        via: r.via,
        input: { accept: r.accept, multiple: r.multiple, matched: r.matched, inputsOnPage: r.count, hadFiles: r.current || '' },
        files: abs.map((f) => ({ name: path.basename(f), bytes: statSync(f).size })),
        hint: abs.map((f) => path.basename(f)).join(',') === (r.current || '')
          ? '⚠ 与控件现有文件同名，Chrome 可能不再触发 change（值未变）；如需强制重传，先刷新页面或换文件名'
          : '已触发 change；上传耗时用 browser_wait(textContains=页面状态词) 等',
      }
    },
  }))

  tools.push(t({
    name: 'browser_press',
    description: '按键/快捷键，作用在页面焦点上。keys 如 "Enter"、"Tab"、"Escape"、"ctrl+a"、"ctrl+shift+r"、"F5"。可组合 ctrl/alt/meta(shift)/cmd。',
    parameters: { keys: { type: 'string', required: true, description: '按键描述，如 ctrl+l、Enter、alt+ArrowLeft' } },
    async execute(args) { const tab = await selectedTab(); await pressKeys(tab, args.keys); return { ok: true, keys: args.keys } },
  }))

  tools.push(t({
    name: 'browser_scroll',
    description: '滚动页面：direction=up|down|left|right + amountPx（默认 600），或用 ref 滚到某元素附近。',
    parameters: {
      direction: { type: 'string', description: 'up|down|left|right' },
      amountPx: { type: 'number', description: '滚动像素，默认 600' },
      ref: { type: 'string', description: '可选：先滚到该元素' },
    },
    async execute(args) {
      const tab = await selectedTab()
      const amount = clamp(args.amountPx || 600, 10, 8000)
      const d = args.direction || 'down'
      if (args.ref) { const r = await callOnPage(tab, REF_CENTER_FN, [String(args.ref)]); if (r.error) return r }
      await dispatchMouse(tab, 'mouseWheel', 400, 400, { deltaX: d === 'left' ? -amount : d === 'right' ? amount : 0, deltaY: d === 'up' ? -amount : d === 'down' ? amount : 0, button: 'none' })
      await sleep(120)
      const pos = await evaluate(tab, '({y:Math.round(window.scrollY||0),x:Math.round(window.scrollX||0),doc:document.documentElement.scrollHeight})')
      return { ok: true, scrolled: pos }
    },
  }))

  tools.push(t({
    name: 'browser_wait',
    description: '等待页面条件：timeMs 纯等待；textContains 正文出现某段文字；selectorPresent CSS 命中；urlMatches URL 正则片段。带超时（默认 15s），返回是否满足+当前状态。',
    parameters: {
      timeMs: { type: 'number', description: '至少等待的毫秒数（0=不等）' },
      textContains: { type: 'string', description: '正文包含此文本即成功' },
      selectorPresent: { type: 'string', description: 'CSS 选择器命中即成功' },
      urlMatches: { type: 'string', description: 'URL 包含此片段（或正则源串）即成功' },
      timeoutMs: { type: 'number', description: '总超时，默认 15000，上限 60000' },
    },
    async execute(args, exec) {
      const tab = await selectedTab()
      const deadline = Date.now() + clamp(args.timeoutMs || 15000, 100, 60000)
      await sleep(clamp(args.timeMs || 0, 0, 60000))
      const cond = !!(args.textContains || args.selectorPresent || args.urlMatches)
      while (true) {
        if (!cond) return { ok: true, waited: 'time' }
        const st = await evaluate(tab, '(function(){return {t:(document.body&&document.body.innerText||"").slice(0,20000),s:0,u:location.href}})()')
        const hit = (!args.textContains || String(st.t).includes(args.textContains))
          && (!args.selectorPresent || !!(await evaluate(tab, '(!!document.querySelector(' + JSON.stringify(args.selectorPresent) + '))')))
          && (!args.urlMatches || String(st.u).includes(args.urlMatches))
        if (hit) return { ok: true, url: st.u, title: await evaluate(tab, 'document.title') }
        if (Date.now() > deadline) return { ok: false, timeout: true, url: st.u }
        if (exec.signal?.aborted) return { ok: false, aborted: true }
        await sleep(500)
      }
    },
  }))

  tools.push(t({
    name: 'browser_eval',
    description: '在页面上下文执行 JS 表达式（IIFE，如 "(()=>{...})()"），returnByValue+awaitPromise，结果 JSON 截断 24k。适合取正文片段、读 location、操作 window 上插件自身登记的辅助对象；常规交互优先用 snapshot/click/type。',
    parameters: { expression: { type: 'string', required: true, description: '单个 JS 表达式' }, awaitPromise: { type: 'boolean', description: 'true=await（默认 false）' } },
    async execute(args) {
      const tab = await selectedTab()
      const v = await evaluate(tab, String(args.expression || ''), !!args.awaitPromise)
      return { value: v }
    },
  }))

  tools.push(t({
    name: 'browser_text',
    description: '抽取正文：selector（默认 body）的 innerText，offset/limit 分页（默认 8000 字）。适合长文阅读比 snapshot 省 token。',
    parameters: {
      selector: { type: 'string', description: 'CSS 选择器，默认 body' },
      offset: { type: 'number', description: '起始字符偏移，默认 0' },
      limit: { type: 'number', description: '最多字符，默认 8000，上限 40000' },
    },
    async execute(args) {
      const tab = await selectedTab()
      const sel = args.selector || 'body'
      const off = Math.max(0, args.offset || 0)
      const lim = clamp(args.limit || 8000, 200, 40000)
      const r = await evaluate(tab, '(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');var t=e?(e.innerText||""):null;return {found:t!==null,len:t?t.length:0,text:t?t.slice(' + off + ',' + off + '+' + lim + '):""}})()')
      if (!r.found) return { ok: false, error: 'selector 未命中: ' + sel }
      return { url: await evaluate(tab, 'location.href'), length: r.len, offset: off, text: r.text, more: r.len > off + r.text.length }
    },
  }))

  tools.push(t({
    name: 'browser_screenshot',
    description: '截图存盘（PNG）到 $DSH_HOME/dsh-browser-live/shots/ 并返回文件路径，可交给图片读取工具看。full=true 截整页。',
    parameters: { full: { type: 'boolean', description: 'true=整页滚动区，默认只截可视区' }, name: { type: 'string', description: '文件名主干（可选），自动补时间戳防重' } },
    async execute(args) {
      const tab = await selectedTab()
      const r = await browser.cdp.send('Page.captureScreenshot', {
        format: 'png',
        ...(args.full ? { captureBeyondViewport: true } : {}),
      }, tab.sessionId, 20000)
      const buf = Buffer.from(r.data, 'base64')
      mkdirSync(SHOTS_DIR(), { recursive: true })
      const safe = String(args.name || tab.title || 'shot').replace(/[^\w\-\u4e00-\u9fff]+/g, '_').slice(0, 40) || 'shot'
      const file = path.join(SHOTS_DIR(), safe + '-' + Date.now() + '.png')
      writeFileSync(file, buf)
      return { ok: true, path: file, bytes: buf.length }
    },
  }))

  tools.push(t({
    name: 'browser_tabs',
    description: '标签页管理：action=list|new|select|close；index 选 0 基序号（select/close 用）。多页任务用它切页。',
    parameters: {
      action: { type: 'string', required: true, description: 'list|new|select|close' },
      url: { type: 'string', description: 'action=new 时的目标 URL（默认 about:blank）' },
      index: { type: 'number', description: 'select/close 的标签页序号' },
    },
    async execute(args) {
      const act = args.action
      await refreshTabs()
      const view = () => browser.tabs.map((x, i) => ({ i, url: x.url, title: x.title, selected: x.targetId === browser.selected }))
      if (act === 'list') return { tabs: view() }
      if (act === 'new') {
        const { targetId } = await browser.cdp.send('Target.createTarget', { url: args.url || 'about:blank' })
        browser.selected = targetId
        await refreshTabs()
        return { ok: true, tabs: view() }
      }
      const idx = Number(args.index)
      if (!Number.isInteger(idx) || idx < 0 || idx >= browser.tabs.length) return { ok: false, error: 'index 越界', tabs: view() }
      const tab = browser.tabs[idx]
      if (act === 'select') { browser.selected = tab.targetId; await attachTab(tab); await refreshTabs(); return { ok: true, tabs: view() } }
      if (act === 'close') { await browser.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {}); if (browser.selected === tab.targetId) browser.selected = null; await waitTargetGone(tab.targetId); return { ok: true, tabs: view() } }
      throw new Error('未知 action: ' + act)
    },
  }))

  tools.push(t({
    name: 'browser_history',
    description: '导航历史/重载：action=back|forward|reload。reload 可选 hard=true 绕过缓存。',
    parameters: {
      action: { type: 'string', required: true, description: 'back|forward|reload' },
      hard: { type: 'boolean', description: 'reload 时 true=强刷' },
    },
    async execute(args) {
      const tab = await selectedTab()
      const act = args.action
      if (act === 'reload') { await browser.cdp.send('Page.reload', { ignoreCache: !!args.hard }, tab.sessionId); await sleep(600); return { ok: true } }
      const hist = await browser.cdp.send('Page.getNavigationHistory', {}, tab.sessionId)
      const idx = hist.currentIndex + (act === 'back' ? -1 : act === 'forward' ? 1 : 0)
      if (idx < 0 || idx >= hist.entries.length) return { ok: false, error: '没有更多历史（当前第 ' + (hist.currentIndex + 1) + '/' + hist.entries.length + ' 条）' }
      await browser.cdp.send('Page.navigateToHistoryEntry', { entryId: hist.entries[idx].id }, tab.sessionId)
      await sleep(500); await refreshTabs()
      const cur = browser.tabs.find((z) => z.targetId === browser.selected)
      return { ok: true, url: cur?.url, title: cur?.title }
    },
  }))

  tools.push(t({
    name: 'browser_downloads',
    description: '列出浏览器下载（$DSH_HOME/dsh-browser-live/downloads/）：文件名/大小/状态。用户可在观察窗里直接点下载文件。',
    parameters: {},
    async execute() {
      let files = []
      try { files = readdirSync(DOWNLOADS_DIR()).filter((f) => !f.endsWith('.crdownload')) } catch {}
      const onDisk = files.map((f) => { try { return { file: f, bytes: statSync(path.join(DOWNLOADS_DIR(), f)).size, mtime: statSync(path.join(DOWNLOADS_DIR(), f)).mtimeMs } } catch { return { file: f } } })
      return { dir: DOWNLOADS_DIR(), files: onDisk.slice(-40), tracked: browser.downloads.slice(-10) }
    },
  }))

  async function gotoUrl(tab, rawUrl) {
    let url = String(rawUrl || '').trim()
    if (!url) throw new Error('url 不能为空')
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !url.startsWith('about:') && !url.startsWith('data:')) url = 'https://' + url
    try {
      const nav = await browser.cdp.send('Page.navigate', { url }, tab.sessionId)
      if (nav && nav.errorText) return { ok: false, error: '导航失败: ' + nav.errorText }
    } catch (e) { return { ok: false, error: '导航失败: ' + e.message } }
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      const rs = await evaluate(tab, 'document.readyState').catch(() => null)
      if (rs === 'complete') break
    }
    await sleep(250)
    await refreshTabs()
    const cur = browser.tabs.find((z) => z.targetId === browser.selected) || tab
    await updateMeta(cur).catch(() => {})
    return { ok: true, url: cur.url, title: cur.title }
  }

  return tools
}

// ------------------------------------------------------------- watch panel backend

const viewers = new Set()
let frameTimer = null
let capturing = false

async function frameLoop() {
  if (capturing) return
  capturing = true
  try {
    if (!viewers.size) return
    if (!alive()) { for (const res of viewers) { try { res.write('event: offline\ndata: {"alive":false}\n\n') } catch { viewers.delete(res) } } }
    else {
      const tab = await selectedTab().catch(() => null)
      if (tab) {
        if (++browser.frameSeq % 8 === 1) await updateMeta(tab).catch(() => {})
        const data = await captureJpeg(tab, settings.quality)
        const payload = JSON.stringify({
          img: data, vw: browser.meta.vw, vh: browser.meta.vh,
          url: tab.url, title: tab.title, ts: Date.now(),
        })
        for (const res of viewers) { try { res.write('event: frame\ndata: ' + payload + '\n\n') } catch { viewers.delete(res) } }
      }
    }
  } catch { /* 单次失败下一帧再来 */ }
  finally { capturing = false }
}

function ensureTicker() {
  if (frameTimer || !viewers.size) return
  const period = Math.round(1000 / clamp(settings.fps, 0.5, 10))
  frameTimer = setInterval(() => {
    if (!viewers.size) { clearInterval(frameTimer); frameTimer = null; return }
    frameLoop()
  }, period)
  frameLoop()
}

function publicState() {
  const cur = browser.tabs.find((t) => t.targetId === browser.selected)
  return {
    ok: true,
    alive: alive(),
    url: cur?.url || '',
    title: cur?.title || '',
    tabs: browser.tabs.map((tt, i) => ({ i, url: tt.url, title: tt.title, selected: tt.targetId === browser.selected })),
    vw: browser.meta.vw, vh: browser.meta.vh,
    lastAction: browser.actionLog.slice(-8),
    panelWanted: browser.panelWanted,
    downloads: browser.downloads.slice(-6),
    settings: { fps: settings.fps, quality: settings.quality, headless: settings.headless },
  }
}

// ------------------------------------------------------------- apply (wiring)

export async function apply(ctx, config) {
  loadSettings()
  browser.WS = await loadWs()
  if (!browser.WS) console.warn('[dsh-browser-live] 未解析到 ws 包，回退 Node 内置 WebSocket（对新版 Chrome 可能不稳）')
  else console.log('[dsh-browser-live] CDP 传输：ws 包')
  if (config && typeof config === 'object') {
    // cordis 行配置可覆盖设置里的同名字段（一次性生效，不落盘）
    const over = sanitizeSettings({ ...settings, ...config })
    settings = over
  }

  const defineTool = await loadDefineTool()
  const t = makeTool(defineTool)
  const builtTools = buildTools(t)
  for (const tool of builtTools) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-browser-live: ${tool.name} tool`)
  }

  const webServer = ctx.get('webServer')
  const offs = []

  // 独立网页版观察窗（liveView=standalone 或面板/地球钮的 ⧉ 按钮打开）：
  // 同一套 /bl/* 接口的全屏页面，可拖到副屏、F11/⛶ 全屏，适合"看着 agent 干活"。
  const VIEW_PAGE = [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>浏览器观察窗</title><style>',
    ':root{color-scheme:dark}',
    'html,body{height:100%;margin:0}',
    'body{background:#0d1117;color:#dfe6ef;font:13px/1.5 system-ui,"Segoe UI",sans-serif;display:flex;flex-direction:column}',
    '#hd{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #222a35;flex:none}',
    '#ttl{font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#url{color:#8b98a9;max-width:38%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}',
    '.dot{width:9px;height:9px;border-radius:50%;background:#b9bfc9;flex:none}',
    '.dot.on{background:#3fb96f;box-shadow:0 0 7px rgba(63,185,111,.9)}',
    '#tabs{display:none;gap:6px;padding:6px 10px;border-bottom:1px solid #222a35;overflow-x:auto;flex:none}',
    '.tab{flex:none;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid #2b3542;background:#161c24;border-radius:7px;padding:3px 9px;cursor:pointer;color:inherit;font-size:12px}',
    '.tab.sel{border-color:#5b8def;background:rgba(91,141,239,.16)}',
    '#stage{position:relative;flex:1;min-height:0;background:#101418;display:flex;align-items:flex-start;justify-content:center;overflow:hidden;line-height:0}',
    '#img{max-width:100%;max-height:100%;display:block;user-select:none;-webkit-user-drag:none}',
    '#empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#8b98a9;line-height:1.7;text-align:center;padding:24px}',
    '#act{position:absolute;left:12px;bottom:12px;right:12px;background:rgba(10,14,20,.75);border-radius:8px;padding:4px 10px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;transition:opacity .25s}',
    '#act.show{opacity:1}',
    '#ft{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid #222a35;flex-wrap:wrap;flex:none}',
    'button{border:1px solid #2b3542;background:#161c24;color:inherit;border-radius:7px;height:26px;padding:0 10px;cursor:pointer;font-size:12px}',
    'button:hover{border-color:#3b4757}',
    'button.on{background:rgba(91,141,239,.18);border-color:#5b8def}',
    'button.danger{color:#ff7b72;border-color:rgba(255,123,114,.4)}',
    'select{border:1px solid #2b3542;background:#161c24;color:inherit;border-radius:6px;height:26px;font-size:12px}',
    'label{color:#8b98a9;display:inline-flex;align-items:center;gap:5px}',
    '#dl{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}',
    '#dl a{color:#7aa7e8;text-decoration:none;border:1px solid rgba(91,141,239,.4);border-radius:6px;padding:1px 8px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}',
    '#key{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}',
    '</style></head><body>',
    '<div id="hd"><span class="dot" id="dot"></span><span id="ttl">浏览器观察窗</span><span id="url"></span>',
    '<button id="rc" title="重连画面">⟳ 重连</button><button id="fs" title="全屏（丢副屏）">⛶ 全屏</button></div>',
    '<div id="tabs"></div>',
    '<div id="stage"><img id="img" alt="" draggable="false">',
    '<div id="empty">等待 agent 打开浏览器…<br>在 DSH 里调用任意 browser_* 工具后，这里会实时显示画面</div>',
    '<div id="act"></div><textarea id="key" spellcheck="false" autocomplete="off"></textarea></div>',
    '<div id="ft"><button id="take">⌨ 接管:开</button>',
    '<label>FPS <select id="fps"><option>1</option><option selected>2</option><option>4</option><option>8</option></select></label>',
    '<label>画质 <select id="q"><option value="40">省流</option><option value="60" selected>默认</option><option value="80">高清</option></select></label>',
    '<button id="stop" class="danger">⏹ 关浏览器</button><span id="dl"></span></div>',
    '<script>',
    '(function(){',
    'var $=function(i){return document.getElementById(i)};',
    'var img=$("img"),dot=$("dot"),ttl=$("ttl"),url=$("url"),tabs=$("tabs"),act=$("act"),empty=$("empty"),key=$("key"),dl=$("dl");',
    'var vw=1280,takeOn=true,es=null,lastClick=0,stopArmed=false;',
    'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
    'function trim(u){return String(u||"").replace(/^https?:\\/\\//,"").slice(0,80)}',
    'function post(p,o){return fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(o||{})}).catch(function(){})}',
    'function api(p){return fetch(p).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}',
    'function xy(ev){var r=img.getBoundingClientRect();if(!r.width)return null;var f=vw/r.width;return {x:Math.max(0,Math.round((ev.clientX-r.left)*f)),y:Math.max(0,Math.round((ev.clientY-r.top)*f))}}',
    'function focusKey(){try{key.focus({preventScroll:true})}catch(e){}}',
    'img.addEventListener("mousedown",function(ev){if(!takeOn||ev.button>2)return;ev.preventDefault();focusKey();var p=xy(ev);if(!p)return;var now=Date.now();var dbl=now-lastClick<350&&ev.button===0;lastClick=now;post("/bl/input",{kind:ev.button===2?"rclick":dbl?"dblclick":"click",x:p.x,y:p.y})});',
    'img.addEventListener("contextmenu",function(ev){if(takeOn)ev.preventDefault()});',
    'var mv=0;img.addEventListener("mousemove",function(ev){if(!takeOn)return;var now=Date.now();if(now-mv<90)return;mv=now;var p=xy(ev);if(p)post("/bl/input",{kind:"move",x:p.x,y:p.y})});',
    '$("stage").addEventListener("wheel",function(ev){if(!takeOn)return;ev.preventDefault();var p=xy(ev);if(!p)return;post("/bl/input",{kind:"wheel",x:p.x,y:p.y,dx:Math.round(ev.deltaX),dy:Math.round(ev.deltaY)})},{passive:false});',
    'var NAMED=["Enter","Tab","Escape","Backspace","Delete","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown","F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"," ","Insert"];',
    'key.addEventListener("keydown",function(ev){if(!takeOn)return;var c=[];if(ev.ctrlKey)c.push("ctrl");if(ev.altKey)c.push("alt");if(ev.metaKey)c.push("meta");if(ev.shiftKey&&(c.length||ev.key.indexOf("Arrow")===0||["Tab","Enter","Backspace","Delete"].indexOf(ev.key)>=0))c.push("shift");if(NAMED.indexOf(ev.key)>=0||c.length){ev.preventDefault();post("/bl/input",{kind:"key",keys:c.concat([ev.key===" "?"Space":ev.key]).join("+")})}});',
    'key.addEventListener("beforeinput",function(ev){if(!takeOn)return;if(ev.inputType==="insertText"&&ev.data){ev.preventDefault();post("/bl/input",{kind:"text",text:ev.data})}});',
    'key.addEventListener("compositionend",function(ev){if(takeOn&&ev.data)post("/bl/input",{kind:"text",text:ev.data})});',
    'key.addEventListener("paste",function(ev){var t=(ev.clipboardData||window.clipboardData).getData("text");if(t){ev.preventDefault();post("/bl/input",{kind:"text",text:t})}});',
    '$("take").addEventListener("click",function(){takeOn=!takeOn;this.textContent=takeOn?"⌨ 接管:开":"⌨ 接管:关";this.classList.toggle("on",takeOn)});',
    '$("take").classList.add("on");',
    '$("fps").addEventListener("change",function(){fetch("/bl/settings.json",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({fps:Number(this.value)})})});',
    '$("q").addEventListener("change",function(){fetch("/bl/settings.json",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({quality:Number(this.value)})})});',
    '$("stop").addEventListener("click",function(){var b=this;if(!stopArmed){stopArmed=true;b.textContent="再点一次确认关闭";setTimeout(function(){stopArmed=false;b.textContent="⏹ 关浏览器"},3000);return}stopArmed=false;b.textContent="⏹ 关浏览器";post("/bl/close-browser",{}).then(function(){setTimeout(poll,300)})});',
    '$("rc").addEventListener("click",function(){open()});',
    '$("fs").addEventListener("click",function(){if(document.fullscreenElement){document.exitFullscreen()}else if(document.documentElement.requestFullscreen){document.documentElement.requestFullscreen()}});',
    'function open(){if(es){try{es.close()}catch(e){}}try{es=new EventSource("/bl/stream");es.addEventListener("frame",function(ev){var d;try{d=JSON.parse(ev.data)}catch(e){return}vw=d.vw||vw;img.src="data:image/jpeg;base64,"+d.img;empty.style.display="none";dot.classList.add("on");var t=String(d.title||"浏览器观察窗").slice(0,90);ttl.textContent=t;url.textContent=trim(d.url)});es.addEventListener("offline",function(){dot.classList.remove("on")});es.onerror=function(){}}catch(e){}}',
    'function poll(){api("/bl/state").then(function(st){if(!st)return;dot.classList.toggle("on",!!st.alive);if(!st.alive){empty.style.display="flex";img.removeAttribute("src");ttl.textContent="浏览器观察窗";url.textContent=""}',
    'var ts=st.tabs||[];tabs.style.display=ts.length>1?"flex":"none";tabs.innerHTML=ts.map(function(t){return \x27<button class="tab\x27+(t.selected?" sel":"")+\x27" data-i="\x27+t.i+\x27">\x27+esc(t.title||trim(t.url)||"(空白页)")+\x27</button>\x27}).join("");',
    'var done=(st.downloads||[]).filter(function(d){return d.state==="done"}).slice(-3);dl.innerHTML=done.map(function(d){return \x27<a href="/bl/download?file=\x27+encodeURIComponent(d.file)+\x27" title="取回下载文件">⬇ \x27+esc(d.file)+\x27</a>\x27}).join("");',
    'var la=st.lastAction||[];var last=la[la.length-1];if(last){act.textContent="🤖 "+last.label;act.classList.add("show")}',
    'if(st.panelWanted)post("/bl/ack",{})})}',
    'tabs.addEventListener("click",function(ev){var b=ev.target.closest?ev.target.closest(".tab"):null;if(!b)return;post("/bl/tabs",{action:"select",index:Number(b.getAttribute("data-i"))}).then(poll)});',
    'open();poll();setInterval(poll,2500);',
    '})();',
    '</script></body></html>',
  ].join('\n')

  if (webServer && typeof webServer.register === 'function') {
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/ping',
      handler: (req, res) => { sendJson(res, 200, { ok: true, alive: alive() }); req.resume?.() },
    }), 'bl: ping route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/state',
      handler: (req, res) => { sendJson(res, 200, publicState()); req.resume?.() },
    }), 'bl: state route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/stream',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        res.write('retry: 3000\n\n')
        viewers.add(res)
        ensureTicker()
        const beat = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 5000)
        const bye = () => { clearInterval(beat); viewers.delete(res); try { res.end() } catch {} }
        req.on('close', bye)
      },
    }), 'bl: stream route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/input',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          if (!alive() || !browser.selected) return sendJson(res, 409, { ok: false, error: '浏览器未在运行' })
          const tab = browser.tabs.find((tt) => tt.targetId === browser.selected)
          if (!tab || !tab.sessionId) return sendJson(res, 409, { ok: false, error: '会话未附加' })
          const kind = String(body.kind || '')
          switch (kind) {
            case 'click': case 'dblclick': case 'rclick':
              await clickXY(tab, Number(body.x) || 0, Number(body.y) || 0, {
                button: kind === 'rclick' ? 'right' : 'left',
                clicks: kind === 'dblclick' ? 2 : 1,
                instant: true, // 接管=人的实时意图，直达，不插轨迹
              })
              break
            case 'move':
              await dispatchMouse(tab, 'mouseMoved', Number(body.x) || 0, Number(body.y) || 0, { button: 'none' })
              break
            case 'wheel':
              await dispatchMouse(tab, 'mouseWheel', Number(body.x) || 400, Number(body.y) || 400, { deltaX: Number(body.dx) || 0, deltaY: Number(body.dy) || 0, button: 'none' })
              break
            case 'text':
              await typeText(tab, String(body.text || ''))
              break
            case 'key':
              await pressKeys(tab, String(body.keys || 'Enter'))
              break
            default:
              return sendJson(res, 400, { ok: false, error: '未知 kind: ' + kind })
          }
          noteAction('🖱 用户接管输入: ' + (kind === 'text' ? '"' + String(body.text || '').slice(0, 20) + '"' : kind))
          sendJson(res, 200, { ok: true })
        } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message || e) }) }
      },
    }), 'bl: input route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/settings.json',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, settings)
        if (req.method === 'PUT' || req.method === 'POST') {
          try { settings = sanitizeSettings({ ...settings, ...(await readBody(req)) }); saveSettings(); sendJson(res, 200, { ok: true, settings }) }
          catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message || e) }) }
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    }), 'bl: settings route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/view',
      handler: (req, res) => {
        req.resume?.()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(VIEW_PAGE)
      },
    }), 'bl: view route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/download',
      handler: (req, res) => {
        try {
          const u = new URL(req.url || '/bl/download', 'http://bl.internal')
          const file = String(u.searchParams.get('file') || '')
          if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) return sendJson(res, 400, { ok: false, error: 'bad file' })
          const abs = path.join(DOWNLOADS_DIR(), file)
          if (!existsSync(abs)) return sendJson(res, 404, { ok: false, error: 'not found' })
          const st = statSync(abs)
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': 'attachment; filename="' + encodeURIComponent(file) + '"' })
          res.end(readFileSync(abs))
        } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message || e) }) }
      },
    }), 'bl: download route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/ack',
      handler: (req, res) => { browser.panelWanted = false; sendJson(res, 200, { ok: true }); req.resume?.() },
    }), 'bl: ack route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/tabs',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          if (!alive()) return sendJson(res, 409, { ok: false, error: '浏览器未在运行' })
          await withLock(async () => {
            await refreshTabs()
            const idx = Number(body.index)
            const tab = browser.tabs[idx]
            if (!tab) throw new Error('index 越界')
            if (body.action === 'select') { browser.selected = tab.targetId; await attachTab(tab); await refreshTabs() }
            else if (body.action === 'close') { await browser.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {}); if (browser.selected === tab.targetId) browser.selected = null; await waitTargetGone(tab.targetId) }
            else throw new Error('未知 action')
          })
          noteAction('🖱 用户面板操作标签页: ' + body.action + ' #' + body.index)
          sendJson(res, 200, publicState())
        } catch (e) { sendJson(res, 400, { ok: false, error: String(e?.message || e) }) }
      },
    }), 'bl: tabs route'))
    offs.push(ctx.effect(() => webServer.register({
      kind: 'exact', path: '/bl/close-browser',
      handler: async (req, res) => {
        await withLock(() => shutdown(true))
        noteAction('🖱 用户手动关闭浏览器')
        sendJson(res, 200, { ok: true })
        req.resume?.()
      },
    }), 'bl: close-browser route'))
  } else {
    console.warn('[dsh-browser-live] webServer 不可用：观察窗面板不会工作，工具仍可用（headless 场景）')
  }

  process.on('exit', () => { try { if (browser.proc) browser.proc.kill() } catch {} try { browser.cdp?.close() } catch {} })

  console.log('[dsh-browser-live] host up (v' + version + ') · ' + builtTools.length + ' 个 browser_* 工具已注册 · 数据目录 ' + BASE_DIR())
}
