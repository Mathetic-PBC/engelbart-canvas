'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

// Exercise the real editor's shortcut/history methods without mounting a browser or touching user documents.
const filename = path.join(__dirname, '__doc-editor-unit.cjs');
const built = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react-dom'], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
});
const compiled = new Module(filename, module);
compiled.paths = module.paths;
const previousWindow = global.window;
global.window = { engelbartAPI: { saveSessionUI: async () => true } };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const DocEditor = compiled.exports.default;
const { DEFAULT_MODELS, readQuestion } = require('../src/main/bart/models.cjs');

function editor(text, selection) {
  const instance = new DocEditor({ docKey: 'test', text, onChange: (next) => { instance.props = { ...instance.props, text: next }; } });
  instance.caretInfo = () => selection;
  instance.setState = (change) => { instance.state = { ...instance.state, ...(typeof change === 'function' ? change(instance.state) : change) }; };
  return instance;
}
const range = (from, to, offset = 1) => ({ anchor: { line: from, offset: 0 }, focus: { line: to, offset } });

test('the shared editor loads in a sticky note with only the restricted post-it bridge', () => {
  const filename = path.join(__dirname, '__post-it-editor-unit.cjs'), compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const previous = global.window;
  global.window = { postItAPI: {} };
  try {
    compiled._compile(built.outputFiles[0].text, filename);
    const PostItEditor = compiled.exports.default;
    const ed = new PostItEditor({ compact: true, docKey: 'sticky-note', text: '**My note**', onChange: () => {} });
    ed.restoreDrafts(); ed.saveDrafts();
    assert.match(ed.editorHtml(), /<strong\b[^>]*>My note<\/strong>/);
    assert.equal(global.window.engelbartAPI, undefined, 'the editor never adds the main-window API');
  } finally { if (previous === undefined) delete global.window; else global.window = previous; }
});

test('unsent replies reopen on the same question, including after surrounding lines move', () => {
  const ed = editor('@bart Explain anchors\nbart> Answer.');
  ed.props = { ...ed.props, viewScope: 'draft-test' };
  ed.followText.set(0, 'What about a rebuild?'); ed.followChoice.set(0, 'astra'); ed.saveDrafts();
  const reopened = editor('A new paragraph\n\n@bart Explain anchors\nbart> Answer.');
  reopened.props = { ...reopened.props, viewScope: 'draft-test' }; reopened.restoreDrafts();
  assert.equal(reopened.followText.get(2), 'What about a rebuild?');
  assert.equal(reopened.followChoice.get(2), 'astra');
  reopened.props = { ...reopened.props, text: '@bart Different question\nbart> Answer.' }; reopened.restoreDrafts();
  assert.equal(reopened.followText.size, 0, 'a removed question never lends its draft to another thread');
  reopened.props = { ...ed.props, viewScope: 'another-workspace' }; reopened.restoreDrafts();
  assert.equal(reopened.followText.size, 0, 'drafts do not leak between workspaces');
});

test('reply borders start 12px outside the user box without changing the text inset', () => {
  for (const answer of ['bart> First line\nbart> Second line', 'bart~> pending', 'bart> ```json\nbart> {}\nbart> ```']) {
    const ed = editor(`@bart Check this\n${answer}`);
    const html = ed.editorHtml();
    const question = html.match(/data-line="0"[^>]*style="([^"]*)"/)[1];
    const reply = html.match(/data-line="1"[^>]*style="([^"]*)"/)[1];
    assert.match(question, /background:#f5f5f5;/);
    assert.match(reply, /^margin-top:12px;margin-left:16px;padding:16px 0 \d+px 16px;border-left:2px solid #e2e2e2;/);
    if (answer.startsWith('bart> First')) {
      const continuation = html.match(/data-line="2"[^>]*style="([^"]*)"/)[1];
      assert.match(continuation, /^margin-top:0px;/, 'the rule remains continuous within a reply');
    }
  }
});

test('code context is a synchronized control, not editable question or reply text', () => {
  const source = '@bart --astra Explain this code', ed = editor(source);
  let asked;
  ed.props = { ...ed.props, models: DEFAULT_MODELS, onAsk: value => { asked = value; }, onChooseRepository: () => {},
    repository: { name: 'Project <code>', directory: '/project/code', inherited: true } };
  assert.match(ed.editorHtml(), /data-code-context="1"/);
  assert.match(ed.repositoryControl(), /Code context: Project &lt;code&gt; ⌄/);
  assert.doesNotMatch(ed.repositoryControl(), /Project default/);
  assert.match(ed.repositoryControl(), /title="\/project\/code"/);
  ed.props = { ...ed.props, repository: { name: 'Override', directory: '/other', inherited: false } };
  assert.match(ed.editorHtml(), /Code context: Override/);
  assert.doesNotMatch(ed.repositoryControl(), /Project default/);
  assert.equal(ed.props.text, source);
  ed.askInline(0);
  assert.equal(asked.text, '--astra Explain this code');
  assert.equal(asked.repository, undefined, 'the renderer cannot choose a different target for one request');
  ed.props = { ...ed.props, text: `${source}\nbart> Existing answer` };
  assert.match(ed.editorHtml(), /data-code-context="1"/, 'follow-ups offer the same connection control');
});

test('Bart messages hide routing flags while keeping question text and request settings', () => {
  for (const question of [
    '--astra --xhigh Explain **this** --verbose option',
    'Explain **this** --verbose option --astra --xhigh',
    '--astra Explain **this** --verbose option --xhigh',
  ]) {
    const source = `@bart ${question}`, ed = editor(source, null);
    let asked;
    ed.props = { ...ed.props, models: DEFAULT_MODELS, onAsk: (request) => { asked = request; } };
    for (const activeLine of [null, 0]) {
      ed.state.activeLine = activeLine;
      const html = ed.editorHtml(), visible = html.replace(/<[^>]*>/g, '');
      assert.doesNotMatch(visible, /--astra|--xhigh/);
      assert.match(visible, /@bart Explain this --verbose option/);
      assert.equal(ed.props.text, source);
    }
    ed.askInline(0);
    assert.equal(asked.text, question);
    assert.deepEqual(readQuestion(asked.text, DEFAULT_MODELS).steps.map(({ key, effort }) => ({ key, effort })), [{ key: 'astra', effort: 'xhigh' }]);
    assert.doesNotMatch(ed.editorHtml().replace(/<[^>]*>/g, ''), /--astra|--xhigh/, 'sent messages also hide their routing flags');
  }
});

test('Bart flag hiding leaves literal command text and unrecognised options visible', () => {
  for (const text of ['@bart What does `--astra` do?', '@bart --unknown Explain this', '@bart Explain --astra in this command']) {
    const ed = editor(text, null);
    ed.props = { ...ed.props, models: DEFAULT_MODELS };
    assert.match(ed.editorHtml().replace(/<[^>]*>/g, ''), text.includes('--unknown') ? /--unknown/ : /--astra/);
  }
});

test('build intent stays visible and is never silently inherited by a follow-up', () => {
  const ed = editor('@bart --build --astra --high Make a timer\nbart> Created.', null);
  ed.props = { ...ed.props, models: DEFAULT_MODELS };
  const visible = ed.editorHtml().replace(/<[^>]*>/g, '');
  assert.match(visible, /--build/);
  assert.doesNotMatch(visible, /--astra|--high/);
  const follow = ed.followStep(ed.lines(), { from: 0, turns: [{ q: 0 }] });
  assert.equal(follow.flags, '--astra --high');
  assert.equal(readQuestion(follow.flags, DEFAULT_MODELS).build, false);
});

test('Bart links to notification approval instead of duplicating controls in the document', () => {
  const source = '@bart --build Make a timer\nbart~> build-request';
  const ed = editor(source, null), replies = [];
  ed.props = { ...ed.props, asks: { 'build-request': { localBuild: { id: 'preview' }, buildApproval: { id: 'approval' } } }, onShowLocalBuild: id => replies.push(id) };
  const html = ed.editorHtml();
  assert.match(html, /Review it in Notifications/);
  assert.match(html, /data-act="showbuild"/);
  assert.doesNotMatch(html, /data-act="approvebuild"|data-act="declinebuild"/);
  assert.doesNotMatch(html, /animation:thinking|Thinking|Build and Run Locally/);
  assert.equal(ed.props.text, source, 'approval is transient UI, not document content');
  ed.editorEl = () => null;
  ed.editorClick({ preventDefault() {}, target: { closest: () => ({ dataset: { act: 'showbuild', build: 'preview' } }) } });
  assert.deepEqual(replies, ['preview']);
  ed.props.asks['build-request'] = { activity: 'Building the interface', buildApproval: null };
  assert.doesNotMatch(ed.editorHtml(), /data-build-approval/);
});

test('typing beside hidden flags preserves the routing choice, including an empty draft', () => {
  for (const [source, at, text, expected] of [
    ['@bart --astra --xhigh Draft', 21, 'New ', '@bart --astra --xhigh New Draft'],
    ['@bart --astra --xhigh ', 6, 'Hello', '@bart --astra --xhigh Hello'],
    ['@bart --astra --xhigh', 6, 'Hello', '@bart --astra --xhigh Hello'],
    ['@bart Draft --astra --xhigh', 11, '!', '@bart Draft! --astra --xhigh'],
  ]) {
    const position = { line: 0, offset: at }, ed = editor(source, { anchor: position, focus: position });
    ed.props = { ...ed.props, models: DEFAULT_MODELS };
    let prevented = false;
    ed.beforeBartInput({ inputType: 'insertText', data: text, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ed.props.text, expected);
    const chosen = readQuestion(ed.props.text.slice(6), DEFAULT_MODELS).steps[0];
    assert.equal(chosen.key, 'astra');
    assert.equal(chosen.effort, 'xhigh');
  }
});

function shortcut(instance, options = {}) {
  let prevented = false;
  instance.editorKey({ key: 'J', metaKey: true, shiftKey: true, preventDefault: () => { prevented = true; }, ...options });
  return prevented;
}

test('Cmd+Shift+J is one undoable JSON edit and keeps the whole code body selected', () => {
  const text = 'Before\n{\n  "ok": true\n}\nAfter', ed = editor(text, range(1, 3));
  ed.state.statuses = { test: { 0: 'done', 4: 'done' } };
  assert.equal(shortcut(ed), true);
  const result = 'Before\n```json\n{\n  "ok": true\n}\n```\nAfter';
  assert.equal(ed.props.text, result);
  assert.equal(ed.history.length, 1);
  assert.deepEqual(ed.caret, { line: 2, sel: [0, 1], endLine: 4 });
  assert.deepEqual(ed.state.statuses.test, { 0: 'done', 6: 'done' });
  ed.undo(); assert.equal(ed.props.text, text);
  ed.redo(); assert.equal(ed.props.text, result);
});

test('Ctrl+Shift+J works too; ordinary typing, composition and held keys do not format', () => {
  const text = '{"ok":true}', ed = editor(text, range(0, 0, text.length));
  assert.equal(shortcut(ed, { metaKey: false, ctrlKey: true }), true);
  assert.match(ed.props.text, /^```json\n/);
  for (const options of [{ shiftKey: false }, { metaKey: false }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
    const untouched = editor(text, range(0, 0, text.length));
    shortcut(untouched, options);
    assert.equal(untouched.props.text, text);
  }
  const composing = editor(text, range(0, 0)); composing.composing = true; shortcut(composing);
  assert.equal(composing.props.text, text);
});

test('formatting respects locked answers, attribution lines and running task rows', () => {
  for (const text of ['bart+> folded', 'bart> *Model · 1 s*', '> legacy reply', '@bart question\nbart~> pending']) {
    const ed = editor(text, range(0, 0)); shortcut(ed);
    assert.equal(ed.props.text, text); assert.equal(ed.history.length, 0);
  }
  const busy = editor('- [ ] working', range(0, 0)); busy.state.statuses = { test: { 0: 'building' } }; shortcut(busy);
  assert.equal(busy.props.text, '- [ ] working');
});

test('select-all on the editor root formats all lines and selection outside the editor is ignored', (t) => {
  const prior = global.getSelection;
  t.after(() => { if (prior === undefined) delete global.getSelection; else global.getSelection = prior; });
  const nodes = [0, 1, 2].map((line) => ({ dataset: { line: String(line) } }));
  const root = { contains: (node) => node === root, querySelectorAll: () => nodes };
  const selected = { startContainer: root, endContainer: root, intersectsNode: () => true };
  global.getSelection = () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => selected });
  const ed = editor('{\n  "ok": true\n}', null); ed.editorEl = () => root;
  shortcut(ed);
  assert.equal(ed.props.text, '```json\n{\n  "ok": true\n}\n```\n');
  const oneRootEnd = editor('{\n  "ok": true\n}', range(0, 0)); oneRootEnd.editorEl = () => root;
  shortcut(oneRootEnd);
  assert.equal(oneRootEnd.props.text, ed.props.text, 'a root endpoint cannot fall back to formatting only the anchor line');
  const outside = editor('untouched', null); outside.editorEl = () => root; selected.endContainer = {};
  shortcut(outside); assert.equal(outside.props.text, 'untouched');
  const partial = editor('untouched', range(0, 0)); partial.editorEl = () => root;
  shortcut(partial); assert.equal(partial.props.text, 'untouched', 'a selection beginning inside but ending outside is ignored');
});

test('restoring a JSON selection uses the last selected line, not an offset on the first', () => {
  const ed = editor('', range(0, 0));
  ed.caret = { line: 2, sel: [0, 5], endLine: 6 };
  let applied;
  ed.setSelection = (...args) => { applied = args; };
  ed.applyCaret();
  assert.deepEqual(applied, [2, 0, 5, 6]);
  assert.equal(ed.caret, null);
});
