'use strict';

// MATH-22 (2026-10-06): in a document's @ menu a library folder opens in place (listFolder, live), a subfolder a level
// deeper; the back row or Backspace with nothing typed goes up; a file picked is written `@[Name](lib:<folderId>:<path>)`
// and links its folder (onMentionPicked with the folder's row). Its chip opens the file (onOpenFile). Follow-up
// (2026-10-06): the line keeps the path, `@My Papers/sub dir/`, and what is typed after its last `/` narrows the level;
// Backspace right after a `/` takes the last name off, and at the top puts back what was typed. The same in a follow-up
// field. There is no document here: the editor and its elements are stand-ins, as in doc-editor-mention-keys.

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

const FOLDER = { id: 'f-1', name: 'My Papers', type: 'folder', tags: [], folder_path: '/home/papers' };
const LEVELS = {
  '': { entries: [{ name: 'sub dir', rel: 'sub dir', dir: true, type: 'folder' }, { name: 'top.md', rel: 'top.md', dir: false, type: 'md' }, { name: 'Smith notes.md', rel: 'Smith notes.md', dir: false, type: 'md' }], total: 3 },
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
  editor.caretRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  const caretAt = (line, offset) => { editor.caretInfo = () => ({ anchor: { line, offset }, focus: { line, offset } }); };
  const key = (k, extra = {}) => {
    const e = { key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    editor.editorKey(e);
    return e;
  };
  // Typing on line 0: the text becomes `text`, the caret at its end, and the @ menu reads it as editorInput does.
  const type = (text) => { props.text = text; editor.lineMention(0, text, text.length); caretAt(0, text.length); };
  return { editor, props, picked, asked, opened, caretAt, key, type, lines: () => editor.lines() };
}
const names = (rows) => rows.map((m) => `${m.kind}:${m.name}`);

test('a folder picked writes its path into the line; a subfolder deeper; Backspace after a / goes up a name; at the top, what was typed comes back', async () => {
  const m = mounted(['See @pap']);
  m.editor.state.mention = { i: 0, start: 4, caret: 8, query: 'pap' };
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  assert.equal(m.lines()[0], 'See @My Papers/', 'what found the folder goes; its path stays, spaces and all');
  assert.deepEqual(m.editor.caret, { line: 0, offset: 15 }, 'the caret after the /');
  assert.deepEqual(m.picked, [], 'nothing mentioned, nothing linked yet');
  assert.deepEqual(names(m.editor.mentionList()), ['back:All', 'note:Opening…']);
  await settle();
  assert.deepEqual(m.asked, [['f-1', '']]);
  assert.deepEqual(names(m.editor.mentionList()), ['back:All', 'self:Mention this folder', 'entry:sub dir', 'entry:top.md', 'entry:Smith notes.md']);
  assert.equal(m.editor.state.mentionIdx, 2, 'the keyboard on the first entry');

  m.caretAt(0, 15);
  m.key('Enter'); // the subfolder
  assert.equal(m.lines()[0], 'See @My Papers/sub dir/');
  assert.deepEqual(m.editor.caret, { line: 0, offset: 23 });
  await settle();
  assert.deepEqual(m.asked[1], ['f-1', 'sub dir'], 'listed live, each time');
  assert.deepEqual(names(m.editor.mentionList()), ['back:My Papers', 'self:Mention this folder', 'entry:Smith (2024).pdf']);

  m.caretAt(0, 23);
  assert.equal(m.key('Backspace').prevented, true, 'Backspace right after the /: up');
  assert.equal(m.lines()[0], 'See @My Papers/', 'the subfolder\'s name taken off');
  await settle();
  assert.equal(m.editor.state.browse.rel, '');
  assert.equal(m.editor.state.mention.caret, 15);

  m.caretAt(0, 15);
  assert.equal(m.key('Backspace').prevented, true, 'at the folder\'s top: out of it');
  assert.equal(m.lines()[0], 'See @pap', 'what was typed to find it comes back');
  assert.deepEqual(m.editor.caret, { line: 0, offset: 8 });
  assert.equal(m.editor.browsing(), null);
  assert.deepEqual([m.editor.state.mention.query, m.editor.state.mention.start, m.editor.state.mention.caret], ['pap', 4, 8], 'the whole menu, narrowed as before');

  m.caretAt(0, 8);
  assert.equal(m.key('Backspace').prevented, false, 'out of the folder, Backspace is Backspace');
});

test('what is typed after the last / narrows that level, spaces and all; the path stays one open mention', async () => {
  const m = mounted(['See @']);
  m.editor.state.mention = { i: 0, start: 4, caret: 5, query: '' };
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  await settle();
  m.type('See @My Papers/smi');
  assert.deepEqual([m.editor.state.mention.query, m.editor.state.mention.start], ['smi', 4], 'one mention from the @, the space in the folder\'s name kept');
  assert.ok(m.editor.browsing(), 'still in the folder');
  assert.deepEqual(names(m.editor.mentionList()), ['entry:Smith notes.md']);
  assert.equal(m.editor.state.mentionIdx, 0);
  m.type('See @My Papers/smith no');
  assert.deepEqual(names(m.editor.mentionList()), ['entry:Smith notes.md'], 'a file name holds spaces: so may what narrows it');
  assert.equal(m.key('Backspace').prevented, false, 'something typed after the /: Backspace takes a letter');

  m.type('See @My Papers/');
  assert.equal(m.editor.state.mentionIdx, 2, 'nothing typed: the level again, the keyboard on its first entry');
  m.type('See @My Papers/sub dir/');
  assert.equal(m.editor.state.browse.rel, 'sub dir', 'a subfolder\'s name and a / typed: in it');
  await settle();
  assert.deepEqual(names(m.editor.mentionList()), ['back:My Papers', 'self:Mention this folder', 'entry:Smith (2024).pdf']);

  m.type('See @My Papers/sub dir/ and then I wrote on');
  assert.equal(m.editor.state.mention, null, 'words that no name holds are writing: the menu closes');

  const edited = mounted(['See @']);
  edited.editor.state.mention = { i: 0, start: 4, caret: 5, query: '' };
  edited.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  await settle();
  edited.type('See @My Pap');
  assert.equal(edited.editor.state.mention, null, 'the path broken: no folder, and "@My Pap" is no mention');
  assert.equal(edited.editor.state.browse, null);
  edited.type('See @My');
  assert.deepEqual([edited.editor.state.mention.query, edited.editor.browsing()], ['My', null], 'the whole menu again');
});

test('a file picked is written with its folder\'s id and its encoded path, links the folder, and opens from its chip', async () => {
  const m = mounted(['See @']);
  m.editor.state.mention = { i: 0, start: 4, caret: 5, query: '' };
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  await settle();
  m.editor.pickMention(m.editor.mentionList().find((r) => r.name === 'sub dir'));
  await settle();
  m.type('See @My Papers/sub dir/smi');
  assert.deepEqual(names(m.editor.mentionList()), ['entry:Smith (2024).pdf'], 'typed: narrowed, the match first');
  m.editor.pickMention(m.editor.mentionList()[0]);
  const token = '@[Smith (2024).pdf](lib:f-1:sub%20dir/Smith%20%282024%29.pdf)';
  assert.equal(m.lines()[0], `See ${token}`, 'the whole "@My Papers/sub dir/smi" gives way to the chip');
  assert.deepEqual(m.picked, ['f-1'], 'its folder comes into the workspace');
  assert.deepEqual(m.editor.caret, { line: 0, offset: 4 + token.length });

  const html = m.editor.editorHtml();
  assert.match(html, /data-folder="f-1" data-file="sub dir\/Smith \(2024\)\.pdf"/);
  assert.match(html, /title="My Papers \/ sub dir\/Smith \(2024\)\.pdf"/);
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
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  await settle();
  m.editor.pickMention(m.editor.mentionList().find((r) => r.kind === 'self'));
  assert.equal(m.lines()[0], '@[My Papers]');
  assert.deepEqual(m.picked, ['f-1']);

  const sub = mounted(['@']);
  sub.editor.state.mention = { i: 0, start: 0, caret: 1, query: '' };
  sub.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
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
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  assert.equal(m.lines()[0], '@[My Papers]');
});

test('in a follow-up field the same: the path written in, narrowed after its last /, Backspace up a name, a file picked takes its place', async () => {
  const m = mounted(['@bart hi']);
  global.document = global.document || { activeElement: null };
  const input = {
    value: 'and @pa', selectionStart: 7, selectionEnd: 7, dataset: { followInput: '0' }, style: {}, scrollHeight: 24, parentElement: null,
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 20 }),
    setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; },
    focus() {},
  };
  m.editor.followField = () => input;
  const type = (text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; m.editor.followInput(input); };
  const key = (k) => { const e = { key: k, target: input, metaKey: false, ctrlKey: false, shiftKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; } }; m.editor.followKey(e); return e; };

  type('and @pa');
  assert.deepEqual([m.editor.state.mention.field, m.editor.state.mention.query], [0, 'pa']);
  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  assert.equal(input.value, 'and @My Papers/');
  assert.equal(input.selectionStart, 15);
  await settle();
  m.editor.pickMention(m.editor.mentionList().find((r) => r.name === 'sub dir'));
  assert.equal(input.value, 'and @My Papers/sub dir/');
  await settle();
  assert.equal(key('Backspace').prevented, true);
  assert.equal(input.value, 'and @My Papers/', 'up a name');
  await settle();
  type('and @My Papers/smith n');
  assert.deepEqual(names(m.editor.mentionList()), ['entry:Smith notes.md'], 'one open mention from the @');
  type('and @My Papers/');
  assert.equal(key('Backspace').prevented, true);
  assert.equal(input.value, 'and @pa', 'out of the folder: what was typed comes back');
  assert.deepEqual([m.editor.state.mention.query, m.editor.browsing()], ['pa', null]);

  m.editor.pickMention({ kind: 'item', key: 'f-1', row: FOLDER, name: 'My Papers' });
  await settle();
  type('and @My Papers/top');
  m.editor.pickMention(m.editor.mentionList()[0]);
  assert.equal(input.value, 'and @[top.md](lib:f-1:top.md)', 'the whole "@My Papers/top" gives way to the file\'s token');
  assert.equal(m.editor.state.mention, null);
  assert.deepEqual(m.picked, ['f-1']);
});

test('the menu cuts a long name in the middle, so names that start the same still differ, and shows the whole in the row\'s title', () => {
  const MentionMenu = load('MentionMenu.jsx').default;
  const { renderToStaticMarkup } = require('react-dom/server');
  const React = require('react');
  const long = '_FutureHCI_26__The_Illusion_of_Learning__Toward_Growth_Centered_AI';
  const items = [
    { kind: 'entry', key: 'entry:a', name: `${long}.pdf`, row: FOLDER, rel: `${long}.pdf`, dir: false, type: 'pdf' },
    { kind: 'entry', key: 'entry:b', name: `${long}-2.pdf`, row: FOLDER, rel: `${long}-2.pdf`, dir: false, type: 'pdf' },
    { kind: 'entry', key: 'entry:c', name: 'top.md', row: FOLDER, rel: 'top.md', dir: false, type: 'md' },
    { kind: 'note', key: 'note:more', name: '3 more: type to narrow' },
  ];
  const html = renderToStaticMarkup(React.createElement(MentionMenu, { items, index: 0, anchor: { left: 0, right: 0, top: 0, bottom: 0 }, onPick() {} }));
  assert.match(html, new RegExp(`title="${long}\\.pdf"`));
  assert.match(html, new RegExp(`title="${long}-2\\.pdf"`));
  assert.match(html, /text-overflow:ellipsis[^>]*>_FutureHCI_26__The_Illusion_of_Learning__Toward_Growth_C<\/span><span style="flex:none;white-space:pre">entered_AI\.pdf<\/span>/, 'the end and extension kept whole');
  assert.match(html, /white-space:pre">tered_AI-2\.pdf<\/span>/);
  assert.match(html, />top\.md<\/span><\/span>/, 'a short name is not split');
  assert.doesNotMatch(html, /title="3 more/, 'a row that only says something has no title');
});
