'use strict';

// A Build's card at the end of a conversation is drawn inside the conversation's card, as its last part (MATH-161,
// 2026-10-27): the card of an "@bart yes" sent to Build, of the Build button under an answer (MATH-160), and of an
// `@bart --build` line. One card, its question rows without a model picker or send, the Build's Reply its one reply
// field; collapsed with the conversation. A Build anywhere else keeps its own card.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { normalizeModels } = require('../src/main/bart/models.cjs');

const loadDoc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-build-joined-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const DocEditor = loadEditor().default;

function mounted(lines, { builds = {} } = {}) {
  const props = {
    docKey: 'k', text: lines.join('\n'), models: normalizeModels(null), builds,
    onChange: (next) => { props.text = next; },
    onAsk: () => {}, onRoute: () => null, onRouteGone: () => {}, onBuild: () => undefined,
  };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [] };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  return { editor, props, root, lines: () => props.text.split('\n'), html: () => editor.editorHtml() };
}
test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

const ID = '0123456789';
const running = () => ({ [ID]: { id: ID, title: 'Add Haiku', status: 'running', messages: [], modelName: 'Opus', effort: 'high' } });
const finished = () => ({ [ID]: { id: ID, title: 'Add Haiku', status: 'accepted', final: true, messages: [], modelName: 'Opus', effort: 'high' } });
const TITLE = 'bart# [chat 2026-10-27T09:00:00Z] Haiku';
const FOLDED = 'bart#+ [chat 2026-10-27T09:00:00Z] Haiku';
const ANSWER = ['@bart add Haiku 5.5 to the models', 'bart> Here is the Build prompt:', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', 'bart> Want me to build it?', 'bart> *Chat · Sonnet · high · 3 s*'];
// (a) "@bart yes" under the offer, its pending line replaced by the Build's card; (b) the Build button's card, right under
// the conversation; (c) an `@bart --build` line's.
const YES = [TITLE, ...ANSWER, '@bart yes', `build> ${ID}`, ''];
const BUTTON = [TITLE, ...ANSWER, `build> ${ID}`, ''];
const DIRECT = [TITLE, '@bart --build add Haiku 5.5 to the models', `build> ${ID}`, ''];

// The opening tag of the row drawn for line `i`.
const rowTag = (html, i) => { const at = html.indexOf(`<div data-line="${i}" `); assert.ok(at >= 0, `row ${i}`); return html.slice(at, html.indexOf('>', at) + 1); };
const count = (html, re) => (html.match(re) || []).length;

// One card from line `from` to the Build's line `to`: only `from`'s row opens it and only the Build's row closes it.
function oneCard(html, from, to) {
  const body = html.slice(html.indexOf(`<div data-line="${from}" `), html.indexOf(`<div data-line="${to}" `));
  assert.ok(!/margin-bottom:8px/.test(body), 'nothing above the Build closes the card');
  assert.ok(!/border-radius:(?:0 0|10px 10px) 10px 10px/.test(body), 'no row above the Build rounds the card\'s end');
  assert.match(rowTag(html, from), /border-radius:10px 10px 0 0/, 'the card opens at its first question');
  const build = rowTag(html, to);
  assert.match(build, new RegExp(`data-build="${ID}"`));
  assert.match(build, /data-build-joined=/);
  assert.match(html.slice(html.indexOf(build) + build.length), /^<div data-build-rule="1" style="border-top:1px solid #eaeaea;padding-top:10px"><div data-build-part="head">/, 'a hairline parts the question from the Build');
  assert.match(build, /background:#fafafa;border-radius:0 0 10px 10px;margin-bottom:8px/, 'the Build\'s row closes the conversation\'s card');
  assert.ok(!/margin:6px 0 14px|border-radius:10px;/.test(build), 'no card of its own: no own margin or corners');
  assert.match(build, /padding:6px 16px 14px/, '16px in, as the rows above it');
}
// Exactly one reply field, the Build's; no follow-up field.
function oneReply(html) {
  assert.equal(count(html, /data-build-input=/g), 1, 'the Build\'s Reply');
  assert.equal(count(html, /data-follow-input/g), 0, 'no conversation reply field');
  assert.equal(count(html, new RegExp(`data-build="${ID}"`, 'g')), 1, 'the Build drawn once');
}
const noChip = (tag, html, i) => {
  const row = html.slice(html.indexOf(`<div data-line="${i}" `), html.indexOf(`<div data-line="${i + 1}" `));
  assert.ok(!/data-act="ask"|data-act="pick"|data-chip=/.test(row), `${tag}: no model picker or send on the Build's question`);
};

test('the model: a Build right under the last answer is the conversation\'s joined end; `to` and the turns stay as they were', async () => {
  const { threads } = await loadDoc();
  const [b] = threads(BUTTON);
  assert.deepEqual([b.from, b.to, b.turns.length, b.joined], [1, 7, 1, { line: 8, id: ID }]);
  const [a] = threads(YES);
  assert.deepEqual([a.to, a.turns.length, a.turns[1].build, a.joined], [9, 2, ID, undefined], '"@bart yes": its turn\'s answer, as before');
  const [c] = threads(DIRECT);
  assert.deepEqual([c.to, c.turns[0].build, c.joined], [2, ID, undefined]);
  assert.equal(threads([...ANSWER, '', `build> ${ID}`])[0].joined, undefined, 'a blank line between: not at its end');
  assert.equal(threads(['@bart why?', 'bart~> a1', `build> ${ID}`])[0].joined, undefined, 'not under an answer still coming');
  const after = threads([...BUTTON.slice(0, -1), '@bart and Opus?', 'bart> Sure.', '']);
  assert.deepEqual(after.map((t) => [t.from, t.to, t.joined ? t.joined.line : -1]), [[1, 7, 8], [9, 10, -1]], 'a question under the Build starts a conversation of its own');
});

test('(a) a Chat answer, "@bart yes" and its Build: one card, the yes drawn as an answered question with no picker or send', () => {
  const m = mounted(YES, { builds: running() });
  const html = m.html();
  oneCard(html, 1, 9);
  oneReply(html);
  noChip('yes', html, 8);
  const yes = rowTag(html, 8);
  assert.match(yes, /padding:14px 16px 0px;background:#fafafa;border-radius:0 0 0 0;margin-bottom:0/, 'an answered question\'s row, the card going on under it');
  assert.ok(!/data-message-box/.test(yes), 'not a message box');
  assert.ok(html.includes('data-build-part="head"') && html.includes('data-build-part="reply"') && html.includes('data-build-part="actions"'), 'the Build\'s parts');
});

test('(b) the Build button\'s card, right under the conversation: in its card, no question row for it, one reply field', () => {
  const m = mounted(BUTTON, { builds: running() });
  const html = m.html();
  oneCard(html, 1, 8);
  oneReply(html);
  assert.ok(!/data-foot="1"[^>]*margin-bottom:8px/.test(html), 'the answer\'s foot does not close the card');
  // Nothing drawn between the foot's row and the Build's: no empty question row.
  const between = html.slice(html.indexOf('<div data-line="7" '), html.indexOf('<div data-line="8" '));
  assert.equal(count(between, /<div data-line=/g), 1, 'the foot\'s row alone');
  assert.ok(!/data-message-box|data-act="ask"/.test(between));
  assert.equal(count(html, /data-build-offer=/g), 0, 'no Build button once its card is there');
});

test('under a collapsed turn the joined Build has no hairline: the collapsed row is apart enough', () => {
  const folded = BUTTON.map((l) => (l.startsWith('bart> ') ? l.replace('bart> ', 'bart+> ') : l));
  const html = mounted(folded, { builds: running() }).html();
  const build = rowTag(html, 8);
  assert.match(build, /data-build-joined=/);
  assert.match(build, /padding:10px 16px 14px/);
  assert.match(html.slice(html.indexOf(build) + build.length), /^<div><div data-build-part="head">/, 'no hairline');
  assert.equal(count(html, /data-build-rule=/g), 0);
});

test('(c) an `@bart --build` conversation: its question and its Build in one card, the question without a picker or send', () => {
  const m = mounted(DIRECT, { builds: running() });
  const html = m.html();
  assert.match(rowTag(html, 1), /border-radius:10px 10px 0 0;margin-bottom:0/);
  assert.match(rowTag(html, 2), /data-build-joined=.*border-radius:0 0 10px 10px;margin-bottom:8px/);
  noChip('--build', html, 1);
  oneReply(html);
});

test('collapsing the conversation hides its Build with it, and expanding shows both again, in all three', () => {
  for (const [name, lines, q, build] of [['yes', YES, 1, 9], ['button', BUTTON, 1, 8], ['--build', DIRECT, 1, 2]]) {
    const m = mounted(lines, { builds: finished() });
    m.editor.collapseTurn(q);
    assert.equal(m.lines()[0], FOLDED, `${name}: collapsed to its title`);
    let html = m.html();
    assert.match(rowTag(html, build), /style="display:none"/, `${name}: the Build is hidden`);
    assert.equal(count(html, /data-build=/g), 0, `${name}: not drawn`);
    assert.ok(m.editor.collapsedOf(m.lines()).has(build), `${name}: one of the lines it hides`);
    m.editor.toggleThread(0);
    html = m.html();
    assert.equal(m.lines()[0], TITLE, `${name}: expanded`);
    assert.match(rowTag(html, build), /data-build-joined=/, `${name}: the Build is back, in the card`);
    assert.match(rowTag(html, q), /border-radius:10px 10px 0 0/);
  }
  // A Build still at work keeps its conversation open, as one that answers a turn always has.
  const m = mounted(BUTTON, { builds: running() });
  m.editor.toggleThread(0);
  assert.equal(m.lines()[0], TITLE, 'not collapsed while its Build runs');
  assert.match(rowTag(m.html(), 8), /data-build-joined=/);
});

test('a Build anywhere else keeps its own card: a task\'s, a post-it\'s, one with a line between it and the conversation, one under a research box', () => {
  const own = (lines, i, why) => { const tag = rowTag(mounted(lines, { builds: running() }).html(), i); assert.match(tag, /margin:6px 0 14px;padding:12px 16px 14px;background:#fafafa;border-radius:10px/, why); assert.ok(!/data-build-joined/.test(tag), why); };
  own(['Fix the header', '', `build> ${ID}`, ''], 2, 'a post-it\'s Build');
  own([TITLE, ...ANSWER, '', `build> ${ID}`, ''], 9, 'a blank line between');
  own([`build> ${ID}`, '', TITLE, ...ANSWER, ''], 0, 'above a conversation');
  own(['@discover --research papers on wave energy', 'bart> Found 3.', 'bart> *Discover · Sonnet · high · 3 s*', `build> ${ID}`, ''], 3, 'under a research box');
  // A task's Build is drawn under its row (MATH-106), never as a `build>` line.
  const task = mounted([`- [ ] <!--build:${ID}--> Add Haiku`, ''], { builds: running() });
  task.editor.taskOpen.add(ID);
  const drawn = task.html();
  assert.ok(/data-task-card=/.test(drawn), 'its card under its row');
  assert.equal(count(drawn, /data-build-joined|data-build="/g), 0);
});

test('patchBuilds replaces only the parts that changed, inside the joined card, and the card stays joined', () => {
  const m = mounted(BUTTON, { builds: running() });
  m.editor.lastHtml = m.html(); m.editor.lastKey = m.editor.key();
  const set = [];
  const parts = new Map();
  const part = (name) => { if (!parts.has(name)) parts.set(name, { set innerHTML(html) { set.push(name); }, querySelectorAll: () => [] }); return parts.get(name); };
  const card = { dataset: { line: '8', build: ID }, querySelector: (sel) => { const name = /data-build-part="([^"]+)"/.exec(sel); return name ? part(name[1]) : null; } };
  m.root.querySelectorAll = (sel) => (sel === '[data-build]' ? [card] : []);
  m.props.builds = { [ID]: { ...running()[ID], status: 'review' } };
  assert.equal(m.editor.patchBuilds(), true);
  assert.ok(set.length > 0 && set.includes('head'), `the head says Ready to review: ${set}`);
  assert.ok(!set.includes('prompt') && !set.includes('goal'), `unchanged parts left alone: ${set}`);
  const before = set.length;
  assert.equal(m.editor.patchBuilds(), true);
  assert.equal(set.length, before, 'nothing changed: nothing replaced');
  // Redrawn after the update, it is still the conversation's last part, drawn once.
  const html = m.editor.lastHtml;
  oneCard(html, 1, 8);
  oneReply(html);
});

test('a question typed under a finished joined Build starts a conversation of its own, the Build still closing the first', () => {
  const m = mounted([...BUTTON.slice(0, -1), '@bart and Opus?', 'bart> Sure.', 'bart> *Chat · Sonnet · high · 2 s*', ''], { builds: finished() });
  const html = m.html();
  oneCard(html, 1, 8);
  assert.match(rowTag(html, 9), /border-radius:10px 10px 0 0/, 'the new question opens a card');
  assert.equal(count(html, /data-follow-input/g), 1, 'the new conversation\'s own reply field');
});
