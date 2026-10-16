'use strict';

// An @bart exchange's turns read as units (2026-10-15, David; src/renderer/workspace/DocEditor.jsx layout `ruled` and
// `earlier`, TURN_RULE, chatFootHtml): a 1px hairline over every follow-up question but the first, 16px under the answer
// above and 14px over the question, drawn by the editor and never written into the document; an answer a follow-up came
// under keeps its icons in a row that takes no room, shown while its turn is pointed at. A single turn is as before.
// There is no document here: the editor and its elements are stand-ins, as in doc-editor-titles.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-turns-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const MODELS = normalizeModels(null);
const answer = (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true });

function mounted(lines) {
  const props = { docKey: 'k', text: lines.join('\n'), models: MODELS, onChange: (next) => { props.text = next; }, onAsk: () => {}, onStopAsk: () => {} };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  return { editor, props, html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

/** The rendered row of line `i`: its opening tag, and what it holds up to the next line's row. */
function rowOf(html, i) {
  const at = html.indexOf(`data-line="${i}"`); assert.ok(at >= 0, `line ${i} is drawn`);
  const start = html.lastIndexOf('<', at), next = html.indexOf(`data-line="${i + 1}"`);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf('<', next));
}

const QUESTIONS = ['@bart why does the sync retry three times?', '@bart what happens between attempts?', '@bart could the wait be shorter?', '@bart so should I change it?'];
const FOUR = ['bart# [chat 2026-10-15T10:00:00Z] Retry logic', ...QUESTIONS.flatMap((q, n) => [q, ...answer(`answer ${n + 1}`)]), '', 'End'];
const qLines = (ls) => QUESTIONS.map((q) => ls.indexOf(q));

test('four turns: a hairline over turns 2–4, 16px under the answer above and 14px over the question, none over the first', () => {
  const m = mounted(FOUR), html = m.html(), [q1, ...rest] = qLines(FOUR);
  assert.ok(!rowOf(html, q1).includes('data-turn-rule'), 'none over the first question');
  assert.match(rowOf(html, q1), /class="chat-q"[^>]*padding:14px 18px/, 'the first question as before');
  for (const q of rest) {
    const row = rowOf(html, q);
    assert.match(row, /class="chat-q"[^>]*padding:31px 18px/, `turn at ${q}: 16 + 1 + 14 over its text`);
    assert.match(row, /<span contenteditable="false" aria-hidden="true" data-turn-rule="1" style="position:absolute;left:18px;right:18px;top:16px;height:1px;background:#e9e9e9;pointer-events:none"><\/span>/, `turn at ${q}: the hairline, the card's content wide`);
  }
  assert.equal((html.match(/data-turn-rule/g) || []).length, 3);
});

test('the hairline is drawn, never written: the document and what is saved are the lines as they were', () => {
  const m = mounted(FOUR);
  m.html();
  assert.deepEqual(m.editor.lines(), FOUR);
  assert.equal(m.props.text, FOUR.join('\n'));
  for (const q of qLines(FOUR)) assert.ok(!/data-turn-rule/.test(m.editor.lines()[q]));
});

test('an earlier answer\'s icons take no room and are hidden until its turn is pointed at; the last answer\'s are as before', () => {
  const m = mounted(FOUR), html = m.html(), feet = FOUR.map((l, j) => (/^bart> \*/.test(l) ? j : -1)).filter((j) => j >= 0);
  for (const j of feet.slice(0, -1)) {
    const row = rowOf(html, j);
    assert.match(row, /data-turn-tools="\d+"[^>]*position:relative;height:0/, `foot ${j}: no room`);
    assert.match(row, /data-act="copybart"/);
    assert.match(row, /data-act="dropturn"/);
  }
  const last = rowOf(html, feet[feet.length - 1]);
  assert.ok(!last.includes('data-turn-tools'), 'the last answer shows its icons');
  assert.match(last, /padding:8px 12.5px/);
  // Pointed at: one rule shows that turn's icons, and leaving takes it away.
  const head = { appendChild(el) { this.el = el; } };
  globalThis.document = { ...globalThis.document, head, createElement: () => ({ textContent: '', remove() {} }) };
  const q2 = qLines(FOUR)[0];
  m.editor.turnHover(String(q2));
  assert.equal(head.el.textContent, `[data-turn-tools][data-turn-tools="${q2}"]>div{visibility:visible}`);
  m.editor.turnHover(null);
  assert.equal(head.el.textContent, '');
});

test('a single-turn exchange has no hairline and keeps its icons and reply as before', () => {
  const lines = ['@bart what does backoff mean?', ...answer('Waiting longer after each failed attempt.'), '', 'End'];
  const html = mounted(lines).html();
  assert.ok(!html.includes('data-turn-rule'));
  assert.ok(!html.includes('data-turn-tools'));
  assert.match(rowOf(html, 0), /class="chat-q"[^>]*padding:14px 18px/);
});
