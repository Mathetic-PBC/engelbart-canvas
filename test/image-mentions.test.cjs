'use strict';

// 2026-10-17: a picture in the library (a row of type `image`, a pasted PNG among them) is mentioned with @ like a paper
// or a note. The @ menu offers it with the picture's glyph (before anything is typed, after every other row, so the
// pasted "Attachment n" rows do not fill it), a picked one is written `@[Name](lib:<id>)` and drawn as any library item's
// chip, and a click opens it (Workspace.jsx openItem: the Stage). An agent is given its path under the line, as a pdf's;
// a picture the same text pastes is given where it is pasted, once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { expandMentions, expandDoc } = require('../src/main/context/expand-mentions.cjs');

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-image-mentions-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const { default: DocEditor } = loadEditor();
const model = (file) => import(pathToFileURL(path.join(__dirname, `../src/renderer/model/${file}`)).href);
const load = () => model('rail.js');

const SHOT = { id: 'i1', name: 'Attachment 1', type: 'image', tags: [], path: '/data/p/assets/i1.png' };
const DIAGRAM = { id: 'i2', name: 'Pipeline diagram', type: 'image', tags: [], path: '/data/assets/images/pipeline.png' };
const PAPER = { id: 'p1', name: 'Cocoa paper', type: 'pdf', tags: ['paper'], path: '/x/cocoa.pdf' };
const NOTE = { id: 'n1', name: 'Zebra', type: 'md', tags: ['note'] };
const LIBRARY = [SHOT, DIAGRAM, PAPER, NOTE];

function editorWith(text, props = {}) {
  const p = { docKey: 'k', text, onChange: (next) => { p.text = next; }, mentionable: LIBRARY, ...props };
  const editor = new DocEditor(p);
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.scrollRef = { current: null };
  editor.edRef = { current: {} };
  return { editor, p };
}
async function picked(row) {
  const { editor } = editorWith('x @');
  let text = 'x @';
  editor.writeText = (i, line) => { text = line; };
  editor.state.mention = { i: 0, start: 2, caret: 3, query: '' };
  editor.pickMention(row);
  return text;
}
const chips = (html) => [...html.matchAll(/<span([^>]*data-mention[^>]*)>@(<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/g)].map(([, attrs, icon, shown]) => ({
  attrs, shown, icon: icon || '', lib: (/data-lib="([^"]*)"/.exec(attrs) || [])[1],
}));
const click = (editor, dataset) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-mention]' ? { dataset } : null) }, preventDefault() {} });

test('the @ menu offers pictures: by name when typed, after every other row before anything is typed', async () => {
  const { mentionRows, folderRows } = await load();
  const items = (rows) => rows.filter((r) => r.kind === 'item').map((r) => r.key);
  assert.deepEqual(items(mentionRows({ query: 'pipe', library: LIBRARY, page: null, pageRow: null })), ['i2'], 'found by its name');
  assert.deepEqual(items(mentionRows({ query: 'attachment', library: LIBRARY, page: null, pageRow: null })), ['i1']);
  assert.deepEqual(items(mentionRows({ query: '', library: LIBRARY, page: null, pageRow: null })), ['p1', 'n1', 'i1', 'i2'], 'untyped, pictures last');
  assert.deepEqual(items(mentionRows({ query: '', library: LIBRARY, page: null, pageRow: null, here: new Set(['i1', 'n1']) })), ['n1', 'p1', 'i1', 'i2'], 'last even when this workspace holds one');
  const many = [SHOT, ...Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, name: `Extra ${i}`, type: 'pdf', tags: [] }))];
  assert.equal(items(mentionRows({ query: '', library: many, page: null, pageRow: null })).includes('i1'), false, 'a pasted attachment does not take one of the first ten');
  assert.equal(items(mentionRows({ query: 'att', library: many, page: null, pageRow: null }))[0], 'i1', 'typed, it is there');
  // Its glyph (MentionMenu.jsx KindGlyph by kindKey) is the picture's.
  const { kindKey } = await model('kind.js');
  assert.equal(kindKey(SHOT), 'image');
  // A picture in a library folder is offered there too, with its type for the glyph.
  const folder = { id: 'f1', name: 'figures', type: 'folder', tags: [], folder_path: '/Users/h/figures' };
  const inside = folderRows({ browse: { row: folder, rel: '' }, listing: { entries: [{ name: 'plot.png', rel: 'plot.png', type: 'image' }], total: 1 }, query: 'plot' });
  assert.deepEqual(inside.map((r) => [r.kind, r.name, r.type]), [['entry', 'plot.png', 'image']]);
});

test('a picture picked in the @ menu is written by its id, drawn as the library chip, and a click opens it', async () => {
  const text = await picked({ kind: 'item', key: SHOT.id, row: SHOT, name: SHOT.name });
  assert.equal(text, 'x @[Attachment 1](lib:i1)', 'by id: pasted pictures share names');
  assert.equal(await picked({ kind: 'item', key: PAPER.id, row: PAPER, name: PAPER.name }), 'x @[Cocoa paper]', 'a paper as before');
  const opened = [];
  const { editor } = editorWith(`${text} and @[Pipeline diagram](lib:i2)`, { onOpenItem: (row) => opened.push(row.id) });
  const [shot, diagram] = chips(editor.editorHtml());
  assert.deepEqual([shot.shown, shot.lib, diagram.shown, diagram.lib], ['Attachment 1', 'i1', 'Pipeline diagram', 'i2']);
  assert.match(shot.attrs, /color:#0070f3;font-weight:500;cursor:pointer/, 'the chip every library item has, not grey');
  click(editor, { mention: 'Attachment 1', lib: 'i1' });
  assert.deepEqual(opened, ['i1'], 'Workspace.jsx openItem shows it in the Stage');
});

test('a document that pastes a picture still draws it as before', () => {
  const { editor } = editorWith('![Attachment 1](img:i1)\nsee @[Attachment 1](lib:i1)', { images: { i1: 'blob:x' } });
  const html = editor.editorHtml();
  assert.match(html, /<img[^>]*src="blob:x"/, 'the pasted picture');
  assert.equal(chips(html).length, 1, 'and the mention, a chip');
});

test('expandMentions: a mentioned picture is its path under the line; one the text pastes is given once, where it is pasted', async () => {
  const images = { i1: SHOT.path, i2: DIAGRAM.path };
  const source = { find: (name) => [PAPER, NOTE].find((row) => row.name === name) || null, get: (id) => LIBRARY.find((row) => row.id === id) || null, read: async () => '', image: (id) => images[id] || null };
  const alone = await expandMentions('What is in @[Pipeline diagram](lib:i2)?', source);
  assert.deepEqual(alone.lines, ['What is in @[Pipeline diagram](lib:i2)?', '', `<file name="Pipeline diagram" type="image" path="${DIAGRAM.path}" />`]);
  assert.equal(alone.files, 1);
  for (const text of ['![Attachment 1](img:i1)\nWhat does @[Attachment 1](lib:i1) show?', 'What does @[Attachment 1](lib:i1) show?\n![Attachment 1](img:i1)']) {
    const both = await expandMentions(text, source);
    assert.equal(both.lines.join('\n'), text.replace('img:i1', SHOT.path), 'pasted as before, and no block for the mention');
  }
  const byName = await expandMentions('@[Attachment 1]', source);
  assert.equal(byName.missing, 1, 'a picture is never found by its name alone');
});

/* ------------------------------------------------------------- with the store */

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-image-mentions-'));
const layout = ensureHome(homeDir);
let ctx;
let project;
test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, 'Here');
});
test.after(async () => { await db.closeAll(); });

test('expandDoc: a workspace that mentions a PNG gives its file on disk, which the agent can open', async () => {
  const image = await projects.saveImage(ctx, project.id, { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', name: 'Attachment 1' });
  const row = await ctx.libraryDb.get(image.id);
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Figures' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, `Describe @[Attachment 1](lib:${image.id}).\n`);
  const result = await expandDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id });
  assert.ok(result.text.includes(`Describe @[Attachment 1](lib:${image.id}).\n\n<file name="Attachment 1" type="image" path="${row.path}" />`), result.text);
  assert.ok(fs.existsSync(row.path) && row.path.startsWith(ctx.dataRoot + path.sep), 'under the data root, which every agent is granted');
});
