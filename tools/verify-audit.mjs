// dsh-browser-live · 留痕模块离线自检
// 用法： node tools/verify-audit.mjs
// 覆盖：追加写 / 哈希链自洽 / **删一行能被查出来** / **改一行能被查出来** / 截断标注 /
//       写不进去时不抛错（留痕坏了不能连累浏览器功能）。
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAudit, verifyChain, trim, auditFileName } from '../audit.js'

let pass = 0
const fails = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label) }
  else { fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  FAIL ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}

const root = mkdtempSync(path.join(tmpdir(), 'bl-audit-'))
const dir = path.join(root, 'audit')
const fixed = new Date('2026-09-12T10:00:00Z')
const A = createAudit(dir, { now: () => fixed })

console.log('留痕模块自检（临时目录 ' + dir + '）')
ok(auditFileName(fixed) === '2026-09-12', '文件名主干按本地日期：' + auditFileName(fixed))

// ---- ① 追加写 + 链自洽 ----
const r1 = A.audit('boot', { version: '0.9.0' })
const r2 = A.audit('tool', { tool: 'browser_open', args: '{"url":"https://example.com"}' })
const r3 = A.audit('nav', { url: 'https://example.com/a' })
const r4 = A.audit('tool', { tool: 'browser_close', ok: true })
ok(!!r1 && !!r2 && !!r3 && !!r4, '四条记录都写成功')
ok(r1.prev === null, '第一条 prev 为 null（当天新文件）')
ok(r2.prev === r1.h && r3.prev === r2.h && r4.prev === r3.h, '每条 prev 指向上一条的 hash（链接上了）')

const file = A.file()
const lines = readFileSync(file, 'utf8').trim().split('\n')
ok(lines.length === 4, '文件里正好 4 行', lines.length)
ok(path.basename(file) === '2026-09-12.jsonl', '落盘文件名是 2026-09-12.jsonl（不是 .jsonl.jsonl）', path.basename(file))
let v = verifyChain(file)
ok(v.ok === true && v.records === 4, 'verifyChain 通过', v)

// ---- ② 删一行必须被查出来 ----
const tamper1 = path.join(root, 'deleted.jsonl')
writeFileSync(tamper1, [lines[0], lines[1], lines[3]].join('\n') + '\n', 'utf8')
v = verifyChain(tamper1)
ok(v.ok === false && v.brokenAt === 3, '删掉第 3 行 → 在第 3 行断链', v)

// ---- ③ 改一行必须被查出来 ----
const tamper2 = path.join(root, 'edited.jsonl')
const forged = JSON.parse(lines[2]); forged.url = 'https://example.com/另一个页面'
writeFileSync(tamper2, [lines[0], lines[1], JSON.stringify(forged), lines[3]].join('\n') + '\n', 'utf8')
v = verifyChain(tamper2)
ok(v.ok === false && v.brokenAt === 3 && /内容与它自己的 h 对不上/.test(v.reason), '把第 3 行的 url 改掉 → 就地查出"这一行被改过"', v)

// ---- ④ 续写已有文件时链要接上（否则重启后的第一条看起来像被删过） ----
const B = createAudit(dir, { now: () => fixed })
B.audit('boot', { version: '0.9.0', restart: true })
v = verifyChain(file)
ok(v.ok === true && v.records === 5, '同一天再开一个实例续写，链仍然自洽', v)

// ---- ⑤ 截断要标注长度，不假装完整 ----
const long = 'x'.repeat(5000)
const t = trim(long, 4000)
ok(t.length > 4000 && t.includes('原文 5000 字'), '超长参数被截断且标注原文长度', t.slice(-30))

// ---- ⑥ 写不进去不抛错 ----
const bad = createAudit(path.join(root, 'a-file-not-a-dir'), { now: () => fixed })
writeFileSync(path.join(root, 'a-file-not-a-dir'), 'x', 'utf8')
let threw = false
try { bad.audit('tool', { tool: 'x' }) } catch { threw = true }
ok(threw === false, '目录不可写时 audit() 不抛错（只记 fails）', bad.stats())
ok(bad.stats().fails === 1 && bad.stats().lastError !== '', '失败被计数并留了 lastError', bad.stats())

// ---- ⑦ 空文件 / 不存在文件 ----
const empty = path.join(root, 'empty.jsonl')
writeFileSync(empty, '', 'utf8')
v = verifyChain(empty)
ok(v.ok === true && v.records === 0, '空文件视为链完整（0 条）', v)
v = verifyChain(path.join(root, 'nope.jsonl'))
ok(v.ok === false && /读不到文件/.test(v.reason), '不存在的文件给出明确原因', v.reason)

try { rmSync(root, { recursive: true, force: true }) } catch {}

console.log('')
if (fails.length) { console.error('FAIL ' + fails.length + ' 项：'); for (const f of fails) console.error('  - ' + f); process.exit(1) }
console.log('PASS ' + pass + ' 项 —— 留痕追加写、哈希链自洽，且删/改记录都能被查出来')
