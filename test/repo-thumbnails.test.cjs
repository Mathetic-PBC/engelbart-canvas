'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const thumbs = require('../src/main/store/repo-thumbnails.cjs');

const bytes = Buffer.from([255, 216, 255, 224, 1, 2, 3, 255, 217]);
let ctx;
test.before(async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'engelbart-thumbnails-'));
  ctx = { dataRoot, libraryDb: await db.openLibraryDb(dataRoot) };
});
test.after(() => db.closeAll());
async function repo() {
  const id = randomUUID();
  const row = await ctx.libraryDb.insert({ id, name: 'owner/repo', url: 'https://github.com/owner/repo', type: 'website', tags: ['git'] });
  const run = await nextRun(row.id);
  return { row, run, url: run.preview_url };
}
async function nextRun(id, status = 'ready') {
  await ctx.libraryDb.query("update sandbox_runs set status = 'stopped' where library_id = $1", [id]);
  const runId = randomUUID();
  const [run] = await ctx.libraryDb.query('insert into sandbox_runs (id, library_id, status, preview_url) values ($1, $2, $3, $4) returning *',
    [runId, id, status, `https://3000-${runId}.e2b.app/`]);
  return run;
}
const files = async id => (await fs.readdir(path.join(ctx.dataRoot, 'assets/repo-thumbnails')).catch(() => [])).filter(name => name.startsWith(id));

test('target resolves only a current ready repo preview, not the GitHub page or a lookalike host', async () => {
  const { row, run, url } = await repo();
  assert.equal((await thumbs.target(ctx, url + 'app?x=1')).run.id, run.id);
  for (const other of [row.url, url.replace('.app', '.app.evil.example'), 'file:///tmp/a', 'about:blank', 'https://someone:secret@example.com/']) assert.equal(await thumbs.target(ctx, other), null);
  await nextRun(row.id, 'failed');
  assert.equal(await thumbs.target(ctx, url), null, 'an older ready preview is not eligible after a later run');
});

test('file precedes its library reference; writes preserve the repo identity and edit time; persists across reopen', async () => {
  const { row, run, url } = await repo();
  const updated = await thumbs.save(ctx, await thumbs.target(ctx, url), bytes);
  assert.match(updated.thumbnail_path, /^assets\/repo-thumbnails\//);
  assert.equal(updated.thumbnail_run_id, run.id);
  assert.ok(Date.parse(updated.thumbnail_captured_at));
  assert.equal(updated.last_edited, row.last_edited);
  assert.deepEqual([updated.url, updated.path, updated.folder_path, updated.tags], [row.url, row.path, row.folder_path, row.tags]);
  assert.deepEqual(await fs.readFile(path.join(ctx.dataRoot, updated.thumbnail_path)), bytes);
  assert.equal((await fs.stat(path.join(ctx.dataRoot, updated.thumbnail_path))).mode & 0o777, 0o600);
  assert.equal(await thumbs.target(ctx, url), null, 'a saved run is not photographed again');
  await db.closeAll(); ctx.libraryDb = await db.openLibraryDb(ctx.dataRoot);
  assert.equal(await thumbs.read(ctx, row.id), `data:image/jpeg;base64,${bytes.toString('base64')}`);
  await fs.unlink(path.join(ctx.dataRoot, updated.thumbnail_path));
  const missing = await thumbs.target(ctx, url);
  assert.equal(missing.run.id, run.id, 'a missing image can be repaired without rebuilding');
  assert.ok(await thumbs.save(ctx, missing, bytes));
  await ctx.libraryDb.query("update sandbox_runs set status = 'stopped' where id = $1", [run.id]);
  assert.ok(await thumbs.read(ctx, row.id), 'stopping a sandbox does not remove its thumbnail');
});

test('a later run replaces the image; stale runs, cancelled captures and losing concurrent writers cannot overwrite it', async () => {
  const { row, url } = await repo();
  const oldTarget = await thumbs.target(ctx, url);
  const first = await thumbs.save(ctx, oldTarget, bytes);
  const run = await nextRun(row.id), newer = await thumbs.target(ctx, run.preview_url);
  assert.equal(await thumbs.save(ctx, oldTarget, bytes), null);
  assert.equal(await thumbs.save(ctx, newer, bytes, () => false), null);
  assert.equal((await ctx.libraryDb.get(row.id)).thumbnail_path, first.thumbnail_path);
  const results = await Promise.all([thumbs.save(ctx, newer, bytes), thumbs.save(ctx, newer, bytes)]);
  assert.equal(results.filter(Boolean).length, 1);
  const current = await ctx.libraryDb.get(row.id);
  assert.notEqual(current.thumbnail_path, first.thumbnail_path);
  assert.equal(current.thumbnail_run_id, run.id);
  assert.equal((await files(row.id)).length, 1, 'only the published replacement remains');
  await assert.rejects(() => fs.access(path.join(ctx.dataRoot, first.thumbnail_path)));
});

test('failed saves retain the last successful thumbnail and clean up only unpublished generated files', async () => {
  const { row, url } = await repo();
  const first = await thumbs.save(ctx, await thumbs.target(ctx, url), bytes);
  const run = await nextRun(row.id), candidate = await thumbs.target(ctx, run.preview_url);
  const failing = { ...ctx, libraryDb: { query: async () => { throw new Error('disk/database unavailable'); } } };
  await assert.rejects(() => thumbs.save(failing, candidate, bytes), /unavailable/);
  assert.equal((await ctx.libraryDb.get(row.id)).thumbnail_path, first.thumbnail_path);
  assert.equal((await files(row.id)).length, 1);
  await fs.unlink(path.join(ctx.dataRoot, first.thumbnail_path));
  assert.equal(await thumbs.read(ctx, row.id), null);
  assert.ok(await thumbs.target(ctx, run.preview_url), 'missing images can be captured on another visit');
});

test('image reads are bounded and cannot escape the generated thumbnail directory', async () => {
  const { row, url } = await repo();
  const candidate = await thumbs.target(ctx, url);
  await assert.rejects(() => thumbs.read(ctx, '../outside'), TypeError);
  await assert.rejects(() => thumbs.save(ctx, candidate, Buffer.alloc(thumbs.MAX_BYTES + 1)), TypeError);
  await assert.rejects(() => thumbs.save(ctx, candidate, Buffer.from('not jpeg')), TypeError);
  const secret = path.join(ctx.dataRoot, 'secret.jpg'); await fs.writeFile(secret, bytes);
  for (const value of [secret, '../secret.jpg', 'assets/repo-thumbnails/../../secret.jpg']) {
    await ctx.libraryDb.query('update library set thumbnail_path = $2 where id = $1', [row.id, value]);
    assert.equal(await thumbs.read(ctx, row.id), null);
  }
  await ctx.libraryDb.query('update library set thumbnail_path = null where id = $1', [row.id]);
  const saved = await thumbs.save(ctx, candidate, bytes), file = path.join(ctx.dataRoot, saved.thumbnail_path);
  await fs.unlink(file); await fs.symlink(secret, file);
  assert.equal(await thumbs.read(ctx, row.id), null, 'symlink escape cannot expose arbitrary image files');
});

test('capture service serializes each repo, skips unknown sites, and discards captures after a data-root switch', async () => {
  const { row, url } = await repo();
  let changed = 0, count = 0, currentContext = ctx, release;
  const service = thumbs.createRepoThumbnails({ getContext: async () => currentContext, onChange: () => changed++ });
  assert.equal(await service.capture('https://example.com/', () => { throw Error('not called'); }, () => true), false);
  const taking = service.capture(url, () => { count++; return new Promise(resolve => { release = resolve; }); }, () => true);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await service.capture(url, () => { count++; return bytes; }, () => true), false);
  currentContext = { ...ctx, dataRoot: ctx.dataRoot + '-other' };
  release(bytes); assert.equal(await taking, false);
  assert.equal((await ctx.libraryDb.get(row.id)).thumbnail_path, null);
  assert.equal(changed, 0); assert.equal(count, 1);
  currentContext = ctx;
  assert.equal(await service.capture(url, async () => bytes, () => true), true);
  assert.equal(changed, 1);
  assert.equal(await service.capture(url, () => { throw Error('already saved'); }, () => true), false);
});
