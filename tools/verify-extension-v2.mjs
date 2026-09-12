// ============================================================================
// 扩展 v2 离线自测（不装浏览器、不起 ws）
//
// 跑法：node tools/verify-extension-v2.mjs
// 退出码：0 = 全过；1 = 有失败（方便挂进 CI）
//
// 两段：
//   A. 纯函数层（import extension/sid.js）+ background.js 静态约束。
//      —— 不需要 chrome，也不需要 background.js 能被 node import（它是 MV3 SW，
//         顶层就摸 chrome.*，node dynamic import 会当场炸）。
//   B. 用最小 mock chrome 真加载 background.js，端到端跑新增的两个弹窗动作
//      （allowTabs / revokeAll）与身份上报，确认"按钮真的改到 origins"。
// ============================================================================
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectBrowserKind, browserName, extSid, rawSid } from '../extension/sid.js'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')) }
}
const eq = (actual, expected, label) => ok(actual === expected, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
const section = (t) => console.log('\n' + t)

const EXT = path.join(import.meta.dirname, '..', 'extension')

// ---------------------------------------------------------------- sid.js 可导入性
section('sid.js 纯函数层（background.js / popup.js / node 三边共用）')
ok(existsSync(path.join(EXT, 'sid.js')), 'extension/sid.js 存在')
const sidMod = await import(pathToFileURL(path.join(EXT, 'sid.js')).href)
ok(typeof sidMod.detectBrowserKind === 'function' && typeof sidMod.extSid === 'function' && typeof sidMod.rawSid === 'function',
  'sid.js 导出 detectBrowserKind / extSid / rawSid')
ok(typeof globalThis.chrome === 'undefined', '本脚本全程不依赖 chrome（真·离线）')

// ---------------------------------------------------------------- §2 身份嗅探
section('§2 身份 sniff（UA → kind）')
const UA = {
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  brave: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Brave/126',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0',
  chromeos: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
}
eq(detectBrowserKind(UA.edge), 'edge', 'Edge UA（含 Chrome/ 也含 Edg/）→ edge')
eq(detectBrowserKind(UA.brave), 'brave', 'Brave UA → brave')
eq(detectBrowserKind(UA.opera), 'opera', 'Opera UA（OPR/）→ opera')
eq(detectBrowserKind(UA.chrome), 'chrome', 'Chrome UA → chrome')
eq(detectBrowserKind(UA.chromeos), 'chrome', 'ChromeOS UA → chrome')
eq(detectBrowserKind(UA.firefox), 'unknown', 'Firefox UA → unknown（不是 chrome）')
eq(detectBrowserKind(''), 'unknown', '空 UA → unknown')
eq(detectBrowserKind(undefined), 'unknown', 'undefined UA → unknown')
// 顺序陷阱：Opera 的 UA 里含 "Chrome/" 且旧版 Opera 也含 "Edg"？—— 只保证 OPR 优先于 Chrome
eq(detectBrowserKind('Chrome/120 Safari/537.36 OPR/99 Edg/120'), 'edge', '同时含 Edg//OPR/ 时以 Edg/ 优先（Edge 的 UA 从不含 OPR/）')

section('§5 人类可读名（弹窗顶部）')
eq(browserName('edge'), 'Microsoft Edge', 'edge → Microsoft Edge')
eq(browserName('chrome'), 'Google Chrome', 'chrome → Google Chrome')
eq(browserName('brave'), 'Brave', 'brave → Brave')
eq(browserName('opera'), 'Opera', 'opera → Opera')
eq(browserName('unknown'), '未知浏览器', 'unknown → 未知浏览器')
eq(browserName('其他垃圾'), '未知浏览器', '未知 kind → 未知浏览器（不抛）')

// ---------------------------------------------------------------- §3 前缀表驱动
section('§3 sessionId 前缀：extSid 只加一次（表驱动）')
const EXT_CASES = [
  ['chrome', 'bl-12-1', 'chrome:bl-12-1'],
  ['edge', 'bl-12-1', 'edge:bl-12-1'],
  ['brave', 'bl-3-2', 'brave:bl-3-2'],
  ['opera', 'bl-7-9', 'opera:bl-7-9'],
  ['unknown', 'bl-1-1', 'unknown:bl-1-1'],
  ['edge', '3', 'edge:3'],
  ['edge', 3, 'edge:3'],
  ['edge', '0', 'edge:0'],
]
for (const [kind, input, expected] of EXT_CASES) {
  eq(extSid(kind, input), expected, `extSid(${JSON.stringify(kind)}, ${JSON.stringify(input)}) === ${JSON.stringify(expected)}`)
}
ok((extSid('edge', 'bl-12-1').match(/:/g) || []).length === 1, '加前缀后整串只有一个冒号（extSid 本体不自带冒号）')
eq(extSid('', 'bl-1-1'), 'unknown:bl-1-1', 'kind 空 → unknown: 前缀（不产生 ":bl-1-1"）')
eq(extSid(undefined, 'bl-1-1'), 'unknown:bl-1-1', 'kind undefined → unknown:')
eq(extSid('edge', ''), '', '空 sessionId → 空串（不产生 "edge:" 垃圾 key）')
eq(extSid('edge', null), '', 'null sessionId → 空串')
eq(extSid('edge', undefined), '', 'undefined sessionId → 空串')
// 只加一次：extSid 是纯拼接，重复调用会得到双前缀 —— 由 rawSid 只剥一层还原
eq(extSid('edge', extSid('edge', 'bl-1-1')), 'edge:edge:bl-1-1', 'extSid 纯拼接（调用方不得对已加过前缀的值再加）')
eq(rawSid(extSid('edge', extSid('edge', 'bl-1-1'))), 'edge:bl-1-1', '双前缀经 rawSid 只剥一层')

section('§3 sessionId 剥前缀：rawSid 只在有前缀时剥且只剥一次（表驱动）')
const RAW_CASES = [
  ['edge:3', '3'],
  ['chrome:12', '12'],
  ['edge:bl-12-1', 'bl-12-1'],
  ['chrome:bl-12-1', 'bl-12-1'],
  ['brave:bl-3-2', 'bl-3-2'],
  ['opera:bl-7-9', 'bl-7-9'],
  ['unknown:bl-1-1', 'bl-1-1'],
  ['3', '3'],                        // 无前缀不变
  ['bl-12-1', 'bl-12-1'],            // 无前缀不变（连字符数字不是 [a-z]+:）
  ['', ''],                          // 空串不变
  ['edge:', ''],                     // 剥完是空串
  ['edge:edge:bl-1-1', 'edge:bl-1-1'],  // 只剥一层
  ['EDGE:3', 'EDGE:3'],              // 大写不算前缀（只认小写 kind）
  ['edge3:3', '3'],                  // [a-z]+ 不含数字 → "edge3:" 不匹配，原样…… 见下条断言
]
// 上面最后一条故意写错期望，改为在循环外单独断言真实行为：
for (const [input, expected] of RAW_CASES.slice(0, -1)) {
  eq(rawSid(input), expected, `rawSid(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`)
}
eq(rawSid('edge3:3'), 'edge3:3', '前缀段必须全是 [a-z]：edge3:3 不剥（避免误伤真实 sessionId）')
eq(rawSid(undefined), '', 'rawSid(undefined) → 空串')
eq(rawSid(null), '', 'rawSid(null) → 空串')
eq(rawSid(12), '12', 'rawSid(12) → "12"（数字入参不抛）')
eq(rawSid(0), '0', 'rawSid(0) → "0"（不把 0 当空）')

section('§3 加/剥互逆（往返不变式）')
for (const kind of ['chrome', 'edge', 'brave', 'opera', 'unknown']) {
  for (const rawId of ['bl-11-1', 'bl-12-34', 'bl-1024-7']) {
    const wire = extSid(kind, rawId)
    eq(rawSid(wire), rawId, `${kind} 往返：${wire} → ${rawId}`)
    eq(rawSid(rawSid(wire)), rawId, `${kind} 往返幂等：rawSid 调两次仍 === ${rawId}`)
  }
}

// ---------------------------------------------------------------- 静态约束（background.js）
section('静态约束：background.js 所有跨 WS 边界都走 ext()/raw()')
const bg = readFileSync(path.join(EXT, 'background.js'), 'utf8')
ok(/import\s*\{[^}]*\bdetectBrowserKind\b[^}]*\bextSid\b[^}]*\brawSid\b[^}]*\}\s*from\s*'\.\/sid\.js'/.test(bg),
  "background.js 从 './sid.js' 引入 detectBrowserKind / extSid / rawSid")
ok(/const PROTOCOL = 2\b/.test(bg), 'PROTOCOL 已提到 2')
ok(/browser: KIND\b/.test(bg), "hello 的 browser 字段来自 KIND（不再是硬编码 'chrome')")
ok(!/browser:\s*'chrome'/.test(bg), "background.js 里没有残留的 browser: 'chrome' 硬编码")
ok(/protocol: PROTOCOL/.test(bg), 'hello 带上 protocol 字段')
// 出口：event / detach / cdp 回包都必须带前缀
ok(/type:\s*'event',\s*sessionId:\s*ext\(sessionId\)/.test(bg), "event 出口 sessionId 走 ext()")
ok(/type:\s*'detach',\s*sessionId:\s*ext\(sessionId\)/.test(bg), "detach 出口（onDetach）sessionId 走 ext()")
ok(/type:\s*'detach',\s*sessionId:\s*ext\(sessionId\),\s*reason:\s*'tab-closed'/.test(bg), "detach 出口（tab-closed）sessionId 走 ext()")
ok(/out\.sessionId = ext\(wireSid\)/.test(bg), 'cdp 回包出口 sessionId 走 ext()')
ok(/out\.sessionId = ext\(sid\)/.test(bg), 'cdp 错误回包出口 sessionId 走 ext()')
// 入口：handleCommand / detachFromTarget 都要剥
ok(/const sid = raw\(sessionId\)/.test(bg), 'handleCommand 入口先 raw() 剥前缀')
ok(/await detachSession\(raw\(params\.sessionId\) \|\| sid\)/.test(bg), 'Target.detachFromTarget 的 params.sessionId 也走 raw()')
// 内部键不带前缀：attachTab 生成的 extSid 不得自带 kind
ok(/const sessionId = `bl-\$\{tabId\}-\$\{\+\+state\.seq\}`/.test(bg), '内部 sessionId 生成规则仍是 bl-<tabId>-<seq>（无前缀）')
ok(!/`\$\{KIND\}:/.test(bg), 'background.js 里没有手写 `${KIND}:` 拼接（统一走 ext()）')
// 20s ping / 方法白名单 / isCurrent 竞态保护 / SW 保活 必须原样保留
ok(/setInterval\(\(\) => \{ sendToHost\(\{ type: 'ping', t: Date.now\(\) \}\) \}, 20000\)/.test(bg), '20s 自 ping 保活仍在')
ok(/const isCurrent = \(\) => state\.ws === ws/.test(bg), 'isCurrent() 竞态保护仍在')
ok(/chrome\.alarms\.create\('bl-keepalive'/.test(bg), 'SW 休眠重连（alarms）仍在')
ok(/const ALLOWED = new Set\(\[/.test(bg) && /const INPUT_METHODS = new Set\(\[/.test(bg), '方法白名单仍在')
ok(/async allowTabs\(\)/.test(bg) && /async revokeAll\(\)/.test(bg), 'POPUP_API 新增 allowTabs / revokeAll')

// ---------------------------------------------------------------- 静态约束（popup / manifest）
section('静态约束：popup 与 manifest')
const html = readFileSync(path.join(EXT, 'popup.html'), 'utf8')
const popup = readFileSync(path.join(EXT, 'popup.js'), 'utf8')
const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'))
ok(/id="browserName"/.test(html), 'popup.html 有浏览器身份显示位 #browserName')
ok(/id="allowAllTabs"/.test(html), 'popup.html 有「允许当前所有标签页」按钮')
ok(/id="revokeAll"/.test(html), 'popup.html 有「撤销全部授权」按钮')
ok(/允许当前所有标签页/.test(html) && /撤销全部授权/.test(html), '两个按钮的中文文案符合规格')
ok(/<script type="module" src="popup\.js">/.test(html), 'popup.html 以 ESM 方式加载 popup.js（要 import sid.js）')
ok(/detectBrowserKind\(navigator\.userAgent\)/.test(popup), 'popup.js 本地也嗅探一次（首帧不等 SW）')
ok(/api\('allowTabs'\)/.test(popup) && /api\('revokeAll'\)/.test(popup), 'popup.js 调 allowTabs / revokeAll')
ok(/confirm\(/.test(popup), '「撤销全部授权」有二次确认')
ok(!/Chrome/.test(popup.replace(/Google Chrome/g, '')), 'popup.js 里没有写死的 Chrome 字样（Google Chrome 来自 kind 映射）')
ok(!/Chrome/.test(html.replace(/Google Chrome/g, '')), 'popup.html 里没有写死的 Chrome 字样')
ok(manifest.manifest_version === 3, 'manifest 仍是 MV3')
ok(manifest.background?.type === 'module', 'service worker 仍是 ESM（ES import 才不会崩）')
ok(manifest.action?.default_popup === 'popup.html', '弹窗入口没变')

// ---------------------------------------------------------------- B. mock chrome 集成
section('B. mock chrome：真加载 background.js，端到端跑新增弹窗动作')
{
  // 假 Edge：KIND 必须是 edge，且 allowTabs/revokeAll 要真的改 origins
  // Node ≥21 自带只读的 globalThis.navigator（getter-only），必须 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: UA.edge }, configurable: true, writable: true })
  const TABS = [
    { id: 21, url: 'https://a.test/x', title: 'A', active: true, windowId: 1 },
    { id: 22, url: 'https://b.test/y', title: 'B', active: false, windowId: 1 },
    { id: 23, url: 'https://a.test/z', title: 'A2', active: false, windowId: 1 },  // 与 21 同 origin
    { id: 24, url: 'https://c.test:8443/w', title: 'C', active: false, windowId: 1 }, // 带端口
    { id: 25, url: 'chrome://settings', title: '设置', active: false, windowId: 1 },
    { id: 26, url: 'about:blank', title: '新标签页', active: false, windowId: 1 },
    { id: 27, url: 'file:///C:/x.html', title: '本地', active: false, windowId: 1 },
    { id: 28, tabId: undefined, url: undefined, title: '无 url', active: false, windowId: 1 },
  ]
  const storage = {}
  const detached = []
  const listeners = { message: [], debuggerEvent: [], debuggerDetach: [], tabRemoved: [], alarm: [] }
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.2.0' }), onMessage: { addListener: (f) => listeners.message.push(f) }, lastError: null },
    storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys || {})).filter((k) => k in storage).map((k) => [k, storage[k]])),
      set: async (o) => { Object.assign(storage, o) },
    } },
    tabs: {
      query: async () => TABS.map((t) => ({ ...t })),
      get: async (id) => { const t = TABS.find((x) => x.id === id); if (!t) throw new Error('no tab'); return { ...t } },
      update: async () => ({}),
      // v0.8.3：未授权页 + 已授权目标站时扩展走"新开标签页"，所以替身要真能加标签页
      create: async (props) => {
        const t = { id: 900 + TABS.length, url: (props && props.url) || 'about:blank', title: '新标签页', active: true, windowId: 1 }
        TABS.push(t)
        return { ...t }
      },
      onRemoved: { addListener: (f) => listeners.tabRemoved.push(f) },
      // v0.8.5：关标签页只放行 agent 自己开的页，替身要真能删并触发 onRemoved
      remove: async (id) => {
        const i = TABS.findIndex((x) => x.id === id)
        if (i < 0) throw new Error('no tab')
        TABS.splice(i, 1)
        listeners.tabRemoved.forEach((f) => f(id))
      },
    },
    windows: { get: async (id) => ({ id, focused: true }), update: async () => ({}) },
    debugger: {
      attach: async () => {},
      detach: async (target) => { detached.push(target) },
      sendCommand: async () => ({}),
      onEvent: { addListener: (f) => listeners.debuggerEvent.push(f) },
      onDetach: { addListener: (f) => listeners.debuggerDetach.push(f) },
    },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: (f) => listeners.alarm.push(f) } },
  }
  const extUrl = pathToFileURL(path.join(EXT, 'background.js')).href + '?v2test'
  const bgMod = await import(extUrl)
  const P = bgMod.__internals.POPUP_API

  eq(bgMod.__internals.KIND, 'edge', 'mock Edge UA 下 background 的 KIND === edge')
  eq(bgMod.__internals.KIND_NAME, 'Microsoft Edge', 'mock Edge UA 下人类可读名 === Microsoft Edge')
  ok(listeners.debuggerEvent.length === 1 && listeners.message.length === 1, 'background.js 装载后仍注册了 onEvent / onMessage')

  await P.save({ origins: [], allowAll: false, allowInput: false, autoConnect: false })
  let st = await P.status()
  eq(st.browser, 'edge', 'status 上报 browser === edge（弹窗顶部用它）')
  eq(st.browserName, 'Microsoft Edge', 'status 上报 browserName === Microsoft Edge')
  eq(st.protocol, 2, 'status 上报 protocol === 2')
  eq(st.origins.length, 0, '初始 origins 为空')

  // —— 「允许当前所有标签页」
  const r1 = await P.allowTabs()
  const got1 = [...st.origins, ...r1.addedOrigins].sort()
  eq(r1.added, 3, 'allowTabs 并入 3 个站点（同 origin 去重）')
  eq(JSON.stringify(r1.origins.slice().sort()), JSON.stringify(['https://a.test', 'https://b.test', 'https://c.test:8443']),
    'origins = a.test / b.test / c.test:8443（chrome:// / about: / file: / 无 url 全被排除）')
  eq(r1.allowAll, false, '「允许当前所有标签页」不打开 allowAll')
  ok(!r1.origins.some((o) => /^(chrome|about|file):/.test(o)), '并入的 origin 全是 http(s)')
  ok(got1.length === 3, '去重后总数 3（同 origin 的两个标签只算一个）')
  ok(storage.origins && storage.origins.length === 3, 'origins 落盘到 chrome.storage.local')

  // 幂等：再点一次不重复并入
  const r2 = await P.allowTabs()
  eq(r2.added, 0, '再点一次「允许当前所有标签页」→ 已允许 0 个（不重复并入）')
  eq(r2.origins.length, 3, 'origins 仍为 3')

  // 已有更早的授权时只增量并入
  await P.revoke('https://b.test')
  await P.allow('https://zzz.test')
  const r3 = await P.allowTabs()
  eq(r3.added, 1, '增量场景：只有 b.test 需要补回（zzz.test 已单独授权，a/c 已在列表）')
  eq(r3.origins.slice().sort().join(','), 'https://a.test,https://b.test,https://c.test:8443,https://zzz.test', '合并结果正确')

  // —— 「撤销全部授权」
  const r4 = await P.revokeAll()
  eq(r4.removed, 4, 'revokeAll 报告撤销 4 个站点')
  eq(r4.origins.length, 0, 'revokeAll 清空 origins')
  ok(storage.origins && storage.origins.length === 0, '清空也落盘')
  eq(r4.allowAll, false, 'revokeAll 不动 allowAll 开关（开关自身的语义保持原样）')
  eq((await P.status()).origins.length, 0, 'status 确认 origins 已空')

  // 撤销后 agent 再也附加不上（授权是附加的先决条件）
  let attErr = ''
  try { await P.status() ; await bgMod.handleCommand({ method: 'Target.attachToTarget', params: { targetId: '21' } }) } catch (e) { attErr = e.message }
  ok(/未授权/.test(attErr), 'revokeAll 之后附加标签页被拒（回到未授权态）', attErr)

  // allowAll 打开时逐站点列表为空也能附加（原有行为不能被这次改动带偏）
  await P.allowAll(true)
  const attOk = await bgMod.handleCommand({ method: 'Target.attachToTarget', params: { targetId: '21' } })
  ok(/^bl-21-\d+$/.test(attOk.sessionId), 'allowAll 打开时 attach 仍成功，且内部 sessionId 无前缀', attOk.sessionId)
  ok(!String(attOk.sessionId).includes(':'), 'handleCommand 返回给内部调用方的 sessionId 是无前缀的（前缀只在 onCommand 出口加）')

  // ---- v0.8.1/v0.8.3：当前页未授权 + 目标站已授权 → 扩展**新开标签页**过去、附加到新标签页。
  // 替身不记录 tabs.update / tabs.create / debugger.attach，这里临时包一层来观测**顺序与对象** ——
  // 这两点正是这条改动的要害：① attach 必须在"页面已经是已授权站点"之后；
  // ② 你正在看的那个标签页必须**一个字都不动**（v0.8.1 的就地导航会把它顶掉，v0.8.3 改成新开）。
  {
    const nav = []
    const realUpdate = globalThis.chrome.tabs.update
    const realAttach = globalThis.chrome.debugger.attach
    const realCreate = globalThis.chrome.tabs.create
    globalThis.chrome.tabs.update = async (id, props) => {
      nav.push('update:' + id + ':' + ((props && props.url) || ''))
      const t = TABS.find((x) => x.id === id)
      if (t && props && props.url) t.url = props.url
      return {}
    }
    globalThis.chrome.tabs.create = async (props) => {
      nav.push('create:' + ((props && props.url) || ''))
      // 必须真的把新标签页加进 TABS：扩展接下来会 chrome.tabs.get(新 id) 等它落到已授权 origin
      const t = { id: 900 + TABS.length, url: (props && props.url) || 'about:blank', title: '新标签页', active: true, windowId: 1 }
      TABS.push(t)
      return { ...t }
    }
    globalThis.chrome.debugger.attach = async (targetOrId) => {
      nav.push('attach:' + (targetOrId && targetOrId.tabId !== undefined ? targetOrId.tabId : targetOrId))
    }
    await P.save({ origins: ['https://a.test'], allowAll: false, allowInput: false, autoConnect: false })
    const before22 = TABS.find((x) => x.id === 22).url

    // A. 前台页是 b.test（未授权）、目标是已授权的 a.test → 新开标签页再附加
    const st = await bgMod.handleCommand({ method: 'Target.attachToTarget', params: { targetId: '22', intendedUrl: 'https://a.test/landing' } })
    ok(nav[0] === 'create:https://a.test/landing' && nav[1] === 'attach:' + st.tabId,
      '未授权页 + 已授权目标站：新开标签页 → 附加到**新**标签页（顺序与对象都对）', JSON.stringify({ st, nav }))
    ok(String(st.tabId) !== '22' && /^bl-\d+-\d+$/.test(String(st.sessionId)),
      '附加的是新标签页，且 handleCommand 把真实 tabId 报给 host（host 才能纠正映射）', st)
    ok(TABS.find((x) => x.id === 22).url === before22 && !nav.some((x) => x.startsWith('update:')),
      '你正在看的那个标签页一个字都没动（这就是"不动你的页面"）', { before: before22, nav })
    await bgMod.__internals.detachSession(st.sessionId)

    // B. 目标站也没授权 → 仍然拒绝，且既不新开也不导航（隐私底线不变）
    nav.length = 0
    let e2 = ''
    try { await bgMod.handleCommand({ method: 'Target.attachToTarget', params: { targetId: '24', intendedUrl: 'https://d.test/never' } }) } catch (e) { e2 = e.message }
    ok(/未授权/.test(e2) && nav.length === 0, '目标站也未授权：仍然拒绝，既不新开标签页也不导航', JSON.stringify({ e2, nav }))

    // C.（回归）"**已经附着过**、但现在未授权"的前台页：不能因为走 byTab 缓存就地放行。
    //    这正是本机实测踩到的坑：先用 browser_navigate 把前台页附着成未授权，再 browser_open 时
    //    attachTab 命中缓存直接返回 → 老的就地导航行为复活，你正在看的页面照样被改写。
    await P.save({ origins: ['https://c.test:8443'], allowAll: false, allowInput: false, autoConnect: false })
    const cAtt = await bgMod.handleCommand({ method: 'Target.attachToTarget', params: { targetId: '24' } })
    ok(!!cAtt && !!cAtt.sessionId, '先允许 c.test 并附着 #24（造出"已附着"状态）', cAtt)
    await P.save({ origins: ['https://a.test'], allowAll: false, allowInput: false, autoConnect: false })   // 撤销 c.test
    nav.length = 0
    const cNew = await bgMod.handleCommand({ method: 'Target.attachToTarget', params: { targetId: '24', intendedUrl: 'https://a.test/landing2' } })
    ok(nav[0] === 'create:https://a.test/landing2' && String(cNew.tabId) !== '24',
      '已附着但已变未授权的前台页：同样新开标签页（顺序必须判在 byTab 缓存之前）', JSON.stringify({ nav, cNew }))
    ok(TABS.find((x) => x.id === 24).url === 'https://c.test:8443/w',
      '那个已附着的未授权页也没被导航（你正在看的页面不该被改写）', TABS.find((x) => x.id === 24).url)
    await bgMod.__internals.detachSession(cNew.sessionId)

    // D. 关标签页：只放行 **agent 自己开的** 页；你手动开的页永远拒；
    //    弹窗开关（默认开）关掉之后连自己开的也拒。
    let eOwn = ''
    try { await bgMod.handleCommand({ method: 'Target.closeTarget', params: { targetId: '22' } }) } catch (e) { eOwn = e.message }
    ok(/只能关闭 agent 自己打开的标签页/.test(eOwn), '拒绝关闭你手动开的标签页 #22', eOwn)

    const ownedId = String(cNew.tabId)          // C 段里新开的那张就是 agent 自己的页
    const dClose = await bgMod.handleCommand({ method: 'Target.closeTarget', params: { targetId: ownedId } })
    ok(dClose && dClose.success === true && !TABS.some((t) => String(t.id) === ownedId),
      'agent 自己开的标签页可以关掉，且真的从列表消失', JSON.stringify({ dClose, ids: TABS.map((t) => t.id) }))
    ok(!bgMod.__internals.state.ownedTabs.has(Number(ownedId)),
      '关掉之后 ownedTabs 里也清掉了（onRemoved 收尾）', [...bgMod.__internals.state.ownedTabs])

    const offStatus = await bgMod.__internals.POPUP_API.setCloseOwn(false)
    ok(offStatus && offStatus.allowCloseOwn === false, '弹窗开关 setCloseOwn(false) 生效并回读为 false', offStatus && offStatus.allowCloseOwn)
    const again = await bgMod.handleCommand({ method: 'Target.attachToTarget', params: { targetId: '24', intendedUrl: 'https://a.test/again' } })
    ok(again && bgMod.__internals.state.ownedTabs.has(Number(again.tabId)), '又开了一张自己的页（记进 ownedTabs）', [...bgMod.__internals.state.ownedTabs])
    let eOff = ''
    try { await bgMod.handleCommand({ method: 'Target.closeTarget', params: { targetId: String(again.tabId) } }) } catch (e) { eOff = e.message }
    ok(/弹窗里打开/.test(eOff), '开关关掉后：连自己开的页也不许关', eOff)
    await bgMod.__internals.POPUP_API.setCloseOwn(true)
    const dBack = await bgMod.handleCommand({ method: 'Target.closeTarget', params: { targetId: String(again.tabId) } })
    ok(dBack && dBack.success === true, '开关重新打开后：自己开的页又能关了（收尾）', dBack)

    globalThis.chrome.tabs.update = realUpdate
    globalThis.chrome.tabs.create = realCreate
    globalThis.chrome.debugger.attach = realAttach
  }
  await bgMod.disconnect()
}

// ---------------------------------------------------------------- 跨部件：hello.browser ↔ bridge.kindOfBrowser
// 这是最容易两边都自测过、一联调就炸的地方：扩展上报的是**纯 kind**
// （'edge' / 'chrome' / …，契约 §2），桥必须能把纯 kind 归一化成同一个 kind。
// 桥若不认纯 kind，Edge 扩展会被塞进 'unknown' 槽，host 用 'edge:xxx' 路由就永远找不到。
section('跨部件：hello.browser === kind，桥必须认得')
{
  const bridgeUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'bridge.js')).href
  const { kindOfBrowser } = await import(bridgeUrl)
  for (const kind of ['chrome', 'edge', 'brave', 'opera', 'unknown']) {
    eq(kindOfBrowser(kind), kind, `bridge.kindOfBrowser(${JSON.stringify(kind)}) === ${JSON.stringify(kind)}（扩展上报的就是这个纯 kind）`)
  }
  // 完整 UA 也必须还能认（v1 扩展 / 手动粘贴 UA 的场景）
  eq(kindOfBrowser(UA.edge), 'edge', 'bridge.kindOfBrowser(完整 Edge UA) === edge')
  eq(kindOfBrowser(UA.chrome), 'chrome', 'bridge.kindOfBrowser(完整 Chrome UA) === chrome')
}

// ---------------------------------------------------------------- 结果
console.log(`\n${fail ? '✗' : '✓'} verify-extension-v2: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
