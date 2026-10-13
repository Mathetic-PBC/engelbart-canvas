'use strict';

// The answer so far on a pending row (src/renderer/workspace/DocEditor.jsx, 2026-10-13). It sits in a box of its own,
// as tall as min(240px, 35vh) at most, with the log and the activity row (label, steps, Stop) under it: a long answer
// scrolls inside the box, which keeps to its newest line unless the person scrolled up in it, and the line being typed
// below the card stays where it is on screen while the card changes above it and when the answer lands.
// There is no browser here: the editor's element, its rows and the pane are stand-ins with a small layout of their own
// (a line 30px tall, a pending row its padding, its box and a 20px activity row; a box as tall as its lines up to the cap
// its HTML declares), as in doc-editor-research.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-stream-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const EDITOR = load('DocEditor.jsx');
const DocEditor = EDITOR.default;
const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const MODELS = normalizeModels(null);
const VH = 800, LINE = 30, ACTIVITY = 20, PAD = 14, STREAM_LINE = 22;

// The cap a box's style declares, in px for a window VH tall.
function capOf(style) {
  const m = String(style).match(/max-height:min\((\d+)px, (\d+)vh\)/);
  return m ? Math.min(Number(m[1]), (Number(m[2]) * VH) / 100) : Infinity;
}

/* The stand-in page. `ed.rows` are the editor's rows in order, each made from its HTML; the pane scrolls them. */
function page() {
  const pane = { scrollTop: 0, closest: () => null, getBoundingClientRect: () => ({ top: 0, height: VH }) };
  const ed = {
    rows: [],
    set innerHTML(html) { this.rows = split(html).map((h) => row(h, this)); },
    querySelectorAll(sel) {
      if (sel === '[data-pending]') return this.rows.filter((r) => r.dataset.pending != null);
      if (sel === '[data-stream]') return this.rows.flatMap((r) => (r.box ? [r.box] : []));
      if (sel === '[data-line]') return [...this.rows];
      return [];
    },
    querySelector(sel) { const m = String(sel).match(/^\[data-line="(\d+)"\]$/); return m ? this.rows.find((r) => r.dataset.line === m[1]) || null : null; },
    contains(x) { return x === this || this.rows.includes(x) || this.rows.some((r) => r.box === x); },
    closest: (sel) => (sel === '[data-editor]' ? ed : null),
    matches: () => false,
    focus() { globalThis.document.activeElement = ed; },
    blur() {},
    offsetOf(r) { let y = 0; for (const x of this.rows) { if (x === r) return y; y += x.height; } return y; },
  };
  return { pane, ed };
}
// The editor's HTML, one piece per line's row (what is drawn between two rows goes with the one above).
function split(html) {
  const at = []; const re = /<div data-line="/g; let m;
  while ((m = re.exec(html))) at.push(m.index);
  return at.map((start, k) => html.slice(start, at[k + 1]));
}
function row(html, ed) {
  const r = {
    nodeType: 1, html, box: null,
    dataset: { line: html.match(/^<div data-line="(\d+)"/)[1] },
    get outerHTML() { return this.html; },
    get isConnected() { return ed.rows.includes(this); },
    get height() { return this.dataset.pending != null ? PAD + (this.box ? this.box.clientHeight : 0) + ACTIVITY : LINE; },
    closest(sel) { return sel === '[data-line]' ? this : null; },
    querySelectorAll(sel) { return sel === '[data-stream]' && this.box ? [this.box] : []; },
    getBoundingClientRect() { return { top: ed.offsetOf(this) - ed.pane.scrollTop, height: this.height }; },
    compareDocumentPosition(other) { return ed.rows.indexOf(other) > ed.rows.indexOf(this) ? 4 : 2; },
    replaceWith(next) { ed.rows[ed.rows.indexOf(this)] = next; },
  };
  const pending = html.match(/^<div [^>]*data-pending="([^"]*)"/);
  if (pending) r.dataset.pending = pending[1];
  const open = html.match(/<div data-stream="([^"]*)" style="([^"]*)">/);
  if (open) {
    // What the box holds: up to its closing tag, which is the first one after it (an answer so far has no divs of its own).
    const inside = html.slice(open.index + open[0].length), end = inside.indexOf('</div>');
    const lines = (inside.slice(0, end).match(/display:block;min-height/g) || []).length, cap = capOf(open[2]);
    let top = 0;
    r.box = {
      dataset: { stream: open[1] }, style: open[2], lines, after: inside.slice(end + '</div>'.length),
      scrollHeight: lines * STREAM_LINE, clientHeight: Math.min(lines * STREAM_LINE, cap),
      get scrollTop() { return top; },
      set scrollTop(v) { top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, v)); },
      get isConnected() { return r.isConnected; },
    };
  }
  return r;
}

function mounted(lines, asks = {}) {
  const { pane, ed } = page(); ed.pane = pane;
  const props = { docKey: 'k', text: lines.join('\n'), models: MODELS, asks, onChange: (next) => { props.text = next; }, onAsk: () => {}, onStopAsk: () => {} };
  const editor = new DocEditor(props);
  editor.props = props;
  editor.edRef = { current: ed };
  editor.scrollRef = { current: pane };
  let again = null; // a setState inside an update: React renders again before the page is painted
  editor.setState = (patch) => { const before = { ...editor.state }; Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch); again = before; };
  editor.forceUpdate = () => {};
  editor.maybeRestoreView = () => {};
  const carets = [];
  editor.applyCaret = function () { carets.push(this.caret); this.caret = null; };
  let caretRow = null;
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: caretRow ? 1 : 0, focusNode: caretRow, anchorNode: caretRow });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null, createElement: () => ({ set innerHTML(h) { this.firstElementChild = row(h, ed); } }) };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const update = (change) => {
    const prev = { ...props };
    change(props);
    editor.componentDidUpdate(prev, { ...editor.state });
    while (again) { const before = again; again = null; editor.componentDidUpdate({ ...props }, before); }
  };
  // The caret on line `i`, the editor focused; null: nothing focused.
  const caretOn = (i) => {
    if (i == null) { caretRow = null; globalThis.document.activeElement = null; return; }
    caretRow = ed.querySelector(`[data-line="${i}"]`); globalThis.document.activeElement = ed;
    editor.caretInfo = () => ({ anchor: { line: Number(caretRow.dataset.line), offset: 0 }, focus: { line: Number(caretRow.dataset.line), offset: 0 } });
  };
  return { editor, props, ed, pane, update, caretOn, carets, rowAt: (i) => ed.querySelector(`[data-line="${i}"]`), pending: (id) => ed.rows.find((r) => r.dataset.pending === id) };
}

const said = (n, from = 1) => Array.from({ length: n }, (_, k) => `Line ${k + from} of the answer.`);
const chat = (lines, extra = {}) => ({ agent: 'bart', name: 'Opus', effort: 'high', activity: 'Writing', lines, ...extra });
const DOC = ['Intro', '@bart why do tutors notice struggle?', 'bart~> a1', 'typing here', ''];

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a pending row with 40 lines so far keeps them in a capped box, the log and activity row under it, scrolled to its newest line', () => {
  const m = mounted(DOC, { a1: chat(said(2), { log: ['Read the workspace', 'Searched the web'] }) });
  m.editor.openLogs.add('a1');
  m.update((p) => { p.asks = { a1: chat(said(40), { log: ['Read the workspace', 'Searched the web'] }) }; });
  const r = m.pending('a1'), box = r.box;
  assert.ok(box, 'the answer so far has its box');
  assert.equal(EDITOR.STREAM_CAP, 'min(240px, 35vh)');
  assert.match(box.style, /^max-height:min\(240px, 35vh\);overflow-y:auto$/, 'capped, scrolling, and nothing else about its look');
  assert.equal(box.lines, 40, 'every line so far is inside the box');
  // The log and the activity row (label, steps, Stop) come after the box, outside it.
  assert.match(box.after, /^<div style="margin:0 0 8px 16px[^"]*"><div[^>]*>Read the workspace<\/div>/);
  assert.match(box.after, /data-act="asklog"/); assert.match(box.after, /data-act="stopask"/);
  assert.ok(r.height <= PAD + 240 + ACTIVITY, `no taller than the cap and its activity row (${r.height}px)`);
  assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight, 'on its newest line');
  // Its look is the answer so far's as before: the same grey lines and the cursor at the end, inside the box.
  assert.match(r.html, /<div data-stream="a1" style="[^"]*"><span style="display:block;min-height:22px;padding:1px 0 1px 14px;[^"]*color:#8f8f8f;font-size:14px/);
  assert.match(r.html.slice(0, r.html.indexOf(box.after)), /animation:thinking 1\.2s ease-in-out infinite/);
});

test('scrolled up more than 40px, the box keeps where it was on the next update; back at the bottom it follows again', () => {
  const m = mounted(DOC, { a1: chat(said(30)) });
  let box = m.pending('a1').box;
  assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
  // 30px up: still following.
  box.scrollTop -= 30; m.editor.streamScrolled({ target: box });
  m.update((p) => { p.asks = { a1: chat(said(31)) }; });
  box = m.pending('a1').box;
  assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight, 'within 40px of the bottom it still follows');
  // 100px up: it stays there through updates.
  box.scrollTop = 120; m.editor.streamScrolled({ target: box });
  m.update((p) => { p.asks = { a1: chat(said(34)) }; });
  box = m.pending('a1').box;
  assert.equal(box.scrollTop, 120, 'the person\'s scrollTop is put back');
  m.editor.streamScrolled({ target: box }); // the replaced box says where it is: still up there
  m.update((p) => { p.asks = { a1: chat(said(36)) }; });
  box = m.pending('a1').box;
  assert.equal(box.scrollTop, 120);
  // An event from a box already replaced says nothing.
  const gone = box; m.update((p) => { p.asks = { a1: chat(said(37)) }; }); m.editor.streamScrolled({ target: gone });
  assert.equal(m.pending('a1').box.scrollTop, 120);
  // Back to the bottom: following again.
  box = m.pending('a1').box; box.scrollTop = box.scrollHeight; m.editor.streamScrolled({ target: box });
  m.update((p) => { p.asks = { a1: chat(said(40)) }; });
  box = m.pending('a1').box;
  assert.equal(box.scrollTop, box.scrollHeight - box.clientHeight);
  // The flag goes with the ask.
  box.scrollTop = 0; m.editor.streamScrolled({ target: box });
  assert.equal(m.editor.streamFollow.get('a1'), false);
  m.update((p) => { p.asks = {}; });
  assert.equal(m.editor.streamFollow.has('a1'), false, 'cleared when the ask ends');
});

test('a full redraw puts each box back where it was: on its newest line, or where the person left it', () => {
  const m = mounted(DOC, { a1: chat(said(30)) });
  let box = m.pending('a1').box; box.scrollTop = 50; m.editor.streamScrolled({ target: box });
  m.update((p) => { p.text = DOC.map((l) => (l === 'Intro' ? 'Intro, edited' : l)).join('\n'); });
  box = m.pending('a1').box;
  assert.equal(box.scrollTop, 50);
});

test('with the caret on a line under a pending row, an update that adds lines leaves that line where it was', () => {
  const m = mounted(DOC, { a1: chat(said(2)) });
  m.caretOn(3);
  const line = m.rowAt(3), before = line.getBoundingClientRect().top;
  m.update((p) => { p.asks = { a1: chat(said(8)) }; });
  assert.equal(m.rowAt(3), line, 'only the pending row was replaced');
  assert.equal(line.getBoundingClientRect().top, before);
  assert.equal(m.pane.scrollTop, 6 * STREAM_LINE, 'the pane scrolled by what the card grew');
  // Past the cap the card does not grow: nothing to correct.
  m.update((p) => { p.asks = { a1: chat(said(40)) }; });
  const at = m.pane.scrollTop;
  m.update((p) => { p.asks = { a1: chat(said(60)) }; });
  assert.equal(m.pane.scrollTop, at);
  assert.equal(line.getBoundingClientRect().top, before);
});

test('with the caret above the pending row, or nothing focused, or the mouse held down, the pane does not scroll on an update', () => {
  const m = mounted(DOC, { a1: chat(said(2)) });
  m.caretOn(0);
  m.update((p) => { p.asks = { a1: chat(said(8)) }; });
  assert.equal(m.pane.scrollTop, 0, 'caret above');
  m.caretOn(null);
  m.update((p) => { p.asks = { a1: chat(said(9)) }; });
  assert.equal(m.pane.scrollTop, 0, 'not focused');
  m.caretOn(3); m.editor.pressed = true;
  m.update((p) => { p.asks = { a1: chat(said(10)) }; });
  assert.equal(m.pane.scrollTop, 0, 'a selection or drag in progress');
});

test('when the answer lands with the caret below it, the caret stays on its line and the line where it was', async () => {
  const { placeAnswer } = await doc();
  // Twenty lines above, the pane scrolled down to the card: the answer, shorter than the card, may pull the pane up.
  const above = Array.from({ length: 20 }, (_, k) => `Note ${k + 1}`), top = ['Intro', ...above], at0 = top.length + 2;
  const m = mounted([...top, '@bart why do tutors notice struggle?', 'bart~> a1', 'typing here', ''], { a1: chat(said(40)) });
  m.pane.scrollTop = 400;
  m.caretOn(at0); m.editor.state.activeLine = at0;
  m.update((p) => { p.asks = { a1: chat(said(41)) }; });
  const before = m.rowAt(at0).getBoundingClientRect().top, scrolled = m.pane.scrollTop, card = m.pending('a1').height;
  const lines = replyLines(said(12), { level: { name: 'Opus', effort: 'high' }, trail: [], ms: 3000 }, { model: true });
  m.update((p) => { p.asks = {}; p.text = placeAnswer(p.text, 'a1', lines); });
  const at = at0 + lines.length - 1, text = m.props.text.split('\n');
  assert.equal(text[at], 'typing here');
  assert.deepEqual(m.carets.at(-1), { line: at, offset: 0 }, 'the caret is put back on its own line, not the one now in its old place');
  assert.equal(m.editor.state.activeLine, at, 'which is still the open line');
  assert.equal(m.rowAt(at).getBoundingClientRect().top, before, 'and where it was on screen');
  assert.equal(m.pane.scrollTop, scrolled + lines.length * LINE - card, 'the pane scrolled by what the answer is taller than the card');
});

test('an answer landing with the caret above it moves nothing', async () => {
  const { placeAnswer } = await doc();
  const m = mounted(DOC, { a1: chat(said(40)) });
  m.caretOn(0); m.editor.state.activeLine = 0;
  const lines = replyLines(said(12), { level: { name: 'Opus', effort: 'high' }, trail: [], ms: 3000 }, { model: true });
  m.update((p) => { p.asks = {}; p.text = placeAnswer(p.text, 'a1', lines); });
  assert.equal(m.pane.scrollTop, 0);
  assert.deepEqual(m.carets.at(-1), { line: 0, offset: 0 });
  assert.equal(m.editor.state.activeLine, 0);
});

test('a Brainstorm pending row has no stream box; nor does Discover output that starts as JSON, nor a row with nothing yet', () => {
  const brainstorm = mounted(['Plan', '@brainstorm a plan', 'bart~> b1', ''], { b1: { agent: 'brainstorm', activity: 'Reading', lines: ['{"type":"mcq",', '"question": "Which?"}'] } });
  assert.equal(brainstorm.pending('b1').box, null);
  assert.doesNotMatch(brainstorm.pending('b1').html, /data-stream/);
  const discover = mounted(['Plan', '@discover tutors', 'bart~> d1', ''], { d1: { agent: 'discover', activity: 'Searching', lines: ['{"type":"free"', '}'] } });
  assert.doesNotMatch(discover.pending('d1').html, /data-stream/);
  const thinking = mounted(DOC, { a1: chat([]) });
  assert.doesNotMatch(thinking.pending('a1').html, /data-stream/);
  // A guide arriving from @discover does get its box.
  const guide = mounted(['Plan', '@discover tutors', 'bart~> d2', ''], { d2: { agent: 'discover', activity: 'Writing', lines: ['## Read first', 'A paper.'] } });
  assert.equal(guide.pending('d2').box.dataset.stream, 'd2');
});

test('a box held by its scrollbar is not replaced under the pointer; it is once the button comes up', () => {
  const m = mounted(DOC, { a1: chat(said(30)) });
  const held = m.pending('a1');
  m.editor.pressedStream = 'a1';
  m.update((p) => { p.asks = { a1: chat(said(31)) }; });
  assert.equal(m.pending('a1'), held);
  m.editor.pressedStream = null; m.editor.patchPending();
  assert.notEqual(m.pending('a1'), held);
  assert.equal(m.pending('a1').box.lines, 31);
});

/* A follow-up sent from a card's reply field (sendFollow, 2026-10-13) folds the turns above it in the same edit: its
   question's row is put where the field's top was (holdFollow), so the view does not jump by the folded answer's height.
   Here the pane and the field are stand-ins with fixed boxes: the pane's top at 0, 800px tall, scrolled to 1000. */
const ANSWER = (n) => Array.from({ length: n }, (_, k) => `Line ${k + 1} of the answer so far.`);
const META = { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 };

function sending({ text, route = false }) {
  const asked = [], routed = [];
  const props = { docKey: 'k', text, onChange: (next) => { props.text = next; }, onAsk: (ask) => asked.push(ask), ...(route ? { onRoute: (r) => { routed.push(r); return new Promise(() => {}); } } : {}) };
  const editor = new DocEditor(props);
  const root = {
    rows: new Map(), field: null,
    closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false,
    querySelector: (sel) => { const m = sel.match(/^\[data-line="(\d+)"\]$/); if (m) return root.rows.get(Number(m[1])) || null; return sel.startsWith('[data-follow-input') ? root.field : null; },
    querySelectorAll: () => [],
  };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { scrollTop: 1000, closest: () => null, getBoundingClientRect: () => ({ top: 0, height: 800 }) } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  // A row whose top moves with the pane's scroll: `at` its top with the pane at 1000.
  const rowAt = (line, at) => { const r = { isConnected: true, base: at, dataset: { line: String(line) }, getBoundingClientRect: () => ({ top: r.base - (editor.scrollRef.current.scrollTop - 1000), height: 30 }) }; root.rows.set(line, r); return r; };
  return { editor, root, props, asked, routed, rowAt };
}
function conversation(agent = 'bart', token = '@chat') {
  const turn = (q, n) => [q, ...replyLines(ANSWER(n).join('\n'), META, { agent, model: agent !== 'brainstorm' })];
  return ['Intro', ...turn(`${token} first question`, 6), ...turn(`${token} second question`, 30), ''];
}

for (const c of [
  { label: 'typed and routed through Bart', agent: 'bart', token: '@chat', route: true, typed: 'and then?', want: '@bart and then?' },
  { label: 'typed and sent straight', agent: 'bart', token: '@chat', route: false, typed: 'and then?', want: '@chat and then?' },
  { label: 'sent empty from a Brainstorm recap\'s field', agent: 'brainstorm', token: '@brainstorm', route: true, typed: '', want: '@brainstorm' },
]) {
  test(`a follow-up ${c.label} puts its question where the reply field was, the earlier turns folded`, () => {
    const ls = conversation(c.agent, c.token);
    const m = sending({ text: ls.join('\n'), route: c.route });
    m.root.field = { getBoundingClientRect: () => ({ top: 540, height: 40 }) };
    if (c.typed) m.editor.followText.set(1, c.typed);
    m.editor.sendFollow(1);
    const now = m.props.text.split('\n'), q = now.indexOf(c.want);
    assert.equal(q, ls.length - 1, 'the question goes under the card');
    assert.ok(now.slice(0, q).some((l) => /^bart\+>/.test(l)) && !now.slice(0, q).some((l) => /^bart>/.test(l)), 'every answer above it is folded');
    assert.deepEqual({ line: m.editor.followHold.line, text: m.editor.followHold.text, top: m.editor.followHold.top }, { line: q, text: c.want, top: 540 });
    // Drawn again: the turns above folded, the question's row came up 900px. The pane follows it, once.
    const r = m.rowAt(q, 540 - 900);
    m.editor.holdFollow(m.root, m.editor.key());
    assert.equal(r.getBoundingClientRect().top, 540, 'the question\'s row is where the field\'s top was');
    assert.equal(m.editor.followHold, null);
    if (c.route) assert.equal(m.routed.length, c.typed ? 1 : 0); else assert.equal(m.asked.length, 1);
  });
}

test('a follow-up sent with its field off screen, or drawn before its question is, leaves the pane alone', () => {
  const m = sending({ text: conversation().join('\n') });
  m.root.field = { getBoundingClientRect: () => ({ top: 900, height: 40 }) }; // below the pane
  m.editor.followText.set(1, 'later');
  m.editor.sendFollow(1);
  assert.equal(m.editor.followHold, null);
  m.editor.followHold = { key: m.editor.key(), line: 5, text: '@chat q', top: 100, until: Date.now() + 2000 };
  m.editor.holdFollow(m.root, m.editor.key());
  assert.ok(m.editor.followHold, 'a draw without its question waits');
  m.editor.holdFollow(m.root, 'another document');
  assert.equal(m.editor.followHold, null, 'dropped with the document');
  assert.equal(m.editor.scrollRef.current.scrollTop, 1000);
});

test('the line being typed on is not kept in place while the person scrolls the pane, nor when it is out of view', () => {
  const m = mounted(DOC, { a1: chat(said(2)) });
  m.caretOn(3);
  const rows = [m.pending('a1')];
  assert.ok(m.editor.caretLineBelow(m.ed, rows), 'kept, as a rule');
  m.editor.paneWheel(); assert.equal(m.editor.caretLineBelow(m.ed, rows), null, 'not just after a wheel scroll'); m.editor.wheelAt = 0;
  m.pane.scrollTop = 5000; assert.equal(m.editor.caretLineBelow(m.ed, rows), null, 'not with the line out of view');
});
