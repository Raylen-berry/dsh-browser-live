// verify-manifest: 保证"这个包能被 DSH 装载"。
//
// 为什么值得单开一个套件：package.json 不是合法 JSON 时，DSH 会在 **prepare 阶段**直接失败，
// 而且是整个 harness 起不来 —— 本机实测：description 里混进一个未转义的 ASCII 双引号 →
//   [harness-node] plugin failures: {"stage":"prepare","packageName":"dsh-browser-live",
//     "message":"Expected ',' or '}' after property value in JSON at position 427 (line 4 column 374)"}
//   [harness-node] DSH entry failed: Error: failed to prepare profile bundle dsh-browser-live
//   [desktop] safe mode: third-party web profile bundles are blocked
// 偏偏 index.js 读 package.json 版本号的地方带兜底，所以常规套件全绿也照样发现不了 ——
// 那次是重启 DSH 才炸的，代价很高。这里把它钉死在提交前。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
const ok = (cond, label, detail) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (detail !== undefined ? ' → ' + JSON.stringify(detail) : '')) } }
const eq = (a, b, label) => ok(a === b, label, { got: a, want: b })

const ROOT = path.join(import.meta.dirname, '..')
const readJson = (p) => { try { return { v: JSON.parse(readFileSync(p, 'utf8')) } } catch (e) { return { err: e.message } } }
const exists = (p) => { try { statSync(p); return true } catch { return false } }

// run-all.mjs 的清单要在两处用到（A 段查登记完备性、D 段查文档里的"清单事实"），
// 所以先在模块级读一次。不 import 它：它是可执行脚本（会跑全部套件并 process.exit）。
const RUN_ALL_PATH = path.join(ROOT, 'tools', 'run-all.mjs')
const RUN_ALL_TEXT = (() => { try { return readFileSync(RUN_ALL_PATH, 'utf8') } catch (e) { return { err: e.message } } })()

/**
 * 取 `const NAME = [` 到**配平**的 `]` 之间的字面内容。
 * 逐字符前进，跳过字符串字面量（含 ' " `），才能正确配平 —— 清单条目里就有英文方括号。
 */
function listLiteral(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\[').exec(src)
  if (!m) return null
  let i = m.index + m[0].length
  const start = i
  let depth = 1
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
    } else if (c === '[') depth++
    else if (c === ']') depth--
    if (depth === 0) break
    i++
  }
  return src.slice(start, i)
}

console.log('\nA. package.json（DSH 的装载入口）')
const p = readJson(path.join(ROOT, 'package.json'))
ok(!p.err, 'package.json 是合法 JSON —— 不合法会让 DSH 在 prepare 阶段整个起不来', p.err)
if (p.v) {
  eq(p.v.name, 'dsh-browser-live', 'name 就是插件 id（profile 用 link: 装的就是这个名字）')
  ok(/^\d+\.\d+\.\d+$/.test(String(p.v.version)), 'version 是 x.y.z（generation 目录名与变更记录都依赖它）', p.v.version)
  eq(p.v.type, 'module', 'type=module（host 是 ESM）')
  eq(p.v.main, 'index.js', 'main 指向 index.js')
  ok(p.v.exports && p.v.exports['.'] === './index.js' && p.v.exports['./client'] === './client.js',
    'exports 同时暴露 . 与 ./client', p.v.exports)
  ok(p.v.dsh && p.v.dsh.bundle && p.v.dsh.bundle.patch, '声明了 dsh.bundle.patch（bundle 装载靠它）', p.v.dsh)
  ok(p.v.dsh && p.v.dsh.client && p.v.dsh.client.platform === 'web', 'dsh.client.platform=web（观察窗按 web 平台注入）')
  for (const f of ['index.js', 'bridge.js', 'client.js', 'cordis.patch.yml']) {
    ok(exists(path.join(ROOT, f)), `files 里声明的 ${f} 真的存在`)
  }
  const t = String((p.v.scripts && p.v.scripts.test) || '')
  // npm test 只是"汇总入口"一句话：真正跑哪些套件由 run-all.mjs 的三个清单决定（见下面那段）。
  ok(t.includes('tools/run-all.mjs'), 'npm test 走 tools/run-all.mjs 汇总入口（逐套跑完再汇总，不是 && 串）', t)
  // verify-audit-chain.mjs 是**用户数据的自检**（检查真实留痕链是否被删/改过），不是代码测试：
  // 混进 npm test 会让"改了代码跑测试"因为历史数据而失败（v0.12.0 拆分，见 CHANGELOG）。
  // 它必须作为 audit:check 存在，并被排除在"npm test 覆盖"的判定之外。
  const dataChecks = new Set(['verify-audit-chain.mjs'])
  ok(String((p.v.scripts && p.v.scripts['audit:check']) || '').includes('tools/verify-audit-chain.mjs'),
    'audit:check 覆盖实时留痕链自检（数据检查与代码测试分开）')

  // ---- 不变量：tools/ 下每个套件都在 run-all.mjs 里登记过 -------------------------
  // 口径变更（2026-09，本套件从 KNOWN_FAILING 挪回 SUITES 的原因）：
  //   原来这里断言的是 `scripts.test` 这个**字符串**里逐个出现 "tools/verify-xxx.mjs"。
  //   那是耦合实现细节 —— npm test 现在只是 `node tools/run-all.mjs`，长串本身已经不存在了。
  //   口径只允许**等价地加强**，不接受放宽：真正的意图是"不许有套件被静默漏跑"，
  //   而这件事现在由 run-all.mjs 的三个清单承担。所以改成直接检查那三个清单：
  //     ① 每个套件文件都登记进 SUITES / EXCLUDED / KNOWN_FAILING 三选一（无遗漏）；
  //     ② 三份清单之间**两两不重叠**（同一套件不能既"跑"又"被排除"，否则口径自相矛盾）；
  //     ③ 清单里的每一项都对应 tools/ 下真实存在的文件（无幽灵条目）。
  //   比旧口径更强的地方：旧口径只查"名字出现在一个字符串里"（既漏掉"被排除"这种状态，
  //   也查不出重复/幽灵）；新口径连状态和一致性一起钉住。
  const runAll = RUN_ALL_TEXT
  ok(typeof runAll === 'string', 'tools/run-all.mjs 存在且可读（npm test 的汇总入口）', typeof runAll === 'string' ? undefined : runAll.err)
  if (typeof runAll === 'string') {
    // 清单里每项的名字：SUITES 是 'tools/x.mjs'，EXCLUDED/KNOWN_FAILING 是 ['tools/x.mjs', '原因…']
    const namesIn = (literal) => [...String(literal).matchAll(/['"`](tools\/[\w.-]+\.mjs)['"`]/g)].map((x) => path.basename(x[1]))
    const suitesLit = listLiteral(runAll, 'SUITES')
    const excludedLit = listLiteral(runAll, 'EXCLUDED')
    const knownLit = listLiteral(runAll, 'KNOWN_FAILING')
    ok(suitesLit !== null && excludedLit !== null && knownLit !== null,
      'run-all.mjs 里三个清单（SUITES / EXCLUDED / KNOWN_FAILING）都读得到', { suites: suitesLit !== null, excluded: excludedLit !== null, known: knownLit !== null })

    const suites = namesIn(suitesLit)
    const excluded = namesIn(excludedLit)
    const known = namesIn(knownLit)
    ok(suites.length > 0, 'SUITES 非空（否则 npm test 名义上跑、实际一套都没跑）', suites.length)

    // ① 无遗漏：每个套件文件都必须在三选一里登记
    const registered = new Set([...suites, ...excluded, ...known])
    const allSuites = readdirSync(path.join(ROOT, 'tools')).filter((f) => /^(verify|test|probe)-.*\.mjs$/.test(f) || f === 'selfcheck.mjs')
    const missing = allSuites.filter((f) => !registered.has(f))
    ok(missing.length === 0, 'tools/ 下每个套件都被 run-all.mjs 登记过（SUITES / EXCLUDED / KNOWN_FAILING 三选一，不许静默漏跑）', missing)

    // ② 两两不重叠：同一套件不能有"既跑又被排除"这种自相矛盾的登记
    const dup = []
    const pairs = [['SUITES', suites], ['EXCLUDED', excluded], ['KNOWN_FAILING', known]]
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        for (const n of pairs[i][1]) if (pairs[j][1].includes(n)) dup.push(n + '：' + pairs[i][0] + ' ∩ ' + pairs[j][0])
      }
    }
    ok(dup.length === 0, 'SUITES / EXCLUDED / KNOWN_FAILING 两两不重叠（同一套件不能既跑又被排除）', dup)
    // 同一清单内部也不许重复（重复登记=口径含糊）
    const selfDup = []
    for (const [nm, list] of pairs) {
      const seen = new Set()
      for (const n of list) { if (seen.has(n)) selfDup.push(nm + '：' + n); seen.add(n) }
    }
    ok(selfDup.length === 0, '同一清单里没有重复条目', selfDup)

    // ③ 无幽灵：登记的名字都对应 tools/ 下真实存在的文件
    const ghost = [...registered].filter((f) => !exists(path.join(ROOT, 'tools', f)))
    ok(ghost.length === 0, '登记的名字都对应 tools/ 下真实存在的文件（没有幽灵条目）', ghost)

    // ④ 数据自检（verify-audit-chain）不因"改口径"被漏掉：它仍在 audit:check 里，
    //    且仍在 SUITES 里跑（它的断言对空 DSH_HOME 也成立，本轮干净环境实测通过）。
    ok(String((p.v.scripts && p.v.scripts['audit:check']) || '').includes('tools/verify-audit-chain.mjs'),
      'verify-audit-chain.mjs 仍由 audit:check 覆盖（数据自检与代码测试两条命令各跑一次）')
    // ⑤ 排除项必须写清原因（不然"被排除"会变成无声的丢套件）
    const noReason = []
    for (const lit of [excludedLit, knownLit]) {
      for (const m of String(lit).matchAll(/\[\s*['"`](tools\/[\w.-]+\.mjs)['"`]\s*,\s*(['"`])([\s\S]*?)\2\s*\]/g)) {
        if (m[3].trim().length < 8) noReason.push(path.basename(m[1]))
      }
    }
    ok(noReason.length === 0, 'EXCLUDED / KNOWN_FAILING 的每一项都写了原因（不许无声排除）', noReason)
  }
}

console.log('\nB. 包里所有 JSON 都能解析（prepare 阶段会读它们）')
const bad = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (e.name.endsWith('.json')) {
      const r = readJson(full)
      if (r.err) bad.push(path.relative(ROOT, full) + ' → ' + r.err)
    }
  }
}
walk(ROOT)
ok(bad.length === 0, '没有任何损坏的 JSON 文件', bad)

console.log('\nC. cordis.patch.yml（bundle 层声明）')
const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
ok(/id:\s*dsh-browser-live/.test(patch), 'patch 里 insert 的行 id 等于包名（客户端模块扫描按 manifest name 匹配）')
ok(/name:\s*'?dsh-browser-live'?/.test(patch), 'patch 里的 name 也等于包名')

console.log('\nD. 文档里的「套件数字」不许陈旧（现状文档禁写跑出来的数；清单事实必须与代码相等）')
//
// 为什么是**禁止**而不是"文档数字 == 实测通过数"那种相等校验：
//   要做相等校验，断言里就得把每个套件跑一遍拿数 —— 而本轮真正写歪的三处里有两个
//   （verify-host 73→93、verify-page-fns 96→121）**根本不在 CI 门禁里**，它们要起真浏览器。
//   CI 侧永远拿不到它们的数 ⇒ "相等"这个口径对最容易陈旧的数字无效，禁掉才是唯一收口。
//   代价是文档不再自带数字，所以必须同时留下一条指路（"以 `npm test` 输出为准"），
//   并且把**能静态推出来的**那三类清单事实改成相等校验，别一起丢掉：
//     · 语法门禁几条  ←→ tools/run-all.mjs 的 CHECKS
//     · 离线套件几套  ←→ tools/run-all.mjs 的 SUITES
//     · 有几个 browser_* 工具 ←→ index.js 里 `name: 'browser_*'` 的注册数
//   附带好处：本套件自己的条数不再需要写进 README（自引用问题解决）。
// 豁免（这些写的是"当时测出来是多少"，改它等于伪造历史，不在本段范围内）：
//   · README 的「## 版本与变更记录」之后（所以先钉住这个锚点存在）
//   · CHANGELOG.md（逐版本记录，含 17→26 那种前后对照）
//   · .github/workflows/*.yml 的注释（Node 20 为什么被移出矩阵，靠的就是那次实测的数）
const HISTORY_ANCHOR = '## 版本与变更记录'
const readText = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8') } catch { return '' } }

const readmeAll = readText('README.md')
ok(readmeAll.includes(HISTORY_ANCHOR),
  'README 里有「' + HISTORY_ANCHOR + '」这一节 —— 本段的历史豁免边界就是它（改名/删掉会让豁免范围悄悄变化）', HISTORY_ANCHOR)
const readmeNow = readmeAll.split(HISTORY_ANCHOR)[0]

// 现状文档：README 的历史章节之前 + docs/ 下每份 .md 全文（设计文档读起来都是现在时）。
// HISTORY.md / HISTORY-2026-09.md（README 拆分前整本存档）是逐版本记录，与 CHANGELOG 同类
// （写的是"当时测出来是多少"），同享历史豁免。
const HISTORY_OK = (n) => n === 'HISTORY.md' || n.startsWith('HISTORY-')
const scopes = [{ file: 'README.md', text: readmeNow }]
for (const f of readdirSync(path.join(ROOT, 'docs')).filter((n) => n.endsWith('.md') && !HISTORY_OK(n)).sort()) {
  scopes.push({ file: 'docs/' + f, text: readText(path.join('docs', f)) })
}
// 套件名当场从 tools/ 取：这样新加一套件、文档里写了它的数，立刻就落在规则里
const suiteNames = new Set(
  readdirSync(path.join(ROOT, 'tools')).filter((f) => /^(verify|test|probe)-.*\.mjs$/.test(f)).map((f) => f.replace(/\.mjs$/, ''))
)
// 跑出来的数：阿拉伯数字 + 计数单位（中文"一条断言"、退出码 0 都不算，那些是正常表述）
const RESULT_NUM = /\d+\s*(?:项|条|个断言|断言|passed|failed|assert(?:ion)?s?)/i
// 也禁"套件名后面直接跟括号数字"：`verify-host.mjs`(59) 这种表格里最常见的写法不带单位，会漏网
const SUITE_BARE_NUM = /(?:verify|test|probe)-[a-z0-9][a-z0-9-]*(?:\.mjs)?[^\S\n]{0,3}[`'"]{0,2}[^\S\n]{0,2}[（(]\s*\d+/i
// 结果分数 "M/N 套件"、"套件 M/N"：同样是一次运行的产物
const SCORE = /\d+\s*\/\s*\d+\s*(?:套件|语法门禁|项测试|测试)|(?:套件|语法门禁)\s*\d+\s*\/\s*\d+/
// 逃生口：写"输出长什么样"时免不了 `0 failed` 这种零计数（它不是会陈旧的那种数）。
// 只放行**全零**，且必须显式打标记 —— 命令模板里那三行靠它，非零数字一律照抓。
const MARKER = 'doc-numbers-ok'
const numTokens = (line) => [...line.matchAll(/\d+\s*(?:项|条|个断言|断言|passed|failed|assert(?:ion)?s?)/gi)]
const allZeros = (line) => { const t = numTokens(line); return t.length > 0 && t.every((m) => /^\s*0\s*/.test(m[0])) }
/** 一行之内的三个判定，抽成函数是为了让下面那几条"自检"能直接拿违规样本喂它 */
function judgeLine(line) {
  const tokens = (line.match(/(?:verify|test|probe)-[a-z0-9][a-z0-9-]*/gi) || []).map((t) => t.toLowerCase().replace(/\.mjs$/, ''))
  const withSuite = tokens.some((t) => suiteNames.has(t))
  return {
    suite: withSuite,
    num: withSuite && (RESULT_NUM.test(line) || SUITE_BARE_NUM.test(line)) && !(allZeros(line) && line.includes(MARKER)),
    score: SCORE.test(line),
  }
}
const resultHits = [], scoreHits = []
for (const s of scopes) {
  s.text.split(/\r?\n/).forEach((line, i) => {
    const j = judgeLine(line)
    if (j.num) resultHits.push(s.file + ':' + (i + 1) + '  ' + line.trim())
    if (j.score) scoreHits.push(s.file + ':' + (i + 1) + '  ' + line.trim())
  })
}
ok(resultHits.length === 0,
  '现状文档里没有"套件名 + 跑出来的通过数"（这类数只能跑出来，写进文档必然陈旧；要数看 `npm test` 输出）', resultHits)
ok(scoreHits.length === 0, '现状文档里没有 M/N 这种运行结果分数（同理）', scoreHits)
ok(/以\s*`?npm test`?\s*(?:的)?\s*输出为准/.test(readmeNow),
  'README 现状章节留了"以 `npm test` 输出为准"这句指路（禁掉数字不等于把信息也弄没）')

// ---- 自检：规则本身没有被悄悄改松（把违规样本喂进去必须抓得住，正常句必须不抓） ----
ok(judgeLine('node tools/verify-host.mjs   # 期望 73 passed / 0 failed').num === true,
  '自检·正样本：给 verify-host 写死通过数会被抓（改松规则当场红）')
ok(judgeLine('验证：`node tools/verify-page-fns.mjs`（96 条断言）').num === true,
  '自检·正样本：中文"条"同样被抓')
ok(judgeLine('| 离线验证 | `verify-bridge-v2`(74) · `verify-host.mjs`(59) 等 | ✅ 全绿 |').num === true,
  '自检·正样本：表格里"套件名(数字)"这种不带单位的写法也被抓（上一版就是从这儿漏的）')
ok(judgeLine('合计 8/8 语法门禁 + 12/12 套件').score === true,
  '自检·正样本：M/N 结果分数被抓')
ok(judgeLine('`tools/run-all.mjs` 把 8 项语法门禁（`node --check`）和 12 套离线测试都跑完再汇总').num === false,
  '自检·负样本：清单事实（没有套件名同现）不误抓 —— 否则禁的就不是陈旧数字而是所有数字')
ok(judgeLine('node tools/verify-audit-chain.mjs   # 期望退出码 0 = 链完整；里面有一条断言钉住').num === false,
  '自检·负样本：退出码 0 与中文"一条断言"不算通过数')
// 逃生口本身也要钉：① 打了标记且全零 ⇒ 放行；② 打了标记但有非零数字 ⇒ 照抓（否则标记就成了万能后门）
ok(judgeLine('node tools/verify-host.mjs   # 期望 0 failed<!-- ' + MARKER + ' -->').num === false,
  '自检·负样本：打了标记且只有零计数 ⇒ 放行（命令模板要展示输出形状）')
ok(judgeLine('node tools/verify-host.mjs   # 期望 93 passed / 0 failed<!-- ' + MARKER + ' -->').num === true,
  '自检·正样本：打标记也压不住非零的通过数 —— 标记不是后门（这条是"标记只放行全零"的守门人）')

// ---- 清单事实：能静态推出来的那三类，出现就必须与代码相等 ----
const runAllText = typeof RUN_ALL_TEXT === 'string' ? RUN_ALL_TEXT : ''
const gateLit = runAllText ? listLiteral(runAllText, 'CHECKS') : null
const suiteLit = runAllText ? listLiteral(runAllText, 'SUITES') : null
const gateCount = gateLit === null ? -1 : [...gateLit.matchAll(/['"`][^'"`\n]*['"`]/g)].length
const suiteCount = suiteLit === null ? -1 : [...suiteLit.matchAll(/['"`]tools\/[\w.-]+\.mjs['"`]/g)].length
ok(gateCount > 0 && suiteCount > 0,
  `D 段的分母可信：从 run-all.mjs 读出 CHECKS ${gateCount} 条 / SUITES ${suiteCount} 套`, { gateCount, suiteCount })

const toolCount = (readText('index.js').match(/^[ \t]*name:\s*['"`]browser_[a-z0-9_]+/gim) || []).length
ok(toolCount >= 15, '工具数分母可信：index.js 里静态数出 ' + toolCount + ' 个 browser_* 注册项（正则没退化）', toolCount)

const docNums = (re) => [...readmeNow.matchAll(re)].map((m) => Number(m[1] ?? m[2] ?? m[3] ?? m[4]))
const gateClaims = [...new Set(docNums(/(\d+)\s*项\s*(?:\*\*)?语法门禁|语法门禁[^\d\n]{0,4}(\d+)\s*项/g))]
ok(gateClaims.length > 0 && gateClaims.every((n) => n === gateCount),
  `README 写的"语法门禁 N 项"与 run-all.mjs 的 CHECKS 一致（实测 ${gateCount} 条）`, { doc: gateClaims, actual: gateCount })
const suiteClaims = [...new Set(docNums(/(\d+)\s*套(?:测试|离线套件|离线测试|套件)/g))]
ok(suiteClaims.length > 0 && suiteClaims.every((n) => n === suiteCount),
  `README 写的"N 套离线测试"与 run-all.mjs 的 SUITES 一致（实测 ${suiteCount} 套）`, { doc: suiteClaims, actual: suiteCount })
const toolClaims = [...new Set(docNums(/(\d+)\s*个\s*`?browser_\*?`?\s*工具/g))]
ok(toolClaims.length > 0 && toolClaims.every((n) => n === toolCount),
  `README 写的"N 个 browser_* 工具"与 index.js 实际注册数一致（实测 ${toolCount} 个）`, { doc: toolClaims, actual: toolCount })

// 未纳入 CI 的套件数：README 只写了名字、没写数量，这里就把数量也钉上（EXCLUDED 有几套是真事实）
const excludedLit = runAllText ? listLiteral(runAllText, 'EXCLUDED') : null
const knownLit = runAllText ? listLiteral(runAllText, 'KNOWN_FAILING') : null
const excludedCount = excludedLit === null ? -1 : [...excludedLit.matchAll(/['"`]tools\/[\w.-]+\.mjs['"`]/g)].length
const knownCount = knownLit === null ? -1 : [...knownLit.matchAll(/['"`]tools\/[\w.-]+\.mjs['"`]/g)].length
ok(excludedCount > 0 && knownCount >= 0,
  `D 段的分母可信：从 run-all.mjs 读出 EXCLUDED ${excludedCount} 套 / KNOWN_FAILING ${knownCount} 套`, { excludedCount, knownCount })
ok((knownCount > 0) === (knownLit !== null && /tools\//.test(String(knownLit))),
  'KNOWN_FAILING 的条数读法与它登记的内容一致（空清单 = 没有已知失败 = 0 套）', { knownCount, known: knownLit })
const excludedClaims = [...new Set(docNums(/(\d+)\s*套[^\n。]{0,12}(?:未纳入|排除|不在)/g))]
ok(excludedClaims.every((n) => n === excludedCount),
  `README 写的"未纳入 CI 的套件数"与 run-all.mjs 的 EXCLUDED 一致（实测 ${excludedCount} 套）`, { doc: excludedClaims, actual: excludedCount })

// ---- SKILL.md 的"节数/剧本数"：正是上一轮漏掉的那一处陈旧（README 写 19 节，实际 14 节） ----
// 取数方式选"标题"而不是"内容条目"：标题是结构化事实（`## N.` 编号一拍到底），
// 加内容条目不算新的一节 —— 用标题计数，加内容不会误报、加一节必然报，且不依赖跑浏览器。
const skillText = readText('skills/browser-automation/SKILL.md')
const skillSectionNums = [...skillText.matchAll(/^##\s+(\d+)\./gm)].map((m) => Number(m[1]))
const skillSections = skillSectionNums.length
const skillContiguous = skillSections > 0 && skillSectionNums.every((n, i) => n === i)
ok(skillContiguous,
  `SKILL.md 的节号从 0 连续排到 ${skillSections - 1}（共 ${skillSections} 节）—— 编号一乱，"N 节"就没人能核对`,
  skillSectionNums)
const scenarioMarkers = [...skillText.matchAll(/^\*\*([A-Z])\.\s/gm)].map((m) => m[1])
const scenarioCount = scenarioMarkers.length
const scenarioContiguous = scenarioCount > 0 && scenarioMarkers.every((c, i) => c.charCodeAt(0) - 65 === i)
ok(scenarioContiguous,
  `SKILL.md 的剧本标号从 A 连续排到 ${scenarioCount}（共 ${scenarioCount} 个现成剧本）`, scenarioMarkers)
const skillClaims = [...new Set(docNums(/(\d+)\s*节/g))]
ok(skillClaims.length > 0 && skillClaims.every((n) => n === skillSections),
  `README 写的"SKILL.md N 节"与文件里的编号标题数一致（实测 ${skillSections} 节）`, { doc: skillClaims, actual: skillSections })
const scenarioClaims = [...new Set(docNums(/(\d+)\s*个\s*(?:现成)?剧本/g))]
ok(scenarioClaims.length > 0 && scenarioClaims.every((n) => n === scenarioCount),
  `README 写的"N 个现成剧本"与 SKILL.md 的标号数一致（实测 ${scenarioCount} 个）`, { doc: scenarioClaims, actual: scenarioCount })

// ---- 自检：上面这几条相等校验的正则也没被改松 ----
const claimsIn = (re, line) => [...line.matchAll(re)].map((m) => Number(m[1] ?? m[2] ?? m[3] ?? m[4]))
ok(claimsIn(/(\d+)\s*节/g, 'README 写"19 节"这种').includes(19),
  '自检·正样本：`(\\d+)\\s*节` 抓得住"19 节"这种写法（抓不住就等于没校验）')
ok(claimsIn(/(\d+)\s*节/g, '随手引一句"下面这一节"').length === 0,
  '自检·负样本：不带数字的"这一节"不误抓（否则整段规则会把正常行文判红）')
ok(claimsIn(/(\d+)\s*个\s*(?:现成)?剧本/g, '→ 4 个现成剧本 → 验收口径').includes(4),
  '自检·正样本：`N 个现成剧本`抓得住（这条正是 README 那一行的写法）')
ok(claimsIn(/(\d+)\s*套[^\n。]{0,12}(?:未纳入|排除|不在)/g, '其中 3 套未纳入 CI').includes(3),
  '自检·正样本：`N 套未纳入 CI`抓得住（EXCLUDED 那条相等校验靠它）')

console.log(`\n${fail ? '✗' : '✓'} verify-manifest: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
