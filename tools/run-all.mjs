#!/usr/bin/env node
// tools/run-all.mjs —— 发布前检查总入口：本地与 CI 跑的是同一条命令（npm test）。
//
//   node tools/run-all.mjs          跑全部：每套都跑完再汇总
//   node tools/run-all.mjs --list   只列清单，不执行
//
// 为什么不用 `npm test = a.mjs && b.mjs && ...`（本仓库原来就是那样）：第一套一失败后面的根本不跑，
// 一次 push 只能暴露一个错误。这里每套都跑、逐套列结果，任一套非 0 退出 ⇒ 本进程退出码 1 ⇒ CI 变红。
//
// 本清单只含**离线套件**：测试执行期间**不联网**（不做真实下载、不调真实模型）、不起真浏览器。
// 需要真浏览器（拉 CDP 实测）的套件写在 EXCLUDED 里（含原因），不参与 CI。
// 需要 npm 'ws' 包的 6 套**在**这里：ws 由 package.json 的 devDependencies 声明，
// CI 的依赖安装步骤（npm ci）装好、本机 npm install 装好 —— 依赖是"装出来"的，不是"测试时下载的"。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIST_ONLY = process.argv.includes('--list')

// ---- 仓库配置 -------------------------------------------------------------
const CHECKS = [                        // node --check（纯语法门禁，原 npm test 里已有的那 8 项 + view-page.js）
  'index.js', 'page-read.js', 'view-page.js', 'audit.js', 'bridge.js', 'client.js',
  'extension/background.js', 'extension/sid.js', 'extension/popup.js',
]

const SUITES = [
  'tools/verify-bridge-isolation.mjs', // 重连隔离：旧连接排队消息与跨浏览器回复不得串会话（2026-09-21）
  'tools/verify-audit.mjs',
  'tools/verify-audit-chain.mjs',
  'tools/verify-audit-redact.mjs',
  'tools/verify-extension-v2.mjs',
  'tools/verify-launcher.mjs',
  'tools/verify-manifest.mjs',
  // 观察窗"画面健康"判定（纯函数 + 接线断言）：用户 2026-09-14 反馈"断流还在亮绿灯"。
  // 不起浏览器、不出网，只把 client.js 的 factory 拉起来取测试缝。
  'tools/verify-panel-health.mjs',
  // 以下 6 套要测试用的 npm 'ws' 包（已在 package.json 的 devDependencies 里声明，
  // CI 由 `npm ci` 装出、本机由 `npm install` 装出）—— 2026-09 从 EXCLUDED 挪回。
  // 它们在**干净环境**（DSH_HOME/APPDATA/LOCALAPPDATA/USERPROFILE 指空目录）实测通过。
  'tools/verify-bridge.mjs',        // 23 项
  'tools/verify-bridge-v2.mjs',     // 74 项
  'tools/verify-extension.mjs',     // 77 项
  'tools/verify-browsers.mjs',      // 35 项
  'tools/verify-result-cap.mjs',    // 67 项
  'tools/verify-launch.mjs',        // 24 项；其中 4 项窗口自查依赖 loadWs 的产品缺陷修复（见 index.js）
  // v0.16.0 截图自动回收：shots/ 留最近 200 张且 7 天内，其余移入 recycle（只移不删）
  'tools/verify-shots-recycle.mjs',
]

const EXCLUDED = [
  ['tools/verify-host.mjs',
    '要 ws 包；且它**会真的拉起浏览器**：本机有 Chromium 时 browser_open{gui:true} 断言的是"启动成功"（真窗口），' +
    '没 Chromium 时才走"预期失败"那一支。CI runner（windows-latest）自带 Edge ⇒ 会拉起真浏览器，违反"测试期不出网/不起真浏览器"。'],
  ['tools/verify-page-fns.mjs', '会拉无头 Chromium（Edge/Chrome）做 CDP 实测 —— 测试期不许起真浏览器、不许做真实下载'],
  ['tools/verify-web-tools.mjs', '同样会拉真 Chromium 做 CDP 实测 —— 同上'],
]

const ENV = {}

// ---- 登记完备性 + 已知失败 ------------------------------------------------
// tools/ 下每个「看起来是套件」的文件都必须在 SUITES / EXCLUDED / KNOWN_FAILING 里登记，
// 否则本进程直接失败 —— 防止以后新增套件被静默漏掉（同一个不变量原来由 browser-live 的
// verify-manifest.mjs 断言 package.json 里那个长串来保证）。
const DISCOVERY = (n) => /^(verify|test|probe)-.*\.mjs$/.test(n) || n === 'selfcheck.mjs'

// 已知失败：仍然跑、结果照列，但**不**让整体变红（每条都必须写明原因）。
const KNOWN_FAILING = []
// （verify-manifest.mjs 曾因"断言 package.json 的 scripts.test 长串"过时而进这里；
//   2026-09 已把它的口径改成检查本文件的三个清单，等价且更强，于是挪回 SUITES。详见该文件内注释。）

// ---- 执行器 ---------------------------------------------------------------
const results = []
const t = (ms) => (ms / 1000).toFixed(1) + 's'

function summarize(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  const cand = [...lines].reverse().find((l) => /passed|通过|failed|失败/.test(l))
  if (cand) return cand.trim()
  const n = lines.filter((l) => /^\s*(PASS|✓|✔|OK)\b/.test(l)).length
  return n ? n + ' 项（按 PASS 行计数）' : '（无输出）'
}

function run(kind, file) {
  const args = kind === 'check' ? ['--check', file] : [file]
  const started = Date.now()
  const s = spawnSync(process.execPath, args, {
    cwd: REPO, env: { ...process.env, ...ENV }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const out = (s.stdout || '') + (s.stderr || '')
  const code = s.status === null ? 1 : s.status
  const ok = code === 0
  results.push({ kind, file, ok, code, ms: Date.now() - started, summary: summarize(out) })
  console.log('\n' + '─'.repeat(72))
  console.log((ok ? '✅ ' : '❌ ') + file + '   exit=' + code + '  ' + t(Date.now() - started))
  console.log('─'.repeat(72))
  if (out.trim()) console.log(out.replace(/\s+$/, ''))
  if (s.error) console.log('!! spawn 失败：' + s.error.message)
  return ok
}

function checkRegistry() {
  const reg = new Set([...SUITES, ...EXCLUDED.map((e) => e[0]), ...KNOWN_FAILING.map((e) => e[0])]
    .map((f) => path.basename(String(f).split(' ')[0])))
  const missing = fs.readdirSync(path.join(REPO, 'tools')).filter(DISCOVERY).filter((n) => !reg.has(n))
  if (missing.length) {
    console.error('✗ 有套件没登记到 tools/run-all.mjs（SUITES / EXCLUDED / KNOWN_FAILING 三选一）：' + missing.join(', '))
    process.exit(1)
  }
}

checkRegistry()

if (LIST_ONLY) {
  console.log('语法门禁：' + (CHECKS.length ? CHECKS.join(', ') : '（无）'))
  console.log('测试套件：')
  for (const f of SUITES) console.log('  · ' + f)
  console.log('未纳入 CI：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + ' —— ' + why)
  if (KNOWN_FAILING.length) {
    console.log('已知失败（仍跑、不拦截）：')
    for (const [f, why] of KNOWN_FAILING) console.log('  · ' + f + ' —— ' + why)
  }
  process.exit(0)
}

console.log('dsh-browser-live 发布前检查（离线）· node ' + process.version)
console.log('仓库：' + REPO)
for (const f of CHECKS) run('check', f)
for (const f of SUITES) run('suite', f)

const checks = results.filter((r) => r.kind === 'check')
const suites = results.filter((r) => r.kind === 'suite')
const knownNames = new Set(KNOWN_FAILING.map((e) => path.basename(e[0])))
const isKnown = (r) => knownNames.has(path.basename(r.file))
const bad = results.filter((r) => !r.ok && !isKnown(r))
const known = results.filter((r) => !r.ok && isKnown(r))

console.log('\n' + '='.repeat(72))
console.log('汇总')
console.log('='.repeat(72))
for (const r of results) console.log((r.ok ? ' ✅ ' : ' ❌ ') + r.file.padEnd(38) + t(r.ms).padStart(6) + '  ' + r.summary)
console.log('-'.repeat(72))
console.log('语法门禁 ' + checks.filter((r) => r.ok).length + '/' + checks.length +
  '　套件 ' + suites.filter((r) => r.ok).length + '/' + suites.length + ' 通过')
if (EXCLUDED.length) {
  console.log('\n未纳入 CI 的套件（原因）：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + '\n      ' + why)
}
if (known.length) {
  console.log('\n⚠ 已知失败（不拦截整体退出码，原因见本文件 KNOWN_FAILING）：')
  for (const r of known) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
if (bad.length) {
  console.log('\n失败套件：')
  for (const r of bad) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
console.log('\n' + (bad.length ? '✗ 有套件失败 —— 整体失败' : '✓ 全部通过'))
process.exit(bad.length ? 1 : 0)
