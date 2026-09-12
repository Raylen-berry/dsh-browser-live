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
// v0.5.0 起多了一条可选后端（P0 只读）——**接管用户日常浏览器**：
//   · 扩展路线，见 bridge.js + extension/ + docs/PLAN-user-browser-takeover.md；
//   · settings.userBridge=true 时 host 起 WS 桥（127.0.0.1:bridgePort），
//     Chrome 扩展用 chrome.debugger 当"反向 CDP 客户端"，于是 browser.cdp 直接换成桥，
//     17 个工具的调用面一行未改；
//   · 扩展侧只放行只读 + 导航（Input.* / 上传 / 标签页增删一律拒绝），逐站点授权；
//   · 桥一断就自动回退插件自拉实例，行为与 v0.4.3 一致。
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
import { BridgeServer, BRIDGE_FILE, DEFAULT_BRIDGE_PORT } from './bridge.js'
import { createAudit, trim as auditTrim } from './audit.js'

export const name = 'dsh-browser-live'
export const inject = ['tools', 'webServer']
// 版本号以 package.json 为准。这里原来写死成字符串，于是 bump package.json 之后
// 日志的 `host up (vX)` 和桥握手的 hostVersion 还报旧版本（v0.8.0 已经踩过一次）。
const HOST_PKG = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
export const version = String(HOST_PKG.version || '0.0.0')

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
const CHROME_PROFILE = (exe) => path.join(BASE_DIR(), 'chrome-profile' + (exe ? '-' + path.basename(exe, path.extname(exe)) : ''))
const AUDIT_DIR = () => path.join(BASE_DIR(), 'audit')
const DOWNLOADS_DIR = () => path.join(BASE_DIR(), 'downloads')
const SHOTS_DIR = () => path.join(BASE_DIR(), 'shots')

// 留痕实例（2026-09-12）：每一次 browser_* 工具调用、每一次页面自己发起的跳转都追加到
// $DSH_HOME/dsh-browser-live/audit/YYYY-MM-DD.jsonl；详见 audit.js 顶部的能力边界说明。
// 提取函数（不写盘），便于 tools/verify-audit.mjs 离线测。
const AUDIT = createAudit(AUDIT_DIR())

// 启动失败后的兼容参数（按顺序补试）。为什么是它：有些机器上安全软件会拦掉 Chrome
// **GPU 进程**的沙箱初始化（本机实测：火绒 D:\Huorong\Sysdiag\bin\HipsDaemon.exe），
// 表现是"进程起来又立刻静默退出、日志停在 variations setup、没有任何报错"。
// `--in-process-gpu` 让 GPU 跑在浏览器进程里，绕开那一步，而**渲染器沙箱仍然保留** ——
// 刻意**不**用 `--no-sandbox`：那是把整台浏览器的沙箱都关掉，拿它当 agent 浏览器的代价太大。
const COMPAT_FLAGS = ['--in-process-gpu']

export function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE(), 'utf8')) || {} } catch { return {} }
}
export function writeState(patch) {
  try { writeFileSync(STATE_FILE(), JSON.stringify({ ...readState(), ...patch }), 'utf8') } catch { /* 状态文件写不了不该影响启动 */ }
}
/** 上一次"某个浏览器 + 某组兼容参数"成功过 → 直接用，省掉每轮都要先失败 10 秒。 */
export function compatFlagsFor(exe) {
  const c = readState().compat
  const f = c && c[path.basename(exe)]
  return Array.isArray(f) ? f : []
}
export { COMPAT_FLAGS }

const DEFAULT_SETTINGS = Object.freeze({
  fps: 2,            // 观察窗帧率（0.5~10）
  quality: 60,       // SSE JPEG 质量（20~90）
  headless: false,   // true 时 Chrome 无头（观察窗看的是虚拟页面）
  windowSize: '1440,900',
  chromePath: '',    // 空=自动探测
  extraArgs: '',     // 追加到 Chrome 命令行的空格分隔参数
  proxy: '',         // Chrome --proxy-server，例 http://127.0.0.1:7890 / socks5://127.0.0.1:1080；空=跟随系统
  liveView: 'panel', // panel=DSH 内嵌观察窗；standalone=独立网页 /bl/view（可丢到副屏/全屏）
  // true（默认）= 用 VBS 启动器把 Chrome 拉起成**独立进程**：脱离 DSH 的父进程/作业对象，
  // 于是它拥有真实可见的窗口句柄。false = 老行为 `spawn(...,{detached:false})`，
  // 在部分 Windows 环境（DSH Desktop 自身带作业对象时）拉起的 Chrome 会**没有窗口句柄**，
  // 表现为"浏览器明明在跑、你也点得到，但屏幕上根本看不到窗口"，只能看观察窗。
  launchDetached: true,
  maxTabsWarn: 12,
  humanize: true,    // agent 鼠标移动走拟人轨迹（贝塞尔+缓动+抖动）；接管面板的实时转发不受影响
  humanSpeed: 1,     // 轨迹速度倍率（0.3~4）：越大越快越不像人，1≈0.25~0.45s 中等距离
  userBridge: false, // true=启动"用户日常浏览器"桥（需在 Chrome 里装 extension/ 里的扩展并粘 token）
  // 默认把 agent 的浏览器操作放在**插件自拉实例**里：那个实例不需要逐站点授权，
  // 所以"不是要登录的页面"直接 browser_open 打开就行，不用接管用户正在用的浏览器。
  //   auto   = 默认插件实例；browser_open 显式给 use:'user' 时才去用户的浏览器（要登录态的站点）
  //   plugin = 只用插件实例
  //   user   = 默认就用用户的浏览器（与旧行为一致）
  backendMode: 'auto',
  // 多浏览器（v0.7）：use:'user' 时用哪个已接入的浏览器。空=任选一个已连接的。
  // 想"默认就用 Edge 的登录态"就填 'edge'；不改这里也不影响 —— 工具调用可直接 use:'edge'。
  userDefault: '',
  bridgePort: DEFAULT_BRIDGE_PORT, // 桥监听端口（127.0.0.1；占用则顺延）
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
    if (typeof raw.launchDetached === 'boolean') s.launchDetached = raw.launchDetached
    if (typeof raw.humanize === 'boolean') s.humanize = raw.humanize
    if (Number.isFinite(raw.humanSpeed)) s.humanSpeed = clamp(raw.humanSpeed, 0.3, 4)
    if (typeof raw.userBridge === 'boolean') s.userBridge = raw.userBridge
    if (raw.backendMode === 'auto' || raw.backendMode === 'plugin' || raw.backendMode === 'user') s.backendMode = raw.backendMode
    if (typeof raw.userDefault === 'string' && (raw.userDefault === '' || BROWSER_KINDS.includes(raw.userDefault))) s.userDefault = raw.userDefault
    if (Number.isFinite(raw.bridgePort)) s.bridgePort = clamp(Math.round(raw.bridgePort), 1024, 65535)
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

// ------------------------------------------------------------------ 留痕包装 --
// 收口点：**所有** browser_* 工具都由 buildTools(t) → 这里注册，所以包一层 execute
// 就等于"agent 用浏览器做的每一步都留下一条"，不需要逐个工具去加埋点
// （逐个加必然会漏，而且以后新增工具又会漏）。
// 记录内容：工具名、参数（截断但标注长度）、成功/失败、错误信息、耗时、调用前后所在 URL
// 与 backend —— 这正好回答"他开了浏览器、点了什么、填了什么、去了哪、然后关了没有"。
function withAudit(tool) {
  const original = tool && tool.execute
  if (typeof original !== 'function') return tool
  const snapshot = () => {
    try {
      const s = browser.session
      const tb = s && s.tabs && s.tabs[0]
      return { backend: (s && s.backend) || undefined, at: (tb && tb.url) || undefined }
    } catch { return {} }
  }
  return {
    ...tool,
    async execute(args, exec) {
      const t0 = Date.now()
      const before = snapshot()
      let out
      let err = null
      try {
        out = await original(args, exec)
        return out
      } catch (e) {
        err = e
        throw e
      } finally {
        const after = snapshot()
        AUDIT.audit('tool', {
          tool: tool.name,
          args: auditTrim(args, 4000),
          ok: !err,
          err: err ? String((err && err.message) || err).slice(0, 400) : undefined,
          ms: Date.now() - t0,
          backend: before.backend || after.backend,
          urlBefore: before.at,
          urlAfter: after.at,
          result: err ? undefined : auditTrim(out, 1500),
        })
      }
    },
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

/** 解析 'ws' 包本体（需要 WebSocketServer 起桥），与 loadWs 同款候选路径。 */
async function loadWsModule() {
  const candidates = ['ws']
  try { candidates.push(pathToFileURL(path.join(dshHome(), 'profiles', 'node_modules', 'ws', 'index.js')).href) } catch { /* ignore */ }
  try {
    const appNm = path.join(path.dirname(process.execPath), '..', '..')
    candidates.push(pathToFileURL(path.join(appNm, 'ws', 'index.js')).href)
  } catch { /* ignore */ }
  try {
    if (process.env.APPDATA) candidates.push(pathToFileURL(path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'node_modules', 'ws', 'index.js')).href)
  } catch { /* ignore */ }
  for (const c of candidates) {
    try {
      const m = await import(c)
      const W = m && (m.default || m)
      const WSS = m?.WebSocketServer || W?.WebSocketServer
      if (typeof W === 'function' && typeof WSS === 'function') return { WebSocket: W, WebSocketServer: WSS }
      // CJS 具名导出：{ WebSocket, WebSocketServer }
      if (typeof m?.WebSocket === 'function' && typeof WSS === 'function') return { WebSocket: m.WebSocket, WebSocketServer: WSS }
    } catch { /* next */ }
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

/**
 * DSH GUI 的"已认证 URL"（带一次性 launch token 的 `/?token=…`）。
 * 为什么需要它：`/bl/*` 这些插件路由不校验身份，但 GUI 根路径由 dsh-client-connection 把守
 * （`authorizeIndex`：URL 上的 launch token 换签名 cookie，否则 401 "dsh web authentication required"）。
 * 插件 Chrome 是独立 profile，本来没有任何凭据 —— 所以在那个浏览器里看 GUI 必然被拒。
 * 这里不绕过门禁：走宿主自己的接口 `connection.authenticatedUrl(base)`（dsh-web-app 打印 URL 用的同一个），
 * 拿到 URL 后在目标浏览器里访问一次，token 就换成正常 cookie（303 落地），后续就都能开。
 */
let guiAuthUrl = null
let guiAuthApi = null   // inject(["connection"]) 拿到的该服务引用

function guiUrlFromCtx(c) {
  try {
    if (!c || !c.connection || typeof c.connection.authenticatedUrl !== 'function') return null
    const port = (c.webServer && c.webServer.port) || (process.env.DSH_WEB_URL ? Number(new URL(process.env.DSH_WEB_URL).port) : 0)
    if (!port) return null
    return c.connection.authenticatedUrl('http://127.0.0.1:' + port)
  } catch { return null }
}

/** 取（并缓存）已认证 GUI URL；拿不到就回 null，由调用方给出可读原因。 */
function guiAuthUrlNow() {
  if (!guiAuthApi) return guiAuthUrl
  const u = guiUrlFromCtx(guiAuthApi)
  if (u) guiAuthUrl = u
  return guiAuthUrl
}

/**
 * 每浏览器一份会话（v0.7 多浏览器）。
 *
 * 为什么要有这个：桥（bridge.js）现在能同时挂 Chrome 和 Edge 两条扩展连接，
 * 而 tabs / selected / cdp 这些状态**必须按浏览器分开** —— 共用一个 browser.tabs
 * 会让"在 Edge 上 snapshot、却对 Chrome 的标签页点击"这种错位悄悄发生。
 *
 * 兼容策略：`browser` 这个老单例仍然存在，并且**始终是当前活跃会话的视图**
 * （`viewOf()` 把会话字段拷进去），所以 19 个工具里那 100 多处 `browser.tabs`
 * 之类的写法一行都不用改；只有"会话边界"（选会话、刷新标签、附加会话）需要传 s。
 */
const BROWSER_KINDS = ['chrome', 'edge', 'brave', 'opera', 'unknown']
const KIND_LABEL = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', opera: 'Opera', unknown: '未知浏览器' }
const kindLabel = (k) => KIND_LABEL[k] || (k ? String(k) : '未知浏览器')

const makeSession = (kind, { backend = 'plugin', userClosed = false } = {}) => ({
  kind, backend, userClosed,
  cdp: null, tabs: [], selected: null, lastPos: null,
  meta: { vw: 1280, vh: 800 },
})

const browser = {
  proc: null,
  detachedLaunch: false, // true=Chrome 由 VBS 启动器拉成独立进程（proc 只是启动器，别拿它当 Chrome）
  cdp: null,          // 当前活跃会话的传输（插件实例=local Cdp；用户浏览器=bridge 的 per-kind Cdp）
  local: null,        // 插件自拉 Chrome 的 Cdp 连接（切到用户浏览器时保留，断开可回退）
  bridge: null,       // BridgeServer 实例（settings.userBridge=true 才创建）
  backend: 'plugin',  // 'plugin' | 'user'（当前活跃会话的性质）
  userClosed: false,  // 用户浏览器模式下用户主动 browser_close：暂停而不关他的浏览器
  port: 0,
  tabs: [],           // {targetId, sessionId, url, title, type} —— 当前活跃会话的视图
  selected: null,     // targetId
  meta: { vw: 1280, vh: 800 },
  frameSeq: 0,
  actionLog: [],      // {t, label}
  panelWanted: false, // 客户端轮询：true 时自动弹观察窗
  downloads: [],      // {file, url, state, t}（仅插件自拉实例有 CDP 下载事件）
  dying: false,
  WS: null,           // ws 包构造器（apply 时解析；null=退回全局 WebSocket）
  lastPos: null,      // 拟人轨迹的"笔尖"：上一次鼠标落点 {x,y}（CSS px）
  sessions: new Map(),// Map<kind, session>；'plugin' 键 = 插件自拉实例
  session: null,      // 当前活跃会话
  primary: null,      // 插件自拉实例的 local Cdp（= sessions.get('plugin').cdp）
}

/** 把会话字段拷进老单例，让所有 `browser.xxx` 读法继续成立。 */
function viewOf(s) {
  browser.session = s
  browser.backend = s.backend
  browser.userClosed = s.userClosed
  browser.tabs = s.tabs
  browser.selected = s.selected
  browser.meta = s.meta
  browser.lastPos = s.lastPos
  browser.cdp = s.cdp
}

/** 取会话；不存在则建（并接上可用的传输）。 */
function sessionOf(kind) {
  const k = kind || 'plugin'
  let s = browser.sessions.get(k)
  if (s) {
    // 传输可能是后到的（桥刚连上 / 插件实例刚起来），每次都重新兜一次
    if (!s.cdp) s.cdp = k === 'plugin' ? browser.primary : (browser.bridge ? browser.bridge.cdpFor(k) : null)
    return s
  }
  s = makeSession(k, k === 'plugin' ? { backend: 'plugin' } : { backend: 'user' })
  s.cdp = k === 'plugin' ? browser.primary : (browser.bridge ? browser.bridge.cdpFor(k) : null)
  browser.sessions.set(k, s)
  return s
}

const isUserKind = (k) => k !== 'plugin'
/** 是不是"我们认识的浏览器种类"（chrome/edge/brave/opera/unknown）。
 *  与 isUserKind 的区别：后者只回答"是不是插件自带实例"，所以 'firefox' 也会过关；
 *  校验 use 取值时必须用这个，否则拼错的名字会被当成"未接入的浏览器"去报错。 */
const isKnownKind = (k) => BROWSER_KINDS.includes(k)
const aliveOf = (s) => !!(s && s.cdp && s.cdp.alive && !(s.backend === 'user' && s.userClosed))

/** 已接入的浏览器 kind 列表（按固定顺序，便于日志与 UI 稳定）。 */
function connectedKinds() {
  const b = browser.bridge
  if (!b || !b.alive) { if (process.env.BL_TRACE) console.log('[trace.kinds] bridge none/alive=', !!b && b.alive); return [] }
  let ks = []
  try {
    ks = typeof b.kinds === 'function' ? b.kinds() : (b.list() || []).map((x) => x.kind)
  } catch { ks = [] }
  const out = (Array.isArray(ks) ? ks : []).filter(Boolean).sort((a, c) => BROWSER_KINDS.indexOf(a) - BROWSER_KINDS.indexOf(c))
  if (process.env.BL_TRACE) console.log('[trace.kinds]', JSON.stringify(out), 'connected=', b.connected)
  return out
}

function browsersView() {
  const live = new Set(connectedKinds())
  // 已接入但还没被任何调用碰过的浏览器也要列出来 —— 否则设置页只能显示"你用过的"，
  // 用户刚装完 Edge 扩展时会看到一台都没接（明明连上了）。
  const kinds = new Set([...browser.sessions.keys(), ...live])
  return [...kinds].map((kind) => {
    const s = browser.sessions.get(kind)
    return {
      kind,
      label: isUserKind(kind) ? kindLabel(kind) : '插件自带实例',
      connected: isUserKind(kind) ? live.has(kind) : !!(browser.primary && browser.primary.alive),
      active: !!s && browser.session === s,
      tabs: s ? s.tabs.length : 0,
      selected: (s && s.tabs.find((t) => t.targetId === s.selected)?.url) || '',
    }
  })
}

/**
 * 这台调用用哪个浏览器。优先级：显式 use > lastUse（上次用的）> settings.backendMode > 插件实例。
 *   use:'plugin'         → 插件自拉实例（免授权、可新开页）
 *   use:'chrome'|'edge'  → 指定用户的那个浏览器（必须连着；连不上就明确报错，不静默换车）
 *   use:'user'           → settings.userDefault 指定的那个，没指定就用任一已连接的
 *   use 缺省             → 沿用上一次用的；没有上一次就看 backendMode（user 档默认用你的浏览器）
 */
let lastUse = ''
async function useSession(use) {
  const u0 = typeof use === 'string' ? use.trim().toLowerCase() : ''
  // 不给 use：沿用上一次（lastUse）；冷启动才看 backendMode。避免"上一次刚在 Edge 里读完，
  // 这一次没写 use 就悄悄跑回插件实例"这种错位。
  const u = u0 || lastUse || (settings.backendMode === 'user' ? 'user' : 'plugin')
  if (u === 'plugin' || u === 'local') { lastUse = 'plugin'; const s = sessionOf('plugin'); return viewOf(s), s }
  if (u === 'user') {
    const ks = connectedKinds()
    if (!ks.length) throw new Error('用户浏览器桥未连接：先在 Chrome/Edge 的扩展弹窗里「连接」，或改用 use:"plugin"')
    const want = ks.includes(settings.userDefault) ? settings.userDefault : ks[0]
    lastUse = want
    const s = sessionOf(want); return viewOf(s), s
  }
  if (u === 'auto') {
    // auto：桥连着就用你的浏览器，否则插件实例
    const ks = connectedKinds()
    const k = ks.includes(settings.userDefault) ? settings.userDefault : ks[0]
    lastUse = k || 'plugin'
    const s = sessionOf(k || 'plugin')
    return viewOf(s), s
  }
  // 先看"是不是已知浏览器种类"（这条判断必须排在"未接入"之前）：
  // 已接入的浏览器（Chrome/Edge）没连上时给"怎么连上"的指引；
  // 连种类都不认识（比如 firefox）就是参数写错了，要列出合法取值。
  if (!isKnownKind(u)) {
    throw new Error(`use 只能是 'plugin' | 'user' | 'auto' | ${BROWSER_KINDS.map((k) => `'${k}'`).join(' | ')}（收到 "${u}"）`)
  }
  const ks = connectedKinds()
  if (!ks.includes(u)) {
    // 没写 use、只是"沿用上一次"的那台已经掉线 → 退回插件实例，别让后续调用一路报错。
    // 显式写了 use:'edge' 掉线时**不能**这样兜底：那是"必须用这台"的明示意图，只能报错。
    if (!u0 && lastUse && u === lastUse) {
      noteAction(`${kindLabel(u)} 已掉线，这次改用插件自带实例`)
      lastUse = 'plugin'
      const ps = sessionOf('plugin')
      return viewOf(ps), ps
    }
    // 报错必须分清"桥没开"和"扩展没装"：这两种的下一步动作完全不同，
    // 混成一句会让用户/agent 去装一个装了也连不上的扩展（v0.7 的老毛病）。
    const bridgeReady = settings.userBridge === true && !!browser.bridge
    const wantKind = (u === 'edge' || u === 'chrome') ? u : (settings.userDefault || 'edge')
    const extPage = wantKind === 'edge' ? 'edge://extensions' : 'chrome://extensions'
    throw new Error(ks.length
      ? `${kindLabel(u)} 未接入（当前连着：${ks.map(kindLabel).join('、')}）。在 ${kindLabel(u)} 里装好扩展并点「连接」，或改用 use:"${ks[0]}"`
      : (bridgeReady
        ? `${kindLabel(u)} 未接入：该浏览器里的 DSH Browser Bridge 扩展还没连接。`
          + `装法：打开 ${extPage} → 开发者模式 → 加载已解压的扩展程序 → 选 ${EXTENSION_DIR()} → 粘 token 点连接；`
          + `token 在 ${BRIDGE_FILE(BASE_DIR())}。调 browser_ext_setup 可以一次把这些都摆到你面前。`
        : `${kindLabel(u)} 未接入：用户浏览器桥**没启用**（settings.userBridge=false），扩展装了也连不上。`
          + `调 browser_ext_setup 即可：它打开桥、取出 token，并把 ${extPage} 与扩展目录 ${EXTENSION_DIR()} 一起打开。`))
  }
  lastUse = u
  const s = sessionOf(u)
  return viewOf(s), s
}

async function probePort(port) {
  const r = await httpGetJson(`http://127.0.0.1:${port}/json/version`)
  return r && r.json && r.json.webSocketDebuggerUrl ? r.json.webSocketDebuggerUrl : null
}

/**
 * 所有可用的 Chromium 系浏览器，按偏好排序：设置里的 chromePath → 环境变量 → Chrome → Edge → Brave。
 * 之所以是**列表**而不是"第一个能用的"：某台机器上首选浏览器可能根本起不来
 * （实测：DSH Desktop 以管理员身份运行时，Chrome 会因无法初始化沙箱而静默退出，Edge 不受影响），
 * 那时候应该自动退到下一个，而不是让整个插件不可用。
 */
export function findChromiumExes() {
  const found = []
  const add = (p) => { try { if (p && existsSync(p) && !found.includes(p)) found.push(p) } catch { /* ignore */ } }
  add(settings.chromePath)
  add(process.env.DSH_BROWSER_LIVE_CHROME)
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles (x86)'] || 'C:\\Program Files (x86)'
  const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  add(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  add(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  add(path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  add(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  add(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  add(path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
  add(path.join(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
  return found
}

function findChrome() {
  return findChromiumExes()[0] || null
}

/** 本包 extension/ 的绝对路径 —— 装扩展时用户必须选中的那个目录。 */
function EXTENSION_DIR() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'extension')
}

/**
 * 某个浏览器种类的 exe（装扩展要落到用户**日常那个浏览器**里，不能用 findChrome()：
 * 它优先返回 Chrome，而用户可能只用 Edge —— 打开错的扩展页等于没帮上忙）。
 */
function exeForKind(kind) {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles (x86)'] || 'C:\\Program Files (x86)'
  const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const map = {
    edge: [
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    chrome: [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  }
  for (const t of (map[kind] || [])) { try { if (existsSync(t)) return t } catch { /* ignore */ } }
  return null
}

/** 把一段文本放进 Windows 剪贴板（cmd 的 clip 读 stdin）。失败不致命：返回值里照样给 token。 */
function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    let p
    try { p = spawn('cmd.exe', ['/c', 'clip'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }) }
    catch (e) { reject(e); return }
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(true) : reject(new Error('clip 退出码 ' + code))))
    try { p.stdin.end(String(text)) } catch (e) { reject(e) }
  })
}

/** 打开一个"看一眼就行"的外部程序（扩展页 / 资源管理器目录）：detached + unref，不等它退出。 */
function openDetached(exe, args) {
  const p = spawn(exe, args, { stdio: 'ignore', detached: true })
  p.unref()
  return p
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
  browser.local = cdp
  browser.primary = cdp
  // 插件自拉实例的会话也就是这条连接
  const sp = browser.sessions.get('plugin')
  if (sp) sp.cdp = cdp
  // 正在驱动用户浏览器时不要把插件实例顶上来；桥断了 onBridgeStatus 会把 local 接回去
  if (browser.session && browser.session.kind === 'plugin') browser.cdp = cdp
  return cdp
}

/**
 * 用 VBS 启动器把 Chrome 拉成"没有父作业对象的独立进程"。
 * 为什么不是 spawn 的 detached:true：那个只保证 Node 不等它，Windows 上子进程照样继承/留在
 * 同一作业对象里；实测在 DSH Desktop 这条链上拉起的 Chrome **拿不到窗口句柄**（窗口不注册）。
 * 独立进程 + 可见窗口是这台机器上唯一稳定出窗口的路径（已由同类启动方式的对照实验支持）。
 * 启动器脚本写在数据目录里（极小，VBScript；不引入任何依赖），失败即当返回值 false 由调用方回退。
 */
export function writeDetachedLauncher(exe, args) {
  mkdirSync(BASE_DIR(), { recursive: true })   // 首次启动/全新数据目录时这里还不存在
  const vbs = path.join(BASE_DIR(), 'launch-chrome-detached.vbs')
  const lit = (s) => '"' + String(s).replace(/"/g, '""') + '"'
  const cmd = [lit(exe), ...args.map(lit)].join(' ')
  const body = [
    "' dsh-browser-live：把浏览器拉成独立进程，使其拥有真实窗口（由插件自动生成，可删）",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = ' + lit(path.dirname(exe)),
    'sh.Run ' + lit(cmd) + ', 1, False',
    '',
  ].join('\r\n')
  // 必须写 **UTF-16LE + BOM**：wscript 默认按 ANSI 代码页读 .vbs，
  // 而用户名/路径里只要有中文（C:\Users\陈道云\…），UTF-8 写出来的就会被读成
  // `C:\Users\闄堥亾浜慭\…` —— 那是条不存在的路径，浏览器一个进程都不会起，
  // 而错误表现只是"未响应 CDP 端口"，极难定位（本机实测踩过，还在 C:\Users 下留下了乱码目录）。
  writeFileSync(vbs, '\ufeff' + body, 'utf16le')
  return vbs
}

/**
 * 启动后自查"窗口到底存不存在"：CDP 的 Browser.getWindowForTarget/getWindowBounds 是 Chrome
 * 自己报的，不依赖我这边能不能枚举 Win32 窗口 —— 所以把结论写进观察窗动作条，用户一眼可判。
 */
export async function reportWindowState(port) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
    const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!page) return '⚠ 启动后自查：拿不到页面目标，无法确认窗口'
    const { WebSocket } = await loadWs()
    if (!WebSocket) return '⚠ 启动后自查：WebSocket 不可用'
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch { /* ignore */ } }
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 4000) })
    const send = (method, params) => new Promise((res, rej) => {
      const mid = ++id
      pending.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(mid + ': timeout')) } }, 4000)
    })
    try {
      const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.id })
      const bounds = await send('Browser.getWindowBounds', { windowId })
      const b = bounds?.bounds || {}
      const visible = b.windowState !== 'minimized'
      // 顺手保证"可见且够大"：windowState 只认 normal/maximized，尺寸给到设置里的 windowSize
      try {
        const [w, h] = String(settings.windowSize || '1440,900').split(',').map((n) => Number(n) || 0)
        if (w > 400 && h > 300) await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: w, height: h } })
      } catch { /* 老版本 Chrome 不支持就跳过 */ }
      ws.close()
      return (visible ? '✓ 启动后自查：窗口存在且可见' : '⚠ 启动后自查：窗口存在但被最小化')
        + '（windowId=' + windowId + '，state=' + (b.windowState || '?') + '，' + (b.width || '?') + 'x' + (b.height || '?') + '）'
        + (visible ? '，屏幕上看不到就是被别的窗口盖住了' : '')
    } finally { try { ws.close() } catch { /* ignore */ } }
  } catch (e) { return '⚠ 启动后自查窗口失败：' + String(e?.message || e) }
}

async function launch() {
  // 用户浏览器会话：不拉任何进程，直接用扩展那条链路
  const cur = browser.session
  if (cur && isUserKind(cur.kind)) {
    cur.cdp = browser.bridge ? browser.bridge.cdpFor(cur.kind) : null
    if (cur.cdp && cur.cdp.alive) {
      cur.userClosed = false
      viewOf(cur)
      await refreshTabs(cur).catch(() => {})
      return
    }
  }
  // 走到这里就是"要插件自拉实例"：先把它设成活跃会话，再拉进程（进程/端口这些资源
  // 都属于插件实例，跟用户浏览器那条链路无关）。
  const ps = sessionOf('plugin')
  if (browser.session !== ps) viewOf(ps)
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
        await refreshTabs(ps).catch(() => {})
        console.log(`[dsh-browser-live] 接管已运行中的浏览器（:${last.port}）`)
        return
      }
    }
  } catch { /* 无状态文件 */ }

  const exes = findChromiumExes()
  if (!exes.length) throw new Error('未找到 Chrome/Edge/Brave；在设置里填 chromePath，或装一个 Chromium')

  const failures = []
  for (const exe of exes) {
    const label = path.basename(exe)
    // 选一个**本机没有别的 CDP 在听**的端口：9600~9899 里随机挑也可能正好撞上别的浏览器
    // （或上次没退干净的实例）的调试端口，那时 probePort 会返回**别人**的 WebSocket，
    // 插件就附加到错误的那台浏览器上了（本机实测撞到过 Edge 的调试实例）。
    // 尝试序列：先按"记住的成功参数"（或什么都不加）试一次，失败再补一轮兼容参数。
    const saved = compatFlagsFor(exe)
    const attempts = saved.length ? [saved] : [[], COMPAT_FLAGS]
    for (const extra of attempts) {
      // 选一个**本机没有别的 CDP 在听**的端口：9600~9899 里随机挑也可能正好撞上别的浏览器
      // （或上次没退干净的实例）的调试端口，那时 probePort 会返回**别人**的 WebSocket，
      // 插件就附加到错误的那台浏览器上了（本机实测撞到过 Edge 的调试实例）。
      let port = 0
      for (let i = 0; i < 24; i++) {
        const cand = 9600 + Math.floor(Math.random() * 300)
        if (!(await probePort(cand))) { port = cand; break }
      }
      if (!port) { failures.push(label + '：9600~9899 端口全被占用'); break }

      // 每个浏览器用**各自的** profile 目录：Chrome 与 Edge 共用一个目录会互相改对方的数据。
      const profile = CHROME_PROFILE(exe)
      mkdirSync(profile, { recursive: true })
      const args = [
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        `--window-size=${settings.windowSize}`,
        // 代理：独立实例也走你指定的出口（http://host:port / socks5://host:port）；留空=跟随系统
        ...(settings.proxy ? [`--proxy-server=${settings.proxy}`] : []),
        ...parseExtraArgs(settings.extraArgs),
        ...(settings.headless ? ['--headless=new'] : []),
        ...extra,                     // 兼容参数放最后，不会被用户自己的 extraArgs 顶掉
        'about:blank',
      ]
      let launched = false
      if (settings.launchDetached !== false) {
        try {
          const vbs = writeDetachedLauncher(exe, args)
          const wscriptExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
          browser.proc = spawn(wscriptExe, [vbs], { stdio: 'ignore', windowsHide: true })
          browser.proc.on('exit', () => { browser.proc = null })
          browser.detachedLaunch = true
          launched = true
        } catch (e) {
          console.warn('[dsh-browser-live] 独立启动器不可用，回退自身子进程:', e?.message)
          browser.detachedLaunch = false
        }
      }
      if (!launched) {
        browser.proc = spawn(exe, args, { stdio: 'ignore', detached: false })
        browser.proc.on('exit', () => { browser.proc = null })
        browser.detachedLaunch = false
      }
      // 等 CDP：VBS 启动器自己会立刻退出（不代表浏览器没起），所以这里只能按时间等。
      let ws = null
      for (let i = 0; i < 40; i++) {
        await sleep(250)
        ws = await probePort(port)
        if (ws) break
      }
      if (ws) {
        browser.port = port
        const compat = { ...(readState().compat || {}) }
        if (extra.length) compat[label] = extra; else delete compat[label]
        writeState({ port, compat })
        await attachCdp(ws)
        console.log(`[dsh-browser-live] 浏览器已启动（${label} :${port}${browser.detachedLaunch ? ' · 独立进程（有独立窗口）' : ' · 宿主子进程'}${extra.length ? ' · 兼容参数 ' + extra.join(' ') : ''}）`)
        if (failures.length) noteAction(`⚠ ${failures.join('；')}，已自动改用 ${label}`)
        if (extra.length) noteAction(`🩹 ${label} 需要兼容参数才能启动：${extra.join(' ')}（通常是安全软件拦了 GPU 进程沙箱）。已记住，下次直接用`)
        // 让窗口可见性变成"可观测事实"，而不是靠用户反馈
        reportWindowState(port).then((msg) => noteAction('🪟 ' + msg)).catch(() => {})
        return
      }
      try { if (browser.proc) browser.proc.kill() } catch { /* 已经退了 */ }
      browser.proc = null
      failures.push(label + (extra.length ? `（含 ${extra.join(' ')}）` : '') + '：10 秒内没响应 CDP 端口')
      console.warn(`[dsh-browser-live] ${label}${extra.length ? '（兼容参数）' : ''} 起不来`)
    }
  }
  throw new Error('没有浏览器能起来：' + failures.join('；')
    + '。常见原因两种：① 安全软件拦掉 Chrome **GPU 进程**的沙箱初始化（本机实测是火绒 HipsDaemon，'
    + '表现是"起来又立刻静默退出"）—— 插件已自动补试 --in-process-gpu（渲染器沙箱仍保留），'
    + '仍失败就把 chromePath 指向 Edge 等其它 Chromium；② 机器上没有可用的 Chromium 系浏览器。')
}

async function shutdown(kill, only) {
  const s = only || browser.session || sessionOf('plugin')
  // 用户浏览器会话：只拆调试器，绝不关人家的浏览器
  if (isUserKind(s.kind)) {
    const sids = s.tabs.map((t) => t.sessionId).filter(Boolean)
    for (const sid of sids) {
      try { await (s.cdp || browser.bridge)?.send('Target.detachFromTarget', { sessionId: sid }, undefined, 5000) } catch { /* 已经掉了 */ }
    }
    s.userClosed = true
    s.tabs = []; s.selected = null
    if (browser.session === s) viewOf(s)
    noteAction(`已断开对 ${kindLabel(s.kind)} 的读取（浏览器本身没关）`)
    return
  }
  browser.dying = true
  try { s.cdp?.send('Browser.close', {}).catch(() => {}) } catch {}
  await sleep(150)
  // 独立启动时 proc 是启动器，杀它没用；Browser.close（上面那条 CDP）才是真正关 Chrome 的手段
  try { if (kill && browser.proc && !browser.detachedLaunch) browser.proc.kill() } catch {}
  try { s.cdp?.close() } catch {}
  s.cdp = null; s.tabs = []; s.selected = null
  browser.primary = null; browser.local = null; browser.proc = null
  if (browser.session === s) viewOf(s)
  browser.dying = false
}

function alive() { return aliveOf(browser.session) }

async function refreshTabs(s0) {
  const s = s0 || browser.session || sessionOf('plugin')
  if (!s.cdp) throw new Error(`${isUserKind(s.kind) ? kindLabel(s.kind) : '插件自带实例'} 未连接`)
  const { targetInfos } = await s.cdp.send('Target.getTargets', {})
  const pages = targetInfos.filter((t) => t.type === 'page')
  // 丢弃已消失的本地 tab 记录
  s.tabs = s.tabs.filter((t) => pages.some((p) => p.targetId === t.targetId))
  for (const p of pages) {
    const allowed = p.allowed !== false          // 本地 CDP 没有这个字段 → 视为允许
    const fresh = { targetId: p.targetId, sessionId: null, url: p.url || '', title: p.title || '', allowed }
    const t = s.tabs.find((x) => x.targetId === p.targetId)
    if (!t) { s.tabs.push(fresh); continue }
    t.allowed = allowed
    if (!allowed) {
      // 扩展打码时必须**覆盖**本地缓存：否则被撤销授权后 url 会留在 host 里（隐私泄漏）
      t.url = ''; t.title = '(未授权站点)'
    } else if (t.url === '' && t.title === '(未授权站点)') {
      t.url = p.url || ''; t.title = p.title || ''    // 刚从打码恢复，别把打码值当"旧值"留着
    } else {
      t.url = p.url || t.url; t.title = p.title || t.title
    }
    if (!allowed) t.sessionId = null
  }
  if (!s.tabs.length || (s.selected && !s.tabs.find((t) => t.targetId === s.selected))) s.selected = s.tabs[0]?.targetId || null
  if (browser.session === s) viewOf(s)
  return s.tabs
}

async function waitTargetGone(targetId, tries = 12, s0) {
  const s = s0 || browser.session
  // Target.closeTarget 是异步生效的：轮询确认它真的从 getTargets 消失，避免"刚关完就列表"竞态
  for (let i = 0; i < tries; i++) {
    await refreshTabs(s)
    if (!s.tabs.some((t) => t.targetId === targetId)) return true    // 真的关掉了
    await sleep(120)
  }
  return false                                                       // 还在 —— 说明被拒绝或没生效
}

/** 会话 id 归一：用户浏览器的 sessionId 一律带 `<kind>:` 前缀。
 *  为什么必做：桥靠前缀把请求/事件路由到正确的那条扩展连接（docs/MULTI-BROWSER.md §3）。
 *  `Target.attachToTarget` 的回包里本来就带着前缀（扩展加的），但**不能假设**这一点 ——
 *  否则一旦某条路径把裸 id 存进 browser.tabs，事件回来时就认不出是哪台浏览器了。
 *  幂等：已带前缀的直接返回。插件实例（本地 CDP）不加前缀，不受影响。 */
function prefixSid(s, sid) {
  const id = String(sid || '')
  if (!id || !s || !isUserKind(s.kind)) return id
  return id.startsWith(s.kind + ':') ? id : `${s.kind}:${id}`
}

async function attachTab(tab, s0, intendedUrl) {
  if (tab.sessionId) return tab
  const s = s0 || browser.session
  const params = { targetId: tab.targetId, flatten: true }
  // 用户浏览器档：把"这次想去哪个站点"一并交给扩展。当前页未授权、目标页已授权时，
  // 扩展会**先导航过去再附加**（extension/background.js 的 attachTab）——
  // 否则"我允许了 github.com，但前台开着别的页"这种最常见用法会在切会话这一步就被闸死。
  if (intendedUrl && isUserKind(s.kind)) params.intendedUrl = String(intendedUrl)
  const att = await s.cdp.send('Target.attachToTarget', params)
  const sessionId = prefixSid(s, att && att.sessionId)
  // 用户浏览器档在"当前页未授权、目标页已授权"时，扩展会**新开一个标签页**（不动你正在看的页面），
  // 附加到的是那个新标签页 —— 扩展把真实 tabId 一起报回来，这里据此纠正映射。
  // 不纠正的话：列表显示"旧标签页已附加"，而 agent 的截图/点击落在另一个标签页上，排查起来极难。
  let target = tab
  const realTabId = att && att.tabId != null ? String(att.tabId) : String(tab.targetId)
  if (realTabId !== String(tab.targetId)) {
    await refreshTabs(s).catch(() => {})
    const moved = s.tabs.find((t) => String(t.targetId) === realTabId)
    if (moved) {
      tab.sessionId = null
      target = moved
      s.selected = moved.targetId
      if (browser.session === s) viewOf(s)
    } else {
      // 新标签页还没出现在列表里（时序）——至少别把会话挂到旧标签页上
      tab.sessionId = null
    }
  }
  target.sessionId = sessionId
  // 注意：事件监听挂在**本会话自己的传输**上，且闭包持有本会话的 sessionId —— 这样
  // Chrome 与 Edge 同时在用时，事件不会串到另一个浏览器去。
  const cdp = s.cdp
  await cdp.send('Page.enable', {}, sessionId).catch(() => {})
  await cdp.send('Runtime.enable', {}, sessionId).catch(() => {})
  await cdp.send('DOM.enable', {}, sessionId).catch(() => {})
  try { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS_DIR(), eventsEnabled: true }, sessionId) } catch {}
  // 标签页 URL/标题变化 → 同步状态
  cdp.on('Page.javascriptDialogOpening', (p) => {
    if (p.sessionId === sessionId) noteAction(`⚠ ${kindLabel(s.kind)} 页面弹出对话框：` + (p.message || p.type))
  })
  // 留痕补口：**页面自己发起**的跳转（点链接触发的导航）不在任何工具参数里，
  // 只靠工具埋点会看到"点了某个按钮"却看不到"最后落在哪个 URL"。只记主框架，iframe 太吵。
  cdp.on('Page.frameNavigated', (p) => {
    try {
      if (p.sessionId !== sessionId) return
      const f = p.frame || {}
      if (f.parentId) return
      if (!f.url || f.url === 'about:blank') return
      AUDIT.audit('nav', { url: String(f.url).slice(0, 800), targetId: p.targetId, browser: s.kind, backend: s.backend })
    } catch { /* 留痕不该影响导航 */ }
  })
  return target
}

async function selectedTab(s0, intendedUrl) {
  const s = s0 || browser.session
  if (!aliveOf(s)) throw new Error('浏览器未运行；先 browser_open')
  await refreshTabs(s)
  if (!s.tabs.length) {
    if (isUserKind(s.kind)) {
      throw new Error(`${kindLabel(s.kind)} 里没有可用标签页：先在那个浏览器里打开一个页面，并在扩展弹窗里点「允许」该站点`)
    }
    const { targetId } = await s.cdp.send('Target.createTarget', { url: 'about:blank' })
    s.tabs.push({ targetId, sessionId: null, url: 'about:blank', title: '' })
    s.selected = targetId
  }
  if (!s.selected) s.selected = s.tabs[0].targetId
  const tab = s.tabs.find((t) => t.targetId === s.selected)
  // 必须用 attachTab 的**返回值**：用户浏览器档在"当前页未授权、目标站已授权"时会新开标签页，
  // 真正被附着的不是点名的那个。v0.8.3 第一版返回了旧的 tab，于是 browser_open 又把前台那个
  // 未授权页导航了一遍 —— 新标签页开了、你正在看的页面却照样被改写，等于白改。
  const attached = await attachTab(tab, s, intendedUrl)
  if (browser.session === s) viewOf(s)
  return attached
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

const USE_PROP = {
  type: 'string',
  description: "可选，这次调用用哪个浏览器：'plugin'=插件自带实例（免授权，冷启动默认）；'chrome'/'edge'=你的日常浏览器（需该浏览器扩展已连接）；'user'=settings.userDefault 指定的那个；'auto'=桥连着就用你的浏览器。"
    + "不填=沿用上一次调用用的那个（避免相邻两次调用莫名换浏览器）；要你的登录态（后台、飞书、公司系统）时显式写 'edge' 或 'chrome'。",
}

function makeTool(definer) {
  /** 统一注册入口：lock + action 日志 + 自动拉起浏览器 */
  function tool({ name: tname, description, parameters, execute, autostart = true, noUse = false }) {
    return definer({
      name: tname,
      description,
      // use 统一在这里注入：工具各自只需要读 args.use（不用每个都抄一遍 schema）
      parameters: noUse ? (parameters || {}) : { use: USE_PROP, ...(parameters || {}) },
      output: { schema: { type: 'string' }, render: (_a, v) => txt(typeof v === 'string' ? v : safeJson(v)) },
      presentCall: (args) => ({ card: 'generic', title: tname, kind: 'other', rawInput: args }),
      async execute(args, exec) {
        return withLock(async () => {
          const once = async () => {
            let s = browser.session
            // browser_open 自己会 useSession + launch，所以这里不要抢在它前面拦下来 ——
            // 否则 browser_close 之后（userClosed=true，会话还在但"已断开"）再 open 会被这层
            // 守卫直接判成"未接入"，永远接不回去。其它工具则照旧在入口把会话定好。
            let handled = false
            if (!noUse && tname !== 'browser_open') s = await useSession(args.use)
            else if (tname === 'browser_open') handled = true
            if (!aliveOf(s) && !handled) {
              if (isUserKind(s.kind)) {
                // 用户的浏览器不能被"拉起"：没连上就只有明确报错，绝不静默换到插件实例去
                return safeJson({
                  ok: false,
                  error: `${kindLabel(s.kind)} 未接入或已断开：扩展没在跑，或你在弹窗里断开了`,
                  hint: `在 ${kindLabel(s.kind)} 里点扩展图标 → 确认状态是「已连接」；要改用插件自带实例就传 use:"plugin"`,
                })
              }
              if (!autostart) return safeJson({ ok: false, error: '浏览器未运行' })
              browser.panelWanted = true   // 冷启动才请求弹观察窗（客户端 ack 后清除）
              await launch()
            }
            noteAction(tname + ' ' + brief(args))
            const r = await execute(args, exec || {})
            return typeof r === 'string' ? r : safeJson(r)
          }
          try {
            return await once()
          } catch (e) {
            const msg = String(e?.message || e)
            // 用户浏览器：扩展侧会话可能已经没了（MV3 SW 重启 / 调试器被 DevTools 抢走 /
            // 标签页重载），而 host 的 tabs 还记着旧 sessionId —— 清一次再重试。
            const s = browser.session
            if (s && isUserKind(s.kind) && /会话已失效|未附加|session/i.test(msg)) {
              for (const t of s.tabs) t.sessionId = null
              try { return await once() } catch (e2) {
                return safeJson({ ok: false, error: String(e2?.message || e2), note: `重新附加后仍失败：在 ${kindLabel(s.kind)} 的扩展弹窗里确认该站点已「允许」，或标签页是否被关闭` })
              }
            }
            return safeJson({ ok: false, error: msg, note: '本次调用失败；若浏览器掉线会自动在下次调用重连，必要时先 browser_open' })
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
    description: '启动/接管浏览器（懒启动，profile 持久保留登录态）。给 url 则新开或导航该页；不给则确保浏览器在跑并返回当前标签页。'
      + '默认用**插件自带实例**：独立窗口 + 独立 profile，不碰用户日常浏览器，**不受逐站点授权限制** —— '
      + '免登录网页（公开页、插件 UI 自查、落地页巡检、竞对情报）一律用它，直接开、无需任何授权，可 newTab 新开页。'
      + '需要"你自己的登录态"（后台、飞书文档、公司系统）时传 use:"edge" 或 use:"chrome"（你日常那个浏览器，扩展必须已连接）：'
      + '那一档逐站点授权、默认只读，站点没在扩展弹窗里点过「允许」会直接报"站点未授权"；扩展硬拒 Target.createTarget，所以只导航当前页、不能新开标签页。'
      + '做回免登录的事时传 use:"plugin" 切回插件实例。返回值里的 browser/hint 会告诉你当前实际用哪个浏览器。'
      + 'gui:true = 在插件实例里打开 **DSH 自己的 Web GUI**（用宿主 connection 服务签发的带 token 的已认证 URL；'
      + '插件 Chrome 是干净 profile，直接访问根路径会 401 "dsh web authentication required"，所以必须走这个 URL）。'
      + '第一次调用后网页会实时出现在右下角观察窗里，用户可随时接管。',
    parameters: {
      url: { type: 'string', description: '可选，要打开的 URL' },
      newTab: { type: 'boolean', description: 'true=新开标签页（默认在当前页导航；用户浏览器那一档被扩展拒绝，只导航当前页）' },
      gui: { type: 'boolean', description: 'true=打开 DSH 自己的 Web GUI（自动用带 launch token 的已认证 URL；与 url 互斥）' },
    },
    async execute(args) {
      let url = args.url
      if (args.gui) {
        const u = guiAuthUrlNow()
        if (!u) {
          return {
            ok: false,
            error: '拿不到 DSH GUI 的已认证 URL（宿主 connection 服务未就绪或没暴露 authenticatedUrl）',
            hint: '替代办法：把 DSH 启动时打印的 `dsh web: http://127.0.0.1:<端口>/?token=…` 原样粘到目标浏览器里打开一次，token 会换成正常 cookie（303 落地），之后那个浏览器就能一直开 GUI 了。',
          }
        }
        url = u
      }
      const s = await useSession(args.use)
      if (!aliveOf(s)) await launch()
      // 把目标 URL 交给 selectedTab：用户浏览器档若当前页未授权、而目标页已授权，
      // 扩展会先导航过去再附加（见 attachTab 的 intendedUrl）。
      const tab = await selectedTab(s, url)
      if (url) {
        if (args.newTab) { const { targetId } = await browser.cdp.send('Target.createTarget', { url }); browser.selected = targetId; await refreshTabs(); await attachTab(browser.tabs.find((x) => x.targetId === targetId)) }
        else { await gotoUrl(tab, url) }
      } else if (/^about:blank$/.test(tab.url || '')) {
        await gotoUrl(tab, 'about:blank')
      }
      await refreshTabs()
      const cur = browser.tabs.find((x) => x.targetId === browser.selected)
      const userKind = isUserKind(s.kind)
      const ks = connectedKinds()
      return {
        ok: true,
        browser: userKind ? `你的 ${kindLabel(s.kind)}` : '插件自带实例',
        use: s.kind,
        connected: ks,
        url: cur?.url, title: cur?.title, tabs: browser.tabs.length,
        hint: userKind
          ? `当前在你的 ${kindLabel(s.kind)} 里：站点未授权会直接报错（点扩展图标 →「允许此站点」或「允许当前所有标签页」）；`
            + '要点击/打字还得在弹窗里打开「允许操作」。要回到免授权、可新开页面的插件自带实例，再调 browser_open {use:"plugin"}。'
          : `当前在插件自带实例（免授权、可新开页面）。要用你的登录态就传 use:"${ks.includes(settings.userDefault) ? settings.userDefault : (ks[0] || 'edge')}"`
            + `（已接入：${ks.length ? ks.map(kindLabel).join('、') : '暂无'}）`
            + (ks.length ? '' : '—— 一台都没接入就先调 browser_ext_setup，它会把桥、token、扩展目录和扩展页一次备好')
            + '；做完再 {use:"plugin"} 切回来。',
      }
    },
  }))

  tools.push(t({
    name: 'browser_ext_setup',
    description: '一键准备「接管你日常浏览器」这件事 —— 把装扩展之前的现场全部摆好。它会：'
      + '① 打开用户浏览器桥（settings.userBridge=true，即时生效，不用重启 DSH）；'
      + '② 取出配对 token 并放进剪贴板；③ 在目标浏览器里打开它的扩展页；'
      + '④ 在资源管理器里打开本包的 extension 目录。'
      + '你只剩三下点击：开「开发者模式」→「加载解压缩的扩展」选那个目录 → 粘 token 点「连接」。'
      + '装完用 browser_open {use:"edge"} 验证，再在扩展弹窗里点「允许当前所有标签页」给我操作权限。'
      + '排查也用它：桥没开 / 扩展没装 / 站点没授权，返回值会写明是哪一种。',
    parameters: {
      kind: { type: 'string', description: "装到哪个浏览器：'edge' 或 'chrome'（默认 settings.userDefault，再退回 'edge'）" },
      open: { type: 'boolean', description: '默认 true：顺手打开扩展页、扩展目录并把 token 放进剪贴板；false 只返回步骤、路径与 token' },
    },
    async execute(args) {
      const kind = String(args.kind || settings.userDefault || 'edge').toLowerCase()
      if (kind !== 'edge' && kind !== 'chrome') {
        return { ok: false, error: `kind 只能是 'edge' 或 'chrome'（收到 "${kind}"）` }
      }
      const extensionDir = EXTENSION_DIR()
      const bridgeFile = BRIDGE_FILE(BASE_DIR())
      const did = []

      // ① 桥：没开着就打开（配置落盘 + 即时起服务，与面板开关同一条路径）
      if (settings.userBridge !== true) {
        settings.userBridge = true
        saveSettings()
        did.push('已把 settings.userBridge 设为 true 并落盘')
      }
      await syncBridge()
      const st = browser.bridge ? browser.bridge.status() : { enabled: false, connected: false, port: settings.bridgePort }
      const token = (browser.bridge && browser.bridge.token) || ''
      if (!st.enabled) {
        return {
          ok: false,
          error: '桥没起来：settings.userBridge 已是 true 但服务没监听本机端口 —— 多半是 ws 包没解析到，看 DSH 日志里 [dsh-browser-live] 的告警',
          bridge: st, extensionDir, bridgeFile, did,
        }
      }

      // ② 摆现场：扩展页 + 扩展目录 + 剪贴板（任何一步失败都只记 warning，不掩盖主流程）
      const opened = {}
      if (args.open !== false) {
        const extPage = kind === 'edge' ? 'edge://extensions' : 'chrome://extensions'
        const exe = exeForKind(kind)
        if (exe) {
          try { openDetached(exe, [extPage]); did.push(`已在 ${kindLabel(kind)} 里打开 ${extPage}`) }
          catch (e) { opened.browser = '打开扩展页失败：' + String(e?.message || e) }
        } else { opened.browser = `没找到 ${kindLabel(kind)} 的 exe，请手动打开 ${extPage}` }
        try { openDetached('explorer.exe', [extensionDir]); did.push('已在资源管理器里打开扩展目录') }
        catch (e) { opened.explorer = '打开扩展目录失败：' + String(e?.message || e) }
        try { await copyToClipboard(token); did.push('token 已复制到剪贴板') }
        catch (e) { opened.clipboard = '复制 token 失败（手动从下面的 token 字段或 ' + bridgeFile + ' 取）：' + String(e?.message || e) }
      }

      return {
        ok: true,
        kind,
        bridge: { enabled: !!st.enabled, connected: !!st.connected, port: st.port, browsers: browsersView() },
        token,
        extensionDir,
        bridgeFile,
        did,
        ...(Object.keys(opened).length ? { warnings: opened } : {}),
        steps: [
          `① 在刚打开的 ${kind === 'edge' ? 'Edge' : 'Chrome'} 扩展页右上角打开「开发者模式」`,
          '② 点「加载解压缩的扩展」（Edge 也可能写作「加载未打包的扩展程序」）',
          `③ 选中目录：${extensionDir}`,
          '④ 点工具栏里刚出现的扩展图标 → 粘上 token（应已在剪贴板）→ 点「连接」',
          '⑤ 再点「允许当前所有标签页」把要交给我操作的站点一次授权；要我真点击/打字，同时打开「允许操作」',
        ],
        verify: `装完调 browser_open {use:"${kind}"} 验证：返回值 connected 会列出已接入的浏览器。`,
        note: '扩展只需装一次；桥重启后 token 会变，变了就在扩展弹窗里重粘一次。',
      }
    },
  }))

  tools.push(t({
    name: 'browser_close',
    description: '关掉当前这台调用所用的浏览器：插件自带实例=真的关掉窗口（不删用户数据目录，登录态保留）；'
      + '用户的 Chrome/Edge=只断开调试器、不关人家的浏览器（再调就恢复读取）。任务做完后调用。',
    parameters: {},
    autostart: false,
    async execute() {
      const s = browser.session
      if (!aliveOf(s)) return { ok: true, note: '浏览器本来就没在跑' }
      await shutdown(true)
      return { ok: true, browser: isUserKind(s.kind) ? `你的 ${kindLabel(s.kind)}` : '插件自带实例' }
    },
  }))

  tools.push(t({
    name: 'browser_navigate',
    description: '导航到 URL（自动等加载完成）。',
    parameters: { url: { type: 'string', required: true, description: '目标 URL；无 scheme 时自动补 https://' } },
    async execute(args) { const tab = await selectedTab(undefined, args.url); return gotoUrl(tab, args.url) },
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
      const view = () => browser.tabs.map((x, i) => ({ i, url: x.url, title: x.title, selected: x.targetId === browser.selected, allowed: x.allowed !== false }))
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
      if (act === 'close') {
        // v0.8.5：错误不再吞掉。用户浏览器档只允许关"agent 自己开的"标签页，
        // 被扩展拒绝时必须让人看见原因 —— 原来 .catch(()=>{}) 会返回 ok:true，看着像关成功了。
        let err = null
        try { await browser.cdp.send('Target.closeTarget', { targetId: tab.targetId }) } catch (e) { err = e }
        if (browser.selected === tab.targetId) browser.selected = null
        const gone = await waitTargetGone(tab.targetId)
        if (!gone) throw new Error('关闭标签页失败：' + String((err && err.message) || '标签页没有被关掉（多半是被扩展拒绝了：只能关 agent 自己打开的标签页，或弹窗里那个开关关着）'))
        return { ok: true, tabs: view() }
      }
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

// ------------------------------------------------------------- 用户浏览器桥（多浏览器）

/** 桥的连接发生变化：把每条会话的传输重新兜一遍，并让"刚断开的那个"退场。 */
function onBridgeStatus(st) {
  const kinds = st && Array.isArray(st.kinds)
    ? st.kinds
    // 兜底也要给 kind：v1 形状的 st.browser 是**完整 UA**（不是 kind），塞进 Set 会让
    // live.has('chrome') 永远为 false，把所有 user 会话误判离线（子代理 review 抓到的坑）。
    : (Array.isArray(st?.browsers) ? st.browsers.map((b) => b.kind) : [])
  const live = new Set(kinds.filter(Boolean))
  const wasEmpty = ![...browser.sessions.values()].some((s) => isUserKind(s.kind) && s.cdp)
  for (const s of browser.sessions.values()) {
    if (!isUserKind(s.kind)) continue
    if (live.has(s.kind)) {
      s.cdp = browser.bridge ? browser.bridge.cdpFor(s.kind) : null
      s.userClosed = false
      s.tabs = []; s.selected = null
      s.lastPos = null
      noteAction(`🔴 已接入你的 ${kindLabel(s.kind)}（逐站点授权；「允许操作」开着才能点击/打字）`)
    } else {
      if (s.cdp) noteAction(`已断开 ${kindLabel(s.kind)}（浏览器本身没关）`)
      s.cdp = null
      s.tabs = []; s.selected = null; s.userClosed = false
      // 断开的就是当前活跃会话 → 退回插件实例，避免后续调用对着空气发指令
      if (browser.session === s) viewOf(sessionOf('plugin'))
    }
  }
  // backendMode='user' 的语义是"默认就用你的浏览器"：桥从"一台都没有"变成"有"时，
  // 就把活跃会话切过去。只在 0→N 这一次切换，免得你手动 use 指定过的浏览器被反复顶掉。
  if (wasEmpty && live.size && settings.backendMode === 'user') {
    const want = live.has(settings.userDefault) ? settings.userDefault : kinds[0]
    if (want) {
      try { viewOf(sessionOf(want)) } catch { /* ignore */ }
      noteAction(`🟢 backendMode=user：已切到你的 ${kindLabel(want)}`)
    }
  }
  if (browser.session) viewOf(browser.session)
}

/**
 * 把 BridgeServer 包装成"某个浏览器专属的 CDP 传输"，形状与 Cdp 一致
 * （send / on / close / alive），于是会话层不需要知道背后是桥还是本地端口。
 *
 * sessionId 的 `<kind>:` 前缀由扩展负责加/剥（见 docs/MULTI-BROWSER.md §3）：
 * host 只是把它原样透传，靠前缀决定投给哪条扩展连接。
 */
function bridgeCdpFor(bridge, kind) {
  if (!bridge) return null
  return {
    kind,
    get alive() {
      if (!bridge.alive) return false
      try { return typeof bridge.has === 'function' ? bridge.has(kind) : (bridge.list() || []).some((b) => b.kind === kind) } catch { return false }
    },
    send(method, params, sessionId, timeoutMs) { return bridge.send(method, params, sessionId, timeoutMs, kind) },
    on(event, fn) { return bridge.on(event, (params, sessionId, evKind) => { if (!evKind || evKind === kind) fn({ ...(params || {}), ...(sessionId ? { sessionId } : {}) }) }) },
    close() { try { if (typeof bridge.drop === 'function') bridge.drop(kind) } catch { /* ignore */ } },
  }
}

/** 按 settings.userBridge 起停桥；设置页改开关后调用即可即时生效。 */
async function syncBridge() {
  const want = settings.userBridge === true
  if (want && !browser.bridge) {
    const wsMod = await loadWsModule()
    if (!wsMod) { console.warn('[dsh-browser-live] 桥需要 ws 包（未解析到 WebSocketServer），用户浏览器模式不可用'); return }
    const srv = new BridgeServer({
      wsMod, baseDir: BASE_DIR(), port: settings.bridgePort, hostVersion: version,
      onStatus: (st) => { try { onBridgeStatus(st) } catch { /* ignore */ } },
    })
    srv.on('bl.detached', (p, sid, kind) => {
      // 标签页被关 / 调试器被 DevTools 或别的扩展抢走 → 立刻作废该浏览器的本地 sessionId，
      // 否则下一次工具调用会拿着死 session 去问扩展（表现为"会话已失效"）。
      const id = String(p?.sessionId || '')
      if (!id) return
      for (const s of browser.sessions.values()) {
        if (kind && s.kind !== kind) continue
        const t = s.tabs.find((x) => x.sessionId === id)
        if (t) t.sessionId = null
      }
    })
    try {
      await srv.start()
      browser.bridge = srv
      // 桥要能为每个浏览器 kind 造一条"专属 CDP 传输"（见 bridge.js 的 cdpFor）。
      // 缺了它就会退化成"所有调用都发往第一条连接"——那正是多浏览器最容易出的错，
      // 所以这里不静默兜底，直接把问题摆出来。
      if (typeof srv.cdpFor !== 'function') {
        srv.cdpFor = (kind) => bridgeCdpFor(srv, kind)
        console.warn('[dsh-browser-live] 桥未提供 cdpFor，已用 host 侧兜底实现（多浏览器路由可能不准，建议同步更新 bridge.js）')
      }
      onBridgeStatus(srv.status())
      console.log('[dsh-browser-live] 用户浏览器桥已启用 · token 在 ' + BRIDGE_FILE(BASE_DIR()))
    } catch (e) {
      console.warn('[dsh-browser-live] 桥启动失败：' + (e?.message || e))
    }
  } else if (!want && browser.bridge) {
    const srv = browser.bridge
    browser.bridge = null
    onBridgeStatus({ connected: false, kinds: [] })
    await srv.stop().catch(() => {})
  }
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
  const s = browser.session
  return {
    ok: true,
    alive: alive(),
    backend: browser.backend,          // plugin=插件自拉实例；user=你的日常浏览器
    use: s?.kind || 'plugin',          // 当前活跃会话的浏览器 kind（chrome/edge/plugin）
    browserLabel: s && isUserKind(s.kind) ? kindLabel(s.kind) : '插件自带实例',
    browsers: browsersView(),          // 每台已接入浏览器一行（给观察窗/设置页显示）
    bridge: browser.bridge ? browser.bridge.status() : { enabled: false, connected: false, port: settings.bridgePort },
    url: cur?.url || '',
    title: cur?.title || '',
    tabs: browser.tabs.map((tt, i) => ({ i, url: tt.url, title: tt.title, selected: tt.targetId === browser.selected })),
    vw: browser.meta.vw, vh: browser.meta.vh,
    lastAction: browser.actionLog.slice(-8),
    panelWanted: browser.panelWanted,
    downloads: browser.downloads.slice(-6),
    settings: { fps: settings.fps, quality: settings.quality, headless: settings.headless, userDefault: settings.userDefault },
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
  let auditedTools = 0
  for (const tool of builtTools) {
    const wrapped = withAudit(tool)
    if (wrapped !== tool) auditedTools++
    ctx.effect(() => ctx.tools.register(wrapped), `dsh-browser-live: ${tool.name} tool`)
  }

  // 立好"插件自带实例"这条会话，并把它设为初始活跃会话（此后 browser.* 视图始终跟着活跃会话走）
  viewOf(sessionOf('plugin'))

  const webServer = ctx.get('webServer')
  const offs = []

  // 拿"带 launch token 的 GUI URL"：与 dsh-web-app 打印 dsh web URL 用的是同一个宿主接口。
  // 宿主可能稍后才就绪（web-app 那边要等 loader settle），所以 inject 回调里能拿到才算数，
  // 拿不到也不影响任何既有功能（只是 browser_open {gui:true} 会给一条明确提示）。
  try {
    ctx.inject(['connection'], (c) => {
      guiAuthApi = c
      const u = guiUrlFromCtx(c)
      if (u) {
        guiAuthUrl = u
        console.log('[dsh-browser-live] 已取得 DSH GUI 已认证 URL（可在插件实例里打开 GUI）')
        noteAction('🔑 已取得 DSH GUI 已认证 URL（browser_open {gui:true} 可直接打开）')
      } else {
        console.warn('[dsh-browser-live] connection 服务在，但生成不了 GUI URL（webServer 端口未就绪？）')
      }
    })
  } catch (e) {
    console.warn('[dsh-browser-live] 无法注入 connection 服务（不影响浏览器功能）:', e?.message)
  }

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
    '#who{display:none;font-size:11px;padding:1px 7px;border-radius:99px;background:rgba(198,40,40,.18);border:1px solid rgba(198,40,40,.5);color:#ff9b93;flex:none}',
    '.dot{width:9px;height:9px;border-radius:50%;corner-shape:round;background:#b9bfc9;flex:none}',
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
    '#fsmsg{display:none;position:fixed;left:50%;bottom:52px;transform:translateX(-50%);max-width:min(680px,92vw);background:rgba(10,14,20,.92);border:1px solid rgba(255,123,114,.45);color:#ffd8d4;border-radius:8px;padding:7px 12px;font-size:12px;line-height:1.5;z-index:9}',
    '</style></head><body>',
    '<div id="hd"><span class="dot" id="dot"></span><span id="who"></span><span id="ttl">浏览器观察窗</span><span id="url"></span>',
    '<button id="rc" title="重连画面">⟳ 重连</button><button id="fs" title="全屏（也可以直接按 F11）">⛶ 全屏</button></div>',
    '<div id="tabs"></div>',
    '<div id="stage"><img id="img" alt="" draggable="false">',
    '<div id="empty">等待 agent 打开浏览器…<br>在 DSH 里调用任意 browser_* 工具后，这里会实时显示画面</div>',
    '<div id="act"></div><textarea id="key" spellcheck="false" autocomplete="off"></textarea></div>',
    '<div id="fsmsg"></div>',
    '<div id="ft"><button id="take">⌨ 接管:开</button>',
    '<label>FPS <select id="fps"><option>1</option><option selected>2</option><option>4</option><option>8</option></select></label>',
    '<label>画质 <select id="q"><option value="40">省流</option><option value="60" selected>默认</option><option value="80">高清</option></select></label>',
    '<button id="stop" class="danger">⏹ 关浏览器</button><span id="dl"></span></div>',
    '<script>',
    '(function(){',
    'var $=function(i){return document.getElementById(i)};',
    'var img=$("img"),dot=$("dot"),ttl=$("ttl"),url=$("url"),tabs=$("tabs"),act=$("act"),empty=$("empty"),key=$("key"),dl=$("dl"),who=$("who");',
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
    // 全屏：以前是一个裸 requestFullscreen()，被拒时静默 —— 用户看到的就是"点了没反应"。
    // 现在把失败原因说出来（被 iframe 的 permission policy 拦 / 浏览器不允许 / 元素失效），
    // 并给出一定能用的替代（F11）。失败不抛出去，免得把整个页面脚本带崩。
    'function fsMsg(t){var m=$("fsmsg");if(!m)return;m.textContent=t;m.style.display="block";clearTimeout(fsMsg.t);fsMsg.t=setTimeout(function(){m.style.display="none"},7000)}',
    '$("fs").addEventListener("click",function(){',
    '  try{',
    '    if(document.fullscreenElement||document.webkitFullscreenElement){',
    '      var ex=document.exitFullscreen||document.webkitExitFullscreen;',
    '      if(ex){var r=ex.call(document);if(r&&r.catch)r.catch(function(e){fsMsg("退出全屏失败："+e.message)})}',
    '      return;',
    '    }',
    '    var root=document.documentElement;',
    '    var req=root.requestFullscreen||root.webkitRequestFullscreen||root.mozRequestFullScreen||root.msRequestFullscreen;',
    '    if(!req){fsMsg("这个浏览器不支持脚本全屏（requestFullscreen 不存在）—— 请直接按 F11") ;return}',
    '    var p=req.call(root,{navigationUI:"hide"});',
    '    if(p&&p.catch)p.catch(function(e){',
    '      var why=(location!==window.top)?"本页被嵌在 iframe 里，父页面没给 allow=fullscreen 权限":"浏览器拒绝了这次请求";',
    '      fsMsg("全屏被拒："+why+"（"+e.name+": "+e.message+"）。替代：按 F11；或点面板标题栏的 ⧉ 在独立窗口里看")',
    '    })',
    '  }catch(e){fsMsg("全屏出错："+e.message+"（替代：按 F11）")}',
    '});',
    'function open(){if(es){try{es.close()}catch(e){}}try{es=new EventSource("/bl/stream");es.addEventListener("frame",function(ev){var d;try{d=JSON.parse(ev.data)}catch(e){return}vw=d.vw||vw;img.src="data:image/jpeg;base64,"+d.img;empty.style.display="none";dot.classList.add("on");var t=String(d.title||"浏览器观察窗").slice(0,90);ttl.textContent=t;url.textContent=trim(d.url)});es.addEventListener("offline",function(){dot.classList.remove("on")});es.onerror=function(){}}catch(e){}}',
    'function poll(){api("/bl/state").then(function(st){if(!st)return;dot.classList.toggle("on",!!st.alive);',
    'if(st.backend==="user"){who.style.display="inline-block";who.textContent=((st.bridge&&st.bridge.allowInput)?"🔴 正在操作你的":"🔴 正在读取你的")+(st.browserLabel||"日常浏览器")+((st.bridge&&st.bridge.allowInput)?"（可点击/打字）":"")}else{who.style.display="none";who.textContent=""}',
    'if(!st.alive){empty.style.display="flex";img.removeAttribute("src");ttl.textContent="浏览器观察窗";url.textContent=""}',
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
      kind: 'exact', path: '/bl/bridge',
      handler: (req, res) => {
        req.resume?.()
        const st = browser.bridge ? browser.bridge.status() : { enabled: false, connected: false, port: settings.bridgePort }
        sendJson(res, 200, {
          ok: true,
          ...st,
          // token 给的是"用户自己的 DSH 页面"（同源、无 CORS），方便一键复制到扩展里；
          // 网页/第三方 origin 读不到它（无 CORS 头），扩展的 WS 也只认 chrome-extension:// 的 Origin。
          token: browser.bridge ? browser.bridge.token : '',
          bridgeFile: BRIDGE_FILE(BASE_DIR()),
          extensionDir: EXTENSION_DIR(),
          browsers: browsersView(),
          userDefault: settings.userDefault,
          hint: settings.userBridge
            ? (st.connected
              ? `扩展已接入：${(st.browsers || []).map((b) => kindLabel(b.kind)).join('、')}`
              : `扩展未连接：在 Edge 用 edge://extensions、在 Chrome 用 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 ${EXTENSION_DIR()}，再把 token 粘进弹窗（agent 调 browser_ext_setup 可一键把这些都打开）`)
            : '桥未启用：点面板上的「启用桥」按钮，或让 agent 调 browser_ext_setup（等价于 PUT /bl/settings.json {userBridge:true}）',
        })
      },
    }), 'bl: bridge route'))
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
      // 取 / 用「DSH GUI 的已认证 URL」。
      // 安全取向：URL 里含 launch token，所以只认 POST + JSON（裸 GET 会被 <img>/<script> 这类
      // 跨站请求捎带上；POST+JSON 触发预检，而本服务不返回 CORS 头，跨站读不到结果）。
      // 不做 Origin 白名单：同源的观察窗页面本就不带 Origin，拦它反而把自己的 UI 弄坏。
      kind: 'exact', path: '/bl/gui',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed（POST + JSON 才给 URL，避免被跨站捎带）' })
        let body = {}
        try { body = await readBody(req) } catch { body = {} }
        if (body.need !== 'gui-url') return sendJson(res, 400, { ok: false, error: 'need 必须是 "gui-url"' })
        let url = guiAuthUrlNow()
        if (typeof body.base === 'string' && body.base) {
          // 想换成 LAN 地址（局域网访问）时：同一套 token/authority 绑定规则，由宿主服务重签
          try { url = guiAuthApi ? guiAuthApi.connection.authenticatedUrl(body.base) : url } catch { /* 用默认 */ }
        }
        if (!url) return sendJson(res, 503, { ok: false, error: '宿主 connection 服务未就绪（拿不到已认证 URL）', hint: '改用 DSH 启动时打印的 dsh web URL' })
        sendJson(res, 200, { ok: true, url })
      },
    }), 'bl: gui url route'))
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
          try {
            const before = `${settings.backendMode}|${settings.userDefault}`
            settings = sanitizeSettings({ ...settings, ...(await readBody(req)) })
            saveSettings()
            await syncBridge()   // userBridge 开关即时生效，不用重启 DSH
            // backendMode / userDefault 当场生效，别等下一次工具调用（切不了就只是这步失败，配置照样存）
            let backendWarn
            if (`${settings.backendMode}|${settings.userDefault}` !== before) {
              try { await useSession(settings.backendMode === 'user' ? 'user' : (settings.backendMode === 'plugin' ? 'plugin' : '')) } catch (e) { backendWarn = String(e?.message || e) }
            }
            sendJson(res, 200, { ok: true, settings, backend: browser.backend, active: browser.session?.kind || '', browsers: browsersView(), ...(backendWarn ? { backendWarn } : {}) })
          }
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
            else if (body.action === 'close') {
              // 与 browser_tabs 的 close 同一条路径：不吞错误，关不掉就说清楚为什么（面板里也看得到）
              let err = null
              try { await browser.cdp.send('Target.closeTarget', { targetId: tab.targetId }) } catch (e) { err = e }
              if (browser.selected === tab.targetId) browser.selected = null
              if (!(await waitTargetGone(tab.targetId))) {
                throw new Error('关闭标签页失败：' + String((err && err.message) || '标签页没有被关掉（多半是被扩展拒绝了）'))
              }
            }
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

  await syncBridge()

  console.log('[dsh-browser-live] host up (v' + version + ') · ' + builtTools.length + ' 个 browser_* 工具已注册（' + auditedTools + ' 个带留痕） · 数据目录 ' + BASE_DIR())
  // 本次会话的开头记一条：这样"某天他到底开过几次、每次干了什么"能按 boot 分段读。
  AUDIT.audit('boot', { version, node: process.version, auditedTools, tools: builtTools.length })
  console.log('[dsh-browser-live] 留痕目录 ' + AUDIT_DIR() + '（append-only JSONL + 哈希链，校验：node tools/verify-audit-chain.mjs）')
}
