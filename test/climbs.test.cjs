'use strict';

// Onboarding build 2 (2026-10-08): the climbs under "Suggested places to start". The gate in code (src/main/bart/
// climb-text.cjs: word for word, no text no rung, one page), approval required before anything is shown and the record
// it leaves (climb.cjs), the climb's order, the fixes and second check, the fallbacks (climbs.cjs: a quick search, then a
// step that is not a paper), the climbs begun on onboarding's plan and bound to the project (onboard.cjs), the preparing
// screen's end condition (renderer/model/onboarding.js), the guide passage in the Stage (renderer/model/stage.js, find.js)
// and the block that shows them (renderer/workspace/StartsBlock.jsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const text = require('../src/main/bart/climb-text.cjs');
const climb = require('../src/main/bart/climb.cjs');
const climbs = require('../src/main/bart/climbs.cjs');
const onboard = require('../src/main/bart/onboard.cjs');
const { normalizeModels, DEFAULT_MODELS } = require('../src/main/bart/models.cjs');

const renderer = (file) => import(pathToFileURL(path.join(__dirname, '../src/renderer/model', file)).href);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-climbs-')));
const models = () => normalizeModels(DEFAULT_MODELS);

/* --------------------------------------------------------------------------------------------- the papers */

const KAPUR = {
  id: 'W1', title: 'Productive failure', authors: ['Manu Kapur'], year: 2008, venue: 'Cognition and Instruction', doi: '10.1/pf',
  abstract: 'Students who struggle with a problem before instruction learn more from it. Productive failure designs that struggle on purpose and measures what transfers to new problems.',
  pages: [
    { page: 1, lines: ['Productive failure', 'Abstract', 'Students who struggle with a problem before instruction learn more from it.', '1 Introduction', 'Transfer is the use of what was learned in a new situa-', 'tion. Studies of transfer ask students to solve problems unlike the ones they practised.'] },
    { page: 2, lines: ['2 Method', 'Seventy students were randomly assigned to struggle first or to be taught first; both groups then took', 'the same test of new problems.', 'In the ﬁrst condition, students “generated” their own solutions.'] },
    { page: 3, lines: ['3 Results', 'Students who struggled first solved more of the new problems.', 'References', 'Kapur, M. (2006). Productive failure.'] },
  ],
};
const BASTANI = {
  id: 'W2', title: 'Generative AI can harm learning', authors: ['Hamsa Bastani', 'Osbert Bastani', 'Alp Sungu'], year: 2025, venue: 'PNAS', doi: '10.1/gai',
  abstract: 'Students who practised with an AI tutor did better while it was there, and worse on an exam taken without it. Access to answers can stand in for learning.',
  pages: null,
};
const NO_TEXT = { id: 'W3', title: 'A paper behind a paywall', authors: ['Ann Other'], year: 2020, venue: null, doi: '10.1/pay', abstract: null, pages: null };

/* ------------------------------------------------------------------------------------------ the gate, in code */

test('the gate: a passage word for word in the pdf\'s text is anchored to its span, on its page', () => {
  const out = text.gatePassage('Transfer is the use of what was learned in a new situation.', KAPUR);
  assert.equal(out.ok, true);
  assert.equal(out.source, 'pdf');
  assert.equal(out.page, 1);
  // The span is the text as extracted: the word broken across the line is there as pdf.js gives it, spaces collapsed.
  assert.equal(out.find, 'Transfer is the use of what was learned in a new situa- tion.');
  const page = KAPUR.pages[0].lines.join('\n');
  assert.equal(page.slice(out.start, out.end).replace(/\s+/g, ' '), out.find);
  assert.equal(out.occurrences, 1);
});

test('the gate: only spacing, a broken word, a ligature and curly quotes may differ; any word, case or mark that differs is refused', () => {
  assert.equal(text.gatePassage('In the first condition, students "generated" their own solutions.', KAPUR).ok, true, 'ﬁ and “” read as fi and ""');
  assert.equal(text.gatePassage('Seventy students were randomly   assigned to struggle first or to be taught first; both groups then took the same test of new problems.', KAPUR).ok, true);
  const refused = [
    'Seventy students were assigned to struggle first or to be taught first; both groups then took the same test of new problems.', // a word left out
    'seventy students were randomly assigned to struggle first or to be taught first; both groups then took the same test of new problems.', // case
    'Seventy students were randomly assigned to struggle first or to be taught first, both groups then took the same test of new problems.', // a mark
    'Seventy students were randomly assigned … both groups then took the same test of new problems.', // an ellipsis
    'Students who struggled first solved far more of the new problems.', // a word added
  ];
  for (const passage of refused) assert.deepEqual(text.gatePassage(passage, KAPUR), { ok: false, why: 'not word for word in the paper\'s text' }, passage);
});

test('the gate: no text, no rung; a passage across a page break, too short or too long is refused', () => {
  assert.equal(text.gatePassage('Anything at all that a model might write here.', NO_TEXT).ok, false);
  assert.match(text.gatePassage('Anything at all that a model might write here.', NO_TEXT).why, /no text/);
  assert.equal(text.gatePassage('Anything at all that a model might write here.', null).ok, false);
  assert.match(text.gatePassage('solve problems unlike the ones they practised. 2 Method Seventy students', KAPUR).why, /page break/);
  assert.match(text.gatePassage('2 Method', KAPUR).why, /too short/);
  assert.match(text.gatePassage('word '.repeat(300), KAPUR).why, /longer than/);
});

test('the gate: a passage of the abstract opens the pdf when the pdf has it too, else the abstract', () => {
  assert.equal(text.gatePassage('Students who struggle with a problem before instruction learn more from it.', KAPUR).source, 'pdf');
  const abstract = text.gatePassage('Productive failure designs that struggle on purpose and measures what transfers to new problems.', KAPUR);
  assert.equal(abstract.source, 'abstract');
  assert.equal(abstract.page, null);
  assert.equal(text.gatePassage('Access to answers can stand in for learning.', BASTANI).source, 'abstract');
});

test('the section a passage is in: the last heading before it, numbered or named', () => {
  assert.equal(text.headingOf('2 Method'), 'Method');
  assert.equal(text.headingOf('3.2 Study design'), 'Study design');
  assert.equal(text.headingOf('2 RELATED WORK'), 'Related Work');
  assert.equal(text.headingOf('Abstract'), 'Abstract');
  assert.equal(text.headingOf('Seventy students were randomly assigned.'), '');
  assert.equal(text.headingOf('2 students took part in 2019 and 2020 of the study across schools in the region of'), '');
  const gate = text.gatePassage('Students who struggled first solved more of the new problems.', KAPUR);
  assert.equal(text.sectionAt(KAPUR.pages, gate.page, gate.start), 'Results');
  const context = text.contextOf(KAPUR, gate);
  assert.match(context, /«Students who struggled first solved more of the new problems\.»/);
  assert.match(context, /Seventy students/, 'the text around it, the page before included');
});

test('excerpts for Bart: the windows nearest the sub-question, never the references', () => {
  const out = text.excerptsFor(KAPUR, 'How have prior studies measured transfer to new problems?');
  assert.ok(out.length >= 1);
  assert.ok(out.every((one) => !/Kapur, M\. \(2006\)/.test(one.text)));
  assert.ok(out.some((one) => /new problems/.test(one.text)));
  // What Bart is shown passes the gate when copied.
  const sentence = out[0].text.split(/(?<=\.)\s+/)[0];
  assert.equal(text.gatePassage(sentence, KAPUR).ok, true, sentence);
});

/* -------------------------------------------------------------------------------- a climb: order and approval */

const BY = { provider: 'anthropic', model: 'Opus', id: 'opus', effort: 'high' };
const verdict = (n, ok = true, extra = {}) => JSON.stringify({ rung: n, read_in_context: true, says_what_line_claims: ok, self_contained: true, assumes_only_earlier: true, why: ok ? 'fine' : 'claims too much', fix: null, ...extra });
const newcomer = (same = true, confusing = []) => JSON.stringify({ newcomer: true, own_answer: 'Struggle first helps transfer.', newcomer_answer: same ? 'Struggle first helps transfer.' : '?', same, confusing });

/** A scripted writer and checker: `draft` the writer's rungs, `checks` one reply per whole-climb check, `first` the first rung's. */
function scripted({ draft, checks, first = verdict(1) }) {
  const calls = [];
  let round = 0;
  const ask = async (role, message, { onDelta, onBy } = {}) => {
    calls.push({ role, message });
    if (onBy) onBy(BY);
    if (role === 'writer') return { text: JSON.stringify(draft), by: BY };
    if (/Write one line of JSON for rung 1/.test(message)) return { text: first, by: BY };
    const reply = checks[Math.min(round, checks.length - 1)];
    round += 1;
    if (onDelta) { let so = ''; for (const line of reply.split('\n')) { so += `${line}\n`; onDelta(so); } }
    return { text: reply, by: BY };
  };
  return { ask, calls };
}

const RUNGS = [
  { stage: 'known', paper: 'W1', passage: 'Students who struggled first solved more of the new problems.', line: 'Struggling first helped on new problems', gloss: '' },
  { stage: 'problem', paper: 'W1', passage: 'Students who struggle with a problem before instruction learn more from it.', line: 'Struggle before teaching can help', gloss: '' },
  { stage: 'methods', paper: 'W1', passage: 'Seventy students were randomly assigned to struggle first or to be taught first; both groups then took the same test of new problems.', line: 'Transfer is tested with new problems', gloss: 'Randomly assigned: chance decides who gets which teaching.' },
];

test('order: the climb runs problem → foundations → how it is studied → what is known → the open edge, a stage\'s rungs as written', () => {
  const out = climb.orderRungs([{ stage: 'open', n: 1 }, { stage: 'known', n: 2 }, { stage: 'problem', n: 3 }, { stage: 'methods', n: 4 }, { stage: 'foundations', n: 5 }, { stage: 'problem', n: 6 }]);
  assert.deepEqual(out.map((one) => one.n), [3, 6, 5, 4, 2, 1]);
});

test('a climb: drafted, gated, put in order, approved rung by rung, the newcomer check passed, each rung with its record', async () => {
  const { ask, calls } = scripted({ draft: { answer: 'Struggle first helps.', rungs: [...RUNGS, { stage: 'open', paper: 'W1', passage: 'Words no paper has ever printed anywhere at all.', line: 'x' }], more: ['W3'] }, checks: [[verdict(1), verdict(2), verdict(3), newcomer()].join('\n')] });
  const updates = [];
  const out = await climb.buildClimb({ sub: 'How have prior studies measured transfer?', question: 'Which behaviors predict learning transfer?', papers: [KAPUR, BASTANI, NO_TEXT], ask, onUpdate: (one) => updates.push(one), now: () => '2026-10-08T00:00:00.000Z' });
  assert.equal(out.status, 'done');
  assert.deepEqual(out.rungs.map((rung) => rung.stage), ['problem', 'methods', 'known']);
  assert.deepEqual(out.rungs.map((rung) => rung.part), ['Abstract', 'Method', 'Results']);
  assert.equal(out.rungs[0].label, 'Kapur 2008');
  assert.equal(out.newcomer.passed, true);
  // The made-up passage never reached the checker and is recorded as refused by the gate.
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].why, /word for word/);
  assert.ok(calls.filter((call) => call.role === 'checker').every((call) => !/Words no paper has ever printed/.test(call.message)));
  // The checker read each passage with the paper's own text around it.
  assert.match(calls.find((call) => call.role === 'checker' && /Rung 3/.test(call.message)).message, /«Seventy students were randomly/);
  // The record: which model approved it, the text it read, when, its verdict.
  for (const rung of out.rungs) {
    assert.equal(rung.approval.model, 'Opus');
    assert.equal(rung.approval.effort, 'high');
    assert.equal(rung.approval.at, '2026-10-08T00:00:00.000Z');
    assert.equal(rung.approval.read.passage, rung.passage);
    assert.match(rung.approval.read.context, /«/);
    assert.deepEqual(Object.keys(rung.approval.verdict).sort(), ['assumes_only_earlier', 'read_in_context', 'says_what_line_claims', 'self_contained', 'why']);
  }
  assert.deepEqual(out.more.map((one) => one.label), ['Other 2020'], 'a paper with no text is listed apart, not checked');
  // Rungs appeared one at a time, and every one ever shown was approved.
  const counts = updates.map((one) => one.rungs.length);
  assert.ok(counts.includes(1) && counts.includes(2) && counts.includes(3), String(counts));
  for (const one of updates) for (const rung of one.rungs) assert.ok(rung.approval && rung.approval.verdict.says_what_line_claims, 'only approved rungs are shown');
});

test('approval is required: a refused rung is never shown, nor any after it, and is fixed then checked again', async () => {
  const fix = verdict(2, false, { fix: { line: 'Struggle first can help, for new problems', gloss: '' } });
  const { ask } = scripted({
    draft: { answer: 'A', rungs: RUNGS, more: [] },
    checks: [[verdict(1), fix, verdict(3), newcomer(false, [{ rung: 2, problem: 'overclaims', fix: 'line', line: 'Struggle first can help, for new problems' }])].join('\n'), [verdict(1), verdict(2), verdict(3), newcomer()].join('\n')],
  });
  const updates = [];
  const out = await climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [KAPUR], ask, onUpdate: (one) => updates.push(one) });
  // Rung 2 as drafted was refused: it never showed, and neither did rung 3 (it may lean on rung 2) until the fix passed.
  for (const one of updates) {
    assert.ok(one.rungs.every((rung) => rung.line !== 'Transfer is tested with new problems'), 'the refused rung never shows');
    if (one.rungs.length > 1) assert.equal(one.rungs[1].line, 'Struggle first can help, for new problems');
  }
  assert.equal(out.rounds, 2);
  assert.equal(out.newcomer.passed, true);
  assert.equal(out.rungs.length, 3);
  assert.equal(out.rungs[1].line, 'Struggle first can help, for new problems');
  assert.equal(out.rungs[1].approval.round, 2);
});

test('approval is required: a rung refused with no fix is dropped, and one never checked is never shown', async () => {
  const { ask } = scripted({ draft: { answer: 'A', rungs: RUNGS, more: [] }, checks: [[verdict(1), verdict(2, false), newcomer(false)].join('\n'), [verdict(1), verdict(2, false), newcomer(false)].join('\n')] });
  const out = await climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [KAPUR], ask });
  // Rung 3 got no verdict in round 1 and rung 2 was dropped: round 2 checked [1, 3] and refused 3.
  assert.deepEqual(out.rungs.map((rung) => rung.stage), ['problem']);
  assert.equal(out.newcomer.passed, false);
  // The checker that never answers: nothing is shown.
  const silent = await climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [KAPUR], ask: async (role) => (role === 'writer' ? { text: JSON.stringify({ answer: 'A', rungs: RUNGS }), by: BY } : { text: 'I cannot.', by: BY }) });
  assert.deepEqual(silent.rungs, []);
});

test('the first rung is checked on its own and shown before the whole climb\'s check ends', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const updates = [];
  const ask = async (role, message) => {
    if (role === 'writer') return { text: JSON.stringify({ answer: 'A', rungs: RUNGS }), by: BY };
    if (/Write one line of JSON for rung 1/.test(message)) return { text: verdict(1), by: BY };
    await held;
    return { text: [verdict(1), verdict(2), verdict(3), newcomer()].join('\n'), by: BY };
  };
  const running = climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [KAPUR], ask, onUpdate: (one) => updates.push(one) });
  for (let n = 0; n < 50 && !updates.some((one) => one.rungs.length === 1); n += 1) await new Promise((resolve) => { setImmediate(resolve); });
  const early = updates.find((one) => one.rungs.length === 1);
  assert.ok(early, 'the first rung shows while the whole climb is still being checked');
  assert.equal(early.status, 'checking');
  assert.equal(early.pending, 2);
  release();
  assert.equal((await running).rungs.length, 3);
});

test('a passage that opens by pointing back is refused in code, before any model reads it; one naming its paper stands', async () => {
  assert.equal(climb.pointsBackOf('This indicates that many students may reach near transfer.'), 'This');
  assert.equal(climb.pointsBackOf('However, students who struggled first solved more.'), 'However');
  assert.equal(climb.pointsBackOf('“These abstract principles” matter.'), 'These');
  assert.equal(climb.pointsBackOf('This study asks whether struggle helps.'), '');
  assert.equal(climb.pointsBackOf('Thinking aloud is a method.'), '', 'a word that only starts like one');
  const kapur = { ...KAPUR, pages: [...KAPUR.pages, { page: 4, lines: ['This indicates that struggle before instruction is productive for transfer.'] }] };
  const { ask, calls } = scripted({ draft: { answer: 'A', rungs: [RUNGS[1], { stage: 'known', paper: 'W1', passage: 'This indicates that struggle before instruction is productive for transfer.', line: 'x' }] }, checks: [[verdict(1), newcomer()].join('\n')] });
  const out = await climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [kapur], ask });
  assert.equal(out.rungs.length, 1);
  assert.match(out.failures[0].why, /pointing back \("This"\)/);
  assert.ok(calls.every((call) => !/This indicates that struggle/.test(call.message) || call.role === 'writer'));
});

test('a draft whose passages all fail the gate is written once more, told why each failed', async () => {
  const drafts = [];
  const ask = async (role, message) => {
    if (role === 'writer') {
      drafts.push(message);
      const rungs = drafts.length === 1 ? [{ stage: 'problem', paper: 'W1', passage: 'Students who struggle with a problem before teaching learn more from it.', line: 'x' }] : [RUNGS[1]];
      return { text: JSON.stringify({ answer: 'A', rungs }), by: BY };
    }
    return { text: /Write one line/.test(message) ? verdict(1) : [verdict(1), newcomer()].join('\n'), by: BY };
  };
  const out = await climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [KAPUR], ask });
  assert.equal(drafts.length, 2);
  assert.match(drafts[1], /were all refused, in code:\n- \[W1\] "Students who struggle with a problem before teaching[^\n]*: not word for word/);
  assert.equal(out.rungs.length, 1);
  assert.deepEqual(out.failures.map((one) => one.draft), [1]);
});

test('the first rung: refused with a fix, the fix is checked at once; refused with none, the next rung is tried first', async () => {
  const replies = [verdict(1, false, { fix: { line: 'Struggle before teaching may help' } }), verdict(1)];
  const firsts = [];
  const ask = async (role, message) => {
    if (role === 'writer') return { text: JSON.stringify({ answer: 'A', rungs: RUNGS }), by: BY };
    if (/Write one line of JSON for rung 1/.test(message)) { firsts.push(message.match(/Line \(what you'll learn here\): (.+)/)[1]); return { text: replies.shift(), by: BY }; }
    return { text: [verdict(1), verdict(2), verdict(3), newcomer()].join('\n'), by: BY };
  };
  const updates = [];
  const out = await climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [KAPUR], ask, onUpdate: (one) => updates.push(one) });
  assert.deepEqual(firsts, ['Struggle before teaching can help', 'Struggle before teaching may help']);
  const early = updates.find((one) => one.rungs.length === 1 && one.rounds === 0);
  assert.equal(early.rungs[0].line, 'Struggle before teaching may help', 'the fixed first rung is up before the whole climb is checked');
  assert.deepEqual(out.checks.map((check) => [check.kind, check.approved, check.rungs]), [['first', 0, 1], ['first', 1, 1], ['climb', 3, 3]]);
  assert.deepEqual(out.checks[0].refused[0].failed, ['says_what_line_claims']);
  // Refused with no fix: dropped, and the next rung is checked as the first.
  const dropped = [verdict(1, false), verdict(1)];
  const tried = [];
  const ask2 = async (role, message) => {
    if (role === 'writer') return { text: JSON.stringify({ answer: 'A', rungs: RUNGS }), by: BY };
    if (/Write one line of JSON for rung 1/.test(message)) { tried.push(message.match(/Line \(what you'll learn here\): (.+)/)[1]); return { text: dropped.shift(), by: BY }; }
    return { text: [verdict(1), verdict(2), newcomer()].join('\n'), by: BY };
  };
  const out2 = await climb.buildClimb({ sub: 'S?', question: 'Q?', papers: [KAPUR], ask: ask2 });
  assert.deepEqual(tried, ['Struggle before teaching can help', 'Transfer is tested with new problems']);
  assert.deepEqual(out2.rungs.map((rung) => rung.stage), ['methods', 'known']);
});

test('the checker\'s reply is read line by line, fences and half-written lines put aside', () => {
  const out = climb.readCheck(['```json', verdict(1), `- ${verdict(2, false)}`, newcomer(), '{"rung": 3, "read_in'].join('\n'), { complete: false });
  assert.deepEqual([...out.verdicts.keys()], [1, 2]);
  assert.equal(climb.passes(out.verdicts.get(1)), true);
  assert.equal(climb.passes(out.verdicts.get(2)), false);
  assert.equal(out.newcomer.same, true);
  assert.equal(climb.passes({ read_in_context: true, says_what_line_claims: true, self_contained: true }), false, 'every check, or none');
});

/* ------------------------------------------------------------------------------- the runs, and their fallbacks */

/** A shelf holding `papers` already read; prepare answers what it holds. */
const fakeShelf = (papers) => {
  const byId = new Map(papers.map((paper) => [paper.id, paper]));
  const pdfDir = tmp();
  for (const paper of papers) if (paper.pages) { paper.pdf = path.join(pdfDir, `${paper.id}.pdf`); fs.writeFileSync(paper.pdf, '%PDF-1.4 fake'); }
  return { prepare: async (one) => byId.get(one.id) || null, get: (id) => byId.get(id) || null, dir: pdfDir };
};

/** A session per call whose answers come from `answer(message, step)`. */
const sessionsFrom = (answer) => (options) => ({ provider: 'anthropic', turn: async (message, { onDelta } = {}) => { const out = answer(message, options.step); if (onDelta) onDelta(out); return out; }, warm: async () => 'ready', alive: () => true, close() {} });

test('the writer runs at the fastest level Bart has and the approval at the second step of @bart\'s ladder: Opus high', () => {
  const made = climbs.createClimbs({ readModels: models, shelf: fakeShelf([]), papers: { search: async () => ({ results: [] }) } });
  assert.deepEqual([made.stepOf('writer').name, made.stepOf('writer').effort], ['Sonnet', 'medium']);
  assert.deepEqual([made.stepOf('checker').name, made.stepOf('checker').effort], ['Opus', 'high']);
  const codex = () => ({ ...models(), provider: 'openai' });
  const other = climbs.createClimbs({ readModels: codex, shelf: fakeShelf([]), papers: { search: async () => ({ results: [] }) } });
  assert.deepEqual([other.stepOf('checker').name, other.stepOf('checker').effort], ['Sol', 'high']);
});

test('fallbacks: nothing approved from onboarding\'s papers → a quick search for the sub-question; nothing there → a step that is not a paper', async () => {
  const projectDir = tmp();
  const searched = [];
  const shelf = fakeShelf([KAPUR, BASTANI]);
  // The sub-question's own search up front finds nothing; the fallback's shorter search finds W2.
  const papers = { search: async ({ query }) => { searched.push(query); return { results: query === 'happens exam without' ? [{ id: 'W2', title: BASTANI.title }] : [] }; } };
  // The writer quotes nothing true from W1; quotes W2's abstract word for word.
  const answer = (message) => {
    if (/Papers you may quote/.test(message)) return /\[W2\]/.test(message) ? JSON.stringify({ answer: 'A', rungs: [{ stage: 'known', paper: 'W2', passage: 'Access to answers can stand in for learning.', line: 'Answers can replace learning' }] }) : JSON.stringify({ answer: 'A', rungs: [{ stage: 'known', paper: 'W1', passage: 'Nothing like this is in the paper at all.', line: 'x' }] });
    if (/rung 1/.test(message) && /Write one line/.test(message)) return verdict(1);
    return [verdict(1), newcomer()].join('\n');
  };
  const changes = [];
  const made = climbs.createClimbs({ readModels: models, makeSession: sessionsFrom(answer), shelf, papers, onChange: (one) => changes.push(one), readWaitMs: 50 });
  made.ensure({ projectDir, projectId: 'p', workspaceId: 'w', question: 'Q?', starts: [
    { id: 's1', text: 'What happens on an exam without the AI tutor?' },
    { id: 's2', text: 'Which student behaviors does your data capture?' },
    { id: 's3', text: 'What theory explains productive struggle?' },
  ] });
  // s1's candidates are onboarding's (none in the project's file): its search finds W2.
  await made.settled();
  const kept = climbs.readClimbs(projectDir).starts;
  assert.equal(kept.s1.fallback, 'search');
  assert.equal(kept.s1.rungs.length, 1);
  assert.equal(kept.s1.rungs[0].label, 'Bastani et al. 2025');
  assert.ok(kept.s1.rungs[0].approval);
  // Their own data: the search finds nothing, so the step is to add it.
  assert.equal(kept.s2.fallback, 'action');
  assert.deepEqual(kept.s2.rungs.map((rung) => [rung.kind, rung.title]), [['action', 'Add your data: logs, exports, a codebook']]);
  assert.equal(kept.s2.rungs[0].approval.by, 'fixed words');
  // Anything else with nothing to quote: a paper they trust.
  assert.equal(kept.s3.rungs[0].title, 'Add a paper you trust on this');
  assert.ok(searched.includes('happens exam without tutor'), 'its own search up front, in its words');
  assert.ok(searched.includes('happens exam without'), 'then the fallback\'s');
  assert.ok(changes.every((one) => one.projectId === 'p' && one.workspaceId === 'w'));
  // Every sub-question ends with something approved under it.
  for (const id of ['s1', 's2', 's3']) assert.ok(kept[id].rungs.length >= 1 && kept[id].status === 'done');
});

test('a rung written into the project opens its copy there: the pdf at its passage, or the abstract as a page', async () => {
  const projectDir = tmp();
  const shelf = fakeShelf([KAPUR, BASTANI]);
  const pdfRung = climbs.withOpen({ kind: 'paper', paper: { id: 'W1' }, source: 'pdf', anchor: { find: 'Students who struggled first', page: 3 } }, projectDir, shelf);
  assert.equal(path.dirname(pdfRung.open.path), path.join(projectDir, '.context', 'papers'));
  assert.match(path.basename(pdfRung.open.path), /^Kapur 2008 Productive failure\.pdf$/);
  assert.equal(fs.readFileSync(pdfRung.open.path, 'utf8'), '%PDF-1.4 fake');
  assert.deepEqual([pdfRung.open.find, pdfRung.open.page], ['Students who struggled first', 3]);
  const abstractRung = climbs.withOpen({ kind: 'paper', paper: { id: 'W2' }, source: 'abstract', anchor: { find: 'Access to answers can stand in for learning.', page: null } }, projectDir, shelf);
  assert.match(abstractRung.open.path, /\(abstract\)\.md$/);
  const page = fs.readFileSync(abstractRung.open.path, 'utf8');
  assert.ok(page.includes(BASTANI.abstract), 'the abstract word for word, so the passage is found in it');
  assert.ok(page.includes(abstractRung.open.find));
});

test('a start edited is climbed again for its new words; one removed loses its climb; one done is left alone', async () => {
  const projectDir = tmp();
  const shelf = fakeShelf([BASTANI]);
  let drafts = 0;
  const answer = (message) => {
    if (/Papers you may quote/.test(message)) { drafts += 1; return JSON.stringify({ answer: 'A', rungs: [{ stage: 'known', paper: 'W2', passage: 'Access to answers can stand in for learning.', line: 'Answers can replace learning' }] }); }
    return /Write one line/.test(message) ? verdict(1) : [verdict(1), newcomer()].join('\n');
  };
  fs.mkdirSync(path.join(projectDir, '.context'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.context', 'start-candidates.json'), JSON.stringify({ papers: [{ id: 'W2', title: BASTANI.title, queries: ['ai tutor exam'] }] }));
  const made = climbs.createClimbs({ readModels: models, makeSession: sessionsFrom(answer), shelf, papers: { search: async () => ({ results: [] }) }, readWaitMs: 50 });
  const where = { projectDir, projectId: 'p', workspaceId: 'w', question: 'Q?' };
  assert.deepEqual(made.ensure({ ...where, starts: [{ id: 's1', text: 'Does an AI tutor harm exam scores?' }, { id: 's2', text: 'Gone soon?' }] }), ['s1', 's2']);
  await made.settled();
  assert.deepEqual(made.ensure({ ...where, starts: [{ id: 's1', text: 'Does an AI tutor harm exam scores?' }] }), [], 'done already');
  assert.equal(climbs.readClimbs(projectDir).starts.s2, undefined, 'a removed start\'s climb is dropped');
  assert.deepEqual(made.ensure({ ...where, starts: [{ id: 's1', text: 'Does AI help on exams taken without it?' }] }), ['s1']);
  await made.settled();
  assert.equal(climbs.readClimbs(projectDir).starts.s1.question, 'Does AI help on exams taken without it?');
  assert.equal(drafts, 3);
});

test('onboarding: the plan\'s sub-questions start their climbs at once, and the project, once made, gets them', async () => {
  const projectDir = tmp();
  const shelf = fakeShelf([BASTANI]);
  const papers = { search: async () => ({ total: 1, results: [{ id: 'W2', title: BASTANI.title, cited_by: 3 }] }) };
  const begun = [];
  const answer = (message) => {
    if (/Papers you may quote/.test(message)) { begun.push(message.match(/Sub-question: (.+)/)[1]); return JSON.stringify({ answer: 'A', rungs: [{ stage: 'known', paper: 'W2', passage: 'Access to answers can stand in for learning.', line: 'Answers can replace learning' }] }); }
    return /Write one line/.test(message) ? verdict(1) : [verdict(1), newcomer()].join('\n');
  };
  const made = climbs.createClimbs({ readModels: models, makeSession: sessionsFrom(answer), shelf, papers, readWaitMs: 50 });
  const prefetched = [];
  const spy = { ...made, prefetch: (list) => { prefetched.push(list.length); made.prefetch(list); }, begin: (...args) => made.begin(...args), bind: (...args) => made.bind(...args), cancel: (...args) => made.cancel(...args) };
  const card = onboard.createOnboard({ readModels: models, makeSession: () => onboard.createFakeSession({ delayMs: 1 }), papers, climbs: spy });
  const { id } = card.open();
  await card.answer(id, { card: 'working', answers: { working: 'AI tutors and exams' } });
  await card.settled(id);
  assert.ok(prefetched.length >= 1, 'papers are read while the cards are answered');
  const plan = await card.plan(id, { answers: { working: 'AI tutors and exams' }, sentence: 'I’m working on AI tutors.' });
  assert.equal(plan.starts.length, 3);
  for (let n = 0; n < 100 && begun.length < 3; n += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.deepEqual(begun.sort(), plan.starts.slice().sort(), 'every sub-question is being climbed before the project exists');
  const starts = plan.starts.map((textOf, i) => ({ id: `s${i}`, text: textOf }));
  card.attach(id, projectDir, { projectId: 'p', workspaceId: 'w', starts, question: plan.question });
  await made.settled();
  const kept = climbs.readClimbs(projectDir).starts;
  assert.deepEqual(Object.keys(kept).sort(), ['s0', 's1', 's2']);
  for (const one of Object.values(kept)) assert.ok(one.rungs.length && one.rungs[0].open && fs.existsSync(one.rungs[0].open.path));
  assert.equal(begun.length, 3, 'not climbed again once bound');
});

test('scripted runs (ENGELBART_BART_FAKE=1): the fake session drafts quotes that pass the gate and approves them', async () => {
  const session = onboard.createFakeSession({ delayMs: 1 });
  const ask = async (role, message) => ({ text: await session.turn(message), by: BY });
  const out = await climb.buildClimb({ sub: 'What is productive failure?', question: 'Q?', papers: [KAPUR, BASTANI], ask });
  assert.ok(out.rungs.length >= 2, JSON.stringify(out.failures));
  assert.equal(out.failures.length, 0);
});

/* ------------------------------------------------------------------------------------- the preparing screen */

test('the preparing screen ends when every sub-question has an approved item, or after 20 seconds, naming the step under way', async () => {
  const { preparingState, PREPARE_MS } = await renderer('onboarding.js');
  assert.equal(PREPARE_MS, 20000);
  assert.deepEqual(preparingState({ starts: null }), { done: false, label: 'reading your answers' });
  const starts = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(preparingState({ starts, climbs: {}, elapsedMs: 100 }), { done: false, label: 'finding places to start' });
  assert.deepEqual(preparingState({ starts, climbs: { a: { step: 'checking', rungs: [] }, b: { step: 'finding', rungs: [] } }, elapsedMs: 100 }), { done: false, label: 'finding places to start' });
  assert.deepEqual(preparingState({ starts, climbs: { a: { step: 'checking', rungs: [{ id: 1 }] }, b: { step: 'checking', rungs: [] } }, elapsedMs: 100 }), { done: false, label: 'checking each step' });
  assert.equal(preparingState({ starts, climbs: { a: { step: 'checking', rungs: [{ id: 1 }] }, b: { step: 'done', rungs: [{ kind: 'action' }] } }, elapsedMs: 100 }).done, true, 'one approved item each, the rest still being checked');
  assert.equal(preparingState({ starts, climbs: {}, elapsedMs: 20000 }).done, true, 'twenty seconds at most');
  assert.equal(preparingState({ starts: [], climbs: {}, elapsedMs: 0 }).done, true, 'no sub-questions: nothing to wait for');
});

/* ------------------------------------------------------------------------------------- the Stage's guide */

test('the Stage: a rung\'s passage waits, then lands as Bart\'s guide, with no find card and no sections', async () => {
  const { withPassage, landTab, landingFinds } = await renderer('stage.js');
  const { guideSpot } = await renderer('find.js');
  const tab = { id: 't', pdf: { bytes: 1 }, pendingFind: null, sections: [{ find: 'x' }], activeSection: 0 };
  const waiting = withPassage(tab, 'Students who struggled first', '', null, { page: 3 });
  assert.deepEqual([waiting.pendingFind, waiting.pendingGuide, waiting.sections.length, waiting.guide], ['Students who struggled first', { page: 3 }, 0, null]);
  assert.equal(landingFinds(waiting), false, 'no find card');
  const landed = landTab(waiting, 'Students who struggled first');
  assert.deepEqual([landed.pendingFind, landed.pendingGuide, landed.guide], [null, null, { find: 'Students who struggled first', page: 3 }]);
  assert.equal(landingFinds(landed), false);
  // Another link's passage replaces the guide.
  const other = withPassage(landed, 'We argue that', '', null);
  assert.deepEqual([other.guide, other.pendingGuide], [null, null]);
  assert.equal(guideSpot([{ page: 1, from: 0 }, { page: 3, from: 5 }], 3).page, 3, 'the match on its own page');
  assert.equal(guideSpot([{ page: 1, from: 0 }], 3).page, 1);
  assert.equal(guideSpot([], 3), null);
});

/* -------------------------------------------------------------------------------------------- the block */

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-climbs-unit.cjs`);
  const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/server'] });
  const compiled = new Module(filename, module); compiled.paths = module.paths;
  compiled._compile(built.outputFiles[0].text, filename);
  return compiled.exports;
}

test('the block: each approved rung as "paper · part" and its line, the next step being checked, reading not checked apart', () => {
  const { default: StartsBlock, climbFor } = load('workspace/StartsBlock.jsx');
  const starts = [{ id: 's1', text: 'How have prior studies measured transfer?', by: 'bart' }, { id: 's2', text: 'Which student behaviors does your data capture?', by: 'bart' }];
  const rung = { id: 'r1', kind: 'paper', label: 'Kapur 2008', part: 'Method', line: 'Struggle first, then tested on new problems', gloss: 'Transfer: using what you learned on a new problem.', approval: { model: 'Opus', effort: 'high', at: '2026-10-08T00:00:00Z' } };
  const climbsHere = {
    s1: { question: starts[0].text, status: 'checking', rungs: [rung], more: [] },
    s2: { question: 'An older wording', status: 'done', rungs: [rung], more: [] },
  };
  assert.equal(climbFor(starts[1], climbsHere), null, 'a climb made for other words is not shown');
  const html = renderToStaticMarkup(React.createElement(StartsBlock, { starts, onSave: () => {}, climbs: climbsHere, activeRung: 'r1' }));
  assert.match(html, /Kapur 2008 · Method/);
  assert.match(html, /Struggle first, then tested on new problems/);
  assert.match(html, /data-rung-gloss="1"[^>]*>Transfer: using what you learned/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /Bart is checking the next step…/);
  assert.equal((html.match(/data-rung="r1"/g) || []).length, 1, 'the second start is shut, as in the design');
  const done = renderToStaticMarkup(React.createElement(StartsBlock, { starts: starts.slice(0, 1), onSave: () => {}, climbs: { s1: { ...climbsHere.s1, status: 'done', more: [{ id: 'W3', label: 'Other 2020', title: 'A paper behind a paywall', url: 'https://doi.org/10.1/pay' }] } } }));
  assert.doesNotMatch(done, /checking the next step/);
  assert.match(done, /More reading, not checked/);
  assert.match(done, /Other 2020 · A paper behind a paywall/);
  const waiting = renderToStaticMarkup(React.createElement(StartsBlock, { starts: starts.slice(0, 1), onSave: () => {}, climbs: {} }));
  assert.match(waiting, /Finding places to start…/);
});
