'use strict';

// The Build default where a Build is made (MATH-162, 2026-10-27): an unsent `@bart --build` line's chip names the Build
// default and opens Build's selector; a pick there is the default (rememberModelChoice('build'), as the Build panel's),
// redrawn on every chip that shows it. A Build card's model is plain words (2026-10-28): what that Build runs on.

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
  const DocEditor = loadEditor();
  const props = {
    docKey: 'k', text: lines.join('\n'), models: normalizeModels(null), builds,
    onChange: (next) => { props.text = next; },
    onAsk: () => {}, onRoute: () => null, onRouteGone: () => {}, onBuild: () => undefined,
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
  return { editor, props, lines: () => props.text.split('\n'), html: () => editor.editorHtml(), redrawn: () => redrawn };
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

test('an unsent --build line\'s chip names the Build default; a plain @bart line\'s names @bart\'s model', async () => {
  const m = mounted(['@bart --build add Haiku 5.5', '', '@bart why is this slow', '', '@bart --sonnet --medium --build add Luna']);
  await settled();
  const html = m.html();
  assert.equal(lineChip(html, 0), 'Opus High', 'Build\'s default');
  assert.equal(lineChip(html, 2), 'Sonnet High', '@bart\'s model');
  assert.equal(lineChip(html, 4), 'Opus High', 'its flags still do not choose a Build\'s model, as today');
  assert.equal(m.editor.buildLineAt(0), true);
  assert.equal(m.editor.buildLineAt(2), false);
});

test('while Build\'s list is read, a --build line\'s chip shows nothing rather than @bart\'s model', async () => {
  const b = bridge({ held: true });
  const m = mounted(['@bart --build add Haiku 5.5', '@bart why'], { api: b.api });
  await settled();
  assert.equal(lineChip(m.html(), 0), null, 'no label yet');
  assert.doesNotMatch(m.html().split('data-line="1"')[0], /Sonnet/, 'never @bart\'s model');
  assert.equal(lineChip(m.html(), 1), 'Sonnet High', 'a plain line is as before');
  m.editor.openPicker(at({ act: 'pick', row: '0' }), 'line');
  assert.equal(m.editor.pickerView(), null, 'no selector until the list is read');
  b.release(); await settled();
  assert.equal(lineChip(m.html(), 0), 'Opus High');
  assert.ok(isBuildPicker(m.editor.pickerView()));
});

test('typing or taking out --build changes the chip and which selector it opens', async () => {
  const m = mounted(['@bart add Haiku 5.5']);
  await settled();
  const open = () => { m.editor.state.picker = null; m.editor.openPicker(at({ act: 'pick', row: '0' }), 'line'); return m.editor.pickerView(); };
  assert.equal(lineChip(m.html(), 0), 'Sonnet High');
  assert.equal(isBuildPicker(open()), false, '@bart\'s selector');
  m.props.text = '@bart --build add Haiku 5.5';
  assert.equal(lineChip(m.html(), 0), 'Opus High');
  assert.equal(isBuildPicker(open()), true, 'Build\'s selector');
  // Open while --build is taken out: the same chip's menu becomes @bart's.
  m.props.text = '@bart add Haiku 5.5';
  assert.equal(isBuildPicker(m.editor.pickerView()), false);
  assert.equal(lineChip(m.html(), 0), 'Sonnet High');
});

test('a pick on a --build line saves the Build default and writes no flags; on a plain line it writes them, as before', async () => {
  const b = bridge();
  const m = mounted(['@bart --build add Haiku 5.5', '', '@bart why is this slow'], { api: b.api });
  await settled();
  m.editor.openPicker(at({ act: 'pick', row: '0' }), 'line');
  m.editor.pickerView().props.onPick({ provider: 'anthropic', model: 'sonnet', effort: 'medium' });
  await settled();
  assert.deepEqual(b.saved, [['build', { provider: 'anthropic', model: 'sonnet', effort: 'medium' }]]);
  assert.equal(m.lines()[0], '@bart --build add Haiku 5.5', 'the line as typed');
  assert.equal(lineChip(m.html(), 0), 'Sonnet Medium');
  // The same pick through pickModel (the line's own handler) is Build's too.
  m.editor.pickModel({ provider: 'anthropic', model: 'fable', effort: 'high' });
  await settled();
  assert.equal(m.lines()[0], '@bart --build add Haiku 5.5');
  assert.equal(b.saved.length, 2);
  // A plain @bart line: flags in the line, the Build default untouched.
  m.editor.state.picker = null;
  m.editor.openPicker(at({ act: 'pick', row: '2' }), 'line');
  m.editor.pickerView().props.onPick({ provider: 'anthropic', model: 'opus', effort: 'max' });
  assert.equal(m.lines()[2], '@bart --opus --max why is this slow');
  assert.equal(b.saved.length, 2, 'nothing saved for Build');
  assert.equal(lineChip(m.html(), 0), 'Fable High');
});

test('without the bridge (a post-it\'s window) nothing breaks: no Build default, @bart lines as before', async () => {
  const m = mounted(['@bart --build add Haiku', '@bart why'], { api: null });
  await settled();
  assert.equal(lineChip(m.html(), 0), null);
  assert.equal(lineChip(m.html(), 1), 'Sonnet High');
});
