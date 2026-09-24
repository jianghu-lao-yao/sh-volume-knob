/**
 * sh-volume-knob — browser half.
 *
 * Composer speaker button (right of the microphone seat):
 *
 *   click                    → read aloud from the marked start position and
 *                              scroll the page to it, with a blinking caret;
 *                              the next click stops
 *   press, drag right        → pick the reading start position on the page
 *   press, drag up           → the volume panel
 *
 * Built for `@deepseek-ai/dsh@next` (0.1.7-rc.1): the slot registry
 * (`ctx.slots.inject` / `ctx.slots.register`), the composer tool slot
 * `conversation.input.right`, and the chat DOM markers
 * `[data-chat-flow]` / `[data-chat-flow-kind]` / `[data-chat-flow-key]` are
 * the same contract the previous 0.1.5 target used, so this half only had to
 * extend them.
 *
 * Synthesis walks two paths: `dsh-tts` (`POST /dsh-tts/speak`) when that
 * plugin answers, browser `speechSynthesis` otherwise. Both are chunked, so
 * reading can start in the middle of a reply.
 */
window.__ModuleLoader__.load({
  id: 'sh-volume-knob',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const LS_KEY = 'sh-volume-knob/state'
    const MEDIA_PATCH = '__shVolumeKnobMedia'
    const ROUTE = '/sh-volume-knob/system'
    const TTS_SPEAK = '/dsh-tts/speak'
    const TTS_STATUS = '/dsh-tts/status'
    const SLOT = 'conversation.input.right' // composer tool row; the mic sits here at order 30
    const ORDER = 40 // right of the microphone button
    const LONG_PRESS_MS = 400
    const DRAG_UP_PX = 18
    const DRAG_RIGHT_PX = 16
    const VERSION = '0.6.0'
    const FLOW = '[data-chat-flow]'
    const CURSOR_SETTLE_MS = 700

    // ---------------------------------------------------------------------
    // State shared by the button, its popover, the caret and the reader.
    // ---------------------------------------------------------------------
    const state = {
      page: 1, // 0..1 master volume for every in-page <audio>/<video>
      pageMuted: false,
      reading: false,
      busy: false, // synthesizing the first chunk
      note: '',
      cursor: null, // { key, offset } — newest answer + offset into its text
      picking: false, // the drag-right position picker is armed
      pickHint: '', // live picker hint; empty while reading / idle
      rect: null, // viewport rect of the caret, refreshed on scroll
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
        fetch('/sh-volume-knob/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, detail: detail === undefined ? '' : String(detail) }),
          keepalive: true,
        }).catch(() => {})
      } catch { /* diagnostics never break the widget */ }
    }

    const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
    const percent = (value) => Math.round(clamp01(value) * 100)
    const clampInt = (value, low, high) => Math.max(low, Math.min(high, Math.round(Number(value) || 0)))

    function loadState () {
      try {
        const raw = window.localStorage.getItem(LS_KEY)
        if (!raw) return
        const saved = JSON.parse(raw) || {}
        if (typeof saved.page === 'number') state.page = clamp01(saved.page)
        state.pageMuted = !!saved.pageMuted
        if (saved.cursor && typeof saved.cursor.key === 'string' && Number.isFinite(Number(saved.cursor.offset))) {
          state.cursor = { key: saved.cursor.key, offset: clampInt(saved.cursor.offset, 0, 1e6) }
        }
      } catch { /* private mode / malformed */ }
    }

    function saveState () {
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify({
          page: state.page,
          pageMuted: state.pageMuted,
          cursor: state.cursor || null,
        }))
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
    // Page text: which parts of the conversation may be read, and exactly
    // where each character sits in the DOM.
    //
    // Every chat node renders as [data-chat-flow] with a
    // [data-chat-flow-kind] of 'user' | 'assistant' (and other furniture such
    // as 'command-input'). Reading runs from the marked start position to the
    // end of the newest flow node, and a caret is placed with a collapsed DOM
    // Range, so "start position" is a real character offset, not a CSS guess.
    // ---------------------------------------------------------------------

    /** Inline elements that must not start a new line while text is flattened. */
    const INLINE_TAGS = new Set([
      'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I',
      'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG',
      'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
    ])
    /**
     * Interactive furniture inside a reply (copy / retry / feedback buttons,
     * token badges). Its text is not part of the spoken answer.
     */
    const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'SELECT', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE'])

    const styleOf = (node) => {
      try { return window.getComputedStyle(node) } catch { return null }
    }

    function isHidden (node) {
      if (!node || !node.tagName) return false
      const style = styleOf(node)
      if (!style) return false
      if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') return true
      return false
    }

    /**
     * Walk `root` in document order, applying innerText-like block newlines.
     * Calls `visit(text, node)` per visible text node; the visitor may return
     * `false` to stop the walk.
     */
    function walkText (root, visit) {
      let stopped = false
      const step = (node) => {
        if (stopped || !node) return
        if (node.nodeType === 3) {
          if (node.nodeValue) stopped = visit(node.nodeValue, node) === false
          return
        }
        if (node.nodeType !== 1) return
        const tag = node.tagName.toUpperCase()
        if (SKIP_TAGS.has(tag) || isHidden(node) || node.getAttribute('aria-hidden') === 'true') return
        const block = !INLINE_TAGS.has(tag)
        if (block) stopped = visit('\n', null) === false
        if (stopped) return
        if (tag === 'BR') { stopped = visit('\n', null) === false; return }
        for (const child of [...node.childNodes]) {
          step(child)
          if (stopped) return
        }
        if (block) stopped = visit('\n', null) === false
      }
      step(root)
    }

    /** Collapse runs of blank lines the way innerText does. */
    function tidy (raw) {
      return String(raw || '')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
    }

    function flowNodes () {
      try { return [...document.querySelectorAll(FLOW)] } catch { return [] }
    }

    /**
     * Index one flow node: its flattened text, the character → DOM map and the
     * signature the cache is keyed on. Both text and map come from one walk, so
     * `map[i]` offsets are offsets into `text` exactly.
     *
     * Entry format: [textNode, start, end] — the node's share of `text`. Block
     * newlines count into the surrounding offsets (a shared newline belongs to
     * the end of one entry and the start of the next), which is exactly where a
     * caret at a block boundary wants to sit.
     */
    function buildIndex (node) {
      const map = []
      let text = ''
      walkText(node, (chunk, textNode) => {
        if (textNode) {
          if (chunk) map.push([textNode, text.length, text.length + chunk.length])
        }
        text += chunk
        return true
      })
      return { node, text: tidy(text), map, length: text.length }
    }

    /** DOM signature: cheap to read, changes whenever the rendered text does. */
    function indexSignature (node) {
      let length = 0
      let count = 0
      const step = (child) => {
        if (child.nodeType === 3) { length += child.nodeValue ? child.nodeValue.length : 0; return }
        if (child.nodeType !== 1) return
        count += 1
        for (const grand of child.childNodes) step(grand)
      }
      for (const child of node.childNodes) step(child)
      return `${node.getAttribute('data-chat-flow-key') || ''}:${count}:${length}`
    }

    const indexCache = new Map() // node → { signature, index }

    function indexOf (node) {
      if (!node) return { node: null, text: '', map: [], length: 0 }
      const signature = indexSignature(node)
      const cached = indexCache.get(node)
      if (cached && cached.signature === signature) return cached.index
      const index = Object.assign(buildIndex(node), { signature })
      indexCache.set(node, { signature, index })
      if (indexCache.size > 24) indexCache.delete(indexCache.keys().next().value)
      return index
    }

    /** Readable flow nodes in document order (the text the button may speak). */
    let flowCache = null
    function visibleFlow () {
      const doc = typeof window !== 'undefined' && window.document ? window.document : document
      const nodes = flowNodes()
      if (flowCache && flowCache.doc === doc
        && flowCache.nodes.length === nodes.length
        && flowCache.nodes.every((node, i) => node === nodes[i])) {
        return flowCache.flow
      }
      const out = []
      for (const node of nodes) {
        if (isHidden(node)) continue
        const kind = node.getAttribute('data-chat-flow-kind')
        const index = indexOf(node)
        if (index.text) out.push({ node, kind, text: index.text, index })
      }
      flowCache = { doc, nodes, flow: out }
      return out
    }

    function newestAssistantNode () {
      const nodes = flowNodes()
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i]
        if (isHidden(node)) continue
        if (node.getAttribute('data-chat-flow-kind') === 'assistant') return node
      }
      // Fallback for shells that mark replies differently: the last flow node.
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        if (!isHidden(nodes[i])) return nodes[i]
      }
      return null
    }

    /**
     * Newest readable user message — the default start position. Reading runs
     * from there through everything after it (the reply included), which is
     * what "read this answer, after my question" means to a listener.
     */
    function newestUserNode () {
      const nodes = flowNodes()
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i]
        if (isHidden(node)) continue
        if (node.getAttribute('data-chat-flow-kind') === 'user') return node
      }
      return null
    }

    /** The node a start position lives in: the user's question, else the reply. */
    function startNode () {
      return newestUserNode() || newestAssistantNode()
    }

    function nodeKey (node) {
      if (!node) return ''
      const key = node.getAttribute('data-chat-flow-key')
      if (key) return key
      // No stable key published: fall back to the node's position in the flow.
      return `#${flowNodes().indexOf(node)}`
    }

    function mapEntryAt (index, offset) {
      if (!index || !index.map.length) return null
      const point = clampInt(offset, 0, index.length)
      for (const entry of index.map) {
        if (point >= entry[1] && point < entry[2]) return entry
      }
      // Past the end (or inside collapsed whitespace): sit at the last node's end.
      return index.map[index.map.length - 1]
    }

    function entryRange (entry, offset) {
      if (!entry) return null
      const [node] = entry
      const local = clampInt(offset - entry[1], 0, node.nodeValue ? node.nodeValue.length : 0)
      const range = document.createRange()
      try {
        range.setStart(node, local)
        range.setEnd(node, local)
      } catch { return null }
      return range
    }

    function firstRect (range) {
      if (!range) return null
      try {
        const rects = range.getClientRects()
        for (const rect of rects) {
          if (rect && (rect.width || rect.height)) return rect
        }
        const rect = range.getBoundingClientRect()
        if (rect && (rect.width || rect.height)) return rect
      } catch { /* range collapsed in a detached node */ }
      return null
    }

    /** Viewport rect for a caret at `offset` inside one flow node's index. */
    function rectForOffset (node, offset) {
      const index = indexOf(node)
      const point = clampInt(offset, 0, index.length)
      const entry = mapEntryAt(index, point)
      if (!entry) return null
      let rect = firstRect(entryRange(entry, point))
      // A caret at the very end of a text node has no rect of its own in some
      // engines; the preceding character's right edge is the same place.
      if (!rect) {
        if (point - entry[1] > 0) rect = firstRect(entryRange(entry, point - 1))
        if (!rect && entry[1] + 1 < entry[2]) rect = firstRect(entryRange(entry, point + 1))
      }
      if (!rect) return null
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height || rect.width || 18,
      }
    }

    /** Scroll the start position into the middle of its scrolling container. */
    function scrollToRect (rect) {
      if (!rect) return
      try {
        const scroller = scrollParentOf(newestAssistantNode())
        if (!scroller) return
        const box = typeof scroller.getBoundingClientRect === 'function'
          ? scroller.getBoundingClientRect()
          : { top: 0, height: window.innerHeight }
        const height = box.height || window.innerHeight
        const top = box.top || 0
        const delta = (rect.top - top) - height * 0.38
        if (Math.abs(delta) < 8) return
        if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ top: delta, behavior: 'smooth' })
        else scroller.scrollTop += delta
      } catch { /* no scrolling needed when the rect is already gone */ }
    }

    function scrollParentOf (node) {
      let current = node ? node.parentElement : null
      while (current) {
        const style = styleOf(current)
        if (style) {
          const overflow = `${style.overflowY}`
          if ((overflow === 'auto' || overflow === 'scroll') && current.scrollHeight > current.clientHeight + 4) return current
        }
        current = current.parentElement
      }
      return document.scrollingElement || document.documentElement
    }

    // ---------------------------------------------------------------------
    // The caret: a fixed 2px bar that blinks at the start position. It is
    // re-measured on scroll/resize, because a fixed bar over scrolling text
    // would otherwise drift away from its character.
    // ---------------------------------------------------------------------
    let cursorNode = null
    let cursorAnchor = null // { node, offset }

    const CURSOR_CSS = `
@keyframes sh-vk-blink { 0%,49% { opacity:1 } 50%,100% { opacity:.08 } }
.sh-vk-caret {
  position: fixed; z-index: 2147483001; width: 2px; border-radius: 1px;
  background: var(--dsw-alias-brand-primary, #6f7bff);
  box-shadow: 0 0 0 1px rgba(111,123,255,.35), 0 0 8px rgba(111,123,255,.55);
  animation: sh-vk-blink 1.05s steps(1, end) infinite;
  pointer-events: none; transition: left .06s linear, top .06s linear, height .12s ease;
}
.sh-vk-caret[data-mode="pick"] { background: #f5a524; box-shadow: 0 0 0 1px rgba(245,165,36,.4), 0 0 10px rgba(245,165,36,.6) }
.sh-vk-caret::after {
  content: ''; position: absolute; left: -3px; top: -4px; width: 8px; height: 8px;
  border-radius: 50%; background: inherit; opacity: .95;
}
.sh-vk-hint {
  position: fixed; z-index: 2147483002; max-width: min(420px, 74vw);
  padding: 7px 10px; border-radius: 9px; pointer-events: none;
  background: var(--dsw-alias-bg-layer-2, rgba(28,28,32,.97));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.18));
  box-shadow: 0 10px 26px rgba(0,0,0,.4);
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
}
.sh-vk-hint b { color: #f5a524; font-weight: 600 }
.sh-vk-hint span { opacity: .68 }
`

    const cursorStyle = {
      ensure () {
        if (!document.getElementById('sh-vk-style')) {
          const style = document.createElement('style')
          style.id = 'sh-vk-style'
          style.textContent = CURSOR_CSS
          document.head.append(style)
        }
        if (!cursorNode) {
          cursorNode = document.createElement('div')
          cursorNode.className = 'sh-vk-caret'
          cursorNode.setAttribute('aria-hidden', 'true')
          document.body.append(cursorNode)
        }
        return cursorNode
      },
      /** Draw the caret at a character position; `mode` tints it for picking. */
      show (rect, mode) {
        const node = cursorStyle.ensure()
        if (!rect) { node.style.display = 'none'; return }
        node.dataset.mode = mode || 'read'
        node.style.display = 'block'
        node.style.left = `${Math.round(rect.left)}px`
        node.style.top = `${Math.round(rect.top)}px`
        node.style.height = `${Math.max(14, Math.round(rect.height || 18))}px`
      },
      hide () {
        if (cursorNode) cursorNode.style.display = 'none'
      },
      destroy () {
        if (cursorNode) { try { cursorNode.remove() } catch { /* already gone */ } }
        cursorNode = null
        const style = document.getElementById('sh-vk-style')
        if (style) { try { style.remove() } catch { /* already gone */ } }
      },
    }

    // ---------------------------------------------------------------------
    // Picker hint: one floating line above the caret while a start position is
    // being chosen. It disappears the moment reading starts.
    // ---------------------------------------------------------------------
    let hintNode = null
    function showHint (text, rect) {
      if (!hintNode) {
        hintNode = document.createElement('div')
        hintNode.className = 'sh-vk-hint'
        hintNode.setAttribute('role', 'status')
        document.body.append(hintNode)
      }
      hintNode.innerHTML = text
      hintNode.style.display = 'block'
      const width = hintNode.offsetWidth || 240
      const height = hintNode.offsetHeight || 32
      const anchor = rect || { left: window.innerWidth / 2, top: window.innerHeight / 2, height: 0, bottom: 0 }
      let left = anchor.left - 8
      let top = anchor.top - height - 10
      if (top < 8) top = anchor.bottom + 22
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
      hintNode.style.left = `${Math.round(left)}px`
      hintNode.style.top = `${Math.round(top)}px`
    }

    function hideHint () {
      if (hintNode) hintNode.style.display = 'none'
    }

    const escapeHtml = (value) => String(value || '')
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')

    function previewOf (text, offset) {
      const slice = String(text || '').slice(offset, offset + 34).replace(/\s+/gu, ' ')
      return escapeHtml(slice)
    }

    /**
     * The caret position the user is currently looking at (or null when the
     * conversation has nothing readable).
     */
    function resolveCursor () {
      const node = startNode()
      if (!node) return null
      const index = indexOf(node)
      if (!index.text) return null
      const key = nodeKey(node)
      const offset = state.cursor && state.cursor.key === key
        ? clampInt(state.cursor.offset, 0, index.text.length)
        : 0 // a fresh turn: the question's first character is the default start
      return { node, key, index, offset, rect: rectForOffset(node, offset) }
    }

    /** Persist a caret position and put the caret (and reading start) there. */
    function setCursor (node, index, offset, mode) {
      const key = nodeKey(node)
      const point = clampInt(offset, 0, index.text.length)
      state.cursor = { key, offset: point }
      cursorAnchor = { node, offset: point }
      state.rect = rectForOffset(node, point)
      cursorStyle.show(state.rect, mode)
      saveState()
      notify()
      return state.rect
    }

    function refreshCaret () {
      if (!state.cursor && !cursorAnchor) return
      const node = cursorAnchor && cursorAnchor.node && cursorAnchor.node.isConnected
        ? cursorAnchor.node
        : newestAssistantNode()
      if (!node) { state.rect = null; cursorStyle.hide(); return }
      const index = indexOf(node)
      const offset = cursorAnchor ? cursorAnchor.offset : (state.cursor ? state.cursor.offset : 0)
      const point = clampInt(offset, 0, index.text.length)
      cursorAnchor = { node, offset: point }
      state.rect = rectForOffset(node, point)
      cursorStyle.show(state.rect, state.picking ? 'pick' : 'read')
    }

    /** Move the caret to the point under the pointer (pick mode). */
    function cursorFromPoint (x, y) {
      const flow = visibleFlow()
      if (!flow.length) return null
      const hit = pointToOffset(x, y, flow)
      if (!hit) return null
      return hit
    }

    /**
     * Translate viewport coordinates to (flow node, character offset).
     * Uses the browser caret APIs when present; falls back to a geometric
     * search over the character rects, which is also what clamps a pointer in
     * the gutters onto the nearest readable character.
     */
    function pointToOffset (x, y, flow) {
      let range = null
      try {
        if (typeof document.caretPositionFromPoint === 'function') {
          const pos = document.caretPositionFromPoint(x, y)
          if (pos && pos.offsetNode) {
            range = document.createRange()
            range.setStart(pos.offsetNode, Math.min(pos.offset, pos.offsetNode.nodeValue ? pos.offsetNode.nodeValue.length : 0))
            range.collapse(true)
          }
        } else if (typeof document.caretRangeFromPoint === 'function') {
          range = document.caretRangeFromPoint(x, y)
        }
      } catch { range = null }

      // Which flow node owns that point? Prefer the DOM answer, then the
      // geometrically nearest node.
      let index = -1
      if (range && range.startContainer) {
        const probe = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
        for (let i = 0; i < flow.length; i += 1) {
          if (flow[i].node === probe || (probe && flow[i].node.contains(probe))) { index = i; break }
        }
      }
      if (index < 0) index = nearestFlowIndex(x, y, flow)
      if (index < 0) return null
      const target = flow[index]
      const built = target.index || indexOf(target.node)
      let offset = offsetFromRange(range, target.node, built)
      if (offset === null) offset = nearestOffsetInNode(x, y, target.node, built)
      if (offset === null) return null
      return { node: target.node, index: built, offset: clampInt(offset, 0, built.text.length) }
    }

    function offsetFromRange (range, node, built) {
      if (!range || !range.startContainer) return null
      const container = range.startContainer
      if (container.nodeType !== 3 || !node.contains(container)) return null
      const local = range.startOffset
      for (const entry of built.map) {
        if (entry[0] === container) return clampInt(entry[1] + local, 0, built.text.length)
      }
      return null
    }

    function nearestFlowIndex (x, y, flow) {
      let best = -1
      let bestDistance = Infinity
      for (let i = 0; i < flow.length; i += 1) {
        let box = null
        try { box = flow[i].node.getBoundingClientRect() } catch { box = null }
        if (!box || (!box.width && !box.height)) { if (best < 0) best = i; continue }
        const dx = x < box.left ? box.left - x : (x > box.right ? x - box.right : 0)
        const dy = y < box.top ? box.top - y : (y > box.bottom ? y - box.bottom : 0)
        const distance = Math.hypot(dx, dy)
        if (distance < bestDistance) { bestDistance = distance; best = i }
      }
      return best
    }

    /** Nearest character offset inside one node for a pointer position. */
    function nearestOffsetInNode (x, y, node, built) {
      const text = built.text
      if (!text) return null
      let best = 0
      let bestDistance = Infinity
      const step = text.length > 4000 ? 7 : 1
      for (let i = 0; i < text.length; i += step) {
        const rect = rectForOffset(node, i)
        if (!rect) continue
        const dx = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0)
        const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0)
        const distance = Math.hypot(dx, dy * 1.2)
        if (distance < bestDistance) { bestDistance = distance; best = i }
        if (distance === 0) break
      }
      return best
    }

    // ---------------------------------------------------------------------
    // Reading the page aloud.
    // ---------------------------------------------------------------------
    const reader = { token: 0, audio: null, tts: null, media: null }

    const DROP_LINE = /^(\d+(\.\d+)?\s*(ms|s|秒)|\d+\s*(tok|tokens|字))\s*$/i
    const ACTION_LINE = new Set(['复制', '重试', '编辑', '赞', '踩', 'Copy', 'Retry', 'Edit'])

    /**
     * Speech-ready text for ONE node. Chrome lines (time badges, token counts,
     * copy/retry labels) are dropped per line so a user message that happens to
     * *start* with such a word keeps its real characters; the caller joins node
     * texts, never the other way round. Paragraph breaks survive: consecutive
     * blank lines collapse to exactly one break, not to nothing.
     */
    function speakable (raw) {
      const lines = String(raw || '').split('\n').map((line) => line.trim())
      const kept = []
      let blank = false
      for (const line of lines) {
        if (!line) { blank = true; continue }
        if (DROP_LINE.test(line) || ACTION_LINE.has(line)) continue
        if (blank && kept.length) kept.push('')
        blank = false
        kept.push(line)
      }
      return kept.join('\n').trim()
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

    /** Is `dsh-tts` installed and serving? Cached per page. */
    async function ttsAvailable () {
      if (reader.tts !== null) return reader.tts
      try {
        const res = await fetch(TTS_STATUS, { cache: 'no-store' })
        reader.tts = res.ok
        if (!res.ok) report('tts:absent', `${res.status}`)
      } catch (error) {
        reader.tts = false
        report('tts:probe-failed', String((error && error.message) || error))
      }
      return reader.tts
    }

    async function synthesize (text) {
      try {
        const res = await fetch(TTS_SPEAK, {
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
        if (reader.token !== token) { resolve('stopped'); return }
        const audio = new Audio(`data:${clip.mime};base64,${clip.base64}`)
        reader.audio = audio
        const done = (why) => {
          if (reader.audio === audio) reader.audio = null
          resolve(why || 'ended')
        }
        audio.onended = () => done('ended')
        audio.onerror = () => done('error')
        try { audio.volume = state.pageMuted ? 0 : state.page } catch { /* volume not settable */ }
        audio.play().then(
          () => report('play:ok', `${clip.mime} ${clip.base64.length}b vol=${audio.volume}`),
          (error) => { report('play:blocked', String((error && error.name) || error)); done('blocked') },
        )
        if (reader.token !== token) { try { audio.pause() } catch { /* not playing */ } done('stopped') }
      })
    }

    function speakInBrowser (text, token) {
      return new Promise((resolve) => {
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') { resolve('unsupported'); return }
        const utterance = new window.SpeechSynthesisUtterance(text)
        utterance.lang = 'zh-CN'
        const finish = (why) => resolve(why || 'ended')
        utterance.onend = () => finish('ended')
        utterance.onerror = () => finish('error')
        try { window.speechSynthesis.speak(utterance) } catch { finish('error') }
        if (reader.token !== token) { try { window.speechSynthesis.cancel() } catch { /* not supported */ } finish('stopped') }
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

    /**
     * Everything to read: from the start position inside its own node through
     * the end of the newest flow node. Reading *starts* at the marked character
     * and never skips back, so earlier turns stay silent.
     */
    function readingPlan () {
      const resolved = resolveCursor()
      if (!resolved) return null
      const flow = visibleFlow()
      const startAt = flow.findIndex((entry) => entry.node === resolved.node)
      const pieces = []
      const first = speakable(resolved.index.text.slice(resolved.offset))
      if (first) pieces.push(first)
      if (startAt >= 0) {
        for (let i = startAt + 1; i < flow.length; i += 1) {
          const text = speakable(flow[i].text)
          if (text) pieces.push(text)
        }
      }
      return { node: resolved.node, offset: resolved.offset, text: pieces.join('\n\n') }
    }

    /** Scroll to the start position and leave the caret blinking there. */
    function focusStartPosition (plan) {
      const node = plan.node
      const rect = rectForOffset(node, plan.offset)
      cursorAnchor = { node, offset: plan.offset }
      state.rect = rect
      cursorStyle.show(rect, 'read')
      scrollToRect(rect)
      // Smooth scrolling moves the rect for a few frames: re-measure briefly.
      const startedAt = Date.now()
      const settle = () => {
        if (!state.reading && Date.now() - startedAt > 200) return
        refreshCaret()
        if (Date.now() - startedAt < CURSOR_SETTLE_MS) window.setTimeout(settle, 120)
      }
      window.setTimeout(settle, 60)
    }

    async function startReading () {
      const plan = readingPlan()
      report('read:start', JSON.stringify({ offset: plan ? plan.offset : -1, length: plan ? plan.text.length : 0, page: state.page, muted: state.pageMuted }))
      if (!plan || !plan.text) {
        state.note = '页面上没有可朗读的内容'
        notify()
        return
      }
      state.note = ''
      state.pickHint = ''
      state.picking = false
      hideHint()
      focusStartPosition(plan)

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

      const chunks = chunkText(plan.text)
      report('read:chunks', `${chunks.length}`)
      const useTts = await ttsAvailable()
      let spoken = 0
      for (const chunk of chunks) {
        if (reader.token !== token) return
        if (useTts) {
          const clip = await synthesize(chunk)
          if (reader.token !== token) return
          if (clip) {
            state.busy = false
            notify()
            const why = await playClip(clip, token)
            if (reader.token !== token || why === 'stopped') return
            if (why === 'error' || why === 'blocked') {
              // Playback broke mid-way: browser voice picks up the remainder.
              report('read:browser-fallback', `after ${spoken} chars (${why})`)
              await speakInBrowser(chunks.slice(chunks.indexOf(chunk)).join('\n'), token)
              return
            }
            spoken += chunk.length
            continue
          }
          report('read:browser-fallback', `synthesis failed after ${spoken} chars`)
          const remaining = chunks.slice(chunks.indexOf(chunk)).join('\n')
          await speakInBrowser(remaining, token)
          return
        }
        state.busy = false
        notify()
        const why = await speakInBrowser(chunk, token)
        if (reader.token !== token || why === 'stopped') return
        if (why === 'unsupported') {
          state.note = '浏览器不支持语音朗读，且未检测到 dsh-tts'
          state.reading = false
          state.busy = false
          notify()
          return
        }
        spoken += chunk.length
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
        text: '单击图标朗读 / 停止 · 按住上滑面板 · 按住右滑选起点',
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
    // Composer button.
    //
    //   click                    → read from the start position / stop
    //   press, drag right        → choose the start position
    //   press, drag up           → the volume panel
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
      const press = React.useRef({
        active: false, startX: 0, startY: 0, moved: false, picked: false,
        longHold: false, timer: null, pointerId: null,
      })
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

      // Pick mode: the caret and its hint follow the pointer until release.
      React.useEffect(() => {
        if (!state.picking) return undefined
        const onMove = (event) => {
          if (!press.current.active) return
          const hit = cursorFromPoint(event.clientX, event.clientY)
          if (!hit) return
          setCursor(hit.node, hit.index, hit.offset, 'pick')
          state.pickHint = `朗读起点：第 ${hit.offset + 1} 字 · <span>${previewOf(hit.index.text, hit.offset)}</span>`
          showHint(`<b>拖动选择朗读起点</b> · 第 ${hit.offset + 1} 字 · <span>${previewOf(hit.index.text, hit.offset)}</span>`, state.rect)
        }
        const onUp = () => { commitPick() }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', onUp, true)
        window.addEventListener('pointercancel', onUp, true)
        return () => {
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', onUp, true)
          window.removeEventListener('pointercancel', onUp, true)
        }
      }, [state.picking])

      React.useEffect(() => {
        const onScroll = () => refreshCaret()
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        refreshCaret()
        return () => {
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
        }
      }, [])

      React.useEffect(() => () => {
        if (press.current.timer) clearTimeout(press.current.timer)
      }, [])

      const onPointerDown = (event) => {
        if (typeof event.button === 'number' && event.button !== 0) return
        const current = press.current
        current.active = true
        current.startX = event.clientX
        current.startY = event.clientY
        current.moved = false
        current.picked = false
        current.longHold = false
        current.pointerId = event.pointerId === undefined ? null : event.pointerId
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not capturable */ }
        if (current.timer) clearTimeout(current.timer)
        current.timer = setTimeout(() => { current.longHold = true }, LONG_PRESS_MS)
      }

      const enterPick = () => {
        const current = press.current
        if (current.picked) return
        current.picked = true
        state.picking = true
        report('gesture:drag-right', 'pick')
        // Seed the caret where the pointer already is, so the hint appears at once.
        const hit = cursorFromPoint(current.startX + DRAG_RIGHT_PX, current.startY)
        const resolved = hit || resolveCursor()
        refreshCaret()
        if (resolved) {
          state.pickHint = `朗读起点：第 ${resolved.offset + 1} 字`
          showHint('<b>拖动选择朗读起点</b> · 松手开始朗读', state.rect)
        } else {
          showHint('<b>拖动选择朗读起点</b> · 松手开始朗读', null)
        }
        notify()
      }

      const onPointerMove = (event) => {
        const current = press.current
        if (!current.active) return
        const dx = event.clientX - current.startX
        const dy = event.clientY - current.startY
        if (dx > DRAG_RIGHT_PX && dx >= Math.abs(dy)) { // rightward wins over a wobbly press
          enterPick()
          return
        }
        if (dy <= -DRAG_UP_PX && Math.abs(dy) > Math.abs(dx)) {
          current.moved = true
          if (!open) setOpen(true) // 按住上滑 → 调出音量控制
        }
      }

      const endPress = () => {
        const current = press.current
        if (current.timer) { clearTimeout(current.timer); current.timer = null }
        current.active = false
        return current
      }

      const commitPick = () => {
        const current = press.current
        if (!current.picked) return false
        current.picked = false
        state.picking = false
        hideHint()
        state.pickHint = ''
        report('gesture:pick-commit', state.cursor ? `offset=${state.cursor.offset}` : 'none')
        refreshCaret()
        notify()
        return true
      }

      const onPointerUp = (event) => {
        const current = press.current
        lastPointerAt.current = Date.now()
        if (!current.active) return
        const picked = current.picked
        const { moved, longHold } = endPress()
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* not captured */ }
        report('gesture:up', `moved=${moved} picked=${picked} longHold=${longHold} open=${open}`)
        if (picked) { commitPick(); return } // the picker already placed the caret
        if (moved) return // the drag already opened the panel; no reading
        if (open) { setOpen(false); return } // panel open: a plain click just hides it
        if (longHold) return // a press without dragging is not a click
        toggleReading()
      }

      const onPointerCancel = () => {
        const current = press.current
        if (current.picked) { current.picked = false; state.picking = false; hideHint(); state.pickHint = ''; notify() }
        endPress()
      }

      const onKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleReading(); return }
        if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); setOpen((value) => !value); return }
        if (!state.cursor) return
        if (event.key === 'Escape' && state.picking) {
          event.preventDefault()
          state.picking = false
          hideHint()
          state.pickHint = ''
          notify()
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const resolved = resolveCursor()
          if (!resolved) return
          event.preventDefault()
          const step = event.shiftKey ? 20 : 1
          const next = clampInt(resolved.offset + (event.key === 'ArrowRight' ? step : -step), 0, resolved.index.text.length)
          setCursor(resolved.node, resolved.index, next, state.picking ? 'pick' : 'read')
        }
      }

      const muted = state.pageMuted || state.page === 0
      const title = state.reading || state.busy
        ? '停止朗读'
        : (state.note || '从起点朗读（再点停止）· 按住上滑调音量 · 按住右滑选起点')

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
        cursorStyle.ensure()
        return () => { cursorStyle.destroy() }
      }, 'sh-volume-knob: in-page media volume + caret layer')

      try {
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'sh-volume-knob',
          order: ORDER,
        }, VolumeButton))
      } catch { /* shell without this slot: the button simply does not mount */ }
    }

    exports.apply = apply
    exports.inject = ['slots']
    // Testing seam: the jsdom harness loads the same bundle and drives these.
    exports.__internals = {
      state, reader, readingPlan, resolveCursor, chunkText, speakable,
      walkText, tidy, buildIndex, indexOf, visibleFlow, rectForOffset,
      pointToOffset, cursorFromPoint, focusStartPosition, startReading,
      stopReading, toggleReading,
    }
    return module.exports
  },
})
