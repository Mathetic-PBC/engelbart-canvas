'use strict';

// A live @brainstorm card's own controls (src/renderer/workspace/DocEditor.jsx, round 6): Wrap up between Skip and Submit,
// which writes the answer given (if any) and "; (wrap up)", and under the card's box an @discover button with the card's
// search, which starts an @discover thread of its own under the brainstorm thread and leaves the card live. @discover's
// own cards have neither. There is no document here: the editor and its elements are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const card = require('../src/main/bart/card.cjs');
const { replyLines } = require('../src/main/bart/reply.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-cards-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const editorModule = load('DocEditor.jsx'), DocEditor = editorModule.default;
const LOOK = 'how others have handled “it stops when the lock frees”';
const FREE = { say: 'You said “it stops when the lock frees”.', card: 'questions', questions: { items: [{ id: 'next-2', type: 'free', title: 'Within “Retries”, what would change your mind?' }] }, lookFor: LOOK, ready: false };
const FOCUS = { say: '', card: 'focus', focus: { title: 'Which part do you want prior work on?', options: [{ label: 'Retries' }, { label: 'Timeouts' }] }, ready: false };
// A card as the runner writes it under its line: the fenced JSON, then the foot.
const answer = (value) => replyLines(card.cardBody(JSON.stringify(value)).body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false });

/** An editor as mounted on `lines`, with what it asks and writes kept. */
function mounted(lines) {
  const asks = [];
  const props = { docKey: 'k', text: lines.join('\n'), onChange: (next) => { props.text = next; }, onAsk: (ask) => asks.push(ask) };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, contains: () => false, querySelector: () => null };
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
  const entry = (q) => editor.cardsOf(editor.lines()).byQ.get(q);
  const html = (q) => editor.cardHtml('', entry(q));
  // A click on a button the card drew, as the editor's click listener gets it.
  const click = (act, turn) => editor.editorClick({ target: { closest: () => ({ dataset: { act, turn: String(turn) } }) }, preventDefault() {} });
  return { editor, props, asks, entry, html, click, lines: () => props.text.split('\n') };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a live @brainstorm card has Skip, Wrap up and Submit, in that order, and under its box an @discover button with its search', () => {
  const { html, entry } = mounted(['Notes', '@brainstorm', ...answer(FREE), '']);
  assert.equal(entry(1).live, true);
  const shown = html(1);
  const at = (act) => shown.indexOf(`data-act="${act}"`);
  assert.ok(at('cardskip') > 0 && at('cardskip') < at('cardwrap') && at('cardwrap') < at('cardsend'), 'Wrap up between Skip and Submit');
  assert.match(shown, /<button type="button" class="bart-text" data-act="cardwrap" data-turn="1"[^>]*>Wrap up<\/button>/, 'styled as Skip is');
  assert.ok(shown.indexOf('data-act="cardlook"') > shown.lastIndexOf('data-act="cardsend"'), 'the @discover button is under the box');
  assert.match(shown, /data-act="cardlook" data-turn="1"[^>]*><span[^>]*>@discover<\/span><span>how others have handled “it stops when the lock frees”<\/span><\/button>/);
  const bare = mounted(['@brainstorm', ...answer({ ...FREE, lookFor: undefined }), '']).html(0);
  assert.match(bare, /data-act="cardlook" data-turn="0"[^>]*><span[^>]*>@discover<\/span><\/button>/, 'no search: "@discover" alone');
});

test('the @discover button starts an @discover thread of its own under the brainstorm thread; the card stays live, and its next answer goes above the new thread', () => {
  const m = mounted(['Notes', '@brainstorm', ...answer(FREE)]);
  const before = m.lines();
  m.click('cardlook', 1);
  const ask = m.asks[0];
  assert.deepEqual({ ...ask, askId: undefined }, { askId: undefined, text: LOOK, turns: [], agent: 'discover' }, 'asked with the card\'s search and no earlier turns');
  assert.deepEqual(m.lines(), [...before, '', `@discover ${LOOK}`, `bart~> ${ask.askId}`, ''], 'a blank line, the @discover line and its pending line, after the thread');
  const live = m.entry(1);
  assert.deepEqual([live.live, live.thread.to], [true, before.length - 1], 'the brainstorm card is still its thread\'s last turn');
  const shown = m.html(1);
  for (const act of ['cardskip', 'cardwrap', 'cardsend', 'cardlook']) assert.ok(shown.includes(`data-act="${act}"`), `it keeps ${act}`);

  // Its answer, with Wrap up: written under the brainstorm thread, so above the @discover one.
  m.editor.cardState.set(1, { text: '  I will read  the logs ' });
  m.click('cardwrap', 1);
  const wrap = m.asks[1];
  assert.equal(wrap.agent, 'brainstorm');
  assert.equal(wrap.text, 'I will read the logs; (wrap up)');
  assert.equal(wrap.turns.length, 1);
  assert.deepEqual(m.lines().slice(before.length), ['@brainstorm I will read the logs; (wrap up)', `bart~> ${wrap.askId}`, '', `@discover ${LOOK}`, `bart~> ${ask.askId}`, '']);
});

test('Wrap up with nothing given writes "(wrap up)" alone, and works on a choice card with a pick; the answered card says Wrapped up and shows no buttons', () => {
  const empty = mounted(['@brainstorm', ...answer(FREE), '']);
  empty.click('cardwrap', 0);
  assert.equal(empty.asks[0].text, '(wrap up)');
  assert.equal(empty.lines()[empty.lines().length - 3], '@brainstorm (wrap up)');

  const picked = mounted(['@brainstorm', ...answer(FOCUS), '']);
  picked.editor.cardState.set(0, { picks: ['Timeouts'], note: 'soon' });
  picked.click('cardwrap', 0);
  assert.equal(picked.asks[0].text, 'picked "Timeouts"; note: soon; (wrap up)');

  // The card as it then stands: answered, its answer read back, no controls.
  const done = mounted(['@brainstorm', ...answer(FREE), '@brainstorm I will read the logs; (wrap up)', 'bart> Where you are: x', '']);
  const entry = done.entry(0);
  assert.deepEqual([entry.live, entry.answer], [false, { skipped: false, picks: [], text: 'I will read the logs', note: '', wrap: true }]);
  const shown = done.html(0);
  assert.ok(shown.includes('I will read the logs') && shown.includes('Wrapped up'), 'the answer, then Wrapped up');
  for (const act of ['cardskip', 'cardwrap', 'cardsend', 'cardlook']) assert.ok(!shown.includes(`data-act="${act}"`), `no ${act} on an answered card`);
  const alone = mounted(['@brainstorm', ...answer(FREE), '@brainstorm (wrap up)', 'bart> Where you are: x', '']).html(0);
  assert.ok(alone.includes('Wrapped up') && !alone.includes('Skipped'), 'Wrap up alone says Wrapped up, not Skipped');
});

test('@discover\'s cards have no Wrap up and no @discover button, and Wrap up asked of one does nothing; Skip and Submit are as they were', async () => {
  const m = mounted(['@discover', ...answer({ ...FOCUS, lookFor: LOOK }), '']);
  assert.equal(m.entry(0).live, true);
  const shown = m.html(0);
  assert.ok(shown.includes('data-act="cardskip"') && shown.includes('data-act="cardsend"'));
  assert.ok(!shown.includes('data-act="cardwrap"') && !shown.includes('data-act="cardlook"') && !shown.includes('Wrap up'));
  m.click('cardwrap', 0);
  m.click('cardlook', 0);
  assert.deepEqual(m.asks, [], 'nothing asked');
  m.click('cardskip', 0);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text], ['discover', '(skipped)']);

  // A recap's Look for button still asks its search, as before (round 4).
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const recap = mounted(['@brainstorm (wrap up)', 'bart> Where you are: a', 'bart> Look for: retry loops', '']);
  recap.editor.editorClick({ target: { closest: () => ({ dataset: { act: 'discoverlook', row: '2' } }) }, preventDefault() {} });
  assert.deepEqual([recap.asks[0].text, recap.asks[0].agent], ['retry loops', 'discover']);
  assert.deepEqual(model.threads(recap.lines()).map((t) => model.agentOf(model.parseLine(recap.lines()[t.from]))), ['brainstorm', 'discover']);
});

test('on a live @brainstorm versions card the field under the options reads "Or rewrite it yourself…", and the rest is as on any card; elsewhere it reads as before (round 7)', () => {
  const VERSIONS = { say: '', card: 'questions', questions: { items: [{ id: 'versions', type: 'mcq', title: 'Which one is your question?', options: [{ label: 'Why do retries loop?', why: 'as you wrote it' }, { label: 'Why specifically do retries loop?', why: 'narrower' }] }] }, lookFor: LOOK, ready: false };
  const m = mounted(['@brainstorm', ...answer(VERSIONS), '']);
  const shown = m.html(0);
  assert.match(shown, /data-card-field="note" placeholder="Or rewrite it yourself…" aria-label="Or rewrite it yourself"/);
  assert.ok(!shown.includes('Or say it in your own words'));
  for (const act of ['cardskip', 'cardwrap', 'cardsend', 'cardlook']) assert.ok(shown.includes(`data-act="${act}"`), `it keeps ${act}`);
  // A rewrite typed with nothing picked is sent as their words.
  m.editor.cardState.set(0, { note: '  Why do retries   loop at all? ' });
  m.click('cardsend', 0);
  assert.equal(m.asks[0].text, 'Why do retries loop at all?');
  for (const lines of [['@brainstorm', ...answer(FOCUS), ''], ['@discover', ...answer(VERSIONS), '']]) {
    assert.match(mounted(lines).html(0), /placeholder="Or say it in your own words…"/, `${lines[0]}: as before`);
  }
  assert.equal(editorModule.BRAINSTORM_ITEM.summary, 'Work out what puzzles you and land on a research question in your own words.');
});
