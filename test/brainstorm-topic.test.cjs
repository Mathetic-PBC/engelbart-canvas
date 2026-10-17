'use strict';

// A Brainstorm conversation's topic (2026-10-14): the label on a chip beside its first question, kept as its title line.
// Unset after a bare @brainstorm; Brainstorm marks it when the person names one or changes to another (main's
// bart/ask.cjs takeTopic, test/bart.test.cjs), and the window writes it into the title line (Workspace askBart). The chip's
// menu renames it, or changes it and asks Brainstorm to go on from there (DocEditor renameTopic, changeTopic).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-topic-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const MODELS = normalizeModels(null);
const answer = (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true });

function mounted(lines, extra = {}) {
  const asks = [], changes = [];
  const props = { ...extra, docKey: 'k', text: lines.join('\n'), models: MODELS, onChange: (next) => { changes.push(next); props.text = next; }, onAsk: (ask) => asks.push(ask), onStopAsk: () => {} };
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
  // `on`: { alt } for an ⌥-click, { row } when what was clicked is inside a collapsed conversation's row.
  const click = (act, data = {}, disabled = false, on = {}) => editor.editorClick({ altKey: !!on.alt, target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, ...data }, disabled, closest: (s) => (s === '[data-thread-row]' && on.row ? {} : null) } : null) }, preventDefault() {} });
  return { editor, props, asks, changes, click, lines: () => editor.lines(), html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

/** The rendered row of line `i`: its opening tag, and what it holds up to the next line's row. */
function rowOf(html, i) {
  const at = html.indexOf(`data-line="${i}"`); assert.ok(at >= 0, `line ${i} is drawn`);
  const start = html.lastIndexOf('<', at), next = html.indexOf(`data-line="${i + 1}"`);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf('<', next));
}

const BS = (title) => `bart# [brainstorm 2026-10-14T20:13:23Z] ${title}`.trimEnd();
const said = (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false, agent: 'brainstorm' });
const CONVERSATION = (title) => [BS(title), '@brainstorm', ...said('Looks like you\'ve been working on Bart\'s voice.\n\nWhat did you want to talk through?'), '@brainstorm I want to talk about Bart\'s voice', ...said('What about its voice are you still figuring out?'), ''];

test('topic chip: not drawn since 2026-10-16 (David: "just remove this"), with a topic or without; the topic stays the conversation\'s title', () => {
  const ed = mounted(CONVERSATION('Bart\'s voice'));
  const html = ed.html();
  assert.equal(html.includes('data-topic-chip='), false, 'no chip');
  assert.ok(!/>Topic:</.test(html), 'no "Topic: …" line');
  const first = rowOf(html, 1);
  assert.match(first, /class="t"[^>]*><span style="color:#0070f3;font-weight:500">@bart<\/span>/, 'a sent @brainstorm line says @bart (2026-10-16)');
  assert.equal(ed.lines()[0], BS('Bart\'s voice'), 'the title line as it was');
  assert.equal(mounted(CONVERSATION('')).html().includes('data-topic-chip='), false);
});

test('topic chip: a click opens the menu (Rename topic, Change topic) and a second click closes it; Escape closes it', () => {
  const ed = mounted(CONVERSATION('Bart\'s voice'));
  ed.click('topic', { row: '0' });
  assert.deepEqual(ed.editor.state.topicMenu && ed.editor.state.topicMenu.line, 0);
  assert.match(rowOf(ed.html(), 1), /aria-expanded="true"/);
  const view = ed.editor.topicView();
  assert.equal(view.props.topic, 'Bart\'s voice');
  assert.equal(view.props.canChange, true);
  ed.click('topic', { row: '0' });
  assert.equal(ed.editor.state.topicMenu, null, 'toggled shut');
  ed.click('topic', { row: '0' });
  let prevented = false;
  assert.equal(ed.editor.escapeShut({ key: 'Escape', preventDefault: () => { prevented = true; } }), true);
  assert.ok(prevented && ed.editor.state.topicMenu === null);
});

test('Rename topic writes the title line alone: no question is asked', () => {
  const ed = mounted(CONVERSATION('Bart\'s voice'));
  ed.editor.renameTopic(0, 'Bart\'s personality');
  assert.equal(ed.lines()[0], BS('Bart\'s personality'), 'the title, its agent and time kept');
  assert.equal(ed.asks.length, 0);
});

test('Change topic renames, then asks Brainstorm to go on from the new topic as a follow-up of the same conversation, its turns kept', () => {
  const ed = mounted(CONVERSATION('Bart\'s voice'));
  ed.editor.changeTopic(0, 'Onboarding flow');
  const ls = ed.lines();
  assert.equal(ls[0], BS('Onboarding flow'));
  assert.equal(ed.asks.length, 1);
  const ask = ed.asks[0];
  assert.equal(ask.agent, 'brainstorm', 'asked of Brainstorm, never routed');
  assert.equal(ask.text, 'New topic: Onboarding flow');
  assert.equal(ask.turns.length, 2, 'the earlier discussion goes with it');
  const q = ls.indexOf('@brainstorm New topic: Onboarding flow');
  assert.ok(q > 1 && ls[q + 1] === `bart~> ${ask.askId}`, 'the document says where the topic changed');
  const after = mounted(ls).html();
  assert.equal(after.includes('data-topic-chip='), false, 'no chip, folded or not (2026-10-16)');
});

test('Change topic waits for an answer: the menu offers it only once Brainstorm has answered', () => {
  const ed = mounted([BS('Bart\'s voice'), '@brainstorm', ...said('Hi.'), '@brainstorm more', 'bart~> running', '']);
  ed.click('topic', { row: '0' });
  assert.equal(ed.editor.topicView().props.canChange, false);
});

test('a reply streaming in hides Brainstorm\'s topic tag, whole or half-arrived', () => {
  const ed = mounted([BS(''), '@brainstorm Bart\'s voice', 'bart~> s1', ''], { asks: { s1: { agent: 'brainstorm', lines: ['What about its voice', 'are you figuring out?', '', '<topic>Bart\'s vo'] } } });
  const row = rowOf(ed.html(), 2);
  assert.ok(row.includes('are you figuring out?') && !row.includes('&lt;topic') && !row.includes('<topic'), 'the tag is not drawn');
  const half = mounted([BS(''), '@brainstorm x', 'bart~> s2', ''], { asks: { s2: { agent: 'brainstorm', lines: ['Hi.', '<to'] } } });
  assert.ok(!rowOf(half.html(), 2).includes('&lt;to'));
  const chat = mounted(['@chat x', 'bart~> s3', ''], { asks: { s3: { agent: 'bart', lines: ['<topic>is Chat\'s to say</topic>'] } } });
  assert.ok(rowOf(chat.html(), 1).includes('&lt;topic&gt;'), 'only Brainstorm\'s');
});

test('doc.js: retitle changes the title of the conversation that holds a question, nowhere else; topicOfThread is a Brainstorm conversation\'s title once set', async () => {
  const { retitle, threads, topicOfThread, askedAt } = await doc();
  const text = [...CONVERSATION('Bart\'s voice').slice(0, -1), '@brainstorm its personality', 'bart~> a1', '', 'bart# [brainstorm 2026-10-14T21:00:00Z] Other', '@brainstorm other', ...said('Hm.'), ''].join('\n');
  const near = askedAt(text, 'a1');
  const placed = text.replace('bart~> a1', 'bart> Imagine you ask Bart to build something.');
  const next = retitle(placed, near, 'Bart\'s personality').split('\n');
  assert.equal(next[0], BS('Bart\'s personality'));
  assert.ok(next.includes('bart# [brainstorm 2026-10-14T21:00:00Z] Other'), 'the other conversation keeps its title');
  assert.equal(retitle(placed, near, 'Bart\'s voice'), null, 'the same title: nothing to change');
  assert.equal(retitle(placed, near, '  '), null);
  assert.equal(retitle('@brainstorm x\nbart> y', { question: '@brainstorm x', index: 0 }, 'T'), null, 'no title line: nothing to change');
  const folded = retitle(placed.replace('bart# [brainstorm', 'bart#+ [brainstorm'), near, 'P').split('\n')[0];
  assert.equal(folded, 'bart#+ [brainstorm 2026-10-14T20:13:23Z] P', 'collapsed stays collapsed');
  const all = threads(next);
  assert.equal(topicOfThread(all[0]), 'Bart\'s personality');
  assert.equal(topicOfThread(threads(CONVERSATION(''))[0]), '');
  assert.equal(topicOfThread(threads(CONVERSATION('New conversation'))[0]), '');
  assert.equal(topicOfThread(threads(['bart# [chat 2026-10-14T20:13:23Z] Why', '@chat why?', 'bart> b'])[0]), '');
  // `unset` (2026-10-14, a Discover conversation named from its direction): only a title not yet given is filled.
  const D = (title) => [`bart# [discover 2026-10-14T20:13:23Z] ${title}`, '@discover', 'bart> What would you like to research?', 'bart> *Discover · 2 s*', '@discover tutors', 'bart> I will look.', ''].join('\n');
  const at = { question: '@discover tutors', index: 4 };
  for (const empty of ['', 'New conversation']) assert.equal(retitle(D(empty), at, 'Tutors noticing struggle', { unset: true }).split('\n')[0], 'bart# [discover 2026-10-14T20:13:23Z] Tutors noticing struggle', JSON.stringify(empty));
  assert.equal(retitle(D('Mine'), at, 'Tutors noticing struggle', { unset: true }), null, 'a title already there stays');
  assert.equal(retitle(D('Mine'), at, 'Tutors noticing struggle').split('\n')[0], 'bart# [discover 2026-10-14T20:13:23Z] Tutors noticing struggle', 'without it, as before');
});

test('Workspace askBart: a Brainstorm conversation names its own topic: not named at once or from a bare line\'s answer; retitled from the reply\'s topic once the answer is in, else named from a first line\'s words', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.ok(src.includes("const ownTopic = agent === 'brainstorm' && !build;"));
  assert.ok(src.includes('if (name && !later && !ownTopic) nameAs(text);'), 'not named at once');
  assert.ok(src.includes("if (later && !ownTopic && !ownDirection) nameAs(out.stopped ? '' : answerText(out.lines));"), 'a bare line\'s answer names nothing');
  assert.ok(src.includes('if (ownTopic && !out.stopped && !out.failed) { if (out.topic) retitleTo(out.topic); else if (name && !later) nameAs(text); }'));
  assert.ok(src.includes('if (typeof held === \'string\' && !held.includes(`bart~> ${askId}`)) { const next = retitle(held, answered, title);'), 'once the answer is in the document');
});
