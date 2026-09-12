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

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const lineHash = (line) => createHash('sha256').update(line).digest('hex').slice(0, 20)

/** 当天文件名主干：YYYY-MM-DD（**不带扩展名** —— 扩展名由 fileFor 统一加 '.jsonl'，
 *  两处都加会写成 2026-09-12.jsonl.jsonl，端到端跑的时候真踩到过）。 */
export const auditFileName = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function createAudit(baseDir, { maxArgChars = 4000, maxResChars = 1500, now = () => new Date() } = {}) {
  let day = ''
  let prev = null
  let writes = 0
  let fails = 0
  let lastError = ''

  const fileFor = (d) => path.join(baseDir, d + '.jsonl')

  /** 续写已有文件时，把链尾接上（否则重启后第一条的 prev 会是 null、链看起来断了）。 */
  function tailHash(file) {
    try {
      const txt = readFileSync(file, 'utf8')
      const i = txt.lastIndexOf('\n', txt.length - 2)
      const last = txt.slice(i + 1).trim()
      if (!last) return null
      const rec = JSON.parse(last)
      return typeof rec.h === 'string' ? rec.h : null
    } catch { return null }
  }

  /** 写一条。type 建议用 'tool' / 'nav' / 'boot' / 'note'。永不抛错。
   *  `h` = 本条内容（不含 h 本身）的 hash，**既写进文件也返回** —— 写进文件是为了
   *  第二天/重启后续写时能把链接上（离线自检抓到过"只返回不落盘"导致链断的 bug）。 */
  function audit(type, data = {}) {
    try {
      const d = auditFileName(now())
      if (d !== day) { day = d; prev = tailHash(fileFor(d)) }
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
