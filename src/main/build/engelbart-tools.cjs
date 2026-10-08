'use strict';

// Engelbart's own tools for a Build's agent (2026-10-07, "Bart build agents": a Build "should explicitly be able to save
// files, duplicate files, or move a file into Engelbart"). Served to Claude Code and Codex as the MCP server `engelbart`
// by ./engelbart-mcp.cjs, over the loopback bridge the run step uses (../sandbox/local-tools.cjs openToolBridge), one
// bridge a turn. A file the agent writes into an Engelbart folder itself is not in the library; these put it there,
// the way the person's own adding does:
//   save_file                 text the agent wrote → a note of the project (Markdown), or a file of a format the library
//                             reads, kept under <data root>/assets/files
//   duplicate_file            a library item → a copy of its own (a note → a note, a paper → a paper)
//   move_file_into_engelbart  a file on this Mac → kept by Engelbart (a pdf or a picture as a saved copy, Markdown as a
//                             note, any other format the library reads under assets/files); the file where it was is
//                             then removed, unless it is the person's (their folder, an Engelbart folder) or asked kept
// Each new item is linked to the Build's workspace, so it is on its sidebar. Nothing here deletes or changes an item the
// library already holds (./keep.cjs).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const SAVE_FORMATS = Object.freeze(['md', 'html', 'csv', 'tsv', 'json', 'jsonl']);
const MAX_TEXT = 100_000; // what save_file takes: the bridge carries 128 KB a call
const MAX_NOTE = 5 * 1024 * 1024;
const MAX_FILE = 200 * 1024 * 1024;
const COPIED_IMAGES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENGELBART_TOOLS = [
  { name: 'save_file', description: 'Save something you wrote into the person\'s Engelbart library, where they see it beside their notes and papers. format "md" (the default) makes a note of this project; html, csv, tsv, json and jsonl make a file Engelbart keeps. name: what the library calls it. content: the text, up to about 100 KB (for more, write the file and use move_file_into_engelbart). The new item is linked to this Build\'s workspace. Returns the item: id, name, type, path.', inputSchema: schema({ name: text, content: text, format: { type: 'string', enum: [...SAVE_FORMATS] } }, ['name', 'content']) },
  { name: 'duplicate_file', description: 'Make a copy of an item in the person\'s Engelbart library, as an item of its own (a note becomes a new note, a paper a new paper). item: the item\'s id, or the path of its file (as <context_json> gives them). name: what the copy is called (default: the name with " copy"). Folders, repositories and web pages cannot be copied. Returns the new item.', inputSchema: schema({ item: text, name: text }, ['item']) },
  { name: 'move_file_into_engelbart', description: 'Move a file on this Mac into the person\'s Engelbart library: a paper you downloaded, a figure or a dataset you made. A pdf or a picture is kept as Engelbart\'s own copy, Markdown becomes a note of this project, html, csv, tsv, json, jsonl, docx, xlsx, parquet, heic and svg are kept as files. path: absolute, ~/…, or relative to your working directory. The file where it was is then removed, unless keep_original is true or it is the person\'s (their own folder, an Engelbart folder). The new item is linked to this Build\'s workspace. Returns the item and what became of the original.', inputSchema: schema({ path: text, name: text, keep_original: { type: 'boolean' } }, ['path']) },
];

/** Arguments as a tool's schema says, or an error. */
function validateEngelbartTool(name, args) {
  const tool = ENGELBART_TOOLS.find((entry) => entry.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown Engelbart tool');
  const { properties, required } = tool.inputSchema;
  if (required.some((key) => !Object.hasOwn(args, key)) || Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw new Error('Invalid tool arguments');
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key];
    if (type.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error(`${key} must be a ${type.type}`);
    if (type.enum && !type.enum.includes(value)) throw new Error(`${key} must be one of ${type.enum.join(', ')}`);
    if (typeof value === 'string' && (value.includes('\0') || (key !== 'content' && value.length > 4096))) throw new Error(`${key} is not valid`);
  }
  return args;
}

const inside = (base, target) => !!base && (target === base || target.startsWith(`${base}${path.sep}`));
const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const stem = (file) => path.basename(file, path.extname(file));
const shown = (row) => ({ id: row.id, name: row.name, type: row.type, path: row.path || null });

/**
 * The tools for one turn of one Build. `task`: its record (workspaceId, cwd, worktree, repo, source); `inspectPdf`: what
 * tags a pdf (a paper or not); `onAdded(row)`: a row was made (the sidebar reads the library again). → call(name, args)
 */
function createEngelbartTools({ ctx, projectId, task, inspectPdf = null, onAdded = () => {} }) {
  const projects = require('../store/projects.cjs');
  const library = require('../store/library.cjs');
  const { sanitizeName } = require('../store/home.cjs');
  const home = ctx.homeDir || os.homedir();

  /** A path the agent gave: absolute, ~/…, file://…, or relative to its working directory. */
  function where(value) {
    let file = value.trim();
    if (/^file:\/\//i.test(file)) file = fileURLToPath(file);
    if (file === '~' || file.startsWith('~/')) file = path.join(home, file.slice(1));
    return path.resolve(task.cwd || task.worktree || home, file);
  }

  /** A new folder for one kept file, under <data root>/assets/files. */
  function keptFile(name, extension) {
    const dir = path.join(ctx.dataRoot, 'assets', 'files', randomUUID());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = sanitizeName(name).replace(new RegExp(`\\${extension}$`, 'i'), '') || 'Untitled';
    return path.join(dir, `${base}${extension}`);
  }

  /** The row made: linked to the workspace, announced. */
  async function made(row) {
    if (task.workspaceId) { try { await projects.linkToWorkspace(ctx, projectId, task.workspaceId, [row.id]); } catch { /* the workspace went meanwhile */ } }
    try { onAdded(row); } catch { /* nobody listening */ }
    return row;
  }

  async function note(name, body) {
    const created = await projects.createNote(ctx, projectId, { name, workspaceId: task.workspaceId || null, text: body });
    return (await ctx.libraryDb.get(created.id)) || { id: created.id, name: created.name, type: 'md', path: path.join(projects.findProject(ctx, projectId).dir, created.path) };
  }

  /** `source` kept by Engelbart as a new row named `name`. */
  async function keep(source, name) {
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error(`${source} is not a file`);
    if (stat.size > MAX_FILE) throw new Error('The file is larger than 200 MB');
    const extension = path.extname(source).toLowerCase();
    const type = library.FILE_TYPES.get(extension);
    if (!type) throw new Error(`Engelbart does not keep ${extension || 'files without an extension'} yet (it reads ${[...new Set(library.FILE_TYPES.keys())].join(' ')})`);
    if (type === 'md') {
      if (stat.size > MAX_NOTE) throw new Error('A note is at most 5 MB');
      return note(name || stem(source), fs.readFileSync(source, 'utf8'));
    }
    if (type === 'pdf' || COPIED_IMAGES[extension]) {
      const buffer = fs.readFileSync(source);
      return library.addFileCopy(ctx, { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), mime: type === 'pdf' ? 'application/pdf' : COPIED_IMAGES[extension], name: name || stem(source) }, { inspectPdf });
    }
    const file = keptFile(name || stem(source), extension);
    fs.copyFileSync(source, file, fs.constants.COPYFILE_FICLONE);
    try {
      return await library.addItem(ctx, file, { inspectPdf, name: name || stem(source) });
    } catch (error) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      throw error;
    }
  }

  async function saveFile({ name, content, format = 'md' }) {
    if (content.length > MAX_TEXT) throw new Error('content is at most 100 KB: write the file and use move_file_into_engelbart');
    if (format === 'md') return shown(await made(await note(name, content)));
    const file = keptFile(name, `.${format}`);
    fs.writeFileSync(file, content, { mode: 0o600 });
    try {
      return shown(await made(await library.addItem(ctx, file, { inspectPdf, name })));
    } catch (error) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      throw error;
    }
  }

  async function duplicateFile({ item, name }) {
    const rows = await ctx.libraryDb.list();
    const wanted = UUID_RE.test(item.trim()) ? null : real(where(item));
    const row = wanted ? rows.find((each) => each.path && real(each.path) === wanted) : rows.find((each) => each.id === item.trim());
    if (!row) throw new Error(`${item} is not an item of the library (to bring a file in, use move_file_into_engelbart with keep_original)`);
    if (!row.path) throw new Error(`“${row.name}” has no file of its own (a folder, a repository or a web page) and cannot be copied`);
    return shown(await made(await keep(row.path, name || `${row.name} copy`)));
  }

  async function moveFile({ path: given, name, keep_original: keepOriginal = false }) {
    const source = where(given);
    if (!fs.existsSync(source)) throw new Error(`Nothing is at ${source}`);
    const resolved = real(source);
    const held = (await ctx.libraryDb.list()).find((row) => row.path && real(row.path) === resolved);
    if (held) throw new Error(`${source} is already in the library as “${held.name}” (use duplicate_file for a copy)`);
    const row = await made(await keep(source, name || null));
    let original = 'kept, as asked';
    if (!keepOriginal) {
      const worktree = task.worktree ? real(task.worktree) : null;
      const theirs = [task.repo, task.source].filter(Boolean).map(real);
      if (!inside(worktree, resolved) && theirs.some((dir) => inside(dir, resolved))) original = 'kept: it is in the person\'s own folder';
      else if (!inside(worktree, resolved) && inside(real(ctx.dataRoot), resolved)) original = 'kept: it is in an Engelbart folder';
      else {
        try { fs.unlinkSync(source); original = 'removed'; } catch (error) { original = `kept: it could not be removed (${error.code || error.message})`; }
      }
    }
    return { ...shown(row), original };
  }

  return async function call(name, args) {
    validateEngelbartTool(name, args);
    if (name === 'save_file') return saveFile(args);
    if (name === 'duplicate_file') return duplicateFile(args);
    return moveFile(args);
  };
}

module.exports = { ENGELBART_TOOLS, SAVE_FORMATS, validateEngelbartTool, createEngelbartTools };
