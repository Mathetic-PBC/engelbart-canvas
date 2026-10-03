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
const { withMode, discoverSpans, readDiscover, readProvider } = require('../src/main/bart/question.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');

const DEFAULTS = normalizeModels(null);
const CODEX = { ...DEFAULTS, provider: 'openai' };
const CLAUDE_ONLY = onlyProviders(DEFAULTS, ['anthropic']);

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
  const pick = (i, mode, provider) => { editor.state.picker = { kind: 'line', i, left: null, right: 0, top: 0, bottom: 0, choice: null }; editor.pickLevel({ mode, provider }); };
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
  assert.deepEqual(levels.props.current, { mode: 'deep', provider: 'anthropic', pinned: false });
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

/* ------------------------------------------------------------- the provider (2026-10-03) */

/** What DiscoverLevels draws, as elements: rendered inside a component, so its hooks run, and walked for its rows. */
function levelsTree(props) {
  let out = null;
  renderToStaticMarkup(React.createElement(() => { out = Levels.default(props); return null; }));
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type && (node.type.name === 'Row' || node.type.name === 'ProviderField')) found.push(node);
    if (node.props) walk(node.props.children);
  };
  walk(out);
  return { rows: found.filter((node) => node.type.name === 'Row'), field: found.find((node) => node.type.name === 'ProviderField') || null };
}

test('readProvider: --claude, --codex and --chatgpt anywhere on the line, in any case, the last of two; other words stay (P-01)', () => {
  assert.deepEqual(readProvider('how people read --codex'), { provider: 'openai', rest: 'how people read' });
  assert.deepEqual(readProvider('--Claude how people read'), { provider: 'anthropic', rest: 'how people read' });
  assert.deepEqual(readProvider('how --chatgpt people read'), { provider: 'openai', rest: 'how people read' });
  assert.deepEqual(readProvider('--codex why --claude'), { provider: 'anthropic', rest: 'why' }, 'the last one counts');
  assert.deepEqual(readProvider('why --codexy claude --gpt'), { provider: null, rest: 'why --codexy claude --gpt' });
  assert.deepEqual(readProvider(''), { provider: null, rest: '' });
});

test('readDiscover: the provider the line names, else the one an earlier turn named, else the default; one not offered is passed over; a model flag still pins (P-02)', () => {
  const run = (text, models = DEFAULTS, earlier) => { const read = readDiscover(text, models, earlier); return [read.provider, read.mode, read.question, read.pinned, read.steps.map((s) => `${s.name} ${s.effort}`).join()]; };
  assert.deepEqual(run('why --codex --deep'), ['openai', 'deep', 'why', false, 'Astra ultra'], 'Codex at deep');
  assert.deepEqual(run('--chatgpt --quick why'), ['openai', 'quick', 'why', false, 'Sol medium']);
  assert.deepEqual(run('why --claude', CODEX), ['anthropic', 'standard', 'why', false, 'Opus high'], 'Claude Code when Codex is the default');
  assert.equal(readDiscover('why --codex', DEFAULTS).steps[0].model, 'gpt-6-astra', 'the id the CLI gets');
  // Carried: a card's answer or a follow-up stays on the provider its exchange was asked on, and at its level.
  assert.deepEqual(run('picked "Retries"', DEFAULTS, [{ question: 'agents --codex --deep' }]), ['openai', 'deep', 'picked "Retries"', false, 'Astra ultra']);
  assert.deepEqual(run('more', DEFAULTS, [{ question: 'agents --codex' }, { question: 'x --quick' }]), ['openai', 'quick', 'more', false, 'Sol medium'], 'each carried from the latest turn that names it');
  assert.deepEqual(run('more --claude', DEFAULTS, [{ question: 'agents --codex' }]), ['anthropic', 'standard', 'more', false, 'Opus high'], 'the line\'s own wins');
  assert.deepEqual(run('more', DEFAULTS, [{ question: 'a --claude' }, { question: 'b --codex' }])[0], 'openai');
  // A provider the list does not offer: the flag is taken off the question, and the provider is the one it would be without it.
  assert.deepEqual(run('why --codex --deep', CLAUDE_ONLY), ['anthropic', 'deep', 'why', false, 'Opus max']);
  assert.deepEqual(run('more', CLAUDE_ONLY, [{ question: 'agents --codex' }])[0], 'anthropic', 'nor carried');
  assert.deepEqual(run('more --codex', DEFAULTS, [{ question: 'agents --claude' }]).slice(0, 1), ['openai']);
  // A model flag pins as before, on its own provider; an effort alone on the provider the line names.
  assert.deepEqual(run('--codex --opus why --deep'), ['anthropic', 'deep', 'why', true, 'Opus high'], '--opus pins Claude Code over --codex');
  assert.deepEqual(run('--codex --high why'), ['openai', 'standard', 'why', true, 'Sol high'], 'an effort alone, on Codex');
  assert.deepEqual(run('--opus why', DEFAULTS, [{ question: 'agents --codex' }]).slice(0, 1), ['anthropic']);
  assert.deepEqual(run('why'), ['anthropic', 'standard', 'why', false, 'Opus high'], 'no flag: as before');
});

test('withMode writes --claude or --codex when the provider is not the line\'s plain one, and takes both kinds of flag off (P-03)', () => {
  const plain = { mode: 'standard', provider: 'anthropic' };
  assert.equal(withMode('how people read', 'deep', DEFAULTS, plain, 'openai'), 'how people read --codex --deep', 'A-02');
  assert.equal(withMode('how people read', 'standard', DEFAULTS, plain, 'openai'), 'how people read --codex');
  assert.equal(withMode('how people read --codex --deep', 'standard', DEFAULTS, plain, 'anthropic'), 'how people read', 'the default at Standard: both go (A-03)');
  assert.equal(withMode('--chatgpt how people read --opus', 'quick', DEFAULTS, plain, 'openai'), 'how people read --codex --quick', '--chatgpt is written --codex; a pin goes');
  assert.equal(withMode('how --claude people read', 'deep', DEFAULTS, plain), 'how people read --deep', 'no provider given: none written, any there taken off');
  assert.equal(withMode('how people read', 'deep', CODEX, { mode: 'standard' }, 'anthropic'), 'how people read --claude --deep', 'the plain provider defaults to the list\'s');
  // In a Codex exchange, Codex is plain and Claude Code has to be said.
  const codex = { mode: 'standard', provider: 'openai' };
  assert.equal(withMode('more like these', 'standard', DEFAULTS, codex, 'anthropic'), 'more like these --claude');
  assert.equal(withMode('more like these --claude', 'standard', DEFAULTS, codex, 'openai'), 'more like these');
  assert.equal(withMode('why', 'standard', CLAUDE_ONLY, plain, 'openai'), 'why', 'a provider not offered writes nothing');
  assert.equal(withMode('', 'deep', DEFAULTS, plain, 'openai'), '--codex --deep');
  const read = readDiscover(withMode('--opus why', 'deep', DEFAULTS, plain, 'openai'), DEFAULTS);
  assert.deepEqual([read.provider, read.steps[0].name, read.steps[0].effort], ['openai', 'Astra', 'ultra'], 'what it writes runs there');
});

test('discoverSpans marks the provider flags too (P-04)', () => {
  const at = (text, models = DEFAULTS) => discoverSpans(text, models).map(([a, b]) => text.slice(a, b));
  assert.deepEqual(at('why --codex --deep'), ['--codex', '--deep']);
  assert.deepEqual(at('--claude --opus why'), ['--claude', '--opus'], 'readFlags alone would stop at --claude');
  assert.deepEqual(at('--chatgpt why --high --quick'), ['--chatgpt', '--high', '--quick']);
  assert.deepEqual(at('why --codexy'), []);
  assert.deepEqual(at('why --codex', null), ['--codex'], 'before the models load');
});

test('the level menu: a provider field when more than one is offered; Codex lists Sol · Medium, Astra · High, Astra · Ultra; a pick says its provider (P-05, A-01, A-04)', () => {
  const rows = (models, provider) => Levels.levelRows(models, provider).map((row) => `${row.label}: ${row.detail}`);
  assert.deepEqual(rows(DEFAULTS, 'openai'), ['Quick: Sol · Medium', 'Standard: Astra · High', 'Deep: Astra · Ultra']);
  assert.deepEqual(rows(DEFAULTS, 'anthropic'), ['Quick: Sonnet · Medium', 'Standard: Opus · High', 'Deep: Opus · Max']);
  assert.deepEqual(rows(CODEX), rows(DEFAULTS, 'openai'), 'no provider: the default\'s');
  const anchor = { left: null, right: 400, top: 100, bottom: 126 };
  const html = (models, current) => renderToStaticMarkup(React.createElement(Levels.default, { models, current, anchor, onPick() {} }));
  const both = html(DEFAULTS, { mode: 'deep', provider: 'anthropic', pinned: false });
  assert.match(both, /role="dialog" aria-label="How far Discover looks"[^>]*><div style="padding:4px 4px 0"><div style="position:relative;margin-bottom:4px"><div role="button" aria-haspopup="listbox" aria-expanded="false"[^>]*><span[^>]*>Claude Code<\/span>/, 'the field first, as BartPicker has it');
  assert.deepEqual([...both.matchAll(/aria-selected="(true|false)"/g)].map((found) => found[1]), ['false', 'false', 'true']);
  const codex = html(DEFAULTS, { mode: 'standard', provider: 'openai', pinned: false });
  assert.match(codex, /<span[^>]*>Codex<\/span>/);
  assert.match(codex, />Quick<span[^>]*>Sol · Medium<\/span>.*>Standard<span[^>]*>Astra · High<\/span>.*>Deep<span[^>]*>Astra · Ultra<\/span>/, 'a Codex line opens on Codex\'s levels (A-01)');
  assert.deepEqual([...codex.matchAll(/aria-selected="(true|false)"/g)].map((found) => found[1]), ['false', 'true', 'false']);
  // One provider: the menu as it was, no field.
  const one = html(CLAUDE_ONLY, { mode: 'standard', provider: 'anthropic', pinned: false });
  assert.doesNotMatch(one, /aria-haspopup/);
  assert.match(one, /role="dialog" aria-label="How far Discover looks"[^>]*><div role="listbox" aria-label="Level" style="padding:4px">/, 'A-04');
  // A pick names its level and the provider viewed.
  const picks = [];
  const tree = levelsTree({ models: DEFAULTS, current: { mode: 'standard', provider: 'openai', pinned: false }, anchor, onPick: (pick) => picks.push(pick) });
  assert.equal(tree.field.props.provider, 'openai');
  tree.rows[2].props.onPick();
  tree.rows[1].props.onPick();
  assert.deepEqual(picks, [{ mode: 'deep', provider: 'openai' }, { mode: 'standard', provider: 'openai' }]);
  assert.equal(levelsTree({ models: CLAUDE_ONLY, current: { mode: 'standard', provider: 'anthropic', pinned: false }, anchor, onPick() {} }).field, null);
  const pinned = levelsTree({ models: DEFAULTS, current: { mode: 'standard', provider: 'anthropic', pinned: true }, anchor, onPick() {} });
  assert.deepEqual(pinned.rows.map((row) => row.props.on), [false, false, false], 'pinned: none checked');
});

test('picking Codex › Deep writes --codex --deep and the chip reads "Codex · Deep"; the default at Standard takes both off; a Codex exchange stays on Codex (P-06, A-02, A-03)', async () => {
  const m = mounted(['@discover how people read']);
  m.pick(0, 'deep', 'openai');
  assert.deepEqual(m.lines(), ['@discover how people read --codex --deep']);
  assert.equal(await m.chip(0), 'Codex · Deep');
  assert.match(await m.lineOf(0), /<span style="font-weight:500">--codex<\/span> <span style="font-weight:500">--deep<\/span>/, 'both marked as flags');
  assert.deepEqual(m.view(0).props.current, { mode: 'deep', provider: 'openai', pinned: false });
  m.pick(0, 'standard', 'anthropic');
  assert.deepEqual(m.lines(), ['@discover how people read'], 'A-03');
  assert.equal(await m.chip(0), 'Standard');
  m.pick(0, 'standard', 'openai');
  assert.deepEqual(m.lines(), ['@discover how people read --codex']);
  assert.equal(await m.chip(0), 'Codex · Standard');

  const empty = mounted(['@Discover']);
  empty.pick(0, 'quick', 'openai');
  assert.deepEqual(empty.lines(), ['@Discover --codex --quick '], 'a space after the flags, for the question');

  // A follow-up in a Codex exchange runs on Codex: its chip says so, and Claude Code has to be written.
  const follow = mounted(['@discover agents --codex --deep', 'bart> ## Start here', 'bart> *Astra · ultra · 3 s*', '@discover more like these']);
  assert.equal(await follow.chip(3), 'Codex · Deep');
  assert.deepEqual(follow.view(3).props.current, { mode: 'deep', provider: 'openai', pinned: false });
  follow.pick(3, 'deep', 'anthropic');
  assert.equal(follow.lines()[3], '@discover more like these --claude');
  assert.equal(await follow.chip(3), 'Deep');
  follow.pick(3, 'deep', 'openai');
  assert.equal(follow.lines()[3], '@discover more like these');

  // Claude Code named on a list whose default is Codex; and one provider offered, where --codex does nothing.
  assert.equal(await mounted(['@discover why --claude'], CODEX).chip(0), 'Claude Code · Standard');
  assert.equal(await mounted(['@discover why --codex --deep'], CLAUDE_ONLY).chip(0), 'Deep');
  assert.equal(await mounted(['@discover --codex --opus why']).chip(0), 'Opus High', 'a model flag still pins');
});

test('@bart\'s chip and BartPicker are unchanged by the provider flags (A-05)', async () => {
  const m = mounted(['@bart why --codex', '', '@Bart --opus --high why']);
  assert.equal(await m.chip(0), 'Sonnet High', '--codex is a word on an @bart line');
  assert.doesNotMatch(await m.lineOf(0), /font-weight:500">--codex/);
  const picker = m.view(0);
  assert.equal(picker.type.name, 'BartPicker');
  assert.deepEqual(picker.props.current, { provider: 'anthropic', model: 'sonnet', effort: 'high' });
  const html = renderToStaticMarkup(picker);
  assert.match(html, /role="dialog" aria-label="Model and effort"[^>]*><div style="flex:1 1 0;min-width:0;padding:4px"><div style="position:relative;margin-bottom:4px"><div role="button" aria-haspopup="listbox" aria-expanded="false"[^>]*><span[^>]*>Claude Code<\/span><span[^>]*><span[^>]*>⌄<\/span><\/span><\/div><\/div><div role="listbox" aria-label="Model">/);
  m.editor.state.picker = { kind: 'line', i: 2, left: null, right: 0, top: 0, bottom: 0, choice: null };
  m.editor.pickModel({ model: 'astra', effort: 'ultra' });
  assert.equal(m.lines()[2], '@Bart --astra --ultra why');
});
