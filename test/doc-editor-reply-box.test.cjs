'use strict';

// The conversation's foot after Hudson's stress test (src/renderer/workspace/DocEditor.jsx, 2026-10-16). The reply field
// is always under a conversation's last turn: no Reply button to open it, and it does not shut when left empty. A Create
// run's Stop and Hide are plain text, as on every other running row. An agent's answer is read, selected and copied, never
// typed in, deleted from or pasted over; its question can still be edited, and the foot's Delete still takes the turn.
// There is no document here: the editor and its elements are stand-ins, as in doc-editor-titles.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-reply-box-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const MODELS = normalizeModels(null);
const answer = (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true });
const prose = (agent) => (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false, agent });

function mounted(lines, extra = {}) {
  const asks = [], stopped = [];
  const props = { docKey: 'k', models: MODELS, onAsk: (ask) => asks.push(ask), onStopAsk: (id) => stopped.push(id), ...extra, text: lines.join('\n'), onChange: (next) => { props.text = next; } };
  const editor = new DocEditor(props);
  // The page's rows, as editorInput reads them: `rows` holds what each drawn line's text is now (absent: the browser took it).
  const page = { rows: null };
  const root = {
    closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null,
    get childNodes() { return []; },
    querySelectorAll: (sel) => (sel === '[data-raw]' && page.rows ? [...page.rows.entries()].map(([i, text]) => ({ dataset: { line: String(i), raw: editor.lines()[i] }, querySelector: () => ({ src: text }) })) : []),
  };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  editor.activeRaw = (t) => t.src;
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null, execCommand() {} };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const click = (act, data = {}) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, ...data } } : null) }, preventDefault() {} });
  const caretAt = (line, offset = 0, focus = { line, offset }) => { editor.caretInfo = () => ({ anchor: { line, offset }, focus }); };
  // An edit the browser made: every row's text as it is now, `gone` the rows it removed, `changed` the rows it rewrote.
  const edit = ({ gone = [], changed = {}, caret, selected = null }) => {
    const ls = editor.lines();
    page.rows = new Map(ls.map((l, i) => [i, l.replace(/^bart> ?/, '')]).filter(([i]) => !gone.includes(i)));
    for (const [i, text] of Object.entries(changed)) page.rows.set(Number(i), text);
    editor.selRaw = selected ? { line: selected[0], a: 0, b: 0, multi: true, lines: selected } : null;
    editor.bulkDelete = !!selected;
    caretAt(caret, 0);
    editor.editorInput();
  };
  const paste = (text, files = []) => { const e = { prevented: false, preventDefault() { e.prevented = true; }, clipboardData: { files, getData: (type) => (type === 'text/plain' ? text : '') } }; editor.editorPaste(e); return e; };
  return { editor, props, asks, stopped, click, caretAt, edit, paste, lines: () => editor.lines(), html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

const fields = (html) => [...html.matchAll(/data-followup="(\d+)"/g)].map((m) => Number(m[1]));

/* ------------------------------------------------------------------------------------------ the reply box */

test('three answered turns: the reply box is under the third alone, nothing clicked, whether Chat, Brainstorm or Discover answered last; no Reply button anywhere', () => {
  for (const [agent, say] of [['chat', answer], ['brainstorm', prose('brainstorm')], ['discover', prose('discover')]]) {
    const lines = [`@${agent} one?`, ...say('1'), `@${agent} two?`, ...say('2'), `@${agent} three?`, ...say('3'), ''];
    const m = mounted(lines), html = m.html(), third = lines.indexOf(`@${agent} three?`);
    assert.deepEqual(fields(html), [0], `${agent}: one box, the conversation's`);
    assert.ok(html.indexOf('data-followup="0"') > html.indexOf(`data-foot="${third}"`), `${agent}: under the third turn's foot`);
    assert.ok(html.indexOf(`data-line="${third}"`) < html.indexOf('data-followup="0"') && !/data-followup="0"[\s\S]*data-line="\d+" data-raw="@/.test(html), `${agent}: no question after it`);
    assert.ok(!html.includes('data-act="reply"'), `${agent}: no Reply`);
    assert.match(html, /data-follow-input="0"[^>]*placeholder="Respond…"/, `${agent}: its placeholder`);
    assert.match(html, /data-act="sendfollow" data-thread="0"/, `${agent}: its send`);
  }
  // The model chip stays on Chat's.
  assert.match(mounted(['@chat one?', ...answer('1'), '']).html(), /data-act="pickfollow" data-thread="0"/);
});

test('no box under a last turn that is pending, running, folded, in a collapsed conversation, or in a document read only', () => {
  const none = (lines, why, extra) => assert.deepEqual(fields(mounted(lines, extra).html()), [], why);
  none(['@chat one?', ...answer('1'), '@chat two?', 'bart~> a2', ''], 'pending (an interrupted run)');
  none(['@chat one?', ...answer('1'), '@chat two?', 'bart~> a2', ''], 'running', { asks: { a2: { agent: 'bart', name: 'Sonnet', effort: 'high', activity: 'Thinking', at: Date.now(), lines: [], log: [] } } });
  none(['@chat one?', ...answer('1').map((l) => l.replace(/^bart>/, 'bart+>')), ''], 'its last exchange folded');
  none(['bart#+ Retry logic', '@chat one?', ...answer('1'), ''], 'collapsed');
  none(['@chat one?', ...answer('1'), ''], 'read only', { readOnly: true });
  assert.deepEqual(fields(mounted(['@chat one?', ...answer('1'), '']).html()), [0], 'answered, open, editable: the box');
});

test('typed in, then left empty (blurred, or Escape): the box stays; Escape only blurs', async () => {
  const m = mounted(['@chat one?', ...answer('1'), '']);
  m.editor.followText.set(0, 'and');
  m.editor.followText.set(0, '');
  m.editor.leftReply(0);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(fields(m.html()), [0], 'left empty: still there');
  let blurred = 0;
  const e = { key: 'Escape', prevented: false, preventDefault() { e.prevented = true; }, target: { dataset: { followInput: '0' }, blur() { blurred += 1; } } };
  m.editor.followKey(e);
  assert.equal(blurred, 1, 'Escape blurs');
  assert.deepEqual(fields(m.html()), [0], 'and the box stays');
});

/* ------------------------------------------------------------------------------------------ Stop */

test('a running Create row\'s Stop is plain text (bart-text), as Hide on an interrupted one; Save and Open in Stage stay buttons (made-btn)', () => {
  const m = mounted(['@create a diagram of retries', 'bart~> c1', ''], { asks: { c1: { agent: 'create', name: 'Opus', effort: 'high', activity: 'Writing retries.svg · 2 KB', making: 'A diagram of the retry loop.', at: Date.now(), lines: [], log: [] } } });
  const html = m.html();
  assert.ok(html.includes('data-create-pending'), 'the Create row');
  assert.match(html, /<button type="button" class="bart-text" data-act="stopask" data-ask="c1"[^>]*>Stop<\/button>/);
  assert.ok(!/class="made-btn" data-act="stopask"/.test(html));
  const gone = mounted(['@create a diagram of retries', 'bart~> c1', '']).html();
  assert.match(gone, /<button type="button" class="bart-text" data-act="dropline" data-row="1"[^>]*>Hide<\/button>/, 'interrupted: Hide, plain text');
  const made = { name: 'retries.svg', askId: 'c1', rel: 'retries.svg' };
  m.props.madeFiles = { 'c1/retries.svg': { type: 'svg', url: 'file:///x.svg' } };
  m.props.onSaveMade = () => {};
  m.editor.madeOpen.add('c1/retries.svg');
  const frame = m.editor.madeHtml(made);
  assert.match(frame, /class="made-btn" data-act="madesave"/, 'Save');
  assert.match(frame, /class="made-btn" data-act="madestage"/, 'Open in Stage');
});

/* ------------------------------------------------------------------------------------------ answers read only */

// One conversation of two turns, then a line of the document's own.
const DOC = ['Notes', '@chat first?', 'bart> one', 'bart> more of one', 'bart>', 'bart> *Sonnet · high · 3 s*', '@chat second?', ...answer('two'), 'After'];

test('an answer\'s lines are drawn not editable, still selectable; its question is drawn as before', () => {
  const m = mounted(DOC), html = m.html();
  for (const i of [2, 3]) assert.match(html, new RegExp(`<div data-line="${i}" data-raw="[^"]*"[^>]* contenteditable="false" data-readonly="1"[^>]*style="user-select:text;-webkit-user-select:text;`), `answer line ${i}`);
  assert.equal(m.editor.lockedAt(m.lines(), 2), true);
  assert.equal(m.editor.lockedAt(m.lines(), 0), false, 'a line of the document');
});

test('typing into an answer changes nothing', () => {
  const m = mounted(DOC);
  m.edit({ changed: { 2: 'one, rewritten' }, caret: 2 });
  assert.deepEqual(m.lines(), DOC);
});

test('deleting a selection that takes in answers keeps their text: across a turn, or inside one answer', () => {
  const m = mounted(DOC);
  // From the end of the first answer down into "After": the browser took the rows between.
  m.edit({ gone: [3, 4, 5, 6, 7, 8, 9], changed: { 2: 'o', 10: 'ter' }, caret: 2, selected: [2, 10] });
  assert.deepEqual(m.lines().slice(0, 10), DOC.slice(0, 10), 'every answer line and question as it was');
  // Two lines of one answer (once the person's to delete, 2026-09-21): kept.
  const one = mounted(DOC);
  one.edit({ gone: [3], changed: { 2: 'o' }, caret: 2, selected: [2, 3] });
  assert.deepEqual(one.lines(), DOC);
  // A whole conversation selected still goes with the selection (2026-10-15): that is not editing an answer.
  const whole = mounted(DOC);
  whole.edit({ gone: [1, 2, 3, 4, 5, 6, 7, 8, 9], changed: { 0: 'No', 10: 'ter' }, caret: 0, selected: [0, 10] });
  assert.ok(!whole.lines().some((l) => l.startsWith('bart>') || l.startsWith('@chat')), 'the whole conversation went');
});

test('a deletion across lines that starts or ends in an answer is not done on the document (deleteAcross)', () => {
  const m = mounted(DOC);
  m.editor.selEnds = () => ({ start: { line: 3, offset: 2 }, end: { line: 10, offset: 2 } });
  assert.equal(m.editor.deleteAcross(), false);
  assert.deepEqual(m.lines(), DOC);
});

test('pasting over an answer does nothing; pasting on a line of the document still pastes', () => {
  const m = mounted(DOC);
  m.caretAt(2, 1, { line: 2, offset: 3 });
  const e = m.paste('pasted');
  assert.equal(e.prevented, true);
  assert.deepEqual(m.lines(), DOC);
  m.caretAt(10, 5);
  m.paste('!');
  assert.equal(m.lines()[10], 'After!');
});

test('a picture pasted or dropped on an answer goes on a line of its own under the conversation, not into the answer', async () => {
  const m = mounted(DOC, { onPasteImage: async () => ({ id: 'p1' }) });
  await m.editor.pasteImages([{ type: 'image/png' }], { line: 2, offset: 1 });
  const ls = m.lines(), at = ls.indexOf('![Attachment 1](img:p1)');
  assert.deepEqual(ls.slice(0, 10), DOC.slice(0, 10), 'the answers as they were');
  assert.equal(at, 10, 'right after the conversation');
});

test('a question is still edited in place, its answer still not; the foot\'s Delete still takes the turn', () => {
  const m = mounted(DOC);
  m.click('editturn', { turn: '6' });
  assert.equal(m.editor.lockedAt(m.lines(), 6), false, 'the question opens');
  assert.equal(m.editor.lockedAt(m.lines(), 7), true, 'its answer does not');
  m.edit({ changed: { 6: '@chat second, reworded?' }, caret: 6 });
  assert.equal(m.lines()[6], '@chat second, reworded?');
  const d = mounted(DOC);
  d.click('dropturn', { turn: '1' });
  assert.deepEqual(d.lines(), ['Notes', '@chat second?', ...answer('two'), 'After']);
});
