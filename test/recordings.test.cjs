'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const schema = require('../src/shared/recordings.cjs');
const recordings = require('../src/main/store/recordings.cjs');
const { createRecordings } = require('../src/main/browser/recordings.cjs');
const { createRecordingTitles } = require('../src/main/browser/recording-titles.cjs');
const { createStore } = require('../src/main/ipc.cjs');
const projects = require('../src/main/store/projects.cjs');

const packet = (recordingId, documentId = randomUUID(), seq = 0) => ({ id: recordingId, documentId, seq, at: 1100,
  events: [{ type: 4, timestamp: 1000, data: { href: 'https://example.com', width: 700, height: 500 } }, { type: 2, timestamp: 1010, data: { node: { type: 0, id: 1, childNodes: [] } } }],
  canvas: [], assets: [], warnings: [], end: null });
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engelbart-recordings-test-'));
  const store = createStore({ homeDir: root, fixturesDir: path.join(__dirname, '../fixtures') });
  const ctx = await store.context();
  const project = await projects.createProject(ctx, { name: 'Recordings' });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { ctx, project, store };
}

test('recording protocol bounds input and rejects paths, arbitrary assets and invalid frames', () => {
  const batch = packet(randomUUID());
  assert.deepEqual(schema.readBatch(JSON.stringify(batch)), batch);
  for (const value of ['../../secret', '', 'a', 4]) assert.throws(() => schema.id(value));
  assert.equal(schema.pageUrl('https://example.com/a?token=secret#b'), 'https://example.com/a');
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com']) assert.throws(() => schema.pageUrl(value));
  for (const broken of [{ ...batch, seq: -1 }, { ...batch, events: [{ type: 7, timestamp: 1 }] }, { ...batch, canvas: [{ at: 1, nodeId: 1, dataUrl: 'https://example.com/a' }] }, { ...batch, assets: [{ url: 'x', dataUrl: 'data:text/html;base64,Zm9v' }] }]) assert.throws(() => schema.readBatch(JSON.stringify(broken)));
  assert.throws(() => schema.readBatch(' '.repeat(schema.MAX_BATCH + 1)));
});

test('asset visitor rewrites image and CSS references without changing links or text', () => {
  const event = { type: 2, data: { node: { tagName: 'div', attributes: { style: 'background:url(https://example.com/a.png)' }, childNodes: [
    { tagName: 'img', attributes: { src: 'https://example.com/a.png', srcset: 'other.png 2x' } },
    { tagName: 'a', attributes: { href: 'https://example.com/a.png' }, childNodes: [{ textContent: 'https://example.com/a.png' }] },
    { isStyle: true, textContent: '@font-face{src:url("https://example.com/font.woff2")}' },
  ] } } };
  schema.resources(event, value => `saved:${value}`);
  const n = event.data.node;
  assert.match(n.attributes.style, /saved:https/);
  assert.match(n.childNodes[0].attributes.src, /^saved:/);
  assert.equal(n.childNodes[0].attributes.srcset, undefined);
  assert.equal(n.childNodes[1].attributes.href, 'https://example.com/a.png');
  assert.equal(n.childNodes[1].childNodes[0].textContent, 'https://example.com/a.png');
  assert.match(n.childNodes[2].textContent, /saved:https/);
});

test('local recording persists batches, metadata and assets; projects stay isolated', async t => {
  const { ctx, project } = await setup(t);
  const writer = await recordings.create(ctx, { projectId: project.id, url: 'https://example.com/?secret=1', name: 'Demo' });
  const batch = packet(writer.metadata.id);
  batch.canvas = [{ at: 1090, nodeId: 4, dataUrl: 'data:image/png;base64,YQ==' }];
  batch.assets = [{ url: 'https://example.com/pic.png', dataUrl: 'data:image/png;base64,YQ==' }];
  await writer.append(batch);
  const whileActive = await recordings.list(ctx, project.id, writer.metadata.id);
  assert.equal(whileActive[0].status, 'recording');
  await writer.finish();
  const read = await recordings.read(ctx, project.id, writer.metadata.id);
  assert.equal(read.metadata.status, 'saved');
  assert.equal(read.metadata.events, 2);
  assert.equal(read.metadata.frames, 1);
  assert.equal(read.metadata.durationMs, 100);
  assert.deepEqual(read.batches, [batch]);
  assert.equal(read.metadata.url, 'https://example.com/');
  assert.ok((await fs.stat(path.join(recordings.directory(ctx, project.id, writer.metadata.id), 'capture.jsonl'))).mode & 0o600);
  const other = await projects.createProject(ctx, { name: 'Other' });
  assert.deepEqual(await recordings.list(ctx, other.id), []);
  await assert.rejects(recordings.read(ctx, other.id, writer.metadata.id));
  await assert.rejects(recordings.read(ctx, project.id, '../secret'));
});

test('interrupted captures recover complete batches and tolerate an incomplete crash tail', async t => {
  const { ctx, project } = await setup(t);
  const writer = await recordings.create(ctx, { projectId: project.id, url: 'https://example.com' });
  await writer.append(packet(writer.metadata.id)); await writer.finish();
  const dir = recordings.directory(ctx, project.id, writer.metadata.id);
  const metadata = { ...writer.metadata, status: 'recording', events: 0 };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(metadata));
  await fs.appendFile(path.join(dir, 'capture.jsonl'), '{"incomplete":');
  const [recovered] = await recordings.list(ctx, project.id);
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.events, 2);
  assert.match(recovered.warnings.join(' '), /interrupted/);
  assert.equal((await recordings.read(ctx, project.id, recovered.id)).batches.length, 1);
});

test('canvas-only activity extends the persisted recording timeline', async t => {
  const { ctx, project } = await setup(t);
  const writer = await recordings.create(ctx, { projectId: project.id, url: 'https://example.com' });
  const initial = packet(writer.metadata.id);
  await writer.append(initial);
  await writer.append({ ...initial, seq: 1, at: 2500, events: [], canvas: [{ at: 2490, nodeId: 4, dataUrl: 'data:image/png;base64,YQ==' }] });
  await writer.finish('Recording was interrupted.');
  const saved = await recordings.read(ctx, project.id, writer.metadata.id);
  assert.equal(saved.metadata.durationMs, 1500);
  assert.equal(saved.metadata.status, 'interrupted');
  assert.equal(saved.metadata.frames, 1);
});

function page() {
  const wc = new EventEmitter(); let dead = false;
  Object.assign(wc, { mainFrame: {}, sent: [], url: 'https://example.com/app', throttled: true,
    isDestroyed: () => dead, isLoading: () => false, getURL: () => wc.url, getTitle: () => 'Demo',
    getBackgroundThrottling: () => wc.throttled, setBackgroundThrottling: value => { wc.throttled = value; },
    send(channel, value) { wc.sent.push([channel, value]); wc.respond?.(value); },
    crash() { dead = true; wc.emit('render-process-gone'); },
  });
  return wc;
}
async function settled(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Did not settle'); }

test('controller owns one tab, validates sender, deduplicates batches and flushes before Stop completes', async t => {
  const { ctx, project } = await setup(t), wc = page(), reports = [];
  const service = createRecordings({ getContext: async () => ctx, send: (...args) => reports.push(args), stopTimeout: 100 });
  service.attach('tab', wc);
  const started = await service.start('tab', project.id), b = packet(started.id);
  await assert.rejects(service.start('tab', project.id), /Stop the current/);
  wc.emit('ipc-message', { senderFrame: {} }, 'browser:record-batch', JSON.stringify(b));
  assert.equal(service.current().events, 0);
  wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'browser:record-batch', JSON.stringify(b));
  wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'browser:record-batch', JSON.stringify(b));
  await settled(() => service.current()?.events === 2);
  assert.equal(wc.throttled, false);
  wc.respond = m => { if (m.type === 'stop') { const final = { ...b, seq: 1, events: [{ type: 5, timestamp: 1200, data: { tag: 'end', payload: {} } }], at: 1200, end: 'stop' }; queueMicrotask(() => wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'browser:record-batch', JSON.stringify(final))); } };
  const result = await service.stopTab('tab');
  assert.equal(result.status, 'saved'); assert.equal(result.events, 3); assert.equal(wc.throttled, true);
  assert.equal(service.current(), null);
  assert.equal((await service.read(project.id, started.id)).batches.length, 2);
  assert.equal(reports.at(-1)[1].status, 'saved');
});

test('controller restarts capture on same-site reload, and preserves saved data on a crash', async t => {
  const { ctx, project } = await setup(t), wc = page();
  const service = createRecordings({ getContext: async () => ctx, send() {}, stopTimeout: 10 });
  service.attach('tab', wc);
  const started = await service.start('tab', project.id);
  wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'browser:record-batch', JSON.stringify(packet(started.id)));
  await settled(() => service.current()?.events === 2);
  wc.emit('dom-ready');
  assert.equal(wc.sent.filter(([, m]) => m.type === 'start').length, 2);
  wc.crash();
  await settled(() => !service.current());
  const [row] = await service.list(project.id);
  assert.equal(row.status, 'interrupted'); assert.equal(row.events, 2);
});

test('unresponsive recorder is finalized honestly instead of an endless recording indicator', async t => {
  const { ctx, project } = await setup(t), wc = page();
  const service = createRecordings({ getContext: async () => ctx, send() {}, stopTimeout: 10 });
  service.attach('tab', wc); await service.start('tab', project.id);
  const ended = await service.stop();
  assert.equal(ended.status, 'interrupted'); assert.match(ended.warnings.join(' '), /final capture batch/);
  assert.equal(service.current(), null);
});

test('metadata-only captures are never advertised as recording or successfully saved', async t => {
  const { ctx, project } = await setup(t);
  const writer = await recordings.create(ctx, { projectId: project.id, url: 'https://example.com' });
  const batch = packet(writer.metadata.id); batch.events = batch.events.slice(0, 1);
  await writer.append(batch);
  assert.equal(writer.metadata.status, 'starting');
  assert.equal((await writer.finish()).status, 'interrupted');
});

test('a different-site navigation stops capture and never arms the new page', async t => {
  const { ctx, project } = await setup(t), wc = page();
  const service = createRecordings({ getContext: async () => ctx, send() {}, stopTimeout: 10 });
  service.attach('tab', wc);
  const started = await service.start('tab', project.id);
  wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'browser:record-batch', JSON.stringify(packet(started.id)));
  await settled(() => service.current()?.events === 2);
  wc.url = 'https://different.example'; wc.emit('dom-ready');
  await settled(() => !service.current());
  assert.equal(wc.sent.filter(([, m]) => m.type === 'start').length, 1);
  const [row] = await service.list(project.id);
  assert.match(row.warnings.join(' '), /different site/);
});

test('replay runs on a restricted separate origin; app permissions do not enter recordings', async () => {
  const html = await fs.readFile(path.join(__dirname, '../src/renderer/recordings/player.html'), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src data: blob:; font-src data:/);
  assert.doesNotMatch(html, /https:|unsafe-eval|unsafe-inline.*script-src/);
  const player = await fs.readFile(path.join(__dirname, '../src/renderer/recordings/player.js'), 'utf8');
  assert.match(player, /UNSAFE_replayCanvas: false/);
  assert.match(player, /event.source !== parent \|\| event.origin !== 'engelbart:\/\/app'/);
  assert.doesNotMatch(player, /engelbartAPI|ipcRenderer|fetch\(/);
});

function titledPacket(id) {
  const b = packet(id);
  b.events[1].data.node.childNodes = [{ type: 2, id: 2, tagName: 'body', attributes: {}, childNodes: [
    { type: 2, id: 3, tagName: 'button', attributes: {}, childNodes: [{ type: 3, id: 4, textContent: 'Save settings' }] },
    { type: 2, id: 5, tagName: 'input', attributes: { 'aria-label': 'Project name', value: 'private-initial-value' }, childNodes: [] },
  ] }];
  b.events.push({ type: 3, timestamp: 1050, data: { source: 5, id: 5, text: 'private-edited-value' } },
    { type: 3, timestamp: 1090, data: { source: 2, type: 2, id: 3 } });
  return b;
}
async function oldRecording(ctx, projectId, events = titledPacket) {
  const writer = await recordings.create(ctx, { projectId, url: 'https://example.com', name: 'Create Next App' });
  await writer.append(events(writer.metadata.id));
  return writer.finish();
}

test('saving does not wait for naming; title completion cannot replace a newer active recording', async t => {
  const { ctx, project } = await setup(t), wc = page(), reports = [], calls = [];
  let release;
  const service = createRecordings({ getContext: async () => ctx, send: (...args) => reports.push(args), stopTimeout: 10,
    summarizeTitle: input => { calls.push(input); return new Promise(resolve => { release = resolve; }); } });
  service.attach('tab', wc);
  const started = await service.start('tab', project.id), b = titledPacket(started.id);
  wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'browser:record-batch', JSON.stringify(b));
  await settled(() => service.current()?.events === 4);
  wc.respond = m => { if (m.type === 'stop') queueMicrotask(() => wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'browser:record-batch', JSON.stringify({ ...b, seq: 1, events: [], end: 'stop' }))); };
  const ended = await service.stop();
  assert.equal(ended.status, 'saved'); assert.equal(ended.name, 'Demo');
  await settled(() => calls.length === 1);
  const next = await service.start('tab', project.id);
  release({ summary: '{"title":"Editing project settings"}', meta: { provider: 'test', model: 'small' } });
  await settled(() => reports.some(([channel, row]) => channel === 'browser:recording-updated' && row.title?.status === 'ready'));
  const updated = await recordings.read(ctx, project.id, started.id);
  assert.equal(updated.metadata.name, 'Editing project settings'); assert.equal(updated.metadata.pageName, 'Demo');
  assert.deepEqual(updated.batches[0], b, 'title generation never modifies playback events');
  assert.equal(service.current().id, next.id);
  assert.equal(reports.filter(([channel]) => channel === 'browser:recording').at(-1)[1].id, next.id);
  assert.doesNotMatch(calls[0].text, /private-initial-value|private-edited-value|https:\/\//);
  assert.match(calls[0].text, /Save settings/); assert.match(calls[0].systemPrompt, /untrusted evidence/);
  wc.respond = null; await service.stop(); await service.cancelTitles();
});

test('opening the list backfills old recordings once and retains the original page title', async t => {
  const { ctx, project } = await setup(t);
  const row = await oldRecording(ctx, project.id), calls = [];
  const service = createRecordings({ getContext: async () => ctx, send() {}, summarizeTitle: async input => { calls.push(input); return { summary: '{"title":"Updating project settings"}' }; } });
  await service.list(project.id); await service.list(project.id);
  await settled(async () => (await recordings.readMetadata(ctx, project.id, row.id)).title?.status === 'ready');
  const [updated] = await service.list(project.id);
  assert.equal(calls.length, 1); assert.equal(updated.name, 'Updating project settings'); assert.equal(updated.pageName, 'Create Next App');
  assert.equal(updated.title.stats.actions, 3); await service.cancelTitles();
});

test('weak evidence keeps the page title without making a model request', async t => {
  const { ctx, project } = await setup(t), row = await oldRecording(ctx, project.id, packet);
  const worker = createRecordingTitles({ summarize: async () => { throw new Error('Must not call a model'); } });
  worker.enqueue(ctx, row);
  await settled(() => worker.pending === 0);
  const saved = await recordings.readMetadata(ctx, project.id, row.id);
  assert.equal(saved.name, row.name); assert.equal(saved.title.status, 'fallback'); assert.equal(saved.title.reason, 'insufficient-evidence');
});

test('invalid and unavailable model responses preserve playback and retry with a cooldown and a limit', async t => {
  const { ctx, project } = await setup(t), row = await oldRecording(ctx, project.id);
  let clock = 1000, calls = 0;
  const worker = createRecordingTitles({ now: () => clock, summarize: async () => { calls++; if (calls === 1) throw Object.assign(new Error('No provider'), { kind: 'unavailable' }); return { summary: 'Not a JSON title' }; } });
  worker.enqueue(ctx, row); await settled(() => worker.pending === 0);
  let current = await recordings.readMetadata(ctx, project.id, row.id);
  assert.equal(current.title.reason, 'unavailable'); assert.equal(current.name, row.name);
  worker.enqueue(ctx, current); assert.equal(worker.pending, 0, 'no retries on every renderer refresh');
  for (let i = 0; i < 3; i++) {
    clock += 301000; worker.enqueue(ctx, current); await settled(() => worker.pending === 0);
    current = await recordings.readMetadata(ctx, project.id, row.id);
  }
  assert.equal(calls, 3); assert.equal(current.title.status, 'failed');
  assert.equal((await recordings.read(ctx, project.id, row.id)).metadata.status, 'saved');
});

test('timeouts, cancellation and resumed pending jobs do not leave the queue stuck or accept late titles', async t => {
  const { ctx, project } = await setup(t), row = await oldRecording(ctx, project.id);
  const timeout = createRecordingTitles({ timeoutMs: 15, summarize: () => new Promise(() => {}) });
  timeout.enqueue(ctx, row); await settled(() => timeout.pending === 0);
  assert.equal((await recordings.readMetadata(ctx, project.id, row.id)).title.status, 'failed');
  const other = await oldRecording(ctx, project.id); let release, calls = 0;
  const worker = createRecordingTitles({ summarize: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  worker.enqueue(ctx, other); await settled(() => calls === 1);
  await worker.cancel(); assert.equal(worker.pending, 0);
  release({ summary: '{"title":"This cancelled result must not win"}' });
  const pending = await recordings.readMetadata(ctx, project.id, other.id);
  assert.equal(pending.title.status, 'pending'); assert.equal(pending.name, other.name);
  const resumed = createRecordingTitles({ summarize: async () => ({ summary: '{"title":"Changing project settings"}' }) });
  resumed.enqueue(ctx, pending); await settled(() => resumed.pending === 0);
  assert.equal((await recordings.readMetadata(ctx, project.id, other.id)).title.status, 'ready');
});

test('naming cannot mutate a running recording or cross project boundaries', async t => {
  const { ctx, project } = await setup(t), writer = await recordings.create(ctx, { projectId: project.id, url: 'https://example.com' });
  await assert.rejects(recordings.writeTitle(ctx, project.id, writer.metadata.id, { status: 'ready' }, 'Title'), /still running/);
  await writer.finish();
  const other = await projects.createProject(ctx, { name: 'Other' });
  await assert.rejects(recordings.writeTitle(ctx, other.id, writer.metadata.id, { status: 'ready' }, 'Title'));
});
