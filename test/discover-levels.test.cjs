'use strict';

// @discover's level chip (2026-10-03): an unanswered @discover line shows the level it would run at ("Standard ⌄"), or the
// model and effort a flag pins it to, and its menu lists Quick, Standard and Deep with the model and effort of each. A
// pick is written into the line as a flag (question.cjs withMode). @bart's chip and selector stay as they were, and
// @brainstorm has no chip. There is no document here: the editor is mounted on stand-ins, as in doc-editor-cards.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { normalizeModels, onlyProviders } = require('../src/main/bart/models.cjs');
const { withMode, discoverSpans, readDiscover } = require('../src/main/bart/question.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');

const DEFAULTS = normalizeModels(null);
const CODEX = { ...DEFAULTS, provider: 'openai' };

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-levels-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const Levels = load('DiscoverLevels.jsx');
const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

/** An editor as mounted on `lines` with `models`, with what it writes kept. */
function mounted(lines, models = DEFAULTS) {
  const props = { docKey: 'k', text: lines.join('\n'), models, onChange: (next) => { props.text = next; }, onAsk: () => {} };
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
  const lineOf = async (i) => {
    const { parseLine } = await doc(), ls = editor.lines();
    return editor.lineHtml(i, ls[i], parseLine(ls[i]), false, false, editor.layout(ls).get(i), editor.lockedAt(ls, i));
  };
  // The chip's words, or null when the line draws none.
  const chip = async (i) => { const found = (await lineOf(i)).match(/data-act="pick" data-row="\d+"[^>]*>([^<]*)<span/); return found ? found[1] : null; };
  const pick = (i, mode) => { editor.state.picker = { kind: 'line', i, left: null, right: 0, top: 0, bottom: 0, choice: null }; editor.pickLevel(mode); };
  const view = (i) => { editor.state.picker = { kind: 'line', i, left: null, right: 0, top: 0, bottom: 0, choice: null }; return editor.pickerView(); };
  return { editor, props, chip, pick, view, lineOf, lines: () => props.text.split('\n') };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('withMode: each level, a level replaced, model and effort flags taken off, an empty question, and the plain level written as none (L-02)', () => {
  assert.equal(withMode('how people read', 'quick', DEFAULTS), 'how people read --quick');
  assert.equal(withMode('how people read', 'standard', DEFAULTS), 'how people read', 'a plain line is standard');
  assert.equal(withMode('how people read', 'deep', DEFAULTS), 'how people read --deep');
  assert.equal(withMode('--quick how people read', 'deep', DEFAULTS), 'how people read --deep', 'the level it had goes');
  assert.equal(withMode('how --deep people read --quick', 'standard', DEFAULTS), 'how people read', 'every level flag goes, wherever it was');
  assert.equal(withMode('--opus --high how people read', 'deep', DEFAULTS), 'how people read --deep', 'a pin goes');
  assert.equal(withMode('how people read --high --deep --opus', 'quick', DEFAULTS), 'how people read --quick', 'a pin behind a level goes too');
  assert.equal(withMode('', 'deep', DEFAULTS), '--deep');
  assert.equal(withMode('', 'standard', DEFAULTS), '');
  assert.equal(withMode('--sonnet', 'quick', DEFAULTS), '--quick');
  assert.equal(withMode('more like these', 'standard', DEFAULTS, 'deep'), 'more like these --standard', 'in a deep exchange, standard has to be said');
  assert.equal(withMode('more like these', 'deep', DEFAULTS, 'deep'), 'more like these', 'and deep need not be');
  assert.deepEqual(readDiscover(withMode('--opus why', 'deep', DEFAULTS), DEFAULTS).steps.map((s) => `${s.name} ${s.effort}`), ['Opus max'], 'what it writes runs at that level');
});

test('discoverSpans: the level flags, and the model and effort flags readDiscover obeys, at their places in the text', () => {
  const at = (text) => discoverSpans(text, DEFAULTS).map(([a, b]) => text.slice(a, b));
  assert.deepEqual(at('why --deep'), ['--deep']);
  assert.deepEqual(at('--quick --opus why --deep'), ['--quick', '--opus', '--deep']);
  assert.deepEqual(at('why --high --deep'), ['--high', '--deep'], 'readFlags alone would stop at --deep');
  assert.deepEqual(at('why --deeper'), []);
  assert.deepEqual(discoverSpans('why --deep', null).map(([a, b]) => 'why --deep'.slice(a, b)), ['--deep'], 'before the models load: the levels still');
});

test('bart-models also returns @discover\'s levels per provider, cut to the providers offered (L-01)', async () => {
  const handlers = new Map();
  let offered = DEFAULTS;
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, readModels: () => offered });
  const models = await handlers.get('engelbart:bart-models')();
  assert.deepEqual(Object.keys(models).sort(), ['discover', 'provider', 'providers']);
  assert.deepEqual(models.discover, { providers: DEFAULTS.discover.providers });
  assert.deepEqual(models.discover.providers.anthropic, { quick: { model: 'sonnet', effort: 'medium' }, standard: { model: 'opus', effort: 'high' }, deep: { model: 'opus', effort: 'max' } });
  offered = onlyProviders(DEFAULTS, ['openai']);
  assert.deepEqual(Object.keys((await handlers.get('engelbart:bart-models')()).discover.providers), ['openai']);
});

test('the chip on an @discover line: Standard, Quick, Deep, or the model and effort a flag pins (L-03)', async () => {
  const m = mounted(['@discover how tools point a reader to a passage', '', '@discover --quick why', '', '@Discover why --deep', '', '@discover --opus --high why', '', '@discover', '', '@discover why --deep --high']);
  assert.deepEqual(await Promise.all([0, 2, 4, 6, 8, 10].map((i) => m.chip(i))), ['Standard', 'Quick', 'Deep', 'Opus High', 'Standard', 'Sonnet High'], 'an effort alone pins the step it pairs with, as on @bart');
  assert.match(await m.lineOf(0), /data-act="pick" data-row="0" role="button" aria-haspopup="dialog" aria-expanded="false"[^>]*>Standard<span[^>]*><span[^>]*>⌄<\/span><\/span><\/span><button contenteditable="false" data-act="ask"/, 'the chip, then send (A-01)');
  assert.equal(await mounted(['@discover why'], null).chip(0), null, 'no chip before the models load');
});

test('a follow-up in a --deep exchange shows Deep; an answered @discover line has no chip', async () => {
  const lines = ['@discover agents --deep', 'bart> ## Start here', 'bart> *Opus · max · 3 s*', '@discover more like these'];
  const m = mounted(lines);
  assert.equal(await m.chip(3), 'Deep', 'carried from the turn above');
  assert.equal(await m.chip(0), null, 'answered: the foot says who answered');
  assert.equal(await mounted(['@discover agents --quick', 'bart> ## Start here', '@discover more --deep']).chip(2), 'Deep', 'the line\'s own wins');
});

test('picking writes the level into the line: Deep adds --deep, Standard takes it off; a pin goes; the lead stays as written (L-05)', async () => {
  const m = mounted(['@discover how people read']);
  m.pick(0, 'deep');
  assert.deepEqual(m.lines(), ['@discover how people read --deep']);
  assert.equal(await m.chip(0), 'Deep');
  assert.match(await m.lineOf(0), /<span style="font-weight:500">--deep<\/span>/, 'highlighted as --opus is');
  m.pick(0, 'standard');
  assert.deepEqual(m.lines(), ['@discover how people read']);
  m.pick(0, 'quick');
  assert.deepEqual(m.lines(), ['@discover how people read --quick']);

  const pinned = mounted(['@Discover --opus --high how people read']);
  pinned.pick(0, 'deep');
  assert.deepEqual(pinned.lines(), ['@Discover how people read --deep'], '"@Discover" stays, the pin goes');

  const empty = mounted(['@discover']);
  empty.pick(0, 'deep');
  assert.deepEqual(empty.lines(), ['@discover --deep '], 'a space after the flag, for the question');
  empty.pick(0, 'standard');
  assert.deepEqual(empty.lines(), ['@discover ']);

  const follow = mounted(['@discover agents --deep', 'bart> ## Start here', '@discover more like these']);
  follow.pick(2, 'standard');
  assert.deepEqual(follow.lines()[2], '@discover more like these --standard', 'standard has to be said in a deep exchange');
  assert.equal(await follow.chip(2), 'Standard');
  follow.pick(2, 'deep');
  assert.deepEqual(follow.lines()[2], '@discover more like these');

  const bart = mounted(['@bart how people read']);
  bart.pick(0, 'deep');
  assert.deepEqual(bart.lines(), ['@bart how people read'], 'an @bart line takes no level');
});

test('the chip opens DiscoverLevels on @discover lines and BartPicker on @bart lines, unchanged; @brainstorm has no chip', async () => {
  const m = mounted(['@discover why --deep', '', '@bart why', '', '@brainstorm', '', '@Bart --opus --high why', '', '@discover --sonnet why']);
  const levels = m.view(0);
  assert.equal(levels.type.name, 'DiscoverLevels');
  assert.deepEqual(levels.props.current, { mode: 'deep', pinned: false });
  assert.equal(m.view(8).props.current.pinned, true);
  const picker = m.view(2);
  assert.equal(picker.type.name, 'BartPicker');
  assert.deepEqual(picker.props.current, { provider: 'anthropic', model: 'sonnet', effort: 'high' });
  assert.equal(await m.chip(2), 'Sonnet High');
  assert.equal(await m.chip(4), null, '@brainstorm: no chip');
  assert.match(await m.lineOf(4), /<span contenteditable="false" style="flex:none;margin-top:3px"><button contenteditable="false" data-act="ask"/, 'only the send button');
  m.editor.state.picker = { kind: 'line', i: 6, left: null, right: 0, top: 0, bottom: 0, choice: null };
  m.editor.pickModel({ model: 'fable', effort: 'xhigh' });
  assert.equal(m.lines()[6], '@Bart --fable --xhigh why', '@bart\'s pick still writes model and effort, its lead as written');
});

test('the level menu: Quick, Standard and Deep with the model and effort of each, on Claude Code and on Codex; the level in force checked, none when pinned (L-04, A-02)', () => {
  const rows = (models) => Levels.levelRows(models).map((row) => `${row.label}: ${row.detail}`);
  assert.deepEqual(rows(DEFAULTS), ['Quick: Sonnet · Medium', 'Standard: Opus · High', 'Deep: Opus · Max']);
  assert.deepEqual(rows(CODEX), ['Quick: Sol · Medium', 'Standard: Astra · High', 'Deep: Astra · Ultra']);
  const gone = { ...DEFAULTS, discover: { providers: { ...DEFAULTS.discover.providers, anthropic: { ...DEFAULTS.discover.providers.anthropic, deep: { model: 'gone', effort: 'max' } } } } };
  assert.equal(rows(gone)[2], 'Deep: Sonnet · High', 'a level whose model is gone shows the ladder\'s first, as it runs');
  assert.deepEqual(rows({ ...DEFAULTS, discover: undefined }), ['Quick: Sonnet · High', 'Standard: Sonnet · High', 'Deep: Sonnet · High'], 'no levels sent: the ladder\'s first');
  const anchor = { left: null, right: 400, top: 100, bottom: 126 };
  const html = (current) => renderToStaticMarkup(React.createElement(Levels.default, { models: DEFAULTS, current, anchor, onPick() {} }));
  const shown = html({ mode: 'deep', pinned: false });
  assert.match(shown, /^<div data-bart-picker="1" data-overlay="1" data-hover="1" role="dialog"/, 'the hover rules hold');
  assert.deepEqual([...shown.matchAll(/aria-selected="(true|false)"/g)].map((found) => found[1]), ['false', 'false', 'true']);
  assert.match(shown, />Deep<span[^>]*>Opus · Max<\/span>/);
  assert.deepEqual([...html({ mode: 'standard', pinned: true }).matchAll(/aria-selected="(true|false)"/g)].map((found) => found[1]), ['false', 'false', 'false'], 'pinned: none checked');
});
