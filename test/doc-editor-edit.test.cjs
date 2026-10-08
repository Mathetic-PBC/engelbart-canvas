'use strict';

// Editing a past question in place (src/renderer/workspace/DocEditor.jsx, 2026-10-03). An answered @bart, @brainstorm or
// @discover turn's foot has Edit, beside Regenerate: the question becomes an ordinary agent line again (lockedAt), its
// answer dimmed under it. Enter asks it again as Regenerate does, after the turns that follow it in its thread are taken
// out; unchanged, Enter only leaves edit mode. Escape, or the caret, the keyboard or a click going elsewhere, puts it back.
// One undo brings back the question, its answer and the turns taken out. There is no document here: the editor and its
// elements are stand-ins, as in doc-editor-cards.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const card = require('../src/main/bart/card.cjs');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-edit-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const MODELS = normalizeModels(null);
// An answer as the runner writes it under its line: its text, an empty line, the foot naming who answered.
const answer = (text, name = 'Sonnet', effort = 'high') => replyLines([text], { level: { name, effort }, trail: [], ms: 3000 }, { model: true });
const plainAnswer = (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false });
const FOCUS = { say: '', card: 'focus', focus: { title: 'Which part?', options: [{ label: 'Retries' }, { label: 'Timeouts' }] }, ready: false };

// One thread of four turns, the last still at work, then a line of the document's own.
const THREAD = [
  'Notes',
  '@bart first?', ...answer('one'), //          1..4
  '@bart second?', ...answer('two'), //         5..8
  '@bart third?', ...answer('three', 'Opus', 'low'), // 9..12
  '@bart fourth?', 'bart~> run4', //            13..14
  '',
  'After',
];

/**
 * An editor as mounted on `lines`. `deferred`: props.text does not change when the editor writes, as in the app, where
 * the parent hands the new text back on its next render; `hand()` does that.
 */
function mounted(lines, { models = MODELS, deferred = false, readOnly = false } = {}) {
  const asks = [], stopped = [], changes = [];
  const props = { docKey: 'k', text: lines.join('\n'), models, readOnly, onChange: (next) => { changes.push(next); if (!deferred) props.text = next; }, onAsk: (ask) => asks.push(ask), onStopAsk: (id) => stopped.push(id) };
  const editor = new DocEditor(props);
  // Each line's row holds the nodes put in `inside` for it; a selection is in a row when both its ends are.
  const inside = new Map();
  const row = (i) => ({ dataset: { line: String(i) }, contains: (node) => (inside.get(i) || []).includes(node) });
  const root = {
    blurred: 0,
    closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() { root.blurred += 1; }, contains: () => false,
    querySelector: (sel) => { const m = sel.match(/^\[data-line="(\d+)"\]$/); return m ? row(Number(m[1])) : null; },
  };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  let selection = { isCollapsed: true, rangeCount: 0 };
  globalThis.getSelection = () => selection;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const lines_ = () => editor.lines();
  // The caret, as the editor reads it from the page.
  const caretAt = (line, offset = lines_()[line].length) => { editor.caretInfo = () => ({ anchor: { line, offset }, focus: { line, offset } }); };
  const key = (k, extra = {}) => {
    const e = { key: k, shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    editor.editorKey(e);
    return e;
  };
  // A click on a button the editor drew, in line `line` (a foot that is the answer's closing line) or in none.
  const click = (act, data = {}, line = null) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, ...data } } : sel === '[data-line]' && line != null ? row(line) : null) }, preventDefault() {} });
  // Typing into the question being edited: its line is written as editorInput writes it.
  const type = (text) => { const q = editor.editing.q; caretAt(q); editor.writeText(q, text, { line: q, offset: text.length }); };
  // The selection moves to `node` (put in line `line`'s row, or in none) and the browser says so.
  const select = (node, line = null) => {
    if (line != null) inside.set(line, [...(inside.get(line) || []), node]);
    selection = { isCollapsed: true, rangeCount: 1, getRangeAt: () => ({ startContainer: node, endContainer: node }), anchorNode: node };
    editor.docListeners.selectionchange();
  };
  const hand = () => { props.text = changes[changes.length - 1]; };
  return { editor, props, asks, stopped, changes, root, caretAt, key, click, type, select, hand, lines: lines_, html: () => editor.editorHtml() };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('Edit sits in an answered turn\'s foot next to Regenerate; never on a run at work, a Build line or a card', () => {
  const m = mounted(THREAD);
  const shown = m.html();
  for (const q of [1, 5, 9]) {
    const foot = shown.slice(shown.indexOf(`data-act="regen" data-turn="${q}"`));
    const at = (act) => foot.indexOf(`data-act="${act}" data-turn="${q}"`);
    assert.ok(at('editturn') > 0 && at('editturn') < at('fold'), `turn ${q}: Edit after Regenerate, before Collapse`);
  }
  assert.match(shown, /<button class="bart-ic" data-act="editturn" data-turn="5" aria-label="Edit"><svg[^>]*>.*?<\/svg><\/button><span class="bart-tip" style="left:0">Edit<\/span>/, 'a pencil, named Edit on hover');
  assert.ok(!shown.includes('data-act="editturn" data-turn="13"'), 'not on the turn still at work');

  // A Build line (`@bart --build`), whether it started its Build or failed to, and a card's turn.
  const build = mounted(['@bart --build make it', 'build> 0123456789', '', '@bart --build', 'bart> **No Build.** Write what to build after --build.', '']).html();
  assert.ok(build.includes('data-act="dropturn" data-turn="3"'), 'the failed Build has its foot');
  assert.ok(!build.includes('data-act="editturn"'), 'but no Edit');
  const cards = mounted(['@brainstorm', ...replyLines(card.cardBody(JSON.stringify(FOCUS)).body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false }), '']).html();
  assert.ok(cards.includes('data-act="regen" data-plain="1" data-turn="0"') && !cards.includes('data-act="editturn"'), 'an @brainstorm card\'s turn has Regenerate but no Edit');
  // An @discover guide and a @brainstorm recap are answers like @bart's: they have it. A read-only document has none.
  assert.ok(mounted(['@discover retries', ...plainAnswer('## Read'), '']).html().includes('data-act="editturn" data-turn="0"'));
  assert.ok(mounted(['@brainstorm (wrap up)', ...plainAnswer('Where you are: x'), '']).html().includes('data-act="editturn" data-turn="0"'));
  assert.ok(!mounted(THREAD, { readOnly: true }).html().includes('data-act="editturn"'));
});

test('Edit unlocks the question alone (lockedAt), caret at its end, chip and send back, its answer dimmed; one question at a time', () => {
  const m = mounted(THREAD);
  assert.equal(m.editor.lockedAt(m.lines(), 5), true, 'an answered question is locked');
  m.click('editturn', { turn: '5' });
  assert.deepEqual([m.editor.editing.q, m.editor.editing.original], [5, '@bart second?']);
  assert.equal(m.editor.lockedAt(m.lines(), 5), false, 'not while it is edited');
  assert.equal(m.editor.lockedAt(m.lines(), 1), true, 'the others stay locked');
  assert.equal(m.editor.lockedAt(m.lines(), 9), true);
  assert.equal(m.editor.state.activeLine, 5);
  assert.deepEqual(m.editor.caret, { line: 5, offset: '@bart second?'.length });
  assert.equal(m.lines().join('\n'), THREAD.join('\n'), 'the line holds its @bart as it did');

  const shown = m.html(), line = shown.match(/<div data-line="5"[^>]*>.*?(?=<div data-dim="1" data-line="6")/s)[0];
  const open = line.match(/^<div[^>]*>/)[0];
  assert.ok(open.includes('data-editing="1"') && !open.includes('contenteditable="false"'), 'an ordinary line');
  assert.ok(line.includes('data-act="pick" data-row="5"') && line.includes('data-act="ask" data-row="5"'), 'with its model chip and send');
  for (const i of [6, 7, 8]) assert.match(shown, new RegExp(`<div data-dim="1" data-line="${i}"`), `answer line ${i} dimmed`);
  assert.ok(!/<div data-dim="1" data-line="(5|9|10)"/.test(shown), 'nothing else dimmed');

  // Edit on another turn: this one goes back, that one is edited.
  m.type('@bart second, changed?');
  m.click('editturn', { turn: '9' });
  assert.equal(m.editor.editing.q, 9);
  assert.equal(m.lines()[5], '@bart second?');
  assert.equal(m.editor.lockedAt(m.lines(), 5), true);
  assert.equal(m.editor.lockedAt(m.lines(), 9), false);
});

test('Enter on changed words: the later turns go (a run among them is stopped), the answer becomes a pending run of the new words, earlier turns go as the conversation; one undo brings it all back', () => {
  const m = mounted(THREAD);
  m.editor.history.push({ text: 'an earlier version', caret: null }); // an edit made before: undo reaches it after
  m.click('editturn', { turn: '5' });
  m.type('@bart second, reworded');
  m.type('@bart second, reworded?');
  const e = m.key('Enter');
  assert.equal(e.prevented, true);
  assert.equal(m.asks.length, 1);
  const ask = m.asks[0];
  assert.deepEqual({ ...ask, askId: undefined }, { askId: undefined, text: 'second, reworded?', turns: [{ question: 'first?', answer: 'one' }], agent: 'bart', choice: { model: 'sonnet', effort: 'high' } }, 'asked with the new words, the turn before it, and the model that answered it (ranWith)');
  assert.deepEqual(m.stopped, ['run4'], 'the follow-up at work is stopped');
  assert.deepEqual(m.lines(), ['Notes', '@bart first?', ...answer('one'), '@bart second, reworded?', `bart~> ${ask.askId}`, '', 'After']);
  assert.equal(m.editor.editing, null);
  assert.equal(m.editor.lockedAt(m.lines(), 5), true, 'locked again, under its run');
  assert.ok(m.root.blurred > 0, 'the keyboard leaves the line, as after asking');

  m.editor.undo();
  assert.equal(m.lines().join('\n'), THREAD.join('\n'), 'one undo: the old question, its answer and the turns after it');
  m.editor.undo();
  assert.equal(m.props.text, 'an earlier version', 'the words typed while editing are not steps of their own');
});

test('Enter on the thread\'s last turn asks it again with nothing taken out; Enter on the first takes every other turn', () => {
  const last = mounted(['@bart one?', ...answer('1'), '@bart two?', ...answer('2'), '']);
  last.click('editturn', { turn: '4' });
  last.type('@bart two, again?');
  last.key('Enter');
  assert.deepEqual(last.lines(), ['@bart one?', ...answer('1'), '@bart two, again?', `bart~> ${last.asks[0].askId}`, '']);
  assert.deepEqual(last.asks[0].turns, [{ question: 'one?', answer: '1' }]);

  const first = mounted(THREAD);
  first.click('editturn', { turn: '1' });
  first.type('@bart first, really?');
  first.key('Enter');
  assert.deepEqual(first.lines(), ['Notes', '@bart first, really?', `bart~> ${first.asks[0].askId}`, '', 'After']);
  assert.deepEqual(first.asks[0].turns, [], 'no conversation before the first turn');
});

test('Enter with the words unchanged leaves edit mode and asks nothing; Shift+Enter adds no line', () => {
  const m = mounted(THREAD);
  m.click('editturn', { turn: '5' });
  m.type('@bart second?!');
  m.caretAt(5);
  const shift = m.key('Enter', { shiftKey: true });
  assert.equal(shift.prevented, true, 'no line break');
  assert.equal(m.editor.editing.q, 5, 'still editing');
  assert.equal(m.lines().length, THREAD.length);
  m.type('@bart second?');
  m.key('Enter');
  assert.equal(m.editor.editing, null);
  assert.deepEqual(m.asks, []);
  assert.equal(m.lines().join('\n'), THREAD.join('\n'));
  assert.equal(m.editor.lockedAt(m.lines(), 5), true, 'locked again');
  assert.equal(m.editor.history.length, 0, 'nothing to undo');
});

test('Escape puts the question back as it was, with its answer; so does ⌘Z with nothing typed', () => {
  const m = mounted(THREAD);
  m.click('editturn', { turn: '9' });
  m.type('@bart third, but different');
  m.caretAt(9);
  assert.equal(m.key('Escape').prevented, true);
  assert.equal(m.editor.editing, null);
  assert.equal(m.lines().join('\n'), THREAD.join('\n'));
  assert.deepEqual(m.asks, []);
  assert.equal(m.editor.history.length, 0, 'what was typed is not in undo');

  m.click('editturn', { turn: '9' });
  m.caretAt(9);
  m.key('z', { metaKey: true });
  assert.equal(m.editor.editing, null);
  assert.equal(m.lines().join('\n'), THREAD.join('\n'));
});

test('the keyboard or the caret leaving the line, or a click elsewhere, puts the question back', () => {
  const blur = mounted(THREAD);
  blur.click('editturn', { turn: '5' });
  blur.type('@bart gone?');
  blur.editor.docListeners.focusout({ target: blur.root, relatedTarget: null });
  assert.equal(blur.editor.editing, null);
  assert.equal(blur.lines()[5], '@bart second?');

  const caret = mounted(THREAD);
  caret.click('editturn', { turn: '5' });
  caret.type('@bart moved?');
  const inLine = {}, below = {};
  caret.select(inLine, 5);
  assert.equal(caret.editor.editing.q, 5, 'a caret inside the line keeps it');
  caret.editor.held = true; // the mouse is still down: a drag goes on
  caret.select(below, 6);
  assert.equal(caret.editor.editing.q, 5, 'not while the mouse is down');
  caret.editor.held = false;
  caret.select(below, 6);
  assert.equal(caret.editor.editing, null);
  assert.equal(caret.lines()[5], '@bart second?');
});

test('a click on another turn\'s button puts the question back first, then acts on the document as it was, before the parent hands it back', () => {
  const m = mounted(THREAD, { deferred: true });
  m.click('editturn', { turn: '5' });
  m.type('@bart typed, not asked'); m.hand();
  assert.equal(m.lines()[5], '@bart typed, not asked');
  m.click('dropturn', { turn: '1' }, 4);
  const ended = m.changes[m.changes.length - 1].split('\n');
  assert.deepEqual(ended, ['Notes', ...THREAD.slice(5)], 'the first turn deleted, the edited question as it was');
  assert.equal(m.editor.editing, null);
  m.hand();
  assert.deepEqual(m.lines(), ended, 'once handed back, the document is the parent\'s again');
  assert.equal(m.editor.textNow, null);
  m.editor.undo();
  assert.equal(m.changes[m.changes.length - 1], THREAD.join('\n'), 'undo goes back to before the delete, with nothing typed in it');
});

test('a model picked on the edited line\'s chip is what it is asked on; otherwise what answered it (ranWith)', () => {
  const m = mounted(THREAD);
  m.click('editturn', { turn: '9' });
  m.editor.state.picker = { kind: 'line', i: 9, left: null, right: 0, top: 0, bottom: 0, choice: null };
  m.editor.pickModel({ model: 'fable', effort: 'high' });
  assert.equal(m.lines()[9], '@bart --fable --high third?');
  m.caretAt(9);
  m.key('Enter');
  assert.equal(m.asks[0].text, '--fable --high third?');
  assert.equal(m.asks[0].choice, undefined, 'the line\'s flags decide');

  const kept = mounted(THREAD);
  kept.click('editturn', { turn: '9' });
  kept.type('@bart third, again?');
  kept.key('Enter');
  assert.deepEqual(kept.asks[0].choice, { model: 'opus', effort: 'low' }, 'Regenerate\'s choice: the model that answered');
});

test('@discover: its level chip shows while editing and the edit is asked on its own level, with no choice', () => {
  const m = mounted(['@discover --deep retries', ...plainAnswer('## Read'), '']);
  m.click('editturn', { turn: '0' });
  const line = m.html().match(/<div data-line="0"[^>]*>.*?(?=<div data-dim)/s)[0];
  assert.match(line, /data-act="pick" data-row="0"[^>]*>Deep/, 'the level chip');
  m.type('@discover --deep retries in queues');
  m.key('Enter');
  assert.deepEqual({ ...m.asks[0], askId: undefined }, { askId: undefined, text: '--deep retries in queues', turns: [], agent: 'discover', choice: undefined });
});

test('Enter waits on a line that no longer asks its agent, or asks for a Build; the line is never joined to its neighbours', () => {
  const m = mounted(THREAD);
  m.click('editturn', { turn: '5' });
  m.type('second?');
  m.key('Enter');
  assert.equal(m.editor.editing.q, 5, 'still editing');
  m.type('@discover second?');
  m.key('Enter');
  m.type('@bart --build second');
  m.key('Enter');
  assert.deepEqual(m.asks, []);
  assert.equal(m.editor.editing.q, 5);

  m.type('@bart second?');
  m.caretAt(5, 0);
  assert.equal(m.key('Backspace').prevented, true);
  m.caretAt(5);
  assert.equal(m.key('Delete').prevented, true);
  assert.equal(m.lines().join('\n'), THREAD.join('\n'), 'nothing joined');
});

test('lines landing above the question being edited move it with them; when its answer is gone, edit mode ends', () => {
  const lines = ['@bart above?', 'bart~> run0', '', '@bart below?', ...answer('b'), ''];
  const m = mounted(lines);
  m.click('editturn', { turn: '3' });
  m.type('@bart below, changed?');
  const before = m.props.text;
  m.props.text = before.replace('bart~> run0', answer('a').join('\n')); // the run above answers: two more lines
  m.editor.componentDidUpdate({ ...m.props, text: before });
  assert.equal(m.editor.editing.q, 5);
  assert.equal(m.editor.state.activeLine, 5, 'the caret goes with it');
  assert.equal(m.editor.lockedAt(m.lines(), 5), false);
  m.caretAt(5);
  m.key('Escape');
  assert.equal(m.lines()[5], '@bart below?');

  const gone = mounted(lines);
  gone.click('editturn', { turn: '3' });
  const was = gone.props.text;
  gone.props.text = '@bart above?\nbart~> run0\n';
  gone.editor.componentDidUpdate({ ...gone.props, text: was });
  assert.equal(gone.editor.editing, null);
});
