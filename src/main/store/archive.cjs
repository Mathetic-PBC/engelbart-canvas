'use strict';

// A workspace's earlier versions (2026-09-25; design docs/superpowers/specs/2026-09-25-build-workflow-design.md B21-B22).
// Clear saves the document as it stands to <Workspace>/.archive/<UTC time>.md and starts it blank, keeping only the
// lines the caller keeps (a Build still open keeps its `build>` line: its conversation lives in its record, not here).
// Beside each archived document, <time>.json holds what the workspace had then — its context, what it had thrown away,
// the library items and workspaces the document @mentioned, its Builds — as ids: no note's text is copied ("just the
// fact that they were @mentioned"). Everything the document mentioned is linked to the workspace at Clear, so the
// sidebar shows after Clear what it showed before. Restore archives the current document first, so nothing is ever
// overwritten. The folder starts with a dot, so no listing takes it for a workspace and no edit time counts it.
// A post-it added to a workspace (2026-09-27) is put in as one more archived version, the current document untouched.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('./projects.cjs');
const { INLINE } = require('../context/expand-mentions.cjs');

const ARCHIVE_DIR = '.archive';
const IMPORTED = 'Imported from Task:';
const BUILD_ID_RE = /^[0-9a-f]{10}$/;
const IMAGE_TOKEN = /^!\[[^\]\n]*\]\(img:([\w-]+)\)$/;
const WS_TOKEN = /^@\[[^\]\n]+\]\(ws:([\w-]+)\)$/;

const pad = (n) => String(n).padStart(2, '0');
/** 2026-09-25T21-03-12Z: a moment, sortable, legal in a file name. */
function stampOf(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}Z`;
}

/** What a version is called in the sidebar: its first line with words in it, without its markdown. */
function titleOf(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*(#{1,3} |- \[[ xX]?\] |[-*] |> )/, '').replace(/@\[([^\]\n]+)\](\(ws:[\w-]+\))?/g, '$1').replace(/!\[[^\]\n]*\]\([^)]*\)/g, '').replace(/[*`]/g, '').trim();
    if (line && !/^(bart[~+?]?>|build>)/.test(raw.trim())) return line.slice(0, 120);
  }
  return 'Untitled';
}

/** The library rows and workspaces a document mentions, by the rule Copy uses: this project's row first for a shared name. → { ids, workspaces } */
async function mentionsIn(ctx, projectId, text) {
  const rows = await ctx.libraryDb.list();
  const byName = new Map();
  for (const row of rows) {
    if (row.type === 'image') continue;
    const key = row.name.toLowerCase();
    const held = byName.get(key);
    if (!held || (held.project_id !== projectId && row.project_id === projectId)) byName.set(key, row);
  }
  const images = new Set(rows.filter((row) => row.type === 'image').map((row) => row.id));
  const ids = [];
  const workspaces = [];
  const add = (list, id) => { if (!list.includes(id)) list.push(id); };
  for (const token of String(text || '').split(INLINE)) {
    if (!token) continue;
    const image = token.match(IMAGE_TOKEN);
    if (image) { if (images.has(image[1])) add(ids, image[1]); continue; }
    const ws = token.match(WS_TOKEN);
    if (ws) { add(workspaces, ws[1]); continue; }
    if (!token.startsWith('@[') || !token.endsWith(']')) continue;
    const row = byName.get(token.slice(2, -1).toLowerCase());
    if (row) add(ids, row.id);
  }
  return { ids, workspaces };
}

const archiveDir = (workspace) => path.join(workspace.dir, ARCHIVE_DIR);

function freeStamp(dir, date) {
  const base = stampOf(date);
  let stamp = base;
  for (let n = 2; fs.existsSync(path.join(dir, `${stamp}.md`)); n += 1) stamp = `${base}-${n}`;
  return stamp;
}

/**
 * Clear (B21). `keep(line)` names the lines the blank document keeps. A document with nothing else in it is not archived.
 * → { text: the document now, archive: { file, clearedAt, title } | null, linked: [ids linked so the sidebar keeps them] }
 */
async function clearWorkspace(ctx, projectId, workspaceId, { keep = () => false, now = () => new Date() } = {}) {
  const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
  const file = path.join(workspace.dir, 'workspace.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  const lines = text.split('\n');
  const kept = lines.filter((line) => keep(line));
  if (lines.every((line) => keep(line) || !line.trim())) return { text, archive: null, linked: [] };
  const mentions = await mentionsIn(ctx, projectId, text);
  const dir = archiveDir(workspace);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = now();
  const stamp = freeStamp(dir, at);
  const entry = { file: stamp, clearedAt: at.toISOString(), title: titleOf(text) };
  projects.writeTextAtomic(path.join(dir, `${stamp}.md`), text);
  projects.writeTextAtomic(path.join(dir, `${stamp}.json`), `${JSON.stringify({ ...entry, context: workspace.context, removed: workspace.removed, mentions: mentions.ids, workspaces: mentions.workspaces, builds: workspace.builds }, null, 2)}\n`);
  // What the document mentioned stays on the sidebar: linked, unless it had been thrown away (it was not showing then either).
  const linked = mentions.ids.filter((id) => !workspace.context.includes(id) && !workspace.removed.includes(id));
  const next = kept.length ? `${kept.join('\n')}\n` : '';
  projects.writeTextAtomic(file, next);
  projects.patchWorkspace(ctx, projectId, workspaceId, { context: [...workspace.context, ...linked], archives: [...workspace.archives, entry].slice(-500), chars: next.length });
  return { text: next, archive: entry, linked };
}

/**
 * A post-it added to a workspace (2026-09-27: "it should not clear the current workspace … it is treated as if it is an
 * old version of the workspace it was added to"). Its text becomes an archived version headed "Imported from Task:",
 * with the Build's line under it as any archived version has, so the Build shows in the workspace's history. The
 * document, its links and its edit time are left as they are. → { file, clearedAt, title }
 */
async function importTask(ctx, projectId, workspaceId, { text, buildId, now = () => new Date() }) {
  if (typeof buildId !== 'string' || !BUILD_ID_RE.test(buildId)) throw new TypeError('build id is invalid');
  const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
  const body = String(text || '').trim();
  const doc = `${IMPORTED}\n${body}\n\nbuild> ${buildId}\n`;
  const mentions = await mentionsIn(ctx, projectId, body);
  const dir = archiveDir(workspace);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = now();
  const stamp = freeStamp(dir, at);
  const entry = { file: stamp, clearedAt: at.toISOString(), title: `${IMPORTED} ${titleOf(body)}`.slice(0, 120) };
  projects.writeTextAtomic(path.join(dir, `${stamp}.md`), doc);
  projects.writeTextAtomic(path.join(dir, `${stamp}.json`), `${JSON.stringify({ ...entry, imported: { buildId }, context: workspace.context, removed: workspace.removed, mentions: mentions.ids, workspaces: mentions.workspaces, builds: [buildId] }, null, 2)}\n`);
  projects.patchWorkspace(ctx, projectId, workspaceId, { archives: [...workspace.archives, entry].slice(-500) });
  return entry;
}

function archiveFile(ctx, projectId, workspaceId, stamp, ext) {
  if (typeof stamp !== 'string' || !projects.ARCHIVE_RE.test(stamp)) throw new TypeError('archive is invalid');
  const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
  return { workspace, file: path.join(archiveDir(workspace), `${stamp}${ext}`) };
}

/** One archived version: where it is, its text (opened read-only in the middle), and what the workspace had then. */
function readArchive(ctx, projectId, workspaceId, stamp) {
  const { file } = archiveFile(ctx, projectId, workspaceId, stamp, '.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error('That version is gone'); }
  let held = null;
  try { held = JSON.parse(fs.readFileSync(file.replace(/\.md$/, '.json'), 'utf8')); } catch { held = null; }
  return { path: file, text, held };
}

/** The newest archived version, for a Build's <history> (B6): its text and file, or null when there is none. */
function latestArchive(ctx, projectId, workspaceId) {
  const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
  for (const entry of [...workspace.archives].reverse()) {
    try { return { ...entry, ...readArchive(ctx, projectId, workspaceId, entry.file) }; } catch { /* a file removed by hand: the one before */ }
  }
  return null;
}

/**
 * Restore (B22): the current document is archived (as Clear does, the kept lines staying), then the chosen version becomes
 * the document again, with the kept lines after it, and what it mentioned is linked again. → { text, archive }
 */
async function restoreArchive(ctx, projectId, workspaceId, stamp, { keep = () => false, now = () => new Date() } = {}) {
  const chosen = readArchive(ctx, projectId, workspaceId, stamp);
  const cleared = await clearWorkspace(ctx, projectId, workspaceId, { keep, now });
  const carried = cleared.text.split('\n').filter((line) => line && !chosen.text.split('\n').includes(line));
  const next = carried.length ? `${chosen.text.replace(/\n*$/, '\n')}${carried.join('\n')}\n` : chosen.text;
  const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
  projects.writeTextAtomic(path.join(workspace.dir, 'workspace.md'), next);
  const back = [...((chosen.held && chosen.held.context) || []), ...((chosen.held && chosen.held.mentions) || [])].filter((id) => typeof id === 'string' && !workspace.context.includes(id) && !workspace.removed.includes(id));
  projects.patchWorkspace(ctx, projectId, workspaceId, { context: [...workspace.context, ...new Set(back)], chars: next.length });
  return { text: next, archive: cleared.archive };
}

module.exports = { ARCHIVE_DIR, IMPORTED, stampOf, titleOf, mentionsIn, clearWorkspace, importTask, readArchive, latestArchive, restoreArchive };
