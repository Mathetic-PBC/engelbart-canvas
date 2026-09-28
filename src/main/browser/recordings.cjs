'use strict';

const saved = require('../store/recordings.cjs');
const { readBatch, pageUrl } = require('../../shared/recordings.cjs');
const { createRecordingTitles } = require('./recording-titles.cjs');

function createRecordings({ getContext, send, stopTimeout = 3500, summarizeTitle }) {
  const pages = new Map();
  const titles = createRecordingTitles({ summarize: summarizeTitle, send });
  let active = null, starting = false;
  const publish = () => send('browser:recording', active ? { ...active.writer.metadata, tabId: active.tabId } : null);
  function attach(tabId, contents) {
    pages.set(tabId, contents);
    const issueStart = () => {
      if (!active || active.tabId !== tabId || active.finishing || active.stopping) return;
      let origin; try { origin = new URL(contents.getURL()).origin; } catch { origin = null; }
      if (origin !== active.origin) { void stop('Recording stopped when the tab moved to a different site.'); return; }
      contents.send('browser:record-command', { type: 'start', id: active.writer.metadata.id });
    };
    const receive = (event, channel, text) => {
      const a = active;
      if (channel !== 'browser:record-batch' || !a || a.tabId !== tabId || event.senderFrame !== contents.mainFrame) return;
      let batch;
      try { batch = readBatch(text); } catch { void stop('The recorder returned invalid or oversized data. Previously saved batches are available.'); return; }
      if (batch.id !== a.writer.metadata.id) return;
      a.pending = a.pending.then(async () => {
        if (a.closed || (a.sequences.get(batch.documentId) ?? -1) >= batch.seq) return;
        if ((a.sequences.get(batch.documentId) ?? -1) + 1 !== batch.seq) batch.warnings.push('Some recording batches were missing.');
        await a.writer.append(batch);
        a.sequences.set(batch.documentId, batch.seq);
        if (!contents.isDestroyed()) contents.send('browser:record-command', { type: 'ack', id: batch.id, documentId: batch.documentId, bytes: text.length });
        publish();
        if (batch.end === 'stop') a.stopped?.();
        if (batch.end === 'limit' || batch.end === 'error') void finish(a, 'Capture ended early. The available portion was saved.');
      }).catch(error => { void finish(a, error.message); });
    };
    const gone = () => { if (active?.tabId === tabId) void finish(active, 'The page closed unexpectedly. Previously saved batches are available.'); };
    contents.on('dom-ready', issueStart);
    contents.on('ipc-message', receive);
    contents.on('render-process-gone', gone);
    contents.once('destroyed', () => { gone(); pages.delete(tabId); });
  }
  async function start(tabId, projectId) {
    if (active || starting) throw new Error('Stop the current recording before starting another.');
    const contents = pages.get(tabId);
    if (!contents || contents.isDestroyed() || contents.isLoading()) throw new Error('Wait for the page to finish loading.');
    const url = pageUrl(contents.getURL());
    starting = true;
    try {
      const ctx = await getContext(), writer = await saved.create(ctx, { projectId, url, name: contents.getTitle() });
      if (contents.isDestroyed()) { await writer.finish('The tab closed before recording started.'); throw new Error('This tab is closed'); }
      let currentUrl; try { currentUrl = pageUrl(contents.getURL()); } catch { currentUrl = null; }
      if (contents.isLoading() || currentUrl !== url) {
        await writer.finish('The page changed before recording started.');
        throw new Error('The page changed. Press Record again when it finishes loading.');
      }
      const a = { tabId, contents, ctx, writer, origin: new URL(url).origin, pending: Promise.resolve(), sequences: new Map(), throttling: contents.getBackgroundThrottling(), closed: false, finishing: null };
      active = a;
      contents.setBackgroundThrottling(false);
      publish();
      contents.send('browser:record-command', { type: 'start', id: writer.metadata.id });
      a.startTimer = setTimeout(() => { if (active === a && writer.metadata.status === 'starting') void stop('The page did not confirm recording.'); }, 6000);
      a.startTimer.unref?.();
      return { ...writer.metadata, tabId };
    } finally { starting = false; }
  }
  async function finish(a, reason) {
    if (a.finishing) return a.finishing;
    a.finishing = (async () => {
      clearTimeout(a.startTimer);
      if (!a.contents.isDestroyed()) {
        a.contents.send('browser:record-command', { type: 'stop', id: a.writer.metadata.id });
        a.contents.setBackgroundThrottling(a.throttling);
      }
      await a.pending;
      a.closed = true;
      let metadata;
      try { metadata = await a.writer.finish(reason); }
      catch {
        metadata = { ...a.writer.metadata, status: 'interrupted', warnings: [...a.writer.metadata.warnings, 'The recording could not be finalized on disk. Previously written batches may be recoverable.'] };
      }
      if (active === a) active = null;
      send('browser:recording', { ...metadata, tabId: a.tabId });
      titles.enqueue(a.ctx, metadata);
      return metadata;
    })();
    return a.finishing;
  }
  async function stop(reason = null) {
    const a = active;
    if (!a) return null;
    if (a.finishing) return a.finishing;
    if (a.stopping) return a.stopping;
    a.stopping = (async () => {
      if (!a.contents.isDestroyed()) {
        let timer;
        const ended = new Promise(resolve => { a.stopped = resolve; timer = setTimeout(() => resolve(false), stopTimeout); });
        a.contents.send('browser:record-command', { type: 'stop', id: a.writer.metadata.id });
        const flushed = await ended; clearTimeout(timer);
        if (flushed === false) reason ||= 'The final capture batch was unavailable. Previously saved batches are available.';
      }
      return finish(a, reason);
    })();
    return a.stopping;
  }
  return {
    attach, start, stop,
    current: () => active ? { ...active.writer.metadata, tabId: active.tabId } : null,
    stopTab: tabId => active?.tabId === tabId ? stop() : Promise.resolve(),
    list: async (projectId, url) => {
      const ctx = await getContext(), rows = await saved.list(ctx, projectId, active?.writer.metadata.id, url);
      for (const row of rows) titles.enqueue(ctx, row);
      return rows;
    },
    cancelTitles: () => titles.cancel(),
    read: async (projectId, recordingId) => {
      if (active?.writer.metadata.id === recordingId) throw new Error('Stop recording before opening playback.');
      return saved.read(await getContext(), projectId, recordingId);
    },
  };
}
module.exports = { createRecordings };
