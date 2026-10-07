'use strict';

// MATH-22 (2026-10-06): in a document's @ menu a library folder opens in place (listFolder, live), a subfolder a level
// deeper; the back row or Backspace with nothing typed goes up; a file picked is written `@[Name](lib:<folderId>:<path>)`
// and links its folder (onMentionPicked with the folder's row). Its chip opens the file (onOpenFile). There is no
// document here: the editor and its elements are stand-ins, as in doc-editor-mention-keys.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-folder-mentions-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const DocEditor = load('DocEditor.jsx').default;

const FOLDER = { id: 'f-1', name: 'Papers', type: 'folder', tags: [], folder_path: '/home/papers' };
const LEVELS = {
  '': { entries: [{ name: 'sub dir', rel: 'sub dir', dir: true, type: 'folder' }, { name: 'top.md', rel: 'top.md', dir: false, type: 'md' }], total: 2 },
  'sub dir': { entries: [{ name: 'Smith (2024).pdf', rel: 'sub dir/Smith (2024).pdf', dir: false, type: 'pdf' }], total: 1 },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

function mounted(lines) {
  const picked = [], asked = [], opened = [];
  const props = {
    docKey: 'k', text: lines.join('\n'), mentionable: [FOLDER], onChange: (next) => { props.text = next; },
    onMentionPicked: (r) => picked.push(r.row ? r.row.id : r.id),
    listFolder: async (id, rel) => { asked.push([id, rel]); return { id, rel, missing: false, ...LEVELS[rel] }; },
    onOpenFile: (file, options) => opened.push([file, options]),
  };
  const editor = new DocEditor(props);
  editor.props = props;
  editor.mounted = true;
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.scrollRef = { current: null };
  editor.caretInfo = () => null;
  const caretAt = (line, offset) => { editor.caretInfo = () => ({ anchor: { line, offset }, focus: { line, offset } }); };
  const key = (k, extra = {}) => {
    const e = { key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    editor.editorKey(e);
    return e;
  };
  return { editor, props, picked, asked, opened, caretAt, key, lines: () => editor.lines() };
}
const names = (rows) => rows.map((m) => `${m.kind}:${m.name}`);

test('a folder picked opens in the menu; a subfolder goes deeper; Backspace on nothing typed and the back row go up', async () => {
  const m = mounted(['See @pap']);
  m.editor.state.mention = { i: 0, start: 4, caret: 8, query: 'pap' };
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'Papers' });
  assert.equal(m.lines()[0], 'See @', 'what found the folder goes; the @ stays');
  assert.deepEqual(m.picked, [], 'nothing mentioned, nothing linked yet');
  assert.deepEqual(names(m.editor.mentionList()), ['back:All', 'note:Opening…']);
  await settle();
  assert.deepEqual(m.asked, [['f-1', '']]);
  const top = m.editor.mentionList();
  assert.deepEqual(names(top), ['back:All', 'self:Mention this folder', 'entry:sub dir', 'entry:top.md']);
  assert.equal(m.editor.state.mentionIdx, 2, 'the keyboard on the first entry');

  m.caretAt(0, 5);
  m.key('Enter'); // the subfolder
  await settle();
  assert.deepEqual(m.asked[1], ['f-1', 'sub dir'], 'listed live, each time');
  assert.deepEqual(names(m.editor.mentionList()), ['back:Papers', 'self:Mention this folder', 'entry:Smith (2024).pdf']);

  assert.equal(m.key('Backspace').prevented, true, 'Backspace with nothing typed: up, the @ kept');
  await settle();
  assert.equal(m.lines()[0], 'See @');
  assert.equal(m.editor.state.browse.rel, '');
  m.editor.pickMention(m.editor.mentionList()[0]); // the back row, at the folder's top: the whole menu again
  assert.equal(m.editor.browsing(), null);
});

test('a file picked is written with its folder\'s id and its encoded path, links the folder, and opens from its chip', async () => {
  const m = mounted(['See @']);
  m.editor.state.mention = { i: 0, start: 4, caret: 5, query: '' };
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'Papers' });
  await settle();
  m.editor.pickMention(m.editor.mentionList().find((r) => r.name === 'sub dir'));
  await settle();
  m.editor.state.mention = { ...m.editor.state.mention, query: 'smi', caret: 8 };
  m.props.text = 'See @smi';
  assert.deepEqual(names(m.editor.mentionList()), ['entry:Smith (2024).pdf'], 'typed: narrowed, the match first');
  m.editor.pickMention(m.editor.mentionList()[0]);
  const token = '@[Smith (2024).pdf](lib:f-1:sub%20dir/Smith%20%282024%29.pdf)';
  assert.equal(m.lines()[0], `See ${token}`);
  assert.deepEqual(m.picked, ['f-1'], 'its folder comes into the workspace');
  assert.deepEqual(m.editor.caret, { line: 0, offset: 4 + token.length });

  const html = m.editor.editorHtml();
  assert.match(html, /data-folder="f-1" data-file="sub dir\/Smith \(2024\)\.pdf"/);
  assert.match(html, /title="Papers \/ sub dir\/Smith \(2024\)\.pdf"/);
  m.editor.editorEl = () => ({});
  const chip = { dataset: { mention: 'Smith (2024).pdf', folder: 'f-1', file: 'sub dir/Smith (2024).pdf' } };
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-mention]' ? chip : null) }, preventDefault() {}, metaKey: false, ctrlKey: false });
  assert.deepEqual(m.opened, [[{ folderId: 'f-1', rel: 'sub dir/Smith (2024).pdf', name: 'Smith (2024).pdf' }, undefined]]);

  m.caretAt(0, 4 + token.length);
  assert.equal(m.key('Backspace').prevented, true, 'Backspace after it takes the whole token');
  assert.equal(m.lines()[0], 'See ');
  m.key('z', { metaKey: true });
  assert.equal(m.lines()[0], `See ${token}`);
});

test('"Mention this folder" mentions the folder as before; a subfolder\'s mentions it by its path', async () => {
  const m = mounted(['@']);
  m.editor.state.mention = { i: 0, start: 0, caret: 1, query: '' };
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'Papers' });
  await settle();
  m.editor.pickMention(m.editor.mentionList().find((r) => r.kind === 'self'));
  assert.equal(m.lines()[0], '@[Papers]');
  assert.deepEqual(m.picked, ['f-1']);

  const sub = mounted(['@']);
  sub.editor.state.mention = { i: 0, start: 0, caret: 1, query: '' };
  sub.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'Papers' });
  await settle();
  sub.editor.pickMention(sub.editor.mentionList().find((r) => r.name === 'sub dir'));
  await settle();
  sub.editor.pickMention(sub.editor.mentionList().find((r) => r.kind === 'self'));
  assert.equal(sub.lines()[0], '@[sub dir](lib:f-1:sub%20dir)');
});

test('without listFolder (a post-it), a folder row is mentioned as before', () => {
  const m = mounted(['@pap']);
  delete m.props.listFolder;
  m.editor.state.mention = { i: 0, start: 0, caret: 4, query: 'pap' };
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'Papers' });
  assert.equal(m.lines()[0], '@[Papers]');
});
