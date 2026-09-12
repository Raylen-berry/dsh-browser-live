// DSH Browser Bridge · 弹窗脚本（无框架，轮询 800ms 刷新）
import { detectBrowserKind, browserName } from './sid.js'

const $ = (id) => document.getElementById(id)

function api(type, payload, retry) {
  // MV3 service worker 休眠时，醒来后的第一条消息可能以 "Receiving end does not exist"
  // 失败；静默失败会让人以为「点了没反应」，所以重试一次并把错误显式报出来。
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => {
      if (chrome.runtime.lastError) {
        if (retry !== false) { setTimeout(() => resolve(api(type, payload, false)), 300); return }
        return resolve({ ok: false, error: chrome.runtime.lastError.message })
      }
      resolve(r || { ok: false, error: 'no reply' })
    })
  })
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

let flashTimer = null
function setFlash(msg, bad) {
  const el = $('flash')
  el.textContent = msg || ''
  el.className = bad ? 'bad' : 'ok'
  clearTimeout(flashTimer)
  if (msg) flashTimer = setTimeout(() => { el.textContent = '' }, 5000)
}

let rendering = false

// 本地先按 UA 认一次（弹窗首帧就能显示，不必等 service worker 醒）；
// 之后每轮 refresh 用 background 上报的 browserName 覆盖（两者应当一致）。
const LOCAL_KIND = detectBrowserKind(navigator.userAgent)
function paintBrowser(name) {
  const el = $('browserName')
  if (el) el.textContent = name || browserName(LOCAL_KIND)
}
paintBrowser(browserName(LOCAL_KIND))

async function refresh() {
  if (rendering) return
  rendering = true
  try {
    const sr = await api('status')
    const st = sr.data
    const tabs = (await api('tabs')).data || []
    if (!st) {
      $('headline').textContent = '读不到扩展状态'
      $('err').textContent = sr.error || 'service worker 没响应；点一下「连接」重试'
      return
    }

    paintBrowser(st.browserName || browserName(st.kind || LOCAL_KIND))

    $('dot').className = 'dot' + (st.connected ? ' on' : st.lastError ? ' err' : '')
    $('headline').textContent = st.connected
      ? `已连接 127.0.0.1:${st.port}` + (st.hostVersion ? ` · host v${st.hostVersion}` : '')
      : '未连接'
    $('err').textContent = st.lastError || ''
    $('port').value = st.port
    $('auto').checked = !!st.autoConnect
    $('allowAll').checked = !!st.allowAll
    $('allowInput').checked = !!st.allowInput
    $('allowCloseOwn').checked = st.allowCloseOwn !== false
    $('allowNewTab').checked = st.allowNewTab !== false

    const origins = st.origins || []
    $('granted').textContent = (st.allowAll
      ? '已授权：所有网站（高风险开关已打开）'
      : (origins.length ? `已授权 ${origins.length} 个站点：${origins.join(' , ')}` : '已授权：无 —— 点下面标签页右侧的「允许」'))
      + (st.allowInput ? ' · ⚠ 允许操作：开（agent 可真点击/打字）' : ' · 允许操作：关（只读）')

    const list = tabs.length ? tabs : []
    $('tabs').className = ''
    $('tabs').innerHTML = list.map((t) => {
      const origin = t.origin || '(无法识别)'
      const allowed = st.allowAll || origins.includes(origin)
      return `<div class="tab${t.attached ? ' attached' : ''}">
        <div class="ti"><b>${esc(t.title || '(无标题)')}${t.active ? ' · 当前' : ''}</b><span>${esc(origin)}</span></div>
        <button class="mini" data-allow="${esc(origin)}" data-on="${allowed ? '0' : '1'}">${allowed ? '撤销' : '允许'}</button>
      </div>`
    }).join('') || '<div class="muted">没有可读的标签页</div>'

    const logs = (st.log || []).slice(-4).map((l) => '· ' + esc(l.msg)).join('<br>')
    $('log').innerHTML = logs || ''
    $('disconnect').disabled = !st.connected
  } finally { rendering = false }
}

$('connect').addEventListener('click', async () => {
  await api('save', { port: Number($('port').value) || 9760, token: $('token').value.trim() })
  const r = await api('connect')
  if (!r.ok) setFlash('连接失败：' + (r.error || ''), true)
  else setFlash(r.data && r.data.connected ? '已连接' : ('未连上：' + ((r.data && r.data.lastError) || '检查 host 的桥是否开着')), !(r.data && r.data.connected))
  refresh()
})
$('disconnect').addEventListener('click', async () => { await api('disconnect'); setFlash('已断开'); refresh() })
$('auto').addEventListener('change', async () => { await api('save', { autoConnect: $('auto').checked }); refresh() })
$('allowAll').addEventListener('change', async () => {
  const r = await api('allowAll', $('allowAll').checked)
  setFlash(r.ok ? ($('allowAll').checked ? '已允许所有网站（高风险）' : '已关闭「允许所有网站」') : ('失败：' + (r.error || '')), !r.ok)
  refresh()
})
$('allowInput').addEventListener('change', async () => {
  const on = $('allowInput').checked
  const r = await api('setInput', on)
  setFlash(r.ok
    ? (on ? '⚠ 已开启「允许操作」：agent 现在可以在这个浏览器里真点击/打字（仅限已授权站点）' : '已关闭「允许操作」：回到只读')
    : ('失败：' + (r.error || '')), !r.ok)
  refresh()
})
$('detachAll').addEventListener('click', async () => { await api('detachAll'); setFlash('已断开所有标签页'); refresh() })
$('allowCloseOwn').addEventListener('change', async () => {
  const on = $('allowCloseOwn').checked
  const r = await api('setCloseOwn', on)
  setFlash(r.ok
    ? (on ? '已允许 agent 关闭它自己打开的标签页（你手动开的页面仍然不会被关）' : '已关闭：agent 连自己打开的标签页也不能关')
    : ('失败：' + (r.error || '')), !r.ok)
  refresh()
})
$('allowNewTab').addEventListener('change', async () => {
  const on = $('allowNewTab').checked
  const r = await api('setNewTab', on)
  setFlash(r.ok
    ? (on ? '已允许 agent 新开标签页（仅 http/https；要读页面仍需逐站点授权）' : '已关闭：agent 只能在你已有的标签页里工作')
    : ('失败：' + (r.error || '')), !r.ok)
  refresh()
})
// 允许当前所有标签页：只并入 origins，不打开 allowAll（新增站点以后仍要单独点「允许」）
$('allowAllTabs').addEventListener('click', async () => {
  const r = await api('allowTabs')
  if (!r.ok) setFlash('操作失败：' + (r.error || ''), true)
  else setFlash(`已允许 ${((r.data && r.data.added) || 0)} 个站点` + ((r.data && r.data.added) ? '' : '（没有新站点可加）'), false)
  refresh()
})
// 撤销全部授权：清空 origins（allowAll 开关不动），二次确认
$('revokeAll').addEventListener('click', async () => {
  if (!confirm('撤销全部站点授权？之后 agent 无法再附加任何标签页，需要重新逐个允许。')) return
  const r = await api('revokeAll')
  if (!r.ok) setFlash('操作失败：' + (r.error || ''), true)
  else setFlash(`已撤销全部授权（${(r.data && r.data.removed) || 0} 个站点）`, false)
  refresh()
})
$('token').addEventListener('change', async () => { await api('save', { token: $('token').value.trim() }) })
$('port').addEventListener('change', async () => { await api('save', { port: Number($('port').value) || 9760 }) })
$('tabs').addEventListener('click', async (ev) => {
  const b = ev.target.closest ? ev.target.closest('button[data-allow]') : null
  if (!b) return
  const origin = b.getAttribute('data-allow')
  const on = b.getAttribute('data-on') === '1'
  const r = on ? await api('allow', origin) : await api('revoke', origin)
  if (!r.ok) setFlash('操作失败：' + (r.error || ''), true)
  else {
    const now = ((r.data && r.data.origins) || []).includes(origin)
    setFlash((now ? '已允许 ' : '已撤销 ') + origin + (now ? ' —— 回到 DSH 里让我重试' : ''), false)
  }
  refresh()
})

refresh()
setInterval(refresh, 800)
