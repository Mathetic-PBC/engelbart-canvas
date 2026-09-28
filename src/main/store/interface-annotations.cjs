'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pageAddress, routeUrl, anchor, body } = require('../../shared/interface-annotations.cjs');
const projects = require('./projects.cjs');
const sites = require('./captured-sites.cjs');
const UUID = /^[a-f0-9-]{36}$/i;
const queues = new WeakMap();
const key = (projectId, scope) => createHash('sha256').update(`${projectId}\n${scope}`).digest('hex');
const directory = ctx => path.join(ctx.dataRoot, 'annotations', 'interface');

// Migration and edits share the writer lock: a metadata upgrade cannot overwrite
// a note saved while source resolution was awaiting SQL.
function serial(ctx, work) {
  const next = (queues.get(ctx.libraryDb) || Promise.resolve()).catch(() => {}).then(work);
  queues.set(ctx.libraryDb, next);
  return next;
}
async function project(ctx, projectId) {
  if (!UUID.test(projectId)) throw new TypeError('Invalid project');
  await projects.loadProject(ctx, projectId);
}
function read(file) {
  const data = fs.readFileSync(file, 'utf8');
  if (data.length > 8 * 1024 * 1024) throw new Error('Annotation file is too large');
  const saved = JSON.parse(data);
  if (saved.version !== 1 || !Array.isArray(saved.notes)) throw new Error('Invalid annotation file');
  return saved;
}
function write(file, saved) {
  const data = JSON.stringify(saved);
  if (data.length > 8 * 1024 * 1024) throw new Error('Annotations are too large. Delete a note before adding another.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}
async function bundles(ctx, projectId) {
  await project(ctx, projectId);
  const names = fs.existsSync(directory(ctx)) ? fs.readdirSync(directory(ctx)) : [];
  const result = [];
  result.warnings = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(directory(ctx), name);
    let saved;
    try { saved = read(file); }
    catch { result.warnings.push('An annotation file could not be read. Its saved data has been left intact.'); continue; }
    if (saved.projectId && saved.projectId !== projectId) continue;
    if (!saved.notes.length) continue;
    const first = saved.notes[0];
    let source;
    if (!saved.projectId) {
      // Original files encode ownership only in their hash. Verify that before
      // exposing or adopting anything into the requested project.
      source = await sites.resolve(ctx, first.url, { runId: first.runId });
      const candidates = [source.scope, `site:${pageAddress(first.url).site}`];
      if (!candidates.some(scope => `${key(projectId, scope)}.json` === name)) continue;
    }
    source = await sites.resolve(ctx, first.url, { ensure: true, libraryId: saved.libraryId, runId: first.runId, kind: saved.scope?.split(':')[0], title: first.anchor?.documentTitle });
    const next = { ...saved, projectId, scope: source.scope, libraryId: source.libraryId,
      notes: saved.notes.map(note => ({ ...note, libraryId: source.libraryId })) };
    if (JSON.stringify(next) !== JSON.stringify(saved)) write(file, next);
    result.push({ file, saved: next, source });
  }
  return result;
}
const publicNotes = entries => entries.flatMap(({ saved, source }) => saved.notes.map(note => ({ ...note,
  scope: saved.scope, sourceName: source.sourceName,
  sourceUrl: source.sourceUrl ? routeUrl(note.anchor.route, source.sourceUrl) : null,
})));

async function list(ctx, input) {
  return serial(ctx, async () => {
    const entries = await bundles(ctx, input?.projectId);
    const source = input.url ? await sites.resolve(ctx, input.url) : null;
    return { scope: source?.scope || null, notes: publicNotes(input.all || !source ? entries : entries.filter(e => e.saved.scope === source.scope)), warnings: [...new Set(entries.warnings)] };
  });
}
async function create(ctx, input, value) {
  const clean = { body: body(value?.body), anchor: anchor(value?.anchor) };
  return serial(ctx, async () => {
    await project(ctx, input?.projectId);
    const page = pageAddress(input.url);
    if (clean.anchor.route !== page.route) throw new Error('The page changed. Select the element again.');
    const source = await sites.resolve(ctx, input.url, { ensure: true, title: clean.anchor.documentTitle });
    const entries = await bundles(ctx, input.projectId);
    if (entries.filter(e => e.saved.scope === source.scope).reduce((n, e) => n + e.saved.notes.length, 0) >= 500) throw new Error('This site already has 500 notes. Delete a note before adding another.');
    const file = path.join(directory(ctx), `${key(input.projectId, source.scope)}.json`);
    // A damaged file may be omitted from the browser, but must never be
    // overwritten as though it were an empty site when another note is saved.
    const existing = entries.find(e => e.file === file)?.saved || (fs.existsSync(file) ? read(file) : null);
    const saved = existing || { version: 1, projectId: input.projectId, scope: source.scope, libraryId: source.libraryId, notes: [] };
    const now = new Date().toISOString();
    const note = { id: randomUUID(), ...clean, url: page.url, libraryId: source.libraryId, runId: source.runId, createdAt: now, updatedAt: now };
    saved.notes.push(note); write(file, saved);
    return publicNotes([{ saved: { ...saved, notes: [note] }, source }])[0];
  });
}
async function mutate(ctx, input, id, change) {
  return serial(ctx, async () => {
    const entries = await bundles(ctx, input?.projectId);
    const source = input.url ? await sites.resolve(ctx, input.url) : null;
    const entry = entries.find(e => (!source || e.saved.scope === source.scope) && e.saved.notes.some(n => n.id === id));
    if (!entry) throw new Error('This annotation no longer exists');
    const at = entry.saved.notes.findIndex(n => n.id === id);
    const note = change(entry.saved.notes[at]);
    if (note) entry.saved.notes[at] = note; else entry.saved.notes.splice(at, 1);
    write(entry.file, entry.saved);
    return note ? publicNotes([{ ...entry, saved: { ...entry.saved, notes: [note] } }])[0] : true;
  });
}
async function edit(ctx, input, id, value) {
  const clean = body(value);
  return mutate(ctx, input, id, note => ({ ...note, body: clean, updatedAt: new Date().toISOString() }));
}
async function remove(ctx, input, id) { return mutate(ctx, input, id, () => null); }
async function restore(ctx) {
  for (const project of await projects.listProjects(ctx)) await list(ctx, { projectId: project.id });
}
module.exports = { list, create, edit, remove, restore };
