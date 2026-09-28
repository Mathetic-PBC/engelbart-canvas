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
//   <dataRoot>/<slug>/builds/<id>/                   a Build's record (../build/store.cjs)
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
  return { id: meta.id, name, slug: path.basename(dir), dir, created: meta.created || null, directory: exists ? saved : null, directoryMissing: saved && !exists ? saved : null, description };
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
// (2026-09-28, ./onboarding.cjs) names the workspace "Welcome", starts its document with the project's
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
  // The Builds started from this workspace (2026-09-25), and its archived versions, oldest first (./archive.cjs).
  const builds = Array.isArray(meta.builds) ? meta.builds.filter((id) => typeof id === 'string' && BUILD_ID_RE.test(id)) : [];
  const archives = (Array.isArray(meta.archives) ? meta.archives : [])
    .filter((entry) => entry && typeof entry.file === 'string' && ARCHIVE_RE.test(entry.file))
    .map((entry) => ({ file: entry.file, clearedAt: typeof entry.clearedAt === 'string' ? entry.clearedAt : null, title: typeof entry.title === 'string' ? entry.title.slice(0, 200) : '' }));
  return { id: meta.id, name: path.basename(dir), context, removed, chars, builds, archives, dir, created: meta.created || null };
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
  return { id: workspace.id, name: workspace.name, context: workspace.context, removed: workspace.removed, chars: workspace.chars, builds: workspace.builds || [], archives: workspace.archives || [], created: workspace.created };
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

function workspaceTree(parentDir, depth = 0) {
  if (depth > 32) return [];
  return workspaceRecords(parentDir).map((workspace) => ({ ...publicWorkspace(workspace), children: workspaceTree(workspace.dir, depth + 1) }));
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

async function linkToWorkspace(ctx, projectId, workspaceId, ids) {
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  const adding = (Array.isArray(ids) ? ids : [ids]).map((id) => assertId(id, 'library'));
  const context = [...workspace.context];
  for (const id of adding) if (!context.includes(id)) context.push(id);
  return patchWorkspaceMeta(workspace, { context: flatContext(context), removed: workspace.removed.filter((id) => !adding.includes(id)) });
}

async function unlinkFromWorkspace(ctx, projectId, workspaceId, id) {
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  const gone = assertId(id, 'library');
  const removed = [...workspace.removed.filter((held) => held !== gone), gone].slice(-MAX_REMOVED);
  return patchWorkspaceMeta(workspace, { context: workspace.context.filter((held) => held !== gone), removed });
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

// Where the app reopens: <dataRoot>/state.json { projectId, workspaceId, views, recent, agents }. Missing or stale ids
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
const AGENT_KINDS = new Set(['bart', 'build']);
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

function cleanDocRef(value) {
  const input = plainObject(value);
  if (input && input.kind === 'workspace' && idOrNull(input.workspaceId)) return { kind: 'workspace', workspaceId: input.workspaceId };
  if (input && input.kind === 'note' && idOrNull(input.id)) return { kind: 'note', id: input.id };
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
  const resolved = fs.realpathSync(candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]);
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
  return { project: publicProject(project), workspaces: workspaceTree(project.dir), notes };
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
  renameProject,
  loadProject,
  createWorkspace,
  renameWorkspace,
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
  readViews,
  writeView,
  readNav,
  recordEdit,
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
