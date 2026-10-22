'use strict';

// Chat's citations (2026-10-21): the shared fold and link (src/shared/passage-text.cjs, passage-link.cjs), the check
// against the sources (src/main/bart/cite.cjs), and a fake Chat answer that cites through it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { foldPassage, normalizePassage, matchPassage } = require('../src/shared/passage-text.cjs');
const { splitTarget, citeHref } = require('../src/shared/passage-link.cjs');
const { checkCitations, tidyAround } = require('../src/main/bart/cite.cjs');
const { createFakeBart } = require('../src/main/bart/ask.cjs');
const { answerText } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { createRunLog } = require('../src/main/bart/runlog.cjs');

/* ------------------------------------------------------------------ the fold */

test('normalizePassage: case, whitespace, quotes, dashes, ligatures, soft hyphens and a word broken at a line end', () => {
  assert.equal(normalizePassage('  The   Quick\n\tBrown  '), 'the quick brown');
  assert.equal(normalizePassage('“Smart” ‘tools’ ′'), '"smart" \'tools\' \'');
  assert.equal(normalizePassage('a – b — c − d'), 'a - b - c - d');
  assert.equal(normalizePassage('ﬁnd the ﬂow, eﬀort'), 'find the flow, effort');
  assert.equal(normalizePassage('con­struc­tion'), 'construction');
  assert.equal(normalizePassage('the construc-\n  tion of it'), 'the construction of it');
  assert.equal(normalizePassage('a well-known thing'), 'a well-known thing', 'a hyphen inside a line stays');
  assert.equal(normalizePassage('Section 3-\n4'), 'section 3- 4', 'only between letters');
});

test('foldPassage: every folded character maps back to the offset it came from', () => {
  const text = 'A ﬁne “day”';
  const { text: folded, map } = foldPassage(text);
  assert.equal(folded, 'a fine "day"');
  assert.equal(text[map[folded.indexOf('fine')]], 'ﬁ');
  assert.equal(map[folded.length - 1], text.length - 1);
});

test('matchPassage: across prefixes and markdown, hyphenation, and text with no spaces between its pieces', () => {
  const doc = '@bart why skip short notes?\nbart> It **skips** them because\nbart> they carry [no signal](https://x.y) at all';
  const [hit] = matchPassage(doc, 'It skips them because they carry no signal at all', { prefixes: true, markdown: true });
  assert.ok(hit && doc.slice(hit.start, hit.end).startsWith('It **skips**') && doc.slice(hit.start, hit.end).endsWith('at all'));
  assert.deepEqual(matchPassage(doc, 'It skips them because they carry'), [], 'without the options the prefixes and marks count');
  assert.equal(matchPassage('a well-\nknown result', 'well-known result').length, 1, 'a hyphenated word broken at a line');
  assert.equal(matchPassage('cellonecelltwo', 'cell one cell two').length, 1, 'pieces run together');
  assert.deepEqual(matchPassage('anything', '   '), []);
});

/* ------------------------------------------------------------------ the link */

test('splitTarget: old #find= and &to= links read as before; cite and counter in any order', () => {
  assert.deepEqual(splitTarget('/a/b.md#find=one%20two'), { address: '/a/b.md', find: 'one two', to: '' });
  assert.deepEqual(splitTarget('/a/b.md#find=one&to=two'), { address: '/a/b.md', find: 'one', to: 'two' });
  assert.deepEqual(splitTarget('/a/b.md#find=a&b'), { address: '/a/b.md', find: 'a&b', to: '' }, 'a literal & with no key after it is the words\'');
  assert.deepEqual(splitTarget('/a/b.md#find=a&to=b&c'), { address: '/a/b.md', find: 'a&to=b&c', to: '' }, 'as before');
  assert.deepEqual(splitTarget('/a/b.md#to=x&find=y'), { address: '/a/b.md#to=x&find=y', find: '', to: '' }, 'no find first and no cite: the address\'s, as before');
  const cite = { address: '/a/My Note.md', find: 'search & rank', to: '', cite: 'you', counter: false };
  assert.deepEqual(splitTarget('/a/My%20Note.md#find=search%20%26%20rank&cite=you'), cite);
  assert.deepEqual(splitTarget('/a/My%20Note.md#cite=you&find=search%20%26%20rank'), cite, 'cite before find');
  assert.deepEqual(splitTarget('/a/b.md#find=x%20y&to=z&cite=other&counter=1'), { address: '/a/b.md', find: 'x y', to: 'z', cite: 'other', counter: true });
  assert.deepEqual(splitTarget('/a/b.md#find=x%20y&counter=1&cite=source&to=z'), { address: '/a/b.md', find: 'x y', to: 'z', cite: 'source', counter: true }, 'any order');
  assert.deepEqual(splitTarget('/a/b.md#counter=1&find=x&cite=source'), { address: '/a/b.md', find: 'x', to: '', cite: 'source', counter: true });
  assert.equal(splitTarget('/a/b.md#find=x&cite=nobody').cite, '', 'an unknown cite is none');
  assert.equal(citeHref({ address: '/a/My Note (1).md', find: 'a & (b)', cite: 'you', counter: true }), '/a/My%20Note%20%281%29.md#find=a%20%26%20%28b%29&cite=you&counter=1', 'no parenthesis ends the link early');
  assert.deepEqual(splitTarget(citeHref({ address: '/a/My Note (1).md', find: 'a & (b)', cite: 'you' })), { address: '/a/My Note (1).md', find: 'a & (b)', to: '', cite: 'you', counter: false });
  assert.equal(citeHref({ address: 'https://en.wikipedia.org/wiki/Hint_(education)', find: 'x', cite: 'source' }), 'https://en.wikipedia.org/wiki/Hint_%28education%29#find=x&cite=source');
});

/* ------------------------------------------------------------------ the check */

// A one-page PDF with the given lines of text, enough for pdf.js to read back (as test/context.test.cjs makes one).
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

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-cite-'));
const layout = ensureHome(homeDir);
let ctx, project, workspace, other, elsewhere, files, library;

const link = (label, address, find, cite, extra = {}) => `[${label}](${citeHref({ address, find, cite, ...extra })})`;
const check = (body, options = {}) => checkCitations(body, { library, dataRoot: ctx.dataRoot, projectId: project.id, workspaceId: workspace.id, ...options });

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, { name: 'Citing', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-cite-code-')) });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Agents' });
  other = await projects.createWorkspace(ctx, project.id, { name: 'Planning' });
  const otherProject = await projects.createProject(ctx, { name: 'Elsewhere' });
  elsewhere = await projects.createWorkspace(ctx, otherProject.id, { name: 'Theirs' });
  await projects.writeDoc(ctx, otherProject.id, { kind: 'workspace', workspaceId: elsewhere.id }, 'their own private thinking about tutors\n');
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id }, [
    '@bart should the tutor wait before hinting?',
    'bart> Yes, waiting **ten seconds** before a hint lets the learner retry first.',
    'I agree, but make it five seconds for beginners in the pilot.',
  ].join('\n'));
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, '@bart what did we decide about hints?\nbart~> q1\n');
  const assets = path.join(ctx.dataRoot, 'assets');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-cite-lib-'));
  files = {
    note: path.join(dir, 'Hints note.md'),
    chat: path.join(assets, 'md', randomUUID(), 'Tutor chat.md'),
    pdf: path.join(dir, 'TutorTrace.pdf'),
    page: path.join(assets, 'pages', randomUUID(), 'index.html'),
    folder: path.join(dir, 'Interviews'),
    outside: path.join(dir, 'Stray.md'),
    memory: path.join(ctx.dataRoot, 'MEMORY.md'),
    catalog: path.join(path.dirname(projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir), '.context', 'catalog.json'),
  };
  for (const file of Object.values(files)) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(files.note, '# Hints\n\nI think the tutor should “wait” before the ﬁrst hint — learners need to struggle a little.\n');
  fs.writeFileSync(files.chat, '*ChatGPT · 2026-09-02 · Citing*\n\n**You:** how long should a tutor wait before hinting?\n\n**ChatGPT:** Most systems wait between five and fifteen seconds before offering a hint.\n\nThat range comes from studies of help abuse.\n\n**You:** I will start with ten seconds then.\n');
  fs.writeFileSync(files.pdf, makePdf(['Learners who waited for hints retained more', 'of the material a week later.']));
  fs.writeFileSync(files.page, '<html><head><title>x</title></head><body><p>Productive struggle means letting <b>students</b> wrestle with a problem.</p></body></html>');
  fs.mkdirSync(files.folder, { recursive: true });
  fs.writeFileSync(path.join(files.folder, 'P3.md'), 'P3 said the hints came far too early for her.\n');
  fs.writeFileSync(files.outside, 'this note is not in the library at all\n');
  fs.writeFileSync(files.memory, 'the person prefers short waits before hints\n');
  fs.writeFileSync(files.catalog, '{"summary": "a catalog summary of hints and waits"}');
  const add = (fields) => ctx.libraryDb.insert({ id: randomUUID(), project_id: project.id, tags: [], ...fields });
  await add({ name: 'Hints note', type: 'md', path: files.note });
  await add({ name: 'Tutor chat', type: 'md', path: files.chat });
  await add({ name: 'TutorTrace', type: 'pdf', tags: ['paper'], path: files.pdf });
  await add({ name: 'Productive struggle', type: 'html', path: files.page, url: 'https://example.org/struggle' });
  await add({ name: 'Interviews', type: 'folder', path: files.folder });
  library = await ctx.libraryDb.list();
});

test('checkCitations: a body with no citation, and ordinary links, come back as they were', async () => {
  const plain = 'No sources here. A [plain link](https://example.org) and a [passage](/a/b.pdf#find=some%20words).';
  assert.deepEqual(await check(plain), { body: plain, kept: [], dropped: [] });
});

test('checkCitations: exact and normalized quotes are kept; a missing quote is taken out with its sentence intact', async () => {
  const body = [
    `Wait first ${link('You · Oct 12', files.note, 'I think the tutor should "wait" before the first hint', 'you')}.`,
    `You also said ${link('You · Oct 13', files.note, 'learners never need to struggle at all', 'you')}, which matters.`,
    '```',
    `${link('In code', files.note, 'nothing', 'you')}`,
    '```',
  ].join('\n');
  const out = await check(body);
  const lines = out.body.split('\n');
  assert.ok(lines[0].startsWith('Wait first [You · Oct 12]('), 'kept, curly quotes, the ligature and the dash folded');
  assert.equal(lines[1], 'You also said, which matters.', 'the link is gone, the sentence kept and tidied');
  assert.equal(lines[3], `${link('In code', files.note, 'nothing', 'you')}`, 'a fenced block is not read');
  assert.deepEqual(out.kept.map((k) => [k.label, k.cite, k.source, k.relabeled]), [['You · Oct 12', 'you', 'Hints note', false]]);
  assert.deepEqual(out.dropped, [{ label: 'You · Oct 13', address: files.note, reason: 'not-found' }]);
});

test('checkCitations: an unknown path, MEMORY.md, a catalog, a file outside the library and another project\'s workspace are dropped', async () => {
  const theirs = path.join(projects.findWorkspace(ctx, (await projects.listProjects(ctx)).find((p) => p.name === 'Elsewhere').id, elsewhere.id).workspace.dir, 'workspace.md');
  const body = [
    `A ${link('You', '/nowhere/at/all.md', 'some words that are here', 'you')}.`,
    `B ${link('You', files.memory, 'the person prefers short waits', 'you')}.`,
    `C ${link('You', files.catalog, 'a catalog summary of hints', 'other')}.`,
    `D ${link('You', files.outside, 'this note is not in', 'you')}.`,
    `E ${link('You', theirs, 'their own private thinking about tutors', 'you')}.`,
  ].join('\n');
  const out = await check(body);
  assert.equal(out.body, 'A.\nB.\nC.\nD.\nE.');
  assert.deepEqual(out.dropped.map((d) => d.reason), ['unresolved', 'memory', 'catalog', 'unresolved', 'other-project']);
  assert.deepEqual(out.kept, []);
});

test('checkCitations: an imported chat\'s assistant turn is someone else\'s words; the person\'s turn stays theirs', async () => {
  const body = `Ten seconds is common ${link('You · Sep 2', files.chat, 'That range comes from studies of help abuse', 'you')}, and you chose it ${link('You · Sep 2', files.chat, 'I will start with ten seconds then', 'you')}.`;
  const out = await check(body);
  assert.deepEqual(out.kept.map((k) => [k.label, k.cite, k.relabeled]), [['ChatGPT · Sep 2', 'other', true], ['You · Sep 2', 'you', false]]);
  assert.match(out.body, /\[ChatGPT · Sep 2\]\([^)]*&cite=other\)/, 'the link says so too');
  assert.match(out.body, /\[You · Sep 2\]\([^)]*&cite=you\)\.$/);
});

test('checkCitations: a workspace\'s lines: the person\'s stay `you`, an answer line is `other`, found despite prefixes and marks', async () => {
  const doc = path.join(projects.findWorkspace(ctx, project.id, other.id).workspace.dir, 'workspace.md');
  const body = `Chat proposed ten ${link('You · Oct 1', doc, 'waiting ten seconds before a hint lets the learner retry', 'you')}; you changed it ${link('You · Oct 1', doc, 'make it five seconds for beginners', 'you')}. You asked ${link('You · Oct 1', doc, 'should the tutor wait before hinting', 'you')}.`;
  const out = await check(body);
  assert.deepEqual(out.kept.map((k) => [k.label, k.cite, k.source]), [['Chat · Oct 1', 'other', 'Planning'], ['You · Oct 1', 'you', 'Planning'], ['You · Oct 1', 'you', 'Planning']]);
  assert.equal(out.dropped.length, 0);
});

test('checkCitations: a quote with parentheses is checked whether or not they were encoded, and comes back encoded', async () => {
  const words = 'the tutor should (at first) wait';
  fs.writeFileSync(files.note, `${fs.readFileSync(files.note, 'utf8')}\nSo the tutor should (at first) wait, then hint.\n`);
  const raw = `[You · Oct 14](${files.note.split('/').map(encodeURIComponent).join('/')}#find=${encodeURIComponent(words)}&cite=you)`;
  const spaced = `[You · Oct 14](${files.note}#find=${words}&cite=you)`;
  const wrong = `[You · Oct 15](${files.note}#find=the tutor should (never) wait&cite=you)`;
  const out = await check(`One ${raw}. Two ${link('You · Oct 14', files.note, words, 'you')}. Three ${spaced}. Four ${wrong}.`);
  assert.equal(out.kept.length, 3, 'all three spellings are seen and confirmed');
  assert.deepEqual(out.dropped.map((d) => d.reason), ['not-found'], 'one that is not there is seen too, and taken out');
  const kept = link('You · Oct 14', files.note, words, 'you');
  assert.equal(out.body, `One ${kept}. Two ${kept}. Three ${kept}. Four.`, 'each written so the editor reads it as one link');
  assert.ok(!/\]\([^)]*\(/.test(out.body), 'no parenthesis inside a link target');
});

test('checkCitations: words the person repeated from an answer stay theirs; words only in answers are Chat\'s', async () => {
  const space = await projects.createWorkspace(ctx, project.id, { name: 'Builds' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: space.id }, [
    '@bart what should the first build be?',
    'bart+> Build: Ask about the project before Connect your library on the first screen.',
    '@bart --build Ask about the project before Connect your library on the first screen.',
    'bart> Sure, and keep the previews sleeping rather than deleted.',
  ].join('\n'));
  const doc = path.join(projects.findWorkspace(ctx, project.id, space.id).workspace.dir, 'workspace.md');
  fs.writeFileSync(files.chat, `${fs.readFileSync(files.chat, 'utf8')}\n**ChatGPT:** Start with ten seconds then.\n`);
  const out = await check([
    `You asked for it ${link('You · Oct 20', doc, 'Ask about the project before Connect your library', 'you')}.`,
    `Chat said ${link('You · Oct 20', doc, 'keep the previews sleeping rather than deleted', 'you')}.`,
    `And ${link('You · Sep 2', files.chat, 'start with ten seconds then', 'you')}.`,
  ].join('\n'));
  assert.deepEqual(out.kept.map((k) => [k.label, k.cite, k.relabeled]), [['You · Oct 20', 'you', false], ['Chat · Oct 20', 'other', true], ['You · Sep 2', 'you', false]]);
});

test('checkCitations: a pdf and a saved web page are matched through their text; a file inside a library folder is citable', async () => {
  const body = [
    `Waiting helps ${link('TutorTrace p. 1', files.pdf, 'Learners who waited for hints retained more of the material', 'source')}.`,
    `By its address ${link('Productive struggle', 'https://example.org/struggle', 'letting students wrestle with a problem', 'source')}.`,
    `By its copy ${link('Productive struggle', files.page, 'Productive struggle means letting students', 'source')}.`,
    `P3 ${link('Interview · P3', path.join(files.folder, 'P3.md'), 'the hints came far too early', 'other', { counter: true })}.`,
  ].join('\n');
  const out = await check(body);
  assert.deepEqual(out.dropped, []);
  assert.deepEqual(out.kept.map((k) => [k.source, k.cite, k.counter]), [['TutorTrace', 'source', false], ['Productive struggle', 'source', false], ['Productive struggle', 'source', false], ['P3.md', 'other', true]]);
  assert.equal(out.kept[1].address, 'https://example.org/struggle');
});

test('checkCitations: nothing readable is no-text; the conversation being answered is not a source', async () => {
  const empty = path.join(files.folder, 'empty.md');
  fs.writeFileSync(empty, '');
  const here = path.join(projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir, 'workspace.md');
  const body = `X ${link('You', empty, 'one two three four', 'you')}. Y ${link('You · today', here, 'what did we decide about hints', 'you')}.`;
  const out = await check(body, { currentThread: [{ question: 'what did we decide about hints?' }] });
  assert.equal(out.body, 'X. Y.');
  assert.deepEqual(out.dropped.map((d) => d.reason), ['no-text', 'current-thread']);
  const kept = await check(body, { currentThread: [{ question: 'something else entirely' }] });
  assert.equal(kept.kept.length, 1, 'the same line, when it is not the thread being answered');
});

test('tidyAround: a link taken out leaves no doubled space, no space before punctuation, no empty brackets', () => {
  assert.equal(tidyAround('A claim [x](y) here.', 8, 14), 'A claim here.');
  assert.equal(tidyAround('A claim [x](y).', 8, 14), 'A claim.');
  assert.equal(tidyAround('A claim ([x](y)), more.', 9, 15), 'A claim, more.');
});

/* ------------------------------------------------------------------ a fake Chat answer */

const MODELS = normalizeModels({ providers: { claude: { steps: [{ name: 'Sol', model: 'sol', effort: 'medium' }, { name: 'Sol', model: 'sol', effort: 'high' }] } } });

test('a fake Chat answer citing one good and one bad passage: one citation kept, one dropped and logged; the thread is the checked body', async () => {
  const runLog = createRunLog();
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 2, runLog });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const out = await bart.ask(ctx, project.id, { askId: 'c1', ref, workspaceId: workspace.id, text: 'cite what I wrote', agent: 'bart' });
  const body = out.lines.map((line) => line.replace(/^bart> ?/, '')).join('\n');
  assert.equal((body.match(/&cite=/g) || []).length, 1, 'one citation is left');
  assert.match(body, /You wrote this down before \[You · Oct 12\]\(/);
  assert.match(body, /And something else\./);
  const record = runLog.get('c1');
  assert.equal(record.citations.kept.length, 1);
  assert.deepEqual(record.citations.dropped.map((d) => d.reason), ['not-found']);
  // A follow-up finds the session the checked answer was kept under.
  const answer = answerText(out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n'));
  assert.ok(!answer.includes('never says anywhere'));
  const next = await bart.ask(ctx, project.id, { askId: 'c2', ref, workspaceId: workspace.id, text: 'and then?', turns: [{ question: 'cite what I wrote', answer }], agent: 'bart' });
  assert.match(next.lines.join('\n'), /the same session, given the question alone/);
});

test('a fake Build reply is not checked', async () => {
  const runLog = createRunLog();
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 2, runLog });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const out = await bart.ask(ctx, project.id, { askId: 'b1', ref, workspaceId: workspace.id, text: 'cite and build it', agent: 'bart', routed: { id: 'r1', build: true } });
  assert.equal((out.lines.join('\n').match(/&cite=/g) || []).length, 2, 'both citations as they came');
  assert.equal(runLog.get('b1').citations, undefined);
});

test('only Chat\'s own answers are checked: not a Build\'s, Brainstorm\'s, Discover\'s or Create\'s', () => {
  const { citesChecked } = require('../src/main/bart/ask.cjs');
  assert.equal(citesChecked('bart', null), true);
  assert.equal(citesChecked('bart', { id: 'r1' }), true, 'a routed answer that is no Build');
  assert.equal(citesChecked('bart', { id: 'r1', build: true }), false);
  for (const agent of ['brainstorm', 'discover', 'create', 'orient']) assert.equal(citesChecked(agent, null), false, agent);
});
