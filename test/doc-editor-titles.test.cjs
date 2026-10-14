'use strict';

// A conversation's title and Collapse (src/renderer/workspace/DocEditor.jsx, 2026-10-12). A question that starts a new
// @chat, @brainstorm or @discover conversation gets an empty `bart# ` line above it, which the workspace fills in when
// main's name-chat answers (src/main/bart/name-chat.cjs, test/bart.test.cjs); the answer starts at once. A titled
// conversation draws no header while open (its card starts at its question) and collapses whole to one link, the Agents
// pointer and its title (`bart#+`, 2026-10-13), which an ⌥-click renames; an older one, with no title line, folds a turn
// at a time as before. Shown again, a document's open titled conversations collapse (autoCollapse). There is no document here: the editor and its elements are stand-ins, as in doc-editor-edit.

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

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a new question gets an empty title line above it and is asked to be named; the answer is asked at once, as before', () => {
  for (const [line, agent] of [['@chat why retry?', 'bart'], ['@brainstorm a plan', 'brainstorm'], ['@discover retries', 'discover']]) {
    const m = mounted(['Notes', line, 'After']);
    m.editor.askInline(1);
    const ls = m.lines();
    assert.match(ls[1], new RegExp(`^bart# \\[${line.slice(1, line.indexOf(' '))} \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\] $`), `${agent}: the title line, empty, keeping its agent and when it was asked`);
    assert.equal(ls[2], line);
    assert.match(ls[3], /^bart~> /);
    // @discover (2026-10-13): Chat's reply is the one named, and the search is a research box under it.
    const research = agent === 'discover';
    assert.equal(ls[research ? 6 : 4], 'After');
    if (research) assert.deepEqual([ls[4], ls[5].slice(0, 7)], ['@discover --research retries', 'bart~> ']);
    assert.equal(m.asks.length, research ? 2 : 1);
    assert.equal(m.asks[0].agent, research ? 'bart' : agent);
    assert.equal(m.asks[0].name, true);
    assert.equal(m.asks[0].askId, ls[3].slice('bart~> '.length));
    if (research) assert.deepEqual([m.asks[1].agent, m.asks[1].name, m.asks[1].askId], ['discover', undefined, ls[5].slice('bart~> '.length)]);
  }
});

test('no title for a follow-up, a question under an older conversation, or one with a title already', () => {
  // A follow-up sent from the field under an answer.
  const follow = mounted(['bart# Retry logic', '@chat why retry?', ...answer('because'), '']);
  follow.editor.followText.set(1, 'and timeouts?');
  follow.editor.sendFollow(1);
  assert.equal(follow.asks.length, 1);
  assert.equal(follow.asks[0].name, undefined);
  assert.equal(follow.lines().filter((l) => l.startsWith('bart#')).length, 1, 'still the one title');
  assert.equal(follow.lines()[0], 'bart# Retry logic', 'not renamed');

  // A follow-up from the field of an older conversation (no title line): none put in it.
  const old = mounted(['@chat why retry?', ...answer('because'), '']);
  old.editor.followText.set(0, 'and timeouts?');
  old.editor.sendFollow(0);
  assert.equal(old.asks[0].name, undefined);
  assert.ok(!old.lines().some((l) => l.startsWith('bart#')), 'an untitled conversation stays untitled');

  // A title the person wrote, or one left from before, is kept as it is.
  const titled = mounted(['bart# Mine', '@chat why?']);
  titled.editor.askInline(1);
  assert.equal(titled.asks[0].name, undefined);
  assert.deepEqual(titled.lines().slice(0, 2), ['bart# Mine', '@chat why?']);

  // A Build request gets one too (2026-10-13), marked a Build's.
  const build = mounted(['@chat --build make it', '']);
  build.editor.askInline(0);
  assert.match(build.lines()[0], /^bart# \[chat build \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/);
  assert.equal(build.asks[0].name, true);
});

test('an @ line typed under an answer starts a conversation of its own: an empty line and its title line above it, in one change; the reply field still adds a follow-up (2026-10-13)', async () => {
  const { threads } = await doc();
  const CARD = ['@chat why retry?', 'bart> because', 'bart> *Chat · Sonnet · high · 3 s*'];
  for (const [line, agent] of [['@chat new', 'chat'], ['@bart new', 'chat']]) {
    let release; const routed = new Promise((resolve) => { release = resolve; });
    const m = mounted([...CARD, line], { onRoute: () => routed });
    const before = m.changes.length;
    m.editor.askInline(3);
    assert.equal(m.changes.length, before + 1, `${line}: one change, one undo`);
    assert.equal(m.lines()[3], '', `${line}: the empty line goes in at once, with the pending line`);
    release({ id: 'r', agent, sure: 0.9, by: 'model' });
    await new Promise((resolve) => setImmediate(resolve));
    const ls = m.lines();
    assert.equal(ls[3], '', `${line}: an empty line under the card`);
    assert.match(ls[4], /^bart# \[chat \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/, `${line}: its title line`);
    assert.equal(ls[5], line);
    assert.match(ls[6], /^bart~> /);
    assert.deepEqual([m.asks[0].turns, m.asks[0].name, m.asks[0].place], [[], true, { line: 5, text: line }]);
    assert.deepEqual(threads(ls).map((t) => [t.from, t.turns.length]), [[0, 1], [5, 1]], `${line}: two conversations`);
  }

  // From the card's reply field, as before: the card's next turn.
  const f = mounted([...CARD, '']);
  f.editor.followText.set(0, 'and timeouts?');
  f.editor.sendFollow(0);
  assert.deepEqual(f.lines().slice(3, 5), ['@chat and timeouts?', `bart~> ${f.asks[0].askId}`]);
  assert.deepEqual([f.asks[0].turns.length, f.asks[0].name], [1, undefined]);
  assert.deepEqual(threads(f.lines()).map((t) => t.turns.length), [2], 'one conversation, two turns');

  // Under an empty line or other text, as before: nothing put in but its title line.
  for (const above of ['', 'Some notes']) {
    const n = mounted([...CARD, above, '@chat new']);
    n.editor.askInline(4);
    assert.deepEqual([n.lines()[3], n.lines()[5]], [above, '@chat new']);
    assert.match(n.lines()[4], /^bart# /);
  }
});

test('the answer replaces its pending line with the title line above it, and the title fills in after the answer started', async () => {
  const { placeAnswer, placeTitle, askedAt } = await doc();
  const m = mounted(['Notes', '@chat why retry?', '']);
  m.editor.askInline(1);
  const { askId } = m.asks[0];
  // The answer lands first, as Workspace askBart places it, noting where its question stood.
  const near = askedAt(m.props.text, askId);
  m.props.text = placeAnswer(m.props.text, askId, answer('because'));
  const head = m.props.text.split('\n')[1];
  assert.match(head, /^bart# \[chat [^\]]+\] $/);
  assert.deepEqual(m.props.text.split('\n').slice(2, 4), ['@chat why retry?', 'bart> because']);
  assert.ok(!m.props.text.includes('bart~>'), 'the pending line is gone');
  // Then the title comes back and fills its line.
  m.props.text = placeTitle(m.props.text, askId, 'Retry logic', near);
  assert.equal(m.props.text.split('\n')[1], `${head}Retry logic`, 'the title after what the line keeps');
  assert.ok(!/data-title-row/.test(m.html()), 'open, the title is not drawn');
  m.editor.toggleThread(1);
  assert.match(rowOf(m.html(), 1), /data-thread-row[\s\S]*>Retry logic</, 'collapsed, its row shows it');

  // Or the title first, while it is still running: the pending line is still the anchor.
  const r = mounted(['@chat why retry?', '']);
  r.editor.askInline(0);
  r.props.text = placeTitle(r.props.text, r.asks[0].askId, 'Retry logic');
  r.props.text = placeAnswer(r.props.text, r.asks[0].askId, answer('because'));
  assert.deepEqual(r.props.text.split('\n').slice(0, 3).map((l) => l.replace(/\[[^\]]+\] /, '')), ['bart# Retry logic', '@chat why retry?', 'bart> because']);
});

test('an open titled conversation draws no title row; its question opens the card, rounded; Collapse is on the foot', () => {
  const lines = ['bart# [chat 2026-10-12T21:41:00Z] Retry logic', '@chat why retry?', ...answer('because'), ''];
  const m = mounted(lines);
  const html = m.html(), head = rowOf(html, 0);
  assert.match(head, /^<div data-line="0" data-raw="[^"]*" contenteditable="false" data-readonly="1" style="display:none"><\/div>$/, 'the title line is in the file, not on the page');
  assert.ok(!/data-title-row|data-thread-row/.test(html));
  assert.ok(!html.replace(/ data-raw="[^"]*"/g, '').includes('Retry logic'), 'the title is not shown');
  assert.match(rowOf(html, 1), /border-radius:10px 10px 0 0/, 'the first question has the card\'s rounded top');
  assert.ok(html.includes('data-act="foldthread" data-row="0" aria-label="Collapse" aria-expanded="true">'), 'the foot\'s Collapse is the conversation\'s');
  assert.ok(!html.includes('data-act="fold" data-turn="1"'), 'not the turn\'s');
  assert.deepEqual(m.lines(), lines, 'the `bart#` line is as it was');
  // Collapse from the foot folds it to one row, a link; an ⌥-click on the foot's Collapse is a click, not a rename.
  m.click('foldthread', { row: '0' }, false, { alt: true });
  assert.equal(m.lines()[0], 'bart#+ [chat 2026-10-12T21:41:00Z] Retry logic');
  assert.deepEqual(m.lines().slice(1), lines.slice(1));
  assert.equal(m.editor.titleEdit, null);
  const row = rowOf(m.html(), 0), open = row.slice(0, row.indexOf('>'));
  assert.match(open, /data-thread-row="0"/);
  assert.ok(!/background|border-radius/.test(open), 'no card around it');
  assert.match(row, /class="bart-link" data-act="foldthread" data-row="0"/);
});

test('collapsed: one 42px line, the pointer and the title as a link, when it was asked on the right (the agent first unless Chat); every line of it hidden; a click expands', () => {
  const at = new Date(); at.setHours(21, 41, 0, 0);
  const lines = ['Notes', `bart#+ [discover ${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}] Retry logic`, '@bart why retry?', ...answer('because'), '@bart timeouts?', ...answer('those too'), '', 'After'];
  const m = mounted(lines);
  const html = m.html(), row = rowOf(html, 1), open = row.slice(0, row.indexOf('>'));
  assert.match(open, /data-thread-row="1"/);
  assert.ok(!/data-act|background|border:|border-radius/.test(open), 'the row is not the button, and nothing is drawn around it');
  assert.match(open, /height:42px;box-sizing:border-box;font:15px\/1\.4 var\(--font-sans\)/, 'one 42px line, 15px');
  const link = row.slice(row.indexOf('<span class="bart-link"'));
  assert.match(link, /^<span class="bart-link" data-act="foldthread" data-row="1" role="button" tabindex="0" aria-label="Expand Retry logic" aria-expanded="false" title="⌥-click to rename"/, 'the link is the button');
  assert.match(link, /<span style="flex:none;display:inline-flex"><svg width="15"[^>]*><path d="M4\.04 4\.69/, 'the mouse-pointer-2, 15px, in the link\'s colour');
  assert.equal((row.match(/<svg/g) || []).length, 1, 'no other icon: no chevron');
  assert.match(link, /class="bart-thread-name"[^>]*text-overflow:ellipsis[^>]*>Retry logic<\/span><\/span><span data-thread-when="1" style="[^"]*font:12px\/1 var\(--font-sans\);color:#8f8f8f[^"]*">Discover · 9:41 PM<\/span><\/div>$/, 'the title, then the agent and when on the right, no count');
  const last = lines.indexOf('After') - 2;
  for (let i = 2; i <= last; i++) assert.match(rowOf(html, i), /^<div[^>]*display:none/, `line ${i} hidden`);
  const drawn = html.replace(/ data-raw="[^"]*"/g, '');
  assert.ok(!drawn.includes('because') && !drawn.includes('timeouts?'), 'nothing of it is drawn');
  assert.match(rowOf(html, 0), />Notes</);

  m.click('foldthread', { row: '1' });
  assert.equal(m.lines()[1], lines[1].replace('bart#+', 'bart#'), 'expanded: the title line, what it keeps kept, nothing else rewritten');
  assert.deepEqual(m.lines().slice(2), lines.slice(2));
  assert.ok(!m.html().includes('data-thread-row'), 'open: no row for it');
  m.click('foldthread', { row: '1' });
  assert.equal(m.lines()[1], lines[1]);
  assert.deepEqual(m.lines().slice(2), lines.slice(2), 'the answers stay `bart>`: no `bart+>`');

  // Each names its agent; one from yesterday says so; a line Bart read as a build is Build's; an older title has no time.
  const day = new Date(); day.setDate(day.getDate() - 1); day.setHours(12, 0, 0, 0);
  const iso = day.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const many = mounted([
    `bart#+ [chat build ${iso}] Unaccepted builds check`, '@bart check the builds', ...answer('x'),
    `bart#+ [brainstorm ${iso}] Questions as multi-select`, '@brainstorm a plan', ...answer('x'),
    'bart#+ Papers on assessment', '@discover retries', ...answer('x'), '',
  ]).html();
  const n = answer('x').length + 2;
  assert.match(rowOf(many, 0), /data-thread-when="1"[^>]*>Build · Yesterday</);
  assert.match(rowOf(many, n), /data-thread-when="1"[^>]*>Brainstorm · Yesterday</);
  assert.match(rowOf(many, 2 * n), /data-thread-when="1"[^>]*>Discover</);
  // Chat's: the time alone.
  assert.match(rowOf(mounted([`bart#+ [chat ${iso}] Retry logic`, '@chat why?', ...answer('x'), '']).html(), 0), /data-thread-when="1"[^>]*>Yesterday</);
});

test('a conversation at work cannot be collapsed: its Collapse is disabled, and `bart#+` on it is drawn open', () => {
  const m = mounted(['bart# Retry logic', '@chat why retry?', ...answer('because'), '@chat and more?', 'bart~> run1', '']);
  const html = m.html();
  assert.match(html, /data-act="foldthread" data-row="0" aria-label="Collapse" aria-expanded="true" disabled/);
  assert.match(html, /Collapse once it answers/);
  m.editor.toggleThread(0);
  m.click('foldthread', { row: '0' }, true);
  assert.equal(m.lines()[0], 'bart# Retry logic');
  const open = mounted(['bart#+ Retry logic', '@chat why retry?', 'bart~> run1', '']).html();
  assert.match(rowOf(open, 0), /style="display:none"/, 'drawn open: no header');
  assert.ok(!open.includes('data-thread-row'));
  assert.match(rowOf(open, 1), /border-radius:10px 10px 0 0/);
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

test('an ⌥-click on the collapsed link edits its title in place: Enter writes it, Escape and an empty field change nothing; a click expands', () => {
  const m = mounted(['bart#+ Retry logic', '@chat why retry?', ...answer('because'), '']);
  const rename = () => m.click('foldthread', { row: '0' }, false, { alt: true, row: true });
  rename();
  let row = rowOf(m.html(), 0);
  assert.match(row, /<input[^>]*data-title-input="0"[^>]*value="Retry logic"/);
  assert.ok(!row.includes('data-act'), 'while it is edited there is no link: a click in the field stays there');
  assert.equal(m.lines()[0], 'bart#+ Retry logic', 'still collapsed');
  const input = { value: 'Retries and backoff' };
  m.editor.titleInput(input);
  m.editor.titleKey({ key: 'Enter', target: input, isComposing: false, preventDefault() {} });
  assert.equal(m.lines()[0], 'bart#+ Retries and backoff', 'renamed, and kept collapsed');
  rename();
  m.editor.titleKey({ key: 'Escape', target: { value: 'nope' }, preventDefault() {} });
  assert.ok(!m.html().includes('data-title-input'));
  rename();
  m.editor.commitTitle({ value: '   ' });
  assert.equal(m.lines()[0], 'bart#+ Retries and backoff');
  // A plain click on the link expands it.
  assert.match(rowOf(m.html(), 0), /class="bart-link" data-act="foldthread" data-row="0"/);
  m.click('foldthread', { row: '0' }, false, { row: true });
  assert.equal(m.lines()[0], 'bart# Retries and backoff');
  assert.equal(m.editor.titleEdit, null);
  // Read only, an ⌥-click expands it too: there is nothing to rename.
  const r = mounted(['bart#+ Retry logic', '@chat why retry?', ...answer('because'), '']);
  r.props.readOnly = true;
  r.click('foldthread', { row: '0' }, false, { alt: true, row: true });
  assert.equal(r.editor.titleEdit, null);
  assert.equal(r.lines()[0], 'bart# Retry logic');
});

test('a new question\'s title row shows no text until name-chat returns, then the model\'s title; no "Naming…" or "Untitled", ever', async () => {
  const { placeAnswer, placeTitle, askedAt } = await doc();
  const m = mounted(['Notes', '@chat why does the client retry three times?', '']);
  m.editor.askInline(1);
  const { askId } = m.asks[0];
  const never = (html, when) => { assert.ok(!/Naming|Untitled/.test(html), `${when}: no placeholder`); };
  // Running, unnamed: no header is drawn, the line waits in the file.
  assert.match(rowOf(m.html(), 1), /style="display:none"/);
  never(m.html(), 'running');
  // The answer lands before the title: still nothing shown, and collapsed the row falls back to the question.
  const near = askedAt(m.props.text, askId);
  m.props.text = placeAnswer(m.props.text, askId, answer('because'));
  never(m.html(), 'answered, unnamed');
  m.editor.toggleThread(1);
  assert.match(rowOf(m.html(), 1), /class="bart-thread-name"[^>]*>why does the client retry three times\?<\/span>/);
  // name-chat returns: the title fills the row.
  m.props.text = placeTitle(m.props.text, askId, 'Client retry count', near);
  assert.match(rowOf(m.html(), 1), /class="bart-thread-name"[^>]*>Client retry count<\/span>/);
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
  assert.match(m.lines()[0], /^bart# \[chat [\dTZ:-]+\] My own name$/);
  assert.equal(placeTitle(m.props.text, askId, 'Retry logic'), null, 'the model\'s title is not placed');
  assert.match(m.lines()[0], /^bart# \[chat [\dTZ:-]+\] My own name$/);
  // After the answer landed too.
  const near = askedAt(m.props.text, askId);
  m.props.text = placeAnswer(m.props.text, askId, answer('because'));
  assert.equal(placeTitle(m.props.text, askId, 'Retry logic', near), null);
  // Still being typed on the collapsed row when the title came back: what the person writes wins.
  const t = mounted(['@chat why retry?', '']);
  t.editor.askInline(0);
  const tNear = askedAt(t.props.text, t.asks[0].askId);
  t.props.text = placeAnswer(t.props.text, t.asks[0].askId, answer('because'));
  t.editor.toggleThread(0);
  t.click('edittitle', { row: '0' });
  t.editor.titleInput({ value: 'Typed meanwhile' });
  t.props.text = placeTitle(t.props.text, t.asks[0].askId, 'Retry logic', tNear);
  assert.match(t.html(), /<input[^>]*data-title-input="0"[^>]*value="Typed meanwhile"/, 'the field keeps what was typed');
  t.editor.commitTitle({ value: 'Typed meanwhile' });
  assert.match(t.lines()[0], /^bart#\+ \[chat [\dTZ:-]+\] Typed meanwhile$/);
});

test('a title with no question under it is the text it is; deleting a titled conversation\'s only turn takes its title', () => {
  const plain = mounted(['bart# Left behind', 'Notes']).html();
  assert.ok(!plain.includes('data-title-row') && !plain.includes('data-thread-row'));
  assert.match(plain, /bart# Left behind/);
  const m = mounted(['Notes', 'bart# Retry logic', '@chat why retry?', ...answer('because'), '', 'After']);
  m.editor.deleteTurn(2);
  assert.deepEqual(m.lines(), ['Notes', '', 'After']);
});

test('the card (2026-10-13): question 14px 16px, answer 12px under it in a 14px rule, button row 12px 10px 10px 16px closing it, 8px under a card; no reply field until Reply', () => {
  const html = mounted(['@chat first?', ...answer('one'), '@chat second?', ...answer('two'), '']).html();
  assert.match(rowOf(html, 0), /padding:14px 16px 0px;background:#fafafa;border-radius:10px 10px 0 0/);
  assert.match(rowOf(html, 0), /color:#171717/);
  assert.match(rowOf(html, 1), /padding:12px 16px 0px;[^"]*color:#262626;font-size:16px;line-height:1\.65[^"]*"><span style="display:block;padding:2px 0 2px 14px;border-left:2px solid #d6d6d6"/);
  assert.match(rowOf(html, 4), /padding:14px 16px 0px/, 'a question under an open answer');
  assert.match(html, /padding:12px 10px 6px 16px/);
  assert.match(html, /padding:12px 10px 10px 16px;background:#fafafa;border-radius:0 0 10px 10px;margin-bottom:8px/);
  assert.ok(!html.includes('data-followup=') && html.includes('data-act="reply" data-thread="0"'), 'Reply, no field');
});

test('the button row (2026-10-13): Reply, Copy and Regenerate on the left; the model, effort and time on the right (the agent first unless Chat, never "via Bart"), then Collapse and Delete; the closing line is kept', () => {
  const footOf = (html) => { const at = html.indexOf('data-foot='); assert.ok(at >= 0, 'a foot is drawn'); const start = html.lastIndexOf('<div', at); return html.slice(start, html.indexOf('</div>', at) + 6); };
  const shown = (html) => html.replace(/<span class="bart-tip"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').trim();
  for (const [line, closing, meta] of [['@bart make the icons bigger', '*Build · Opus · high · 39 s*', 'Build · Opus · high · 39 s'], ['@chat why retry?', '*Chat · Opus · high · 17 s*', 'Opus · high · 17 s'], ['@bart why retry?', '*Chat · 48 s · via Bart*', '48 s'], ['@chat why retry?', '*Opus · high · 9 s · moved up from Sonnet medium*', 'Opus · high · 9 s']]) {
    const lines = ['bart# [chat 2026-10-12T21:41:00Z] Retry logic', line, 'bart> because', `bart> ${closing}`, ''];
    const m = mounted(lines), foot = footOf(m.html());
    assert.equal(shown(foot), `Reply${meta}`, `${closing}: Reply, then ${meta}`);
    assert.match(foot, /<span data-foot-meta="1" style="flex:none;margin-left:auto;padding-right:6px;font:12px\/1 var\(--font-sans\);color:#8f8f8f;white-space:nowrap">/, 'the meta, pushed right, 12px grey');
    assert.match(foot, /<button type="button" class="bart-reply" data-act="reply" data-thread="1"/, 'Reply');
    assert.match(foot, /data-act="copybart" data-turn="1" aria-label="Copy"/, 'Copy');
    assert.match(foot, /data-act="regen" data-turn="1" data-quiet="1" aria-label="Regenerate"/, 'Regenerate, opening no selector');
    assert.match(foot, /data-act="foldthread" data-row="0" aria-label="Collapse"/, 'Collapse');
    assert.match(foot, /data-act="dropturn" data-turn="1" aria-label="Delete"/, 'Delete');
    const order = ['data-act="reply"', 'copybart', 'data-act="regen"', 'data-foot-meta', 'foldthread', 'dropturn'].map((k) => foot.indexOf(k));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'Reply, Copy, Regenerate, the meta, Collapse, Delete');
    assert.ok(!foot.includes('editturn') && !foot.includes('footbuild'), 'no Edit, no Build');
    assert.equal(m.lines()[3], `bart> ${closing}`, 'the closing line in the file is as it was');
  }
  // What reads the closing line still does: a routed turn's agent is the one it names.
  const m = mounted(['@bart make the icons bigger', 'bart> ```', 'bart> Make them 20px', 'bart> ```', 'bart> *Build · Opus · high · 39 s*', '']);
  const found = m.editor.findTurn(m.lines(), 0);
  assert.equal(m.editor.turnAgent(found.thread, found.turn), 'bart', 'a Build-named closing line is still read (Chat answered it)');
});

test('the follow-up field says @bart whichever agent answered, since what is typed goes to Bart; with no router, that agent', () => {
  const field = (html) => { const at = html.indexOf('data-followup='); assert.ok(at >= 0, 'a follow-up field'); return html.slice(at, html.indexOf('</div>', at)); };
  for (const line of ['@chat why retry?', '@discover retries', '@brainstorm a plan']) {
    const m = mounted([line, ...answer('x'), '']);
    m.props.onRoute = () => {};
    assert.ok(!m.html().includes('data-followup='), `${line}: shut until Reply`);
    m.click('reply', { thread: '0' });
    const routed = field(m.html());
    assert.match(routed, /font-size:16px;line-height:24px">@bart<\/span>/, `${line}: @bart`);
    assert.ok(!/>@(chat|discover|brainstorm)</.test(routed), `${line}: not the agent that answered`);
    assert.match(routed, /placeholder="Respond…"/);
    delete m.props.onRoute;
    const token = line.split(' ')[0];
    assert.match(field(m.html()), new RegExp(`line-height:24px">${token}</span>`), `${line}: no router, it asks ${token}`);
  }
});

test('shown again, a document collapses its open titled conversations once: not one at work or unanswered, not untitled, not read only', () => {
  const lines = [
    'bart# [chat 2026-10-12T21:41:00Z] Retry logic', '@chat why retry?', ...answer('because'), '',
    'bart# Running one', '@chat still going?', 'bart~> run1', '',
    'bart#+ Folded already', '@chat old?', ...answer('old'), '',
    'bart# ', '@chat unnamed but answered?', ...answer('yes'), '',
    '@chat untitled?', ...answer('as before'), '',
  ];
  const m = mounted(lines, { autoCollapse: true });
  const ls = m.lines();
  assert.equal(m.changes.length, 1, 'one change, on mount');
  assert.equal(ls[0], 'bart#+ [chat 2026-10-12T21:41:00Z] Retry logic', 'collapsed, what the line keeps kept');
  assert.equal(ls[lines.indexOf('bart# Running one')], 'bart# Running one', 'one at work stays open');
  assert.equal(ls[lines.indexOf('bart#+ Folded already')], 'bart#+ Folded already');
  assert.equal(ls[lines.indexOf('bart# ')], 'bart#+', 'one still being named collapses to its question');
  assert.ok(!ls.some((l) => /^bart\+>/.test(l)), 'an untitled conversation is not folded');
  assert.deepEqual(m.editor.history || [], [], 'not an edit to undo');
  // Opened again by hand, it stays open while the document is shown; another document, then this one, collapses it again.
  m.click('foldthread', { row: '0' });
  m.editor.componentDidUpdate({}, m.editor.state);
  assert.equal(m.lines()[0], 'bart# [chat 2026-10-12T21:41:00Z] Retry logic');
  m.props.docKey = 'other'; m.editor.componentDidUpdate({}, m.editor.state);
  m.props.docKey = 'k'; m.editor.componentDidUpdate({}, m.editor.state);
  assert.equal(m.lines()[0], 'bart#+ [chat 2026-10-12T21:41:00Z] Retry logic');

  // Not loaded yet: it waits for the text, then collapses.
  const later = mounted([], { autoCollapse: true });
  later.props.text = undefined; later.editor.autoFolded = undefined;
  later.editor.componentDidUpdate({}, later.editor.state);
  assert.equal(later.changes.length, 0);
  later.props.text = lines.join('\n'); later.editor.componentDidUpdate({}, later.editor.state);
  assert.equal(later.lines()[0], 'bart#+ [chat 2026-10-12T21:41:00Z] Retry logic');

  for (const extra of [{}, { autoCollapse: true, readOnly: true }]) {
    const n = mounted(lines, extra);
    assert.equal(n.changes.length, 0, JSON.stringify(extra));
    assert.equal(n.lines()[0], lines[0]);
  }
});

test('a follow-up collapses the turns before it, in the same edit; each is one read-only row, its question cut to one line with Expand (2026-10-13)', () => {
  const long = 'and timeouts, and what happens when the server answers slowly but never quite fails, and whether the retry budget should be shared across every request of a session?';
  const lines = ['bart# [chat 2026-10-12T21:41:00Z] Retry logic', '@chat why retry?', ...answer('because'), `@chat ${long}`, ...answer('those too'), ''];
  const second = lines.indexOf(`@chat ${long}`);
  for (const routed of [false, true]) {
    const m = mounted(lines);
    if (routed) m.props.onRoute = () => new Promise(() => {});
    const undo = m.editor.history.length;
    m.editor.followText.set(1, 'and backoff?');
    m.editor.sendFollow(1);
    const ls = m.lines(), tag = routed ? 'routed' : 'asked';
    assert.equal(m.editor.history.length, undo + 1, `${tag}: one edit, one undo`);
    assert.ok(ls.slice(2, second).every((l) => /^bart\+>/.test(l)) && ls.slice(second + 1, second + 1 + answer('x').length).every((l) => /^bart\+>/.test(l)), `${tag}: both earlier answers collapsed`);
    assert.equal(ls[0], lines[0], `${tag}: the conversation stays open`);
    assert.match(ls[second + 1 + answer('x').length], routed ? /^@bart and backoff\?$/ : /^@chat and backoff\?$/, `${tag}: the follow-up under them`);
    const html = m.html(), drawn = html.replace(/ data-raw="[^"]*"/g, '');
    assert.ok(!drawn.includes('because') && !drawn.includes('those too'), `${tag}: the earlier answers are not drawn`);
    for (const q of [1, second]) {
      const row = rowOf(html, q), open = row.slice(0, row.indexOf('>') + 1);
      assert.match(open, /contenteditable="false" data-readonly="1" data-folded-row="\d+" data-act="fold" data-turn="\d+"/, `${tag}: question ${q} is a read-only row a click expands`);
      assert.match(open, /cursor:pointer;display:flex;align-items:center/, `${tag}: one row`);
      assert.match(open, /background:#fafafa;[^"]*font:14px\/1\.5 var\(--font-sans\);color:#7a7a7a/, `${tag}: on the card, grey, 14px`);
      assert.match(row, /<span style="flex:none;display:inline-flex;color:#a3a3a3"><svg width="14"[^>]*><path d="m9 18 6-6-6-6">/, `${tag}: a chevron first`);
      assert.match(row, /<span class="t" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">/, `${tag}: its question on one line, cut off`);
      assert.ok(!row.includes('<button') && !/@(chat|bart)/.test(row.replace(/ data-raw="[^"]*"/, '')), `${tag}: no Expand button, no @bart`);
      assert.ok(!row.includes('editturn') && !row.includes('data-chip') && !row.includes('data-corner'), `${tag}: no edit, chip or corner Collapse`);
      assert.ok(!html.includes(`data-foot="${q}"`), `${tag}: no foot drawn for ${q}`);
    }
    assert.ok(rowOf(html, 1).includes('why retry?') && rowOf(html, second).includes('and timeouts, and what happens'), `${tag}: the questions, as said`);
    const asked = second + 1 + answer('x').length;
    assert.match(rowOf(html, asked), /padding:0px 16px 0px;background:#fafafa;border-radius:0 0 0 0/, `${tag}: the new question goes on in the same card`);
    // Folded lines at the top of the card, 6px apart, then 18px to the question.
    assert.match(rowOf(html, 1).slice(0, 600), /padding:14px 16px 6px;background:#fafafa;border-radius:10px 10px 0 0/, `${tag}: the first at the card's top, 6px under it`);
    assert.match(rowOf(html, second).slice(0, 600), /padding:0px 16px 18px/, `${tag}: 18px under the last`);
    assert.ok(html.indexOf(`data-line="${second}"`) < html.indexOf(`data-line="${asked}"`));
  }
  // The foot rows of the folded turns are hidden; their lines stay in the file.
  const m = mounted(lines);
  m.editor.followText.set(1, 'and backoff?');
  m.editor.sendFollow(1);
  const html = m.html();
  for (const foot of [1 + answer('x').length, second + answer('x').length]) assert.match(rowOf(html, foot), /^<div[^>]*style="display:none"><\/div>$/, `foot line ${foot} hidden`);
  // A click on the row (or its Expand) opens that turn: question, answer and foot again; Expand all opens the rest.
  m.click('fold', { turn: '1' });
  assert.ok(m.lines().slice(2, second).every((l) => /^bart>/.test(l)));
  const open = m.html();
  assert.match(open, /data-act="foldthread" data-row="0" aria-label="Collapse"/, 'open again, its foot collapses the conversation');
  assert.ok(open.includes('because') && open.includes('data-foot="1"'), 'its answer and foot are drawn');
  assert.ok(!rowOf(open, 1).includes('data-folded-row'), 'its question is a question row again');
  assert.ok(rowOf(open, second).includes('data-folded-row'), 'the other stays one row');
  m.props.text = m.props.text.replace(/bart~> \S+/, 'bart> sure').trimEnd() + '\n';
  m.editor.foldAll(false);
  assert.ok(!m.lines().some((l) => /^bart\+>/.test(l)), 'Expand all opens every turn');
  assert.equal(m.lines()[0], lines[0]);
});

test('a line typed and asked right under an answer starts a conversation of its own: an empty line above it, in the same change, then its title line; no earlier turns, and routed with no current agent (2026-10-13)', async () => {
  const { threads } = await doc();
  const card = ['bart# [chat 2026-10-13T09:00:00Z] Retries', '@chat why retry?', ...answer('because')];
  const end = card.length; // where the typed line stands
  for (const typed of ['@bart new', '@chat new']) {
    const routes = [];
    const m = mounted([...card, typed], { onRoute: async (input) => { routes.push(input); return { id: 'r', agent: 'chat', sure: 0.9, by: 'model' }; } });
    m.editor.askInline(end);
    await new Promise((resolve) => setImmediate(resolve));
    const ls = m.lines();
    assert.deepEqual(ls.slice(0, end), card, `${typed}: the card above is as it was`);
    assert.equal(ls[end], '', `${typed}: an empty line above it`);
    assert.match(ls[end + 1], /^bart# \[chat \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/, `${typed}: its own title line`);
    assert.equal(ls[end + 2], typed);
    assert.equal(ls[end + 3], `bart~> ${m.asks[0].askId}`);
    assert.deepEqual([m.asks.length, m.asks[0].turns, m.asks[0].name, m.asks[0].place], [1, [], true, { line: end + 2, text: typed }]);
    assert.deepEqual(threads(ls).map((t) => [t.from, t.turns.length]), [[1, 1], [end + 2, 1]], `${typed}: two conversations`);
    if (typed === '@bart new') {
      assert.equal(routes.length, 1);
      assert.equal(routes[0].current, null, 'routed as a line that starts a conversation');
      assert.deepEqual(routes[0].place, { line: end + 1, text: typed });
    } else assert.equal(m.changes.length, 1, 'the empty line, the title line and the pending line in one change (one undo)');
  }
});

test('the reply field still adds a follow-up to the card: one conversation of two turns; a typed line with an empty line or text above it is asked as before', async () => {
  const { threads } = await doc();
  const card = ['bart# [chat 2026-10-13T09:00:00Z] Retries', '@chat why retry?', ...answer('because'), ''];
  const f = mounted(card);
  f.editor.followText.set(1, 'and timeouts?');
  f.editor.sendFollow(1);
  const placed = f.lines().map((l) => (l === `bart~> ${f.asks[0].askId}` ? answer('this') : [l])).flat();
  assert.deepEqual(threads(placed).map((t) => t.turns.length), [2]);
  assert.equal(f.asks[0].turns.length, 1);
  // An empty line above it: no second one is put in.
  const gap = mounted(['@chat why retry?', ...answer('because'), '', '@chat new']);
  const at = gap.lines().length - 1;
  gap.editor.askInline(at);
  assert.equal(gap.lines()[at - 1], '', 'one empty line, as before');
  assert.match(gap.lines()[at], /^bart# /);
  assert.notEqual(gap.lines()[at - 2], '', 'not two');
  assert.equal(gap.lines()[at + 1], '@chat new');
  // Text above it: asked under it as before.
  const text = mounted(['Notes', '@chat new']);
  text.editor.askInline(1);
  assert.deepEqual([text.lines()[0], text.lines()[2]], ['Notes', '@chat new']);
});

/* ------------------------------------------- a Build's conversation (2026-10-13) */

// A `--build` line asked from the document starts a conversation, as a question does: its title line, marked a Build's,
// named from what it asks to build (Workspace askBart); its Build's card is its answer, and it collapses once the Build is
// finished (accepted, discarded, failed or stopped), never while it runs or waits in review.
const BUILT = 'abc0123456';
const task = (status, extra = {}) => ({ id: BUILT, status, title: 'Make X', model: 'opus', effort: 'high', messages: [], final: status === 'accepted' || status === 'discarded', ...extra });
const BUILD_DOC = ['Notes', 'bart# [chat build 2026-10-13T09:00:00Z] Make X', '@chat --build make X', `build> ${BUILT}`, '', 'After'];

test('@chat --build from the document gets a title line, marked a Build\'s, and is asked to be named; its line is under it', () => {
  const m = mounted(['Notes', '@chat --build make X', 'After']);
  m.editor.askInline(1);
  const ls = m.lines();
  assert.match(ls[1], /^bart# \[chat build \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/, 'as titleLine writes it, with ` build`');
  assert.equal(ls[2], '@chat --build make X');
  assert.match(ls[3], /^bart~> /);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].name, m.asks[0].place], ['bart', '--build make X', true, { line: 2, text: '@chat --build make X' }]);
});

test('@bart --build from the document: Bart\'s --build rule hands it over with a title line above it, and it is named', async () => {
  const m = mounted(['Notes', '@bart --build make X', 'After'], { onRoute: async (input) => ({ id: 'route-b', ...input.rule, sure: 1, by: 'rule' }) });
  m.editor.askInline(1);
  await new Promise((resolve) => setImmediate(resolve));
  const ls = m.lines();
  assert.match(ls[1], /^bart# \[chat build \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/);
  assert.equal(ls[2], '@bart --build make X');
  assert.match(ls[3], /^bart~> /);
  assert.deepEqual([m.asks[0].agent, m.asks[0].name, m.asks[0].place], ['router', true, { line: 2, text: '@bart --build make X' }]);
  // A failed Build ("No Build.") keeps the title it was given.
  const { placeAnswer, placeTitle, askedAt } = await doc();
  const near = askedAt(m.props.text, m.asks[0].askId);
  m.props.text = placeAnswer(m.props.text, m.asks[0].askId, ['bart> **No Build.** It could not start.']);
  m.props.text = placeTitle(m.props.text, m.asks[0].askId, 'Make X', near);
  assert.match(m.lines()[1], /^bart# \[chat build [^\]]+\] Make X$/);
});

test('Workspace askBart names a Build\'s conversation from its request, as Chat\'s, before the Build starts', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  const named = src.indexOf("api.nameChat(build ? { text: build.request || text, agent: 'bart' } : { text, agent: agent || 'bart' })");
  assert.ok(named > 0, 'named from build.request, by Chat\'s namer');
  assert.ok(src.indexOf('const build = buildRequestOf({ agent, text }') < named && named < src.indexOf('const task = await buildFrom(ref, build.request'), 'before the Build branch returns');
});

test('an open Build conversation draws its question and the Build\'s card as before; Collapse waits until the Build is finished', () => {
  for (const [builds, running] of [[{}, true], [{ [BUILT]: task('running') }, true], [{ [BUILT]: task('review') }, true], [{ [BUILT]: task('accepted') }, false], [{ [BUILT]: task('stopped') }, false], [{ [BUILT]: task('failed') }, false]]) {
    const m = mounted(BUILD_DOC, { builds });
    const html = m.html(), said = JSON.stringify(builds[BUILT] && builds[BUILT].status);
    assert.match(rowOf(html, 1), /style="display:none"/, `${said}: open, no title row`);
    const q = rowOf(html, 2);
    assert.match(q, /data-act="ask" data-row="2"/, `${said}: the question keeps its send`);
    assert.match(q, /margin-bottom:8px/, `${said}: the question closes its card, as before`);
    assert.ok(q.includes(`data-act="foldthread" data-row="1" aria-label="Collapse" aria-expanded="true"${running ? ' disabled' : ''}>`), `${said}: the conversation's Collapse`);
    assert.ok(q.includes(running ? 'Collapse once it answers' : '>Collapse<'), said);
    assert.match(rowOf(html, 3), new RegExp(`^<div data-line="3" data-raw="build&gt; ${BUILT}" data-build="${BUILT}"`), `${said}: the card is drawn as a Build's card`);
    assert.ok(!/data-foot|data-follow/.test(html), `${said}: no foot or reply field under it`);
    // toggleThread, Collapse all: only once the Build is finished.
    m.editor.toggleThread(1);
    assert.equal(m.lines()[1].startsWith('bart#+'), !running, `${said}: its Collapse`);
    const n = mounted(BUILD_DOC, { builds });
    n.editor.foldAll(true);
    assert.equal(n.lines()[1].startsWith('bart#+'), !running, `${said}: Collapse all`);
  }
});

test('a collapsed Build conversation is one row named Build; `bart#+` on one still running is drawn open', () => {
  const folded = BUILD_DOC.map((l, j) => (j === 1 ? l.replace('bart#', 'bart#+') : l));
  const done = mounted(folded, { builds: { [BUILT]: task('accepted') } }), html = done.html();
  assert.match(rowOf(html, 1), /data-thread-row="1"[\s\S]*>Make X<[\s\S]*data-thread-when="1"[^>]*>Build · /);
  for (const i of [2, 3]) assert.match(rowOf(html, i), /^<div[^>]*style="display:none"/, `line ${i} hidden`);
  assert.match(rowOf(html, 5), />After</);
  // The Build's record arriving finished collapses it; one that starts again opens it.
  const later = mounted(folded, { builds: { [BUILT]: task('review') } });
  assert.match(rowOf(later.html(), 1), /style="display:none"/, 'in review: drawn open');
  assert.match(rowOf(later.html(), 3), /data-build=/);
  later.props.builds = { [BUILT]: task('accepted') };
  assert.match(rowOf(later.html(), 1), /data-thread-row/, 'finished: collapsed');
  // An @chat line's: Build too.
  assert.match(rowOf(mounted(['bart#+ [chat build 2026-10-13T09:00:00Z] Make X', '@bart --build make X', `build> ${BUILT}`, ''], { builds: { [BUILT]: task('discarded') } }).html(), 0), /data-thread-when="1"[^>]*>Build · /);
});

test('the editor is drawn again, not patched, when a Build that answers a conversation finishes', () => {
  const m = mounted(BUILD_DOC, { builds: { [BUILT]: task('review') } });
  let synced = 0; m.editor.syncEditor = () => { synced += 1; }; m.editor.patchBuilds = () => true; m.editor.markBeside = () => {};
  const prev = { ...m.props };
  m.props.builds = { [BUILT]: task('review', { messages: [{ role: 'agent', text: 'more' }] }) };
  m.editor.componentDidUpdate(prev, m.editor.state);
  assert.equal(synced, 0, 'still in review: its card is patched');
  const prev2 = { ...m.props };
  m.props.builds = { [BUILT]: task('accepted') };
  m.editor.componentDidUpdate(prev2, m.editor.state);
  assert.equal(synced, 1, 'finished: drawn again');
});

test('shown again, a Build conversation collapses once its Build is finished: not one in review or running; one not loaded yet once it loads', () => {
  const ids = ['a000000001', 'a000000002', 'a000000003'];
  const conv = (id, n) => [`bart# [chat build 2026-10-13T09:00:00Z] Build ${n}`, `@chat --build make ${n}`, `build> ${id}`, ''];
  const lines = [...conv(ids[0], 1), ...conv(ids[1], 2), ...conv(ids[2], 3)];
  const builds = { [ids[0]]: { ...task('accepted'), id: ids[0] }, [ids[1]]: { ...task('review'), id: ids[1] }, [ids[2]]: { ...task('running'), id: ids[2] } };
  const m = mounted(lines, { autoCollapse: true, builds });
  assert.deepEqual([0, 4, 8].map((j) => m.lines()[j].startsWith('bart#+')), [true, false, false]);

  // Shown before the project's Builds have loaded: nothing of them is decided until they have.
  const w = mounted(lines, { autoCollapse: true, builds: {} });
  assert.equal(w.changes.length, 0);
  w.props.builds = builds; w.editor.componentDidUpdate({ ...w.props, builds: {} }, w.editor.state);
  assert.deepEqual([0, 4, 8].map((j) => w.lines()[j].startsWith('bart#+')), [true, false, false]);
  // Expanded by hand afterwards, it stays open.
  w.click('foldthread', { row: '0' });
  w.props.builds = { ...builds }; w.editor.componentDidUpdate({ ...w.props, builds }, w.editor.state);
  assert.equal(w.lines()[0].startsWith('bart#+'), false);
});

test('an older --build line with no title parses and draws as before: no title, no Collapse, nothing for Collapse all', async () => {
  const { threads } = await doc();
  const lines = ['@bart --build x', `build> ${BUILT}`, ''];
  const m = mounted(lines, { builds: { [BUILT]: task('accepted') } });
  const t = threads(lines);
  assert.deepEqual([t.length, t[0].titleLine, t[0].turns[0].build], [1, -1, BUILT]);
  const html = m.html(), q = rowOf(html, 0);
  assert.match(q, /data-act="ask" data-row="0"/);
  assert.ok(!/data-corner|foldthread|data-act="fold"/.test(html), 'no Collapse of any kind');
  assert.match(rowOf(html, 1), /data-build=/);
  assert.deepEqual(m.editor.foldable(m.lines()), []);
  m.editor.foldAll(true);
  assert.deepEqual(m.lines(), lines);
  // A line typed under its card is asked as before: no empty line goes in above it.
  const u = mounted([...lines.slice(0, 2), '@chat next?'], { builds: { [BUILT]: task('accepted') } });
  u.editor.askInline(2);
  assert.equal(u.lines()[2].startsWith('bart#'), true);
  assert.equal(u.lines()[3], '@chat next?');
});

test('revealing a line inside a collapsed conversation expands it first', () => {
  const folded = BUILD_DOC.map((l, j) => (j === 1 ? l.replace('bart#', 'bart#+') : l));
  const m = mounted(folded, { builds: { [BUILT]: task('accepted') } });
  m.editor.scrollRef = { current: { getBoundingClientRect: () => ({ height: 100 }) } };
  m.editor.edRef = { current: { ...m.editor.edRef.current, querySelector: () => ({}) } };
  assert.equal(m.editor.showLine(3), false, 'not on the page yet');
  assert.equal(m.lines()[1], BUILD_DOC[1], 'expanded');
});

test('a Build conversation opened from the Agents dropdown before its record loads stays open when the record arrives', () => {
  // Folded once it finished; revealed from the dropdown, then its record arrives again: it stays open.
  const w = mounted(['Notes', `${BUILD_DOC[1].replace('bart#', 'bart#+')}`, ...BUILD_DOC.slice(2)], { autoCollapse: true, builds: {} });
  w.props.builds = { [BUILT]: task('review') }; w.editor.componentDidUpdate({ ...w.props, builds: {} }, w.editor.state);
  w.editor.edRef = { current: { ...w.editor.edRef.current, querySelector: () => null } };
  w.props.builds = { [BUILT]: task('accepted') };
  assert.equal(w.editor.showLine(3), false);
  assert.equal(w.lines()[1], BUILD_DOC[1], 'expanded to show it');
  w.editor.componentDidUpdate({ ...w.props, builds: { [BUILT]: task('review') } }, w.editor.state);
  assert.equal(w.lines()[1], BUILD_DOC[1], 'left open');
});
