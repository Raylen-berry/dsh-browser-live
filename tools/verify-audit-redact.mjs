// dsh-browser-live · 留痕**脱敏**离线自检（P1 隐私泄漏修复的回归断言）
// 用法： node tools/verify-audit-redact.mjs
//
// 背景（缺陷）：browser_type 的**返回值**是脱敏过的（password 只回长度不回显），
// 但留痕落盘的 args.text 是原文 ⇒ 往密码框里打的字原样进了 append-only 的审计日志。
// 本套件把"修好"这件事钉成断言，而且**离线**：不开浏览器、不连网、不碰真实浏览数据。
//
// 覆盖：
//   ① password 场景：args.text 落盘后不含明文，含长度 + sha256 摘要
//   ② 普通输入：text 原样保留（防"修过头把审计变成废物"）
//   ③ 通用兜底：password / token / apiKey 这类键名在任何工具下都脱敏
//   ④ 其它字段（ref / selector / url / files …）不被误伤
//   ⑤ null / undefined / 非对象入参不抛错
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createAudit, trim, redactAuditArgs, verifyChain } from '../audit.js'

let pass = 0
const fails = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label) }
  else { fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  FAIL ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }
}
const sha12 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 12)

// 虚构密码：绝不用真口令。故意用一个别处不会出现的串，才能断言"它不出现在最终 JSON 里"。
const PW = 'S3cret-Dummy-Pw-9f2a'
const PW2 = '另一个虚构口令-7c1d'

// browser_type 成功时的返回形状（照 index.js L2039-2051 抄）：
//   { ok:true, typed:N, enter:false, field:{ tag,type,valueLength,empty,matches,value } }
const typeOut = (rbType, len) => ({
  ok: true,
  typed: len,
  enter: false,
  field: { tag: 'input', type: rbType, valueLength: len, empty: false, matches: true, value: rbType === 'password' ? '•••（' + len + ' 位，不回显）' : undefined },
})

console.log('留痕脱敏自检（离线；虚构口令 ' + PW + '）')

// ---- ① password 场景：明文不得出现，长度与摘要必须留下 ----
const argsPw = { ref: 'e12', text: PW }
const redPw = redactAuditArgs('browser_type', argsPw, typeOut('password', PW.length), null)
const persistedPw = trim(redPw, 4000)          // ← 这就是真正落盘的那串文本
ok(!persistedPw.includes(PW), 'password 场景：args.text 落盘后**不含明文**', persistedPw.slice(0, 200))
ok(Object.keys(redPw).includes('text') && redPw.text && redPw.text.redacted === true, 'text 被替换成脱敏结构', redPw.text)
ok(redPw.text.len === PW.length, '留下长度 ' + PW.length + '（便于知道填了几位）', redPw.text.len)
ok(redPw.text.sha256 === sha12(PW) && redPw.text.sha256.length === 12, '留下 sha256 前 12 位（便于比对"是不是同一个值"）', redPw.text.sha256)
ok(redPw.text.field === 'text', '脱敏结构标注了字段名 field:"text"', redPw.text.field)
ok(JSON.stringify(redPw).includes(sha12(PW)), '最终 JSON 里能找到摘要（不是整条被丢掉）')
ok(typeof redPw.text !== 'string', 'text 不再是一个字符串（杜绝"半截明文"这种中间态）')

// 另一个值 ⇒ 摘要必须不同（否则摘要没有比对价值）
const redPw2 = redactAuditArgs('browser_type', { ref: 'e12', text: PW2 }, typeOut('password', PW2.length), null)
ok(redPw2.text.sha256 !== redPw.text.sha256, '两个不同口令的摘要不同（摘要可用于比对）')
ok(redPw2.text.len === PW2.length, '长度按各自的值算（中文口令按字符数）', redPw2.text.len)

// 失败路径：元素找不到/回读失败 → 没有 out.field，但错误里带着 type 事实 ⇒ 也必须脱敏
const argsErr = { selector: '#pw', text: PW }
const errPw = Object.assign(new Error('回读失败：目标元素不在了'), { fieldType: 'password' })
const redErr = redactAuditArgs('browser_type', argsErr, undefined, errPw)
ok(redErr.text && redErr.text.redacted === true, 'password 目标即使这次调用失败（没有 out），text 仍被脱敏', redErr.text)
ok(!trim(redErr, 4000).includes(PW), '失败路径的落盘文本同样不含明文')

// ---- ② 普通输入：原样保留（防"修过头"） ----
const argsPlain = { ref: 'e3', text: 'hello 世界 123', enter: true }
const redPlain = redactAuditArgs('browser_type', argsPlain, typeOut('text', 12), null)
ok(redPlain.text === 'hello 世界 123', '普通输入（type=text）的 text 原样保留', redPlain.text)
ok(redPlain.ref === 'e3' && redPlain.enter === true, '普通输入其它字段也原样保留', redPlain)
ok(trim(redPlain, 4000).includes('hello 世界 123'), '落盘文本里能看出当时打了什么（审计没被修废）')

// type 信息缺失（没给 ref/selector，所以没有回读）⇒ 不能"没证据也脱敏"，但也不能靠正则猜内容
const outNoField = { ok: true, typed: PW.length, enter: false }
const redNoField = redactAuditArgs('browser_type', { text: PW }, outNoField, null)
ok(redNoField.text === PW, '没有字段类型证据时不误伤（普通文本输入通道）', String(redNoField.text).slice(0, 12))

// 可操作性检查带回来的类型（out.__audit.fieldType）：被遮挡 / disabled / 回读失败这些
// **失败路径**上，password 也必须脱敏 —— 否则"密码框被浮层盖住"就绕过了脱敏
const outProbe = { ok: false, reason: 'covered', error: '元素被遮挡', __audit: { fieldType: 'password' } }
const redProbe = redactAuditArgs('browser_type', { ref: 'e9', text: PW }, outProbe, null)
ok(redProbe.text && redProbe.text.redacted === true, '被遮挡/disabled 的失败路径：用可操作性检查带回来的类型照样脱敏', redProbe.text)
ok(!trim(redProbe, 4000).includes(PW), '该失败路径的落盘文本不含明文')
// 同一个 __audit 通道如果是普通 text 字段 ⇒ 仍然原样（别把失败路径一律脱敏）
const outProbeText = { ok: false, reason: 'covered', error: '元素被遮挡', __audit: { fieldType: 'text' } }
ok(redactAuditArgs('browser_type', { ref: 'e9', text: 'covered-but-plain' }, outProbeText, null).text === 'covered-but-plain', '__audit.fieldType=text 时不被误脱敏（失败路径也不一刀切）')
// __audit 本身是内部字段：它不会出现在返回给 agent 的 out 里，但就算漏了也不该把类型信息当真参数落盘
ok(!JSON.stringify(redProbe).includes('__audit'), '脱敏结果里没有 __audit 这类内部字段（args 里本来也没有）')

// ---- ③ 通用兜底：键名命中敏感词，任何工具都脱敏 ----
// 每例显式声明"哪个键必须被脱敏"，避免断言选错键（上一版就踩了这个坑）
const fallbackCases = [
  ['browser_eval', 'password', { password: 'x-plain-1' }],
  ['browser_eval', 'token', { token: 'x-plain-2' }],
  ['browser_type', 'apiKey', { apiKey: 'x-plain-3' }],
  ['browser_open', 'authorization', { authorization: 'x-plain-4' }],
  ['browser_type', 'api_key', { api_key: 'x-plain-5' }],
  ['browser_type', 'cookie', { cookie: 'x-plain-6' }],
  ['browser_type', 'passwd', { passwd: 'x-plain-7' }],
  ['browser_type', 'secret', { secret: 'x-plain-8' }],
  ['browser_type', 'userPassword', { userPassword: 'x-plain-9' }],   // 复合键名
  ['browser_type', 'myToken', { nested: { myToken: 'x-plain-10' } }], // 嵌套一层
]
let fallbackBad = []
for (const [tool, key, a] of fallbackCases) {
  const red = redactAuditArgs(tool, a, typeOut('text', 3), null)
  const node = a[key] !== undefined ? red[key] : red[Object.keys(a)[0]][key]
  const val = a[key] !== undefined ? a[key] : a[Object.keys(a)[0]][key]
  const good = node && node.redacted === true && node.field === key && node.len === val.length && node.sha256 === sha12(val)
  if (!good) fallbackBad.push(tool + '/' + key + '→' + JSON.stringify(node))
}
ok(fallbackBad.length === 0, '通用兜底：password/passwd/token/apiKey/api_key/authorization/cookie/secret 及复合、嵌套键名全部脱敏（' + fallbackCases.length + ' 例）', fallbackBad)
const allFallbackText = fallbackCases.map(([tool, , a]) => trim(redactAuditArgs(tool, a, typeOut('text', 3), null), 4000)).join('\n')
const leakedFallback = fallbackCases.filter(([, , a]) => Object.values(a).some((v) => typeof v === 'string' && allFallbackText.includes(v))).map(([t, k]) => t + '/' + k)
ok(leakedFallback.length === 0, '通用兜底：10 个明文值一个都没落进最终文本', leakedFallback)
const fb1 = redactAuditArgs('browser_eval', { token: 'abc' }, null, null)
ok(fb1.token && fb1.token.redacted === true && fb1.token.field === 'token' && fb1.token.len === 3 && fb1.token.sha256 === sha12('abc'), '兜底脱敏结构含 field/len/sha256', fb1.token)
ok(!redactAuditArgs('browser_type', { note: 'hello' }, typeOut('text', 5), null).note.redacted, '键名不敏感的值不会被误脱敏', null)

// ---- ④ 其它字段不被误伤 ----
const argsWide = {
  ref: 'e77',
  selector: '#login-form input',
  url: 'https://example.com/a?b=c',
  text: PW,
  files: ['D:\\assets\\a.png', 'D:\\assets\\b.png'],
  amount: 42,
  ok: false,
}
const redWide = redactAuditArgs('browser_type', argsWide, typeOut('password', PW.length), null)
ok(redWide.ref === 'e77', 'ref 不被误伤', redWide.ref)
ok(redWide.selector === '#login-form input', 'selector 不被误伤', redWide.selector)
ok(redWide.url === 'https://example.com/a?b=c', 'url 不被误伤', redWide.url)
ok(Array.isArray(redWide.files) && redWide.files.length === 2 && redWide.files[1] === 'D:\\assets\\b.png', 'files 数组逐项原样保留', redWide.files)
ok(redWide.amount === 42 && redWide.ok === false, '数字/布尔字段类型不变', [redWide.amount, redWide.ok])
ok(redWide.text.redacted === true, '同一份 args 里只有 text 被脱敏（精确命中，不整条替换）')
// `D:\secrets\a.png` 这类**路径本身**不算敏感输入：不按内容扫，避免把正常路径也吃掉
const pathArgs = { files: ['D:\\secrets\\pw.png'] }
ok(redactAuditArgs('browser_upload', pathArgs, null, null).files[0] === 'D:\\secrets\\pw.png', '值里出现敏感词但键名正常 ⇒ 不误脱敏（只按键名判，不猜内容）', null)

// ---- ⑤ 异常入参不抛错 ----
let threw = null
const weird = [undefined, null, 0, '', 123, true, 'plain string', [], [1, 2], new Date('2026-09-12T00:00:00Z'), () => 1]
for (const w of weird) {
  try { redactAuditArgs('browser_type', w, typeOut('password', 3), null) } catch (e) { threw = String(w) + ' → ' + e.message }
}
ok(threw === null, 'null / undefined / 数字 / 字符串 / 数组 / 函数 等非对象入参都不抛错（' + weird.length + ' 例）', threw)
ok(redactAuditArgs('browser_type', undefined, undefined, undefined) === undefined, 'undefined 原样返回')
ok(redactAuditArgs('browser_type', null, null, null) === null, 'null 原样返回')
ok(Array.isArray(redactAuditArgs('browser_type', [1, 2], null, null)) && redactAuditArgs('browser_type', [1, 2], null, null)[1] === 2, '数组入参逐项处理且不炸', null)
let threw2 = null
try { redactAuditArgs('browser_type', { circ: null }, undefined, undefined) } catch (e) { threw2 = e.message }
ok(threw2 === null, '缺少 out/err 时（工具提前失败）不抛错', threw2)

// 不修改入参本身（留痕不能反过来污染工具的参数）
const orig = { ref: 'e1', text: PW }
const before = JSON.stringify(orig)
redactAuditArgs('browser_type', orig, typeOut('password', PW.length), null)
ok(JSON.stringify(orig) === before, '纯函数：入参 args 没被就地改动', orig.text && orig.text.slice(0, 4))

// ---- ⑥ 端到端：写进真文件的那行 JSONL 里没有明文 ----
const root = mkdtempSync(path.join(tmpdir(), 'bl-redact-'))
const fixed = new Date('2026-09-12T10:00:00Z')
const A = createAudit(path.join(root, 'audit'), { now: () => fixed })
const rec = A.audit('tool', {
  tool: 'browser_type',
  args: trim(redactAuditArgs('browser_type', argsPw, typeOut('password', PW.length), null), 4000),
  ok: true,
  ms: 42,
  backend: 'plugin',
  urlBefore: 'https://example.com/login',
  urlAfter: 'https://example.com/login',
  result: trim(typeOut('password', PW.length), 1500),
})
const onDisk = readFileSync(A.file(), 'utf8')
ok(!onDisk.includes(PW), '落盘文件里**任何位置**都不含口令明文', onDisk.length + ' 字节')
// args 在落盘时是 trim() 出来的**字符串**（既有口径，没改），所以这里解回来核对
const argsOnDisk = JSON.parse(JSON.parse(onDisk.split('\n')[0]).args)
ok(argsOnDisk.text && argsOnDisk.text.sha256 === sha12(PW) && argsOnDisk.text.len === PW.length, '落盘里留着长度与摘要', argsOnDisk.text)
ok(JSON.parse(onDisk.split('\n')[0]).result.includes('不回显'), 'result 那侧仍是原来的脱敏形态（page-read 的处理没动）', null)
ok(rec && rec.tool === 'browser_type' && rec.ok === true && rec.ms === 42 && rec.backend === 'plugin', '审计没有变成没用的一行：tool/ok/ms/backend 都在', rec && { tool: rec.tool, ok: rec.ok, ms: rec.ms, backend: rec.backend })
ok(rec.urlBefore === 'https://example.com/login' && rec.urlAfter === 'https://example.com/login', 'urlBefore/urlAfter 保留', [rec.urlBefore, rec.urlAfter])
ok(rec.err === undefined, '没失败时 err 仍是 undefined（字段语义没变）', String(rec.err))
ok(verifyChain(A.file()).ok === true, '脱敏后哈希链依然自洽（脱敏发生在写之前，链照旧）', verifyChain(A.file()))
// 失败记录也要有 err
const recErr = A.audit('tool', { tool: 'browser_type', args: trim(redactAuditArgs('browser_type', argsErr, undefined, errPw), 4000), ok: false, err: '回读失败：目标元素不在了', ms: 9 })
ok(recErr.ok === false && recErr.err.includes('回读失败') && !readFileSync(A.file(), 'utf8').includes(PW), '失败记录的 err 保留，且密码仍不明文', null)
try { rmSync(root, { recursive: true, force: true }) } catch {}

// ---- ⑦ 走**真包装器**（index.js 的 withAudit）——纯函数对而"接线漏了"正是这次的缺陷形态 ----
// 只 import 模块 + 调 execute，不起浏览器、不连网。
const home = mkdtempSync(path.join(tmpdir(), 'bl-redact-home-'))
process.env.DSH_HOME = home
let withAudit = null
try { withAudit = (await import('../index.js')).withAudit } catch (e) { /* 下面按 FAIL 记 */ }
ok(typeof withAudit === 'function', 'index.js 导出了 withAudit（离线可测的真包装器）', typeof withAudit)
if (typeof withAudit === 'function') {
  const calls = []
  const recs = []
  const fakeType = withAudit({
    name: 'browser_type',
    async execute(a) { calls.push(a); return typeOut('password', String(a.text).length) },
  })
  const outReal = await fakeType.execute({ ref: 'e5', text: PW }, {})
  ok(outReal && outReal.field && outReal.field.type === 'password', '包装器不改变工具返回值（结果形状原样透出）', outReal && outReal.field)
  const onDisk2 = readFileSync(path.join(home, 'dsh-browser-live', 'audit', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
  const last = JSON.parse(onDisk2.trim().split('\n').pop())
  ok(last.tool === 'browser_type', '包装器落盘的是 browser_type 那条', last.tool)
  ok(!last.args.includes(PW), '真包装器落盘后 args 里**没有口令明文**', last.args.slice(0, 160))
  ok(!onDisk2.includes(PW), '真包装器落盘的整行里也没有口令明文')
  const a2 = JSON.parse(last.args)
  ok(a2.text && a2.text.redacted === true && a2.text.len === PW.length && a2.text.sha256 === sha12(PW), '真包装器落盘的是"长度 + 摘要"结构', a2.text)
  ok(a2.ref === 'e5', '真包装器落盘里 ref 仍在（没被整条替换掉）', a2.ref)
  ok(last.ok === true && typeof last.ms === 'number' && last.result !== undefined, '真包装器仍保留 ok / ms / result', { ok: last.ok, ms: last.ms })

  // 普通输入走真包装器 ⇒ 审计里必须能看出打了什么
  const fakePlain = withAudit({ name: 'browser_type', async execute(a) { return typeOut('text', String(a.text).length) } })
  await fakePlain.execute({ ref: 'e6', text: '普通文本-keep' }, {})
  const d3 = JSON.parse(readFileSync(path.join(home, 'dsh-browser-live', 'audit', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8').trim().split('\n').pop())
  ok(d3.args.includes('普通文本-keep'), '普通输入走真包装器 ⇒ 审计里看得到原文（没被修废）', d3.args.slice(0, 120))

  // 工具失败时也要留一条且不含明文
  const fakeFail = withAudit({ name: 'browser_type', async execute() { const e = new Error('回读失败：目标元素不在了'); e.fieldType = 'password'; throw e } })
  let thrown = null
  try { await fakeFail.execute({ selector: '#pw', text: PW }, {}) } catch (e) { thrown = e }
  const d4 = JSON.parse(readFileSync(path.join(home, 'dsh-browser-live', 'audit', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8').trim().split('\n').pop())
  ok(!!thrown && d4.ok === false && d4.err.includes('回读失败'), '工具抛错时错误照旧抛给调用方，且留了一条 ok:false 的记录', d4.err)
  ok(!d4.args.includes(PW), '失败记录里同样没有口令明文（不会"一失败就漏"）', d4.args.slice(0, 160))
  // 真包装器生成的留痕链必须仍然自洽
  ok(verifyChain(path.join(home, 'dsh-browser-live', 'audit', new Date().toISOString().slice(0, 10) + '.jsonl')).ok === true, '真包装器写出的留痕链自洽', null)
}
try { rmSync(home, { recursive: true, force: true }) } catch {}

console.log('')
if (fails.length) { console.error('FAIL ' + fails.length + ' 项：'); for (const f of fails) console.error('  - ' + f); process.exit(1) }
console.log('PASS ' + pass + ' 项 —— 敏感输入落盘前已脱敏（password 字段只留长度+摘要），普通输入原样保留')
