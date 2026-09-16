'use strict';

// Projects, goals and topics are directories; notes are flat markdown files in the
// project directory, indexed by the project's notes table and mirrored in the root
// library (spec §3). `ctx.dataRoot` is ~/.engelbart (test off) or ~/.engelbart/test (test on).
//
//   <dataRoot>/<slug>/project.json                { id, name, created }
//   <dataRoot>/<slug>/notes.pglite/
//   <dataRoot>/<slug>/<Note>.md
//   <dataRoot>/<slug>/<Goal>/meta.json            { id, box, created }
//   <dataRoot>/<slug>/<Goal>/future.md            "- idea" per line
//   <dataRoot>/<slug>/<Goal>/<Topic>/meta.json    { id, status, context, created }
//   <dataRoot>/<slug>/<Goal>/<Topic>/workspace.md
//
// A topic's `context` is a tree: entries are library ids (strings) or folders
// `{ id, name, children: [entries] }` (the design's + Folder).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sanitizeName, slugify, uniqueName, readJson, writeJson, DIR_MODE } = require('./home.cjs');
const db = require('./db.cjs');

const BOXES = Object.freeze(['current', 'experimental', 'past']);
const STATUSES = Object.freeze(['open', 'progress', 'done']);
const RESERVED = new Set(['annotations', 'seed', 'test']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TREE_ENTRIES = 500;
const MAX_TREE_DEPTH = 6;

const WELCOME_NOTE = [
  'This is a note. Notes are plain markdown files in your project folder, and the sidebar lists what this topic can see.',
  '',
  '- [ ] Write a todo, then press Build',
  '- [ ] Type @ to mention a paper, dataset or note from your library',
  '- [ ] Type @chat, a question, and press Enter',
  '',
  'The Workspace tab is this topic\'s own document. Add papers, folders and notes from the sidebar with + Context and + Folder.',
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

function projectRecord(dir) {
  const meta = readJson(path.join(dir, 'project.json'));
  if (!meta || typeof meta.id !== 'string') return null;
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name : path.basename(dir);
  return { id: meta.id, name, slug: path.basename(dir), dir, created: meta.created || null };
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
  return { id: project.id, name: project.name, slug: project.slug, dir: project.dir, created: project.created, ...extra };
}

async function listProjects(ctx) {
  return projectRecords(ctx)
    .map((project) => publicProject(project, { goalCount: goalRecords(project.dir).length, lastEdited: latestMtime(project.dir) || project.created }))
    .sort((a, b) => String(b.lastEdited || '').localeCompare(String(a.lastEdited || '')));
}

// `path` is the directory name under the data root, as the create screen shows it after "./".
function resolveSlug(ctx, name, requested) {
  const raw = typeof requested === 'string' && requested.trim() ? requested : name;
  const slug = slugify(raw) || 'engelbart';
  return uniqueName(ctx.dataRoot, slug);
}

async function createProject(ctx, input) {
  const options = typeof input === 'string' ? { name: input } : (input || {});
  const name = sanitizeName(options.name);
  const slug = resolveSlug(ctx, name, options.path);
  const dir = path.join(ctx.dataRoot, slug);
  fs.mkdirSync(dir, { mode: DIR_MODE });
  const meta = { id: randomUUID(), name, created: nowIso() };
  writeJson(path.join(dir, 'project.json'), meta);
  await db.openNotesDb(dir);
  return publicProject(projectRecord(dir), { goalCount: 0, lastEdited: meta.created });
}

// First-run flow: the project, a first goal and topic, and a "Welcome!" note open in the
// topic's context (spec §2 #17, request of 2026-09-16).
async function createProjectWithWelcome(ctx, input) {
  const project = await createProject(ctx, input);
  const goal = await createGoal(ctx, project.id, { name: 'First steps', box: 'current' });
  const topic = await createTopic(ctx, project.id, goal.id, 'Getting started');
  const note = await createNote(ctx, project.id, { name: 'Welcome!', goalId: goal.id, topicId: topic.id, text: WELCOME_NOTE });
  await setTopicContext(ctx, project.id, goal.id, topic.id, [note.id]);
  return { project, goalId: goal.id, topicId: topic.id, noteId: note.id, noteName: note.name };
}

async function renameProject(ctx, id, name) {
  const project = findProject(ctx, id);
  const next = sanitizeName(name);
  if (next === project.name) return publicProject(project, { goalCount: goalRecords(project.dir).length, lastEdited: latestMtime(project.dir) });
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
      await ctx.libraryDb.rewritePathPrefix(dir + path.sep, target + path.sep);
      dir = target;
    }
  }
  const renamed = projectRecord(dir);
  return publicProject(renamed, { goalCount: goalRecords(dir).length, lastEdited: latestMtime(dir) });
}

/* --------------------------------------------------------------------- goals */

function goalRecord(dir) {
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta || typeof meta.id !== 'string' || !BOXES.includes(meta.box)) return null;
  return { id: meta.id, name: path.basename(dir), box: meta.box, dir, created: meta.created || null };
}

function goalRecords(projectDir) {
  return subdirs(projectDir).map(goalRecord).filter(Boolean).sort(byCreated);
}

function findGoal(ctx, projectId, goalId) {
  const project = findProject(ctx, projectId);
  assertId(goalId, 'goal');
  const goal = goalRecords(project.dir).find((candidate) => candidate.id === goalId);
  if (!goal) throw new Error('Unknown goal');
  return { project, goal };
}

function readFuture(goalDir) {
  try {
    return fs.readFileSync(path.join(goalDir, 'future.md'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/^\s*[-–]\s?/, '').trimEnd())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function writeFuture(goalDir, ideas) {
  const text = ideas.map((idea) => `- ${idea}`).join('\n');
  writeTextAtomic(path.join(goalDir, 'future.md'), text ? `${text}\n` : '');
}

async function createGoal(ctx, projectId, { name, box }) {
  const project = findProject(ctx, projectId);
  if (!BOXES.includes(box)) throw new TypeError('Unknown box');
  const dir = path.join(project.dir, uniqueName(project.dir, sanitizeName(name || 'Goal')));
  fs.mkdirSync(dir, { mode: DIR_MODE });
  writeJson(path.join(dir, 'meta.json'), { id: randomUUID(), box, created: nowIso() });
  return publicGoal(goalRecord(dir));
}

async function renameGoal(ctx, projectId, goalId, name) {
  const { project, goal } = findGoal(ctx, projectId, goalId);
  const base = sanitizeName(name);
  if (base === goal.name) return publicGoal(goal);
  const next = path.join(project.dir, uniqueName(project.dir, base));
  fs.renameSync(goal.dir, next);
  return publicGoal(goalRecord(next));
}

async function setFuture(ctx, projectId, goalId, ideas) {
  const { goal } = findGoal(ctx, projectId, goalId);
  if (!Array.isArray(ideas) || ideas.some((idea) => typeof idea !== 'string' || idea.includes('\n') || idea.length > 2000)) {
    throw new TypeError('ideas must be an array of single-line strings');
  }
  writeFuture(goal.dir, ideas.map((idea) => idea.trim()).filter(Boolean));
  return readFuture(goal.dir);
}

function publicGoal(goal) {
  return { id: goal.id, name: goal.name, box: goal.box, created: goal.created };
}

/* -------------------------------------------------------------------- topics */

function topicRecord(dir) {
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta || typeof meta.id !== 'string' || !STATUSES.includes(meta.status)) return null;
  let context = [];
  try {
    context = validateTree(meta.context || []);
  } catch {
    context = [];
  }
  return { id: meta.id, name: path.basename(dir), status: meta.status, context, dir, created: meta.created || null };
}

function topicRecords(goalDir) {
  return subdirs(goalDir).map(topicRecord).filter(Boolean).sort(byCreated);
}

function findTopic(ctx, projectId, goalId, topicId) {
  const { project, goal } = findGoal(ctx, projectId, goalId);
  assertId(topicId, 'topic');
  const topic = topicRecords(goal.dir).find((candidate) => candidate.id === topicId);
  if (!topic) throw new Error('Unknown topic');
  return { project, goal, topic };
}

function publicTopic(topic) {
  return { id: topic.id, name: topic.name, status: topic.status, context: topic.context, created: topic.created };
}

async function createTopic(ctx, projectId, goalId, name) {
  const { goal } = findGoal(ctx, projectId, goalId);
  const dir = path.join(goal.dir, uniqueName(goal.dir, sanitizeName(name || 'Topic')));
  fs.mkdirSync(dir, { mode: DIR_MODE });
  writeJson(path.join(dir, 'meta.json'), { id: randomUUID(), status: 'open', context: [], created: nowIso() });
  writeTextAtomic(path.join(dir, 'workspace.md'), '');
  return publicTopic(topicRecord(dir));
}

async function renameTopic(ctx, projectId, goalId, topicId, name) {
  const { goal, topic } = findTopic(ctx, projectId, goalId, topicId);
  const base = sanitizeName(name);
  if (base === topic.name) return publicTopic(topic);
  const next = path.join(goal.dir, uniqueName(goal.dir, base));
  fs.renameSync(topic.dir, next);
  return publicTopic(topicRecord(next));
}

async function setTopicStatus(ctx, projectId, goalId, topicId, status) {
  const { topic } = findTopic(ctx, projectId, goalId, topicId);
  if (!STATUSES.includes(status)) throw new TypeError('Unknown status');
  const meta = readJson(path.join(topic.dir, 'meta.json'));
  writeJson(path.join(topic.dir, 'meta.json'), { ...meta, status });
  return publicTopic(topicRecord(topic.dir));
}

async function setTopicContext(ctx, projectId, goalId, topicId, entries) {
  const { topic } = findTopic(ctx, projectId, goalId, topicId);
  const context = validateTree(entries);
  const meta = readJson(path.join(topic.dir, 'meta.json'));
  writeJson(path.join(topic.dir, 'meta.json'), { ...meta, context });
  return publicTopic(topicRecord(topic.dir));
}

/* --------------------------------------------------------------------- notes */

function publicNote(row) {
  return { id: row.id, name: row.name, path: row.path, goalId: row.goal_id || null, topicId: row.topic_id || null, created: row.created, lastEdited: row.last_edited };
}

async function createNote(ctx, projectId, { name, goalId, topicId, text } = {}) {
  const project = findProject(ctx, projectId);
  if (goalId != null) assertId(goalId, 'goal');
  if (topicId != null) assertId(topicId, 'topic');
  const stem = uniqueName(project.dir, sanitizeName(name || 'Untitled note'), '.md');
  const file = path.join(project.dir, `${stem}.md`);
  writeTextAtomic(file, typeof text === 'string' ? text : '');
  const id = randomUUID();
  const notesDb = await db.openNotesDb(project.dir);
  const row = await notesDb.insert({ id, name: stem, path: `${stem}.md`, goal_id: goalId || null, topic_id: topicId || null });
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
    const { topic } = findTopic(ctx, projectId, ref.goalId, ref.topicId);
    return { file: path.join(topic.dir, 'workspace.md') };
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

/* --------------------------------------------------------------------- tree */

async function loadProject(ctx, projectId) {
  const project = findProject(ctx, projectId);
  const notesDb = await db.openNotesDb(project.dir);
  const notes = (await notesDb.list()).map(publicNote);
  const goals = goalRecords(project.dir).map((goal) => ({
    ...publicGoal(goal),
    topics: topicRecords(goal.dir).map(publicTopic),
    notes: notes.filter((note) => note.goalId === goal.id),
    future: readFuture(goal.dir),
  }));
  return { project: publicProject(project), goals, notes };
}

module.exports = {
  BOXES,
  STATUSES,
  WELCOME_NOTE,
  validateTree,
  treeIds,
  treeContains,
  listProjects,
  createProject,
  createProjectWithWelcome,
  renameProject,
  loadProject,
  createGoal,
  renameGoal,
  setFuture,
  createTopic,
  renameTopic,
  setTopicStatus,
  setTopicContext,
  createNote,
  renameNote,
  readDoc,
  writeDoc,
};
