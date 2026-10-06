'use strict';

// @bart on a highlight (MATH-27 phase 1, 2026-10-06), the main process's side: a question asked from a note on a pdf's
// highlight names its place as a mark ({ kind: 'mark', id, rowId | url, page }), which ipc's docRef takes and keys as no
// note, projects' cleanDocRef keeps on the agent's row, and bart/context.cjs buildContext turns into a <highlight> block
// with the workspace as background. A follow-up sends the mark's answers as its turns, as the Stage keeps them
// (src/renderer/pdf/canvas.js askEntry), and so finds the same session (ask.cjs threadKey).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { docRef, docKeyOf, highlightInput } = require('../src/main/ipc.cjs');
const { buildContext, highlightBlock } = require('../src/main/bart/context.cjs');
const { createFakeBart, threadKey } = require('../src/main/bart/ask.cjs');
const { replyLines, answerText } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

const loadCanvas = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/canvas.js')).href);
const MODELS = { ...normalizeModels(null), provider: 'openai' };
const ROW = '3f0a6c1e-6b1d-4a57-9a51-1c2b3d4e5f60';

/* ------------------------------------------------------------------------------------------------ docRef, docKeyOf */

test('docRef takes a mark on a library pdf or on an address, its page a page number; docKeyOf keys it as no note', () => {
  assert.deepEqual(docRef({ kind: 'mark', id: 'm17a2b3c', rowId: ROW, page: 3 }), { kind: 'mark', id: 'm17a2b3c', rowId: ROW, page: 3 });
  assert.deepEqual(docRef({ kind: 'mark', id: 'm1', url: 'https://arxiv.org/pdf/2401.00001', page: 1, extra: 'dropped' }), { kind: 'mark', id: 'm1', url: 'https://arxiv.org/pdf/2401.00001', page: 1 });
  for (const bad of [
    { kind: 'mark', id: 'm1', page: 1 }, // neither
    { kind: 'mark', id: 'm1', rowId: ROW, url: 'https://x.y/a.pdf', page: 1 }, // both
    { kind: 'mark', id: 'm1', rowId: ROW, page: 0 },
    { kind: 'mark', id: 'm1', rowId: ROW, page: 1.5 },
    { kind: 'mark', id: 'm1', rowId: ROW, page: '2' },
    { kind: 'mark', id: 'm 1', rowId: ROW, page: 1 },
    { kind: 'mark', id: 'x'.repeat(65), rowId: ROW, page: 1 },
    { kind: 'mark', id: 'm1', url: 'x'.repeat(8193), page: 1 },
    { kind: 'mark', id: 'm1', rowId: 7, page: 1 },
  ]) assert.throws(() => docRef(bad), TypeError, JSON.stringify(bad).slice(0, 80));
  assert.equal(docKeyOf({ kind: 'mark', id: 'm1', rowId: ROW, page: 1 }), 'mark:m1');
  assert.equal(docKeyOf({ kind: 'note', id: 'n1' }), 'note:n1');
  assert.equal(docKeyOf({ kind: 'workspace', workspaceId: 'w1' }), 'ws:w1');
  // Notes and workspaces as before.
  assert.deepEqual(docRef({ kind: 'note', id: 'n1' }), { kind: 'note', id: 'n1' });
  assert.throws(() => docRef({ kind: 'page', id: 'p' }), /Unknown doc kind/);
});

test('highlightInput: the passage, the note and the paper\'s name, bounded; missing ones are empty', () => {
  assert.deepEqual(highlightInput({ quote: 'κ = 0.79', note: '@bart why?', paper: 'TutorTrace' }), { quote: 'κ = 0.79', note: '@bart why?', paper: 'TutorTrace' });
  assert.deepEqual(highlightInput(null), { quote: '', note: '', paper: null });
  assert.throws(() => highlightInput({ quote: 'x'.repeat(20001) }), TypeError);
  assert.throws(() => highlightInput({ note: 3 }), TypeError);
});

/* ------------------------------------------------------------------------------------------------ with the store */

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-highlight-'));
const layout = ensureHome(homeDir);
let ctx, project, workspace, paperPath, paperId;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-highlight-code-'));
  project = await projects.createProject(ctx, { name: 'Reading', directory: code });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'TutorTrace notes' });
  const papers = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-highlight-papers-'));
  paperPath = path.join(papers, 'tutortrace.pdf');
  fs.writeFileSync(paperPath, '%PDF-1.4\n');
  paperId = randomUUID();
  await ctx.libraryDb.insert({ id: paperId, name: 'TutorTrace', project_id: project.id, tags: ['paper'], type: 'pdf', path: paperPath });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'What do the labels mean?\n@bart earlier?\nbart> An earlier answer.\n');
});
test.after(async () => { await db.closeAll(); });

test('cleanDocRef keeps a mark (by library row or by address) on the agent\'s row, so the ask is still tracked; junk is dropped', () => {
  const { cleanDocRef } = projects;
  assert.deepEqual(cleanDocRef({ kind: 'mark', id: 'm1', rowId: ROW, page: 2 }), { kind: 'mark', id: 'm1', rowId: ROW, page: 2 });
  assert.deepEqual(cleanDocRef({ kind: 'mark', id: 'm1', url: 'https://x.y/a.pdf', page: 1, quote: 'not kept' }), { kind: 'mark', id: 'm1', url: 'https://x.y/a.pdf', page: 1 });
  for (const bad of [{ kind: 'mark', id: 'm1', page: 2 }, { kind: 'mark', id: 'm1', rowId: 'not-a-uuid', page: 2 }, { kind: 'mark', id: 'm 1', rowId: ROW, page: 2 }, { kind: 'mark', id: 'm1', rowId: ROW, page: 0 }, { kind: 'mark', id: 'm1', url: '', page: 1 }]) {
    assert.equal(cleanDocRef(bad), null, JSON.stringify(bad));
  }
  const doc = { kind: 'mark', id: 'm9', rowId: paperId, page: 4 };
  projects.agentStarted(ctx, { id: 'hl-ask', kind: 'bart', projectId: project.id, workspaceId: workspace.id, doc });
  let agent = projects.readNav(ctx).agents.find((a) => a.id === 'hl-ask');
  assert.deepEqual([agent.status, agent.workspaceId, agent.doc], ['running', workspace.id, doc], 'running, in the workspace it was asked from, with its mark');
  projects.agentFinished(ctx, 'hl-ask');
  agent = projects.readNav(ctx).agents.find((a) => a.id === 'hl-ask');
  assert.deepEqual([agent.status, agent.doc], ['waiting', doc], 'still its mark once it has answered');
  assert.equal(projects.seenAgents(ctx, project.id, workspace.id), 1);
});

test('a mark is no document: reading or writing one is refused', async () => {
  const ref = docRef({ kind: 'mark', id: 'm1', rowId: paperId, page: 1 });
  await assert.rejects(() => projects.readDoc(ctx, project.id, ref), /Unknown doc kind/);
  await assert.rejects(() => projects.writeDoc(ctx, project.id, ref, 'x'), /Unknown doc kind/);
});

test('buildContext from a highlight on a library pdf: the workspace as background, then <highlight> with the paper, its path, the page, the passage and the note', async () => {
  const ref = { kind: 'mark', id: 'm1', rowId: paperId, page: 6 };
  const c = await buildContext(ctx, project.id, { ref, workspaceId: workspace.id, askId: 'h1', highlight: { quote: 'Cohen\'s κ was 0.79 overall', note: '@bart is that good?', paper: 'ignored: the library names it' } });
  assert.match(c.head, /\nasked from: a highlight on page 6 of "TutorTrace", opened from the workspace "TutorTrace notes"\n/);
  assert.equal(c.documents, `<workspace name="TutorTrace notes">\nWhat do the labels mean?\n@bart earlier?\nbart> An earlier answer.\n</workspace>\n\n<highlight paper="TutorTrace" path="${paperPath}" page="6">\n<quote>\nCohen's κ was 0.79 overall\n</quote>\n<note>\n@bart is that good?\n</note>\n</highlight>`);
  assert.ok(!c.documents.includes('<<<'), 'no line of the workspace is where it was asked');
  const entries = JSON.parse(c.contextJson.replace(/^<context_json>\n|\n<\/context_json>$/g, ''));
  assert.deepEqual(entries.filter((e) => e.mentioned).map((e) => e.name), ['TutorTrace'], 'the paper is what the person points at');
  assert.ok(c.dirs.includes(path.dirname(paperPath)), 'its folder can be read');
});

test('buildContext from a highlight on an address: a file:// address is given as its path (its folder granted), a web one as it is', async () => {
  const loose = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-highlight-loose-')), 'Some Paper.pdf');
  fs.writeFileSync(loose, '%PDF-1.4\n');
  const local = await buildContext(ctx, project.id, { ref: { kind: 'mark', id: 'm2', url: pathToFileURL(loose).href, page: 1 }, workspaceId: workspace.id, askId: 'h2', highlight: { quote: 'q', note: '' } });
  assert.match(local.documents, new RegExp(`<highlight paper="Some Paper\\.pdf" path="${loose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" page="1">\\n<quote>\\nq\\n</quote>\\n<note>\\n\\n</note>\\n</highlight>$`));
  assert.ok(local.dirs.includes(path.dirname(loose)), 'a pdf the library does not hold can be read too');
  const web = await buildContext(ctx, project.id, { ref: { kind: 'mark', id: 'm3', url: 'https://arxiv.org/pdf/2401.00001v2', page: 2 }, workspaceId: workspace.id, askId: 'h3', highlight: { quote: 'q', note: 'n', paper: 'Scim' } });
  assert.match(web.head, /asked from: a highlight on page 2 of "Scim", opened from the workspace "TutorTrace notes"/);
  assert.match(web.documents, /<highlight paper="Scim" path="https:\/\/arxiv\.org\/pdf\/2401\.00001v2" page="2">/);
  assert.equal(highlightBlock({ name: 'A "quoted"\nname', where: '/p/a.pdf' }, 3, { quote: ' x ', note: '' }), '<highlight paper="A  quoted  name" path="/p/a.pdf" page="3">\n<quote>\nx\n</quote>\n<note>\n\n</note>\n</highlight>');
});

test('a follow-up on the same mark sends its answers as the turns, as the Stage keeps them, and resumes the same session', async () => {
  const { askEntry, turnsOf } = await loadCanvas();
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 4 });
  const ref = { kind: 'mark', id: 'm4', rowId: paperId, page: 2 };
  const highlight = { quote: 'the passage', note: '@bart why?', paper: 'TutorTrace' };
  const first = await bart.ask(ctx, project.id, { askId: 'f1', ref, workspaceId: workspace.id, text: 'why?', turns: [], highlight });
  assert.match(first.lines[0], /^bart> FAKE ANSWER to "why\?"/);
  const mark = { id: 'm4', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.015 }], note: '@bart why?', asks: [askEntry({ id: 'f1', question: 'why?', lines: first.lines, meta: first.meta, at: '2026-10-06T10:00:00.000Z' })] };
  assert.equal(mark.asks[0].answer, answerText(first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n')), 'the answer as a document would hold it');
  const second = await bart.ask(ctx, project.id, { askId: 'f2', ref, workspaceId: workspace.id, text: 'and then?', turns: turnsOf(mark), highlight: { ...highlight, note: '@bart and then?' } });
  assert.match(second.lines.join('\n'), /the same session, given the question alone/);
  // Another mark is another exchange.
  assert.notEqual(threadKey(project.id, ref, turnsOf(mark)), threadKey(project.id, { ...ref, id: 'm5' }, turnsOf(mark)));
});

test('after an answer is deleted from the mark, the next question still resumes the same session (follow-up, 2026-10-06)', async () => {
  const { askEntry, turnsOf, shownAsks } = await loadCanvas();
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 4 });
  const ref = { kind: 'mark', id: 'm6', rowId: paperId, page: 2 };
  const highlight = { quote: 'the passage', note: '@bart why?', paper: 'TutorTrace' };
  const mark = { id: 'm6', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.015 }], note: '@bart why?', asks: [] };
  const first = await bart.ask(ctx, project.id, { askId: 'd1', ref, workspaceId: workspace.id, text: 'why?', turns: turnsOf(mark), highlight });
  mark.asks.push(askEntry({ id: 'd1', question: 'why?', lines: first.lines, meta: first.meta, at: new Date().toISOString() }));
  const second = await bart.ask(ctx, project.id, { askId: 'd2', ref, workspaceId: workspace.id, text: 'and then?', turns: turnsOf(mark), highlight });
  mark.asks.push(askEntry({ id: 'd2', question: 'and then?', lines: second.lines, meta: second.meta, at: new Date().toISOString() }));
  mark.asks[0].deleted = true; // Delete on the first answer's box (PaperView askClick)
  assert.deepEqual(shownAsks(mark).map((a) => a.id), ['d2']);
  const third = await bart.ask(ctx, project.id, { askId: 'd3', ref, workspaceId: workspace.id, text: 'so?', turns: turnsOf(mark), highlight });
  assert.match(third.lines.join('\n'), /the same session, given the question alone/);
});

test('askEntry reads an answer\'s lines back to the text main keeps the session under, and its foot', async () => {
  const { askEntry, answerOf } = await loadCanvas();
  const meta = { provider: 'anthropic', level: { name: 'Sonnet', effort: 'high', model: 'claude-sonnet-5-5' }, trail: [], ms: 4200, pinned: false };
  const body = 'It is **good**: p. 6 reports κ = 0.79.\n\n- one\n\n```js\nx\n```';
  const lines = replyLines(body, meta);
  assert.deepEqual(answerOf(lines), { answer: answerText(body), foot: 'Sonnet · high · 4 s' });
  const entry = askEntry({ id: 'a1', question: '  why?  ', lines, meta, at: 'now' });
  assert.deepEqual(entry, { id: 'a1', question: 'why?', answer: answerText(body), meta: { provider: 'anthropic', name: 'Sonnet', effort: 'high', ms: 4200, foot: 'Sonnet · high · 4 s' }, at: 'now', pos: null, collapsed: false });
});
