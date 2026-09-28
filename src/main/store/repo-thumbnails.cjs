'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { githubRepo } = require('../sandbox/runs.cjs');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID = new RegExp(`^${UUID}$`, 'i');
const OWNED = new RegExp(`^assets/repo-thumbnails/(${UUID})-(${UUID})-(${UUID})\\.jpg$`, 'i');
const MAX_BYTES = 512 * 1024;
function origin(value) {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.origin : null; }
  catch { return null; }
}
function fileFor(ctx, relative, libraryId) {
  const match = typeof relative === 'string' && OWNED.exec(relative);
  return match && match[1] === libraryId ? path.join(ctx.dataRoot, relative) : null;
}
const jpeg = bytes => bytes?.length >= 4 && bytes.length <= MAX_BYTES && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;

// Resolve by the real preview origin, never by a title, GitHub page, or arbitrary
// renderer-supplied repository id. Only the latest ready run may replace a photo.
async function target(ctx, url) {
  const site = origin(url);
  if (!site) return null;
  const runs = await ctx.libraryDb.query('select distinct on (library_id) id, library_id, status, preview_url from sandbox_runs order by library_id, created_at desc, id desc');
  const run = runs.find(r => r.status === 'ready' && origin(r.preview_url) === site);
  if (!run) return null;
  const row = await ctx.libraryDb.get(run.library_id);
  if (!githubRepo(row?.url)) return null;
  if (row.thumbnail_run_id === run.id && await read(ctx, row.id)) return null;
  return { run, row };
}

async function read(ctx, libraryId) {
  if (typeof libraryId !== 'string' || !ID.test(libraryId)) throw new TypeError('Invalid library id');
  const row = await ctx.libraryDb.get(libraryId);
  const file = row && fileFor(ctx, row.thumbnail_path, libraryId);
  if (!file) return null;
  try {
    const actual = await fs.realpath(file), root = await fs.realpath(ctx.dataRoot);
    if (!actual.startsWith(path.join(root, 'assets', 'repo-thumbnails') + path.sep)) return null;
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const bytes = await fs.readFile(actual);
    return jpeg(bytes) ? `data:image/jpeg;base64,${bytes.toString('base64')}` : null;
  } catch { return null; }
}

async function save(ctx, { run, row }, bytes, isCurrent = () => true) {
  if (!ID.test(row.id) || !ID.test(run.id) || run.library_id !== row.id || !jpeg(bytes)) throw new TypeError('Invalid repo thumbnail');
  const relative = `assets/repo-thumbnails/${row.id}-${run.id}-${randomUUID()}.jpg`;
  const file = fileFor(ctx, relative, row.id), temporary = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let saved = false;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    if (!isCurrent()) return null;
    const [updated] = await ctx.libraryDb.query(`update library set thumbnail_path = $2,
      thumbnail_run_id = $3, thumbnail_captured_at = now()
      where id = $1 and thumbnail_path is not distinct from $4
      and exists (select 1 from sandbox_runs r where r.id = $3 and r.library_id = $1
        and r.status = 'ready' and r.preview_url = $5 and r.id = (
          select id from sandbox_runs where library_id = $1 order by created_at desc, id desc limit 1))
      returning *`, [row.id, relative, run.id, row.thumbnail_path, run.preview_url]);
    if (!updated) return null;
    saved = true;
    // Delete only this feature's superseded image, after its replacement is durable.
    const old = fileFor(ctx, row.thumbnail_path, row.id);
    if (old) await fs.unlink(old).catch(() => {});
    return updated;
  } finally {
    await fs.unlink(temporary).catch(() => {});
    if (!saved) await fs.unlink(file).catch(() => {});
  }
}

function createRepoThumbnails({ getContext, onChange = () => {} }) {
  const busy = new Set();
  return {
    read: async id => read(await getContext(), id),
    async capture(url, takePicture, isCurrent) {
      const ctx = await getContext(), found = await target(ctx, url);
      if (!found || !isCurrent()) return false;
      const key = `${ctx.dataRoot}:${found.row.id}`;
      if (busy.has(key)) return false;
      busy.add(key);
      try {
        const bytes = await takePicture();
        if (!bytes || !isCurrent() || (await getContext()).dataRoot !== ctx.dataRoot) return false;
        const row = await save(ctx, found, bytes, isCurrent);
        if (row) onChange();
        return !!row;
      } finally { busy.delete(key); }
    },
  };
}

module.exports = { target, read, save, createRepoThumbnails, MAX_BYTES };
