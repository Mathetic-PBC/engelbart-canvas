'use strict';
// The drawing layer for boxes (MATH-70 build 1, 2026-10-07): a transparent view main lays over a Stage page only while a
// box is being drawn (views.cjs startBox), since a native view cannot let clicks through to the one below it. This is
// all it runs: a drag draws the box and is sent to main (done, in the layer's pixels, which are the page view's); a click
// that does not drag is sent as a click (main asks the page which box it is on); Esc cancels. Releasing ⌥ is main's to
// judge (alt-up), but a drag that is under way when it is let go is finished first. Sandboxed and isolated: it talks to
// main only over its own view's ipc.

const CHANNELS = Object.freeze({ start: 'engelbart-box:start', done: 'engelbart-box:done', click: 'engelbart-box:click', cancel: 'engelbart-box:cancel', altUp: 'engelbart-box:alt-up' });
const MIN = 6; // pixels: a smaller drag is a click

function runInLayer() {
  const { ipcRenderer } = require('electron');
  let from = null, rect = null, mode = 'button', altGone = false;
  let frame = null, hint = null;

  function build() {
    const style = document.createElement('style');
    style.textContent = 'html,body{margin:0;height:100%;background:transparent;cursor:crosshair;user-select:none;overflow:hidden}'
      + '#f{position:fixed;display:none;box-sizing:border-box;border:2px solid #0070f3;border-radius:3px;background:rgba(0,112,243,.06)}'
      + '#h{position:fixed;left:50%;top:10px;transform:translateX(-50%);padding:6px 10px;border-radius:8px;background:#171717;color:#fff;'
      + 'font:400 12.5px/1 -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.12)}';
    document.head.appendChild(style);
    frame = document.createElement('div'); frame.id = 'f';
    hint = document.createElement('div'); hint.id = 'h';
    document.body.append(frame, hint);
  }
  const reset = () => { from = null; rect = null; altGone = false; if (frame) frame.style.display = 'none'; };
  const send = (channel, value) => { ipcRenderer.send(channel, value); reset(); };

  ipcRenderer.on(CHANNELS.start, (_event, value) => {
    if (!frame) build();
    reset();
    mode = value && value.mode === 'alt' ? 'alt' : 'button';
    hint.textContent = mode === 'alt' ? 'Drag to box part of the page' : 'Drag to box part of the page · Esc to cancel';
  });
  // ⌥ let go: the layer goes, unless a box is being drawn, which is finished when the mouse is let go
  const altUp = () => { if (from) altGone = true; else send(CHANNELS.cancel, { reason: 'alt' }); };
  ipcRenderer.on(CHANNELS.altUp, altUp);

  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    from = { x: event.clientX, y: event.clientY };
    rect = { x: from.x, y: from.y, w: 0, h: 0 };
  });
  window.addEventListener('mousemove', (event) => {
    if (!from) return;
    const x = Math.max(0, Math.min(event.clientX, window.innerWidth)), y = Math.max(0, Math.min(event.clientY, window.innerHeight));
    rect = { x: Math.min(from.x, x), y: Math.min(from.y, y), w: Math.abs(x - from.x), h: Math.abs(y - from.y) };
    Object.assign(frame.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  });
  window.addEventListener('mouseup', (event) => {
    if (!from || event.button !== 0) return;
    if (rect && rect.w >= MIN && rect.h >= MIN) send(CHANNELS.done, rect);
    else send(CHANNELS.click, { x: from.x, y: from.y, alt: altGone });
  });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); send(CHANNELS.cancel, { reason: 'escape' }); } });
  window.addEventListener('keyup', (event) => { if (event.key === 'Alt' && mode === 'alt') altUp(); });
  window.addEventListener('blur', () => { if (!from) return; reset(); });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof require === 'function') runInLayer();
else if (typeof module === 'object' && module && module.exports) module.exports = { CHANNELS, MIN };
