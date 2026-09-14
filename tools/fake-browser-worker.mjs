// verify-browsers.mjs 用的"假浏览器"Worker。
//
// 为什么必须是 Worker：扩展代码里的 `chrome` 是模块级自由变量，指向 **globalThis**。
// 在同一个 realm 里加载两份扩展副本，无论怎么在副本开头赋值 globalThis.chrome，
// 两份扩展看到的都是**同一个对象**（最后一个赋的值），于是 Chrome 扩展会读到 Edge 的
// 标签页 —— 这个替身缺陷一度让整套断言全是假绿。Worker 有独立 realm，才真正等价于
// "每个浏览器进程各有自己的 chrome.*"。
//
// 协议（全部 postMessage）：
//   ← {type:'init', extDir, kind, ua, port, token, tabs}
//   → {type:'ready', kind}
//   ← {type:'call', id, fn, args}    fn ∈ saveCfg|connect|allowTabs|disconnect|dump
//   → {type:'call.done', id, ok, value|error}
//   ← {type:'dump', id}
//   → {type:'dump.done', id, state:{kinds:[],calls:{},origins:[],connected:bool,lastError:''}}
//
// workerData 可选扩展（默认缺省 = verify-browsers 的老行为，一个字都不变）：
//   pageText  : 一个超长正文字符串。给了它就进"长页模式" —— Runtime.evaluate 会把**工具真正
//               生成的那个表达式**放进 node:vm，配一个只有 document.querySelector 的假 DOM 真跑一遍。
//               这样 browser_text 的 offset/limit 语义（含 clamp）是被真代码执行的，而不是替身自己算的；
//               READ_FN（readPageInPage）另给一份按 offset/limit 切的、字段名与真实现一致的载荷。
//   readLinks : 长页模式下 links 清单的条数（用来造"元信息撑爆结果上限"的场景）。
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const { extDir, kind, ua, tabs, pageText, readLinks } = workerData

const state = {
  kind, ua, tabs,
  storage: {},
  calls: { attach: [], detach: [], sendCommand: [], badge: [], tabsUpdate: [], windowsUpdate: [] },
  listeners: { debuggerEvent: [], debuggerDetach: [], tabRemoved: [], alarm: [], message: [] },
  connected: false,
  lastError: '',
}
const find = (id) => state.tabs.find((x) => x.id === id)

// ---- 长页模式的三个小工具（只在 workerData.pageText 存在时用到） ----------------
/** 取 callOnPage 生成表达式的尾参：'(FN)(a,b)' → [a, b]。 */
function trailingArgs(ex) {
  const at = ex.lastIndexOf(')(')
  if (at < 0) return null
  try { return JSON.parse('[' + ex.slice(at + 2, ex.length - 1) + ']') } catch { return null }
}
/** 假 DOM：只够 browser_text / browser_eval 这类"取正文"的表达式真跑一遍。 */
const fakePageRealm = () => ({
  document: {
    title: `${kind} 长页 · 30000 字`,
    body: { innerText: pageText, textContent: pageText },
    querySelector: () => ({ innerText: pageText, textContent: pageText }),
    querySelectorAll: () => [],
  },
  location: { href: `https://${kind}.test/p` },
  window: {},
})
/** 造一份"很占地方"的链接清单：用来验证结果超限时元信息会被显式裁剪（而不是切断 JSON）。 */
function mkLinks(n) {
  const out = []
  for (let i = 0; i < (Number(n) || 0); i++) {
    out.push({ text: `${kind} 链接 ${i} ` + '标'.repeat(110), url: `https://${kind}.test/a/${i}/` + 'x'.repeat(260) })
  }
  return out
}

/** 记账数组用 Proxy 包一层：改了就顺手把快照 postMessage 回主线程（主线程只做断言）。 */
const shadow = { calls: { attach: [], detach: [], sendCommand: [], badge: [], tabsUpdate: [], windowsUpdate: [] } }
function track(name) {
  return new Proxy(state.calls[name], {
    get(t, p) {
      if (p === 'push') return (...a) => { const r = t.push(...a); sync(); return r }
      if (p === 'length') return t.length
      const v = t[p]
      return typeof v === 'function' ? v.bind(t) : v
    },
    set(t, p, v) { t[p] = v; sync(); return true },
  })
}
for (const k of Object.keys(state.calls)) state.calls[k] = track(k)
function sync() {
  for (const k of Object.keys(state.calls)) shadow.calls[k] = state.calls[k].slice()
  // 关键：也把 sendCommand 的目标 tabId 一起带回来，主线程据此判断"命令打在哪台"
}

globalThis.chrome = {
  __state: state,
  runtime: {
    getManifest: () => ({ version: '0.3.0' }),
    onMessage: { addListener: (f) => state.listeners.message.push(f) },
    lastError: null,
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys || {})).filter((k) => k in state.storage).map((k) => [k, state.storage[k]])),
      set: async (obj) => { Object.assign(state.storage, obj); sync() },
    },
  },
  tabs: {
    query: async () => state.tabs.map((t) => ({ ...t })),
    get: async (id) => { const t = find(id); if (!t) throw new Error('no tab'); return { ...t } },
    update: async (id, props) => {
      state.calls.tabsUpdate.push({ id, props })
      const t = find(id)
      if (t && props && props.active) { state.tabs.forEach((x) => { x.active = false }); t.active = true }
      sync()
      return t ? { ...t } : undefined
    },
    onRemoved: { addListener: (f) => state.listeners.tabRemoved.push(f) },
  },
  windows: {
    get: async (id) => ({ id, focused: true }),
    update: async (id, props) => { state.calls.windowsUpdate.push({ id, props }); sync(); return { id } },
  },
  debugger: {
    attach: async (target, version) => { state.calls.attach.push({ target, version }); sync() },
    detach: async (target) => { state.calls.detach.push(target); sync() },
    sendCommand: async (target, method, params) => {
      state.calls.sendCommand.push({ target, method, params, kind })
      sync()
      // 每台浏览器的页面内容都带自己的 kind 标记 —— 用来判断"到底读的是哪一台"
      const page = {
        url: `https://${kind}.test/p`, title: `${kind} page`, vw: 1280, vh: 720,
        scrollY: 0, docHeight: 1800,
        elements: [{ ref: 'e1', tag: 'input', text: `${kind}-书籍ID`, x: 100, y: 200 }],
        text: pageText !== undefined ? pageText.slice(0, 40000) : `hello from ${kind} browser`,
        textMore: pageText !== undefined ? pageText.length > 40000 : false,
      }
      if (method === 'Runtime.evaluate') {
        const ex = String(params?.expression || '')
        if (ex === 'location.href') return { result: { value: page.url } }
        // 长页模式（见文件头注释）：先给 READ_FN 一份字段名一致的载荷，其余表达式丢进 vm 真跑
        if (pageText !== undefined) {
          if (/function readPageInPage/.test(ex)) {
            const spec = (trailingArgs(ex) || [])[0] || {}
            const off = Math.max(0, Number(spec.offset) || 0)
            // 上限刻意交给**工具层**去管（替身只按 spec.limit 切，最多 40000 = 改前声明的额度）：
            // 这样"声明上限与实际行为不一致"才能在真链路上被断言抓到，而不是被替身自己夹平。
            const lim = Math.max(200, Math.min(Number(spec.limit) || 8000, 40000))
            const cut = pageText.slice(off, off + lim)
            return {
              result: {
                value: {
                  ok: true, url: page.url, title: `${kind} 长页 · 30000 字`, lang: 'zh-CN', charset: 'UTF-8',
                  source: 'article',
                  meta: { description: '长页 fixture', siteName: 'fake', author: '', published: '', type: 'article' },
                  textLength: pageText.length, offset: off, charsStart: off,
                  truncated: off + cut.length < pageText.length, text: cut,
                  ...(spec.links === false ? {} : { links: mkLinks(readLinks) }),
                },
              },
            }
          }
          try {
            const value = vm.runInNewContext(ex, fakePageRealm())
            return { result: { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) } }
          } catch { /* 替身跑不了（snapshot 之类要真 DOM）→ 落到下面的老分支 */ }
        }
        // 顺序要紧：SNAPSHOT_FN 里同时含 'function vis(e)' 与 'innerText'，
        // 先判 innerText 会把 snapshot 误当成取正文
        if (/function vis\(e\)/.test(ex)) return { result: { value: page } }
        if (/innerText/.test(ex)) return { result: { value: { found: true, len: page.text.length, text: page.text } } }
        return { result: { value: null } }
      }
      if (method === 'Page.captureScreenshot') return { data: 'UE5HRA==' }
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      return {}
    },
    onEvent: { addListener: (f) => state.listeners.debuggerEvent.push(f) },
    onDetach: { addListener: (f) => state.listeners.debuggerDetach.push(f) },
  },
  action: {
    setBadgeBackgroundColor: async (o) => { state.calls.badge.push({ color: o.color }); sync() },
    setBadgeText: async (o) => { state.calls.badge.push(o); sync() },
  },
  alarms: { create: () => {}, onAlarm: { addListener: (f) => state.listeners.alarm.push(f) } },
}
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true })

const ext = await import(pathToFileURL(extDir + '/background.js').href + '?worker=' + kind)

const dump = () => ({
  state: {
    kind,
    kinds: state.calls.sendCommand.map((c) => c.target.tabId),
    calls: Object.fromEntries(Object.keys(state.calls).map((k) => [k, state.calls[k].slice()])),
    origins: (ext.__internals.state.cfg.origins || []).slice(),
    connected: !!ext.__internals.state.connected,
    lastError: ext.__internals.state.lastError || '',
    kindSeen: ext.__internals.KIND,
  },
})

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'call') {
      const { id, fn, args } = msg
      let value
      if (fn === 'saveCfg') value = await ext.__internals.saveCfg(args)
      else if (fn === 'connect') value = await ext.connect()
      else if (fn === 'disconnect') value = await ext.disconnect()
      else if (fn === 'allowTabs') value = await ext.__internals.POPUP_API.allowTabs()
      else if (fn === 'revokeAll') value = await ext.__internals.POPUP_API.revokeAll()
      else if (fn === 'setInput') value = await ext.__internals.POPUP_API.setInput(args)
      else if (fn === 'status') value = ext.status()
      else throw new Error('未知调用: ' + fn)
      parentPort.postMessage({ type: 'call.done', id, ok: true, value: value === undefined ? null : value, ...dump() })
      return
    }
    if (msg.type === 'dump') {
      parentPort.postMessage({ type: 'dump.done', id: msg.id, ok: true, ...dump() })
      return
    }
    if (msg.type === 'exit') process.exit(0)
  } catch (e) {
    parentPort.postMessage({ type: msg.type === 'call' ? 'call.done' : 'dump.done', id: msg.id, ok: false, error: String(e?.message || e), ...dump() })
  }
})

parentPort.postMessage({ type: 'ready', kind, kindSeen: ext.__internals.KIND })
