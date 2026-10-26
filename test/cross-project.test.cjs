'use strict';

// Other projects' workspaces and Sources from inside this one (MATH-148, 2026-10-26): a mention of another project's
// workspace is read for Bart through the read-only lookup, while findWorkspace and everything that writes stay in their
// own project; search across the other projects (store/elsewhere.cjs); a workspace copied in; the read-only tab kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const elsewhere = require('../src/main/store/elsewhere.cjs');
const { expandDoc } = require('../src/main/context/expand-mentions.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-cross-'));
const layout = ensureHome(homeDir);
let ctx;
let here;
let there;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  there = await projects.createProject(ctx, 'Thesis');
  here = await projects.createProject(ctx, 'Lab');
});
test.after(async () => { await db.closeAll(); });

const wsRef = (workspaceId) => ({ kind: 'workspace', workspaceId });
const docFile = (workspaceId) => path.join(projects.findWorkspaceAnywhere(ctx, workspaceId).workspace.dir, 'workspace.md');

/* ------------------------------------------------------------ the lookup, for a mention only */

test('a mention of another project\'s workspace gives its document, named with its project; this project\'s ws:<id> still resolves', async () => {
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'Chapter two' });
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), 'what chapter two says');
  const mine = await projects.createWorkspace(ctx, here.id, { name: 'Notes here' });
  await projects.writeDoc(ctx, here.id, wsRef(mine.id), 'my own words');
  const asking = await projects.createWorkspace(ctx, here.id, { name: 'Asking' });
  await projects.writeDoc(ctx, here.id, wsRef(asking.id), `See @[Chapter two](ws:${theirs.id}) and @[Notes here](ws:${mine.id}).`);
  const result = await expandDoc(ctx, here.id, wsRef(asking.id));
  assert.match(result.text, /<file name="Chapter two" type="workspace" project="Thesis" path="[^"]+[\\/]Chapter two[\\/]workspace\.md">\nwhat chapter two says\n<\/file>/);
  assert.match(result.text, /<file name="Notes here" type="workspace" path="[^"]+[\\/]Notes here[\\/]workspace\.md">\nmy own words\n<\/file>/, 'its own, with no project said');
  assert.equal(result.missing, 0);
});

test('a name mentioned inside another project\'s workspace is looked for in that project first, then this one', async () => {
  await projects.createNote(ctx, here.id, { name: 'Method', text: 'the lab\'s method' });
  await projects.createNote(ctx, there.id, { name: 'Method', text: 'the thesis\'s method' });
  await projects.createNote(ctx, here.id, { name: 'Only here', text: 'only the lab has this' });
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'Methods chapter' });
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), 'Uses @[Method] and @[Only here].');
  const asking = await projects.createWorkspace(ctx, here.id, { name: 'Reading it' });
  await projects.writeDoc(ctx, here.id, wsRef(asking.id), `@[Methods chapter](ws:${theirs.id})`);
  const result = await expandDoc(ctx, here.id, wsRef(asking.id));
  assert.match(result.text, /the thesis's method/);
  assert.doesNotMatch(result.text, /the lab's method/);
  assert.match(result.text, /only the lab has this/, 'not in its project: this one\'s');
});

test('Bart is handed another project\'s mentioned workspace as it is handed this project\'s', async () => {
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'Related work' });
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), 'a survey of related work');
  const asking = await projects.createWorkspace(ctx, here.id, { name: 'Bart asks' });
  await projects.writeDoc(ctx, here.id, wsRef(asking.id), `Compare @[Related work](ws:${theirs.id}).\n@bart what?\nbart~> q1\n`);
  const context = await buildContext(ctx, here.id, { ref: wsRef(asking.id), workspaceId: asking.id, askId: 'q1' });
  assert.match(context.documents, /<file name="Related work" type="workspace" project="Thesis" path="[^"]+">\na survey of related work\n<\/file>/);
});

test('findWorkspace and what writes stay in their own project: another project\'s workspace is not found and not written', async () => {
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'Untouched' });
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), 'as it was');
  assert.throws(() => projects.findWorkspace(ctx, here.id, theirs.id), /Unknown workspace/);
  assert.equal(projects.findWorkspace(ctx, there.id, theirs.id).workspace.id, theirs.id, 'in its own project, as before');
  await assert.rejects(projects.writeDoc(ctx, here.id, wsRef(theirs.id), 'overwritten'));
  await assert.rejects(projects.renameWorkspace(ctx, here.id, theirs.id, 'Renamed'));
  const found = projects.findWorkspaceAnywhere(ctx, theirs.id);
  assert.equal(found.project.id, there.id);
  assert.equal(fs.readFileSync(docFile(theirs.id), 'utf8'), 'as it was');
  assert.equal(projects.findWorkspaceAnywhere(ctx, randomUUID()), null);
});

test('every project\'s workspaces in one list, nested ones too, each with its project', async () => {
  const top = await projects.createWorkspace(ctx, there.id, { name: 'Top' });
  const inner = await projects.createWorkspace(ctx, there.id, { name: 'Inner', parentId: top.id });
  const all = projects.workspacesEverywhere(ctx);
  const got = all.find((ws) => ws.id === inner.id);
  assert.ok(got, 'the nested one is listed');
  assert.deepEqual({ name: got.name, projectId: got.projectId, projectName: got.projectName }, { name: 'Inner', projectId: there.id, projectName: 'Thesis' });
  assert.ok(all.some((ws) => ws.projectId === here.id), 'this project\'s too');
});

/* ------------------------------------------------------------ search across the other projects */

test('search finds words in another project\'s workspace and in a pdf\'s text, and gives back only the matches', async () => {
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'Field notes' });
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), `${'filler '.repeat(40)}the zebrafish larvae swim${' more'.repeat(40)}`);
  const paper = await ctx.libraryDb.insert({ id: randomUUID(), name: 'A paper', type: 'pdf', path: '/nowhere/a.pdf', project_id: there.id, tags: ['paper'] });
  await ctx.libraryDb.setText(paper.id, `${'x '.repeat(200)}Zebrafish regenerate fins${' y'.repeat(200)}`, 1);
  const mineToo = await projects.createWorkspace(ctx, here.id, { name: 'Lab zebrafish' });
  await projects.writeDoc(ctx, here.id, wsRef(mineToo.id), 'zebrafish here');

  const hits = await elsewhere.searchElsewhere(ctx, here.id, 'ZEBRAFISH', 20);
  const ws = hits.find((hit) => hit.id === theirs.id);
  assert.deepEqual({ kind: ws.kind, name: ws.name, projectId: ws.projectId, projectName: ws.projectName, by: ws.by }, { kind: 'workspace', name: 'Field notes', projectId: there.id, projectName: 'Thesis', by: 'text' });
  assert.match(ws.snippet, /zebrafish larvae/);
  assert.ok(ws.snippet.length < 200, 'a snippet, not the document');
  const pdf = hits.find((hit) => hit.id === paper.id);
  assert.equal(pdf.kind, 'item');
  assert.equal(pdf.projectName, 'Thesis');
  assert.match(pdf.snippet, /Zebrafish regenerate fins/);
  assert.ok(pdf.snippet.length < 200);
  assert.ok(!hits.some((hit) => hit.id === mineToo.id || hit.projectId === here.id), 'nothing of the project asking');
  for (const hit of hits) assert.ok(!('text' in hit), 'no texts');
  assert.deepEqual(await elsewhere.searchElsewhere(ctx, here.id, 'no such words anywhere', 20), []);
  assert.equal((await elsewhere.searchElsewhere(ctx, here.id, 'zebrafish', 1)).length, 1, 'the limit holds');
});

test('search sees a workspace\'s new text at once, and one renamed or deleted, without a restart', async () => {
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'Changing' });
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), 'before the change');
  assert.equal((await elsewhere.searchElsewhere(ctx, here.id, 'axolotl', 20)).length, 0);
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), 'after the change there is an axolotl');
  assert.deepEqual((await elsewhere.searchElsewhere(ctx, here.id, 'axolotl', 20)).map((hit) => hit.id), [theirs.id]);
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), 'after the change there is an axolotz'); // same length
  const stamp = new Date(Date.now() + 5000);
  fs.utimesSync(docFile(theirs.id), stamp, stamp);
  assert.equal((await elsewhere.searchElsewhere(ctx, here.id, 'axolotl', 20)).length, 0, 'same size, new time: read again');
  const named = await projects.createWorkspace(ctx, there.id, { name: 'Brand new' });
  assert.deepEqual((await elsewhere.searchElsewhere(ctx, here.id, 'brand new', 20)).map((hit) => [hit.id, hit.by]), [[named.id, 'name']]);
  await projects.renameWorkspace(ctx, there.id, named.id, 'Renamed since');
  assert.deepEqual(await elsewhere.searchElsewhere(ctx, here.id, 'brand new', 20), []);
  assert.deepEqual((await elsewhere.searchElsewhere(ctx, here.id, 'renamed since', 20)).map((hit) => hit.id), [named.id]);
  projects.trashWorkspace(ctx, there.id, theirs.id);
  assert.deepEqual(await elsewhere.searchElsewhere(ctx, here.id, 'axolotz', 20), [], 'trashed: gone from search');
});

/* ------------------------------------------------------------ copy to this project */

test('Copy to this project: a new workspace at the top, same name, the text without task markers or build> lines; the original untouched', async () => {
  await projects.createWorkspace(ctx, here.id, { name: 'Already first' });
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'To copy' });
  const original = '# Plan\n- [ ] <!--build:0123456789--> Add the export\nbuild> abc123def\nkeep this\n';
  await projects.writeDoc(ctx, there.id, wsRef(theirs.id), original);
  const copied = await projects.copyWorkspaceInto(ctx, here.id, there.id, theirs.id);
  assert.notEqual(copied.id, theirs.id);
  assert.equal(copied.name, 'To copy');
  const top = projects.workspacesEverywhere(ctx).filter((ws) => ws.projectId === here.id && !ws.path.includes('/'));
  assert.equal(top[0].id, copied.id, 'at the top of this project');
  assert.equal(await projects.readDoc(ctx, here.id, wsRef(copied.id)), '# Plan\n- [ ] Add the export\nkeep this\n');
  assert.equal(await projects.readDoc(ctx, there.id, wsRef(theirs.id)), original, 'the original as it was');
  assert.ok(projects.findWorkspace(ctx, there.id, theirs.id), 'still in its project');
});

/* ------------------------------------------------------------ the read-only tab, kept with this project's view */

test('a tab of another project\'s workspace is kept in this project\'s view and comes back as one', async () => {
  const mine = await projects.createWorkspace(ctx, here.id, { name: 'With a foreign tab' });
  const theirs = await projects.createWorkspace(ctx, there.id, { name: 'Shown read-only' });
  const tab = { id: theirs.id, title: 'Shown read-only', kind: 'foreign', projectId: there.id, from: 'Thesis' };
  projects.writeView(ctx, here.id, mine.id, { active: theirs.id, tabs: [tab] });
  const view = projects.readViews(ctx, here.id)[mine.id];
  assert.deepEqual(view.tabs.find((t) => t.id === theirs.id), tab);
  assert.equal(projects.readViews(ctx, there.id)[mine.id], undefined, 'nothing in the other project\'s views');
  projects.writeView(ctx, here.id, mine.id, { tabs: [{ id: randomUUID(), title: 'x', kind: 'foreign' }] });
  assert.deepEqual(projects.readViews(ctx, here.id)[mine.id].tabs, [], 'one with no project is dropped');
});
