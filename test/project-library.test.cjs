'use strict';

// A project's own list (2026-10-11, the Library's Phase A): project.json `library` and `removed`, the one rule for what a
// project holds (shared/project-holds.cjs), adding to and removing from a project, which workspaces mention an item, and
// what an agent is shown afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const { writeCatalogs } = require('../src/main/context/catalog.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');
const { holder, letGo } = require('../src/shared/project-holds.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-plib-')));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

let n = 0;
async function scene() {
  n += 1;
  const project = await projects.createProject(ctx, `Library ${n}`);
  const a = await projects.createWorkspace(ctx, project.id, { name: 'A' });
  const b = await projects.createWorkspace(ctx, project.id, { name: 'B' });
  return { project, a, b, record: () => projects.findProject(ctx, project.id) };
}
const paper = (name, extra = {}) => ctx.libraryDb.insert({ id: randomUUID(), name, type: 'website', url: `https://example.org/${randomUUID()}`, ...extra });
const projectJson = (project) => JSON.parse(fs.readFileSync(path.join(project.dir, 'project.json'), 'utf8'));
const heldIds = async (projectId) => (await library.libraryForProject(ctx, projectId)).map((row) => row.id);
const catalogIds = async (project) => {
  await writeCatalogs(ctx);
  return JSON.parse(fs.readFileSync(path.join(project.dir, '.context', 'catalog.json'), 'utf8')).entries.map((entry) => entry.id);
};

test('the rule: made in it, on its list, or in a workspace\'s context and not thrown away there; removal wins over all three', () => {
  const project = { id: 'p', library: ['listed', 'both'], removed: ['both', 'made-removed'] };
  const workspaces = [{ id: 'w', context: ['ctx', 'ctx-thrown'], removed: ['ctx-thrown'] }];
  const held = holder(project, workspaces);
  assert.equal(held({ id: 'made', project_id: 'p' }), true);
  assert.equal(held({ id: 'listed' }), true);
  assert.equal(held({ id: 'ctx' }), true);
  assert.equal(held({ id: 'ctx-thrown' }), false, 'in context but on that workspace\'s removed');
  assert.equal(held({ id: 'both' }), false, 'on the list and removed: removed wins');
  assert.equal(held({ id: 'made-removed', project_id: 'p' }), false, 'made in it and removed: removed wins over the origin');
  assert.equal(held({ id: 'other', project_id: 'q' }), false);
  // A post-it's note (made in no workspace, none ever had it) is held; one every workspace threw away is not.
  assert.deepEqual([...letGo(workspaces, new Map([['postit', null]]))], []);
  assert.equal(holder({ id: 'p' }, workspaces, new Map([['postit', null]]))({ id: 'postit', project_id: 'p' }), true);
});

test('project.json keeps the list: missing reads as empty, and an add puts a row on it that no workspace has', async () => {
  const { project, record } = await scene();
  assert.deepEqual([record().library, record().removed], [[], []], 'an older project.json, without either');
  const row = await paper('Listed');
  assert.deepEqual(await heldIds(project.id), []);
  assert.deepEqual(await projects.addToProject(ctx, project.id, [row.id]), { added: 1, inWorkspace: 0 });
  assert.deepEqual(projectJson(project).library, [row.id]);
  assert.deepEqual(await heldIds(project.id), [row.id], 'held, with no workspace holding it');
  assert.ok((await projects.listProjects(ctx)).find((each) => each.id === project.id).libraryIds.includes(row.id), 'the all-projects card counts it');
  assert.ok((await catalogIds(project)).includes(row.id), '.context/catalog.json lists it');
  assert.deepEqual((await library.projectsForLibraryItem(ctx, row.id)).map((each) => each.id), [project.id]);
});

test('a row on project.removed is not held, even one made in the project', async () => {
  const { project } = await scene();
  const made = await paper('Imported before', { project_id: project.id });
  assert.deepEqual(await heldIds(project.id), [made.id]);
  fs.writeFileSync(path.join(project.dir, 'project.json'), JSON.stringify({ ...projectJson(project), removed: [made.id] }));
  assert.deepEqual(await heldIds(project.id), []);
  assert.ok(!(await catalogIds(project)).includes(made.id));
});

test('a note every workspace threw away is not held; a post-it\'s note in no workspace is', async () => {
  const { project, a, b } = await scene();
  const note = await projects.createNote(ctx, project.id, { name: 'Draft', text: 'x', workspaceId: a.id });
  const postIt = await projects.createNote(ctx, project.id, { name: 'From a post-it', text: 'y' });
  await projects.linkToWorkspace(ctx, project.id, b.id, [note.id]);
  assert.deepEqual((await heldIds(project.id)).sort(), [note.id, postIt.id].sort());
  await projects.unlinkFromWorkspace(ctx, project.id, b.id, note.id);
  assert.ok((await heldIds(project.id)).includes(note.id), 'still the note of the workspace it was made in');
  await projects.unlinkFromWorkspace(ctx, project.id, a.id, note.id);
  assert.deepEqual(await heldIds(project.id), [postIt.id], 'thrown away everywhere: let go of');
  assert.ok(!(await catalogIds(project)).includes(note.id));
});

test('remove-from-project takes a row out of the project and out of every workspace, and refuses a note written here', async () => {
  const { project, a, b, record } = await scene();
  const row = await paper('Going');
  await projects.addToProject(ctx, project.id, [row.id], { workspaceId: a.id });
  await projects.linkToWorkspace(ctx, project.id, b.id, [row.id]);
  assert.deepEqual(await projects.removeFromProject(ctx, project.id, [row.id]), { removed: 1 });
  assert.deepEqual([record().library, record().removed], [[], [row.id]]);
  for (const workspace of [a, b]) {
    const held = projects.findWorkspace(ctx, project.id, workspace.id).workspace;
    assert.ok(!held.context.includes(row.id) && held.removed.includes(row.id), `${workspace.name}: out of its context, on its removed`);
  }
  assert.deepEqual(await heldIds(project.id), []);
  const note = await projects.createNote(ctx, project.id, { name: 'Mine', text: 'z', workspaceId: a.id });
  await assert.rejects(projects.removeFromProject(ctx, project.id, [note.id]), /Made in this project.*Mine/);
  assert.ok((await heldIds(project.id)).includes(note.id), 'nothing changed');
  // Added again: off removed, held again.
  await projects.addToProject(ctx, project.id, [row.id]);
  assert.deepEqual([record().library, record().removed], [[row.id], []]);
});

test('both calls take at most 200 ids and refuse more, without cutting the list short', async () => {
  const { project, record } = await scene();
  const ids = Array.from({ length: 201 }, () => randomUUID());
  await assert.rejects(projects.addToProject(ctx, project.id, ids), /At most 200 .* 201 were sent/);
  await assert.rejects(projects.removeFromProject(ctx, project.id, ids), /At most 200 .* 201 were sent/);
  assert.deepEqual([record().library, record().removed], [[], []]);
  await assert.rejects(projects.addToProject(ctx, project.id, [randomUUID()]), /Not in the library/);
  // The IPC handlers say the same before anything is queued.
  const ipc = fs.readFileSync(path.join(__dirname, '../src/main/ipc.cjs'), 'utf8');
  assert.match(ipc, /saving\('add-to-project'[\s\S]*?projectIds\(ids\)/);
  assert.match(ipc, /saving\('remove-from-project'[\s\S]*?projectIds\(ids\)/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  for (const [name, channel] of [['addToProject', 'add-to-project'], ['removeFromProject', 'remove-from-project'], ['projectItemMentions', 'project-item-mentions']]) assert.match(preload, new RegExp(`${name}: invoke\\('${channel}'\\)`));
});

test('add-to-project with a workspace links there as far as it has room; the rest are the project\'s alone', async () => {
  const { project, a } = await scene();
  const rows = [await paper('One'), await paper('Two')];
  const workspace = projects.findWorkspace(ctx, project.id, a.id).workspace;
  fs.writeFileSync(path.join(workspace.dir, 'meta.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(workspace.dir, 'meta.json'), 'utf8')), context: Array.from({ length: projects.MAX_TREE_ENTRIES - 1 }, () => randomUUID()) }));
  assert.deepEqual(await projects.addToProject(ctx, project.id, rows.map((row) => row.id), { workspaceId: a.id }), { added: 2, inWorkspace: 1 });
  assert.deepEqual((await heldIds(project.id)).filter((id) => rows.some((row) => row.id === id)).length, 2);
});

test('project-item-mentions: the workspaces whose document mentions it, by id or by name', async () => {
  const { project, a, b } = await scene();
  const row = await paper('Transfer study');
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: a.id }, `See @[Transfer study](lib:${row.id}).`);
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: b.id }, 'And @[transfer study] too.');
  assert.deepEqual((await projects.projectItemMentions(ctx, project.id, row.id)).map((each) => each.name).sort(), ['A', 'B']);
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: b.id }, 'Nothing now.');
  assert.deepEqual((await projects.projectItemMentions(ctx, project.id, row.id)).map((each) => each.name), ['A']);
});

test('after add-to-project, the row is in the library the agents are shown (bart/context.cjs); after remove-from-project, it is not', async () => {
  const { project, a } = await scene();
  const row = await paper('Only on the list');
  const shown = async () => {
    const context = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: a.id }, workspaceId: a.id, askId: 'x', agent: 'discover' });
    return JSON.parse(context.contextJson.replace(/^<context_json>\n|\n<\/context_json>$/g, '')).map((entry) => entry.name);
  };
  assert.ok(!(await shown()).includes('Only on the list'));
  await projects.addToProject(ctx, project.id, [row.id]);
  assert.ok((await shown()).includes('Only on the list'));
  await projects.removeFromProject(ctx, project.id, [row.id]);
  assert.ok(!(await shown()).includes('Only on the list'));
});
