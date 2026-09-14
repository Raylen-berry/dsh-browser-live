// dsh-browser-live · 留痕 (audit)
// ============================================================================
// 为什么是独立模块：这段逻辑必须能被**离线测试**（tools/verify-audit.mjs 直接 import 它），
// 而不是塞在 136KB 的 index.js 里靠"跑起来才知道对不对"。
//
// 设计（2026-09-12 用户要求「全量留痕」，起因是"agent 会不会开了浏览器操作完再自己关掉、
// 让我查不到他干了什么"）：
//  1. **追加写、永不重写**：一天一个文件 `<baseDir>/audit/YYYY-MM-DD.jsonl`，
//     只 appendFileSync，不做任何 read-modify-write —— 没有"覆盖"这条路径。
//  2. **哈希链**：每条记录带 `prev` = 上一条**原始行文本**的 sha256 前 20 位。
//     删掉一行、改一行，后面那条的 prev 就对不上 ⇒ 能查出"少了/动过哪一条"。
//  3. 只依赖 node 内置模块，失败一律吞掉（留痕坏了不能让浏览器功能跟着坏），
//     但失败计数留在 stats() 里，可以被自检看到。
//
// **能力边界（必须说清）**：哈希链能发现"删行/改行"，但**不能**防住同时拥有写权限的人
// 重算整条链 —— 它挡的是"悄悄抹掉一两步"，不是密码学意义上的防篡改。真要不可抹，
// 得把日志实时送到 agent 够不到的另一个人/进程/机器上。
// ============================================================================

import { appendFileSync, mkdirSync, openSync, closeSync, fstatSync, readSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const lineHash = (line) => createHash('sha256').update(line).digest('hex').slice(0, 20)

/** 当天文件名主干：YYYY-MM-DD（**不带扩展名** —— 扩展名由 fileFor 统一加 '.jsonl'，
 *  两处都加会写成 2026-09-12.jsonl.jsonl，端到端跑的时候真踩到过）。 */
export const auditFileName = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function createAudit(baseDir, { maxArgChars = 4000, maxResChars = 1500, now = () => new Date(), tailBytes = 16384 } = {}) {
  let day = ''
  let prev = null
  let writes = 0
  let fails = 0
  let lastError = ''

  const fileFor = (d) => path.join(baseDir, d + '.jsonl')

  /** 读文件最后一行的 h（只读文件末尾 tailBytes，避免大文件整读）。读不到就 null。 */
  function tailHash(file) {
    let fd
    try {
      fd = openSync(file, 'r')
      const size = fstatSync(fd).size
      if (!size) return null
      const len = Math.min(size, tailBytes)
      const buf = Buffer.allocUnsafe(len)
      readSync(fd, buf, 0, len, size - len)
      const txt = buf.toString('utf8')
      // 末尾可能正好是 '\n'（正常情况）：先砍掉，再取最后一行
      const trimmed = txt.endsWith('\n') ? txt.slice(0, -1) : txt
      const i = trimmed.lastIndexOf('\n')
      const last = trimmed.slice(i + 1).trim()
      if (!last) return null
      const rec = JSON.parse(last)
      return typeof rec.h === 'string' ? rec.h : null
    } catch { return null } finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } } }
  }

  /** 写一条。type 建议用 'tool' / 'nav' / 'boot' / 'note'。永不抛错。
   *  `h` = 本条内容（不含 h 本身）的 hash，**既写进文件也返回** —— 写进文件是为了
   *  第二天/重启后续写时能把链接上（离线自检抓到过"只返回不落盘"导致链断的 bug）。
   *
   *  **链尾以文件为准，不信内存**（v0.12.0 修）：原来只在"跨天"时才读一次文件尾，
   *  同一天里默认内存里的 prev 是对的 —— 但同一天里可能有**第二个写入者**：
   *  2026-09-14 实测踩到，插件被重新 apply 后旧实例的 AUDIT 仍在写（DSH 的插件生命周期），
   *  于是两条线各自记着自己的链尾，第 16 行接回了第 14 行 ⇒ 链断。
   *  这不是"谁把行删了"，却和删行长得一模一样（这正是哈希链不该误报的地方）。
   *  现在每次写之前都读一次文件尾（只读末尾 16KB），prev 是**文件的事实**而不是进程的记忆。 */
  function audit(type, data = {}) {
    try {
      const d = auditFileName(now())
      if (d !== day) { day = d; prev = null }
      const tail = tailHash(fileFor(d))
      if (tail !== prev) prev = tail
      const rec = { t: now().toISOString(), type, ...data, prev }
      const h = lineHash(JSON.stringify(rec))
      mkdirSync(baseDir, { recursive: true })
      appendFileSync(fileFor(d), JSON.stringify({ ...rec, h }) + '\n', 'utf8')
      prev = h
      writes++
      return { ...rec, h }
    } catch (e) {
      fails++
      lastError = String((e && e.message) || e)
      return null
    }
  }

  return {
    audit,
    file: () => fileFor(day || auditFileName(now())),
    dir: () => baseDir,
    stats: () => ({ writes, fails, lastError, day, prev }),
  }
}

/** 把任意值压成一行可读文本；超长按 maxChars 截断并**显式标注**截了多少字（不假装完整）。 */
export function trim(v, maxChars) {
  if (v === undefined) return undefined
  let s
  try { s = typeof v === 'string' ? v : JSON.stringify(v) } catch { return '[无法序列化]' }
  if (s === undefined) return undefined
  return s.length > maxChars ? s.slice(0, maxChars) + `…[截断，原文 ${s.length} 字]` : s
}

// ---------------------------------------------------------------------------
// 落盘前的敏感输入脱敏（P1 隐私泄漏修复）
// ---------------------------------------------------------------------------
// 缺陷：`browser_type` 的**返回值**是脱敏过的（password 字段只回长度不回显，
// page-read.js 的 READBACK_FN），但索引里落盘的 **args.text 是原文** —— 于是
// "往密码框里打的字"原样写进了 append-only 的审计日志，且日志是持久化的。
// 修法口径：**敏感输入只留字段名、长度和摘要，不留内容**；普通输入保持原样
// （留痕的价值就在于能看出当时打了什么，一刀切会把审计变成废物）。
//
// 判据（不靠肉眼正则猜密码串）：
//  ① `browser_type`：这次输入的**目标是不是 password 字段** —— 从工具返回值里认，
//     即 out.field.type === 'password'（page-read.js 的 readbackInPage 回读出来的
//     元素 type，是浏览器自己的事实，不是我们猜的）。此时只脱敏其 `text`。
//  ② 通用兜底：args 里**键名**命中敏感词（含嵌套）的值一律脱敏，与哪个工具无关。
//     键名是调用方写下的语义标签，比猜内容可靠。
// 纯函数：不读 DOM、不发请求、不读文件，离线可断言。
// ---------------------------------------------------------------------------

/** 键名命中即视为敏感（大小写/下划线无关，lastpass / my_token / user_password 都算）。 */
const SENSITIVE_KEY = /(password|passwd|passphrase|secret|token|authorization|auth|apikey|api_?key|access_?key|cookie|credential|session_?id|otp)/i

/** 值摘要：长度 + sha256 前 12 位。够用来比对"两次是不是同一个值"，但不泄漏内容。 */
const digest12 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 12)

/** 脱敏后的占位结构。`field` 是字段名（便于知道脱敏的是哪一项）。
 *  摘要算在**原始值的稳定序列化**上：同一个值两次调用得到同一个摘要，才好比对。 */
export function redactedValue(field, v) {
  let s = String(v)
  if (typeof v !== 'string') { try { s = JSON.stringify(v) ?? String(v) } catch { s = String(v) } }
  return { redacted: true, field, len: s.length, sha256: digest12(s) }
}

/** 目标这次是不是 password 字段？只认"返回值里带 type 信息"这条——不猜内容。
 *  三个来源都来自浏览器自己：① 成功时的回读 `field.type`；② 可操作性检查带回来的
 *  元素 `type`（browser_type 放在 out.__audit.fieldType，被遮挡/disabled/回读失败这些
 *  失败路径也有）；③ 工具抛错时挂在 error 上的 `fieldType`。 */
function isPasswordTarget(out, err) {
  const fromReadback = out && out.field && String(out.field.type || '').toLowerCase() === 'password'
  if (fromReadback) return true
  const fromProbe = out && out.__audit && String(out.__audit.fieldType || '').toLowerCase() === 'password'
  if (fromProbe) return true
  const fromErr = err && err.fieldType && String(err.fieldType).toLowerCase() === 'password'
  return !!fromErr
}

/**
 * 返回**要落盘的 args 副本**（不改入参）。签名里保留 toolName/out/err 三个入参，
 * 就是为了让判据来自"工具自己的返回值"，而不是靠调用参数猜。
 */
export function redactAuditArgs(toolName, args, out, err) {
  if (args === null || args === undefined) return args
  if (typeof args !== 'object') return args          // 标量入参：没有键名可判，原样返回
  if (Array.isArray(args)) return args.map((v) => redactAuditArgs(toolName, v, out, err))

  const pwTarget = toolName === 'browser_type' && isPasswordTarget(out, err)
  // 注意 walk 的**键名优先**：命中敏感词就地整块脱敏，不再往里递归 —— 递归就得先看一眼
  // 那个值，而"先看一眼再决定要不要脱敏"正是这类泄漏的来源。
  const walk = (v, key) => {
    if (typeof key === 'string' && SENSITIVE_KEY.test(key)) return redactedValue(key, v)
    if (pwTarget && key === 'text') return redactedValue('text', v)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {}
      for (const [k2, v2] of Object.entries(v)) o[k2] = walk(v2, k2)
      return o
    }
    return v
  }

  const copy = {}
  for (const [k, v] of Object.entries(args)) copy[k] = walk(v, k)
  return copy
}

/** 校验一条 JSONL 留痕文件的哈希链。返回 { ok, lines, records, brokenAt, reason }。
 *  两道检查：① 每条自己的 h 与内容对得上（防"改内容"）② 每条 prev 指向上一条的 h（防"删/插行"）。 */
export function verifyChain(file) {
  let txt
  try { txt = readFileSync(file, 'utf8') } catch (e) { return { ok: false, lines: 0, records: 0, reason: '读不到文件：' + String(e.message || e) } }
  const raw = txt.split('\n').filter((l) => l.trim())
  let prevExpected = null
  for (let i = 0; i < raw.length; i++) {
    let rec
    try { rec = JSON.parse(raw[i]) } catch { return { ok: false, lines: raw.length, records: i, brokenAt: i + 1, reason: '第 ' + (i + 1) + ' 行不是合法 JSON' } }
    const { h, ...rest } = rec
    if (typeof h !== 'string' || lineHash(JSON.stringify(rest)) !== h) {
      return { ok: false, lines: raw.length, records: i, brokenAt: i + 1, reason: '第 ' + (i + 1) + ' 行的内容与它自己的 h 对不上（这一行被改过）' }
    }
    if ((rec.prev || null) !== prevExpected) {
      return { ok: false, lines: raw.length, records: i, brokenAt: i + 1, reason: '第 ' + (i + 1) + ' 行的 prev 与上一条对不上（它前面被删过或插过行）' }
    }
    prevExpected = h
  }
  return { ok: true, lines: raw.length, records: raw.length }
}
