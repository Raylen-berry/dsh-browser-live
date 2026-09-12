// verify-launcher: 启动链上两条"只有真实机器才暴露"的坑的回归测试。
//
// ① VBS 独立启动器的编码：wscript 默认按 ANSI 代码页读 .vbs。脚本里的路径只要含中文
//    （C:\Users\陈道云\…），用 UTF-8 写出来就会被读成 C:\Users\闄堥亾浜慭\… —— 一条不存在的
//    路径，浏览器一个进程都起不来，而对外表现只是"未响应 CDP 端口"，极难定位。
//    本机实测踩过，还在 C:\Users 下留了乱码目录。所以：必须 UTF-16LE + BOM，且能原样读回。
//
// ② 候选浏览器是**列表**且顺序稳定：首选浏览器起不来时要能退到下一个，
//    而不是让整个插件不可用（实测：DSH Desktop 以管理员身份运行时 Chrome 起不来、Edge 可以）。
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label, detail) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (detail !== undefined ? ' → ' + JSON.stringify(detail) : '')) } }
const eq = (a, b, label) => ok(a === b, label, { got: a, want: b })

// 用假 ctx 加载 host（verify-host.mjs 的同一套最小替身）
const tools = new Map()
const ctx = {
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
  get: () => undefined,
  inject: () => {},
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
}
const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href + '?launcher')
await mod.apply(ctx, { userBridge: false })

console.log('\nA. VBS 启动器的编码（中文路径不能被写成乱码）')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'bl-launcher-'))
  const cn = path.join(dir, '陈道云 的目录', 'chrome.exe')      // 故意含中文 + 空格
  mkdirSync(path.dirname(cn), { recursive: true })
  writeFileSync(cn, 'stub')
  const args = ['--remote-debugging-port=9601', `--user-data-dir=${path.join(dir, '陈道云 profile')}`, 'about:blank']
  const vbs = mod.writeDetachedLauncher(cn, args)
  const buf = readFileSync(vbs)
  ok(buf[0] === 0xff && buf[1] === 0xfe, 'VBS 以 UTF-16LE BOM（FF FE）开头 —— wscript 才会按 Unicode 读', [...buf.slice(0, 2)])
  const text = buf.toString('utf16le').replace(/^\ufeff/, '')
  ok(text.includes(cn), '中文 exe 路径被原样写进脚本（没有被写成本机代码页乱码）', { hasRaw: text.includes(cn) })
  ok(text.includes('陈道云 profile'), '中文 --user-data-dir 同样原样保留')
  ok(!/[\uFFFD]/.test(text), '脚本里没有替换字符（说明解码正确）')
  ok(text.includes('WScript.Shell') && /sh\.Run ".*", 1, False/.test(text), '仍是可执行的独立启动器（sh.Run …, 1, False）')
  rmSync(dir, { recursive: true, force: true })
}

console.log('\nB. 候选浏览器列表与顺序')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'bl-cand-'))
  const fake = path.join(dir, 'brave.exe')
  writeFileSync(fake, 'stub')
  process.env.DSH_BROWSER_LIVE_CHROME = fake
  const list = mod.findChromiumExes()
  ok(Array.isArray(list) && list.length >= 1, 'findChromiumExes() 返回候选数组', list)
  // 设置里的 chromePath 允许排在最前（那是用户显式指定），除此之外环境变量指定的必须最靠前
  ok(list.includes(fake) && list.indexOf(fake) <= 1, '环境变量指定的浏览器是首选（仅让位于用户显式配置的 chromePath）', list)
  ok(list.every((p) => typeof p === 'string' && p.length > 0), '候选都是非空字符串路径')
  const again = mod.findChromiumExes()
  eq(again.length, list.length, '重复调用结果稳定（不会随调用次数变长）')
  ok(new Set(list).size === list.length, '候选里没有重复项')
  delete process.env.DSH_BROWSER_LIVE_CHROME
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail ? '✗' : '✓'} verify-launcher: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
