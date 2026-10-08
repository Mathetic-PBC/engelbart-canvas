'use strict';

// @bart in a PDF highlight's note (src/renderer/pdf/PaperView.jsx, MATH-27 phase 1, 2026-10-06): the @ menu offers Bart at
// the start of a highlight's note, Enter in a note that starts with @bart asks (Shift+Enter is a new line) with the
// passage, the note and the mark's earlier answers as the turns, and a finished answer from the Stage joins its mark. No
// pdf here: the viewer and its note's field are stand-ins (pdf.js and rough.js are not loaded).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-ask-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/pdf/PaperView.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'pdfjs-dist', 'roughjs'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const stubs = { 'pdfjs-dist': { GlobalWorkerOptions: {} }, roughjs: { __esModule: true, default: null } };
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  compiled._compile(bundled.outputFiles[0].text, filename);
  delete globalThis.document;
  return compiled.exports;
}

const PaperView = load().default;

const ROWS = [
  { kind: 'verb', verb: 'bart', key: 'verb:bart', name: 'Bart' },
  { kind: 'verb', verb: 'note', key: 'verb:note', name: 'Note' },
  { kind: 'item', key: 'r1', row: { id: 'r1', name: 'TutorTrace' }, name: 'TutorTrace' },
];

function field(value) {
  return {
    value, selectionStart: value.length, selectionEnd: value.length, style: {}, scrollHeight: 21, dataset: { mark: 'm1' }, isConnected: true, blurred: 0,
    getBoundingClientRect: () => ({ left: 10, top: 20, bottom: 41, right: 110 }),
    focus() { globalThis.document.activeElement = this; },
    blur() { this.blurred += 1; if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; },
  };
}

/** A viewer with one mark on page 2 whose note holds `typed`: a highlight unless `free`, its field focused. */
function viewer(typed, { free = false, asks, props = {} } = {}) {
  const asked = [], drawn = [];
  const all = { mentionItems: () => ROWS, onOpenMention: () => {}, onAsk: (ask) => asked.push(ask), ...props };
  for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key];
  const view = new PaperView(all);
  view.props = all;
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  const m = { id: 'm1', rects: free ? [] : [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: typed, text: 'Cohen\'s κ was 0.79 overall', pos: free ? { x: 0.1, y: 0.1 } : null, ...(asks ? { asks } : {}) };
  view.marks = { 2: [m] };
  const ta = field(typed);
  view.find1 = (sel) => (sel === 'textarea[data-mark="m1"]' ? ta : null);
  view.renderMarks = (page) => drawn.push(page);
  let saves = 0, flushed = 0;
  view.scheduleSave = () => { saves += 1; };
  view.flushSave = () => { flushed += 1; };
  // The page's text as pdf.js gives it: a question carries it, around the passage (2026-10-06).
  view.texts = { get: async () => ({ items: [{ str: 'Results.', hasEOL: true }, { str: 'Cohen\'s κ was 0.79 overall, which is good.' }] }) };
  globalThis.document = { activeElement: ta };
  globalThis.requestAnimationFrame = () => 0;
  return { view, m, ta, asked, drawn, saves: () => saves, flushed: () => flushed };
}
const settle = () => new Promise((resolve) => setImmediate(resolve)); // the page's text is read before the question goes
const key = (k, more = {}) => ({ key: k, shiftKey: false, isComposing: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...more });

test.afterEach(() => { delete globalThis.document; delete globalThis.requestAnimationFrame; });

test('the @ menu offers Bart at the start of a highlight\'s note, and library items as before', () => {
  const { view, m, ta } = viewer('@ba');
  view.noteMention(ta, m, 2);
  assert.deepEqual(view.mentionList().map((r) => r.key), ['verb:bart', 'r1'], 'Bart, and items; not Note');
  const later = viewer('see @ba');
  later.view.noteMention(later.ta, later.m, 2);
  assert.deepEqual(later.view.mentionList().map((r) => r.key), ['r1'], 'not in the middle of a note: it could not ask from there');
  const free = viewer('@ba', { free: true });
  free.view.noteMention(free.ta, free.m, 2);
  assert.deepEqual(free.view.mentionList().map((r) => r.key), ['r1'], 'a free note has no passage to ask about');
  const none = viewer('@ba', { props: { onAsk: undefined } });
  none.view.noteMention(none.ta, none.m, 2);
  assert.deepEqual(none.view.mentionList().map((r) => r.key), ['r1'], 'nor one with nowhere to send it');
});

test('Bart picked writes @Bart and a space, and the note is saved', () => {
  const { view, m, ta, saves } = viewer('@ba');
  view.noteMention(ta, m, 2);
  view.noteKey(key('Enter'), ta, m, 2);
  assert.equal(ta.value, '@Bart ');
  assert.equal(m.note, '@Bart ');
  assert.equal(saves(), 1);
});

test('Enter in a highlight\'s note that starts with @bart asks: the passage, the note, the question, the page around it, no turns yet; the note shows as text', async () => {
  const { view, m, ta, asked, flushed } = viewer('@bart why is κ = 0.79 good?');
  view.editing = 'm1';
  const enter = key('Enter');
  view.noteKey(enter, ta, m, 2);
  assert.ok(enter.prevented && enter.stopped);
  await settle();
  assert.deepEqual(asked, [{ markId: 'm1', page: 2, quote: 'Cohen\'s κ was 0.79 overall', note: '@bart why is κ = 0.79 good?', question: 'why is κ = 0.79 good?', turns: [], pageText: 'Results.\nCohen\'s κ was 0.79 overall, which is good.' }]);
  assert.equal(flushed(), 1, 'what the note says is saved first');
  assert.equal(ta.blurred, 1);
  assert.equal(view.editing, null);
  assert.equal(m.note, '@bart why is κ = 0.79 good?', 'the note keeps what was typed');
});

test('a second @bart on the same mark sends its answers as the turns; the page is found when the caller does not say', async () => {
  const asks = [{ id: 'a1', question: 'why?', answer: 'Because.', meta: {}, at: 'x', pos: null, collapsed: false }];
  const { view, m, ta, asked } = viewer('@Bart and then?', { asks });
  view.noteKey(key('Enter'), ta, m);
  await settle();
  assert.deepEqual(asked.map((a) => [a.question, a.page, a.turns]), [['and then?', 2, [{ question: 'why?', answer: 'Because.' }]]]);
});

test('a page whose text pdf.js cannot give still asks, with no page text', async () => {
  const { view, m, ta, asked } = viewer('@bart why?');
  view.texts = { get: () => Promise.reject(new Error('gone')) };
  view.noteKey(key('Enter'), ta, m, 2);
  await settle();
  assert.deepEqual(asked.map((a) => [a.question, a.pageText]), [['why?', '']]);
});

test('Shift+Enter is a new line; a note without @bart, a free note, an empty question or a key still being composed do not ask', async () => {
  const cases = [
    ['@bart why', key('Enter', { shiftKey: true }), {}],
    ['why @bart', key('Enter'), {}],
    ['@bart why', key('Enter'), { free: true }],
    ['@bart why', key('Enter', { isComposing: true }), {}],
  ];
  for (const [typed, ev, options] of cases) {
    const { view, m, ta, asked } = viewer(typed, options);
    view.noteKey(ev, ta, m, 2);
    assert.equal(ev.prevented, false, `${typed}: a line break, as before`);
    await settle();
    assert.deepEqual(asked, []);
  }
  const empty = viewer('@bart   ');
  const enter = key('Enter');
  empty.view.noteKey(enter, empty.ta, empty.m, 2);
  assert.ok(enter.prevented, 'nothing to ask: Enter adds no line either');
  assert.deepEqual(empty.asked, []);
});

test('addAsk: a finished answer joins its mark once, is drawn and saved; again it is neither (main tells every window); a mark that is gone takes nothing', () => {
  const { view, m, drawn, saves } = viewer('@bart why?');
  view.syncOffscreen = () => {};
  const entry = { id: 'a1', question: 'why?', answer: 'Because.', meta: { name: 'Sonnet', effort: 'high' }, at: 'now', pos: null, collapsed: false };
  assert.equal(view.addAsk(2, 'm1', entry), true);
  assert.equal(view.addAsk(2, 'm1', entry), true, 'here already');
  assert.deepEqual(m.asks, [entry]);
  assert.deepEqual(drawn, [2]);
  assert.equal(saves(), 1);
  assert.equal(view.addAsk(2, 'gone', entry), false);
  assert.equal(view.addAsk(5, 'm1', entry), false);
});

/* ------------------------------------------------------------------------------------------------ follow-ups (2026-10-06) */

const actClick = (what) => {
  const act = { dataset: { act: what }, textContent: '', isConnected: true };
  return { target: { closest: (sel) => (sel === '[data-act]' ? act : null) }, preventDefault() {} };
};

test('@bart on a part of a selection across pages sends the whole passage, page by page; so does Continue in workspace', async () => {
  const continued = [];
  const { view, m, ta, asked } = viewer('@bart what does this claim?', { props: { onContinueAsk: (x) => continued.push(x) } });
  m.group = 'g1';
  view.marks[3] = [{ id: 'm2', group: 'g1', rects: [{ x: 0.1, y: 0.05, w: 0.4, h: 0.015 }], side: 'right', y: 0.05, note: null, text: 'across 480 students' }];
  view.marks[1] = [{ id: 'm0', group: 'g2', rects: [{ x: 0.1, y: 0.05, w: 0.4, h: 0.015 }], y: 0.05, note: null, text: 'another selection' }];
  view.noteKey(key('Enter'), ta, m, 2);
  await settle();
  assert.equal(asked[0].quote, 'Cohen\'s κ was 0.79 overall\nacross 480 students');
  const a = { id: 'a1', question: 'what does this claim?', answer: 'That.', meta: { foot: 'Sonnet · high · 3 s' } };
  m.asks = [a];
  view.askClick(actClick('continue'), m, a, 2);
  assert.equal(continued[0].quote, 'Cohen\'s κ was 0.79 overall\nacross 480 students');
});

/** The paper's host, a note's field and a button on it, a button elsewhere (the Stage's), and the page itself. */
function keyboard(view, ta) {
  const body = { nodeName: 'BODY' };
  const inside = { closest: () => null }; // something of the paper's that is no control
  const button = { closest: (sel) => (sel.includes('button') ? button : null) };
  const outside = { closest: (sel) => (sel.includes('button') ? outside : null) };
  const editor = { closest: (sel) => (sel.includes('contenteditable') ? editor : null) };
  ta.closest = (sel) => (sel.includes('textarea') ? ta : null);
  const held = new Set([ta, inside, button]);
  view.host.current = { dataset: {}, contains: (t) => held.has(t) };
  view.root.current = { contains: (t) => held.has(t) };
  globalThis.document.body = body;
  return { body, inside, button, outside, editor };
}
const keyEv = (target, more = {}) => ({ target, key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...more });

test('Space over the paper pans only while nothing has the keyboard: a note\'s field, a button or the document keeps it', () => {
  const { view, ta } = viewer('a note');
  const { body, inside, button, outside, editor } = keyboard(view, ta);
  view.hovered = true;
  for (const [target, why] of [[ta, 'a note\'s field'], [button, 'a button on the paper'], [outside, 'a button elsewhere'], [editor, 'the document']]) {
    const ev = keyEv(target, { key: ' ', code: 'Space' });
    view.onKeyCapture(ev);
    assert.ok(!ev.prevented && !ev.stopped, `${why} gets its Space`);
    assert.equal(view.space, false);
  }
  for (const target of [body, inside]) {
    const ev = keyEv(target, { key: ' ', code: 'Space' });
    view.onKeyCapture(ev);
    assert.ok(ev.prevented && ev.stopped, 'nothing has the keyboard: the paper pans');
    assert.equal(view.space, true);
    view.holdSpace(false);
  }
  view.hovered = false;
  const away = keyEv(body, { key: ' ', code: 'Space' });
  view.onKeyCapture(away);
  assert.ok(!away.prevented, 'the pointer elsewhere: Space is the app\'s');
  // A pending selection's keys too: a focused button keeps Space and Enter.
  view.pendingSel = { parts: [] };
  view.addMark = () => { throw new Error('no note'); };
  for (const k of [' ', 'Enter']) {
    const ev = keyEv(button, { key: k, code: k === ' ' ? 'Space' : 'Enter' });
    view.onKeyCapture(ev);
    assert.ok(!ev.prevented && !ev.stopped, `${k === ' ' ? 'Space' : 'Enter'} on a button is the button's`);
  }
});

test('Delete hides an answer and ⌘Z brings it back; meanwhile the next question still sends it, so the session goes on', async () => {
  const now = new Date().toISOString();
  const asks = [
    { id: 'a1', question: 'why?', answer: 'Because.', meta: {}, at: now, pos: null, collapsed: false },
    { id: 'a2', question: 'and?', answer: 'Then.', meta: {}, at: now, pos: null, collapsed: false },
  ];
  const { view, m, ta, asked, drawn, saves } = viewer('@bart and after that?', { asks });
  const { body, inside, outside } = keyboard(view, ta);
  view.askClick(actClick('delete'), m, asks[0], 2);
  view.askClick(actClick('delete'), m, asks[1], 2);
  assert.deepEqual(m.asks.map((a) => [a.id, !!a.deleted]), [['a1', true], ['a2', true]], 'kept on the mark, not drawn');
  assert.deepEqual(drawn, [2, 2]);
  assert.equal(saves(), 2);
  view.noteKey(key('Enter'), ta, m, 2);
  await settle();
  assert.deepEqual(asked[0].turns, [{ question: 'why?', answer: 'Because.' }, { question: 'and?', answer: 'Then.' }], 'the turns the session heard: it is found again');
  const z = (target, more = {}) => keyEv(target, { key: 'z', metaKey: true, ...more });
  // Not the paper's: the last press was elsewhere, or a field has the keyboard, or it is ⌘⇧Z.
  view.onPointerDown({ target: outside });
  let ev = z(body);
  view.onKeyCapture(ev);
  assert.ok(!ev.prevented, 'the last press was not on the paper');
  view.onPointerDown({ target: inside });
  for (const e of [z(ta), z(outside), z(body, { shiftKey: true })]) { view.onKeyCapture(e); assert.ok(!e.prevented); }
  assert.ok(m.asks.every((a) => a.deleted));
  // The last deleted first.
  ev = z(body);
  view.onKeyCapture(ev);
  assert.ok(ev.prevented && ev.stopped);
  assert.deepEqual(m.asks.map((a) => [a.id, 'deleted' in a]), [['a1', true], ['a2', false]]);
  assert.deepEqual(drawn, [2, 2, 2]);
  assert.equal(saves(), 3);
  ev = z(inside, { metaKey: false, ctrlKey: true });
  view.onKeyCapture(ev);
  assert.ok(ev.prevented, 'Ctrl+Z as well');
  assert.ok(m.asks.every((a) => !('deleted' in a)));
  ev = z(body);
  view.onKeyCapture(ev);
  assert.ok(!ev.prevented && !ev.stopped, 'nothing left to bring back: the key is the app\'s');
  // One gone meanwhile is passed over.
  view.askClick(actClick('delete'), m, asks[0], 2);
  m.asks = [asks[1]];
  ev = z(body);
  view.onKeyCapture(ev);
  assert.ok(!ev.prevented);
});

/* ------------------------------------------------------------------------------------------------ second pass (2026-10-06) */

// A few lines of the DOM a box being written is made of (PaperView runBox): elements with their dataset, style (cssText
// read into its properties), children, text and attributes, and querySelector / closest by a data attribute. innerHTML
// is kept as given, and counted: a paragraph that reads the same is not given it again.
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.dataset = {}; this.children = []; this.parentNode = null; this.attrs = {};
    this.text = ''; this.html = ''; this.htmlSets = 0; this.title = ''; this.scrollTop = 0; this.clientHeight = 100; this.scrollHeight = 100;
    const style = {};
    Object.defineProperty(style, 'cssText', { get: () => '', set: (css) => { for (const decl of String(css).split(';')) { const at = decl.indexOf(':'); if (at > 0) style[decl.slice(0, at).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decl.slice(at + 1).trim(); } } });
    this.style = style;
  }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  append(...els) { for (const el of els) this.appendChild(el); }
  replaceChildren(...els) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...els); }
  remove() { if (!this.parentNode) return; const list = this.parentNode.children; list.splice(list.indexOf(this), 1); this.parentNode = null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text; }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get innerHTML() { return this.html; }
  set innerHTML(value) { this.replaceChildren(); this.html = String(value); this.htmlSets += 1; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  matches(sel) {
    const m = String(sel).match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return k in this.dataset && (m[2] == null || this.dataset[k] === m[2]);
  }
  querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const deep = c.querySelector(sel); if (deep) return deep; } return null; }
  closest(sel) { for (let el = this; el; el = el.parentNode) if (el.matches(sel)) return el; return null; }
  contains(el) { for (let at = el; at; at = at.parentNode) if (at === this) return true; return false; }
}
const click = (target) => ({ target, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });

test('a box being written is filled in place as Bart works: Stop and "▸ steps" stay the same buttons, so a click between two ticks still lands', () => {
  const stopped = [];
  const { view, drawn } = viewer('@bart why?', { props: { onStopAsk: (id) => stopped.push(id), onOpenLink: () => {} } });
  globalThis.document.createElement = (tag) => new El(tag);
  view.arrange = () => {};
  const p = { askId: 'h1', markId: 'm1', page: 2, question: 'why?' };
  view.props.pendingAsks = [p];
  const box = view.runBox(p, 2);
  view.find1 = (sel) => (sel === '[data-ask-run="h1"]' ? box : null);
  // What Bart is doing changes about every 100 ms, each a new list from the workspace (Workspace.jsx onBartProgress).
  const tick = (patch) => { const before = view.props.pendingAsks; view.props.pendingAsks = [{ ...before[0], ...patch }]; view.syncPending(before); };
  const label = () => box.querySelector('[data-run-label]').textContent;
  const stop = box.querySelector('[data-act="stop"]'), toggle = box.querySelector('[data-act="log"]');
  assert.equal(label(), 'Bart · Thinking');
  assert.equal(box.querySelector('[data-run-steps]').style.display, 'none', 'no steps yet');

  // Stop pressed, a tick, Stop let go: the click is on the button that was pressed, still in the box.
  tick({ step: 1, name: 'Sonnet', effort: 'high', activity: 'Reading', log: ['Read tutortrace.pdf'] });
  assert.equal(box.querySelector('[data-act="stop"]'), stop, 'the same Stop');
  assert.ok(box.contains(stop));
  assert.equal(label(), 'Bart · Reading');
  assert.equal(toggle.textContent, '▸ 1 step');
  assert.equal(box.querySelector('[data-run-steps]').style.display, '');
  box.onclick(click(stop));
  assert.deepEqual(stopped, ['h1']);

  // "▸ steps" pressed across a tick: the same button, and it opens them.
  tick({ activity: 'Searching', log: ['Read tutortrace.pdf', 'Searched OpenAlex'] });
  assert.equal(box.querySelector('[data-act="log"]'), toggle);
  assert.equal(toggle.textContent, '▸ 2 steps');
  box.onclick(click(toggle));
  assert.equal(toggle.textContent, '▾ 2 steps');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const list = box.querySelector('[data-run-log]');
  assert.deepEqual([list.style.display, list.children.map((row) => row.innerHTML)], ['', ['Read tutortrace.pdf', 'Searched OpenAlex']]);

  // The answer comes in: a paragraph that reads the same is left as it was, a changed one is given its text, a new one added.
  tick({ activity: 'Writing', lines: ['It is **good**.', 'Cohen'] });
  const body = box.querySelector('[data-run-body]'), first = body.children[0];
  assert.equal(body.style.display, '');
  assert.deepEqual(body.children.map((el) => el.innerHTML), ['It is <strong style="font-weight:600">good</strong>.', 'Cohen']);
  tick({ lines: ['It is **good**.', 'Cohen\'s κ is 0.79,', 'on 480 students.'] });
  assert.equal(body.children[0], first);
  assert.equal(first.htmlSets, 1, 'not given its text again');
  assert.deepEqual(body.children.map((el) => el.innerHTML), ['It is <strong style="font-weight:600">good</strong>.', 'Cohen\'s κ is 0.79,', 'on 480 students.']);
  assert.equal(box.querySelector('[data-act="stop"]'), stop, 'Stop all the while');
  assert.equal(label(), 'Bart · Writing');
  assert.deepEqual(drawn, [], 'the page was not drawn again for any of it');

  // A failure: × in Stop's place, why, and no answer.
  tick({ error: 'The CLI quit.' });
  assert.equal(box.querySelector('[data-act="stop"]'), null);
  assert.ok(box.querySelector('[data-act="dismiss"]'));
  assert.match(box.querySelector('[data-run-head]').textContent, /Bart · No answer/);
  assert.deepEqual([box.querySelector('[data-run-error]').style.display, box.querySelector('[data-run-error]').textContent], ['', 'The CLI quit.']);
  assert.equal(body.style.display, 'none');
});
