'use strict';

// A screenshot pasted into the follow-up field under an answer (src/renderer/workspace/DocEditor.jsx, 2026-10-02): it is
// saved as one pasted into the document is, named in the field as [Attachment n] numbered on from the document's images,
// and written into the asked line as ![Attachment n](img:<id>), which main sends the agent as the file's path
// (test/bart.test.cjs). There is no document here: the editor and its field are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-follow-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
// One image already in the document, then an answered @bart question: its thread starts on line 1.
const TEXT = 'A shot ![Attachment 1](img:first)\n@bart why?\nbart> because\n';
const FROM = 1;
const PNG = { type: 'image/png' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A field of the editor as the paste listener sees it: matched by its own attribute, inside the editor. */
function field(root, attr, data, value = '') {
  return {
    value, selectionStart: value.length, selectionEnd: value.length, dataset: data, style: {}, scrollHeight: 24,
    parentElement: { querySelector: () => null },
    matches: (sel) => sel.split(',').map((one) => one.trim()).includes(attr),
    closest: (sel) => (sel === '[data-editor]' ? root : null),
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; },
  };
}

/** An editor as mounted, with a follow-up field holding `typed`; each pasted image saves as img-1, img-2… */
function mounted({ text = TEXT, typed = '' } = {}) {
  const changes = [], asks = [], saved = [];
  const props = { docKey: 'k', text, onChange: (next) => { changes.push(next); props.text = next; }, onAsk: (ask) => asks.push(ask), onPasteImage: async (file, name) => { saved.push(name); return { id: `img-${saved.length}` }; } };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, contains: () => false, querySelector: (sel) => (sel === `[data-follow-input="${FROM}"]` ? root.field : null) };
  root.field = field(root, '[data-follow-input]', { followInput: String(FROM) }, typed);
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
  if (typed) editor.followInput(root.field);
  const paste = (target, files = [], plain = '') => {
    const e = { target, clipboardData: { files, getData: () => plain }, prevented: false, preventDefault() { this.prevented = true; } };
    editor.docListeners.paste(e);
    return e;
  };
  return { editor, root, paste, changes, asks, saved };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a paste goes to the field it lands in: a follow-up\'s, a Build reply\'s, a card\'s, or the document', () => {
  const { editor, root, paste } = mounted();
  const went = [];
  editor.followPaste = () => went.push('follow');
  editor.buildPaste = () => went.push('build');
  editor.editorPaste = () => went.push('document');
  paste(root.field);
  paste(field(root, '[data-build-input]', { buildInput: 'abc' }));
  paste(field(root, '[data-card-input]', { cardInput: '1' }));
  paste({ closest: () => root, matches: () => false });
  assert.deepEqual(went, ['follow', 'build', 'document'], 'a card\'s field keeps its paste to itself, as before');
});

test('an image pasted into a follow-up is saved and named [Attachment n] at the caret, numbered on from the document', async () => {
  const { editor, root, paste, saved, changes } = mounted({ typed: 'what is  showing?' });
  root.field.selectionStart = root.field.selectionEnd = 'what is '.length;
  assert.equal(paste(root.field, [PNG]).prevented, true);
  await settle();
  assert.deepEqual(saved, ['Attachment 2'], 'the document holds one image already');
  assert.equal(root.field.value, 'what is [Attachment 2]  showing?');
  assert.equal(editor.followText.get(FROM), root.field.value, 'what the field holds is kept, as typing keeps it');
  // The next counts the field's own images too: two at once are 3 and 4.
  paste(root.field, [PNG, { type: 'image/jpeg' }]);
  await settle(); await settle();
  assert.deepEqual(saved, ['Attachment 2', 'Attachment 3', 'Attachment 4']);
  assert.deepEqual(editor.followImages.get(FROM), [{ n: 2, id: 'img-1' }, { n: 3, id: 'img-2' }, { n: 4, id: 'img-3' }]);
  assert.deepEqual(changes, [], 'nothing is written to the document before it is sent');
});

test('a text paste into a follow-up is the field\'s own, as before; so is a file that is not an image', async () => {
  const { editor, root, paste, saved } = mounted();
  assert.equal(paste(root.field, [], 'line one\nline two').prevented, false);
  assert.equal(paste(root.field, [{ type: 'application/pdf' }]).prevented, false);
  await settle();
  assert.deepEqual(saved, []);
  assert.equal(editor.followImages.size, 0);
});

test('an image that saves after its field was redrawn away is added to what the field will hold', async () => {
  const { editor, root, paste } = mounted({ typed: 'look' });
  const pasted = root.field;
  root.field = null; // redrawn: the field pasted into is gone, and no other stands there yet
  paste(pasted, [PNG]);
  await settle();
  assert.equal(editor.followText.get(FROM), 'look [Attachment 2] ');
});

test('sending writes each pasted image into the line as an image pasted on a line is, and asks with the same text', async () => {
  const { editor, root, paste, asks, changes } = mounted({ typed: 'compare' });
  paste(root.field, [PNG, PNG, PNG]);
  await settle(); await settle(); await settle();
  assert.equal(root.field.value, 'compare [Attachment 2] [Attachment 3] [Attachment 4] ');
  // Attachment 3 is deleted before sending, and a [Attachment 9] typed by hand names no image.
  root.field.value = 'compare [Attachment 2] [Attachment 4] with [Attachment 9]';
  editor.followInput(root.field);
  editor.sendFollow(FROM);
  const asked = 'compare ![Attachment 2](img:img-1) ![Attachment 4](img:img-3) with [Attachment 9]';
  assert.equal(asks.length, 1);
  assert.equal(asks[0].text, asked);
  assert.equal(asks[0].agent, 'bart');
  assert.deepEqual(asks[0].turns, [{ question: 'why?', answer: 'because' }]);
  const lines = changes[changes.length - 1].split('\n');
  assert.equal(lines[3], `@bart ${asked}`, 'the line under the answer holds the images as ![Attachment n](img:<id>)');
  assert.match(lines[4], /^bart~> /);
  assert.ok(!lines.join('\n').includes('img-2'), 'the deleted one is not sent');
  assert.equal(editor.followImages.has(FROM), false, 'the field\'s images go with the send');
  assert.equal(editor.followText.has(FROM), false);
});

test('a follow-up with no image is sent as it always was', () => {
  const { editor, asks, changes } = mounted({ typed: 'and then?' });
  editor.sendFollow(FROM);
  assert.equal(asks[0].text, 'and then?');
  assert.equal(changes[0].split('\n')[3], '@bart and then?');
});
