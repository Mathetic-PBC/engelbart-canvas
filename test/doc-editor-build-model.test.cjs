'use strict';

// A Build's model (MATH-162, 2026-10-27; since 2026-10-28, MATH-168): a Build from an `@bart` line runs on that line's
// model, `--build` or not, the chip being @bart's as on any line and a pick written into the line as flags. A Build card's
// model is plain words: what that Build runs on. The Build default (model/build-default.js) is the Build panel's alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { normalizeModels, buildChoices } = require('../src/main/bart/models.cjs');

const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } }).outputFiles[0].text;
// A fresh copy each time: the Build default is kept per window (model/build-default.js), and each test is a window.
function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-build-model-unit.cjs');
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled, filename);
  return compiled.exports.default;
}

// Main's side of the bridge: Build's list (Opus High by default; @bart's own is Sonnet High), and the picks saved.
function bridge({ held = false } = {}) {
  const saved = [];
  let list = buildChoices(normalizeModels(null)), release = null;
  const gate = held ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  return {
    saved,
    release: () => release && release(),
    api: {
      buildModels: (place) => { assert.equal(place, 'build'); const value = list; return gate.then(() => value); },
      rememberModelChoice: (place, choice) => {
        saved.push([place, choice]);
        list = { ...list, provider: choice.provider, providers: { ...list.providers, [choice.provider]: { ...list.providers[choice.provider], ladder: [{ model: choice.model, effort: choice.effort }] } } };
        return Promise.resolve({});
      },
    },
  };
}

function mounted(lines, { builds = {}, api = bridge().api } = {}) { // api null: no bridge
  const DocEditor = loadEditor(), asks = [];
  const props = {
    docKey: 'k', text: lines.join('\n'), models: normalizeModels(null), builds,
    onChange: (next) => { props.text = next; },
    onAsk: (ask) => asks.push(ask), onRoute: () => null, onRouteGone: () => {}, onBuild: () => undefined,
  };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [] };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  let redrawn = 0;
  editor.forceUpdate = () => { redrawn += 1; };
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, engelbartAPI: api };
  editor.componentDidMount();
  return { editor, props, asks, lines: () => props.text.split('\n'), html: () => editor.editorHtml(), redrawn: () => redrawn };
}
test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

const settled = () => new Promise((resolve) => setImmediate(resolve));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// What opened a selector: its data, and where it is.
const at = (dataset) => { const el = { dataset, getBoundingClientRect: () => ({ left: 10, right: 120, top: 40, bottom: 68 }) }; el.closest = () => el; return el; };
const lineChip = (html, i) => { const m = html.match(new RegExp(`<span data-act="pick" data-row="${i}"[^>]*>([^<]*)<`)); return m ? m[1] : null; };
const isBuildPicker = (view) => !!view && !!view.props.models && !view.props.models.build && Object.keys(view.props.models.providers).every((id) => view.props.models.providers[id].ladder.length === 1);

const ID = '0123456789';
const TITLE = 'bart# [chat 2026-10-27T09:00:00Z] Haiku';
const task = (extra) => ({ id: ID, title: 'Add Haiku', status: 'running', messages: [], model: 'sol', modelName: 'Sol', effort: 'high', ...extra });

test('a Build card\'s model is plain words, what the Build runs or ran on: no chip, no selector', async () => {
  const m = mounted([TITLE, '@bart --build add Haiku 5.5 to the models', `build> ${ID}`, ''], { builds: { [ID]: task({ status: 'review', ranModel: 'gpt-6-sol' }) } });
  await settled();
  const head = (parts) => new Map(parts).get('head');
  for (const html of [m.html(), head(m.editor.buildParts(ID, task())), head(m.editor.taskParts(ID, task({ kind: 'build' })))]) {
    assert.doesNotMatch(html, /data-act="(?:buildmodel|offerpick)"/);
  }
  assert.match(m.html(), /<span style="flex:none;font-size:12\.5px;color:#8f8f8f">Sol \(ran as gpt-6-sol\) · High<\/span>/);
});

test('a --build line\'s chip is @bart\'s, as any line\'s: its flags name the model', async () => {
  const m = mounted(['@bart --build add Haiku 5.5', '', '@bart why is this slow', '', '@bart --opus --medium --build add Luna']);
  await settled();
  const html = m.html();
  assert.equal(lineChip(html, 0), 'Sonnet High', '@bart\'s default, not the Build default');
  assert.equal(lineChip(html, 2), 'Sonnet High');
  assert.equal(lineChip(html, 4), 'Opus Medium', 'its flags');
  m.editor.openPicker(at({ act: 'pick', row: '0' }), 'line');
  assert.equal(isBuildPicker(m.editor.pickerView()), false, '@bart\'s selector');
});

test('a pick on a --build line is written into it as flags, as on any line; the Build default is not touched', async () => {
  const b = bridge();
  const m = mounted(['@bart --build add Haiku 5.5'], { api: b.api });
  await settled();
  m.editor.openPicker(at({ act: 'pick', row: '0' }), 'line');
  m.editor.pickerView().props.onPick({ provider: 'anthropic', model: 'opus', effort: 'max' });
  assert.equal(m.lines()[0], '@bart --opus --max --build add Haiku 5.5');
  assert.deepEqual(b.saved, [], 'nothing saved for Build');
  assert.equal(lineChip(m.html(), 0), 'Opus Max');
});

test('a --build line\'s Build runs on the line\'s model and is given the conversation above it', async () => {
  const m = mounted(['@bart --opus --medium --build add Haiku 5.5', 'bart~> a1', '']);
  await settled();
  assert.equal(m.editor.handOff('a1', { id: 'route-1', agent: 'build', rule: '--build', sure: 1 }), 'build');
  assert.equal(m.asks.length, 1);
  assert.deepEqual(m.asks[0].build, { choice: { provider: 'anthropic', model: 'opus', effort: 'medium' }, context: [] });
  const plain = mounted(['@bart --build add Haiku 5.5', 'bart~> a2', '']);
  await settled();
  plain.editor.handOff('a2', { id: 'route-2', agent: 'build', rule: '--build', sure: 1 });
  assert.deepEqual(plain.asks[0].build.choice, { provider: 'anthropic', model: 'sonnet', effort: 'high' }, 'no flags: @bart\'s default');
});
