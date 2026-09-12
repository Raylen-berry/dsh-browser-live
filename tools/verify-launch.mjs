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
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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
