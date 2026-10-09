'use strict';

// A project is a directory of workspaces, nested to any depth. Notes are flat markdown files in
// the project directory, indexed by the project's notes table and mirrored in the root library;
// pasted images live in <project>/assets and are library rows of type `image`.
// `ctx.dataRoot` is ~/.engelbart (test off) or ~/.engelbart/test (test on).
//
//   <dataRoot>/<slug>/project.json                   { id, name, created, directory }
//   <dataRoot>/<slug>/notes.pglite/
//   <dataRoot>/<slug>/<Note>.md
//   <dataRoot>/<slug>/assets/<id>.<ext>
//   <dataRoot>/<slug>/<Workspace>/meta.json          { id, status, context, created, chars, builds, archives }
//   <dataRoot>/<slug>/<Workspace>/workspace.md
//   <dataRoot>/<slug>/<Workspace>/.archive/<t>.md    the document as it was when Clear was pressed (./archive.cjs)
//   <dataRoot>/<slug>/<Workspace>/<Child>/…          the same, recursively
//   <dataRoot>/<slug>/.trash/<Workspace>/…           a deleted workspace, restorable for a week (trashWorkspace)
//   <dataRoot>/<slug>/builds/<id>/                   a Build's record (../build/store.cjs)
//   <dataRoot>/.trash/<slug>/…                       a deleted project, restorable for a week (trashProject)
//
// `directory` is where the project's code lives: terminals and agents start there.
// A workspace's `context` is a flat list of library ids. Grouping is done by nesting a workspace.
// `chars` is the length of workspace.md, the workspace's counterpart of a note's library.char_count.
// The earlier layout (<slug>/<Goal>/<Topic>/…) is converted on first touch: see ./migrate.cjs.

const fs = require('node:fs');
const path = require('node:path');
const stageFiles = require('../stage/files.cjs');
const { randomUUID } = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { sanitizeName, slugify, uniqueName, readJson, writeJson, DIR_MODE } = require('./home.cjs');
const db = require('./db.cjs');
const { migrateProjectDir } = require('./migrate.cjs');
const buildStore = require('../build/store.cjs');
const { addressKey } = require('../../shared/address-key.cjs');

// A workspace's meta.json `status` is no longer shown or changed (2026-09-25: the todo / in progress / done marks were
// deleted). It stays on disk only as the mark that a folder is a workspace and not an older layout's goal (migrate.cjs).
const STATUSES = Object.freeze(['open', 'progress', 'done']);
const RESERVED = new Set(['annotations', 'seed', 'test']);
// A project's own folders, never workspaces: pasted images, and Build records (2026-09-25).
const PROJECT_RESERVED = new Set(['assets', 'builds']);
// Folders of the data root that are not projects: Build's worktrees (<dataRoot>/worktrees/<slug>/<id>).
const ROOT_RESERVED = new Set([...RESERVED, 'worktrees']);
const BUILD_ID_RE = /^[a-z0-9]{6,32}$/;
const ARCHIVE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d{1,3})?$/;
const IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' });
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TREE_ENTRIES = 500;
const MAX_TREE_DEPTH = 6;
const MAX_DESCRIPTION = 4000;

const WELCOME_NOTE = [
  'This is a note. Notes are plain markdown files in your project folder, and the sidebar lists what this workspace can see.',
  '',
  '- [ ] Type @Task or "- []" for a task, then press Build',
  '- [ ] Type @ to mention a paper, folder or note from your library',
  '- [ ] Type @bart, a question, and press Enter',
  '- A bare dash is a bullet; Tab and Shift-Tab nest it',
  '',
  'The Workspace tab is this workspace\'s own document. Add papers, folders and notes from the sidebar with + Context and + Folder, and nest a workspace inside this one with + Workspace. Paste an image anywhere.',
  '',
].join('\n');

const nowIso = () => new Date().toISOString();
const byCreated = (a, b) => String(a.created || '').localeCompare(String(b.created || ''));

function assertId(value, what) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new TypeError(`${what} id is invalid`);
  return value;
}

function subdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.endsWith('.pglite') && !RESERVED.has(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function writeTextAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// When a project was last written in. A Build writing its record (`builds/`) is not the person writing.
function latestMtime(dir, depth = 3) {
  let latest = 0;
  const walk = (current, level) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.endsWith('.pglite') || entry.name.startsWith('.') || (level === 0 && entry.name === 'builds')) continue;
      const full = path.join(current, entry.name);
      try {
        latest = Math.max(latest, fs.statSync(full).mtimeMs);
      } catch {
        continue;
      }
      if (entry.isDirectory() && level < depth) walk(full, level + 1);
    }
  };
  walk(dir, 0);
  return latest ? new Date(latest).toISOString() : null;
}

/* ------------------------------------------------------------ context tree */

function validateTree(entries, depth = 0, counter = { n: 0, seen: new Set() }) {
  if (!Array.isArray(entries)) throw new TypeError('context must be an array');
  if (depth > MAX_TREE_DEPTH) throw new TypeError('context folders are nested too deep');
  const out = [];
  const seen = counter.seen;
  for (const entry of entries) {
    counter.n += 1;
    if (counter.n > MAX_TREE_ENTRIES) throw new TypeError('context has too many entries');
    if (typeof entry === 'string') {
      assertId(entry, 'library item');
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = assertId(entry.id, 'folder');
      if (seen.has(id)) continue;
      seen.add(id);
      const name = typeof entry.name === 'string' ? entry.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) : '';
      out.push({ id, name: name || 'New folder', children: validateTree(entry.children || [], depth + 1, counter) });
    } else {
      throw new TypeError('context entry must be an id or a folder');
    }
  }
  return out;
}

// A context is a flat list of library ids. Folders existed once; anything that still sends or
// holds one is flattened to what the folder contained, in order.
function flatContext(entries) {
  return [...new Set(treeIds(validateTree(entries)))];
}

function treeIds(entries, out = []) {
  for (const entry of entries || []) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry === 'object') treeIds(entry.children, out);
  }
  return out;
}

function treeContains(entries, id) {
  return treeIds(entries).includes(id);
}

/* ------------------------------------------------------------------ projects */

const migrated = new Set();
/** A default repo as project.json keeps it: { kind: 'project' } (the code directory) or { kind: 'library', id }; else null. */
const targetOrNull = (value) => {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'project') return { kind: 'project' };
  if (value.kind === 'library' && typeof value.id === 'string' && UUID_RE.test(value.id)) return { kind: 'library', id: value.id };
  return null;
};

function projectRecord(dir) {
  const meta = readJson(path.join(dir, 'project.json'));
  if (!meta || typeof meta.id !== 'string') return null;
  if (!migrated.has(dir)) {
    migrated.add(dir);
    try { migrateProjectDir(dir); } catch (error) { console.error(`Engelbart: could not convert ${dir} to the workspace layout: ${error.message}`); }
  }
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name : path.basename(dir);
  const saved = typeof meta.directory === 'string' && path.isAbsolute(meta.directory) ? meta.directory : null;
  let exists = false;
  try { exists = !!saved && fs.statSync(saved).isDirectory(); } catch { exists = false; }
  // A saved directory that is gone (moved, unmounted) counts as not chosen: the project asks again.
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  // Where the Builds' default repo is (build/manager.cjs, 2026-09-29): the code directory, or a library row.
  const defaultTarget = targetOrNull(meta.defaultTarget);
  // Before defaultTarget: the folder the default repo was made as, in `directory`; read once, to convert it (build/manager.cjs).
  const defaultRepo = typeof meta.defaultRepo === 'string' && /^[^/\\\0]{1,255}$/.test(meta.defaultRepo) && !['.', '..'].includes(meta.defaultRepo) ? meta.defaultRepo : null;
  return { id: meta.id, name, slug: path.basename(dir), dir, created: meta.created || null, directory: exists ? saved : null, directoryMissing: saved && !exists ? saved : null, description, defaultTarget, defaultRepo };
}

function projectRecords(ctx) {
  return subdirs(ctx.dataRoot).map(projectRecord).filter(Boolean);
}

function findProject(ctx, id) {
  assertId(id, 'project');
  const project = projectRecords(ctx).find((candidate) => candidate.id === id);
  if (!project) throw new Error('Unknown project');
  return project;
}

function publicProject(project, extra = {}) {
  return { id: project.id, name: project.name, slug: project.slug, dir: project.dir, created: project.created, directory: project.directory, directoryMissing: project.directoryMissing, description: project.description || '', ...extra };
}

const countWorkspaces = (dir) => workspaceRecords(dir).reduce((n, workspace) => n + 1 + countWorkspaces(workspace.dir), 0);
const summary = (project) => ({ workspaceCount: countWorkspaces(project.dir), lastEdited: latestMtime(project.dir) || project.created });

const RECENT_WORKSPACES = 4;
const RECENT_TEXT_CHARS = 4000;

/** The workspaces whose document changed last, newest first, each with the start of its text. */
function recentWorkspaces(projectDir, workspaces, limit = RECENT_WORKSPACES) {
  return workspaces
    .map((workspace) => {
      const file = path.join(projectDir, workspace.path, 'workspace.md');
      let edited = 0;
      try { edited = fs.statSync(file).mtimeMs; } catch { edited = 0; }
      return { workspace, file, edited };
    })
    .sort((a, b) => b.edited - a.edited)
    .slice(0, limit)
    .map(({ workspace, file, edited }) => {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8').slice(0, RECENT_TEXT_CHARS); } catch { text = ''; }
      return { id: workspace.id, name: workspace.name, path: workspace.path, chars: workspace.chars, edited: edited ? new Date(edited).toISOString() : null, text };
    });
}

// Each project with what the all-projects screen draws on its card: the workspaces touched last
// and the ids of the library rows it holds.
async function listProjects(ctx) {
  const rows = await ctx.libraryDb.list();
  return projectRecords(ctx)
    .map((project) => {
      const workspaces = flattenWorkspaces(project.dir);
      const refs = referencedBy(workspaces);
      return publicProject(project, {
        workspaceCount: workspaces.length,
        lastEdited: latestMtime(project.dir) || project.created,
        recent: recentWorkspaces(project.dir, workspaces),
        libraryIds: rows.filter((row) => holds(project, refs, row)).map((row) => row.id),
      });
    })
    .sort((a, b) => String(b.lastEdited || '').localeCompare(String(a.lastEdited || '')));
}

// `path` is the directory name under the data root, as the create screen shows it after "./".
function resolveSlug(ctx, name, requested) {
  const raw = typeof requested === 'string' && requested.trim() ? requested : name;
  return freeSlug(ctx, raw);
}

// A project called "test", "seed" or "annotations" would take a directory name the data root keeps
// for itself, and then never be listed.
function freeSlug(ctx, raw) {
  const slug = slugify(raw) || 'engelbart';
  return uniqueName(ctx.dataRoot, ROOT_RESERVED.has(slug) ? `${slug}-project` : slug);
}

// The project's code directory: absolute, existing, a directory.
function checkDirectory(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) throw new TypeError('directory must be an absolute path');
  const resolved = path.resolve(value);
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new TypeError('directory does not exist'); }
  if (!stat.isDirectory()) throw new TypeError('directory must be a directory');
  return resolved;
}

async function createProject(ctx, input) {
  const options = typeof input === 'string' ? { name: input } : (input || {});
  const name = sanitizeName(options.name);
  const directory = options.directory == null ? null : checkDirectory(options.directory);
  const description = typeof options.description === 'string' ? options.description.trim().slice(0, MAX_DESCRIPTION) : '';
  const slug = resolveSlug(ctx, name, options.path);
  const dir = path.join(ctx.dataRoot, slug);
  fs.mkdirSync(dir, { mode: DIR_MODE });
  const meta = { id: randomUUID(), name, created: nowIso(), ...(directory ? { directory } : {}), ...(description ? { description } : {}) };
  writeJson(path.join(dir, 'project.json'), meta);
  migrated.add(dir);
  await db.openNotesDb(dir);
  return publicProject(projectRecord(dir), { workspaceCount: 0, lastEdited: meta.created });
}

// First-run flow: the project, a first workspace, and a "Welcome!" note open in its context. Onboarding
// (2026-09-28, ./onboarding.cjs) names the workspace "Getting started", starts its document with the project's
// description, and puts the library rows chosen on its last screen in context after the note.
async function createProjectWithWelcome(ctx, input, { workspaceName = 'Getting started', context = [] } = {}) {
  const project = await createProject(ctx, input);
  const workspace = await createWorkspace(ctx, project.id, { name: workspaceName });
  const note = await createNote(ctx, project.id, { name: 'Welcome!', workspaceId: workspace.id, text: WELCOME_NOTE });
  await setWorkspaceContext(ctx, project.id, workspace.id, [note.id, ...context.filter((id) => id !== note.id)]);
  if (project.description) await writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, `${project.description}\n`);
  return { project, workspaceId: workspace.id, noteId: note.id, noteName: note.name };
}

async function setProjectDirectory(ctx, id, directory) {
  const project = findProject(ctx, id);
  const resolved = checkDirectory(directory);
  const meta = readJson(path.join(project.dir, 'project.json')) || {};
  writeJson(path.join(project.dir, 'project.json'), { ...meta, directory: resolved });
  const next = projectRecord(project.dir);
  return publicProject(next, summary(next));
}

/** Where the project's Builds work by default: { kind: 'project' } or { kind: 'library', id } (build/manager.cjs checks it first). */
function setDefaultTarget(ctx, id, target) {
  const project = findProject(ctx, id);
  const value = targetOrNull(target);
  if (!value) throw new TypeError('the default repo must be the code directory or a library row');
  const meta = readJson(path.join(project.dir, 'project.json')) || {};
  if (JSON.stringify(targetOrNull(meta.defaultTarget)) !== JSON.stringify(value)) writeJson(path.join(project.dir, 'project.json'), { ...meta, defaultTarget: value });
  return value;
}

async function renameProject(ctx, id, name) {
  const project = findProject(ctx, id);
  const next = sanitizeName(name);
  if (next === project.name) return publicProject(project, summary(project));
  const meta = readJson(path.join(project.dir, 'project.json')) || {};
  writeJson(path.join(project.dir, 'project.json'), { ...meta, name: next });
  let dir = project.dir;
  // The directory follows the name only while it is still the name's own slug.
  if (project.slug === slugify(project.name)) {
    const slug = freeSlug(ctx, next);
    const target = path.join(ctx.dataRoot, slug);
    if (target !== dir) {
      await db.closeDb(path.join(dir, 'notes.pglite'));
      fs.renameSync(dir, target);
      migrated.add(target);
      await ctx.libraryDb.rewritePathPrefix(dir + path.sep, target + path.sep);
      dir = target;
    }
  }
  const renamed = projectRecord(dir);
  return publicProject(renamed, summary(renamed));
}

// Delete, on the all-projects screen (2026-10-03): the project's folder, everything in it (workspaces, notes, pasted
// images, Build records), goes into <dataRoot>/.trash, a dot folder no listing of projects sees. project.json `trashed`
// keeps when it went, the folder name it had (`slug`) and the one it has in the trash (`name`); the library rows of its
// notes and images follow it there. Home's "Recently deleted" lists it; Restore puts it back under its old folder name
// when that is free, else the next free one; a week after it went in it is purged, and with it its Builds' worktrees,
// its library rows and its views in state.json. Its code directory is never touched: it is not in the project's folder.
// `trashed` is written before the folder moves: a delete cut short is then a project still listed whose project.json has
// `trashed`, never a folder in the trash that nothing lists or purges. A project listed with `trashed` (a delete or a
// restore cut short) is finished as restored when the trash is next read.
const PROJECT_WORKTREES = 'worktrees';
const folderName = (value) => (typeof value === 'string' && /^[^/\\\0]{1,255}$/.test(value) && !value.startsWith('.') ? value : null);
const realOrResolved = (dir) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
const inside = (child, parent) => { const rel = path.relative(realOrResolved(parent), realOrResolved(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** `stopBuilds(id)`: its Builds stopped first (build/manager.cjs stopProject). → { id, name } */
async function trashProject(ctx, id, { stopBuilds = null } = {}) {
  const project = findProject(ctx, id);
  if (project.directory && inside(project.directory, project.dir)) throw new Error(`${project.name}'s code folder is inside its Engelbart folder, so deleting the project would take the code with it.`);
  if (stopBuilds) await stopBuilds(id);
  await db.closeDb(path.join(project.dir, 'notes.pglite'));
  const bin = path.join(ctx.dataRoot, TRASH_DIR);
  fs.mkdirSync(bin, { recursive: true, mode: DIR_MODE });
  const name = uniqueName(bin, project.slug);
  const into = path.join(bin, name);
  const file = path.join(project.dir, 'project.json');
  const meta = readJson(file) || {};
  writeJson(file, { ...meta, trashed: { at: nowIso(), slug: project.slug, name } });
  try {
    fs.renameSync(project.dir, into);
  } catch (error) {
    writeJson(file, meta);
    throw error;
  }
  migrated.delete(project.dir);
  await ctx.libraryDb.rewritePathPrefix(project.dir + path.sep, into + path.sep);
  return { id: project.id, name: project.name };
}

/** A project folder's trash record → { id, name, dir, at, slug, into } or null; `trashed` read from its project.json. */
function trashedEntry(dir) {
  const meta = readJson(path.join(dir, 'project.json'));
  const trashed = meta && typeof meta.id === 'string' && UUID_RE.test(meta.id) ? plainObject(meta.trashed) : null;
  const at = trashed && typeof trashed.at === 'string' ? Date.parse(trashed.at) : NaN;
  if (Number.isNaN(at)) return null;
  return { id: meta.id, name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : path.basename(dir), dir, at, slug: folderName(trashed.slug), into: folderName(trashed.name) };
}

const trashedProjectRecords = (ctx) => subdirs(path.join(ctx.dataRoot, TRASH_DIR)).map(trashedEntry).filter(Boolean);

/** Projects in the data root whose project.json still has `trashed`: a delete or a restore that was cut short. */
const cutShort = (ctx) => subdirs(ctx.dataRoot).map(trashedEntry).filter(Boolean);

/**
 * A project folder that is back where it belongs (`dir`): the rows of its notes and images that point into the trash
 * (or, after a delete cut short before they moved, at the folder it had) point at it again, then `trashed` goes. Every
 * step finds nothing to do the second time, so running it again after a crash repairs what the first run left.
 */
async function settleRestored(ctx, entry, dir) {
  const from = [entry.into && path.join(ctx.dataRoot, TRASH_DIR, entry.into), entry.slug && path.join(ctx.dataRoot, entry.slug)].filter((old) => old && old !== dir);
  for (const old of from) await ctx.libraryDb.rewritePathPrefix(old + path.sep, dir + path.sep, { projectId: entry.id });
  const file = path.join(dir, 'project.json');
  const { trashed, ...meta } = readJson(file) || {}; // eslint-disable-line no-unused-vars
  if (trashed !== undefined) writeJson(file, meta);
}

/**
 * The projects in the trash, newest first, each { id, name, deleted, expires, workspaceCount }. Those in it a week are
 * purged first (`removeWorktrees`: build/manager.cjs's), and a project whose delete or restore was cut short is
 * finished as restored.
 */
async function trashedProjects(ctx, now = Date.now(), { removeWorktrees = null } = {}) {
  for (const entry of cutShort(ctx)) await settleRestored(ctx, entry, entry.dir).catch((error) => console.error(`Engelbart: could not finish restoring ${entry.dir}: ${error.message}`));
  const out = [];
  for (const entry of trashedProjectRecords(ctx)) {
    if (entry.at < now - TRASH_DAYS * DAY) { await purgeProject(ctx, entry, { removeWorktrees }).catch((error) => console.error(`Engelbart: could not purge ${entry.dir}: ${error.message}`)); continue; }
    out.push({ id: entry.id, name: entry.name, deleted: new Date(entry.at).toISOString(), expires: new Date(entry.at + TRASH_DAYS * DAY).toISOString(), workspaceCount: countWorkspaces(entry.dir) });
  }
  return out.sort((a, b) => b.deleted.localeCompare(a.deleted));
}

/**
 * Gone for good: the worktrees of its Builds that were still open (and of accepted ones whose copy outlived a crash), the
 * library rows made in it, its views and places in state.json, then its folder. What fails is left; the folder goes last,
 * so a purge cut short runs again the next time the trash is read.
 */
async function purgeProject(ctx, entry, { removeWorktrees = null } = {}) {
  const open = buildStore.listTasks({ dir: entry.dir }).filter((task) => !buildStore.FINAL.has(task.status) || task.keptCopy);
  if (open.length && removeWorktrees) await Promise.resolve().then(() => removeWorktrees(open)).catch(() => {});
  for (const row of await ctx.libraryDb.list()) {
    if (row.project_id === entry.id) await ctx.libraryDb.remove(row.id).catch(() => false); // a row a sandbox run still names stays
  }
  forgetProject(ctx, entry.id);
  await db.closeDb(path.join(entry.dir, 'notes.pglite'));
  fs.rmSync(entry.dir, { recursive: true, force: true });
}

/**
 * Restore: the project back from the trash, under the folder name it had when that is free (else the next free one).
 * When the name changes, its open Builds' worktrees follow it to worktrees/<slug>/<id> (`moveWorktree(task, to)`); one
 * that cannot be moved is discarded (`removeWorktrees`, its copy and branch). → the project, as listProjects has it
 */
async function restoreProject(ctx, id, { moveWorktree = null, removeWorktrees = null } = {}) {
  assertId(id, 'project');
  const half = cutShort(ctx).find((candidate) => candidate.id === id);
  if (half) {
    await settleRestored(ctx, half, half.dir);
    const project = projectRecord(half.dir);
    return publicProject(project, summary(project));
  }
  const entry = trashedProjectRecords(ctx).find((candidate) => candidate.id === id);
  if (!entry) throw new Error('That project is no longer in the trash');
  const slug = entry.slug && !ROOT_RESERVED.has(entry.slug) && !fs.existsSync(path.join(ctx.dataRoot, entry.slug)) ? entry.slug : freeSlug(ctx, entry.slug || entry.name);
  const back = path.join(ctx.dataRoot, slug);
  if (slug !== entry.slug) await followSlug(ctx, entry, slug, { moveWorktree, removeWorktrees });
  fs.renameSync(entry.dir, back);
  migrated.add(back);
  await ctx.libraryDb.rewritePathPrefix(entry.dir + path.sep, back + path.sep);
  await settleRestored(ctx, entry, back);
  const project = projectRecord(back);
  return publicProject(project, summary(project));
}

/** A restored project's new folder name: each open Build's worktree moves to worktrees/<slug>/<id>, and its record says so. */
async function followSlug(ctx, entry, slug, { moveWorktree, removeWorktrees }) {
  const where = { dir: entry.dir };
  for (const task of buildStore.listTasks(where)) {
    if (buildStore.FINAL.has(task.status) || typeof task.worktree !== 'string') continue;
    const to = path.join(ctx.dataRoot, PROJECT_WORKTREES, slug, task.id);
    if (task.worktree === to) continue;
    const moved = { worktree: to, cwd: path.join(to, typeof task.cwd === 'string' ? path.relative(task.worktree, task.cwd) : '') };
    try {
      // Nothing where it was: moved before a restore was cut short, or gone (Resume makes it again from its branch).
      if (fs.existsSync(task.worktree)) {
        if (!moveWorktree) continue; // left where it is: a Build works wherever its record says its copy is
        await moveWorktree(task, to);
      }
      buildStore.writeTask(where, { ...task, ...moved });
    } catch (error) {
      if (removeWorktrees) await Promise.resolve().then(() => removeWorktrees([task])).catch(() => {});
      buildStore.writeTask(where, { ...task, status: 'discarded', queued: null, finished: nowIso(), messages: [...(task.messages || []), buildStore.message('engelbart', `Its copy could not be moved when the project came back from the trash (${error.message}), so it was discarded.`)] });
    }
  }
}

/* ---------------------------------------------------------------- workspaces */

function workspaceRecord(dir) {
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta || typeof meta.id !== 'string' || !STATUSES.includes(meta.status)) return null;
  let context = [];
  try {
    context = flatContext(meta.context || []);
  } catch {
    context = [];
  }
  // Kept by every save through the app; a workspace last saved before the count existed is measured.
  const chars = Number.isInteger(meta.chars) && meta.chars >= 0 ? meta.chars : docChars(dir);
  const removed = Array.isArray(meta.removed) ? meta.removed.filter((id) => typeof id === 'string' && UUID_RE.test(id)) : [];
  // What the @ menu linked (MATH-57): it leaves with its last mention in the document.
  const picked = Array.isArray(meta.picked) ? meta.picked.filter((id) => typeof id === 'string' && UUID_RE.test(id)) : [];
  // The Builds started from this workspace (2026-09-25), and its archived versions, oldest first (./archive.cjs).
  const builds = Array.isArray(meta.builds) ? meta.builds.filter((id) => typeof id === 'string' && BUILD_ID_RE.test(id)) : [];
  const archives = (Array.isArray(meta.archives) ? meta.archives : [])
    .filter((entry) => entry && typeof entry.file === 'string' && ARCHIVE_RE.test(entry.file))
    .map((entry) => ({ file: entry.file, clearedAt: typeof entry.clearedAt === 'string' ? entry.clearedAt : null, title: typeof entry.title === 'string' ? entry.title.slice(0, 200) : '' }));
  return { id: meta.id, name: path.basename(dir), context, removed, picked, chars, builds, archives, dir, created: meta.created || null };
}

function docChars(dir) {
  try { return fs.readFileSync(path.join(dir, 'workspace.md'), 'utf8').length; } catch { return 0; }
}

function workspaceRecords(parentDir) {
  return subdirs(parentDir).filter((dir) => !PROJECT_RESERVED.has(path.basename(dir))).map(workspaceRecord).filter(Boolean).sort(byCreated);
}

function findWorkspaceIn(parentDir, id, depth = 0) {
  if (depth > 32) return null;
  for (const workspace of workspaceRecords(parentDir)) {
    if (workspace.id === id) return { workspace, parentDir };
    const deeper = findWorkspaceIn(workspace.dir, id, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

function findWorkspace(ctx, projectId, workspaceId) {
  const project = findProject(ctx, projectId);
  const found = findWorkspaceIn(project.dir, assertId(workspaceId, 'workspace'));
  if (!found) throw new Error('Unknown workspace');
  return { project, ...found };
}

function publicWorkspace(workspace) {
  return { id: workspace.id, name: workspace.name, context: workspace.context, removed: workspace.removed, picked: workspace.picked || [], chars: workspace.chars, builds: workspace.builds || [], archives: workspace.archives || [], created: workspace.created };
}

/** Every workspace of a project, flat, with its path from the project directory ("Agents/Inline chat agent"). */
function flattenWorkspaces(projectDir, prefix = '', depth = 0, out = []) {
  if (depth > 32) return out;
  for (const workspace of workspaceRecords(depth === 0 ? projectDir : path.join(projectDir, prefix))) {
    const at = prefix ? `${prefix}/${workspace.name}` : workspace.name;
    out.push({ id: workspace.id, name: workspace.name, path: at, context: workspace.context, chars: workspace.chars });
    flattenWorkspaces(projectDir, at, depth + 1, out);
  }
  return out;
}

/** Library id → the paths of the workspaces that have it in context. */
function referencedBy(workspaces) {
  const refs = new Map();
  for (const workspace of workspaces) {
    for (const id of workspace.context) refs.set(id, [...(refs.get(id) || []), workspace.path]);
  }
  return refs;
}

/** What a project holds: the rows made in it (`project_id`, the origin) and the rows one of its workspaces has in context. */
const holds = (project, refs, row) => row.project_id === project.id || refs.has(row.id);

// A workspace.md written from outside the app (an agent in a terminal): the stored count follows
// the file. Workspaces that never had a count are left alone; reading one measures the file.
function recountWorkspaces(ctx) {
  let fixed = 0;
  const walk = (parentDir, depth) => {
    if (depth > 32) return;
    for (const workspace of workspaceRecords(parentDir)) {
      const meta = readJson(path.join(workspace.dir, 'meta.json'));
      if (meta && Number.isInteger(meta.chars) && meta.chars !== docChars(workspace.dir)) { patchWorkspaceMeta(workspace, { chars: docChars(workspace.dir) }); fixed += 1; }
      walk(workspace.dir, depth + 1);
    }
  };
  for (const project of projectRecords(ctx)) walk(project.dir, 0);
  return fixed;
}

// When a workspace's document was last saved (workspace.md's mtime; made counts as saved): the sidebar lists the workspaces
// worked in last (2026-10-07), with state.json `recent` for the notes typed in them.
function editedAt(dir) {
  try { return fs.statSync(path.join(dir, 'workspace.md')).mtime.toISOString(); } catch { return null; }
}

function workspaceTree(parentDir, depth = 0) {
  if (depth > 32) return [];
  return workspaceRecords(parentDir).map((workspace) => ({ ...publicWorkspace(workspace), edited: editedAt(workspace.dir), children: workspaceTree(workspace.dir, depth + 1) }));
}

// A workspace's directory name: never one the project keeps for itself.
function workspaceDirName(parentDir, name, fallback) {
  let base = sanitizeName(name || fallback);
  if (PROJECT_RESERVED.has(base.toLowerCase()) || base.toLowerCase().endsWith('.pglite')) base = `${base} workspace`;
  return uniqueName(parentDir, base);
}

async function createWorkspace(ctx, projectId, { name, parentId } = {}) {
  const parentDir = parentId ? findWorkspace(ctx, projectId, parentId).workspace.dir : findProject(ctx, projectId).dir;
  const dir = path.join(parentDir, workspaceDirName(parentDir, name, 'Untitled Workspace 1'));
  fs.mkdirSync(dir, { mode: DIR_MODE });
  writeJson(path.join(dir, 'meta.json'), { id: randomUUID(), status: 'open', context: [], created: nowIso(), chars: 0 });
  writeTextAtomic(path.join(dir, 'workspace.md'), '');
  return publicWorkspace(workspaceRecord(dir));
}

async function renameWorkspace(ctx, projectId, workspaceId, name) {
  const { workspace, parentDir } = findWorkspace(ctx, projectId, workspaceId);
  if (sanitizeName(name) === workspace.name) return publicWorkspace(workspace);
  const next = path.join(parentDir, workspaceDirName(parentDir, name, workspace.name));
  fs.renameSync(workspace.dir, next);
  return publicWorkspace(workspaceRecord(next));
}

// Delete, from the switcher (2026-09-30): the workspace goes into the trash with everything nested in it, into
// <project>/.trash, a dot folder no listing of workspaces sees. meta.json `trashed` keeps when it went, its name and the
// workspace it was under, so Restore puts it back there (at the top when that one is gone too). The sidebar's trash lists
// it and purges it a week after it went in, as it does the post-its.
const TRASH_DIR = '.trash';
const TRASH_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

function trashWorkspace(ctx, projectId, workspaceId) {
  const { project, workspace, parentDir } = findWorkspace(ctx, projectId, workspaceId);
  const parent = parentDir === project.dir ? null : workspaceRecord(parentDir);
  const bin = path.join(project.dir, TRASH_DIR);
  fs.mkdirSync(bin, { recursive: true, mode: DIR_MODE });
  const into = path.join(bin, uniqueName(bin, workspace.name));
  fs.renameSync(workspace.dir, into);
  patchWorkspaceMeta({ dir: into }, { trashed: { at: nowIso(), name: workspace.name, parentId: parent ? parent.id : null } });
  return { id: workspace.id, name: workspace.name };
}

function trashedRecords(project) {
  const bin = path.join(project.dir, TRASH_DIR);
  return subdirs(bin).map((dir) => {
    const workspace = workspaceRecord(dir);
    const trashed = workspace && readJson(path.join(dir, 'meta.json')).trashed;
    const at = trashed && typeof trashed.at === 'string' ? Date.parse(trashed.at) : NaN;
    if (!workspace || Number.isNaN(at)) return null;
    const name = typeof trashed.name === 'string' && trashed.name ? trashed.name : workspace.name;
    return { workspace, dir, at, name, parentId: typeof trashed.parentId === 'string' && UUID_RE.test(trashed.parentId) ? trashed.parentId : null };
  }).filter(Boolean);
}

/** The workspaces in the trash, newest first, each { id, name, deleted, expires, nested }; those in it a week are purged. */
function trashedWorkspaces(ctx, projectId, now = Date.now()) {
  const project = findProject(ctx, projectId);
  const out = [];
  for (const entry of trashedRecords(project)) {
    if (entry.at < now - TRASH_DAYS * DAY) { fs.rmSync(entry.dir, { recursive: true, force: true }); continue; }
    out.push({ id: entry.workspace.id, name: entry.name, deleted: new Date(entry.at).toISOString(), expires: new Date(entry.at + TRASH_DAYS * DAY).toISOString(), nested: countWorkspaces(entry.dir) });
  }
  return out.sort((a, b) => b.deleted.localeCompare(a.deleted));
}

function restoreWorkspace(ctx, projectId, workspaceId) {
  const project = findProject(ctx, projectId);
  assertId(workspaceId, 'workspace');
  const entry = trashedRecords(project).find((candidate) => candidate.workspace.id === workspaceId);
  if (!entry) throw new Error('That workspace is no longer in the trash');
  const parent = entry.parentId ? findWorkspaceIn(project.dir, entry.parentId) : null;
  const parentDir = parent ? parent.workspace.dir : project.dir;
  const back = path.join(parentDir, workspaceDirName(parentDir, entry.name, entry.workspace.name));
  fs.renameSync(entry.dir, back);
  const { trashed, ...meta } = readJson(path.join(back, 'meta.json')); // eslint-disable-line no-unused-vars
  writeJson(path.join(back, 'meta.json'), meta);
  return publicWorkspace(workspaceRecord(back));
}

function patchWorkspaceMeta(workspace, patch) {
  const meta = readJson(path.join(workspace.dir, 'meta.json'));
  writeJson(path.join(workspace.dir, 'meta.json'), { ...meta, ...patch });
  return publicWorkspace(workspaceRecord(workspace.dir));
}

async function setWorkspaceContext(ctx, projectId, workspaceId, entries) {
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  return patchWorkspaceMeta(workspace, { context: flatContext(entries) });
}

/** A Build started from this workspace (2026-09-25): its id joins meta.json `builds`. */
function addWorkspaceBuild(ctx, projectId, workspaceId, buildId) {
  if (typeof buildId !== 'string' || !BUILD_ID_RE.test(buildId)) throw new TypeError('build id is invalid');
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  if (workspace.builds.includes(buildId)) return publicWorkspace(workspace);
  return patchWorkspaceMeta(workspace, { builds: [...workspace.builds, buildId].slice(-500) });
}

// The sidebar's trash and its ways of bringing something in (2026-09-22). A workspace's rail shows
// its context, the notes made in it and what its document @mentions; the trash takes a row off it
// whatever put it there, so `removed` (meta.json) remembers what was thrown away and the rail leaves
// it out. Nothing is deleted: the library keeps the row and the project keeps the note. Linking an
// item again (search, +, Save, an @mention picked from the menu) puts it back in context and takes
// it off `removed`. Both run here, one read and one write of meta.json, so quick adds never race.
const MAX_REMOVED = 1000;

async function linkToWorkspace(ctx, projectId, workspaceId, ids, { picked = false } = {}) {
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  const adding = (Array.isArray(ids) ? ids : [ids]).map((id) => assertId(id, 'library'));
  const context = [...workspace.context];
  // `picked` (MATH-57): linked by picking it from the @ menu, which is remembered for an item not linked already. Linked
  // any other way, it stays when its mentions go.
  const chosen = picked ? [...workspace.picked, ...adding.filter((id) => !context.includes(id) && !workspace.picked.includes(id))] : workspace.picked.filter((id) => !adding.includes(id));
  for (const id of adding) if (!context.includes(id)) context.push(id);
  return patchWorkspaceMeta(workspace, { context: flatContext(context), removed: workspace.removed.filter((id) => !adding.includes(id)), picked: chosen });
}

// `unmentioned` (MATH-57): the document's last mention of an item the @ menu linked went, and the item goes with it. Only
// such an item, and it is not remembered as thrown away: mentioned again, it is on the rail as any mention is.
async function unlinkFromWorkspace(ctx, projectId, workspaceId, id, { unmentioned = false } = {}) {
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  const gone = assertId(id, 'library');
  const context = workspace.context.filter((held) => held !== gone), picked = workspace.picked.filter((held) => held !== gone);
  if (unmentioned) return workspace.picked.includes(gone) ? patchWorkspaceMeta(workspace, { context, picked }) : publicWorkspace(workspace);
  const removed = [...workspace.removed.filter((held) => held !== gone), gone].slice(-MAX_REMOVED);
  return patchWorkspaceMeta(workspace, { context, removed, picked });
}

/* --------------------------------------------------------------------- notes */

// The notes table keeps its first columns: `topic_id` holds the workspace id (topic ids became
// workspace ids when the layout changed), `goal_id` is no longer written.
function publicNote(row) {
  return { id: row.id, name: row.name, path: row.path, workspaceId: row.topic_id || null, created: row.created, lastEdited: row.last_edited };
}

async function createNote(ctx, projectId, { name, workspaceId, text } = {}) {
  const project = findProject(ctx, projectId);
  if (workspaceId != null) assertId(workspaceId, 'workspace');
  const stem = uniqueName(project.dir, sanitizeName(name || 'Untitled Note 1'), '.md');
  const file = path.join(project.dir, `${stem}.md`);
  writeTextAtomic(file, typeof text === 'string' ? text : '');
  const id = randomUUID();
  const notesDb = await db.openNotesDb(project.dir);
  const row = await notesDb.insert({ id, name: stem, path: `${stem}.md`, goal_id: null, topic_id: workspaceId || null });
  await ctx.libraryDb.insert({ id, name: stem, type: 'md', tags: ['note'], path: file, project_id: projectId });
  await ctx.libraryDb.setCharCount(id, typeof text === 'string' ? text.length : 0);
  return publicNote(row);
}

async function renameNote(ctx, projectId, noteId, name) {
  const project = findProject(ctx, projectId);
  const notesDb = await db.openNotesDb(project.dir);
  const row = await notesDb.get(assertId(noteId, 'note'));
  if (!row) throw new Error('Unknown note');
  const base = sanitizeName(name);
  if (base === row.name) return publicNote(row);
  const stem = uniqueName(project.dir, base, '.md');
  const file = path.join(project.dir, `${stem}.md`);
  fs.renameSync(path.join(project.dir, row.path), file);
  const updated = await notesDb.rename(noteId, stem, `${stem}.md`);
  await ctx.libraryDb.rename(noteId, stem);
  await ctx.libraryDb.updatePath(noteId, file);
  return publicNote(updated);
}

/* -------------------------------------------------------------------- images */

// A pasted image: bytes → <project>/assets/<id>.<ext>, plus a library row (type `image`) so it is
// context like a paper or a note. Documents reference it as ![Attachment n](img:<id>).
async function saveImage(ctx, projectId, { bytes, mime, name } = {}) {
  const project = findProject(ctx, projectId);
  const extension = IMAGE_TYPES[mime];
  if (!extension) throw new TypeError('Only png, jpeg, gif and webp images can be attached');
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes || []);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new TypeError('The image is empty or larger than 20 MB');
  const dir = path.join(project.dir, 'assets');
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const id = randomUUID();
  const file = path.join(dir, `${id}.${extension}`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  const label = sanitizeName(typeof name === 'string' && name.trim() ? name : 'Attachment');
  return ctx.libraryDb.insert({ id, name: label, type: 'image', path: file, project_id: projectId });
}

async function readImage(ctx, id) {
  const row = await ctx.libraryDb.get(assertId(id, 'image'));
  if (!row || row.type !== 'image' || !row.path) throw new Error('Unknown image');
  const resolved = path.resolve(row.path);
  if (!resolved.startsWith(ctx.dataRoot + path.sep)) throw new Error('The image is outside the data root');
  const extension = path.extname(resolved).slice(1).toLowerCase();
  const mime = Object.keys(IMAGE_TYPES).find((type) => IMAGE_TYPES[type] === extension) || 'application/octet-stream';
  return { id: row.id, name: row.name, mime, bytes: fs.readFileSync(resolved) };
}

/* ---------------------------------------------------------------------- docs */

async function resolveDoc(ctx, projectId, ref) {
  if (!ref || typeof ref !== 'object') throw new TypeError('doc ref must be an object');
  if (ref.kind === 'note') {
    const project = findProject(ctx, projectId);
    const notesDb = await db.openNotesDb(project.dir);
    const row = await notesDb.get(assertId(ref.id, 'note'));
    if (!row) throw new Error('Unknown note');
    return { file: path.join(project.dir, row.path), note: row, notesDb };
  }
  if (ref.kind === 'workspace') {
    const { workspace } = findWorkspace(ctx, projectId, ref.workspaceId);
    return { file: path.join(workspace.dir, 'workspace.md'), workspace };
  }
  throw new TypeError('Unknown doc kind');
}

async function readDoc(ctx, projectId, ref) {
  const { file } = await resolveDoc(ctx, projectId, ref);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function writeDoc(ctx, projectId, ref, text) {
  if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) throw new TypeError('doc text must be a string under 5 MB');
  const resolved = await resolveDoc(ctx, projectId, ref);
  let previous = null;
  try { previous = fs.readFileSync(resolved.file, 'utf8'); } catch { previous = null; }
  // A save that changes nothing is not an edit: last_edited decides when a summary is stale.
  if (previous === text) return { lastEdited: null };
  writeTextAtomic(resolved.file, text);
  if (resolved.note) {
    await resolved.notesDb.touch(resolved.note.id);
    await ctx.libraryDb.recordEdit(resolved.note.id, text.length); // the note's character count, current with every save
  }
  if (resolved.workspace) patchWorkspaceMeta(resolved.workspace, { chars: text.length }); // and the workspace's
  return { lastEdited: nowIso() };
}

/* ------------------------------------------------------------- last opened */

// Where the app reopens: <dataRoot>/state.json { projectId, workspaceId, views, stages, recent, agents }. Missing or stale ids
// fall back to the first project / workspace. (Files written before the layout change carry
// `topicId`, which is the same id.)
// `views[projectId][workspaceId]` is what a workspace had open when it was left (2026-09-22): the document in front
// (`active`: 'ws', a note's library id, or a workspace tab's workspace id), its tabs (notes, and since 2026-09-23 other
// workspaces' documents, `kind: 'workspace'`), and where each document was scrolled to, keyed as the editor
// keys documents (`ws:<id>`, `note:<id>`). Positions belong to the workspace, so one note can be halfway down in one
// workspace and at the top in another. Scrolling writes here and nowhere else: a document's edit time never moves.
const STATE_FILE = 'state.json';
const MAX_TABS = 40;
const MAX_POSITIONS = 200;
const idOrNull = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : null);
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

function readState(ctx) {
  return plainObject(readJson(path.join(ctx.dataRoot, STATE_FILE), {})) || {};
}

function readLastOpen(ctx) {
  const value = readState(ctx);
  return { projectId: idOrNull(value.projectId), workspaceId: idOrNull(value.workspaceId) || idOrNull(value.topicId) };
}

/** Rewrites state.json with the fields given; every other field it held is kept (a topic-era `topicId` becomes `workspaceId`). */
function writeState(ctx, patch) {
  const { topicId, goalId, ...held } = readState(ctx); // eslint-disable-line no-unused-vars
  writeJson(path.join(ctx.dataRoot, STATE_FILE), { ...held, ...readLastOpen(ctx), ...patch });
}

function writeLastOpen(ctx, value) {
  const input = plainObject(value) || {};
  const next = { projectId: idOrNull(input.projectId), workspaceId: idOrNull(input.workspaceId) };
  writeState(ctx, next);
  return next;
}

// The windows open when the app last kept them (2026-10-03), every one reopened at the next launch:
// `windows: [{ projectId, workspaceId, bounds: { x, y, width, height } }]`, the window focused last at the end; a projectId
// of null is a window on the projects screen. Written by main (index.cjs) as windows move, resize and go somewhere, and
// at quit. Without it (a state.json from before) the app opens one window where `projectId` / `workspaceId` say.
const MAX_WINDOWS = 24;

function cleanBounds(value) {
  const input = plainObject(value); if (!input) return null;
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = Number(input[key]);
    if (!Number.isFinite(n) || Math.abs(n) > 100000) return null;
    out[key] = Math.round(n);
  }
  return out.width >= 100 && out.height >= 100 ? out : null;
}

function cleanWindows(value) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const input = plainObject(entry); if (!input) continue;
    const projectId = idOrNull(input.projectId);
    out.push({ projectId, workspaceId: projectId ? idOrNull(input.workspaceId) : null, bounds: cleanBounds(input.bounds) });
  }
  return out.slice(-MAX_WINDOWS);
}

function readWindows(ctx) {
  return cleanWindows(readState(ctx).windows);
}

function writeWindows(ctx, list) {
  const windows = cleanWindows(list);
  writeState(ctx, { windows });
  return windows;
}

/** { top, line?, offset?, hash? } — the scroll offset in pixels, and the first line on screen, how far its top sat above the pane's edge, a hash of its text. */
function cleanPosition(value) {
  const input = plainObject(value); if (!input || !Number.isFinite(input.top)) return null;
  const out = { top: Math.round(Math.min(1e7, Math.max(0, input.top))) };
  if (Number.isInteger(input.line) && input.line >= 0 && input.line < 1e6) {
    out.line = input.line;
    out.offset = Number.isFinite(input.offset) ? Math.round(Math.min(1e6, Math.max(-1e6, input.offset))) : 0;
    if (typeof input.hash === 'string' && /^[0-9a-z]{1,16}$/.test(input.hash)) out.hash = input.hash;
  }
  return out;
}

function cleanView(value) {
  const input = plainObject(value); if (!input) return null;
  const tabs = [], seen = new Set();
  for (const tab of Array.isArray(input.tabs) ? input.tabs : []) {
    const id = idOrNull(tab && tab.id); if (!id || seen.has(id)) continue;
    seen.add(id);
    const clean = { id, title: typeof tab.title === 'string' ? tab.title.slice(0, 200) : '' };
    if (tab.kind === 'workspace') clean.kind = 'workspace'; // another workspace's document open here as a tab (2026-09-23)
    tabs.push(clean);
    if (tabs.length >= MAX_TABS) break;
  }
  const positions = {};
  for (const [key, position] of Object.entries(plainObject(input.positions) || {}).slice(-MAX_POSITIONS)) {
    const m = /^(ws|note):(.+)$/.exec(key), clean = m && idOrNull(m[2]) ? cleanPosition(position) : null;
    if (clean) positions[`${m[1]}:${m[2]}`] = clean;
  }
  const active = input.active !== 'ws' && seen.has(idOrNull(input.active)) ? input.active : 'ws';
  return { active, tabs, positions };
}

/** What each workspace of a project had open → { [workspaceId]: { active, tabs, positions } }. */
function readViews(ctx, projectId) {
  const id = idOrNull(projectId); if (!id) return {};
  const mine = plainObject((plainObject(readState(ctx).views) || {})[id]) || {};
  const out = {};
  for (const [workspaceId, view] of Object.entries(mine)) {
    const clean = idOrNull(workspaceId) ? cleanView(view) : null;
    if (clean) out[workspaceId] = clean;
  }
  return out;
}

function writeView(ctx, projectId, workspaceId, view) {
  const pid = idOrNull(projectId), wid = idOrNull(workspaceId);
  if (!pid || !wid) throw new TypeError('a view needs a project id and a workspace id');
  const clean = cleanView(view); if (!clean) throw new TypeError('view is invalid');
  const views = plainObject(readState(ctx).views) || {};
  writeState(ctx, { views: { ...views, [pid]: { ...(plainObject(views[pid]) || {}), [wid]: clean } } });
  return clean;
}

// `stages[projectId]` is what the project's Stage had open (MATH-10, 2026-10-05): its tabs, each a library row
// `{ item, title }` or a place `{ address, title }` (a URL or an absolute path), and `active`, the index of the one in
// front. One list for the project, shared by its workspaces, as the Stage is. Written by the renderer as tabs change
// (Stage.jsx), so ⌘R and quitting give the same tabs back; no page's contents, ink or history are kept.
const MAX_STAGE_TABS = 15; // MAX_TABS in renderer/model/stage.js
const MAX_ADDRESS = 2048;

/** A place a Stage tab can go back to: http, https or file, or an absolute path; never about:. */
function cleanAddress(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  if (!address || address.length > MAX_ADDRESS || /^about:/i.test(address)) return null;
  return /^(https?|file):/i.test(address) || address.startsWith('/') ? address : null;
}

/** { active, tabs }: entries that are neither a row nor a place go, and the second of two that are one (by row, else by addressKey). */
function cleanStage(value) {
  const input = plainObject(value); if (!input) return null;
  const tabs = [], seen = new Map(); // key → where it is kept
  const at = new Map(); // the index it came at → the index it is kept at
  (Array.isArray(input.tabs) ? input.tabs : []).forEach((tab, i) => {
    const entry = plainObject(tab); if (!entry) return;
    const item = idOrNull(entry.item), address = item ? null : cleanAddress(entry.address);
    if (!item && !address) return;
    const key = item ? `i:${item}` : `l:${addressKey(address.startsWith('/') ? `file://${address}` : address)}`;
    if (seen.has(key)) { at.set(i, seen.get(key)); return; }
    if (tabs.length >= MAX_STAGE_TABS) return;
    seen.set(key, tabs.length);
    at.set(i, tabs.length);
    const title = typeof entry.title === 'string' ? entry.title.slice(0, 200) : '';
    tabs.push(item ? { item, title } : { address, title });
  });
  const wanted = Number.isInteger(input.active) ? input.active : 0;
  const active = at.has(wanted) ? at.get(wanted) : Math.max(0, Math.min(wanted, tabs.length - 1));
  return { active, tabs };
}

/** What the project's Stage had open → { active, tabs } (none: no tabs). */
function readStage(ctx, projectId) {
  const id = idOrNull(projectId);
  const held = id ? (plainObject(readState(ctx).stages) || {})[id] : null;
  return cleanStage(held) || { active: 0, tabs: [] };
}

function writeStage(ctx, projectId, value) {
  const pid = idOrNull(projectId); if (!pid) throw new TypeError('a Stage needs a project id');
  const clean = cleanStage(value); if (!clean) throw new TypeError('stage is invalid');
  const stages = plainObject(readState(ctx).stages) || {};
  writeState(ctx, { stages: { ...stages, [pid]: clean } });
  return clean;
}

/** A project purged from the trash: its views and its Stage, and its entries among the recent workspaces and the agents, go. */
function forgetProject(ctx, projectId) {
  const state = readState(ctx);
  const patch = {};
  const views = plainObject(state.views) || {};
  if (projectId in views) { const { [projectId]: gone, ...kept } = views; patch.views = kept; } // eslint-disable-line no-unused-vars
  const stages = plainObject(state.stages) || {};
  if (projectId in stages) { const { [projectId]: gone, ...kept } = stages; patch.stages = kept; } // eslint-disable-line no-unused-vars
  for (const key of ['recent', 'agents']) {
    const list = Array.isArray(state[key]) ? state[key] : [];
    if (list.some((entry) => plainObject(entry) && entry.projectId === projectId)) patch[key] = list.filter((entry) => !(plainObject(entry) && entry.projectId === projectId));
  }
  const starred = plainObject(state.starred) || {};
  if (projectId in starred) { const { [projectId]: gone, ...kept } = starred; patch.starred = kept; } // eslint-disable-line no-unused-vars
  if (Object.keys(patch).length) writeState(ctx, patch);
}

/* ----------------------------------------------------------------- starred */

// What the sidebar's Starred lists (2026-10-07): `starred[projectId]`, the library ids starred in that project, oldest
// first. A star is the project's, not the library row's: one paper can be starred in one project and not in another.
const MAX_STARRED = 500;
const starredIds = (value) => [...new Set((Array.isArray(value) ? value : []).map(idOrNull).filter(Boolean))].slice(-MAX_STARRED);

function readStarred(ctx, projectId) {
  const id = idOrNull(projectId); if (!id) return [];
  return starredIds((plainObject(readState(ctx).starred) || {})[id]);
}

/** Stars an item in a project (`on`), or takes its star off. → the project's starred ids. */
function setStarred(ctx, projectId, itemId, on) {
  const pid = idOrNull(projectId), iid = idOrNull(itemId);
  if (!pid || !iid) throw new TypeError('a star needs a project id and a library id');
  const all = plainObject(readState(ctx).starred) || {};
  const held = starredIds(all[pid]).filter((id) => id !== iid);
  const next = on ? starredIds([...held, iid]) : held;
  writeState(ctx, { starred: { ...all, [pid]: next } });
  return next;
}

/* ------------------------------------------------------------- where to next */

// What the sidebar's "next" row and ⌘J go to (2026-09-22), kept in state.json beside the views:
//   recent: [{ projectId, workspaceId, at }]  the workspaces written in, newest first: every one written in during the last
//           thirty minutes, or the last three, whichever is more (2026-09-23, Hudson: "whichever group contains MORE
//           workspaces"). A workspace is written in when it is made, or when its document or a note open in it is typed
//           into; looking around does not count.
//   agents: [{ id, kind, projectId, workspaceId, doc, status, started, finished }]  every agent the app started that is
//           still `running`, or has finished and is `waiting` for you to look (it is dropped when its workspace is
//           visited). `kind` is 'bart' (the inline @bart asks) or 'build' (a Build's turn, 2026-09-25); `workspaceId`
//           may be null for an agent that belongs to no workspace (a post-it's quick task). A `running` row from an
//           earlier run of the app is stale and is not read.
const RECENT_KEEP = 3;
const RECENT_WINDOW = 30 * 60 * 1000;
const MAX_RECENT = 100;
const MAX_AGENTS = 50;
const AGENT_KINDS = new Set(['bart', 'brainstorm', 'discover', 'build']);
const AGENT_STATUSES = new Set(['running', 'waiting']);
const liveAgents = new Set(); // ids of the agents running in this process
const isoOrNull = (value) => (typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null);

/** Newest first, once each: the first three whatever their age, then any other written in during the last thirty minutes. */
function cleanRecent(value, now = Date.now()) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const input = plainObject(entry) || {};
    const projectId = idOrNull(input.projectId), workspaceId = idOrNull(input.workspaceId), at = isoOrNull(input.at);
    if (!projectId || !workspaceId || !at || out.some((held) => held.projectId === projectId && held.workspaceId === workspaceId)) continue;
    if (out.length >= RECENT_KEEP && !(now - Date.parse(at) <= RECENT_WINDOW)) continue;
    out.push({ projectId, workspaceId, at });
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

// A highlight on a pdf (MATH-27): its mark's id (PaperView's, not a uuid), the library row or the address the pdf is, its page.
// A highlight on a web page (MATH-54) has `source: 'web'` and no page.
const MARK_ID_RE = /^[\w-]{1,64}$/;
function cleanDocRef(value) {
  const input = plainObject(value);
  if (input && input.kind === 'workspace' && idOrNull(input.workspaceId)) return { kind: 'workspace', workspaceId: input.workspaceId };
  if (input && input.kind === 'note' && idOrNull(input.id)) return { kind: 'note', id: input.id };
  const web = !!input && input.source === 'web' && input.page == null;
  if (input && input.kind === 'mark' && typeof input.id === 'string' && MARK_ID_RE.test(input.id) && (web || (Number.isInteger(input.page) && input.page > 0))) {
    const on = web ? { source: 'web' } : { page: input.page };
    if (idOrNull(input.rowId)) return { kind: 'mark', id: input.id, rowId: input.rowId, ...on };
    if (typeof input.url === 'string' && input.url && input.url.length <= 8192) return { kind: 'mark', id: input.id, url: input.url, ...on };
  }
  return null;
}

function cleanAgents(value) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const input = plainObject(entry) || {};
    const id = typeof input.id === 'string' && /^[\w-]{1,64}$/.test(input.id) ? input.id : null;
    if (!id || !AGENT_KINDS.has(input.kind) || !AGENT_STATUSES.has(input.status) || out.some((held) => held.id === id)) continue;
    if (input.status === 'running' && !liveAgents.has(id)) continue;
    out.push({ id, kind: input.kind, projectId: idOrNull(input.projectId), workspaceId: idOrNull(input.workspaceId), doc: cleanDocRef(input.doc), status: input.status, started: isoOrNull(input.started), finished: isoOrNull(input.finished) });
  }
  return out.slice(-MAX_AGENTS);
}

/**
 * The recent workspaces and the agents, each with the names it is shown by ({ name, path, projectName }); an entry whose
 * project or workspace is gone is left out.
 */
function readNav(ctx) {
  const state = readState(ctx);
  const places = new Map(); // projectId → { name, byId } | null
  const place = (projectId, workspaceId) => {
    if (!places.has(projectId)) {
      let found = null;
      try {
        const project = findProject(ctx, projectId);
        found = { name: project.name, byId: new Map(flattenWorkspaces(project.dir).map((workspace) => [workspace.id, workspace])) };
      } catch { found = null; }
      places.set(projectId, found);
    }
    const project = places.get(projectId), workspace = project && project.byId.get(workspaceId);
    return workspace ? { name: workspace.name, path: workspace.path, projectName: project.name } : null;
  };
  const recent = cleanRecent(state.recent).flatMap((entry) => { const at = place(entry.projectId, entry.workspaceId); return at ? [{ ...entry, ...at }] : []; });
  const agents = cleanAgents(state.agents).flatMap((agent) => {
    if (!agent.workspaceId) return [agent];
    const at = agent.projectId && place(agent.projectId, agent.workspaceId);
    return at ? [{ ...agent, ...at }] : [];
  });
  return { recent, agents };
}

/** A workspace was written in (or made): it moves to the front of `recent`, with the time. */
function recordEdit(ctx, projectId, workspaceId) {
  findWorkspace(ctx, projectId, workspaceId);
  const held = readState(ctx).recent;
  const recent = cleanRecent([{ projectId, workspaceId, at: nowIso() }, ...(Array.isArray(held) ? held : [])]);
  writeState(ctx, { recent });
  return recent;
}

function writeAgents(ctx, change) {
  const agents = change(cleanAgents(readState(ctx).agents));
  writeState(ctx, { agents: agents.slice(-MAX_AGENTS) });
  return agents;
}

/** An agent starts: `running`, in the workspace it was asked from. */
function agentStarted(ctx, { id, kind = 'bart', projectId, workspaceId = null, doc = null }) {
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || !AGENT_KINDS.has(kind)) throw new TypeError('agent is invalid');
  liveAgents.add(id);
  writeAgents(ctx, (agents) => [...agents.filter((agent) => agent.id !== id), { id, kind, projectId: idOrNull(projectId), workspaceId: idOrNull(workspaceId), doc: cleanDocRef(doc), status: 'running', started: nowIso(), finished: null }]);
}

/** It finished (an answer or a failure, both of which land in the document): `waiting` until its workspace is visited. */
function agentFinished(ctx, id) {
  writeAgents(ctx, (agents) => agents.map((agent) => (agent.id === id ? { ...agent, status: 'waiting', finished: nowIso() } : agent)));
  liveAgents.delete(id);
}

/** It was stopped: nothing came of it, so nothing waits. */
function agentStopped(ctx, id) {
  liveAgents.delete(id);
  writeAgents(ctx, (agents) => agents.filter((agent) => agent.id !== id));
}

/** A workspace is being looked at: whatever was waiting there has been seen. Answers how many were. */
function seenAgents(ctx, projectId, workspaceId) {
  const pid = idOrNull(projectId), wid = idOrNull(workspaceId);
  if (!pid || !wid) throw new TypeError('seen needs a project id and a workspace id');
  let seen = 0;
  const held = cleanAgents(readState(ctx).agents);
  const kept = held.filter((agent) => { const here = agent.status === 'waiting' && agent.projectId === pid && agent.workspaceId === wid; if (here) seen += 1; return !here; });
  if (seen) writeState(ctx, { agents: kept });
  return seen;
}

/* ---------------------------------------------------------------- text files */

// The browser pane's "file" mode: a path typed as ~/…, /… or relative to the project directory,
// read-only, kept inside the home directory, first 20 000 characters.
/** A typed path, made real. Relative ones are looked for in the project, then the engelbart
 *  folder, then the project's code directory; the first that exists wins. Home directory only. */
function resolveTypedPath(ctx, project, input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0')) throw new TypeError('path is invalid');
  let target = input.trim();
  if (/^file:\/\//i.test(target)) target = fileURLToPath(target);
  let candidates;
  if (target.startsWith('~/')) candidates = [path.join(ctx.homeDir, target.slice(2))];
  else if (target === '~') candidates = [ctx.homeDir];
  else if (path.isAbsolute(target)) candidates = [target];
  else candidates = [project.dir, ctx.dataRoot, ctx.root, project.directory].filter(Boolean).map((base) => path.join(base, target));
  const resolved = stageFiles.reading(() => fs.realpathSync(candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0])); // nothing there, or macOS keeps it
  const homeReal = fs.realpathSync(ctx.homeDir);
  if (resolved !== homeReal && !resolved.startsWith(homeReal + path.sep)) throw new Error('Only files inside your home directory can be opened');
  return resolved;
}

const PAGE_FILE = /\.(?:html?|pdf)$/i;

/** What the Browser pane renders rather than prints: an html file or a pdf that exists (a pdf is drawn by the Paper viewer). Anything else is null. */
async function resolvePageFile(ctx, projectId, input) {
  const project = findProject(ctx, projectId);
  const typed = String(input || '').trim();
  const cut = typed.search(/[#?]/); // `report.html#results` is the file, then a place in it
  for (const [file, rest] of cut > 0 ? [[typed, ''], [typed.slice(0, cut), typed.slice(cut)]] : [[typed, '']]) {
    try {
      const resolved = resolveTypedPath(ctx, project, file);
      if (PAGE_FILE.test(resolved) && fs.statSync(resolved).isFile()) return { path: resolved, url: pathToFileURL(resolved).href + rest };
    } catch {
      // Not a file here: the address means something else.
    }
  }
  return null;
}

/** What the Stage shows for a path typed or picked in this project (src/main/stage/files.cjs). */
async function readStageFile(ctx, projectId, input) {
  const file = resolveTypedPath(ctx, findProject(ctx, projectId), input);
  return stageFiles.readStageFile(file, { cacheDir: path.join(ctx.dataRoot, '.cache', 'stage') });
}

async function readProjectTextFile(ctx, projectId, input) {
  const resolved = resolveTypedPath(ctx, findProject(ctx, projectId), input);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(resolved, { withFileTypes: true }).map((entry) => entry.name + (entry.isDirectory() ? '/' : '')).sort();
    return { path: resolved, text: entries.join('\n'), truncated: false, kind: 'directory' };
  }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('The file is not a readable text file');
  const text = fs.readFileSync(resolved, 'utf8');
  return { path: resolved, text: text.slice(0, 20000), truncated: text.length > 20000, kind: 'file' };
}

/* --------------------------------------------------------------------- tree */

async function loadProject(ctx, projectId) {
  const project = findProject(ctx, projectId);
  const notesDb = await db.openNotesDb(project.dir);
  const notes = (await notesDb.list()).map(publicNote);
  return { project: publicProject(project), workspaces: workspaceTree(project.dir), notes, trash: trashedWorkspaces(ctx, projectId) };
}

module.exports = {
  STATUSES,
  WELCOME_NOTE,
  validateTree,
  treeIds,
  treeContains,
  listProjects,
  createProject,
  createProjectWithWelcome,
  setProjectDirectory,
  setDefaultTarget,
  renameProject,
  trashProject,
  trashedProjects,
  purgeProject,
  restoreProject,
  loadProject,
  createWorkspace,
  renameWorkspace,
  trashWorkspace,
  trashedWorkspaces,
  restoreWorkspace,
  setWorkspaceContext,
  addWorkspaceBuild,
  patchWorkspace: (ctx, projectId, workspaceId, patch) => patchWorkspaceMeta(findWorkspace(ctx, projectId, workspaceId).workspace, patch),
  writeTextAtomic,
  BUILD_ID_RE,
  ARCHIVE_RE,
  linkToWorkspace,
  unlinkFromWorkspace,
  createNote,
  renameNote,
  saveImage,
  readImage,
  findWorkspace,
  resolveDoc,
  readDoc,
  writeDoc,
  readProjectTextFile,
  readStageFile,
  resolvePageFile,
  readLastOpen,
  writeLastOpen,
  readWindows,
  writeWindows,
  readViews,
  writeView,
  cleanStage,
  readStage,
  writeStage,
  readNav,
  recordEdit,
  readStarred,
  setStarred,
  cleanDocRef,
  agentStarted,
  agentFinished,
  agentStopped,
  seenAgents,
  projectRecords,
  findProject,
  flattenWorkspaces,
  referencedBy,
  holds,
  recountWorkspaces,
};
