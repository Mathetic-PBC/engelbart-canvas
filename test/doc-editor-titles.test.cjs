'use strict';

// A conversation's title and Collapse (src/renderer/workspace/DocEditor.jsx, 2026-10-12). A question that starts a new
// @chat, @brainstorm or @discover conversation gets an empty `bart# ` line above it, which the workspace fills in when
// main's name-chat answers (src/main/bart/name-chat.cjs, test/bart.test.cjs); the answer starts at once. A titled
// conversation has a header row and collapses whole to one row (`bart#+`); an older one, with no title line, folds a turn
// at a time as before. There is no document here: the editor and its elements are stand-ins, as in doc-editor-edit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-titles-unit.cjs`);
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

function mounted(lines) {
  const asks = [], changes = [];
  const props = { docKey: 'k', text: lines.join('\n'), models: MODELS, onChange: (next) => { changes.push(next); props.text = next; }, onAsk: (ask) => asks.push(ask), onStopAsk: () => {} };
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
  const click = (act, data = {}, disabled = false) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, ...data }, disabled } : null) }, preventDefault() {} });
  return { editor, props, asks, changes, click, lines: () => editor.lines(), html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

/** The rendered row of line `i`: its opening tag, and what it holds up to the next line's row. */
function rowOf(html, i) {
  const at = html.indexOf(`data-line="${i}"`); assert.ok(at >= 0, `line ${i} is drawn`);
  const start = html.lastIndexOf('<', at), next = html.indexOf(`data-line="${i + 1}"`);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf('<', next));
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a new question gets an empty title line above it and is asked to be named; the answer is asked at once, as before', () => {
  for (const [line, agent] of [['@chat why retry?', 'bart'], ['@brainstorm a plan', 'brainstorm'], ['@discover retries', 'discover']]) {
    const m = mounted(['Notes', line, 'After']);
    m.editor.askInline(1);
    const ls = m.lines();
    assert.equal(ls[1], 'bart# ', `${agent}: the title line, empty`);
    assert.equal(ls[2], line);
    assert.match(ls[3], /^bart~> /);
    assert.equal(ls[4], 'After');
    assert.equal(m.asks.length, 1);
    assert.equal(m.asks[0].agent, agent);
    assert.equal(m.asks[0].name, true);
    assert.equal(m.asks[0].askId, ls[3].slice('bart~> '.length));
  }
});

test('no title for a follow-up, a question under an older conversation, one with a title already, or a Build', () => {
  // A follow-up sent from the field under an answer.
  const follow = mounted(['bart# Retry logic', '@chat why retry?', ...answer('because'), '']);
  follow.editor.followText.set(1, 'and timeouts?');
  follow.editor.sendFollow(1);
  assert.equal(follow.asks.length, 1);
  assert.equal(follow.asks[0].name, undefined);
  assert.equal(follow.lines().filter((l) => l.startsWith('bart#')).length, 1, 'still the one title');
  assert.equal(follow.lines()[0], 'bart# Retry logic', 'not renamed');

  // A question typed under an older conversation's answer is its next turn: no title, and none put in the old one.
  const old = mounted(['@chat why retry?', ...answer('because'), '@chat and timeouts?']);
  old.editor.askInline(4);
  assert.equal(old.asks[0].name, undefined);
  assert.ok(!old.lines().some((l) => l.startsWith('bart#')), 'an untitled conversation stays untitled');

  // A title the person wrote, or one left from before, is kept as it is.
  const titled = mounted(['bart# Mine', '@chat why?']);
  titled.editor.askInline(1);
  assert.equal(titled.asks[0].name, undefined);
  assert.deepEqual(titled.lines().slice(0, 2), ['bart# Mine', '@chat why?']);

  const build = mounted(['@chat --build make it', '']);
  build.editor.askInline(0);
  assert.ok(!build.lines().some((l) => l.startsWith('bart#')));
});

test('the answer replaces its pending line with the title line above it, and the title fills in after the answer started', async () => {
  const { placeAnswer, placeTitle, askedAt } = await doc();
  const m = mounted(['Notes', '@chat why retry?', '']);
  m.editor.askInline(1);
  const { askId } = m.asks[0];
  // The answer lands first, as Workspace askBart places it, noting where its question stood.
  const near = askedAt(m.props.text, askId);
  m.props.text = placeAnswer(m.props.text, askId, answer('because'));
  assert.deepEqual(m.props.text.split('\n').slice(0, 4), ['Notes', 'bart# ', '@chat why retry?', 'bart> because']);
  assert.ok(!m.props.text.includes('bart~>'), 'the pending line is gone');
  // Then the title comes back and fills its line.
  m.props.text = placeTitle(m.props.text, askId, 'Retry logic', near);
  assert.equal(m.props.text.split('\n')[1], 'bart# Retry logic');
  assert.match(m.html(), /data-title-row[\s\S]*Retry logic/);

  // Or the title first, while it is still running: the pending line is still the anchor.
  const r = mounted(['@chat why retry?', '']);
  r.editor.askInline(0);
  r.props.text = placeTitle(r.props.text, r.asks[0].askId, 'Retry logic');
  r.props.text = placeAnswer(r.props.text, r.asks[0].askId, answer('because'));
  assert.deepEqual(r.props.text.split('\n').slice(0, 3), ['bart# Retry logic', '@chat why retry?', 'bart> because']);
});

test('an expanded titled conversation has a header: its title, and Collapse; the foot\'s Collapse folds the whole of it', () => {
  const m = mounted(['bart# Retry logic', '@chat why retry?', ...answer('because'), '']);
  const html = m.html(), head = rowOf(html, 0);
  assert.match(head, /data-title-row/);
  assert.match(head, /class="bart-title" data-act="edittitle" data-row="0"[^>]*font:13px[^>]*color:#4d4d4d[^>]*>Retry logic</);
  assert.match(head, /text-overflow:ellipsis/);
  assert.match(head, /data-act="foldthread" data-row="0" aria-label="Collapse"/);
  assert.ok(html.includes('data-act="foldthread" data-row="0" aria-label="Collapse" aria-expanded="true">'), 'the foot\'s Collapse is the conversation\'s');
  assert.ok(!html.includes('data-act="fold" data-turn="1"'), 'not the turn\'s');
});

test('collapsed: one row, the Agents icon and the title as a link; every line of it hidden; a click expands', () => {
  const lines = ['Notes', 'bart#+ Retry logic', '@chat why retry?', ...answer('because'), '@chat timeouts?', ...answer('those too'), '', 'After'];
  const m = mounted(lines);
  const html = m.html(), row = rowOf(html, 1);
  assert.match(row, /data-thread-row/);
  assert.match(row, /padding:4px 0/);
  assert.match(row, /margin-bottom:6px/);
  assert.ok(!/background/.test(row.slice(0, row.indexOf('>'))), 'no card behind it');
  assert.match(row, /data-act="foldthread" data-row="1"[^>]*color:#0070f3;font:14px/);
  assert.match(row, /<svg[^>]*width="14"[^>]*>/, 'the Agents icon at 14px');
  assert.match(row, />Retry logic</);
  assert.match(row, /class="bart-tip"[^>]*>Chat</, 'hovering names the agent');
  const last = lines.indexOf('After') - 2;
  for (let i = 2; i <= last; i++) assert.match(rowOf(html, i), /^<div[^>]*display:none/, `line ${i} hidden`);
  const drawn = html.replace(/ data-raw="[^"]*"/g, '');
  assert.ok(!drawn.includes('because') && !drawn.includes('timeouts?'), 'nothing of it is drawn');
  assert.match(rowOf(html, 0), />Notes</);

  m.click('foldthread', { row: '1' });
  assert.equal(m.lines()[1], 'bart# Retry logic', 'expanded: the title line, nothing else rewritten');
  assert.deepEqual(m.lines().slice(2), lines.slice(2));
  assert.match(m.html(), /data-title-row/);
  m.click('foldthread', { row: '1' });
  assert.equal(m.lines()[1], 'bart#+ Retry logic');
  assert.deepEqual(m.lines().slice(2), lines.slice(2), 'the answers stay `bart>`: no `bart+>`');

  // @brainstorm and @discover are named for themselves.
  assert.match(mounted(['bart#+ Plan', '@brainstorm a plan', ...answer('x'), '']).html(), /class="bart-tip"[^>]*>Brainstorm</);
  assert.match(mounted(['bart#+ Read', '@discover retries', ...answer('x'), '']).html(), /class="bart-tip"[^>]*>Discover</);
});

test('a conversation at work cannot be collapsed: its Collapse is disabled, and `bart#+` on it is drawn open', () => {
  const m = mounted(['bart# Retry logic', '@chat why retry?', 'bart~> run1', '']);
  const head = rowOf(m.html(), 0);
  assert.match(head, /data-act="foldthread" data-row="0" aria-label="Collapse" aria-expanded="true" style="[^"]*" disabled/);
  assert.match(head, /Collapse once it answers/);
  m.editor.toggleThread(0);
  m.click('foldthread', { row: '0' }, true);
  assert.equal(m.lines()[0], 'bart# Retry logic');
  const open = mounted(['bart#+ Retry logic', '@chat why retry?', 'bart~> run1', '']).html();
  assert.match(rowOf(open, 0), /data-title-row/);
  assert.ok(!open.includes('data-thread-row'));
});

test('Collapse all folds titled conversations by their title line, older ones a turn at a time; Expand all opens both', () => {
  const lines = ['bart# Retry logic', '@chat why retry?', ...answer('because'), '', '@chat old one?', ...answer('old'), ''];
  const m = mounted(lines);
  m.editor.foldAll(true);
  const ls = m.lines();
  assert.equal(ls[0], 'bart#+ Retry logic');
  assert.equal(ls[2], 'bart> because', 'the titled conversation\'s answer lines are not rewritten');
  assert.ok(ls.includes('bart+> old'), 'the untitled turn folds as before');
  const html = m.html();
  assert.match(rowOf(html, 0), /data-thread-row/);
  m.editor.foldAll(false);
  assert.deepEqual(m.lines(), lines);
});

test('clicking the title edits it in place: Enter writes it, Escape and an empty field change nothing', () => {
  const m = mounted(['bart# Retry logic', '@chat why retry?', ...answer('because'), '']);
  m.click('edittitle', { row: '0' });
  assert.match(m.html(), /<input[^>]*data-title-input="0"[^>]*value="Retry logic"/);
  const input = { value: 'Retries and backoff' };
  m.editor.titleInput(input);
  m.editor.titleKey({ key: 'Enter', target: input, isComposing: false, preventDefault() {} });
  assert.equal(m.lines()[0], 'bart# Retries and backoff');
  m.click('edittitle', { row: '0' });
  m.editor.titleKey({ key: 'Escape', target: { value: 'nope' }, preventDefault() {} });
  m.click('edittitle', { row: '0' });
  m.editor.commitTitle({ value: '   ' });
  assert.equal(m.lines()[0], 'bart# Retries and backoff');
  // Renaming a collapsed one keeps it collapsed.
  const f = mounted(['bart#+ Retry logic', '@chat why retry?', ...answer('because'), '']);
  f.editor.titleEdit = { line: 0, value: 'Retry logic' };
  f.editor.commitTitle({ value: 'Backoff' });
  assert.equal(f.lines()[0], 'bart#+ Backoff');
});

test('a new question\'s title row shows no text until name-chat returns, then the model\'s title; no "Naming…" or "Untitled", ever', async () => {
  const { placeAnswer, placeTitle, askedAt } = await doc();
  const m = mounted(['Notes', '@chat why does the client retry three times?', '']);
  m.editor.askInline(1);
  const { askId } = m.asks[0];
  const never = (html, when) => { assert.ok(!/Naming|Untitled/.test(html), `${when}: no placeholder`); };
  // Running, unnamed: the row is there with its Collapse (disabled), and the title's span holds nothing.
  let head = rowOf(m.html(), 1);
  assert.match(head, /data-title-row="1"/);
  assert.match(head, /<span class="bart-title" data-act="edittitle" data-row="1"[^>]*min-height:21px[^>]*><\/span>/, 'the span is empty, and keeps its height');
  assert.match(head, /data-act="foldthread" data-row="1" aria-label="Collapse"[^>]* disabled/);
  never(m.html(), 'running');
  // The answer lands before the title: still nothing in the row.
  const near = askedAt(m.props.text, askId);
  m.props.text = placeAnswer(m.props.text, askId, answer('because'));
  head = rowOf(m.html(), 1);
  assert.match(head, /data-act="edittitle" data-row="1"[^>]*><\/span>/);
  never(m.html(), 'answered, unnamed');
  // name-chat returns: the title fills the row.
  m.props.text = placeTitle(m.props.text, askId, 'Client retry count', near);
  assert.match(rowOf(m.html(), 1), /data-act="edittitle" data-row="1"[^>]*>Client retry count<\/span>/);
  never(m.html(), 'named');
  // Collapsed with its title emptied by hand: the row shows the opening question, not "Untitled".
  const c = mounted(['bart#+ ', '@chat why does the **client** retry three times?', ...answer('because'), '']);
  const row = rowOf(c.html(), 0);
  assert.match(row, /class="bart-thread-name"[^>]*>why does the client retry three times\?<\/span>/);
  never(c.html(), 'collapsed, untitled');
});

test('a title the person edited while naming was still running is not overwritten when name-chat returns', async () => {
  const { placeAnswer, placeTitle, askedAt } = await doc();
  // Renamed and written before the title came back, while the question still runs.
  const m = mounted(['@chat why retry?', '']);
  m.editor.askInline(0);
  const { askId } = m.asks[0];
  m.click('edittitle', { row: '0' });
  m.editor.commitTitle({ value: 'My own name' });
  assert.equal(m.lines()[0], 'bart# My own name');
  assert.equal(placeTitle(m.props.text, askId, 'Retry logic'), null, 'the model\'s title is not placed');
  assert.equal(m.lines()[0], 'bart# My own name');
  // After the answer landed too.
  const near = askedAt(m.props.text, askId);
  m.props.text = placeAnswer(m.props.text, askId, answer('because'));
  assert.equal(placeTitle(m.props.text, askId, 'Retry logic', near), null);
  // Still being typed when the title came back: what the person writes wins.
  const t = mounted(['@chat why retry?', '']);
  t.editor.askInline(0);
  t.click('edittitle', { row: '0' });
  t.editor.titleInput({ value: 'Typed meanwhile' });
  t.props.text = placeTitle(t.props.text, t.asks[0].askId, 'Retry logic');
  assert.match(t.html(), /<input[^>]*data-title-input="0"[^>]*value="Typed meanwhile"/, 'the field keeps what was typed');
  t.editor.commitTitle({ value: 'Typed meanwhile' });
  assert.equal(t.lines()[0], 'bart# Typed meanwhile');
});

test('a title with no question under it is the text it is; deleting a titled conversation\'s only turn takes its title', () => {
  const plain = mounted(['bart# Left behind', 'Notes']).html();
  assert.ok(!plain.includes('data-title-row') && !plain.includes('data-thread-row'));
  assert.match(plain, /bart# Left behind/);
  const m = mounted(['Notes', 'bart# Retry logic', '@chat why retry?', ...answer('because'), '', 'After']);
  m.editor.deleteTurn(2);
  assert.deepEqual(m.lines(), ['Notes', '', 'After']);
});

test('cards are compact: question 8px 12px (6px after an answer), foot 4px 10px 6px, follow-up 10px 12px, 8px under a card', () => {
  const html = mounted(['@chat first?', ...answer('one'), '@chat second?', ...answer('two'), '']).html();
  assert.match(rowOf(html, 0), /padding:8px 12px/);
  assert.match(rowOf(html, 4), /padding:6px 12px/);
  assert.match(html, /padding:4px 10px 6px/);
  assert.match(html, /padding:10px 12px;margin-bottom:8px/);
});
