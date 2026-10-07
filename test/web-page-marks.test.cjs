'use strict';

// MATH-54 build 2 (2026-10-06): the Stage's pages get one preload, registered on their browsing session, that tints the
// page's web highlights (src/main/browser/page-preload.cjs), and the right-click menu's Highlight saves a selection as a
// web mark (src/main/browser/views.cjs, store/library.cjs addWebMark). Here: finding a highlight by its quote, the menu
// entry, what main accepts from a page, previews never filed, and tabs a page opened getting the preload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const PAGE = require('../src/main/browser/page-preload.cjs');
const { PAGE_PRELOAD, MARK_CSS, fileablePage, quoteInput, marksForPage, createBrowserViews } = require('../src/main/browser/views.cjs');
const library = require('../src/main/store/library.cjs');

/* ------------------------------------------------------------------------------------------- finding by quote */

const node = (data) => ({ data });
const text = (...parts) => PAGE.textMap(parts.map(node)).text;
/** The passage a quote finds in `page`, and how much of the page comes before it. */
function found(page, quote) {
  const at = PAGE.anchor(PAGE.textMap([node(page)]).text, quote);
  return at && { before: PAGE.textMap([node(page)]).text.slice(0, at.start), exact: PAGE.textMap([node(page)]).text.slice(at.start, at.end) };
}

test('page text: each run of whitespace is one space, none at the start, across nodes', () => {
  assert.equal(text('  Hello\n\n  ', '  world ', 'again'), 'Hello world again');
  const map = PAGE.textMap(['a  b', '', ' c'].map(node));
  assert.equal(map.text, 'a b c');
  assert.equal(map.segs.length, 2); // a node with no text after spacing has no seg
  assert.deepEqual(map.segs[0].map, [0, 1, 3]); // 'a', the first of the two spaces, 'b'
});

test('a quote is found where it is unique, and spacing does not matter', () => {
  const quote = { exact: 'the quick  brown\nfox', prefix: 'once ', suffix: ' jumped' };
  assert.deepEqual(found('Once upon a time the quick brown fox jumped.', quote), { before: 'Once upon a time ', exact: 'the quick brown fox' });
  assert.equal(found('Nothing to see here.', quote), null);
  assert.equal(PAGE.anchor('anything', { exact: '   ', prefix: '', suffix: '' }), null);
});

test('repeated text: prefix and suffix pick the right occurrence', () => {
  const page = 'Alice said the cat sat on the mat. Later Bob said the cat sat by the door. Then Carol said the cat sat in a box.';
  assert.match(found(page, { exact: 'the cat sat', prefix: 'Later Bob said ', suffix: ' by the door.' }).before, /Later Bob said $/);
  assert.match(found(page, { exact: 'the cat sat', prefix: 'Then Carol said ', suffix: ' in a box.' }).before, /Carol said $/);
  assert.match(found(page, { exact: 'the cat sat', prefix: 'Alice said ', suffix: ' on the mat.' }).before, /^Alice said $/);
  // only a suffix to go by
  assert.match(found(page, { exact: 'the cat sat', prefix: '', suffix: ' in a box.' }).before, /Carol said $/);
  // nothing to go by: the first
  assert.match(found(page, { exact: 'the cat sat', prefix: '', suffix: '' }).before, /^Alice said $/);
});

test('small edits around a repeated passage still find the right one', () => {
  const quote = { exact: 'the cat sat', prefix: 'Later Bob said ', suffix: ' by the door.' };
  // a word changed before it, a word put in after it
  const edited = 'Alice said the cat sat on the mat. Later on, Robert said the cat sat by the front door. Then Carol said the cat sat in a box.';
  assert.match(found(edited, quote).before, /Robert said $/);
  // the sentence moved: another paragraph now comes first
  const moved = 'A new opening. Then Carol said the cat sat in a box. Alice said the cat sat on the mat. Later Bob says the cat sat by the door!';
  assert.match(found(moved, quote).before, /Later Bob says $/);
  // the passage itself changed: not found (skipped, for now)
  assert.equal(found('Later Bob said the dog sat by the door.', quote), null);
});

test('a selection becomes a quote with words on each side, and back into the nodes it covers', () => {
  const nodes = ['Intro text here. ', 'The ', 'important', ' claim is made. More text follows after it.'].map(node);
  const map = PAGE.textMap(nodes);
  // from 'The' (node 1, offset 0) to the end of 'claim' (node 3, offset 6)
  const got = PAGE.quoteOf(map, 1, 0, 3, 6);
  assert.deepEqual(got.quote, { exact: 'The important claim', prefix: 'Intro text here. ', suffix: ' is made. More text follows afte' });
  assert.equal(got.quote.suffix.length, PAGE.CONTEXT);
  const range = PAGE.rangeOf(map, got.start, got.end);
  assert.equal(range.startNode, nodes[1]); assert.equal(range.startOffset, 0);
  assert.equal(range.endNode, nodes[3]); assert.equal(range.endOffset, 6);
  // whitespace at either end is left out
  const spaced = PAGE.quoteOf(map, 0, 16, 1, 4);
  assert.equal(spaced.quote.exact, 'The');
  // found again where it was made
  assert.deepEqual(PAGE.anchor(map.text, got.quote), { start: got.start, end: got.end });
  // nothing selected, or too much
  assert.equal(PAGE.quoteOf(map, 0, 16, 0, 17), null);
  const long = PAGE.textMap([node('x'.repeat(PAGE.MAX_EXACT + 1))]);
  assert.equal(PAGE.quoteOf(long, 0, 0, 0, PAGE.MAX_EXACT + 1), null);
});

/* --------------------------------------------------------------------------------------------------- the views */

function fakeElectron() {
  const made = [];
  let frames = 0;
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.visible = true;
      const contents = options.webContents || new EventEmitter();
      const ipc = { handlers: new Map(), listeners: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); }, on(channel, fn) { this.listeners.set(channel, fn); } };
      Object.assign(contents, {
        ipc, sent: [], css: [], loaded: [], closed: false, url: contents.url || '',
        mainFrame: { frameTreeNodeId: (frames += 1) },
        loadURL(url) { this.loaded.push(url); this.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle: () => 'Title', isLoading: () => false, isDestroyed() { return this.closed; },
        close() { this.closed = true; }, reload() {}, stop() {},
        send(channel, payload) { this.sent.push([channel, payload]); if (this.onSend) this.onSend(channel, payload); },
        insertCSS(css, options) { this.css.push([css, options]); return Promise.resolve('key'); },
        setWindowOpenHandler(handler) { this.windowOpen = handler; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
      });
      this.webContents = contents;
      made.push(this);
    }
    setBackgroundColor() {}
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible; }
    setBounds() {}
  }
  const browsing = {
    preloads: [], cookies: { on() {}, flushStore: async () => {} }, setUserAgent() {}, getUserAgent: () => 'UA', setPermissionRequestHandler() {},
    webRequest: { onHeadersReceived() {} }, on() {},
    registerPreloadScript(script) { this.preloads.push(script); return script.id; },
  };
  const menus = [];
  const Menu = { buildFromTemplate: (template) => { menus.push(template); return { popup() {} }; } };
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1, focus() {} }, contentView: { addChildView() {}, removeChildView() {} } };
  return { made, browsing, menus, win, electron: { WebContentsView, session: { fromPartition: () => browsing }, Menu, clipboard: {}, dialog: {}, shell: { openExternal: async () => {} } } };
}

function setup({ marks = {} } = {}) {
  const fake = fakeElectron();
  const saved = [], listed = [];
  const pageMarks = {
    list: async (url) => { listed.push(url); return marks[url] || []; },
    add: async (url, mark) => { saved.push([url, mark]); return true; },
  };
  let n = 0;
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: () => {}, appName: 'Engelbart', pageMarks, newId: () => `mark-${(n += 1)}` });
  return { fake, views, saved, listed };
}

const fromMain = (contents, extra = {}) => ({ sender: contents, senderFrame: contents.mainFrame, ...extra });
const menuFor = (fake, contents, params) => { contents.emit('context-menu', {}, { selectionText: '', isEditable: false, linkURL: '', x: 0, y: 0, ...params }); return fake.menus.at(-1); };
const labels = (template) => template.map((item) => item.label || item.role || item.type);

test('the preload is registered once on the browsing session, and tabs a page opened have it too', async () => {
  const { fake, views } = setup({ marks: { 'https://example.com/new': [{ id: 'm1', quote: { exact: 'hi', prefix: '', suffix: '' } }] } });
  const other = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: () => {}, appName: 'Engelbart' }); // a second window
  views.open('a', 'https://example.com/');
  other.open('b', 'https://example.org/');
  assert.deepEqual(fake.browsing.preloads, [{ type: 'frame', id: 'engelbart-page', filePath: PAGE_PRELOAD }]);
  assert.ok(fs.existsSync(PAGE_PRELOAD));
  // contextIsolation and sandbox stay on, and nothing in a view's own preferences
  const [a] = fake.made;
  assert.equal(a.options.webPreferences.contextIsolation, true);
  assert.equal(a.options.webPreferences.sandbox, true);
  assert.equal(a.options.webPreferences.preload, undefined);

  // a window the page opens is a tab around the webContents Chromium made, in the same session: it has the preload, and
  // main answers it as any tab
  const made = Object.assign(new EventEmitter(), { url: 'https://example.com/new' });
  const answer = a.webContents.windowOpen({ url: 'https://example.com/new', disposition: 'foreground-tab' });
  answer.createWindow({ webContents: made });
  const adopted = fake.made.at(-1);
  assert.equal(adopted.webContents, made);
  assert.equal(adopted.options.webPreferences.partition, a.options.webPreferences.partition);
  assert.deepEqual(await made.ipc.handlers.get(PAGE.CHANNELS.marks)(fromMain(made)), [{ id: 'm1', quote: { exact: 'hi', prefix: '', suffix: '' } }]);
  made.emit('dom-ready');
  assert.deepEqual(made.css, [[MARK_CSS, undefined]]); // an author sheet: Chromium paints ::highlight() from no user sheet
});

test('the tint is the pdf highlight blue, and the preload and main agree on names and limits', () => {
  assert.match(MARK_CSS, /^::highlight\(engelbart-web-mark\)\{background-color:rgba\(0,112,243,\.14\) !important\}$/);
  assert.equal(PAGE.HIGHLIGHT, 'engelbart-web-mark');
  const preload = fs.readFileSync(PAGE_PRELOAD, 'utf8').replace(/^\s*\/\/.*$/gm, ''); // its code, not its comments
  assert.doesNotMatch(preload, /contextBridge|exposeInMainWorld/); // the page is given nothing
  assert.doesNotMatch(preload, /require\((?!'electron'\))/); // sandboxed: electron only
});

test('right-click: Highlight above Copy only with a selection, in a tab, on a page whose ink is kept', () => {
  const { fake, views } = setup();
  views.open('a', 'https://example.com/post');
  const contents = fake.made[0].webContents;
  assert.deepEqual(labels(menuFor(fake, contents, { selectionText: 'a passage' })).slice(0, 3), ['Highlight', 'copy', 'separator']);
  assert.ok(!labels(menuFor(fake, contents, {})).includes('Highlight'));
  assert.ok(!labels(menuFor(fake, contents, { selectionText: '   ' })).includes('Highlight'));
  assert.ok(!labels(menuFor(fake, contents, { selectionText: 'typed', isEditable: true })).includes('Highlight'));
  assert.ok(!labels(menuFor(fake, contents, { selectionText: 'x'.repeat(PAGE.MAX_EXACT + 1) })).includes('Highlight'));
  // a page on disk is kept too
  contents.url = 'file:///Users/h/page.html';
  assert.equal(labels(menuFor(fake, contents, { selectionText: 'a passage' }))[0], 'Highlight');
  // a popup is no tab
  const popup = Object.assign(new EventEmitter(), { title: '', isDestroyed: () => false, setTitle() {} });
  popup.webContents = Object.assign(new EventEmitter(), { getURL: () => 'https://example.com/', getTitle: () => '', setWindowOpenHandler() {}, navigationHistory: contents.navigationHistory });
  contents.emit('did-create-window', popup);
  assert.ok(!labels(menuFor(fake, popup.webContents, { selectionText: 'a passage' })).includes('Highlight'));
});

test('Highlight asks the page for its quote, saves it as a web mark and has it tinted', async () => {
  const { fake, views, saved } = setup();
  views.open('a', 'https://www.example.com/post?utm_source=x');
  const contents = fake.made[0].webContents;
  const quote = { exact: 'a passage', prefix: 'before ', suffix: ' after' };
  contents.onSend = (channel, nonce) => { if (channel === PAGE.CHANNELS.quote) setImmediate(() => contents.ipc.listeners.get(PAGE.CHANNELS.quote)(fromMain(contents), { nonce, quote })); };
  menuFor(fake, contents, { selectionText: 'a passage' })[0].click();
  // Until the save lands (or a second passes): the page's reply comes by setImmediate, which a 10ms timer can beat
  // while the whole suite keeps the event loop busy.
  for (const end = Date.now() + 1000; !contents.sent.some(([channel]) => channel === PAGE.CHANNELS.add) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(saved.length, 1);
  const [url, mark] = saved[0];
  assert.equal(url, 'https://www.example.com/post?utm_source=x'); // the library files it by addressKey
  assert.deepEqual({ ...mark, at: typeof mark.at }, { id: 'mark-1', quote, note: null, at: 'string' });
  const added = contents.sent.find(([channel]) => channel === PAGE.CHANNELS.add);
  assert.deepEqual(added[1].mark, { id: 'mark-1', quote });
  assert.equal(added[1].nonce, contents.sent[0][1]);
});

test('untrusted messages are refused: unknown senders, subframes, wrong nonces, bad shapes, too long', async () => {
  const { fake, views, saved, listed } = setup({ marks: { 'https://example.com/': [{ id: 'm1', quote: { exact: 'kept', prefix: '', suffix: '' } }] } });
  views.open('a', 'https://example.com/');
  views.open('b', 'https://example.org/');
  const [a, b] = fake.made.map((view) => view.webContents);
  const marks = a.ipc.handlers.get(PAGE.CHANNELS.marks);
  assert.equal((await marks(fromMain(a))).length, 1);
  // another tab's contents, a subframe, no frame, or arguments
  await assert.rejects(marks(fromMain(b)));
  await assert.rejects(marks({ sender: a, senderFrame: { frameTreeNodeId: 999 } }));
  await assert.rejects(marks({ sender: a }));
  await assert.rejects(marks(fromMain(a), 'https://elsewhere.com/'), TypeError);
  // a closed tab is no longer known
  views.close('a');
  await assert.rejects(marks(fromMain(a)));
  assert.deepEqual(listed, ['https://example.com/']);

  // replies to a quote main asked for
  const contents = b;
  const reply = contents.ipc.listeners.get(PAGE.CHANNELS.quote);
  const ask = async (answer) => {
    contents.sent.length = 0;
    contents.onSend = (channel, nonce) => { if (channel === PAGE.CHANNELS.quote) setImmediate(() => answer(nonce)); };
    return views.highlightSelection('b', contents);
  };
  const good = { exact: 'fine', prefix: '', suffix: '' };
  assert.equal(await ask((nonce) => reply(fromMain(contents), { nonce: `${nonce}x`, quote: good }) || reply(fromMain(contents), { nonce, quote: { exact: 42 } })), false);
  assert.equal(await ask((nonce) => { reply(fromMain(a), { nonce, quote: good }); reply({ sender: contents, senderFrame: { frameTreeNodeId: 999 } }, { nonce, quote: good }); reply(fromMain(contents), { nonce, quote: { ...good, exact: 'x'.repeat(PAGE.MAX_EXACT + 1) } }); }), false);
  assert.equal(await ask((nonce) => reply(fromMain(contents), { nonce, quote: { ...good, prefix: 'p'.repeat(PAGE.MAX_AFFIX + 1) } })), false);
  assert.equal(await ask((nonce) => reply(fromMain(contents), { nonce, quote: null })), false); // no selection there
  assert.deepEqual(saved, []);
  assert.equal(await ask((nonce) => reply(fromMain(contents), { nonce, quote: good })), true);
  assert.equal(saved.length, 1);
  // an unasked reply after that is ignored
  reply(fromMain(contents), { nonce: 'quote-old', quote: good });
  assert.equal(saved.length, 1);
});

test('shapes main accepts and gives', () => {
  assert.deepEqual(quoteInput({ exact: 'a', prefix: 'b', suffix: 'c', extra: 1 }), { exact: 'a', prefix: 'b', suffix: 'c' });
  assert.deepEqual(quoteInput({ exact: 'a' }), { exact: 'a', prefix: '', suffix: '' });
  for (const bad of [null, 'a', ['a'], { exact: '' }, { exact: '  ' }, { exact: 'a', prefix: 3 }, { exact: 'x'.repeat(PAGE.MAX_EXACT + 1) }]) assert.equal(quoteInput(bad), null);
  const list = [{ id: 'ok', quote: { exact: 'a', prefix: 'p'.repeat(100), suffix: 's'.repeat(100) }, note: 'kept out', asks: [1] }, { id: 7, quote: { exact: 'a' } }, { id: 'no-quote' }, null];
  assert.deepEqual(marksForPage(list), [{ id: 'ok', quote: { exact: 'a', prefix: 'p'.repeat(PAGE.MAX_AFFIX), suffix: 's'.repeat(PAGE.MAX_AFFIX) } }]);
  assert.equal(marksForPage(Array.from({ length: 2500 }, (_, i) => ({ id: `m${i}`, quote: { exact: 'a' } }))).length, 2000);
});

test('previews and local servers are never filed: no Highlight, no marks asked for, nothing saved', async () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8080/x', 'https://3000-abc.e2b.app/', 'http://app.localhost/', 'about:blank', 'data:text/html,x']) assert.equal(fileablePage(url), false, url);
  for (const url of ['https://example.com/', 'http://example.com/a', 'file:///Users/h/a.html']) assert.equal(fileablePage(url), true, url);
  const { fake, views, saved, listed } = setup();
  views.open('a', 'http://localhost:3000/');
  const contents = fake.made[0].webContents;
  assert.ok(!labels(menuFor(fake, contents, { selectionText: 'a passage' })).includes('Highlight'));
  assert.deepEqual(await contents.ipc.handlers.get(PAGE.CHANNELS.marks)(fromMain(contents)), []);
  contents.onSend = () => { throw new Error('the page should not be asked'); };
  assert.equal(await views.highlightSelection('a', contents), false);
  assert.deepEqual([saved, listed], [[], []]);
});

/* ------------------------------------------------------------------------------------------------ the storage */

async function libraryContext(rows = []) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-webmarks-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-webmarks-home-'));
  return { dataRoot, homeDir, libraryDb: { list: async () => rows, get: async (id) => rows.find((row) => row.id === id) || null } };
}
const mark = (id, exact) => ({ id, quote: { exact, prefix: '', suffix: '' }, note: null, at: '2026-10-06T00:00:00.000Z' });

test('addWebMark: beside the pdf pages, by the normalized address; on a saved page\'s row; never a preview', async () => {
  const ctx = await libraryContext();
  assert.equal(await library.addWebMark(ctx, 'https://www.example.com/post/?utm_source=feed#top', mark('w1', 'one')), true);
  assert.equal(await library.addWebMark(ctx, 'http://example.com/post', mark('w2', 'two')), true);
  assert.equal(await library.addWebMark(ctx, 'http://example.com/post', mark('w2', 'two again')), false); // once
  const ink = await library.readPageAnnotations(ctx, 'https://example.com/post');
  assert.deepEqual(ink.web.map((m) => m.id), ['w1', 'w2']);
  // pdf pages already there are kept
  await library.writePageAnnotations(ctx, 'https://example.com/paper', { 1: [{ id: 'p1', rects: [] }] });
  await library.addWebMark(ctx, 'https://example.com/paper', mark('w3', 'three'));
  const both = await library.readPageAnnotations(ctx, 'https://example.com/paper');
  assert.deepEqual(Object.keys(both).sort(), ['1', 'web']);

  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:3000/a', 'https://8080-xyz.e2b.app/']) {
    assert.equal(await library.addWebMark(ctx, url, mark('w9', 'nine')), false, url);
  }
  assert.equal(await library.addWebMark(ctx, 'file:///etc/hosts', mark('w9', 'nine')), false); // outside home: not placed

  // a saved page: the library's row keeps it, from its live address or its copy
  const rowId = '11111111-2222-4333-8444-555555555555';
  const copy = path.join(ctx.homeDir, 'index.html');
  fs.writeFileSync(copy, '<p>saved</p>');
  const saved = await libraryContext([{ id: rowId, type: 'html', path: fs.realpathSync(copy), url: 'https://blog.example.com/a' }]);
  saved.homeDir = ctx.homeDir;
  assert.equal(await library.addWebMark(saved, 'https://www.blog.example.com/a/', mark('s1', 'live')), true);
  assert.equal(await library.addWebMark(saved, `file://${fs.realpathSync(copy)}`, mark('s2', 'copy')), true);
  const rowInk = await library.readAnnotations(saved, rowId);
  assert.deepEqual(rowInk.web.map((m) => m.id), ['s1', 's2']);
});
