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
    // @discover (2026-10-14): Discover's alone, as any agent's; a research box comes only once it settles the direction.
    assert.equal(ls[4], 'After');
    assert.equal(m.asks.length, 1);
    assert.equal(m.asks[0].agent, agent);
    assert.equal(m.asks[0].name, true);
    assert.equal(m.asks[0].askId, ls[3].slice('bart~> '.length));
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

test('an open titled conversation draws no title row; its question opens the card, rounded; Collapse is in its corner, and on its first exchange it collapses the conversation', () => {
  const lines = ['bart# [chat 2026-10-12T21:41:00Z] Retry logic', '@chat why retry?', ...answer('because'), ''];
  const m = mounted(lines);
  const html = m.html(), head = rowOf(html, 0);
  assert.match(head, /^<div data-line="0" data-raw="[^"]*" contenteditable="false" data-readonly="1" style="display:none"><\/div>$/, 'the title line is in the file, not on the page');
  assert.ok(!/data-title-row|data-thread-row/.test(html));
  assert.ok(!html.replace(/ data-raw="[^"]*"/g, '').includes('Retry logic'), 'the title is not shown');
  assert.match(rowOf(html, 1), /border-radius:10px 10px 0 0/, 'the first question has the card\'s rounded top');
  assert.ok(html.includes('class="bart-fold" data-act="fold" data-turn="1" aria-expanded="true" aria-label="Collapse conversation" title="Collapse conversation"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>'), 'the corner\'s Collapse is the conversation\'s (2026-10-15), the single chevron every exchange has (2026-10-16)');
  assert.ok(!html.includes('m17 11-5-5-5 5'), 'no double chevron');
  assert.ok(!html.includes('data-act="foldthread"'), 'not the conversation\'s');
  assert.deepEqual(m.lines(), lines, 'the `bart#` line is as it was');
  // Its only exchange: Collapse from the foot folds the conversation to one row, a link; an ⌥-click is a click, not a rename.
  m.click('fold', { turn: '1' }, false, { alt: true });
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
  assert.match(link, /class="bart-thread-name"[^>]*text-overflow:ellipsis[^>]*>Retry logic<\/span><\/span><span data-thread-when="1" style="flex:none;margin-left:auto;font:12px\/1 var\(--font-sans\);color:#8f8f8f;white-space:nowrap">9:41 PM<\/span><\/div>$/, 'the title, then on its right when it was asked, never the agent (2026-10-15, David)');
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

  // None says who answered or when (2026-10-15, David), whatever the agent or the day.
  const day = new Date(); day.setDate(day.getDate() - 1); day.setHours(12, 0, 0, 0);
  const iso = day.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const many = mounted([
    `bart#+ [chat build ${iso}] Unaccepted builds check`, '@bart check the builds', ...answer('x'),
    `bart#+ [brainstorm ${iso}] Questions as multi-select`, '@brainstorm a plan', ...answer('x'),
    'bart#+ Papers on assessment', '@discover retries', ...answer('x'),
    `bart#+ [chat ${iso}] Retry logic`, '@chat why?', ...answer('x'), '',
  ]).html();
  // When it was asked, on the right; never the agent (2026-10-15, David: the agent went, the time came back).
  assert.equal((many.match(/<span data-thread-when="1"[^>]*>Yesterday<\/span>/g) || []).length, 3, 'the time on each row that has one');
  assert.ok(!/>Build ·|>Brainstorm ·|>Discover ·|>Chat ·/.test(many), 'no agent on any row');
});

test('a click on an open exchange\'s question collapses nothing (2026-10-16, David; since 2026-10-15 it had): only its Collapse does', () => {
  const plain = mounted(['@chat why retry?', ...answer('because'), '']);
  const row = rowOf(plain.html(), 0);
  assert.ok(!row.includes('data-fold-turn'), 'the question is no button');
  assert.match(row.slice(0, row.indexOf('>')), /cursor:default/);
  plain.editor.editorClick({ target: { closest: () => null }, preventDefault() {} });
  assert.ok(plain.lines().slice(1).every((l) => !/^bart\+>/.test(l)), 'nothing folds');
  assert.match(row, /data-act="fold" data-turn="0" aria-expanded="true" aria-label="Collapse" title="Collapse">/, 'untitled: its own Collapse, the single chevron');
  plain.click('fold', { turn: '0' });
  assert.ok(plain.lines().slice(1, -1).every((l) => /^bart\+>/.test(l)), 'its Collapse folds it');
});

test('a conversation at work collapses all the same (2026-10-15, David): the question at work has the Collapse too, its title row shows it working; `bart#+` on it is drawn collapsed', () => {
  const lines = ['bart# Retry logic', '@chat why retry?', ...answer('because'), '@chat and more?', 'bart~> run1', ''];
  const m = mounted(lines);
  const html = m.html();
  assert.match(html, /class="bart-fold" data-act="fold" data-turn="1" aria-expanded="true" aria-label="Collapse" title="Collapse"><svg[^>]*><path d="m6 9 6 6 6-6"><\/path><\/svg>/, 'while it is at work, the first exchange\'s Collapse is its own (2026-10-16), the single chevron, not disabled');
  assert.ok(!html.includes('Collapse once it answers'));
  const at = lines.indexOf('@chat and more?');
  const alone = mounted(['bart# Retry logic', '@chat why retry?', 'bart~> run1', '']).html();
  assert.match(rowOf(alone, 1), /data-act="foldall" data-turn="1"/, 'a question at work, the only one: its own corner');
  m.click('foldall', { turn: String(at) });
  assert.equal(m.lines()[0], 'bart#+ Retry logic', 'the conversation collapses');
  assert.deepEqual(m.lines().slice(1), lines.slice(1), 'its lines as they were, the one at work too');
  const row = rowOf(m.html(), 0);
  assert.match(row, /data-thread-row/);
  assert.match(row, /data-thread-running="1"/, 'its title row shows it working');
  assert.match(row, /class="bart-thread-name eb-wave"[^>]*text-overflow:ellipsis[^>]*>Retry logic<\/span>/, 'its title in the grey wave of text at work, still cut off with an ellipsis (2026-10-17, David)');
  assert.ok(!row.includes('made-spin') && !row.includes('#0070f3'), 'no blue spinner beside it');
  assert.ok(!row.includes('data-thread-when'), 'no time until it is done');
  assert.match(row, /data-act="foldthread" data-row="0"/, 'a click still expands it');
  m.editor.foldAll(false);
  assert.equal(m.lines()[0], 'bart# Retry logic', 'Expand all opens it');
  m.editor.foldAll(true);
  assert.equal(m.lines()[0], 'bart# Retry logic', 'Collapse all leaves one at work open');
  m.editor.toggleThread(0);
  m.editor.toggleThread(0);
  assert.equal(m.lines()[0], 'bart# Retry logic', 'and its title row opens it again');
  assert.ok(!rowOf(m.html(), 0).includes('data-thread-running'));
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

test('the card (2026-10-13): question 14px 16px, answer 12px under it in a 14px rule, button row 12px 10px 6px 10px (Copy\'s glyph 16px in), the reply field closing it (2026-10-16), 8px under a card; read only, the button row closes it', () => {
  const m = mounted(['@chat first?', ...answer('one'), '@chat second?', ...answer('two'), '']), html = m.html();
  assert.match(rowOf(html, 0), /padding:14px 16px 0px;background:#fafafa;border-radius:10px 10px 0 0/);
  assert.match(rowOf(html, 0), /color:#171717/);
  assert.match(rowOf(html, 1), /padding:12px 16px 0px;[^"]*color:#262626;font-size:16px;line-height:1\.65[^"]*"><span style="display:block;padding:2px 0 2px 14px;border-left:2px solid #d6d6d6"/);
  assert.match(rowOf(html, 4), /padding:14px 16px 0px/, 'a question under an open answer');
  assert.match(html, /padding:12px 10px 6px 10px/);
  assert.ok(!html.includes('data-act="reply"'), 'no Reply');
  assert.match(html, /<div contenteditable="false" data-followup="0" style="user-select:none;padding:4px 10px 10px 16px;background:#fafafa;border-radius:0 0 10px 10px;margin-bottom:8px">/, 'the reply field closes the card');
  assert.ok(html.indexOf('data-followup="0"') > html.indexOf('data-foot="4"'), 'under the last turn\'s button row');
  m.props.readOnly = true;
  const read = m.html();
  assert.ok(!read.includes('data-followup='), 'read only: no field');
  assert.match(read, /padding:12px 10px 10px 10px;background:#fafafa;border-radius:0 0 10px 10px;margin-bottom:8px/, 'the button row closes it');
});

test('the button row (2026-10-13): Copy and Regenerate on the left (no Reply since 2026-10-16); then Delete on the right, the closing line\'s words not drawn (2026-10-15), Collapse being in the question\'s corner (2026-10-15); the closing line is kept', () => {
  const footOf = (html) => { const at = html.indexOf('data-foot='); assert.ok(at >= 0, 'a foot is drawn'); const start = html.lastIndexOf('<div', at); return html.slice(start, html.indexOf('</div>', at) + 6); };
  const shown = (html) => html.replace(/<span class="bart-tip"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').trim();
  for (const [line, closing, meta] of [['@bart make the icons bigger', '*Build · Opus · high · 39 s*', 'Opus · high · 39 s'], ['@chat why retry?', '*Chat · Opus · high · 17 s*', 'Opus · high · 17 s'], ['@bart why retry?', '*Chat · 48 s · via Bart*', '48 s'], ['@chat why retry?', '*Opus · high · 9 s · moved up from Sonnet medium*', 'Opus · high · 9 s']]) {
    const lines = ['bart# [chat 2026-10-12T21:41:00Z] Retry logic', line, 'bart> because', `bart> ${closing}`, ''];
    const m = mounted(lines), foot = footOf(m.html());
    assert.equal(shown(foot), '', `${closing}: no words, not ${meta}`);
    assert.ok(!foot.includes('data-foot-meta'), 'no meta');
    assert.ok(!foot.includes('data-act="reply"'), 'no Reply');
    assert.match(foot, /data-act="copybart" data-turn="1" aria-label="Copy"/, 'Copy');
    assert.match(foot, /data-act="regen" data-turn="1" data-quiet="1" aria-label="Regenerate"/, 'Regenerate, opening no selector on hover (a click opens it, 2026-10-16)');
    assert.ok(!foot.includes('data-act="fold"'), 'no Collapse here');
    assert.match(rowOf(m.html(), 1), /data-corner="1"[^>]*><button type="button" class="bart-fold" data-act="(?:fold" data-turn="1|foldthread" data-row="0)" aria-expanded="true" aria-label="Collapse(?: conversation)?"[^>]*><svg/, 'Collapse, a chevron (2026-10-16), in the question\'s top right');
    assert.match(foot, /data-act="dropturn" data-turn="1" aria-label="Delete"/, 'Delete');
    const order = ['copybart', 'data-act="regen"', 'dropturn'].map((k) => foot.indexOf(k));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'Copy, Regenerate, Delete');
    assert.match(foot, /<span style="margin-left:auto"><\/span><span style="flex:none;position:relative;display:inline-flex;"><button class="bart-ic" data-danger="1" data-act="dropturn"/, 'Delete pushed right');
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
    assert.ok(!m.html().includes('data-act="reply"'), `${line}: no Reply; the field is open`);
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

test('a follow-up collapses the turns before it but the last (2026-10-14: the two newest stay open), in the same edit; each is one read-only row, its question cut to one line with Expand (2026-10-13)', () => {
  const long = 'and timeouts, and what happens when the server answers slowly but never quite fails, and whether the retry budget should be shared across every request of a session?';
  const lines = ['bart# [chat 2026-10-12T21:41:00Z] Retry logic', '@chat why retry?', ...answer('because'), `@chat ${long}`, ...answer('those too'), '@chat and jitter?', ...answer('jitter as well'), ''];
  const second = lines.indexOf(`@chat ${long}`), third = lines.indexOf('@chat and jitter?');
  for (const routed of [false, true]) {
    const m = mounted(lines);
    if (routed) m.props.onRoute = () => new Promise(() => {});
    const undo = m.editor.history.length;
    m.editor.followText.set(1, 'and backoff?');
    m.editor.sendFollow(1);
    const ls = m.lines(), tag = routed ? 'routed' : 'asked';
    assert.equal(m.editor.history.length, undo + 1, `${tag}: one edit, one undo`);
    assert.ok(ls.slice(2, second).every((l) => /^bart\+>/.test(l)) && ls.slice(second + 1, third).every((l) => /^bart\+>/.test(l)), `${tag}: the two oldest answers collapsed`);
    assert.ok(ls.slice(third + 1, third + 1 + answer('x').length).every((l) => /^bart>/.test(l)), `${tag}: the one before the follow-up stays open`);
    assert.equal(ls[0], lines[0], `${tag}: the conversation stays open`);
    assert.match(ls[third + 1 + answer('x').length], routed ? /^@bart and backoff\?$/ : /^@chat and backoff\?$/, `${tag}: the follow-up under them`);
    const html = m.html(), drawn = html.replace(/ data-raw="[^"]*"/g, '');
    assert.ok(!drawn.includes('because') && !drawn.includes('those too') && drawn.includes('jitter as well'), `${tag}: the older answers are not drawn; the last is`);
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
    const asked = third + 1 + answer('x').length;
    assert.match(rowOf(html, asked), /padding:\d+px 16px 0px;background:#fafafa;border-radius:0 0 0 0/, `${tag}: the new question goes on in the same card, under the open turn`);
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
  assert.match(rowOf(open, 1), /data-corner="1"[^>]*><button type="button" class="bart-fold" data-act="fold" data-turn="1" aria-expanded="true" aria-label="Collapse" title="Collapse"><svg/, 'open again, its question\'s corner folds it alone while the follow-up is at work (2026-10-16)');
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

test('an @bart line is handed on in the document it was typed in, after the editor has gone to another one while Bart routed (2026-10-16: it was left "interrupted")', async () => {
  let pick = null;
  const gone = [], awayAsks = [], awayChanges = [];
  const m = mounted(['@bart what is a tutor'], { onRoute: () => new Promise((resolve) => { pick = resolve; }), docTextOf: (key) => (key === 'k' ? m.props.text : 'another workspace'), onRouteGone: (id) => gone.push(id) });
  m.editor.askInline(0);
  const typed = m.props;
  // Another workspace's document in the same editor, as React gives it: new props, with that document's callbacks.
  m.editor.props = { ...typed, docKey: 'other', text: 'another workspace', onChange: (t) => awayChanges.push(t), onAsk: (a) => awayAsks.push(a) };
  pick({ id: 'r', agent: 'chat', sure: 0.9, by: 'model' });
  await new Promise((resolve) => setImmediate(resolve));
  const ls = typed.text.split('\n');
  assert.deepEqual(gone, [], 'not taken for a deleted line');
  assert.deepEqual([m.asks.length, m.asks[0].agent, m.asks[0].text], [1, 'bart', 'what is a tutor'], 'asked of Chat, by the document it was typed in');
  assert.match(ls[0], /^bart# \[chat \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/, 'its title line, in that document');
  assert.deepEqual(ls.slice(1, 3), ['@bart what is a tutor', `bart~> ${m.asks[0].askId}`]);
  assert.deepEqual([awayAsks.length, awayChanges.length], [0, 0], 'the document shown now is left alone');
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
  assert.ok(src.includes("api.nameChat(build ? { text: build.request || text, agent: 'bart' } : { text: said, agent: agent || 'bart' })"), 'named from build.request, by Chat\'s namer');
  assert.ok(src.includes('const later = name && !build && '), 'a Build is never one named later, from its answer');
  const named = src.indexOf('if (name && !later && !ownTopic) nameAs(text);');
  assert.ok(named > 0, 'named at once');
  assert.ok(src.indexOf('const build = buildRequestOf({ agent, text }') < named && named < src.indexOf('const task = await buildFrom(ref, request, routed && routed.id, typed'), 'before the Build branch returns');
});

test('Workspace askBart names a conversation an empty line started from its first answer, not "New conversation" (2026-10-14); a Brainstorm one names its own topic (test/brainstorm-topic.test.cjs)', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  const placed = src.indexOf("place(out.stopped ? (research ? ['bart> Stopped.'] : []) : box ? [...out.lines, box.line, ...(refine ? [] : [`bart~> ${box.askId}`])] : out.lines);");
  const later = src.indexOf("if (later && !ownTopic && !ownDirection) nameAs(out.stopped ? '' : answerText(out.lines));");
  assert.ok(placed > 0 && later > placed, 'named once its answer is placed');
  // A Discover conversation (2026-10-14) is named from the direction it settles, while it has no title (retitle's `unset`).
  assert.ok(src.includes("const ownDirection = agent === 'discover' && !build;") && src.includes('if (box && ownDirection) nameDirection(out.research);'));
  assert.ok(src.includes("api.nameChat({ text: said, agent: 'discover' })") && src.includes('retitle(held, answered, named.title, { unset: true })'));
  assert.ok(src.indexOf("if (later && !ownTopic) nameAs('');") > later, 'a failed run still gets its title line filled');
});

test('an open Build conversation draws its question and the Build\'s card in one card (MATH-161); Collapse waits until the Build is finished', () => {
  for (const [builds, running] of [[{}, true], [{ [BUILT]: task('running') }, true], [{ [BUILT]: task('review') }, true], [{ [BUILT]: task('accepted') }, false], [{ [BUILT]: task('stopped') }, false], [{ [BUILT]: task('failed') }, false]]) {
    const m = mounted(BUILD_DOC, { builds });
    const html = m.html(), said = JSON.stringify(builds[BUILT] && builds[BUILT].status);
    assert.match(rowOf(html, 1), /style="display:none"/, `${said}: open, no title row`);
    const q = rowOf(html, 2);
    assert.ok(!/data-act="ask"|data-act="pick"/.test(q), `${said}: no model picker or send (MATH-161: the Build's head says its model)`);
    assert.match(q, /margin-bottom:0/, `${said}: the card goes on into the Build`);
    assert.ok(q.includes(`class="bart-fold" data-act="foldthread" data-row="1" aria-expanded="true" aria-label="Collapse"${running ? ' disabled title="Collapse once it answers"' : ' title="Collapse"'}><svg`), `${said}: the conversation's Collapse`);
    assert.match(rowOf(html, 3), new RegExp(`^<div data-line="3" data-raw="build&gt; ${BUILT}" data-build="${BUILT}"[^>]*data-build-joined="2"`), `${said}: the Build's card, the conversation's last part`);
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
  assert.match(rowOf(html, 1), /data-thread-row="1"[\s\S]*>Make X</);
  for (const i of [2, 3]) assert.match(rowOf(html, i), /^<div[^>]*style="display:none"/, `line ${i} hidden`);
  assert.match(rowOf(html, 5), />After</);
  // The Build's record arriving finished collapses it; one that starts again opens it.
  const later = mounted(folded, { builds: { [BUILT]: task('review') } });
  assert.match(rowOf(later.html(), 1), /style="display:none"/, 'in review: drawn open');
  assert.match(rowOf(later.html(), 3), /data-build=/);
  later.props.builds = { [BUILT]: task('accepted') };
  assert.match(rowOf(later.html(), 1), /data-thread-row/, 'finished: collapsed');
  // An @chat line's: Build too.
  assert.match(rowOf(mounted(['bart#+ [chat build 2026-10-13T09:00:00Z] Make X', '@bart --build make X', `build> ${BUILT}`, ''], { builds: { [BUILT]: task('discarded') } }).html(), 0), /data-thread-row="0"[\s\S]*>Make X</);
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
  assert.ok(!/data-act="ask"/.test(q), 'no send: its Build joins its card (MATH-161)');
  assert.ok(!/data-corner|foldthread|data-act="fold"/.test(html), 'no Collapse of any kind');
  assert.match(rowOf(html, 1), /data-build=[^>]*data-build-joined="0"/);
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

// A drawn line `i` and a pane to centre it in: the line's element keeps its attributes, applyView records where it went.
function drawnLine(m, i) {
  const attrs = new Map(), views = [];
  const el = { isConnected: true, offsetWidth: 0, getBoundingClientRect: () => ({ height: 20 }), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k) };
  m.editor.scrollRef = { current: { closest: () => null, getBoundingClientRect: () => ({ height: 400 }) } };
  m.editor.edRef = { current: { ...m.editor.edRef.current, querySelector: (sel) => (sel === `[data-line="${i}"]` ? el : null) } };
  m.editor.applyView = (pos) => views.push(pos);
  return { el, views };
}

test('showLine centres a drawn line and lights it up; with flash: false it centres it without the light', () => {
  const m = mounted(['Notes', '@chat why?', 'After']);
  const lit = drawnLine(m, 2);
  assert.equal(m.editor.showLine(2), true);
  assert.equal(lit.el.hasAttribute('data-ask-flash'), true, 'lit up, as before');
  assert.deepEqual([lit.views.length, lit.views[0].line, lit.views[0].offset], [1, 2, -190]);

  const n = mounted(['Notes', '@chat why?', 'After']);
  const quiet = drawnLine(n, 2);
  assert.equal(n.editor.showLine(2, { flash: false }), true);
  assert.equal(quiet.el.hasAttribute('data-ask-flash'), false, 'no light');
  assert.deepEqual([quiet.views.length, quiet.views[0].line, quiet.views[0].offset], [1, 2, -190], 'centred all the same');
  assert.equal(n.editor.settle.pos.line, 2, 'held there as before');
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

test('three turns: the follow-up that makes the third collapses the first and leaves the second open; the one that makes the second collapses nothing (2026-10-14)', () => {
  const two = ['bart# [chat 2026-10-14T21:41:00Z] Retry logic', '@chat why retry?', ...answer('because'), '@chat and backoff?', ...answer('backoff too'), ''];
  const m = mounted(two), second = two.indexOf('@chat and backoff?');
  m.editor.followText.set(1, 'and jitter?');
  m.editor.sendFollow(1);
  const ls = m.lines();
  assert.ok(ls.slice(2, second).every((l) => /^bart\+>/.test(l)), 'the first collapsed');
  assert.ok(ls.slice(second + 1, second + 1 + answer('x').length).every((l) => /^bart>/.test(l)), 'the second open');
  assert.equal(ls[second + 1 + answer('x').length], '@chat and jitter?');
  const one = ['bart# [chat 2026-10-14T21:41:00Z] Retry logic', '@chat why retry?', ...answer('because'), ''];
  const n = mounted(one);
  n.editor.followText.set(1, 'and backoff?');
  n.editor.sendFollow(1);
  assert.ok(n.lines().slice(2, 2 + answer('x').length).every((l) => /^bart>/.test(l)), 'two turns: nothing collapsed');
});

test('a click that expands a collapsed conversation, or its last exchange, shows its reply field, with the keyboard in it when it is in sight (2026-10-15; the pane stays put, 2026-10-16); an earlier exchange focuses nothing', () => {
  const field = (m) => { const at = /data-follow-input="(\d+)"/.exec(m.html()); return at ? Number(at[1]) : null; };
  const focusing = (m) => {
    const input = { focused: 0, focus() { input.focused += 1; } };
    m.editor.edRef.current.querySelector = (sel) => (/data-follow-input/.test(sel) ? input : null);
    return input;
  };
  // A conversation collapsed to its title's row: expanded, its field is drawn, and takes the keyboard once the document has changed.
  const m = mounted(['bart#+ Retry logic', '@chat why retry?', ...answer('because'), '']);
  assert.equal(field(m), null, 'collapsed: no field');
  const input = focusing(m);
  m.click('foldthread', { row: '0' });
  assert.equal(m.lines()[0], 'bart# Retry logic', 'expanded');
  assert.notEqual(field(m), null, 'its reply field is drawn');
  m.editor.focusReplyAfter();
  assert.equal(input.focused, 1, 'the keyboard is in it');
  m.editor.focusReplyAfter();
  assert.equal(input.focused, 1, 'once');
  // Out of sight below the pane (a long conversation, 2026-10-16): drawn, but the pane stays where it was and no keyboard.
  const far = mounted(['bart#+ Retry logic', '@chat why retry?', ...answer('because'), '']);
  const below = focusing(far);
  below.getBoundingClientRect = () => ({ top: 2400, bottom: 2440 });
  far.editor.scrollRef.current = { ...far.editor.scrollRef.current, scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 700 }) };
  far.click('foldthread', { row: '0' });
  assert.notEqual(field(far), null, 'its reply field is drawn');
  far.editor.focusReplyAfter();
  assert.deepEqual([below.focused, far.editor.scrollRef.current.scrollTop], [0, 0], 'not focused, not scrolled to');
  // Its last exchange folded on its own: the same.
  const turn = mounted(['@chat why retry?', ...answer('because').map((l) => l.replace(/^bart>/, 'bart+>')), '']);
  const typed = focusing(turn);
  turn.click('fold', { turn: '0' });
  assert.notEqual(field(turn), null);
  turn.editor.focusReplyAfter();
  assert.equal(typed.focused, 1);
  // An earlier exchange expanded focuses nothing: the field, there all along, is the conversation's last exchange's.
  const two = mounted(['bart# Retry logic', '@chat why retry?', ...answer('because').map((l) => l.replace(/^bart>/, 'bart+>')), '@chat and more?', ...answer('more'), '']);
  two.click('fold', { turn: '1' });
  assert.equal(two.html().indexOf('data-follow-input') > two.html().indexOf('data-foot="' + (2 + answer('x').length) + '"'), true, 'under the last exchange');
  assert.equal(field(two), 1, 'the field, always open at the bottom (2026-10-16), is the conversation\'s, not opened by the click');
  assert.equal(two.editor.replyFocus, null);
});

test('a question asked on a line: once answered, its reply field is under it, with the keyboard in it while the person is still on it: not when they typed or went to another field meanwhile (2026-10-15; 2026-10-16)', () => {
  const run = (meanwhile) => {
    const m = mounted(['@chat why retry?', '']);
    const input = { focused: 0, focus() { input.focused += 1; } };
    m.editor.edRef.current.querySelector = (sel) => (/data-follow-input/.test(sel) ? input : null);
    m.editor.askInline(0);
    const pending = m.lines().findIndex((l) => l.startsWith('bart~> '));
    m.editor.replyArrived();
    assert.ok(m.editor.replyWait, 'waiting while it runs');
    if (meanwhile) meanwhile(m.editor);
    m.props.text = m.lines().map((l, j) => (j === pending ? answer('because').join('\n') : l)).join('\n');
    m.editor.replyArrived();
    return { m, input, field: /data-follow-input="\d+"/.test(m.html()) };
  };
  const still = run();
  assert.ok(still.field, 'its reply field is drawn');
  assert.equal(still.input.focused, 1, 'nothing touched since: the keyboard is in it');
  assert.equal(still.m.editor.replyWait, null);
  // Somewhere else meanwhile (2026-10-16, David: "assuming I'm not somewhere else working on something else").
  const elsewhere = { closest: () => null };
  for (const [why, meanwhile] of [['typed', (ed) => { ed.keyedAt = Date.now() + 1; }], ['in another field', () => { globalThis.document.activeElement = elsewhere; }]]) {
    const moved = run(meanwhile);
    globalThis.document.activeElement = null;
    assert.ok(moved.field, `${why}: the field is still drawn`);
    assert.equal(moved.input.focused, 0, `${why}: the keyboard stays where they put it`);
  }
  // Scrolled while reading it: still on it, the field takes the keyboard where the pane is (it is in sight here).
  const read = run((ed) => { ed.wheelAt = Date.now() + 1; });
  assert.equal(read.input.focused, 1, 'scrolled: the keyboard is in it all the same');
  // A follow-up sent from the reply field waits for its answer as a line asked does (2026-10-16, David; Discover's alone before).
  const m = mounted(['@chat why retry?', ...answer('because'), '']);
  m.editor.followText.set(0, 'and timeouts?'); m.editor.sendFollow(0);
  assert.ok(m.editor.replyWait, 'waiting for its answer');
});
