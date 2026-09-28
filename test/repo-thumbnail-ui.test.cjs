'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/repo-thumbnail.js')).href);
const row = { id: 'repo', thumbnail_path: 'assets/repo-thumbnails/first.jpg' };

test('thumbnail cache shares pending reads and serves repeat hovers immediately', async () => {
  const { createRepoThumbnailCache } = await load();
  let reads = 0, finish;
  const cache = createRepoThumbnailCache(id => {
    assert.equal(id, row.id); reads++;
    return new Promise(resolve => { finish = resolve; });
  });
  const first = cache.load(row), second = cache.load(row);
  assert.equal(first, second);
  assert.equal(cache.peek(row), null);
  await Promise.resolve();
  finish('decoded-image');
  assert.equal(await first, 'decoded-image');
  assert.equal(cache.peek(row), 'decoded-image');
  assert.equal(await cache.load(row), 'decoded-image');
  assert.equal(reads, 1);
});

test('new thumbnail paths invalidate old versions even when the old read finishes last', async () => {
  const { createRepoThumbnailCache } = await load();
  const pending = [];
  const cache = createRepoThumbnailCache(() => new Promise(resolve => pending.push(resolve)));
  const first = cache.load(row);
  await Promise.resolve();
  const updated = { ...row, thumbnail_path: 'assets/repo-thumbnails/new-run.jpg' };
  const second = cache.load(updated);
  await Promise.resolve();
  pending[1]('new-image'); await second;
  pending[0]('old-image'); await first;
  assert.equal(cache.peek(updated), 'new-image');
  assert.equal(cache.peek(row), null);
});

test('missing, failed, and explicitly invalidated images retry without an empty card', async () => {
  const { createRepoThumbnailCache } = await load();
  let reads = 0;
  const cache = createRepoThumbnailCache(() => {
    reads++;
    if (reads === 1) throw Error('unavailable');
    return reads === 2 ? null : 'image';
  });
  assert.equal(await cache.load({ id: 'no-thumbnail' }), null);
  assert.equal(reads, 0);
  assert.equal(await cache.load(row), null);
  assert.equal(await cache.load(row), null);
  assert.equal(await cache.load(row), 'image');
  cache.forget(row);
  assert.equal(cache.peek(row), null);
  assert.equal(await cache.load(row), 'image');
  assert.equal(reads, 4);
});

test('thumbnail cache is bounded, retains recently used images, and is sidebar-local', async () => {
  const { createRepoThumbnailCache } = await load();
  const cache = createRepoThumbnailCache(id => id, 2);
  const second = { ...row, id: 'second' }, third = { ...row, id: 'third' };
  await cache.load(row); await cache.load(second);
  cache.peek(row);
  await cache.load(third);
  assert.equal(cache.peek(row), row.id);
  assert.equal(cache.peek(second), null);
  assert.equal(cache.peek(third), third.id);
  assert.equal(createRepoThumbnailCache(() => 'different data root').peek(row), null);
});

test('repo preview has a fixed frame aligned with the row and sidebar edge', async () => {
  const { placeRepoThumbnail } = await load();
  const rect = { right: 288, top: 360 };
  assert.deepEqual(placeRepoThumbnail(rect, 300, { width: 1450, height: 900 }),
    { left: 300, top: 360, width: 320, height: 210 });
  assert.deepEqual(placeRepoThumbnail({ ...rect, right: 348 }, 360, { width: 1450, height: 900 }),
    { left: 360, top: 360, width: 320, height: 210 }, 'sidebar resize keeps the same gap and frame');
});

test('repo preview stays inside viewport edges, including small windows', async () => {
  const { placeRepoThumbnail } = await load();
  const at = placeRepoThumbnail({ right: 400, top: 680 }, 410, { width: 700, height: 800 });
  assert.deepEqual(at, { left: 364, top: 582, width: 320, height: 210 });
  const small = placeRepoThumbnail({ right: 280, top: -12 }, 300, { width: 300, height: 180 });
  assert.deepEqual(small, { left: 8, top: 8, width: 276, height: 164 });
  assert.equal(small.left + 8 + small.width, 292);
  assert.equal(small.top + small.height, 172);
});
