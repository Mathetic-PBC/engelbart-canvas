'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { pageAddress, routeUrl } = require('../../shared/interface-annotations.cjs');

// Serialize automatic additions shared by annotation and recording writers.
const queues = new WeakMap();
function serial(db, work) {
  const next = (queues.get(db) || Promise.resolve()).catch(() => {}).then(work);
  queues.set(db, next);
  return next;
}
async function rememberPreview(db, run) {
  if (!run?.preview_url) return;
  const { site } = pageAddress(run.preview_url);
  await db.query("insert into captured_sites(site,library_id,kind) values($1,$2,'repo') on conflict(site) do update set library_id = excluded.library_id, kind = excluded.kind", [site, run.library_id]);
}

async function resolve(ctx, input, { ensure = false, libraryId = null, runId = null, kind = null, title = '' } = {}) {
  return serial(ctx.libraryDb, async () => {
    const db = ctx.libraryDb, page = pageAddress(input);
    const runs = await db.query('select id, library_id, status, preview_url from sandbox_runs order by created_at desc, id desc');
    const [saved] = await db.query('select library_id, kind from captured_sites where site = $1', [page.site]);
    // Recorded provenance wins over an address that may since have been reused.
    let row = libraryId ? await db.get(libraryId) : null;
    const run = runs.find(r => runId && r.id === runId) || runs.find(r => {
      try { return pageAddress(r.preview_url).site === page.site; } catch { return false; }
    });
    if (!row && run) row = await db.get(run.library_id);
    if (!row) {
      if (saved) row = await db.get(saved.library_id);
    }
    if (!row) {
      const candidates = (await db.list()).filter(r => r.type === 'website' || r.type === 'html' || r.tags?.includes('git'));
      const matches = r => { try { return pageAddress(r.url || pathToFileURL(r.path).href); } catch { return null; } };
      row = candidates.find(r => matches(r)?.url === page.url) || candidates.find(r => !r.tags?.includes('git') && matches(r)?.site === page.site);
    }
    if (!row && ensure) {
      const file = page.url.startsWith('file:') ? fileURLToPath(page.url) : null;
      const name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || (file ? path.basename(file) : new URL(page.url).host);
      row = await db.insert({ id: randomUUID(), name, type: file ? 'html' : 'website', url: page.url, path: file, tags: [] });
    }
    // A GitHub webpage may itself be annotated. Its catalog tags do not turn
    // that capture into a sandbox preview; only captured provenance does.
    const repo = kind ? kind === 'repo' : !!row && (run?.library_id === row.id || (saved?.library_id === row.id && saved.kind === 'repo'));
    if (row) await db.query('insert into captured_sites(site,library_id,kind) values($1,$2,$3) on conflict(site) do update set library_id = excluded.library_id, kind = excluded.kind', [page.site, row.id, repo ? 'repo' : 'site']);
    const latest = repo ? runs.find(r => r.library_id === row.id) : null;
    const sourceUrl = repo ? (latest?.status === 'ready' && latest.preview_url ? routeUrl(page.route, latest.preview_url) : null) : page.url;
    return { page, kind: repo ? 'repo' : 'site', scope: repo ? `repo:${row.id}` : `site:${page.site}`, libraryId: row?.id || null,
      runId: runId || run?.id || null, sourceName: row?.name || page.site, sourceUrl };
  });
}

module.exports = { resolve, rememberPreview };
