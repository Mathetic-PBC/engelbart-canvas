'use strict';

// What the Stage shows for a path (2026-09-23, Claude Design "Add - Mention Stage.dc.html"): the renderer asks by path
// (projects.readStageFile resolves it inside the home directory) and gets back what it is and what it needs to draw it.
// A pdf and a picture come as bytes, text as text, an html file as its file: address for the native view. Two formats
// only macOS reads are converted with the tools it ships, once per version of the file, into <data root>/.cache/stage:
// a heic picture (sips → jpeg) and a word-processor document (textutil → html, shown as a page).

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const MAX_PDF_BYTES = 200 * 1024 * 1024; // the library's limit
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 500000;
const CONVERT_MS = 30000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const HEIC = new Set(['.heic', '.heif']);
const DOCUMENTS = new Set(['.docx', '.doc', '.rtf', '.odt']);

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: CONVERT_MS }, (error) => (error ? reject(error) : resolve()));
});

const bytesOf = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

// A file macOS keeps from Engelbart (2026-10-02): its privacy settings (Downloads, Desktop, Documents, another disk) answer
// a stat or a read with EPERM, and a mode that shuts Engelbart out answers EACCES. Said as that, not as a missing file.
const BLOCKED = 'macOS blocked Engelbart from reading this file. Allow access in System Settings → Privacy & Security → Files and Folders.';

/** A failed stat or read of a person's file as they should hear it: nothing there, or blocked; anything else as it came. */
function readFailure(error) {
  const code = error && error.code;
  if (code === 'ENOENT') return new Error('Nothing is at that path');
  if (code === 'EPERM' || code === 'EACCES') return new Error(BLOCKED);
  return error;
}

/** `read()`'s answer, or readFailure's reason for having none. */
function reading(read) {
  try { return read(); } catch (error) { throw readFailure(error); }
}

/** One name per version of a file: its real path, when it last changed, how big it is. */
function cacheKey(file, stat) {
  return createHash('sha256').update(`${file}\n${stat.mtimeMs}\n${stat.size}`).digest('hex').slice(0, 32);
}

/** Text if its first 8 KB hold no NUL byte (the test git uses for binary), else null. */
function readText(file, stat) {
  if (stat.size > MAX_TEXT_BYTES) return null;
  const buffer = reading(() => fs.readFileSync(file));
  if (buffer.subarray(0, 8192).includes(0)) return null;
  const all = buffer.toString('utf8');
  return { text: all.slice(0, MAX_TEXT_CHARS), truncated: all.length > MAX_TEXT_CHARS };
}

/** A converted copy in the cache, made now unless this version of the file was converted before. */
async function converted(cacheDir, file, stat, ext, make) {
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const out = path.join(cacheDir, `${cacheKey(file, stat)}${ext}`);
  if (!fs.existsSync(out)) {
    const temporary = path.join(cacheDir, `${cacheKey(file, stat)}.${process.pid}.tmp${ext}`);
    try { await make(temporary); fs.renameSync(temporary, out); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }
  return out;
}

/**
 * What is at `file` (already resolved and inside the home directory), for the Stage:
 * { kind: 'folder' | 'pdf' | 'page' | 'doc' | 'md' | 'table' | 'image' | 'text' | 'unsupported', path, name, … }.
 * `runTool(file, args)` runs sips/textutil (tests pass their own).
 */
async function readStageFile(file, { cacheDir, runTool = run } = {}) {
  const stat = reading(() => fs.statSync(file));
  const base = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  if (stat.isDirectory()) return { kind: 'folder', path: file, name: base };
  if (!stat.isFile()) throw new Error('That is not a file');
  if (ext === '.pdf') {
    if (stat.size > MAX_PDF_BYTES) throw new Error('The pdf is larger than 200 MB');
    return { kind: 'pdf', path: file, name: path.basename(file, path.extname(file)), url: pathToFileURL(file).href, bytes: bytesOf(reading(() => fs.readFileSync(file))) };
  }
  if (ext === '.html' || ext === '.htm') return { kind: 'page', path: file, name: base, url: pathToFileURL(file).href };
  if (IMAGE_TYPES[ext]) {
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('The picture is larger than 50 MB');
    return { kind: 'image', path: file, name: base, mime: IMAGE_TYPES[ext], bytes: bytesOf(reading(() => fs.readFileSync(file))) };
  }
  if (HEIC.has(ext)) {
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('The picture is larger than 50 MB');
    const jpeg = await converted(cacheDir, file, stat, '.jpg', (out) => runTool('/usr/bin/sips', ['-s', 'format', 'jpeg', file, '--out', out]));
    return { kind: 'image', path: file, name: base, mime: 'image/jpeg', bytes: bytesOf(reading(() => fs.readFileSync(jpeg))) };
  }
  if (DOCUMENTS.has(ext)) {
    const html = await converted(cacheDir, file, stat, '.html', (out) => runTool('/usr/bin/textutil', ['-convert', 'html', '-output', out, file]));
    return { kind: 'doc', path: file, name: base, url: pathToFileURL(html).href };
  }
  const text = readText(file, stat);
  if (!text) return { kind: 'unsupported', path: file, name: base, ext: ext.slice(1) };
  if (ext === '.md' || ext === '.markdown') return { kind: 'md', path: file, name: base, ...text };
  if (ext === '.csv' || ext === '.tsv') return { kind: 'table', path: file, name: base, delimiter: ext === '.tsv' ? '\t' : ',', ...text };
  return { kind: 'text', path: file, name: base, ext: ext.slice(1), ...text };
}

module.exports = { readStageFile, cacheKey, readFailure, reading, BLOCKED };
