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
const { docRef, docKeyOf, highlightInput, turnsInput, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const library = require('../src/main/store/library.cjs');
const { clipMiddle } = require('../src/main/bart/clip.cjs');
const { buildContext, highlightBlock } = require('../src/main/bart/context.cjs');
const { createFakeBart, threadKey, cleanTurns } = require('../src/main/bart/ask.cjs');
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

test('highlightInput: the passage, the note, the paper\'s name and the page\'s text, bounded; missing ones are empty', () => {
  assert.deepEqual(highlightInput({ quote: 'κ = 0.79', note: '@bart why?', paper: 'TutorTrace', pageText: 'Results. κ = 0.79 overall.' }), { quote: 'κ = 0.79', note: '@bart why?', paper: 'TutorTrace', pageText: 'Results. κ = 0.79 overall.' });
  assert.deepEqual(highlightInput(null), { quote: '', note: '', paper: null, pageText: '' });
  assert.throws(() => highlightInput({ pageText: 5 }), TypeError);
  const page = highlightInput({ pageText: 'p'.repeat(9000) }).pageText;
  assert.ok(page.length <= 8000 && /characters cut/.test(page), 'the page text is bounded too, cut in the middle');
  assert.throws(() => highlightInput({ quote: 7 }), TypeError);
  assert.throws(() => highlightInput({ note: 3 }), TypeError);
});

/* ------------------------------------------------------------------------------------------------ long passages (second pass, 2026-10-06) */

test('a passage past 20,000 characters is asked about with its start and end and the cut marked, not refused; so is an earlier turn past its cap', () => {
  const start = 'We present TutorTrace. ', end = ' Together, these findings show it.';
  const passage = start + 'x'.repeat(59950) + end; // a selection across many pages (marks.js passageOf has no cap)
  const { quote } = highlightInput({ quote: passage, note: '@bart sum up' });
  assert.ok(quote.length <= 20000, `${quote.length}`);
  assert.ok(quote.startsWith(start) && quote.endsWith(end), 'its start and its end');
  const cut = quote.match(/\n\[… ([\d,]+) characters cut …\]\n/);
  assert.ok(cut, 'the cut is marked');
  assert.equal(Number(cut[1].replace(/,/g, '')), passage.length - (quote.length - cut[0].length), 'with how much was left out');
  assert.equal(highlightInput({ quote: 'y'.repeat(20000) }).quote, 'y'.repeat(20000), 'one that fits is as it was');

  const answer = 'First, the labels. ' + 'z'.repeat(60000) + ' So: it is good.';
  const [turn] = turnsInput([{ question: 'why?', answer }]);
  assert.ok(turn.answer.length <= 40000 && turn.answer.startsWith('First, the labels.') && turn.answer.endsWith('So: it is good.') && /characters cut/.test(turn.answer));
  assert.equal(turnsInput([{ question: 'q'.repeat(9000), answer: 'a' }])[0].question.length, 8000);
  assert.throws(() => turnsInput([{ question: 'why?' }]), TypeError, 'an answer still has to be a string');
  assert.equal(turnsInput(Array.from({ length: 50 }, (_, i) => ({ question: `q${i}`, answer: '' }))).length, 40);
  // What a session is told: an earlier answer past 20,000 keeps its end too (before, its start alone).
  const told = cleanTurns([{ question: ' why? ', answer: turn.answer }])[0];
  assert.ok(told.answer.length <= 20000 && told.answer.startsWith('First, the labels.') && told.answer.endsWith('So: it is good.'));
  assert.equal(told.question, 'why?');
  // Nothing past a pair of surrogates' halves.
  const emoji = clipMiddle('😀'.repeat(30), 41);
  assert.ok(emoji.length <= 41 && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji), JSON.stringify(emoji));
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
  // The page around the passage (2026-10-06): inside <highlight>, after the note; none when there is no text.
  const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
  assert.match(BART_SYSTEM_PROMPT, /in <page_text> the text of that page around the passage/, 'Bart is told the page comes with it');
  assert.match(BART_SYSTEM_PROMPT, /do not open the PDF just to see that page/);
  assert.equal(highlightBlock({ name: 'P', where: '/p/a.pdf' }, 3, { quote: 'x', note: 'n', pageText: '\nResults. x and y.\n' }), '<highlight paper="P" path="/p/a.pdf" page="3">\n<quote>\nx\n</quote>\n<note>\nn\n</note>\n<page_text>\nResults. x and y.\n</page_text>\n</highlight>');
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

/* ------------------------------------------------------------------------------------------------ ⌘R while it runs (second pass, 2026-10-06) */

// The ipc's ask-bart and running-paper-asks with a Bart that waits to be let go, a caller window, and what is told to
// every window (announce) and to the window that asked (reply).
function asking({ fail = null } = {}) {
  const handlers = new Map(), told = [], replies = [], asked = [];
  let go, caller = { id: 'w1' };
  const gate = new Promise((resolve) => { go = resolve; });
  const bart = {
    async ask(c, pid, question, { onProgress }) {
      asked.push(question);
      onProgress({ step: 1, name: 'Sonnet', effort: 'high', movedUp: false });
      onProgress({ activity: 'Reading', log: true });
      await gate;
      if (fail) throw fail;
      return { lines: ['bart> It is **good**: κ = 0.79.', '', '*Sonnet · high · 3 s*'], meta: { provider: 'anthropic', level: { name: 'Sonnet', effort: 'high', model: 'claude-sonnet-5-5' }, trail: [], ms: 3000, pinned: false } };
    },
    stop: () => true,
  };
  registerEngelbartIpc({
    store: { context: async () => ctx }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {}, bart,
    windowHandler: (fn) => (...args) => fn(caller, ...args), reply: (win, channel, payload) => replies.push([win.id, channel, payload]), announce: (channel, payload, options) => told.push([channel, payload, options]),
  });
  const call = (name, ...args) => handlers.get(`engelbart:${name}`)(...args);
  return { call, told, replies, asked, go, from: (win) => { caller = win; } };
}
const settle = async () => { for (let n = 0; n < 5; n += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('main puts an answer from a highlight on its mark itself and tells every window, so it lands though the window that asked was reloaded; meanwhile that window can show its box again', async () => {
  const ink = { 3: [{ id: 'mR1', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.015 }], note: '@bart is that good?', text: 'κ = 0.79' }], 5: [{ id: 'other', rects: [], note: 'a note' }] };
  await library.writeAnnotations(ctx, paperId, ink);
  const a = asking();
  const ref = { kind: 'mark', id: 'mR1', rowId: paperId, page: 3 };
  const pending = a.call('ask-bart', project.id, { askId: 'hR1', ref, workspaceId: workspace.id, text: 'is that good?', turns: [], highlight: { quote: 'p'.repeat(30000), note: '@bart is that good?', paper: 'TutorTrace' } });
  await settle();
  assert.ok(a.asked[0].highlight.quote.length <= 20000 && /characters cut/.test(a.asked[0].highlight.quote), 'a long passage is asked about, cut');
  assert.deepEqual(a.replies.map(([win, channel, payload]) => [win, channel, payload.askId]), [['w1', 'engelbart:bart-progress', 'hR1'], ['w1', 'engelbart:bart-progress', 'hR1']], 'progress to the window that asked');
  // ⌘R: the window asks what it had running, and gets its box back as it stood.
  assert.deepEqual(await a.call('running-paper-asks', project.id), [{ step: 1, name: 'Sonnet', effort: 'high', movedUp: false, activity: 'Reading', lines: [], log: ['Reading'], askId: 'hR1', markId: 'mR1', page: 3, rowId: paperId, url: null, question: 'is that good?', agent: 'bart' }]);
  assert.deepEqual(await a.call('running-paper-asks', 'another-project'), []);
  a.from({ id: 'w2' });
  assert.deepEqual(await a.call('running-paper-asks', project.id), [], 'another window: it hears none of its progress');
  a.from({ id: 'w1' });

  a.go(); // the reloaded window's own ask never hears this answer: what main does with it is all there is
  const out = await pending;
  assert.deepEqual(out.entry, { id: 'hR1', question: 'is that good?', answer: 'It is **good**: κ = 0.79.', meta: { provider: 'anthropic', name: 'Sonnet', effort: 'high', ms: 3000, foot: 'Sonnet · high · 3 s' }, at: out.entry.at, pos: null, collapsed: false });
  assert.ok(!Number.isNaN(Date.parse(out.entry.at)));
  const kept = await library.readAnnotations(ctx, paperId);
  assert.deepEqual(kept[3][0].asks, [out.entry], 'on its mark in the ink kept for the pdf');
  assert.deepEqual(kept[5], ink[5], 'the rest as it was');
  assert.deepEqual(a.told, [['engelbart:paper-ask-done', { askId: 'hR1', markId: 'mR1', page: 3, rowId: paperId, url: null, entry: out.entry }, undefined]], 'every window is told, the one that asked too');
  assert.deepEqual(await a.call('running-paper-asks', project.id), []);
  // The Stage putting it there as well changes nothing; nor does main again.
  assert.equal(await library.addMarkAnswer(ctx, { rowId: paperId }, 3, 'mR1', out.entry), false);
  assert.equal(await library.addMarkAnswer(ctx, { rowId: paperId }, 3, 'gone', { ...out.entry, id: 'hR9' }), false, 'a mark deleted meanwhile takes nothing');
  assert.deepEqual((await library.readAnnotations(ctx, paperId))[3][0].asks.length, 1);
});

test('a failure or a Stop is told to every window as well (the reloaded window says "No answer", or drops its box); the ink is left alone', async () => {
  await library.writeAnnotations(ctx, paperId, { 2: [{ id: 'mF1', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.015 }], note: '@bart why?' }] });
  const ref = { kind: 'mark', id: 'mF1', rowId: paperId, page: 2 };
  const failing = asking({ fail: new Error('Claude Code did not return a result.') });
  const pending = failing.call('ask-bart', project.id, { askId: 'hF1', ref, workspaceId: workspace.id, text: 'why?', turns: [], highlight: { quote: 'q', note: '@bart why?' } });
  await settle();
  failing.go();
  const out = await pending;
  assert.deepEqual(out, { failed: true, lines: ['bart> **No answer.** Claude Code did not return a result.'] });
  assert.deepEqual(failing.told.map(([channel, payload]) => [channel, payload]), [['engelbart:paper-ask-done', { askId: 'hF1', markId: 'mF1', page: 2, rowId: paperId, url: null, ...out }]]);
  const stopped = Object.assign(new Error('Stopped.'), { kind: 'stopped' });
  const stopping = asking({ fail: stopped });
  const halted = stopping.call('ask-bart', project.id, { askId: 'hF2', ref, workspaceId: workspace.id, text: 'why?', turns: [], highlight: { quote: 'q', note: '' } });
  await settle();
  stopping.go();
  assert.deepEqual(await halted, { stopped: true });
  assert.deepEqual(stopping.told.map(([, payload]) => payload), [{ askId: 'hF2', markId: 'mF1', page: 2, rowId: paperId, url: null, stopped: true }]);
  assert.equal((await library.readAnnotations(ctx, paperId))[2][0].asks, undefined, 'no answer written');
  // A question from a document is no highlight's: nothing is kept for it or told.
  const doc = asking();
  const fromDoc = doc.call('ask-bart', project.id, { askId: 'dA1', ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, text: 'why?', turns: [] });
  await settle();
  assert.deepEqual(await doc.call('running-paper-asks', project.id), []);
  doc.go();
  assert.equal((await fromDoc).entry, undefined);
  assert.deepEqual(doc.told, []);
});

test('addMarkAnswer on a pdf kept by its address: once, in the ink the Stage reads for that address', async () => {
  const address = 'https://arxiv.org/pdf/2401.99999';
  await library.writePageAnnotations(ctx, address, { 1: [{ id: 'mU1', rects: [{ x: 0, y: 0, w: 0.2, h: 0.01 }], note: '@bart q' }] });
  const entry = { id: 'hU1', question: 'q', answer: 'A.', meta: {}, at: 'now', pos: null, collapsed: false };
  // A save from the Stage asked for just before goes first; the answer is added to what it wrote, not to what was there before.
  const saved = library.writePageAnnotations(ctx, address, { 1: [{ id: 'mU1', rects: [{ x: 0, y: 0, w: 0.2, h: 0.01 }], note: '@bart q', pos: { x: 1.2, y: 0 } }] });
  const added = library.addMarkAnswer(ctx, { url: address }, 1, 'mU1', entry);
  await Promise.all([saved, added]);
  const kept = await library.readPageAnnotations(ctx, address);
  assert.deepEqual(kept[1][0].pos, { x: 1.2, y: 0 });
  assert.deepEqual(kept[1][0].asks, [entry]);
  assert.equal(await library.addMarkAnswer(ctx, { url: address }, 1, 'mU1', entry), false);
});

test('ink is written one change at a time: a save from the Stage asked for while main puts an answer on is written after it, never under it', async () => {
  const mark = { id: 'mQ1', rects: [{ x: 0, y: 0, w: 0.2, h: 0.01 }], note: '@bart q' };
  await library.writeAnnotations(ctx, paperId, { 4: [mark] });
  const entry = { id: 'hQ1', question: 'q', answer: 'A.', meta: {}, at: 'now', pos: null, collapsed: false };
  const moved = { 4: [{ ...mark, pos: { x: 1.3, y: 0 } }] };
  const added = library.addMarkAnswer(ctx, { rowId: paperId }, 4, 'mQ1', entry);
  const saved = library.writeAnnotations(ctx, paperId, moved); // the viewer's next save, which then has the answer too
  await Promise.all([added, saved]);
  assert.deepEqual(await library.readAnnotations(ctx, paperId), moved, 'not the ink main read before it, with the answer, over the move');
});
