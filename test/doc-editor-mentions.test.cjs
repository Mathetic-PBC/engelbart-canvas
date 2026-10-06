'use strict';

// MATH-60 (2026-10-06): a mention in a workspace shows what it names, or shows that it is gone. A library mention
// (`@[Name](lib:<id>)`) finds its item by id, under the name it has now; one whose item has left the library is grey, with
// nothing to click and no card, as in a PDF's margin notes. Bart's card is only for `@[bart]`; a chat that is gone is grey
// too, and a note whose name starts with "Bart" is that note. Nothing gets a made-up "unresolved" card any more.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-mentions-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const { default: DocEditor, BART_ITEM, BRAINSTORM_ITEM, DISCOVER_ITEM } = loadEditor();
const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

const FOLLOW_UP = 'Bart Follow-up Sessions and Idle Window';
// The workspace's list, as Workspace.jsx makes it: the agents, then the library.
const LIBRARY = [
  BART_ITEM, BRAINSTORM_ITEM, DISCOVER_ITEM,
  { id: 'p1', name: 'Renamed Paper', title: 'Renamed Paper', type: 'pdf', tags: ['paper'] },
  { id: 'a1', name: 'Twin', title: 'Twin', type: 'md', tags: ['note'], summary: 'the first twin' },
  { id: 'a2', name: 'Twin', title: 'Twin', type: 'md', tags: ['note'], summary: 'the second twin' },
  { id: 'n1', name: FOLLOW_UP, title: FOLLOW_UP, type: 'md', tags: ['note'] },
];

function editorWith(text, props = {}) {
  const editor = new DocEditor({ docKey: 'k', text, onChange() {}, mentionable: LIBRARY, ...props });
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.scrollRef = { current: null };
  return editor;
}
/** Each mention as drawn: { text, lib, mention, grey, title }. */
function mentions(html) {
  return [...html.matchAll(/<span([^>]*)>@([^<]*)<\/span>/g)].map(([, attrs, text]) => ({
    text, attrs,
    lib: (/data-lib="([^"]*)"/.exec(attrs) || [])[1],
    mention: (/data-mention="([^"]*)"/.exec(attrs) || [])[1],
    grey: /color:#8f8f8f/.test(attrs) && !/data-mention=/.test(attrs) && !/cursor:pointer/.test(attrs),
    title: (/title="([^"]*)"/.exec(attrs) || [])[1],
  }));
}
/** What the pointer resting on a drawn mention shows: the card's item, or null when no card opens. */
function hover(editor, dataset) {
  editor.state.pop = null;
  const el = { dataset, getBoundingClientRect: () => ({ left: 0, right: 10, top: 0, bottom: 10 }) };
  editor.editorOver({ target: { closest: (sel) => (sel === '[data-mention]' ? el : null) } });
  return editor.state.pop ? editor.state.pop.res : null;
}

test('a deleted library item\'s mention in a workspace is grey, not clickable, and opens no card', () => {
  const editor = editorWith('See @[Gone Paper](lib:zz) here.');
  const [m] = mentions(editor.editorHtml());
  assert.equal(m.text, 'Gone Paper', 'the name it was mentioned by');
  assert.equal(m.grey, true, m.attrs);
  assert.equal(m.title, 'No longer in the library');
  assert.equal(editor.findRes('Gone Paper', 'zz'), null, 'no card, not even a placeholder');
});

test('a renamed item\'s old mention shows its card under its name now, and a click goes past it to the right place', async () => {
  const editor = editorWith('See @[Old Paper](lib:p1) here.');
  const [m] = mentions(editor.editorHtml());
  assert.equal(m.text, 'Renamed Paper');
  assert.equal(m.lib, 'p1');
  const res = hover(editor, { mention: m.mention, lib: m.lib });
  assert.equal(res.id, 'p1');
  assert.equal(res.title, 'Renamed Paper');
  // " here" after the chip, as drawn: "See @Renamed Paper here." — the "h" is at display offset 19.
  const { rawOffset, parseLine } = await doc();
  const line = 'See @[Old Paper](lib:p1) here.';
  assert.equal(rawOffset(parseLine(line), 19, line, editor.mentionOpts), line.indexOf('here'));
});

test('two items with one name each resolve to their own by id; a deleted one never shows the other', () => {
  const editor = editorWith('@[Twin](lib:a1) and @[Twin](lib:a2) and @[Twin](lib:a3)');
  const drawn = mentions(editor.editorHtml());
  assert.deepEqual(drawn.map((m) => m.lib), ['a1', 'a2', undefined]);
  assert.equal(hover(editor, { mention: 'Twin', lib: 'a1' }).summary, 'the first twin');
  assert.equal(hover(editor, { mention: 'Twin', lib: 'a2' }).summary, 'the second twin');
  assert.equal(drawn[2].grey, true, 'a3 has left the library');
  assert.equal(hover(editor, { mention: 'Twin', lib: 'a3' }), null);
});

test('a note named "Bart Follow-up Sessions…" shows as itself, with its own card, and opens', () => {
  const opened = [];
  const editor = editorWith(`Read @[${FOLLOW_UP}] first.`, { onOpenItem: (row) => opened.push(row.id) });
  const [m] = mentions(editor.editorHtml());
  assert.equal(m.text, FOLLOW_UP, 'not shown as @bart');
  assert.equal(m.grey, false);
  const res = hover(editor, { mention: m.mention });
  assert.equal(res.id, 'n1');
  assert.notEqual(res.type, 'chat');
  const el = { dataset: { mention: m.mention } };
  editor.edRef = { current: {} };
  editor.editorClick({ target: { closest: (sel) => (sel === '[data-mention]' ? el : null) }, preventDefault() {} });
  assert.deepEqual(opened, ['n1']);
});

test('a mention of a chat that is gone is grey with "This chat is gone"; Bart\'s own mention still shows the Bart card', async () => {
  const editor = editorWith('Old: @[bart:4f2a] and @[chat:9] and @[chat]. Now: @[bart].');
  const drawn = mentions(editor.editorHtml());
  assert.deepEqual(drawn.map((m) => m.text), ['bart', 'chat', 'chat', 'bart']);
  for (const m of drawn.slice(0, 3)) { assert.equal(m.grey, true, m.attrs); assert.equal(m.title, 'This chat is gone'); }
  assert.equal(drawn[3].grey, false);
  assert.equal(hover(editor, { mention: drawn[3].mention }).id, 'bart');
  assert.equal(editor.findRes('bart:4f2a'), null);
  const { tokShown } = await doc();
  assert.deepEqual(drawn.map((m) => m.text), ['@[bart:4f2a]', '@[chat:9]', '@[chat]', '@[bart]'].map((tok) => tokShown(tok).shown.slice(1)), 'what is drawn is what a click maps through');
});

test('a mention by name that names nothing is grey with no card; with no library to ask, mentions are drawn as written', () => {
  const editor = editorWith('About @[Nothing by that name].');
  const [m] = mentions(editor.editorHtml());
  assert.equal(m.grey, true);
  assert.equal(m.title, 'Not in the library');
  assert.equal(editor.findRes('Nothing by that name'), null);
  // A post-it's editor has no library: nothing turns grey for want of one.
  const postIt = editorWith('About @[Nothing by that name] and @[Gone](lib:zz).', { mentionable: undefined });
  assert.deepEqual(mentions(postIt.editorHtml()).map((x) => x.grey), [false, false]);
  assert.equal(hover(postIt, { mention: 'Nothing by that name' }), null, 'and no made-up card');
});
