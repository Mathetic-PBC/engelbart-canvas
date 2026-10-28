'use strict';

// An answer offering to build its fenced prompt (MATH-160, 2026-10-27): Chat writes a Build prompt as a fenced block and
// ends "Want me to build it?" (main's bart/ask.cjs ROUTED_BUILD). From 2026-10-27 a Build button, then a "Build this
// prompt?" bar, stood in for that line; since 2026-10-28 (David) the line is plain text again, answered in the reply field:
// "@bart yes" builds the block on that line's model (MATH-168). The [[build]] hammer still builds it (footBuild).

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
const offerRows = (html) => (html.match(/data-build-offer=/g) || []).length;

const TITLE = 'bart# [chat 2026-10-27T09:00:00Z] Haiku';
const answer = (said, { foot = 'bart> *Chat · Sonnet · high · 3 s*' } = {}) => [TITLE, '@bart add Haiku 5.5 to the models', 'bart> Here is the Build prompt:', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', ...said.map((l) => `bart> ${l}`), foot, ''];
const OFFER = answer(['Want me to build it?']);

test('a build offer is plain text: "Want me to build it?" drawn as the answer\'s last line, with no Build bar or button under it', () => {
  const html = mounted(OFFER).html();
  assert.equal(offerRows(html), 0, 'no bar');
  assert.doesNotMatch(html, /data-offer-bar|data-offer-said|data-act="offerpick"|Build this prompt/);
  assert.match(html, /<div data-line="6" [^>]*>[\s\S]*?Want me to build it\?/, 'the offer, drawn as any line of the answer');
});

test('"@bart yes" under the offer and the [[build]] hammer still build the fenced block', async () => {
  const m = mounted(OFFER, { route: async () => ({ id: 'route-y', agent: 'build', sure: 0.95, spec: true, by: 'model' }) });
  m.editor.followText.set(1, 'yes');
  m.editor.sendFollow(1);
  await settled();
  assert.equal(m.asked.length, 0, 'no reply of Chat\'s');
  assert.deepEqual([m.started.length, m.started[0].text, m.started[0].routedFrom], [1, 'Add Haiku 5.5 to models.cjs.', 'route-y']);
  assert.deepEqual(m.started[0].choice, { provider: 'anthropic', model: 'sonnet', effort: 'high' }, 'on the "yes" line\'s model (MATH-168)');
  // The [[build]] hammer: one, inline, building the block.
  const hammer = mounted([TITLE, '@bart add Haiku', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', 'bart> Press [[build]] Build to build it.', 'bart> *Build · Sonnet · high · 3 s*', '']);
  const html = hammer.html();
  assert.equal((html.match(/data-build-icon/g) || []).length, 1);
  assert.equal(offerRows(html), 0);
  click(hammer, { act: 'footbuild', turn: '1' });
  assert.deepEqual([hammer.started.length, hammer.started[0].text], [1, 'Add Haiku 5.5 to models.cjs.']);
  for (const id of [...m.editor.timers, ...hammer.editor.timers]) clearTimeout(id);
});

test('a blank line under a code block is 8px, not the 22px between paragraphs: no gap over "Want me to build it?"', () => {
  const html = mounted(answer(['', 'Want me to build it?'])).html();
  const row = (h, i) => { const at = h.indexOf(`<div data-line="${i}" `); return h.slice(at, h.indexOf('</div>', at)); };
  assert.match(row(html, 6), /<span class="t" style="display:block;min-height:8px;height:8px;overflow:hidden;/, 'under the closing fence');
  const prose = mounted([TITLE, '@bart why?', 'bart> First.', 'bart> ', 'bart> Second.', 'bart> *Chat · Sonnet · high · 3 s*', '']).html();
  assert.match(row(prose, 3), /<span class="t" style="display:block;min-height:22px;border-radius/, 'between paragraphs, as before');
});
