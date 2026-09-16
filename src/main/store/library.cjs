'use strict';

// The root library: seeds for test mode, file bytes for papers, PDF annotations.
// Nothing here copies user files; the seeds are the app's own fixtures (spec §2 #7, #15).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DIR_MODE } = require('./home.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PDF_BYTES = 200 * 1024 * 1024;

function seedRows(seedDir) {
  return [
    { name: 'How to Teach Programming in the AI Era?', type: 'paper', path: path.join(seedDir, 'hypocompass.pdf') },
    { name: 'arXiv 2310.05292', type: 'website', url: 'https://arxiv.org/abs/2310.05292' },
    { name: 'mqo00/hypocompass', type: 'git_repo', url: 'https://github.com/mqo00/hypocompass', folder_path: null },
    { name: 'backend/problems', type: 'dataset', path: path.join(seedDir, 'problems.csv') },
  ];
}

async function seedIfEmpty(ctx, fixturesDir) {
  const existing = await ctx.libraryDb.list();
  if (existing.length) return 0;
  const seedDir = path.join(ctx.dataRoot, 'seed');
  fs.mkdirSync(seedDir, { recursive: true, mode: DIR_MODE });
  for (const name of ['hypocompass.pdf', 'problems.csv']) {
    const source = path.join(fixturesDir, name);
    const target = path.join(seedDir, name);
    if (!fs.existsSync(target) && fs.existsSync(source)) fs.copyFileSync(source, target);
  }
  let count = 0;
  for (const row of seedRows(seedDir)) {
    if (row.path && !fs.existsSync(row.path)) continue;
    await ctx.libraryDb.insert({ id: randomUUID(), ...row });
    count += 1;
  }
  return count;
}

async function listLibrary(ctx) {
  return ctx.libraryDb.list();
}

async function readLibraryFile(ctx, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('library id is invalid');
  const row = await ctx.libraryDb.get(id);
  if (!row || !row.path) throw new Error('This item has no local file');
  const file = path.resolve(row.path);
  if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('Only downloaded pdf files open for now');
  if (!file.startsWith(ctx.homeDir + path.sep)) throw new Error('The file is outside your home directory');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_PDF_BYTES) throw new Error('The file is not a readable pdf');
  const buffer = fs.readFileSync(file);
  return { id: row.id, name: row.name, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
}

function annotationFile(ctx, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('library id is invalid');
  return path.join(ctx.dataRoot, 'annotations', `${id}.json`);
}

async function readAnnotations(ctx, id) {
  try {
    return JSON.parse(fs.readFileSync(annotationFile(ctx, id), 'utf8'));
  } catch {
    return null;
  }
}

async function writeAnnotations(ctx, id, value) {
  const file = annotationFile(ctx, id);
  let text;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    throw new TypeError('annotations must be JSON-serialisable');
  }
  if (text.length > 20 * 1024 * 1024) throw new TypeError('annotations are too large');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return true;
}

module.exports = { seedIfEmpty, listLibrary, readLibraryFile, readAnnotations, writeAnnotations };
