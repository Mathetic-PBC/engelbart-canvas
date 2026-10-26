'use strict';

// The Stage tool of Claude Code and Codex started in Engelbart's terminal (MATH-79, 2026-10-26): open_on_stage shows the
// person a web page, a local app, a pdf or another file on the Stage of the window that owns the terminal session, beside
// their notes. Served as `engelbart-stage` (./stage-mcp.cjs through ../sandbox/local-mcp.cjs), one bridge per session
// (./stage-bridges.cjs). Nothing it opens is added to the library: a file from the computer opens as one picked from it
// does, and + Save is how it would be kept.
//
// `target` is, in this order: a library item's id; a library item's exact name, this window's project first, then the
// rest of the library (the split store/elsewhere.cjs makes for the @ menu: what the project holds, store/projects.cjs
// holder, then what it does not); a path that exists (absolute, ~/…, file://…, or from the session's working
// directory), a library row's file opening as the row; else a web address.
//
// search_library (2026-10-26) is how the agent finds a library item it knows only part of the name of: names and file
// names, never what the items say. It answers each one's id, to open by, and its file or address, which the agent can
// read with its own tools when it wants what is inside.

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { shownKind, SHOWN, readFailure } = require('../stage/files.cjs');
const { mcpContent } = require('../sandbox/local-tools.cjs');

const NAME = 'open_on_stage';
const SEARCH = 'search_library';
const MAX_TARGET = 4096;
const MAX_QUERY = 512;
const SEARCH_LIMIT = 20;

const STAGE_TOOLS = Object.freeze([{
  name: NAME,
  description: 'Show the person a web page, a local app (such as a dev server at http://localhost:3000), a PDF or another file on Engelbart\'s Stage, beside their notes. It does not add anything to their library.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'A web address (http://localhost:3000 and other local dev servers too), a file path (absolute, ~/…, file://…, or relative to this terminal\'s working directory), or a library item\'s id or exact name (search_library finds one by part of its name).' },
    },
    required: ['target'],
    additionalProperties: false,
  },
}, {
  name: SEARCH,
  description: 'Find items in the person\'s Engelbart library (papers, saved pages, files, notes) by part of their name or file name. Answers each one\'s name, kind, project, the day it was added, its id (open it with open_on_stage) and its file or web address (read it with your own tools if you need what it says).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words from the item\'s name or file name, in any case and order, such as "tutor trace".' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}]);

// What the agent is told it can do (requirement 4): Claude Code's --append-system-prompt, Codex's developer_instructions.
const STAGE_NOTE = 'You are running inside Engelbart, a research app the person is looking at while they work with you. The open_on_stage tool shows them a web page, a local app (such as the dev server you just started) or a file (a paper, a page you made) on Engelbart\'s Stage, beside their notes; use it on your own whenever showing the thing would help. search_library finds things in their Engelbart library by part of the name; open one by its id, or read its file yourself.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEB = /^https?:\/\//i;
const FILE_URL = /^file:\/\//i;
const PATH_LIKE = /^(?:\/|~(?:\/|$)|\.{1,2}(?:\/|$))/;
// This machine, by name or address, with a port and a path or not: what a dev server prints (0.0.0.0 is where it listens).
const LOCAL = /^(?:localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
// A name the web could resolve, dotted with a lettered last label: example.com, arxiv.org/abs/…
const HOST = /^(?:[a-z0-9-]+\.)+(?=[a-z0-9-]*[a-z])[a-z0-9-]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** A tool's arguments as the bridge got them → { target } or { query }, or a reason they are not right. */
function validateStageTool(name, args) {
  if (name !== NAME && name !== SEARCH) throw new Error(`Unknown tool: ${name}`);
  const key = name === NAME ? 'target' : 'query';
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError(`${name} takes { ${key} }`);
  const unknown = Object.keys(args).filter((other) => other !== key);
  if (unknown.length) throw new TypeError(`${name} does not take ${unknown.join(', ')}`);
  if (name === SEARCH) {
    const { query } = args;
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must be words from a library item\'s name');
    if (query.length > MAX_QUERY || query.includes('\0')) throw new TypeError('query is too long');
    return { query: query.trim() };
  }
  const { target } = args;
  if (typeof target !== 'string' || !target.trim()) throw new TypeError('target must be a web address, a file path or a library item\'s name');
  if (target.length > MAX_TARGET || target.includes('\0')) throw new TypeError('target is not a valid address or path');
  return { target: target.trim() };
}

const real = (file) => { try { return fs.realpathSync(file); } catch { return null; } };
const quoted = (rows) => rows.map((row) => `"${row.name}" (${row.id})`).join(', ');

/** Where a path the agent gave is: file://, ~ and a path relative to the session's working directory resolved. */
function pathOf(target, { cwd, homeDir }) {
  if (FILE_URL.test(target)) {
    try { return fileURLToPath(target); } catch { throw new Error(`${target} is not a file address.`); }
  }
  if (target === '~') return homeDir;
  if (target.startsWith('~/')) return path.join(homeDir, target.slice(2));
  return path.resolve(cwd, target);
}

/**
 * What `target` opens: { kind: 'item', row } | { kind: 'file', path } | { kind: 'address', address }, or an Error whose
 * message the agent is told. `all`: every library row; `here`: those this window's project holds.
 */
function resolveTarget(target, { cwd, homeDir, all, here }) {
  if (UUID_RE.test(target)) {
    const row = all.find((candidate) => candidate.id.toLowerCase() === target.toLowerCase());
    if (row) return { kind: 'item', row };
  }
  const own = new Set(here.map((row) => row.id));
  const levels = [all.filter((row) => own.has(row.id)), all.filter((row) => !own.has(row.id))];
  for (const [i, level] of levels.entries()) {
    const named = level.filter((row) => row.name === target);
    if (named.length === 1) return { kind: 'item', row: named[0] };
    if (named.length > 1) throw new Error(`Several library items ${i === 0 ? 'in this project' : 'in the library'} are named "${target}": ${quoted(named)}. Give the id of the one to open.`);
  }

  if (WEB.test(target)) return { kind: 'address', address: target };
  if (LOCAL.test(target)) return { kind: 'address', address: `http://${target}` };
  const pathLike = FILE_URL.test(target) || PATH_LIKE.test(target);
  if (!pathLike && SCHEME.test(target)) throw new Error(`${target.split(':')[0]}: addresses do not open on the Stage; it opens http and https addresses, files and library items.`);
  const file = pathOf(target, { cwd, homeDir });
  let there = false;
  try { fs.lstatSync(file); there = true; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw readFailure(error); }
  if (!there) {
    if (!pathLike && HOST.test(target)) return { kind: 'address', address: `https://${target}` };
    throw new Error(pathLike ? `Nothing is at ${file}.` : `Nothing is at ${file}, and "${target}" is not a web address or the name of anything in the library. To find a library item by part of its name, use search_library.`);
  }
  const resolved = real(file);
  if (!resolved) throw new Error(`Nothing is at ${file}.`);
  const home = real(homeDir) || homeDir;
  if (resolved !== home && !resolved.startsWith(home + path.sep)) throw new Error('The Stage opens files inside the home directory only.');
  // A library row's own file opens as the row, its ink and its name with it.
  const base = path.basename(resolved);
  const row = all.find((candidate) => (candidate.path && path.basename(candidate.path) === base && real(candidate.path) === resolved)
    || (candidate.folder_path && path.basename(candidate.folder_path) === base && real(candidate.folder_path) === resolved));
  if (row) return { kind: 'item', row };
  if (shownKind(resolved) === 'unsupported') {
    const ext = path.extname(resolved).toLowerCase();
    throw new Error(`The Stage does not show ${ext ? `${ext} files` : 'this kind of file'}. It shows ${SHOWN}.`);
  }
  return { kind: 'file', path: resolved };
}

const isNote = (row) => Array.isArray(row.tags) && row.tags.includes('note');

// Case, spaces and punctuation aside: "tutor trace" is in "TutorTrace: Tracing…" and in tutor-trace.pdf.
const fold = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const wordsOf = (query) => String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const addedAt = (row) => { const at = new Date(row.created).getTime(); return Number.isFinite(at) ? at : 0; };

/**
 * The rows whose name or file name holds every word of `query`: this window's project's (`here`) first, an exact name
 * before the rest, the newest first → { rows (at most `limit`), total, own (the ids `here` holds) }.
 */
function searchLibrary(query, { all, here, limit = SEARCH_LIMIT }) {
  const words = wordsOf(query);
  const own = new Set(here.map((row) => row.id));
  if (!words.length) return { rows: [], total: 0, own };
  const exact = fold(query);
  const text = (row) => [row.name, row.path && path.basename(row.path), row.folder_path && path.basename(row.folder_path)].map(fold).join(' ');
  const matched = all.filter((row) => { const haystack = text(row); return words.every((word) => haystack.includes(word)); });
  const rank = (row) => (own.has(row.id) ? 0 : 2) + (fold(row.name) === exact ? 0 : 1);
  matched.sort((a, b) => rank(a) - rank(b) || addedAt(b) - addedAt(a));
  return { rows: matched.slice(0, limit), total: matched.length, own };
}

/** One result, for the agent: what it is, where it lives, what to open it by and where its contents are. */
function describeRow(row, { here, projectName }) {
  const kind = isNote(row) ? 'note' : (row.type || 'item');
  const where = here ? 'this project' : projectName ? `project "${projectName}"` : 'the library, in no project of this window';
  const added = addedAt(row) ? `, added ${new Date(addedAt(row)).toISOString().slice(0, 10)}` : '';
  const at = [row.path && `file ${row.path}`, row.folder_path && `folder ${row.folder_path}`, row.url && `address ${row.url}`].filter(Boolean);
  return `- "${row.name}" (${kind}, ${where}${added}) id ${row.id}; ${at.length ? at.join('; ') : 'nothing to open'}`;
}

/** What search_library answers. */
function searchAnswer(query, found, projectName) {
  if (!found.total) return `Nothing in the library has "${query}" in its name or file name.`;
  const shown = found.rows.length < found.total ? ` (the first ${found.rows.length}; more words narrow it)` : '';
  const lines = found.rows.map((row) => describeRow(row, { here: found.own.has(row.id), projectName: projectName(row.project_id) }));
  return [`${found.total} in the library match "${query}"${shown}:`, ...lines].join('\n');
}

/** What the agent hears once it opened. A note opens where the sidebar opens it, beside the document, not on the Stage. */
function opened(found) {
  if (found.kind === 'item' && isNote(found.row)) return `Opened the note "${found.row.name}" in Engelbart, beside the person's document (notes open there, not on the Stage).`;
  if (found.kind === 'item') return `Opened the library item "${found.row.name}" on Engelbart's Stage.`;
  if (found.kind === 'file') return `Opened the file ${found.path} on Engelbart's Stage. It was not added to the library.`;
  return `Opened the page ${found.address} on Engelbart's Stage.`;
}

/**
 * One session's tool: (name, args, { cwd }) → the MCP answer, `cwd` where the agent's server runs (a relative path is from
 * there; else from the session's own directory). `session()` → { id, cwd } once the session started, else null;
 * `owner(id)` → the open window context that holds it, else null; `context()` → main's store context (its libraryDb, its
 * homeDir); `projectItems(ctx, projectId)` → the rows that project holds (store/library.cjs libraryForProject);
 * `projectName(ctx, projectId)` → that project's name, else null;
 * `deliver(win, payload)` → whether that window took { projectId, kind, row | path | address }.
 */
function stageToolFor({ session, owner, context, projectItems, deliver, projectName = () => null }) {
  return async (name, args, from = {}) => {
    const { target, query } = validateStageTool(name, args);
    const current = session();
    if (!current) throw new Error('This terminal session has not started yet.');
    const win = owner(current.id);
    if (name === SEARCH) {
      // The whole library; the window's project, when it shows one, first.
      const ctx = await context();
      const projectId = win && win.place && win.place.projectId;
      const found = searchLibrary(query, { all: await ctx.libraryDb.list(), here: projectId ? await projectItems(ctx, projectId) : [] });
      return mcpContent([{ type: 'text', text: searchAnswer(query, found, (id) => (id ? projectName(ctx, id) : null)) }]);
    }
    if (!win) throw new Error('The Engelbart window this terminal belongs to is closed, so there is no Stage to open it on.');
    const projectId = win.place && win.place.projectId;
    if (!projectId) throw new Error('The Engelbart window this terminal belongs to is showing All projects, not a project, so it has no Stage to open it on.');
    if (!win.stageListeners) throw new Error('The Engelbart window this terminal belongs to is not showing a Stage right now.');
    const ctx = await context();
    const all = await ctx.libraryDb.list();
    const here = await projectItems(ctx, projectId);
    const cwd = typeof from.cwd === 'string' && path.isAbsolute(from.cwd) && !from.cwd.includes('\0') ? from.cwd : current.cwd;
    const found = resolveTarget(target, { cwd, homeDir: ctx.homeDir, all, here });
    if (found.kind === 'item' && !isNote(found.row) && !(found.row.url || found.row.path || found.row.folder_path)) {
      throw new Error(`"${found.row.name}" has no page or file the Stage can show.`);
    }
    const payload = found.kind === 'item' ? { projectId, kind: 'item', row: found.row }
      : found.kind === 'file' ? { projectId, kind: 'file', path: found.path }
        : { projectId, kind: 'address', address: found.address };
    if (!deliver(win, payload)) throw new Error('The Engelbart window this terminal belongs to is not showing its Stage right now.');
    return mcpContent([{ type: 'text', text: opened(found) }]);
  };
}

module.exports = { STAGE_TOOLS, STAGE_NOTE, validateStageTool, resolveTarget, searchLibrary, stageToolFor };
