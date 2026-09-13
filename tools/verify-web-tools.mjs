// 新工具（browser_read / browser_scrape / browser_search）的**集成测试**：
// 走真的 apply() → 真工具注册表 → 真 browser.cdp → 真无头浏览器，而不是只测页面侧函数。
//
// 为什么值得单独一个文件：verify-page-fns.mjs 测的是"注入到页面里的那些函数对不对"，
// 但工具层自己还有一层会出错的东西 —— 参数拼接、clamp、ref/selector 分支、结果形状、
// 以及"工具之间的配合"（点完页面真的变了吗、回读真的回来了吗）。这一层只有在真工具链上跑才测得到。
//
// 跑法：node tools/verify-web-tools.mjs
// 可选：BL_TEST_SEARCH=1 时额外做一次**真联网**搜索（默认跳过：网络/验证码会让它不稳定，
//       但它的价值在于尽早发现"引擎改版了"这种选择器腐烂）。
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + String(extra).slice(0, 300) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = mkdtempSync(path.join(os.tmpdir(), 'bl-webtools-'))
const fixDir = mkdtempSync(path.join(os.tmpdir(), 'bl-webtools-fix-'))
process.env.DSH_HOME = home

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)

// 本机没有可启动的 Chromium 就跳过（不假装通过）
const HAS_CHROMIUM = (() => {
  try {
    const found = typeof mod.findChromiumExes === 'function' ? mod.findChromiumExes() : []
    const list = Array.isArray(found) ? found : Object.values(found || {}).flat().filter((x) => typeof x === 'string')
    return list.filter((p) => existsSync(p)).length > 0
  } catch { return false }
})()
if (!HAS_CHROMIUM) {
  console.log('  ⚠ SKIP：本机没有 Chrome/Edge/Brave，工具层集成测试未覆盖（别当成通过）')
  rmSync(home, { recursive: true, force: true }); rmSync(fixDir, { recursive: true, force: true })
  process.exit(0)
}

// ---------------------------------------------------------------- fixture
const rel = (n) => path.join(fixDir, n)
const fileUrl = (n) => pathToFileURL(rel(n)).href
writeFileSync(rel('page.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>集成测试页 · 示例</title><meta name="description" content="集成测试用的页面。">
<script type="application/ld+json">{"@type":"Article","headline":"集成测试页","author":{"name":"李四"},"datePublished":"2026-03-01"}</script>
<style>
  #cover{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9}
  #b2{position:relative;z-index:1}
</style></head><body>
<nav>导航不该进正文</nav>
<article>
  <h1>集成测试页</h1>
  <p id="para">第一段正文，含一个<a href="https://example.com/x">链接</a>。</p>
  <button id="b1" onclick="document.getElementById('out').textContent='CLICKED-OK'">点我</button>
  <div id="out">NOT-CLICKED</div>
  <div id="coverWrap" style="position:relative;display:inline-block">
    <button id="b2">被遮罩盖住的按钮</button>
    <div id="cover" style="position:absolute;inset:0;z-index:9;background:rgba(0,0,0,.3)"></div>
  </div>
  <input id="t1" type="text">
  <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></tbody></table>
  <div class="card"><h3><a href="https://example.com/1">第一项</a></h3><span class="price">¥10</span></div>
  <div class="card"><h3><a href="https://example.com/2">第二项</a></h3><span class="price">¥20</span></div>
  ${'<p>填充段落，保证正文长度超过两百字以免走 body 兜底。</p>'.repeat(8)}
</article>
<footer>页脚不该进正文</footer>
</body></html>`)

// ---------------------------------------------------------------- 假 ctx + 真插件
const tools = new Map()
const routes = new Map()
const skillRegs = []
const CTX = {
  webServer: { port: 52731, register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
  connection: { authenticatedUrl: (b) => String(b).replace(/\/+$/, '') + '/?token=TEST' },
  skills: { register: (s) => { skillRegs.push(s); return () => { } } },
}
const ctx = {
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => { } },
  get: (k) => CTX[k],
  inject: (deps, cb) => { if (deps.every((d) => CTX[d] !== undefined)) cb(Object.assign({ get: (k) => CTX[k] }, CTX)) },
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
}

// headless=true：测试不能让浏览器窗口弹到用户脸上；launchDetached=false 走普通 spawn，
// 免得 VBS 启动器把进程脱离出去、测试结束时收不干净。
await mod.apply(ctx, { headless: true, launchDetached: false, humanize: false })

const call = async (name, args = {}) => {
  const tool = tools.get(name)
  if (!tool) throw new Error('工具未注册: ' + name)
  return String(await tool.execute(args, {}))
}
const has = (s, ...subs) => subs.every((x) => String(s).includes(x))

console.log(`\n[1] 注册面`)
ok(tools.size === 21, '21 个工具已注册', String(tools.size))
ok(tools.has('browser_read') && tools.has('browser_scrape') && tools.has('browser_search'), '三个新工具都在')
ok(skillRegs.some((s) => s.name === 'browser-automation'), '调用方案技能已注册进 skills 服务')

console.log(`\n[2] 真启动浏览器 + 导航`)
const openRes = await call('browser_open', {})
ok(/ok":true/.test(openRes), 'browser_open 成功（无头）', openRes)
const navRes = await call('browser_navigate', { url: fileUrl('page.html') })
ok(has(navRes, '"ok":true', 'page.html'), '导航到本地 fixture 成功', navRes)

console.log(`\n[3] browser_read（走真工具层）`)
const read1 = await call('browser_read', { links: true, headings: true })
ok(has(read1, '"ok":true', '"source":"article"'), '正文来源识别为 article', read1.slice(0, 200))
ok(read1.includes('第一段正文'), '正文内容读到了')
ok(!read1.includes('导航不该进正文') && !read1.includes('页脚不该进正文'), '导航/页脚被剔除')
ok(has(read1, '"author":"李四"', '不可信数据'), 'JSON-LD 作者 + 不可信内容提示都在', read1.slice(0, 400))
ok(/# 集成测试页/.test(read1), 'Markdown 标题被保留')
const read2 = await call('browser_read', { limit: 300, links: false, selector: '#para' })
ok(has(read2, '"source":"selector"', '第一段正文'), 'selector 限定读取生效', read2.slice(0, 200))

console.log(`\n[4] browser_scrape（走真工具层）`)
const scrape = await call('browser_scrape', { item: '.card', fields: { 标题: 'h3 a', 链接: 'h3 a@href', 价格: '.price' } })
ok(has(scrape, '"matched":2', '"标题":"第一项"', '"价格":"¥20"'), '两个卡片按字段映射抓到了', scrape.slice(0, 300))
ok(scrape.includes('https://example.com/1'), 'href 是绝对 URL')
const scrapeBad = await call('browser_scrape', { item: '.nope', fields: { t: 'a' } })
ok(has(scrapeBad, '"ok":false'), 'item 未命中时明确报错（不是空数组）', scrapeBad.slice(0, 200))
// 缺 fields：DSH 的工具层在**执行之前**就按 schema 拒掉了（ToolArgsError），
// 所以这里断言的是"schema 校验生效"，而不是工具内部那层 defence in depth 的报错。
let schemaErr = null
try { await call('browser_scrape', { item: '.card' }) } catch (e) { schemaErr = e }
ok(schemaErr && /fields/.test(String(schemaErr.message)), '缺 fields 被工具 schema 在执行前拦下', String(schemaErr && schemaErr.message))

console.log(`\n[5] browser_snapshot + 可操作性检查（走真工具层）`)
const snap1 = JSON.parse(await call('browser_snapshot', {}))
ok(Array.isArray(snap1.elements) && snap1.elements.length > 0, '快照有元素清单', snap1.elements && snap1.elements.length)
ok(!!snap1.refsInfo, 'refsInfo 存在（编号复用统计）', JSON.stringify(snap1.refsInfo))
const b1 = snap1.elements.find((e) => e.text === '点我')
const b2 = snap1.elements.find((e) => (e.text || '').includes('被遮罩盖住'))
ok(!!b1 && !!b2, '两个按钮都在快照里')
ok(b2.flags.some((f) => /covered/.test(f)), '被遮罩盖住的按钮标了 covered', JSON.stringify(b2.flags))
const snap2 = JSON.parse(await call('browser_snapshot', {}))
const b1b = snap2.elements.find((e) => e.text === '点我')
ok(b1 && b1b && b1.ref === b1b.ref, 'ref 跨快照稳定（同一元素同一编号）', JSON.stringify([b1 && b1.ref, b1b && b1b.ref]))

console.log(`\n[6] 点/输入：成功路径与"确定性失败"路径`)
const blocked = await call('browser_click', { ref: b2.ref })
ok(has(blocked, '"ok":false', '"reason":"covered"'), '点被遮住的按钮 → 明确返回 covered，不静默点空', blocked.slice(0, 240))
const clicked = await call('browser_click', { ref: b1.ref })
ok(has(clicked, '"ok":true'), '点正常按钮成功', clicked.slice(0, 200))
await sleep(300)
const outText = await call('browser_text', { selector: '#out' })
ok(outText.includes('CLICKED-OK'), '页面真的发生了预期变化（onclick 生效）', outText.slice(0, 200))
const typed = await call('browser_type', { selector: '#t1', text: 'hello-世界' })
ok(has(typed, '"ok":true', '"matches":true'), '输入后回读匹配', typed.slice(0, 240))
const typedBad = await call('browser_click', { selector: '#b2', force: true })
ok(has(typedBad, '"ok":true'), 'force:true 时跳过检查（给"就是要硬点"留出口）', typedBad.slice(0, 200))

console.log(`\n[7] browser_search 的参数校验（不联网）`)
const badEngine = await call('browser_search', { query: 'x', engine: 'google-but-not-a-real-key' })
ok(has(badEngine, '"ok":false', '未知引擎'), '未知引擎名被拒并列出可用引擎', badEngine.slice(0, 240))
let queryErr = null
try { await call('browser_search', {}) } catch (e) { queryErr = e }
ok(queryErr && /query/.test(String(queryErr.message)), '缺 query 被 schema 拦下', String(queryErr && queryErr.message))

if (process.env.BL_TEST_SEARCH === '1') {
  console.log(`\n[8] browser_search 真联网（BL_TEST_SEARCH=1）`)
  const s = await call('browser_search', { query: 'deepseek harness', engine: 'bing', limit: 5 })
  const parsed = JSON.parse(s)
  if (parsed.challenge) ok(true, '真搜索遇到人机验证 → 工具如实回报 challenge（这本身是正确行为）', JSON.stringify(parsed.challenge))
  else ok(parsed.ok === true && Array.isArray(parsed.results) && parsed.results.length > 0, '真搜索拿到结构化结果', s.slice(0, 400))
  ok(!parsed.ok || parsed.results.every((r) => /^https?:/.test(r.url)), '结果 URL 都是 http(s)')
} else {
  console.log('\n[8] browser_search 真联网：跳过（置 BL_TEST_SEARCH=1 可跑；选择器腐烂靠它尽早发现）')
}

console.log('\n[9] 收尾')
const closed = await call('browser_close', {})
ok(has(closed, '"ok":true'), 'browser_close 正常收尾（不留浏览器进程）', closed.slice(0, 160))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
// 兜底：万一某条断言在浏览器还活着时就失败退出，也别把进程留在机器上
try {
  const st = mod.readState && mod.readState()
  if (st && st.pid) spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { stdio: 'ignore' })
} catch { }
rmSync(home, { recursive: true, force: true })
rmSync(fixDir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
