'use strict';
// A copy of a whole Overleaf project on disk (MATH-65, Overleaf part 1, 2026-10-07), for @bart to read the files that are
// not open in the editor. Main downloads https://www.overleaf.com/project/<id>/download/zip with the Stage's own session
// (index.cjs passes session.fromPartition(<the Stage's partition>).fetch), so the sign-in is the one the person made in the
// Stage and no cookie leaves that session. It is unpacked to <dataRoot>/.overleaf/<projectId>/, swapped in whole once
// unpacked, and what it holds is written beside it, <dataRoot>/.overleaf/<projectId>.json: { projectId, fetchedAt,
// files, skipped: [{ path, bytes }] }.
//
// A copy is refreshed before an @bart turn when it is over MAX_AGE_MS old (ensure); never more than one download at a
// time per project: a turn that comes while one runs waits on that one. A binary file over MAX_BINARY_BYTES is skipped
// (listed in `skipped`); text files are always kept. Nothing here ever writes to Overleaf.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');

const MAX_AGE_MS = 60_000;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024; // a text file past this is not unpacked either
const MAX_ENTRIES = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const BASE = 'https://www.overleaf.com';
// What is read as text, by extension; a file with none (latexmkrc, Makefile) is text too. Anything else is binary.
const TEXT_EXT = new Set(['tex', 'ltx', 'latex', 'bib', 'bbl', 'bst', 'bbx', 'cbx', 'cls', 'sty', 'clo', 'cfg', 'def', 'dtx', 'ins', 'fd',
  'txt', 'md', 'markdown', 'rnw', 'rtex', 'rmd', 'csv', 'tsv', 'dat', 'json', 'yaml', 'yml', 'xml', 'svg', 'tikz', 'pgf', 'pgf-plot',
  'lua', 'py', 'r', 'm', 'sh', 'pl', 'gnuplot', 'gp', 'ist', 'gls', 'glo', 'idx', 'ind', 'nlo', 'nls', 'lof', 'lot', 'toc', 'aux', 'log',
  'html', 'htm', 'css', 'js', 'mk', 'tikzstyles', 'asy', 'mp', 'lbx', 'gitignore', 'latexmkrc']);
const ID_RE = /^[0-9a-f]{24}$/;

const overleafRoot = (dataRoot) => path.join(dataRoot, '.overleaf');
const copyDir = (dataRoot, projectId) => path.join(overleafRoot(dataRoot), projectId);
const infoFile = (dataRoot, projectId) => path.join(overleafRoot(dataRoot), `${projectId}.json`);

function isText(name) {
  const base = path.posix.basename(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return !base.startsWith('.') || TEXT_EXT.has(base.slice(1).toLowerCase());
  return TEXT_EXT.has(base.slice(dot + 1).toLowerCase());
}

/** A name in the zip as a safe relative path ('a/b.tex'), or '' when it is a folder, absolute, or leaves the copy. */
function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || name.endsWith('/')) return '';
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return '';
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return '';
  return parts.join('/');
}

/**
 * The files of a zip (`buffer`) → { files: [{ name, data }], skipped: [{ path, bytes, why }] }. Stored and deflated
 * entries; folders, links, encrypted entries and names that would leave the copy are passed over. A binary file over
 * `maxBinaryBytes` is skipped before it is inflated. Throws on what is no zip, or one this cannot read (ZIP64).
 */
function readZip(buffer, { maxBinaryBytes = MAX_BINARY_BYTES } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Overleaf did not send a zip');
  const count = buf.readUInt16LE(eocd + 10), size = buf.readUInt32LE(eocd + 12), start = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Error('The project zip is too large to read');
  if (count > MAX_ENTRIES) throw new Error('The project has too many files');
  if (start + size > eocd) throw new Error('The project zip is damaged');
  const files = [], skipped = [];
  let at = start;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('The project zip is damaged');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20), bytes = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28), extraLength = buf.readUInt16LE(at + 30), commentLength = buf.readUInt16LE(at + 32);
    const mode = (buf.readUInt32LE(at + 38) >>> 16) & 0o170000, local = buf.readUInt32LE(at + 42);
    const raw = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    const name = safeName(raw);
    if (!name || mode === 0o120000 || mode === 0o040000) continue; // a folder, a link, or no safe name
    if (flags & 1) { skipped.push({ path: name, bytes, why: 'encrypted' }); continue; }
    if (!isText(name) && bytes > maxBinaryBytes) { skipped.push({ path: name, bytes, why: 'binary over the size limit' }); continue; }
    if (bytes > MAX_FILE_BYTES) { skipped.push({ path: name, bytes, why: 'too large' }); continue; }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('The project zip is damaged');
    const from = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(from, from + packed);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, bytes) });
    else { skipped.push({ path: name, bytes, why: 'unknown compression' }); continue; }
    if (data.length !== bytes || (typeof zlib.crc32 === 'function' && zlib.crc32(data) !== crc)) throw new Error('The project zip is damaged');
    files.push({ name, data });
  }
  return { files, skipped };
}

/** The body of `response`, at most `max` bytes (more throws). */
async function bodyOf(response, max) {
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (declared > max) throw new Error('The project is too large to copy');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const all = Buffer.from(await response.arrayBuffer());
    if (all.length > max) throw new Error('The project is too large to copy');
    return all;
  }
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('The project is too large to copy'); }
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(parts, total);
}

function readInfo(dataRoot, projectId) {
  try {
    const info = JSON.parse(fs.readFileSync(infoFile(dataRoot, projectId), 'utf8'));
    if (!info || !Number.isFinite(info.fetchedAt) || !fs.statSync(copyDir(dataRoot, projectId)).isDirectory()) return null;
    return { projectId, folder: copyDir(dataRoot, projectId), fetchedAt: info.fetchedAt, files: Number(info.files) || 0, skipped: Array.isArray(info.skipped) ? info.skipped : [] };
  } catch {
    return null;
  }
}

/** The files written to a new folder beside the copy, then swapped in for it, the old one removed. */
function writeCopy(dataRoot, projectId, files) {
  const root = overleafRoot(dataRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const incoming = path.join(root, `.${projectId}.incoming-${randomUUID()}`);
  try {
    for (const { name, data } of files) {
      const target = path.join(incoming, ...name.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    fs.mkdirSync(incoming, { recursive: true }); // an empty project is an empty folder
    const dir = copyDir(dataRoot, projectId);
    const old = path.join(root, `.${projectId}.old-${randomUUID()}`);
    let moved = false;
    try { fs.renameSync(dir, old); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(incoming, dir);
    if (moved) fs.rmSync(old, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
}

/**
 * → { ensure, refresh, info, inFlight }. `fetch(url, init)` is the Stage's session's. `ensure(dataRoot, projectId)`:
 * the copy as it is when it is at most `maxAgeMs` old, else refreshed (joined to a download already running) →
 * { projectId, folder, fetchedAt, files, skipped, fresh } on success; a failed download → { error, …the old copy's
 * info when there is one }. Never throws.
 */
function createOverleafCopies({ fetch, now = Date.now, base = BASE, maxAgeMs = MAX_AGE_MS, maxBinaryBytes = MAX_BINARY_BYTES, maxZipBytes = MAX_ZIP_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const running = new Map(); // copy folder -> the download under way

  async function download(dataRoot, projectId) {
    const url = `${base}/project/${projectId}/download/zip`;
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Overleaf answered ${response.status} for the project's zip`);
    const body = await bodyOf(response, maxZipBytes);
    // signed out, Overleaf sends its sign-in page (200, html) in place of the zip
    if (body.length < 4 || body.readUInt32LE(0) !== (body.length === 22 ? 0x06054b50 : 0x04034b50)) {
      throw new Error('Overleaf did not send the project: is the Stage signed in to overleaf.com?');
    }
    const { files, skipped } = readZip(body, { maxBinaryBytes });
    writeCopy(dataRoot, projectId, files);
    const info = { projectId, fetchedAt: now(), files: files.length, skipped: skipped.map(({ path: p, bytes, why }) => ({ path: p, bytes, why })) };
    fs.writeFileSync(infoFile(dataRoot, projectId), `${JSON.stringify(info, null, 1)}\n`);
    return { ...readInfo(dataRoot, projectId), fresh: true };
  }

  /** A download now, or the one already running for this project. */
  function refresh(dataRoot, projectId) {
    if (!ID_RE.test(String(projectId))) return Promise.resolve({ error: 'Not an Overleaf project id' });
    const key = copyDir(dataRoot, projectId);
    if (running.has(key)) return running.get(key);
    const run = download(dataRoot, projectId)
      .catch((error) => ({ ...(readInfo(dataRoot, projectId) || { projectId }), error: String((error && error.message) || error).slice(0, 300) }))
      .finally(() => { running.delete(key); });
    running.set(key, run);
    return run;
  }

  function ensure(dataRoot, projectId, { maxAge = maxAgeMs } = {}) {
    if (!ID_RE.test(String(projectId))) return Promise.resolve({ error: 'Not an Overleaf project id' });
    const held = readInfo(dataRoot, projectId);
    if (held && now() - held.fetchedAt <= maxAge) return Promise.resolve({ ...held, fresh: true });
    return refresh(dataRoot, projectId);
  }

  return { ensure, refresh, info: readInfo, inFlight: (dataRoot, projectId) => running.has(copyDir(dataRoot, projectId)) };
}

module.exports = { createOverleafCopies, readZip, safeName, isText, copyDir, infoFile, overleafRoot, MAX_AGE_MS, MAX_BINARY_BYTES };
