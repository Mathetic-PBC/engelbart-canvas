'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createStore } = require('../src/main/ipc.cjs');
const projects = require('../src/main/store/projects.cjs');
const annotations = require('../src/main/store/interface-annotations.cjs');
const recordings = require('../src/main/store/recordings.cjs');
const { runStore } = require('../src/main/sandbox/runs.cjs');
const anchor = { element: { tag: 'button', selector: '#save', text: 'Save' }, ancestors: [], frames: [], route: '/editor', documentTitle: 'Editor' };
async function setup(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engelbart-captured-sites-'));
  const store = createStore({ homeDir, fixturesDir: path.join(__dirname, '../fixtures') });
  const ctx = await store.context();
  const project = await projects.createProject(ctx, { name: 'Captures' });
  t.after(async () => { await store.close(); await fs.rm(homeDir, { recursive: true, force: true }); });
  return { store, ctx, project };
}

test('simultaneous captures of an unsaved site share a library owner and survive a closed/reopened store', async t => {
  const { store, ctx, project } = await setup(t);
  const scope = { projectId: project.id, url: 'https://unsaved.example/editor?secret=1' };
  const [note, writer] = await Promise.all([
    annotations.create(ctx, scope, { body: 'Keep this visible', anchor }),
    recordings.create(ctx, { ...scope, name: 'Editor' }),
  ]);
  await writer.finish();
  assert.ok(note.libraryId);
  assert.equal(writer.metadata.libraryId, note.libraryId);
  const rows = (await ctx.libraryDb.list()).filter(row => row.type === 'website');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://unsaved.example/editor');
  const other = await projects.createProject(ctx, { name: 'Other' });
  assert.deepEqual((await annotations.list(ctx, { projectId: other.id })).notes, []);
  await store.close();
  const reopened = await store.context();
  assert.equal((await reopened.libraryDb.list()).filter(row => row.type === 'website').length, 1);
  const [restored] = (await annotations.list(reopened, { projectId: project.id })).notes;
  assert.equal(restored.id, note.id);
  assert.equal(restored.sourceUrl, 'https://unsaved.example/editor');
  const [recording] = await recordings.list(reopened, project.id);
  assert.equal(recording.libraryId, restored.libraryId);
  assert.equal(recording.sourceUrl, restored.sourceUrl);
  assert.equal((await recordings.read(reopened, project.id, recording.id)).metadata.id, writer.metadata.id);
});

test('collections include routes on the current website and exclude other origins and projects', async t => {
  const { ctx, project } = await setup(t);
  const captures = [];
  for (const url of ['https://one.example/editor', 'https://one.example/settings', 'https://two.example/editor', 'https://one.example:8443/editor']) {
    const scope = { projectId: project.id, url };
    const note = await annotations.create(ctx, scope, { anchor: { ...anchor, route: new URL(url).pathname }, body: url });
    const writer = await recordings.create(ctx, scope); await writer.finish();
    captures.push({ note: note.id, recording: writer.metadata.id });
  }
  const url = 'https://one.example/another?query=1#/details';
  const notes = await annotations.list(ctx, { projectId: project.id, url });
  const rows = await recordings.list(ctx, project.id, null, url);
  assert.deepEqual(notes.notes.map(n => n.id).sort(), captures.slice(0, 2).map(c => c.note).sort());
  assert.deepEqual(rows.map(r => r.id).sort(), captures.slice(0, 2).map(c => c.recording).sort());
  assert.deepEqual(await recordings.list(ctx, project.id, null, 'https://empty.example'), []);
  const other = await projects.createProject(ctx, { name: 'Other' });
  assert.deepEqual(await recordings.list(ctx, other.id, null, url), []);
  assert.equal((await recordings.list(ctx, project.id)).length, 4, 'filtering keeps all saved captures intact');
});

test('repo resume clears the old URL without losing ownership; notes remain readable offline and follow the rebuilt preview', async t => {
  const { store, ctx, project } = await setup(t);
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), type: 'website', tags: ['git'], name: 'owner/repo', url: 'https://github.com/owner/repo' });
  const runs = runStore(ctx.libraryDb), run = await runs.create(repo.id);
  await runs.update(run.id, { status: 'ready', preview_url: 'https://old-preview.example' });
  const scope = { projectId: project.id, url: 'https://old-preview.example/editor' };
  const note = await annotations.create(ctx, scope, { body: 'Rebuild-safe', anchor });
  const writer = await recordings.create(ctx, scope); await writer.finish();
  await runs.reopen(run.id, randomUUID());
  assert.equal((await runs.get(run.id)).preview_url, null);
  const offline = (await annotations.list(ctx, { projectId: project.id })).notes[0];
  assert.equal(offline.id, note.id); assert.equal(offline.sourceUrl, null);
  assert.equal((await annotations.list(ctx, scope)).notes[0].id, note.id, 'old URL still resolves while the preview rebuilds');
  await runs.update(run.id, { status: 'ready', preview_url: 'https://new-preview.example' });
  await store.close();
  const reopened = await store.context();
  const next = { ...scope, url: 'https://new-preview.example/editor' };
  const [restored] = (await annotations.list(reopened, next)).notes;
  assert.equal(restored.libraryId, repo.id);
  assert.equal(restored.sourceUrl, next.url);
  assert.equal(restored.url, scope.url, 'original capture provenance remains intact');
  assert.equal((await recordings.list(reopened, project.id))[0].sourceUrl, next.url);
  assert.equal((await recordings.list(reopened, project.id, null, next.url))[0].id, writer.metadata.id, 'new preview finds the original recording');
  assert.equal((await recordings.list(reopened, project.id, null, scope.url))[0].id, writer.metadata.id, 'old preview alias finds the same recording');
  assert.deepEqual(await recordings.list(reopened, project.id, null, 'https://unrelated.example/editor'), []);
  assert.deepEqual(await recordings.list(reopened, project.id, null, repo.url), [], 'the GitHub website is separate from its repo preview');
  assert.equal((await reopened.libraryDb.list()).filter(row => row.type === 'website').length, 1, 'preview URLs do not create extra website entries');
  assert.deepEqual((await annotations.list(reopened, { ...next, url: 'https://unrelated.example/editor' })).notes, []);
  await annotations.edit(reopened, next, note.id, 'Still editable');
  assert.equal((await annotations.list(reopened, scope)).notes[0].body, 'Still editable');
});

test('startup adopts legacy unlinked notes and recordings, verifies project hashes, and preserves IDs and bodies', async t => {
  const { store, ctx, project } = await setup(t);
  const other = await projects.createProject(ctx, { name: 'Other' });
  const url = 'https://legacy.example/editor', site = 'site:https://legacy.example';
  const note = { id: randomUUID(), url, runId: null, anchor, body: 'Existing note', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' };
  const hash = createHash('sha256').update(`${project.id}\n${site}`).digest('hex');
  const dir = path.join(ctx.dataRoot, 'annotations', 'interface');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${hash}.json`), JSON.stringify({ version: 1, notes: [note] }));
  const writer = await recordings.create(ctx, { projectId: project.id, url }); await writer.finish();
  const recordingFile = path.join(recordings.directory(ctx, project.id, writer.metadata.id), 'meta.json');
  await fs.writeFile(recordingFile, JSON.stringify({ ...writer.metadata, libraryId: null }));
  await ctx.libraryDb.remove(writer.metadata.libraryId);
  await store.close();
  const reopened = await store.context();
  assert.deepEqual((await annotations.list(reopened, { projectId: other.id })).notes, []);
  const [saved] = (await annotations.list(reopened, { projectId: project.id })).notes;
  assert.equal(saved.id, note.id); assert.equal(saved.body, note.body);
  const [recording] = await recordings.list(reopened, project.id);
  assert.equal(recording.libraryId, saved.libraryId);
  assert.equal((await reopened.libraryDb.list()).filter(row => row.type === 'website').length, 1);
  const migrated = JSON.parse(await fs.readFile(path.join(dir, `${hash}.json`), 'utf8'));
  assert.equal(migrated.projectId, project.id);
  assert.equal(migrated.libraryId, saved.libraryId);
  assert.equal(JSON.parse(await fs.readFile(recordingFile, 'utf8')).libraryId, saved.libraryId);
});

test('legacy repo notes recover through run ID even if their hostname was already replaced', async t => {
  const { ctx, project } = await setup(t);
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), type: 'website', tags: ['git'], name: 'repo', url: 'https://github.com/owner/repo' });
  const runId = randomUUID();
  await ctx.libraryDb.query("insert into sandbox_runs(id,library_id,status,preview_url) values($1,$2,'ready',$3)", [runId, repo.id, 'https://replacement.example']);
  const hash = createHash('sha256').update(`${project.id}\nrepo:${repo.id}`).digest('hex');
  const dir = path.join(ctx.dataRoot, 'annotations', 'interface'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${hash}.json`), JSON.stringify({ version: 1, notes: [{ id: randomUUID(), url: 'https://forgotten.example/editor', runId, anchor, body: 'Old repo note' }] }));
  const [note] = (await annotations.list(ctx, { projectId: project.id, url: 'https://replacement.example/editor' })).notes;
  assert.equal(note.libraryId, repo.id);
  assert.equal(note.sourceUrl, 'https://replacement.example/editor');
  assert.equal((await ctx.libraryDb.list()).filter(row => row.type === 'website').length, 1);
});

test('an existing website is reused; catalog repo tags do not redirect captures of GitHub itself to a preview', async t => {
  const { ctx, store, project } = await setup(t);
  const existing = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Saved website', type: 'website', url: 'https://saved.example/' });
  const scope = { projectId: project.id, url: 'https://saved.example/editor' };
  const note = await annotations.create(ctx, scope, { anchor, body: 'Already saved' });
  assert.equal(note.libraryId, existing.id);
  const github = { projectId: project.id, url: 'https://github.com/owner/repo' };
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), name: 'owner/repo', type: 'website', tags: ['git'], url: github.url });
  const gitNote = await annotations.create(ctx, github, { anchor: { ...anchor, route: '/owner/repo' }, body: 'Comment about the GitHub page' });
  assert.equal(gitNote.libraryId, repo.id, 'an exact saved address is reused even if its library row is a repository');
  await store.close();
  const reopened = await store.context();
  assert.ok((await reopened.libraryDb.get(gitNote.libraryId)).tags.includes('git'), 'catalog recognizes repository address on startup');
  const [restored] = (await annotations.list(reopened, github)).notes;
  assert.equal(restored.sourceUrl, github.url);
  assert.equal(restored.scope, 'site:https://github.com');
  assert.equal((await reopened.libraryDb.list()).filter(row => row.type === 'website').length, 2);
});

test('route restoration preserves the source origin for double-slash paths and hash routes', () => {
  const { routeUrl } = require('../src/shared/interface-annotations.cjs');
  assert.equal(routeUrl('//other.example/path', 'https://original.example/base'), 'https://original.example//other.example/path');
  assert.equal(routeUrl('/#/editor', 'https://rebuilt.example'), 'https://rebuilt.example/#/editor');
});

test('an unreadable annotation file leaves other sites visible and is never overwritten by a new note', async t => {
  const { ctx, project } = await setup(t);
  const scope = { projectId: project.id, url: 'https://damaged.example/editor' };
  await annotations.create(ctx, scope, { anchor, body: 'Original' });
  const other = await annotations.create(ctx, { ...scope, url: 'https://intact.example/editor' }, { anchor, body: 'Intact' });
  const hash = createHash('sha256').update(`${project.id}\nsite:https://damaged.example`).digest('hex');
  const file = path.join(ctx.dataRoot, 'annotations', 'interface', `${hash}.json`);
  await fs.writeFile(file, 'incomplete saved bytes');
  const result = await annotations.list(ctx, { projectId: project.id });
  assert.deepEqual(result.notes.map(n => n.id), [other.id]);
  assert.equal(result.warnings.length, 1);
  await assert.rejects(annotations.create(ctx, scope, { anchor, body: 'Do not replace the damaged file' }));
  assert.equal(await fs.readFile(file, 'utf8'), 'incomplete saved bytes');
});
