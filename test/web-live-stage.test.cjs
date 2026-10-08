'use strict';

// MATH-54 build 3a (2026-10-06): @bart sees what the person has selected on the web page in front and a picture of it.
// The page's preload answers with the selection's quote (each end taken to the whole word, as Highlight's is) and the
// page's text around it; main asks within ~300 ms and keeps none of it. The picture is a PNG under
// <dataRoot>/bart-shots/, the last 20 kept. Both go inside <stage source="web">, a resumed turn's `now` too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const PAGE = require('../src/main/browser/page-preload.cjs');
const { createBrowserViews, selectionInput, SELECTION_TIMEOUT_MS, SHOT_MAX_EDGE } = require('../src/main/browser/views.cjs');
const { saveShot, pruneShots, shotsDir, MAX_SHOTS } = require('../src/main/bart/shots.cjs');
const { webStageBlock } = require('../src/main/bart/highlights.cjs');
const { buildContext, SELECTION_WAIT_MS } = require('../src/main/bart/context.cjs');
const { createBart, createThreads } = require('../src/main/bart/ask.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { stageInput, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');

const node = (data) => ({ data });
const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // the bytes a PNG starts with; enough to be kept

/* ------------------------------------------------------------------------------------------------ whole words */

test('a selection that starts or ends inside a word is taken to the whole word, at both ends', () => {
  const map = PAGE.textMap([node('Once upon a time the future was bright.')]);
  const at = (from, to) => PAGE.quoteOf(map, 0, from, 0, to);
  // "he futur" → "the future"
  assert.equal(at(18, 26).quote.exact, 'the future');
  assert.deepEqual(at(18, 26).quote, { exact: 'the future', prefix: 'Once upon a time ', suffix: ' was bright.' });
  assert.equal(at(18, 20).quote.exact, 'the', 'the start alone inside a word');
  assert.equal(at(17, 24).quote.exact, 'the future', 'the end alone inside a word');
  assert.equal(at(17, 27).quote.exact, 'the future', 'whole words are left as they are');
  assert.equal(at(16, 29).quote.exact, 'the future was', 'whitespace at an end is dropped, the word at the other taken whole');
  assert.equal(at(35, 37).quote.exact, 'bright', 'punctuation is no part of a word');
  // the tint covers the whole words too
  const got = at(18, 26), range = PAGE.rangeOf(map, got.start, got.end);
  assert.deepEqual([range.startOffset, range.endOffset], [17, 27]);
  // apostrophes inside a word, and letters past ASCII
  const words = PAGE.textMap([node("They don't know the café menu.")]);
  assert.equal(PAGE.quoteOf(words, 0, 7, 0, 22).quote.exact, "don't know the café");
});

test('snapping stays in its text node: two blocks run together are not one word', () => {
  // <p>end</p><p>Start here</p> with no whitespace node between: the text reads "endStart here"
  const nodes = ['end', 'Start here', ' and so on'].map(node);
  const map = PAGE.textMap(nodes);
  assert.equal(map.text, 'endStart here and so on');
  assert.equal(PAGE.quoteOf(map, 1, 0, 1, 8).quote.exact, 'Start here', 'not "endStart here"');
  assert.equal(PAGE.quoteOf(map, 1, 2, 2, 3).quote.exact, 'Start here and', 'each end in its own node');
  // a selection snapped past MAX_EXACT is not taken
  const long = PAGE.textMap([node('x'.repeat(PAGE.MAX_EXACT + 10))]);
  assert.equal(PAGE.quoteOf(long, 0, 5, 0, PAGE.MAX_EXACT), null);
});

test('the page text around a selection: about 4,000 characters, the passage in the middle, no broken words at the edges', () => {
  const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
  const start = words.indexOf('w1000 '), end = start + 'w1000'.length;
  const around = PAGE.textAround(words, start, end);
  assert.ok(around.length <= PAGE.PAGE_TEXT && around.length > PAGE.PAGE_TEXT - 20, String(around.length));
  assert.ok(around.includes('w1000'));
  const middle = around.indexOf('w1000') / around.length;
  assert.ok(middle > 0.45 && middle < 0.55, String(middle));
  assert.match(around, /^w\d+ /, 'starts on a whole word');
  assert.match(around, / w\d+$/, 'ends on one');
  // a short page is given whole; a passage longer than the size still has some text on each side
  assert.equal(PAGE.textAround('A short page.', 2, 7), 'A short page.');
  const big = PAGE.textAround(words, 100, 100 + 5000);
  assert.ok(big.length >= 5000 + 200, String(big.length));
});

/* -------------------------------------------------------------------------------- asking the tab (views.cjs) */

function fakeElectron({ capture } = {}) {
  const made = [];
  let frames = 0;
  class WebContentsView {
    constructor(options) {
      this.options = options;
      const contents = options.webContents || new EventEmitter();
      const ipc = { handlers: new Map(), listeners: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); }, on(channel, fn) { this.listeners.set(channel, fn); } };
      Object.assign(contents, {
        ipc, sent: [], closed: false, url: '',
        mainFrame: { frameTreeNodeId: (frames += 1) },
        loadURL(url) { this.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle: () => 'Title', isLoading: () => false, isDestroyed() { return this.closed; },
        close() { this.closed = true; }, reload() {}, stop() {},
        send(channel, payload) { this.sent.push([channel, payload]); if (this.onSend) this.onSend(channel, payload); },
        insertCSS: () => Promise.resolve('key'),
        setWindowOpenHandler() {},
        capturePage: () => capture(),
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
      });
      this.webContents = contents;
      made.push(this);
    }
    setBackgroundColor() {}
    setVisible() {}
    getVisible() { return true; }
    setBounds() {}
  }
  const browsing = {
    cookies: { on() {}, flushStore: async () => {} }, setUserAgent() {}, getUserAgent: () => 'UA', setPermissionRequestHandler() {},
    webRequest: { onHeadersReceived() {} }, on() {}, registerPreloadScript() {},
  };
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1, focus() {} }, contentView: { addChildView() {}, removeChildView() {} } };
  const electron = { WebContentsView, session: { fromPartition: () => browsing }, Menu: { buildFromTemplate: () => ({ popup() {} }) }, clipboard: {}, dialog: {}, shell: { openExternal: async () => {} } };
  return { made, win, electron };
}

function setupViews(options) {
  const fake = fakeElectron(options);
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: () => {}, appName: 'Engelbart' });
  return { fake, views };
}
const fromMain = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });

test('pageSelection asks the tab\'s page and takes its answer; nothing is saved or tinted', async () => {
  const { fake, views } = setupViews();
  views.open('a', 'https://example.org/essay');
  const contents = fake.made[0].webContents;
  const reply = contents.ipc.listeners.get(PAGE.CHANNELS.selection);
  const quote = { exact: 'the future', prefix: 'Once upon a time ', suffix: ' was bright.' };
  contents.onSend = (channel, nonce) => { if (channel === PAGE.CHANNELS.selection) setImmediate(() => reply(fromMain(contents), { nonce, quote, pageText: 'Once upon a time the future was bright.' })); };
  assert.deepEqual(await views.pageSelection('a'), { quote, pageText: 'Once upon a time the future was bright.' });
  assert.deepEqual(contents.sent.map(([channel]) => channel), [PAGE.CHANNELS.selection], 'no quote asked for, nothing added');
  // nothing selected there
  contents.onSend = (channel, nonce) => { if (channel === PAGE.CHANNELS.selection) setImmediate(() => reply(fromMain(contents), { nonce, quote: null, pageText: '' })); };
  assert.equal(await views.pageSelection('a'), null);
  // a sandbox preview's selection is read too: it is never filed
  views.open('p', 'http://localhost:3000/');
  const preview = fake.made[1].webContents;
  preview.onSend = (channel, nonce) => setImmediate(() => preview.ipc.listeners.get(PAGE.CHANNELS.selection)(fromMain(preview), { nonce, quote: { exact: 'Submit' }, pageText: '' }));
  assert.deepEqual(await views.pageSelection('p'), { quote: { exact: 'Submit', prefix: '', suffix: '' }, pageText: '' });
  // no such tab
  assert.equal(await views.pageSelection('nope'), null);
});

test('a page that never answers has no selection, after about 300 ms', async () => {
  assert.equal(SELECTION_TIMEOUT_MS, 300);
  const { fake, views } = setupViews();
  views.open('a', 'https://slow.example.org/');
  const started = Date.now();
  assert.equal(await views.pageSelection('a'), null);
  const took = Date.now() - started;
  assert.ok(took >= 280 && took < 1000, String(took));
  // its late answer is ignored
  const contents = fake.made[0].webContents;
  const [, nonce] = contents.sent.at(-1);
  contents.ipc.listeners.get(PAGE.CHANNELS.selection)(fromMain(contents), { nonce, quote: { exact: 'late' }, pageText: '' });
});

test('selection answers main refuses: another tab, a subframe, a wrong nonce, bad shapes, too much text', async () => {
  const { fake, views } = setupViews();
  views.open('a', 'https://a.example.org/');
  views.open('b', 'https://b.example.org/');
  const [a, b] = fake.made.map((view) => view.webContents);
  const reply = a.ipc.listeners.get(PAGE.CHANNELS.selection);
  const good = { exact: 'fine', prefix: '', suffix: '' };
  const ask = (answer) => { a.onSend = (channel, nonce) => setImmediate(() => answer(nonce)); return views.pageSelection('a', { timeoutMs: 50 }); };
  assert.equal(await ask((nonce) => reply(fromMain(b), { nonce, quote: good })), null, 'another tab');
  assert.equal(await ask((nonce) => reply({ sender: a, senderFrame: { frameTreeNodeId: 999 } }, { nonce, quote: good })), null, 'a subframe');
  assert.equal(await ask((nonce) => reply(fromMain(a), { nonce: `${nonce}x`, quote: good })), null, 'a wrong nonce');
  assert.equal(await ask((nonce) => reply(fromMain(a), { nonce, quote: { exact: 'x'.repeat(PAGE.MAX_EXACT + 1) } })), null, 'too long a passage');
  const cut = await ask((nonce) => reply(fromMain(a), { nonce, quote: good, pageText: 'p'.repeat(100000) }));
  assert.ok(cut.pageText.length < 20000, 'page text is cut');
  assert.deepEqual(selectionInput({ quote: good, pageText: 7 }), { quote: good, pageText: '' });
  for (const bad of [null, 'x', [], { quote: null }, { quote: { exact: '  ' } }]) assert.equal(selectionInput(bad), null);
});

test('screenshot: the page as PNG bytes, its longer edge at most 1568 pixels; a failed or empty capture is none', async () => {
  const image = (width, height, { empty = false } = {}) => ({
    isEmpty: () => empty, getSize: () => ({ width, height }),
    resize(size) { return image(size.width, size.height); },
    toPNG() { return Buffer.from(`png ${width}x${height}`); },
  });
  let next = () => Promise.resolve(image(1200, 800));
  const { views } = setupViews({ capture: () => next() });
  views.open('a', 'https://example.org/');
  assert.equal(String(await views.screenshot('a')), 'png 1200x800');
  next = () => Promise.resolve(image(3200, 2000));
  assert.equal(String(await views.screenshot('a')), `png ${SHOT_MAX_EDGE}x980`);
  next = () => Promise.resolve(image(0, 0, { empty: true }));
  assert.equal(await views.screenshot('a'), null);
  next = () => Promise.reject(new Error('gone'));
  assert.equal(await views.screenshot('a'), null);
  assert.equal(await views.screenshot('nope'), null);
});

/* ---------------------------------------------------------------------------------------------- the pictures */

test('pictures are kept as <turn id>.png, the last 20, older ones deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-shots-'));
  const dir = shotsDir(root);
  assert.equal(dir, path.join(root, 'bart-shots'));
  assert.equal(MAX_SHOTS, 20);
  const t0 = Date.now() / 1000 - 1000;
  for (let i = 0; i < 24; i += 1) {
    const file = saveShot(root, `turn-${String(i).padStart(2, '0')}`, PNG);
    assert.equal(file, path.join(dir, `turn-${String(i).padStart(2, '0')}.png`));
    fs.utimesSync(file, t0 + i, t0 + i); // written a second apart
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a picture');
  const kept = () => fs.readdirSync(dir).filter((name) => name.endsWith('.png')).sort();
  assert.equal(kept().length, 20);
  assert.deepEqual(kept().slice(0, 2), ['turn-04.png', 'turn-05.png'], 'the oldest four went');
  // a new one, even with an old time, is kept; the oldest goes
  const file = saveShot(root, 'turn-new', PNG);
  assert.ok(fs.existsSync(file));
  assert.equal(kept().length, 20);
  assert.ok(!kept().includes('turn-04.png'));
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'nothing else is touched');
  assert.deepEqual(pruneShots(dir, 18).length, 2);
  // nothing to keep, or no file name
  assert.equal(saveShot(root, 'empty', Buffer.alloc(0)), null);
  assert.equal(saveShot(root, '../escape', PNG), null);
  assert.equal(saveShot(root, null, PNG), null);
});

/* ------------------------------------------------------------------------------------------- what Bart is given */

test('webStageBlock: <selection> and <screenshot> inside the web <stage>, with or without highlights', () => {
  const page = { name: 'An essay', address: 'https://example.org/e', path: '', annotations: '/ink/e.json' };
  const selection = { quote: { exact: 'the future', prefix: 'a ', suffix: ' b' }, pageText: 'Once upon a time the future was bright.' };
  assert.equal(webStageBlock({ ...page, selection, screenshot: '/data/bart-shots/t1.png' }, {}),
    '<stage source="web" title="An essay" address="https://example.org/e" highlights="0">\n<selection>\n<quote>\nthe future\n</quote>\n<page_text>\nOnce upon a time the future was bright.\n</page_text>\n</selection>\n<screenshot path="/data/bart-shots/t1.png"/>\n</stage>');
  const ink = { web: [{ id: 'w1', quote: { exact: 'kept passage' }, note: 'mine' }] };
  assert.equal(webStageBlock({ ...page, selection }, ink),
    '<stage source="web" title="An essay" address="https://example.org/e" annotations="/ink/e.json">\n<selection>\n<quote>\nthe future\n</quote>\n<page_text>\nOnce upon a time the future was bright.\n</page_text>\n</selection>\n<highlight>\n<quote>\nkept passage\n</quote>\n<note>\nmine\n</note>\n</highlight>\n</stage>');
  // no selection: no <selection>; nothing live: one line, as before
  assert.equal(webStageBlock({ ...page, selection: null, screenshot: '/s.png' }, {}), '<stage source="web" title="An essay" address="https://example.org/e" highlights="0">\n<screenshot path="/s.png"/>\n</stage>');
  assert.equal(webStageBlock(page, {}), '<stage source="web" title="An essay" address="https://example.org/e" highlights="0"/>');
  assert.equal(webStageBlock({ ...page, selection: { quote: { exact: ' ' }, pageText: 'x' } }, {}), '<stage source="web" title="An essay" address="https://example.org/e" highlights="0"/>');
});

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-live-'));
const layout = ensureHome(homeDir);
let ctx, project, workspace;
test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-live-code-'));
  project = await projects.createProject(ctx, { name: 'Live pages', directory: code });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Reading' });
});
test.after(async () => { await db.closeAll(); });

const STAGE = { kind: 'web', url: 'https://example.org/essay', title: 'An essay', tab: 'tab-1' };
const SELECTED = { quote: { exact: 'the future', prefix: 'Once upon a time ', suffix: ' was bright.' }, pageText: 'Once upon a time the future was bright.' };

test('buildContext: the selection and the picture of the page in front, in <stage> and in `now`; none of it saved', async () => {
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, '@bart what does this mean?\nbart~> L1\n');
  const asked = [];
  const live = { selection: async () => { asked.push('selection'); return SELECTED; }, screenshot: async () => { asked.push('screenshot'); return PNG; } };
  const c = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'L1', stage: STAGE, live });
  const shot = path.join(ctx.dataRoot, 'bart-shots', 'L1.png');
  const stage = `<stage source="web" title="An essay" address="https://example.org/essay" highlights="0">\n<selection>\n<quote>\nthe future\n</quote>\n<page_text>\nOnce upon a time the future was bright.\n</page_text>\n</selection>\n<screenshot path="${shot}"/>\n</stage>`;
  assert.ok(c.documents.includes(stage), c.documents.slice(-600));
  assert.equal(c.now, `${stage}\n\n<highlights>none</highlights>`, 'what a resumed turn is sent carries both');
  assert.deepEqual(fs.readFileSync(shot), PNG);
  assert.ok(c.dirs.some((dir) => shot.startsWith(dir + path.sep)), 'the picture is in a folder Bart may read');
  assert.deepEqual(asked.sort(), ['screenshot', 'selection']);
  // the selection is kept nowhere: not in the page's ink, not on disk
  const all = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of all(ctx.dataRoot).filter((f) => !f.includes('library.pglite') && !f.endsWith('.png'))) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('Once upon a time the future'), file);
  }

  // no selection: no <selection>; a capture that fails: no <screenshot>
  const none = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'L2', stage: STAGE, live: { selection: async () => null, screenshot: async () => null } });
  assert.ok(none.documents.includes('<stage source="web" title="An essay" address="https://example.org/essay" highlights="0"/>'));
  assert.ok(!none.documents.includes('<selection>') && !none.documents.includes('<screenshot'));
  assert.ok(!fs.existsSync(path.join(ctx.dataRoot, 'bart-shots', 'L2.png')));
  const thrown = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'L3', stage: STAGE, live: { selection: () => { throw new Error('gone'); }, screenshot: () => Promise.reject(new Error('gone')) } });
  assert.ok(!thrown.documents.includes('<selection>') && !thrown.documents.includes('<screenshot'));
  // no tab to ask (a pdf, or no Stage): as before
  const plain = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'L4', stage: { kind: 'web', url: STAGE.url, title: 'An essay' } });
  assert.ok(plain.documents.includes('<stage source="web" title="An essay" address="https://example.org/essay" highlights="0"/>'));
  // the other agents are never shown it, nor is the tab asked
  const brainstorm = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'L5', agent: 'brainstorm', stage: STAGE, live: { selection: () => assert.fail('asked'), screenshot: () => assert.fail('asked') } });
  assert.ok(!brainstorm.documents.includes('<stage'));
  await projects.writeDoc(ctx, project.id, ref, '');
});

test('buildContext: a page that never answers has no selection, and the turn waits about 300 ms for it', async () => {
  assert.equal(SELECTION_WAIT_MS, 300);
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const started = Date.now();
  const c = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'N1', stage: STAGE, live: { selection: () => new Promise(() => {}), screenshot: async () => PNG } });
  const took = Date.now() - started;
  assert.ok(took >= 280 && took < 1500, String(took));
  assert.ok(!c.documents.includes('<selection>'));
  assert.ok(c.documents.includes(`<screenshot path="${path.join(ctx.dataRoot, 'bart-shots', 'N1.png')}"/>`), 'the picture still comes');
});

test('a question asked from a highlight on the page is about the highlight: the selection is not asked for, the picture is', async () => {
  const ref = { kind: 'mark', id: 'w1', url: STAGE.url, source: 'web' };
  const c = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'M1', highlight: { quote: 'kept', note: '@bart why?', paper: 'An essay' }, stage: STAGE, live: { selection: () => assert.fail('asked'), screenshot: async () => PNG } });
  assert.ok(!c.documents.includes('<selection>'));
  assert.ok(c.documents.includes('<screenshot path='));
});

test('a resumed @bart turn is sent the selection and the picture as they are now', async () => {
  const authFile = path.join(homeDir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, `answer ${calls.length}`);
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcf"}\n');
  };
  const bart = createBart({ readModels: () => ({ ...normalizeModels(null), provider: 'openai' }), environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs'), codexHome: path.join(homeDir, 'codex-home'), codexAuthFile: authFile, run, threads: createThreads() });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, '@bart what is this?\nbart~> R1\n');
  const said = [];
  const ask = async (askId, text, selection) => {
    const out = await bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns: [...said], stage: STAGE, live: { selection: async () => selection, screenshot: async () => PNG } });
    said.push({ question: text, answer: out.lines[0].replace(/^bart> /, '') });
    return calls[calls.length - 1];
  };
  const first = await ask('R1', 'what is this?', SELECTED);
  assert.ok(first.input.includes('<quote>\nthe future\n</quote>') && first.input.includes(`<screenshot path="${path.join(ctx.dataRoot, 'bart-shots', 'R1.png')}"/>`));
  const second = await ask('R2', 'and this?', { quote: { exact: 'was bright' }, pageText: 'the future was bright.' });
  assert.match(second.command, / resume /);
  assert.match(second.input, new RegExp(`^<stage source="web" title="An essay" address="https://example\\.org/essay" highlights="0">\\n<selection>\\n<quote>\\nwas bright\\n</quote>\\n<page_text>\\nthe future was bright\\.\\n</page_text>\\n</selection>\\n<screenshot path="[^"]+R2\\.png"/>\\n</stage>\\n\\n<highlights>none</highlights>\\n\\n<level>`));
  const third = await ask('R3', 'and now?', null);
  assert.ok(!third.input.includes('<selection>'), 'nothing selected now: none, though an earlier turn had one');
  await projects.writeDoc(ctx, project.id, ref, '');
});

/* ------------------------------------------------------------------------------------------------ ipc and prompt */

test('stageInput keeps the tab of a web page; ask-bart reaches that tab in the calling window', async () => {
  assert.deepEqual(stageInput({ kind: 'web', url: 'https://example.org/', title: 't', tab: 'b0c1-2.3' }), { kind: 'web', url: 'https://example.org/', title: 't', tab: 'b0c1-2.3' });
  assert.deepEqual(stageInput({ kind: 'web', url: 'https://example.org/' }), { kind: 'web', url: 'https://example.org/', title: '' });
  for (const bad of [{ tab: 7 }, { tab: 'a b' }, { tab: 'x'.repeat(200) }]) assert.throws(() => stageInput({ kind: 'web', url: 'https://example.org/', ...bad }), TypeError);

  const handlers = new Map(), asks = [], reached = [];
  const live = { selection: async () => null, screenshot: async () => null };
  registerEngelbartIpc({
    store: { context: async () => ctx }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {},
    bart: { async ask(c, pid, question) { asks.push(question); return { lines: ['bart> ok'], meta: {} }; }, stop: () => true },
    windowHandler: (fn) => (...args) => fn({ id: 'w1' }, ...args), reply: () => {},
    stagePageFor: (win, tab) => { reached.push([win.id, tab]); return live; },
  });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const askBart = (value) => handlers.get('engelbart:ask-bart')(project.id, { ref, workspaceId: workspace.id, text: 'what?', turns: [], ...value });
  await askBart({ askId: 'I1', stage: STAGE });
  assert.deepEqual(reached, [['w1', 'tab-1']]);
  assert.equal(asks[0].live, live);
  await askBart({ askId: 'I2', stage: { kind: 'web', url: STAGE.url } }); // no tab
  await askBart({ askId: 'I3', agent: 'discover', stage: STAGE }); // not @bart
  assert.equal(reached.length, 1);
  assert.ok(!('live' in asks[1]) && !('live' in asks[2]));
});

test('the system prompt explains <selection> and <screenshot>', () => {
  assert.match(BART_SYSTEM_PROMPT, /<selection>, inside a web <stage>, is the text the person has selected on that page right now/);
  assert.match(BART_SYSTEM_PROMPT, /"this", "here" and "it" refer to the selection, ahead of the saved highlights/);
  assert.match(BART_SYSTEM_PROMPT, /<screenshot path="…"\/>[^\n]*only when the answer depends on what the page looks like: a figure, chart, image or layout, or a page whose text you cannot read otherwise \(Google Docs/);
  assert.match(BART_SYSTEM_PROMPT, /Otherwise do not open it\./);
  assert.match(BART_SYSTEM_PROMPT, /view_image/);
});
