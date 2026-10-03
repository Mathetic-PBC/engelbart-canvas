'use strict';

// Several windows, one main process (2026-10-03, src/main/windows.cjs): each window's Stage tabs, post-its and terminal
// attachment are its own; a terminal's output goes to its window alone; what one window saves reaches the others.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const { createWindows, cleanPlace, placement } = require('../src/main/windows.cjs');
const { SessionManager } = require('../src/main/terminal/session-manager.cjs');
const { createBrowserViews } = require('../src/main/browser/views.cjs');
const { createPostItViews, createPostItPeers, CARD_URL } = require('../src/main/post-its/views.cjs');
const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const projects = require('../src/main/store/projects.cjs');

const APP_URL = 'engelbart://app/index.html';
const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ------------------------------------------------------------------ fakes */

function fakePty() {
  const made = [];
  return {
    made,
    spawn() {
      const handle = {
        pid: 1000 + made.length, paused: false, written: [], data: [], exits: [],
        onData(fn) { this.data.push(fn); return { dispose() {} }; },
        onExit(fn) { this.exits.push(fn); return { dispose() {} }; },
        write(text) { this.written.push(text); }, resize() {},
        kill() { for (const fn of this.exits) fn({ exitCode: 0 }); },
        pause() { this.paused = true; }, resume() { this.paused = false; },
        emit(text) { for (const fn of this.data) fn(text); },
      };
      made.push(handle);
      return handle;
    },
  };
}

function fakeContents(url) {
  const contents = new EventEmitter();
  Object.assign(contents, {
    url, closed: false, sent: [], focused: false,
    mainFrame: { url },
    loadURL(next) { this.url = next; this.mainFrame.url = next; return Promise.resolve(); }, getURL() { return this.url; }, getTitle: () => 'Title',
    isLoading: () => false, isDestroyed() { return this.closed; }, close() { this.closed = true; this.emit('destroyed'); },
    isFocused() { return this.focused; }, focus() { this.focused = true; }, reload() {}, stop() {},
    setWindowOpenHandler(handler) { this.windowOpen = handler; }, setZoomFactor() {}, getZoomFactor: () => 1,
    executeJavaScript: async () => null, capturePage: async () => ({ isEmpty: () => true }),
    send(channel, payload) { this.sent.push([channel, payload]); },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
  });
  return contents;
}

function fakeElectron() {
  class WebContentsView {
    constructor(options = {}) {
      this.webContents = options.webContents || fakeContents('');
      this.visible = true;
      this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    }
    setBackgroundColor() {}
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible; }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
  }
  const browsing = {
    cookies: { on() {}, flushStore: async () => {} }, getUserAgent: () => 'UA', setUserAgent() {},
    setPermissionRequestHandler(handler) { this.permission = handler; },
    webRequest: { onHeadersReceived(_filter, handler) { browsing.headers = handler; } },
    on(name, handler) { browsing[name] = handler; },
  };
  const dialog = { showMessageBox: async () => ({ response: 1 }) };
  return { browsing, electron: { WebContentsView, session: { fromPartition: () => browsing }, Menu: {}, clipboard: { writeText() {} }, dialog, shell: { openExternal: async () => {} } } };
}

let nextWebContentsId = 1;
function fakeWindow() {
  const children = [];
  const contents = fakeContents(APP_URL);
  contents.id = nextWebContentsId++;
  const win = {
    destroyed: false, focused: false, bounds: { x: 10, y: 20, width: 1200, height: 800 }, children,
    isDestroyed() { return this.destroyed; }, isFocused() { return this.focused; },
    getBounds() { return this.bounds; }, getNormalBounds() { return this.bounds; }, getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    webContents: contents,
    contentView: {
      children,
      addChildView(view) { const at = children.indexOf(view); if (at >= 0) children.splice(at, 1); children.push(view); },
      removeChildView(view) { const at = children.indexOf(view); if (at >= 0) children.splice(at, 1); },
    },
  };
  return win;
}
const appEvent = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
const cardEvent = (view) => ({ sender: view.webContents, senderFrame: view.webContents.mainFrame });
const sentOn = (win, channel) => win.webContents.sent.filter(([name]) => name === channel).map(([, payload]) => payload);

/** The app's main process as index.cjs builds it, for two windows on one project with one post-it. */
async function twoWindows(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-windows-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  const ctx = await store.context();
  const project = await projects.createProject(ctx, { name: 'Windows' });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Both' });
  const fake = fakeElectron();
  const pty = fakePty();
  const peers = createPostItPeers();
  let windows = null;
  const manager = new SessionManager({ pty, environment: { SHELL: '/bin/zsh', HOME: homeDir, PATH: '/usr/bin:/bin' }, batchDelayMs: 0, maxUnackedBytes: 8, resumeUnackedBytes: 4, attached: (id) => windows.attached(id) });
  windows = createWindows({
    appUrl: APP_URL,
    manager,
    makeViews: (each) => {
      const send = (channel, payload) => windows.deliver(each, channel, payload);
      const postItViews = createPostItViews({ electron: fake.electron, getWindow: () => each.win, getContext: () => store.context(), send, peers });
      const browserViews = createBrowserViews({ electron: fake.electron, getWindow: () => each.win, send, appName: 'Engelbart', onLayerChange: () => postItViews.raise() });
      return { browserViews, postItViews };
    },
  });
  t.after(async () => {
    for (const each of windows.all()) await each.postItViews.activate(null).catch(() => {});
    await manager.shutdown().catch(() => {});
    await store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const place = { projectId: project.id, workspaceId: workspace.id };
  const a = windows.add(fakeWindow(), place);
  const b = windows.add(fakeWindow(), place);
  return { store, ctx, project, workspace, fake, pty, manager, windows, a, b };
}

/** The cards a window shows: its child views that are post-its. */
const cardsOf = (ctx) => ctx.win.children.filter((view) => view.webContents.url === CARD_URL);

/* ------------------------------------------------------------------ tests */

test('two windows keep their own Stage tabs, post-its and terminal: reloading or closing one leaves the other intact', async (t) => {
  const { a, b, windows, manager, pty, project } = await twoWindows(t);
  // A post-it on the project, shown in both windows.
  await a.postItViews.activate(project.id);
  await b.postItViews.activate(project.id);
  const card = await a.postItViews.create(project.id);
  await tick(10);
  assert.equal(cardsOf(a).length, 1);
  assert.equal(cardsOf(b).length, 1, 'the other window on the project shows the new card too');
  // Each window opens a Stage tab of its own and its terminal attaches, with a session of its own.
  a.browserViews.open('tab-a', 'https://example.com/a');
  b.browserViews.open('tab-b', 'https://example.com/b');
  assert.equal(a.browserViews.has('tab-b'), false, 'a tab is its window\'s alone');
  windows.bootstrap(a);
  windows.bootstrap(b);
  const sessionA = manager.create({ provider: 'shell', cwd: os.tmpdir(), cols: 80, rows: 24 });
  windows.own(sessionA.id, a);
  const sessionB = manager.create({ provider: 'shell', cwd: os.tmpdir(), cols: 80, rows: 24 });
  windows.own(sessionB.id, b);
  manager.on('data', (payload) => windows.terminalData(payload));

  // A reloads: its tab, its cards and its terminal attachment go; B's stay.
  windows.reset(a);
  await tick(10);
  assert.equal(a.browserViews.has('tab-a'), false);
  assert.equal(b.browserViews.has('tab-b'), true, 'the other window keeps its Stage tab');
  assert.equal(cardsOf(a).length, 0);
  assert.equal(cardsOf(b).length, 1, 'the other window keeps its post-it');
  assert.equal(a.lifecycle.ready, false);
  assert.equal(b.lifecycle.ready, true, 'the other window\'s terminal stays attached');
  pty.made[1].emit('to b');
  await tick(5);
  assert.deepEqual(sentOn(b.win, 'terminal:data').map((p) => p.data), ['to b']);
  pty.made[0].emit('to a while it reloads');
  await tick(5);
  assert.equal(sentOn(a.win, 'terminal:data').length, 0, 'nothing reaches a window whose terminal has not attached again');

  // A comes back; then B closes. A's tab, card and terminal are untouched; B's session keeps running, held by no window.
  windows.bootstrap(a);
  await a.postItViews.activate(project.id);
  a.browserViews.open('tab-a2', 'https://example.com/a2');
  b.win.destroyed = true;
  windows.remove(b);
  await tick(10);
  assert.equal(windows.count(), 1);
  assert.equal(a.browserViews.has('tab-a2'), true);
  assert.equal(cardsOf(a).length, 1);
  assert.equal(a.lifecycle.ready, true);
  assert.equal(windows.ownerOf(sessionB.id), null);
  assert.ok(manager.get(sessionB.id), 'a closed window\'s terminal session keeps running');
  pty.made[0].emit('to a again');
  await tick(5);
  assert.deepEqual(sentOn(a.win, 'terminal:data').map((p) => p.data), ['to a again']);
  // The next window whose terminal attaches takes the session no window holds; every session is listed to it.
  const c = windows.add(fakeWindow(), null);
  const listed = windows.bootstrap(c);
  assert.deepEqual(listed.map((s) => s.id).sort(), [sessionA.id, sessionB.id].sort());
  assert.equal(windows.ownerOf(sessionB.id), c);
  assert.equal(windows.ownerOf(sessionA.id), a, 'a session its window still holds stays there');
  assert.ok(card);
});

test('a terminal\'s output reaches only its window; announcements reach every window', async (t) => {
  const { a, b, windows, manager, pty } = await twoWindows(t);
  manager.on('data', (payload) => windows.terminalData(payload));
  windows.bootstrap(a);
  windows.bootstrap(b);
  const session = manager.create({ provider: 'shell', cwd: os.tmpdir(), cols: 80, rows: 24 });
  windows.own(session.id, a);
  pty.made[0].emit('hello');
  await tick(5);
  assert.deepEqual(sentOn(a.win, 'terminal:data').map((p) => p.data), ['hello']);
  assert.deepEqual(sentOn(b.win, 'terminal:data'), [], 'another window never gets it');

  // Flow control follows the window that holds the session: unacknowledged output pauses it only while that window is
  // attached; detaching that window (a reload) lets it run again.
  pty.made[0].emit('more than eight bytes');
  await tick(5);
  assert.equal(pty.made[0].paused, true);
  windows.reset(b);
  assert.equal(pty.made[0].paused, true, 'another window reloading leaves this session\'s flow control alone');
  windows.reset(a);
  assert.equal(pty.made[0].paused, false);

  // Shown in another window (a Build's terminal opened from B): its output follows, and A is told to let it go.
  windows.bootstrap(a);
  windows.bootstrap(b);
  const left = windows.own(session.id, b);
  assert.equal(left, a);
  pty.made[0].emit('now b');
  await tick(5);
  assert.deepEqual(sentOn(b.win, 'terminal:data').map((p) => p.data), ['now b']);
  assert.equal(sentOn(a.win, 'terminal:data').some((p) => p.data === 'now b'), false);

  // Broadcasts: to both, gated ones to the windows whose terminal has attached, and never to the window left out.
  assert.equal(windows.broadcast('engelbart:library-changed', {}), true);
  assert.equal(sentOn(a.win, 'engelbart:library-changed').length, 1);
  assert.equal(sentOn(b.win, 'engelbart:library-changed').length, 1);
  windows.reset(a);
  windows.broadcast('engelbart:build', { id: 'x' }, { gated: true });
  assert.equal(sentOn(a.win, 'engelbart:build').length, 0);
  assert.equal(sentOn(b.win, 'engelbart:build').length, 1);
  windows.broadcast('doc:changed', { key: 'ws:1' }, { except: b });
  assert.equal(sentOn(a.win, 'doc:changed').length, 1);
  assert.equal(sentOn(b.win, 'doc:changed').length, 0);
});

test('a window handler knows which window called, and refuses a page that is not the app', async (t) => {
  const { a, b, windows } = await twoWindows(t);
  const seen = [];
  const handler = windows.handler((ctx, value) => { seen.push([ctx, value, windows.asking()]); return value * 2; });
  assert.equal(await handler(appEvent(b.win), 21), 42);
  assert.deepEqual(seen, [[b, 21, b]]);
  await handler(appEvent(a.win), 1);
  assert.equal(seen[1][0], a);
  assert.equal(windows.asking(), null, 'only while the handler runs');
  const page = fakeContents('https://evil.example/');
  await assert.rejects(handler({ sender: page, senderFrame: page.mainFrame }, 1), /untrusted renderer/);
  // The focused window, else the one focused last.
  b.win.focused = true;
  assert.equal(windows.focused(), b);
  b.win.focused = false;
  windows.touch(a);
  assert.equal(windows.focused(), a);
});

test('a card saved in one window shows its new text, place and trash in every other window on the project', async (t) => {
  const { a, b, project, ctx, windows } = await twoWindows(t);
  windows.bootstrap(a); // a window hears its post-its once its terminal has attached, as the one window always did
  windows.bootstrap(b);
  await a.postItViews.activate(project.id);
  await b.postItViews.activate(project.id);
  const id = await a.postItViews.create(project.id);
  await tick(10);
  const [viewA] = cardsOf(a);
  const [viewB] = cardsOf(b);
  await b.postItViews.card(cardEvent(viewB)).ready();
  // Typed in A: B's card gets the text (and so would save it, not its old text, at quit).
  await a.postItViews.card(cardEvent(viewA)).edit('from window A');
  await tick(10);
  assert.deepEqual(viewB.webContents.sent.filter(([name]) => name === 'post-it:text'), [['post-it:text', 'from window A']]);
  // B moves it; A's row follows, so A never writes the old place back with its next save.
  b.postItViews.card(cardEvent(viewB)).gesture({ phase: 'begin', kind: 'drag', x: 400, y: 300 });
  b.postItViews.card(cardEvent(viewB)).gesture({ phase: 'move', kind: 'drag', x: 700, y: 500 });
  b.postItViews.card(cardEvent(viewB)).gesture({ phase: 'end', kind: 'drag', x: 700, y: 500 });
  await tick(20);
  assert.deepEqual(viewA.bounds, viewB.bounds, 'the card stands where it was put in both windows');
  await a.postItViews.card(cardEvent(viewA)).edit('again from A');
  await tick(10);
  const { openNotesDb } = require('../src/main/store/db.cjs');
  const [row] = await (await openNotesDb(projects.findProject(ctx, project.id).dir)).postIts.list();
  assert.equal(row.text, 'again from A');
  assert.notEqual(row.nx, 0.22, 'B\'s move was kept by A\'s later save');
  // Thrown away in B: gone from A, and A's trash counts it.
  await b.postItViews.requests.throwOut(project.id, id);
  await tick(10);
  assert.equal(cardsOf(a).length, 0);
  assert.ok(sentOn(a.win, 'post-its:trash').some((state) => state.count === 1));
  // Back out of the trash in A: back in B.
  await a.postItViews.requests.restore(project.id, id);
  await tick(10);
  assert.equal(cardsOf(b).length, 1);
});

test('a document saved in one window is announced to the others with its revision; an unchanged one to none', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-doc-changed-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(async () => { await store.close(); fs.rmSync(homeDir, { recursive: true, force: true }); });
  const ctx = await store.context();
  const project = await projects.createProject(ctx, { name: 'Docs' });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Shared' });
  const handlers = new Map();
  const told = [];
  const windowA = { name: 'A' }, windowB = { name: 'B' };
  let caller = null;
  registerEngelbartIpc({
    store,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    trustedHandler: (fn) => fn,
    windowHandler: (fn) => (...args) => fn(caller, ...args),
    announce: (channel, payload, { except } = {}) => told.push({ channel, payload, except }),
    notify: () => {},
  });
  const write = (win, text) => { caller = win; return handlers.get('engelbart:write-doc')(project.id, { kind: 'workspace', workspaceId: workspace.id }, text); };
  const first = await write(windowA, 'one');
  assert.equal(first.revision, 1);
  assert.deepEqual(told.filter((e) => e.channel === 'doc:changed'), [{ channel: 'doc:changed', payload: { projectId: project.id, key: `ws:${workspace.id}`, text: 'one', revision: 1 }, except: windowA }]);
  const same = await write(windowB, 'one');
  assert.equal(same.revision, 1, 'a save that changes nothing answers with the revision it is at');
  assert.equal(told.filter((e) => e.channel === 'doc:changed').length, 1, 'and is announced to no one');
  // Two windows saving at once are taken one at a time, in the order they came: the revisions say which is on disk.
  const [x, y] = await Promise.all([write(windowA, 'from A'), write(windowB, 'from B')]);
  assert.deepEqual([x.revision, y.revision], [2, 3]);
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }), 'from B');
  // Clear rewrites it in its turn and is announced the same way, with the project's tree.
  caller = windowB;
  const cleared = await handlers.get('engelbart:clear-workspace')(project.id, workspace.id);
  assert.equal(cleared.text, '');
  assert.equal(cleared.revision, 4);
  assert.deepEqual(told.at(-2), { channel: 'doc:changed', payload: { projectId: project.id, key: `ws:${workspace.id}`, text: '', revision: 4 }, except: windowB });
  assert.deepEqual(told.at(-1), { channel: 'engelbart:project-changed', payload: { projectId: project.id }, except: windowB });
  // A workspace made in one window: the others read the project's tree again.
  caller = windowA;
  await handlers.get('engelbart:create-workspace')(project.id, { name: 'Another' });
  assert.deepEqual(told.at(-1), { channel: 'engelbart:project-changed', payload: { projectId: project.id }, except: windowA });
});

test('doc:changed: a window without edits takes the new text; one with edits keeps them and asks; older news is ignored', async () => {
  const { createDocSync } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc-sync.js')).href);
  // A window as Workspace.jsx keeps it: its documents' text, its edits not yet saved, the notice when it must ask.
  function windowState() {
    const state = { docs: { 'ws:1': 'start' }, edits: new Set(), asked: null };
    state.sync = createDocSync({ hasEdits: (key) => state.edits.has(key), take: (key, text) => { state.docs[key] = text; }, conflict: (key, change) => { state.asked = { key, ...change }; } });
    return state;
  }
  const quiet = windowState();
  assert.equal(quiet.sync.announced('ws:1', { text: 'theirs', revision: 1 }), 'take');
  assert.equal(quiet.docs['ws:1'], 'theirs');
  assert.equal(quiet.sync.announced('ws:1', { text: 'older', revision: 1 }), 'ignore');
  assert.equal(quiet.docs['ws:1'], 'theirs');

  const busy = windowState();
  busy.docs['ws:1'] = 'start + my words';
  busy.edits.add('ws:1');
  assert.equal(busy.sync.announced('ws:1', { text: 'theirs', revision: 1 }), 'conflict');
  assert.equal(busy.docs['ws:1'], 'start + my words', 'its edits are not replaced');
  assert.deepEqual(busy.asked, { key: 'ws:1', text: 'theirs', revision: 1 });

  // Its own save on the way when news arrives: decided when the save answers. Saved after theirs (revision 3 > 2): its
  // text is on disk, theirs is dropped. Saved before (1 < 2): theirs is the newer, and taken.
  const after = windowState();
  after.sync.saving('ws:1');
  assert.equal(after.sync.announced('ws:1', { text: 'theirs', revision: 2 }), 'wait');
  assert.equal(after.sync.saved('ws:1', 3), 'ignore');
  assert.equal(after.docs['ws:1'], 'start');
  const before = windowState();
  before.sync.saving('ws:1');
  before.sync.announced('ws:1', { text: 'theirs', revision: 2 });
  assert.equal(before.sync.saved('ws:1', 1), 'take');
  assert.equal(before.docs['ws:1'], 'theirs');
});

test('windows are kept in state.json and come back on a screen, at least their minimum size', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-windows-state-'));
  try {
    const ctx = { dataRoot };
    const project = '11111111-2222-4333-8444-555555555555', workspace = '66666666-7777-4888-8999-000000000000';
    projects.writeLastOpen(ctx, { projectId: project, workspaceId: workspace });
    assert.deepEqual(projects.readWindows(ctx), [], 'a state.json from before has none: one window opens where projectId says');
    const saved = projects.writeWindows(ctx, [
      { projectId: project, workspaceId: workspace, bounds: { x: 10.4, y: 20, width: 1200, height: 800 } },
      { projectId: null, workspaceId: workspace, bounds: { x: 0, y: 0, width: 'wide', height: 800 } },
      'nonsense',
    ]);
    assert.deepEqual(saved, [
      { projectId: project, workspaceId: workspace, bounds: { x: 10, y: 20, width: 1200, height: 800 } },
      { projectId: null, workspaceId: null, bounds: null },
    ]);
    assert.deepEqual(projects.readWindows(ctx), saved);
    assert.deepEqual(projects.readLastOpen(ctx), { projectId: project, workspaceId: workspace }, 'the rest of state.json is kept');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  const screen = [{ x: 0, y: 0, width: 1440, height: 900 }];
  assert.deepEqual(placement({ bounds: { x: 100, y: 50, width: 1000, height: 700 }, workAreas: screen }), { x: 100, y: 50, width: 1000, height: 700 });
  assert.deepEqual(placement({ bounds: { x: 4000, y: 50, width: 1000, height: 700 }, workAreas: screen }), { width: 1000, height: 700 }, 'off every screen (a display unplugged): centred');
  assert.deepEqual(placement({ bounds: { x: 0, y: 0, width: 300, height: 200 }, workAreas: screen }), { x: 0, y: 0, width: 900, height: 560 });
  assert.deepEqual(placement({ from: { x: 40, y: 40, width: 1200, height: 800 }, workAreas: screen }), { x: 64, y: 64, width: 1200, height: 800 }, 'a step from the window it was opened from');
  assert.deepEqual(placement({ workAreas: screen }), { width: 1440, height: 900 });
  assert.deepEqual(cleanPlace({ projectId: 'not an id', workspaceId: 'x' }), { projectId: null, workspaceId: null });
});

test('a window says where it is; what is saved of the windows leaves out one that has not said yet', async (t) => {
  const { a, b, windows, project, workspace } = await twoWindows(t);
  const c = windows.add(fakeWindow(), null);
  assert.equal(windows.target(c), null, 'a window opened without a place: where the app was last');
  windows.navigated(b, { projectId: null });
  assert.deepEqual(windows.target(b), { home: true });
  assert.deepEqual(windows.target(a), { projectId: project.id, workspaceId: workspace.id });
  windows.touch(a);
  assert.deepEqual(windows.places().map((p) => p.projectId), [null, project.id], 'the window focused last at the end');
  assert.deepEqual(windows.places()[1].bounds, { x: 10, y: 20, width: 1200, height: 800 });
  assert.equal(windows.showing(project.id), a);
});

test('a sandbox notification cleared or read in one window is cleared or read in the others, never shown again by them', async () => {
  const { sandboxProgressReducer, sandboxProgressState } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/sandbox-notifications.js')).href);
  const run = { id: 'run-1', library_id: 'repo-1', status: 'ready', created_at: '2026-10-03T10:00:00.000Z', updated_at: '2026-10-03T10:05:00.000Z', preview_url: 'https://x.e2b.app', build_log: [{ message: 'Preview ready', time: '2026-10-03T10:05:00.000Z' }] };
  const progress = (state) => sandboxProgressReducer(state, { type: 'progress', event: { dataRoot: '/d', run, message: 'Preview ready' } });
  // Both windows hear the same progress, so each bell has the same one notification.
  let a = progress(sandboxProgressState('/d'));
  let b = progress(sandboxProgressState('/d'));
  assert.equal(a.notifications.length, 1);
  assert.deepEqual(a.notifications, b.notifications);
  // Read in A: B's reads as read once A's saved state arrives.
  a = sandboxProgressReducer(a, { type: 'read', ids: [a.notifications[0].id] });
  b = sandboxProgressReducer(b, { type: 'sync', saved: { notifications: a.notifications, dismissed: a.dismissed } });
  assert.equal(b.notifications[0].read, true);
  // Cleared in A: gone from B, and B's next progress for that run does not bring it back.
  a = sandboxProgressReducer(a, { type: 'clear', ids: [a.notifications[0].id] });
  b = sandboxProgressReducer(b, { type: 'sync', saved: { notifications: a.notifications, dismissed: a.dismissed } });
  assert.deepEqual(b.notifications, []);
  assert.deepEqual(progress(b).notifications, []);
  // Nothing new in what arrives: the same state back, so the windows do not write to each other forever.
  assert.equal(sandboxProgressReducer(b, { type: 'sync', saved: { notifications: a.notifications, dismissed: a.dismissed } }), b);
});

test('the one browsing session asks about a page in the window that shows it, and turns any window\'s pdf into a download', async () => {
  const fake = fakeElectron();
  const asked = [];
  fake.electron.dialog = { showMessageBox: async (win, options) => { asked.push([win, options.message]); return { response: 0 }; } };
  const winA = fakeWindow(), winB = fakeWindow();
  const viewsA = createBrowserViews({ electron: fake.electron, getWindow: () => winA, send() {}, appName: 'Engelbart' });
  const viewsB = createBrowserViews({ electron: fake.electron, getWindow: () => winB, send() {}, appName: 'Engelbart' });
  viewsA.open('a', 'https://a.example/');
  viewsB.open('b', 'https://b.example/');
  const tabB = winB.children[0].webContents;
  const allowed = await new Promise((resolve) => { fake.browsing.permission(tabB, 'media', resolve, { requestingUrl: 'https://b.example/' }); });
  assert.equal(allowed, true);
  assert.deepEqual(asked, [[winB, 'Allow https://b.example to use the camera or microphone?']], 'asked over the window whose page wants it, though A set the session up');
  const headers = await new Promise((resolve) => fake.browsing.headers({ resourceType: 'mainFrame', webContents: tabB, responseHeaders: { 'content-type': ['application/pdf'] } }, resolve));
  assert.match(headers.responseHeaders['Content-Disposition'][0], /^attachment/);
  // A closed window's views leave the session: nothing of its own is asked about any more.
  viewsB.dispose();
  const none = await new Promise((resolve) => fake.browsing.headers({ resourceType: 'mainFrame', webContents: tabB, responseHeaders: { 'content-type': ['application/pdf'] } }, resolve));
  assert.deepEqual(none, {});
});

test('a closed window\'s cards still save their last words while they are let go', async (t) => {
  const { b, windows, project, ctx } = await twoWindows(t);
  windows.bootstrap(b);
  await b.postItViews.activate(project.id);
  await b.postItViews.create(project.id);
  const [view] = cardsOf(b);
  await b.postItViews.card(cardEvent(view)).ready();
  // Letting the cards go flushes each (preload's postItAPI.flush): its edit comes back on the card's own IPC.
  let flushed = null;
  view.webContents.executeJavaScript = async () => {
    const holder = windows.cardsHolding(view.webContents);
    flushed = holder ? holder.card(cardEvent(view)).edit('last words') : Promise.reject(new Error('IPC rejected: unknown sticky'));
    return flushed;
  };
  b.win.destroyed = true;
  windows.remove(b);
  await tick(20);
  await flushed;
  const { openNotesDb } = require('../src/main/store/db.cjs');
  const [row] = await (await openNotesDb(projects.findProject(ctx, project.id).dir)).postIts.list();
  assert.equal(row.text, 'last words');
  assert.equal(windows.cardsHolding(view.webContents), null, 'and once they are gone, no window holds the card');
});
