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
    // 2026-09-11：DSH 主题全局给了 `*{corner-shape:superellipse(1.5)}`（方圆角），
    // 于是所有 `border-radius:50%` 的真圆都会被画成圆角方块（按钮 hover 底衬尤其明显）。
    // 宿主自己的圆形控件都写 `corner-shape:round` 豁免，这里照做；旧内核会自动忽略该属性。
    var CSS = [
      '.bl-fab{width:22px;height:22px;border-radius:50%;corner-shape:round;border:none;background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;position:relative;font-size:15px;line-height:1;padding:0;flex:none;transition:opacity .3s ease,filter .3s ease}',
      '.bl-fab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
      '.bl-fab-dot{position:absolute;right:0;top:0;width:5px;height:5px;border-radius:50%;corner-shape:round;background:#3fb96f;box-shadow:0 0 4px rgba(63,185,111,.8)}',
      '.bl-fab-dot.bl-off{background:#b9bfc9;box-shadow:none}',
      '.bl-fab-stacked{position:fixed;z-index:2147483049}',
      // 退路样式：量不到遮罩层级时，浮球仍留在顶层，但自己糊成一层磨砂影（小玻璃板 +
      // backdrop-filter 把它身后的内容糊掉），看着像沉在下面，而不是硬邦邦压在上面。
      '.bl-fab-ghost{opacity:.3;filter:blur(2px) saturate(.7);pointer-events:none}',
      '.bl-fab-ghost::before{content:"";position:absolute;inset:-8px -8px -6px;border-radius:14px;background:rgba(20,18,26,.3);backdrop-filter:blur(7px) saturate(.9);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}',
      // 兜底球的层级也走样式表（不写行内）：让位时把 style.zIndex 置空才能回到基值
      '.bl-fab-fallback{position:fixed;left:18px;bottom:18px;z-index:2147483050;box-shadow:0 6px 20px rgba(0,0,0,.22)}',
      // 面板几何全部走**视口百分比**（v0.12.0）：宽/高/宽屏宽/边距都是"屏幕的多少"，
      // 通过 CSS 变量由设置注入（--bl-pw / --bl-ph / --bl-pww / --bl-gap）。
      // 历史：原来写死 560px/900px —— 2026-09-13 改成 clamp(300px→560px) 那一版仍然有硬上限，
      // 窗口再宽面板也不再变大，宽屏上反而相对变小，用起来就是"固定尺寸"。现在只有两个兜底：极窄窗口的可读下限 min(280px,90vw)（它自己也随视口缩），以及不越出视口的 max-*。
      // 高度的同类问题更明显：以前面板高度完全由截图的宽高比决定，窄而高的窗口里会顶穿视口，
      // 所以现在给 max-height: <ph>vh，舞台 flex:1 + 图片 contain（**照搬独立页 /bl/view 已验证的写法**）。
      '.bl-panel{position:fixed;right:var(--bl-gap,clamp(10px,1.2vw,22px));bottom:var(--bl-gap,clamp(10px,1.2vh,22px));z-index:2147483050;width:calc(var(--bl-pw,42) * 1vw);min-width:min(280px,90vw);max-width:calc(100vw - 24px);max-height:calc(var(--bl-ph,52) * 1vh);background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary,#222)}',
      '.bl-panel.bl-wide{width:calc(var(--bl-pww,66) * 1vw)}',
      '.bl-panel.bl-snap{transition:left .16s ease,top .16s ease}',
      '.bl-hd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));flex:none;cursor:grab;user-select:none}',
      '.bl-hd.bl-drag{cursor:grabbing}',
      '.bl-dot{width:8px;height:8px;border-radius:50%;corner-shape:round;background:#b9bfc9;flex:none}',
      '.bl-dot.on{background:#3fb96f;box-shadow:0 0 6px rgba(63,185,111,.9)}',
      // 黄灯 = 浏览器还在跑，但画面已经断流（正在自动重连）。绿灯只代表"画面真的在更新"。
      '.bl-dot.warn{background:#e0a63c;box-shadow:0 0 6px rgba(224,166,60,.85)}',
      // 灰实心 = 收起成一条时主动暂停了画面流（不是断流，也不是浏览器没跑）
      '.bl-dot.paused{background:#8b93a0}',
      '.bl-status{flex:none;font-size:11px;color:#e0a63c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%}',
      // 画面上盖一条"这不是实时画面"，避免把最后一帧当成现场
      '.bl-stale{position:absolute;left:50%;top:10px;transform:translateX(-50%);background:rgba(120,78,10,.86);color:#ffe9c2;border-radius:8px;padding:3px 10px;font-size:11px;line-height:16px;pointer-events:none;white-space:nowrap}',
      '.bl-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}',
      '.bl-url{flex:none;max-width:38%;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.bl-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:inherit;border-radius:7px;height:22px;padding:0 8px;cursor:pointer;font-size:11px;flex:none}',
      '.bl-btn.bl-on{background:var(--dsw-alias-interactive-bg-hover,rgba(80,130,220,.16));border-color:#5b8def}',
      '.bl-btn.danger{color:#d0453f;border-color:rgba(208,69,63,.45)}',
      '.bl-tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));overflow-x:auto;flex:none}',
      '.bl-tab{flex:none;max-width:min(150px,18vw);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));border-radius:7px;padding:2px 8px;cursor:pointer}',
      '.bl-tab.sel{border-color:#5b8def;background:rgba(91,141,239,.14)}',
      // 舞台吃满剩余高度（min-height:0 才允许 flex 子项收缩），图片按比例装进这个盒子并居中 ——
      // 于是面板高度受 max-height 约束，不再被截图的宽高比牵着走，也不会变形。
      '.bl-stage{position:relative;line-height:0;background:#101418;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.bl-stage img{max-width:100%;max-height:100%;width:auto;height:auto;display:block;user-select:none;-webkit-user-drag:none}',
      '.bl-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa4b2;line-height:1.5;text-align:center;padding:20px;font-size:12px}',
      '.bl-act{position:absolute;left:8px;bottom:8px;right:8px;background:rgba(10,14,20,.72);color:#dfe6ef;border-radius:8px;padding:3px 8px;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;transition:opacity .25s}',
      '.bl-act.show{opacity:1}',
      '.bl-ft{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));flex-wrap:wrap}',
      '.bl-ft label{color:var(--dsw-alias-label-secondary,#777);display:inline-flex;align-items:center;gap:4px}',
      '.bl-ft select{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:inherit;font-size:11px;height:22px}',
      '.bl-dl{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}',
      '.bl-dl a{color:#5b8def;text-decoration:none;max-width:min(160px,20vw);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid rgba(91,141,239,.4);border-radius:6px;padding:1px 7px}',
      '.bl-key{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}',
      // 收起态：只剩底部一条细把手，基本不挡对话；点它（或 🌐）再展开盖回上层
      '.bl-panel.bl-min{width:auto;min-width:0;max-width:min(calc(var(--bl-pww,66) * 1vw),calc(100vw - 24px));border-radius:12px}',
      '.bl-panel.bl-min .bl-tabs,.bl-panel.bl-min .bl-stage,.bl-panel.bl-min .bl-ft{display:none}',
      '.bl-panel.bl-min .bl-hd{padding:6px 10px;border-bottom:0}',
      '.bl-panel.bl-min .bl-url{max-width:140px}',
      '.bl-panel.bl-min #bl-wide,.bl-panel.bl-min #bl-pop{display:none}',
    ].join('\n')
    function ensureStyles() {
      if (document.querySelector('style[data-bl-styles]')) return
      var el = document.createElement('style')
      el.setAttribute('data-bl-styles', '1')
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ---------------------------------------------------------------- 状态

    /**
     * 把独立观察窗抢到前台。
     * `window.open` 在 Chrome 里通常把新页开成**后台标签**（除非是极短手势里同步开），
     * 已经开着的窗口再点🌐也不会被带上来 —— 用户视角就是"点了没反应"。
     * 这里做三件事：先 blur() 再 focus()（对"已开着但在后台/被别窗口盖住"最有效）、
     * 连续补几次（部分窗口管理器会吃掉首次 focus）、并把内联脚本 focus 也试一遍。
     * 失败静默（跨窗口权限策略允许拒绝），不影响其它逻辑。
     */
    function focusViewer(w, tries) {
      var n = tries || 5
      for (var i = 0; i < n; i++) {
        (function (k) {
          setTimeout(function () {
            try {
              if (!w || w.closed) return
              if (k) { try { w.blur() } catch (e) {} }
              try { w.focus() } catch (e) {}
              try { if (w.document && w.document.body && w.document.body.focus) w.document.body.focus() } catch (e) {}
            } catch (e) { /* 跨窗口权限被拒就放弃 */ }
          }, k * 180)
        })(i)
      }
    }

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
      autoFolded: false,   // 因设置页开着而被收进独立页的那次面板（离开设置页时按需还原）
      es: null,
      poll: null,
      stopBtnArmed: false,
      state: null,
      // 画面健康（v0.13.0）：把"浏览器在不在"与"画面还在不在更新"分开记 ——
      // 用户 2026-09-14 反馈：断流后绿灯还亮着，容易把最后一帧当成实时画面。
      lastFrameAt: 0,     // 最近一帧到达的时刻（0 = 从没收到过）
      streamError: false, // SSE 报过错、正在自动重连
      health: null,       // 1s 心跳（只在面板开着时跑）
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
        '  <span class="bl-status" id="bl-status"></span>',
        '  <button class="bl-btn" id="bl-wide" title="加宽">↔</button>',
        '  <button class="bl-btn" id="bl-pop" title="弹出为独立网页（可拖到副屏、全屏）">⧉</button>',
        '  <button class="bl-btn" id="bl-min" title="收起成底部一条（不挡对话）">—</button>',
        '  <button class="bl-btn" id="bl-hide" title="收走面板">✕</button>',
        '</div>',
        '<div class="bl-tabs" id="bl-tabs" hidden></div>',
        '<div class="bl-stage" id="bl-stage">',
        '  <img id="bl-img" alt="" draggable="false">',
        '  <div class="bl-empty" id="bl-empty">等待 agent 打开浏览器…<br>调用任意 browser_* 工具后这里会实时显示画面</div>',
        '  <div class="bl-stale" id="bl-stale" hidden>⏸ 画面已停 · 最后更新于 <span id="bl-stale-age">0</span> 秒前</div>',
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
      els.status = p.querySelector('#bl-status')
      els.stale = p.querySelector('#bl-stale')
      els.staleAge = p.querySelector('#bl-stale-age')
      els.tabs = p.querySelector('#bl-tabs')
      els.stage = p.querySelector('#bl-stage')
      els.img = p.querySelector('#bl-img')
      els.empty = p.querySelector('#bl-empty')
      els.act = p.querySelector('#bl-act')
      els.key = p.querySelector('#bl-key')
      els.dl = p.querySelector('#bl-dl')
      els.minBtn = p.querySelector('#bl-min')
      els.min = p

      p.querySelector('#bl-hide').addEventListener('click', function () { hidePanel(true) })
      p.querySelector('#bl-wide').addEventListener('click', function () {
        S.wide = !S.wide
        p.classList.toggle('bl-wide', S.wide)
        applyPanelPos()   // 宽度变化后把面板钳回视口
      })
      // ⧉ 是用户主动点击：把弹出的独立观察窗抢到前台（否则会被开在后台标签里，看着像没反应）
      p.querySelector('#bl-pop').addEventListener('click', function () { openStandalone(true) })
      // — 收起成底部一条；⇧点标题行也能切换，不用去够那个小按钮
      p.querySelector('#bl-min').addEventListener('click', function (ev) { ev.stopPropagation(); toggleMin() })
      p.querySelector('.bl-hd').addEventListener('click', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('button')) return   // 点按钮不算
        if (S.min || ev.shiftKey) toggleMin()
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
      bindPanelDrag()
      bindPanelResize()
      setMin(savedMin(), false)   // 记住上次是收起还是展开
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
          S.lastFrameAt = Date.now()
          S.streamError = false
          S.alive = true
          els.title.textContent = d.title || '浏览器观察窗'
          els.url.textContent = trimUrl(d.url)
          S.pageTitle = d.title || ''
          updateMinTitle()   // 收起态那条把手也要显示当前页面名
          renderHealth()     // 绿灯只由这一处点亮：画面真的到了才算"实时"
        })
        es.addEventListener('offline', function () {
          S.alive = false
          S.streamError = false   // 宿主明确说浏览器关了，不是"断流"
          renderHealth()
        })
        // 断了就是断了：EventSource 自己会重连，但**不能**让绿灯继续亮着装作在播
        //（用户 2026-09-14 反馈：断流后还能把最后一帧当成实时画面）。
        es.onopen = function () { S.streamError = false; renderHealth() }
        es.onerror = function () { S.streamError = true; renderHealth() }
      } catch (e) { /* 无 EventSource：只靠 /bl/state 轮询文字信息 */ }
    }
    function closeStream() {
      if (S.es) { try { S.es.close() } catch (e) {} S.es = null }
    }

    // ------------------------------------------------------------ 画面健康（v0.13.0）
    // 三个**独立**的事实，别再混成一个绿点（用户 2026-09-14 反馈）：
    //   ① 浏览器运行中 —— 宿主 /bl/state 的 alive（轮询 2.5s）
    //   ② 画面在更新   —— SSE 最近一帧的到达时间（阈值按最慢档 1 FPS 留三次余量）
    //   ③ 主动暂停     —— 收起成一条时**不拉画面流**（v0.14.0，省截图/传输/解码），不算断流
    // 绿灯 = ①② 都成立；黄灯 = 浏览器在跑但画面断了（自动重连中），画面上还盖一条
    // "画面已停 · 最后更新于 X 秒前"；灰实心灯 = ③ 收起暂停。
    var STALE_MS = 3500
    function hostAlive() { return !!(S.state && S.state.alive) }
    /** 纯函数（测试缝 tools/verify-panel-health.mjs）：几个事实 ⇒ 该亮哪种灯。
     *  hostAlive=浏览器在跑；hasStream=有 SSE 连接；lastFrameAt=最近一帧时刻（0=从没收到）；
     *  paused=主动暂停（收起态）。 */
    function computeHealth(facts) {
      var f = facts || {}
      if (!f.hostAlive) return 'off'
      if (f.paused) return 'paused'
      var last = Number(f.lastFrameAt) || 0
      if (!f.hasStream && last === 0) return 'alive'   // 老内核无 EventSource：只能说"在运行"
      if (last === 0) return 'stale'                   // 有连接但一帧都没来
      return (Number(f.now) - last) < STALE_MS ? 'live' : 'stale'
    }
    function healthState() {
      return computeHealth({
        hostAlive: hostAlive(),
        hasStream: !!S.es,
        lastFrameAt: S.lastFrameAt,
        now: Date.now(),
        paused: S.open && S.min === true,
      })
    }
    /** 灯旁边写什么：从没收到过帧 / 中途断了 / 被收起暂停，是三件事。 */
    function healthText(state, lastFrameAt) {
      if (state === 'paused') return '已暂停（收起中）'
      if (state !== 'stale') return ''
      return Number(lastFrameAt) > 0 ? '正在重连' : '还没收到画面'
    }
    function renderHealth() {
      if (!els.dot || !S.open) return
      var st = healthState()
      els.dot.classList.toggle('on', st === 'live')
      els.dot.classList.toggle('warn', st === 'stale')
      els.dot.classList.toggle('paused', st === 'paused')
      if (els.status) els.status.textContent = healthText(st, S.lastFrameAt)
      if (els.stale) {
        var showStale = st === 'stale' && S.lastFrameAt > 0
        els.stale.hidden = !showStale
        if (showStale && els.staleAge) {
          els.staleAge.textContent = String(Math.max(0, Math.round((Date.now() - S.lastFrameAt) / 1000)))
        }
      }
      updateMinTitle()   // 收起成一条时也要能看出"画面停了/被暂停"
    }
    /** 画面流该不该拉：只有"面板开着且没被收成一条"才拉。
     *  收起时主动断流 —— 宿主那条 `/bl/stream` 是"无查看者零开销"，断开即真的省掉截图与传输；
     *  状态仍靠 `/bl/state` 轮询维持（标题、灯、agent 动作条照常更新），展开立即恢复。 */
    function applyStreamState() {
      var want = S.open && !S.min
      S.paused = !!(S.open && S.min)
      if (want) { if (!S.es) openStream() } else closeStream()
      renderHealth()
    }
    function startHealthTick() {
      if (S.health) return
      S.health = setInterval(renderHealth, 1000)
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
        if (!S.es) { // 无流时给静态信息（有流时健康状态一律由 renderHealth 单点决定）
          if (!st.alive) { els.empty.style.display = 'flex'; els.img.removeAttribute('src') }
        }
        renderHealth()
      }).catch(function () {})
    }

    // --------------------------------------------------- 面板位置记忆/拖动/贴边

    var POS_KEY = 'bl-panel-pos-v1'
    var MIN_KEY = 'bl-panel-min-v1'   // 收起态（只剩底部一条把手）也记住了，不用每次重收
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

    // ---------------------------------------------------------- 收起态（底部细把手）
    // 用户的实际用法：读对话时不想被盖住 → 收成一条；要盯 agent 时一键盖回上层。
    // 收起态只留标题行（绿点 + 当前页面 + 🌐），整条可继续拖动/贴边。
    function savedMin() { return blLoad(MIN_KEY) === '1' }
    function updateMinTitle() {
      if (!els.title) return
      // 收起成一条时只剩这行字，画面停没停必须从这里也看得出来（否则那条把手还像在实时）
      var stale = S.open && healthState() === 'stale'
      var mark = stale ? ' · ⏸ 画面已停' + (S.lastFrameAt > 0 ? Math.max(0, Math.round((Date.now() - S.lastFrameAt) / 1000)) + 's' : '') : ''
      if (!S.min) { els.title.textContent = (S.pageTitle || '浏览器观察窗') + mark; return }
      var t = (S.state && S.state.tabs || []).filter(function (x) { return x.selected })[0]
      var name = S.pageTitle || (t ? trimUrl(t.url || '') : '')
      els.title.textContent = '浏览器观察窗' + (name ? ' · ' + name : '') + mark + '（点这里展开）'
    }
    function setMin(on, save) {
      S.min = !!on
      if (els.panel) els.panel.classList.toggle('bl-min', S.min)
      if (els.minBtn) els.minBtn.textContent = S.min ? '▴' : '—'
      if (els.minBtn) els.minBtn.title = S.min ? '展开面板' : '收起成底部一条（不挡对话）'
      if (els.min) els.min.classList.toggle('bl-mini', S.min)
      updateMinTitle()
      applyPanelPos()          // 尺寸变了，位置要钳回视口
      // 收起 = 暂停画面流（省截图/传输/解码；宿主 /bl/stream 无查看者零开销），展开立即恢复
      applyStreamState()
      if (save !== false) blSave(MIN_KEY, S.min ? '1' : '0')
    }
    function toggleMin() { setMin(!S.min) }
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
    // "左下角地图 UI 优先级太高，点开设置也能看到他"）。
    // v0.4.2 的让位不再是"消失"，而是**沉到遮罩底下**，跟壁纸宝珠同一待遇：宝珠没有任何
    // 特殊样式，它看着朦胧只是因为 DSH 那层半透明 + backdrop-filter 的遮罩盖在它上面。
    // 我们不知道、也不需要猜遮罩的层级：在浮球中心做一次 elementsFromPoint，挑出"盖住大片
    // 视口"的那个元素，沿它的祖先链取最大数值 z-index，浮球 z 设成它 - 1 —— 同一层磨砂会把
    // 浮球一起糊掉，观感与宝珠完全一致。量不到（没有这样的层 / 层级全是 auto）才退回就地磨砂。
    var YIELD_COVER = 0.25   // 只有覆盖 ≥1/4 视口的层才算"遮罩"，普通控件不算
    function fabShouldYield() {
      if (S.settingsUi > 0) return true
      // 顺手覆盖其它弹层：DSH 若用 role/aria-modal 标记对话框，浮球一并让位（探不到就是
      // 没有，多一次 querySelector，600ms 一轮，代价可忽略）。
      try { return !!document.querySelector('[role="dialog"],[aria-modal="true"]') } catch (e) { return false }
    }
    function overlayZAt(fab) {
      try {
        var r = fab.getBoundingClientRect()
        if (!r.width) return 0
        var hit = document.elementsFromPoint || document.mozElementsFromPoint
        if (!hit) return 0
        var list = hit.call(document, r.left + r.width / 2, r.top + r.height / 2) || []
        var min = (window.innerWidth || 1280) * (window.innerHeight || 800) * YIELD_COVER
        for (var i = 0; i < list.length; i++) {
          var el = list[i]
          if (!el || el.nodeType !== 1) continue
          if (el === fab || el.contains(fab) || fab.contains(el)) continue
          if (el.closest && el.closest('.bl-fab')) continue     // 我们自己的另一个浮球不算遮罩
          var b = el.getBoundingClientRect()
          if (b.width * b.height < min) continue
          var best = 0
          for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
            var z = parseInt(window.getComputedStyle(n).zIndex, 10)
            if (z > best) best = z
          }
          if (best > 0) return best
        }
      } catch (e) { /* 量不动就当没有遮罩，走就地磨砂 */ }
      return 0
    }
    function applyFabYield(fab) {
      if (!fab || !fab.dataset) return
      if (!fabShouldYield()) {
        fab.style.zIndex = ''
        fab.dataset.blYield = ''
        if (fab.classList) fab.classList.remove('bl-fab-ghost')
        return
      }
      var z = overlayZAt(fab)
      if (z > 1) {
        // 真的沉下去了：不加任何装饰性样式，朦胧感由那层遮罩的 backdrop-filter 提供
        fab.style.zIndex = String(z - 1)
        fab.dataset.blYield = 'sunk'
        if (fab.classList) fab.classList.remove('bl-fab-ghost')
      } else {
        fab.style.zIndex = ''
        fab.dataset.blYield = 'ghost'
        if (fab.classList) fab.classList.add('bl-fab-ghost')
      }
    }
    function syncFabYield() {
      applyFabYield(S.stackedFab)
      applyFabYield(document.getElementById('bl-fab-fallback'))
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

        fab.style.display = ''
        fab.style.left = Math.round(cx0 + dx - STACK_FAB / 2) + 'px'
        fab.style.top = Math.round(Math.max(4, fabTop)) + 'px'
        applyFabYield(fab)   // 位置定了再判让位：要让位时得按新位置去量遮罩层级
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
    // steal=true：由用户点击触发 —— 已开着就把它抢到前台，新开的也补一次抢前台
    function openStandalone(steal) {
      try {
        if (S.viewWin && !S.viewWin.closed) {
          try { S.viewWin.focus() } catch (e) {}
          if (steal) focusViewer(S.viewWin, 3)
          return true
        }
        var w = window.open('/bl/view', 'dshBlLiveView')
        if (!w) return false                       // 被弹窗拦截 → 调用方退回内嵌面板
        S.viewWin = w
        if (!S.poll) S.poll = setInterval(pollState, 2500)
        focusViewer(w, steal ? 5 : 2)               // 用户点击时多补几次，确保真的翻到前台
        return true
      } catch (e) { return false }
    }
    /**
     * 面板几何：把设置里的**百分比**注入 CSS 变量（v0.12.0）。
     * 为什么要有这一步：面板原来写死 560px/900px（后来 clamp 到 560px 上限），
     * 宽屏上窗口再宽它也不变 —— 用起来就是"固定尺寸"。现在面板宽/高/宽屏宽/边距都是
     * "视口的百分之多少"，改设置立刻生效（不用重启），窄屏由 CSS 里的 min()/max() 兜底。
     */
    function applyPanelGeometry(cfg) {
      if (!cfg || typeof cfg !== 'object') return
      var root = document.documentElement
      var set = function (name, v, lo, hi) {
        if (v === undefined || v === null || v === '') return
        var n = Number(v)
        if (!isFinite(n)) return
        n = Math.min(hi, Math.max(lo, n))
        root.style.setProperty(name, String(Math.round(n * 10) / 10))
      }
      set('--bl-pw', cfg.panelWidthPct, 15, 95)
      set('--bl-ph', cfg.panelHeightPct, 15, 95)
      set('--bl-pww', cfg.panelWidePct, 15, 98)
      S.geom = { pw: Number(cfg.panelWidthPct) || 42, ph: Number(cfg.panelHeightPct) || 52, pww: Number(cfg.panelWidePct) || 66 }
    }

    function fetchSettings() {
      // api() 给的是 Response 不是 JSON —— v0.4.0 这里漏了 .json()，j.liveView 恒为
      // undefined，于是盘上存着 standalone、页面里 S.liveView 仍是 false：地球钮又
      // 弹回内嵌面板。v0.4.1 修回（顺带 no-store，宿主本就发 no-store，双保险）。
      return api('/bl/settings.json', { cache: 'no-store' })
        .then(function (r) { return r && r.ok ? r.json() : null })
        .then(function (j) {
          if (j && typeof j === 'object') {
            S.liveView = j.liveView === 'standalone'
            applyPanelGeometry(j)          // 面板几何跟着设置走（百分比）
            return j
          }
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

    // 设置页打开时，把摊着的内嵌面板"收"进独立页：/bl/view 可以丢副屏、F11，与设置页互不
    // 干扰。离开设置页时按需还原 —— 但你要是已经把独立页关了才还回面板，还开着就不动，
    // 免得同一画面出现两份。弹窗被浏览器拦掉时（非用户手势有可能）不收，留着面板看。
    function foldPanelToStandalone() {
      if (!S.open) return
      if (!openStandalone()) return
      S.autoFolded = true
      hidePanel(false)
    }
    function unfoldPanelIfNeeded() {
      if (!S.autoFolded) return
      S.autoFolded = false
      var gone = !S.viewWin || S.viewWin.closed
      if (gone && !S.open && Date.now() > S.hideUntil) showPanel(false)
    }

    function showPanel(userInitiated) {
      // 两种情况走独立页：用户选了 standalone；或者**设置页正开着** —— 那块 560px 的窗
      // 摊在设置页上就是把人家内容盖掉，收进 /bl/view 两边各看各的（v0.4.3 选的②）。
      if ((S.liveView || S.settingsUi > 0) && openStandalone(!!userInitiated)) {
        if (userInitiated) { S.userClosed = false; S.hideUntil = 0 }
        return
      }
      buildPanel()
      if (userInitiated) { S.userClosed = false; S.hideUntil = 0 }
      S.open = true
      els.panel.style.display = 'flex'
      applyPanelPos()
      applyStreamState()   // 展开态才拉画面流（收起态主动暂停）
      if (!S.poll) S.poll = setInterval(pollState, 2500)
      startHealthTick()   // 1s 心跳：喂"最后更新于 X 秒前"和绿灯/黄灯的翻转
      pollState()
    }
    function hidePanel(byUser) {
      S.open = false
      if (els.panel) els.panel.style.display = 'none'
      closeStream()
      if (S.health) { clearInterval(S.health); S.health = null }
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
      // 位置与层级都放样式表（.bl-fab-fallback），不能写行内：让位时把 style.zIndex
      // 置空要能回到基值，行内值一置没就真沉到侧栏底下去了。
      b.className = 'bl-fab bl-fab-fallback'
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
      // 面板几何（百分比）：默认值与 DEFAULT_SETTINGS 保持一致
      var gm = React.useState({ pw: 42, ph: 52, pww: 66 })
      var geom = gm[0], setGeom = gm[1]
      var note = React.useState('')
      var noteTxt = note[0], setNote = note[1]
      var filled = React.useState(false)
      var isFilled = filled[0], setFilled = filled[1]
      var bs = React.useState(null)
      var br = bs[0], setBr = bs[1]     // /bl/bridge 状态（P0 用户浏览器桥）

      function loadBridge() {
        api('/bl/bridge', { cache: 'no-store' }).then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) { if (j) setBr(j) })
      }

      function loadCfg() {
        // 同上：Response 要先 .json()，否则 cfg 是个 Response 对象、cfg.liveView 恒
        // undefined，设置页每次重进都高亮「内嵌面板」。
        api('/bl/settings.json', { cache: 'no-store' }).then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) {
          if (!j || typeof j !== 'object') return
          setCfg(j)
          S.liveView = j.liveView === 'standalone'
          applyPanelGeometry(j)
          setGeom({ pw: j.panelWidthPct || 42, ph: j.panelHeightPct || 52, pww: j.panelWidePct || 66 })
          if (!isFilled) { setProxy(j.proxy || ''); setExtra(j.extraArgs || ''); setFilled(true) }
        })
        loadBridge()
      }
      React.useEffect(function () {
        S.settingsUi++
        syncFabYield()
        foldPanelToStandalone()   // 面板摊着就收进独立页，别盖住设置内容（v0.4.3）
        var t
        var tick = function () { api('/bl/ping').then(function (r) { return r && r.ok ? r.json() : null }).then(function (j) { if (j) setState(j) }) }
        tick(); loadCfg()
        t = setInterval(tick, 4000)
        return function () { clearInterval(t); S.settingsUi--; syncFabYield(); unfoldPanelIfNeeded() }
      }, [])
      function put(patch, msg) {
        fetch('/bl/settings.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (j && j.settings) {
              setCfg(j.settings)
              applyPanelGeometry(j.settings)
              setGeom({ pw: j.settings.panelWidthPct || 42, ph: j.settings.panelHeightPct || 52, pww: j.settings.panelWidePct || 66 })
              var next = j.settings.liveView === 'standalone'
              if (next !== S.liveView) { S.liveView = next; applyLiveView() }
            }
            setNote(msg || '已保存')
            setTimeout(function () { setNote('') }, 2600)
            loadBridge()
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
          '共 21 个 browser_* 工具：open/ext_setup/navigate/snapshot/click/move/type/press/scroll/upload/wait/eval/text/read/scrape/search/screenshot/tabs/history/downloads/close。',
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
        // 面板几何：百分比（v0.12.0）。原来写死 px，宽屏上面板不再跟着变大；现在这三项都是"视口百分比"，
        // 改完立刻生效（applyPanelGeometry 直接改 CSS 变量，不用重启、也不用等下次拉帧）。
        h('div', { style: box },
          h('span', { style: lab }, '面板宽度 %'),
          h('input', { style: { ...inp, flex: '0 1 90px', minWidth: 70 }, type: 'number', min: 15, max: 95, value: geom.pw, onChange: function (e) { setGeom({ ...geom, pw: e.target.value }) } }),
          h('span', { style: lab }, '面板高度 %'),
          h('input', { style: { ...inp, flex: '0 1 90px', minWidth: 70 }, type: 'number', min: 15, max: 95, value: geom.ph, onChange: function (e) { setGeom({ ...geom, ph: e.target.value }) } }),
          h('span', { style: lab }, '宽屏宽 %'),
          h('input', { style: { ...inp, flex: '0 1 90px', minWidth: 70 }, type: 'number', min: 15, max: 98, value: geom.pww, onChange: function (e) { setGeom({ ...geom, pww: e.target.value }) } }),
          h('button', {
            className: 'bl-btn', onClick: function () {
              var patch = { panelWidthPct: Number(geom.pw) || 42, panelHeightPct: Number(geom.ph) || 52, panelWidePct: Number(geom.pww) || 66 }
              applyPanelGeometry(patch)                 // 先本地生效，别等往返
              put(patch, '面板尺寸已保存（百分比，即时生效）')
            },
          }, '保存')),
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '-4px 0 8px' } },
          '面板宽/高都是视口百分比 ⇒ 换窗口大小、换显示器都自动等比（窄窗口由可读下限与视口边界兜底）。'),
        h('div', { style: box },
          h('span', { style: lab }, '代理服务器'),
          h('input', { style: inp, placeholder: '如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080；留空=跟随系统', value: proxy, onChange: function (e) { setProxy(e.target.value) } }),
          h('button', { className: 'bl-btn', onClick: function () { put({ proxy: proxy.trim() }, '代理已保存（下次拉起浏览器生效）') } }, '保存')),
        h('div', { style: box },
          h('span', { style: lab }, '额外启动参数'),
          h('input', { style: inp, placeholder: '空格分隔，追加到 Chrome 命令行，如 --host-resolver-rules="MAP x.y.z.w 127.0.0.1"', value: extra, onChange: function (e) { setExtra(e.target.value) } }),
          h('button', { className: 'bl-btn', onClick: function () { put({ extraArgs: extra }, '启动参数已保存（下次拉起浏览器生效）') } }, '保存')),
        // ---- 用哪个浏览器（v0.6.2 三档）----
        // 关键区别：插件自带实例**不受逐站点授权限制**，所以"不是要登录的页面"直接用它就行；
        // 用户的日常浏览器是逐站点授权的，只有确实要借用你的登录态时才值得切过去。
        h('div', { style: box },
          h('span', { style: lab }, '用哪个浏览器'),
          h('button', {
            className: 'bl-btn' + (!cfg || (cfg.backendMode || 'auto') === 'auto' ? ' bl-on' : ''),
            onClick: function () { put({ backendMode: 'auto' }, '已设为默认：免登录页用插件自带实例（免授权、可新开页面）；要登录态的站我在扩展里授权后切你的浏览器') },
            title: '推荐：不用授权的页一律走插件自己的窗口；需要你的登录态时才切到你的浏览器',
          }, '免登录用自带实例（推荐）'),
          h('button', {
            className: 'bl-btn' + (cfg && cfg.backendMode === 'plugin' ? ' bl-on' : ''),
            onClick: function () { put({ backendMode: 'plugin' }, '已锁定：只用插件自带实例（你的日常浏览器一律不参与）') },
            title: '只用自己的实例，永远不碰你的浏览器',
          }, '只用自带实例'),
          h('button', {
            className: 'bl-btn' + (cfg && cfg.backendMode === 'user' ? ' bl-on' : ''),
            onClick: function () { put({ backendMode: 'user' }, '已切换：默认就用你的日常浏览器（逐站点授权、默认只读）') },
            title: '与旧行为一致：默认在你的浏览器里操作，站点需先在扩展里允许',
          }, '只用我的浏览器'),
        ),
        h('div', { style: { fontSize: 11.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 10px' } },
          (cfg && cfg.backendMode === 'user')
            ? '当前：默认在你的日常浏览器里操作（逐站点授权、默认只读；没授权过的站点会直接报"站点未授权"，且不能新开标签页）。'
            : (cfg && cfg.backendMode === 'plugin')
              ? '当前：只用插件自带实例（独立窗口 + 独立 profile，登录态存在插件目录），完全不碰你的日常浏览器；需要你的登录态时它帮不上忙。'
              : '当前（推荐）：「免登录的网页」用 agent 自己的独立窗口开（不受逐站点授权限制、可新开页面），你的浏览器不受影响；'
                + '只有需要"你的登录态"时，我在扩展里给该站点授权后才切到你的浏览器操作，做完再切回独立窗口。'),
        // ---- v0.7：Chrome / Edge 可同时接入，按调用指定 ----
        h('div', { style: box },
          h('span', { style: lab }, '默认浏览器'),
          (function () {
            var list = (br && br.browsers) || []
            var live = list.filter(function (b) { return b.connected })
            var btns = []
            btns.push(h('button', {
              className: 'bl-btn' + (!(br && br.userDefault) ? ' bl-on' : ''),
              title: '不指定：use:"user" 时用任一已接入的浏览器（有多个时按 Chrome → Edge 顺序）',
              onClick: function () { put({ userDefault: '' }, '已清空默认浏览器：use:"user" 时自动挑一个已接入的') },
            }, '自动'))
            ;['chrome', 'edge'].forEach(function (k) {
              var b = list.filter(function (x) { return x.kind === k })[0]
              var on = !!(br && br.userDefault === k)
              btns.push(h('button', {
                className: 'bl-btn' + (on ? ' bl-on' : ''),
                title: b && b.connected ? '这台已接入' : '这台还没接入（在该浏览器里装扩展并点连接）',
                onClick: function () { put({ userDefault: k }, 'use:"user" 时默认用 ' + (k === 'edge' ? 'Edge' : 'Chrome')) },
              }, (k === 'edge' ? 'Edge' : 'Chrome') + (b && b.connected ? ' ✓' : '')))
            })
            return h('span', null, btns)
          })(),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
            '只是 use:"user" 的兜底；工具里直接写 use:"edge" / use:"chrome" 永远优先')),
        // ---- P0：接管你自己的浏览器（扩展路线）----
        h('div', { style: box },
          h('span', { style: lab }, '用户浏览器'),
          h('button', {
            className: 'bl-btn' + (cfg && cfg.userBridge ? ' bl-on' : ''),
            onClick: function () {
              var on = !(cfg && cfg.userBridge)
              put({ userBridge: on }, on ? '桥已开启：在 Chrome/Edge 里装好扩展并粘上 token 即可接管' : '桥已关闭：回到插件自拉实例')
            },
          }, cfg && cfg.userBridge ? '桥已开启' : '桥已关闭'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
            '逐站点授权；默认只读，扩展里打开「允许操作」后可真点击/打字')),
        (cfg && cfg.userBridge)
          ? h('div', { style: { fontSize: 11.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 8px', padding: '7px 9px', borderRadius: 8, border: '1px solid ' + (br && br.connected ? 'rgba(198,40,40,.45)' : 'var(--dsw-alias-border-l2,rgba(127,127,127,.3))') } },
            h('div', null, (function () {
              var list = (br && br.browsers) || []
              var live = list.filter(function (b) { return b.connected })
              if (!live.length) return '⏳ 桥在 127.0.0.1:' + ((br && br.port) || '…') + '，还没有浏览器接入'
              return '🔴 已接入：' + live.map(function (b) {
                return (b.kind === 'edge' ? 'Edge' : b.kind === 'chrome' ? 'Chrome' : b.kind) +
                  '（' + b.tabs + ' 标签' + (b.active ? ' · 当前在用' : '') + '）'
              }).join(' · ')
            })()),
            h('div', { style: { marginTop: 4 } },
              '授权：' + ((br && br.allowAll) ? '所有网站（高风险）' : (((br && br.origins) || []).length ? ((br.origins || []).length + ' 个站点') : '无')) +
              ' · 允许操作：' + ((br && br.allowInput) ? '⚠ 开（可真点击/打字）' : '关（只读）') +
              '（在扩展弹窗里改）'),
            h('div', { style: { marginTop: 4, wordBreak: 'break-all' } }, 'token: ' + ((br && br.token) || '…'),
              h('button', { className: 'bl-btn', style: { marginLeft: 6, height: 22, padding: '0 7px' }, onClick: function () { try { navigator.clipboard.writeText((br && br.token) || '') ; setNote('token 已复制') ; setTimeout(function () { setNote('') }, 2200) } catch (e) { setNote('复制失败，手动从 bridge.json 取') } } }, '复制')),
            (br && br.enabled === false)
              ? h('div', { style: { marginTop: 6 } },
                h('button', {
                  className: 'bl-btn', style: { height: 24, padding: '0 9px' },
                  onClick: function () {
                    api('/bl/settings.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userBridge: true }) })
                      .then(function (r) { return r && r.ok ? r.json() : null })
                      .then(function (j) {
                        if (j && j.ok) { setNote('桥已启用，token 出来了 —— 按下面步骤装扩展'); loadBridge(); setTimeout(function () { setNote('') }, 4000) }
                        else setNote('启用失败：' + ((j && j.error) || '看 DSH 日志'))
                      })
                      .catch(function () { setNote('启用失败，看 DSH 日志') })
                  },
                }, '① 启用用户浏览器桥（现在没开，扩展装了也连不上）'))
              : null,
            h('div', { style: { marginTop: 4 } },
              (br && br.enabled === false ? '② ' : '') + '装扩展（Chrome 和 Edge 各装一次，可同时接入）：',
              h('div', null, '· Edge：地址栏输 edge://extensions → 打开「开发人员模式」→「加载解压缩的扩展」→ 选 ' + ((br && br.extensionDir) || 'extension 目录')),
              h('div', null, '· Chrome：地址栏输 chrome://extensions → 同上流程'),
              h('div', null, '· 装完点工具栏里的扩展图标 → 粘上 token → 点「连接」；再点「允许当前所有标签页」把你要交给我操作的站点一次授权。'),
              h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-label-tertiary)' } },
                '· 也可以直接交给 agent：调 browser_ext_setup —— 它会开桥、把 token 放进剪贴板，并把扩展页与扩展目录一起打开。')),
            h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-label-tertiary)' } },
              '怎么用：要登录的站点先在扩展弹窗里点「允许」（或「允许当前所有标签页」），再让我用 browser_open {use:"edge"} 或 {use:"chrome"} 指定这台浏览器；做完 {use:"plugin"} 切回独立窗口。' +
              '边界：默认只读（能看能导航）；「允许操作」打开后我才能真点击/打字/上传，且只在已授权站点上生效；新建/关闭标签页、改网络仍被拒。browser_close 只断开读取，不关你的浏览器。'))
          : null,
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
    // 测试缝（浏览器端不读）：画面健康判定是"状态反馈可信"的核心，单独可断言，
    // 免得以后有人把绿灯又接回 S.alive 那种"连上了就算在播"的旧口径。
    exports.__blInternals = {
      computeHealth: computeHealth,
      healthText: healthText,
      STALE_MS: STALE_MS,
    }
    return module.exports
  },
})
