'use strict';

// MATH-65 build 4: more free sources after OpenAlex (Semantic Scholar, arXiv by id or by a close title), checked against
// fake servers on loopback; a paper downloaded in the browser brought back from the Downloads folder
// (src/main/zotero/downloads.cjs: a match by DOI or title, a pdf of another paper left alone, partial downloads passed
// over, two papers at once, the 10-minute end); a pdf dropped on a chip; and what Bart and the chip see of each.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { createZoteroSync, writeViews } = require('../src/main/zotero/sync.cjs');
const { createOpenAccess, closeTitle, arxivId, arxivEntries, scholarCandidates, keptCopy } = require('../src/main/zotero/oa.cjs');
const { createDownloadWatch, pdfMatches, paperLike } = require('../src/main/zotero/downloads.cjs');
const mirror = require('../src/main/zotero/mirror.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');

const KEY = 'Zk3yN0tToB3S3ntAnywh3r3';
const USER_ID = '475425';
const NOW = Date.parse('2026-10-06T12:00:00Z');
const TITLE_A = 'Behavioral Context for Adaptive Tutoring at Scale';
const DOI_A = '10.1145/3586183.3606700';
const TITLE_B = 'Learning to Learn: A Survey of Methods for Novice Programmers';
const DOI_B = '10.1016/j.cell.2020.01.001';

const zoteroModel = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/zotero.js')).href);

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `zotero-dl-${name}-`));
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(15); }
  return false;
}

// A one-page PDF with the given lines of text, enough for pdf.js to read back (as test/context.test.cjs makes them).
function makePdf(lines) {
  const escape = (text) => text.replace(/([\\()])/g, '\\$1');
  const content = `BT\n/F1 10 Tf\n12 TL\n50 780 Td\n${lines.map((line) => `(${escape(line)}) Tj T*`).join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A mirror with two papers that have no pdf (A and B, each with a DOI), a paper with no DOI, and a web page. */
function mirrorOf(root) {
  const items = {
    PAPERA01: { key: 'PAPERA01', itemType: 'conferencePaper', title: TITLE_A, creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Barron' }], date: '2026', DOI: DOI_A, dateAdded: '2020-01-01' },
    PAPERB01: { key: 'PAPERB01', itemType: 'journalArticle', title: TITLE_B, creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Smith' }], date: '2020', DOI: `https://doi.org/${DOI_B}`, dateAdded: '2020-01-02' },
    NODOI001: { key: 'NODOI001', itemType: 'preprint', title: 'Attention Is All You Need', creators: [{ creatorType: 'author', lastName: 'Vaswani' }], date: '2017', dateAdded: '2020-01-03' },
    WEB00001: { key: 'WEB00001', itemType: 'webpage', title: 'A Page', url: 'https://example.org/page', creators: [], dateAdded: '2020-01-04' },
  };
  fs.mkdirSync(root, { recursive: true });
  writeViews(root, { collections: {}, items, bib: {} });
}

/**
 * Fake OpenAlex, Semantic Scholar, arXiv (its API and its pdfs) and a publisher. `answers.openalex[doi]` /
 * `answers.scholar[doi]`: the JSON each answers (none: 404); `answers.feed`: the Atom the arXiv search answers. arXiv's
 * /pdf/<id> answers a pdf for the ids in `answers.arxivPdfs`, a page (its bot check) for the rest.
 */
async function sources(t, answers = {}) {
  const seen = { openalex: [], scholar: [], arxiv: [], publisher: [], all: [] };
  const publisher = await serve(t, (req, res) => {
    seen.publisher.push(req.url);
    if (req.url === '/paper.pdf') { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF-1.7 from the publisher'); }
    res.setHeader('content-type', 'text/html'); res.end('<html>blocked</html>');
  });
  const json = (res, body) => { if (!body) { res.statusCode = 404; return res.end('{}'); } res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(typeof body === 'function' ? body(publisher) : body)); };
  const openalex = await serve(t, (req, res) => {
    seen.openalex.push(req.url);
    const m = /^\/works\/doi:(.+)$/.exec(req.url.split('?')[0]);
    json(res, (answers.openalex || {})[m ? decodeURIComponent(m[1]) : '']);
  });
  const scholar = await serve(t, (req, res) => {
    seen.scholar.push(req.url);
    if (answers.scholarStatus) { res.statusCode = answers.scholarStatus; return res.end('{}'); }
    const m = /^\/graph\/v1\/paper\/DOI:(.+)$/.exec(req.url.split('?')[0]);
    json(res, (answers.scholar || {})[m ? decodeURIComponent(m[1]) : '']);
  });
  const arxiv = await serve(t, (req, res) => {
    seen.arxiv.push(req.url);
    if (req.url.startsWith('/api/query')) { res.setHeader('content-type', 'application/atom+xml'); return res.end(answers.feed || '<feed></feed>'); }
    const m = /^\/pdf\/(.+)$/.exec(req.url);
    if (m && (answers.arxivPdfs || []).includes(m[1])) { res.setHeader('content-type', 'application/pdf'); return res.end(`%PDF-1.5 arXiv ${m[1]}`); }
    res.setHeader('content-type', 'text/html'); res.end('<html>Are you a robot?</html>');
  });
  const fetchSeen = (url, init) => { seen.all.push(String(url)); return globalThis.fetch(url, init); };
  return {
    seen, publisher, openalex, scholar, arxiv, fetch: fetchSeen,
    oa: { fetch: fetchSeen, api: openalex, semanticScholar: scholar, arxivApi: arxiv, arxiv },
    sync: { fetch: fetchSeen, openAlex: openalex, semanticScholar: scholar, arxivApi: arxiv, arxiv },
  };
}
const feed = (...entries) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.map(([id, title]) => `<entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title></entry>`).join('')}</feed>`;
const record = (root, key) => JSON.parse(fs.readFileSync(path.join(root, 'items', key, 'open-access.json'), 'utf8'));

/* ------------------------------------------------------------------------------------------------ more free sources */

test('helpers: a close title, an arXiv id, the arXiv feed, Semantic Scholar passing over a doi.org link', () => {
  assert.equal(closeTitle('Learning to Learn: A Survey of Methods', 'Learning to learn — a survey of methods'), true, 'case and punctuation aside');
  assert.equal(closeTitle('Behavioral Context for Adaptive Tutoring at Scale in Introductory Programming', 'Behavioral Context for Adaptive Tutoring at Scale in Introductory Python Programming'), true, 'one word in ten');
  assert.equal(closeTitle('Behavioral Context for Adaptive Tutoring', 'Adaptive Tutoring without Behavioral Data'), false);
  assert.equal(closeTitle('Deep Learning', 'Deep Learning Survey'), false, 'a short title must be the same');
  assert.equal(closeTitle('', 'x'), false);
  assert.equal(arxivId('http://arxiv.org/abs/2101.00001v3'), '2101.00001');
  assert.equal(arxivId('arXiv:cs/0112017'), 'cs/0112017');
  assert.equal(arxivId('2101.00001'), '2101.00001');
  assert.equal(arxivId('../etc/passwd'), '');
  assert.deepEqual(arxivEntries(feed(['2101.00001v2', 'A &amp; B:\n  the Title'])), [{ id: '2101.00001', title: 'A & B: the Title' }]);
  assert.deepEqual(scholarCandidates({ openAccessPdf: { url: 'https://doi.org/10.1/x', status: 'BRONZE' } }), [], 'only the doi.org link: passed over');
  assert.deepEqual(scholarCandidates({ openAccessPdf: { url: 'http://dx.doi.org/10.1/x' } }), []);
  assert.deepEqual(scholarCandidates({ openAccessPdf: { url: '' } }), []);
  assert.deepEqual(scholarCandidates({ openAccessPdf: { url: 'https://europepmc.org/x.pdf' } }), ['https://europepmc.org/x.pdf']);
  assert.deepEqual(scholarCandidates(null), []);
});

test('Semantic Scholar: asked after OpenAlex has no pdf, its openAccessPdf kept and recorded as found through it', async (t) => {
  const root = path.join(tmp('s2'), '.zotero');
  mirrorOf(root);
  const w = await sources(t, { openalex: { [DOI_A]: (base) => ({ best_oa_location: { pdf_url: `${base}/blocked` }, locations: [] }) }, scholar: { [DOI_A]: (base) => ({ paperId: 'p', openAccessPdf: { url: `${base}/paper.pdf` }, externalIds: { DOI: DOI_A } }) } });
  const oa = createOpenAccess({ ...w.oa, root, now: () => NOW });
  const found = await oa.find(mirror.itemOf(root, 'PAPERA01'));
  const file = path.join(root, 'files', 'PAPERA01', 'Barron 2026 Behavioral Context for Adaptive Tutoring at Scale.pdf');
  assert.deepEqual(found, { path: file, url: `${w.publisher}/paper.pdf`, foundAt: '2026-10-06T12:00:00.000Z', source: 'open access', via: 'Semantic Scholar' });
  assert.deepEqual(w.seen.openalex, [`/works/doi:${DOI_A}`]);
  assert.deepEqual(w.seen.scholar, [`/graph/v1/paper/DOI:${DOI_A}?fields=openAccessPdf,externalIds`], 'after OpenAlex, by DOI, its two fields');
  assert.deepEqual(w.seen.publisher, ['/blocked', '/paper.pdf']);
  assert.equal(w.seen.arxiv.length, 0, 'arXiv not asked once a copy is kept');
  assert.equal(fs.readFileSync(file, 'utf8'), '%PDF-1.7 from the publisher');
  assert.deepEqual(record(root, 'PAPERA01'), { v: 1, source: 'Semantic Scholar', found: true, url: `${w.publisher}/paper.pdf`, file, checkedAt: '2026-10-06T12:00:00.000Z' });

  // Bart: the same pdf line as build 3's, naming the source.
  const block = await mirror.itemBlock(root, 'PAPERA01', TITLE_A, { openAccess: oa.find });
  assert.ok(block.lines.includes(`pdf: ${file} (source="open access": found through Semantic Scholar at ${w.publisher}/paper.pdf on 2026-10-06)`), block.lines.join('\n'));
});

test('arXiv by the id Semantic Scholar names: its doi.org openAccessPdf passed over, /pdf/<id> kept', async (t) => {
  const root = path.join(tmp('arxiv-id'), '.zotero');
  mirrorOf(root);
  const w = await sources(t, { scholar: { [DOI_B]: { openAccessPdf: { url: `https://doi.org/${DOI_B}` }, externalIds: { ArXiv: '2001.01234', DOI: DOI_B } } }, arxivPdfs: ['2001.01234'] });
  const oa = createOpenAccess({ ...w.oa, root, now: () => NOW });
  const found = await oa.find(mirror.itemOf(root, 'PAPERB01'));
  assert.equal(found.via, 'arXiv');
  assert.equal(found.url, `${w.arxiv}/pdf/2001.01234`);
  assert.equal(fs.readFileSync(found.path, 'utf8'), '%PDF-1.5 arXiv 2001.01234');
  assert.ok(!w.seen.all.some((url) => url.includes('doi.org')), 'the doi.org link is never fetched');
  assert.deepEqual(w.seen.arxiv, ['/pdf/2001.01234'], 'no title search when the id is known');
  assert.equal(record(root, 'PAPERB01').source, 'arXiv');
});

test('arXiv by title: an entry whose title closely matches is downloaded; none close is a miss for all three sources', async (t) => {
  const root = path.join(tmp('arxiv-title'), '.zotero');
  mirrorOf(root);
  const w = await sources(t, { feed: feed(['2309.99999v1', 'Behavioral Context Is Not Enough'], ['2309.12345v2', 'Behavioral context for adaptive tutoring\n at scale']), arxivPdfs: ['2309.12345', '2309.99999'] });
  const oa = createOpenAccess({ ...w.oa, root, now: () => NOW });
  const found = await oa.find(mirror.itemOf(root, 'PAPERA01'));
  assert.equal(found.via, 'arXiv');
  assert.equal(found.url, `${w.arxiv}/pdf/2309.12345`, 'the close title, not the first entry');
  const query = new URL(w.seen.arxiv[0], 'http://x');
  assert.equal(query.pathname, '/api/query');
  assert.equal(query.searchParams.get('search_query'), 'ti:"behavioral context for adaptive tutoring at scale"', 'a phrase: arXiv drops stop words from an AND');
  assert.equal(w.seen.scholar.length, 1, 'Semantic Scholar was asked first (404 here)');

  // Nothing close: none, and a week-long miss naming all three sources.
  const none = await sources(t, { feed: feed(['2309.99999', 'Something Else Entirely About Tutors']), arxivPdfs: ['2309.99999'] });
  const missed = createOpenAccess({ ...none.oa, root, now: () => NOW });
  assert.equal(await missed.find(mirror.itemOf(root, 'PAPERB01')), null);
  assert.ok(!none.seen.arxiv.some((url) => url.startsWith('/pdf/')), 'a title that is not close is not downloaded');
  assert.equal(new URL(none.seen.arxiv[0], 'http://x').searchParams.get('search_query'), 'ti:"learning to learn"', 'searched by the title up to its colon');
  assert.deepEqual(record(root, 'PAPERB01'), { v: 1, found: false, sources: ['OpenAlex', 'Semantic Scholar', 'arXiv'], checkedAt: '2026-10-06T12:00:00.000Z', until: '2026-10-13T12:00:00.000Z' });
});

test('arXiv answering a page for its pdf is not kept; Semantic Scholar throttling (429) is "try later", not a miss; a build 3 miss is asked again', async (t) => {
  const root = path.join(tmp('arxiv-page'), '.zotero');
  mirrorOf(root);
  const w = await sources(t, { scholar: { [DOI_A]: { openAccessPdf: null, externalIds: { ArXiv: '2309.12345' } } }, arxivPdfs: [] });
  assert.equal(await createOpenAccess({ ...w.oa, root, now: () => NOW }).find(mirror.itemOf(root, 'PAPERA01')), null);
  assert.ok(!fs.existsSync(path.join(root, 'files', 'PAPERA01')), 'only a real pdf is kept');
  assert.equal(record(root, 'PAPERA01').found, false);

  const throttled = await sources(t, { scholarStatus: 429 });
  assert.equal(await createOpenAccess({ ...throttled.oa, root, now: () => NOW }).find(mirror.itemOf(root, 'PAPERB01')), null);
  assert.ok(!fs.existsSync(path.join(root, 'items', 'PAPERB01', 'open-access.json')), 'no week-long miss when a source could not answer');
  assert.equal(throttled.seen.arxiv.length, 1, 'arXiv still tried by title');

  // Build 3 remembered a miss when only OpenAlex was asked: the new sources are asked anyway.
  fs.mkdirSync(path.join(root, 'items', 'PAPERB01'), { recursive: true });
  fs.writeFileSync(path.join(root, 'items', 'PAPERB01', 'open-access.json'), JSON.stringify({ v: 1, source: 'OpenAlex', found: false, checkedAt: '2026-10-05T12:00:00.000Z', until: '2026-10-12T12:00:00.000Z' }));
  const later = await sources(t, { scholar: { [DOI_B]: (base) => ({ openAccessPdf: { url: `${base}/paper.pdf` } }) } });
  assert.equal((await createOpenAccess({ ...later.oa, root, now: () => NOW }).find(mirror.itemOf(root, 'PAPERB01'))).via, 'Semantic Scholar');
});

/* ------------------------------------------------------------------------------------------------ the download match */

test('pdfMatches: the DOI (across a line break) or most of the title; a short title or another paper does not match', () => {
  const a = { key: 'A', doi: DOI_A, title: TITLE_A };
  assert.equal(pdfMatches(`Proceedings\nhttps://doi.org/10.1145/3586183.\n3606700\nSomething`, a), 'doi');
  assert.equal(pdfMatches('BEHAVIORAL CONTEXT FOR ADAPTIVE\nTUTORING AT SCALE\nAda Barron', a), 'title', 'the title broken across lines, in capitals');
  assert.equal(pdfMatches('Behavioral Context for Adaptive Tutor-\ning at Scale', a), 'title', 'a hyphen at a line end');
  assert.equal(pdfMatches('Behavioral Context for Adaptive Tutoring\nAbstract', a), 'title', 'most of it (the run is 80% of its letters)');
  assert.equal(pdfMatches('We study tutoring at scale with adaptive methods and behavioral data in context.', a), '', 'its words scattered are not its title');
  assert.equal(pdfMatches('A Different Paper Altogether\ndoi:10.1145/3586183.9999999', a), '');
  assert.equal(pdfMatches('Deep Learning is everywhere', { key: 'S', title: 'Deep Learning' }), '', 'a two-word title alone is not enough');
  assert.equal(pdfMatches('anything', { key: 'S', title: '' }), '');
  assert.equal(paperLike({ itemType: 'webpage' }), false);
  assert.equal(paperLike({ itemType: 'webpage', doi: '10.1/x' }), true);
  assert.equal(paperLike({ itemType: 'journalArticle' }), true);
});

/** A watch on `dir` that looks only when told (scan), and reads each pdf's text from `texts` (by file name). */
function manual(dir, texts, extra = {}) {
  const told = [], matched = [];
  const watch = createDownloadWatch({
    dir: () => dir, pollMs: 60_000, watch: () => ({ close() {}, on() {} }),
    readText: async (file) => { if (!(path.basename(file) in texts)) throw new Error('unreadable'); return texts[path.basename(file)]; },
    onWaiting: (key, on) => told.push([key, on]),
    onMatch: async (item, file) => { matched.push([item.key, path.basename(file)]); return true; },
    ...extra,
  });
  return { watch, told, matched, twice: async () => { await watch.scan(); await watch.scan(); } };
}
const A = { key: 'PAPERA01', doi: DOI_A, title: TITLE_A };
const B = { key: 'PAPERB01', doi: DOI_B, title: TITLE_B };

test('partial downloads are passed over until they finish: .crdownload, Safari\'s .download, Firefox\'s placeholder beside its .part', async () => {
  const dir = tmp('partial');
  const pdf = '%PDF-1.4 bytes';
  const { watch, matched, twice } = manual(dir, { 'paper.pdf': `doi ${DOI_A}`, 'firefox.pdf': `doi ${DOI_A}`, 'safari.pdf': `doi ${DOI_A}` });
  watch.wait(A);
  fs.writeFileSync(path.join(dir, 'Unconfirmed 81234.crdownload'), pdf);
  fs.writeFileSync(path.join(dir, 'paper.pdf.crdownload'), pdf);
  fs.mkdirSync(path.join(dir, 'safari.pdf.download'));
  fs.writeFileSync(path.join(dir, 'safari.pdf.download', 'safari.pdf'), pdf);
  fs.writeFileSync(path.join(dir, 'firefox.pdf'), ''); // Firefox's empty placeholder
  fs.writeFileSync(path.join(dir, 'firefox.pdf.part'), pdf);
  await twice(); await twice();
  assert.deepEqual(matched, [], 'nothing while every download is partial');

  fs.writeFileSync(path.join(dir, 'firefox.pdf'), pdf); // the .part still beside it: still being written
  await twice();
  assert.deepEqual(matched, []);
  fs.rmSync(path.join(dir, 'firefox.pdf.part'));
  await watch.scan();
  assert.deepEqual(matched, [], 'looked at once more before it is read: it may still be growing');
  await watch.scan();
  assert.deepEqual(matched, [['PAPERA01', 'firefox.pdf']], 'finished: read and matched');
  assert.deepEqual(watch.waiting(), [], 'a match ends the wait');
});

test('a file still growing between two looks waits; a pdf there before the click is not new', async () => {
  const dir = tmp('growing');
  fs.writeFileSync(path.join(dir, 'old.pdf'), '%PDF-1.4 old'); // already downloaded before
  const { watch, matched } = manual(dir, { 'old.pdf': `doi ${DOI_A}`, 'new.pdf': `doi ${DOI_A}` });
  watch.wait(A);
  fs.writeFileSync(path.join(dir, 'new.pdf'), '%PDF-1.4 part');
  await watch.scan();
  fs.appendFileSync(path.join(dir, 'new.pdf'), ' more of it');
  await watch.scan();
  assert.deepEqual(matched, [], 'it grew between the looks');
  await watch.scan();
  assert.deepEqual(matched, [['PAPERA01', 'new.pdf']], 'the new one, never old.pdf');
});

test('two papers watched at once: each download goes to its own paper, one of another paper is left alone, a non-pdf is ignored', async () => {
  const dir = tmp('two');
  const { watch, told, matched, twice } = manual(dir, { 'b.pdf': `${TITLE_B.toUpperCase()}\nAnn Smith`, 'other.pdf': 'An Unrelated Paper About Compilers\ndoi:10.9/other', 'a.pdf': `x\n${TITLE_A}\ny` });
  watch.wait(A);
  watch.wait(B);
  assert.deepEqual(watch.waiting().sort(), ['PAPERA01', 'PAPERB01']);
  fs.writeFileSync(path.join(dir, 'other.pdf'), '%PDF-1.4 other');
  fs.writeFileSync(path.join(dir, 'notes.pdf'), 'not a pdf at all');
  await twice();
  assert.deepEqual(matched, [], 'another paper, and a file that is not a pdf, are left alone');
  assert.ok(fs.existsSync(path.join(dir, 'other.pdf')) && fs.existsSync(path.join(dir, 'notes.pdf')));
  fs.writeFileSync(path.join(dir, 'b.pdf'), '%PDF-1.4 b');
  await twice();
  assert.deepEqual(matched, [['PAPERB01', 'b.pdf']]);
  assert.deepEqual(watch.waiting(), ['PAPERA01'], 'A still waited for');
  fs.writeFileSync(path.join(dir, 'a.pdf'), '%PDF-1.4 a');
  await twice();
  assert.deepEqual(matched, [['PAPERB01', 'b.pdf'], ['PAPERA01', 'a.pdf']]);
  assert.deepEqual(told, [['PAPERA01', true], ['PAPERB01', true], ['PAPERB01', false], ['PAPERA01', false]]);
  assert.deepEqual(watch.waiting(), []);
});

test('the wait ends after its time (and a click again starts it over); stopAll ends every wait, as the app quits', async () => {
  const dir = tmp('timeout');
  const { watch, told, matched } = manual(dir, { 'a.pdf': `doi ${DOI_A}` }, { waitMs: 120 });
  watch.wait(A);
  await sleep(80);
  watch.wait(A); // clicked again: 120 ms from now
  await sleep(80);
  assert.deepEqual(watch.waiting(), ['PAPERA01'], 'still waiting: the second click started it over');
  assert.ok(await until(() => watch.waiting().length === 0, 1000), 'over after its time');
  assert.deepEqual(told, [['PAPERA01', true], ['PAPERA01', false]]);
  fs.writeFileSync(path.join(dir, 'a.pdf'), '%PDF-1.4 a');
  await watch.scan(); await watch.scan();
  assert.deepEqual(matched, [], 'a download after the wait ended is left alone');

  const quit = manual(tmp('quit'), {});
  quit.watch.wait(A); quit.watch.wait(B);
  quit.watch.stopAll();
  assert.deepEqual(quit.watch.waiting(), []);
  assert.deepEqual(quit.told.filter(([, on]) => !on).map(([key]) => key).sort(), ['PAPERA01', 'PAPERB01']);
});

/* ------------------------------------------------------------------------------------- end to end, through the IPC */

async function app(t, name) {
  const root = path.join(tmp(name), '.zotero');
  mirrorOf(root);
  const downloads = tmp(`${name}-downloads`);
  const w = await sources(t, {});
  const events = { waiting: [], downloaded: [], finding: [] };
  const library = createZoteroSync({
    api: 'http://127.0.0.1:9', root, account: () => ({ userID: USER_ID, key: KEY }), sleep: async () => {}, storageDir: tmp('storage'), now: () => NOW, ...w.sync,
    downloadsDir: () => downloads, downloadPollMs: 20,
    onWaiting: (key, on) => events.waiting.push([key, on]), onDownloaded: (key, copy) => events.downloaded.push([key, copy.path]), onFinding: (key, on) => events.finding.push([key, on]),
  });
  t.after(() => library.stopWatching());
  const zotero = { status: () => ({ configured: true, connected: true, username: 'r', userID: USER_ID, persisted: true, pending: null, error: '' }) };
  const handlers = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, trustedHandler: (fn) => async (event, ...args) => fn(...args), zotero, zoteroLibrary: library });
  const call = (n, ...args) => handlers.get(`engelbart:${n}`)({}, ...args);
  return { root, downloads, library, events, call, w };
}

test('a matching download: copied into the mirror as "downloaded in browser", opened, the download itself left where it was', async (t) => {
  const { root, downloads, library, events, call } = await app(t, 'match');
  const opened = await call('zotero-open', 'PAPERA01');
  assert.deepEqual(opened, { url: `https://doi.org/${DOI_A}`, external: true, waiting: true }, 'no pdf anywhere: its DOI in the browser, and waited for');
  const { zoteroChipAction } = await zoteroModel();
  assert.deepEqual(zoteroChipAction(opened), { external: `https://doi.org/${DOI_A}` }, 'the chip still opens it in the browser');
  assert.deepEqual(await call('zotero-waiting'), ['PAPERA01']);
  assert.deepEqual(await call('zotero-open', 'WEB00001'), { url: 'https://example.org/page', external: true }, 'a web page is not waited for');

  const download = path.join(downloads, 'barron-2026.pdf');
  const bytes = makePdf(['Behavioral Context for Adaptive', 'Tutoring at Scale', 'Ada Barron', `DOI: https://doi.org/${DOI_A}`]);
  fs.writeFileSync(download, bytes);
  assert.ok(await until(() => events.downloaded.length === 1), 'found within a few looks');
  const file = path.join(root, 'files', 'PAPERA01', 'Barron 2026 Behavioral Context for Adaptive Tutoring at Scale.pdf');
  assert.deepEqual(events.downloaded, [['PAPERA01', file]], 'told, to open it in the Stage and bring the app forward');
  assert.deepEqual(events.waiting, [['PAPERA01', true], ['PAPERA01', false]], 'the chip back to normal');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(download), bytes, 'the download is still there, as it was');
  assert.deepEqual(record(root, 'PAPERA01'), { v: 1, source: 'downloaded in browser', found: true, from: download, file, checkedAt: '2026-10-06T12:00:00.000Z' });
  assert.deepEqual(await call('zotero-waiting'), []);

  // From now on the chip opens it in the paper viewer, and Bart reads it, with its source.
  assert.deepEqual(await call('zotero-open', 'PAPERA01'), { path: file, source: 'downloaded in browser' });
  const block = await mirror.itemBlock(root, 'PAPERA01', TITLE_A, { openAccess: library.openAccess });
  assert.ok(block.lines.includes('attachment: none'));
  assert.ok(block.lines.includes(`pdf: ${file} (source="downloaded in browser": the person downloaded it in their browser on 2026-10-06, after Engelbart opened the item's page there)`), block.lines.join('\n'));
  assert.equal(block.file, file, 'its folder is granted to Bart');
  assert.deepEqual(keptCopy(root, 'PAPERA01'), { path: file, url: '', foundAt: '2026-10-06T12:00:00.000Z', source: 'downloaded in browser', via: 'downloaded in browser', from: download });
  assert.match(BART_SYSTEM_PROMPT, /source="downloaded in browser"/);
});

test('a download of another paper is left alone, and the paper is still waited for', async (t) => {
  const { root, downloads, events, call } = await app(t, 'nomatch');
  await call('zotero-open', 'PAPERA01');
  const other = path.join(downloads, 'other.pdf');
  fs.writeFileSync(other, makePdf(['Compilers: Principles and Practice', 'doi:10.9/other']));
  await sleep(300);
  assert.deepEqual(events.downloaded, []);
  assert.ok(!fs.existsSync(path.join(root, 'files', 'PAPERA01')), 'nothing copied');
  assert.ok(fs.existsSync(other), 'the other download untouched');
  assert.deepEqual(await call('zotero-waiting'), ['PAPERA01']);
  // Then the right one.
  fs.writeFileSync(path.join(downloads, 'right.pdf'), makePdf(['Behavioral Context for Adaptive Tutoring at Scale']));
  assert.ok(await until(() => events.downloaded.length === 1));
});

/* --------------------------------------------------------------------------------------------- a drop on the chip */

test('a pdf dropped on a chip is the item\'s pdf ("added by hand", no title check); a file that is not a pdf is refused', async (t) => {
  const { root, events, call, library } = await app(t, 'drop');
  await call('zotero-open', 'PAPERB01'); // waiting for its download
  const chosen = path.join(tmp('chosen'), 'anything at all.pdf');
  const bytes = makePdf(['Not even the same title']);
  fs.writeFileSync(chosen, bytes);
  const file = path.join(root, 'files', 'PAPERB01', 'Smith 2020 Learning to Learn.pdf');
  assert.deepEqual(await call('zotero-attach', 'PAPERB01', chosen), { path: file, source: 'added by hand' });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(chosen), bytes, 'the chosen file is copied, not moved');
  assert.deepEqual(record(root, 'PAPERB01'), { v: 1, source: 'added by hand', found: true, from: chosen, file, checkedAt: '2026-10-06T12:00:00.000Z' });
  assert.deepEqual(events.waiting, [['PAPERB01', true], ['PAPERB01', false]], 'its download is no longer waited for');
  assert.deepEqual(await call('zotero-open', 'PAPERB01'), { path: file, source: 'added by hand' });
  const block = await mirror.itemBlock(root, 'PAPERB01', TITLE_B, { openAccess: library.openAccess });
  assert.ok(block.lines.some((line) => line === `pdf: ${file} (source="added by hand": the person chose this file as the item's pdf on 2026-10-06)`), block.lines.join('\n'));

  // Not a pdf (whatever its name): refused, nothing written.
  const fake = path.join(tmp('fake'), 'paper.pdf');
  fs.writeFileSync(fake, '<html>not a pdf</html>');
  assert.match((await call('zotero-attach', 'PAPERA01', fake)).error, /not a PDF/);
  assert.match((await call('zotero-attach', 'PAPERA01', path.join(tmp('gone'), 'x.pdf'))).error, /could not be read/);
  assert.ok(!fs.existsSync(path.join(root, 'files', 'PAPERA01')));
  assert.ok(!fs.existsSync(path.join(root, 'items', 'PAPERA01', 'open-access.json')));
  await assert.rejects(async () => call('zotero-attach', 'PAPERA01', 'relative.pdf'), /absolute/);
  await assert.rejects(async () => call('zotero-attach', '../x', chosen), /invalid/);
});

/* ------------------------------------------------------------------------------------------------------ the chip */

test('the chip: "Waiting for your download…" with its hover text, a drop on it goes to onDropOnZotero, the download opens in the Stage', async () => {
  const filename = path.join(__dirname, '__DocEditor-zotero-dl-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  const DocEditor = compiled.exports.default;
  const chip = (key) => {
    const attrs = new Map([['title', 'Zotero']]);
    return { dataset: { mention: 'T', zotero: key }, hasAttribute: (n) => attrs.has(n), toggleAttribute: (n, on) => { if (on) attrs.set(n, ''); else attrs.delete(n); }, setAttribute: (n, v) => attrs.set(n, v), attrs };
  };
  const a = chip('PAPERA01'), b = chip('PAPERB01');
  const editor = new DocEditor({ docKey: 'k', text: '' });
  editor.props = { docKey: 'k', text: '', zoteroFinding: new Set(['PAPERB01']), zoteroWaiting: new Set(['PAPERA01', 'PAPERB01']) };
  editor.editorEl = () => ({ querySelectorAll: (sel) => (sel === '[data-zotero]' ? [a, b] : []) });
  editor.markFinding();
  assert.equal(a.attrs.has('data-waiting'), true);
  assert.equal(a.attrs.get('title'), "Opened in your browser. Download the PDF and it'll open here.");
  assert.equal(b.attrs.has('data-waiting'), false, 'finding a free copy says that instead');
  editor.props = { ...editor.props, zoteroWaiting: new Set() };
  editor.markFinding();
  assert.equal(a.attrs.has('data-waiting'), false, 'back to normal');
  assert.equal(a.attrs.get('title'), 'Zotero');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx'), 'utf8');
  assert.match(source, /\[data-zotero\]\[data-waiting\]::after\{content:" · Waiting for your download…";color:#8f8f8f;font-style:italic\}/);

  // A drop of files on the chip: the first pdf's path, not the document's drop.
  const dropped = [], items = [];
  editor.props = { ...editor.props, pathForFile: (f) => `/Users/r/Downloads/${f.name}`, onDropOnZotero: (target, file) => { dropped.push([target, file]); }, onDropItems: (x) => { items.push(x); } };
  const onChip = { dataTransfer: { types: ['Files'], files: [{ name: 'notes.txt' }, { name: 'paper.pdf' }] }, target: { closest: (sel) => (sel === '[data-zotero]' ? a : null) } };
  editor.editorDrop(onChip);
  assert.deepEqual(dropped, [[{ key: 'PAPERA01', name: 'T' }, '/Users/r/Downloads/paper.pdf']]);
  assert.deepEqual(items, [], 'not added to the library');

  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  assert.match(preload, /onZoteroWaiting: \(callback\) => subscribe\('engelbart:zotero-waiting', callback\)/);
  assert.match(preload, /onZoteroDownloaded: \(callback\) => subscribe\('engelbart:zotero-downloaded', callback\)/);
  assert.match(preload, /zoteroAttach: invoke\('zotero-attach'\)/);
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(workspace, /api\.onZoteroDownloaded\(\(found\) => \{ if \(found && typeof found\.path === 'string'\) openZoteroPdf\(found\.path\); \}\)/);
  assert.match(workspace, /zoteroChipAction\(await api\.zoteroAttach\(key, file\)/);
  const index = fs.readFileSync(path.join(__dirname, '../src/main/index.cjs'), 'utf8');
  assert.match(index, /downloadsDir: \(\) => app\.getPath\('downloads'\)/);
  assert.match(index, /app\.on\('will-quit', \(\) => zoteroLibrary\.stopWatching\(\)\)/);
  assert.match(index, /app\.focus\(\{ steal: true \}\)/);
});
