// ============================================================================
// dsh-browser-live · Client half v0.1.0
//
// 右下角「浏览器观察窗」：
//   * 侧栏底部注册一个 🌐 按钮（同 dsh-bg-atelier 宝珠姿势）；无 slots 时退化为
//     自建浮动球，功能不变。
//   * 面板实时显示 agent 正在操作的页面（host /bl/stream SSE JPEG 帧），
//     标签条、地址、agent 最近动作、下载快捷取回。
//   * 默认开启「接管」：面板内鼠标点击/滚轮/键盘直接操作真浏览器
//     （前端把显示坐标乘回 CSS 视口坐标 → POST /bl/input → CDP Input）。
//   * agent 冷启动浏览器时自动弹出面板一次；手动收起后 60s 内不再自动弹。
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
      '.bl-fab{width:26px;height:26px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;position:relative;font-size:14px;padding:0}',
      '.bl-fab-dot{position:absolute;right:2px;top:2px;width:7px;height:7px;border-radius:50%;background:#3fb96f;box-shadow:0 0 5px rgba(63,185,111,.8)}',
      '.bl-fab-dot.bl-off{background:#b9bfc9;box-shadow:none}',
      '.bl-panel{position:fixed;right:18px;bottom:18px;z-index:2147483050;width:560px;max-width:calc(100vw - 36px);background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary,#222)}',
      '.bl-panel.bl-wide{width:900px}',
      '.bl-hd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));flex:none}',
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
      })
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
        // agent 冷启动浏览器 → 自动弹出
        if (st.panelWanted && !S.open && Date.now() > S.hideUntil) {
          showPanel()
          postJson('/bl/ack', {})
        }
        if (st.panelWanted && S.open) postJson('/bl/ack', {})
        if (st.alive && !S.wasAlive && !S.open && Date.now() > S.hideUntil) showPanel()
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

    // ---------------------------------------------------------------- 显示/隐藏

    function showPanel() {
      buildPanel()
      S.open = true
      els.panel.style.display = 'flex'
      openStream()
      if (!S.poll) S.poll = setInterval(pollState, 2500)
      pollState()
    }
    function hidePanel(byUser) {
      S.open = false
      if (els.panel) els.panel.style.display = 'none'
      closeStream()
      if (byUser) S.hideUntil = Date.now() + 60000
    }
    function togglePanel() {
      ensureStyles()
      if (S.open) hidePanel(true)
      else showPanel()
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
      }, 3000)
    }

    // ---------------------------------------------------------------- 设置页分区（轻量：状态+说明）

    function SettingsSection() {
      var st = React.useState(null)
      var state = st[0], setState = st[1]
      React.useEffect(function () {
        var t
        var tick = function () { api('/bl/ping').then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) { if (j) setState(j) }) }
        tick()
        t = setInterval(tick, 4000)
        return function () { clearInterval(t) }
      }, [])
      return h('div', { className: 'bl-settings' },
        h('p', { style: { fontSize: 12.5, lineHeight: 1.8, margin: '2px 0 10px' } },
          '让 agent 驱动真实浏览器（本机 Chrome/Edge），你在右下角观察窗里实时可见、可直接接管。',
          '共 16 个 browser_* 工具：open/navigate/snapshot/click/type/upload/press/scroll/wait/eval/text/screenshot/tabs/history/downloads/close。',
          '登录态保存在 ' + '$DSH_HOME/dsh-browser-live/chrome-profile。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { className: 'bl-dot' + (state && state.alive ? ' on' : ''), style: { width: 9, height: 9 } }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, state && state.alive ? '浏览器运行中' : '浏览器未运行（agent 调用工具时自动拉起）'),
          h('button', { className: 'bl-btn', onClick: togglePanel }, S.open ? '收起观察窗' : '打开观察窗'))
      )
    }

    // ---------------------------------------------------------------- apply

    exports.apply = function apply(ctx) {
      var slots
      try { slots = ctx.get('slots') } catch (e) { slots = undefined }
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
            React.useEffect(function () {
              var tick = function () { api('/bl/ping').then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) { setAlive2(!!(j && j.alive)) }).catch(function () {}) }
              tick()
              var t = setInterval(tick, 4000)
              return function () { clearInterval(t) }
            }, [])
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
      // 预热状态轮询（决定浮球绿点与自动弹窗）
      if (!S.poll) { S.poll = setInterval(pollState, 2500); pollState() }
    }

    exports.inject = ['slots']
    return module.exports
  },
})
