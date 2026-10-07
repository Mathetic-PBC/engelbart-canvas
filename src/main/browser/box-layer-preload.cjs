'use strict';
// The drawing layer for boxes (MATH-70 build 1, 2026-10-07): a transparent view main lays over a Stage page only while a
// box is being drawn (views.cjs startBox), since a native view cannot let clicks through to the one below it. This is
// all it runs: a drag draws the box and is sent to main (done, in the layer's pixels, which are the page view's); a click
// that does not drag is sent as a click (main asks the page which box's edge it is on); Esc cancels. Releasing ⌥ is
// main's to judge (alt-up), but a drag that is under way when it is let go is finished first. Sandboxed and isolated: it
// talks to main only over its own view's ipc.
// MATH-70 build 2 (2026-10-07): it looks like macOS's ⌘⇧4. Before the press, a crosshair with the pointer's place on the
// screen (event.screenX, event.screenY) as two small numbers stacked at its lower right; while dragging, a translucent
// grey rectangle with a thin light edge and its width and height stacked beside the pointer. Both are in points (CSS
// pixels of this view, which is never zoomed: the screen's points), which is what ⌘⇧4 shows on a Retina display as far as
// we know (READOUT_SCALE; not compared side by side yet). No words over the page: Esc still cancels, ⌥ still draws.

const CHANNELS = Object.freeze({ start: 'engelbart-box:start', done: 'engelbart-box:done', click: 'engelbart-box:click', cancel: 'engelbart-box:cancel', altUp: 'engelbart-box:alt-up' });
const MIN = 6; // pixels: a smaller drag is a click
// What the readouts count in: 1, points (macOS's ⌘⇧4 on a Retina display, as far as we know); devicePixelRatio for pixels.
const READOUT_SCALE = 'points';
const READOUT_GAP = 14; // pixels from the pointer to the numbers' corner, as ⌘⇧4 sets them

/** The two numbers the readout shows: the pointer's place before the press, the rectangle's size while dragging. */
function readout({ dragging, screenX, screenY, w, h }, scale = 1) {
  const n = (v) => String(Math.round((Number(v) || 0) * scale));
  return dragging ? [n(w), n(h)] : [n(screenX), n(screenY)];
}

/** Where the readout's corner goes: below and right of the pointer, flipped to its other side near the layer's edges. */
function readoutAt(x, y, size, view, gap = READOUT_GAP) {
  const left = x + gap + size.width <= view.width ? x + gap : x - gap - size.width;
  const top = y + gap + size.height <= view.height ? y + gap : y - gap - size.height;
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

function runInLayer() {
  const { ipcRenderer } = require('electron');
  let from = null, rect = null, mode = 'button', altGone = false;
  let frame = null, numbers = null, pointer = null;
  const scale = () => (READOUT_SCALE === 'points' ? 1 : window.devicePixelRatio || 1);

  function build() {
    const style = document.createElement('style');
    style.textContent = 'html,body{margin:0;height:100%;background:transparent;cursor:crosshair;user-select:none;overflow:hidden}'
      + '#f{position:fixed;display:none;box-sizing:border-box;border:1px solid rgba(255,255,255,.75);background:rgba(110,110,110,.28);pointer-events:none}'
      // ⌘⇧4's numbers: small, dark, each line right under the other, with a light halo that reads on any page
      + '#n{position:fixed;display:none;pointer-events:none;font:500 10.5px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;font-variant-numeric:tabular-nums;'
      + 'color:#1d1d1f;text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 1px #fff;white-space:pre;text-align:left}';
    document.head.appendChild(style);
    frame = document.createElement('div'); frame.id = 'f';
    numbers = document.createElement('div'); numbers.id = 'n';
    document.body.append(frame, numbers);
  }
  function showNumbers() {
    if (!numbers || !pointer) return;
    const [a, b] = readout({ dragging: !!(from && rect && (rect.w || rect.h)), screenX: pointer.screenX, screenY: pointer.screenY, w: rect && rect.w, h: rect && rect.h }, scale());
    const text = `${a}\n${b}`;
    if (numbers.textContent !== text) numbers.textContent = text;
    numbers.style.display = 'block';
    const at = readoutAt(pointer.x, pointer.y, { width: numbers.offsetWidth, height: numbers.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    numbers.style.left = `${at.left}px`;
    numbers.style.top = `${at.top}px`;
  }
  const reset = () => { from = null; rect = null; altGone = false; if (frame) frame.style.display = 'none'; showNumbers(); };
  const send = (channel, value) => { ipcRenderer.send(channel, value); pointer = null; if (numbers) numbers.style.display = 'none'; reset(); };

  ipcRenderer.on(CHANNELS.start, (_event, value) => {
    if (!frame) build();
    mode = value && value.mode === 'alt' ? 'alt' : 'button';
    // where the pointer is as the layer comes up (main's), so the numbers show before it moves
    const at = value && value.at;
    pointer = at && [at.x, at.y, at.screenX, at.screenY].every(Number.isFinite) ? { ...at } : null;
    reset();
  });
  // ⌥ let go: the layer goes, unless a box is being drawn, which is finished when the mouse is let go
  const altUp = () => { if (from) altGone = true; else send(CHANNELS.cancel, { reason: 'alt' }); };
  ipcRenderer.on(CHANNELS.altUp, altUp);

  const track = (event) => { pointer = { x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY }; };
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    track(event);
    from = { x: event.clientX, y: event.clientY };
    rect = { x: from.x, y: from.y, w: 0, h: 0 };
    showNumbers();
  });
  window.addEventListener('mousemove', (event) => {
    track(event);
    if (from) {
      const x = Math.max(0, Math.min(event.clientX, window.innerWidth)), y = Math.max(0, Math.min(event.clientY, window.innerHeight));
      rect = { x: Math.min(from.x, x), y: Math.min(from.y, y), w: Math.abs(x - from.x), h: Math.abs(y - from.y) };
      Object.assign(frame.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    }
    showNumbers();
  });
  window.addEventListener('mouseup', (event) => {
    if (!from || event.button !== 0) return;
    if (rect && rect.w >= MIN && rect.h >= MIN) send(CHANNELS.done, rect);
    else send(CHANNELS.click, { x: from.x, y: from.y, alt: altGone });
  });
  window.addEventListener('mouseleave', () => { if (!from && numbers) numbers.style.display = 'none'; });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); send(CHANNELS.cancel, { reason: 'escape' }); } });
  window.addEventListener('keyup', (event) => { if (event.key === 'Alt' && mode === 'alt') altUp(); });
  window.addEventListener('blur', () => { if (!from) return; reset(); });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof require === 'function') runInLayer();
else if (typeof module === 'object' && module && module.exports) module.exports = { CHANNELS, MIN, READOUT_SCALE, READOUT_GAP, readout, readoutAt };
