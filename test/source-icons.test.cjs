'use strict';

// "Your sources" draws each row as its type (2026-10-12): a file is KIND's glyph for it (src/renderer/ui/Icons.jsx), not
// the folder every file used to get; a note, a website and a repository keep the sidebar's own icons. And KIND itself:
// docx has a sheet of its own, an html page is a globe, a type nobody listed is a plain sheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

function load(entry) {
  const filename = path.join(__dirname, `__${path.basename(entry)}.cjs`);
  const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', entry)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const previous = global.window;
  global.window = { engelbartAPI: {} };
  try { compiled._compile(built.outputFiles[0].text, filename); } finally { if (previous === undefined) delete global.window; else global.window = previous; }
  return compiled.exports;
}
const Rail = load('workspace/Rail.jsx');
const Icons = load('ui/Icons.jsx');
const Sidebar = load('ui/SidebarIcons.jsx');

const svg = (node) => renderToStaticMarkup(node).match(/<svg[^]*?<\/svg>/)[0];
const paths = (markup) => [...markup.matchAll(/<(path|rect|circle)[^>]*>/g)].map((m) => m[0].replace(/ (width|height)="[^"]*"/g, '')).join('');
const shape = (node) => paths(svg(node)); // what is drawn, whatever size it is drawn at
const glyph = (Component) => shape(React.createElement(Component));

const row = (id, type, tags = [], more = {}) => ({ id, name: id, type, tags, ...more });
const ROWS = [
  [row('plain.md', 'md', [], { path: '/x/plain.md' }), glyph(Icons.FILE)],
  [row('note', 'md', ['note']), glyph(Sidebar.NoteIcon)],
  [row('paper.pdf', 'pdf', ['paper']), glyph(Icons.PDF)],
  [row('draft.docx', 'docx'), glyph(Icons.DOC)],
  [row('apple', 'html', [], { path: '/u/.engelbart/assets/pages/1/index.html', url: 'https://www.apple.com/' }), glyph(Icons.GLOBE)],
  ...['csv', 'tsv', 'json', 'jsonl', 'parquet', 'xlsx'].map((type) => [row(`data.${type}`, type), glyph(Icons.LAYERS)]),
  [row('figure.png', 'image'), glyph(Icons.IMAGE)],
  [row('Papers', 'folder', [], { folder_path: '/Desktop/Papers' }), glyph(Icons.FOLDER)],
  [row('pond', 'website', [], { url: 'https://pond.li/' }), glyph(Sidebar.LinkIcon)],
  [row('clone', 'folder', ['git'], { folder_path: '/repos/rope' }), glyph(Sidebar.CodeIcon)],
  [row('address', 'website', ['git'], { url: 'https://github.com/mqo00/rope' }), glyph(Sidebar.CodeIcon)],
  [row('notes.txt', 'txt'), glyph(Icons.FILE)],
];

test('each type of source gets its own icon: the glyph KIND has for it, a note, a link and code their sidebar icons', () => {
  for (const [source, expected] of ROWS) assert.equal(shape(Rail.sourceIcon(source, false)), expected, `${source.id} (${source.type})`);
});

test('the pairs that must not look alike: a note and a plain md, docx and a note, an html page and a repository; no file is a folder', () => {
  const icon = (id) => shape(Rail.sourceIcon(ROWS.find(([source]) => source.id === id)[0], false));
  assert.notEqual(icon('note'), icon('plain.md'));
  assert.notEqual(icon('draft.docx'), icon('note'));
  assert.notEqual(icon('draft.docx'), glyph(Icons.NOTE), 'not KIND\'s note either');
  assert.notEqual(icon('apple'), icon('clone'));
  assert.notEqual(icon('apple'), glyph(Icons.CODE), 'not the code brackets it had');
  assert.notEqual(icon('notes.txt'), glyph(Sidebar.FolderIcon), 'an unknown type is a sheet, not a folder');
  for (const [source] of ROWS) if (source.type !== 'folder') assert.notEqual(icon(source.id), glyph(Sidebar.FolderIcon), source.id);
});

test('a file\'s glyph is in the row\'s colour: #171717 when it is open in front, #5c5c5c otherwise, in the row\'s 18px box', () => {
  const pdf = row('paper.pdf', 'pdf');
  assert.match(renderToStaticMarkup(Rail.sourceIcon(pdf, true)), /^<span style="[^"]*width:18px;height:18px;[^"]*color:#171717/);
  assert.match(renderToStaticMarkup(Rail.sourceIcon(pdf, false)), /^<span style="[^"]*color:#5c5c5c/);
});

test('drawn in the sidebar: the mixed rows of Your sources start with their own type\'s glyph', () => {
  const drawn = ROWS.filter(([source]) => !source.tags.includes('note'));
  for (let at = 0; at < drawn.length; at += 3) { // a few at a time: the list shows its first few, then More
    const batch = drawn.slice(at, at + 3);
    const sources = batch.map(([source]) => source);
    const html = renderToStaticMarkup(React.createElement(Rail.default, {
      width: 300, project: { id: 'p', name: 'Engelbart' }, roots: [], hereId: null, recent: [], agents: [], builds: [],
      rows: sources, starred: [], library: sources, inRail: () => true, trashRef: () => {},
    }));
    for (const [source, expected] of batch) {
      const from = html.indexOf(`data-sb-source="${source.id}"`);
      assert.ok(from > 0, `${source.id} is listed`);
      assert.equal(paths(html.slice(from).match(/<svg[^]*?<\/svg>/)[0]), expected, source.id);
    }
  }
});

test('KIND: docx its own sheet, html a globe, an unknown type a plain sheet labelled by its type', () => {
  const kindShape = (item) => shape(React.createElement(Icons.KindGlyph, { item }));
  assert.equal(kindShape({ type: 'docx', tags: [] }), glyph(Icons.DOC));
  assert.equal(kindShape({ type: 'html', tags: [] }), glyph(Icons.GLOBE));
  assert.equal(kindShape({ type: 'txt', tags: [] }), glyph(Icons.FILE));
  assert.equal(kindShape({ type: 'md', tags: ['note'] }), glyph(Icons.NOTE), 'a note keeps its lines');
  assert.equal(Icons.kindOf({ type: 'txt', tags: [] }).label, 'txt');
  // a sheet is drawn at the note's size, a page on disk at the globe's
  const box = (item) => renderToStaticMarkup(React.createElement(Icons.KindGlyph, { item })).match(/class="glyph-fit" style="[^"]*width:(\d+)px/)[1];
  assert.deepEqual(['docx', 'txt', 'html', 'website', 'pdf'].map((type) => box({ type, tags: [] })), ['15', '15', '14', '14', '12']);
});
