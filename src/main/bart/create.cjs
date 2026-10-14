'use strict';

// @create's files (2026-10-13). Each run writes in a draft folder of its own, <dataRoot>/.create/<askId>/, made empty
// before the run and the agent's working directory: the only place it may write (./ask.cjs gives Claude Code Write and
// Edit there alone, and Codex a workspace-write sandbox rooted there). After a run that answered, the files it left are
// kept, at most five, each at most 20 MB and of a format the library reads (store/library.cjs FILE_TYPES). Then the draft
// folder is deleted; a run that was stopped or failed deletes it and keeps nothing.
// 2026-10-14: kept is no longer "in the library". The files go to <project>/.created/<askId>/, with the project's documents
// so the answer's rows (one `@[name](made:<askId>/<path>)` line per file, the editor's Create row), its expanded view and
// the Stage still open them after a restart. Only Save (saveCreated) puts one in the library, as a row whose source is
// `create` (the Library's Assets chip), linked to the workspace; which file was saved as which row is kept beside the files
// (SAVED_FILE). Nothing here changes or deletes a row the library already holds.

const fs = require('node:fs');
const path = require('node:path');

const CREATE_DIR = '.create';
const CREATED_DIR = '.created';
const SAVED_FILE = '.engelbart-saved.json';
const PREVIEWS_DIR = '.engelbart-previews';
const MAX_CREATED = 5;
const MAX_CREATED_BYTES = 20 * 1024 * 1024;
const CREATE_TIMEOUT_MS = 10 * 60_000;

/** Where an ask's draft folder is. */
function draftPath(dataRoot, askId) {
  if (typeof askId !== 'string' || !/^[\w-]+$/.test(askId)) throw new TypeError('ask id is invalid');
  return path.join(dataRoot, CREATE_DIR, askId);
}

/** The ask's draft folder, made empty (anything a run before it left is gone) → its real path, as the agent's tools see it. */
function openDraft(dataRoot, askId) {
  const dir = draftPath(dataRoot, askId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync(dir);
}

/** The draft folder gone, whatever is in it. */
function dropDraft(dir) {
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
}

/**
 * The files the run left, by name: plain files only, in the folder and any folder under it. A link (which could point
 * anywhere on the disk) is not followed and is skipped. → [{ file, rel, size }], or [{ rel, why }] for what is skipped.
 */
function draftFiles(dir) {
  const found = [], odd = [];
  const walk = (at) => {
    let names = [];
    try { names = fs.readdirSync(at).sort(); } catch { return; }
    for (const name of names) {
      const file = path.join(at, name), rel = path.relative(dir, file);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) found.push({ file, rel, size: stat.size });
      else odd.push({ rel, why: 'not a plain file' });
    }
  };
  walk(dir);
  return { found, odd };
}

/** A file's name as its row is named: the name it was written under, without its extension. */
const rowName = (file) => path.basename(file, path.extname(file)).trim() || 'Untitled';

/** A path inside the created folder as a row's token carries it (as the editor's doc.js encodeRel): each segment encoded. */
const encodeRel = (rel) => String(rel ?? '').split('/').filter((part) => part && part !== '.').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/** Where a run's kept files are: <project>/.created/<askId>/ (a dot folder: no listing of workspaces sees it). */
function createdDir(ctx, projectId, askId) {
  if (typeof askId !== 'string' || !/^[\w-]+$/.test(askId)) throw new TypeError('ask id is invalid');
  const { findProject } = require('../store/projects.cjs');
  return path.join(findProject(ctx, projectId).dir, CREATED_DIR, askId);
}

/** One kept file by its path in the run's folder: never outside it, never the saved list. → its absolute path */
function createdFile(ctx, projectId, askId, rel) {
  const dir = createdDir(ctx, projectId, askId);
  const parts = String(rel || '').split('/').filter(Boolean);
  if (!parts.length || /^[/\\]/.test(String(rel)) || parts.some((part) => part === '.' || part === '..' || part.includes('\0')) || parts[0] === SAVED_FILE || parts[0] === PREVIEWS_DIR) throw new TypeError('file is invalid');
  const file = path.join(dir, ...parts);
  if (!file.startsWith(dir + path.sep)) throw new TypeError('file is invalid');
  return file;
}

const readSaved = (dir) => { try { const held = JSON.parse(fs.readFileSync(path.join(dir, SAVED_FILE), 'utf8')); return held && typeof held === 'object' && !Array.isArray(held) ? held : {}; } catch { return {}; } };

/**
 * The draft folder's files kept in <project>/.created/<askId>/, under the paths they were written at.
 * → { files: [{ name, rel, type, size }], skipped: ['name: why'] }
 */
async function keepCreated(ctx, projectId, askId, dir) {
  const library = require('../store/library.cjs');
  const { found, odd } = draftFiles(dir);
  const files = [], skipped = odd.map(({ rel, why }) => `${rel}: ${why}`);
  const into = createdDir(ctx, projectId, askId);
  for (const { file, rel, size } of found) {
    const extension = path.extname(file).toLowerCase(), type = library.FILE_TYPES.get(extension);
    if (!type) { skipped.push(`${rel}: ${extension || 'no extension'} is not a format the library keeps`); continue; }
    if (size > MAX_CREATED_BYTES) { skipped.push(`${rel}: larger than 20 MB`); continue; }
    if (files.length >= MAX_CREATED) { skipped.push(`${rel}: past the ${MAX_CREATED} files Create keeps`); continue; }
    try {
      const to = path.join(into, ...rel.split(path.sep));
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file, to, fs.constants.COPYFILE_FICLONE);
      files.push({ name: path.basename(file), rel: rel.split(path.sep).join('/'), type, size });
    } catch (error) {
      skipped.push(`${rel}: ${String((error && error.message) || error).split('\n')[0].slice(0, 160)}`);
    }
  }
  return { files, skipped };
}

/** The line of the answer that stands for one kept file: the editor draws it as Create's row. */
const madeMention = (askId, file) => `@[${String(file.name || '').replace(/[[\]\n]/g, '').trim() || 'Untitled'}](made:${askId}/${encodeRel(file.rel)})`;

/**
 * The answer as the document keeps it: the sentence saying what it made, then one line per file kept (madeMention), then
 * what was skipped, if anything.
 */
function createdBody(text, { files, skipped }, askId) {
  return [
    String(text || '').trim(),
    files.length ? files.map((file) => madeMention(askId, file)).join('\n') : '',
    skipped.length ? `Not kept: ${skipped.join('; ')}.` : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * The sentence Create says first (2026-10-14): what it is making, the text of its first message, written before it reads or
 * writes anything (./create-system-prompt.cjs). Fed the run's updates (./activity.cjs claudeUpdate, codexUpdate): the text
 * of the first message is taken when a tool is used after it, another message starts, or (Codex) the message arrives
 * whole; `onSentence(text)` is told it once. A message that is the harness's ("ESCALATE: …") is not one.
 * → { take(update), text } (`text` '' until there is one)
 */
function firstSentence(onSentence = () => {}) {
  let text = '', done = false;
  const finish = () => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (done || !clean || /^ESCALATE:/.test(clean)) { text = ''; return; }
    done = true; text = clean;
    try { onSentence(clean); } catch { /* nobody listening */ }
  };
  return {
    take(update) {
      if (!update || done) return;
      if (update.textStart) { if (text.trim()) finish(); else text = ''; return; }
      if (typeof update.delta === 'string') { text += update.delta; return; }
      if (typeof update.text === 'string') { text = update.text; finish(); return; }
      if (update.activity && update.log) finish();
    },
    get text() { return done ? text : ''; },
  };
}

/**
 * The sentences above the rows: what it said it was making, then its last message when that says something more (not
 * "Done."), else the request as a sentence ("make a chart of X" → "A chart of X.").
 */
function createdSentence(first, last, request) {
  const said = [first, last].map((text) => String(text || '').trim()).filter((text) => text && !/^done\.?$/i.test(text) && !/^ESCALATE:/.test(text));
  const unique = said.filter((text, at) => said.indexOf(text) === at);
  if (unique.length) return unique.join('\n\n');
  return requestSentence(request);
}

/** A request as the sentence that says what is being made: its asking words off, a capital, a full stop. */
function requestSentence(request) {
  const text = String(request || '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:make|create|draw|build|write|generate|produce|put together|design)\s+(?:me\s+|us\s+)?/i, '')
    .replace(/[?.!\s]+$/, '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}.` : '';
}

/** The library row a kept file was saved as, while the library still holds it, else null. */
async function savedRow(ctx, projectId, askId, rel) {
  const id = readSaved(createdDir(ctx, projectId, askId))[rel];
  if (typeof id !== 'string') return null;
  return (await ctx.libraryDb.get(id)) || null;
}

/**
 * One kept file as the editor and the Stage show it: { name, rel, type, ext, path, size, saved: { id, name } | null,
 * missing }, and its text (a page, a drawing, a table, a document, at most 2 MB) or, for a picture or a pdf, its bytes.
 * A page's picture (`preview`, a png's bytes) comes with it when `snapshot(file, out)` is given (./created-preview.cjs),
 * kept in the run's folder (PREVIEWS_DIR); null when it could not be taken.
 */
async function readCreated(ctx, projectId, askId, rel, { snapshot = null } = {}) {
  const file = createdFile(ctx, projectId, askId, rel);
  const library = require('../store/library.cjs');
  const ext = path.extname(file).toLowerCase(), type = library.FILE_TYPES.get(ext) || 'file';
  const out = { name: path.basename(file), rel, type, ext: ext.slice(1), path: file, size: 0, saved: null, missing: false };
  let stat = null;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) return { ...out, missing: true };
  out.size = stat.size;
  const row = await savedRow(ctx, projectId, askId, rel);
  if (row) out.saved = { id: row.id, name: row.name };
  if (ext === '.svg' || (type !== 'image' && type !== 'pdf' && type !== 'parquet' && type !== 'xlsx' && type !== 'docx')) {
    if (stat.size <= 2 * 1024 * 1024) out.text = fs.readFileSync(file, 'utf8');
  } else if (stat.size <= MAX_CREATED_BYTES) {
    const buffer = fs.readFileSync(file);
    out.bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (type === 'html' && snapshot) {
    const shot = path.join(createdDir(ctx, projectId, askId), PREVIEWS_DIR, `${encodeRel(rel).replace(/\//g, '__')}.png`);
    try { const png = await snapshot(file, shot); out.preview = new Uint8Array(png.buffer, png.byteOffset, png.byteLength); } catch { out.preview = null; }
  }
  return out;
}

/**
 * Save: a kept file into the library, as a row of its own (Markdown a note of the library's own, a pdf or a picture a
 * copy, anything else under assets/files: ../build/engelbart-tools.cjs keepCopy), its source `create`, linked to
 * `workspaceId` and announced by `onAdded(row)`. Saved already (and still in the library): that row, nothing new. → the row
 */
async function saveCreated(ctx, projectId, workspaceId, askId, rel, { inspectPdf = null, onAdded = () => {} } = {}) {
  const library = require('../store/library.cjs');
  const { keepCopy, linkMade } = require('../build/engelbart-tools.cjs');
  const file = createdFile(ctx, projectId, askId, rel), dir = createdDir(ctx, projectId, askId);
  const held = await savedRow(ctx, projectId, askId, rel);
  if (held) return held;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('That file is gone');
  const type = library.FILE_TYPES.get(path.extname(file).toLowerCase());
  if (!type) throw new Error('The library does not keep that kind of file');
  const name = rowName(file);
  let row = type === 'md' ? await library.addMarkdownCopy(ctx, { name, text: fs.readFileSync(file, 'utf8') }) : await keepCopy(ctx, file, name, { inspectPdf });
  row = (await ctx.libraryDb.setSource(row.id, 'create')) || row;
  const saved = readSaved(dir);
  saved[rel] = row.id;
  fs.writeFileSync(path.join(dir, SAVED_FILE), JSON.stringify(saved, null, 2), { mode: 0o600 });
  return linkMade(ctx, projectId, workspaceId, row, onAdded);
}

module.exports = { CREATE_DIR, CREATED_DIR, SAVED_FILE, PREVIEWS_DIR, MAX_CREATED, MAX_CREATED_BYTES, CREATE_TIMEOUT_MS, draftPath, openDraft, dropDraft, draftFiles, createdDir, createdFile, keepCreated, madeMention, createdBody, firstSentence, createdSentence, requestSentence, readCreated, saveCreated };
