'use strict';

// A selection's card (2026-10-18, David: "the annotation card should appear by itself just under the selection, ready to
// type into"): where it goes (src/shared/selection-card.cjs), the pdf's empty card and its keys (src/renderer/pdf/
// PaperView.jsx, in a small fake DOM as test/paper-blank-arrows.test.cjs lays it out), and a web page's, main's card view in
// its 'selection' mode (src/main/browser/views.cjs, a fake Electron as test/web-boxes.test.cjs has). On a web page
// (2026-10-18) nothing is kept until Save; Cancel, Esc, a click elsewhere or the selection gone leaves nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');

const { CARD_GAP, SEL_CARD_W, CARD_SHADE, CHAT_ICON, ICON_GAP, ICON_SHADE, selectionCardPlace, shadedCardPlace, chatIconPlace, shadedIconPlace } = require('../src/shared/selection-card.cjs');
const PAGE = require('../src/main/browser/page-preload.cjs');
const CARD = require('../src/main/browser/box-card-preload.cjs');
const VIEWS = require('../src/main/browser/views.cjs');

/* --------------------------------------------------------------------------------------------------- the place */

const pane = { x: 0, y: 0, width: 800, height: 600 };
const size = { width: 240, height: 60 };

test('the card goes under the selection\'s last line, left with it, CARD_GAP below', () => {
  const line = { x: 120, y: 300, width: 200, height: 16 }, all = { x: 40, y: 260, width: 400, height: 56 };
  assert.deepEqual(selectionCardPlace(line, all, pane, size), { x: 120, y: 316 + CARD_GAP, width: 240, height: 60 });
});

test('with no room under it, the card goes above the selection\'s first line', () => {
  const line = { x: 120, y: 560, width: 200, height: 16 }, all = { x: 40, y: 520, width: 400, height: 56 };
  assert.deepEqual(selectionCardPlace(line, all, pane, size), { x: 120, y: 520 - CARD_GAP - 60, width: 240, height: 60 });
});

test('the card is kept inside the pane: pushed in from its right edge, as far down as it fits with room nowhere, never wider', () => {
  const at = selectionCardPlace({ x: 700, y: 100, width: 60, height: 16 }, null, pane, size);
  assert.deepEqual(at, { x: 800 - 240, y: 116 + CARD_GAP, width: 240, height: 60 });
  // a selection as tall as the pane: neither below nor above, so against its bottom
  const tall = selectionCardPlace({ x: 10, y: 580, width: 60, height: 16 }, { x: 10, y: 20, width: 600, height: 576 }, pane, size);
  assert.deepEqual(tall, { x: 10, y: 540, width: 240, height: 60 });
  // a pane narrower than the card: the card is the pane's width, at its left
  assert.deepEqual(selectionCardPlace({ x: 50, y: 10, width: 20, height: 10 }, null, { x: 30, y: 0, width: 100, height: 600 }, size), { x: 30, y: 20 + CARD_GAP, width: 100, height: 60 });
});

test('a selection wholly out of the pane has no card; one partly in it has', () => {
  assert.equal(selectionCardPlace({ x: 10, y: 700, width: 60, height: 16 }, null, pane, size), null);
  assert.equal(selectionCardPlace({ x: 10, y: -40, width: 60, height: 16 }, { x: 10, y: -80, width: 60, height: 56 }, pane, size), null);
  assert.ok(selectionCardPlace({ x: 10, y: 10, width: 60, height: 16 }, { x: 10, y: -80, width: 60, height: 106 }, pane, size));
  assert.equal(selectionCardPlace(null, null, pane, size), null);
  assert.equal(selectionCardPlace({ x: NaN, y: 0, width: 1, height: 1 }, null, pane, size), null);
});

test('a page\'s preload measures the selection: its last line (the boxes level with its lowest) and all of it', () => {
  const at = PAGE.selectionBoxes([
    { left: 40, top: 100, width: 300, height: 16 },
    { left: 40, top: 118, width: 120, height: 16 },
    { left: 160, top: 119, width: 30, height: 14 },
    { left: 0, top: 0, width: 0, height: 0 }, // an empty box a range has for a line break
  ]);
  assert.deepEqual(at, { line: { x: 40, y: 118, w: 150, h: 16 }, rect: { x: 40, y: 100, w: 300, h: 34 } });
  assert.equal(PAGE.selectionBoxes([{ left: 1, top: 1, width: 0, height: 0 }]), null);
});

/* -------------------------------------------------------------------------------------------- the chat icon */

/** An ES module of the renderer's, bundled to CommonJS to read here. */
function loadRenderer(rel) {
  const filename = path.join(__dirname, `__${path.basename(rel)}-selection-card-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '..', rel)], bundle: true, platform: 'node', format: 'cjs', write: false });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const ICON = loadRenderer('src/renderer/ui/chat-icon.js');
const SEND = loadRenderer('src/renderer/ui/send-button.js');

test('the chat icon (2026-10-24 later): 22 to 24px, a hairline edge on its own white, a shadow inside ICON_SHADE, fading in 120ms; one look for the web and the pdf', () => {
  assert.ok(CHAT_ICON >= 22 && CHAT_ICON <= 24, `${CHAT_ICON}px`);
  const look = ICON.chatIconLook();
  assert.match(look, new RegExp(`width:${CHAT_ICON}px;height:${CHAT_ICON}px`));
  assert.match(look, /border:\.5px solid rgba\(0,0,0,[.\d]+\)/, 'a hairline edge');
  assert.match(look, /background:#fff/, 'its own ground, on a dark page too');
  assert.match(look, /animation:chat-icon-in 120ms/);
  assert.match(ICON.CHAT_ICON_CSS, /@keyframes chat-icon-in\{from\{opacity:0\}to\{opacity:1\}\}/);
  // every layer of its shadow (x, y, blur) reaches no further than the room the web page's icon view has about it
  const layers = [...ICON.ICON_SHADOW.matchAll(/(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)px/g)];
  assert.ok(layers.length > 0);
  for (const [, x, y, blur] of layers) assert.ok(Math.max(Math.abs(+x), Math.abs(+y)) + +blur <= ICON_SHADE, ICON.ICON_SHADOW);
  assert.match(look, new RegExp(`box-shadow:${ICON.ICON_SHADOW.replace(/[().]/g, '\\$&')}`));
  assert.match(ICON.CHAT_SVG, /stroke-width="1\.5"/, 'a thinner bubble');
  assert.equal(ICON.CHAT_TIP, 'Ask or add a note');
});

test('the chat icon under the pointer: a little darker, its bubble the send\'s blue (send-button.js SEND_BLUE, not a copy)', () => {
  assert.equal(SEND.SEND_BLUE, '#0070f3');
  assert.match(SEND.boxSend(true), new RegExp(`background:${SEND.SEND_BLUE}`));
  const hover = ICON.CHAT_ICON_CSS.match(/\[data-chat-icon\]:hover\{([^}]*)\}/);
  assert.ok(hover);
  assert.match(hover[1], new RegExp(`color:${SEND.SEND_BLUE}!important`));
  assert.match(hover[1], /background:#f3f3f3!important/);
});

test('chatIconPlace: CHAT_ICON square, ICON_GAP right of the last line\'s end, level with its middle; under the end with no room right, above with none under; none once the end is out', () => {
  const box = { width: CHAT_ICON, height: CHAT_ICON };
  assert.deepEqual(chatIconPlace({ x: 100, y: 200, width: 300, height: 20 }, pane), { x: 400 + ICON_GAP, y: 210 - CHAT_ICON / 2, ...box });
  assert.deepEqual(chatIconPlace({ x: 500, y: 200, width: 290, height: 20 }, pane), { x: 790 - CHAT_ICON, y: 220 + ICON_GAP, ...box }, 'no room right: under its end');
  assert.deepEqual(chatIconPlace({ x: 500, y: 580, width: 290, height: 16 }, pane), { x: 790 - CHAT_ICON, y: 580 - ICON_GAP - CHAT_ICON, ...box }, 'nor under: above');
  assert.equal(chatIconPlace({ x: 100, y: 620, width: 300, height: 20 }, pane), null, 'scrolled out');
  // a web page's view: the icon in the pane less ICON_SHADE, the view that much bigger on every side
  assert.deepEqual(shadedIconPlace({ x: 100, y: 200, width: 300, height: 20 }, pane), { x: 400 + ICON_GAP - ICON_SHADE, y: 210 - CHAT_ICON / 2 - ICON_SHADE, width: CHAT_ICON + 2 * ICON_SHADE, height: CHAT_ICON + 2 * ICON_SHADE });
});

/* ------------------------------------------------------------------------------- the offered selection's tint */

test('the page\'s tint of the offered selection (tintOffer): on when it is offered, moved with a new selection, off when withdrawn or its card closed', () => {
  const h = new Map();
  const make = (range) => ({ range });
  const r1 = { id: 'r1' }, r2 = { id: 'r2' };
  // offered: its selection tinted, over the highlights
  assert.equal(PAGE.tintOffer(h, { token: 's1', sel: r1 }, make), true);
  assert.equal(h.get(PAGE.OFFER).range, r1);
  assert.equal(h.get(PAGE.OFFER).priority, 1);
  // the selection changed and offered again: the new one tinted, the old not
  PAGE.tintOffer(h, { token: 's2', sel: r2 }, make);
  assert.equal(h.get(PAGE.OFFER).range, r2);
  // withdrawn (a click elsewhere, the selection changed by keys, the page left) or its card closed (Esc, Cancel, Save)
  assert.equal(PAGE.tintOffer(h, null, make), false);
  assert.equal(h.has(PAGE.OFFER), false);
  // a highlight's card opened by a click: no selection, no tint; the highlights' own name untouched
  h.set(PAGE.HIGHLIGHT, 'marks');
  assert.equal(PAGE.tintOffer(h, { token: 'm1', sel: null, markId: 'h-1' }, make), false);
  assert.equal(h.has(PAGE.OFFER), false);
  assert.equal(h.get(PAGE.HIGHLIGHT), 'marks');
  assert.equal(PAGE.tintOffer(null, { token: 's3', sel: r1 }, make), false, 'no registry: nothing');
  assert.notEqual(PAGE.OFFER, PAGE.HIGHLIGHT);
  assert.notEqual(PAGE.OFFER, PAGE.SECTION);
});

test('main styles the tint as the active selection, !important, beside the highlights\' and sections\'', () => {
  assert.ok(VIEWS.MARK_CSS.includes(`::highlight(${PAGE.OFFER}){`));
  const rule = VIEWS.MARK_CSS.slice(VIEWS.MARK_CSS.indexOf(`::highlight(${PAGE.OFFER}){`));
  assert.match(rule, /background-color:[^;]*Highlight[^;]*!important/, 'the system\'s selection colour');
  assert.match(rule, /background-color:rgba\(128,188,255,\.6\) !important/, 'and the default blue where that cannot be read');
  assert.ok(VIEWS.MARK_CSS.includes(`::highlight(${PAGE.HIGHLIGHT}){`) && VIEWS.MARK_CSS.includes(`::highlight(${PAGE.SECTION}){`));
  assert.equal(VIEWS.OFFER_SELECTION_CSS, '::selection{background-color:transparent !important}');
});

/* ------------------------------------------------------------------------------------------------- the pdf's */

function loadView() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-selection-card-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/pdf/PaperView.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'pdfjs-dist', 'roughjs'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const stubs = { 'pdfjs-dist': { GlobalWorkerOptions: {} }, roughjs: { __esModule: true, default: null } };
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  compiled._compile(bundled.outputFiles[0].text, filename);
  delete globalThis.document;
  return compiled.exports;
}
const { default: PaperView } = loadView();

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function styleOf() {
  const style = { setProperty(k, v) { style[k] = v; } };
  Object.defineProperty(style, 'cssText', {
    set(text) { for (const decl of String(text).split(';')) { const at = decl.indexOf(':'); if (at > 0) style[camel(decl.slice(0, at).trim())] = decl.slice(at + 1).trim(); } },
    get() { return ''; },
  });
  return style;
}
function matchOne(el, sel) {
  const last = sel.trim().split(/\s+/).pop();
  if (last.startsWith('.')) return String(el.className || '').split(/\s+/).includes(last.slice(1));
  const m = last.match(/^([a-z]+)?(?:\[(data-)?([\w-]+)(?:="([^"]*)")?\])?$/i);
  if (!m || (!m[1] && !m[3])) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  if (m[3]) {
    const v = m[2] ? el.dataset[camel(m[3])] : el.attrs[m[3]];
    if (v == null || (m[4] != null && String(v) !== m[4])) return false;
  }
  return true;
}
const matches = (el, sel) => String(sel).split(',').some((one) => matchOne(el, one));
const ZERO = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.nodeType = 1; this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.style = styleOf(); this.html = ''; this.scrollHeight = 21; this.scrollTop = 0; this.rect = null; this.height = 0; const classes = new Set(); this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }; }
  get parentElement() { return this.parentNode; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return !!n.root; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get offsetWidth() { return parseFloat(this.style.width) || parseFloat(this.style.maxWidth) || 0; }
  get offsetHeight() { return this.dataset.box === 'card' ? 44 : this.height; }
  get offsetLeft() { return 0; }
  get offsetTop() { return 0; }
  set innerHTML(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.html = String(v); }
  get innerHTML() { return this.html; }
  set textContent(v) { this.innerHTML = v; }
  get textContent() { return this.html; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? Object.assign(new El('span'), { html: c }) : c); }
  prepend(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.unshift(c); }
  insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  replaceChildren(...cs) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...cs); }
  replaceWith(n) { const p = this.parentNode; if (!p) return; if (n.parentNode) n.remove(); p.children[p.children.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; }
  remove() { const p = this.parentNode; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  getBoundingClientRect() { return this.rect || ZERO; }
  getContext() { return {}; }
  querySelectorAll(sel) { const out = []; const walk = (el) => { for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() { globalThis.document.activeElement = this; if (this.onfocus) this.onfocus(); }
  blur() { if (globalThis.document.activeElement !== this) return; globalThis.document.activeElement = globalThis.document.body; if (this.onblur) this.onblur(); }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
}
function fakeDocument() {
  const body = new El('body');
  return { baseURI: 'file:///app/index.html', body, activeElement: body, createElement: (tag) => new El(tag), createElementNS: (_, tag) => new El(tag) };
}

const W = 612, H = 700;
const pdfPage = { getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }), getTextContent: () => Promise.resolve({ items: [] }) };
const tick = () => new Promise((r) => setTimeout(r, 1));

async function viewer(marks = {}) {
  globalThis.document = fakeDocument();
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  const frame = new El('div');
  frame.root = true;
  const host = frame.appendChild(new El('div'));
  host.clientWidth = W; host.clientHeight = H; host.clientLeft = 0; host.clientTop = 0; host.scrollLeft = 0; host.scrollTop = 0;
  host.rect = { left: 0, top: 0, right: W, bottom: H, width: W, height: H };
  const all = { marks };
  const view = new PaperView(all);
  view.props = all;
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  view.host = { current: host };
  view.doc = { numPages: 1, getPage: async () => pdfPage };
  view.zoom = 1;
  let saves = 0;
  view.scheduleSave = () => { saves += 1; };
  await view.layout();
  view.drawSoon();
  for (let i = 0; i < 200 && view.pumping; i += 1) await tick();
  const s = view.sheets[1], g = view.geo[1];
  s.wrap.rect = { left: 0, top: 0, right: W, bottom: g.pageH, width: W, height: g.pageH };
  s.tl.rect = { left: g.G, top: 0, right: g.G + g.pageW, bottom: g.pageH, width: g.pageW, height: g.pageH };
  return { view, host, frame, s, g, saves: () => saves };
}
test.afterEach(() => { for (const name of ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'window', 'getSelection']) delete globalThis[name]; });

/** A selection on page 1 (px of a page 612 wide), pending as pdfMouseUp leaves it, with its card open. */
function select(view, rects, text = 'the selected words') {
  view.pendingSel = { parts: [{ page: 1, rects, width: 612, text, u: 612 }], text };
  view.showPending();
  view.openSelCard();
}
const press = (view, key, more = {}) => {
  const e = { key, target: document.body, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...more };
  return { taken: view.pendingSelKey(e), e };
};
const kept = (view) => (view.marks[1] || []).filter((m) => (m.rects || []).length);

test('pdf: a selection opens an empty card under its last line, left with it, the placeholder after a caret; nothing is kept', async () => {
  const { view, frame, g, saves } = await viewer();
  select(view, [{ x: 50, y: 100, w: 300, h: 12 }, { x: 50, y: 116, w: 120, h: 12 }]);
  const card = view.selEl;
  assert.ok(card, 'a card');
  assert.equal(card.parentNode, frame, 'over the pane, not in the paper');
  assert.equal(card.style.visibility, '', 'placed, so shown');
  assert.equal(parseFloat(card.style.left), Math.round(g.G + 50 * g.k));
  assert.equal(parseFloat(card.style.top), Math.round(128 * g.k + CARD_GAP), 'under the last line');
  assert.ok(card.querySelector('[data-sel-caret]'), 'a caret');
  assert.equal(card.querySelector('[data-sel-placeholder]').textContent, 'Write a note or ask @bart');
  assert.equal(kept(view).length, 0);
  assert.equal(saves(), 0);
});

test('pdf: with no room under the selection the card goes above it', async () => {
  const { view, g } = await viewer();
  select(view, [{ x: 50, y: 660, w: 300, h: 12 }]);
  const card = view.selEl, ns = parseFloat(String(card.style.transform).replace(/[^\d.]/g, ''));
  card.height = 40;
  view.placeSelCard();
  assert.equal(parseFloat(card.style.top), Math.round(660 * g.k - CARD_GAP - 40 * ns));
});

test('pdf: Esc, a click elsewhere, or the selection out of view put the empty card away and keep no mark', async () => {
  const { view, s, host, saves } = await viewer();
  select(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  assert.equal(press(view, 'Escape').taken, true);
  assert.equal(view.selEl, null);
  assert.equal(view.pendingSel, null);
  // a click on the page away from the words
  select(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  const e = { button: 0, target: s.tl, clientX: 300, clientY: 600, preventDefault() {}, stopPropagation() {} };
  view.onDown(e); view.pdfMouseUp(e);
  assert.equal(view.selEl, null);
  // scrolled away: the pane is far below the selection
  select(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  host.scrollTop = 2000;
  s.tl.rect = { ...s.tl.rect, top: s.tl.rect.top - 2000, bottom: s.tl.rect.bottom - 2000 }; // the page moved up with it
  view.placeSelCard();
  assert.equal(view.selEl, null);
  assert.equal(view.pendingSel, null);
  assert.equal(kept(view).length, 0, 'no highlight');
  assert.equal(saves(), 0, 'nothing saved');
});

test('pdf: the first key keeps the highlight with that note, its own card where the empty one was, with the keyboard; Enter keeps it alone', async () => {
  const { view, s } = await viewer();
  select(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  const { taken, e } = press(view, 'w');
  assert.equal(taken, true);
  assert.equal(e.prevented, true, 'typed once, by the note');
  const [m] = kept(view);
  assert.ok(m, 'a highlight');
  assert.equal(m.note, 'w');
  assert.equal(m.text, 'the selected words');
  assert.deepEqual(view.selCard, { markId: m.id }, 'its card drawn where the empty one was');
  assert.equal(view.selEl, null, 'the empty card gone');
  const ta = s.notes.querySelector(`textarea[data-mark="${m.id}"]`);
  assert.ok(ta);
  assert.equal(document.activeElement, ta, 'the note has the keyboard');
  // ⌘C, ⌘A and the arrows are not the card's
  select(view, [{ x: 50, y: 300, w: 200, h: 12 }], 'other words');
  for (const key of ['c', 'a']) assert.equal(press(view, key, { metaKey: true }).taken, false);
  assert.equal(press(view, 'ArrowDown').taken, false);
  assert.ok(view.selEl, 'still open');
  // Enter: the highlight with no note
  assert.equal(press(view, 'Enter').taken, true);
  const plain = kept(view).find((x) => x.text === 'other words');
  assert.ok(plain);
  assert.equal(plain.note, null);
  assert.equal(view.selEl, null);
});

/* --------------------------------------------------------------------------------------------- a web page's */

/** A selection on page 1, pending as pdfMouseUp leaves it (2026-10-24): the chat icon at its end, no card. */
function selectIcon(view, rects, text = 'the selected words') {
  view.pendingSel = { parts: [{ page: 1, rects, width: 612, text, u: 612 }], text };
  view.showPending();
  view.openSelIcon();
}
const click = () => ({ preventDefault() {}, stopPropagation() {} });

test('pdf: a settled selection shows the chat icon at its last line\'s end, level with it, over the pane, with its tooltip; nothing is kept', async () => {
  const { view, frame, g, saves } = await viewer();
  selectIcon(view, [{ x: 50, y: 100, w: 300, h: 12 }, { x: 50, y: 116, w: 120, h: 12 }]);
  const icon = view.selIcon;
  assert.ok(icon, 'an icon');
  assert.equal(icon.parentNode, frame, 'over the pane, not in the paper');
  assert.equal(icon.dataset.chatIcon, '1');
  assert.equal(icon.title, 'Ask or add a note');
  assert.equal(icon.style.visibility, '', 'placed, so shown');
  assert.equal(view.selEl, null, 'no card until it is clicked');
  assert.equal(parseFloat(icon.style.left), Math.round(g.G + 170 * g.k + ICON_GAP), 'right of the last line\'s end');
  assert.equal(parseFloat(icon.style.top), Math.round(116 * g.k + (12 * g.k - CHAT_ICON) / 2), 'level with it');
  // a press on it keeps the selection (its default prevented, so the page's selection is not lost)
  let prevented = false;
  icon.onmousedown({ preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.ok(view.pendingSel, 'still pending');
  assert.equal(kept(view).length, 0);
  assert.equal(saves(), 0);
});

test('pdf: the icon clicked keeps the highlight with an empty note, its field focused where the card goes; the icon gone', async () => {
  const { view, s } = await viewer();
  selectIcon(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  const icon = view.selIcon;
  icon.onclick(click());
  const [m] = kept(view);
  assert.ok(m, 'a highlight');
  assert.equal(m.note, '');
  assert.equal(view.selIcon, null, 'the icon gone');
  assert.equal(icon.parentNode, null);
  assert.deepEqual(view.selCard, { markId: m.id });
  const ta = s.notes.querySelector(`textarea[data-mark="${m.id}"]`);
  assert.ok(ta, 'its note\'s field');
  assert.equal(document.activeElement, ta, 'with the keyboard');
  // its round send, under it: disabled with nothing typed, blue once there is
  const send = s.notes.querySelector(`[data-send="${m.id}"]`);
  assert.ok(send, 'the send');
  assert.equal(send.disabled, true);
  assert.equal(send.style.background, '#ececec');
  ta.value = 'a note';
  ta.oninput();
  assert.equal(send.disabled, false);
  assert.equal(send.style.background, '#0070f3');
  assert.equal(send.style.color, '#fff');
});

test('pdf: Esc, the selection let go, or its end scrolled out of the pane put the icon away and keep nothing', async () => {
  const { view, s, host, saves } = await viewer();
  selectIcon(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  assert.equal(press(view, 'Escape').taken, true);
  assert.equal(view.selIcon, null);
  assert.equal(view.pendingSel, null);
  selectIcon(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  view.clearPending();
  assert.equal(view.selIcon, null, 'the selection cleared');
  selectIcon(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  host.scrollTop = 2000;
  s.tl.rect = { ...s.tl.rect, top: s.tl.rect.top - 2000, bottom: s.tl.rect.bottom - 2000 };
  view.placeSelCard(); // what a scroll calls
  assert.equal(view.selIcon, null, 'scrolled past');
  assert.equal(view.pendingSel, null);
  assert.equal(kept(view).length, 0);
  assert.equal(saves(), 0);
});

test('pdf: a highlight\'s note sends as the workspace\'s do: Enter or its send leaves a plain note as typed, asks a leading @bart; Shift+Enter is a line', async () => {
  const { view, s } = await viewer();
  selectIcon(view, [{ x: 50, y: 100, w: 300, h: 12 }]);
  view.selIcon.onclick(click());
  const [m] = kept(view);
  const ta = s.notes.querySelector(`textarea[data-mark="${m.id}"]`);
  const asked = [];
  view.props = { ...view.props, onAsk: () => {} }; // a Stage that can ask
  view.askFrom = (_ta, mark, page, question) => asked.push([mark.id, page, question]);
  const enter = (more = {}) => ({ key: 'Enter', shiftKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...more });
  ta.value = 'line one';
  ta.oninput();
  const shift = enter({ shiftKey: true });
  view.noteKey(shift, ta, m, 1);
  assert.equal(shift.prevented, false, 'Shift+Enter: a new line');
  assert.equal(document.activeElement, ta);
  const plain = enter();
  view.noteKey(plain, ta, m, 1);
  assert.equal(plain.prevented, true, 'Enter sends');
  assert.notEqual(document.activeElement, ta, 'the note left');
  assert.deepEqual(asked, []);
  assert.equal(m.note, 'line one', 'kept as typed');
  // again, in its field, asking: the send asks as Enter does
  view.editing = m.id;
  view.renderMarks(1);
  const again = s.notes.querySelector(`textarea[data-mark="${m.id}"]`);
  again.focus();
  again.value = '@bart what is this?';
  again.oninput();
  s.notes.querySelector(`[data-send="${m.id}"]`).onclick(click()); // the send asks as Enter does
  assert.deepEqual(asked, [[m.id, 1, 'what is this?']]);
  again.value = '   ';
  assert.equal(view.sendNote(again, m, 1), false, 'nothing to send');
});

function fakeElectron() {
  const made = [];
  let frames = 0;
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.visible = true;
      this.bounds = { x: 0, y: 0, width: 800, height: 600 };
      const contents = options.webContents || new EventEmitter();
      const ipc = { handlers: new Map(), listeners: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); }, on(channel, fn) { this.listeners.set(channel, fn); } };
      Object.assign(contents, {
        ipc, sent: [], css: [], loaded: [], closed: false, focused: 0, url: contents.url || '',
        mainFrame: { frameTreeNodeId: (frames += 1) },
        loadURL(url) { this.loaded.push(url); this.url = url; this.mainFrame.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle: () => 'Title', isLoading: () => false, isDestroyed() { return this.closed; },
        close() { this.closed = true; }, reload() {}, stop() {}, focus() { this.focused += 1; }, getZoomFactor: () => 1,
        send(channel, payload) { this.sent.push([channel, payload]); },
        insertCSS(css) { this.css.push(css); return Promise.resolve(`key-${this.css.length}`); },
        removeInsertedCSS() { return Promise.resolve(); },
        zoom: 1, setZoomFactor(z) { this.zoom = z; }, isFocused() { return false; },
        setWindowOpenHandler(handler) { this.windowOpen = handler; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
      });
      this.webContents = contents;
      made.push(this);
    }
    setBackgroundColor(color) { this.background = color; }
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible; }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  }
  const browsing = {
    preloads: [], cookies: { on() {}, flushStore: async () => {} }, setUserAgent() {}, getUserAgent: () => 'UA', setPermissionRequestHandler() {},
    webRequest: { onHeadersReceived() {} }, on() {}, registerPreloadScript(script) { this.preloads.push(script); return script.id; },
  };
  const children = [];
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1, focus() {} }, contentView: { addChildView(v) { children.push(v); }, removeChildView() {} } };
  return { made, children, win, electron: { WebContentsView, session: { fromPartition: () => browsing }, Menu: { buildFromTemplate: () => ({ popup() {} }) }, clipboard: {}, dialog: {}, shell: { openExternal: async () => {} } } };
}

const URL_A = 'https://en.wikipedia.org/wiki/Douglas_Engelbart';
function setup() {
  const fake = fakeElectron();
  const saved = [], updated = [], told = [];
  const pageMarks = {
    list: async () => saved.map(([, mark]) => mark),
    add: async (url, mark) => { saved.push([url, mark]); return true; },
    update: async (url, markId, patch) => { updated.push([url, markId, patch]); return { id: markId, ...patch }; },
    remove: async (url, markId) => { const i = saved.findIndex(([, m]) => m.id === markId); return i < 0 ? null : saved.splice(i, 1)[0][1]; },
  };
  let n = 0;
  const views = VIEWS.createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: (channel, payload) => { told.push([channel, payload]); }, appName: 'Engelbart', pageMarks, newId: () => `h-${(n += 1)}` });
  views.open('a', URL_A);
  views.show('a', { x: 0, y: 40, width: 800, height: 600 });
  const page = fake.made[0].webContents;
  const fromMain = { sender: page, senderFrame: page.mainFrame };
  const offer = (value) => page.ipc.listeners.get(PAGE.CHANNELS.selectionCard)(fromMain, value);
  const cardView = () => fake.made.find((v) => v.options.webPreferences.preload === VIEWS.BOX_CARD_PRELOAD);
  const lastState = () => cardView().webContents.sent.filter(([c]) => c === CARD.CHANNELS.state).at(-1)[1];
  const fromCard = () => ({ sender: cardView().webContents, senderFrame: cardView().webContents.mainFrame });
  const onCard = (name) => cardView().webContents.ipc.listeners.get(CARD.CHANNELS[name]);
  return { fake, views, page, fromMain, offer, cardView, lastState, fromCard, onCard, saved, updated, told };
}
const key = (contents, input) => { let prevented = false; contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: '', isAutoRepeat: false, shift: false, meta: false, control: false, alt: false, ...input }); return prevented; };
const settle = () => new Promise((r) => setTimeout(r, 10));
const QUOTE = { exact: 'the oNLine System', prefix: 'demonstrated ', suffix: ' in 1968' };
const at = (token, line, rect) => ({ token, line, rect: rect || line, viewport: { width: 800, height: 600 } });

test('web: a settled selection gets the chat icon at its end; the icon clicked, the card view under its last line (its shadow\'s room about it), above it with no room, kept in the page', () => {
  const { offer, cardView, lastState, onCard, fromCard } = setup();
  offer({ ...at('s1', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE, pageText: 'Engelbart demonstrated the oNLine System in 1968' });
  const card = cardView();
  assert.ok(card, 'the card view, the one boxes have');
  card.webContents.emit('did-finish-load');
  assert.deepEqual(lastState(), { mode: 'selection', offer: 's1', mark: null, running: [], icon: true }, 'the icon alone');
  assert.equal(card.visible, true);
  // the line ends at x 400 (y 90 to 110 in the window): the icon ICON_GAP right of it, level with it, its shadow's room about it
  assert.deepEqual(card.bounds, { x: 400 + ICON_GAP - ICON_SHADE, y: 100 - CHAT_ICON / 2 - ICON_SHADE, width: CHAT_ICON + 2 * ICON_SHADE, height: CHAT_ICON + 2 * ICON_SHADE });
  onCard('open')(fromCard());
  assert.deepEqual(lastState(), { mode: 'selection', offer: 's1', mark: null, running: [] }, 'the empty card');
  assert.ok(card.webContents.focused > 0, 'with the keyboard');
  // the page is at y 40: the line's bottom is at 110 in the window, the card itself CARD_GAP under it, its view the
  // shadow's room bigger on every side
  const { side, top, bottom } = CARD_SHADE;
  assert.deepEqual(card.bounds, { x: 100 - side, y: 110 + CARD_GAP - top, width: SEL_CARD_W + 2 * side, height: 96 + top + bottom });
  // the page scrolled: it follows; near the bottom it goes above; near the right edge it is pushed in, its shadow too
  offer(at('s1', { x: 700, y: 560, w: 60, h: 20 }, { x: 100, y: 540, w: 660, h: 40 }));
  assert.deepEqual(card.bounds, { x: 800 - SEL_CARD_W - 2 * side, y: 40 + 540 - CARD_GAP - 96 - top, width: SEL_CARD_W + 2 * side, height: 96 + top + bottom });
  // another token's whereabouts (an old selection's) move nothing
  offer(at('s0', { x: 10, y: 10, w: 60, h: 20 }));
  assert.equal(card.bounds.y, 40 + 540 - CARD_GAP - 96 - top);
});

test('shadedCardPlace: the card where selectionCardPlace puts it in the pane less the shadow\'s room, the view that room bigger', () => {
  const page = { x: 0, y: 40, width: 800, height: 600 }, line = { x: 100, y: 90, width: 300, height: 20 };
  assert.deepEqual(shadedCardPlace(line, line, page, { width: 340, height: 96 }), { x: 76, y: 100, width: 388, height: 144 });
  assert.equal(shadedCardPlace({ x: 100, y: 900, width: 30, height: 20 }, null, page, { width: 340, height: 96 }), null, 'out of the pane');
  // a selection in the pane's rim only: the card as near it as the room lets it be, still all in the pane
  const rim = shadedCardPlace({ x: 790, y: 41, width: 8, height: 10 }, null, page, { width: 340, height: 96 });
  assert.ok(rim.x >= 0 && rim.x + rim.width <= 800 && rim.y >= 40 && rim.y + rim.height <= 640, JSON.stringify(rim));
});

test('web: Esc, a click in the page (the offer taken back), the selection out of view or another tab close the empty card and keep nothing', async () => {
  const { views, page, offer, cardView, saved } = setup();
  offer({ ...at('s1', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  const card = cardView();
  assert.equal(key(page, { key: 'Escape' }), true);
  assert.equal(card.visible, false);
  assert.equal(key(page, { key: 'x' }), false, 'its keys the page\'s again');
  offer({ ...at('s2', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  assert.equal(card.visible, true);
  offer({ token: null });
  assert.equal(card.visible, false);
  offer({ ...at('s3', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  offer(at('s3', { x: 100, y: 900, w: 300, h: 20 }));
  assert.equal(card.visible, false, 'scrolled out of view');
  offer(at('s3', { x: 100, y: 50, w: 300, h: 20 }));
  assert.equal(card.visible, false, 'and not back: it was closed');
  offer({ ...at('s4', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  views.open('b', 'https://github.com/');
  views.show('b', { x: 0, y: 40, width: 800, height: 600 });
  views.show('a', { x: 0, y: 40, width: 800, height: 600 });
  assert.equal(card.visible, false, 'another tab was in front');
  await settle();
  assert.deepEqual(saved, []);
  assert.equal(page.sent.filter(([c]) => c === PAGE.CHANNELS.add).length, 0, 'nothing tinted');
});

test('web: while a selection is offered (its icon, then its card) the page\'s own selection is hidden for its tint; Esc, Cancel, Save, the offer taken back or another tab bring it back; a highlight clicked hides nothing', async () => {
  const { views, page, offer, cardView, onCard, fromCard } = setup();
  const removed = [];
  page.removeInsertedCSS = (k) => { removed.push(k); return Promise.resolve(); };
  // whether the rule that hides the page's selection is in now
  const hidden = () => page.css.map((css, i) => (css === VIEWS.OFFER_SELECTION_CSS ? `key-${i + 1}` : null)).filter((k) => k && !removed.includes(k)).length;
  const select = (token) => offer({ ...at(token, { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  select('s1');
  await settle();
  assert.equal(hidden(), 1, 'the icon shows: hidden');
  const card = cardView();
  card.webContents.emit('did-finish-load');
  onCard('open')(fromCard());
  offer(at('s1', { x: 100, y: 60, w: 300, h: 20 })); // scrolled
  await settle();
  assert.equal(hidden(), 1, 'its card open (the keyboard the card\'s): still hidden, the tint showing');
  card.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'Escape' });
  await settle();
  assert.equal(hidden(), 0, 'Esc: back');
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.cardGone), ['s1'], 'the page told, so its tint goes and the selection with it');
  select('s2');
  select('s3'); // the selection changed and offered again
  await settle();
  assert.equal(hidden(), 1, 'one rule for whichever selection is offered');
  offer({ token: null });
  await settle();
  assert.equal(hidden(), 0, 'taken back (a click elsewhere): back');
  select('s4');
  onCard('open')(fromCard());
  onCard('cancel')(fromCard());
  await settle();
  assert.equal(hidden(), 0, 'Cancel: back');
  select('s5');
  onCard('open')(fromCard());
  onCard('save')(fromCard(), 'A note');
  await settle();
  assert.equal(hidden(), 0, 'Save: back');
  assert.equal(added(page).at(-1)[1].clear, true, 'and the page lets go of the selection');
  select('s6');
  await settle();
  views.open('b', 'https://github.com/');
  views.show('b', { x: 0, y: 40, width: 800, height: 600 });
  await settle();
  assert.equal(hidden(), 0, 'another tab in front: back');
  views.show('a', { x: 0, y: 40, width: 800, height: 600 });
  offer({ ...at('m1', { x: 100, y: 50, w: 300, h: 20 }), markId: 'h-1', pageText: '' });
  await settle();
  assert.equal(hidden(), 0, 'a highlight\'s card opened by a click: no selection to hide');
});

const added = (page) => page.sent.filter(([c]) => c === PAGE.CHANNELS.add);
const sentOn = (page, channel) => page.sent.filter(([c]) => c === channel).map(([, v]) => v);

test('web: while the icon shows, every key but Esc is the page\'s; once open, a key in the page goes into the card, which takes the keyboard; nothing is kept until Save; ⌘C, Enter and the arrows stay the page\'s', async () => {
  const { page, offer, cardView, lastState, saved, updated, onCard, fromCard } = setup();
  offer({ ...at('s1', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE, pageText: 'Engelbart demonstrated the oNLine System in 1968' });
  const card = cardView();
  card.webContents.emit('did-finish-load');
  assert.equal(key(page, { key: 'x' }), false, 'typed in the page while the icon alone shows');
  assert.equal(card.webContents.focused, 0, 'the icon takes no keyboard');
  assert.equal(card.visible, true);
  onCard('open')(fromCard());
  assert.equal(key(page, { key: 'c', meta: true }), false, '⌘C copies the selection');
  assert.equal(key(page, { key: 'a', meta: true }), false);
  assert.equal(key(page, { key: 'ArrowDown' }), false);
  assert.equal(key(page, { key: 'Enter' }), false, 'Enter keeps nothing now');
  assert.equal(key(page, { key: 'Shift' }), false);
  assert.equal(key(page, { key: '@', shift: true }), true, 'the first character is the note\'s');
  assert.ok(card.webContents.focused > 0, 'the card has the keyboard');
  assert.deepEqual(lastState(), { mode: 'selection', offer: 's1', mark: null, running: [], typed: '@' });
  await settle();
  assert.deepEqual(saved, [], 'nothing kept');
  assert.deepEqual(updated, []);
  assert.equal(added(page).length, 0, 'nothing tinted');
});

test('web: Cancel (or Esc) on a new selection\'s card leaves no mark; the page is told the card went', async () => {
  const { page, offer, cardView, saved, onCard, fromCard } = setup();
  offer({ ...at('s1', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  const card = cardView();
  card.webContents.emit('did-finish-load');
  key(page, { key: 'H' });
  onCard('cancel')(fromCard());
  assert.equal(card.visible, false);
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.cardGone), ['s1']);
  offer({ ...at('s2', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  card.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'Escape' });
  assert.equal(card.visible, false);
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.cardGone), ['s1', 's2']);
  // a Save that comes after the card went keeps nothing either
  onCard('save')(fromCard(), 'too late');
  await settle();
  assert.deepEqual(saved, []);
  assert.equal(added(page).length, 0);
});

test('web: Save keeps the highlight with its note and closes the card; an empty Save keeps nothing; the same passage again is that mark, not a second', async () => {
  const { page, offer, cardView, saved, onCard, fromCard, updated } = setup();
  offer({ ...at('s1', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  const card = cardView();
  card.webContents.emit('did-finish-load');
  onCard('save')(fromCard(), 'Before the icon is clicked');
  await settle();
  assert.deepEqual(saved, [], 'the icon alone saves nothing');
  onCard('open')(fromCard());
  onCard('save')(fromCard(), '   ');
  await settle();
  assert.deepEqual(saved, [], 'an empty note keeps nothing');
  assert.equal(card.visible, true, 'and the card stays');
  onCard('save')(fromCard(), 'The demo');
  onCard('save')(fromCard(), 'The demo'); // a second Save for the same selection keeps nothing more
  await settle();
  assert.deepEqual(saved.map(([url, m]) => [url, m.id, m.note]), [[URL_A, 'h-1', 'The demo']]);
  assert.deepEqual(saved[0][1].quote, QUOTE);
  assert.deepEqual(added(page).at(-1)[1], { nonce: 's1', mark: { id: 'h-1', quote: QUOTE, noted: true }, clear: true }, 'tinted, its symbol shown, the selection let go');
  assert.equal(card.visible, false, 'closed');
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.cardGone), ['s1']);
  // the same passage selected again from scratch (as the duplicates were made): its note goes on the mark there is
  offer({ ...at('s2', { x: 100, y: 50, w: 300, h: 20 }), quote: { ...QUOTE } });
  onCard('open')(fromCard());
  onCard('save')(fromCard(), 'Second thoughts');
  await settle();
  assert.equal(saved.length, 1, 'never two marks for one passage');
  assert.deepEqual(updated.at(-1), [URL_A, 'h-1', { note: 'Second thoughts' }]);
  assert.deepEqual(added(page).at(-1)[1], { nonce: 's2', mark: { id: 'h-1', quote: QUOTE, noted: true }, clear: true });
  // another passage is a mark of its own
  offer({ ...at('s3', { x: 100, y: 50, w: 300, h: 20 }), quote: { ...QUOTE, prefix: 'he demonstrated ' + 'x' } });
  onCard('open')(fromCard());
  onCard('save')(fromCard(), 'Elsewhere');
  await settle();
  assert.deepEqual(saved.map(([, m]) => m.id), ['h-1', 'h-3']);
});

test('web: a note that starts with @bart is asked on Save, with the quote and the page\'s text; the card stays for the answer', async () => {
  const { page, offer, cardView, saved, onCard, fromCard, told } = setup();
  offer({ ...at('s1', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE, pageText: 'Engelbart demonstrated the oNLine System in 1968' });
  const card = cardView();
  card.webContents.emit('did-finish-load');
  onCard('open')(fromCard());
  onCard('save')(fromCard(), '@bart what is this');
  await settle();
  assert.deepEqual(saved.map(([, m]) => [m.id, m.note]), [['h-1', '@bart what is this']]);
  assert.deepEqual(added(page).at(-1)[1], { nonce: 's1', mark: { id: 'h-1', quote: QUOTE, noted: true } }, 'the selection kept while the card shows');
  const asked = told.filter(([c]) => c === 'browser:box-ask').at(-1)[1];
  assert.deepEqual(asked, { tab: 'a', markId: 'h-1', url: URL_A, title: 'Title', question: 'what is this', note: '@bart what is this', turns: [], quote: QUOTE.exact, pageText: 'Engelbart demonstrated the oNLine System in 1968' });
  assert.equal(card.visible, true);
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.cardGone), []);
});

test('web: a highlight\'s own card (a click on it): its note to edit, Save keeps the edit, Cancel drops it, Remove takes the highlight out', async () => {
  const { page, offer, cardView, lastState, saved, updated, onCard, fromCard } = setup();
  saved.push([URL_A, { id: 'h-9', quote: QUOTE, note: 'Old note', at: '2026-10-01T00:00:00.000Z' }]);
  offer({ ...at('m1', { x: 100, y: 50, w: 300, h: 20 }), markId: 'h-9', pageText: 'Engelbart demonstrated the oNLine System in 1968' });
  const card = cardView();
  card.webContents.emit('did-finish-load');
  await settle();
  assert.deepEqual(lastState(), { mode: 'selection', offer: 'm1', mark: { id: 'h-9', note: 'Old note', asks: [] }, running: [] });
  assert.equal(card.visible, true);
  onCard('cancel')(fromCard());
  await settle();
  assert.deepEqual(updated, [], 'Cancel keeps the note it had');
  offer({ ...at('m2', { x: 100, y: 50, w: 300, h: 20 }), markId: 'h-9' });
  onCard('save')(fromCard(), '');
  await settle();
  assert.deepEqual(updated.at(-1), [URL_A, 'h-9', { note: '' }], 'a note cleared');
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.noted).at(-1), { id: 'h-9', on: false }, 'its symbol gone');
  assert.equal(card.visible, false);
  assert.equal(saved.length, 1, 'no mark made');
});

test('web: Remove in a highlight\'s card takes it out of the page\'s ink, its tint and symbol off, and closes the card', async () => {
  const { page, offer, cardView, saved, onCard, fromCard } = setup();
  saved.push([URL_A, { id: 'h-9', quote: QUOTE, note: 'Old note', at: '2026-10-01T00:00:00.000Z' }]);
  offer({ ...at('m1', { x: 100, y: 50, w: 300, h: 20 }), markId: 'h-9' });
  const card = cardView();
  card.webContents.emit('did-finish-load');
  onCard('remove')(fromCard());
  await settle();
  assert.deepEqual(saved, []);
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.unmark), ['h-9']);
  assert.equal(card.visible, false);
  assert.deepEqual(sentOn(page, PAGE.CHANNELS.cardGone), ['m1']);
});

test('web: no card while a field has the keyboard, on a page whose ink is not kept, or for a box selected', () => {
  const { page, fromMain, offer, cardView } = setup();
  page.ipc.listeners.get(PAGE.CHANNELS.editing)(fromMain, true);
  offer({ ...at('s1', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  assert.equal(cardView(), undefined, 'a field has the keyboard');
  page.ipc.listeners.get(PAGE.CHANNELS.editing)(fromMain, false);
  page.url = 'https://claude.ai/code/preview/abc';
  // whether that address is a preview's decides; the card follows fileablePage
  offer({ ...at('s2', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  assert.equal(!!(cardView() && cardView().visible), VIEWS.fileablePage(page.url));
  page.url = URL_A;
  offer({ ...at('s3', { x: 100, y: 50, w: 300, h: 20 }), quote: QUOTE });
  assert.equal(cardView().visible, true);
  // a box selected: its card, not the selection's
  page.ipc.listeners.get(PAGE.CHANNELS.boxView)(fromMain, { id: 'b1', rect: { x: 100, y: 50, w: 200, h: 100 }, viewport: { width: 800, height: 600 } });
  assert.equal(key(page, { key: 'x' }), false);
  // what main takes from a page
  assert.deepEqual(VIEWS.selectionCardInput({ token: null }), { token: null });
  assert.equal(VIEWS.selectionCardInput({ token: 'bad token!', viewport: { width: 1, height: 1 } }), null);
  assert.equal(VIEWS.selectionCardInput({ token: 's1', viewport: { width: 1, height: 1 }, quote: { exact: '   ' } }), null);
  assert.equal(VIEWS.selectionCardInput({ token: 's1', viewport: null }), null);
  assert.deepEqual(VIEWS.selectionCardInput({ token: 's1', line: { x: 1, y: 2, w: 3, h: 'x' }, rect: { x: 1, y: 2, w: 3, h: 4 }, viewport: { width: 9, height: 9 } }), { token: 's1', line: null, rect: { x: 1, y: 2, w: 3, h: 4 }, viewport: { width: 9, height: 9 } });
});
