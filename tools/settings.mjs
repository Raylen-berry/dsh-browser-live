// 浏览器观察窗 · 设置导出 / 导入（换机器用；开发与运维脚本，不进 npm 包）
//
// 为什么需要它：本插件的设置（含 **userBridge**、浏览器路径、代理、观察窗形态、拟人轨迹开关…）
// 都在 $DSH_HOME/dsh-browser-live/settings.json，**不随仓库走** ⇒ 换机器后 `userBridge` 是空的、
// 桥不会自己开，得手动改设置页。另外 navigation 相关的**留痕**在 audit/、登录态在 chrome-profile/，
// 这两个脚本**不碰**（登录态不该跨机器复制，留痕本就该各机器各留一份）。
//
// 用法：
//   node tools/settings.mjs show
//   node tools/settings.mjs export [--out <文件>]
//   node tools/settings.mjs import <文件> [--yes]     # 覆盖前自动备份
//
// 注意：扩展本身（extension/）与 token（bridge.json）**不在这个文件里** ——
// 扩展要人工装、token 每台机器各自生成，导入设置后若要用"接管日常浏览器"，
// 请在新机器上重跑一次 browser_ext_setup（或把 userBridge 打开）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'dsh-browser-live'
const FORMAT = 'dsh-plugin-settings/1'
const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const dir = () => path.join(dshHome(), PLUGIN)
const settingsFile = () => path.join(dir(), 'settings.json')

// 默认值**直接从插件本体来**（v0.12.0）：原来这里手抄了一份，靠注释"改那边时这里要跟着改"约束 ——
// 那种约定迟早漂移，而漂移的后果是"导出一份、导入后设置被悄悄改回默认"。
const DEFAULTS = { ...(await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)).DEFAULT_SETTINGS }
const ENUMS = { liveView: ['panel', 'standalone'], backendMode: ['auto', 'plugin', 'user'] }
const BOOLS = ['headless', 'launchDetached', 'humanize', 'userBridge']
// 数值字段的范围（与 index.js sanitizeSettings 同口径；漏掉字段不会丢，会按原值搬过去）
const NUMS = {
  fps: [0.5, 10], quality: [20, 90], humanSpeed: [0.3, 4], maxTabsWarn: [1, 64], bridgePort: [1024, 65535],
  panelWidthPct: [15, 95], panelHeightPct: [15, 95], panelWidePct: [15, 98],
  searchCooldownMs: [5000, 600000], searchBudgetMs: [5000, 120000],
}
// 只搬运"跨机器有意义"的字段：chromePath 与本机安装位置有关，extraArgs 可能带本机路径 —— 仍然搬，
// 但在导入时给出提示让人核一眼。bridgePort 也搬（占用会自动顺延，无风险）。
export function validate(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const notes = []
  const out = { ...DEFAULTS }
  for (const k of Object.keys(src)) if (!(k in DEFAULTS)) notes.push('丢弃未知字段 ' + k)
  for (const [k, [lo, hi]] of Object.entries(NUMS)) {
    const n = Number(src[k])
    out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[k]
    if (Number.isFinite(n) && out[k] !== n) notes.push(k + ' ' + n + ' ⇒ ' + out[k])
  }
  for (const k of BOOLS) out[k] = src[k] === undefined ? DEFAULTS[k] === true : src[k] === true
  for (const [k, list] of Object.entries(ENUMS)) {
    out[k] = list.includes(src[k]) ? src[k] : DEFAULTS[k]
    if (src[k] !== undefined && out[k] !== src[k]) notes.push(k + ' ' + src[k] + ' 不认识 ⇒ ' + out[k])
  }
  for (const k of ['windowSize', 'chromePath', 'extraArgs', 'proxy', 'userDefault']) out[k] = typeof src[k] === 'string' ? src[k] : DEFAULTS[k]
  // windowSize 支持像素（1440,900）与百分比（80%,85% / 80%）两种形态（百分比按屏幕工作区换算）
  if (out.windowSize && !/^\d{3,4},\d{3,4}$/.test(out.windowSize) && !/^\d{1,3}%(\s*,\s*\d{1,3}%)?$/.test(out.windowSize.trim())) {
    notes.push('windowSize "' + out.windowSize + '" 不是合法形态；已改回默认 ' + DEFAULTS.windowSize + '（合法：1440,900 或 80%,85%）')
    out.windowSize = DEFAULTS.windowSize
  }
  if (out.userBridge) notes.push('userBridge=true：新机器上要先装浏览器扩展（人工，见 README「换台机器」一节）并重跑 browser_ext_setup，桥才会连上')
  if (out.chromePath) notes.push('chromePath 指向 ' + out.chromePath + '：换机器后这个路径可能不存在，空了会自动探测')
  return { settings: out, notes }
}

const stripBom = (s) => s.replace(/^\uFEFF/, '')
function readSettings() { try { return JSON.parse(stripBom(fs.readFileSync(settingsFile(), 'utf8'))) } catch { return null } }
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const cmd = process.argv[2]
const args = process.argv.slice(3)
const flag = (n) => args.includes(n)

if (cmd === 'show') {
  const raw = readSettings()
  // 显示**生效值**（盘上的值叠在默认值上），这样"全部可配项"一眼可见 ——
  // 只打印盘上那份会让人以为"没有面板百分比/搜索冷却这些设置"。
  const { settings, notes } = validate(raw || {})
  console.log('设置文件：' + settingsFile() + (raw ? '' : '（不存在，用默认值）'))
  console.log(JSON.stringify(settings, null, 2))
  for (const n of notes) console.log('  注意：' + n)
} else if (cmd === 'export') {
  const cur = readSettings() || {}
  const { settings, notes } = validate(cur)
  const i = args.indexOf('--out')
  const out = i >= 0 ? args[i + 1] : path.join(process.cwd(), 'dsh-browser-live-settings-' + stamp().slice(0, 10) + '.json')
  const payload = { format: FORMAT, plugin: PLUGIN, pluginVersion: '0.12.0', exportedAt: new Date().toISOString(), host: os.hostname(), settings }
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')
  console.log('已导出 ' + out)
  console.log('  观察窗 ' + settings.liveView + ' · 面板 ' + settings.panelWidthPct + '%×' + settings.panelHeightPct + '%（宽屏 ' + settings.panelWidePct + '%）· fps ' + settings.fps + ' · 质量 ' + settings.quality + ' · 无头 ' + settings.headless + ' · 用户浏览器桥 ' + settings.userBridge + ' · 后端 ' + settings.backendMode)
  for (const n of notes) console.log('  注意：' + n)
  console.log('  ⚠ 不含：浏览器扩展（要人工装）、bridge.json 的 token（每台机器各自生成）、chrome-profile 登录态、audit 留痕。')
} else if (cmd === 'import') {
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) { console.error('用法：node tools/settings.mjs import <文件> [--yes]'); process.exit(1) }
  let payload
  try { payload = JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) } catch (e) { console.error('读不了这个文件：' + e.message); process.exit(1) }
  if (payload.format !== FORMAT || payload.plugin !== PLUGIN) {
    console.error('不是本插件的设置文件（format=' + payload.format + ' plugin=' + payload.plugin + '，期望 ' + FORMAT + ' / ' + PLUGIN + '）')
    process.exit(1)
  }
  const { settings, notes } = validate(payload.settings)
  console.log('将写入：' + settingsFile())
  console.log('  观察窗 ' + settings.liveView + ' · fps ' + settings.fps + ' · 质量 ' + settings.quality + ' · 无头 ' + settings.headless + ' · 用户浏览器桥 ' + settings.userBridge + ' · 后端 ' + settings.backendMode)
  for (const n of notes) console.log('  注意：' + n)
  if (!flag('--yes')) { console.log('（演练模式：加 --yes 才真正写入。现有设置会先备份。）'); process.exit(0) }
  fs.mkdirSync(dir(), { recursive: true })
  if (fs.existsSync(settingsFile())) { const bak = settingsFile() + '.bak-' + stamp(); fs.copyFileSync(settingsFile(), bak); console.log('  已备份 settings.json → ' + path.basename(bak)) }
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8')
  console.log('完成。**需要重启 DSH Desktop**；若 userBridge=true，请在新机器上跑一次 browser_ext_setup 装扩展并授权。')
} else {
  console.log('浏览器观察窗 · 设置导出/导入\n  node tools/settings.mjs show\n  node tools/settings.mjs export [--out <文件>]\n  node tools/settings.mjs import <文件> [--yes]')
  console.log('\n换机器完整流程：')
  console.log('  旧机器: node tools/settings.mjs export --out D:\\dsh-browser-live-settings.json')
  console.log('  新机器: git clone → dsh plugin --profile web add link:<路径> → import → 重启 →（要接管日常浏览器的话）装扩展 + browser_ext_setup')
  console.log('  另外两个插件各有自己的同款脚本：dsh-bg-atelier/tools/settings.mjs、dsh-cache-control/tools/settings.mjs')
}
