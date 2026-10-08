'use strict';

// Connect your library (2026-10-07, experimental): notes an import brings in. "Each file its own note in Engelbart with the
// same title, images included" (the Onboarding brainstorm note): a Markdown file becomes a note named by its file, its
// pictures saved into the project as pasted ones are (projects.saveImage, `![name](img:<id>)`), and Obsidian's links
// to other notes (`[[Note]]`, `[[Note|shown]]`, an embedded note `![[Note]]`) become Engelbart mentions (`@[Note]`), as do
// relative links to .md files (a Notion export's "Title 0123…cdef.md" read as "Title").
//
// Onboarding asks before there is a project (the connect screen comes before Create), so a note that arrives then is
// staged: <session folder>/notes/<id>.json { title, body, images: [{ token, file, alt }], source }, and written into the
// project when onboarding makes it (flushStaged). Once a session knows its project, notes go straight in (writeNote).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sanitizeName } = require('../store/home.cjs');

const IMAGE_MIMES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });
const PICTURE_EXT = /\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/i;
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INDEX = 50_000;
const NOTION_HASH_RE = /\s+[0-9a-f]{32}$/i;

/** What a linked note is called in Engelbart: the file's name without its folder, extension or Notion's id. */
const noteName = (target) => sanitizeName(path.basename(String(target || '').trim(), path.extname(String(target || '').trim())).replace(NOTION_HASH_RE, ''));
const altText = (value) => String(value || '').replace(/[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
const decode = (value) => { try { return decodeURI(value); } catch { return value; } };

/** A lookup by file name within a folder (Obsidian finds `![[x.png]]` anywhere in the vault), built once per folder. */
function createIndex() {
  const held = new Map();
  return (root, name) => {
    if (!root) return null;
    let index = held.get(root);
    if (!index) {
      index = new Map();
      const queue = [root];
      let seen = 0;
      while (queue.length && seen < MAX_INDEX) {
        const dir = queue.shift();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          seen += 1;
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) queue.push(full);
          else if (!index.has(entry.name.toLowerCase())) index.set(entry.name.toLowerCase(), full);
        }
      }
      held.set(root, index);
    }
    return index.get(String(name).toLowerCase()) || null;
  };
}

/** Where a picture a note names is on disk: beside the note, from the vault's top, else anywhere in the vault by name. */
function findPicture(target, { sourcePath = '', root = '', index = null } = {}) {
  const clean = decode(String(target || '').split('#')[0].split('|')[0].trim());
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  const tries = [];
  if (path.isAbsolute(clean)) tries.push(clean);
  if (sourcePath) tries.push(path.resolve(path.dirname(sourcePath), clean));
  if (root) tries.push(path.resolve(root, clean));
  for (const file of tries) { try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ } }
  return index ? index(root, path.basename(clean)) : null;
}

/**
 * A Markdown text as an Engelbart note: Obsidian links and embeds read (above), pictures that are files on this Mac set
 * aside as `images` [{ token, file, alt }] whose token stands in the body until the picture is saved. `root`: the folder
 * the import reads (a vault), where Obsidian looks a picture up by name.
 */
function convertMarkdown(text, { sourcePath = '', root = '', index = null } = {}) {
  const images = [];
  const picture = (target, alt) => {
    const file = findPicture(target, { sourcePath, root, index });
    if (!file || !PICTURE_EXT.test(file)) return null;
    const token = `engelbart-image:${images.length}`;
    images.push({ token, file, alt: altText(alt) || path.basename(file, path.extname(file)) });
    return `![${images[images.length - 1].alt}](${token})`;
  };
  let body = String(text || '');
  // ![[picture.png|300]] or ![[Another note]]
  body = body.replace(/!\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]*))?\]\]/g, (whole, target, _anchor, shown) => {
    if (PICTURE_EXT.test(target.trim())) return picture(target, /^\d+(x\d+)?$/.test(String(shown || '').trim()) ? '' : shown) || whole;
    return `@[${noteName(target)}]`;
  });
  // [[Note]], [[Note#Heading]], [[Note|shown]]
  body = body.replace(/\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]*))?\]\]/g, (_whole, target) => `@[${noteName(target)}]`);
  // ![alt](relative/picture.png "title")
  body = body.replace(/!\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g, (whole, alt, target) => (/^(https?:|data:|img:|engelbart-image:)/i.test(target) ? whole : picture(target, alt) || whole));
  // [Title](Other%20note%200123….md)
  body = body.replace(/(^|[^!@])\[([^\]\n]+)\]\(<?([^)\s>]+\.md)>?\)/gi, (whole, lead, _shown, target) => (/^[a-z][a-z0-9+.-]*:/i.test(target) ? whole : `${lead}@[${noteName(decode(target))}]`));
  return { body, images };
}

/** Pictures set aside by convertMarkdown saved into the project, their tokens replaced; one that cannot be kept is named in brackets. */
async function placeImages(ctx, projectId, body, images, { saveImage }) {
  let text = body;
  for (const image of images) {
    let replacement = `[picture: ${image.alt}]`;
    const mime = IMAGE_MIMES[path.extname(image.file).toLowerCase()];
    try {
      const stat = fs.statSync(image.file);
      if (mime && stat.isFile() && stat.size <= MAX_IMAGE_BYTES) {
        const row = await saveImage(ctx, projectId, { bytes: fs.readFileSync(image.file), mime, name: image.alt });
        replacement = `![${image.alt}](img:${row.id})`;
      }
    } catch { /* the picture went, or cannot be read: named instead */ }
    text = text.split(`![${image.alt}](${image.token})`).join(replacement);
  }
  return text;
}

/** A note written into a project: its pictures saved, then the note (named `title`, made unique by createNote). → { id, name } */
async function writeNote(ctx, projectId, { title, body, images = [] }, { projects }) {
  const text = await placeImages(ctx, projectId, String(body || ''), images, { saveImage: projects.saveImage });
  const note = await projects.createNote(ctx, projectId, { name: title, text });
  return { id: note.id, name: note.name };
}

const stagedDir = (sessionDir) => path.join(sessionDir, 'notes');

/** A note kept until the session has a project. → its staged id */
function stageNote(sessionDir, { title, body, images = [], source = '' }) {
  const dir = stagedDir(sessionDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ title: sanitizeName(title), body, images, source, at: new Date().toISOString() }), { mode: 0o600 });
  return id;
}

function stagedNotes(sessionDir) {
  let names = [];
  try { names = fs.readdirSync(stagedDir(sessionDir)).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  return names.map((name) => {
    try { return { file: path.join(stagedDir(sessionDir), name), ...JSON.parse(fs.readFileSync(path.join(stagedDir(sessionDir), name), 'utf8')) }; } catch { return null; }
  }).filter(Boolean);
}

/** Every staged note written into the project, oldest first, each removed once it is in. → [{ id, name }] */
async function flushStaged(ctx, sessionDir, projectId, { projects }) {
  const written = [];
  for (const staged of stagedNotes(sessionDir).sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    written.push(await writeNote(ctx, projectId, staged, { projects }));
    fs.rmSync(staged.file, { force: true });
  }
  return written;
}

module.exports = { MAX_NOTE_BYTES, noteName, createIndex, findPicture, convertMarkdown, placeImages, writeNote, stageNote, stagedNotes, flushStaged };
