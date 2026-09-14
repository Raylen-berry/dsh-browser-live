// 「单次结果上限」契约的离线套件：超长材料下结果必须**仍是合法 JSON**，且**带续读位置**。
//
// 钉的就是这个缺陷：工具声明"正文最多 40000 字符"（browser_text / browser_read 的 limit），
// 外层却把 **序列化后的字符串** 在 24000 处 slice —— 3 万字材料下 JSON.parse 直接抛，
// 连 offset/charsStart 这些续读信息也一起被切掉。于是"内容长、请续读"变成"结果坏了、没法续读"。
//
// 为什么单独一个文件、为什么必须两段都测：
//   [A] 纯函数层（真 fitResult）—— 裁剪算法本身：合法 JSON、显式记账、续读位置对得上。
//   [B] 真链路层（真 apply() + 真工具表 + 真桥 + 真扩展 + 假浏览器）—— 光测纯函数会漏掉
//       "接线漏了"那一类：索引里声明 40000、clamp 写 40000、真链路照样切坏 JSON，纯函数全绿。
//       所以 [B] 用 tools/fake-browser-worker.mjs 的"长页模式"跑**工具真正生成的表达式**（node:vm
//       配一个假 DOM），browser_text 的 offset/limit 语义是被真代码执行的，不是替身自己算的。
//
// 全程**不起真浏览器**：没有 Chromium 进程、没有 CDP 端口、不碰任何真实 profile。
// 跑法：node tools/verify-result-cap.mjs
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + String(extra).slice(0, 300) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = mkdtempSync(path.join(os.tmpdir(), 'bl-result-cap-'))
process.env.DSH_HOME = home

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)
const { fitResult, MAX_TEXT_CHARS, MAX_RESULT_CHARS } = mod

// 与 index.js 的 safeJson 同一条序列化规则：字符串型结果原样、对象结果 stringify。
// （反向验证会把它指向改前的实现 —— 那条实现返回的是**已经被切断的串**，这条规则让它照样对得上，
//   于是断言是因为"真的坏了"而失败，而不是因为类型对不上而抛错。）
const serialize = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
const tryParse = (s) => { try { return JSON.parse(s) } catch { return null } }

// 30000 字材料（不带换行，段的边界行为单独在 [A3] 里测）
const LEN = 30000
const LONG = '甲'.repeat(LEN)
const PAGE_URL = 'https://chrome.test/p'

console.log('单次结果上限：3 万字材料下必须是合法 JSON，且带截断记账与续读 offset')
console.log(`（实测常量 MAX_TEXT_CHARS=${MAX_TEXT_CHARS} / MAX_RESULT_CHARS=${MAX_RESULT_CHARS}）`)

// ============================================================ [A] 纯函数层
console.log('\n[A] fitResult 契约（真导出函数，离线）')

// A1 —— browser_text 形状：30000 字，外层上限 8000（缩小预算只为把"续读链"走满多轮）
{
  const page = { url: PAGE_URL, length: LEN, offset: 0, text: LONG, more: true }
  const fitted = fitResult(page, 8000)
  const raw = serialize(fitted)
  const parsed = tryParse(raw)
  ok(parsed !== null, '3 万字结果裁完后 JSON 可解析（改动前：slice 切断 ⇒ JSON.parse 抛）', raw.slice(0, 80))
  ok(raw.length <= 8000, '裁剪后长度进限额（≤ 8000）', String(raw.length))
  ok(parsed?.truncated === true, '结果里带截断标记 truncated=true')
  ok(parsed?.truncation?.originalChars === LEN, '结果里带原始长度（truncation.originalChars=30000）', String(parsed?.truncation?.originalChars))
  ok(typeof parsed?.truncation?.nextOffset === 'number' && parsed.truncation.nextOffset > 0,
    '结果里带下次续读的 offset（truncation.nextOffset）', JSON.stringify(parsed?.truncation))
  ok(parsed?.next === '还有内容：用 offset=' + parsed?.truncation?.nextOffset + ' 续读', 'next 提示与 nextOffset 一致', parsed?.next)
  ok(parsed?.truncation?.originalResultChars > 8000, '记账里也留着"裁之前整串多长"（originalResultChars）', String(parsed?.truncation?.originalResultChars))
  ok(parsed?.truncation?.keptChars === parsed?.text.length, 'keptChars 与实际返回的正文长度一致', JSON.stringify({ kept: parsed?.truncation?.keptChars, got: parsed?.text?.length }))
}

// A2 —— 续读链：按 nextOffset 一页页取，拼起来必须**一字不差**等于原文（不重不漏）
{
  let off = 0, calls = 0
  let got = ''
  let drift = null
  while (calls < 8) {
    const page = { url: PAGE_URL, length: LEN, offset: off, text: LONG.slice(off, off + 8000), more: off + 8000 < LEN }
    const fitted = fitResult(page, 8000)
    const gotText = String(fitted.text || '')
    if (gotText !== LONG.slice(off, off + gotText.length)) drift = { off, got: gotText.slice(0, 20) }
    got += gotText
    calls++
    off = fitted.truncation ? fitted.truncation.nextOffset : off + gotText.length
    if (off >= LEN) break
  }
  ok(got.length === LEN, `续读 ${calls} 次能取完全文（拼起来 === ${LEN} 字）`, String(got.length))
  ok(got === LONG, '拼起来的内容与原文逐字一致（分页不重不漏）')
  ok(drift === null, '每一页的正文都等于原文对应区间（offset 没有漂移）', JSON.stringify(drift))
}

// A3 —— 段落边界：能落在换行处就落在换行处（不把句子拦腰断）
{
  const para = '第1段' + 'A'.repeat(3000) + '\n' + '第2段' + 'B'.repeat(3000) + '\n' + '第3段' + 'C'.repeat(3000)
  const fitted = fitResult({ ok: true, text: para, offset: 0, length: para.length }, 4000)
  const cutOk = String(fitted.text || '').length <= 4000 && /^[\s\S]*\n$/.test(String(fitted.text || ''))
  ok(cutOk, '裁剪落在段落边界上（结尾是换行）', JSON.stringify(String(fitted.text || '').slice(-8)))
  ok(fitted.truncation?.nextOffset === String(fitted.text || '').length, '段落边界裁剪后 nextOffset 仍等于"已返回的长度"', JSON.stringify({ next: fitted.truncation?.nextOffset, len: String(fitted.text || '').length }))
}

// A4 —— 短结果不受影响（防修过头）：不加字段、形状不变
{
  const short = { ok: true, url: PAGE_URL, length: 12, offset: 0, text: '短正文', more: false }
  const fitted = fitResult(short, MAX_RESULT_CHARS)
  ok(fitted === short, '短结果原样返回（同一个对象引用，连字段都没加）')
  ok(typeof fitted === 'object' && fitted !== null && !('truncated' in fitted) && !('truncation' in fitted) && !('next' in fitted),
    '短结果里没有 truncated / truncation / next 字段')
}

// A5 —— 上限本身：正文按上限取满时，整串仍进 24000（声明 20000 与整体 24000 不打架）
{
  const full = { url: PAGE_URL, length: 40000, offset: 0, text: '乙'.repeat(MAX_TEXT_CHARS), more: true }
  const raw = serialize(fitResult(full))
  const p5 = tryParse(raw)
  ok(raw.length <= MAX_RESULT_CHARS, `正文取满 ${MAX_TEXT_CHARS} 字时整串仍 ≤ ${MAX_RESULT_CHARS}（不用二次裁剪）`, String(raw.length))
  ok(p5 !== null && p5.truncated !== true, '这种情况不该触发外层裁剪（正文确实是完整的、结果仍是合法 JSON）', String(raw).slice(0, 80))
}

// A6 —— 行数据 vs 正文的优先级：链接清单再大也不该把正文挤掉
{
  const links = Array.from({ length: 100 }, (_, i) => ({ text: '链接' + i + '丙'.repeat(100), url: 'https://x.test/' + i + '/'.padEnd(240, 'z') }))
  const fitted = fitResult({ ok: true, url: PAGE_URL, text: '丁'.repeat(20000), charsStart: 0, links }, MAX_RESULT_CHARS)
  const raw = serialize(fitted)
  ok(raw.length <= MAX_RESULT_CHARS, '链接清单非常大时整串仍进限额', String(raw.length))
  ok(tryParse(raw) !== null, '链接清单非常大时结果仍是合法 JSON')
  ok(String(fitted.text || '').length === 20000, '正文没被链接清单牵连（仍是完整的 20000 字）', String(String(fitted.text || '').length))
  ok(fitted.linksDropped >= 1 && Array.isArray(fitted.truncation?.fields) && fitted.truncation.fields.some((f) => f.field === 'links'),
    '丢掉的链接条数有记账（linksDropped + truncation.fields）', JSON.stringify({ dropped: fitted.linksDropped, fields: fitted.truncation?.fields }))
}

// ============================================================ [B] 真链路层
// ---------------------------------------------------------------- 假 cordis ctx + 真 index.js
const tools = new Map()
const routes = new Map()
const CTX_SERVICES = {
  webServer: { port: 52741, register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
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
    if (opts.body !== undefined) setTimeout(() => { req.emit('data', Buffer.from(JSON.stringify(opts.body))); req.emit('end') }, 0)
    if (p && typeof p.then === 'function') p.catch(() => {})
  })
}

/** 一台"假浏览器"：Worker 里跑真扩展代码 + 它自己的 chrome.*，长页模式见 fake-browser-worker.mjs 头部。 */
class FakeBrowser {
  constructor(kind, ua, tabs, extra = {}) {
    this.kind = kind
    this.dump = { calls: {} }
    this.seq = 0
    this.waiting = new Map()
    this.worker = new Worker(path.join(import.meta.dirname, 'fake-browser-worker.mjs'), {
      workerData: { extDir: path.join(import.meta.dirname, '..', 'extension'), kind, ua, tabs, ...extra },
    })
    this.ready = new Promise((resolve) => { this._resolveReady = resolve })
    this.worker.on('message', (m) => {
      if (m.type === 'ready') { this.kindSeen = m.kindSeen; this._resolveReady(m); return }
      if (m.state) this.dump = m.state
      const w = this.waiting.get(m.id)
      if (w) { this.waiting.delete(m.id); w(m) }
    })
    this.worker.on('error', (e) => { console.log('  [worker error]', kind, e.message) })
  }
  ask(fn, args) {
    const id = ++this.seq
    return new Promise((resolve) => { this.waiting.set(id, resolve); this.worker.postMessage({ type: 'call', id, fn, args }) })
  }
  async call(fn, args) { const r = await this.ask(fn, args); if (!r.ok) throw new Error(r.error); return r }
  async stop() { try { this.worker.postMessage({ type: 'exit' }); await this.worker.terminate() } catch { /* ignore */ } }
}

await mod.apply(ctx, { userBridge: false })
const put = await callRoute('/bl/settings.json', { method: 'PUT', body: { userBridge: true } })
ok(put.status === 200, 'PUT 打开桥（后半段要用真工具链路，但走的是假浏览器）')
const cfg = JSON.parse(readFileSync(path.join(home, 'dsh-browser-live', 'bridge.json'), 'utf8'))

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
const TABS = [{ id: 101, url: PAGE_URL, title: 'chrome 长页', active: true, windowId: 1 }]
const browser = new FakeBrowser('chrome', UA, TABS, { pageText: LONG, readLinks: 100 })
await browser.ready
await browser.call('saveCfg', { port: cfg.port, token: cfg.token, autoConnect: false })
await browser.call('connect')
const allowed = (await browser.ask('allowTabs')).value
await sleep(300)
ok(allowed?.added === 1, '假浏览器已接入桥且站点已授权（全程没有真浏览器进程）', JSON.stringify(allowed))

const call = async (name, args) => {
  const raw = await tools.get(name).execute({ use: 'chrome', ...args }, {})
  let json = null, err = null
  try { json = JSON.parse(raw) } catch (e) { err = String(e.message) }
  return { raw, json, err }
}

console.log('\n[B] 真工具链路（真 apply() + 真桥 + 真扩展 + 假浏览器，30000 字页面）')

// B1 —— 声明上限的那条路真的走得通：limit=99999 被夹到声明上限，结果合法且完整
{
  const r = await call('browser_text', { selector: 'body', limit: 99999 })
  ok(r.err === null, 'browser_text{limit:99999}：JSON 可解析（改动前：30000 字被切在 24000 ⇒ 抛错）', r.err)
  ok(r.raw.length <= MAX_RESULT_CHARS, `返回串长度 ≤ ${MAX_RESULT_CHARS}`, String(r.raw.length))
  ok(r.json?.text?.length === MAX_TEXT_CHARS, `实测正文上限 === 声明上限（${MAX_TEXT_CHARS}）`, String(r.json?.text?.length))
  ok(r.json?.length === LEN, '结果里带着"原始共多少字"（length=30000）', String(r.json?.length))
  ok(r.json?.more === true, '结果明确说"还有内容"（more=true）', JSON.stringify(r.json?.more))
  ok(r.json?.text === LONG.slice(0, MAX_TEXT_CHARS), '正文就是原文的前 20000 字（没有错位/丢字）')
}

// B2 —— 续读：照 offset 再取一次就能取完，拼起来一字不差
{
  const first = await call('browser_text', { selector: 'body', limit: MAX_TEXT_CHARS })
  const off = (first.json?.offset || 0) + (first.json?.text?.length || 0)
  const second = await call('browser_text', { selector: 'body', offset: off, limit: MAX_TEXT_CHARS })
  const joined = String(first.json?.text || '') + String(second.json?.text || '')
  ok(second.err === null, '续读一次：JSON 可解析', second.err)
  ok(second.json?.text?.length === LEN - off, `续读拿到剩下的 ${LEN - off} 字`, String(second.json?.text?.length))
  ok(second.json?.more === false, '续读后 more=false（到头了）', String(second.json?.more))
  ok(joined === LONG, '两次拼起来与原文逐字一致，长度 = 30000（分页不重不漏）', String(joined.length))
}

// B3 —— 短结果不受影响（防修过头）
{
  const tabs = await call('browser_tabs', { action: 'list' })
  ok(tabs.err === null && tabs.json?.tabs?.length === 1, '短结果照旧可用（browser_tabs 仍能解析）', tabs.err)
  ok(!('truncated' in (tabs.json || {})) && !('truncation' in (tabs.json || {})), '短结果里没有多出 truncated/truncation 字段（没改正常路径的形状）')
  const loc = await call('browser_eval', { expression: 'location.href' })
  ok(loc.json?.value === PAGE_URL && !('truncated' in (loc.json || {})), 'browser_eval 取短值照旧（无记账字段）', JSON.stringify(loc.json))
}

// B4 —— 外层真的裁剪时：仍是合法 JSON + 明确记账 + 续读位置（browser_read + 巨型链接清单）
{
  const r = await call('browser_read', { limit: MAX_TEXT_CHARS })
  ok(r.err === null, 'browser_read：链接清单把结果撑爆时 JSON 仍可解析', r.err)
  ok(r.raw.length <= MAX_RESULT_CHARS, `裁剪后长度 ≤ ${MAX_RESULT_CHARS}`, String(r.raw.length))
  ok(r.json?.truncated === true, '结果里带截断标记 truncated=true')
  ok(r.json?.truncation?.originalResultChars > MAX_RESULT_CHARS, '记着裁之前整串多长（originalResultChars）', String(r.json?.truncation?.originalResultChars))
  const fields = r.json?.truncation?.fields || []
  ok(fields.some((f) => f.field === 'links' && f.kept < f.original), '链接被弃尾且记了账（truncation.fields: links original/kept）', JSON.stringify(fields))
  ok(r.json?.linksDropped === (fields.find((f) => f.field === 'links')?.original - fields.find((f) => f.field === 'links')?.kept),
    'linksDropped 与 fields 里的记账一致', JSON.stringify({ dropped: r.json?.linksDropped, fields }))
  ok(r.json?.text?.length === MAX_TEXT_CHARS, '正文没被链接清单挤掉（仍是完整的 20000 字）', String(r.json?.text?.length))
  ok(r.json?.truncation?.nextOffset === (r.json?.charsStart || 0) + (r.json?.text?.length || 0), '带下次续读的 offset（= charsStart + 已返回长度）', JSON.stringify({ next: r.json?.truncation?.nextOffset, start: r.json?.charsStart, len: r.json?.text?.length }))
}

// B5 —— 正文本身超限（browser_eval 取回 30000 字）：按正文裁，且带原始长度 + 续读 offset
{
  const r = await call('browser_eval', { expression: 'document.querySelector("body").innerText' })
  ok(r.err === null, 'browser_eval 取回 30000 字：JSON 可解析（改动前：切坏）', r.err)
  ok(r.raw.length <= MAX_RESULT_CHARS, `返回串 ≤ ${MAX_RESULT_CHARS}`, String(r.raw.length))
  ok(r.json?.truncated === true && r.json?.truncation?.field === 'value', '记账指明被裁的是 value 字段', JSON.stringify(r.json?.truncation))
  ok(r.json?.truncation?.originalChars === LEN, '原始长度=30000', String(r.json?.truncation?.originalChars))
  ok(r.json?.truncation?.nextOffset === r.json?.value?.length && r.json?.value?.length > 0, '下次续读 offset = 已保留长度', JSON.stringify({ next: r.json?.truncation?.nextOffset, kept: r.json?.value?.length }))
}

// B6 —— 声明与实际一致：schema 里的数字 == 真 clamp == READ_FN 里的字面量
{
  const descOf = (n) => tools.get(n).parameters.properties.limit.description
  const declared = (s) => Number((String(s).match(/上限\s*(\d+)/) || [])[1])
  ok(declared(descOf('browser_text')) === MAX_TEXT_CHARS, `browser_text 的 limit 声明上限 === 实测上限（${MAX_TEXT_CHARS}）`, descOf('browser_text'))
  ok(declared(descOf('browser_read')) === MAX_TEXT_CHARS, `browser_read 的 limit 声明上限 === 实测上限（${MAX_TEXT_CHARS}）`, descOf('browser_read'))
  ok(String(descOf('browser_text')).includes(String(MAX_RESULT_CHARS)) && String(descOf('browser_read')).includes(String(MAX_RESULT_CHARS)),
    `两个声明都写明了整体上限 ${MAX_RESULT_CHARS} 字符`)
  ok(!/40000/.test(JSON.stringify(tools.get('browser_text').parameters) + JSON.stringify(tools.get('browser_read').parameters)),
    '工具声明里不再出现 40000（旧的、走不通的额度）')
  const readSrc = readFileSync(path.join(import.meta.dirname, '..', 'page-read.js'), 'utf8')
  const lit = Number((readSrc.match(/Math\.min\(Number\(args\.limit\) \|\| 8000,\s*(\d+)\)/) || [])[1])
  ok(lit === MAX_TEXT_CHARS, `page-read.js 里 READ_FN 的 clamp 字面量 === ${MAX_TEXT_CHARS}（注入函数读不到常量，只能靠这条钉住）`, String(lit))
  const jsonDesc = tools.get('browser_eval').description
  ok(/序列化前/.test(jsonDesc) && !/结果 JSON 截断 24k/.test(jsonDesc), 'browser_eval 的说明不再宣称"结果 JSON 截断 24k"（改成描述真行为）', jsonDesc.slice(0, 60))
}

// ============================================================ [C] 同一类问题的第二处
// 除了 browser_text/browser_read 的 40000，"内部上限 > 外层截断"的组合还有三处：
// browser_scrape（300 行 × 每格 400 字）、browser_search（50 条 × 标题 200 + 摘要 400）、
// browser_snapshot（140 元素 + 2600 字正文）。它们**没有**声明 40000，但同样会撑过 24000。
// 这三处走的是同一道收口，所以在这里（纯函数层）钉住"再大也是合法 JSON + 有记账"。
console.log('\n[C] 同类第二处：scrape / search / snapshot 形状的结果也被同一道收口兜住')
{
  const shapes = {
    scrape: { ok: true, url: PAGE_URL, matched: 300, returned: 300, truncated: false, rows: Array.from({ length: 300 }, (_, i) => ({ rank: i + 1, '标题': '标'.repeat(200), '链接': 'https://chrome.test/i/' + i })) },
    search: { ok: true, engine: 'bing', results: Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, title: '标'.repeat(200), url: 'https://x.test/' + i, snippet: '摘'.repeat(400) })) },
    snapshot: { ok: true, url: PAGE_URL, title: 't', elements: Array.from({ length: 140 }, (_, i) => ({ ref: 'e' + i, tag: 'button', role: 'button', text: '按'.repeat(60), x: 1, y: 2, ctx: 'c'.repeat(40) })), text: '正'.repeat(2600), textMore: true },
  }
  for (const [name, shape] of Object.entries(shapes)) {
    const raw = serialize(fitResult(shape, MAX_RESULT_CHARS))
    const parsed = tryParse(raw)
    ok(parsed !== null, `${name}：超限结果仍是合法 JSON（改动前同样是切坏）`, raw.slice(0, 60))
    ok(raw.length <= MAX_RESULT_CHARS, `${name}：长度进限额`, String(raw.length))
    ok(parsed?.truncated === true && Array.isArray(parsed?.truncation?.fields) && parsed.truncation.fields.length > 0,
      `${name}：截断显式记账（truncation.fields 指明裁了哪个字段/多少条）`, JSON.stringify(parsed?.truncation?.fields))
  }
  // 也确认它们没被"顺手改形状"：没超限时原样返回
  const small = { ok: true, returned: 2, rows: [{ a: 1 }, { a: 2 }] }
  ok(fitResult(small, MAX_RESULT_CHARS) === small, 'scrape 类短结果原样返回（没有多出记账字段）')
  ok(serialize(fitResult({ ok: true, returned: 1, rows: [{ a: 1 }] })) === JSON.stringify({ ok: true, returned: 1, rows: [{ a: 1 }] }),
    '短结果的序列化结果与改动前逐字相同（正常路径没有被这条修复碰到）')
}

// ---------------------------------------------------------------- 收尾
await callRoute('/bl/settings.json', { method: 'PUT', body: { userBridge: false } })
await sleep(150)
await browser.stop()
let cleaned = true
try { rmSync(home, { recursive: true, force: true }) } catch { cleaned = false }
ok(cleaned, '临时 DSH_HOME 清理干净（没有残留进程占着目录）')
console.log(`\n${fail ? '✗' : '✓'} verify-result-cap: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
