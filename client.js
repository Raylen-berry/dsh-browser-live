// ============================================================================
// dsh-browser-live · Client half v0.4.0
//
// 右下角「浏览器观察窗」：
//   * 侧栏底部注册一个 🌐 按钮；无 slots 时退化为自建浮动球，功能不变。
//     bg-atelier 宝珠存在时（v0.6）：🌐 变成无边框 22px 小圆钮叠到宝珠**正上方**，
//     地球在上、紫球在下，整列以低谷时段卡中线为对称轴居中，空档大时吸附卡片左缘。
//     几何单点在本插件（写宝珠的 --bga-orb-dy/--bga-orb-dx，bg 只提供被动 transform）。
//   * 面板实时显示 agent 正在操作的页面（host /bl/stream SSE JPEG 帧），
//     标签条、地址、agent 最近动作、下载快捷取回；面板可拖动，拖近边缘自动贴边，
//     位置记忆在 localStorage（默认仍在右下角）；标题栏 ⧉ 可弹出**独立网页**观察窗
//     （host 的 /bl/view，可拖到副屏 / 全屏）；设置页「观察窗形态」选“独立网页”后，
//     🌐 与 agent 冷启动自动弹的都走独立页（弹窗被拦时自动退回内嵌面板）。
//   * 默认开启「接管」：面板内鼠标点击/滚轮/键盘直接操作真浏览器
//     （前端把显示坐标乘回 CSS 视口坐标 → POST /bl/input → CDP Input）。
//   * agent 冷启动浏览器时自动弹出面板一次；用户主动点 ✕ 收走后，本页面内不再
//     自动弹出，再点 🌐 才打开。
//
// 帧来源与坐标映射约定：captureScreenshot 返回的是 CSS 视口像素（dpr=1 时即
// 逻辑像素），img 以 width:100% 等比显示 ⇒ 两轴同一缩放 factor = vw/渲染宽。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-browser-live',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = null
    try { React = require('react') } catch (e) { React = null }
    var h = React ? React.createElement : null

    // ---------------------------------------------------------------- 样式
    var CSS = [
      '.bl-fab{width:22px;height:22px;border-radius:50%;border:none;background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;position:relative;font-size:15px;line-height:1;padding:0;flex:none}',
      '.bl-fab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.bl-fab-dot{position:absolute;right:0;top:0;width:5px;height:5px;border-radius:50%;background:#3fb96f;box-shadow:0 0 4px rgba(63,185,111,.8)}',
      '.bl-fab-dot.bl-off{background:#b9bfc9;box-shadow:none}',
      '.bl-fab-stacked{position:fixed;z-index:2147483049}',
      '.bl-panel{position:fixed;right:18px;bottom:18px;z-index:2147483050;width:560px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary,#222)}',
      '.bl-panel.bl-wide{width:900px}',
      '.bl-panel.bl-snap{transition:left .16s ease,top .16s ease}',
      '.bl-hd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));flex:none;cursor:grab;user-select:none}',
      '.bl-hd.bl-drag{cursor:grabbing}',
      '.bl-dot{width:8px;height:8px;border-radius:50%;background:#b9bfc9;flex:none}',
      '.bl-dot.on{background:#3fb96f;box-shadow:0 0 6px rgba(63,185,111,.9)}',
      '.bl-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}',
      '.bl-url{flex:none;max-width:38%;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.bl-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:inherit;border-radius:7px;height:22px;padding:0 8px;cursor:pointer;font-size:11px;flex:none}',
      '.bl-btn.bl-on{background:var(--dsw-alias-interactive-bg-hover,rgba(80,130,220,.16));border-color:#5b8def}',
      '.bl-btn.danger{color:#d0453f;border-color:rgba(208,69,63,.45)}',
      '.bl-tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));overflow-x:auto;flex:none}',
      '.bl-tab{flex:none;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));border-radius:7px;padding:2px 8px;cursor:pointer}',
      '.bl-tab.sel{border-color:#5b8def;background:rgba(91,141,239,.14)}',
      '.bl-stage{position:relative;line-height:0;background:#101418;flex:none}',
      '.bl-stage img{width:100%;display:block;user-select:none;-webkit-user-drag:none}',
      '.bl-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa4b2;line-height:1.5;text-align:center;padding:20px;font-size:12px}',
      '.bl-act{position:absolute;left:8px;bottom:8px;right:8px;background:rgba(10,14,20,.72);color:#dfe6ef;border-radius:8px;padding:3px 8px;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;transition:opacity .25s}',
      '.bl-act.show{opacity:1}',
      '.bl-ft{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));flex-wrap:wrap}',
      '.bl-ft label{color:var(--dsw-alias-label-secondary,#777);display:inline-flex;align-items:center;gap:4px}',
      '.bl-ft select{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:inherit;font-size:11px;height:22px}',
      '.bl-dl{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}',
      '.bl-dl a{color:#5b8def;text-decoration:none;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid rgba(91,141,239,.4);border-radius:6px;padding:1px 7px}',
      '.bl-key{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}',
    ].join('\n')

    function ensureStyles() {
      if (document.querySelector('style[data-bl-styles]')) return
      var el = document.createElement('style')
      el.setAttribute('data-bl-styles', '1')
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ---------------------------------------------------------------- 状态

    var S = {
      open: false,
      alive: false,
      wasAlive: false,
      vw: 1280,
      frame: null,
      takeOver: true,
      wide: false,
      hideUntil: 0,        // 手动收起后一段时间不再自动弹
      userClosed: false,   // 用户点过 ✕：本页面生命周期内不再自动弹（点 🌐 打开后重置）
      liveView: false,     // 设置项 liveView==='standalone'：用独立网页 /bl/view 当观察窗
      viewWin: null,       // 独立页窗口句柄
      stacked: false,      // 已叠到壁纸宝珠下（bg-atelier 共存模式）
      stackedFab: null,    // 叠列模式用的 fixed 地球钮
      settingsUi: 0,       // >0 = 设置页开着（本插件的 settings.section 挂载中），固定浮球要让位
      es: null,
      poll: null,
      stopBtnArmed: false,
      state: null,
    }
    var els = {}

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
    function trimUrl(u) { return String(u || '').replace(/^https?:\/\//, '').slice(0, 64) }
    function api(path, opts) { return fetch(path, opts).catch(function () { return null }) }
    function postJson(path, obj) {
      return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj || {}) })
    }

    // ---------------------------------------------------------------- 面板

    function buildPanel() {
      if (els.panel) return
      ensureStyles()
      var p = document.createElement('div')
      p.className = 'bl-panel'
      p.innerHTML = [
        '<div class="bl-hd">',
        '  <span class="bl-dot" id="bl-dot"></span>',
        '  <span class="bl-title" id="bl-title">浏览器观察窗</span>',
        '  <span class="bl-url" id="bl-url"></span>',
        '  <button class="bl-btn" id="bl-wide" title="加宽">↔</button>',
        '  <button class="bl-btn" id="bl-pop" title="弹出为独立网页（可拖到副屏、全屏）">⧉</button>',
        '  <button class="bl-btn" id="bl-hide" title="收起面板">✕</button>',
        '</div>',
        '<div class="bl-tabs" id="bl-tabs" hidden></div>',
        '<div class="bl-stage" id="bl-stage">',
        '  <img id="bl-img" alt="" draggable="false">',
        '  <div class="bl-empty" id="bl-empty">等待 agent 打开浏览器…<br>调用任意 browser_* 工具后这里会实时显示画面</div>',
        '  <div class="bl-act" id="bl-act"></div>',
        '  <textarea class="bl-key" id="bl-key" spellcheck="false" autocomplete="off"></textarea>',
        '</div>',
        '<div class="bl-ft">',
        '  <button class="bl-btn" id="bl-take" title="关闭后只观看，不转发鼠标键盘">⌨ 接管:开</button>',
        '  <label>FPS <select id="bl-fps"><option>1</option><option selected>2</option><option>4</option><option>8</option></select></label>',
        '  <label>画质 <select id="bl-q"><option value="40">省流</option><option value="60" selected>默认</option><option value="80">高清</option></select></label>',
        '  <button class="bl-btn danger" id="bl-stop">⏹ 关浏览器</button>',
        '  <span class="bl-dl" id="bl-dl"></span>',
        '</div>',
      ].join('')
      document.body.appendChild(p)
      els.panel = p
      els.dot = p.querySelector('#bl-dot')
      els.title = p.querySelector('#bl-title')
      els.url = p.querySelector('#bl-url')
      els.tabs = p.querySelector('#bl-tabs')
      els.stage = p.querySelector('#bl-stage')
      els.img = p.querySelector('#bl-img')
      els.empty = p.querySelector('#bl-empty')
      els.act = p.querySelector('#bl-act')
      els.key = p.querySelector('#bl-key')
      els.dl = p.querySelector('#bl-dl')

      p.querySelector('#bl-hide').addEventListener('click', function () { hidePanel(true) })
      p.querySelector('#bl-wide').addEventListener('click', function () {
        S.wide = !S.wide
        p.classList.toggle('bl-wide', S.wide)
        applyPanelPos()   // 宽度变化后把面板钳回视口
      })
      p.querySelector('#bl-pop').addEventListener('click', function () { openStandalone() })
      p.querySelector('#bl-take').addEventListener('click', function () {
        S.takeOver = !S.takeOver
        this.textContent = S.takeOver ? '⌨ 接管:开' : '⌨ 接管:关'
        this.classList.toggle('bl-on', S.takeOver)
      })
      p.querySelector('#bl-take').classList.add('bl-on')
      var stopBtn = p.querySelector('#bl-stop')
      stopBtn.addEventListener('click', function () {
        if (!S.stopBtnArmed) {
          S.stopBtnArmed = true
          stopBtn.textContent = '再点一次确认关闭'
          setTimeout(function () { S.stopBtnArmed = false; stopBtn.textContent = '⏹ 关浏览器' }, 3000)
          return
        }
        S.stopBtnArmed = false
        stopBtn.textContent = '⏹ 关浏览器'
        api('/bl/close-browser', { method: 'POST' }).then(pollState).catch(function () {})
      })
      p.querySelector('#bl-fps').addEventListener('change', function () {
        fetch('/bl/settings.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fps: Number(this.value) }) })
      })
      p.querySelector('#bl-q').addEventListener('change', function () {
        fetch('/bl/settings.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quality: Number(this.value) }) })
      })
      bindStage()
      // 标签条：点击=切换选中 tab
      els.tabs.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('.bl-tab') : null
        if (!b) return
        var idx = Number(b.getAttribute('data-i'))
        postJson('/bl/tabs', { action: 'select', index: idx }).then(function (r) { return r && r.ok ? r.json() : null }).then(function (st) {
          if (st && st.tabs) {
            els.tabs.querySelectorAll('.bl-tab').forEach(function (n) { n.classList.toggle('sel', Number(n.getAttribute('data-i')) === idx) })
          }
        }).catch(function () {})
      })
      bindPanelDrag()
      bindPanelResize()
    }

    // ------------------------------------------------- 鼠标键盘 → /bl/input

    function toPageXY(ev) {
      var rect = els.img.getBoundingClientRect()
      if (!rect.width) return null
      var factor = S.vw / rect.width
      var x = (ev.clientX - rect.left) * factor
      var y = (ev.clientY - rect.top) * factor
      if (x < 0) x = 0
      if (y < 0) y = 0
      return { x: Math.round(x), y: Math.round(y) }
    }

    var lastClickAt = 0
    function bindStage() {
      var img = els.img
      img.addEventListener('mousedown', function (ev) {
        if (!S.takeOver || ev.button > 2) return
        ev.preventDefault()
        focusKey()
        var pt = toPageXY(ev)
        if (!pt) return
        var now = Date.now()
        var dbl = now - lastClickAt < 350 && ev.button === 0
        lastClickAt = now
        postJson('/bl/input', { kind: ev.button === 2 ? 'rclick' : dbl ? 'dblclick' : 'click', x: pt.x, y: pt.y })
      })
      img.addEventListener('contextmenu', function (ev) { if (S.takeOver) ev.preventDefault() })
      var moveAt = 0
      img.addEventListener('mousemove', function (ev) {
        if (!S.takeOver) return
        var now = Date.now()
        if (now - moveAt < 90) return
        moveAt = now
        var pt = toPageXY(ev)
        if (pt) postJson('/bl/input', { kind: 'move', x: pt.x, y: pt.y })
      })
      els.stage.addEventListener('wheel', function (ev) {
        if (!S.takeOver) return
        ev.preventDefault()
        var pt = toPageXY(ev)
        if (!pt) return
        postJson('/bl/input', { kind: 'wheel', x: pt.x, y: pt.y, dx: Math.round(ev.deltaX), dy: Math.round(ev.deltaY) })
      }, { passive: false })

      // 键盘：特殊键/组合键走 key，普通字符走 text（composition 后一次发送）
      els.key.addEventListener('keydown', function (ev) {
        if (!S.takeOver) return
        var combo = []
        if (ev.ctrlKey) combo.push('ctrl')
        if (ev.altKey) combo.push('alt')
        if (ev.metaKey) combo.push('meta')
        if (ev.shiftKey && (combo.length || ev.key.indexOf('Arrow') === 0 || ['Tab', 'Enter', 'Backspace', 'Delete'].indexOf(ev.key) >= 0)) combo.push('shift')
        var named = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', ' ', 'Insert'].indexOf(ev.key) >= 0
        if (named || combo.length) {
          ev.preventDefault()
          var key = ev.key === ' ' ? 'Space' : ev.key
          postJson('/bl/input', { kind: 'key', keys: combo.concat([key]).join('+') })
        }
      })
      els.key.addEventListener('beforeinput', function (ev) {
        if (!S.takeOver) return
        if (ev.inputType === 'insertText' && ev.data) {
          ev.preventDefault()
          postJson('/bl/input', { kind: 'text', text: ev.data })
        }
      })
      els.key.addEventListener('compositionend', function (ev) {
        if (S.takeOver && ev.data) postJson('/bl/input', { kind: 'text', text: ev.data })
      })
      els.key.addEventListener('paste', function (ev) {
        if (!S.takeOver) return
        var t = (ev.clipboardData || window.clipboardData).getData('text')
        if (t) { ev.preventDefault(); postJson('/bl/input', { kind: 'text', text: t }) }
      })
    }

    function focusKey() {
      try {
        els.key.style.left = '-9999px'
        els.key.focus({ preventScroll: true })
      } catch (e) { /* 软失败 */ }
    }

    // ---------------------------------------------------------------- SSE

    function openStream() {
      closeStream()
      try {
        var es = new EventSource('/bl/stream')
        S.es = es
        es.addEventListener('frame', function (ev) {
          var d
          try { d = JSON.parse(ev.data) } catch (e) { return }
          S.vw = d.vw || S.vw
          els.img.src = 'data:image/jpeg;base64,' + d.img
          els.empty.style.display = 'none'
          els.dot.classList.add('on')
          S.alive = true
          els.title.textContent = d.title || '浏览器观察窗'
          els.url.textContent = trimUrl(d.url)
        })
        es.addEventListener('offline', function () {
          els.dot.classList.remove('on')
          S.alive = false
        })
        es.onerror = function () { /* EventSource 自动重连 */ }
      } catch (e) { /* 无 EventSource：只靠 /bl/state 轮询文字信息 */ }
    }
    function closeStream() {
      if (S.es) { try { S.es.close() } catch (e) {} S.es = null }
    }

    // ---------------------------------------------------------------- state 轮询

    function pollState() {
      api('/bl/state').then(function (r) { return r && r.ok ? r.json() : null }).then(function (st) {
        if (!st) return
        S.state = st
        // agent 冷启动浏览器 → 自动弹出（用户主动收走后不再自动打扰）
        var mayAuto = !S.userClosed && Date.now() > S.hideUntil
        if (st.panelWanted && !S.open && mayAuto) {
          showPanel(false)
          postJson('/bl/ack', {})
        }
        if (st.panelWanted && S.open) postJson('/bl/ack', {})
        if (st.alive && !S.wasAlive && !S.open && mayAuto) showPanel(false)
        S.wasAlive = st.alive
        if (!S.open) return
        // 标签条
        var tabs = st.tabs || []
        els.tabs.hidden = tabs.length <= 1
        els.tabs.innerHTML = tabs.map(function (t) {
          return '<button class="bl-tab' + (t.selected ? ' sel' : '') + '" data-i="' + t.i + '">' + esc(t.title || trimUrl(t.url) || '(空白页)') + '</button>'
        }).join('')
        // 下载条（completed 的）
        var done = (st.downloads || []).filter(function (d) { return d.state === 'done' }).slice(-3)
        els.dl.innerHTML = done.map(function (d) {
          return '<a href="/bl/download?file=' + encodeURIComponent(d.file) + '" title="取回下载文件">⬇ ' + esc(d.file) + '</a>'
        }).join('')
        // agent 动作条
        var last = (st.lastAction || [])[ (st.lastAction || []).length - 1 ]
        if (last) {
          els.act.textContent = '🤖 ' + last.label
          els.act.classList.add('show')
        }
        if (!S.es) { // 无流时给静态信息
          els.dot.classList.toggle('on', !!st.alive)
          if (!st.alive) { els.empty.style.display = 'flex'; els.img.removeAttribute('src') }
        }
      }).catch(function () {})
    }

    // --------------------------------------------------- 面板位置记忆/拖动/贴边

    var POS_KEY = 'bl-panel-pos-v1'
    function blLoad(k) { try { return window.localStorage.getItem(k) } catch (e) { return null } }
    function blSave(k, v) { try { window.localStorage.setItem(k, v) } catch (e) {} }
    function savedPanelPos() {
      var raw = blLoad(POS_KEY)
      if (!raw) return null
      try {
        var p = JSON.parse(raw)
        if (typeof p.x === 'number' && typeof p.y === 'number' && isFinite(p.x) && isFinite(p.y)) return p
      } catch (e) {}
      return null
    }
    function savePanelPos() {
      if (!els.panel) return
      var r = els.panel.getBoundingClientRect()
      blSave(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }))
    }
    // 有记忆位置则贴过去并钳制在视口内；没有就清掉 inline 定位，回到 CSS 默认
    // （右下角 right/bottom:18px），避免上次拖动留下的 left/top 残留
    function applyPanelPos() {
      if (!els.panel) return
      var p = savedPanelPos()
      if (!p) {
        els.panel.style.left = ''
        els.panel.style.top = ''
        els.panel.style.right = ''
        els.panel.style.bottom = ''
        return
      }
      var r = els.panel.getBoundingClientRect()
      var vw = document.documentElement.clientWidth
      var vh = document.documentElement.clientHeight
      var maxX = Math.max(4, vw - r.width - 4)
      var maxY = Math.max(4, vh - r.height - 4)
      var x = Math.min(Math.max(p.x, 4), maxX)
      var y = Math.min(Math.max(p.y, 4), maxY)
      els.panel.style.left = x + 'px'
      els.panel.style.top = y + 'px'
      els.panel.style.right = 'auto'
      els.panel.style.bottom = 'auto'
      if (x !== p.x || y !== p.y) blSave(POS_KEY, JSON.stringify({ x: x, y: y }))
    }
    // 拖到头就近贴边（≤48px 吸附到最近边缘，留 14px 边距）
    function snapToEdge() {
      if (!els.panel || !S.open || els.panel.style.display === 'none') return
      var r = els.panel.getBoundingClientRect()
      var vw = document.documentElement.clientWidth
      var vh = document.documentElement.clientHeight
      var dL = r.left, dR = vw - (r.left + r.width), dT = r.top, dB = vh - (r.top + r.height)
      var min = Math.min(dL, dR, dT, dB)
      if (min > 48) { savePanelPos(); return }
      var margin = 14
      var x = r.left, y = r.top
      if (min === dL) x = margin
      else if (min === dR) x = vw - r.width - margin
      else if (min === dT) y = margin
      else y = vh - r.height - margin
      els.panel.classList.add('bl-snap')
      els.panel.style.left = x + 'px'
      els.panel.style.top = y + 'px'
      els.panel.style.right = 'auto'
      els.panel.style.bottom = 'auto'
      // 过渡动画期间 getBoundingClientRect 还是起始值，直接存目标坐标
      blSave(POS_KEY, JSON.stringify({ x: x, y: y }))
      setTimeout(function () { els.panel.classList.remove('bl-snap') }, 220)
    }
    function bindPanelDrag() {
      var hd = els.panel.querySelector('.bl-hd')
      if (!hd || hd.dataset.blDrag) return
      hd.dataset.blDrag = '1'
      var drag = null
      hd.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return
        if (!S.open || els.panel.style.display === 'none') return
        var t = ev.target
        if (t && t.closest && t.closest('button,select,a,label,input,textarea')) return
        var r = els.panel.getBoundingClientRect()
        drag = { ox: ev.clientX - r.left, oy: ev.clientY - r.top }
        els.panel.classList.remove('bl-snap')
        hd.classList.add('bl-drag')
        try { hd.setPointerCapture(ev.pointerId) } catch (e) {}
        ev.preventDefault()
      })
      hd.addEventListener('pointermove', function (ev) {
        if (!drag) return
        var vw = document.documentElement.clientWidth
        var vh = document.documentElement.clientHeight
        var w = els.panel.offsetWidth
        var hh = els.panel.offsetHeight
        var x = Math.min(Math.max(ev.clientX - drag.ox, 0), Math.max(0, vw - w))
        var y = Math.min(Math.max(ev.clientY - drag.oy, 0), Math.max(0, vh - hh))
        els.panel.style.left = x + 'px'
        els.panel.style.top = y + 'px'
        els.panel.style.right = 'auto'
        els.panel.style.bottom = 'auto'
      })
      function end(ev) {
        if (!drag) return
        drag = null
        hd.classList.remove('bl-drag')
        try { hd.releasePointerCapture(ev.pointerId) } catch (e) {}
        snapToEdge()
      }
      hd.addEventListener('pointerup', end)
      hd.addEventListener('pointercancel', function () { drag = null; hd.classList.remove('bl-drag') })
    }
    function bindPanelResize() {
      if (bindPanelResize.done) return
      bindPanelResize.done = true
      window.addEventListener('resize', function () {
        if (els.panel && S.open && savedPanelPos()) applyPanelPos()
      })
    }

    // ------------------------------------------- 地球钮叠到壁纸宝珠下（v0.5）

    // 当 bg-atelier 的宝珠存在时：侧栏原生 🌐 占位隐藏，地球改为 fixed 小圆钮叠在
    // 宝珠正上方（v0.6：地球在上、紫球在下；无白边；FAB 22px），整列以低谷时段卡
    // 中线为对称轴居中；空档大时整列右移吸附卡片左缘。让位量写进宝珠的 CSS 变量
    // （--bga-orb-dy/--bga-orb-dx，bg-atelier 侧只有被动 transform），几何单点归本插件。
    var STACK_FAB = 22  // 必须与 CSS .bl-fab 尺寸一致
    var STACK_GAP = 5
    // 固定浮球（叠列地球钮 / 无 slots 时的兜底球）用的是近上限 z-index——正常页面上
    // 必须盖住侧栏才能点得到；但设置页/对话框开着时，它就压在人家的内容上了（用户反馈
    // "左下角地图 UI 优先级太高，点开设置也能看到他"）。这里统一判定"该让位"，让位＝
    // 隐藏：设置页里本来就有「打开观察窗」按钮，入口不会丢。
    function fabShouldYield() {
      if (S.settingsUi > 0) return true
      // 顺手覆盖其它弹层：DSH 若用 role/aria-modal 标记对话框，浮球一并让位（探不到就是
      // 没有，多一次 querySelector，600ms 一轮，代价可忽略）。
      try { return !!document.querySelector('[role="dialog"],[aria-modal="true"]') } catch (e) { return false }
    }
    function syncFabYield() {
      var disp = fabShouldYield() ? 'none' : ''
      if (S.stackedFab) S.stackedFab.style.display = disp
      var fb = document.getElementById('bl-fab-fallback')
      if (fb) fb.style.display = disp
    }
    function stackedPossible() { return !!document.querySelector('.bga-orb') }
    function stackDotTick() {
      if (S.stackedFab) {
        var dot = S.stackedFab.querySelector('.bl-fab-dot')
        if (dot) dot.classList.toggle('bl-off', !(S.state && S.state.alive))
      }
    }
    function ensureStackedFab() {
      if (S.stackedFab) return S.stackedFab
      if (!stackedPossible()) return null
      ensureStyles()
      var b = document.createElement('button')
      b.id = 'bl-fab-stacked'
      b.className = 'bl-fab bl-fab-stacked'
      b.innerHTML = '🌐<span class="bl-fab-dot bl-off"></span>'
      b.title = '浏览器观察窗'
      b.addEventListener('click', togglePanel)
      document.body.appendChild(b)
      S.stackedFab = b
      return b
    }
    function stackedTick() {
      try {
        syncFabYield()
        var orb = document.querySelector('.bga-orb')
        if (!orb) {
          S.stacked = false
          if (S.stackedFab) S.stackedFab.style.display = 'none'
          return
        }
        S.stacked = true
        var fab = ensureStackedFab()
        if (!fab) return
        var core = orb.querySelector('.bga-orb-core') || orb
        var cell = orb.getBoundingClientRect()          // translate 不影响布局盒
        var wO = core.offsetWidth || 20
        var hO = core.offsetHeight || 20
        var colW = Math.max(wO, STACK_FAB)
        var ring = document.querySelector('.dshw_footRing')
        var ringR = ring ? ring.getBoundingClientRect() : null
        var cy0 = cell.top + cell.height / 2            // 宝珠单元布局中心（Y）
        var cx0 = cell.left + cell.width / 2            // 宝珠单元布局中心（X）

        // X：宝珠与低谷卡空档 ≥28px 时整列右移，列右缘贴卡片左缘 -10px
        var dx = 0
        if (ringR && (ringR.left - (cx0 + colW / 2) >= 28)) {
          dx = (ringR.left - 10 - colW / 2) - cx0
        }

        // Y：两圆圆心距 d = 半径和 + 间隙；有卡时整对以卡中线为对称轴（地球在上）
        var d = (hO + STACK_FAB) / 2 + STACK_GAP
        var dy, fabTop
        if (ringR) {
          var C = ringR.top + ringR.height / 2
          var orbCenter = C + d / 2
          var fabCenter = C - d / 2
          dy = orbCenter - cy0
          fabTop = fabCenter - STACK_FAB / 2
        } else {
          dy = 0
          fabTop = (cy0 - hO / 2) - STACK_GAP - STACK_FAB   // 地球紧贴宝珠上方
        }
        orb.style.setProperty('--bga-orb-dy', dy.toFixed(2) + 'px')
        orb.style.setProperty('--bga-orb-dx', dx.toFixed(2) + 'px')

        fab.style.display = fabShouldYield() ? 'none' : ''
        fab.style.left = Math.round(cx0 + dx - STACK_FAB / 2) + 'px'
        fab.style.top = Math.round(Math.max(4, fabTop)) + 'px'
        stackDotTick()
      } catch (e) {
        // 任何测量异常都不能吃掉地球钮：退回原生槽位显示
        S.stacked = false
        if (S.stackedFab) S.stackedFab.style.display = 'none'
      }
    }
    function startStackTicker() {
      if (startStackTicker.done) return
      startStackTicker.done = true
      stackedTick()
      var t = setInterval(stackedTick, 600)
      window.addEventListener('resize', stackedTick)
      // 无独立清理：生命周期与页面共存；插件停用时整页重载才会移除。
      void t
    }

    // ---------------------------------------------------------------- 显示/隐藏

    // 独立网页观察窗（/bl/view，host 侧同一套接口的全屏页；可丢副屏/全屏）
    function openStandalone() {
      try {
        if (S.viewWin && !S.viewWin.closed) { try { S.viewWin.focus() } catch (e) {} return true }
        var w = window.open('/bl/view', 'dshBlLiveView')
        if (!w) return false                       // 被弹窗拦截 → 调用方退回内嵌面板
        S.viewWin = w
        if (!S.poll) S.poll = setInterval(pollState, 2500)
        return true
      } catch (e) { return false }
    }
    function fetchSettings() {
      // api() 给的是 Response 不是 JSON —— v0.4.0 这里漏了 .json()，j.liveView 恒为
      // undefined，于是盘上存着 standalone、页面里 S.liveView 仍是 false：地球钮又
      // 弹回内嵌面板。v0.4.1 修回（顺带 no-store，宿主本就发 no-store，双保险）。
      return api('/bl/settings.json', { cache: 'no-store' })
        .then(function (r) { return r && r.ok ? r.json() : null })
        .then(function (j) {
          if (j && typeof j === 'object') { S.liveView = j.liveView === 'standalone'; return j }
          return null
        }).catch(function () { return null })
    }

    // 切形态要立刻把手上的窗口交接过去，不用退出重进：
    // 独立网页 = 收掉内嵌面板、正在看的话弹出 /bl/view（被拦弹窗则保留面板）；
    // 内嵌面板 = 关掉独立页、正在看的话显示面板。
    function applyLiveView() {
      var watching = S.open || !!(S.viewWin && !S.viewWin.closed)
      if (S.liveView) {
        var opened = !watching || openStandalone()
        if (opened && S.open) hidePanel(false)
      } else {
        if (S.viewWin && !S.viewWin.closed) { try { S.viewWin.close() } catch (e) {} }
        S.viewWin = null
        if (watching) showPanel(true)
      }
    }

    function showPanel(userInitiated) {
      if (S.liveView && openStandalone()) {
        if (userInitiated) { S.userClosed = false; S.hideUntil = 0 }
        return
      }
      buildPanel()
      if (userInitiated) { S.userClosed = false; S.hideUntil = 0 }
      S.open = true
      els.panel.style.display = 'flex'
      applyPanelPos()
      openStream()
      if (!S.poll) S.poll = setInterval(pollState, 2500)
      pollState()
    }
    function hidePanel(byUser) {
      S.open = false
      if (els.panel) els.panel.style.display = 'none'
      closeStream()
      if (byUser) {
        S.hideUntil = Date.now() + 60000
        S.userClosed = true   // 用户主动收走：本页面内不再自动弹，除非再点 🌐
      }
    }
    function togglePanel() {
      ensureStyles()
      if (S.open) hidePanel(true)
      else showPanel(true)
    }

    // ---------------------------------------------------------------- 浮动球 fallback（无 slots 时自建）

    function ensureFallbackFab() {
      if (document.getElementById('bl-fab-fallback')) return
      ensureStyles()
      var b = document.createElement('button')
      b.id = 'bl-fab-fallback'
      b.className = 'bl-fab'
      b.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:2147483050;box-shadow:0 6px 20px rgba(0,0,0,.22)'
      b.innerHTML = '🌐<span class="bl-fab-dot bl-off"></span>'
      b.title = '浏览器观察窗'
      b.addEventListener('click', togglePanel)
      document.body.appendChild(b)
      setInterval(function () {
        var dot = b.querySelector('.bl-fab-dot')
        if (dot) dot.classList.toggle('bl-off', !(S.state && S.state.alive))
        syncFabYield()   // 兜底球也是 fixed 近上限层级，弹层开着照样要让位
      }, 3000)
    }

    // ---------------------------------------------------------------- 设置页分区

    function SettingsSection() {
      var st = React.useState(null)
      var state = st[0], setState = st[1]
      var cg = React.useState(null)
      var cfg = cg[0], setCfg = cg[1]
      var pr = React.useState('')
      var proxy = pr[0], setProxy = pr[1]
      var ex = React.useState('')
      var extra = ex[0], setExtra = ex[1]
      var note = React.useState('')
      var noteTxt = note[0], setNote = note[1]
      var filled = React.useState(false)
      var isFilled = filled[0], setFilled = filled[1]

      function loadCfg() {
        // 同上：Response 要先 .json()，否则 cfg 是个 Response 对象、cfg.liveView 恒
        // undefined，设置页每次重进都高亮「内嵌面板」。
        api('/bl/settings.json', { cache: 'no-store' }).then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) {
          if (!j || typeof j !== 'object') return
          setCfg(j)
          S.liveView = j.liveView === 'standalone'
          if (!isFilled) { setProxy(j.proxy || ''); setExtra(j.extraArgs || ''); setFilled(true) }
        })
      }
      React.useEffect(function () {
        S.settingsUi++
        syncFabYield()
        var t
        var tick = function () { api('/bl/ping').then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) { if (j) setState(j) }) }
        tick(); loadCfg()
        t = setInterval(tick, 4000)
        return function () { clearInterval(t); S.settingsUi--; syncFabYield() }
      }, [])
      function put(patch, msg) {
        fetch('/bl/settings.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (j && j.settings) {
              setCfg(j.settings)
              var next = j.settings.liveView === 'standalone'
              if (next !== S.liveView) { S.liveView = next; applyLiveView() }
            }
            setNote(msg || '已保存')
            setTimeout(function () { setNote('') }, 2600)
          }).catch(function () { setNote('保存失败') })
      }
      var lab = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', width: 96, flex: 'none' }
      var box = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }
      var inp = { flex: '1', minWidth: 160, fontSize: 12, padding: '4px 7px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' }
      // cfg 还在飞（首次渲染 null）时先拿 S.liveView 顶上，别让「内嵌面板」闪一下选中态
      var lv = cfg ? cfg.liveView : (S.liveView ? 'standalone' : 'panel')
      return h('div', { className: 'bl-settings' },
        h('p', { style: { fontSize: 12.5, lineHeight: 1.8, margin: '2px 0 10px' } },
          '让 agent 驱动真实浏览器（本机 Chrome/Edge），你在观察窗里实时可见、可直接接管。',
          '共 17 个 browser_* 工具：open/navigate/snapshot/click/move/type/upload/press/scroll/wait/eval/text/screenshot/tabs/history/downloads/close。',
          '登录态保存在 ' + '$DSH_HOME/dsh-browser-live/chrome-profile。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 } },
          h('span', { className: 'bl-dot' + (state && state.alive ? ' on' : ''), style: { width: 9, height: 9 } }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, state && state.alive ? '浏览器运行中' : '浏览器未运行（agent 调用工具时自动拉起）'),
          h('button', { className: 'bl-btn', onClick: togglePanel }, (S.open || (S.viewWin && !S.viewWin.closed)) ? '收起/聚焦观察窗' : '打开观察窗')),
        h('div', { style: box },
          h('span', { style: lab }, '观察窗形态'),
          h('button', { className: 'bl-btn' + (lv !== 'standalone' ? ' bl-on' : ''), onClick: function () { put({ liveView: 'panel' }, '已切回 DSH 内嵌面板') }, title: '在 DSH 右下角浮动面板里看' }, '内嵌面板'),
          h('button', { className: 'bl-btn' + (lv === 'standalone' ? ' bl-on' : ''), onClick: function () { put({ liveView: 'standalone' }, '已切换：独立网页（/bl/view）') }, title: '弹出独立网页，可拖到副屏、F11 全屏' }, '独立网页'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '独立网页 = 新标签页里的全屏观察窗；面板标题栏的 ⧉ 也能随时弹出')),
        h('div', { style: box },
          h('span', { style: lab }, '代理服务器'),
          h('input', { style: inp, placeholder: '如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080；留空=跟随系统', value: proxy, onChange: function (e) { setProxy(e.target.value) } }),
          h('button', { className: 'bl-btn', onClick: function () { put({ proxy: proxy.trim() }, '代理已保存（下次拉起浏览器生效）') } }, '保存')),
        h('div', { style: box },
          h('span', { style: lab }, '额外启动参数'),
          h('input', { style: inp, placeholder: '空格分隔，追加到 Chrome 命令行，如 --host-resolver-rules="MAP x.y.z.w 127.0.0.1"', value: extra, onChange: function (e) { setExtra(e.target.value) } }),
          h('button', { className: 'bl-btn', onClick: function () { put({ extraArgs: extra }, '启动参数已保存（下次拉起浏览器生效）') } }, '保存')),
        noteTxt ? h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary,#5b8def)', margin: '2px 0 0' } }, noteTxt) : null,
        h('p', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', margin: '8px 0 0' } },
          '代理与额外参数改动不在已运行的浏览器上生效：点面板「⏹ 关浏览器」或让 agent 关闭后重新拉起即带上；',
          '独立网页形态下 agent 冷启动浏览器时会自动弹 /bl/view（被浏览器拦弹窗时自动退回内嵌面板）。'))
    }

    // ---------------------------------------------------------------- apply

    exports.apply = function apply(ctx) {
      var slots
      try { slots = ctx.get('slots') } catch (e) { slots = undefined }
      // 样式必须在任何钮出现之前注入（否则重启冷启动时 🌐 是裸 button，
      // 叠列钮也会因为缺少 position:fixed 而“消失”，要点开面板才恢复）
      try { ensureStyles() } catch (e) {}
      // 观察窗形态（内嵌面板 / 独立网页 /bl/view）先读出来，别等第一次自动弹
      fetchSettings()
      if (slots === undefined || !React) {
        // 非 web/无 React 环境：自建浮动球兜底
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureFallbackFab)
        else ensureFallbackFab()
        return
      }
      slots.inject('sidebar.footer.action', function () {
        return slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-browser-live.fab', order: 1, label: '浏览器观察窗' },
          function Fab(props) {
            var st = React.useState(false)
            var alive2 = st[0], setAlive2 = st[1]
            var stk = React.useState(S.stacked)
            var stacked2 = stk[0], setStacked2 = stk[1]
            React.useEffect(function () {
              var tick = function () {
                api('/bl/ping').then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) { setAlive2(!!(j && j.alive)) }).catch(function () {})
                setStacked2(S.stacked || stackedPossible())
              }
              tick()
              var t = setInterval(tick, 800)
              return function () { clearInterval(t) }
            }, [])
            if (stacked2) {
              // 叠列模式：原生占位隐藏，真正的 🌐 由 stackedTick 在宝珠上方绘制
              return h('span', { style: { display: 'inline-block', width: 0, height: 0, overflow: 'hidden' } })
            }
            return h('button', {
              className: 'bl-fab',
              title: (props && props.label) || '浏览器观察窗',
              onClick: togglePanel,
              dangerouslySetInnerHTML: { __html: '🌐<span class="bl-fab-dot' + (alive2 ? '' : ' bl-off') + '"></span>' },
            })
          },
        )
      })
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'dsh-browser-live.settings', order: 62, label: '浏览器观察窗' },
          function () { return h(SettingsSection, null) },
        )
      })
      // 预热状态轮询（决定浮球绿点与自动弹窗）；bg-atelier 宝珠存在时叠列地球钮
      startStackTicker()
      if (!S.poll) { S.poll = setInterval(pollState, 2500); pollState() }
    }

    exports.inject = ['slots']
    return module.exports
  },
})
