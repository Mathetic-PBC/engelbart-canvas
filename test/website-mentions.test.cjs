'use strict';

// 2026-10-17: a web page mentioned with @ is written `@[Title](lib:<id>)` and drawn as any library item's chip, with the
// globe after the @, never as its address. The open page the library does not hold yet, whose title can be its address
// (Electron's title of a page with none, and the Stage's fallback), is mentioned by its host and path. A mention written
// with an address before (`@[https://…]`) shows the same way and still opens the page; an address typed as such stays a
// link. Bart gets the page's address with its mention.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { expandMentions } = require('../src/main/context/expand-mentions.cjs');

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-website-mentions-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const { default: DocEditor } = loadEditor();
const model = (file) => import(pathToFileURL(path.join(__dirname, `../src/renderer/model/${file}`)).href);

const GARDEN = { id: 'w1', name: "Ben Cuan's digital garden", type: 'website', tags: [], url: 'https://garden.bencuan.me/' };
const REPO = { id: 'w2', name: 'kjfeng/cocoa-canvas', type: 'website', tags: ['git'], url: 'https://github.com/kjfeng/cocoa-canvas' };
const UNTITLED = { id: 'w3', name: 'https://notes.example.org/a/b?x=1', type: 'website', tags: [], url: 'https://notes.example.org/a/b?x=1' };
const PAPER = { id: 'p1', name: 'Cocoa paper', type: 'pdf', tags: ['paper'], path: '/x/cocoa.pdf' };
const NOTE = { id: 'n1', name: 'Zebra', type: 'md', tags: ['note'] };
const LIBRARY = [GARDEN, REPO, UNTITLED, PAPER, NOTE];

function editorWith(text, props = {}) {
  const p = { docKey: 'k', text, onChange: (next) => { p.text = next; }, mentionable: LIBRARY, ...props };
  const editor = new DocEditor(p);
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.scrollRef = { current: null };
  editor.edRef = { current: {} };
  return { editor, p };
}
/** What picking `row` in the @ menu after `x @` writes. */
async function picked(row, extra = {}) {
  const { editor, p } = editorWith('x @', extra);
  let text = 'x @';
  editor.writeText = (i, line) => { text = line; };
  editor.state.mention = { i: 0, start: 2, caret: 3, query: '' };
  editor.pickMention(row);
  return { text, editor, p };
}
/** Each mention as drawn: its attributes, the text it shows and whether a glyph comes after its @. */
const chips = (html) => [...html.matchAll(/<span([^>]*data-mention[^>]*)>@(<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/g)].map(([, attrs, icon, shown]) => ({
  attrs, shown, icon: icon || '',
  lib: (/data-lib="([^"]*)"/.exec(attrs) || [])[1], url: (/data-url="([^"]*)"/.exec(attrs) || [])[1],
}));
const GLOBE_MARK = 'M1.75 8h12.5';
const click = (editor, dataset) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-mention]' ? { dataset } : null) }, preventDefault() {} });

test('a web page picked in the @ menu is written by its id under its title, and drawn with the globe, not its address', async () => {
  const { text } = await picked({ kind: 'item', key: GARDEN.id, row: GARDEN, name: GARDEN.name });
  assert.equal(text, "x @[Ben Cuan's digital garden](lib:w1)");
  const opened = [];
  const { editor } = editorWith(text, { onOpenItem: (row) => opened.push(row.id) });
  const [chip] = chips(editor.editorHtml());
  assert.equal(chip.shown, "Ben Cuan's digital garden");
  assert.equal(chip.lib, 'w1');
  assert.ok(chip.icon.includes(GLOBE_MARK), 'the globe after the @');
  assert.match(chip.attrs, /color:#0070f3;font-weight:500;cursor:pointer/, 'the chip every library item has');
  assert.doesNotMatch(editor.editorHtml(), /garden\.bencuan\.me/, 'its address is nowhere on the line');
  click(editor, { mention: chip.attrs.match(/data-mention="([^"]*)"/)[1].replace(/&#39;/g, "'"), lib: 'w1' });
  assert.deepEqual(opened, ['w1'], 'a click opens the page (Workspace.jsx openItem puts it in the Stage)');
});

test('a page in the library under its address is mentioned by its host and path; a repository known by its address shows GitHub\'s mark', async () => {
  const untitled = await picked({ kind: 'item', key: UNTITLED.id, row: UNTITLED, name: UNTITLED.name });
  assert.equal(untitled.text, 'x @[notes.example.org/a/b](lib:w3)');
  const { editor } = editorWith(`${untitled.text} and @[${REPO.name}](lib:w2)`);
  const [page, repo] = chips(editor.editorHtml());
  assert.equal(page.shown, 'notes.example.org/a/b', 'the row\'s name now, still an address, shown as its host and path');
  assert.equal(repo.shown, 'kjfeng/cocoa-canvas');
  assert.ok(repo.icon && !repo.icon.includes(GLOBE_MARK), 'GitHub\'s mark');
});

test('the open page with no title of its own is offered and written under its host and path', async () => {
  const { mentionRows } = await model('rail.js');
  for (const title of ['https://garden.bencuan.me/notes/rope/', 'garden.bencuan.me/notes/rope/', '']) {
    const rows = mentionRows({ query: '', library: [], page: { input: 'https://garden.bencuan.me/notes/rope/', title }, pageRow: null });
    const fresh = rows.find((row) => row.kind === 'fresh');
    if (!title) { assert.equal(fresh, undefined, 'a page with no title at all is not offered, as before'); continue; }
    assert.equal(fresh.name, 'garden.bencuan.me/notes/rope', title);
    const { text } = await picked(fresh);
    assert.equal(text, 'x @[garden.bencuan.me/notes/rope]');
  }
  const titled = mentionRows({ query: '', library: [], page: { input: 'https://garden.bencuan.me/', title: "Ben Cuan's digital garden" }, pageRow: null }).find((row) => row.kind === 'fresh');
  assert.equal(titled.name, "Ben Cuan's digital garden", 'a real title is kept');
  // The library already holds the open page: its row, mentioned by id.
  const held = mentionRows({ query: '', library: [GARDEN], page: { input: GARDEN.url, title: 'garden.bencuan.me' }, pageRow: GARDEN }).find((row) => row.open);
  assert.equal((await picked(held)).text, "x @[Ben Cuan's digital garden](lib:w1)");
});

test('an older mention written with an address shows its host and path, finds the library\'s page there, and still opens', async () => {
  const opened = [], links = [];
  const { editor } = editorWith('See @[https://garden.bencuan.me/] and @[https://elsewhere.org/x/y?z=1].', { onOpenItem: (row) => opened.push(row.id), onOpenLink: (href) => links.push(href) });
  const [held, loose] = chips(editor.editorHtml());
  assert.equal(held.shown, 'garden.bencuan.me');
  assert.ok(held.icon.includes(GLOBE_MARK));
  assert.equal(editor.findRes('https://garden.bencuan.me/').id, 'w1', 'its card and click are the page\'s');
  click(editor, { mention: 'https://garden.bencuan.me/' });
  assert.deepEqual(opened, ['w1']);
  assert.equal(loose.shown, 'elsewhere.org/x/y', 'one the library holds no page for is not grey');
  assert.equal(loose.url, 'https://elsewhere.org/x/y?z=1');
  assert.ok(loose.icon.includes(GLOBE_MARK));
  click(editor, { mention: 'https://elsewhere.org/x/y?z=1', url: 'https://elsewhere.org/x/y?z=1' });
  assert.deepEqual(links, ['https://elsewhere.org/x/y?z=1'], 'it opens as a link does');
  // The caret maps through what is drawn: "See @garden.bencuan.me and …", the "a" of "and" at display offset 23.
  const { rawOffset, parseLine, tokShown } = await model('doc.js');
  const line = 'See @[https://garden.bencuan.me/] and @[https://elsewhere.org/x/y?z=1].';
  assert.equal(tokShown('@[https://garden.bencuan.me/]').shown, '@garden.bencuan.me');
  assert.equal(rawOffset(parseLine(line), 23, line, editor.mentionOpts), line.indexOf('and'));
});

test('an address typed as it is stays a link; papers and notes are mentioned as before, with no glyph', async () => {
  const paper = await picked({ kind: 'item', key: PAPER.id, row: PAPER, name: PAPER.name });
  const note = await picked({ kind: 'item', key: NOTE.id, row: NOTE, name: NOTE.name });
  assert.equal(paper.text, 'x @[Cocoa paper]');
  assert.equal(note.text, 'x @[Zebra]');
  const { editor } = editorWith('Read https://garden.bencuan.me/x and [the garden](https://garden.bencuan.me/) with @[Cocoa paper] and @[Zebra](lib:n1).');
  const html = editor.editorHtml();
  assert.match(html, /<a href="https:\/\/garden\.bencuan\.me\/x" data-link="1"[^>]*>https:\/\/garden\.bencuan\.me\/x<\/a>/);
  assert.match(html, /<a href="https:\/\/garden\.bencuan\.me\/" data-link="1"[^>]*>the garden<\/a>/);
  assert.deepEqual(chips(html).map((c) => [c.shown, c.icon]), [['Cocoa paper', ''], ['Zebra', '']]);
});

test('Bart is given a mentioned page with its address', async () => {
  const source = { find: () => null, get: (id) => LIBRARY.find((row) => row.id === id) || null, read: async () => '', image: () => null };
  const { lines } = await expandMentions("Look at @[Ben Cuan's digital garden](lib:w1).", source);
  assert.deepEqual(lines, ["Look at @[Ben Cuan's digital garden](lib:w1).", '', `<file name="Ben Cuan's digital garden" type="website" url="https://garden.bencuan.me/" />`]);
});
