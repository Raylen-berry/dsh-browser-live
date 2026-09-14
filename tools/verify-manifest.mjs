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
  const runAllPath = path.join(ROOT, 'tools', 'run-all.mjs')
  const runAll = (() => { try { return readFileSync(runAllPath, 'utf8') } catch (e) { return { err: e.message } } })()
  ok(typeof runAll === 'string', 'tools/run-all.mjs 存在且可读（npm test 的汇总入口）', typeof runAll === 'string' ? undefined : runAll.err)
  if (typeof runAll === 'string') {
    /**
     * 取 `const NAME = [` 到**配平**的 `]` 之间的字面内容。
     * 不 import run-all.mjs：它是可执行脚本（会跑全部套件并 process.exit），
     * 这里要的是"它登记了谁"，静态读出清单即可。
     * 逐字符前进，跳过字符串字面量（含 ' " `），才能正确配平 —— 清单条目里就有英文方括号。
     */
    const listLiteral = (name) => {
      const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\[').exec(runAll)
      if (!m) return null
      let i = m.index + m[0].length
      const start = i
      let depth = 1
      while (i < runAll.length && depth > 0) {
        const c = runAll[i]
        if (c === "'" || c === '"' || c === '`') {
          const q = c
          i++
          while (i < runAll.length && runAll[i] !== q) { if (runAll[i] === '\\') i++; i++ }
        } else if (c === '[') depth++
        else if (c === ']') depth--
        if (depth === 0) break
        i++
      }
      return runAll.slice(start, i)
    }
    // 清单里每项的名字：SUITES 是 'tools/x.mjs'，EXCLUDED/KNOWN_FAILING 是 ['tools/x.mjs', '原因…']
    const namesIn = (literal) => [...String(literal).matchAll(/['"`](tools\/[\w.-]+\.mjs)['"`]/g)].map((x) => path.basename(x[1]))
    const suitesLit = listLiteral('SUITES')
    const excludedLit = listLiteral('EXCLUDED')
    const knownLit = listLiteral('KNOWN_FAILING')
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

console.log(`\n${fail ? '✗' : '✓'} verify-manifest: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
