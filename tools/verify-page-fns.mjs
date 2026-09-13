// 页面侧注入函数 + 搜索结果归一的验收测试（v0.10.0 新增）。
//
// 为什么必须**真起一个浏览器**：page-read.js 里的函数全都跑在页面上下文里，吃的是真 DOM
// （getComputedStyle / elementFromPoint / innerText / contentDocument），用 jsdom 之类的替身
// 测出来的绿是假绿 —— 尤其遮挡检测、祖先可见性、表格/列表的 innerText 语义，替身和真浏览器
// 常有肉眼看不出的差异。所以这里拉起一个无头 Chromium（Edge/Chrome 都在候选里），用 CDP
// 直连，把本地 fixture 页面真渲染出来再断言。
//
// 零外部依赖：CDP 客户端用 Node 自带的全局 WebSocket 手写（Node ≥22）。
// 跑法：node tools/verify-page-fns.mjs
// 若本机没有任何 Chromium 候选，会明确打印 SKIP 并以 0 退出（不假装通过）。
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + String(extra).slice(0, 300) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 这些函数本不该依赖 DSH_HOME，但 index.js 顶层会读它，所以先指到临时目录再 import。
const home = mkdtempSync(path.join(os.tmpdir(), 'bl-pfns-'))
process.env.DSH_HOME = home

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)
const FNS = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'page-read.js')).href)

// ---------------------------------------------------------------- 起浏览器
const exe = (() => {
  const found = typeof mod.findChromiumExes === 'function' ? mod.findChromiumExes() : []
  const list = Array.isArray(found) ? found : Object.values(found || {}).flat().filter((x) => typeof x === 'string')
  return list[0] || ''
})()
if (!exe) {
  console.log('  ⚠ SKIP：本机找不到 Chrome/Edge/Brave，页面侧函数未被覆盖（这条别当成通过）')
  process.exit(0)
}

const port = 9500 + Math.floor(Math.random() * 400)
const profile = mkdtempSync(path.join(os.tmpdir(), 'bl-pfns-prof-'))
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'bl-pfns-fixtures-'))
const proc = spawn(exe, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--window-size=1280,900',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' })

function cleanup() {
  try { proc.kill() } catch { }
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { }
  for (const d of [profile, fixtureDir, home]) { try { rmSync(d, { recursive: true, force: true }) } catch { } }
}
process.on('exit', cleanup)

// 等端口起来
let wsUrl = ''
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break }
  } catch { }
}
if (!wsUrl) { console.log('  ✗ 浏览器没起来（CDP 端口未就绪）'); fail++; cleanup(); process.exit(1) }

/** 极简 CDP 客户端：send(method, params) 配 id，事件忽略。 */
function connect(url) {
  const ws = new WebSocket(url)
  const waiting = new Map()
  let seq = 0
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res())
    ws.addEventListener('error', (e) => rej(new Error('WS 连接失败: ' + (e.message || 'error'))))
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (msg.error) rej(new Error(msg.error.message || 'CDP 错误'))
      else res(msg.result)
    }
  })
  return {
    ready,
    send(method, params = {}, timeoutMs = 15000) {
      const id = ++seq
      return new Promise((res, rej) => {
        const t = setTimeout(() => { waiting.delete(id); rej(new Error('CDP 超时: ' + method)) }, timeoutMs)
        waiting.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { try { ws.close() } catch { } },
  }
}

/** 打开一个本地 fixture，返回该页面的 CDP 客户端 + 一个 inject(FN, args) 便捷函数。 */
async function openFixture(file) {
  const browser = connect(wsUrl)
  await browser.ready
  const { targetId } = await browser.send('Target.createTarget', { url: pathToFileURL(file).href })
  // 拿页面自己的 WS（免去 sessionId 处理）
  let pageWs = ''
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`)
    const list = await r.json()
    const t = list.find((x) => x.id === targetId)
    if (t && t.webSocketDebuggerUrl) { pageWs = t.webSocketDebuggerUrl; break }
    await sleep(120)
  }
  const page = connect(pageWs)
  await page.ready
  await page.send('Runtime.enable').catch(() => { })
  for (let i = 0; i < 40; i++) {
    const rs = await page.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => null)
    if (rs && rs.result && rs.result.value === 'complete') break
    await sleep(120)
  }
  const inject = async (fnSource, args = []) => {
    const expr = '(' + fnSource + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')'
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面内抛错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  const evalJs = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval 抛错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { browser, page, inject, evalJs, close: () => { page.close(); browser.close() } }
}

// ---------------------------------------------------------------- fixtures
const w = (name, html) => { const p = path.join(fixtureDir, name); writeFileSync(p, html, 'utf8'); return p }

const longParas = Array.from({ length: 40 }, (_, i) => `<p>第 ${i + 1} 段正文。` + '这里是用来把文章撑长的句子，段落要有明确边界，好验证截断是按段落切的。'.repeat(2) + '</p>').join('\n')
const tableRows = Array.from({ length: 30 }, (_, i) => `<tr><td>行${i + 1}</td><td>值${i + 1}</td></tr>`).join('\n')

const articleFile = w('article.html', `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>测试文章标题 · 示例站</title>
<meta name="description" content="这是 meta 描述。">
<meta property="og:site_name" content="示例站">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsArticle","headline":"JSON-LD 标题","datePublished":"2026-02-01T08:00:00Z","author":{"@type":"Person","name":"张三"}}]}</script>
</head><body>
<nav>首页 关于 联系（导航不该进正文）</nav>
<div class="cookie-consent">我们使用 Cookie 来改善体验（同意条不该进正文）</div>
<article>
  <h1>测试文章标题</h1>
  <p>第一段：这是正文的开头，里面有一个<a href="https://example.com/ref?a=1">外部链接</a>。</p>
  <div class="related-share"><a href="https://a.example/1">相关阅读一</a><a href="https://a.example/2">相关阅读二</a><a href="https://a.example/3">相关阅读三</a></div>
  <h2>小节标题</h2>
  <ul><li>列表项甲</li><li>列表项乙</li></ul>
  <pre><code class="language-js">const a = 1;
console.log(a);</code></pre>
  <table><thead><tr><th>列A</th><th>列B</th></tr></thead><tbody>${tableRows}</tbody></table>
  <p style="display:none">隐藏段落不该出现</p>
  <aside>侧栏广告：买点什么（aside 不该进正文）</aside>
  ${longParas}
</article>
<footer>版权所有（页脚不该进正文）</footer>
</body></html>`)

const listFile = w('list.html', `<!doctype html><html><head><meta charset="utf-8"><title>列表页</title></head><body>
<h1>商品列表</h1><ul id="cards">
${Array.from({ length: 12 }, (_, i) => `<li class="card"><h3><a href="/item/${i + 1}">商品 ${i + 1}</a></h3><span class="price">¥${(i + 1) * 10}</span><img src="/img/${i + 1}.png" alt="图${i + 1}"></li>`).join('\n')}
</ul></body></html>`)

const serpFile = w('serp.html', `<!doctype html><html><head><meta charset="utf-8"><title>测试 结果 - Bing</title></head><body>
<ol id="b_results">
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=https%3A%2F%2Fexample.com%2Fone">结果一</a></h2><div class="b_caption"><p>第一条摘要。</p></div></li>
  <li class="b_algo"><h2><a href="https://www.example.com/two/?utm_source=x&utm_medium=y#frag">结果二</a></h2><div class="b_caption"><p>短摘要。</p></div></li>
  <li class="b_algo"><h2><a href="https://www.example.com/two/?utm_source=z">结果二重复</a></h2><div class="b_caption"><p>重复项里更长的摘要文本。</p></div></li>
  <li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=x">Bing 图片（内链，应被过滤）</a></h2><p>内链摘要</p></li>
</ol></body></html>`)

const blockedFile = w('blocked.html', `<!doctype html><html><head><meta charset="utf-8"><title>安全验证</title></head><body>
<div class="verify-box">请完成验证：访问过于频繁，请完成验证后继续。</div></body></html>`)

const cfFile = w('cf.html', `<!doctype html><html><head><meta charset="utf-8"><title>Just a moment...</title></head><body>
<div id="challenge-stage">Checking your browser before accessing example.com</div></body></html>`)

const recaptchaFile = w('recaptcha.html', `<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head><body>
<div class="g-recaptcha" data-sitekey="x"></div><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></body></html>`)

const overlayFile = w('overlay.html', `<!doctype html><html><head><meta charset="utf-8"><title>遮挡与状态</title>
<style>
 body{margin:0;font:14px sans-serif}
 #cover{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.4);z-index:10}
 #modal{position:fixed;top:200px;left:400px;width:300px;height:200px;background:#fff;z-index:11}
 .pointee{pointer-events:none}
 .fakebtn{cursor:pointer;display:inline-block;padding:6px;border:1px solid #999}
 .act{cursor:pointer}
</style></head><body>
<div id="modal"><div id="modalTitle">弹层标题</div><button id="modalBtn">弹层里的按钮</button></div>
<div id="cover"></div>
<button id="hiddenBtn" style="display:none">隐藏按钮</button>
<button id="disabledBtn" disabled>禁用按钮</button>
<span id="pe" class="pointee">不接收点击</span>
<div class="fakebtn" id="reactish">React 风格的按钮</div>
<div id="rows">
  <div class="row"><h4>订单 A</h4><span class="act">编辑</span></div>
  <div class="row"><h4>订单 B</h4><span class="act">编辑</span></div>
  <div class="row"><h4>订单 C</h4><span class="act">编辑</span></div>
</div>
<input id="pw" type="password" value="secret123">
<input id="txt" type="text" value="">
</body></html>`)

// ---------------------------------------------------------------- 1) browser_read 的正文识别与清洗
console.log('\n[1] READ_FN —— 正文/元信息/结构')
{
  const f = await openFixture(articleFile)
  const r = await f.inject(FNS.READ_FN, [{ limit: 4000, links: true, headings: true }])
  ok(r && r.ok === true, '读出结果且 ok=true', r && r.error)
  ok(r.source === 'article', '正文来源识别为 article', r.source)
  ok(/^# 测试文章标题/m.test(r.text), 'Markdown 保留 h1 标题')
  ok(r.text.includes('第一段'), '正文段落被保留')
  ok(r.text.includes('[外部链接](https://example.com/ref?a=1)'), '行内链接转成 Markdown', r.text.slice(0, 200))
  ok(/^- 列表项甲/m.test(r.text), '无序列表转成 - 项')
  ok(/```js\nconst a = 1;/.test(r.text), 'PRE 转成带语言的围栏代码块（≥3 个反引号）', JSON.stringify(r.text.slice(Math.max(0, r.text.indexOf('const a') - 40), r.text.indexOf('const a') + 20)))
  const fence = (r.text.match(/`+js/) || [''])[0]
  ok(fence.length >= 3, '围栏至少有 3 个反引号（2 个的话 Markdown 里根本不是代码块）', JSON.stringify(fence))

  // 边界：代码块内容自带 ``` 时，围栏必须加长到 4 个，否则块会被内容提前闭合
  const nestedFile = w('nested.html', `<!doctype html><html><body><article><h1>嵌套围栏</h1>
<pre><code class="language-markdown">\`\`\`
inner fence
\`\`\`</code></pre>
<p>${'正文填充。'.repeat(60)}</p></article></body></html>`)
  const nf = await openFixture(nestedFile)
  const nr = await nf.inject(FNS.READ_FN, [{ limit: 2000, links: false }])
  const nfence = (nr.text.match(/`+markdown/) || [''])[0]
  ok(nfence.length >= 4, '内容含 ``` 时围栏自适应加长（≥4）', JSON.stringify(nfence))
  ok(/inner fence/.test(nr.text), '嵌套代码块内容完整保留')
  nf.close()
  ok(/\| 列A \| 列B \|/.test(r.text), '表格转成 GFM 表格')
  ok(/还有 \d+ 行未展开/.test(r.text), '表格超过 25 行时封顶并说明剩余行数')
  ok(!r.text.includes('导航不该进正文'), '导航文本被剔除')
  ok(!r.text.includes('页脚不该进正文'), '页脚文本被剔除')
  ok(!r.text.includes('同意条不该进正文'), 'Cookie 同意条被剔除')
  ok(!r.text.includes('侧栏广告'), 'aside 被剔除')
  ok(!r.text.includes('隐藏段落不该出现'), 'display:none 的内容被剔除')
  ok(!/相关阅读一/.test(r.text), '链接密度过高的推荐位被剔除')
  ok(r.meta && /meta 描述/.test(r.meta.description || ''), 'meta description 被读出', JSON.stringify(r.meta))
  ok(r.meta && r.meta.siteName === '示例站', 'og:site_name 被读出')
  ok(r.meta && r.meta.author === '张三', 'JSON-LD 作者被读出（@graph 递归）', JSON.stringify(r.meta))
  ok(/^2026-02-01/.test((r.meta && r.meta.published) || ''), 'JSON-LD 发布时间被读出')
  ok(r.title.includes('测试文章标题'), '标题被读出')
  ok(r.lang === 'zh-CN', 'lang 被读出')
  ok(Array.isArray(r.links) && r.links.some((l) => l.u === 'https://example.com/ref?a=1'), '链接清单含文章内链接')
  ok(Array.isArray(r.headings) && r.headings.some((h) => h.level === 2 && h.text === '小节标题'), '标题大纲被读出')
  ok(r.textLength > 3000, 'textLength 反映全文长度（不是窗口长度）', r.textLength)

  // 纯文本模式
  const t = await f.inject(FNS.READ_FN, [{ format: 'text', limit: 500, links: false }])
  ok(!/^#\s/m.test(t.text) && !t.text.includes(']('), 'format=text 时不产出 Markdown 语法', t.text.slice(0, 120))
  ok(t.links === undefined, 'links=false 时不返回链接清单')

  // 段落感知截断 + 续读
  const c1 = await f.inject(FNS.READ_FN, [{ limit: 900, links: false }])
  ok(c1.truncated === true, 'limit 小于全文时 truncated=true')
  ok(c1.text.length <= 900, '返回长度不超过 limit', c1.text.length)
  const tail = c1.text.trim().slice(-1)
  ok(/[。！？.!?\n]/.test(tail), '截断点落在段落/句子边界（不是拦腰切）', JSON.stringify(c1.text.slice(-40)))
  const c2 = await f.inject(FNS.READ_FN, [{ offset: c1.charsStart + c1.text.length, limit: 900, links: false }])
  ok(c2.text.length > 0 && c2.charsStart > c1.charsStart, '续读能接着往下取', JSON.stringify({ a: c1.charsStart, b: c2.charsStart }))
  ok(!c1.text.includes(c2.text.slice(0, 60)), '两段之间有实际推进（没有原地重复）')

  // 选择器限定 + 未命中
  const sel = await f.inject(FNS.READ_FN, [{ selector: 'table', limit: 2000, links: false }])
  ok(sel.ok === true && sel.source === 'selector' && !sel.text.includes('第一段'), 'selector 限定只读该区域')
  const bad = await f.inject(FNS.READ_FN, [{ selector: '#nope' }])
  ok(bad.ok === false && /未命中/.test(bad.error), 'selector 未命中时明确报错', JSON.stringify(bad))
  f.close()
}

// ---------------------------------------------------------------- 2) SCRAPE_FN
console.log('\n[2] SCRAPE_FN —— 重复结构抓取')
{
  const f = await openFixture(listFile)
  const r = await f.inject(FNS.SCRAPE_FN, [{
    item: '.card', limit: 50,
    fields: { 标题: 'h3 a', 链接: 'h3 a@href', 价格: '.price', 图: 'img@src', 自身文本: '@text', html: '.price@html' },
  }])
  ok(r.ok === true && r.matched === 12 && r.rows.length === 12, '12 个卡片全抓到', JSON.stringify({ m: r.matched, n: r.rows && r.rows.length }))
  ok(/^file:\/\/.*item\/1$/.test(r.rows[0].链接), '相对 href 被转成绝对 URL', r.rows[0].链接)
  ok(r.rows[0].标题 === '商品 1', '字段映射取到子节点文本', r.rows[0].标题)
  ok(r.rows[2].价格 === '¥30', '第二个字段映射正确', r.rows[2].价格)
  ok(/^file:\/\/.*img\/1\.png$/.test(r.rows[0].图), '@src 属性取值并绝对化', r.rows[0].图)
  ok(r.rows[0].html === '¥10', '@html 取 innerHTML', r.rows[0].html)
  ok(r.rows[0].自身文本.includes('商品 1'), '@text 取节点自身文本')
  const limited = await f.inject(FNS.SCRAPE_FN, [{ item: '.card', limit: 3, fields: { t: 'h3 a' } }])
  ok(limited.rows.length === 3 && limited.truncated === true, 'limit 生效且标注 truncated')
  const miss = await f.inject(FNS.SCRAPE_FN, [{ item: '.无此class', fields: { t: 'a' } }])
  ok(miss.ok === false && /未命中/.test(miss.error), 'item 未命中时报错并给提示', JSON.stringify(miss).slice(0, 160))
  const noFields = await f.inject(FNS.SCRAPE_FN, [{ item: '.card', fields: {} }])
  ok(noFields.ok === false && /fields/.test(noFields.error), 'fields 为空时报错')
  f.close()
}

// ---------------------------------------------------------------- 3) SEARCH_FN + 结果归一
console.log('\n[3] SEARCH_FN —— SERP 抽取与归一')
{
  const f = await openFixture(serpFile)
  const spec = { item: 'li.b_algo', link: 'h2 a', title: 'h2', text: '.b_caption p', limit: 10 }
  const raw = await f.inject(FNS.SEARCH_FN, [spec])
  ok(raw.count === 3, '抓到 3 条（Bing 内链被过滤掉）', JSON.stringify(raw.items && raw.items.map((x) => x.url)))
  ok(raw.items[0].url === 'https://example.com/one', 'bing /ck/a?u= 跳转链被解包', raw.items[0].url)
  ok(raw.items[0].title === '结果一', '标题字段正确')
  ok(raw.items[0].snippet === '第一条摘要。', '摘要字段正确')
  ok(raw.items.every((x) => /^https?:/.test(x.url)), '所有结果 URL 都是 http(s)')
  ok(raw.items.every((x) => !/bing\.com/.test(x.url)), '引擎自家内链被剔除')
  ok(raw.emptyReason === '', '有条目时 emptyReason 为空')
  ok(raw.blocked === false, '正常结果页不判为被拦')

  // ---- 百度：夹具**照抄 2026-09-13 联网实测到的真实 DOM**（不是我猜的结构）----
  // 教训：我第一版百度选择器是凭通用约定推的，夹具也跟着我猜的结构写，于是测试全绿、线上 0 条。
  // 实测拿到的两件事：① 标题链接是 http://www.baidu.com/link?url=<加密串>（页内解不开，
  // 但**必须留下**，且要标 viaEngineRedirect）；② 摘要新卡片版在 [class*=summary]（哈希后缀类名）里。
  const baiduFile = w('baidu-serp.html', `<!doctype html><html><head><meta charset="utf-8"><title>测试_百度搜索</title></head><body>
<div id="content_left">
  <div class="result c-container xpath-log new-pmd">
    <div class="cosc-card aladdin-struct_r13eS">
      <h3 class="t"><a href="http://www.baidu.com/link?url=l1ZgPzC0F5xQfUp03mmAeSHhQVGDH6hvrjcrFE8otmCVMLY1cmWUZTFRxmkyGnF8E26MZOaeVwUXevAEYgd7MjGVKipsobLOMPmMp_gm0Fq">百度结果一 · GitHub</a></h3>
      <div class="cos-color-text-tiny summary-gap_68jXq">第一条摘要：新卡片版把摘要放在 [class*=summary] 里。</div>
    </div>
  </div>
  <div class="result c-container xpath-log new-pmd">
    <h3 class="t"><a href="http://www.baidu.com/link?url=U7irskomgJbU4UNSPhwZ0meIMTigcGKRZMycXdgqKTjFgiI6fB6GTYJqbKJrk9YXjFUrnIrD95lBbIFYkOka6K">百度结果二</a></h3>
    <div class="c-abstract">老版式摘要：.c-abstract 也得兼容。</div>
  </div>
  <div class="result c-container xpath-log new-pmd">
    <h3 class="t"><a href="https://example.com/normal">正常站点结果（不是跳转链）</a></h3>
    <div class="c-abstract">正常站点的摘要。</div>
  </div>
  <div class="c-container"><a href="https://www.baidu.com/more/">百度更多（引擎内链，应被过滤）</a></div>
</div></body></html>`)
  const bdx = await openFixture(baiduFile)
  const bspec = { ...mod.SEARCH_ENGINES.baidu.spec, limit: 10 }
  const braw = await bdx.inject(FNS.SEARCH_FN, [bspec])
  ok(braw.count === 3, '百度：3 条真结果（"更多"内链被过滤）', JSON.stringify(braw.items && braw.items.map((x) => x.url && x.url.slice(0, 40))))
  ok(braw.emptyReason === '', '百度：不算空结果（曾误报 layout-changed）', braw.emptyReason)
  ok(braw.items[0] && /^https?:\/\/www\.baidu\.com\/link\?url=/.test(braw.items[0].url), '百度：加密跳转链被保留（解不开也得留）', braw.items[0] && braw.items[0].url.slice(0, 50))
  ok(braw.items[0] && braw.items[0].viaEngineRedirect === true, '百度：解不开的跳转链被如实标注 viaEngineRedirect')
  ok(braw.items[0] && braw.items[0].snippet.includes('summary'), '百度：新卡片版摘要从 [class*=summary] 取到', braw.items[0] && braw.items[0].snippet.slice(0, 40))
  ok(braw.items[1] && braw.items[1].snippet.includes('老版式'), '百度：老版式 .c-abstract 仍然兼容', braw.items[1] && braw.items[1].snippet.slice(0, 40))
  ok(braw.items.every((x) => !/baidu\.com\/more/.test(x.url)), '百度：引擎自家内链（/more/）被剔除')
  ok(braw.items[2] && braw.items[2].url === 'https://example.com/normal' && !braw.items[2].viaEngineRedirect, '普通站点 URL 不打跳转链标记', braw.items[2] && JSON.stringify(braw.items[2]))

  // host 侧归一：丢 utm、去 www、剥 fragment、去尾斜杠，重复项合并且保留更长摘要
  const merged = mod.mergeSearchResults([
    { url: 'https://www.example.com/two/?utm_source=x&utm_medium=y#frag', title: 'A', snippet: '短' },
    { url: 'https://example.com/two/', title: 'A2', snippet: '重复项里更长的摘要文本。' },
    { url: 'https://other.test/a', title: 'B', snippet: '别的站' },
  ], 10)
  ok(merged.length === 2, '按归一化 URL 去重（utm/fragment/尾斜杠/www 都不算差异）', JSON.stringify(merged.map((m) => m.url)))
  ok(merged[0].url === 'https://example.com/two', '归一去掉了 www / utm / fragment / 尾斜杠', merged[0].url)
  ok(merged[0].snippet === '重复项里更长的摘要文本。', '重复项保留更长的摘要')
  ok(merged[0].rank === 1 && merged[1].rank === 2, 'rank 重新编号')
  const capped = mod.mergeSearchResults(Array.from({ length: 20 }, (_, i) => ({ url: 'https://e.test/' + i, title: 't' + i, snippet: 's' })), 5)
  ok(capped.length === 5, 'limit 封顶生效')

  // 三层空结果判定：先"页面有内容但选择器没命中"（改版），再"反爬拦截"，最后"页面还没加载"
  const af = await openFixture(articleFile)
  const layout = await af.inject(FNS.SEARCH_FN, [{ item: 'li.nope', link: 'a', title: 'a', text: 'p', limit: 5 }])
  ok(layout.count === 0 && layout.emptyReason === 'layout-changed', '空结果 + 正文够长 ⇒ layout-changed（引擎改版）', layout.emptyReason)
  const thin = await (async () => {
    const emptyFile = w('empty.html', `<!doctype html><html><head><meta charset="utf-8"><title>加载中</title></head><body><div id="app"></div></body></html>`)
    const ef = await openFixture(emptyFile)
    const nl = await ef.inject(FNS.SEARCH_FN, [{ item: 'li.nope', link: 'a', title: 'a', text: 'p', limit: 5 }])
    ef.close()
    return nl
  })()
  ok(thin.emptyReason === 'not-loaded', '空结果 + 正文极短 ⇒ not-loaded（还没加载完，值得再等一次）', thin.emptyReason)
  af.close()
  const bf = await openFixture(blockedFile)
  const bl = await bf.inject(FNS.SEARCH_FN, [{ item: 'li.nope', link: 'a', title: 'a', text: 'p', limit: 5 }])
  ok(bl.emptyReason === 'blocked' && bl.blocked === true, '空结果 + 反爬措辞 ⇒ blocked', JSON.stringify({ r: bl.emptyReason, b: bl.blocked }))
  ok(typeof bl.sample === 'string' && bl.sample.length > 0, 'blocked 时回传页面样本文本便于诊断')
  bf.close()
  f.close()
}

// ---------------------------------------------------------------- 4) CHALLENGE_FN
console.log('\n[4] CHALLENGE_FN —— 人机验证识别')
{
  const a = await openFixture(articleFile)
  const none = await a.inject(FNS.CHALLENGE_FN, [])
  ok(none.challenge === null, '正常文章页不误报 challenge')
  a.close()

  const cf = await openFixture(cfFile)
  const c = await cf.inject(FNS.CHALLENGE_FN, [])
  ok(c.challenge && c.challenge.kind === 'cloudflare', 'Cloudflare 拦页识别为 cloudflare', JSON.stringify(c.challenge))
  ok(c.challenge && /停下/.test(c.challenge.hint || ''), 'hint 明确要求停下问人（不要反复重试）')
  ok(c.challenge && /最佳努力/.test(c.challenge.bestEffort || ''), '标注了"最佳努力"的误报边界')
  cf.close()

  const rc = await openFixture(recaptchaFile)
  const r = await rc.inject(FNS.CHALLENGE_FN, [])
  ok(r.challenge && r.challenge.kind === 'recaptcha', 'iframe src 命中 reCAPTCHA', JSON.stringify(r.challenge))
  rc.close()

  const bl = await openFixture(blockedFile)
  const b = await bl.inject(FNS.CHALLENGE_FN, [])
  ok(b.challenge && b.challenge.kind === 'generic', '只有措辞时走 generic 双条件兜底', JSON.stringify(b.challenge))
  bl.close()
}

// ---------------------------------------------------------------- 5) SNAPSHOT_FN
console.log('\n[5] SNAPSHOT_FN —— 稳定 ref / 状态标记 / 交互恢复')
{
  const f = await openFixture(overlayFile)
  const s1 = await f.inject(FNS.SNAPSHOT_FN, [])
  ok(s1 && Array.isArray(s1.elements) && s1.elements.length > 0, '快照有元素清单', s1 && s1.elements.length)
  const byId = (list, id) => list.find((e) => (e.text || '').includes(id))
  const modal = byId(s1.elements, '弹层里的按钮')
  const dis = byId(s1.elements, '禁用按钮')
  const hidden = byId(s1.elements, '隐藏按钮')
  const reactish = byId(s1.elements, 'React 风格的按钮')
  ok(!!modal, '弹层里的按钮被收录')
  ok(!hidden, 'display:none 的按钮不进快照（它不可见）')
  ok(!!dis && dis.flags.includes('disabled'), 'disabled 状态内联进元素行', JSON.stringify(dis && dis.flags))
  ok(!!reactish, '交互恢复：cursor:pointer 的裸 div（无 onclick 属性）也被收录成可点元素', JSON.stringify(reactish))

  // ref 稳定性：同一元素在两次快照里必须是同一个编号
  const s2 = await f.inject(FNS.SNAPSHOT_FN, [])
  const modal2 = byId(s2.elements, '弹层里的按钮')
  ok(modal && modal2 && modal.ref === modal2.ref, '两次快照之间 ref 稳定（不会张冠李戴）', JSON.stringify([modal && modal.ref, modal2 && modal2.ref]))
  ok(s2.refsInfo && s2.refsInfo.reused > 0, 'refsInfo 报告复用了多少旧编号', JSON.stringify(s2.refsInfo))

  // 重名消歧
  const edits = s2.elements.filter((e) => e.text === '编辑')
  ok(edits.length === 3, '三个重名"编辑"都被收录', edits.length)
  ok(edits.some((e) => e.ctx), '重名元素补了 ctx 上下文以消歧', JSON.stringify(edits.map((e) => e.ctx)))

  // 密码值不进快照
  ok(!JSON.stringify(s2.elements).includes('secret123'), 'password 的值没有进快照（防外泄）')

  // ref 有效性边界：
  //   · 在浮层**之上**的按钮（弹层 z-index 高于遮罩）必须仍判为可点 —— 遮挡检查不能误杀；
  //   · 被遮罩压在下面的按钮必须判为 covered。
  const onTop = await f.inject(FNS.ACTIONABLE_FN, ['ref', modal.ref, {}])
  ok(onTop && onTop.ok === true, '浮层之上的按钮仍判为可点（不误杀）', JSON.stringify(onTop).slice(0, 200))
  const under = await f.inject(FNS.ACTIONABLE_FN, ['ref', reactish.ref, {}])
  ok(under && under.ok === false && under.reason === 'covered', '被遮罩压住的按钮判为 covered', JSON.stringify(under).slice(0, 200))

  const gone = await f.inject(FNS.ACTIONABLE_FN, ['ref', '999999', {}])
  ok(gone && gone.ok === false && /不存在|失效/.test(gone.error || ''), '未知 ref 明确报"不存在/失效"，绝不猜', JSON.stringify(gone).slice(0, 160))
  f.close()
}

// ---------------------------------------------------------------- 6) ACTIONABLE_FN
console.log('\n[6] ACTIONABLE_FN —— 可操作性检查')
{
  const f = await openFixture(overlayFile)
  await f.evalJs('document.getElementById("cover").remove(); document.getElementById("modal").remove();')
  await f.inject(FNS.SNAPSHOT_FN, [])
  const els = (await f.inject(FNS.SNAPSHOT_FN, [])).elements
  const pick = (t) => els.find((e) => (e.text || '').includes(t))

  const reactish = pick('React 风格的按钮')
  const a1 = await f.inject(FNS.ACTIONABLE_FN, ['ref', reactish.ref, { needEnabled: true }])
  ok(a1.ok === true && Number.isFinite(a1.x) && Number.isFinite(a1.y), '正常可点元素返回命中点', JSON.stringify(a1))

  const dis = pick('禁用按钮')
  const a2 = await f.inject(FNS.ACTIONABLE_FN, ['ref', dis.ref, { needEnabled: true }])
  ok(a2.ok === false && a2.reason === 'disabled', 'disabled 元素被拒（reason=disabled）', JSON.stringify(a2))
  const a2b = await f.inject(FNS.ACTIONABLE_FN, ['ref', dis.ref, { needEnabled: false }])
  ok(a2b.ok === true, 'needEnabled:false 时允许对 disabled 元素做悬停类动作')

  // pointer-events:none —— 这类元素通常不满足"可交互选择器"，agent 是按 selector 指过去的
  const a3 = await f.inject(FNS.ACTIONABLE_FN, ['selector', '#pe', {}])
  ok(a3.ok === false && a3.reason === 'pointer-events-none', 'pointer-events:none 被拒（reason=pointer-events-none）', JSON.stringify(a3))

  // 遮挡：重新放回 cover，盖住 React 按钮的位置
  await f.evalJs('(function(){var d=document.createElement("div");d.id="cover2";d.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99";document.body.appendChild(d)})()')
  const a4 = await f.inject(FNS.ACTIONABLE_FN, ['ref', reactish.ref, {}])
  ok(a4.ok === false && a4.reason === 'covered' && /盖住/.test(a4.error || ''), '被浮层盖住 ⇒ reason=covered 并说明被谁盖住', JSON.stringify(a4))
  const s3 = await f.inject(FNS.SNAPSHOT_FN, [])
  const after = s3.elements.find((e) => e.ref === reactish.ref)
  ok(after && after.flags.some((x) => /covered-by/.test(x)), '快照里也标了 covered-by（不用点一次才知道）', JSON.stringify(after && after.flags))

  // selector 路径 + 未命中
  const a5 = await f.inject(FNS.ACTIONABLE_FN, ['selector', '#reactish', {}])
  ok(a5.ok === false && a5.reason === 'covered', 'selector 路径同样会做遮挡检查')
  const a6 = await f.inject(FNS.ACTIONABLE_FN, ['selector', '#nope', {}])
  ok(a6.ok === false && /命中/.test(a6.error || ''), 'selector 未命中明确报错', JSON.stringify(a6).slice(0, 120))
  const a7 = await f.inject(FNS.ACTIONABLE_FN, ['selector', '###bad', {}])
  ok(a7.ok === false && /无效/.test(a7.error || ''), '非法选择器不抛异常、明确报错')
  f.close()
}

// ---------------------------------------------------------------- 7) READBACK_FN
console.log('\n[7] READBACK_FN —— 输入回读（含密码保护）')
{
  const f = await openFixture(overlayFile)
  await f.evalJs('document.getElementById("cover").remove(); document.getElementById("modal").remove();')
  await f.inject(FNS.SNAPSHOT_FN, [])
  const els = (await f.inject(FNS.SNAPSHOT_FN, [])).elements
  const txt = els.find((e) => e.tag === 'input' && e.role === 'input')
  const rb1 = await f.inject(FNS.READBACK_FN, ['selector', '#txt', 'hello'])
  ok(rb1.ok !== false && rb1.empty === true && rb1.matchesInput === false, '空字段回读：empty=true、与期望不匹配', JSON.stringify(rb1))
  await f.evalJs('document.getElementById("txt").value="hello"')
  const rb2 = await f.inject(FNS.READBACK_FN, ['selector', '#txt', 'hello'])
  ok(rb2.matchesInput === true && rb2.value === 'hello', '输入后回读匹配成功')
  const rb3 = await f.inject(FNS.READBACK_FN, ['selector', '#pw', 'secret123'])
  ok(rb3.matchesInput === true, '密码字段能确认"输入进去了"')
  ok(!("secret123" === (rb3.value || '')) && /位/.test(rb3.value || ''), '密码字段只回长度不回显（value=' + rb3.value + '）')
  ok(txt !== undefined, '快照里能找到普通输入框')
  f.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
