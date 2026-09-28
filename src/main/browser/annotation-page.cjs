'use strict';

// Runs only in Electron's isolated world. No Node, preload, postMessage receiver,
// or app API is exposed to the website. Main pulls events from this private queue.
// Target recognition follows engelbart-web's bridge: handles first, then a unique
// best match by visible text and ancestors. Rectangles are never identity.
function installAnnotationPage() {
  if (globalThis.__engelbartAnnotations) return;
  let active = false, marks = [], selected = null, hover = null, events = [], docs = [], unavailable = 0;
  let host, root, outline, dots, blockers, lastSignature = '', lastRoute = '';
  const bindings = new Map();
  const markerNodes = new Map(), blockerNodes = new Map();
  let queryCache = new Map(), rootsCache = new Map(), descriptionCache = new WeakMap();
  let cursorTarget = null, previousCursor = '', previousPriority = '', hadStyle = false;
  const cap = (v, n = 240) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const route = () => location.pathname + (location.hash.startsWith('#/') ? location.hash : '');
  const up = (el) => el.parentElement || el.getRootNode()?.host || null;
  const privateElement = (el) => !!el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]');
  function visibleText(el) {
    if (privateElement(el)) return '';
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let value = '', count = 0;
    for (let node = walker.nextNode(); node && value.length < 300 && count < 1000; node = walker.nextNode(), count++) {
      if (!privateElement(node.parentElement) && !node.parentElement.closest('script,style,[data-engelbart-annotations]')) value += ' ' + node.data;
    }
    return cap(value);
  }
  const testid = (el) => el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || '';
  function selector(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      let part = node.localName;
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const peers = node.parentElement ? [...node.parentElement.children].filter((p) => p.localName === node.localName) : [];
      if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    const shadow = el.getRootNode();
    return (shadow.host ? `${selector(shadow.host)} >>> ` : '') + parts.join(' > ');
  }
  function describe(el) {
    if (descriptionCache.has(el)) return descriptionCache.get(el);
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => el.getRootNode().getElementById?.(id)).filter(Boolean).map(visibleText).join(' ');
    const label = labelledBy || el.getAttribute('aria-label') || [...(el.labels || [])].map(visibleText).join(' ') || el.getAttribute('alt') || el.getAttribute('title');
    const d = { tag: el.localName, selector: selector(el), id: cap(el.id, 160), testid: cap(testid(el), 160), role: cap(el.getAttribute('role'), 100), name: cap(el.getAttribute('name'), 160), type: cap(el.getAttribute('type'), 80), label: cap(label), text: visibleText(el), classes: [...el.classList].slice(0, 6).map((s) => s.slice(0, 80)) };
    descriptionCache.set(el, d); return d;
  }
  const meaningful = (el) => el.matches('button,a,input,textarea,select,canvas,iframe,main,section,article,nav,header,footer,figure,li,p,h1,h2,h3,[role],[aria-label],[data-testid]') || el.id;
  function pickElement(el) {
    if (!el || el.nodeType !== 1) return null;
    // A label or icon inside a control selects the control.
    for (let p = el, n = 0; p && n < 6; p = up(p), n++) if (p.matches('button,a,input,textarea,select,canvas')) return p;
    for (let p = el, n = 0; p && n < 6; p = up(p), n++) if (meaningful(p)) return p;
    return el;
  }
  function ancestors(el) {
    const all = [];
    for (let p = up(el), n = 0; p && n < 12 && all.length < 3; p = up(p), n++) if (meaningful(p)) all.push(describe(p));
    return all;
  }
  function queryAll(doc, sel) {
    if (!queryCache.has(doc)) queryCache.set(doc, new Map());
    const cache = queryCache.get(doc);
    if (cache.has(sel)) return cache.get(sel);
    if (!rootsCache.has(doc)) {
      const roots = [doc];
      for (let i = 0; i < roots.length && roots.length < 100; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot && roots.length < 100) roots.push(el.shadowRoot);
      rootsCache.set(doc, roots);
    }
    const found = [];
    try { for (const r of rootsCache.get(doc)) { found.push(...[...r.querySelectorAll(sel)].slice(0, 500 - found.length)); if (found.length >= 500) break; } } catch { /* malformed or detached */ }
    cache.set(sel, found); return found;
  }
  function bySelector(doc, sel) {
    let scope = doc, el;
    try {
      for (const hop of sel.split(' >>> ')) {
        if (!scope) return null;
        const found = scope.querySelectorAll(hop);
        if (found.length !== 1) return null;
        el = found[0]; scope = el.shadowRoot;
      }
      return el || null;
    } catch { return null; }
  }
  const sameText = (a, b) => cap(a.text || a.label).toLowerCase() === cap(b.text || b.label).toLowerCase();
  function resolve(doc, anchor) {
    const want = anchor.element;
    let el = null, matchedOn = null;
    const unique = (sel) => { const found = queryAll(doc, sel); return found.length === 1 ? found[0] : null; };
    if (want.testid) { el = unique(`[data-testid="${CSS.escape(want.testid)}"],[data-test-id="${CSS.escape(want.testid)}"],[data-test="${CSS.escape(want.testid)}"]`); if (el) matchedOn = 'testid'; }
    if (!el && want.id) { el = unique(`#${CSS.escape(want.id)}`); if (el) matchedOn = 'id'; }
    if (el?.localName !== want.tag) el = null;
    if (!el) { el = bySelector(doc, want.selector); matchedOn = 'selector'; if (el?.localName !== want.tag) el = null; }
    if (el) return { el, confidence: sameText(describe(el), want) ? 'resolved' : 'approximate', matchedOn };
    let best = null, bestScore = 0, runnerUp = 0;
    for (const candidate of queryAll(doc, want.tag)) {
      const d = describe(candidate);
      let score = 1 + (want.name && d.name === want.name ? 2 : 0) + (want.role && d.role === want.role ? 1 : 0) + ((want.text || want.label) && sameText(d, want) ? 4 : 0);
      score += Math.min(2, want.classes.filter((c) => d.classes.includes(c)).length);
      const chain = ancestors(candidate);
      score += anchor.ancestors.filter((a) => chain.some((b) => a.tag === b.tag && ((a.id && a.id === b.id) || (a.testid && a.testid === b.testid) || ((a.text || a.label) && sameText(a, b))))).length;
      if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = candidate; } else runnerUp = Math.max(runnerUp, score);
    }
    return bestScore >= 5 && bestScore > runnerUp ? { el: best, confidence: 'approximate', matchedOn: 'candidate' } : { el: null, confidence: 'unresolved', matchedOn: null };
  }
  const style = (el, props) => Object.assign(el.style, props);
  // Only the element under the pointer gets a temporary cursor override. Restore
  // its exact prior declaration (including !important) on leave, pick, or clear.
  function pointCursor(el) {
    if (cursorTarget === el) return;
    if (cursorTarget && cursorTarget.style.cursor === 'pointer' && cursorTarget.style.getPropertyPriority('cursor') === 'important') {
      if (previousCursor) cursorTarget.style.setProperty('cursor', previousCursor, previousPriority);
      else cursorTarget.style.removeProperty('cursor');
      if (!hadStyle && !cursorTarget.getAttribute('style')) cursorTarget.removeAttribute('style');
    }
    cursorTarget = el?.style ? el : null;
    if (!cursorTarget) return;
    previousCursor = el.style.getPropertyValue('cursor'); previousPriority = el.style.getPropertyPriority('cursor'); hadStyle = el.hasAttribute('style');
    el.style.setProperty('cursor', 'pointer', 'important');
  }
  function ensureOverlay() {
    if (host?.isConnected) return;
    markerNodes.clear(); blockerNodes.clear();
    host = document.createElement('div'); host.dataset.engelbartAnnotations = '1';
    style(host, { all: 'initial', position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    root = host.attachShadow({ mode: 'closed' });
    outline = document.createElement('div'); dots = document.createElement('div'); blockers = document.createElement('div');
    style(outline, { position: 'fixed', border: '1px solid #525252', boxSizing: 'border-box', background: 'rgba(115,115,115,.05)', boxShadow: '0 0 0 1px #ffffffcc', borderRadius: '3px', display: 'none' });
    root.append(blockers, outline, dots); document.documentElement.append(host);
  }
  // Convert nested document coordinates to the top viewport, including frame borders and CSS scaling.
  function rect(el, entry) {
    let r = el.getBoundingClientRect(), box = { x: r.x, y: r.y, w: r.width, h: r.height };
    for (const frame of [...entry.chain].reverse()) {
      r = frame.getBoundingClientRect();
      const sx = r.width / (frame.offsetWidth || r.width || 1), sy = r.height / (frame.offsetHeight || r.height || 1);
      const right = Math.min(box.x + box.w, frame.clientWidth), bottom = Math.min(box.y + box.h, frame.clientHeight);
      box.x = Math.max(0, box.x); box.y = Math.max(0, box.y);
      box.w = Math.max(0, right - box.x); box.h = Math.max(0, bottom - box.y);
      box = { x: r.x + (frame.clientLeft + box.x) * sx, y: r.y + (frame.clientTop + box.y) * sy, w: box.w * sx, h: box.h * sy };
    }
    return box;
  }
  function outlineAt(hit) {
    ensureOverlay();
    if (!hit?.el?.isConnected) { outline.style.display = 'none'; return; }
    const r = rect(hit.el, hit.entry);
    if (!r.w || !r.h || r.x + r.w <= 0 || r.y + r.h <= 0 || r.x >= innerWidth || r.y >= innerHeight) { outline.style.display = 'none'; return; }
    style(outline, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }
  function picked(el, entry) {
    if (!el) return;
    active = false; hover = { el, entry }; selected = null;
    const a = { element: describe(el), ancestors: ancestors(el), frames: entry.path, route: route(), documentTitle: cap(entry.doc.title) };
    selected = { anchor: a, el, entry };
    events.push({ type: 'picked', anchor: a, bounds: { ...rect(el, entry), viewportWidth: innerWidth, viewportHeight: innerHeight } });
    refresh();
  }
  const selectedBounds = () => selected?.el?.isConnected ? { ...rect(selected.el, selected.entry), viewportWidth: innerWidth, viewportHeight: innerHeight } : null;
  function bind(entry) {
    if (bindings.has(entry.doc)) { Object.assign(bindings.get(entry.doc).entry, entry); return; }
    const win = entry.doc.defaultView, handlers = [];
    const on = (name, fn) => { win.addEventListener(name, fn, { capture: true, passive: false }); handlers.push([name, fn]); };
    const own = (event) => event.composedPath().includes(host);
    const swallow = (event) => { if (active && !own(event)) { event.preventDefault(); event.stopImmediatePropagation(); } };
    on('pointermove', (event) => { if (!active || own(event)) return; const target = event.composedPath()[0], el = pickElement(target); pointCursor(el ? target : null); hover = { el, entry }; outlineAt(hover); });
    on('pointerout', (event) => { if (active && !event.relatedTarget) { pointCursor(null); hover = null; outlineAt(null); } });
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'dragstart', 'touchstart', 'touchend']) on(name, swallow);
    on('click', (event) => { if (!active || own(event)) return; swallow(event); picked(pickElement(event.composedPath()[0]), entry); });
    on('keydown', (event) => { if (!active) return; if (event.key === 'Escape') { swallow(event); active = false; hover = null; events.push({ type: 'exited' }); refresh(); } else event.stopImmediatePropagation(); });
    const unbind = () => { for (const [name, fn] of handlers) win.removeEventListener(name, fn, true); };
    unbind.entry = entry; bindings.set(entry.doc, unbind);
  }
  function scan() {
    docs = []; unavailable = 0; const blocked = [];
    function visit(doc, path, chain) {
      if (path.length > 10 || docs.length >= 60) return;
      const entry = { doc, path, chain }; docs.push(entry); bind(entry);
      for (const frame of queryAll(doc, 'iframe,frame')) {
        try {
          const child = frame.contentDocument;
          if (!child?.documentElement) throw new Error('inaccessible');
          visit(child, [...path, selector(frame)], [...chain, frame]);
        } catch { unavailable++; blocked.push({ el: frame, entry }); }
      }
    }
    visit(document, [], []);
    for (const [doc, unbind] of bindings) if (!docs.some((e) => e.doc === doc)) { unbind(); bindings.delete(doc); }
    ensureOverlay();
    for (const [el, cover] of blockerNodes) if (!active || !blocked.some((h) => h.el === el)) { cover.remove(); blockerNodes.delete(el); }
    if (active) for (const hit of blocked) {
      const r = rect(hit.el, hit.entry);
      let cover = blockerNodes.get(hit.el);
      if (!cover) {
        cover = document.createElement('div'); blockerNodes.set(hit.el, cover);
        cover.addEventListener('pointermove', () => { pointCursor(null); hover = hit; outlineAt(hit); });
        cover.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); picked(hit.el, hit.entry); });
        blockers.append(cover);
      }
      style(cover, { position: 'fixed', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, pointerEvents: 'auto', cursor: 'pointer' });
    }
    if (!active) pointCursor(null);
  }
  function find(a) {
    if (a.route !== route()) return { confidence: 'unresolved', reason: 'different-page' };
    const entry = docs.find((e) => JSON.stringify(e.path) === JSON.stringify(a.frames));
    if (!entry) return { confidence: 'unresolved', reason: 'frame-unavailable' };
    return { ...resolve(entry.doc, a), entry };
  }
  function refresh() {
    if (lastRoute && lastRoute !== route()) {
      active = false; selected = hover = null;
      events.push({ type: 'navigated' });
    }
    lastRoute = route(); queryCache = new Map(); rootsCache = new Map(); descriptionCache = new WeakMap(); scan();
    const visibleMarkers = new Set();
    const resolutions = {};
    for (let i = 0; i < marks.length; i++) {
      const note = marks[i], got = find(note.anchor);
      resolutions[note.id] = { confidence: got.confidence, reason: got.reason || '', matchedOn: got.matchedOn || '' };
      if (!got.el) continue;
      const r = rect(got.el, got.entry);
      if (!r.w || !r.h || r.x + r.w < 0 || r.y + r.h < 0 || r.x > innerWidth || r.y > innerHeight) continue;
      visibleMarkers.add(note.id);
      let dot = markerNodes.get(note.id);
      if (!dot) {
        dot = document.createElement('button'); markerNodes.set(note.id, dot); dots.append(dot);
        dot.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); active = false; selected = { anchor: note.anchor, ...find(note.anchor) }; hover = null; refresh(); events.push({ type: 'marker', id: note.id, bounds: selectedBounds() }); });
      }
      dot.textContent = String(i + 1); dot.setAttribute('aria-label', `Open annotation ${i + 1}`);
      style(dot, { position: 'fixed', left: `${Math.max(0, Math.min(r.x + r.w - 12, innerWidth - 24))}px`, top: `${Math.max(0, r.y - 10)}px`, width: '23px', height: '23px', padding: '0', border: '2px solid white', borderRadius: '50%', background: '#525252', color: 'white', font: '600 11px/1 system-ui', boxShadow: '0 1px 3px #0003', cursor: 'pointer', pointerEvents: 'auto' });
    }
    for (const [id, dot] of markerNodes) if (!visibleMarkers.has(id)) { dot.remove(); markerNodes.delete(id); }
    if (selected) { const got = find(selected.anchor); selected = { anchor: selected.anchor, ...got }; }
    outlineAt(active ? hover : selected);
    const signature = JSON.stringify({ resolutions, unavailable, active });
    if (signature !== lastSignature) { lastSignature = signature; events.push({ type: 'status', resolutions, unavailable, active }); }
  }
  function clear() {
    pointCursor(null);
    active = false; marks = []; selected = hover = null; events = []; lastSignature = '';
    for (const unbind of bindings.values()) unbind(); bindings.clear();
    markerNodes.clear(); blockerNodes.clear(); queryCache.clear(); rootsCache.clear(); descriptionCache = new WeakMap(); docs = [];
    host?.remove(); host = null;
  }
  globalThis.__engelbartAnnotations = {
    command(message) {
      if (message.type === 'clear') { clear(); return []; }
      if (message.type === 'show') marks = message.items;
      if (message.type === 'mode') { active = message.on; selected = hover = null; }
      if (message.type === 'locate') {
        active = false; selected = hover = null; scan(); const note = marks.find((n) => n.id === message.id);
        if (note) { const got = find(note.anchor); selected = { anchor: note.anchor, ...got }; got.el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); for (const frame of [...(got.entry?.chain || [])].reverse()) frame.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      }
      refresh();
      if (message.type === 'locate') events.push({ type: 'located', id: message.id, bounds: selectedBounds() });
      const result = events; events = []; return result.slice(-30);
    },
  };
}

module.exports = { source: `(${installAnnotationPage.toString()})();`, WORLD: 1739 };
