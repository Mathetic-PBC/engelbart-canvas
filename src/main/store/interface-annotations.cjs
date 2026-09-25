'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pageAddress, anchor, body } = require('../../shared/interface-annotations.cjs');
const projects = require('./projects.cjs');
const UUID = /^[a-f0-9-]{36}$/i;

async function place(ctx, input) {
  if (!input || !UUID.test(input.projectId)) throw new TypeError('Invalid project');
  // Also establishes that this project belongs to the active data root.
  await projects.loadProject(ctx, input.projectId);
  const page = pageAddress(input.url);
  // Preview hostnames change between runs. Bind those notes to the repository.
  const runs = await ctx.libraryDb.query('select id, library_id, preview_url from sandbox_runs where preview_url is not null order by created_at desc');
  const run = runs.find((row) => { try { return pageAddress(row.preview_url).site === page.site; } catch { return false; } });
  const scope = run ? `repo:${run.library_id}` : `site:${page.site}`;
  const key = createHash('sha256').update(`${input.projectId}\n${scope}`).digest('hex');
  return { file: path.join(ctx.dataRoot, 'annotations', 'interface', `${key}.json`), page, scope, runId: run?.id || null };
}
function read(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (data.length > 8 * 1024 * 1024) throw new Error('Annotation file is too large');
    const saved = JSON.parse(data);
    if (saved.version !== 1 || !Array.isArray(saved.notes)) throw new Error('Invalid annotation file');
    return saved.notes;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function write(file, notes) {
  const data = JSON.stringify({ version: 1, notes });
  if (data.length > 8 * 1024 * 1024) throw new Error('Annotations are too large. Delete a note before adding another.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}
async function list(ctx, input) {
  const p = await place(ctx, input);
  return { scope: p.scope, notes: read(p.file) };
}
async function create(ctx, input, value) {
  const clean = { body: body(value?.body), anchor: anchor(value?.anchor) };
  const p = await place(ctx, input);
  if (clean.anchor.route !== p.page.route) throw new Error('The page changed. Select the element again.');
  const notes = read(p.file);
  if (notes.length >= 500) throw new Error('This site already has 500 notes. Delete a note before adding another.');
  const now = new Date().toISOString();
  const note = { id: randomUUID(), ...clean, url: p.page.url, runId: p.runId, createdAt: now, updatedAt: now };
  write(p.file, [...notes, note]);
  return note;
}
async function edit(ctx, input, id, value) {
  const clean = body(value);
  const p = await place(ctx, input), notes = read(p.file);
  const at = notes.findIndex((n) => n.id === id);
  if (at < 0) throw new Error('This annotation no longer exists');
  notes[at] = { ...notes[at], body: clean, updatedAt: new Date().toISOString() };
  write(p.file, notes);
  return notes[at];
}
async function remove(ctx, input, id) {
  const p = await place(ctx, input), notes = read(p.file);
  write(p.file, notes.filter((n) => n.id !== id));
  return true;
}
module.exports = { list, create, edit, remove };
