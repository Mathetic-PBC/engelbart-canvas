'use strict';

// MATH-65, Overleaf part 1 (2026-10-07): @bart sees the Overleaf project open in the Stage. The open file is read live from
// a fake Overleaf page (a fake CodeMirror 6 view behind .cm-content, a file tree) by the script main runs in the page's
// main world (src/main/overleaf/editor.cjs); a page that does not answer within 500 ms falls back to the project's copy.
// The copy is a zip from a fake Overleaf on loopback (src/main/overleaf/copy.cjs): refreshed only when over 60 s old, one
// download at a time per project, a binary over 20 MB skipped. Then the <stage source="overleaf"> block and the turn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { READ_SCRIPT, READ_TIMEOUT_MS, overleafProjectId, projectTitle, editorInput, readEditor } = require('../src/main/overleaf/editor.cjs');
const { createOverleafCopies, readZip, safeName, isText, copyDir, MAX_AGE_MS, MAX_BINARY_BYTES } = require('../src/main/overleaf/copy.cjs');
const { createOverleafStage, overleafStageBlock, overleafTabsBlock, openFileXml, CURSOR } = require('../src/main/overleaf/stage.cjs');
const { createBrowserViews } = require('../src/main/browser/views.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');

const ID = '5f3c2a1b9d8e7f6a5b4c3d2e';
const OTHER = '65a1b2c3d4e5f60718293a4b';
const EDITOR_URL = `https://www.overleaf.com/project/${ID}`;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `overleaf-${name}-`));

/* ------------------------------------------------------------------------------------------- a fake Overleaf page */

/** CodeMirror 6's Text, as much of it as the script uses: length, lines, toString, sliceString, lineAt. */
function cmDoc(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return {
    length: text.length, lines: starts.length, toString: () => text, sliceString: (from, to = text.length) => text.slice(from, to),
    lineAt(pos) { let n = 0; while (n + 1 < starts.length && starts[n + 1] <= pos) n += 1; return { number: n + 1, from: starts[n] }; },
  };
}
/** An EditorView: its state (doc, selection.main) and dispatch, which a write would use and a read never calls. */
function cmView(text, { anchor = 0, head = anchor, focus = false } = {}) {
  const view = {
    state: { doc: cmDoc(text), selection: { main: { from: Math.min(anchor, head), to: Math.max(anchor, head), head } } },
    hasFocus: focus, dom: { offsetParent: {} }, dispatched: [],
    dispatch(spec) { this.dispatched.push(spec); },
  };
  return view;
}

/** A DOM node: attributes, classes, a parent, and the selectors the script uses (closest, querySelector). */
function node({ attrs = {}, cls = [], parent = null, text = '', props = {} } = {}) {
  const el = {
    parentElement: parent, textContent: text,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: () => null,
    closest(selector) {
      for (let at = el; at; at = at.parentElement) {
        if (selector === '.cm-editor' && at.cls.includes('cm-editor')) return at;
        if (selector === '[role="treeitem"]' && at.getAttribute('role') === 'treeitem') return at;
      }
      return null;
    },
    cls,
  };
  return Object.assign(el, props);
}

/**
 * The page: an editor whose .cm-content knows its view the way CodeMirror's does (`cmView.rootView.view`, or `cmTile` in
 * newer versions), a file tree with `file` (a/b/c.tex) selected, and the project's name in its meta tag.
 */
function overleafPage({ view, file = 'main.tex', projectName = 'My Paper', tile = false } = {}) {
  const editor = node({ cls: ['cm-editor'] });
  const content = node({ cls: ['cm-content'], parent: editor, props: view ? (tile ? { cmTile: { root: { view } } } : { cmView: { rootView: { view } } }) : {} });
  let selected = null;
  if (file) {
    const tree = node({ attrs: { role: 'tree' } });
    let parent = tree;
    for (const part of file.split('/')) parent = node({ attrs: { role: 'treeitem', 'aria-label': part }, parent: node({ attrs: { role: 'group' }, parent }) });
    selected = parent;
  }
  const meta = projectName ? node({ attrs: { name: 'ol-projectName', content: projectName } }) : null;
  const document = {
    title: `${projectName || 'Untitled'} - Overleaf, Online LaTeX Editor`,
    querySelectorAll: (selector) => (selector === '.cm-content' ? [content] : []),
    querySelector: (selector) => {
      if (selector === '[role="tree"] [role="treeitem"][aria-selected="true"]') return selected;
      if (selector === 'meta[name="ol-projectName"]') return meta;
      return null;
    },
  };
  return { document, run: (code) => vm.runInNewContext(code, { document }) };
}

const PAPER = '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nWe study tutors.\n\\input{sections/method}\n\\end{document}\n';
const TYPED = 'Tutors notice struggle before students ask.';
const LIVE = PAPER.replace('We study tutors.', `We study tutors. ${TYPED}`); // typed seconds ago: Overleaf's zip does not have it yet

test('overleafProjectId: an editor tab is overleaf.com/project/<24 hex>, nothing else', () => {
  assert.equal(overleafProjectId(EDITOR_URL), ID);
  assert.equal(overleafProjectId(`https://overleaf.com/project/${ID.toUpperCase()}/?a=1#x`), ID);
  for (const not of ['https://www.overleaf.com/project', `https://www.overleaf.com/project/${ID}/download/zip`, `http://www.overleaf.com/project/${ID}`,
    `https://evil.com/project/${ID}`, `https://www.overleaf.com.evil.com/project/${ID}`, 'https://www.overleaf.com/project/abc', 'not a url', null]) {
    assert.equal(overleafProjectId(not), '', String(not));
  }
  assert.equal(projectTitle('My Paper - Overleaf, Online LaTeX Editor'), 'My Paper');
});

test('the script reads the whole file from the CodeMirror view, not the DOM: text, selection, cursor line, file path, project', () => {
  const at = LIVE.indexOf(TYPED) + TYPED.length;
  for (const tile of [false, true]) {
    const page = overleafPage({ view: cmView(LIVE, { anchor: at }), file: 'chapters/intro.tex', tile });
    const read = editorInput(page.run(READ_SCRIPT));
    assert.equal(read.text, LIVE, 'all of it');
    assert.equal(read.head, at);
    assert.equal(read.cursorLine, 4);
    assert.equal(read.lines, 7);
    assert.equal(read.selection, '');
    assert.equal(read.file, 'chapters/intro.tex');
    assert.equal(read.projectName, 'My Paper');
  }
  // a selection over two lines
  const from = LIVE.indexOf('\\section'), to = LIVE.indexOf('tutors.') + 'tutors.'.length;
  const read = editorInput(overleafPage({ view: cmView(LIVE, { anchor: to, head: from }) }).run(READ_SCRIPT));
  assert.equal(read.selection, '\\section{Intro}\nWe study tutors.');
  assert.deepEqual([read.fromLine, read.toLine, read.cursorLine], [3, 4, 3]);
  // no editor (an image open): no text, but the file and project are still said
  const none = editorInput(overleafPage({ view: null, file: 'figs/plot.png' }).run(READ_SCRIPT));
  assert.deepEqual(none, { found: false, file: 'figs/plot.png', projectName: 'My Paper' });
  // the view is only read: nothing dispatched
  const view = cmView(LIVE);
  overleafPage({ view }).run(READ_SCRIPT);
  assert.deepEqual(view.dispatched, []);
});

test('editorInput refuses what does not add up, and a file path that leaves the project', () => {
  const good = editorInput(overleafPage({ view: cmView(PAPER, { anchor: 5 }) }).run(READ_SCRIPT));
  assert.ok(good);
  for (const bad of [null, 'x', [], { found: true }, { ...good, head: PAPER.length + 1 }, { ...good, text: 7 }, { ...good, cursorLine: 0 }, { ...good, from: 9, to: 2 }]) assert.equal(editorInput(bad), null);
  assert.equal(editorInput({ ...good, file: '../../etc/passwd' }).file, '');
  assert.equal(editorInput({ ...good, file: '/main.tex' }).file, 'main.tex');
});

/* -------------------------------------------------------------------------------- the tab (views.cjs), and its timeout */

function fakeElectron() {
  const made = [];
  let frames = 0;
  class WebContentsView {
    constructor(options) {
      const contents = options.webContents || new EventEmitter();
      Object.assign(contents, {
        ipc: { handle() {}, on() {} }, closed: false, url: '', title: 'Title', run: null,
        mainFrame: { frameTreeNodeId: (frames += 1) },
        loadURL(url) { this.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle() { return this.title; }, isLoading: () => false, isDestroyed() { return this.closed; },
        close() { this.closed = true; }, send() {}, insertCSS: () => Promise.resolve('key'), setWindowOpenHandler() {},
        executeJavaScript(code) { return this.run ? this.run(code) : Promise.reject(new Error('no page')); },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      });
      this.webContents = contents;
      this.visible = false;
      made.push(this);
    }
    setBackgroundColor() {}
    setVisible(on) { this.visible = on; }
    getVisible() { return this.visible; }
    setBounds() {}
  }
  const browsing = { cookies: { on() {}, flushStore: async () => {} }, setUserAgent() {}, getUserAgent: () => 'UA', setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} }, on() {}, registerPreloadScript() {} };
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1, focus() {} }, contentView: { addChildView() {}, removeChildView() {} } };
  return { made, win, electron: { WebContentsView, session: { fromPartition: () => browsing }, Menu: { buildFromTemplate: () => ({ popup() {} }) }, clipboard: {}, dialog: {}, shell: { openExternal: async () => {} } } };
}

test('views: Overleaf editor tabs are found, front and background, and the one asked is read in its main world', async () => {
  const fake = fakeElectron();
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: () => {}, appName: 'Engelbart' });
  views.open('o1', EDITOR_URL);
  views.open('o2', `https://www.overleaf.com/project/${OTHER}`);
  views.open('w', 'https://example.org/');
  views.open('dash', 'https://www.overleaf.com/project');
  const [o1, o2] = fake.made.map((v) => v.webContents);
  o1.title = 'My Paper - Overleaf, Online LaTeX Editor';
  o2.title = 'Thesis - Overleaf, Online LaTeX Editor';
  views.show('o1', { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(views.overleafTabs(), [
    { id: 'o1', projectId: ID, title: 'My Paper - Overleaf, Online LaTeX Editor', front: true },
    { id: 'o2', projectId: OTHER, title: 'Thesis - Overleaf, Online LaTeX Editor', front: false },
  ]);
  const page = overleafPage({ view: cmView(LIVE, { anchor: 10 }), file: 'main.tex' });
  const ran = [];
  o1.run = async (code) => { ran.push(code); return page.run(code); };
  const got = await views.readOverleaf('o1');
  assert.equal(got.ok, true);
  assert.equal(got.read.text, LIVE);
  assert.deepEqual(ran, [READ_SCRIPT], 'the script, run once');
  // not an Overleaf tab, or no tab
  assert.deepEqual(await views.readOverleaf('w'), { ok: false, why: 'error' });
  assert.deepEqual(await views.readOverleaf('nope'), { ok: false, why: 'error' });
  // a page that throws
  o1.run = async () => { throw new Error('boom'); };
  assert.deepEqual(await views.readOverleaf('o1'), { ok: false, why: 'error' });
});

test('a page that never answers is given up on after about 500 ms', async () => {
  assert.equal(READ_TIMEOUT_MS, 500);
  const started = Date.now();
  const got = await readEditor({ isDestroyed: () => false, executeJavaScript: () => new Promise(() => {}) });
  const took = Date.now() - started;
  assert.deepEqual(got, { ok: false, why: 'timeout' });
  assert.ok(took >= 480 && took < 1500, String(took));
});

/* ------------------------------------------------------------------------------------------------- the zip copy */

/** A zip of `entries` ([{ name, data }]), deflated, as Overleaf's download is. */
function zipOf(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name), raw = Buffer.from(data), body = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * A fake overleaf.com: GET /project/<id>/download/zip answers `zips[id]` (a Buffer, or a function giving one), after
 * `delayMs`; signed out, the sign-in page. `hits` counts downloads, `most` the most that ran at once.
 */
async function fakeOverleaf(t, zips) {
  const state = { hits: [], running: 0, most: 0, delayMs: 0, signedIn: true };
  const server = http.createServer((req, res) => {
    const m = /^\/project\/([0-9a-f]{24})\/download\/zip$/.exec(req.url);
    if (!m || !zips[m[1]]) { res.writeHead(404); res.end(); return; }
    state.hits.push(m[1]);
    state.running += 1;
    state.most = Math.max(state.most, state.running);
    setTimeout(() => {
      state.running -= 1;
      if (!state.signedIn) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Log in to Overleaf</title>'); return; }
      const body = typeof zips[m[1]] === 'function' ? zips[m[1]]() : zips[m[1]];
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
      res.end(body);
    }, state.delayMs);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, state };
}

const PROJECT_FILES = [
  { name: 'main.tex', data: PAPER },
  { name: 'sections/method.tex', data: '\\section{Method}\nWe watched 480 students.\n' },
  { name: 'refs.bib', data: '@article{chi2001, title={Learning from human tutoring}}\n' },
  { name: 'figs/plot.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
];

test('the copy: unpacked to <dataRoot>/.overleaf/<id>/, refreshed only when over 60 s old, never two downloads at once', async (t) => {
  assert.equal(MAX_AGE_MS, 60_000);
  const { base, state } = await fakeOverleaf(t, { [ID]: zipOf(PROJECT_FILES) });
  const root = tmp('copy');
  let clock = 1_000_000;
  const copies = createOverleafCopies({ fetch: globalThis.fetch, base, now: () => clock });
  state.delayMs = 150;
  // three turns at once: one download, all three get it
  const [a, b, c] = await Promise.all([copies.ensure(root, ID), copies.ensure(root, ID), copies.ensure(root, ID)]);
  assert.deepEqual(state.hits, [ID]);
  assert.equal(state.most, 1);
  for (const got of [a, b, c]) assert.equal(got.folder, path.join(root, '.overleaf', ID));
  assert.equal(a.fetchedAt, clock);
  assert.equal(fs.readFileSync(path.join(root, '.overleaf', ID, 'sections', 'method.tex'), 'utf8'), '\\section{Method}\nWe watched 480 students.\n');
  assert.deepEqual(fs.readFileSync(path.join(root, '.overleaf', ID, 'figs', 'plot.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.overleaf', `${ID}.json`), 'utf8')).files, 4);
  // under a minute later: the copy as it is, no download
  clock += 59_000;
  assert.equal((await copies.ensure(root, ID)).fetchedAt, 1_000_000);
  assert.equal(state.hits.length, 1);
  // past a minute: downloaded again; the turns that come while it runs wait on that one
  clock += 2_000;
  const again = await Promise.all([copies.ensure(root, ID), copies.ensure(root, ID)]);
  assert.equal(state.hits.length, 2);
  assert.equal(state.most, 1);
  assert.equal(again[0].fetchedAt, clock);
  assert.equal(copies.inFlight(root, ID), false);
  // a file deleted on Overleaf is gone from the next copy: the folder is swapped in whole, no leftovers beside it
  clock += 61_000;
  fs.writeFileSync(path.join(root, '.overleaf', ID, 'stray.tex'), 'x');
  await copies.ensure(root, ID);
  assert.ok(!fs.existsSync(path.join(root, '.overleaf', ID, 'stray.tex')));
  assert.deepEqual(fs.readdirSync(path.join(root, '.overleaf')).sort(), [ID, `${ID}.json`]);
});

test('signed out (Overleaf sends its sign-in page): the error is said, the old copy is kept', async (t) => {
  const { base, state } = await fakeOverleaf(t, { [ID]: zipOf(PROJECT_FILES) });
  const root = tmp('signed-out');
  let clock = 0;
  const copies = createOverleafCopies({ fetch: globalThis.fetch, base, now: () => clock });
  state.signedIn = false;
  const none = await copies.ensure(root, ID);
  assert.match(none.error, /signed in to overleaf\.com/);
  assert.equal(none.folder, undefined);
  state.signedIn = true;
  await copies.ensure(root, ID);
  clock += 120_000;
  state.signedIn = false;
  const kept = await copies.ensure(root, ID);
  assert.match(kept.error, /signed in/);
  assert.equal(kept.folder, copyDir(root, ID));
  assert.equal(kept.fetchedAt, 0, 'the copy it still has');
  assert.ok(fs.existsSync(path.join(root, '.overleaf', ID, 'main.tex')));
  // not a project id: no request
  const before = state.hits.length;
  assert.ok((await copies.ensure(root, '../../etc')).error);
  assert.equal(state.hits.length, before);
});

test('a binary file over 20 MB is skipped (before it is inflated); text files are kept; names that leave the copy are not written', async (t) => {
  assert.equal(MAX_BINARY_BYTES, 20 * 1024 * 1024);
  const big = Buffer.alloc(21 * 1024 * 1024); // deflates to almost nothing
  const zip = zipOf([...PROJECT_FILES, { name: 'video/talk.mp4', data: big }, { name: 'data/huge.csv', data: Buffer.alloc(21 * 1024 * 1024, 0x61) }, { name: '../escape.tex', data: 'no' }, { name: 'figs/', data: '' }]);
  const listed = readZip(zip);
  assert.deepEqual(listed.skipped, [{ path: 'video/talk.mp4', bytes: big.length, why: 'binary over the size limit' }]);
  assert.deepEqual(listed.files.map((f) => f.name), ['main.tex', 'sections/method.tex', 'refs.bib', 'figs/plot.png', 'data/huge.csv']);
  const { base } = await fakeOverleaf(t, { [ID]: zip });
  const root = tmp('binary');
  const got = await createOverleafCopies({ fetch: globalThis.fetch, base }).ensure(root, ID);
  assert.deepEqual(got.skipped, [{ path: 'video/talk.mp4', bytes: big.length, why: 'binary over the size limit' }]);
  assert.ok(!fs.existsSync(path.join(root, '.overleaf', ID, 'video')));
  assert.ok(!fs.existsSync(path.join(root, '.overleaf', 'escape.tex')) && !fs.existsSync(path.join(root, 'escape.tex')));
  assert.equal(fs.statSync(path.join(root, '.overleaf', ID, 'data', 'huge.csv')).size, 21 * 1024 * 1024);
  assert.deepEqual([safeName('a/./b.tex'), safeName('/abs.tex'), safeName('a/../../b'), safeName('C:/x'), safeName('d/')], ['a/b.tex', '', '', '', '']);
  assert.deepEqual([isText('main.tex'), isText('.latexmkrc'), isText('Makefile'), isText('fig.pdf'), isText('x.PNG')], [true, true, true, false, false]);
});

test('readZip reads a zip made by the zip command (stored and deflated entries)', (t) => {
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); } catch { t.skip('no zip command'); return; }
  const dir = tmp('zipcmd');
  fs.mkdirSync(path.join(dir, 'p', 'sections'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'p', 'main.tex'), PAPER.repeat(20));
  fs.writeFileSync(path.join(dir, 'p', 'sections', 'a.tex'), 'é ü — unicode\n');
  fs.writeFileSync(path.join(dir, 'p', 'tiny.txt'), 'x');
  execFileSync('zip', ['-qr', path.join(dir, 'out.zip'), '.'], { cwd: path.join(dir, 'p') });
  const { files } = readZip(fs.readFileSync(path.join(dir, 'out.zip')));
  const byName = Object.fromEntries(files.map((f) => [f.name, f.data.toString('utf8')]));
  assert.equal(byName['main.tex'], PAPER.repeat(20));
  assert.equal(byName['sections/a.tex'], 'é ü — unicode\n');
  assert.equal(byName['tiny.txt'], 'x');
  assert.throws(() => readZip(Buffer.from('<!doctype html>')), /did not send a zip/);
});

/* ------------------------------------------------------------------------------------------- what Bart is given */

test('openFileXml marks the cursor; a long file is whole lines around it, with the lines shown', () => {
  const at = LIVE.indexOf(TYPED) + TYPED.length;
  const read = editorInput(overleafPage({ view: cmView(LIVE, { anchor: at }) }).run(READ_SCRIPT));
  assert.equal(openFileXml(read), `<open_file path="main.tex" lines="7" cursor_line="4">\n${LIVE.slice(0, at)}${CURSOR}${LIVE.slice(at)}\n</open_file>\n`);
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} of the thesis`);
  const long = lines.join('\n');
  const head = long.indexOf('line 2500 ') + 4;
  const cut = openFileXml(editorInput(overleafPage({ view: cmView(long, { anchor: head }) }).run(READ_SCRIPT)), { max: 2000 });
  const [, first, last] = /shown_lines="(\d+)-(\d+)"/.exec(cut);
  const body = cut.split('\n').slice(1, -2);
  assert.equal(body[0], `line ${first} of the thesis`, 'starts on a whole line');
  assert.equal(body.at(-1), `line ${last} of the thesis`, 'ends on one');
  assert.ok(Number(first) < 2500 && Number(last) > 2500 && Number(last) - Number(first) < 100, `${first}-${last}`);
  assert.ok(body.includes(`line${CURSOR} 2500 of the thesis`));
  assert.match(cut, /cursor_line="2500"/);
});

test('overleafStageBlock: the live file and selection, the copy\'s folder; a timeout says the copy is all there is', () => {
  const copy = { projectId: ID, folder: `/data/.overleaf/${ID}`, fetchedAt: Date.UTC(2026, 9, 7, 12, 0, 0), skipped: [] };
  const from = PAPER.indexOf('We study'), to = from + 'We study tutors.'.length;
  const read = editorInput(overleafPage({ view: cmView(PAPER, { anchor: from, head: to }), file: 'main.tex' }).run(READ_SCRIPT));
  const block = overleafStageBlock({ name: 'My Paper', live: { ok: true, read }, copy }, { screenshot: '/data/bart-shots/t.png' });
  assert.equal(block, [
    `<stage source="overleaf" project="My Paper" file="main.tex" folder="/data/.overleaf/${ID}" copied_at="2026-10-07T12:00:00.000Z">`,
    '<open_file path="main.tex" lines="7" cursor_line="4">',
    `${PAPER.slice(0, to)}${CURSOR}${PAPER.slice(to)}`,
    '</open_file>',
    '<selection from_line="4" to_line="4">',
    'We study tutors.',
    '</selection>',
    '<screenshot path="/data/bart-shots/t.png"/>',
    '</stage>',
  ].join('\n'));
  // timed out: no open file, the copy said to be all there is
  const late = overleafStageBlock({ name: 'My Paper', live: { ok: false, why: 'timeout' }, copy });
  assert.match(late, new RegExp(`^<stage source="overleaf" project="My Paper" folder="/data/\\.overleaf/${ID}" copied_at="[^"]+" live="unavailable">\\n<note>The Overleaf editor did not answer within 500 ms[^<]*Read the project from the folder`));
  assert.ok(!late.includes('<open_file'));
  // no copy at all, and files left out of one
  assert.match(overleafStageBlock({ name: 'P', live: { ok: false, why: 'error' }, copy: { error: 'Overleaf did not send the project: is the Stage signed in to overleaf.com?' } }), /<note>There is no copy of the project on disk: Overleaf did not send the project/);
  assert.match(overleafStageBlock({ name: 'P', live: { ok: true, read }, copy: { ...copy, skipped: [{ path: 'talk.mp4', bytes: 22e6, why: 'binary over the size limit' }] } }), /<note>Not in the copy: talk\.mp4 \(21 MB, binary over the size limit\)\.<\/note>/);
  assert.match(overleafStageBlock({ name: 'P', live: { ok: true, read }, copy: { ...copy, pending: true } }), /<note>A newer copy is still downloading/);
  // background tabs: one line each
  assert.equal(overleafTabsBlock([{ name: 'Thesis', copy: { folder: '/d/.overleaf/x' } }, { name: 'Grant', copy: { error: 'no' } }]),
    '<overleaf_tabs>\n<project name="Thesis" folder="/d/.overleaf/x"/>\n<project name="Grant" copy="unavailable"/>\n</overleaf_tabs>');
  assert.equal(overleafTabsBlock([]), '');
});

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-overleaf-'));
const layout = ensureHome(homeDir);
let ctx, project, workspace;
test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, { name: 'Overleaf', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'eb-overleaf-code-')) });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Writing' });
});
test.after(async () => { await db.closeAll(); });

const STAGE = { kind: 'web', url: EDITOR_URL, title: 'My Paper - Overleaf, Online LaTeX Editor', tab: 'o1' };

test('a turn: <stage source="overleaf"> with what was just typed (not yet in the copy), the copy\'s folder, other tabs; in `now` too', async (t) => {
  const { base, state } = await fakeOverleaf(t, { [ID]: zipOf(PROJECT_FILES), [OTHER]: zipOf([{ name: 'thesis.tex', data: 'Thesis' }]) });
  const overleaf = createOverleafStage({ copies: createOverleafCopies({ fetch: globalThis.fetch, base }) });
  const at = LIVE.indexOf(TYPED) + TYPED.length;
  const page = overleafPage({ view: cmView(LIVE, { anchor: at }), file: 'main.tex' });
  const tabs = [{ id: 'o1', projectId: ID, title: STAGE.title }, { id: 'o2', projectId: OTHER, title: 'Thesis - Overleaf, Online LaTeX Editor' }, { id: 'o3', projectId: OTHER, title: 'Thesis - Overleaf' }];
  const read = (id) => readEditor({ isDestroyed: () => false, executeJavaScript: async (code) => (id === 'o1' ? page.run(code) : null) });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, '@bart what did I just write?\nbart~> O1\n');
  const turn = overleaf.forTurn({ tabs, read }, STAGE);
  assert.equal(turn.front, true);
  const asked = [];
  const live = { selection: () => { asked.push('selection'); return null; }, screenshot: async () => { asked.push('screenshot'); return null; } };
  const c = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'O1', stage: STAGE, live, overleaf: turn });
  const folder = path.join(ctx.dataRoot, '.overleaf', ID);
  assert.match(c.documents, new RegExp(`<stage source="overleaf" project="My Paper" file="main\\.tex" folder="${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" copied_at="[^"]+">\\n<open_file path="main\\.tex" lines="7" cursor_line="4">`));
  assert.ok(c.documents.includes(`${TYPED}${CURSOR}`), 'the sentence typed seconds ago, cursor after it');
  assert.ok(!fs.readFileSync(path.join(folder, 'main.tex'), 'utf8').includes(TYPED), 'the copy does not have it yet');
  assert.ok(fs.existsSync(path.join(folder, 'sections', 'method.tex')), 'the other files are in the folder');
  assert.ok(c.dirs.some((dir) => folder.startsWith(dir + path.sep)), 'Bart may read the folder');
  assert.ok(c.documents.includes(`<overleaf_tabs>\n<project name="Thesis" folder="${path.join(ctx.dataRoot, '.overleaf', OTHER)}"/>\n</overleaf_tabs>`), 'one line for the other project, however many tabs');
  assert.ok(!c.documents.includes('<stage source="web"'), 'not shown as a web page');
  assert.deepEqual(asked, ['screenshot'], 'its picture is taken; the page\'s selection is the editor\'s');
  assert.ok(c.now.startsWith('<stage source="overleaf"') && c.now.includes('<overleaf_tabs>') && c.now.includes(TYPED), 'a resumed turn is sent it too');
  assert.deepEqual(state.hits.sort(), [ID, OTHER].sort());

  // the editor does not answer: the copy, said so; no new download within the minute
  const slow = overleaf.forTurn({ tabs: tabs.slice(0, 1), read: (id) => readEditor({ isDestroyed: () => false, executeJavaScript: () => new Promise(() => {}) }) }, STAGE);
  const started = Date.now();
  const fallback = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'O2', stage: STAGE, overleaf: slow });
  assert.ok(Date.now() - started < 2000);
  assert.match(fallback.documents, /<stage source="overleaf" project="My Paper" folder="[^"]+" copied_at="[^"]+" live="unavailable">\n<note>The Overleaf editor did not answer within 500 ms/);
  assert.ok(!fallback.documents.includes(TYPED));
  assert.equal(state.hits.length, 2, 'the copy was under a minute old');

  // a web page in front, Overleaf in the background: the web <stage>, then the Overleaf line
  const web = overleaf.forTurn({ tabs: tabs.slice(0, 1), read }, { kind: 'web', url: 'https://example.org/', title: 'Ex', tab: 'w' });
  assert.equal(web.front, false);
  const other = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'O3', stage: { kind: 'web', url: 'https://example.org/', title: 'Ex', tab: 'w' }, overleaf: web });
  assert.ok(other.now.startsWith(`<stage source="web" title="Ex" address="https://example.org/" highlights="0"/>\n<overleaf_tabs>\n<project name="My Paper" folder="${folder}"/>`));
  // the other agents are not shown it, and nothing is read for them
  const brainstorm = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'O4', agent: 'brainstorm', stage: STAGE, overleaf: () => assert.fail('read') });
  assert.ok(!brainstorm.documents.includes('overleaf'));
  // no Overleaf tab: nothing
  assert.equal(overleaf.forTurn({ tabs: [], read }, STAGE), null);
  await projects.writeDoc(ctx, project.id, ref, '');
});

test('ask-bart reaches the calling window\'s Overleaf tabs for @bart alone', async () => {
  const handlers = new Map(), asks = [], reached = [];
  const turn = async () => ({ front: null, background: [] });
  registerEngelbartIpc({
    store: { context: async () => ctx }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {},
    bart: { async ask(c, pid, question) { asks.push(question); return { lines: ['bart> ok'], meta: {} }; }, stop: () => true },
    windowHandler: (fn) => (...args) => fn({ id: 'w1' }, ...args), reply: () => {},
    overleafFor: (win, stage) => { reached.push([win.id, stage && stage.tab]); return turn; },
  });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const askBart = (value) => handlers.get('engelbart:ask-bart')(project.id, { ref, workspaceId: workspace.id, text: 'what?', turns: [], ...value });
  await askBart({ askId: 'I1', stage: STAGE });
  await askBart({ askId: 'I2' }); // nothing in front: background tabs still count
  await askBart({ askId: 'I3', agent: 'discover', stage: STAGE });
  assert.deepEqual(reached, [['w1', 'o1'], ['w1', null]]);
  assert.equal(asks[0].overleaf, turn);
  assert.ok(!('overleaf' in asks[2]));
});

test('the system prompt explains the Overleaf <stage>: the live text is newer than the copy; other files from the folder', () => {
  assert.match(BART_SYSTEM_PROMPT, /<stage source="overleaf">/);
  assert.match(BART_SYSTEM_PROMPT, /The live text is newer than the copy/);
  assert.match(BART_SYSTEM_PROMPT, /Read the project's other files \([^)]*\) from the folder/);
  assert.match(BART_SYSTEM_PROMPT, /<<<cursor>>> marks where their cursor is/);
  assert.match(BART_SYSTEM_PROMPT, /live="unavailable" means the editor could not be read/);
  assert.match(BART_SYSTEM_PROMPT, /<overleaf_tabs>/);
});
