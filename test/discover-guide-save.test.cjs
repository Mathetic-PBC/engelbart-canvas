'use strict';

// An @discover guide's papers kept from the guide (2026-10-02): each title line of a guide ends in + Save, + Workspace or
// ✓ (src/renderer/model/guide.js, DocEditor.jsx paperSaveHtml); a click adds the paper to the library and this workspace
// as the Stage's Save does, and never touches workspace.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const projects = require('../src/main/store/projects.cjs');

const model = (name) => import(pathToFileURL(path.join(__dirname, `../src/renderer/model/${name}.js`)).href);

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-guide-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports.default;
}
const DocEditor = loadEditor();

const SCIM = 'https://arxiv.org/pdf/2205.04561';
const CITESEE = 'https://dl.acm.org/doi/pdf/10.1145/3544548.3580847';
const ABSTRACT = 'https://doi.org/10.1145/3290605.3300234';
// A guide as @discover writes it, under a @bart answer and an @brainstorm recap that hold lines of the same shape.
const GUIDE = [
  '# Reading',
  '',
  '@discover tools that help people read papers',
  'bart> ## Start here',
  `bart> **[Scim: Intelligent Skimming Support for Scientific Papers](${SCIM})** · Fok et al. · 2022`,
  `bart> **Read:** [3.2 Design Goals](${SCIM}#find=We%20introduce%20seven%20design%20goals&to=a%20tool%20that%20supports) and [8.4 Limitations](${SCIM}#find=highlights%20only%20present)`,
  'bart> **Why:** seven design goals to compare the reader against.',
  'bart> ',
  `bart> **[CiteSee: Augmenting Citations in Scientific Papers](${CITESEE}#page=2)** · Chang et al. · 2023`,
  `bart> **Read:** [4.5 Paper Cards](${CITESEE}#find=Making%20sense%20of%20inline%20citations)`,
  'bart> **Why:** how a citation card carries context.',
  'bart> ',
  'bart> ## Classics',
  `bart> **[Reading in the age of search](${ABSTRACT})** · Doe et al. · 2019`,
  'bart> **Read:** abstract only',
  'bart> **Why:** what the abstract says it measures.',
  'bart> *Opus high · 2m 10s*',
  '',
  '@bart what should I read first?',
  `bart> **[Scim: Intelligent Skimming Support for Scientific Papers](${SCIM})** · Fok et al. · 2022`,
  'bart> **Read:** [Design Goals](https://arxiv.org/pdf/2205.04561#find=We%20introduce)',
  'bart> *Sonnet high · 12s*',
  '',
  '@brainstorm',
  `bart> **[Scim: Intelligent Skimming Support for Scientific Papers](${SCIM})** · Fok et al. · 2022`,
  'bart> *brainstorm · 8s*',
  '',
].join('\n');
const TITLE_ROWS = [4, 8]; // the two @discover titles with a Read link

/** The editor's drawing of a document: each save button as { row, save, label, disabled }. */
function draw(props) {
  const editor = new DocEditor({ text: GUIDE, onAsk() {}, onChange() { throw new Error('the document changed'); }, ...props });
  const html = editor.editorHtml();
  const buttons = [...html.matchAll(/<button[^>]*data-act="papersave"[^>]*>([^<]*)<\/button>/g)].map(([tag, label]) => ({
    row: Number(/data-row="(\d+)"/.exec(tag)[1]), save: /data-save="(\w+)"/.exec(tag)[1], label, disabled: / disabled\b/.test(tag),
  }));
  return { editor, html, buttons };
}

test('guideTitle: a bold link at the start of a line is a paper, without its #fragment; abstract-only entries and other lines are not', async () => {
  const { guideTitle } = await model('guide');
  assert.deepEqual(guideTitle(`**[Scim: Skimming](${SCIM}#find=x)** · Fok et al. · 2022`, '**Read:** [s](x)'), { title: 'Scim: Skimming', address: SCIM });
  assert.deepEqual(guideTitle(`**[A  title\twith space](${CITESEE})**`), { title: 'A title with space', address: CITESEE });
  assert.equal(guideTitle(`**[Abstract](${ABSTRACT})** · A · 2019`, '**Read:** abstract only'), null);
  assert.equal(guideTitle(`**[Abstract](${ABSTRACT})** · A · 2019`, '**Read:** "Abstract only"'), null);
  assert.equal(guideTitle(`**Read:** [3.2 Design Goals](${SCIM}#find=We)`), null, 'a Read line');
  assert.equal(guideTitle(`See [Scim](${SCIM})`), null, 'a link inside a line');
  assert.equal(guideTitle('## Start here'), null, 'a heading');
  assert.equal(guideTitle('**[Elsewhere](ws:abc)**'), null, 'not a place a paper can be');
  assert.deepEqual(guideTitle('**[Mine](/Users/h/My%20Paper.pdf)** · Me · 2024'), { title: 'Mine', address: '/Users/h/My Paper.pdf' }, 'a library path as the library spells it');
  assert.equal(guideTitle(`**[${'x'.repeat(300)}](${SCIM})**`).title.length, 200, 'no longer than the library takes a name');
});

test('paperState: none, lib, here; an arXiv pdf is the row the library made for its abstract page', async () => {
  const { paperState } = await model('guide');
  const { linkPlan } = await model('stage');
  const library = [
    { id: 'a', name: 'Scim', type: 'website', tags: ['paper'], url: 'https://arxiv.org/abs/2205.04561' },
    { id: 'c', name: 'CiteSee', type: 'website', tags: [], url: CITESEE },
  ];
  const here = new Set(['c']);
  const inRail = (id) => here.has(id);
  assert.deepEqual(paperState(library, SCIM, inRail), { state: 'lib', row: library[0] });
  assert.equal(paperState(library, 'https://arxiv.org/pdf/2205.04561v2', inRail).state, 'lib', 'a version is the same paper');
  assert.equal(paperState(library, CITESEE, inRail).state, 'here');
  assert.equal(paperState(library, 'https://arxiv.org/pdf/9999.00001', inRail).state, 'none');
  // A passage opens the saved copy once the library keeps it; while the row is still the abstract page, the pdf's address.
  assert.equal(linkPlan(`${SCIM}#find=We%20introduce`, library).row, null);
  const kept = [{ ...library[0], type: 'pdf', path: '/Users/h/.engelbart/assets/pdfs/a.pdf' }];
  const plan = linkPlan(`${SCIM}#find=We%20introduce&to=a%20tool`, kept);
  assert.deepEqual([plan.row && plan.row.id, plan.find, plan.to, plan.key], ['a', 'We introduce', 'a tool', 'i:a']);
  assert.equal(linkPlan(SCIM, kept).row, null, 'without a passage a link opens its address, as before');
});

test('the editor draws a button on each @discover title with a Read link; none on Read lines, abstract-only entries, @bart or @brainstorm', () => {
  const { buttons, html } = draw({ paperState: () => 'none', onSavePaper: async () => {} });
  assert.deepEqual(buttons.map((b) => b.row), TITLE_ROWS);
  assert.ok(buttons.every((b) => b.label === '+ Save' && !b.disabled));
  assert.match(html, /data-act="papersave"[^>]*contenteditable="false"|contenteditable="false"[^>]*data-act="papersave"/, 'the caret never goes into it');
  // The title is still a link to the paper, the button after it.
  assert.match(html, /Scim: Intelligent Skimming Support for Scientific Papers<\/a><\/strong> · Fok et al\. · 2022<button/);
  assert.equal(draw({}).buttons.length, 0, 'no button where the editor is not told where papers are (a post-it)');
});

test('the three states: + Save, + Workspace, ✓ (disabled); the state follows paperState, read on every drawing', () => {
  const states = { [SCIM]: 'lib', [CITESEE]: 'here' };
  const { buttons } = draw({ paperState: (address) => states[address] || 'none', onSavePaper: async () => {} });
  assert.deepEqual(buttons.map(({ save, label, disabled }) => [save, label, disabled]), [['lib', '+ Workspace', false], ['here', '✓', true]]);
  // A paper saved from the Stage: the workspace changes, the next drawing reads ✓.
  states[SCIM] = 'here';
  assert.deepEqual(draw({ paperState: (address) => states[address] || 'none', onSavePaper: async () => {} }).buttons.map((b) => b.label), ['✓', '✓']);
});

test('a click hands the paper (title, address without its fragment) to onSavePaper and never changes the document; while it works the button is disabled', async () => {
  const saved = [];
  let finish;
  const { editor } = draw({ paperState: () => 'none', onSavePaper: (paper) => { saved.push(paper); return new Promise((resolve) => { finish = resolve; }); } });
  const press = (row) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'papersave', row: String(row) }, disabled: false } : null) }, preventDefault() {} });
  press(8);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, [{ title: 'CiteSee: Augmenting Citations in Scientific Papers', address: CITESEE }]);
  const busy = editor.editorHtml().match(/<button[^>]*data-row="8"[^>]*>[^<]*<\/button>/)[0];
  assert.match(busy, /disabled/);
  assert.match(busy, />\+ Save</);
  press(8);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1, 'a second click while the first works does nothing');
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(editor.editorHtml().match(/<button[^>]*data-row="8"[^>]*>/)[0], /disabled/);
  // ✓ does nothing, and neither does a line that is not a title.
  const done = draw({ paperState: () => 'here', onSavePaper: (paper) => { saved.push(paper); } });
  done.editor.savePaper(4); done.editor.savePaper(5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1);
});

test('a failed click goes to onError and the button says what it said before', async () => {
  const errors = [];
  const { editor } = draw({ paperState: () => 'lib', onSavePaper: async () => { throw new Error('offline'); }, onError: (error) => errors.push(error.message) });
  editor.savePaper(4);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['offline']);
  const button = editor.editorHtml().match(/<button[^>]*data-row="4"[^>]*>([^<]*)<\/button>/);
  assert.equal(button[1], '+ Workspace');
  assert.doesNotMatch(button[0], /disabled/);
});

// The Workspace's side, against the real library and workspace (ipc.cjs): + Save is addInput (add, then link), + Workspace
// is linkIds, as Workspace.jsx wires them.
async function workspaceHarness(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-guide-save-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {}, describe: async () => ({ title: 'The page names itself', description: '' }), identifyRepo: async () => null });
  const h = (name) => handlers.get(`engelbart:${name}`);
  const ctx = await store.context();
  const project = await h('create-project')({ name: 'Reading' });
  const workspace = await h('create-workspace')(project.id, { name: 'Tools' });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await h('write-doc')(project.id, ref, GUIDE);
  const file = path.join(projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir, 'workspace.md');
  const context = () => projects.findWorkspace(ctx, project.id, workspace.id).workspace.context;
  const linkIds = async (ids) => { await h('link-to-workspace')(project.id, workspace.id, ids); };
  const addInput = async (input, name) => { const row = await h('add-library-item')(input, name ? { name } : undefined); await linkIds([row.id]); return row; };
  const { savePaper } = await model('guide');
  const click = async ({ title, address }) => savePaper({ title, address, library: await h('library')(), inRail: (id) => context().includes(id) }, { addInput, linkIds });
  return { ctx, h, file, context, click, addInput };
}

test('+ Save makes exactly one library row named with the title and links it here; clicking again never makes a second; workspace.md is untouched', async (t) => {
  const { ctx, file, context, click, h } = await workspaceHarness(t);
  const before = fs.readFileSync(file);
  const paper = { title: 'Scim: Intelligent Skimming Support for Scientific Papers', address: SCIM };
  assert.equal(await click(paper), 'saved');
  const rows = await ctx.libraryDb.list();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].url], [paper.title, 'https://arxiv.org/abs/2205.04561'], 'named with the title, not the file');
  assert.deepEqual(context(), [rows[0].id]);
  assert.equal(await click(paper), 'here', 'the library caught up: ✓');
  // A second click before the library was read again (the first still on its way) is refused by main, not added twice.
  await assert.rejects(() => h('add-library-item')(SCIM, { name: paper.title }), /Already in the library/);
  const page = { title: 'CiteSee: Augmenting Citations in Scientific Papers', address: CITESEE };
  await Promise.allSettled([click(page), click(page)]);
  assert.equal((await ctx.libraryDb.list()).filter((row) => row.url === CITESEE).length, 1);
  assert.equal((await ctx.libraryDb.list()).find((row) => row.url === CITESEE).name, page.title, 'a page is named with the title, not its own');
  assert.equal(context().length, 2);
  assert.ok(fs.readFileSync(file).equals(before), 'workspace.md is byte-identical');
});

test('+ Workspace only links the library\'s row: no new row', async (t) => {
  const { ctx, file, context, click, h } = await workspaceHarness(t);
  const before = fs.readFileSync(file);
  const held = await h('add-library-item')('https://arxiv.org/abs/2205.04561', { name: 'Scim (saved earlier)' });
  assert.deepEqual(context(), []);
  assert.equal(await click({ title: 'Scim: Intelligent Skimming Support for Scientific Papers', address: SCIM }), 'linked');
  const rows = await ctx.libraryDb.list();
  assert.deepEqual(rows.map((row) => [row.id, row.name]), [[held.id, 'Scim (saved earlier)']], 'the same row, its name kept');
  assert.deepEqual(context(), [held.id]);
  assert.ok(fs.readFileSync(file).equals(before));
});
