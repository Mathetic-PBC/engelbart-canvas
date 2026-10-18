'use strict';

// MATH-70 build 1 (2026-10-07): boxes on web pages. A box is drawn on a transparent layer laid over the page while
// drawing (src/main/browser/box-layer-preload.cjs, views.cjs startBox), kept by the element under it as fractions of its
// rectangle (page-preload.cjs), saved as a mark in the page's "web" list with a picture of it and the text under it
// (store/library.cjs), drawn by one html::after rule (browser/boxes.cjs boxesCss), removed with Backspace and put back
// with Undo, and shown to @bart as <box crop="…"> (bart/highlights.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const PAGE = require('../src/main/browser/page-preload.cjs');
const LAYER = require('../src/main/browser/box-layer-preload.cjs');
const BOX = require('../src/main/browser/boxes.cjs');
const { BOX_LAYER_PRELOAD, marksForPage, boxReplyInput, boxReportInput, createBrowserViews } = require('../src/main/browser/views.cjs');
const library = require('../src/main/store/library.cjs');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { WEB } = require('../src/shared/mark-answers.cjs');
const { marksOf, webMarksOf, webStageBlock, mentionedBlock } = require('../src/main/bart/highlights.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');

const anchor = { selector: 'div:nth-of-type(2) > img:nth-of-type(1)', tag: 'img', src: '/chart.png', text: 'A chart of the results' };
const boxMark = (id, extra = {}) => ({ id, box: { x: 0.1, y: 0.2, w: 0.5, h: 0.4, anchor, doc: { x: 100, y: 900, w: 300, h: 200, width: 1200 } }, crop: `crops/${id}.png`, text: 'Figure 2: results', note: null, at: '2026-10-07T00:00:00.000Z', ...extra });
const webMark = (id, exact, extra = {}) => ({ id, quote: { exact, prefix: '', suffix: '' }, note: null, ...extra });

/* --------------------------------------------------------------------------------------- anchoring and finding */

test('the anchor: the smallest element holding most of the box, a picture, figure or table before anything else', () => {
  const box = { left: 100, top: 100, width: 200, height: 100 };
  const el = (tag, left, top, width, height) => ({ tag, rect: { left, top, width, height } });
  const html = el('html', 0, 0, 1200, 5000), para = el('p', 90, 90, 230, 130), figure = el('figure', 50, 50, 600, 400), img = el('img', 95, 95, 210, 110);
  assert.equal(PAGE.chooseAnchor([para, html], box), para); // the smallest that holds it
  assert.equal(PAGE.chooseAnchor([para, figure, html], box), figure); // media first, though larger
  assert.equal(PAGE.chooseAnchor([img, para, figure, html], box), img); // the smallest of the media
  assert.equal(PAGE.chooseAnchor([el('span', 100, 100, 20, 10), html], box).tag, 'html'); // a span holding a corner holds too little
  assert.equal(PAGE.chooseAnchor([], box), null);
  // fractions of the element's rectangle, and placed back in it however it moved or grew
  const f = PAGE.fractionsOf(box, { left: 50, top: 50, width: 400, height: 400 });
  assert.deepEqual(f, { x: 0.125, y: 0.125, w: 0.5, h: 0.25 });
  assert.deepEqual(PAGE.placeIn(f, { x: 0, y: 1000, w: 800, h: 800 }), { x: 100, y: 1100, w: 400, h: 200 });
});

test('finding a box again: the selector (when it finds the same element), then an image with its src, then document coordinates, then not found', () => {
  const box = { anchor, doc: { x: 100, y: 900, w: 300, h: 200, width: 1200 } };
  const same = { id: 'same' }, other = { id: 'other' }, image = { id: 'image' };
  const described = new Map([[same, { tag: 'img', src: '/chart.png', text: 'A chart of the results' }], [other, { tag: 'img', src: '/ad.png', text: 'Buy now' }]]);
  const look = (found, { bySrc = null, width = 1200 } = {}) => ({ bySelector: () => found, describe: (x) => described.get(x), bySrc: (src) => (src === '/chart.png' ? bySrc : null), width });

  assert.deepEqual(PAGE.refind(box, look(same, { bySrc: image })), { how: 'selector', el: same });
  // the selector finds another element now (the page changed): the image by its src
  assert.deepEqual(PAGE.refind(box, look(other, { bySrc: image })), { how: 'src', el: image });
  assert.deepEqual(PAGE.refind(box, look(null, { bySrc: image })), { how: 'src', el: image });
  // neither: where it was in the document, while the page is about as wide
  assert.deepEqual(PAGE.refind(box, look(other, { width: 1210 })), { how: 'doc', el: null });
  assert.deepEqual(PAGE.refind(box, look(null, { width: 800 })), { how: 'none', el: null });
  // a selector that throws is a selector that found nothing
  assert.equal(PAGE.refind(box, { ...look(null), bySelector: () => { throw new SyntaxError('bad'); } }).how, 'doc');
  // no anchor at all: only the document
  assert.equal(PAGE.refind({ anchor: null, doc: box.doc }, look(same)).how, 'doc');

  // the same element: same tag, same src, much the same text
  assert.ok(PAGE.sameElement(anchor, { tag: 'img', src: '/chart.png', text: 'A chart of the results ' }));
  assert.ok(PAGE.sameElement({ ...anchor, src: '' , tag: 'p', text: 'Results improved by 12 percent this year' }, { tag: 'p', src: '', text: 'Results improved by 13 percent this year' }));
  assert.ok(!PAGE.sameElement(anchor, { tag: 'div', src: '/chart.png', text: 'A chart of the results' }));
  assert.ok(!PAGE.sameElement({ ...anchor, src: '', tag: 'p', text: 'Results improved' }, { tag: 'p', src: '', text: 'Something else entirely' }));
});

test('a click selects a box by its edge alone (build 2: the drawing layer\'s click too); the smallest of nested ones', () => {
  const rects = [{ id: 'big', x: 0, y: 0, w: 400, h: 400 }, { id: 'small', x: 100, y: 100, w: 100, h: 100 }];
  assert.equal(PAGE.boxAt(rects, 0, 200), 'big'); // on its edge
  assert.equal(PAGE.boxAt(rects, -6, 200), 'big'); // just outside it
  assert.equal(PAGE.boxAt(rects, 300, 300), null); // well inside: the page's click (a link there opens)
  assert.equal(PAGE.boxAt(rects, 300, 300, { inside: true }), null); // there is no "inside" any more, from anywhere
  assert.equal(PAGE.boxAt(rects, 150, 150), null);
  assert.equal(PAGE.boxAt(rects, 100, 150), 'small');
  assert.equal(PAGE.boxAt(rects, 600, 600), null);
  // the drawing layer's click goes to the page as boxHit, which selects by the same edge rule: no `inside` is passed
  const source = fs.readFileSync(path.join(__dirname, '../src/main/browser/page-preload.cjs'), 'utf8');
  const hit = source.slice(source.indexOf('ipcRenderer.on(CHANNELS.boxHit'), source.indexOf('ipcRenderer.on(CHANNELS.frame'));
  assert.match(hit, /select\(boxAt\(lastRects, point\.x \+ window\.scrollX, point\.y \+ window\.scrollY\)\)/);
  assert.ok(!/inside/.test(hit));
});

/* ------------------------------------------------------------------------------------------------- the drawing */

const svgOf = (css) => decodeURIComponent(css.match(/url\("data:image\/svg\+xml,([^"]+)"\)/)[1]);

test('boxesCss: one html::after rule, out of flow and inert, covering only the boxes (and their handles), an SVG background; nothing for none', () => {
  assert.equal(BOX.boxesCss([]), '');
  const P = BOX.PAD;
  assert.ok(P >= Math.ceil(BOX.HANDLE / 2) + 1, 'room for a handle half outside the edge, and its stroke');
  const css = BOX.boxesCss([{ id: 'a', x: 100, y: 900, w: 300, h: 200 }, { id: 'b', x: 50, y: 1500, w: 100, h: 50 }], 'b', { width: 1200, height: 4000 });
  assert.match(css, /^html::after\{.*\}$/);
  const W = 400 - 50 + 2 * P, H = 1550 - 900 + 2 * P;
  for (const part of ['position:absolute !important', 'pointer-events:none !important', 'z-index:2147483647 !important', `left:${50 - P}px !important`, `top:${900 - P}px !important`, `width:${W}px !important`, `height:${H}px !important`, 'content:"" !important']) assert.ok(css.includes(part), part);
  const svg = svgOf(css);
  assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"`), svg.slice(0, 120));
  // never past the page's right or bottom edge: it must add nothing to what scrolls
  assert.match(BOX.boxesCss([{ id: 'a', x: 1100, y: 10, w: 100, h: 20 }], null, { width: 1200, height: 800 }), new RegExp(`width:${1200 - (1100 - P)}px`));
  // past its left and top it scrolls nothing in: a box at the corner keeps its handles whole
  assert.match(BOX.boxesCss([{ id: 'a', x: 0, y: 0, w: 100, h: 20 }], 'a', { width: 1200, height: 800 }), new RegExp(`left:${-P}px !important;top:${-P}px`));
});

test('boxesCss (build 2): a 1px outline with no fill; the selected box also has 8 small white square handles with a 1px stroke, none cut off', () => {
  const P = BOX.PAD;
  const plain = svgOf(BOX.boxesCss([{ id: 'a', x: 100, y: 200, w: 300, h: 150 }], null));
  assert.deepEqual(plain.match(/<rect [^>]*\/>/g), [`<rect x="${P + 0.5}" y="${P + 0.5}" width="299" height="149" fill="none" stroke="#0070f3" stroke-width="1"/>`]);
  assert.ok(!/fill-opacity|fill="#0070f3"/.test(plain), 'no fill');

  const svg = svgOf(BOX.boxesCss([{ id: 'a', x: 100, y: 200, w: 300, h: 150 }, { id: 'b', x: 600, y: 200, w: 40, h: 40 }], 'a'));
  const rects = svg.match(/<rect [^>]*\/>/g);
  assert.equal(rects.length, 2 + 8); // two outlines, the selected one's 8 handles
  const handles = rects.filter((r) => r.includes('fill="#fff"'));
  assert.equal(handles.length, 8);
  const side = BOX.HANDLE - 1; // inside its 1px stroke: HANDLE across, stroke included
  for (const h of handles) assert.match(h, new RegExp(`width="${side}" height="${side}" fill="#fff" stroke="#0070f3" stroke-width="1"`));
  // the handles sit on the corners and the middles of the edges, all inside the drawing
  const W = Number(svg.match(/width="(\d+)"/)[1]), H = Number(svg.match(/height="(\d+)"/)[1]);
  const centres = handles.map((h) => { const [, x, y] = h.match(/x="([\d.-]+)" y="([\d.-]+)"/); return [Number(x) + side / 2, Number(y) + side / 2]; });
  assert.deepEqual(centres, BOX.handlesOf({ x: P, y: P, w: 300, h: 150 }).map((p) => [p.x, p.y]));
  for (const h of handles) { const [, x, y] = h.match(/x="([\d.-]+)" y="([\d.-]+)"/).map(Number); assert.ok(x - 0.5 >= 0 && y - 0.5 >= 0 && x + side + 0.5 <= W && y + side + 0.5 <= H, h); }
  // the page's handles are boxes.cjs's: the same names in the same places
  assert.deepEqual(PAGE.HANDLES, BOX.HANDLES.map((h) => [...h]));
});

test('a handle of the selected box: within reach of its centre; a drag moves the edges it holds, never inside out, kept in the visible page', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(PAGE.handleAt(r, 100, 100), 'nw');
  assert.equal(PAGE.handleAt(r, 304, 203), 'se');
  assert.equal(PAGE.handleAt(r, 200, 96), 'n');
  assert.equal(PAGE.handleAt(r, 299, 150), 'e');
  assert.equal(PAGE.handleAt(r, 150, 150), null); // inside: no handle
  assert.equal(PAGE.handleAt(r, 100 + PAGE.HANDLE_HIT + 1, 100), null);
  assert.equal(PAGE.handleAt(null, 0, 0), null);

  const view = { x: 0, y: 0, w: 800, h: 600 };
  assert.deepEqual(PAGE.resizeRect(r, 'se', 50, 20, view), { x: 100, y: 100, w: 250, h: 120 });
  assert.deepEqual(PAGE.resizeRect(r, 'nw', -50, -20, view), { x: 50, y: 80, w: 250, h: 120 });
  assert.deepEqual(PAGE.resizeRect(r, 'e', 30, 99, view), { x: 100, y: 100, w: 230, h: 100 }); // a side moves one edge
  assert.deepEqual(PAGE.resizeRect(r, 's', 99, -30, view), { x: 100, y: 100, w: 200, h: 70 });
  // past the other side: it stops at the smallest a box may be
  assert.deepEqual(PAGE.resizeRect(r, 'w', 500, 0, view), { x: 300 - PAGE.MIN_BOX, y: 100, w: PAGE.MIN_BOX, h: 100 });
  // past the visible page: kept inside it, all of it
  assert.deepEqual(PAGE.resizeRect(r, 'se', 900, 900, view), { x: 100, y: 100, w: 700, h: 500 });
  assert.deepEqual(PAGE.resizeRect(r, 'nw', -500, -500, view), { x: 0, y: 0, w: 300, h: 200 });
  assert.deepEqual(PAGE.resizeRect({ x: -40, y: 550, w: 200, h: 100 }, 'e', 10, 0, view), { x: 0, y: 550, w: 170, h: 50 });
  assert.deepEqual(Object.keys(PAGE.CURSORS).sort(), PAGE.HANDLES.map(([name]) => name).sort());
});

/* -------------------------------------------------------------------------------- what main takes from a page */

test('readers of the "web" list tell boxes from highlights: the page gets each as its kind, a malformed box nothing', () => {
  const list = [webMark('w1', 'a passage'), boxMark('b1'), { id: 'b2', box: { x: 0, y: 0, w: 0, h: 1, doc: {} } }, { id: 'b3', box: 'no' }, null];
  const given = marksForPage(list);
  assert.deepEqual(given.map((m) => [m.id, !!m.quote, !!m.box]), [['w1', true, false], ['b1', false, true]]);
  assert.deepEqual(given[1].box, boxMark('b1').box);
  assert.equal(BOX.isBox(boxMark('b1')), true);
  assert.equal(BOX.isBox(webMark('w1', 'x')), false);

  // what a page says of a box drawn on it, and where its boxes are: bounded and well-formed only
  const reply = boxReplyInput({ nonce: 'n', box: boxMark('x').box, text: `  lots   of\n text ${'y'.repeat(3000)}` });
  assert.equal(reply.text.length, BOX.TEXT_MAX);
  assert.ok(reply.text.startsWith('lots of text '));
  assert.equal(boxReplyInput({ box: { x: 'a' } }), null);
  assert.equal(boxReplyInput({ box: { ...boxMark('x').box, anchor: { selector: '', tag: 'img' } } }).box.anchor, null);
  assert.deepEqual(boxReportInput({ rects: [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }, { id: 'b', x: 1, y: 2, w: 0, h: 4 }, { id: 5 }], selected: 'a', size: { width: 10, height: 20 } }),
    { rects: [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }], selected: 'a', size: { width: 10, height: 20 }, resizing: null });
  assert.equal(boxReportInput({}), null);
  // build 3: the box being resized and where the pointer is, only for a box in the report
  const resizing = { id: 'a', x: 50, y: 60, viewport: { width: 800, height: 600 } };
  assert.deepEqual(boxReportInput({ rects: [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }], resizing }).resizing, resizing);
  assert.equal(boxReportInput({ rects: [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }], resizing: { ...resizing, id: 'zz' } }).resizing, null);
  assert.equal(boxReportInput({ rects: [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }], resizing: { ...resizing, x: 'a' } }).resizing, null);
});

/* ------------------------------------------------------------------------------------------------- the storage */

async function libraryContext() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-boxes-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-boxes-home-'));
  return { dataRoot, homeDir, libraryDb: { list: async () => [], get: async () => null } };
}
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

test('a box is saved in the "web" list with its picture, and the picture is deleted with its mark (and back with Undo)', async () => {
  const ctx = await libraryContext();
  const url = 'https://en.wikipedia.org/wiki/Douglas_Engelbart';
  const crop = path.join(ctx.dataRoot, 'annotations', 'crops', 'b1.png');
  assert.equal(library.cropFile(ctx, 'crops/b1.png'), crop);
  assert.equal(library.cropFile(ctx, '../../etc/passwd'), null);
  assert.equal(library.cropFile(ctx, 'crops/../x.png'), null);

  assert.equal(await library.addWebMark(ctx, url, webMark('w1', 'a passage')), true);
  assert.equal(await library.addWebMark(ctx, url, boxMark('b1'), { crop: PNG }), true);
  assert.deepEqual(fs.readFileSync(crop), PNG);
  const ink = await library.readPageAnnotations(ctx, url);
  assert.deepEqual(ink[WEB].map((m) => m.id), ['w1', 'b1']);
  assert.deepEqual(ink[WEB][1], boxMark('b1'));

  // removed: out of the list, its picture gone; what comes back is enough to undo it
  const removed = await library.removeWebMark(ctx, url, 'b1');
  assert.deepEqual(removed.mark, boxMark('b1'));
  assert.equal(removed.index, 1);
  assert.deepEqual(removed.crops, [{ crop: 'crops/b1.png', bytes: PNG }]);
  assert.equal(fs.existsSync(crop), false);
  assert.deepEqual((await library.readPageAnnotations(ctx, url))[WEB].map((m) => m.id), ['w1']);
  assert.equal(await library.removeWebMark(ctx, url, 'b1'), null); // once

  assert.equal(await library.restoreWebMark(ctx, url, removed), true);
  assert.deepEqual(fs.readFileSync(crop), PNG);
  assert.deepEqual((await library.readPageAnnotations(ctx, url))[WEB].map((m) => m.id), ['w1', 'b1']);
  assert.equal(await library.restoreWebMark(ctx, url, removed), false); // there already

  // a highlight has no picture to delete; a preview keeps nothing
  assert.deepEqual((await library.removeWebMark(ctx, url, 'w1')).crops, []);
  assert.equal(await library.addWebMark(ctx, 'http://localhost:3000/', boxMark('b9'), { crop: PNG }), false);
  assert.equal(fs.existsSync(path.join(ctx.dataRoot, 'annotations', 'crops', 'b9.png')), false);
});

/* --------------------------------------------------------------------------------------------------- the views */

function fakeElectron() {
  const made = [];
  let frames = 0;
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.visible = true;
      this.bounds = { x: 0, y: 0, width: 800, height: 600 };
      const contents = options.webContents || new EventEmitter();
      const ipc = { handlers: new Map(), listeners: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); }, on(channel, fn) { this.listeners.set(channel, fn); } };
      Object.assign(contents, {
        ipc, sent: [], css: [], removedCss: [], loaded: [], closed: false, focused: 0, url: contents.url || '',
        mainFrame: { frameTreeNodeId: (frames += 1) },
        loadURL(url) { this.loaded.push(url); this.url = url; this.mainFrame.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle: () => 'Title', isLoading: () => false, isDestroyed() { return this.closed; },
        close() { this.closed = true; }, reload() {}, stop() {}, focus() { this.focused += 1; }, getZoomFactor: () => 1,
        send(channel, payload) { this.sent.push([channel, payload]); if (this.onSend) this.onSend(channel, payload); },
        insertCSS(css) { this.css.push(css); return Promise.resolve(`key-${this.css.length}`); },
        removeInsertedCSS(key) { this.removedCss.push(key); return Promise.resolve(); },
        captures: [],
        // what is drawn when the picture is taken: how many of the boxes' rules are in the page then
        capturePage(rect) { this.captures.push({ rect, rules: this.css.filter((css) => css.startsWith('html::after')).length - this.removedCss.length }); return Promise.resolve({ isEmpty: () => false, getSize: () => ({ width: rect.width * 2, height: rect.height * 2 }), resize() { return this; }, toPNG: () => PNG, rect }); },
        zoom: 1, setZoomFactor(z) { this.zoom = z; }, isFocused() { return false; },
        setWindowOpenHandler(handler) { this.windowOpen = handler; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
      });
      this.webContents = contents;
      made.push(this);
    }
    setBackgroundColor(color) { this.background = color; }
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible; }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  }
  const browsing = {
    preloads: [], cookies: { on() {}, flushStore: async () => {} }, setUserAgent() {}, getUserAgent: () => 'UA', setPermissionRequestHandler() {},
    webRequest: { onHeadersReceived() {} }, on() {}, registerPreloadScript(script) { this.preloads.push(script); return script.id; },
  };
  const children = [];
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1, focus() {} }, contentView: { addChildView(v) { children.push(v); }, removeChildView() {} } };
  return { made, children, win, electron: { WebContentsView, session: { fromPartition: () => browsing }, Menu: { buildFromTemplate: () => ({ popup() {} }) }, clipboard: {}, dialog: {}, shell: { openExternal: async () => {} } } };
}

function setup({ list = [] } = {}) {
  const fake = fakeElectron();
  const saved = [], removed = [], restored = [], told = [], updated = [];
  const pageMarks = {
    list: async () => list,
    update: async (url, markId, patch, extra) => { updated.push([url, markId, patch, extra]); return { ...boxMark(markId), ...patch, crop: `crops/${markId}-1.png` }; },
    add: async (url, mark, extra) => { saved.push([url, mark, extra]); return true; },
    remove: async (url, markId) => { removed.push([url, markId]); return { mark: boxMark(markId), index: 0, crops: [{ crop: `crops/${markId}.png`, bytes: PNG }] }; },
    restore: async (url, value) => { restored.push([url, value]); return true; },
  };
  let n = 0;
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: (channel, payload) => { told.push([channel, payload]); }, appName: 'Engelbart', pageMarks, newId: () => `box-${(n += 1)}` });
  views.open('a', 'https://en.wikipedia.org/wiki/Douglas_Engelbart');
  views.show('a', { x: 0, y: 40, width: 800, height: 600 });
  const page = fake.made[0].webContents;
  return { fake, views, page, saved, removed, restored, told, updated };
}
const fromMain = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });
const key = (contents, input) => { let prevented = false; contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: '', isAutoRepeat: false, shift: false, meta: false, control: false, alt: false, ...input }); return prevented; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
// Until `done()` holds (or a second passes): a box's save waits on the page's reply (setImmediate), which a 10ms timer can
// beat while the whole suite keeps the event loop busy.
const settle = async (done) => { for (const end = Date.now() + 1000; !done() && Date.now() < end;) await tick(); };

test('⌥ held in the page lays the drawing layer over it (not while a field has the keyboard); letting go is the layer\'s to judge', () => {
  const { fake, views, page, told } = setup();
  page.ipc.listeners.get(PAGE.CHANNELS.editing)(fromMain(page), true);
  key(page, { key: 'Alt', alt: true });
  assert.equal(fake.made.length, 1, 'a text field has the keyboard: no layer');
  page.ipc.listeners.get(PAGE.CHANNELS.editing)(fromMain(page), false);
  key(page, { key: 'Alt', alt: true });
  const layer = fake.made[1];
  assert.equal(layer.options.webPreferences.preload, BOX_LAYER_PRELOAD);
  assert.equal(layer.options.webPreferences.sandbox, true);
  assert.equal(layer.background, '#00000000');
  assert.equal(layer.visible, true);
  assert.deepEqual(layer.bounds, fake.made[0].bounds); // over the page, exactly
  assert.equal(fake.children.at(-1), layer); // on top
  assert.equal(layer.webContents.focused, 1); // with the keyboard, for Esc
  assert.deepEqual(told.at(-1), ['browser:boxing', { id: 'a', on: true }]);
  // its page loads, then it is told how it was started
  layer.webContents.emit('did-finish-load');
  assert.deepEqual(layer.webContents.sent.at(-1), [LAYER.CHANNELS.start, { mode: 'alt' }]);
  // ⌥ let go in the page goes to the layer, which finishes a drag under way first
  page.emit('before-input-event', { preventDefault() {} }, { type: 'keyUp', key: 'Alt' });
  assert.deepEqual(layer.webContents.sent.at(-1), [LAYER.CHANNELS.altUp, undefined]);
  layer.webContents.ipc.listeners.get(LAYER.CHANNELS.cancel)({}, { reason: 'alt' });
  assert.equal(layer.visible, false);
  assert.deepEqual(told.at(-1), ['browser:boxing', { id: 'a', on: false }]);
  assert.equal(page.focused, 1); // the page has the keyboard back
  // the Stage's Box button; hiding the page takes the layer away
  assert.equal(views.startBox('a'), true);
  assert.deepEqual(layer.webContents.sent.at(-1), [LAYER.CHANNELS.start, { mode: 'button' }]);
  void views.hide();
  assert.equal(layer.visible, false);
  // a preview cannot be boxed
  page.url = 'http://localhost:5173/';
  assert.equal(views.startBox('a'), false);
});

test('a box drawn: the page says what it is kept by, its picture is taken, and it is saved as a mark with note null', async () => {
  const { fake, page, saved, told } = setup();
  const reply = { box: boxMark('x').box, text: 'Figure 2: results' };
  page.onSend = (channel, payload) => { if (channel === PAGE.CHANNELS.box) setImmediate(() => page.ipc.listeners.get(PAGE.CHANNELS.box)(fromMain(page), { nonce: payload.nonce, ...reply })); };
  key(page, { key: 'Alt', alt: true });
  const layer = fake.made[1];
  layer.webContents.ipc.listeners.get(LAYER.CHANNELS.done)({}, { x: 100, y: 50, w: 300, h: 200 });
  assert.equal(layer.visible, false); // the layer goes as soon as the box is done
  assert.ok(told.some(([c, p]) => c === 'browser:boxing' && p.on === false));
  await settle(() => saved.length && page.sent.at(-1)?.[0] === PAGE.CHANNELS.boxAdd);
  const asked = page.sent.find(([channel]) => channel === PAGE.CHANNELS.box);
  assert.deepEqual(asked[1].rect, { x: 100, y: 50, w: 300, h: 200 });
  assert.equal(saved.length, 1);
  const [url, mark, extra] = saved[0];
  assert.equal(url, 'https://en.wikipedia.org/wiki/Douglas_Engelbart');
  assert.deepEqual({ ...mark, at: typeof mark.at }, { id: 'box-1', box: reply.box, crop: 'crops/box-1.png', text: 'Figure 2: results', note: null, at: 'string' });
  assert.deepEqual(extra.crop, PNG);
  assert.deepEqual(page.sent.at(-1), [PAGE.CHANNELS.boxAdd, { id: 'box-1', box: reply.box, select: true }]); // a box just drawn is selected

  // the page reports where its boxes are: drawn by one rule, the new one in before the old one goes
  const report = page.ipc.listeners.get(PAGE.CHANNELS.boxes);
  report(fromMain(page), { rects: [{ id: 'box-1', x: 100, y: 900, w: 300, h: 200 }], selected: null, size: { width: 1200, height: 4000 } });
  await tick();
  report(fromMain(page), { rects: [{ id: 'box-1', x: 100, y: 950, w: 300, h: 200 }], selected: null, size: { width: 1200, height: 4000 } });
  await tick();
  assert.equal(page.css.filter((css) => css.startsWith('html::after')).length, 2);
  assert.deepEqual(page.removedCss, ['key-1']);
  report(fromMain(page), { rects: [], selected: null, size: null });
  await tick();
  assert.deepEqual(page.removedCss, ['key-1', 'key-2']);
});

test('a selected box: Backspace removes it (not while a field has the keyboard) and the Stage is told; Undo and ⌘Z put it back', async () => {
  const { page, views, removed, restored, told } = setup();
  const report = page.ipc.listeners.get(PAGE.CHANNELS.boxes);
  assert.equal(key(page, { key: 'Backspace' }), false); // nothing selected: the page's
  report(fromMain(page), { rects: [{ id: 'b1', x: 1, y: 2, w: 30, h: 40 }], selected: 'b1', size: null });
  page.ipc.listeners.get(PAGE.CHANNELS.editing)(fromMain(page), true);
  assert.equal(key(page, { key: 'Backspace' }), false);
  page.ipc.listeners.get(PAGE.CHANNELS.editing)(fromMain(page), false);
  assert.equal(key(page, { key: 'Escape' }), true);
  assert.deepEqual(page.sent.at(-1), [PAGE.CHANNELS.boxSelect, null]);
  assert.equal(key(page, { key: 'Delete' }), true);
  await tick();
  assert.deepEqual(removed, [['https://en.wikipedia.org/wiki/Douglas_Engelbart', 'b1']]);
  assert.deepEqual(page.sent.at(-1), [PAGE.CHANNELS.boxRemove, 'b1']);
  assert.deepEqual(told.at(-1), ['browser:box-removed', { id: 'a', markId: 'b1' }]);

  assert.equal(await views.undoBox('a'), true);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0][1].crops, [{ crop: 'crops/b1.png', bytes: PNG }]);
  assert.deepEqual(page.sent.at(-1), [PAGE.CHANNELS.boxAdd, { id: 'b1', box: boxMark('b1').box }]);
  assert.deepEqual(told.at(-1), ['browser:box-restored', { id: 'a', markId: 'b1' }]);
  assert.equal(await views.undoBox('a'), false); // once

  key(page, { key: 'Backspace' });
  await tick();
  assert.equal(key(page, { key: 'z', meta: process.platform === 'darwin', control: process.platform !== 'darwin' }), true);
  await tick();
  assert.equal(restored.length, 2);
});

/* ---------------------------------------------------------------------------------------------------- @bart */

test('@bart: a box is <box crop="/abs/…png"> with its <text>, in a web <stage> and a mentioned page; highlights beside it as before', () => {
  const inkRoot = '/data/annotations';
  const crop = (id) => path.join(inkRoot, 'crops', `${id}.png`); // the platform's separators, as the app writes it
  const ink = { [WEB]: [webMark('w1', 'a passage'), boxMark('b1'), boxMark('b2', { text: '', crop: null }), boxMark('b3', { crop: '../../etc/passwd', note: 'see this' })] };
  const listed = webMarksOf(ink, inkRoot);
  assert.deepEqual(listed.map((h) => [h.box || false, h.quote, h.crop || '']), [[false, 'a passage', ''], [true, '', crop('b1')], [true, '', ''], [true, '', '']]);
  const page = { name: 'Douglas Engelbart', address: 'https://en.wikipedia.org/wiki/Douglas_Engelbart', path: '', annotations: '/data/annotations/pages/x.json', inkRoot };
  const stage = webStageBlock(page, ink);
  assert.ok(stage.includes('<highlight>\n<quote>\na passage\n</quote>\n</highlight>\n'));
  assert.ok(stage.includes(`<box crop="${crop('b1')}">\n<text>\nFigure 2: results\n</text>\n</box>\n`), stage);
  assert.ok(stage.includes('<box/>\n')); // a box with nothing to say still says it is there
  assert.ok(stage.includes('<box>\n<text>\nFigure 2: results\n</text>\n<note>\nsee this\n</note>\n</box>\n')); // no crop outside crops/
  assert.ok(!/<quote>\n\n/.test(stage));
  // only boxes: still not highlights="0"
  assert.ok(webStageBlock(page, { [WEB]: [boxMark('b1')] }).startsWith('<stage source="web" title="Douglas Engelbart" address="https://en.wikipedia.org/wiki/Douglas_Engelbart" annotations='));

  const mentioned = mentionedBlock([{ source: 'web', name: 'Saved', address: 'https://saved.example.org/', path: '/p/index.html', annotations: '/ink/s.json', inkRoot, ink: { [WEB]: [boxMark('s1')] } }]);
  assert.equal(mentioned, `<highlights from="mentioned">\n<page source="web" title="Saved" address="https://saved.example.org/" path="/p/index.html" annotations="/ink/s.json">\n<box crop="${crop('s1')}">\n<text>\nFigure 2: results\n</text>\n</box>\n</page>\n</highlights>`);

  // a pdf page's list with a box in it (later builds) is read as a box, never as a quote or a free note
  const pdf = marksOf({ 2: [{ id: 'p', rects: [{ x: 0, y: 0, w: 1, h: 0.1 }], y: 0.1, text: 'pdf text' }, { id: 'pb', y: 0.3, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, crop: 'crops/pb.png', text: 'under' }] }, inkRoot);
  assert.deepEqual(pdf.map((h) => [h.page, h.box || false, h.quote, h.crop || '']), [[2, false, 'pdf text', ''], [2, true, '', crop('pb')]]);
});

test('the system prompt tells Bart what a <box> is and to open its crop when the question is about what it shows', () => {
  assert.match(BART_SYSTEM_PROMPT, /<box crop="…">/);
  assert.match(BART_SYSTEM_PROMPT, /open its crop with your Read tool/);
});

test('buildContext: the page in front and a mentioned saved page carry their boxes with absolute crop paths', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-boxes-'));
  const layout = ensureHome(homeDir);
  const ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  t.after(() => db.closeAll());
  const project = await projects.createProject(ctx, { name: 'Boxes', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-boxes-code-')) });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Figures' });
  const live = 'https://en.wikipedia.org/wiki/Douglas_Engelbart';
  assert.equal(await library.addWebMark(ctx, live, boxMark('front'), { crop: PNG }), true);
  const savedFile = path.join(fs.mkdtempSync(path.join(homeDir, 'pages-')), 'index.html');
  fs.writeFileSync(savedFile, '<title>Saved</title>');
  const saved = randomUUID();
  await ctx.libraryDb.insert({ id: saved, name: 'Saved figure', project_id: project.id, type: 'html', tags: [], path: fs.realpathSync(savedFile), url: 'https://blog.example.org/fig' });
  await library.writeAnnotations(ctx, saved, { [WEB]: [boxMark('kept')] });
  const wsRef = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, wsRef, 'See @[Saved figure].\n@bart what\'s in the box?\nbart~> q1\n');
  const { documents } = await buildContext(ctx, project.id, { ref: wsRef, workspaceId: workspace.id, askId: 'q1', stage: { kind: 'web', url: live, title: 'Douglas Engelbart' } });
  const crops = path.join(ctx.dataRoot, 'annotations', 'crops');
  assert.ok(documents.includes(`<box crop="${path.join(crops, 'front.png')}">\n<text>\nFigure 2: results\n</text>\n</box>\n</stage>`), documents.slice(-1200));
  assert.ok(fs.existsSync(path.join(crops, 'front.png')));
  assert.ok(documents.includes(`<page source="web" title="Saved figure"`) && documents.includes(`<box crop="${path.join(crops, 'kept.png')}">`));
});

/* ===================================================================================================== build 2 */
// MATH-70 build 2 (2026-10-07): macOS-style drawing, selecting by the edge alone, resizing by the handles with a new
// picture each time (earlier answers keep theirs), a card per selected box (note and @bart), and only the text that shows.

const { askEntry, withAsk } = require('../src/shared/mark-answers.cjs');
const CARD = require('../src/main/browser/box-card-preload.cjs');
const VIEWS = require('../src/main/browser/views.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { highlightBlock } = require('../src/main/bart/context.cjs');

test('the drawing layer\'s readouts: the pointer\'s screen place before the press, the size while dragging, stacked at its lower right', () => {
  assert.equal(LAYER.READOUT_SCALE, 'points');
  assert.deepEqual(LAYER.readout({ dragging: false, screenX: 812.4, screenY: 301, w: 0, h: 0 }), ['812', '301']);
  assert.deepEqual(LAYER.readout({ dragging: true, screenX: 812, screenY: 301, w: 240.6, h: 99.5 }), ['241', '100']);
  assert.deepEqual(LAYER.readout({ dragging: true, w: 240, h: 100 }, 2), ['480', '200']); // pixels, were it ever wanted
  const view = { width: 800, height: 600 }, size = { width: 30, height: 26 };
  assert.deepEqual(LAYER.readoutAt(100, 100, size, view), { left: 100 + LAYER.READOUT_GAP, top: 100 + LAYER.READOUT_GAP });
  assert.deepEqual(LAYER.readoutAt(790, 590, size, view), { left: 790 - LAYER.READOUT_GAP - 30, top: 590 - LAYER.READOUT_GAP - 26 }); // flipped at the edges
  // no words over the page any more
  const source = fs.readFileSync(path.join(__dirname, '../src/main/browser/box-layer-preload.cjs'), 'utf8');
  assert.ok(!/Drag to box part of the page/.test(source));
});

test('the drawing layer looks like ⌘⇧4 (build 3): the system cursor hidden, its own crosshair and circle, outlined numbers, a flat fill', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/browser/box-layer-preload.cjs'), 'utf8');
  assert.match(source, /cursor:none/);
  assert.doesNotMatch(source, /cursor:crosshair/);
  const svg = LAYER.CROSS_SVG, end = LAYER.CROSS + 1, c = LAYER.CROSS / 2 + 0.5;
  assert.equal(LAYER.CROSS, 40);
  assert.equal(LAYER.CIRCLE, 24);
  assert.match(svg, new RegExp(`width="${end}" height="${end}"`));
  assert.match(svg, new RegExp(`<circle cx="${c}" cy="${c}" r="${LAYER.CIRCLE / 2 - 0.5}" fill="rgba\\(128,128,128,[0-9.]+\\)" stroke="rgba\\(70,70,70,`), 'a translucent grey circle with a darker rim');
  const paths = [...svg.matchAll(/<path d="([^"]+)" stroke="([^"]+)" stroke-width="(\d+)"/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(paths.map((p) => p[0]), [`M0 ${c}H${end}M${c} 0V${end}`, `M0 ${c}H${end}M${c} 0V${end}`], 'both lines, end to end, through the point');
  assert.deepEqual(paths.map((p) => p[2]), ['3', '1'], 'a light halo under each thin line');
  assert.match(paths[0][1], /^rgba\(255,255,255,/);
  assert.equal(paths[1][1], '#3a3a3a');
  assert.ok(svg.indexOf('<circle') < svg.indexOf('<path'), 'the circle under the lines');
  assert.match(LAYER.READOUT_CSS, /color:#000/);
  assert.match(LAYER.READOUT_CSS, /-webkit-text-stroke:[0-9.]+px #fff;paint-order:stroke fill/, 'black numbers with a white outline');
  assert.match(LAYER.READOUT_CSS, /white-space:pre/, 'x over y');
  assert.match(source, /#f\{position:fixed;display:none;background:\$\{FILL\}/, 'a flat fill, no edge');
  // a box resized on the page looks the same
  assert.equal(BOX.FILL, LAYER.FILL);
  assert.equal(BOX.READOUT_CSS, LAYER.READOUT_CSS);
  assert.equal(BOX.READOUT_GAP, LAYER.READOUT_GAP);
});

test('a box being resized (build 3): a flat fill with no outline or handles, its size in points beside the pointer, flipped at the edges', () => {
  const rects = [{ id: 'a', x: 100, y: 200, w: 300, h: 150 }, { id: 'b', x: 600, y: 200, w: 40, h: 40 }];
  const svg = svgOf(BOX.boxesCss(rects, 'a', null, 'a'));
  const shapes = svg.match(/<rect [^>]+>/g);
  assert.equal(shapes.length, 2, 'the resized box is one rectangle, no handles; the other its outline');
  assert.match(shapes[0], new RegExp(`fill="${BOX.FILL.replace(/[()]/g, '\\$&')}" stroke="none"`));
  assert.match(shapes[1], /fill="none" stroke="#0070f3"/);
  assert.equal(svgOf(BOX.boxesCss(rects, 'a')).match(/<rect /g).length, 2 + 8, 'not resizing: the outline and handles as before');

  const css = BOX.readoutCss({ x: 100, y: 100, w: 240.4, h: 99.6, zoom: 1, viewport: { width: 800, height: 600 } });
  assert.match(css, /^html::before\{/);
  assert.match(css, /content:"240\\A 100" !important/, 'width over height');
  assert.match(css, /position:fixed !important/);
  assert.match(css, new RegExp(`left:${100 + BOX.READOUT_GAP}px !important;top:${100 + BOX.READOUT_GAP}px !important`), 'below and right of the pointer');
  assert.match(css, /pointer-events:none !important/);
  assert.match(css, /color:#000 !important/);
  assert.match(css, /transform:scale\(1\) translate\(0,0\) !important/);
  // zoomed: the numbers are points, the look the same size
  const zoomed = BOX.readoutCss({ x: 100, y: 100, w: 200, h: 50, zoom: 1.5, viewport: { width: 800, height: 600 } });
  assert.match(zoomed, /content:"300\\A 75"/);
  assert.match(zoomed, /scale\(0\.6667\)/);
  // near the right and bottom: on the pointer's other side
  const flipped = BOX.readoutCss({ x: 790, y: 590, w: 10, h: 10, zoom: 1, viewport: { width: 800, height: 600 } });
  assert.match(flipped, new RegExp(`left:${790 - BOX.READOUT_GAP}px !important;top:${590 - BOX.READOUT_GAP}px`));
  assert.match(flipped, /translate\(-100%,-100%\)/);
  assert.equal(BOX.readoutCss({ x: NaN, y: 0, w: 1, h: 1 }), '');
});

test('the pointer over a box (build 3): a hand on any box\'s edge band, a handle\'s cursor before it, the page\'s own elsewhere', () => {
  assert.equal(PAGE.EDGE_CURSOR, 'pointer');
  assert.equal(PAGE.cursorFor(null, 'a'), 'pointer');
  assert.equal(PAGE.cursorFor('se', 'a'), 'nwse-resize');
  assert.equal(PAGE.cursorFor(null, null), '');
  const rects = [{ id: 'a', x: 100, y: 100, w: 200, h: 100 }];
  assert.equal(PAGE.cursorFor(null, PAGE.boxAt(rects, 100 + PAGE.EDGE - 1, 150)), 'pointer', 'on the edge band');
  assert.equal(PAGE.cursorFor(null, PAGE.boxAt(rects, 200, 150)), '', 'well inside: the page\'s');
  assert.equal(PAGE.cursorFor(null, PAGE.boxAt(rects, 50, 50)), '', 'outside');
  // main lets the hand through as it does the handles' cursors
  const source = fs.readFileSync(path.join(__dirname, '../src/main/browser/views.cjs'), 'utf8');
  assert.match(source, /CURSOR_VALUES = new Set\(\[[^\]]*'pointer'\]\)/);
});

test('what shows under a box: centre in the box and the viewport, visible, and not covered — hidden, clipped, covered and offscreen text is not', () => {
  const box = { left: 100, top: 100, width: 300, height: 200 }, viewport = { width: 800, height: 600 };
  const word = (left, top) => ({ left, top, width: 40, height: 16 });
  const calls = [];
  const probe = (visible = true, hits = true) => ({ visible: () => { calls.push('visible'); return visible; }, hits: (x, y) => { calls.push(['hits', x, y]); return hits; } });
  assert.equal(PAGE.shows(word(150, 150), box, viewport, probe()), true);
  assert.deepEqual(calls.at(-1), ['hits', 170, 158]); // asked at the word's centre
  // hidden: display:none, visibility:hidden, opacity:0, content-visibility (checkVisibility says no)
  assert.equal(PAGE.shows(word(150, 150), box, viewport, probe(false, true)), false);
  // covered: a sticky header, a dialog over it (what is at its centre is not its element)
  assert.equal(PAGE.shows(word(150, 150), box, viewport, probe(true, false)), false);
  // clipped by the box: its centre outside it, though it overlaps
  calls.length = 0;
  assert.equal(PAGE.shows(word(385, 150), box, viewport, probe()), false);
  assert.deepEqual(calls, [], 'the geometry is judged first: no probe asked');
  // offscreen: in the box, outside the viewport (the box runs past the page's edge)
  assert.equal(PAGE.shows(word(150, 650), { left: 100, top: 500, width: 300, height: 400 }, viewport, probe()), false);
  assert.equal(PAGE.shows({ left: 150, top: 150, width: 0, height: 16 }, box, viewport, probe()), false); // nothing drawn
  // a picture: judged by the centre of its visible part (inside the box and the viewport)
  const img = { left: 0, top: 0, width: 160, height: 160 }; // its centre (80, 80) is outside the box; its part in it is not
  assert.equal(PAGE.shows(img, box, viewport, probe()), false);
  calls.length = 0;
  assert.equal(PAGE.shows(img, box, viewport, probe(), { part: true }), true);
  assert.deepEqual(calls.at(-1), ['hits', 130, 130]);
  assert.equal(PAGE.shows({ left: 500, top: 0, width: 100, height: 100 }, box, viewport, probe(), { part: true }), false); // none of it under the box
  assert.deepEqual(PAGE.VISIBILITY, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
});

test('the card goes beside the box: to its right with room, else its left, else under it, else over it, else against the page\'s edge; never outside the page; none for a box out of view', () => {
  const page = { x: 0, y: 40, width: 800, height: 600 }, size = { width: 336, height: 120 };
  assert.deepEqual(BOX.cardPlace({ x: 100, y: 90, width: 200, height: 100 }, page, size), { x: 308, y: 90, width: 336, height: 120 });
  assert.deepEqual(BOX.cardPlace({ x: 500, y: 90, width: 200, height: 100 }, page, size), { x: 156, y: 90, width: 336, height: 120 });
  assert.deepEqual(BOX.cardPlace({ x: 100, y: 90, width: 650, height: 100 }, page, size), { x: 100, y: 198, width: 336, height: 120 }); // under a wide box
  assert.deepEqual(BOX.cardPlace({ x: 100, y: 450, width: 650, height: 150 }, page, size), { x: 100, y: 322, width: 336, height: 120 }); // over it, no room under
  assert.deepEqual(BOX.cardPlace({ x: 100, y: 60, width: 650, height: 560 }, page, size), { x: 464, y: 60, width: 336, height: 120 }); // room nowhere: the edge
  assert.deepEqual(BOX.cardPlace({ x: 100, y: 600, width: 100, height: 300 }, page, size), { x: 208, y: 520, width: 336, height: 120 }); // up into the page
  assert.deepEqual(BOX.cardPlace({ x: 100, y: -50, width: 100, height: 200 }, page, size), { x: 208, y: 40, width: 336, height: 120 });
  assert.equal(BOX.cardPlace({ x: 100, y: 640, width: 100, height: 100 }, page, size), null); // below the page
  assert.equal(BOX.cardPlace({ x: 100, y: -100, width: 100, height: 140 }, page, size), null); // above it
  assert.equal(BOX.cardPlace({ x: 100, y: 100, width: 100, height: 100 }, page, { width: 336, height: 900 }).height, 600);
});

test('crop names: a resize\'s picture is "crops/<id>-<n>.png", one past the mark\'s and its answers\' pictures, and fits CROP_RE', () => {
  const id = randomUUID();
  assert.equal(BOX.nextCropName({ id, crop: `crops/${id}.png` }), `crops/${id}-1.png`);
  assert.equal(BOX.nextCropName({ id, crop: `crops/${id}-1.png`, asks: [{ crop: `crops/${id}.png` }, { crop: `crops/${id}-3.png` }] }), `crops/${id}-4.png`);
  assert.equal(BOX.nextCropName({ id, crop: null }), `crops/${id}-1.png`);
  assert.match(BOX.nextCropName({ id, crop: `crops/${id}-41.png` }), BOX.CROP_RE);
  assert.equal(BOX.cropNumber('b1', 'crops/b1.png'), 0);
  assert.equal(BOX.cropNumber('b1', 'crops/b1-12.png'), 12);
  for (const other of ['crops/b10.png', 'crops/b1-x.png', 'crops/b1-0.png', 'crops/b2-1.png', '../b1-1.png', null]) assert.equal(BOX.cropNumber('b1', other), -1, String(other));
  assert.deepEqual(BOX.cropsOf({ id: 'b1', crop: 'crops/b1-1.png', asks: [{ crop: 'crops/b1.png' }, { crop: 'crops/b1-1.png' }, {}, { crop: '/etc/x.png' }] }), ['crops/b1-1.png', 'crops/b1.png']);
});

test('askEntry keeps the picture a box had when it was asked about; withAsk keeps it as it came', () => {
  const lines = ['bart> A chart.', '', '*Sonnet · high · 2 s*'];
  assert.equal(askEntry({ id: 'a1', question: 'what?', lines, meta: {}, at: 'now', crop: 'crops/b1-2.png' }).crop, 'crops/b1-2.png');
  assert.equal('crop' in askEntry({ id: 'a1', question: 'what?', lines, meta: {}, at: 'now' }), false);
  for (const bad of ['../../x.png', 'crops/a b.png', 7]) assert.equal('crop' in askEntry({ id: 'a1', question: 'q', lines, meta: {}, at: 'now', crop: bad }), false);
  const marks = { [WEB]: [boxMark('b1', { crop: 'crops/b1-3.png' })] };
  const entry = askEntry({ id: 'a1', question: 'q', lines, meta: {}, at: 'now', crop: 'crops/b1-2.png' });
  assert.equal(withAsk(marks, null, 'b1', entry)[WEB][0].asks[0].crop, 'crops/b1-2.png');
});

test('a box resized: the mark gets a new picture under a new name, the old one stays, and an earlier answer keeps the one it was about', async () => {
  const ctx = await libraryContext();
  const url = 'https://github.com/mqo00/rope';
  const PNG2 = Buffer.from('89504e470d0a1a0a0002', 'hex'), PNG3 = Buffer.from('89504e470d0a1a0a0003', 'hex');
  const file = (name) => path.join(ctx.dataRoot, 'annotations', name);
  assert.equal(await library.addWebMark(ctx, url, boxMark('b1'), { crop: PNG }), true);
  const lines = ['bart> A chart of results.', '', '*Sonnet · high · 2 s*'];
  assert.equal(await library.addMarkAnswer(ctx, { url }, null, 'b1', askEntry({ id: 'a1', question: 'what is it?', lines, meta: {}, at: 'now', crop: 'crops/b1.png' })), true);

  const wider = { ...boxMark('b1').box, w: 0.8, doc: { ...boxMark('b1').box.doc, w: 480 } };
  const once = await library.updateWebMark(ctx, url, 'b1', { box: wider, text: 'Figure 2: results and the caption' }, { crop: PNG2 });
  assert.equal(once.crop, 'crops/b1-1.png');
  assert.deepEqual(once.box, wider);
  assert.equal(once.text, 'Figure 2: results and the caption');
  assert.equal(once.asks[0].crop, 'crops/b1.png', 'the answer keeps the picture it was about');
  assert.deepEqual(fs.readFileSync(file('crops/b1.png')), PNG, 'the old picture is kept');
  assert.deepEqual(fs.readFileSync(file('crops/b1-1.png')), PNG2);
  assert.deepEqual((await library.readPageAnnotations(ctx, url))[WEB][0], once);
  const twice = await library.updateWebMark(ctx, url, 'b1', { box: boxMark('b1').box }, { crop: PNG3 });
  assert.equal(twice.crop, 'crops/b1-2.png');
  assert.deepEqual(fs.readFileSync(file('crops/b1-1.png')), PNG2);

  // a note: only what may be set is; no picture without bytes
  const noted = await library.updateWebMark(ctx, url, 'b1', { note: '@bart what changed?', id: 'other', asks: [], crop: 'crops/x.png' });
  assert.equal(noted.note, '@bart what changed?');
  assert.equal(noted.id, 'b1');
  assert.equal(noted.asks.length, 1);
  assert.equal(noted.crop, 'crops/b1-2.png');
  assert.equal(await library.updateWebMark(ctx, url, 'nope', { note: 'x' }), null);
  assert.equal(await library.updateWebMark(ctx, 'http://localhost:3000/', 'b1', { note: 'x' }), null);
  assert.equal((await library.readWebMark(ctx, { url }, 'b1')).note, '@bart what changed?');

  // @bart sees which picture each answer was about
  const xml = webStageBlock({ name: 'rope', address: url, path: '', annotations: '', inkRoot: path.join(ctx.dataRoot, 'annotations') }, await library.readPageAnnotations(ctx, url));
  assert.ok(xml.includes(`<box crop="${file('crops/b1-2.png')}">`), xml);
  assert.ok(xml.includes(`<ask crop="${file('crops/b1.png')}">\n<question>\nwhat is it?`), xml);
});

test('removing a box deletes every picture of it (its own, its answers\', a resize\'s nothing answered about); Undo brings them all back', async () => {
  const ctx = await libraryContext();
  const url = 'https://en.wikipedia.org/wiki/Hypertext';
  const file = (name) => path.join(ctx.dataRoot, 'annotations', 'crops', name);
  const bytes = (n) => Buffer.from(`89504e470d0a1a0a00${String(n).padStart(2, '0')}`, 'hex');
  assert.equal(await library.addWebMark(ctx, url, boxMark('b1'), { crop: bytes(0) }), true);
  assert.equal(await library.addWebMark(ctx, url, boxMark('b10'), { crop: bytes(9) }), true); // another box, a name like it
  await library.updateWebMark(ctx, url, 'b1', {}, { crop: bytes(1) }); // b1-1: nothing answered about it
  await library.addMarkAnswer(ctx, { url }, null, 'b1', askEntry({ id: 'a1', question: 'q', lines: ['bart> a'], meta: {}, at: 'now', crop: 'crops/b1-1.png' }));
  await library.updateWebMark(ctx, url, 'b1', {}, { crop: bytes(2) }); // b1-2: its picture now
  await library.updateWebMark(ctx, url, 'b1', {}, { crop: bytes(3) }); // b1-3
  const before = ['b1.png', 'b1-1.png', 'b1-2.png', 'b1-3.png'];
  for (const name of before) assert.ok(fs.existsSync(file(name)), name);

  const removed = await library.removeWebMark(ctx, url, 'b1');
  assert.deepEqual(removed.crops.map((c) => c.crop).sort(), before.map((name) => `crops/${name}`).sort());
  for (const name of before) assert.equal(fs.existsSync(file(name)), false, name);
  assert.deepEqual(fs.readFileSync(file('b10.png')), bytes(9), 'another box\'s picture stays');

  assert.equal(await library.restoreWebMark(ctx, url, removed), true);
  before.forEach((name, n) => assert.deepEqual(fs.readFileSync(file(name)), bytes(n), name));
  assert.equal((await library.readWebMark(ctx, { url }, 'b1')).crop, 'crops/b1-3.png');
  // only the mark's own pictures come back
  assert.equal(await library.removeWebMark(ctx, url, 'b10') !== null, true);
  assert.equal(await library.restoreWebMark(ctx, url, { mark: boxMark('b10'), index: 0, crops: [{ crop: 'crops/b1.png', bytes: bytes(7) }] }), true);
  assert.deepEqual(fs.readFileSync(file('b1.png')), bytes(0));
});

test('resizing in the page: main draws the boxes without that one, waits for the page to paint, takes the new picture and updates the mark', async () => {
  const { page, updated } = setup();
  page.onSend = (channel, payload) => { if (channel === PAGE.CHANNELS.frame) setImmediate(() => page.ipc.listeners.get(PAGE.CHANNELS.frame)(fromMain(page), payload)); };
  const report = page.ipc.listeners.get(PAGE.CHANNELS.boxes);
  report(fromMain(page), { rects: [{ id: 'b1', x: 100, y: 900, w: 300, h: 200 }], selected: 'b1', size: null });
  await tick();
  assert.equal(page.css.filter((css) => css.startsWith('html::after')).length, 1);
  const resize = page.ipc.handlers.get(PAGE.CHANNELS.boxResize);
  const box = { ...boxMark('b1').box, w: 0.9 };
  const answer = await resize(fromMain(page), { id: 'b1', rect: { x: 10, y: 20, w: 330, h: 210 }, box, text: '  the  new\ntext ' });
  assert.deepEqual(answer, { box });
  assert.deepEqual(page.captures.map((c) => c.rect), [{ x: 10, y: 20, width: 330, height: 210 }]);
  assert.equal(page.captures[0].rules, 0, 'its own lines are not in its picture');
  assert.ok(page.sent.some(([channel]) => channel === PAGE.CHANNELS.frame), 'the page was asked to paint first');
  await tick();
  assert.equal(page.css.filter((css) => css.startsWith('html::after')).length - page.removedCss.length, 1, 'drawn again after');
  assert.deepEqual(updated, [['https://en.wikipedia.org/wiki/Douglas_Engelbart', 'b1', { box, text: 'the new text' }, { crop: PNG }]]);
  // what a page may not send: no resize
  assert.equal(await resize(fromMain(page), { id: 'b 1', rect: { x: 0, y: 0, w: 1, h: 1 }, box }), null);
  assert.equal(await resize(fromMain(page), { id: 'b1', rect: { x: 0, y: 0, w: 0, h: 1 }, box }), null);
  await assert.rejects(() => resize({ sender: {}, senderFrame: null }, { id: 'b1' }));
  // the cursor over a handle: one rule while it is there, gone after
  page.ipc.listeners.get(PAGE.CHANNELS.cursor)(fromMain(page), 'nwse-resize');
  await tick();
  assert.ok(page.css.at(-1).includes('cursor:nwse-resize !important'));
  page.ipc.listeners.get(PAGE.CHANNELS.cursor)(fromMain(page), 'url(evil)');
  await tick();
  assert.ok(!page.css.some((css) => css.includes('evil')));
  assert.equal(page.removedCss.at(-1), `key-${page.css.length}`);
});

test('the card: one view per window beside the selected box on the tab in front, following it, gone out of view, on navigating, on another tab and on hide', async () => {
  const marks = [boxMark('b1', { note: 'kept note', asks: [askEntry({ id: 'a1', question: 'what?', lines: ['bart> A chart.'], meta: {}, at: 'now' })] })];
  const { fake, views, page, told, updated, removed } = setup({ list: marks });
  const view = (value) => page.ipc.listeners.get(PAGE.CHANNELS.boxView)(fromMain(page), value);
  view({ id: 'b1', rect: { x: 100, y: 50, w: 200, h: 100 }, viewport: { width: 800, height: 600 }, scrolling: false });
  const card = fake.made.find((v) => v.options.webPreferences.preload === VIEWS.BOX_CARD_PRELOAD);
  assert.ok(card, 'a card view');
  assert.equal(card.options.webPreferences.sandbox, true);
  assert.equal(card.webContents.loaded[0], VIEWS.BOX_CARD_URL);
  assert.equal(card.visible, true);
  assert.equal(fake.children.at(-1), card, 'over the page');
  assert.deepEqual(card.bounds, { x: 308, y: 90, width: VIEWS.CARD_W, height: 64 }); // right of the box (page at y 40)
  // it is given its mark once its page has loaded
  card.webContents.emit('did-finish-load');
  await tick();
  const state = card.webContents.sent.filter(([c]) => c === CARD.CHANNELS.state).at(-1)[1];
  assert.deepEqual(state.mark, { id: 'b1', note: 'kept note', asks: [{ id: 'a1', question: 'what?', answer: 'A chart.', at: 'now', meta: { name: null, effort: null } }] });
  assert.deepEqual(state.running, []);
  // its height, as the card says; then it follows the box as the page scrolls, to the left when there is no room
  const fromCard = { sender: card.webContents, senderFrame: card.webContents.mainFrame };
  card.webContents.ipc.listeners.get(CARD.CHANNELS.size)(fromCard, { height: 180.2 });
  assert.equal(card.bounds.height, 181);
  // and its width, as the card says (only as wide as its note, 2026-10-07): never wider than CARD_W, which it is when it says none
  card.webContents.ipc.listeners.get(CARD.CHANNELS.size)(fromCard, { height: 180.2, width: 200.4 });
  assert.equal(card.bounds.width, 201);
  card.webContents.ipc.listeners.get(CARD.CHANNELS.size)(fromCard, { height: 180.2, width: 999 });
  assert.equal(card.bounds.width, VIEWS.CARD_W);
  card.webContents.ipc.listeners.get(CARD.CHANNELS.size)(fromCard, { height: 180.2 });
  assert.equal(card.bounds.width, VIEWS.CARD_W);
  // a box's size is kept: selected again, its card is placed at that size at once (2026-10-07)
  card.webContents.ipc.listeners.get(CARD.CHANNELS.size)(fromCard, { height: 180.2, width: 200.4 });
  view({ id: 'b2', rect: { x: 100, y: 50, w: 200, h: 100 }, viewport: { width: 800, height: 600 }, scrolling: false });
  assert.equal(card.bounds.width, VIEWS.CARD_W, 'another box: not yet measured');
  view({ id: 'b1', rect: { x: 100, y: 50, w: 200, h: 100 }, viewport: { width: 800, height: 600 }, scrolling: false });
  assert.deepEqual([card.bounds.width, card.bounds.height], [201, 181], 'b1 again: its own size');
  card.webContents.ipc.listeners.get(CARD.CHANNELS.size)(fromCard, { height: 180.2 });
  view({ id: 'b1', rect: { x: 500, y: 10, w: 200, h: 100 }, viewport: { width: 800, height: 600 }, scrolling: true });
  assert.deepEqual(card.bounds, { x: 156, y: 50, width: VIEWS.CARD_W, height: 181 });
  assert.equal(card.visible, VIEWS.CARD_HIDE_WHILE_SCROLLING ? false : true);
  view({ id: 'b1', rect: { x: 500, y: 700, w: 200, h: 100 }, viewport: { width: 800, height: 600 }, scrolling: false });
  assert.equal(card.visible, false, 'the box is out of view');
  view({ id: 'b1', rect: { x: 500, y: 300, w: 200, h: 100 }, viewport: { width: 800, height: 600 } });
  assert.equal(card.visible, true);

  // the card's own channels, from its own page only
  const on = (name) => card.webContents.ipc.listeners.get(CARD.CHANNELS[name]);
  on('note')({ sender: page, senderFrame: page.mainFrame }, 'not from the card');
  on('note')(fromCard, '@bart what is shown here?');
  await tick();
  assert.deepEqual(updated, [['https://en.wikipedia.org/wiki/Douglas_Engelbart', 'b1', { note: '@bart what is shown here?' }, undefined]]);
  on('ask')(fromCard, 'what is shown here?');
  await tick();
  assert.deepEqual(told.filter(([c]) => c === 'browser:box-ask').at(-1)[1], { tab: 'a', markId: 'b1', url: 'https://en.wikipedia.org/wiki/Douglas_Engelbart', title: 'Title', question: 'what is shown here?', note: '@bart what is shown here?', turns: [{ question: 'what?', answer: 'A chart.' }] });
  on('stop')(fromCard, 'h123');
  assert.deepEqual(told.at(-1), ['browser:box-stop', { askId: 'h123' }]);
  // what the Stage has running: the card shows its own box's
  views.setBoxAsks([{ askId: 'h123', markId: 'b1', question: 'what is shown here?', activity: 'Reading', lines: [], log: ['Read x'] }, { askId: 'h9', markId: 'other' }, { askId: 5 }]);
  await tick();
  const running = card.webContents.sent.filter(([c]) => c === CARD.CHANNELS.state).at(-1)[1].running;
  assert.deepEqual(running.map((p) => [p.askId, p.activity]), [['h123', 'Reading']]);
  // keys typed in the card are the card's: Backspace there removes nothing
  card.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'Backspace' });
  await tick();
  assert.deepEqual(removed, []);
  on('remove')(fromCard);
  await tick();
  assert.deepEqual(removed, [['https://en.wikipedia.org/wiki/Douglas_Engelbart', 'b1']], 'its trash removes the box');

  // gone: the page going elsewhere, another tab in front, the Stage hidden; nothing selected
  view({ id: 'b1', rect: { x: 100, y: 50, w: 200, h: 100 }, viewport: { width: 800, height: 600 } });
  assert.equal(card.visible, true);
  page.emit('did-navigate');
  assert.equal(card.visible, false);
  view({ id: 'b1', rect: { x: 100, y: 50, w: 200, h: 100 }, viewport: { width: 800, height: 600 } });
  views.open('b', 'https://github.com/');
  views.show('b', { x: 0, y: 40, width: 800, height: 600 });
  assert.equal(card.visible, false, 'another tab in front');
  views.show('a', { x: 0, y: 40, width: 800, height: 600 });
  assert.equal(card.visible, true, 'its tab in front again');
  void views.hide();
  assert.equal(card.visible, false);
  views.show('a', { x: 0, y: 40, width: 800, height: 600 });
  view({ id: null });
  assert.equal(card.visible, false, 'nothing selected');
  assert.equal(fake.made.filter((v) => v.options.webPreferences.preload === VIEWS.BOX_CARD_PRELOAD).length, 1, 'one card view, made once');
  // what main takes from a page and from the Stage
  assert.deepEqual(VIEWS.boxViewInput({ id: 'x', rect: { x: 1, y: 2, w: 0, h: 4 }, viewport: { width: 1, height: 1 } }), { id: null });
  assert.equal(VIEWS.boxAsksInput([{ askId: 'a', markId: 'b', lines: Array.from({ length: 900 }, () => 'x') }])[0].lines.length, 400);
});

test('ask-bart from a box\'s card: the answer keeps the picture the box had when asked, though it was resized meanwhile', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-boxes-ask-'));
  const layout = ensureHome(homeDir);
  const ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  t.after(() => db.closeAll());
  const project = await projects.createProject(ctx, { name: 'Box asks', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-boxes-ask-code-')) });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Figures' });
  const url = 'https://en.wikipedia.org/wiki/NLS_(computer_system)';
  assert.equal(await library.addWebMark(ctx, url, boxMark('bA', { crop: 'crops/bA.png' }), { crop: PNG }), true);
  const handlers = new Map(), asked = [], win = { id: 'w1' };
  let go;
  const gate = new Promise((resolve) => { go = resolve; });
  const bart = { async ask(c, pid, question) { asked.push(question); await gate; return { lines: ['bart> A screenshot of NLS.', '', '*Sonnet · high · 2 s*'], meta: { provider: 'anthropic', level: { name: 'Sonnet', effort: 'high' }, ms: 2000 } }; }, stop: () => true };
  registerEngelbartIpc({
    store: { context: async () => ctx }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {}, bart,
    windowHandler: (fn) => (...args) => fn(win, ...args), reply: () => {}, announce: () => {},
  });
  const ref = { kind: 'mark', id: 'bA', url, source: 'web' };
  const pending = handlers.get('engelbart:ask-bart')(project.id, { askId: 'hB1', ref, workspaceId: workspace.id, text: 'what is shown?', turns: [], highlight: { quote: '', note: '@bart what is shown?', paper: 'NLS' } });
  for (let n = 0; n < 10 && !asked.length; n += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const running = await handlers.get('engelbart:running-paper-asks')(project.id);
  assert.deepEqual(running.map((p) => [p.askId, p.markId, p.page, p.source]), [['hB1', 'bA', null, 'web']]);
  // resized while Bart works
  assert.equal((await library.updateWebMark(ctx, url, 'bA', {}, { crop: PNG })).crop, 'crops/bA-1.png');
  go();
  const out = await pending;
  assert.equal(out.entry.crop, 'crops/bA.png');
  const kept = await library.readWebMark(ctx, { url }, 'bA');
  assert.equal(kept.crop, 'crops/bA-1.png');
  assert.deepEqual(kept.asks, [out.entry]);
});

test('highlightBlock for a box: <box crop> with the text under it in place of <quote>, the note and the page text kept; buildContext reads the box from the ink', async (t) => {
  const paper = { source: 'web', name: 'Douglas Engelbart', address: 'https://en.wikipedia.org/wiki/Douglas_Engelbart', path: '' };
  assert.equal(highlightBlock(paper, null, { quote: 'ignored', note: '@bart what is this?', pageText: 'around it', box: { crop: '/data/annotations/crops/b1.png', text: 'Figure 2: results' } }),
    '<highlight source="web" title="Douglas Engelbart" address="https://en.wikipedia.org/wiki/Douglas_Engelbart">\n<box crop="/data/annotations/crops/b1.png">\n<text>\nFigure 2: results\n</text>\n</box>\n<note>\n@bart what is this?\n</note>\n<page_text>\naround it\n</page_text>\n</highlight>');
  assert.match(highlightBlock(paper, null, { quote: 'a passage', note: '' }), /<quote>\na passage\n<\/quote>/); // a highlight as before
  assert.match(BART_SYSTEM_PROMPT, /On a box, <box crop="…"> stands in place of <quote>/);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-boxes-ctx-'));
  const layout = ensureHome(homeDir);
  const ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  t.after(() => db.closeAll());
  const project = await projects.createProject(ctx, { name: 'Box context', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-boxes-ctx-code-')) });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Figures' });
  const url = paper.address;
  assert.equal(await library.addWebMark(ctx, url, boxMark('bC', { crop: 'crops/bC.png', note: '@bart what is it?' }), { crop: PNG }), true);
  const ref = { kind: 'mark', id: 'bC', url, source: 'web' };
  // the renderer's word for it is not taken: the box is read from the page's ink
  const { documents, head } = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'q1', highlight: { quote: 'not what the box holds', note: '', paper: 'Douglas Engelbart', pageText: '' } });
  assert.ok(documents.includes(`<box crop="${path.join(ctx.dataRoot, 'annotations', 'crops', 'bC.png')}">\n<text>\nFigure 2: results\n</text>\n</box>\n<note>\n@bart what is it?\n</note>\n</highlight>`), documents);
  assert.ok(!documents.includes('not what the box holds'));
  assert.match(head, /asked from: a box on the web page "Douglas Engelbart", opened from the workspace "Figures"/);
  // a web highlight is still a highlight
  await library.addWebMark(ctx, url, { id: 'wH', quote: { exact: 'the mouse', prefix: '', suffix: '' }, note: '' });
  const plain = await buildContext(ctx, project.id, { ref: { ...ref, id: 'wH' }, workspaceId: workspace.id, askId: 'q2', highlight: { quote: 'the mouse', note: '@bart who?', paper: 'Douglas Engelbart' } });
  assert.match(plain.head, /asked from: a highlight on the web page/);
  assert.ok(plain.documents.includes('<quote>\nthe mouse\n</quote>'));
});
