'use strict';

// Show more under long answers (2026-10-16, David; src/renderer/workspace/DocEditor.jsx moreHtml): a conversation's first
// answer is always whole, with no toggle, and so is its latest, the one being read (2026-10-16, David); every answer
// between has one, whether it was there when the document opened or landed since. The toggle is drawn hidden; applyClips shows it once the answer is long enough to cut.
// There is no document here: the editor and its elements are stand-ins, as in doc-editor-titles.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-show-more-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const MODELS = normalizeModels(null);
const answer = (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true });

function mounted(lines) {
  const props = { docKey: 'k', text: lines.join('\n'), models: MODELS, onChange: (next) => { props.text = next; }, onAsk: () => {}, onStopAsk: () => {} };
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
  return { editor, props, html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

const toggles = (html) => [...html.matchAll(/data-more="(\d+)"[^>]*data-cut-at=/g)].map((m) => Number(m[1]));

test('a conversation\'s first answer and its latest have no Show more; each one between has one', () => {
  const lines = ['@chat why retry?', ...answer('because'), '@chat and the wait?', ...answer('it doubles'), '@chat and then?', ...answer('it stops'), ''];
  const qs = ['@chat why retry?', '@chat and the wait?', '@chat and then?'].map((q) => lines.indexOf(q));
  assert.deepEqual(toggles(mounted(lines).html()), [qs[1]]);
  // A follow-up at work: the answer before it is still the latest answered.
  const asking = [...lines.slice(0, -1), '@chat and after?', 'bart~> r1', ''];
  assert.deepEqual(toggles(mounted(asking).html()), [qs[1]]);
});

test('an answer that landed after the document opened is the latest, whole; once another lands it has one', () => {
  const first = ['@chat why retry?', ...answer('because'), ''];
  const m = mounted(first);
  assert.deepEqual(toggles(m.html()), [], 'the first answer: whole');
  const more = [...first.slice(0, -1), '@chat and the wait?', ...answer('it doubles'), ''];
  m.props.text = more.join('\n');
  assert.deepEqual(toggles(m.html()), [], 'the follow-up that just landed: the one being read');
  const again = [...more.slice(0, -1), '@chat and then?', ...answer('it stops'), ''];
  m.props.text = again.join('\n');
  assert.deepEqual(toggles(m.html()), [again.indexOf('@chat and the wait?')], 'once another lands after it');
});

test('each conversation counts from its own first answer', () => {
  const lines = ['@chat why retry?', ...answer('because'), '', 'Notes', '', '@chat what is backoff?', ...answer('waiting longer'), '@chat how long?', ...answer('a second, then two'), ''];
  assert.deepEqual(toggles(mounted(lines).html()), [], 'two answers each: the first and the latest');
  const three = [...lines.slice(0, -1), '@chat and after that?', ...answer('it gives up'), ''];
  assert.deepEqual(toggles(mounted(three).html()), [three.indexOf('@chat how long?')]);
});
