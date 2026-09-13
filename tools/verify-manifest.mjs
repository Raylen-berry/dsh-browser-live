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
  // verify-audit-chain.mjs 是**用户数据的自检**（检查真实留痕链是否被删/改过），不是代码测试：
  // 混进 npm test 会让"改了代码跑测试"因为历史数据而失败（v0.12.0 拆分，见 CHANGELOG）。
  // 它必须作为 audit:check 存在，并被排除在"npm test 覆盖"的判定之外。
  const dataChecks = new Set(['verify-audit-chain.mjs'])
  ok(String((p.v.scripts && p.v.scripts['audit:check']) || '').includes('tools/verify-audit-chain.mjs'),
    'audit:check 覆盖实时留痕链自检（数据检查与代码测试分开）')
  for (const suite of readdirSync(path.join(ROOT, 'tools')).filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))) {
    if (dataChecks.has(suite)) {
      ok(!t.includes('tools/' + suite), `${suite} 是数据自检，不混进 npm test`)
      continue
    }
    ok(t.includes('tools/' + suite), `npm test 覆盖了 ${suite}`)
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
