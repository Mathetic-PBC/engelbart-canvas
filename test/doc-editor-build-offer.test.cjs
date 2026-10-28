'use strict';

// The Build button under an answer that offers to build its fenced prompt (MATH-160, 2026-10-27): Chat writes a Build
// prompt as a fenced block and ends "Want me to build it?" (main's bart/ask.cjs ROUTED_BUILD); under the conversation's
// last answer, finished, a "Build" text button builds that block as the footer's Build does (footBuild, route.js
// buildTextOf). "@bart yes" and the [[build]] hammer still build as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { normalizeModels } = require('../src/main/bart/models.cjs');

const loadRoute = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/route.js')).href);
const loadDoc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-build-offer-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const DocEditor = loadEditor().default;

// `onBuild`: what the editor's onBuild returns (Workspace's is async), or false for none.
function mounted(lines, { readOnly = false, onBuild = () => undefined, route = null, asks = undefined, builds = undefined } = {}) {
  const started = [], routes = [], asked = [];
  const props = {
    docKey: 'k', text: lines.join('\n'), models: normalizeModels(null), readOnly, asks, builds,
    onChange: (next) => { props.text = next; },
    onAsk: (ask) => asked.push(ask),
    onRoute: route ? (input) => { routes.push(input); return route(input); } : undefined,
    onRouteGone: () => {},
    ...(onBuild ? { onBuild: (b) => { started.push(b); return onBuild(b); } } : {}),
  };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
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
  return { editor, props, started, routes, asked, lines: () => props.text.split('\n'), html: () => editor.editorHtml() };
}
test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

const settled = () => new Promise((resolve) => setImmediate(resolve));
const click = (m, dataset, disabled = false) => m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset, disabled, closest: () => null } : null) }, preventDefault() {} });
const BUTTON_RE = /<button type="button" class="bart-go" data-act="footbuild" data-turn="(\d+)" style="[^"]*">([^<]*)<\/button>/g;
const buttons = (html) => [...html.matchAll(BUTTON_RE)].map((m) => ({ turn: Number(m[1]), label: m[2] }));
const offerRows = (html) => (html.match(/data-build-offer=/g) || []).length;

const TITLE = 'bart# [chat 2026-10-27T09:00:00Z] Haiku';
const answer = (said, { foot = 'bart> *Chat · Sonnet · high · 3 s*' } = {}) => [TITLE, '@bart add Haiku 5.5 to the models', 'bart> Here is the Build prompt:', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', ...said.map((l) => `bart> ${l}`), foot, ''];
const OFFER = answer(['Want me to build it?']);

test('a finished fenced answer ending with a build offer: one Build text button, under its last line, above its foot', () => {
  const m = mounted(OFFER);
  const html = m.html();
  assert.deepEqual(buttons(html), [{ turn: 1, label: 'Build this prompt' }], 'one button, the turn\'s question line, saying the whole offer');
  assert.equal(offerRows(html), 1);
  const at = html.indexOf('data-build-offer=');
  const row = html.slice(at, html.indexOf('</div>', at));
  assert.ok(!/<svg|data-build-icon/.test(row), 'no icon');
  assert.ok(html.indexOf('data-line="6"') < at, 'under the offer line');
  assert.match(html, /<div data-offer-said="1" [^>]*data-line="6"/, 'the offer line kept in the text but not drawn: the button stands for it');
  assert.equal((html.match(/data-offer-said=/g) || []).length, 1, 'no other line hidden');
  // A blank line between the closing fence and the offer goes too: no gap above the button.
  const spaced = mounted(answer(['', 'Want me to build it?'])).html();
  const hidden = [...spaced.matchAll(/<div data-offer-said="1" [^>]*data-line="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(hidden, [6, 7], 'the blank line and the offer, not the closing fence');
  assert.ok(at < html.indexOf('data-line="7"'), 'above the foot');
  assert.match(row, /class="bart-go"[^>]*style="[^"]*background:#0070f3;color:#fff/, 'blue, as Start research is');
});

test('the offers it reads: "Want me to build it?", "Should I build this?", "Want me to build that now?" and the like', async () => {
  const { offersBuild } = await loadRoute(), { threads } = await loadDoc();
  const offers = (said) => { const ls = answer(said); return offersBuild(ls, threads(ls)[0].turns[0]); };
  for (const said of ['Want me to build it?', 'Should I build this?', 'Want me to build that now?', 'Would you like me to build it?', 'Shall I build it?', '**Want me to build it?**', 'Do you want me to go ahead and build it?']) {
    assert.equal(offers([said]), true, said);
    assert.equal(offers(['', said, '']), true, `${said}, blank lines around it`);
  }
  for (const said of ['Want me to explain more?', 'Should I add tests too?', 'Want me to build it? Or change it first.', 'I can build it.', 'Want me to build it']) assert.equal(offers([said]), false, said);
});

test('no button: no fenced block, an answer ending at its fence, another closing question', () => {
  const none = (lines, why) => { const html = mounted(lines).html(); assert.equal(offerRows(html), 0, why); assert.deepEqual(buttons(html), [], why); };
  none([TITLE, '@bart add Haiku', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> Want me to build it?', 'bart> *Chat · Sonnet · high · 3 s*', ''], 'no fenced block');
  none(answer([]), 'the answer ends at its closing fence');
  none(answer(['Want me to explain the change first?']), 'another question');
  none([TITLE, '@bart add Haiku', 'bart> Want me to build it?', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', 'bart> *Chat · Sonnet · high · 3 s*', ''], 'the offer above the block');
});

test('no button while the turn is pending or streaming, nor on an earlier turn', () => {
  // Pending: the question with its pending line, the offer streaming in.
  const streaming = mounted([TITLE, '@bart add Haiku', 'bart~> a1', ''], { asks: { a1: { docKey: 'k', agent: 'bart', activity: 'Writing', lines: ['Here is the Build prompt:', '```', 'Add Haiku 5.5 to models.cjs.', '```', 'Want me to build it?'] } } });
  assert.equal(offerRows(streaming.html()), 0, 'streaming');
  // A follow-up at work under the offering answer.
  const following = mounted([...OFFER.slice(0, -1), '@bart actually use Opus', 'bart~> a2', ''], { asks: { a2: { docKey: 'k', agent: 'bart' } } });
  assert.equal(offerRows(following.html()), 0, 'a later turn at work');
  // An earlier turn: the offer was answered by a follow-up that offers nothing.
  const later = mounted([...OFFER.slice(0, -1), '@bart why that file?', 'bart> It holds the models.', 'bart> *Chat · Sonnet · high · 2 s*', '']);
  assert.equal(offerRows(later.html()), 0, 'the offer is not the last answer');
  // The last answer offering again, after an earlier offer: one button, for it.
  const again = mounted([...OFFER.slice(0, -1), '@bart use Opus', 'bart> ```', 'bart> Add Opus.', 'bart> ```', 'bart> Should I build this?', 'bart> *Chat · Sonnet · high · 2 s*', '']);
  assert.deepEqual(buttons(again.html()), [{ turn: 8, label: 'Build this prompt' }]);
});

test('no button with a Build card under the conversation, in a read-only document, without onBuild, nor in a Build\'s messages', () => {
  const carded = [...OFFER.slice(0, -1), 'build> 0123456789', ''];
  const builds = { '0123456789': { id: '0123456789', status: 'running', messages: [{ role: 'agent', text: '```\nAdd Haiku.\n```\nWant me to build it?' }] } };
  const card = mounted(carded, { builds });
  card.editor.buildOpen = new Set(['0123456789']);
  assert.equal(offerRows(card.html()), 0, 'its Build\'s card is under it');
  assert.match(card.html(), /<div data-offer-said="1" [^>]*data-line="6"/, 'the offer stays hidden under its card');
  assert.ok(!/data-offer-said/.test(mounted(OFFER, { readOnly: true }).html()), 'no button, the offer shown');
  assert.equal(offerRows(mounted(OFFER, { readOnly: true }).html()), 0, 'read only');
  assert.equal(offerRows(mounted(OFFER, { onBuild: false }).html()), 0, 'no onBuild');
  // A Build's messages are drawn as the card's (buildMessageHtml), never as an answer with a button.
  const said = card.editor.buildMessageHtml(builds['0123456789'].messages[0]);
  assert.ok(said.includes('Want me to build it?') && !said.includes('footbuild'));
});

test('a click builds the answer\'s last fenced block, once; clicks while it starts start nothing more, and the button hides', async () => {
  let finish; const pending = new Promise((resolve) => { finish = resolve; });
  const m = mounted(answer(['Or, smaller:', '```', 'Add Haiku 5.5 only.', '```', 'Want me to build it?']), { onBuild: () => pending });
  // Two blocks: the second is built.
  const [b] = buttons(m.html());
  click(m, { act: 'footbuild', turn: String(b.turn) });
  assert.equal(m.started.length, 1);
  assert.equal(m.started[0].text, 'Add Haiku 5.5 only.', 'the last fenced block');
  assert.deepEqual([m.started[0].model, m.started[0].effort, m.started[0].askId], [undefined, undefined, undefined], 'the Build\'s own model and effort: nothing picked is sent');
  assert.deepEqual(m.started[0].place, { line: 1, text: '@bart add Haiku 5.5 to the models' });
  assert.equal(offerRows(m.html()), 0, 'hidden while it starts');
  assert.match(m.html(), /<div data-offer-said="1" [^>]*data-line="10"/, 'and so is the offer it stood for');
  click(m, { act: 'footbuild', turn: String(b.turn) });
  assert.equal(m.editor.footBuild(b.turn), false);
  assert.equal(m.started.length, 1, 'no second Build');
  // The card lands: the button stays hidden for good.
  m.props.text = [...m.lines().slice(0, -1), 'build> 0123456789', ''].join('\n');
  finish({ id: '0123456789' }); await settled();
  assert.equal(offerRows(m.html()), 0);
  for (const id of m.editor.timers) clearTimeout(id);
});

test('a Build that failed to start: its button comes back once it settles', async () => {
  let fail; const pending = new Promise((_, reject) => { fail = reject; });
  const m = mounted(OFFER, { onBuild: () => pending });
  click(m, { act: 'footbuild', turn: '1' });
  assert.equal(offerRows(m.html()), 0);
  const waits = [];
  m.editor.timer = (fn, ms) => { waits.push(ms); fn(); };
  fail(new Error('no')); await settled(); await settled();
  assert.deepEqual(waits.length, 1);
  assert.equal(offerRows(m.html()), 1, 'shown again');
  assert.equal((m.html().match(/data-offer-said=/g) || []).length, 1, 'the offer hidden under it again');
  click(m, { act: 'footbuild', turn: '1' });
  assert.equal(m.started.length, 2, 'and builds again');
});

test('"@bart yes" under the offer and the [[build]] hammer still build the fenced block', async () => {
  const m = mounted(OFFER, { route: async () => ({ id: 'route-y', agent: 'build', sure: 0.95, spec: true, by: 'model' }) });
  m.editor.followText.set(1, 'yes');
  m.editor.sendFollow(1);
  await settled();
  assert.equal(m.asked.length, 0, 'no reply of Chat\'s');
  assert.deepEqual([m.started.length, m.started[0].text, m.started[0].routedFrom], [1, 'Add Haiku 5.5 to models.cjs.', 'route-y']);
  // The [[build]] hammer: one, inline, building the block; that answer offers nothing, so no text button.
  const hammer = mounted([TITLE, '@bart add Haiku', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', 'bart> Press [[build]] Build to build it.', 'bart> *Build · Sonnet · high · 3 s*', '']);
  const html = hammer.html();
  assert.equal((html.match(/data-build-icon/g) || []).length, 1);
  assert.equal(offerRows(html), 0);
  click(hammer, { act: 'footbuild', turn: '1' });
  assert.deepEqual([hammer.started.length, hammer.started[0].text], [1, 'Add Haiku 5.5 to models.cjs.']);
  for (const id of [...m.editor.timers, ...hammer.editor.timers]) clearTimeout(id);
});
