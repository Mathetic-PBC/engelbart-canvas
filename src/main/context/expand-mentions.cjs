'use strict';

// A document as one text that stands on its own outside Engelbart: what the sidebar's Copy puts
// on the clipboard (2026-09-19). Every @[mentioned] file is placed directly under the line that
// mentions it, in <file> tags, once: at its first mention reading top to bottom. A note is
// included whole and brings its own mentions with it. Anything else (a pdf, a website, a
// repository, a folder, a data file) is included as where it is plus its catalog summary when the sweep has
// written one; a paper's text can run to hundreds of thousands of characters, its abstract cannot.
// A mention that leads nowhere says so where it stands. A pasted image becomes the path of its
// file, which means something outside the app; img:<id> does not.

const fs = require('node:fs');
const projects = require('../store/projects.cjs');

// The editor's inline tokens (src/renderer/model/doc.js), so a mention inside `code` stays text
// here as it does on screen. test/expand-mentions.test.cjs holds the two together.
const INLINE = /(!\[[^\]\n]*\]\(img:[\w-]+\)|@[Bb]art(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`])/g;
const IMAGE_TOKEN = /^!\[([^\]\n]*)\]\(img:([\w-]+)\)$/;
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
      if (!token.startsWith('@[')) continue;
      const name = token.slice(2, -1);
      const row = source.find(name);
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
 * image(id) → a pasted image's file or null. `seen` holds what is already included (the document
 * itself, when it is a note). → { lines, files, missing }
 */
async function expandMentions(text, source, seen = new Set()) {
  const tally = { files: 0, missing: 0 };
  const lines = await expandLines(text, source, seen, tally);
  return { lines, ...tally };
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
  // Two projects can each hold a file of the same name: this project's is the one meant.
  const byName = new Map();
  for (const row of rows) {
    if (row.type === 'image') continue;
    const key = row.name.toLowerCase();
    const held = byName.get(key);
    if (!held || (held.project_id !== projectId && row.project_id === projectId)) byName.set(key, row);
  }
  const images = new Map(rows.filter((row) => row.type === 'image' && row.path).map((row) => [row.id, row.path]));
  const source = {
    find: (name) => byName.get(name.toLowerCase()) || null,
    // Not readDoc: that reads a file that is gone as an empty document, and here it is a missing one.
    read: async (row) => fs.readFileSync((await projects.resolveDoc(ctx, row.project_id, { kind: 'note', id: row.id })).file, 'utf8'),
    image: (id) => images.get(id) || null,
  };
  if (self) seen.add(self.id);
  const { lines, files, missing } = await expandMentions(body, source, seen);
  const text = [...(title ? [`# ${title}`, ''] : []), ...lines].join('\n').trimEnd();
  return { title, body: lines.join('\n').trimEnd(), text, chars: text.length, files, missing };
}

module.exports = { INLINE, expandMentions, expandDoc };
