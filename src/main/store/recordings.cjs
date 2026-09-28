'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');
const { VERSION, MAX_RECORDING, id, pageUrl, readBatch } = require('../../shared/recordings.cjs');
const projects = require('./projects.cjs');
const sites = require('./captured-sites.cjs');

async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}
function directory(ctx, projectId, recordingId) {
  const root = path.join(ctx.dataRoot, 'recordings', id(projectId));
  return recordingId ? path.join(root, id(recordingId)) : root;
}
async function project(ctx, projectId) { id(projectId); await projects.loadProject(ctx, projectId); }
async function create(ctx, input) {
  await project(ctx, input.projectId);
  const url = pageUrl(input.url), recordingId = randomUUID();
  const source = await sites.resolve(ctx, url, { ensure: true, title: input.name });
  const metadata = { version: VERSION, id: recordingId, projectId: input.projectId, name: String(input.name || new URL(url).host).slice(0, 200), url,
    libraryId: source.libraryId, sourceKind: source.kind, runId: source.runId, status: 'starting', createdAt: Date.now(), startedAt: null, stoppedAt: null,
    durationMs: 0, bytes: 0, events: 0, snapshots: 0, frames: 0, warnings: [] };
  const dir = directory(ctx, input.projectId, recordingId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await atomic(path.join(dir, 'meta.json'), metadata);
  const file = await fs.open(path.join(dir, 'capture.jsonl'), 'ax', 0o600);
  let closed = false;
  return {
    metadata,
    async append(batch) {
      if (closed) throw new Error('Recording is closed');
      const line = JSON.stringify(batch) + '\n', bytes = Buffer.byteLength(line);
      if (metadata.bytes + bytes > MAX_RECORDING) throw new Error('Recording reached its 128 MB limit. The captured portion was saved.');
      await file.writeFile(line);
      await file.datasync(); // Acknowledged batches are on disk, not only in renderer memory.
      metadata.bytes += bytes; metadata.events += batch.events.length; metadata.frames += batch.canvas.length;
      metadata.snapshots += batch.events.filter(e => e.type === 2).length;
      if (batch.events.length) {
        metadata.startedAt ??= Math.min(...batch.events.map(e => e.timestamp));
        if (metadata.snapshots) metadata.status = 'recording';
      }
      if (metadata.startedAt !== null) metadata.durationMs = Math.max(metadata.durationMs, batch.at - metadata.startedAt, ...batch.events.map(e => e.timestamp - metadata.startedAt));
      metadata.warnings = [...new Set([...metadata.warnings, ...batch.warnings])].slice(0, 20);
      await atomic(path.join(dir, 'meta.json'), metadata);
    },
    async finish(reason = null) {
      if (closed) return metadata;
      closed = true;
      await file.close();
      metadata.stoppedAt = Date.now();
      metadata.status = reason || !metadata.snapshots ? 'interrupted' : 'saved';
      if (reason) metadata.warnings = [...new Set([...metadata.warnings, reason])].slice(0, 20);
      await atomic(path.join(dir, 'meta.json'), metadata);
      return metadata;
    },
  };
}
async function readLines(dir) {
  const file = path.join(dir, 'capture.jsonl'), stat = await fs.stat(file);
  if (stat.size > MAX_RECORDING) throw new Error('Recording exceeds the supported size');
  const lines = (await fs.readFile(file, 'utf8')).split('\n'), batches = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try { batches.push(readBatch(lines[i])); }
    catch { if (i < lines.length - 1) throw new Error('Recording data is damaged'); } // a crash may leave one incomplete tail
  }
  return batches;
}
async function list(ctx, projectId, activeId = null, url = null) {
  await project(ctx, projectId);
  const root = directory(ctx, projectId);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      id(entry.name);
      const dir = directory(ctx, projectId, entry.name), file = path.join(dir, 'meta.json');
      const m = JSON.parse(await fs.readFile(file, 'utf8'));
      if (m.version !== VERSION || m.projectId !== projectId || m.id !== entry.name) continue;
      if (['starting', 'recording'].includes(m.status) && m.id !== activeId) {
        const batches = await readLines(dir);
        const events = batches.flatMap(b => b.events);
        m.events = events.length;
        m.snapshots = events.filter(e => e.type === 2).length;
        m.frames = batches.reduce((n, b) => n + b.canvas.length, 0);
        m.startedAt = events[0]?.timestamp || m.startedAt;
        m.stoppedAt = batches.at(-1)?.at || m.createdAt;
        m.durationMs = Math.max(0, m.stoppedAt - (m.startedAt || m.createdAt));
        m.status = 'interrupted';
        m.warnings = [...new Set([...m.warnings, 'Recording was interrupted. Previously saved batches are available.'])];
        await atomic(file, m);
      }
      result.push(await linked(ctx, m, m.id !== activeId));
    } catch { /* a broken recording must not hide the other recordings */ }
  }
  const source = url ? await sites.resolve(ctx, url) : null;
  return result.filter(row => !source || row.scope === source.scope).sort((a, b) => b.createdAt - a.createdAt);
}
async function read(ctx, projectId, recordingId) {
  const metadata = await readMetadata(ctx, projectId, recordingId);
  const batches = await readLines(directory(ctx, projectId, recordingId));
  return { metadata, batches };
}
async function readMetadata(ctx, projectId, recordingId) {
  await project(ctx, projectId);
  const dir = directory(ctx, projectId, recordingId);
  const metadata = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  if (metadata.version !== VERSION || metadata.projectId !== projectId || metadata.id !== recordingId) throw new Error('Invalid recording');
  return linked(ctx, metadata, ['saved', 'interrupted'].includes(metadata.status));
}
async function linked(ctx, metadata, persist) {
  const source = await sites.resolve(ctx, metadata.url, { ensure: true, libraryId: metadata.libraryId, runId: metadata.runId, kind: metadata.sourceKind, title: metadata.pageName || metadata.name });
  if (persist && (metadata.libraryId !== source.libraryId || metadata.sourceKind !== source.kind)) {
    metadata.libraryId = source.libraryId;
    metadata.sourceKind = source.kind;
    await atomic(path.join(directory(ctx, metadata.projectId, metadata.id), 'meta.json'), metadata);
  }
  return { ...metadata, scope: source.scope, libraryId: source.libraryId, sourceName: source.sourceName, sourceUrl: source.sourceUrl };
}
async function restore(ctx) {
  for (const project of await projects.listProjects(ctx)) await list(ctx, project.id);
}
// Titles only mutate finalized metadata. The recording writer remains the sole
// owner of metadata while capturing, and capture.jsonl is never rewritten.
async function writeTitle(ctx, projectId, recordingId, title, name) {
  const metadata = await readMetadata(ctx, projectId, recordingId);
  if (!['saved', 'interrupted'].includes(metadata.status)) throw new Error('Recording is still running');
  metadata.pageName ||= metadata.name;
  metadata.title = title;
  if (name) metadata.name = name;
  await atomic(path.join(directory(ctx, projectId, recordingId), 'meta.json'), metadata);
  return metadata;
}
// Read one bounded batch at a time for title extraction, including older captures.
// As in playback, only an incomplete final line is recoverable after a crash.
async function visitBatches(ctx, projectId, recordingId, visit, signal) {
  await readMetadata(ctx, projectId, recordingId);
  const file = path.join(directory(ctx, projectId, recordingId), 'capture.jsonl');
  if ((await fs.stat(file)).size > MAX_RECORDING) throw new Error('Recording exceeds the supported size');
  const stream = createReadStream(file, { encoding: 'utf8', signal }), lines = createInterface({ input: stream, crlfDelay: Infinity });
  let previous = null;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (previous) visit(readBatch(previous));
      previous = line;
    }
    if (previous) { let batch; try { batch = readBatch(previous); } catch { return; } visit(batch); }
  } finally { lines.close(); stream.destroy(); }
}
module.exports = { create, list, read, directory, readMetadata, writeTitle, visitBatches, restore };
