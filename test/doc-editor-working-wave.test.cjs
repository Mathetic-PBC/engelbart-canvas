'use strict';

// While an agent works, what it is doing is said by its text alone (src/renderer/workspace/DocEditor.jsx, 2026-10-16,
// David): no blinking blue dot beside it, the text itself carrying the moving gradient the title bar's import status uses
// (styles.css .eb-wave). A pending ask (Chat, Brainstorm, Discover, a Deep search's countdown, Create before it says what
// it makes), a Create row, and a Build's live row and run step all wave while they work; what is finished, failed or
// stopped is plain text. There is no document here: the editor is a stand-in, as in doc-editor-research.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-wave-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const MODELS = normalizeModels(null);
const answer = (text, agent = 'bart') => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true, agent });

function mounted(lines, asks = {}) {
  const props = { docKey: 'k', text: lines.join('\n'), models: MODELS, asks, onChange: (next) => { props.text = next; }, onAsk: () => {}, onStopAsk: () => {} };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.patchPending = () => true;
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  return { editor, html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}
test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

// The pending row with this id, from its opening tag to the next line's.
function pendingRow(html, id) {
  const at = html.indexOf(`data-pending="${id}"`); assert.ok(at >= 0, `${id} is drawn`);
  const start = html.lastIndexOf('<', at), next = html.indexOf('data-line="', at);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf('<', next));
}
const noDot = (html, what) => {
  assert.ok(!html.includes('#0070f3;animation'), `${what}: no blue dot`);
  assert.ok(!html.includes('animation:thinking'), `${what}: no blinking`);
};
// The span with class eb-wave, and what it says.
const waved = (html) => [...html.matchAll(/<span class="([^"]*\beb-wave\b[^"]*)"[^>]*>([^<]*)</g)].map((m) => m[2]);

const CHAT = ['@bart why do tutors notice struggle?', 'bart~> a1', ''];

test('a pending ask, whatever agent is at work, says what it is doing as a wave and has no blue dot', () => {
  for (const [agent, ask, said] of [
    ['bart', { activity: 'Thinking' }, 'Thinking · Opus high'],
    ['chat', { activity: 'Searched the web' }, 'Searched the web · Opus high'],
    ['brainstorm', { activity: 'Thinking' }, 'Thinking · Opus high'],
    ['discover', { activity: 'Searching OpenAlex' }, 'Searching OpenAlex · Opus high'],
    ['create', { activity: 'Thinking' }, 'Thinking · Opus high'], // before Create says what it makes, a run like any other
  ]) {
    const row = pendingRow(mounted(CHAT, { a1: { agent, name: 'Opus', effort: 'high', ...ask } }).html(), 'a1');
    noDot(row, agent);
    assert.deepEqual(waved(row), [said], `${agent}: its text waves`);
    assert.match(row, /<span class="t" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="eb-wave" style="display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top">/, `${agent}: its row's font, size and ellipsis kept; the wave as wide as its words`);
    assert.match(row, /<div style="display:flex;align-items:center;gap:10px"><span class="t"/, `${agent}: the text first in its row, where the dot was`);
  }
});

test('a Deep search counting down waves too', () => {
  const m = mounted(CHAT);
  m.editor.waits.set('a1', { left: 5 });
  const row = pendingRow(m.html(), 'a1');
  noDot(row, 'waiting');
  assert.deepEqual(waved(row), ['Searching in 5 s']);
});

test('a running Discover research box: its running row waves, no dot', () => {
  const lines = ['@discover --research how tutors notice struggle', 'bart~> run1', ''];
  const row = pendingRow(mounted(lines, { run1: { agent: 'discover', activity: 'Searching OpenAlex' } }).html(), 'run1');
  noDot(row, 'research');
  assert.equal(waved(row).length, 1);
  assert.match(waved(row)[0], /^Searching OpenAlex/);
});

test('a running Create row: what it is doing waves beside its spinner; no blue dot', () => {
  const lines = ['@bart --create a diagram of this conversation', 'bart~> c1', ''];
  const row = pendingRow(mounted(lines, { c1: { agent: 'create', name: 'Opus', effort: 'high', making: 'a diagram of this conversation', activity: 'Thinking', at: Date.now() } }).html(), 'c1');
  assert.match(row, /data-create-pending="1"/);
  noDot(row, 'create');
  assert.match(row, /animation:made-spin/, 'the spinner stays');
  assert.equal(waved(row).length, 1, 'its doing text waves');
});

test('a finished answer, a failed run and an interrupted one have no wave', () => {
  const finished = mounted(['@bart why?', ...answer('Because they watch.'), '']).html();
  assert.ok(!finished.includes('eb-wave'), 'finished');
  const failed = mounted(['@bart why?', ...replyLines(['**No answer.** The connection to the model dropped.'], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true, agent: 'bart' }), '']).html();
  assert.ok(!failed.includes('eb-wave'), 'failed');
  const interrupted = pendingRow(mounted(CHAT).html(), 'a1');
  assert.match(interrupted, /No answer came back: the run was interrupted\./);
  assert.ok(!interrupted.includes('eb-wave'), 'interrupted');
  const created = mounted(['@bart --create a diagram', 'bart~> c1', '']).html();
  assert.ok(!created.includes('eb-wave'), 'a Create run the app closed on');
});

/** A Build card's parts, as build-card.test draws them. */
function card(task) {
  const editor = Object.create(DocEditor.prototype);
  Object.assign(editor, { props: {}, buildOpen: new Set(), buildSteps: new Set(), buildPrompt: new Set() });
  return Object.fromEntries(editor.buildParts('b1', { id: 'b1', title: 'Add a page', messages: [], modelName: 'Opus', effort: 'high', ...task }));
}

test('a Build at work: its live row and its run step wave, no blue dot; stopped or done, plain', () => {
  const running = card({ status: 'running' });
  noDot(running.live, 'live');
  assert.match(running.live, /<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="eb-wave" [^>]*>Thinking<\/span><\/span>/);
  const stepping = card({ status: 'review', runStep: { status: 'running', phase: 'Starting web', runnables: [] } });
  noDot(stepping.run, 'run step');
  assert.match(stepping.run, /<span class="eb-wave" style="flex:none;font-weight:500;color:#171717">Getting it running…<\/span>/);
  for (const status of ['done', 'failed', 'stopped']) {
    const after = card({ status: 'review', runStep: { status, runnables: [] } });
    assert.ok(!Object.values(after).join('').includes('eb-wave'), status);
  }
  assert.ok(!Object.values(card({ status: 'failed' })).join('').includes('eb-wave'), 'a failed Build');
});

test('a row drawn again keeps its wave going: every wave is put on the page\'s clock, its HTML untouched', () => {
  const { keepWaves } = load('DocEditor.jsx');
  const anims = [{ startTime: 4180 }, { startTime: 0 }];
  const el = { getAnimations: () => anims, outerHTML: '<span class="eb-wave">Thinking</span>' };
  const root = { querySelectorAll: (sel) => (sel === '.eb-wave' ? [el, { getAnimations: () => [] }, {}] : []) };
  keepWaves(root);
  assert.deepEqual(anims.map((a) => a.startTime), [0, 0], 'both on the page\'s clock');
  assert.equal(el.outerHTML, '<span class="eb-wave">Thinking</span>');
  keepWaves(null); keepWaves({}); // nothing drawn: nothing to do
});
