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

test('a click selects a box by its edge (inside too, from the drawing layer); the smallest of nested ones', () => {
  const rects = [{ id: 'big', x: 0, y: 0, w: 400, h: 400 }, { id: 'small', x: 100, y: 100, w: 100, h: 100 }];
  assert.equal(PAGE.boxAt(rects, 0, 200), 'big'); // on its edge
  assert.equal(PAGE.boxAt(rects, -6, 200), 'big'); // just outside it
  assert.equal(PAGE.boxAt(rects, 300, 300), null); // well inside: the page's click
  assert.equal(PAGE.boxAt(rects, 300, 300, { inside: true }), 'big');
  assert.equal(PAGE.boxAt(rects, 150, 150, { inside: true }), 'small');
  assert.equal(PAGE.boxAt(rects, 100, 150), 'small');
  assert.equal(PAGE.boxAt(rects, 600, 600, { inside: true }), null);
});

/* ------------------------------------------------------------------------------------------------- the drawing */

test('boxesCss: one html::after rule, out of flow and inert, covering only the boxes, an SVG background; nothing for none', () => {
  assert.equal(BOX.boxesCss([]), '');
  const css = BOX.boxesCss([{ id: 'a', x: 100, y: 900, w: 300, h: 200 }, { id: 'b', x: 50, y: 1500, w: 100, h: 50 }], 'b', { width: 1200, height: 4000 });
  assert.match(css, /^html::after\{.*\}$/);
  for (const part of ['position:absolute !important', 'pointer-events:none !important', 'z-index:2147483647 !important', 'left:47px !important', 'top:897px !important', 'width:356px !important', 'height:656px !important', 'content:"" !important']) assert.ok(css.includes(part), part);
  const svg = decodeURIComponent(css.match(/url\("data:image\/svg\+xml,([^"]+)"\)/)[1]);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="356" height="656"/);
  assert.equal((svg.match(/<rect /g) || []).length, 2);
  assert.match(svg, /<rect x="3" y="603" width="100" height="50"[^>]*stroke-width="3"\/>/); // the selected one heavier
  // never past the page's edge: it must add nothing to what scrolls
  assert.match(BOX.boxesCss([{ id: 'a', x: 1100, y: 10, w: 100, h: 20 }], null, { width: 1200, height: 800 }), /width:103px/);
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
    { rects: [{ id: 'a', x: 1, y: 2, w: 3, h: 4 }], selected: 'a', size: { width: 10, height: 20 } });
  assert.equal(boxReportInput({}), null);
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
  assert.deepEqual(removed.crop, PNG);
  assert.equal(fs.existsSync(crop), false);
  assert.deepEqual((await library.readPageAnnotations(ctx, url))[WEB].map((m) => m.id), ['w1']);
  assert.equal(await library.removeWebMark(ctx, url, 'b1'), null); // once

  assert.equal(await library.restoreWebMark(ctx, url, removed), true);
  assert.deepEqual(fs.readFileSync(crop), PNG);
  assert.deepEqual((await library.readPageAnnotations(ctx, url))[WEB].map((m) => m.id), ['w1', 'b1']);
  assert.equal(await library.restoreWebMark(ctx, url, removed), false); // there already

  // a highlight has no picture to delete; a preview keeps nothing
  assert.equal((await library.removeWebMark(ctx, url, 'w1')).crop, null);
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
        loadURL(url) { this.loaded.push(url); this.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle: () => 'Title', isLoading: () => false, isDestroyed() { return this.closed; },
        close() { this.closed = true; }, reload() {}, stop() {}, focus() { this.focused += 1; }, getZoomFactor: () => 1,
        send(channel, payload) { this.sent.push([channel, payload]); if (this.onSend) this.onSend(channel, payload); },
        insertCSS(css) { this.css.push(css); return Promise.resolve(`key-${this.css.length}`); },
        removeInsertedCSS(key) { this.removedCss.push(key); return Promise.resolve(); },
        capturePage: async (rect) => ({ isEmpty: () => false, getSize: () => ({ width: rect.width * 2, height: rect.height * 2 }), resize() { return this; }, toPNG: () => PNG, rect }),
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

function setup() {
  const fake = fakeElectron();
  const saved = [], removed = [], restored = [], told = [];
  const pageMarks = {
    list: async () => [],
    add: async (url, mark, extra) => { saved.push([url, mark, extra]); return true; },
    remove: async (url, markId) => { removed.push([url, markId]); return { mark: boxMark(markId), index: 0, crop: PNG }; },
    restore: async (url, value) => { restored.push([url, value]); return true; },
  };
  let n = 0;
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: (channel, payload) => { told.push([channel, payload]); }, appName: 'Engelbart', pageMarks, newId: () => `box-${(n += 1)}` });
  views.open('a', 'https://en.wikipedia.org/wiki/Douglas_Engelbart');
  views.show('a', { x: 0, y: 40, width: 800, height: 600 });
  const page = fake.made[0].webContents;
  return { fake, views, page, saved, removed, restored, told };
}
const fromMain = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });
const key = (contents, input) => { let prevented = false; contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: '', isAutoRepeat: false, shift: false, meta: false, control: false, alt: false, ...input }); return prevented; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

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
  await tick();
  const asked = page.sent.find(([channel]) => channel === PAGE.CHANNELS.box);
  assert.deepEqual(asked[1].rect, { x: 100, y: 50, w: 300, h: 200 });
  assert.equal(saved.length, 1);
  const [url, mark, extra] = saved[0];
  assert.equal(url, 'https://en.wikipedia.org/wiki/Douglas_Engelbart');
  assert.deepEqual({ ...mark, at: typeof mark.at }, { id: 'box-1', box: reply.box, crop: 'crops/box-1.png', text: 'Figure 2: results', note: null, at: 'string' });
  assert.deepEqual(extra.crop, PNG);
  assert.deepEqual(page.sent.at(-1), [PAGE.CHANNELS.boxAdd, { id: 'box-1', box: reply.box }]);

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
  assert.deepEqual(restored[0][1].crop, PNG);
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
  const ink = { [WEB]: [webMark('w1', 'a passage'), boxMark('b1'), boxMark('b2', { text: '', crop: null }), boxMark('b3', { crop: '../../etc/passwd', note: 'see this' })] };
  const listed = webMarksOf(ink, inkRoot);
  assert.deepEqual(listed.map((h) => [h.box || false, h.quote, h.crop || '']), [[false, 'a passage', ''], [true, '', '/data/annotations/crops/b1.png'], [true, '', ''], [true, '', '']]);
  const page = { name: 'Douglas Engelbart', address: 'https://en.wikipedia.org/wiki/Douglas_Engelbart', path: '', annotations: '/data/annotations/pages/x.json', inkRoot };
  const stage = webStageBlock(page, ink);
  assert.ok(stage.includes('<highlight>\n<quote>\na passage\n</quote>\n</highlight>\n'));
  assert.ok(stage.includes('<box crop="/data/annotations/crops/b1.png">\n<text>\nFigure 2: results\n</text>\n</box>\n'), stage);
  assert.ok(stage.includes('<box/>\n')); // a box with nothing to say still says it is there
  assert.ok(stage.includes('<box>\n<text>\nFigure 2: results\n</text>\n<note>\nsee this\n</note>\n</box>\n')); // no crop outside crops/
  assert.ok(!/<quote>\n\n/.test(stage));
  // only boxes: still not highlights="0"
  assert.ok(webStageBlock(page, { [WEB]: [boxMark('b1')] }).startsWith('<stage source="web" title="Douglas Engelbart" address="https://en.wikipedia.org/wiki/Douglas_Engelbart" annotations='));

  const mentioned = mentionedBlock([{ source: 'web', name: 'Saved', address: 'https://saved.example.org/', path: '/p/index.html', annotations: '/ink/s.json', inkRoot, ink: { [WEB]: [boxMark('s1')] } }]);
  assert.equal(mentioned, '<highlights from="mentioned">\n<page source="web" title="Saved" address="https://saved.example.org/" path="/p/index.html" annotations="/ink/s.json">\n<box crop="/data/annotations/crops/s1.png">\n<text>\nFigure 2: results\n</text>\n</box>\n</page>\n</highlights>');

  // a pdf page's list with a box in it (later builds) is read as a box, never as a quote or a free note
  const pdf = marksOf({ 2: [{ id: 'p', rects: [{ x: 0, y: 0, w: 1, h: 0.1 }], y: 0.1, text: 'pdf text' }, { id: 'pb', y: 0.3, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, crop: 'crops/pb.png', text: 'under' }] }, inkRoot);
  assert.deepEqual(pdf.map((h) => [h.page, h.box || false, h.quote, h.crop || '']), [[2, false, 'pdf text', ''], [2, true, '', '/data/annotations/crops/pb.png']]);
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
