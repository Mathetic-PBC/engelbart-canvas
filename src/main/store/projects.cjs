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
//   <dataRoot>/<slug>/<Workspace>/meta.json          { id, status, context, created }
//   <dataRoot>/<slug>/<Workspace>/workspace.md
//   <dataRoot>/<slug>/<Workspace>/<Child>/…          the same, recursively
//
// `directory` is where the project's code lives: terminals and agents start there.
// A workspace's `context` is a flat list of library ids. Grouping is done by nesting a workspace.
// The earlier layout (<slug>/<Goal>/<Topic>/…) is converted on first touch: see ./migrate.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sanitizeName, slugify, uniqueName, readJson, writeJson, DIR_MODE } = require('./home.cjs');
const db = require('./db.cjs');
const { migrateProjectDir } = require('./migrate.cjs');

const STATUSES = Object.freeze(['open', 'progress', 'done']);
const RESERVED = new Set(['annotations', 'seed', 'test']);
const PROJECT_RESERVED = new Set(['assets']);
const IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' });
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TREE_ENTRIES = 500;
const MAX_TREE_DEPTH = 6;

const WELCOME_NOTE = [
  'This is a note. Notes are plain markdown files in your project folder, and the sidebar lists what this workspace can see.',
  '',
  '- [ ] Write a todo, then press Build',
  '- [ ] Type @ to mention a paper, dataset or note from your library',
  '- [ ] Type @chat, a question, and press Enter',
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
      if (entry.name.endsWith('.pglite') || entry.name.startsWith('.')) continue;
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
  const directory = typeof meta.directory === 'string' && path.isAbsolute(meta.directory) ? meta.directory : null;
  return { id: meta.id, name, slug: path.basename(dir), dir, created: meta.created || null, directory };
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
  return { id: project.id, name: project.name, slug: project.slug, dir: project.dir, created: project.created, directory: project.directory, ...extra };
}

const countWorkspaces = (dir) => workspaceRecords(dir).reduce((n, workspace) => n + 1 + countWorkspaces(workspace.dir), 0);
const summary = (project) => ({ workspaceCount: countWorkspaces(project.dir), lastEdited: latestMtime(project.dir) || project.created });

async function listProjects(ctx) {
  return projectRecords(ctx)
    .map((project) => publicProject(project, summary(project)))
    .sort((a, b) => String(b.lastEdited || '').localeCompare(String(a.lastEdited || '')));
}

// `path` is the directory name under the data root, as the create screen shows it after "./".
function resolveSlug(ctx, name, requested) {
  const raw = typeof requested === 'string' && requested.trim() ? requested : name;
  const slug = slugify(raw) || 'engelbart';
  return uniqueName(ctx.dataRoot, slug);
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
  const slug = resolveSlug(ctx, name, options.path);
  const dir = path.join(ctx.dataRoot, slug);
  fs.mkdirSync(dir, { mode: DIR_MODE });
  const meta = { id: randomUUID(), name, created: nowIso(), ...(directory ? { directory } : {}) };
  writeJson(path.join(dir, 'project.json'), meta);
  migrated.add(dir);
  await db.openNotesDb(dir);
  return publicProject(projectRecord(dir), { workspaceCount: 0, lastEdited: meta.created });
}

// First-run flow: the project, a first workspace, and a "Welcome!" note open in its context.
async function createProjectWithWelcome(ctx, input) {
  const project = await createProject(ctx, input);
  const workspace = await createWorkspace(ctx, project.id, { name: 'Getting started' });
  const note = await createNote(ctx, project.id, { name: 'Welcome!', workspaceId: workspace.id, text: WELCOME_NOTE });
  await setWorkspaceContext(ctx, project.id, workspace.id, [note.id]);
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
    const slug = uniqueName(ctx.dataRoot, slugify(next) || 'engelbart');
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
  return { id: meta.id, name: path.basename(dir), status: meta.status, context, dir, created: meta.created || null };
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
  return { id: workspace.id, name: workspace.name, status: workspace.status, context: workspace.context, created: workspace.created };
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
  writeJson(path.join(dir, 'meta.json'), { id: randomUUID(), status: 'open', context: [], created: nowIso() });
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

async function setWorkspaceStatus(ctx, projectId, workspaceId, status) {
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  if (!STATUSES.includes(status)) throw new TypeError('Unknown status');
  return patchWorkspaceMeta(workspace, { status });
}

async function setWorkspaceContext(ctx, projectId, workspaceId, entries) {
  const { workspace } = findWorkspace(ctx, projectId, workspaceId);
  return patchWorkspaceMeta(workspace, { context: flatContext(entries) });
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
  await ctx.libraryDb.insert({ id, name: stem, type: 'note', path: file, project_id: projectId });
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
    return { file: path.join(workspace.dir, 'workspace.md') };
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
  writeTextAtomic(resolved.file, text);
  if (resolved.note) {
    await resolved.notesDb.touch(resolved.note.id);
    await ctx.libraryDb.touch(resolved.note.id);
  }
  return { lastEdited: nowIso() };
}

/* ------------------------------------------------------------- last opened */

// Where the app reopens: <dataRoot>/state.json { projectId, workspaceId }. Missing or stale ids
// fall back to the first project / workspace. (Files written before the layout change carry
// `topicId`, which is the same id.)
const STATE_FILE = 'state.json';
const idOrNull = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : null);

function readLastOpen(ctx) {
  const value = readJson(path.join(ctx.dataRoot, STATE_FILE), {}) || {};
  return { projectId: idOrNull(value.projectId), workspaceId: idOrNull(value.workspaceId) || idOrNull(value.topicId) };
}

function writeLastOpen(ctx, value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const next = { projectId: idOrNull(input.projectId), workspaceId: idOrNull(input.workspaceId) };
  writeJson(path.join(ctx.dataRoot, STATE_FILE), next);
  return next;
}

/* ---------------------------------------------------------------- text files */

// The browser pane's "file" mode: a path typed as ~/…, /… or relative to the project directory,
// read-only, kept inside the home directory, first 20 000 characters.
async function readProjectTextFile(ctx, projectId, input) {
  const project = findProject(ctx, projectId);
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0')) throw new TypeError('path is invalid');
  let target = input.trim();
  if (target.startsWith('~/')) target = path.join(ctx.homeDir, target.slice(2));
  else if (target === '~') target = ctx.homeDir;
  else if (!path.isAbsolute(target)) target = path.join(project.dir, target);
  const resolved = fs.realpathSync(path.resolve(target));
  const homeReal = fs.realpathSync(ctx.homeDir);
  if (resolved !== homeReal && !resolved.startsWith(homeReal + path.sep)) throw new Error('Only files inside your home directory can be opened');
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
  setWorkspaceStatus,
  setWorkspaceContext,
  createNote,
  renameNote,
  saveImage,
  readImage,
  readDoc,
  writeDoc,
  readProjectTextFile,
  readLastOpen,
  writeLastOpen,
};
