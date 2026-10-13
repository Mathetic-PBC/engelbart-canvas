'use strict';

// @create's files (2026-10-13). Each run writes in a draft folder of its own, <dataRoot>/.create/<askId>/, made empty
// before the run and the agent's working directory: the only place it may write (./ask.cjs gives Claude Code Write and
// Edit there alone, and Codex a workspace-write sandbox rooted there). After a run that answered, the files it left are
// kept in the library, at most five, each at most 20 MB and of a format the library reads (store/library.cjs
// FILE_TYPES): Markdown as a file of the library's own (addMarkdownCopy, assets/md), a pdf or a picture as a copy
// (addFileCopy), anything else under assets/files (../build/engelbart-tools.cjs keepCopy, as a Build's agent keeps a
// file). Each row is named after its file, linked to the workspace the line is in and announced, so the sidebar reads
// the library again. Then the folder is deleted; a run that was stopped or failed deletes it and keeps nothing. Nothing
// here changes or deletes a row the library already holds.

const fs = require('node:fs');
const path = require('node:path');

const CREATE_DIR = '.create';
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

/**
 * The draft folder's files kept as library rows, linked to `workspaceId` and announced by `onAdded(row)`.
 * → { rows, skipped: ['name: why'] }
 */
async function keepCreated(ctx, projectId, workspaceId, dir, { inspectPdf = null, onAdded = () => {} } = {}) {
  const library = require('../store/library.cjs');
  const { keepCopy, linkMade } = require('../build/engelbart-tools.cjs');
  const { found, odd } = draftFiles(dir);
  const rows = [], skipped = odd.map(({ rel, why }) => `${rel}: ${why}`);
  for (const { file, rel, size } of found) {
    const extension = path.extname(file).toLowerCase(), type = library.FILE_TYPES.get(extension);
    if (!type) { skipped.push(`${rel}: ${extension || 'no extension'} is not a format the library keeps`); continue; }
    if (size > MAX_CREATED_BYTES) { skipped.push(`${rel}: larger than 20 MB`); continue; }
    if (rows.length >= MAX_CREATED) { skipped.push(`${rel}: past the ${MAX_CREATED} files Create keeps`); continue; }
    try {
      const name = rowName(file);
      const row = type === 'md' ? await library.addMarkdownCopy(ctx, { name, text: fs.readFileSync(file, 'utf8') }) : await keepCopy(ctx, file, name, { inspectPdf });
      rows.push(await linkMade(ctx, projectId, workspaceId, row, onAdded));
    } catch (error) {
      skipped.push(`${rel}: ${String((error && error.message) || error).split('\n')[0].slice(0, 160)}`);
    }
  }
  return { rows, skipped };
}

/**
 * The answer as the document keeps it: the agent's sentences, then one line per row kept, as a mention of it (drawn as a
 * link the editor opens in the Stage), then what was skipped, if anything.
 */
function createdBody(text, { rows, skipped }) {
  const mention = (row) => `@[${String(row.name || '').replace(/[[\]\n]/g, '').trim() || 'Untitled'}](lib:${row.id})`;
  return [
    String(text || '').trim(),
    rows.length ? rows.map(mention).join('\n') : '',
    skipped.length ? `Not kept: ${skipped.join('; ')}.` : '',
  ].filter(Boolean).join('\n\n');
}

module.exports = { CREATE_DIR, MAX_CREATED, MAX_CREATED_BYTES, CREATE_TIMEOUT_MS, draftPath, openDraft, dropDraft, draftFiles, keepCreated, createdBody };
