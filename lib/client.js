window.__ModuleLoader__.load({
  id: 'dsh-volume-knob',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const LS_KEY = 'dsh-volume-knob/state'
    const MEDIA_PATCH = '__dshVolumeKnobMedia'
    const ROUTE = '/volume-knob/system'
    const TTS_ROUTE = '/dsh-tts/speak'
    const SLOT = 'conversation.input.right' // composer tool row; the mic sits here at order 30
    const ORDER = 40 // right of the microphone button
    const LONG_PRESS_MS = 400
    const DRAG_UP_PX = 18
    const VERSION = '0.4.0'

    // ---------------------------------------------------------------------
    // State shared by the button, its popover and the reader.
    // ---------------------------------------------------------------------
    const state = {
      page: 1, // 0..1 master volume for every in-page <audio>/<video>
      pageMuted: false,
      reading: false,
      busy: false, // synthesizing the first chunk
      note: '',
      system: null, // { volume: 0..100, muted: boolean }
      systemSupported: null,
      systemReason: '',
    }
    const listeners = new Set()
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const notify = () => { for (const fn of [...listeners]) { try { fn() } catch { /* listener isolation */ } } }

    /** Tell the host what happened; the host keeps the last 60 entries. */
    function report (event, detail) {
      try {
        fetch('/volume-knob/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, detail: detail === undefined ? '' : String(detail) }),
          keepalive: true,
        }).catch(() => {})
      } catch { /* diagnostics never break the widget */ }
    }

    const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
    const percent = (value) => Math.round(clamp01(value) * 100)

    function loadState () {
      try {
        const raw = window.localStorage.getItem(LS_KEY)
        if (!raw) return
        const saved = JSON.parse(raw) || {}
        if (typeof saved.page === 'number') state.page = clamp01(saved.page)
        state.pageMuted = !!saved.pageMuted
      } catch { /* private mode / malformed */ }
    }

    function saveState () {
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify({ page: state.page, pageMuted: state.pageMuted }))
      } catch { /* quota or private mode */ }
    }

    // ---------------------------------------------------------------------
    // In-page master volume: dsh-tts plays replies through `new Audio(blob)`
    // and notification plugins use their own elements; patching play() once
    // per document is what lets a single slider cover all of them.
    // ---------------------------------------------------------------------
    function ensureMediaPatch () {
      if (window[MEDIA_PATCH]) return
      const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype
      if (!proto || typeof proto.play !== 'function') return
      const originalPlay = proto.play
      // dsh-tts synthesizes into detached `new Audio(blob)` elements that never
      // enter the DOM, so `querySelectorAll('audio,video')` cannot see them.
      // Remember the elements we saw play: a slider drag then reaches the clip
      // that is sounding right now instead of only the next one.
      const known = new Set()
      const patch = {
        apply (el) {
          try {
            el.volume = state.pageMuted ? 0 : state.page
            if (!known.has(el)) {
              known.add(el)
              if (known.size > 12) known.delete(known.values().next().value)
            }
          } catch { /* element gone */ }
        },
        applyAll () {
          for (const el of [...known]) patch.apply(el)
          try {
            for (const el of document.querySelectorAll('audio,video')) patch.apply(el)
          } catch { /* no document */ }
        },
        /** Silence whatever is playing now (dsh-tts auto-read included). */
        pauseAll (except) {
          const targets = [...known]
          try {
            for (const el of document.querySelectorAll('audio,video')) targets.push(el)
          } catch { /* no document */ }
          for (const el of targets) {
            if (el === except) continue
            try { if (!el.paused) el.pause() } catch { /* element gone */ }
          }
        },
      }
      proto.play = function patchedPlay (...args) {
        patch.apply(this)
        return originalPlay.apply(this, args)
      }
      window[MEDIA_PATCH] = patch
      patch.applyAll()
    }

    function applyPageVolume () {
      ensureMediaPatch()
      const patch = window[MEDIA_PATCH]
      if (patch) patch.applyAll()
      if (state.pageMuted && window.speechSynthesis) {
        try { window.speechSynthesis.cancel() } catch { /* not supported */ }
      }
      notify()
    }

    // ---------------------------------------------------------------------
    // Reading the page aloud.
    //
    // Every chat node renders as [data-chat-flow-kind], so the newest
    // assistant answer is a DOM query away; synthesis goes through dsh-tts
    // when it is installed (Edge voice, same config as its own player) and
    // falls back to the browser voice otherwise.
    // ---------------------------------------------------------------------
    const reader = { token: 0, audio: null, chunks: [], index: 0 }

    const DROP_LINE = /^(\d+(\.\d+)?\s*(ms|s|秒)|\d+\s*(tok|tokens|字))\s*$/i
    const ACTION_LINE = new Set(['复制', '重试', '编辑', '赞', '踩', 'Copy', 'Retry', 'Edit'])

    function cleanText (raw) {
      const lines = String(raw || '').split('\n').map((line) => line.trim())
      const kept = lines.filter((line) => line && !DROP_LINE.test(line) && !ACTION_LINE.has(line))
      return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
    }

    /** Newest visible assistant answer, else the conversation pane's text. */
    function pageText () {
      let nodes = []
      let fallback = ''
      try { nodes = [...document.querySelectorAll('[data-chat-flow-kind="assistant"]')] } catch { /* no DOM */ }
      let visible = 0
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i]
        if (!node || node.offsetParent === null) continue // collapsed inside a turn process
        visible += 1
        const text = cleanText(node.innerText)
        if (text) {
          report('text:assistant', JSON.stringify({ nodes: nodes.length, visible, length: text.length }))
          return text
        }
      }
      // The kind marker may differ on other shells: fall back to any flow node,
      // then to the whole conversation pane.
      try {
        const anyFlow = [...document.querySelectorAll('[data-chat-flow]')]
        for (let i = anyFlow.length - 1; i >= 0; i -= 1) {
          const text = cleanText(anyFlow[i].innerText)
          if (text) {
            report('text:anyflow', JSON.stringify({ nodes: anyFlow.length, kind: anyFlow[i].getAttribute('data-chat-flow-kind'), length: text.length }))
            return text
          }
        }
      } catch { /* no DOM */ }
      try {
        const scroller = document.querySelector('[data-conversation-scroll]')
        if (scroller) fallback = cleanText(scroller.innerText)
      } catch { /* no DOM */ }
      report('text:fallback', JSON.stringify({ assistantNodes: nodes.length, visible, length: fallback.length }))
      return fallback
    }

    function chunkText (text, max = 220) {
      const chunks = []
      let buffer = ''
      const flush = () => { const trimmed = buffer.trim(); if (trimmed) chunks.push(trimmed); buffer = '' }
      for (const char of String(text)) {
        buffer += char
        const endsSentence = '。！？!?；;\n'.includes(char)
        if (buffer.length >= max) flush()
        else if (endsSentence && buffer.trim().length >= max * 0.6) flush()
      }
      flush()
      return chunks
    }

    async function synthesize (text) {
      try {
        const res = await fetch(TTS_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!res.ok) { report('synth:http', `${res.status}`); return null }
        const data = await res.json()
        if (!data || !data.ok || !data.audioBase64) {
          report('synth:empty', JSON.stringify(data && data.error ? data.error : {}))
          return null
        }
        return { mime: data.mime || 'audio/mpeg', base64: data.audioBase64 }
      } catch (error) {
        report('synth:throw', String((error && error.message) || error))
        return null
      }
    }

    function playClip (clip, token) {
      return new Promise((resolve) => {
        const audio = new Audio(`data:${clip.mime};base64,${clip.base64}`)
        reader.audio = audio
        const done = () => { if (reader.audio === audio) reader.audio = null; resolve() }
        audio.onended = done
        audio.onerror = done
        try { audio.volume = state.pageMuted ? 0 : state.page } catch { /* volume not settable */ }
        audio.play().then(
          () => report('play:ok', `${clip.mime} ${clip.base64.length}b vol=${audio.volume}`),
          (error) => { report('play:blocked', String((error && error.name) || error)); done() },
        )
        if (reader.token !== token) { try { audio.pause() } catch { /* not playing */ } done() }
      })
    }

    function speakInBrowser (text, token) {
      return new Promise((resolve) => {
        if (!window.speechSynthesis) { resolve(); return }
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = 'zh-CN'
        const finish = () => { if (reader.token === token) finishReading(); resolve() }
        utterance.onend = finish
        utterance.onerror = finish
        window.speechSynthesis.speak(utterance)
      })
    }

    function finishReading () {
      reader.token += 1
      state.reading = false
      state.busy = false
      notify()
    }

    function stopReading () {
      reader.token += 1
      const audio = reader.audio
      reader.audio = null
      if (audio) { try { audio.pause() } catch { /* already stopped */ } }
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* not supported */ } }
      state.reading = false
      state.busy = false
      notify()
    }

    async function startReading () {
      const text = pageText()
      report('read:start', JSON.stringify({ length: text.length, page: state.page, muted: state.pageMuted }))
      if (!text) {
        state.note = '页面上没有可朗读的内容'
        notify()
        return
      }
      state.note = ''
      // dsh-tts may be auto-reading the same reply right now (speakReplies on):
      // stop it first, so pressing the button is a clean replay, not a duet.
      ensureMediaPatch()
      const mediaPatch = window[MEDIA_PATCH]
      if (mediaPatch) mediaPatch.pauseAll(null)
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* not supported */ } }
      const token = reader.token + 1
      reader.token = token
      state.reading = true
      state.busy = true
      notify()
      const chunks = chunkText(text)
      report('read:chunks', `${chunks.length}`)
      for (const chunk of chunks) {
        if (reader.token !== token) return
        const clip = await synthesize(chunk)
        if (reader.token !== token) return
        if (!clip) {
          state.busy = false
          report('read:browser-fallback', `${chunk.length} chars`)
          notify()
          await speakInBrowser(text, token) // dsh-tts absent or failed: browser voice
          return
        }
        state.busy = false
        notify()
        await playClip(clip, token)
        if (reader.token !== token) return
      }
      if (reader.token === token) finishReading()
    }

    function toggleReading () {
      report('toggle', state.reading || state.busy ? 'stop' : 'start')
      if (state.reading || state.busy) stopReading()
      else startReading()
    }

    // ---------------------------------------------------------------------
    // System output volume: the host owns it (osascript / pactl).
    // ---------------------------------------------------------------------
    async function fetchSystem () {
      try {
        const res = await fetch(ROUTE, { cache: 'no-store' })
        const data = await res.json()
        state.systemSupported = !!data.supported
        state.systemReason = data.reason || ''
        if (data.supported) state.system = { volume: Number(data.volume), muted: !!data.muted }
      } catch (error) {
        state.systemSupported = false
        state.systemReason = String((error && error.message) || error)
      }
      notify()
    }

    async function pushSystem (patch) {
      try {
        const res = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const data = await res.json()
        state.systemSupported = !!data.supported
        if (data.supported) state.system = { volume: Number(data.volume), muted: !!data.muted }
        else state.systemReason = data.reason || (data.error && data.error.message) || ''
      } catch (error) {
        state.systemReason = String((error && error.message) || error)
      }
      notify()
    }

    // ---------------------------------------------------------------------
    // Popover: plain DOM appended to <body>, so no composer ancestor can clip
    // it. It closes on any click outside, on Escape, and on a plain click of
    // the button that opened it.
    // ---------------------------------------------------------------------
    const PANEL_WIDTH = 168
    const MUTE_BTN = 'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));background:transparent;color:inherit;border-radius:6px;cursor:pointer;font-size:11px;padding:1px 6px'
    // Vertical mixer fader: writing-mode is the modern way, `orient` covers
    // Firefox, and the old -webkit-appearance value is left as a last resort.
    const RANGE_V = [
      'writing-mode:vertical-lr', 'direction:rtl', 'width:22px', 'height:104px', 'margin:0',
      'accent-color:var(--dsw-alias-brand-primary, #6f7bff)',
    ].join(';')
    const VALUE = 'opacity:.72;font-variant-numeric:tabular-nums;font-size:11px'

    function el (tag, props = {}, children = []) {
      const node = document.createElement(tag)
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'style') node.setAttribute('style', value)
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
        else if (value !== null && value !== undefined) node.setAttribute(key, String(value))
      }
      for (const child of children) node.append(child)
      return node
    }

    function createPanel () {
      const root = el('div', {
        style: [
          'position:fixed', 'z-index:2147483000', `width:${PANEL_WIDTH}px`, 'box-sizing:border-box',
          'padding:10px 12px 12px', 'border-radius:12px',
          'background:var(--dsw-alias-bg-layer-2, rgba(28,28,32,.98))',
          'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))',
          'box-shadow:0 12px 32px rgba(0,0,0,.42)',
          'color:var(--dsw-alias-label-primary, #e8e8ea)',
          'font:12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
          'display:none',
        ].join(';'),
      })

      const pageValue = el('span', { style: VALUE })
      const pageMute = el('button', {
        class: 'vk-mute', type: 'button', style: MUTE_BTN,
        onclick: () => { state.pageMuted = !state.pageMuted; saveState(); applyPageVolume() },
      })
      const pageRange = el('input', {
        type: 'range', min: '0', max: '100', step: '1', orient: 'vertical',
        title: '页内音量：本页所有音频（含语音朗读）',
        style: RANGE_V,
        oninput: (event) => {
          state.page = clamp01(Number(event.target.value) / 100)
          if (state.page > 0) state.pageMuted = false
          saveState()
          applyPageVolume()
        },
      })

      const sysValue = el('span', { style: VALUE })
      const sysMute = el('button', {
        class: 'vk-mute', type: 'button', style: MUTE_BTN,
        onclick: () => { pushSystem({ muted: !(state.system && state.system.muted) }) },
      })
      const sysRange = el('input', {
        type: 'range', min: '0', max: '100', step: '1', orient: 'vertical',
        title: '系统音量：系统输出（macOS osascript / Linux pactl）',
        style: RANGE_V,
        oninput: (event) => { sysValue.textContent = `${event.target.value}%` },
        onchange: (event) => { pushSystem({ volume: Number(event.target.value), muted: false }) },
      })

      const fader = (label, range, valueNode, muteNode) => el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;gap:6px;flex:1 1 0;min-width:0',
      }, [
        el('span', { text: label, style: 'font-weight:600;font-size:11px;white-space:nowrap' }),
        range,
        valueNode,
        muteNode,
      ])

      const mixer = el('div', {
        style: 'display:flex;align-items:flex-start;justify-content:space-around;gap:10px',
      }, [
        fader('页内音量', pageRange, pageValue, pageMute),
        fader('系统音量', sysRange, sysValue, sysMute),
      ])
      const hint = el('div', {
        text: '单击图标朗读 / 停止 · 按住上滑开关面板',
        style: 'margin-top:8px;font-size:11px;opacity:.5;text-align:center;line-height:1.35',
      })

      root.append(mixer, hint)
      document.body.append(root)

      function paintMute (node, on) {
        node.textContent = on ? '已静音' : '静音'
        node.style.background = on ? '#b4453c' : 'transparent'
        node.style.borderColor = on ? '#b4453c' : 'var(--dsw-alias-border-l2, rgba(255,255,255,.16))'
        node.style.color = on ? '#fff' : 'inherit'
      }

      function render () {
        pageValue.textContent = `${percent(state.page)}%`
        paintMute(pageMute, state.pageMuted)
        if (document.activeElement !== pageRange) pageRange.value = String(percent(state.page))

        if (state.systemSupported === false) {
          sysRange.disabled = true
          sysMute.disabled = true
          sysMute.style.opacity = '.5'
          sysValue.textContent = '不可用'
          sysValue.title = state.systemReason || 'unsupported'
          return
        }
        sysRange.disabled = false
        sysMute.disabled = false
        sysMute.style.opacity = '1'
        if (state.system) {
          sysValue.textContent = state.system.muted ? '静音' : `${Math.round(state.system.volume)}%`
          sysValue.title = ''
          paintMute(sysMute, state.system.muted)
          if (document.activeElement !== sysRange && !state.system.muted) {
            sysRange.value = String(Math.round(state.system.volume))
          }
        } else {
          sysValue.textContent = '…'
        }
      }

      render()
      const unsubscribe = subscribe(render)
      fetchSystem()

      return {
        el: root,
        place (anchor) {
          if (!anchor) return
          root.style.display = 'block' // measure only once the panel has a box
          const rect = anchor.getBoundingClientRect()
          const height = root.offsetHeight || 200
          let left = rect.left + rect.width / 2 - PANEL_WIDTH / 2
          left = Math.max(8, Math.min(left, window.innerWidth - PANEL_WIDTH - 8))
          let top = rect.top - height - 8 // the composer sits at the bottom: open upward
          if (top < 8) top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8))
          root.style.left = `${Math.round(left)}px`
          root.style.top = `${Math.round(top)}px`
        },
        destroy () {
          unsubscribe()
          try { root.remove() } catch { /* already gone */ }
        },
      }
    }

    // ---------------------------------------------------------------------
    // Composer button: speaker icon, seated right of the microphone button.
    //
    //   plain click              → read the page aloud / stop reading
    //   press, then drag upward  → reveal the volume panel
    //   click anywhere else      → hide the volume panel
    // ---------------------------------------------------------------------
    const ICON_COLOR = (reading, muted) => (muted
      ? '#e5484d'
      : reading
        ? 'var(--dsw-alias-brand-primary, #6f7bff)'
        : 'var(--dsw-alias-label-secondary)')

    const SpeakerIcon = (reading, muted) => {
      const children = [
        React.createElement('path', { key: 'body', d: 'M11 5 6 9H3v6h3l5 4V5z' }),
        React.createElement('path', { key: 'wave', d: 'M15.5 8.5a5 5 0 0 1 0 7' }),
      ]
      if (muted) {
        children.push(React.createElement('line', { key: 'slash', x1: '3', y1: '3', x2: '21', y2: '21' }))
      } else {
        children.push(React.createElement('path', { key: 'wave2', d: 'M18.5 5.5a9 9 0 0 1 0 13' }))
        if (reading) children.push(React.createElement('path', { key: 'wave3', d: 'M21 3a13 13 0 0 1 0 18' }))
      }
      return React.createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, children)
    }

    function VolumeButton () {
      const btnRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const press = React.useRef({ active: false, startY: 0, dragged: false, longHold: false, timer: null })
      const lastPointerAt = React.useRef(0)
      const [, force] = React.useReducer((count) => count + 1, 0)

      React.useEffect(() => subscribe(force), [])

      // Panel lifetime: outside click, Escape, resize/scroll repositioning.
      React.useEffect(() => {
        if (!open) return undefined
        const panel = createPanel()
        panel.place(btnRef.current)
        const onPointerDown = (event) => {
          if (panel.el.contains(event.target)) return
          if (btnRef.current && btnRef.current.contains(event.target)) return // the button owns its own click
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        const reposition = () => panel.place(btnRef.current)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', reposition)
          window.removeEventListener('scroll', reposition, true)
          panel.destroy()
        }
      }, [open])

      React.useEffect(() => () => {
        if (press.current.timer) clearTimeout(press.current.timer)
      }, [])

      const onPointerDown = (event) => {
        if (typeof event.button === 'number' && event.button !== 0) return
        const current = press.current
        current.active = true
        current.startY = event.clientY
        current.dragged = false
        current.longHold = false
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not capturable */ }
        if (current.timer) clearTimeout(current.timer)
        current.timer = setTimeout(() => { current.longHold = true }, LONG_PRESS_MS)
      }

      const onPointerMove = (event) => {
        const current = press.current
        if (!current.active) return
        if (event.clientY - current.startY <= -DRAG_UP_PX) {
          current.dragged = true
          report('gesture:drag-up', `dy=${Math.round(event.clientY - current.startY)}`)
          if (!open) setOpen(true) // 按住上滑 → 调出音量控制
        }
      }

      const endPress = () => {
        const current = press.current
        if (current.timer) { clearTimeout(current.timer); current.timer = null }
        current.active = false
        return current
      }

      const onPointerUp = (event) => {
        const current = press.current
        lastPointerAt.current = Date.now()
        if (!current.active) return
        const { dragged, longHold } = endPress()
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* not captured */ }
        report('gesture:up', `dragged=${dragged} longHold=${longHold} open=${open}`)
        if (dragged) return // the drag already opened the panel; no reading
        if (open) { setOpen(false); return } // sheet open: a plain click just hides it
        if (longHold) return // a press without dragging is not a click
        toggleReading()
      }

      const onPointerCancel = () => { endPress() }

      const onKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleReading(); return }
        if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); setOpen((value) => !value) }
      }

      const muted = state.pageMuted || state.page === 0
      const title = state.reading || state.busy
        ? '停止朗读'
        : (state.note || '朗读页面内容（再点停止）· 按住上滑调音量')

      return React.createElement('button', {
        ref: btnRef,
        type: 'button',
        title,
        'aria-label': '朗读 / 音量',
        'aria-pressed': (state.reading || state.busy) ? 'true' : 'false',
        'aria-expanded': open ? 'true' : 'false',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onKeyDown,
        // Keyboard activation arrives here as a click with detail 0. Pointer
        // clicks are handled by pointerup; this branch only fires when pointer
        // events never arrived at all (some shells swallow them), which keeps
        // "single click reads aloud" true everywhere.
        onClick: (event) => {
          const silent = Date.now() - lastPointerAt.current > 600
          report('click', `detail=${event.detail} afterPointer=${!silent}`)
          if (event.detail === 0 || silent) {
            event.preventDefault()
            if (open) { setOpen(false); return }
            toggleReading()
          }
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '32px',
          height: '32px',
          padding: '0',
          background: open ? 'var(--dsw-alias-button-tool-bar-hover, rgba(255,255,255,.08))' : 'transparent',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '8px',
          cursor: 'pointer',
          color: ICON_COLOR(state.reading || state.busy, muted),
          flex: '0 0 auto',
          touchAction: 'none',
          userSelect: 'none',
        },
      }, SpeakerIcon(state.reading || state.busy, muted))
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    loadState()

    function apply (ctx) {
      report('apply', `v${VERSION}`)
      ctx.effect(() => {
        ensureMediaPatch()
        return () => { /* the prototype patch is process-wide by design */ }
      }, 'dsh-volume-knob: in-page media volume')

      try {
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'dsh-volume-knob',
          order: ORDER,
        }, VolumeButton))
      } catch { /* shell without this slot: the button simply does not mount */ }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
