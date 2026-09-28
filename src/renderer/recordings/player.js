// Runs on engelbart://replay, a different origin from the application. No preload,
// no app APIs and no network access. rrweb's inner iframe also disables scripts.
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { resources } from '../../shared/recordings.cjs';
import './player.css';

let player = null, canvas = [], documents = [], zero = 0, playing = false, position = 0, lastPaint = '', generation = 0;
const root = document.querySelector('#replay');
const send = value => parent.postMessage({ type: 'engelbart:replay', ...value }, 'engelbart://app');
const transparent = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
function fit() {
  if (!player) return;
  const { width, height } = player.iframe.getBoundingClientRect();
  const w = Number(player.iframe.getAttribute('width')) || player.iframe.offsetWidth || width;
  const h = Number(player.iframe.getAttribute('height')) || player.iframe.offsetHeight || height;
  const scale = Math.min(innerWidth / Math.max(1, w), innerHeight / Math.max(1, h));
  player.wrapper.style.transform = `scale(${scale})`;
  player.wrapper.style.transformOrigin = 'top left';
  player.wrapper.style.position = 'absolute';
  player.wrapper.style.left = `${Math.max(0, (innerWidth - w * scale) / 2)}px`;
  player.wrapper.style.top = `${Math.max(0, (innerHeight - h * scale) / 2)}px`;
}
function paint(at) {
  if (!player) return;
  let documentId = null;
  for (const d of documents) { if (d.at > at + zero) break; documentId = d.id; }
  const frames = new Map();
  for (const f of canvas) { if (f.at > at + zero) break; if (f.documentId === documentId) frames.set(f.nodeId, f); }
  const key = `${generation}:` + [...frames.values()].map(f => `${f.nodeId}:${f.at}`).join(',');
  if (key === lastPaint) return;
  lastPaint = key;
  for (const frame of frames.values()) {
    const node = player.getMirror().getNode(frame.nodeId);
    if (!node || node.tagName !== 'CANVAS' || !node.isConnected) continue;
    let image = node.nextElementSibling;
    if (image?.getAttribute('data-engelbart-frame') !== String(frame.nodeId)) {
      image = node.ownerDocument.createElement('img');
      // Same safe bitmap substitution as the web player, without replaying code.
      for (const attr of [...node.attributes]) if (!/^on/i.test(attr.name) && attr.name !== 'src') image.setAttribute(attr.name, attr.value);
      image.setAttribute('data-engelbart-frame', String(frame.nodeId)); image.alt = '';
      node.removeAttribute('id'); node.style.display = 'none'; node.after(image);
    }
    image.src = frame.dataUrl;
  }
}
function status() {
  if (!player) return;
  const at = playing ? player.getCurrentTime() : position; paint(at);
  send({ ready: true, at, duration: player.getMetaData().totalTime, playing });
}
function load(batches) {
  player?.destroy(); player = null; root.replaceChildren(); canvas = []; documents = []; lastPaint = ''; playing = false; position = 0;
  const assets = new Map(), events = [], seen = new Set();
  for (const b of batches) for (const a of b.assets) assets.set(a.url, a.dataUrl);
  let missing = false;
  const replace = url => {
    if (typeof url !== 'string' || !url || /^(?:data:|#)/i.test(url)) return url;
    if (assets.has(url)) return assets.get(url);
    missing = true; return transparent; // Never contact the original site during replay.
  };
  for (const b of batches) {
    if (b.events.length && !seen.has(b.documentId)) { documents.push({ id: b.documentId, at: b.events[0].timestamp }); seen.add(b.documentId); }
    for (const event of b.events) events.push(resources(event, replace));
    for (const f of b.canvas) canvas.push({ ...f, documentId: b.documentId });
  }
  events.sort((a, b) => a.timestamp - b.timestamp); canvas.sort((a, b) => a.at - b.at); documents.sort((a, b) => a.at - b.at);
  if (events.length < 2 || !events.some(e => e.type === 2)) throw new Error('This recording ended before a page snapshot was saved.');
  // An interrupted drawing-only capture can have bitmaps after its last DOM event.
  // Extend rrweb's timeline to the last actually saved batch, not to the current clock.
  const end = batches.reduce((latest, batch) => Math.max(latest, batch.at), events.at(-1).timestamp);
  if (end > events.at(-1).timestamp) events.push({ type: 5, timestamp: end, data: { tag: 'engelbart:saved-end', payload: {} } });
  zero = events[0].timestamp;
  player = new Replayer(events, { root, speed: 1, skipInactive: false, mouseTail: false, UNSAFE_replayCanvas: false });
  player.on('fullsnapshot-rebuilded', () => { generation++; lastPaint = ''; requestAnimationFrame(() => { fit(); paint(playing ? player?.getCurrentTime() || 0 : position); }); });
  player.on('resize', fit);
  player.on('finish', () => { position = player.getMetaData().totalTime; playing = false; status(); });
  player.pause(0); fit(); status();
  if (missing) send({ warning: 'Some visual assets were unavailable when captured; playback does not contact the original site.' });
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== 'engelbart://app' || event.data?.type !== 'engelbart:replay') return;
  try {
    const m = event.data;
    if (m.action === 'load') load(m.batches);
    else if (player && m.action === 'play') { playing = true; player.play(position >= player.getMetaData().totalTime - 50 ? 0 : position); status(); }
    else if (player && m.action === 'pause') { position = player.getCurrentTime(); player.pause(); playing = false; status(); }
    else if (player && m.action === 'seek' && Number.isFinite(m.at)) { position = Math.max(0, Math.min(player.getMetaData().totalTime, m.at)); if (playing) player.play(position); else player.pause(position); generation++; paint(position); status(); }
  } catch (error) { send({ error: error.message }); }
});
setInterval(() => { if (playing) status(); }, 100);
window.addEventListener('resize', fit);
