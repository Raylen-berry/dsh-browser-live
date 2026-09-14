// 页面内注入函数集 —— 在浏览器上下文里跑（host 侧用 fn.toString() 注入）。
//
// 为什么单独一个文件、为什么是"普通函数 + toString()"而不是模板字面量字符串：
//   1. 普通 JS 能被 `node --check` 语法校验，也能被单测直接 import（不必起浏览器）；
//   2. 免得在一层模板字面量里对几十个引号/正则做二次转义（index.js 里 SNAPSHOT_FN 那种写法
//      写长了极易出一个反斜杠的错，而且报错点还很远）。
//   3. 注入方式不变：callOnPage(tab, FN, [args]) → Runtime.evaluate('(函数源)(参数)')。
//
// 本文件里的三组函数：
//   readPageInPage    正文/元信息结构化读取（含段落感知截断、链接清单、JSON-LD 兜底）
//   scrapePageInPage  列表/表格的结构化抓取（item + fields 映射）
//   searchPageInPage  从当前 SERP 页面抽结果（含跳转链解包与"被拦"判定）
//
// 算法来源（均为 MIT，已按浏览器 DOM 重写，不是逐行搬运）：
//   · 正文选择降级顺序 + 链接密度阈值 + 段落感知截断 + 噪音黑名单 → 2672243194/dsh-read-url
//   · 结构化抓取的 `字段 -> 选择器@属性` 约定 → wqty123/dsh-browser（dsh-builtin-browser）
//   · 搜索结果抽取的字段约定与"三层空结果判定" → liustack/modsearch、DDWDUC/dsh-free-search、
//     anweat/dsh-web-search-pro
//   编码嗅探那套（GBK/Big5/BOM）**故意没抄**：浏览器 JS 看到的 DOM 早已被解码，那是死代码。

// ---------------------------------------------------------------------------
// 正文读取：默认给 Markdown（比 innerText 保留标题/列表/表格/链接结构），也可只给纯文本。
// 入口函数必须自包含（会被 toString() 后单独注入），所以辅助函数都写在里面。
// ---------------------------------------------------------------------------
export function readPageInPage(args) {
  args = args || {}

  // ---- 常量：噪音标签与类名黑名单 ----
  var NOISE_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1, DIALOG: 1, FORM: 1, NAV: 1, FOOTER: 1, HEADER: 1, ASIDE: 1 }
  var CONTAINER_TAGS = { DIV: 1, SECTION: 1, ARTICLE: 1, UL: 1, OL: 1, LI: 1, P: 1 }
  // 只在**容器标签**上判类名：正文里的 <code class="language-share"> 之类不能被误杀。
  var NOISE_CLASS_RE = /(?:^|[\s_-])(?:ads?|adsbygoogle|advert(?:isement|ising)?|banner|sidebar|social|share|sharing|comments?|comment-|popup|modal|cookie|consent|gdpr|recommend|related|newsletter|subscribe|breadcrumb|pagination|toolbar|menu|nav)(?=$|[\s_-])/i
  var CONSENT_ID_RE = /(?:onetrust|cookiebot|cybot|gdpr|consent|cookie-law|cookie_banner|cmp-)/i
  var ZERO_WIDTH_RE = /[\u200b\u200c\u200d\ufeff]/g
  var MD_TABLE_MAX_ROWS = 25
  var MD_MAX_DEPTH = 60
  // 图片 URL 超过这个长度就不再铺进正文（改只留 alt）：实测 GitHub README 的徽章行是
  // `[![alt](camo.githubusercontent.com/<64位hex>/<编码后的原图>)](链接)`，一整行几百字符、
  // 对"读内容"毫无价值却会把正文淹掉。要图片地址请用 browser_eval / browser_scrape。
  var MD_IMG_URL_MAX = 120
  // 被省略的图片统计（跟着结果一起交回，别静默丢东西）
  var imgStat = { longUrl: 0, noAlt: 0 }

  // ---- 基础工具 ----
  function txt(el) { return (el && (el.innerText || el.textContent) || '') }
  function trimmed(s) { return String(s || '').replace(/\s+/g, ' ').trim() }

  // display:none / 不可见：用 getClientRects 判断（比 getComputedStyle 便宜一个数量级，
  // 大页面上逐个元素调 getComputedStyle 会明显卡）。
  function hidden(el) {
    if (!el || el.nodeType !== 1) return false
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
    var st = el.getAttribute('style')
    if (st && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st)) return true
    try { if (!el.getClientRects().length) return true } catch (e) { }
    return false
  }

  function noiseByAttr(el) {
    if (!el || el.nodeType !== 1) return false
    if (hidden(el)) return true
    var id = String(el.id || '')
    if (id && CONSENT_ID_RE.test(id)) return true
    if (CONTAINER_TAGS[el.tagName] && el.className && typeof el.className === 'string' && NOISE_CLASS_RE.test(el.className)) return true
    return false
  }

  // 链接密度：短块且大部分文字都在链接里 ⇒ 基本是导航/推荐位。
  function linkHeavy(el) {
    if (!el || el.nodeType !== 1) return false
    if (!(el.tagName === 'DIV' || el.tagName === 'SECTION' || el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'P')) return false
    var t = trimmed(txt(el))
    if (t.length === 0 || t.length >= 300) return false
    var a = el.querySelectorAll ? el.querySelectorAll('a') : []
    var lt = 0
    for (var i = 0; i < a.length; i++) lt += trimmed(txt(a[i])).length
    return lt > t.length * 0.65
  }

  // ---- Markdown 生成：递归走活 DOM（不是对 HTML 字符串跑正则） ----
  function escInline(s) { return String(s).replace(/([\\`*_\[\]])/g, '\\$1') }
  // 围栏长度：Markdown 要求至少 3 个反引号，且必须比内容里最长的反引号串再长 1，
  // 否则块里本来就有 ``` 时会被提前闭合（内容含 ``` 就得用 ```` 包）。
  function fenceFor(s) {
    var m = String(s).match(/`+/g)
    var n = 3
    if (m) for (var i = 0; i < m.length; i++) n = Math.max(n, m[i].length + 1)
    return new Array(n + 1).join('`')
  }
  // 链接里的 ( ) 空格必须百分号编码，否则 [t](a(b).html) 会把链接截断。
  function mdUrl(u) { return String(u).replace(/[()\s]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase() }) }
  function safeHref(a) {
    var h = ''
    try { h = a.href || '' } catch (e) { h = '' }
    if (!h) h = a.getAttribute('href') || ''
    if (/^(javascript|mailto|tel|data|blob):/i.test(h)) return ''
    if (h.charAt(0) === '#') return ''
    return h
  }

  function inlineMd(node, depth) {
    if (depth > MD_MAX_DEPTH) return ''
    if (node.nodeType === 3) return escInline(String(node.nodeValue || '').replace(/\s+/g, ' '))
    if (node.nodeType !== 1) return ''
    var tag = node.tagName
    if (NOISE_TAGS[tag] || noiseByAttr(node)) return ''
    if (tag === 'BR') return '  \n'
    if (tag === 'IMG') {
      var alt = trimmed(node.getAttribute('alt') || '')
      var src = node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src') || ''
      if (!src) return ''
      try { src = new URL(src, location.href).href } catch (e) { }
      // 无 alt 的图片对"读内容"没有信息量（原来直接返回空串，这里记一笔账）
      if (!alt) { imgStat.noAlt++; return '' }
      // 超长 URL 多半是徽章/统计图：只留 alt。留着 URL 的收益远小于它淹没正文的代价。
      if (src.length > MD_IMG_URL_MAX) { imgStat.longUrl++; return '![' + escInline(alt) + ']' }
      return '![' + escInline(alt) + '](' + mdUrl(src) + ')'
    }
    if (tag === 'A') {
      var inner = childInline(node, depth + 1)
      var href = safeHref(node)
      if (!href) return inner
      if (!trimmed(inner)) return ''
      return '[' + inner + '](' + mdUrl(href) + ')'
    }
    if (tag === 'CODE') {
      var ct = String(node.textContent || '')
      if (!ct) return ''
      var f = fenceFor(ct)
      return f + ct + f
    }
    if (tag === 'STRONG' || tag === 'B') { var s1 = childInline(node, depth + 1); return s1 ? '**' + s1 + '**' : '' }
    if (tag === 'EM' || tag === 'I') { var s2 = childInline(node, depth + 1); return s2 ? '*' + s2 + '*' : '' }
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') { var s3 = childInline(node, depth + 1); return s3 ? '~~' + s3 + '~~' : '' }
    if (tag === 'MARK') { var s4 = childInline(node, depth + 1); return s4 ? '==' + s4 + '==' : '' }
    if (tag === 'SUP' || tag === 'SUB') return childInline(node, depth + 1)
    // 块级元素混在行内位置：退化成块（交给 blockMd 处理其内容）
    if (BLOCK_TAGS[tag]) return childInline(node, depth + 1)
    return childInline(node, depth + 1)
  }
  function childInline(el, depth) {
    var out = ''
    for (var n = el.firstChild; n; n = n.nextSibling) out += inlineMd(n, depth)
    return out
  }

  var BLOCK_TAGS = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, NAV: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1, HR: 1, FIGURE: 1, FIGCAPTION: 1, DL: 1, DT: 1, DD: 1, ADDRESS: 1, DETAILS: 1, SUMMARY: 1,
  }

  function tableMd(el, depth) {
    var rows = el.querySelectorAll('tr')
    if (!rows.length) return ''
    var out = [], kept = 0, total = rows.length
    for (var i = 0; i < total; i++) {
      if (kept >= MD_TABLE_MAX_ROWS) break
      var cells = rows[i].querySelectorAll('th,td')
      if (!cells.length) continue
      var line = '|'
      for (var c = 0; c < cells.length; c++) {
        var v = trimmed(childInline(cells[c], depth + 1)) || trimmed(txt(cells[c]))
        line += ' ' + v.replace(/\|/g, '\\|').replace(/\n+/g, '<br>') + ' |'
      }
      out.push(line)
      kept++
      if (kept === 1) {
        var sep = '|'
        for (var c2 = 0; c2 < cells.length; c2++) sep += ' --- |'
        out.push(sep)
      }
    }
    if (total > kept) out.push('\n…（表格还有 ' + (total - kept) + ' 行未展开）')
    return out.join('\n') + '\n\n'
  }

  function listMd(el, depth, ordered, startNo) {
    var out = ''
    var idx = ordered ? (startNo || 1) : 0
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1 || n.tagName !== 'LI') continue
      var marker = ordered ? (idx++) + '. ' : '- '
      var body = childBlock(n, depth + 1, true).replace(/^\n+|\n+$/g, '').replace(/\n/g, '\n  ')
      out += marker + body + '\n'
    }
    return out + (out ? '\n' : '')
  }

  function blockMd(node, depth) {
    if (depth > MD_MAX_DEPTH) return ''
    if (node.nodeType === 3) {
      var t = String(node.nodeValue || '').replace(ZERO_WIDTH_RE, '').replace(/\s+/g, ' ')
      return t.trim() ? t : ''
    }
    if (node.nodeType !== 1) return ''
    var tag = node.tagName
    if (NOISE_TAGS[tag] === 1) {
      // 例外：文章自己的 <header>（里面通常就是 h1 标题）要保留，
      // 站点页头（只有 logo/菜单/搜索框）丢掉 —— 一刀切会把文章标题也切掉。
      var keepHeader = tag === 'HEADER' && node.querySelector && node.querySelector('h1,h2,h3')
      if (!keepHeader) return ''
    }
    if (noiseByAttr(node)) return ''
    if (linkHeavy(node)) return ''
    if (tag === 'HR') return '\n---\n\n'
    if (tag === 'BR') return '  \n'
    if (/^H[1-6]$/.test(tag)) {
      var lvl = Number(tag.charAt(1))
      var ht = trimmed(childInline(node, depth + 1))
      // 与 dsh-read-url 一致：剥掉文档站常见的标题尾锚点（¶ / §）
      ht = ht.replace(/\s*[¶§#]+\s*$/, '')
      return ht ? new Array(lvl + 1).join('#') + ' ' + ht + '\n\n' : ''
    }
    if (tag === 'PRE') {
      var codeEl = node.querySelector('code') || node
      var raw = String(codeEl.textContent || '')
      if (!raw.trim()) return ''
      var lang = ''
      var cls = String(codeEl.className || '') + ' ' + String(node.className || '')
      var lm = cls.match(/(?:language|lang)-([a-z0-9+#]+)/i)
      if (lm) lang = lm[1]
      var f = fenceFor(raw)
      return f + lang + '\n' + raw.replace(/\s+$/, '') + '\n' + f + '\n\n'
    }
    if (tag === 'BLOCKQUOTE') {
      var bq = childBlock(node, depth + 1, false).replace(/^\n+|\n+$/g, '')
      if (!bq) return ''
      return bq.split('\n').map(function (l) { return '> ' + l }).join('\n') + '\n\n'
    }
    if (tag === 'UL' || tag === 'OL') return listMd(node, depth, tag === 'OL', Number(node.getAttribute('start')) || 1)
    if (tag === 'TABLE') return tableMd(node, depth)
    if (tag === 'FIGURE') {
      var fig = childBlock(node, depth + 1, false)
      return fig ? fig + '\n' : ''
    }
    if (tag === 'P') {
      var pt = trimmed(childInline(node, depth + 1))
      return pt ? pt + '\n\n' : ''
    }
    if (tag === 'DL') {
      var dl = ''
      for (var d = node.firstChild; d; d = d.nextSibling) {
        if (d.nodeType !== 1) continue
        if (d.tagName === 'DT') dl += '**' + trimmed(childInline(d, depth + 1)) + '**\n'
        else if (d.tagName === 'DD') dl += ': ' + trimmed(childInline(d, depth + 1)) + '\n'
      }
      return dl ? dl + '\n' : ''
    }
    // 其它容器：递归子块
    return childBlock(node, depth, BLOCK_TAGS[tag] === 1)
  }

  function childBlock(el, depth, wantBreak) {
    var out = ''
    for (var n = el.firstChild; n; n = n.nextSibling) {
      var piece = blockMd(n, depth)
      if (!piece) continue
      out += piece
    }
    // 行内混排（例如 <div>文字<a>链接</a>文字</div>，子节点全是文本/行内）：
    // 上面的 blockMd 对文本节点已返回原文，这里只需收敛空白与换行。
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
    return out
  }

  function articleText(el) { return trimmed(txt(el)) }

  // ---- 正文根：四级降级（多 article 全收 / role=main / main / body+密度过滤） ----
  function pickRoots() {
    var sel = args.selector
    if (sel) {
      var one = null
      try { one = document.querySelector(sel) } catch (e) { one = null }
      if (!one) return { error: 'selector 未命中: ' + sel }
      return { roots: [one], source: 'selector' }
    }
    var arts = []
    var all = document.querySelectorAll('article')
    for (var i = 0; i < all.length; i++) if (!hidden(all[i])) arts.push(all[i])
    var artOk = arts.filter(function (a) { return articleText(a).length >= 200 })
    if (artOk.length === 1) return { roots: artOk, source: 'article' }
    if (artOk.length > 1) return { roots: artOk, source: 'article×' + artOk.length }
    var rm = document.querySelector('[role="main"]')
    if (rm && articleText(rm).length >= 200) return { roots: [rm], source: 'role=main' }
    var mn = document.querySelector('main')
    if (mn && articleText(mn).length >= 200) return { roots: [mn], source: 'main' }
    // 都不可靠时：取"文本最多的那个直接子块"，而不是整个 body（body 会拖进导航与页脚）
    var best = null, bestLen = 0
    var kids = document.body ? document.body.children : []
    for (var k = 0; k < kids.length; k++) {
      var e = kids[k]
      if (hidden(e) || NOISE_TAGS[e.tagName] || linkHeavy(e)) continue
      var len = articleText(e).length
      if (len > bestLen) { bestLen = len; best = e }
    }
    if (best && bestLen >= 300) return { roots: [best], source: 'body-max' }
    return { roots: document.body ? [document.body] : [], source: 'body' }
  }

  // ---- 元信息：meta / og / JSON-LD ----
  function metaAll() {
    var out = {}
    var ms = document.querySelectorAll('meta')
    for (var i = 0; i < ms.length; i++) {
      var k = ms[i].getAttribute('property') || ms[i].getAttribute('name') || ''
      var v = ms[i].getAttribute('content') || ''
      k = k.toLowerCase()
      if (!v) continue
      if (k === 'description' && !out.description) out.description = trimmed(v)
      else if (k === 'og:description' && !out.ogDescription) out.ogDescription = trimmed(v)
      else if (k === 'og:title' && !out.ogTitle) out.ogTitle = trimmed(v)
      else if (k === 'og:site_name' && !out.siteName) out.siteName = trimmed(v)
      else if (k === 'og:type' && !out.type) out.type = trimmed(v)
      else if ((k === 'author' || k === 'article:author' || k === 'og:article:author') && !out.author) out.author = trimmed(v)
      else if ((k === 'article:published_time' || k === 'date' || k === 'pubdate') && !out.published) out.published = trimmed(v)
    }
    return out
  }
  // JSON-LD 递归收集（@graph / 数组 / author 三种形状都得认），articleBody 常能捞到被
  // 前端渲染藏起来的正文（反爬兜底）。
  function jsonLd() {
    var out = { jsonLd: null, articleBody: '', author: '', published: '' }
    var scripts = document.querySelectorAll('script[type="application/ld+json"]')
    var walk = function (node) {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return }
      var t = node['@type']
      var types = Array.isArray(t) ? t.map(String) : (t ? [String(t)] : [])
      var isArticle = types.some(function (x) { return /Article|NewsArticle|BlogPosting|Posting|Report/i.test(x) })
      if (isArticle && !out.jsonLd) out.jsonLd = trimmed(node.headline || node.name || '')
      if (isArticle && !out.articleBody && node.articleBody) out.articleBody = String(node.articleBody)
      if (isArticle && !out.published && node.datePublished) out.published = String(node.datePublished)
      if (isArticle && !out.author) {
        var a = node.author
        if (typeof a === 'string') out.author = a
        else if (Array.isArray(a) && a[0]) out.author = (a[0].name || a[0]) + ''
        else if (a && a.name) out.author = a.name + ''
      }
      if (node['@graph']) walk(node['@graph'])
      for (var k in node) if (k !== '@graph' && node[k] && typeof node[k] === 'object') walk(node[k])
    }
    for (var i = 0; i < scripts.length; i++) {
      try { walk(JSON.parse(scripts[i].textContent || '')) } catch (e) { }
    }
    return out
  }

  // ---- 链接清单 ----
  function links(root, limit) {
    var out = [], seen = {}, scan = root.querySelectorAll ? root.querySelectorAll('a[href]') : []
    var cap = Math.min(scan.length, Math.max(limit * 4, 40))
    for (var i = 0; i < cap && out.length < limit; i++) {
      var a = scan[i]
      if (hidden(a)) continue
      var href = safeHref(a)
      if (!href) continue
      var abs = href
      try { abs = new URL(href, location.href).href } catch (e) { }
      if (!/^https?:/i.test(abs)) continue      // URL 构造能放过 ftp:，这里再筛一次
      if (seen[abs]) continue
      var t = trimmed(txt(a)).slice(0, 120)
      if (!t) t = abs
      seen[abs] = 1
      out.push({ t: t, u: abs })
    }
    return out
  }
  function headings(root) {
    var out = []
    var hs = root.querySelectorAll ? root.querySelectorAll('h1,h2,h3,h4') : []
    for (var i = 0; i < hs.length && out.length < 60; i++) {
      if (hidden(hs[i])) continue
      var t = trimmed(txt(hs[i]))
      if (t) out.push({ level: Number(hs[i].tagName.charAt(1)), text: t.slice(0, 160) })
    }
    return out
  }

  // ---- 段落感知截断：绝不把段落/句子拦腰切断 ----
  function smartCut(text, off, lim) {
    var total = text.length
    var start = Math.max(0, Math.min(off || 0, total))
    // 起点落在段落分隔符中间就滑到分隔符之后
    while (start < total && (text.charAt(start) === '\n')) start++
    var hard = Math.min(total, start + lim)
    var end = hard
    if (hard < total) {
      var win = text.slice(start, hard)
      var p = win.lastIndexOf('\n\n')
      if (p > win.length * 0.5) end = start + p + 1
      else {
        var m = win.match(/[.!?。！？\n][^.!?。！？\n]{0,40}$/)
        if (m && m.index > win.length * 0.5) end = start + m.index + 1
        else {
          // 硬切：别把代理对（emoji）劈成两半
          var lo = text.charCodeAt(end - 1), hi = text.charCodeAt(end)
          if (lo >= 0xD800 && lo <= 0xDBFF && hi >= 0xDC00 && hi <= 0xDFFF) end--
        }
      }
    }
    return { text: text.slice(start, end), start: start, end: end, total: total, truncated: end < total }
  }

  // ---- 组装 ----
  try {
    var pick = pickRoots()
    if (pick.error) return { ok: false, error: pick.error }
    var roots = pick.roots || []
    var format = String(args.format || 'md').toLowerCase()
    var body = ''
    for (var r = 0; r < roots.length; r++) {
      var piece = format === 'text'
        ? (roots[r].innerText || roots[r].textContent || '')
        : childBlock(roots[r], 0, true)
      piece = String(piece).replace(ZERO_WIDTH_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '')
      if (!piece) continue
      body += (body ? '\n\n' : '') + piece
    }
    var jl = jsonLd()
    var meta = metaAll()
    var fallbackUsed = false
    if (body.trim().length < 200 && jl.articleBody && jl.articleBody.trim().length > body.trim().length) {
      body = jl.articleBody
      fallbackUsed = true
    }
    var lim = Math.max(200, Math.min(Number(args.limit) || 8000, 40000))
    var cut = smartCut(body, Number(args.offset) || 0, lim)
    var res = {
      ok: true,
      url: location.href,
      title: document.title || meta.ogTitle || jl.jsonLd || '',
      lang: document.documentElement ? (document.documentElement.getAttribute('lang') || '') : '',
      charset: document.characterSet || '',
      source: pick.source + (fallbackUsed ? '+jsonld' : ''),
      meta: {
        description: meta.description || meta.ogDescription || '',
        siteName: meta.siteName || '',
        author: meta.author || jl.author || '',
        published: meta.published || jl.published || '',
        type: meta.type || '',
      },
      textLength: cut.total,
      offset: Number(args.offset) || 0,
      charsStart: cut.start,
      truncated: cut.truncated,
      text: cut.text,
    }
    if (args.links !== false) res.links = links(roots[0] || document.body, Math.max(1, Math.min(Number(args.linkLimit) || 30, 100)))
    if (args.headings) res.headings = headings(roots[0] || document.body)
    // 图片只留 alt 时记账：别让人以为"页面没有图"，也别让人找不到图片地址（用 browser_eval/scrape 取）
    if (imgStat.longUrl || imgStat.noAlt) {
      var bits = []
      if (imgStat.longUrl) bits.push(imgStat.longUrl + ' 张 URL 过长（只留了 alt）')
      if (imgStat.noAlt) bits.push(imgStat.noAlt + ' 张没有 alt')
      res.imagesOmitted = imgStat
      res.imagesNote = '图片处理：' + bits.join('、') + '。要图片地址请用 browser_eval / browser_scrape。'
    }
    return res
  } catch (e) {
    return { ok: false, error: 'readPage 失败: ' + String((e && e.message) || e) }
  }
}

export const READ_FN = readPageInPage.toString()

// ---------------------------------------------------------------------------
// 结构化抓取：`item` 选中重复节点，`fields` 给"字段 → 选择器[@属性]"映射。
// 约定（借 wqty123/dsh-browser 的 browser_scrape）：选择器为 "" 或 "@text" = 节点自身文本；
// "a@href" = 取属性并转绝对 URL；"@html" = innerHTML。适合列表/表格/搜索结果这类重复结构。
// ---------------------------------------------------------------------------
export function scrapePageInPage(args) {
  args = args || {}
  var item = String(args.item || '')
  var fields = args.fields || {}
  var limit = Math.max(1, Math.min(Number(args.limit) || 50, 300))
  var CELL_MAX = 400
  function trimmed(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim() }

  var nodes
  try { nodes = item ? document.querySelectorAll(item) : [] } catch (e) { return { ok: false, error: 'item 选择器无效: ' + item } }
  if (!nodes.length) {
    // 自愈：把最后一段选择器当类名/标签再试一次（页面结构与 agent 的猜测常有细微差异）
    var tail = item.split(/[\s>]+/).pop() || ''
    var m = tail.match(/^[a-z]+/i)
    if (m) {
      try { nodes = document.querySelectorAll(m[0]) } catch (e) { }
    }
    if (!nodes.length) return { ok: false, error: 'item 未命中任何节点: ' + item, hint: '用 browser_snapshot / browser_eval 先确认选择器' }
  }

  function valueOf(scope, spec) {
    spec = String(spec == null ? '@text' : spec)
    var sel = spec, attr = ''
    var at = spec.lastIndexOf('@')
    if (at >= 0) { sel = spec.slice(0, at).trim(); attr = spec.slice(at + 1).trim().toLowerCase() }
    var el = scope
    if (sel && sel !== 'text') {
      try { el = scope.querySelector(sel) } catch (e) { el = null }
    }
    if (!el) return ''
    if (attr === 'html') return String(el.innerHTML || '').slice(0, CELL_MAX)
    if (attr && attr !== 'text') {
      var raw = el.getAttribute ? el.getAttribute(attr) : null
      if (raw == null && attr === 'href' && el.href) raw = el.href
      if (raw == null && attr === 'src' && el.src) raw = el.src
      if (raw == null) return ''
      if ((attr === 'href' || attr === 'src') && String(raw)) {
        try { return new URL(String(raw), location.href).href } catch (e) { return String(raw) }
      }
      return trimmed(raw).slice(0, CELL_MAX)
    }
    return trimmed(el.innerText || el.textContent || '').slice(0, CELL_MAX)
  }

  var keys = Object.keys(fields)
  if (!keys.length) return { ok: false, error: 'fields 为空：至少要给一个「字段名: 选择器」' }
  var rows = []
  for (var i = 0; i < nodes.length && rows.length < limit; i++) {
    var row = {}
    for (var k = 0; k < keys.length; k++) row[keys[k]] = valueOf(nodes[i], fields[keys[k]])
    rows.push(row)
  }
  return { ok: true, url: location.href, title: document.title, matched: nodes.length, returned: rows.length, truncated: nodes.length > rows.length, rows: rows }
}

export const SCRAPE_FN = scrapePageInPage.toString()

// ---------------------------------------------------------------------------
// SERP 结果抽取：host 侧负责导航到引擎 URL，这里负责把结果页读成结构化条目。
// 三件事必须做对，否则会得到"看起来成功但全是垃圾"的结果：
//   1. 跳转链解包 —— DDG/Bing 的结果 href 常是 /l/?uddg=<编码后的真 URL> 或 ?url=，
//      不解包就等于把搜索跳转页当成结果 URL 交回去。
//   2. "被拦"判定 —— 命中 0 条时要能区分四种病因：{被反爬拦了 / 页面还没加载完 / 条目选择器不匹配 /
//      条目命中了但字段全没通过}。四者的处置完全不同（换引擎 / 等一下重试 / 改 item / 改 link·title·text），
//      一律报"没结果"或者一律报"引擎改版"都会把人带去错误的排查方向（百度那次就是被误诊成改版）。
//   3. 相对/协议相对 URL 绝对化 + 只要 http(s)。
// ---------------------------------------------------------------------------
export function searchPageInPage(spec) {
  spec = spec || {}
  var limit = Math.max(1, Math.min(Number(spec.limit) || 10, 50))
  function trimmed(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim() }

  /** 归一化主机名：剥 www、小写；既接受完整 URL 也接受裸主机名（spec.selfHost 可能是后者）。 */
  function normHost(v) {
    var s = String(v || '').trim()
    if (!s) return ''
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      try { return new URL(s).hostname.replace(/^www\./, '').toLowerCase() } catch (e) { return '' }
    }
    var h = s.replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase()
    return /^[a-z0-9.-]+$/.test(h) ? h : ''
  }

  // 跳转链解包：一层就够（实测 ddg/bing/baidu 都只包一层），但保留可读的原始 href。
  function unwrap(href) {
    if (!href) return ''
    var abs = href
    try { abs = new URL(href, location.href).href } catch (e) { return '' }
    try {
      var u = new URL(abs)
      // 只有"跳转型"参数才解包：直接拿任意 url= 参数会把正常带参页面也改掉
      if (/\/(l|url|redirect|link)\b|\/ck\/a|bing\.com\/ck/i.test(u.pathname + u.host) || /uddg=|%3A%2F%2F/i.test(abs)) {
        var raw = u.searchParams.get('uddg') || u.searchParams.get('url') || u.searchParams.get('u') || u.searchParams.get('target')
        if (raw) {
          var dec = decodeURIComponent(raw)
          if (/^https?:\/\//i.test(dec)) return dec
        }
      }
    } catch (e) { }
    return abs
  }

  function pick(scope, sel) {
    if (!sel) return null
    try { return scope.querySelector(sel) } catch (e) { return null }
  }

  var out = []
  var nodes = []
  try { nodes = spec.item ? document.querySelectorAll(spec.item) : [] } catch (e) { nodes = [] }
  for (var i = 0; i < nodes.length && out.length < limit; i++) {
    var box = nodes[i]
    var a = pick(box, spec.link) || box.querySelector('a[href]')
    if (!a) continue
    var url = unwrap(a.getAttribute('href') || a.href || '')
    if (!/^https?:/i.test(url)) continue
    // 引擎自家的内链（"图片"、"更多搜索结果"、"设置"、**相关搜索**）不是结果；
    // 但引擎的**跳转链**是结果，必须留（百度/搜狗的 link?url=<加密串> 就是这种）。
    //
    // v0.10.0 实测踩到过两次，都在这一小段上：
    //   ① 原来写 /\/url$|\/link$/（要求"以 /link 结尾"）—— 带查询参数匹配不上，百度 8 条结果被全杀；
    //   ② 判定"是不是引擎自家"用的是**写死的引擎域名清单** —— 搜狗不在清单里，于是它自己的
    //      "相关搜索"内链（sogou.com/web?query=…）被当成结果混进来了。
    // 所以改成**与引擎无关**的判据：拿链接域名跟"当前这个搜索页自己的域名"比（归一化掉 www），
    // 只有跳转链形态才放行。自定义引擎（engineSpec / settings.search.engines）也自动适用。
    var selfHost = normHost(spec.selfHost || location.hostname)
    var hu = normHost(url)
    var isOwnHost = !!selfHost && hu === selfHost
    var isKnownEngineHost = /(^|\.)(bing|baidu|duckduckgo|google|microsoft|msn)\./.test(hu + '.')
    var isRedirect = /[\/?](url|link|redirect)=|\/url$|\/link$|\/ck\/a|uddg=/.test(url)
    if ((isOwnHost || isKnownEngineHost) && !isRedirect) continue
    var tEl = pick(box, spec.title)
    var sEl = pick(box, spec.text)
    var title = trimmed((tEl && (tEl.innerText || tEl.textContent)) || a.innerText || a.getAttribute('aria-label') || '')
    var snippet = trimmed((sEl && (sEl.innerText || sEl.textContent)) || '')
    if (!title && !snippet) continue
    var row = { rank: out.length + 1, title: title.slice(0, 200), url: url, snippet: snippet.slice(0, 400) }
    // 解不开的跳转链（百度/搜狗的 link?url=<加密串>）要如实标注：
    // 否则 agent 会以为拿到的是最终 URL 而直接引用/展示。
    if ((isOwnHost || isKnownEngineHost) && isRedirect) row.viaEngineRedirect = true
    out.push(row)
  }

  var bodyText = document.body ? String(document.body.innerText || '') : ''
  var head = bodyText.slice(0, 6000)
  var blockedRe = /anomaly|captcha|unusual traffic|robot check|are you a robot|access denied|too many requests|安全验证|请完成验证|滑动验证|访问过于频繁|请输入验证码|人机验证|网络不给力/i
  var isEmpty = out.length === 0
  var blocked = isEmpty && blockedRe.test(head)
  var thin = bodyText.replace(/\s+/g, '').length < 300
  // 四态空结果（host 靠这个决定"该改什么"，别让四种病因说成同一句话）：
  //   blocked       被反爬拦了      → 换引擎 / 等冷却
  //   not-loaded    页面还没加载    → 重试或检查网络
  //   layout-changed 条目选择器没命中（hits=0，页面有内容）→ 改 item
  //   filtered-out  **条目命中了但一条都没通过校验**（hits>0）→ 改 link/title/text，或链接被内链守卫挡了
  // 第四种是实测逼出来的：百度那次就是 hits=8、out=0，原来被判成 layout-changed，
  // 于是人被告知"引擎改版了，去改选择器"——方向错一半。
  // 顺序要紧：**先看有没有命中条目**，再看页面是不是空的。
  // 命中了条目就说明页面已经加载了（哪怕正文短，比如一个极简的站内搜索页），
  // 这时"没加载完"的结论一定是错的 —— 问题只可能出在字段选择器上。
  var emptyReason = ''
  if (isEmpty) emptyReason = blocked ? 'blocked' : (nodes.length > 0 ? 'filtered-out' : (thin ? 'not-loaded' : 'layout-changed'))
  return {
    ok: out.length > 0,
    count: out.length,
    hits: nodes.length,                       // 候选条目命中数：区分"选择器不对"和"字段不对"
    items: out,
    blocked: blocked,
    emptyReason: emptyReason,
    title: document.title || '',
    url: location.href,
    sample: isEmpty ? head.slice(0, 800) : '',
  }
}

export const SEARCH_FN = searchPageInPage.toString()

// ---------------------------------------------------------------------------
// 人机验证 / 反爬拦截识别。
//
// 语义边界（照抄参考实现的诚实态度）：这是**基于特征的最佳努力**，返回 challenge=null
// 只代表"没发现已知特征"，不代表页面上一定没有验证。识别到了就**停下来问人**，
// 不自动解题、不绕过、不反复重试 —— 反复重试只会让站点把你的浏览器标记得更死。
//
// 判定顺序（先强特征，后文本兜底）：
//   Cloudflare 拦页 → hCaptcha → reCAPTCHA → Turnstile → 文本双条件兜底
// 文本采集必须包含**同源 iframe 与 shadow DOM**：验证控件经常整个装在 shadow root 里，
// 只看 document.body.innerText 会漏掉（跨源 iframe 读不到，静默跳过）。
// ---------------------------------------------------------------------------
export function challengeInPage() {
  function colText(root, depth) {
    var s = ''
    if (!root || depth > 6) return s
    try {
      var it = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (var i = 0; i < it.length && s.length < 2000; i++) {
        var el = it[i]
        if (el.shadowRoot) s += colText(el.shadowRoot, depth + 1)
        if (el.tagName === 'IFRAME') {
          try {
            var d = el.contentDocument          // 同源才有；跨源抛错，静默跳过
            if (d && d.body) s += ' ' + (d.body.innerText || '')
          } catch (e) { }
        }
      }
    } catch (e) { }
    return s
  }

  try {
    var parts = [document.title || '']
    if (document.body) parts.push(String(document.body.innerText || '').slice(0, 4000))
    parts.push(colText(document, 0))
    var lower = parts.join('\n').toLowerCase()

    var frames = ''
    try {
      var fs = document.querySelectorAll('iframe')
      for (var i = 0; i < fs.length; i++) frames += ' ' + (fs[i].src || '')
    } catch (e) { }
    var fl = frames.toLowerCase()

    var cfSel = '#challenge-running, #challenge-stage, #cf-chl-container, .cf-challenge, #cf-wrapper'
    var hasCf = /just a moment|checking your browser|attention required|cf_chl|verifying you are human/i.test(lower)
      || !!document.querySelector(cfSel)
    var hasHcaptcha = !!window.hcaptcha || !!document.querySelector('.h-captcha, [data-hcaptcha-widget-id]') || /hcaptcha\.com/i.test(fl)
    var hasRecaptcha = !!window.grecaptcha || !!document.querySelector('.g-recaptcha, [data-sitekey][class*="recaptcha"]') || /recaptcha\/(api|enterprise)|google\.com\/recaptcha/i.test(fl)
    var hasTurnstile = !!window.turnstile || /challenges\.cloudflare\.com/i.test(fl) || /turnstile|challenge-platform/i.test(lower)
    var verifyWords = /verify you are human|verify you are not a robot|are you a human|人机验证|安全验证|请完成验证|滑块验证|拖动滑块|请输入验证码/.test(lower)
    var challengeWords = /challenge|captcha|verification|security check|access denied|blocked|验证/.test(lower)

    var kind = '', reason = ''
    if (hasCf) { kind = 'cloudflare'; reason = 'Cloudflare 的 "Just a moment" 拦页' }
    else if (hasHcaptcha) { kind = 'hcaptcha'; reason = 'hCaptcha 人机验证' }
    else if (hasRecaptcha) { kind = 'recaptcha'; reason = 'Google reCAPTCHA 人机验证' }
    else if (hasTurnstile) { kind = 'turnstile'; reason = 'Cloudflare Turnstile 人机验证' }
    else if (verifyWords && challengeWords) { kind = 'generic'; reason = '页面出现人机验证/安全校验的措辞' }

    if (!kind) return { challenge: null }
    return {
      challenge: {
        kind: kind,
        reason: reason,
        hint: '停下重试：请在浏览器窗口里人工完成验证，然后重新 browser_snapshot 确认。不要反复自动重试（只会让站点标记更死）。',
        bestEffort: '这是基于特征的最佳努力判定；未报验证不代表一定没有验证。',
      },
    }
  } catch (e) {
    return { challenge: null, error: String((e && e.message) || e) }
  }
}

export const CHALLENGE_FN = challengeInPage.toString()

// ---------------------------------------------------------------------------
// 页面快照（观察）—— 编号交互元素 + 正文节选。
//
// 相对 index.js 里原来那版的三处关键改动（都是踩过/差点踩过的坑）：
//
// 1) **稳定编号**。原版每次快照把 window.__BL_REFS 清空重排，于是"上一次拿的 ref=7"
//    在页面重排后会**指向另一个元素**—— agent 会安静地点错东西。现在改成
//    「元素 → id」的 WeakMap + 只增不减的计数器：id 永不复用，元素还在就还是那个号，
//    元素没了就明确报"ref 失效"，绝不张冠李戴。已脱离文档的旧条目顺手清掉，防止对象表涨。
//
// 2) **交互恢复**。React/Vue 的 onClick 走事件委托，DOM 上**没有** onclick 属性，
//    只按 [onclick]/[role] 选择器收元素会漏掉一大片真按钮。补救：对"有短文本的叶子块"
//    做一次有上限的 cursor:pointer 探测（getComputedStyle 有成本，所以限量 400 个）。
//
// 3) **状态内联**。disabled/readonly/checked/pointer-events-none/在视口外/被遮挡 直接写在
//    元素行里，agent 一眼就知道哪个点不动 —— 比让它点一次失败再猜便宜得多。
//    另外重名元素补 [ctx: 上下文]，不然三个"编辑"按钮完全不可区分。
//
// 顺带修一个隐私问题：原版把 e.value 当元素名（输入框会显示当前值），
// **password 输入框的值绝不能进快照**（会随对话外泄），这里按 type 屏蔽。
// ---------------------------------------------------------------------------
export function snapshotInPage() {
  var MAX_EL = 140
  var MAX_TEXT = 2600
  var RECOVER_CAP = 400

  if (!window.__BL_REFS) window.__BL_REFS = {}
  if (!window.__BL_IDS) window.__BL_IDS = new WeakMap()
  if (!window.__BL_SEQ) window.__BL_SEQ = 0
  var refs = window.__BL_REFS, ids = window.__BL_IDS

  // 清掉已脱离文档的旧 ref
  for (var k in refs) { if (!refs[k] || !refs[k].isConnected) delete refs[k] }
  var before = Object.keys(refs).length

  function idOf(e) {
    var id = ids.get(e)
    if (!id) { id = String(++window.__BL_SEQ); ids.set(e, id); refs[id] = e }
    else refs[id] = e
    return id
  }

  function cs(e) { try { return window.getComputedStyle(e) } catch (err) { return null } }
  function vis(e) {
    var r = e.getBoundingClientRect()
    var s = cs(e)
    if (!s) return false
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.02
  }
  function trimmed(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim() }

  // 元素名：按可用性优先级取第一个非空；password 的值绝不取。
  function nameOf(e) {
    var tag = e.tagName
    var t = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || ''
    if (!t && e.getAttribute('aria-labelledby')) {
      var lb = document.getElementById(e.getAttribute('aria-labelledby'))
      if (lb) t = trimmed(lb.innerText || lb.textContent)
    }
    if (!t) {
      var own = trimmed(e.innerText || e.textContent)
      if (own) t = own
    }
    if (!t && tag === 'INPUT') {
      var type = String(e.getAttribute('type') || 'text').toLowerCase()
      if (type !== 'password' && e.value) t = trimmed(e.value)          // 密码值不进快照
      else if (type === 'password' && e.value) t = '•••（已填 ' + String(e.value).length + ' 位）'
    }
    if (!t && (tag === 'SELECT' || tag === 'BUTTON') && e.value) t = trimmed(e.value)
    return String(t || '').slice(0, 64)
  }

  function label(e) {
    var role = e.getAttribute('role') || ''
    var tag = e.tagName.toLowerCase()
    if (role) return role
    if (tag === 'input') {
      var ty = String(e.getAttribute('type') || 'text').toLowerCase()
      return ty === 'text' ? 'input' : ty
    }
    return tag
  }

  // 重名消歧：往上找一个能区分它的上下文（最近的标题/aria-label/表头）
  function ctxOf(e) {
    var p = e, depth = 0
    while (p && depth < 7) {
      p = p.parentElement
      depth++
      if (!p) break
      var own = p.getAttribute && (p.getAttribute('aria-label') || p.getAttribute('data-testid'))
      if (own) return trimmed(own).slice(0, 40)
      var h = p.querySelector ? p.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],caption,legend,th') : null
      if (h && h !== e) {
        var ht = trimmed(h.innerText || h.textContent || h.getAttribute('aria-label') || '')
        if (ht) return ht.slice(0, 40)
      }
    }
    return ''
  }

  function flagsOf(e, r) {
    var f = [], s = cs(e)
    if (e.disabled === true || e.getAttribute('aria-disabled') === 'true') f.push('disabled')
    if (e.readOnly === true) f.push('readonly')
    if (e.checked === true) f.push('checked')
    if (s && s.pointerEvents === 'none') f.push('pointer-events-none')
    var vw = window.innerWidth, vh = window.innerHeight
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { f.push('outside'); return f }
    if (cx >= 0 && cy >= 0 && cx <= vw && cy <= vh && document.elementFromPoint) {
      var top = document.elementFromPoint(cx, cy)
      if (!top) f.push('covered')
      else if (top !== e && !e.contains(top) && !top.contains(e)) {
        var tn = top.tagName.toLowerCase()
        var cls = (top.className && typeof top.className === 'string') ? '.' + String(top.className).trim().split(/\s+/)[0] : ''
        f.push('covered-by:' + (tn + cls).slice(0, 30))
      }
    }
    return f
  }

  var SEL = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,' +
    '[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="tab"],[role="switch"],' +
    '[role="menuitem"],[role="option"],[role="combobox"],[role="radio"],[contenteditable=""],[contenteditable="true"],' +
    '[onclick],[tabindex="0"],[data-testid],[data-test]'
  var nodes = []
  try { nodes = Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(vis) } catch (err) { nodes = [] }
  var seen = new Set(nodes)

  // 交互恢复：补上"有名字 + cursor:pointer"的裸块（React 事件委托的按钮就长这样）
  var extra = []
  try {
    var cands = document.querySelectorAll('div,span,li,td,label,p,svg,i,b,strong,em,img')
    var inspected = 0
    for (var ci = 0; ci < cands.length && nodes.length + extra.length < MAX_EL && inspected < RECOVER_CAP; ci++) {
      var c = cands[ci]
      if (seen.has(c)) continue
      inspected++
      var nm = nameOf(c)
      if (!nm && c.tagName !== 'IMG' && c.tagName !== 'SVG') continue
      if (!nm && !c.getAttribute('aria-label') && !c.getAttribute('title')) continue
      var st = cs(c)
      if (!st || st.cursor !== 'pointer') continue
      if (!vis(c)) continue
      extra.push(c); seen.add(c)
    }
  } catch (err) { }
  nodes = nodes.concat(extra)

  var out = []
  for (var i = 0; i < nodes.length && out.length < MAX_EL; i++) {
    var e = nodes[i]
    var r = e.getBoundingClientRect()
    out.push({
      ref: idOf(e),
      tag: e.tagName.toLowerCase(),
      role: label(e),
      text: nameOf(e),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      flags: flagsOf(e, r),
    })
  }

  // 重名补上下文（只对真的重名的补，避免整页都是 ctx 噪音）
  var counts = {}
  for (var c1 = 0; c1 < out.length; c1++) { var key = (out[c1].text || '') + '|' + out[c1].role; counts[key] = (counts[key] || 0) + 1 }
  var ctxBudget = 24
  for (var c2 = 0; c2 < out.length; c2++) {
    var o = out[c2]
    if (counts[(o.text || '') + '|' + o.role] < 2) continue
    if (ctxBudget-- <= 0) break
    var ctx = ctxOf(refs[o.ref])
    if (ctx && ctx !== o.text) o.ctx = ctx
  }

  var bodyText = document.body ? (document.body.innerText || '') : ''
  return {
    url: location.href,
    title: document.title,
    vw: window.innerWidth,
    vh: window.innerHeight,
    scrollY: Math.round(window.scrollY || 0),
    docHeight: document.documentElement.scrollHeight,
    elements: out,
    refsInfo: { known: Object.keys(refs).length, reused: before, fresh: Object.keys(refs).length - before + 0 },
    text: bodyText.slice(0, MAX_TEXT),
    textMore: bodyText.length > MAX_TEXT,
  }
}

export const SNAPSHOT_FN = snapshotInPage.toString()

// ---------------------------------------------------------------------------
// 动作可操作性检查：点之前先问"这个点真能命中它吗"。
//
// 为什么必须有：原来 click 只做 scrollIntoView + 取几何中心就直接点。元素被 sticky 头
// 盖住、被弹层压住、被自己父级的 overflow 裁掉、或者 pointer-events:none 时，
// **点击会成功返回 ok:true 但页面毫无反应** —— agent 只会以为"点了但没用"，然后反复点。
//
// 检查项：尺寸 → 自身+祖先的可见性/pointer-events → disabled/aria-disabled → 是否在视口内
// → elementFromPoint 命中检测（遮挡）。中心点被盖住时，还会在矩形内换几个候选点再试
// （元素被浮层盖住一半是常态，换点往往就能点）。仍然失败就返回**确定性原因**，不要硬点。
// ---------------------------------------------------------------------------
export function actionableInPage(kind, key, opts) {
  opts = opts || {}
  function cs(e) { try { return window.getComputedStyle(e) } catch (err) { return null } }
  function desc(e) {
    if (!e) return 'unknown'
    var cls = (e.className && typeof e.className === 'string') ? '.' + String(e.className).trim().split(/\s+/)[0] : ''
    return e.tagName.toLowerCase() + cls
  }
  function resolve() {
    if (kind === 'ref') {
      var e = window.__BL_REFS && window.__BL_REFS[key]
      if (!e) return { error: 'ref ' + key + ' 不存在（本页从没给过这个编号）：重新 browser_snapshot' }
      if (!e.isConnected) return { error: 'ref ' + key + ' 已失效（元素已从页面移除）：重新 browser_snapshot' }
      return { el: e }
    }
    var one = null
    try { one = document.querySelector(key) } catch (err) { return { error: '选择器无效: ' + key } }
    if (!one) return { error: '选择器没有命中元素: ' + key }
    return { el: one }
  }
  function ancestorsBlocking(e) {
    // 从**父级**开始：元素自身的不可见/pointer-events 有专门分支，别把自己说成"祖先"
    var p = e.parentElement, depth = 0
    while (p && depth < 12) {
      var s = cs(p)
      if (s) {
        if (s.display === 'none') return 'display:none 的祖先 <' + desc(p) + '>'
        if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'visibility:hidden 的祖先 <' + desc(p) + '>'
        if (parseFloat(s.opacity || '1') <= 0.02) return 'opacity:0 的祖先 <' + desc(p) + '>'
        if (s.pointerEvents === 'none') return 'pointer-events:none 的祖先 <' + desc(p) + '>'
      }
      p = p.parentElement
      depth++
    }
    return ''
  }
  function hit(x, y, el) {
    var top = document.elementFromPoint(x, y)
    if (!top) return { ok: false, why: '屏幕该点没有元素' }
    if (top === el || el.contains(top) || top.contains(el)) return { ok: true }
    return { ok: false, why: '被 <' + desc(top) + '> 盖住' }
  }

  var got = resolve()
  if (got.error) return { ok: false, reason: 'not-found', error: got.error }
  var el = got.el

  var text = String((el.innerText || el.value || el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().slice(0, 60)
  // 元素类型（input 的 type / contenteditable）：**只回报类型，绝不回报值**。
  // browser_type 用它判断"这次输入的目标是不是 password 字段"，好让留痕在**任何失败路径**
  // （找不到元素之外的情况：被遮挡、disabled、回读失败）都能把 text 脱敏掉 —— 否则
  // "密码框被浮层盖住"这一路会绕过脱敏。见 audit.js 的 redactAuditArgs。
  var etype = String(el.getAttribute('type') || '').toLowerCase() || (el.isContentEditable ? 'contenteditable' : '')
  if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (err) { el.scrollIntoView() } }
  var r = el.getBoundingClientRect()
  var s = cs(el)
  var META = { tag: el.tagName.toLowerCase(), type: etype, text: text }

  if (s && (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.opacity || '1') <= 0.02)) {
    return { ok: false, reason: 'hidden', error: '元素自身不可见（display:none / visibility:hidden / opacity:0）', tag: META.tag, type: META.type, text: META.text }
  }
  var blocking = ancestorsBlocking(el)
  if (blocking) return { ok: false, reason: 'hidden', error: '元素不可见（' + blocking + '）', tag: META.tag, type: META.type, text: META.text }
  if (r.width < 4 || r.height < 4) return { ok: false, reason: 'zero-size', error: '元素尺寸趋近于 0（' + Math.round(r.width) + '×' + Math.round(r.height) + '），点不到', tag: META.tag, type: META.type, text: META.text }
  if (s && s.pointerEvents === 'none') return { ok: false, reason: 'pointer-events-none', error: '元素 pointer-events:none（它自己不接收点击，多半该点它的父级/子级）', tag: META.tag, type: META.type, text: META.text }
  if (opts.needEnabled !== false && (el.disabled === true || el.getAttribute('aria-disabled') === 'true')) {
    return { ok: false, reason: 'disabled', error: '元素处于 disabled 状态（先让它可用，别硬点）', tag: META.tag, type: META.type, text: META.text }
  }

  var vw = window.innerWidth, vh = window.innerHeight
  var cands = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + r.width / 2, r.top + Math.max(2, r.height * 0.25)],
    [r.left + r.width / 2, r.top + Math.max(2, r.height * 0.75)],
    [r.left + Math.max(2, r.width * 0.25), r.top + r.height / 2],
    [r.left + Math.max(2, r.width * 0.75), r.top + r.height / 2],
  ]
  var lastWhy = ''
  var outside = true
  for (var i = 0; i < cands.length; i++) {
    var x = Math.round(cands[i][0]), y = Math.round(cands[i][1])
    if (x < 0 || y < 0 || x > vw || y > vh) { lastWhy = '目标点 (' + x + ',' + y + ') 在视口外（' + vw + '×' + vh + '）'; continue }
    outside = false
    var h = hit(x, y, el)
    if (h.ok) return { ok: true, x: x, y: y, tag: META.tag, type: META.type, text: META.text, tried: i }
    lastWhy = h.why
  }
  if (outside) return { ok: false, reason: 'outside-viewport', error: '元素点在视口外：' + lastWhy + '（先 browser_scroll 或 browser_tabs 再看）', tag: META.tag, type: META.type, text: META.text }
  return { ok: false, reason: 'covered', error: '元素被遮挡，5 个候选点都没命中：' + lastWhy, tag: META.tag, type: META.type, text: META.text, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
}

export const ACTIONABLE_FN = actionableInPage.toString()

// ---------------------------------------------------------------------------
// 按 CSS 选择器聚焦（browser_type 用）。
// 单独成函数而不是在 index.js 里拼字符串：手拼 `document.querySelector(' + JSON.stringify(css) + ')`
// 这种写法一旦括号数目对不上，报错是页面里的 SyntaxError，排查成本远高于写在这儿让 node --check 兜住。
// ---------------------------------------------------------------------------
export function focusSelectorInPage(css) {
  var el = null
  try { el = document.querySelector(String(css || '')) } catch (e) { return { error: '选择器无效: ' + css } }
  if (!el) return { error: 'selector 未命中: ' + css }
  if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) { el.scrollIntoView() } }
  try { el.focus() } catch (e) { }
  var tag = el.tagName.toLowerCase()
  if ((tag === 'input' || tag === 'textarea') && typeof el.select === 'function' && el.type !== 'password' && el.type !== 'file' && !el.readOnly) el.select()
  return { ok: true, tag: tag, text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60) }
}

export const FOCUS_SELECTOR_FN = focusSelectorInPage.toString()

// ---------------------------------------------------------------------------
// 输入回读：type 之后确认"值真的进去了"。
// CDP Input.insertText 走的是浏览器编辑流水线，多数情况没问题，但富文本编辑器
// （Lexical/ProseMirror/Draft 这类自带文档模型的）会自己 reconcile 掉外来写入，
// 于是"工具报成功、字段其实是空的"。所以回读一次，不匹配就明确告诉 agent。
// **password 字段只回长度，绝不回值。**
// ---------------------------------------------------------------------------
export function readbackInPage(kind, key, expected) {
  function resolve() {
    if (kind === 'ref') {
      var e = window.__BL_REFS && window.__BL_REFS[key]
      if (!e || !e.isConnected) return null
      return e
    }
    try { return document.querySelector(key) } catch (err) { return null }
  }
  var el = resolve()
  if (!el) return { ok: false, error: '回读失败：目标元素不在了（页面重渲染），重新 browser_snapshot' }
  var tag = el.tagName.toLowerCase()
  var type = String(el.getAttribute('type') || '').toLowerCase()
  var val = el.isContentEditable ? String(el.innerText || el.textContent || '') : String(el.value == null ? '' : el.value)
  var out = {
    tag: tag,
    type: type || (el.isContentEditable ? 'contenteditable' : ''),
    valueLength: val.length,
    empty: val.length === 0,
  }
  if (expected != null) out.matchesInput = val.trim() === String(expected).trim()
  if (type === 'password') out.value = val ? '•••（' + val.length + ' 位，不回显）' : ''
  else out.value = val.slice(0, 120)
  return out
}

export const READBACK_FN = readbackInPage.toString()
