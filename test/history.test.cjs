'use strict';

// The Stage's history (MATH-127): every page a tab arrives at, in <project>/.context/history.json
// (src/main/store/history.cjs), as the tabs and popups report it (src/main/browser/views.cjs, `browser:visit`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const history = require('../src/main/store/history.cjs');
const { writeCatalogs } = require('../src/main/context/catalog.cjs');
const { createSweeper } = require('../src/main/context/sweeper.cjs');
const { createBrowserViews } = require('../src/main/browser/views.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-history-'));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => { await db.closeAll(); });

const fileOf = (project) => path.join(project.dir, '.context', 'history.json');
const read = (project) => JSON.parse(fs.readFileSync(fileOf(project), 'utf8'));
const silent = () => {};
// A clock the test moves: `clock.at` milliseconds.
function clock(start = Date.parse('2026-10-25T12:00:00Z')) {
  const c = { at: start, now: () => new Date(c.at), log: silent };
  return c;
}
const fresh = async (name) => { history.forget(); return projects.createProject(ctx, name); };

test('a visit is written with url, title, time and tab, newest last', async () => {
  const project = await fresh('History one');
  const c = clock();
  await history.record(ctx, project.id, { id: 'tab-1', url: 'https://example.com/', title: 'Example' }, c);
  c.at += 1000;
  await history.record(ctx, project.id, { id: 'tab-1', url: 'https://example.com/b', title: 'B' }, c);
  assert.deepEqual(read(project), { version: 1, entries: [
    { url: 'https://example.com/', title: 'Example', time: '2026-10-25T12:00:00.000Z', tab: 'tab-1' },
    { url: 'https://example.com/b', title: 'B', time: '2026-10-25T12:00:01.000Z', tab: 'tab-1' },
  ] });
});

test('a title that comes later goes into the newest entry for that tab and address, its time unchanged; with none it is dropped', async () => {
  const project = await fresh('History titles');
  const c = clock();
  await history.record(ctx, project.id, { id: 't', url: 'https://a.example/', title: '' }, c);
  c.at += 60_000;
  await history.record(ctx, project.id, { id: 't', url: 'https://b.example/', title: 'B' }, c);
  c.at += 60_000;
  await history.record(ctx, project.id, { id: 't', url: 'https://a.example/', title: 'A again' }, c);
  c.at += 2000;
  await history.record(ctx, project.id, { id: 't', url: 'https://a.example/', title: 'A, titled', update: true }, c);
  const entries = read(project).entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.title), ['', 'B', 'A, titled'], 'only the newest matching entry');
  assert.equal(entries[2].time, '2026-10-25T12:02:00.000Z');

  const before = fs.readFileSync(fileOf(project), 'utf8');
  await history.record(ctx, project.id, { id: 't', url: 'https://nowhere.example/', title: 'X', update: true }, c);
  await history.record(ctx, project.id, { id: 'other', url: 'https://a.example/', title: 'X', update: true }, c);
  assert.equal(fs.readFileSync(fileOf(project), 'utf8'), before, 'no entry for that tab and address: nothing changes');

  // An update does not start the 5 seconds again: a reload 6 s after the arrival is kept though the title came at 2 s.
  c.at += 4000;
  await history.record(ctx, project.id, { id: 't', url: 'https://a.example/', title: 'A, titled' }, c);
  assert.equal(read(project).entries.length, 4);
});

test('a reload within 5 seconds in the same tab is not kept; after 5 seconds, elsewhere, or in another tab it is', async () => {
  const project = await fresh('History reloads');
  const c = clock();
  const visit = (id, url) => history.record(ctx, project.id, { id, url, title: 'T' }, c);
  await visit('a', 'https://example.com/');
  c.at += 3000; await visit('a', 'https://example.com/'); // a reload
  c.at += 1500; await visit('a', 'https://example.com/'); // still within 5 s of the entry
  assert.equal(read(project).entries.length, 1);
  c.at += 1000; await visit('a', 'https://example.com/'); // 5.5 s after the entry
  assert.equal(read(project).entries.length, 2);
  c.at += 100; await visit('a', 'https://example.com/other');
  c.at += 100; await visit('b', 'https://example.com/other');
  c.at += 100; await visit('a', 'https://example.com/'); // back, but the tab's last entry is /other
  assert.deepEqual(read(project).entries.map((e) => [e.tab, e.url]), [
    ['a', 'https://example.com/'], ['a', 'https://example.com/'], ['a', 'https://example.com/other'], ['b', 'https://example.com/other'], ['a', 'https://example.com/'],
  ]);
});

test('the newest 5,000 are kept: the 5,001st drops the oldest; addresses and titles are bounded', async () => {
  const project = await fresh('History cap');
  fs.mkdirSync(path.dirname(fileOf(project)), { recursive: true });
  const entries = Array.from({ length: history.MAX_ENTRIES }, (_, n) => ({ url: `https://example.com/${n}`, title: `${n}`, time: '2026-10-25T00:00:00.000Z', tab: 't' }));
  fs.writeFileSync(fileOf(project), JSON.stringify({ version: 1, entries }));
  await history.record(ctx, project.id, { id: 't', url: `https://example.com/${'x'.repeat(3000)}`, title: 'y'.repeat(500) }, clock());
  const kept = read(project).entries;
  assert.equal(kept.length, 5000);
  assert.equal(kept[0].url, 'https://example.com/1');
  assert.equal(kept.at(-1).url.length, 2048);
  assert.equal(kept.at(-1).title.length, 200);
});

test('a corrupt file starts a fresh list; two writes at once both land', async () => {
  const project = await fresh('History corrupt');
  fs.mkdirSync(path.dirname(fileOf(project)), { recursive: true });
  fs.writeFileSync(fileOf(project), '{ "version": 1, "entries": [ {');
  const c = clock();
  await history.record(ctx, project.id, { id: 't', url: 'https://one.example/', title: '1' }, c);
  assert.deepEqual(read(project).entries.map((e) => e.url), ['https://one.example/']);
  fs.writeFileSync(fileOf(project), '{"version":1,"entries":"no"}');
  await Promise.all([
    history.record(ctx, project.id, { id: 't', url: 'https://two.example/', title: '2' }, c),
    history.record(ctx, project.id, { id: 'u', url: 'https://three.example/', title: '3' }, c),
  ]);
  assert.deepEqual(read(project).entries.map((e) => e.url), ['https://two.example/', 'https://three.example/']);
});

test('a visit that cannot be kept never throws: an unknown project, a missing address, a folder that cannot be written', async () => {
  const project = await fresh('History failures');
  const logged = [];
  const c = { ...clock(), log: (...args) => logged.push(args.join(' ')) };
  await history.record(ctx, 'nope', { id: 't', url: 'https://example.com/' }, c);
  await history.record(ctx, project.id, null, c);
  await history.record(ctx, project.id, { id: 't' }, c);
  fs.mkdirSync(fileOf(project), { recursive: true }); // history.json is a folder: the rename fails
  await history.record(ctx, project.id, { id: 't', url: 'https://example.com/' }, c);
  assert.equal(logged.length, 2, 'the unknown project and the failed write are logged');
});

test('two projects used in turn: each visit goes to its own project\'s file', async () => {
  history.forget();
  const one = await projects.createProject(ctx, 'History A');
  const two = await projects.createProject(ctx, 'History B');
  const c = clock();
  const sent = [
    history.record(ctx, one.id, { id: 't', url: 'https://a.example/1', title: '' }, c),
    history.record(ctx, two.id, { id: 't', url: 'https://b.example/1', title: '' }, c),
    history.record(ctx, one.id, { id: 't', url: 'https://a.example/2', title: '' }, c),
    history.record(ctx, two.id, { id: 't', url: 'https://a.example/1', title: '' }, c), // the same tab id and address, but the other project
  ];
  await Promise.all(sent);
  assert.deepEqual(read(one).entries.map((e) => e.url), ['https://a.example/1', 'https://a.example/2']);
  assert.deepEqual(read(two).entries.map((e) => e.url), ['https://b.example/1', 'https://a.example/1']);
});

test('writeCatalogs and the sweeper leave history.json as it was, byte for byte', async () => {
  const project = await fresh('History kept');
  await projects.createNote(ctx, project.id, { name: 'A note', text: 'Some text' });
  await history.record(ctx, project.id, { id: 't', url: 'https://example.com/', title: 'Example' }, clock());
  const before = fs.readFileSync(fileOf(project));
  const written = await writeCatalogs(ctx);
  assert.ok(written.includes(path.join(project.dir, '.context', 'catalog.json')), 'the catalog was written beside it');
  assert.deepEqual(fs.readFileSync(fileOf(project)), before);
  const sweeper = createSweeper({ getContext: async () => ctx, summarize: async () => ({ summary: 'S', meta: {} }) });
  await sweeper.sweep();
  await sweeper.stop();
  assert.deepEqual(fs.readFileSync(fileOf(project)), before);
});

// The tabs and popups, through views.cjs: what they send is what the Stage forwards to record-visit.
function fakeViews() {
  const made = [];
  class WebContentsView {
    constructor(options) {
      const contents = options.webContents || new EventEmitter();
      Object.assign(contents, {
        url: '', title: '',
        loadURL(url) { this.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle() { return this.title; }, isLoading: () => false, isDestroyed: () => false,
        setWindowOpenHandler() {}, navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      });
      this.webContents = contents;
      made.push(this);
    }
    setBackgroundColor() {}
    setVisible() {}
    setBounds() {}
  }
  const browsing = { cookies: { on() {} }, setUserAgent() {}, getUserAgent: () => 'X', setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} }, on() {} };
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1 }, contentView: { addChildView() {}, removeChildView() {} } };
  const sent = [];
  const views = createBrowserViews({ electron: { WebContentsView, session: { fromPartition: () => browsing }, Menu: {}, clipboard: {}, dialog: {}, shell: {} }, getWindow: () => win, send: (channel, payload) => sent.push([channel, payload]), appName: 'Engelbart' });
  const visits = () => sent.filter(([channel]) => channel === 'browser:visit').map(([, payload]) => payload);
  return { views, made, visits };
}

test('views: a tab reports each arrival, a #section jump in the main frame, about: pages, and a title that comes later', async () => {
  const { views, made, visits } = fakeViews();
  views.open('tab-a', 'https://example.com/');
  const contents = made[0].webContents;
  contents.title = 'Example';
  contents.emit('did-navigate', {}, 'https://example.com/', 200, 'OK');
  contents.emit('did-navigate-in-page', {}, 'https://example.com/#methods', true);
  contents.emit('did-navigate-in-page', {}, 'https://frame.example/#x', false); // a subframe: not the tab's page
  contents.url = 'https://example.com/#methods';
  contents.title = 'Example — Methods';
  contents.emit('page-title-updated', {}, 'Example — Methods');
  contents.emit('did-navigate', {}, 'about:blank', 200, 'OK');
  assert.deepEqual(visits(), [
    { id: 'tab-a', url: 'https://example.com/', title: 'Example' },
    { id: 'tab-a', url: 'https://example.com/#methods', title: 'Example' },
    { id: 'tab-a', url: 'https://example.com/#methods', title: 'Example — Methods', update: true },
    { id: 'tab-a', url: 'about:blank', title: 'Example — Methods' },
  ]);

  const project = await fresh('History views');
  const c = clock();
  for (const visit of visits()) { await history.record(ctx, project.id, visit, c); c.at += 100; }
  assert.deepEqual(read(project).entries.map((e) => [e.url, e.title]), [
    ['https://example.com/', 'Example'], ['https://example.com/#methods', 'Example — Methods'], ['about:blank', 'Example — Methods'],
  ], 'the #section jump is an entry of its own, and about: is kept');
});

test('views: a popup\'s pages go under the tab that opened it; its window title is still its own', async () => {
  const { views, made, visits } = fakeViews();
  views.open('opener', 'https://app.example/');
  const popup = Object.assign(new EventEmitter(), { title: '', isDestroyed: () => false, setTitle(value) { this.title = value; } });
  const page = { url: 'https://accounts.example.com/signin', title: 'Sign in' };
  popup.webContents = Object.assign(new EventEmitter(), { getURL: () => page.url, getTitle: () => page.title, setWindowOpenHandler() {} });
  made[0].webContents.emit('did-create-window', popup);
  popup.webContents.emit('did-navigate', {}, page.url, 200, 'OK');
  page.url = 'https://accounts.example.com/signin#step2';
  popup.webContents.emit('did-navigate-in-page', {}, page.url, true);
  page.title = 'Choose an account';
  const titled = { prevented: false, preventDefault() { this.prevented = true; } };
  popup.webContents.emit('page-title-updated', titled, page.title);
  assert.equal(titled.prevented, true, 'the popup\'s window title is still set by hand');
  assert.equal(popup.title, 'accounts.example.com — Choose an account');
  assert.deepEqual(visits(), [
    { id: 'opener', url: 'https://accounts.example.com/signin', title: 'Sign in' },
    { id: 'opener', url: 'https://accounts.example.com/signin#step2', title: 'Sign in' },
    { id: 'opener', url: 'https://accounts.example.com/signin#step2', title: 'Choose an account', update: true },
  ], 'the page\'s own title, not the window\'s');

  const project = await fresh('History popups');
  const c = clock();
  await history.record(ctx, project.id, { id: 'opener', url: 'https://app.example/', title: 'App' }, c);
  for (const visit of visits()) { c.at += 100; await history.record(ctx, project.id, visit, c); }
  assert.deepEqual(read(project).entries.map((e) => [e.tab, e.url, e.title]), [
    ['opener', 'https://app.example/', 'App'],
    ['opener', 'https://accounts.example.com/signin', 'Sign in'],
    ['opener', 'https://accounts.example.com/signin#step2', 'Choose an account'],
  ]);
});
