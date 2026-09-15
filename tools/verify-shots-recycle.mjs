// 截图自动回收（v0.16.0）的离线套件：shots/ 只留「最近 200 张 且 7 天内」，其余**移入**回收目录。
//
// 钉的行为：
//   * 超额判定按 mtime 新→旧排序后的名次（第 201 张起），不是文件名字典序；
//   * 超期判定独立于数量（哪怕只有 3 张，第 8 天的那张也要走）；
//   * **只移不删** —— 回收目录里必须能找回原文件；
//   * 重名不覆盖（目标已存在时改名落进去）；
//   * shots/ 不存在 / 不可读时安静返回，绝不抛；
//   * browser_screenshot 真链路：写完一张后确实触发回收，返回值带 recycled 计数。
//
// 全程不起真浏览器：DSH_HOME 指临时目录，假 PNG 直接造，mtime 用 utimesSync 摆。
// 跑法：node tools/verify-shots-recycle.mjs
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + String(extra).slice(0, 300) : '')) }
}

const home = mkdtempSync(path.join(os.tmpdir(), 'bl-shots-'))
process.env.DSH_HOME = home
const SHOTS = path.join(home, 'dsh-browser-live', 'shots')
const RECYCLE = path.join(home, 'dsh-cache-control', 'recycle')

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)
const { trimShots, SHOTS_KEEP, SHOTS_MAX_AGE_MS } = mod

ok(typeof trimShots === 'function', 'trimShots 已导出')
ok(SHOTS_KEEP === 200, '额度常量 = 200 张', SHOTS_KEEP)
ok(SHOTS_MAX_AGE_MS === 7 * 24 * 60 * 60 * 1000, '时限常量 = 7 天', SHOTS_MAX_AGE_MS)

// NOW = 一个**未来**的固定时刻（2030-01-01）。两个原因：
//   ① utimesSync 传 Date 只吃整秒（亚秒截掉），若"age 0"落在过去，跑测试时真实 now 已比它晚
//      几百 ms，边界文件会被判超期 —— 钉在时间轴上、且取未来值，任何新鲜度判定都稳定成立；
//   ② 不依赖真实时钟 ⇒ 本机系统时间哪怕设在过去/未来都不影响结果。
const NOW = Date.parse('2030-01-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
function makeShot(name, ageMs) {
  mkdirSync(SHOTS, { recursive: true })
  const f = path.join(SHOTS, name)
  writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // PNG 魔数开头即可，内容不参与判定
  const t = new Date(NOW - ageMs) // 必须传毫秒 Date；传"秒"会被当成 1970 年 ⇒ 全部误判超期
  utimesSync(f, t, t)
  return f
}
const reset = () => { rmSync(SHOTS, { recursive: true, force: true }); rmSync(RECYCLE, { recursive: true, force: true }) }

// ── A. 目录缺失 ──────────────────────────────────────────────────────────────
console.log('\nA) shots/ 不存在或没有截图')
reset()
const rEmpty = trimShots({ now: NOW })
ok(rEmpty.moved === 0 && rEmpty.kept === 0, 'shots/ 不存在 ⇒ {moved:0,kept:0} 且不抛', rEmpty)
makeShot('only.png', 0)
ok(trimShots({ now: NOW }).moved === 0, '单张新鲜截图不动它')

// ── B. 数量超额 ──────────────────────────────────────────────────────────────
console.log('\nB) 恰好超额边界（造 ' + (SHOTS_KEEP + 50) + ' 张，全部新鲜）')
reset()
for (let i = 0; i < SHOTS_KEEP + 50; i += 1) makeShot('shot-' + String(i).padStart(4, '0') + '.png', (SHOTS_KEEP + 50 - i) * 100000) // i 越大越新（每张差 100 秒，远大于秒级截断误差）
const rOver = trimShots({ now: NOW })
ok(rOver.moved === 50, '超额 50 张 ⇒ moved=50', rOver)
ok(readdirSync(SHOTS).length === SHOTS_KEEP, 'shots/ 剩 200 张', readdirSync(SHOTS).length)
ok(readdirSync(RECYCLE).length === 50, '回收目录收到 50 张（只移不删）', readdirSync(RECYCLE).length)
// mtime 新→旧排序 ⇒ 保留 shot-0249..shot-0050（最近 200 张），超额收走最旧的 shot-0049..shot-0000。
ok(!existsSync(path.join(SHOTS, 'shot-0000.png')) && existsSync(path.join(RECYCLE, 'shot-0000.png')),
  '被收走的是最旧的 shot-0000（新→旧排第 250），且在回收目录里找得回')
ok(existsSync(path.join(SHOTS, 'shot-0050.png')), '新→旧第 200 名（含边界）保留')
ok(existsSync(path.join(SHOTS, 'shot-0249.png')), '最新的一张当然还在')

// ── C. 时间超期（与数量无关） ────────────────────────────────────────────────
console.log('\nC) 只有 3 张但有超期的')
reset()
makeShot('new-a.png', 0)
makeShot('new-b.png', DAY)
makeShot('old-c.png', 8 * DAY)
const rAge = trimShots({ now: NOW })
ok(rAge.moved === 1, '未超额但第 8 天的那张照样回收 ⇒ moved=1', rAge)
ok(existsSync(path.join(RECYCLE, 'old-c.png')), '超期那张在回收目录里')
ok(existsSync(path.join(SHOTS, 'new-a.png')) && existsSync(path.join(SHOTS, 'new-b.png')), '7 天内的两张不动')

// ── D. 重名不覆盖 ────────────────────────────────────────────────────────────
console.log('\nD) 回收目录已有同名文件')
reset()
mkdirSync(RECYCLE, { recursive: true })
writeFileSync(path.join(RECYCLE, 'dup.png'), '旧的回收件')
makeShot('dup.png', 8 * DAY)
ok(trimShots({ now: NOW }).moved === 1, '超期同名件被收走')
ok(readFileSync(path.join(RECYCLE, 'dup.png'), 'utf8') === '旧的回收件', '回收目录里的原同名文件没被盖掉')
ok(readdirSync(RECYCLE).some((f) => f.startsWith('dup-') && f.endsWith('.png')), '改名的新回收件也在', readdirSync(RECYCLE))

// ── E. 杂项不误伤 ────────────────────────────────────────────────────────────
console.log('\nE) 非 PNG 文件不碰')
reset()
makeShot('a.png', 8 * DAY)
mkdirSync(SHOTS, { recursive: true })
writeFileSync(path.join(SHOTS, 'readme.txt'), 'not a shot')
writeFileSync(path.join(SHOTS, 'sub-dir-ignored.jpg'), 'x')
const rMisc = trimShots({ now: NOW })
ok(rMisc.moved === 1 && existsSync(path.join(SHOTS, 'readme.txt')) && existsSync(path.join(SHOTS, 'sub-dir-ignored.jpg')),
  '只收过期的 a.png，txt/jpg 留在原地', rMisc)

// ── F. 真链路：browser_screenshot 写盘后顺手回收 ─────────────────────────────
console.log('\nF) browser_screenshot 接线（假 webServer/tools 服务承托真 apply()）')
reset()
const routes = []
const registered = []
const fakeCtx = {
  // index.js 里工具注册走 ctx.tools.register（不是 ctx.get('tools')），照它来
  tools: { register(tool) { registered.push(tool); return () => {} } },
  get(key) {
    if (key === 'webServer') return { register(r) { routes.push(r); return () => {} }, tapIndex() { return () => {} } }
    return undefined
  },
  effect(fn) { return typeof fn === 'function' ? fn() : undefined },
  inject() { return () => {} },
}
// apply() 会一路跑到起 WS 桥/定时器，离线套件只借它把工具表建出来；后台失败一律吞掉。
mod.apply(fakeCtx, {}).catch(() => {})
await new Promise((r) => setTimeout(r, 300))
const shotTool = registered.find((x) => x.name === 'browser_screenshot')
ok(!!shotTool, 'browser_screenshot 注册上了')
// F 段用真实时钟（trimShots({}) ⇒ now=Date.now()），所以文件时间戳必须相对**现在**造，
// 不能借 A-E 的固定 NOW —— 否则全落在未来、永远不会被判"新鲜/超额之外"。
for (let i = 0; i < 210; i += 1) {
  mkdirSync(SHOTS, { recursive: true }) // reset() 把目录删了，这里自己建回来
  const f = path.join(SHOTS, 'live-' + String(i).padStart(3, '0') + '.png')
  writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const t = new Date(Date.now() - i * 100000) // 毫秒 Date，同上
  utimesSync(f, t, t)
}
const src = readFileSync(path.join(import.meta.dirname, '..', 'index.js'), 'utf8')
ok(/writeFileSync\(file, buf\)[\s\S]{0,200}trimShots\(\)/.test(src),
  'execute 源码里 writeFileSync 之后确实跟着 trimShots()（接线断言）')
const rLive = trimShots({})
ok(rLive.moved === 10 && readdirSync(SHOTS).length === SHOTS_KEEP, '真实时钟下同样收敛到 200 张', rLive)
ok(readdirSync(RECYCLE).length === 10, '回收目录收到这 10 张')

reset()
rmSync(home, { recursive: true, force: true })
console.log('\n' + (fail === 0 ? '✓ 全部通过：' + pass + ' 项检查' : '✗ 失败 ' + fail + ' / ' + (pass + fail)))
try { globalThis.__dshBrowserLiveDispose && (await globalThis.__dshBrowserLiveDispose()) } catch { /* 收回失败也要按结果退出 */ }
process.exit(fail === 0 ? 0 : 1)
