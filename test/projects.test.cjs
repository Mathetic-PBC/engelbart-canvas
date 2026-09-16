'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-projects-'));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('projects: create, list, rename moves the directory and rewrites note paths', async () => {
  const created = await projects.createProject(ctx, 'Thesis/2026');
  assert.equal(created.name, 'Thesis2026');
  assert.equal(created.slug, 'thesis2026');
  assert.ok(fs.statSync(path.join(layout.testRoot, 'thesis2026', 'project.json')).isFile());
  assert.ok(fs.statSync(path.join(layout.testRoot, 'thesis2026', 'notes.pglite')).isDirectory());
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.testRoot, 'thesis2026', 'project.json'), 'utf8')).name, 'Thesis2026');
  const note = await projects.createNote(ctx, created.id, { name: 'First' });
  assert.equal(note.path, 'First.md');
  const listed = await projects.listProjects(ctx);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].goalCount, 0);
  const renamed = await projects.renameProject(ctx, created.id, 'Thesis');
  assert.equal(renamed.name, 'Thesis');
  assert.equal(renamed.slug, 'thesis');
  assert.equal(renamed.id, created.id);
  assert.ok(!fs.existsSync(path.join(layout.testRoot, 'thesis2026')));
  assert.ok(fs.existsSync(path.join(layout.testRoot, 'thesis', 'First.md')));
  const libraryRow = await ctx.libraryDb.get(note.id);
  assert.equal(libraryRow.path, path.join(layout.testRoot, 'thesis', 'First.md'));
  assert.equal(libraryRow.type, 'note');
  assert.equal(libraryRow.project_id, created.id);
  const same = await projects.renameProject(ctx, created.id, 'Thesis');
  assert.equal(same.name, 'Thesis');
  await assert.rejects(() => projects.renameProject(ctx, 'not-a-uuid', 'x'), TypeError);
});

test('a custom project path keeps its directory through renames', async () => {
  const created = await projects.createProject(ctx, { name: 'Reading Group', path: 'My Folder!' });
  assert.equal(created.slug, 'my-folder');
  assert.ok(fs.existsSync(path.join(layout.testRoot, 'my-folder', 'project.json')));
  const renamed = await projects.renameProject(ctx, created.id, 'Reading Group 2');
  assert.equal(renamed.slug, 'my-folder');
  assert.equal(renamed.name, 'Reading Group 2');
  const twin = await projects.createProject(ctx, { name: 'Reading Group', path: 'my-folder' });
  assert.equal(twin.slug, 'my-folder 2');
});

test('createProjectWithWelcome makes a first goal and topic and a Welcome! note in the topic context', async () => {
  const made = await projects.createProjectWithWelcome(ctx, { name: 'Fresh' });
  assert.equal(made.noteName, 'Welcome!');
  const tree = await projects.loadProject(ctx, made.project.id);
  assert.equal(tree.goals.length, 1);
  assert.equal(tree.goals[0].name, 'First steps');
  assert.equal(tree.goals[0].topics[0].name, 'Getting started');
  assert.deepEqual(tree.goals[0].topics[0].context, [made.noteId]);
  assert.equal(tree.notes[0].name, 'Welcome!');
  assert.equal(tree.notes[0].topicId, made.topicId);
  const text = await projects.readDoc(ctx, made.project.id, { kind: 'note', id: made.noteId });
  assert.ok(text.startsWith('This is a note'));
  assert.ok(fs.existsSync(path.join(layout.testRoot, 'fresh', 'Welcome!.md')));
});

test('topic context accepts folders and rejects bad entries', async () => {
  const project = await projects.createProject(ctx, 'Trees');
  const goal = await projects.createGoal(ctx, project.id, { name: 'G', box: 'current' });
  const topic = await projects.createTopic(ctx, project.id, goal.id, 'T');
  const a = '11111111-2222-4333-8444-555555555555';
  const folder = '22222222-2222-4333-8444-555555555555';
  const saved = await projects.setTopicContext(ctx, project.id, goal.id, topic.id, [{ id: folder, name: ' Reading ', children: [a, a] }, a]);
  assert.deepEqual(saved.context, [{ id: folder, name: 'Reading', children: [a] }]);
  assert.deepEqual(projects.treeIds(saved.context), [a]);
  await assert.rejects(() => projects.setTopicContext(ctx, project.id, goal.id, topic.id, [42]), TypeError);
  await assert.rejects(() => projects.setTopicContext(ctx, project.id, goal.id, topic.id, [{ id: 'nope', children: [] }]), TypeError);
});

test('goals and topics are directories with meta.json; docs and future round-trip', async () => {
  const project = await projects.createProject(ctx, 'Canvas');
  const goal = await projects.createGoal(ctx, project.id, { name: 'Goal 1', box: 'current' });
  assert.equal(goal.box, 'current');
  await assert.rejects(() => projects.createGoal(ctx, project.id, { name: 'x', box: 'later' }), TypeError);
  const goalDir = path.join(layout.testRoot, 'canvas', 'Goal 1');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(goalDir, 'meta.json'), 'utf8'))).sort(), ['box', 'created', 'id']);
  const duplicate = await projects.createGoal(ctx, project.id, { name: 'Goal 1', box: 'past' });
  assert.equal(duplicate.name, 'Goal 1 2');

  const topic = await projects.createTopic(ctx, project.id, goal.id, 'Topic 4');
  assert.equal(topic.status, 'open');
  assert.deepEqual(topic.context, []);
  const topicDir = path.join(goalDir, 'Topic 4');
  assert.equal(fs.readFileSync(path.join(topicDir, 'workspace.md'), 'utf8'), '');
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', goalId: goal.id, topicId: topic.id }, '- [ ] first\n');
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', goalId: goal.id, topicId: topic.id }), '- [ ] first\n');
  assert.equal((await projects.setTopicStatus(ctx, project.id, goal.id, topic.id, 'progress')).status, 'progress');
  await assert.rejects(() => projects.setTopicStatus(ctx, project.id, goal.id, topic.id, 'later'), TypeError);
  const paperId = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual((await projects.setTopicContext(ctx, project.id, goal.id, topic.id, [paperId, paperId])).context, [paperId]);
  const renamedTopic = await projects.renameTopic(ctx, project.id, goal.id, topic.id, 'Debugging');
  assert.equal(renamedTopic.name, 'Debugging');
  assert.ok(fs.existsSync(path.join(goalDir, 'Debugging', 'workspace.md')));
  const renamedGoal = await projects.renameGoal(ctx, project.id, goal.id, 'HypoCompass');
  assert.equal(renamedGoal.name, 'HypoCompass');
  assert.ok(fs.existsSync(path.join(layout.testRoot, 'canvas', 'HypoCompass', 'Debugging', 'meta.json')));

  assert.deepEqual(await projects.setFuture(ctx, project.id, goal.id, ['  ship it ', '', 'next']), ['ship it', 'next']);
  assert.equal(fs.readFileSync(path.join(layout.testRoot, 'canvas', 'HypoCompass', 'future.md'), 'utf8'), '- ship it\n- next\n');

  const note = await projects.createNote(ctx, project.id, { name: 'Reading', goalId: goal.id, topicId: topic.id });
  assert.equal(note.goalId, goal.id);
  assert.ok(fs.existsSync(path.join(layout.testRoot, 'canvas', 'Reading.md')));
  assert.ok(!fs.existsSync(path.join(layout.testRoot, 'canvas', 'HypoCompass', 'Reading.md')));
  await projects.writeDoc(ctx, project.id, { kind: 'note', id: note.id }, '# hi\n');
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'note', id: note.id }), '# hi\n');
  const renamedNote = await projects.renameNote(ctx, project.id, note.id, 'Reading notes');
  assert.equal(renamedNote.path, 'Reading notes.md');
  assert.equal((await ctx.libraryDb.get(note.id)).path, path.join(layout.testRoot, 'canvas', 'Reading notes.md'));

  const tree = await projects.loadProject(ctx, project.id);
  assert.equal(tree.project.name, 'Canvas');
  assert.equal(tree.goals.length, 2);
  const loadedGoal = tree.goals.find((candidate) => candidate.id === goal.id);
  assert.equal(loadedGoal.topics[0].name, 'Debugging');
  assert.deepEqual(loadedGoal.future, ['ship it', 'next']);
  assert.equal(loadedGoal.notes[0].name, 'Reading notes');
  assert.equal(tree.notes.length, 1);
});
