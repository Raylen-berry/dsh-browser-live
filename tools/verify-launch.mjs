// v0.6.3 新增：独立启动器 + 窗口自查（这两条以前完全没测试覆盖）
//   1) writeDetachedLauncher：写出的 VBS 必须能安全跑起来，尤其**含空格/引号的路径**（Chrome 装到
//      "Program Files"、profile 路径带空格都很常见），引号转义错一个字符，Chrome 就永远起不来、
//      而且失败是静默的（wscript 不报错）—— 所以要逐条断言。
//   2) reportWindowState：真起一个假 CDP（HTTP /json/list + WS），断言它能把 Chrome 自报的
//      窗口状态翻译成人能读的结论，并且窗口过小时会下发 setWindowBounds 修到设置里的尺寸。
// 跑法：node tools/verify-launch.mjs
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, cpSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = mkdtempSync(path.join(os.tmpdir(), 'bl-launch-'))
process.env.DSH_HOME = home
const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)

// ---------------------------------------------------------------- 1) 启动器 VBS
const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const args = [
  '--remote-debugging-port=9777',
  '--remote-allow-origins=*',
  '--user-data-dir=C:\\Users\\Bob Smith\\AppData\\Roaming\\dsh-desktop\\harness\\dsh-browser-live\\chrome-profile',
  '--no-first-run',
  '--window-size=1440,900',
  'about:blank',
]
const vbs = mod.writeDetachedLauncher(exe, args)
ok(typeof vbs === 'string' && existsSync(vbs), 'writeDetachedLauncher 落盘了 VBS', String(vbs))
// v0.8.2 起 VBS 必须写 **UTF-16LE + BOM**：wscript 默认按本机 ANSI 代码页读 .vbs，
// 而用户名/路径里只要有中文（C:\Users\陈道云\…），UTF-8 写出来的就会被读成
// `C:\Users\闄堥亾浜慭\…` —— 一条不存在的路径，浏览器一个进程都不会起，且失败是静默的。
// 所以这里既断言字节序标记，也断言能按 UTF-16 原样读回。
const rawVbs = readFileSync(vbs)
ok(rawVbs[0] === 0xff && rawVbs[1] === 0xfe, 'VBS 以 UTF-16LE BOM（FF FE）开头 —— wscript 才会按 Unicode 读', [...rawVbs.slice(0, 2)])
const src = rawVbs.toString('utf16le').replace(/^\ufeff/, '')
ok(/WScript\.Shell/.test(src), '用 WScript.Shell（不依赖任何外部程序）')
ok(/sh\.Run .*,\s*1,\s*False/.test(src), 'Run 的窗口样式=1 且不等待（False）—— 可见窗口 + 立刻返回')
ok(src.includes('""' + exe + '""') || src.includes('"' + exe + '"'), 'Chrome 路径原样带引号（含空格的 Program Files 路径）', src.split('\r\n')[2])
ok(src.includes('Bob Smith'), '带空格的 user-data-dir 被完整保留', src)
ok((src.match(/--user-data-dir=/g) || []).length === 1, '每个参数只出现一次（没有重复拼接）')
ok(!/\r\n\r\n\r\n/.test(src), '没有意外的空行堆积')
ok(src.includes('sh.CurrentDirectory'), '设了 CurrentDirectory（Chrome 的工作目录不依赖启动器 cwd）')

// 中文用户名：这是本机真实踩过的坑（乱码路径 + C:\Users 下留下乱码目录），单独钉一条
const cnVbs = mod.writeDetachedLauncher('C:\\Users\\陈道云\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ['--user-data-dir=C:\\Users\\陈道云\\prof', 'about:blank'])
const cnSrc = readFileSync(cnVbs, 'utf16le').replace(/^\ufeff/, '')
ok(cnSrc.includes('陈道云') && !cnSrc.includes('闄堥亾浜'), '中文用户名原样保留（不会被写成本机代码页乱码）')
ok(!cnSrc.includes('\ufffd'), '脚本里没有替换字符（说明按 UTF-16 解码正确）')

// 反例：参数里带引号时，VBScript 字符串必须把 " 变成 ""（否则脚本直接语法错，静默失败）
const tricky = mod.writeDetachedLauncher(exe, ['--user-data-dir=C:\\a"b\\c', 'about:blank'])
const trickySrc = readFileSync(tricky, 'utf16le').replace(/^\ufeff/, '')
ok(!/[^"]"[^"]*"[^"]*"[^"]*"[^"]*\.exe/.test(trickySrc) || trickySrc.includes('""'), '参数含引号时做了 "" 转义', trickySrc.split('\r\n')[2])

// ---------------------------------------------------------------- 1b) loadWs 的两种导出形状
//
// 产品缺陷（本套件此前 13 passed / 4 failed 的真因）：loadWs() 曾写 `m.default || m`，然后调用处
// `const { WebSocket } = await loadWs()`。npm 'ws' 两种布局的导出形状不同：
//   · **裸包名** 'ws'（走 package.json 的 exports → wrapper.mjs）：WebSocket 是**具名导出**，
//     default = WebSocket **类本身** —— 类上没有 .WebSocket ⇒ 解构得 undefined。
//   · **直接文件路径**（DSH 安装目录那种布局，index.js 尾部 `WebSocket.WebSocket = WebSocket` 自引用）：
//     default = module.exports，上面**有** .WebSocket ⇒ 恰好能用。
// 所以"本机全绿、干净机器/CI 全红"。下面用临时目录把两种布局各测一遍：
// 路径候选必须不同（否则 ESM 按 URL 缓存，第二次拿到的是第一次的模块）。
const wsLayoutRoot = mkdtempSync(path.join(os.tmpdir(), 'bl-ws-layout-'))
// 夹具里留一个占位符 @@SENTINEL@@，用 replace 填真实值（不直接内插，模板与替换分开更好核对；
// 也不能写成 ${...} 的形式 —— 那是模板插值语法，会被当场求值）。
const FIX_SENTINEL = '@@SENTINEL@@'
// 仿 ws/lib/websocket.js 的角色：只导出类本体，**不带** .WebSocket 自引用。
// real ws 的 wrapper.mjs 正是 `export { WebSocket }; export default WebSocket;`，
// 而它的 default 来自 lib/websocket.js —— 所以 default 上没有 .WebSocket。
const FIX_CLASS_JS = `'use strict'
class WebSocket {
  constructor(url) {
    // 不校验 url：探针要用"无参构造"给取到的构造器打指纹（夹具的构造函数是纯净的，
    // 只会记一笔 SENTINEL；真 npm ws 无参会抛 url 类型错，正好用来区分"取到的是谁"）。
    this.url = url
    globalThis.__wsBindings = (globalThis.__wsBindings || []).concat(this.constructor.SENTINEL || '?')
  }
  on() {} close() {}
}
WebSocket.SENTINEL = '@@SENTINEL@@'
module.exports = WebSocket
`
// 仿 ws/index.js 的角色：把具名导出挂回类上，再整体导出（`WebSocket.WebSocket = WebSocket` 自引用）。
// **直接文件路径**那一档走的就是这个文件，所以 .WebSocket 存在 —— 这是它"恰好能用"的原因。
const FIX_INDEX_JS = `'use strict'
const WebSocket = require('./class.js')
WebSocket.SENTINEL = '@@SENTINEL@@'
WebSocket.WebSocket = WebSocket
WebSocket.default = WebSocket
module.exports = WebSocket
`
function writeFixture(dir, sentinel) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'class.js'), FIX_CLASS_JS.replace(FIX_SENTINEL, sentinel), 'utf8')
  writeFileSync(path.join(dir, 'index.js'), FIX_INDEX_JS.replace(FIX_SENTINEL, sentinel), 'utf8')
  // 等价于 ws 的 wrapper.mjs：default 与具名导出**都指向同一个类本体**
  writeFileSync(path.join(dir, 'wrapper.mjs'),
    `import W from './class.js'\nexport default W\nexport const WebSocket = W\n`, 'utf8')
  return dir
}
// ① 裸包名的形状：package.json 声明 exports → wrapper.mjs（等价于 ws 发的 wrapper.mjs）。
// 包名故意**不叫 'ws'**：夹具在临时目录、而 PROBE_REPO 指向仓库里的 index.js，
// 裸 'ws' 会先被仓库自己的 node_modules/ws 解析走（Node 按导入方文件所在目录逐级向上找，不看 cwd），
// 于是夹具根本轮不上、断言测的还是真包。换个专用名字才能真正钉住夹具；
// 这里要测的是"命名空间的形状"，与包名无关。
const FIX_BARE_NAME = '__bl_fixture_ws__'
const bareRoot = path.join(wsLayoutRoot, 'bare')
const bareDir = writeFixture(path.join(bareRoot, 'node_modules', FIX_BARE_NAME), 'BARE')
writeFileSync(path.join(bareDir, 'package.json'),
  JSON.stringify({ name: FIX_BARE_NAME, version: '0.0.0-fixture', main: './index.js', exports: { '.': { import: './wrapper.mjs', require: './index.js' } } }), 'utf8')
// ② 直接文件路径的形状：调用处要的就是 ws/index.js 这个**文件本身**（不再走 exports 解析）
const directFile = path.join(writeFixture(path.join(wsLayoutRoot, 'direct'), 'DIRECT'), 'index.js')

// 子进程探针：导入**仓库真实的 index.js**，用 DSH_BROWSER_LIVE_WS 缝把候选钉到夹具上，
// 于是它报回来的就是 loadWs() 真实取到的那个绑定（不是测试自己算出来的）。
// 夹具的构造器带 SENTINEL 标记 ⇒ 能反证"取到的确实是夹具、不是碰巧解析到的真包"。
const WS_PROBE = `
import { pathToFileURL } from 'node:url'
const shape = (m) => {
  const OLD = m && (m.default || m)                                  // 改动前的写法
  const NEW = m?.WebSocket ?? m?.default?.WebSocket ?? m?.default     // 改动后的写法
  return {
    kind: m ? (typeof m.default === 'function' && !m['module.exports'] ? 'namespace-only' : 'has-module.exports') : 'none',
    oldHasNamed: typeof OLD?.WebSocket === 'function',
    newIsCtor: typeof NEW === 'function',
    keys: Object.keys(m || {}),
  }
}
const target = process.env.PROBE_TARGET
const mod = await import(process.env.PROBE_REPO)
const m = await import(target.startsWith('bare:') ? target.slice(5) : pathToFileURL(target).href)
const picked = await mod.loadWs()
let bound = 'none'
try {
  if (typeof picked === 'function') { new picked(); bound = (globalThis.__wsBindings || ['?']).pop() || '?' }
  else if (picked && typeof picked.WebSocket === 'function') { new picked.WebSocket(); bound = (globalThis.__wsBindings || ['?']).pop() || '?' }
} catch (e) { bound = 'ctor-threw:' + e.message.slice(0, 60) }
console.log(JSON.stringify({ ...shape(m), picked: picked === null ? 'null' : typeof picked, bound }))
`
// seam 与 target 分开传：
//   seam   = 给 DSH_BROWSER_LIVE_WS 的值（钉住 loadWs 的候选；undefined/null=不设，走 loadWs 自己的候选表）
//   target = 探针自己直接 import 用的地址（算"改动前的写法"在这份命名空间上是什么结果）
//   probeDir = 探针**文件**所在目录。必须是真文件而不是 `-e` 内联脚本：
//     Node 解析裸包名是从**导入方文件**所在目录逐级向上找 node_modules，`-e` 的 import.meta.url
//     落在与 cwd 无关的地方，裸名就解析不到临时夹具（会静默落到仓库自己的 ws 上 —— 断言看起来通过、
//     实际测的是真包，这类"假绿"正是本任务要消灭的东西）。所以探针文件要放进夹具自己那棵树里。
function runWsProbe(target, probeDir, seam) {
  const willSetSeam = seam !== undefined && seam !== null
  const env = { ...process.env }
  delete env.DSH_BROWSER_LIVE_WS
  const probeFile = path.join(probeDir, 'ws-probe.mjs')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(probeFile, WS_PROBE, 'utf8')
  const r = spawnSync(process.execPath, [probeFile], {
    cwd: probeDir, encoding: 'utf8', timeout: 30000,
    env: {
      ...env,
      PROBE_REPO: pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href,
      PROBE_TARGET: target,
      ...(willSetSeam ? { DSH_BROWSER_LIVE_WS: String(seam) } : {}),
      DSH_HOME: home,
    },
  })
  const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (!line) return { picked: 'error', bound: 'error', err: (r.stderr || '').trim().split(/\r?\n/).slice(0, 3).join(' | ') }
  try { return JSON.parse(line) } catch { return { picked: 'error', bound: 'error', err: line.slice(0, 300) } }
}
// 裸包名这一路要真的**走 exports 解析**，这一点有个不太直觉的地方：
// loadWs 是拿裸名做 `import('__bl_fixture_ws__')` 的，而 Node 解析裸名是从**导入方文件**
// （仓库里的 index.js）所在目录逐级向上找 node_modules —— **既不看 cwd、也不看探针文件在哪**。
// 所以夹具只有放在**仓库自己的 node_modules 下**才解析得到；放进临时目录会被静默跳过，
// 落到仓库里那份真 ws 上（断言照样"通过"，但测的是真包 —— 这种假绿正是本任务要消灭的）。
// node_modules 本身是 gitignore 的、且 npm ci 会重建，所以这里写出/删掉夹具是安全的。
const bareInRepo = path.join(import.meta.dirname, '..', 'node_modules', FIX_BARE_NAME)
let bareSeam = FIX_BARE_NAME
let bareSeamKind = '裸包名（走 exports → wrapper.mjs）'
try {
  rmSync(bareInRepo, { recursive: true, force: true })
  cpSync(bareDir, bareInRepo, { recursive: true })
  if (!existsSync(path.join(bareInRepo, 'package.json'))) throw new Error('夹具没落盘')
} catch (e) {
  // 写不进去（只读检出等）就退化成绝对路径；那测的不是"走 exports"这一路，
  // 所以下面的断言会把 bareSeamKind 一起报出来，看得见区别，不当作通过。
  bareSeam = path.join(bareDir, 'index.js')
  bareSeamKind = '退化为直接路径（' + e.message + '）'
}
// 裸包名这一路：seam 给**裸包名** ⇒ loadWs 走 package.json 的 exports → wrapper.mjs
// （**改动前就是这一路坏掉**：解构得到 undefined，本机全绿 CI 全红）
const bareProbe = runWsProbe('bare:' + FIX_BARE_NAME, bareRoot, bareSeam)
// 直接文件路径这一路：seam 给**文件路径** ⇒ 等价于 DSH 安装目录那种布局（原来恰好能用）
const directProbe = runWsProbe(directFile, wsLayoutRoot, directFile)
// 夹具只用在这两条断言里，用完立刻撤（不留残留物在 node_modules 里）
rmSync(bareInRepo, { recursive: true, force: true })

ok(bareProbe.picked === 'function' && bareProbe.bound === 'BARE' && bareSeamKind.startsWith('裸包名'),
  '裸包名布局：loadWs() 取到可用的 WebSocket 构造器（改动前这里是 undefined ⇒ 只对了一半）',
  JSON.stringify({ ...bareProbe, seamKind: bareSeamKind }))
ok(directProbe.picked === 'function' && directProbe.bound === 'DIRECT',
  '直接文件路径布局：loadWs() 也取到可用的 WebSocket 构造器（本机原来恰好能用的那条）',
  JSON.stringify(directProbe))
// 反向证据：把"改动前的写法"套在这两个命名空间上，必须一好一坏 —— 这才是缺陷的机制
ok(bareProbe.oldHasNamed === false && directProbe.oldHasNamed === true,
  '机制自证：改动前 `m.default.WebSocket` 在裸包名下没有具名导出、在直接路径下有（一好一坏）',
  JSON.stringify({ bare: bareProbe.oldHasNamed, direct: directProbe.oldHasNamed }))
ok(JSON.stringify(bareProbe.keys) !== JSON.stringify(directProbe.keys),
  '两种布局的模块命名空间形状确实不同（同一段代码不可能靠一种取法同时对上）',
  JSON.stringify({ bare: bareProbe.keys, direct: directProbe.keys }))

// 真实 npm 'ws' 的交叉对证：用仓库 node_modules 里那份 ws（CI 由 npm ci 装出，本机由 npm install 装出）。
// 没装就明确跳过并说清原因，不假装通过。
ok(typeof mod.loadWs === 'function',
  'index.js 导出了 loadWs（下面两条要直接调它；未导出时那两条会以 error 报出来）', typeof mod.loadWs)

const repoWs = path.join(import.meta.dirname, '..', 'node_modules', 'ws')
if (existsSync(path.join(repoWs, 'package.json'))) {
  // 干净环境的脚手架：一份真实 npm ws + 一个 module 型 package.json。
  // 探针**文件也放在脚手架里**，这样裸 'ws' 按导入方文件解析到脚手架这份（而不是仓库那份）——
  // 与被验证的那条真实失败路径（别人的机器 / CI 上 npm 装出来的 ws）尽量同构。
  const scaffold = path.join(wsLayoutRoot, 'real')
  mkdirSync(scaffold, { recursive: true })
  try { cpSync(repoWs, path.join(scaffold, 'node_modules', 'ws'), { recursive: true }) } catch { /* 下面按缺失处理 */ }
  const repoPkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  writeFileSync(path.join(scaffold, 'package.json'),
    JSON.stringify({ name: repoPkg.name, version: repoPkg.version, private: true, type: 'module' }), 'utf8')
  const realProbe = (() => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import('ws')
      console.log(JSON.stringify({
        keys: Object.keys(m),
        oldOnDefault: typeof (m.default || m)?.WebSocket,
        namedIsFn: typeof m.WebSocket === 'function',
        defaultIsFn: typeof m.default === 'function',
      }))
    `], { cwd: scaffold, encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME: home } })
    const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()
    try { return JSON.parse(line) } catch { return { err: (r.stderr || '').trim().slice(0, 200) } }
  })()
  // 真实 ws 的实证：具名导出在、default 是类、而 default.WebSocket 上没有可用导出
  ok(realProbe.namedIsFn === true && realProbe.defaultIsFn === true && realProbe.oldOnDefault !== 'function',
    "真实 npm 'ws'：裸包名下具名 WebSocket 是函数、default 是类、但 default.WebSocket 不是函数（缺陷的实证）",
    JSON.stringify(realProbe))

  // 端到端复现"干净机器装好 npm ws 后 reportWindowState 照样报不可用"。
  // 必须**在脚手架里起子进程**跑 reportWindowState：只有那时 loadWs 的裸名才解析到这份 npm ws
  // （主进程的 index.js 在仓库里，裸名永远解析到仓库的 node_modules）。
  // 判据必须够强，两道闸门都不能省：
  //   ① 假 CDP 服务返回一个**页面目标** —— 否则 reportWindowState 在 fetch 那一关就返回了
  //      （打一个没人监听的端口 → "fetch failed"），根本走不到 WebSocket 那一步，断言会假绿；
  //   ② 要求消息里出现"窗口存在且可见" —— 那才是真的连上 WS 并拿到了 Browser.getWindowBounds。
  //      只断言"没报 WebSocket 不可用"同样会假绿（fetch failed 也不含那个串）。
  const realRunner = path.join(scaffold, 'real-report.mjs')
  writeFileSync(realRunner, `
import http from 'node:http'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const CDP = []
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/json/list')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/page/T1' }]))
    return
  }
  res.writeHead(404); res.end()
})
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n')
  socket.on('data', (buf) => {
    if ((buf[0] & 0x0f) !== 0x1) return
    const len = buf[1] & 0x7f
    let off = 2, n = len
    if (len === 126) { n = buf.readUInt16BE(2); off = 4 }
    const mask = buf.slice(off, off + 4); off += 4
    const data = Buffer.alloc(n)
    for (let i = 0; i < n; i++) data[i] = buf[off + i] ^ mask[i % 4]
    let msg = {}
    try { msg = JSON.parse(data.toString('utf8')) } catch { return }
    CDP.push(msg.method)
    let result = {}
    if (msg.method === 'Browser.getWindowForTarget') result = { windowId: 7, bounds: { left: 0, top: 0, width: 1200, height: 800, windowState: 'normal' } }
    else if (msg.method === 'Browser.getWindowBounds') result = { bounds: { left: 0, top: 0, width: 1200, height: 800, windowState: 'normal' } }
    const body = Buffer.from(JSON.stringify({ id: msg.id, result }), 'utf8')
    const head = body.length < 126 ? Buffer.from([0x81, body.length])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b })()])
    socket.write(Buffer.concat([head, body]))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const mod = await import(process.env.PROBE_REPO)
const msg = await mod.reportWindowState(server.address().port)
console.log('MSG=' + msg)
console.log('CDP=' + JSON.stringify(CDP))
server.close()
`, 'utf8')
  const rr = spawnSync(process.execPath, [realRunner], {
    cwd: scaffold, encoding: 'utf8', timeout: 40000, env: { ...process.env, PROBE_REPO: pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href, DSH_HOME: home },
  })
  const rout = String(rr.stdout || '')
  const realMsg = (rout.match(/^MSG=(.*)$/m) || [, '(无输出)'])[1]
  const realCdp = (rout.match(/^CDP=(.*)$/m) || [, '[]'])[1]
  ok(!/WebSocket 不可用/.test(realMsg) && /窗口存在且可见/.test(realMsg) && /Browser\.getWindowForTarget/.test(realCdp),
    '干净环境（裸包名布局 + 真实 npm ws）里 reportWindowState 真连上了假 CDP（改动前必报"WebSocket 不可用"）',
    realMsg + ' | CDP=' + realCdp + (rr.stderr ? ' | ' + String(rr.stderr).trim().split(/\r?\n/).slice(0, 2).join(' / ') : ''))
} else {
  console.log('  ~ 跳过真实 ws 交叉对证：仓库 node_modules/ws 不存在（本机先 npm install，CI 由 npm ci 装出）')
}

// ---------------------------------------------------------------- 2) 窗口自查（假 CDP）
const CDP_CALLS = []
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/json/list')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/T1` }]))
    return
  }
  res.writeHead(404); res.end()
})
// 极简 WS 服务端：只处理 CDP 文本帧（不加密、不做分片 —— 测试里够了）
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  socket.on('data', (buf) => {
    // 解析客户端帧（掩码）：opcode 1 = 文本
    const op = buf[0] & 0x0f
    if (op === 0x8) return socket.end()
    if (op !== 0x1) return
    const len = buf[1] & 0x7f
    let off = 2, payloadLen = len
    if (len === 126) { payloadLen = buf.readUInt16BE(2); off = 4 }
    const mask = buf.slice(off, off + 4); off += 4
    const data = Buffer.alloc(payloadLen)
    for (let i = 0; i < payloadLen; i++) data[i] = buf[off + i] ^ mask[i % 4]
    let msg = {}
    try { msg = JSON.parse(data.toString('utf8')) } catch { return }
    CDP_CALLS.push(msg.method)
    const reply = (result) => {
      const body = Buffer.from(JSON.stringify({ id: msg.id, result }), 'utf8')
      const head = body.length < 126
        ? Buffer.from([0x81, body.length])
        : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b })()])
      socket.write(Buffer.concat([head, body]))
    }
    try {
      if (msg.method === 'Browser.getWindowForTarget') return reply({ windowId: 7, bounds: { left: 100, top: 100, width: 800, height: 600, windowState: 'normal' } })
      if (msg.method === 'Browser.getWindowBounds') return reply({ bounds: { left: 100, top: 100, width: 800, height: 600, windowState: 'normal' } })
      if (msg.method === 'Browser.setWindowBounds') return reply({})
      reply({})
    } catch { /* ignore */ }
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const msg1 = await mod.reportWindowState(port)
ok(/窗口存在且可见/.test(msg1), '正常窗口 → 报告"存在且可见"', msg1)
ok(/windowId=7/.test(msg1) && /normal/.test(msg1) && /800x600/.test(msg1), '报告里带上 windowId/状态/尺寸（可核对）', msg1)
ok(CDP_CALLS.includes('Browser.getWindowForTarget') && CDP_CALLS.includes('Browser.getWindowBounds'), '走了 getWindowForTarget + getWindowBounds', JSON.stringify(CDP_CALLS))
ok(CDP_CALLS.includes('Browser.setWindowBounds'), '窗口尺寸小于设置值时下发 setWindowBounds 修正', JSON.stringify(CDP_CALLS))

const msg2 = await mod.reportWindowState(1)   // 没人监听 → 拿不到 /json/list
ok(/自查窗口失败|拿不到页面目标/.test(msg2), 'CDP 不可达时给出可读的失败原因（不抛异常）', msg2)

server.close()
rmSync(home, { recursive: true, force: true })
console.log(`\n${fail ? '✗' : '✓'} verify-launch: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
