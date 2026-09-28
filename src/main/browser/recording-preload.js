// Bundled as a sandboxed, isolated-world preload. Nothing is exposed to the page:
// only the main process can start capture, and the page never receives filesystem APIs.
import { ipcRenderer } from 'electron';
import './catalog-preload.js';
import { record } from '@rrweb/record';
import { MAX_BATCH, resources } from '../../shared/recordings.cjs';

let active = null;
const CHANNEL = 'browser:record-batch';
const PRIVATE = '.rr-block,[data-private],[data-engelbart-annotations]';
const warning = (s, text) => { if (!s.notices.has(text)) { s.notices.add(text); s.warnings.push(text); } };

function documents(s) {
  const out = [document];
  for (let i = 0; i < out.length && i < 30; i++) {
    for (const frame of out[i].querySelectorAll('iframe,frame')) {
      if (frame.closest(PRIVATE)) continue;
      let doc; try { doc = frame.contentDocument; } catch { /* cross-origin */ }
      if (doc) { if (!out.includes(doc)) out.push(doc); }
      else warning(s, 'Some embedded frames could not be captured (cross-origin or inaccessible).');
    }
  }
  if (out.length >= 30) warning(s, 'Some deeply nested frames were not captured.');
  return out.slice(0, 30);
}
function flush(s, end = null) {
  if (!s.events.length && !s.canvas.length && !s.assets.length && !s.warnings.length && !end) return;
  const packet = JSON.stringify({ id: s.id, documentId: s.documentId, seq: s.seq++, at: s.stoppedAt || Date.now(), events: s.events, canvas: s.canvas, assets: s.assets, warnings: s.warnings, end });
  s.events = []; s.canvas = []; s.assets = []; s.warnings = []; s.bytes = 0;
  s.inFlight += packet.length;
  ipcRenderer.send(CHANNEL, packet);
  if (s.inFlight > MAX_BATCH * 2 && !s.ending) void stop('limit', 'Recording could not keep up with this page. The captured portion was saved.');
}
function push(s, kind, value) {
  if (active !== s || s.closed) return;
  const size = JSON.stringify(value).length;
  if (size > MAX_BATCH - 1024) { void stop('limit', 'A page snapshot exceeded the recording size limit.'); return; }
  if (s.bytes + size > MAX_BATCH - 1024) flush(s);
  s[kind].push(value); s.bytes += size;
  if (s.bytes > 256 * 1024) flush(s);
}

// Assets are fetched inside the page's security context: normal CSP/CORS apply.
// Never use main-process fetch to bypass the site's access restrictions.
function cacheAsset(s, input) {
  if (typeof input !== 'string' || !input || /^(?:data:|#)/i.test(input)) return input;
  let url; try { url = new URL(input, location.href); } catch { return input; }
  if (!['http:', 'https:', 'blob:'].includes(url.protocol) || s.seen.has(url.href)) return input;
  if (s.seen.size >= 200 || s.assetBytes > 24 * 1024 * 1024) { warning(s, 'Some images or fonts were not saved because the asset limit was reached.'); return input; }
  s.seen.add(url.href); s.assetQueue.push(url.href); pumpAssets(s);
  return input;
}
function pumpAssets(s) {
  while (!s.closed && s.assetWorkers < 3 && s.assetQueue.length) {
    const url = s.assetQueue.shift(); s.assetWorkers++;
    const task = (async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(2500)]) });
        if (!response.ok) throw new Error('Unavailable asset');
        let type = response.headers.get('content-type')?.split(';')[0] || '';
        if (!/^(image\/(png|jpeg|webp|gif|avif|svg\+xml)|font\/[\w.-]+|application\/(font-woff|vnd.ms-fontobject|octet-stream))$/.test(type)) throw new Error('Unsupported asset');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024 || s.assetBytes + size > 24 * 1024 * 1024) throw new Error('Asset too large'); chunks.push(next.value); }
        } finally { await reader.cancel(); }
        s.assetBytes += size;
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(new Blob(chunks, { type })); });
        push(s, 'assets', { url, dataUrl });
      } catch { if (!s.closed) warning(s, 'Some visual assets could not be saved and may be absent in offline playback.'); }
      finally { s.assetWorkers--; s.tasks.delete(task); pumpAssets(s); }
    })();
    s.tasks.add(task);
  }
}
function sample(s) {
  for (const doc of documents(s)) {
    if (doc.querySelector('video,audio')) warning(s, 'Audio and video playback are not recorded.');
    const roots = [doc];
    for (let i = 0; i < roots.length && i < 100; i++) {
      for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot && !el.closest(PRIVATE)) roots.push(el.shadowRoot);
      for (const canvas of roots[i].querySelectorAll('canvas')) {
        if (canvas.closest(PRIVATE) || !canvas.width || !canvas.height) continue;
        const nodeId = record.mirror.getId(canvas);
        if (nodeId < 0) continue;
        try {
          if (canvas.width * canvas.height > 4_000_000) { warning(s, 'A large canvas was not captured.'); continue; }
          const dataUrl = canvas.toDataURL('image/webp', 0.8);
          if (!dataUrl.startsWith('data:image/')) continue;
          if (s.painted.get(canvas) === dataUrl) continue;
          s.painted.set(canvas, dataUrl);
          push(s, 'canvas', { at: Date.now(), nodeId, dataUrl });
        } catch { warning(s, 'A protected canvas could not be captured.'); }
      }
    }
  }
}
async function stop(end = 'stop', message = null) {
  const s = active;
  if (!s || s.ending) return;
  s.ending = true;
  clearInterval(s.timer); clearInterval(s.frames);
  try { sample(s); s.stop?.(); } catch { warning(s, 'Capture ended unexpectedly.'); }
  s.stoppedAt = Date.now();
  if (message) warning(s, message);
  // Navigation must flush synchronously before this isolated world disappears.
  if (end !== 'navigation') {
    const until = Date.now() + 1800;
    while ((s.tasks.size || s.assetQueue.length) && Date.now() < until) await new Promise(r => setTimeout(r, 30));
  }
  if (s.tasks.size || s.assetQueue.length) warning(s, 'Some visual assets were still loading when capture ended.');
  s.abort.abort();
  push(s, 'events', { type: 5, timestamp: s.stoppedAt, data: { tag: 'engelbart:capture-end', payload: {} } });
  flush(s, end); s.closed = true; active = null;
}
function start(message) {
  if (active || window.top !== window) return;
  const s = { id: message.id, documentId: crypto.randomUUID(), seq: 0, events: [], canvas: [], assets: [], warnings: [], notices: new Set(), bytes: 0, inFlight: 0,
    painted: new WeakMap(), seen: new Set(), assetQueue: [], assetWorkers: 0, assetBytes: 0, tasks: new Set(), abort: new AbortController(), closed: false, ending: false };
  active = s;
  try {
    s.stop = record({
      emit(event) {
        // Discovery does not change recorded event values; rewriting only happens in the player.
        resources(JSON.parse(JSON.stringify(event)), url => cacheAsset(s, url));
        push(s, 'events', event);
      },
      // Route every field through the same policy for snapshots and input events.
      // Ordinary input is part of the replay; passwords and explicit privacy marks are not.
      maskAllInputs: true,
      maskInputFn(value, element) {
        const privateField = !element || element.type?.toLowerCase() === 'password'
          || element.hasAttribute('data-rr-is-password') || element.closest(`${PRIVATE},.rr-mask`);
        return privateField && value ? '•••' : value;
      },
      maskTextSelector: '.rr-mask',
      blockSelector: PRIVATE, inlineStylesheet: true, inlineImages: false, collectFonts: true,
      recordCanvas: false, checkoutEveryNms: 15000,
      sampling: { mousemove: 80, scroll: 100 },
      errorHandler() { warning(s, 'Some page changes could not be captured.'); return true; },
    });
    if (active !== s || s.closed) { s.stop?.(); return; }
    if (!s.stop) throw new Error('Recorder did not start');
    s.timer = setInterval(() => flush(s), 400);
    s.frames = setInterval(() => sample(s), 333);
    sample(s); flush(s);
  } catch { void stop('error', 'The page recorder could not start.'); }
}
ipcRenderer.on('browser:record-command', (_event, message) => {
  if (message?.type === 'start') start(message);
  if (message?.type === 'stop' && message.id === active?.id) void stop();
  if (message?.type === 'ack' && message.id === active?.id && message.documentId === active.documentId) active.inFlight = Math.max(0, active.inFlight - message.bytes);
});
window.addEventListener('pagehide', () => { void stop('navigation'); });
