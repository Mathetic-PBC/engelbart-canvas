'use strict';

// A document as one text that stands on its own outside Engelbart: what the sidebar's Copy puts
// on the clipboard (2026-09-19). Every @[mentioned] file is placed directly under the line that
// mentions it, in <file> tags, once: at its first mention reading top to bottom. A note is
// included whole and brings its own mentions with it. Anything else (a pdf, a website, a
// repository, a folder, a data file) is included as where it is plus its catalog summary when the sweep has
// written one; a paper's text can run to hundreds of thousands of characters, its abstract cannot.
// A mentioned workspace (`@[Name](ws:<id>)`, 2026-09-25) is included as a note is: its document, whole, under its
// current name. A mention that leads nowhere says so where it stands. A pasted image becomes the path of its
// file, which means something outside the app; img:<id> does not.
// An item of the connected Zotero library (`@[Title](zotero:<itemKey>)`, MATH-65 build 2) is its <zotero_item> block
// (zotero/mirror.cjs itemBlock): its metadata, BibTeX, notes and annotations, and where its file is.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('../store/projects.cjs');
const buildStore = require('../build/store.cjs');
const { fileInRow } = require('../store/folder-files.cjs');
const zoteroMirror = require('../zotero/mirror.cjs');

// A Build's line (`build> <id>`, 2026-09-25) is a card drawn from its record: outside the app it reads as what the card says.
const BUILD_LINE_RE = /^build> ([0-9a-f]{10})$/;
function buildLines(text, project) {
  return String(text || '').split('\n').map((line) => {
    const m = BUILD_LINE_RE.exec(line.trim());
    const task = m && project ? buildStore.readTask(project, m[1]) : null;
    return task ? `Build "${task.title}" (${task.status})` : line;
  }).join('\n');
}

// The editor's inline tokens (src/renderer/model/doc.js), so a mention inside `code` stays text
// here as it does on screen. test/expand-mentions.test.cjs holds the two together.
const INLINE = /(!\[[^\]\n]*\]\(img:[\w-]+\)|@(?:[Bb]art|[Bb]rainstorm|[Oo]rient|[Dd]iscover)(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]\(ws:[\w-]+\)|@\[[^\]\n]+\]\(lib:[\w-]+(?::[\w.~%\/-]+)?\)|@\[[^\]\n]+\]\(zotero:[A-Za-z0-9]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`])/g;
const IMAGE_TOKEN = /^!\[([^\]\n]*)\]\(img:([\w-]+)\)$/;
const WS_TOKEN = /^@\[([^\]\n]+)\]\(ws:([\w-]+)\)$/; // another workspace of the project (doc.js WS_MENTION_RE)
// A library item by id (doc.js LIB_MENTION_RE), and a file inside a library folder by the folder's id and its path in it,
// percent-encoded a segment at a time (doc.js FILE_MENTION_RE, MATH-22).
const LIB_TOKEN = /^@\[([^\]\n]+)\]\(lib:([\w-]+)\)$/;
const FILE_TOKEN = /^@\[([^\]\n]+)\]\(lib:([\w-]+):([\w.~%/-]+)\)$/;
// An item of the connected Zotero library by its key (doc.js ZOTERO_MENTION_RE, MATH-65 build 2).
const ZOTERO_TOKEN = /^@\[([^\]\n]+)\]\(zotero:([A-Za-z0-9]+)\)$/;
/** The key a mentioned Zotero item's file is kept under in `seen` (bart/context.cjs grants its folder). */
const zoteroFileKey = (file) => `zfile:${file}`;
const decodeRel = (rel) => String(rel).split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join('/');
/** The key a mentioned file is kept under in `seen` (bart/context.cjs mentionedFiles reads them back). */
const fileKey = (folderId, rel) => `file:${folderId}:${rel}`;
const BART_NAME = /^bart/i; // the editor shows @[bart…] as the question agent, never as a file

const isNote = (row) => Array.isArray(row.tags) && row.tags.includes('note'); // an md from outside the project is not read through the notes table
const attr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const bare = (text) => String(text == null ? '' : text).replace(/\r/g, '').replace(/^\n+/, '').trimEnd();

function openTag(row) {
  const parts = [`name="${attr(row.name)}"`, `type="${attr(row.type)}"`];
  if (Array.isArray(row.tags) && row.tags.length) parts.push(`tags="${attr(row.tags.join(' '))}"`);
  if (row.path) parts.push(`path="${attr(row.path)}"`);
  if (row.folder_path) parts.push(`folder="${attr(row.folder_path)}"`);
  if (row.url) parts.push(`url="${attr(row.url)}"`);
  return `<file ${parts.join(' ')}`;
}

async function fileBlock(row, source, seen, tally) {
  if (isNote(row)) {
    let text;
    try { text = await source.read(row); } catch { text = null; }
    if (typeof text !== 'string') { tally.missing += 1; return [`${openTag(row)} missing="true" />`]; }
    tally.files += 1;
    return [`${openTag(row)}>`, ...(await expandLines(text, source, seen, tally)), '</file>'];
  }
  tally.files += 1;
  const summary = bare(row.summary);
  return summary ? [`${openTag(row)} contains="summary">`, ...summary.split('\n'), '</file>'] : [`${openTag(row)} />`];
}

function folderFileBlock(name, folderId, rel, source, tally) {
  let found = null;
  try { found = source.file ? source.file(folderId, rel) : null; } catch { found = null; }
  if (!found || !found.exists) {
    tally.missing += 1;
    return [`<file name="${attr(name)}"${found ? ` folder="${attr(found.folder)}" path="${attr(found.path)}"` : ''} missing="true" />`];
  }
  tally.files += 1;
  return [`<file name="${attr(name)}" type="${attr(found.dir ? 'folder' : found.type || 'file')}" folder="${attr(found.folder)}" path="${attr(found.path)}" />`];
}

async function zoteroBlock(name, key, source, seen, tally) {
  let found = null;
  try { found = source.zotero ? await source.zotero(key, name) : null; } catch { found = null; }
  if (!found || found.missing) {
    tally.missing += 1;
    return found ? found.lines : [`<zotero_item key="${attr(key)}" title="${attr(name)}" missing="true" />`];
  }
  tally.files += 1;
  if (found.file) seen.add(zoteroFileKey(found.file));
  return found.lines;
}

async function workspaceBlock(name, id, source, seen, tally) {
  let held = null;
  try { held = source.workspace ? await source.workspace(id) : null; } catch { held = null; }
  if (!held) { tally.missing += 1; return [`<file name="${attr(name)}" type="workspace" missing="true" />`]; }
  tally.files += 1;
  const open = `<file name="${attr(held.name)}" type="workspace"${held.path ? ` path="${attr(held.path)}"` : ''}>`;
  return [open, ...(await expandLines(held.text, source, seen, tally)), '</file>'];
}

async function expandLines(text, source, seen, tally) {
  const body = bare(text);
  const out = [];
  let placed = false; // a block was just placed: text that follows gets a blank line before it
  for (const line of body ? body.split('\n') : []) {
    const blocks = [];
    let shown = '';
    for (const token of line.split(INLINE)) {
      if (!token) continue;
      const image = token.match(IMAGE_TOKEN);
      if (image) {
        const file = source.image(image[2]);
        shown += file ? `![${image[1]}](${file})` : token;
        continue;
      }
      shown += token;
      const ws = token.match(WS_TOKEN);
      if (ws) {
        const key = `ws:${ws[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blocks.push(await workspaceBlock(ws[1], ws[2], source, seen, tally));
        continue;
      }
      const zotero = token.match(ZOTERO_TOKEN);
      if (zotero) {
        const key = `zotero:${zotero[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blocks.push(await zoteroBlock(zotero[1], zotero[2], source, seen, tally));
        continue;
      }
      const file = token.match(FILE_TOKEN);
      if (file) {
        // A file in a library folder (MATH-22): where it is, under the line. Its folder counts as mentioned. Its text is
        // not placed here, whatever it is: the agent opens it (the folder is one it may read).
        const folderId = file[2], rel = decodeRel(file[3]), key = fileKey(folderId, rel);
        seen.add(folderId);
        if (seen.has(key)) continue;
        seen.add(key);
        blocks.push(folderFileBlock(file[1], folderId, rel, source, tally));
        continue;
      }
      if (!token.startsWith('@[')) continue;
      const lib = token.match(LIB_TOKEN);
      const name = lib ? lib[1] : token.slice(2, -1);
      // A library mention is its item, by id, whatever it is called now (else, with a source that cannot tell, by name).
      const row = lib && source.get ? source.get(lib[2]) : source.find(name);
      const key = row ? row.id : `?${name.toLowerCase()}`;
      if (seen.has(key) || (!row && BART_NAME.test(name))) continue;
      seen.add(key);
      if (row) blocks.push(await fileBlock(row, source, seen, tally));
      else { tally.missing += 1; blocks.push([`<file name="${attr(name)}" missing="true" />`]); }
    }
    if (placed && shown.trim()) out.push('');
    placed = false;
    out.push(shown);
    for (const block of blocks) {
      if (out[out.length - 1] !== '') out.push('');
      out.push(...block);
      placed = true;
    }
  }
  return out;
}

/**
 * `source` is where mentions lead: find(name) → a library row or null, read(row) → a note's text,
 * image(id) → a pasted image's file or null, workspace(id) → { name, path, text } of a workspace of the project or null.
 * Optional: get(id) → the library row a `lib:<id>` mention names, file(folderId, rel) → a file in a library folder
 * (store/folder-files.cjs fileInRow) or null, zotero(key, name) → zotero/mirror.cjs itemBlock's answer or null. `seen` holds what is already included (the document itself, when it is a
 * note); a mentioned file is added to it as fileKey(folderId, rel), and its folder's id with it. → { lines, files, missing }
 */
async function expandMentions(text, source, seen = new Set()) {
  const tally = { files: 0, missing: 0 };
  const lines = await expandLines(text, source, seen, tally);
  return { lines, ...tally };
}

/** Library rows placed as if each were mentioned on a line of its own (a Build's attached items), those in `seen` skipped. → { lines, files, missing } */
async function expandRows(rows, source, seen = new Set()) {
  const tally = { files: 0, missing: 0 };
  const lines = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (lines.length) lines.push('');
    lines.push(...(await fileBlock(row, source, seen, tally)));
  }
  return { lines, ...tally };
}

/**
 * One line of text with each pasted image (`![label](img:<id>)`) as the path of its file, read as expandMentions reads
 * it (an image inside `code` stays text); an image `source` does not know stays as it was. Nothing else is touched: an
 * agent's question (2026-10-02), which a resumed session is sent alone, without the document that would carry the path.
 */
function imagePaths(text, source) {
  return String(text ?? '').split(INLINE).map((token) => {
    const image = token && token.match(IMAGE_TOKEN), file = image ? source.image(image[2]) : null;
    return file ? `![${image[1]}](${file})` : token;
  }).join('');
}

/** Where the mentions of a project's documents lead (the `source` expandMentions takes), from the library's rows. */
function projectSource(ctx, projectId, rows) {
  // Two projects can each hold a file of the same name: this project's is the one meant.
  const byName = new Map();
  for (const row of rows) {
    if (row.type === 'image') continue;
    const key = row.name.toLowerCase();
    const held = byName.get(key);
    if (!held || (held.project_id !== projectId && row.project_id === projectId)) byName.set(key, row);
  }
  const images = new Map(rows.filter((row) => row.type === 'image' && row.path).map((row) => [row.id, row.path]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    find: (name) => byName.get(name.toLowerCase()) || null,
    get: (id) => { const row = byId.get(id); return row && row.type !== 'image' ? row : null; },
    // A file inside a library folder (MATH-22) → store/folder-files.cjs fileInRow's answer, or null without the folder.
    file: (folderId, rel) => { const row = byId.get(folderId); return row && row.folder_path ? fileInRow(row, rel, ctx.homeDir) : null; },
    // An item of the connected Zotero library (MATH-65 build 2): read from the mirror; its file is downloaded now when
    // it is not on this Mac and the app can (ctx.zotero(), main's ./zotero/sync.cjs), and one with no file of its own
    // has a free copy looked for (build 3, ../zotero/oa.cjs).
    zotero: (key, name) => {
      const service = typeof ctx.zotero === 'function' ? ctx.zotero() : null;
      return zoteroMirror.itemBlock(ctx.dataRoot ? zoteroMirror.mirrorDir(ctx.dataRoot) : null, key, name, service ? { download: service.download, ...(service.openAccess ? { openAccess: service.openAccess } : {}), ...(service.storageDir ? { storageDir: service.storageDir } : {}) } : {});
    },
    // Not readDoc: that reads a file that is gone as an empty document, and here it is a missing one.
    read: async (row) => fs.readFileSync((await projects.resolveDoc(ctx, row.project_id, { kind: 'note', id: row.id })).file, 'utf8'),
    image: (id) => images.get(id) || null,
    workspace: async (id) => {
      let found;
      try { found = projects.findWorkspace(ctx, projectId, id); } catch { return null; }
      const file = path.join(found.workspace.dir, 'workspace.md');
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; } // a workspace with nothing written yet
      return { name: found.workspace.name, path: file, text };
    },
  };
}

/**
 * The document `ref` of a project, under its name, with its mentions in place. `seen` may carry
 * library ids that are already included elsewhere and comes back holding every id placed here.
 * → { title, body, text, chars, files, missing }
 */
async function expandDoc(ctx, projectId, ref, { seen = new Set() } = {}) {
  const rows = await ctx.libraryDb.list();
  const body = await projects.readDoc(ctx, projectId, ref);
  const self = ref.kind === 'note' ? rows.find((row) => row.id === ref.id) : null;
  const title = ref.kind === 'note' ? (self ? self.name : '') : projects.findWorkspace(ctx, projectId, ref.workspaceId).workspace.name;
  const source = projectSource(ctx, projectId, rows);
  if (self) seen.add(self.id);
  if (ref.kind === 'workspace') seen.add(`ws:${ref.workspaceId}`); // mentioned back from inside, it is already here
  let project = null;
  try { project = projects.findProject(ctx, projectId); } catch { project = null; }
  const { lines, files, missing } = await expandMentions(buildLines(body, project), source, seen);
  const text = [...(title ? [`# ${title}`, ''] : []), ...lines].join('\n').trimEnd();
  return { title, body: lines.join('\n').trimEnd(), text, chars: text.length, files, missing };
}

module.exports = { INLINE, fileKey, zoteroFileKey, expandMentions, expandRows, expandDoc, projectSource, imagePaths };
