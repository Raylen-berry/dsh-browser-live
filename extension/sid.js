// ============================================================================
// DSH Browser Bridge · v2 纯函数层（无 chrome.* / DOM 依赖）
//
// 单独成文件的唯一理由：MV3 service worker（background.js）顶层就用 chrome.*，
// 不能被 node 直接 import 做离线断言。这里放三样东西，background.js 与 popup.js
// 都从这里取，tools/verify-extension-v2.mjs 直接 import 本文件跑表驱动断言。
//
//   1. 浏览器身份嗅探：UA → kind（契约 docs/MULTI-BROWSER.md §2）
//   2. sessionId 命名空间：<kind>:<extSid> 跨 WS 加前缀 / 收包剥前缀（§3）
//   3. 浏览器人类可读名（弹窗显示用）
// ============================================================================

// ---- 1. 身份嗅探 -----------------------------------------------------------
// 顺序有讲究：Edge/Opera/Brave 的 UA 里**都**含 Chrome/，所以必须在 Chrome 之前判。
export function detectBrowserKind(ua) {
  const s = String(ua == null ? '' : ua)
  if (/Edg\//.test(s)) return 'edge'
  if (/Brave\//.test(s)) return 'brave'
  if (/OPR\//.test(s)) return 'opera'
  if (/Chrome\//.test(s)) return 'chrome'
  return 'unknown'
}

const BROWSER_NAMES = {
  edge: 'Microsoft Edge',
  chrome: 'Google Chrome',
  brave: 'Brave',
  opera: 'Opera',
  unknown: '未知浏览器',
}

export function browserName(kind) {
  return BROWSER_NAMES[String(kind || '')] || BROWSER_NAMES.unknown
}

// 浏览器内部通道名（status 里给弹窗用；name 是给人看的）
export function nameOfKind(kind) { return browserName(kind) }

// ---- 2. sessionId 命名空间 -------------------------------------------------
// 契约：host 侧 sessionId = `${kind}:${extSid}`；扩展内 chrome.debugger 的
// sessionId（形如 bl-12-1）永远是**无前缀**的。前缀只在跨 WS 边界时加/剥。
// 内部 state.sessions（extSid→tabId）与 state.byTab（tabId→extSid）一律存无前缀值，
// 所有出口消息一律走 extSid()，所有入口 sessionId 一律走 rawSid()。

// 出口：加前缀。空值原样返回，避免造出 "chrome:" 这种垃圾 key。
export function extSid(kind, s) {
  const raw = String(s == null ? '' : s)
  if (!raw) return ''
  return `${String(kind || 'unknown')}:${raw}`
}

// 入口：剥前缀，只剥一层且只在形如 `<小写字母串>:` 时才剥。
// bl-12-1 / 3 / 空串 都原样返回（幂等，重复调用安全）。
export function rawSid(s) {
  return String(s == null ? '' : s).replace(/^[a-z]+:/, '')
}
