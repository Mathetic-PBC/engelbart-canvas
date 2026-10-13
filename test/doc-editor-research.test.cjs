'use strict';

// @discover's research box (src/renderer/workspace/DocEditor.jsx, 2026-10-13). An @discover question with a problem on it
// is answered twice: Chat replies under it at once (main's bart/ask.cjs DISCOVER_INTRO, its closing line naming Discover),
// and Discover searches in a box of its own under that reply, a turn of the same conversation whose line is
// `@discover --research <problem>` (src/renderer/model/doc.js isResearch). A Deep search waits five seconds first, with
// Cancel; a reply Bart sends to Discover again refines the search, stopping one still running. There is no document here:
// the editor and its elements are stand-ins, as in doc-editor-titles.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const ask = require('../src/main/bart/ask.cjs');
const { replyBody } = ask;

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-research-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const MODELS = normalizeModels(null);
const answer = (text, agent = 'discover') => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true, agent });

function mounted(lines, extra = {}) {
  const asks = [], stopped = [], ticks = [];
  const props = { docKey: 'k', text: lines.join('\n'), models: MODELS, onChange: (next) => { props.text = next; }, onAsk: (ask) => asks.push(ask), onStopAsk: (id) => stopped.push(id), ...extra };
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
  // The countdown's timers, run by hand.
  editor.timer = (fn) => { ticks.push(fn); return ticks.length; };
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const click = (act, data = {}) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, ...data }, disabled: false } : null) }, preventDefault() {} });
  const tick = () => { const fn = ticks.shift(); if (fn) fn(); };
  return { editor, props, asks, stopped, click, tick, lines: () => editor.lines(), html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

function rowOf(html, i) {
  const at = html.indexOf(`data-line="${i}"`); assert.ok(at >= 0, `line ${i} is drawn`);
  const start = html.lastIndexOf('<', at), next = html.indexOf(`data-line="${i + 1}"`);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf('<', next));
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('an @discover question is Chat\'s reply under it and a research box under that, both asked at once, one conversation', async () => {
  const { threads } = await doc();
  const m = mounted(['Notes', '@discover how do tutors notice struggle?', '', 'After']);
  m.editor.askInline(1);
  const ls = m.lines();
  assert.match(ls[1], /^bart# \[discover [\dTZ:-]+\] $/, 'its title line, the conversation Discover\'s');
  assert.equal(ls[2], '@discover how do tutors notice struggle?');
  assert.match(ls[3], /^bart~> /);
  assert.equal(ls[4], '@discover --research how do tutors notice struggle?');
  assert.match(ls[5], /^bart~> /);
  assert.deepEqual(ls.slice(6), ['', 'After']);
  assert.equal(m.asks.length, 2);
  const [intro, search] = m.asks;
  assert.deepEqual([intro.agent, intro.intro, intro.name, intro.text, intro.askId], ['bart', 'discover', true, 'how do tutors notice struggle?', ls[3].slice(7)]);
  assert.deepEqual([search.agent, search.research, search.name, search.text, search.askId, search.place], ['discover', true, undefined, 'how do tutors notice struggle?', ls[5].slice(7), { line: 4, text: ls[4] }]);
  const [thread] = threads(ls);
  assert.deepEqual(thread.turns.map((t) => t.q), [2, 4], 'one conversation: the reply, then the box, while both run');
});

test('no box for an @discover line with nothing but flags, an answer to its card, or a box\'s own line', () => {
  const flags = mounted(['@discover --deep', '']);
  flags.editor.askInline(0);
  assert.deepEqual([flags.asks.length, flags.asks[0].agent, flags.asks[0].intro], [1, 'discover', undefined]);
  assert.ok(!flags.lines().some((l) => l.includes('--research')));
  const CARD = JSON.stringify({ say: '', card: 'focus', focus: { title: 'Which part?', options: [{ label: 'Tutors' }, { label: 'Tests' }] }, ready: false });
  const body = replyLines(replyBody('discover', CARD), { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 1000 }, { model: false, agent: 'discover' });
  const carded = mounted(['@discover', ...body, '@discover picked "Tutors"']);
  carded.editor.askInline(carded.lines().length - 1);
  assert.deepEqual([carded.asks.length, carded.asks[0].agent], [1, 'discover'], 'an answer to its card is asked as before');
  assert.equal(carded.editor.splitsDiscover({ type: 'bart', agent: 'discover', text: '--research tutors' }, []), false, 'a box\'s own line is the search');
});

test('drawn: the reply\'s card closes, and the box is a card of its own: "Research · Standard" on top, its own Collapse at the foot', () => {
  const lines = ['bart# [discover 2026-10-13T10:00:00Z] Tutors', '@discover how do tutors notice struggle?', ...answer('Looking for work on noticing struggle.'),
    '@discover --research how do tutors notice struggle?', 'bart> ## Start here', ...answer('A guide.').slice(0, 1).map(() => 'bart> **A paper**'), 'bart>', 'bart> *Discover · Opus · high · 2 s*', ''];
  const m = mounted(lines);
  const html = m.html(), box = lines.indexOf('@discover --research how do tutors notice struggle?');
  const replyFoot = html.slice(html.indexOf('data-foot="1"'));
  assert.match(replyFoot.slice(0, replyFoot.indexOf('>')), /border-radius:0 0 10px 10px;margin-bottom:8px/, 'the reply\'s card ends above the box');
  const head = rowOf(html, box);
  assert.match(head, /^<div[^>]*data-research="\d+"[^>]*border-radius:10px 10px 0 0/, 'the box starts rounded');
  assert.match(head, /contenteditable="false"/, 'its line is never edited in place');
  assert.match(head, />Research<\/span><span[^>]*> · <\/span><span[^>]*>Standard<\/span><\/div>$/);
  assert.ok(!head.replace(/ data-raw="[^"]*"/, '').includes('how do tutors'), 'the first box does not repeat the question above it');
  const foot = html.slice(html.indexOf(`data-foot="${box}"`));
  assert.match(foot.slice(0, foot.indexOf('</div>')), /data-act="fold" data-turn="\d+" aria-label="Collapse"/, 'the box collapses alone');
  assert.match(replyFoot.slice(0, replyFoot.indexOf('</div>')), /data-act="foldthread"/, 'the reply\'s foot still collapses the conversation');
  // Collapsed, the box keeps its head and foot, on no grey.
  m.click('fold', { turn: String(box) });
  assert.match(rowOf(m.html(), box), /background:none/);
  assert.ok(!m.html().replace(/ data-raw="[^"]*"/g, '').includes('A paper'));
});

test('a Deep search waits five seconds, "Searching in 5 s" with Cancel; Cancel takes the box out and nothing is searched', () => {
  const m = mounted(['@discover --deep tutors noticing struggle', '']);
  m.editor.askInline(0);
  assert.equal(m.asks.length, 1, 'the reply is asked at once, the search waits');
  const pending = m.lines()[4].slice(7);
  assert.match(rowOf(m.html(), 4), /Searching in 5 s[\s\S]*data-act="cancelwait"/);
  m.tick(); m.tick();
  assert.match(rowOf(m.html(), 4), /Searching in 3 s/);
  m.click('cancelwait', { ask: pending });
  assert.ok(!m.lines().some((l) => l.includes('--research') || l.includes(pending)), 'the box is gone');
  assert.equal(m.asks.length, 1);
  // Left alone, it is asked when the count runs out.
  const w = mounted(['@discover --deep tutors noticing struggle', '']);
  w.editor.askInline(0);
  for (let k = 0; k < 5; k++) w.tick();
  assert.deepEqual([w.asks.length, w.asks[1].agent, w.asks[1].research], [2, 'discover', true]);
});

test('a reply Bart sends to Discover refines the search: one still running stops, its box saying so; the new box says what it was asked', async () => {
  const head = 'bart# [discover 2026-10-13T10:00:00Z] Tutors';
  const lines = [head, '@discover tutors noticing struggle', ...answer('Looking.'), '@discover --research tutors noticing struggle', 'bart~> run-1', ''];
  const m = mounted(lines, { onRoute: async () => ({ id: 'r', agent: 'discover', sure: 0.9, by: 'model' }) });
  m.editor.followText = new Map([[1, 'only K-12']]);
  // The box is still running, so its conversation has no follow-up field yet: a reply typed under it asks the same way.
  const at = m.lines().length - 1;
  m.props.text = [...m.lines().slice(0, at), '@bart only K-12'].join('\n');
  m.editor.askInline(at);
  await settled();
  const ls = m.lines();
  assert.deepEqual(m.stopped, ['run-1']);
  assert.equal(ls[ls.indexOf('@discover --research tutors noticing struggle') + 1], 'bart> Stopped: refined below.');
  assert.equal(ls[at], '@bart only K-12');
  assert.equal(ls[at + 2], '@discover --research only K-12');
  assert.deepEqual(m.asks.map((a) => [a.agent, !!a.intro, !!a.research]), [['bart', true, false], ['discover', false, true]]);
  const { threads } = await doc();
  assert.equal(threads(ls).length, 1, 'still one conversation');
  assert.match(rowOf(m.html(), at + 2), />Research<\/span>[\s\S]*>Standard<\/span>[\s\S]*>only K-12<\/span>/, 'the refining box says what it was asked');
});

test('main: Chat\'s reply is told Discover searches under it and asked without the flags; --research is never part of a question', () => {
  const context = { head: '<engelbart>', contextJson: '', mentionedFiles: '', documents: '', now: '' };
  const intro = ask.firstMessage({ context, prior: [], question: 'tutors', resumed: false, intro: 'discover' })({ toString: () => '' });
  assert.ok(intro.includes(ask.DISCOVER_INTRO) && intro.indexOf(ask.DISCOVER_INTRO) < intro.indexOf('<question>'));
  assert.ok(!ask.firstMessage({ context, prior: [], question: 'tutors', resumed: false })('').includes('discover_intro'));
  assert.equal(ask.withoutResearch('--research --deep tutors'), '--deep tutors');
  const plan = ask.turnPlan({ agent: 'discover', text: '--research --deep tutors', turns: [{ question: '--research tutors', answer: 'A guide.' }] }, MODELS);
  assert.deepEqual([plan.question, plan.mode, plan.prior[0].question], ['tutors', 'deep', 'tutors']);
});

