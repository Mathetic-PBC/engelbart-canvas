'use strict';

// MATH-54 build 1 (2026-10-06): highlights on web pages, kept and shown to @bart, no UI yet. A web page's ink is the pdf
// ink file with a "web" list beside the pages ({ "web": [mark] }, a mark { id, quote: { exact, prefix, suffix }, note,
// asks } with no page); one address function (shared/address-key.cjs) says which page an address is wherever a page is
// filed or matched; a local server or a sandbox preview is never filed; @bart's <stage> and <highlights> carry web pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const { addressKey, isPreviewAddress } = require('../src/shared/address-key.cjs');
const { withAsk, WEB } = require('../src/shared/mark-answers.cjs');
const { docRef, highlightInput, stageInput, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { marksOf, webMarksOf, webStageBlock, mentionedBlock, stageBlock } = require('../src/main/bart/highlights.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');

const ROW = '3f0a6c1e-6b1d-4a57-9a51-1c2b3d4e5f60';
const box = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.015 }];
const pdfMark = (id, text, extra = {}) => ({ id, rects: box, y: 0.2, text, note: null, pos: null, ...extra });
const webMark = (id, exact, extra = {}) => ({ id, quote: { exact, prefix: 'before ', suffix: ' after' }, note: '', asks: [], ...extra });
const asked = (question, answer) => ({ id: `a-${question}`, question, answer, meta: {}, at: 'now', pos: null, collapsed: false });

/* ------------------------------------------------------------------------------------------------ the address */

test('addressKey: www, http or https, a trailing slash, a #fragment and tracking parameters are one page; the rest of the query is another', () => {
  const one = 'example.org/post';
  for (const spelling of [
    'https://example.org/post', 'http://example.org/post', 'https://www.example.org/post', 'https://WWW.Example.org/post/',
    'https://example.org/post#comments', 'https://example.org/post?utm_source=twitter&utm_medium=social',
    'https://example.org/post?fbclid=IwAR0x', 'https://example.org/post?gclid=abc&mc_cid=1&mc_eid=2', 'https://example.org/post?ref=hn',
    'https://www.example.org/post/?UTM_Campaign=fall#top',
  ]) assert.equal(addressKey(spelling), one, spelling);
  assert.equal(addressKey('https://example.org/post?id=2&utm_source=x'), 'example.org/post?id=2');
  assert.equal(addressKey('https://example.org/post?utm_source=x&id=2&ref=y&page=3'), 'example.org/post?id=2&page=3');
  assert.notEqual(addressKey('https://example.org/post?id=1'), addressKey('https://example.org/post?id=2'));
  assert.equal(addressKey('https://example.org/s?q=a%20b&referrer=me'), 'example.org/s?q=a%20b&referrer=me', 'kept as written; a name that only starts like one is kept');
  assert.equal(addressKey('file:///Users/h/a.html#x'), 'file:///Users/h/a.html');
  assert.equal(addressKey('about:blank'), '');
  assert.equal(addressKey('not an address'), 'not an address');
});

test('isPreviewAddress: local servers and sandbox previews, nothing else', () => {
  for (const preview of ['http://localhost:5173/', 'http://LOCALHOST', 'http://127.0.0.1:8080/app', 'http://127.4.0.9', 'http://[::1]:3000/', 'http://0.0.0.0:3000', 'http://app.localhost:3000', 'https://3000-i8k2xq.e2b.app/', 'https://49983-abc.e2b.dev/x']) {
    assert.equal(isPreviewAddress(preview), true, preview);
  }
  for (const page of ['https://example.org/', 'https://e2b.app.example.org/', 'https://localhost.example.org/', 'file:///Users/h/a.html', '/Users/h/a.html', '', null]) {
    assert.equal(isPreviewAddress(page), false, String(page));
  }
});

/* ------------------------------------------------------------------------------------------------ with the store */

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-web-'));
const layout = ensureHome(homeDir);
let ctx, project, workspace;
const pagesDir = () => path.join(ctx.dataRoot, 'annotations', 'pages');
const fileFor = (address) => path.join(pagesDir(), `${createHash('sha256').update(address).digest('hex')}.json`);
const filed = () => (fs.existsSync(pagesDir()) ? fs.readdirSync(pagesDir()).sort() : []);

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-web-code-'));
  project = await projects.createProject(ctx, { name: 'Reading the web', directory: code });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Articles' });
});
test.after(async () => { await db.closeAll(); });

test('web marks are kept beside pdf pages in one ink, and an answer lands on a web mark (no page) or a pdf mark (its page)', async () => {
  const url = 'https://essays.example.org/both';
  const ink = { 2: [pdfMark('p2', 'a pdf passage')], [WEB]: [webMark('w1', 'a web passage', { note: '@bart what?' })] };
  assert.equal(await library.writePageAnnotations(ctx, url, ink), true);
  assert.deepEqual(await library.readPageAnnotations(ctx, url), ink);
  const entry = asked('what?', 'This.');
  assert.equal(await library.addMarkAnswer(ctx, { url }, null, 'w1', entry), true);
  assert.equal(await library.addMarkAnswer(ctx, { url }, null, 'w1', entry), false, 'once');
  assert.equal(await library.addMarkAnswer(ctx, { url }, 2, 'w1', { ...entry, id: 'x' }), false, 'a web mark is not on a page');
  assert.equal(await library.addMarkAnswer(ctx, { url }, null, 'p2', { ...entry, id: 'y' }), false, 'nor a pdf mark in the web list');
  assert.equal(await library.addMarkAnswer(ctx, { url }, 2, 'p2', asked('pdf?', 'PDF.')), true, 'a pdf mark as before');
  const kept = await library.readPageAnnotations(ctx, url);
  assert.deepEqual(kept[WEB][0].asks, [entry]);
  assert.deepEqual(kept[WEB][0].quote, ink[WEB][0].quote, 'the quote as it was given');
  assert.deepEqual(kept[2][0].asks, [asked('pdf?', 'PDF.')]);
  // a library row's own ink: the same
  const id = randomUUID();
  await library.writeAnnotations(ctx, id, { [WEB]: [webMark('w9', 'saved')] });
  await ctx.libraryDb.insert({ id, name: 'Kept page', type: 'website', tags: [], url: 'https://kept.example.org/' });
  assert.equal(await library.addMarkAnswer(ctx, { rowId: id }, null, 'w9', entry), true);
  assert.deepEqual((await library.readAnnotations(ctx, id))[WEB][0].asks, [entry]);
  // the shared rule the Stage uses too
  assert.deepEqual(withAsk({ [WEB]: [{ id: 'a' }] }, null, 'a', { id: 'e' }), { [WEB]: [{ id: 'a', asks: [{ id: 'e' }] }] });
});

test('ink is filed under the address as addressKey spells it: www, a trailing slash, utm_* and a #fragment find the same notes', async () => {
  const before = filed();
  await library.writePageAnnotations(ctx, 'https://www.news.example.org/story/?utm_source=x#top', { [WEB]: [webMark('n1', 'news')] });
  const added = filed().filter((name) => !before.includes(name));
  assert.deepEqual(added, [path.basename(fileFor('news.example.org/story'))], 'one file, by the address without its spelling');
  for (const spelling of ['http://news.example.org/story', 'https://news.example.org/story?fbclid=1', 'https://www.news.example.org/story#more']) {
    assert.deepEqual(await library.readPageAnnotations(ctx, spelling), { [WEB]: [webMark('n1', 'news')] }, spelling);
  }
  assert.equal(await library.readPageAnnotations(ctx, 'https://news.example.org/story?id=2'), null, 'another query is another page');
  // the library row added later by another spelling finds it, and the Save button knows it
  const row = await library.addItem(ctx, 'http://news.example.org/story/?utm_medium=email');
  assert.deepEqual(await library.readAnnotations(ctx, row.id), { [WEB]: [webMark('n1', 'news')] });
  assert.equal((await library.lookupItem(ctx, 'https://www.news.example.org/story?gclid=9')).row.id, row.id);
  await assert.rejects(() => library.addItem(ctx, 'https://news.example.org/story?ref=x'), (error) => error.code === 'EXISTS');
});

test('ink filed under the raw address before MATH-54 is still found, the next save goes to the new file, and nothing on disk is renamed', async () => {
  const url = 'https://www.old.example.org/essay/';
  const oldFile = fileFor(url), newFile = fileFor('old.example.org/essay');
  const oldInk = { 1: [pdfMark('o1', 'filed long ago')] };
  fs.mkdirSync(pagesDir(), { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify(oldInk));
  assert.deepEqual(await library.readPageAnnotations(ctx, url), oldInk);
  assert.deepEqual(await library.readPageAnnotations(ctx, `${url}#part-2`), oldInk, 'its #fragment was dropped then too');
  assert.equal(await library.annotationsFileOf(ctx, { url }), oldFile, 'Bart is pointed at the file it was read from');
  // an answer onto old ink: read from the old file, written to the new one
  assert.equal(await library.addMarkAnswer(ctx, { url }, 1, 'o1', asked('old?', 'Yes.')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(newFile, 'utf8'))[1][0].asks, [asked('old?', 'Yes.')]);
  assert.deepEqual(JSON.parse(fs.readFileSync(oldFile, 'utf8')), oldInk, 'the old file is left as it was');
  assert.equal(await library.annotationsFileOf(ctx, { url }), newFile);
  assert.deepEqual((await library.readPageAnnotations(ctx, 'http://old.example.org/essay'))[1][0].asks, [asked('old?', 'Yes.')], 'now any spelling finds it');
  // a row that only has old ink finds it too, and a page copy carries it
  const legacy = 'https://legacy.example.org/a?utm_source=feed';
  fs.writeFileSync(fileFor(legacy), JSON.stringify({ [WEB]: [webMark('l1', 'legacy')] }));
  const id = randomUUID();
  await ctx.libraryDb.insert({ id, name: 'Legacy', type: 'website', tags: [], url: legacy });
  assert.deepEqual(await library.readAnnotations(ctx, id), { [WEB]: [webMark('l1', 'legacy')] });
  assert.equal(await library.annotationsFileOf(ctx, { rowId: id }), fileFor(legacy));
  const copied = 'https://copied.example.org/b';
  fs.writeFileSync(fileFor(copied), JSON.stringify({ [WEB]: [webMark('c1', 'copied')] }));
  const save = async (dir) => { fs.writeFileSync(path.join(dir, 'index.html'), '<title>B</title>'); return { url: copied, title: 'B' }; };
  const page = await library.addPageCopy(ctx, copied, save);
  assert.deepEqual(await library.readAnnotations(ctx, page.id), { [WEB]: [webMark('c1', 'copied')] });
  assert.ok(fs.existsSync(fileFor(copied)), 'copied, not moved');
});

test('a local server or a sandbox preview is never filed: nothing is written, read or answered there', async () => {
  const before = filed();
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8080/notes', 'https://3000-i8k2xq.e2b.app/']) {
    assert.equal(await library.writePageAnnotations(ctx, url, { [WEB]: [webMark('v1', 'preview')] }), false, url);
    assert.equal(await library.readPageAnnotations(ctx, url), null, url);
    assert.equal(await library.addMarkAnswer(ctx, { url }, null, 'v1', asked('q', 'a')), false, url);
    assert.equal(await library.annotationsFileOf(ctx, { url }), '', url);
  }
  assert.deepEqual(filed(), before);
});

/* ------------------------------------------------------------------------------------------------ ipc */

test('docRef takes a web mark with no page; a pdf mark is as before', () => {
  assert.deepEqual(docRef({ kind: 'mark', id: 'w1', url: 'https://example.org/a', source: 'web' }), { kind: 'mark', id: 'w1', url: 'https://example.org/a', source: 'web' });
  assert.deepEqual(docRef({ kind: 'mark', id: 'w1', rowId: ROW, source: 'web', extra: 1 }), { kind: 'mark', id: 'w1', rowId: ROW, source: 'web' });
  assert.deepEqual(docRef({ kind: 'mark', id: 'm1', rowId: ROW, page: 3 }), { kind: 'mark', id: 'm1', rowId: ROW, page: 3 });
  for (const bad of [
    { kind: 'mark', id: 'w1', url: 'https://example.org/a' }, // no page and no source
    { kind: 'mark', id: 'w1', url: 'https://example.org/a', source: 'web', page: 2 },
    { kind: 'mark', id: 'w1', url: 'https://example.org/a', source: 'pdf', page: 2 },
    { kind: 'mark', id: 'w1', source: 'web' },
    { kind: 'mark', id: 'w 1', url: 'https://example.org/a', source: 'web' },
  ]) assert.throws(() => docRef(bad), TypeError, JSON.stringify(bad));
});

test('highlightInput takes a web quote as the mark keeps it; stageInput takes a web page in front', () => {
  assert.deepEqual(highlightInput({ quote: { exact: 'the passage', prefix: 'a ', suffix: ' b' }, note: 'n', paper: 'An essay', pageText: 'around' }), { quote: 'the passage', note: 'n', paper: 'An essay', pageText: 'around' });
  assert.deepEqual(highlightInput({ quote: 'as before' }), { quote: 'as before', note: '', paper: null, pageText: '' });
  assert.deepEqual(stageInput({ kind: 'web', url: ' https://example.org/a ', title: '  An\n essay ', page: 4 }), { kind: 'web', url: 'https://example.org/a', title: 'An essay' });
  assert.deepEqual(stageInput({ kind: 'web', url: 'https://example.org/a' }), { kind: 'web', url: 'https://example.org/a', title: '' });
  assert.equal(stageInput({ kind: 'web', url: '  ' }), null);
  assert.ok(stageInput({ kind: 'web', url: 'https://example.org/', title: 't'.repeat(5000) }).title.length <= 300, 'a long title is cut');
  for (const bad of [{ kind: 'web' }, { kind: 'web', url: 7 }, { kind: 'web', url: `https://example.org/${'x'.repeat(4100)}` }]) assert.throws(() => stageInput(bad), TypeError);
  assert.deepEqual(stageInput({ rowId: ROW, page: 3, kind: 'pdf' }), { rowId: ROW, url: null, page: 3, kind: 'pdf' }, 'a pdf as before');
});

test('ask-bart from a web highlight: its answer is put on the mark in the page\'s "web" list, and every window is told', async () => {
  const url = 'https://ask.example.org/article';
  await library.writePageAnnotations(ctx, url, { 1: [pdfMark('p1', 'untouched')], [WEB]: [webMark('wA', 'the claim', { note: '@bart is it true?' })] });
  const handlers = new Map(), told = [], asks = [];
  const bart = { async ask(c, pid, question) { asks.push(question); return { lines: ['bart> Mostly.', '', '*Sonnet · high · 2 s*'], meta: { provider: 'anthropic', level: { name: 'Sonnet', effort: 'high' }, ms: 2000 } }; }, stop: () => true };
  registerEngelbartIpc({
    store: { context: async () => ctx }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {}, bart,
    windowHandler: (fn) => (...args) => fn({ id: 'w1' }, ...args), reply: () => {}, announce: (channel, payload) => told.push([channel, payload]),
  });
  const ref = { kind: 'mark', id: 'wA', url, source: 'web' };
  const out = await handlers.get('engelbart:ask-bart')(project.id, { askId: 'hW1', ref, workspaceId: workspace.id, text: 'is it true?', turns: [], highlight: { quote: { exact: 'the claim', prefix: '', suffix: '' }, note: '@bart is it true?', paper: 'An article' } });
  assert.equal(out.entry.answer, 'Mostly.');
  assert.deepEqual(asks[0].ref, ref);
  assert.equal(asks[0].highlight.quote, 'the claim');
  const kept = await library.readPageAnnotations(ctx, url);
  assert.deepEqual(kept[WEB][0].asks, [out.entry]);
  assert.deepEqual(kept[1], [pdfMark('p1', 'untouched')]);
  assert.deepEqual(told, [['engelbart:paper-ask-done', { askId: 'hW1', markId: 'wA', page: null, rowId: null, url, source: 'web', entry: out.entry }]]);
});

/* ------------------------------------------------------------------------------------------------ what @bart is shown */

test('webMarksOf reads the "web" list alone, marksOf the pages alone; webStageBlock and mentionedBlock show a web page', () => {
  const ink = { 3: [pdfMark('p3', 'pdf text')], [WEB]: [webMark('w1', 'first', { note: 'mine' }), webMark('w2', '', { note: '' }), webMark('w3', 'third', { asks: [asked('why?', 'Because.')] }), null] };
  assert.deepEqual(webMarksOf(ink).map((h) => [h.page, h.quote, h.note, h.asks.length]), [[null, 'first', 'mine', 0], [null, 'third', '', 1]]);
  assert.deepEqual(marksOf(ink).map((h) => h.quote), ['pdf text']);
  const page = { name: 'An "essay"', address: 'https://example.org/e', path: '', annotations: '/ink/e.json' };
  assert.equal(webStageBlock(page, ink), '<stage source="web" title="An  essay " address="https://example.org/e" annotations="/ink/e.json">\n<highlight>\n<quote>\nfirst\n</quote>\n<note>\nmine\n</note>\n</highlight>\n<highlight>\n<quote>\nthird\n</quote>\n<ask>\n<question>\nwhy?\n</question>\n<answer>\nBecause.\n</answer>\n</ask>\n</highlight>\n</stage>');
  assert.equal(webStageBlock({ ...page, annotations: '' }, {}), '<stage source="web" title="An  essay " address="https://example.org/e" highlights="0"/>');
  // too many for the budget: the noted ones first, <more> says how many were left out
  const many = { [WEB]: Array.from({ length: 30 }, (_, i) => webMark(`m${i}`, `${i} `.padEnd(560, 'x'), i === 29 ? { note: 'the last one, noted' } : {})) };
  const cut = webStageBlock(page, many);
  assert.ok(cut.length <= 6000 && cut.includes('the last one, noted') && /<more n="\d+"\/>\n<\/stage>$/.test(cut));
  const mentioned = mentionedBlock([
    { name: 'A paper', where: '/a.pdf', annotations: '/ink/a.json', ink: { 1: [pdfMark('a1', 'paper text')] } },
    { source: 'web', name: 'Saved', address: 'https://saved.example.org/', path: '/pages/x/index.html', annotations: '/ink/s.json', ink: { [WEB]: [webMark('s1', 'saved text')] } },
    { source: 'web', name: 'Bare', address: 'https://bare.example.org/', path: '', annotations: '/ink/b.json', ink: { 1: [pdfMark('b1', 'not a web mark')] } },
  ]);
  assert.equal(mentioned, '<highlights from="mentioned">\n<paper name="A paper" path="/a.pdf" annotations="/ink/a.json">\n<highlight page="1">\n<quote>\npaper text\n</quote>\n</highlight>\n</paper>\n<page source="web" title="Saved" address="https://saved.example.org/" path="/pages/x/index.html" annotations="/ink/s.json">\n<highlight>\n<quote>\nsaved text\n</quote>\n</highlight>\n</page>\n</highlights>');
  // a pdf's <stage> is unchanged: no source, a page
  assert.ok(stageBlock({ name: 'P', where: '/p.pdf', annotations: '/i.json' }, 3, ink).startsWith('<stage paper="P" path="/p.pdf" page="3" annotations="/i.json">\n<highlight page="3">'));
});

test('buildContext: <stage source="web"> for the web page in front, <highlights> for a saved page the document mentions, a preview with none, a pdf as before', async () => {
  const pages = fs.mkdtempSync(path.join(homeDir, 'pages-'));
  const savedFile = path.join(fs.realpathSync(path.join(pages)), 'index.html');
  fs.writeFileSync(savedFile, '<title>Saved essay</title>');
  const saved = randomUUID();
  await ctx.libraryDb.insert({ id: saved, name: 'Saved essay', project_id: project.id, type: 'html', tags: [], path: savedFile, url: 'https://blog.example.org/saved' });
  await library.writeAnnotations(ctx, saved, { [WEB]: [webMark('s1', 'a saved passage', { note: 'worth citing', asks: [asked('who wrote it?', 'The editors.')] })] });
  const live = 'https://www.live.example.org/post/?utm_source=x';
  await library.writePageAnnotations(ctx, live, { [WEB]: [webMark('l1', 'a live passage')] });
  const wsRef = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, wsRef, 'See @[Saved essay].\n@bart what did I mark?\nbart~> s1\n');
  const ask = (input) => buildContext(ctx, project.id, { ref: wsRef, workspaceId: workspace.id, askId: 's1', ...input });
  const plain = (await ask({})).documents;

  // a live page in front, by another spelling of its address; the saved page mentioned
  const front = (await ask({ stage: { kind: 'web', url: 'http://live.example.org/post', title: 'Live post' } })).documents;
  const inkFile = fileFor('live.example.org/post');
  assert.ok(front.includes(`<stage source="web" title="Live post" address="http://live.example.org/post" annotations="${inkFile}">\n<highlight>\n<quote>\na live passage\n</quote>\n</highlight>\n</stage>`), front.slice(-900));
  assert.ok(front.includes(`<highlights from="mentioned">\n<page source="web" title="Saved essay" address="https://blog.example.org/saved" path="${savedFile}" annotations="${path.join(ctx.dataRoot, 'annotations', `${saved}.json`)}">\n<highlight>\n<quote>\na saved passage\n</quote>\n<note>\nworth citing\n</note>\n<ask>\n<question>\nwho wrote it?\n</question>\n<answer>\nThe editors.\n</answer>\n</ask>\n</highlight>\n</page>\n</highlights>`), front.slice(-1500));
  assert.ok(plain.includes('<page source="web" title="Saved essay"') && plain.includes('<stage>none</stage>\n\n<highlights from="mentioned">'), 'mentioned without a Stage: <stage>none</stage>, then <highlights>');

  // the saved page itself in front (its copy open): in <stage> alone, named and addressed as the library has it
  const open = (await ask({ stage: { kind: 'web', url: pathToFileURL(savedFile).href, title: 'Saved essay – Blog' } })).documents;
  assert.ok(open.includes(`<stage source="web" title="Saved essay" address="https://blog.example.org/saved" path="${savedFile}" annotations="`) && open.includes('a saved passage\n'));
  assert.ok(!open.includes('<highlights'), 'open and mentioned: in <stage> alone');

  // a preview: what it is, no highlights, no ink file
  const preview = (await ask({ stage: { kind: 'web', url: 'https://3000-i8k2xq.e2b.app/', title: 'My app' } })).documents;
  assert.ok(preview.includes('<stage source="web" title="My app" address="https://3000-i8k2xq.e2b.app/" highlights="0"/>'));
  // a page with nothing marked
  assert.ok((await ask({ stage: { kind: 'web', url: 'https://nothing.example.org/', title: '' } })).documents.includes('<stage source="web" title="https://nothing.example.org/" address="https://nothing.example.org/" highlights="0"/>'));

  // the other agents see none of it
  for (const agent of ['brainstorm', 'discover']) {
    const c = await ask({ agent, stage: { kind: 'web', url: live, title: 'Live post' } });
    assert.ok(!c.documents.includes('<stage') && !c.documents.includes('<highlights'), agent);
  }

  // a question asked from a web highlight: <highlight source="web">, no page
  const mark = { kind: 'mark', id: 'l1', url: live, source: 'web' };
  const fromMark = await buildContext(ctx, project.id, { ref: mark, workspaceId: workspace.id, askId: 's2', highlight: { quote: 'a live passage', note: '@bart why?', paper: 'Live post', pageText: 'text around it' } });
  assert.match(fromMark.documents, /<\/workspace>\n\n<highlight source="web" title="Live post" address="https:\/\/www\.live\.example\.org\/post\/\?utm_source=x">\n<quote>\na live passage\n<\/quote>\n<note>\n@bart why\?\n<\/note>\n<page_text>\ntext around it\n<\/page_text>\n<\/highlight>/);
  assert.match(fromMark.head, /asked from: a highlight on the web page "Live post", opened from the workspace "Articles"/);
  await ctx.libraryDb.remove(saved);
});

test('the system prompt tells Bart about web pages in <stage>, <highlights> and <highlight>', () => {
  assert.match(BART_SYSTEM_PROMPT, /<stage source="web">/);
  assert.match(BART_SYSTEM_PROMPT, /<page source="web">/);
  assert.match(BART_SYSTEM_PROMPT, /On a web page it says source="web"/);
});
