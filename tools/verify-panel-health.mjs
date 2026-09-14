// 画面健康判定（v0.13.0 · 用户 2026-09-14 反馈）：
// 「内嵌观察窗收到画面就亮绿灯，但连接断掉时状态没更新 —— 用户会把最后一帧当成实时画面」。
//
// 本套件锁两件事：
//   ① 纯函数 computeHealth 的口径：绿灯 = **画面真的在更新**，不只是"连上了"；
//      断流（超过 STALE_MS 没有新帧）必须黄灯，浏览器没跑才是灰灯。
//   ② 接线还在：帧到达才刷新 lastFrameAt、onerror 要重新渲染健康态、
//      面板 HTML/CSS 里那两处"画面已停"的提示没被删掉、
//      以及**没有退回旧口径**（旧代码是 `classList.toggle('on', !!st.alive)`：宿主说浏览器活着就亮绿）。
//
// 不起浏览器、不出网：只把 client.js 的 factory 拉起来取测试缝。
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SRC = readFileSync(path.join(REPO, 'client.js'), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// ---- 极简假浏览器：够 client.js 顶层不炸即可（纯函数不需要真 DOM）----
let captured = null
const noop = () => {}
const fakeEl = () => ({
  style: { setProperty: noop, removeProperty: noop }, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop, addEventListener: noop, removeEventListener: noop,
  appendChild: noop, removeChild: noop, querySelector: () => null, querySelectorAll: () => [], contains: () => false,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }), focus: noop,
})
const store = {}
globalThis.window = {
  __ModuleLoader__: { load: (m) => { captured = m } },
  addEventListener: noop, removeEventListener: noop,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) }, removeItem: (k) => { delete store[k] } },
  innerWidth: 1424, innerHeight: 805, matchMedia: () => ({ matches: false, addEventListener: noop }),
  setTimeout, clearTimeout, setInterval, clearInterval,
}
globalThis.localStorage = globalThis.window.localStorage
globalThis.document = {
  createElement: fakeEl, head: fakeEl(), body: fakeEl(), documentElement: fakeEl(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, removeEventListener: noop, title: '',
  visibilityState: 'visible',
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.fetch = () => Promise.resolve(null)

await import('file:///' + path.join(REPO, 'client.js').replace(/\\/g, '/') + '?health' + Date.now())
if (!captured) throw new Error('client.js 未注册 factory')
const ex = captured.factory((name) => { throw new Error('意外的 require: ' + name) })
const it = ex && ex.__blInternals

console.log('— 0. 测试缝 —')
ok('client 暴露了 __blInternals', !!it && typeof it.computeHealth === 'function', it ? Object.keys(it).join(',') : '无')

if (it) {
  const { computeHealth, healthText, STALE_MS } = it
  const now = 1_800_000_000_000
  console.log('\n— 1. 三种灯：off / alive / live / stale —')
  ok('浏览器没跑 ⇒ off（灰）', computeHealth({ hostAlive: false, hasStream: true, lastFrameAt: now - 100, now }) === 'off')
  ok('浏览器在跑、有连接、从没收到帧 ⇒ stale（黄）', computeHealth({ hostAlive: true, hasStream: true, lastFrameAt: 0, now }) === 'stale')
  ok('刚收到帧 ⇒ live（绿）', computeHealth({ hostAlive: true, hasStream: true, lastFrameAt: now - 1000, now }) === 'live')
  ok('超过阈值没有新帧 ⇒ stale（黄，这就是"断流还在亮绿灯"那个 bug）',
    computeHealth({ hostAlive: true, hasStream: true, lastFrameAt: now - STALE_MS - 1, now }) === 'stale',
    'STALE_MS=' + STALE_MS)
  ok('阈值边界（正好等于 ⇒ 判 stale，宁可保守）',
    computeHealth({ hostAlive: true, hasStream: true, lastFrameAt: now - STALE_MS, now }) === 'stale')
  ok('没有 EventSource、也从没收到帧 ⇒ alive（只说"在运行"，不谎报断流）',
    computeHealth({ hostAlive: true, hasStream: false, lastFrameAt: 0, now }) === 'alive')
  ok('曾有帧、但流已经没了 ⇒ stale（隐藏/关流不该再显示成实时）',
    computeHealth({ hostAlive: true, hasStream: false, lastFrameAt: now - 10000, now }) === 'stale')
  ok('缺参数不抛错（facts 为空 ⇒ off）', computeHealth() === 'off' && computeHealth({}) === 'off')

  console.log('\n— 2. 黄灯旁边写什么：断流 vs 还没收到 —')
  ok('断流 ⇒ 「正在重连」', healthText('stale', now - 5000) === '正在重连')
  ok('从没收到过 ⇒ 「还没收到画面」', healthText('stale', 0) === '还没收到画面')
  ok('绿/灰灯不写状态字', healthText('live', now) === '' && healthText('off', 0) === '')
}

console.log('\n— 3. 接线（源文本断言：这些一旦被删/被退回旧口径，上面的纯函数就白测了）—')
ok('帧到达才刷新 lastFrameAt', /S\.lastFrameAt = Date\.now\(\)/.test(SRC) && /es\.addEventListener\('frame'/.test(SRC))
ok('灯只由 renderHealth 单点决定（帧处理器里不再直接加 on 类）',
  !/els\.dot\.classList\.add\('on'\)/.test(SRC))
ok('onerror 会重新渲染健康态（不再只是"自动重连"注释）',
  /es\.onerror = function \(\) \{ S\.streamError = true; renderHealth\(\) \}/.test(SRC))
ok('onopen 清掉断流标记', /es\.onopen = function \(\) \{ S\.streamError = false; renderHealth\(\) \}/.test(SRC))
ok('轮询里不再用"宿主说活着就亮绿"的旧口径', !/classList\.toggle\('on', !!st\.alive\)/.test(SRC))
ok('面板里有状态文字位（顶部）', SRC.includes('id="bl-status"'))
ok('画面上下有"画面已停 · 最后更新于 X 秒前"的角标', SRC.includes('id="bl-stale"') && SRC.includes('画面已停'))
ok('CSS 里有黄灯样式 .bl-dot.warn', /\.bl-dot\.warn\{/.test(SRC))
ok('收起成一条时也会标出画面已停', /画面已停'/.test(SRC) && /function updateMinTitle/.test(SRC))

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
