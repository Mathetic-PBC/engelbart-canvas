'use strict';

// Onboarding (2026-09-28; as brainstorm cards since 2026-10-07): its backend (src/main/store/onboarding.cjs) — the project
// the cards describe, the brief agents see in place of custom instructions and picked context, the folder made for it,
// unticking a repository again — its order (src/renderer/model/onboarding.js), and Bart's part while the cards are
// answered (src/main/bart/onboard.cjs, onboard-session.cjs): the lines said back, the plan, and the early searches whose
// papers are kept with the project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const onboarding = require('../src/main/store/onboarding.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');
const onboard = require('../src/main/bart/onboard.cjs');
const { createWarmSession, claudeEvent } = require('../src/main/bart/onboard-session.cjs');
const { normalizeModels, onboardStep, DEFAULT_MODELS } = require('../src/main/bart/models.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-home-')));
const layout = ensureHome(homeDir);
let ctx;
const flowModel = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('custom instructions: written, read, trimmed, and removed when emptied', () => {
  assert.equal(onboarding.readInstructions(ctx), '');
  assert.equal(onboarding.instructionsBlock(ctx.dataRoot), '');
  onboarding.writeInstructions(ctx, '  I study help-seeking.\n\n');
  assert.equal(onboarding.readInstructions(ctx), 'I study help-seeking.');
  assert.match(onboarding.instructionsBlock(ctx.dataRoot), /^<custom_instructions [^>]*>\nI study help-seeking\.\n<\/custom_instructions>$/);
  onboarding.writeInstructions(ctx, '   ');
  assert.equal(fs.existsSync(path.join(ctx.dataRoot, 'instructions.md')), false);
});

test('a folder made for the project sits in the home directory and never takes one that exists', () => {
  const first = onboarding.freeFolder(ctx, 'Teachable Agents!');
  assert.deepEqual(first, { path: path.join(homeDir, 'teachable-agents'), shown: '~/teachable-agents' });
  fs.mkdirSync(first.path);
  assert.equal(onboarding.freeFolder(ctx, 'Teachable Agents!').shown, '~/teachable-agents-2');
  assert.throws(() => onboarding.existingFolder(ctx, 'relative/path'), /starts with/);
  assert.throws(() => onboarding.existingFolder(ctx, '~/not-there'), /Nothing is at/);
  assert.equal(onboarding.existingFolder(ctx, '~/teachable-agents'), first.path);
});

test('startProject: Bart\'s name, their answers as description, the question as the workspace, his sub-questions, the brief', async () => {
  const sentence = 'How what students do before asking an AI relates to what they learn. Trying to: Find data instructors could grade the process with.';
  // Since 2026-10-08: what they work on, what they are trying to do with it, and their research question.
  const brief = { working: 'How what students do before asking an AI relates to what they learn', goal: 'Find data instructors could grade the process with', question: 'Which behaviors predict learning transfer?' };
  const made = await onboarding.startProject(ctx, { name: 'Process-based assessment', description: sentence, question: 'Which behaviors predict learning transfer?', starts: ['How have prior studies measured transfer?', 'Which student behaviors does your data capture?', 'What outcome would show transfer?'], brief, folder: 'new' });
  assert.equal(made.project.name, 'Process-based assessment');
  assert.equal(made.project.directory, path.join(homeDir, 'process-based-assessment'), 'the default folder, made for it');
  assert.ok(fs.statSync(made.project.directory).isDirectory());
  assert.equal(made.project.description, sentence);
  const tree = await projects.loadProject(ctx, made.project.id);
  assert.deepEqual(tree.workspaces.map((w) => w.name), ['Which behaviors predict learning transfer?']);
  assert.equal(made.workspaceName, 'Which behaviors predict learning transfer?');
  assert.deepEqual(tree.workspaces[0].starts.map((one) => [one.text, one.by]), [['How have prior studies measured transfer?', 'bart'], ['Which student behaviors does your data capture?', 'bart'], ['What outcome would show transfer?', 'bart']]);
  assert.deepEqual(tree.workspaces[0].context, [made.noteId], 'the Welcome! note, nothing picked');
  assert.equal(await projects.readDoc(ctx, made.project.id, { kind: 'workspace', workspaceId: made.workspaceId }), '', 'the page does not repeat the sentence');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(made.project.dir, 'project.json'), 'utf8')).brief, brief);

  // What custom instructions and the picked context gave @bart and Build, the answers give now: the description and the brief.
  const context = await buildContext(ctx, made.project.id, { ref: { kind: 'workspace', workspaceId: made.workspaceId }, workspaceId: made.workspaceId, askId: 'abc' });
  assert.match(context.head, /project description: How what students do before asking an AI/);
  assert.match(context.head, /<project_brief [^>]*>\nWhat they are working on: How what students do before asking an AI relates to what they learn\nWhat they are trying to do with it: Find data instructors could grade the process with\nThe question they want to answer: Which behaviors predict learning transfer\?\n<\/project_brief>/);
  // Projects made before keep their answers, still told.
  assert.match(onboarding.briefBlock({ brief: { working: 'w', unsure: 'u', findOut: 'f' } }), /What they are least sure about: u\nWhat they want to find out: f/);
  assert.match(onboarding.briefBlock({ brief: { working: 'w', why: 'y' } }), /Why they are interested in it: y/);
  onboarding.writeInstructions(ctx, 'Be blunt.');
  const again = await buildContext(ctx, made.project.id, { ref: { kind: 'workspace', workspaceId: made.workspaceId }, workspaceId: made.workspaceId, askId: 'abd' });
  assert.match(again.head, /<custom_instructions[^>]*>\nBe blunt\.\n<\/custom_instructions>/, 'instructions written before the cards are still read');
  onboarding.writeInstructions(ctx, '');
  assert.equal(onboarding.briefBlock({ brief: null }), '');

  // The sub-questions are edited (an edited one is the person's) and removed; none left, none kept.
  const [first, second] = tree.workspaces[0].starts;
  const edited = await projects.setWorkspaceStarts(ctx, made.project.id, made.workspaceId, [{ ...first, text: '  How has transfer been measured?  ', by: 'you' }, second]);
  assert.deepEqual(edited.starts.map((one) => [one.id, one.text, one.by]), [[first.id, 'How has transfer been measured?', 'you'], [second.id, second.text, 'bart']]);
  const emptied = await projects.setWorkspaceStarts(ctx, made.project.id, made.workspaceId, []);
  assert.deepEqual(emptied.starts, []);
  assert.equal('starts' in JSON.parse(fs.readFileSync(path.join(made.project.dir, made.workspaceName, 'meta.json'), 'utf8')), false);

  // No question: Getting started, as before; an existing folder typed with ~ still works.
  const plain = await onboarding.startProject(ctx, { name: 'Second', folder: 'existing', directory: '~/process-based-assessment' });
  assert.equal(plain.project.directory, made.project.directory);
  assert.equal(plain.workspaceName, 'Getting started');
  await assert.rejects(onboarding.startProject(ctx, { name: 'Third', folder: 'existing', directory: '~/missing' }), /Nothing is at/);
});

test('discardItem removes a row only while nothing holds it', async () => {
  const dir = path.join(homeDir, 'loose');
  fs.mkdirSync(dir);
  const loose = await library.addItem(ctx, dir);
  assert.equal(await onboarding.discardItem(ctx, loose.id), true);
  assert.equal(await ctx.libraryDb.get(loose.id), null);

  const pdf = path.join(homeDir, 'paper.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
  const held = await library.addItem(ctx, pdf);
  const project = await projects.createProject(ctx, 'Holder');
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Reading' });
  await projects.setWorkspaceContext(ctx, project.id, workspace.id, [held.id]);
  assert.equal(await onboarding.discardItem(ctx, held.id), false);
  assert.ok(await ctx.libraryDb.get(held.id));
});

test('the order: welcome, tools, the cards, the project; + Project the cards and the project', async () => {
  const flow = await flowModel();
  const walk = (mode, from, options) => { const out = []; let at = from; for (let i = 0; i < 20 && at !== 'open'; i += 1) { at = flow.forward(mode, at, options); out.push(at); } return out; };
  // 2026-10-08: What are you working on? → What are you trying to do with it? → their research question.
  assert.deepEqual(walk('new', 'welcome'), ['tools', 'working', 'goal', 'question', 'open']);
  assert.deepEqual(walk('existing', 'working'), ['goal', 'question', 'open']);
  assert.deepEqual(flow.flowOf('new'), ['welcome', 'tools', 'working', 'goal', 'question', 'open']);
  assert.deepEqual(flow.CARDS, ['working', 'goal', 'question']);
  for (const gone of ['import', 'instructions', 'create', 'context', 'unsure', 'why', 'together']) assert.equal(flow.flowOf('new').includes(gone), false, `${gone} is not in the flow`);
  assert.equal(flow.QUESTIONS.working.title, 'What are you working on?');
  assert.equal(flow.QUESTIONS.goal.title, 'What are you trying to do with it?');
  assert.equal(flow.QUESTIONS.question.title, 'What research question would you like to start with?');
  assert.equal(flow.pagerOf, undefined, 'no step counter');

  // Nothing to install: the tools screen is left out, and one showing when that is found out moves on to the cards.
  assert.equal(flow.forward('new', 'welcome', { tools: false }), 'working');
  assert.equal(flow.forward('new', 'tools', { tools: false }), 'working');
});

test('Skip moves on, Wrap up jumps to the question card, Submit waits for words', async () => {
  const flow = await flowModel();
  assert.equal(flow.forward('new', 'working'), 'goal');
  assert.equal(flow.forward('existing', 'goal'), 'question');
  assert.equal(flow.forward('existing', 'question'), 'open');
  for (const card of ['working', 'goal']) {
    assert.equal(flow.wrapUp('new', card), 'question', `Wrap up from ${card}`);
    assert.equal(flow.wrapUp('existing', card), 'question');
  }
  assert.equal(flow.wrapUp('existing', 'question'), 'open', 'on the last card there is nowhere to jump: on, as Submit');
  assert.deepEqual(flow.cardButtons('working', ''), { showWrap: true, submitDisabled: true });
  assert.deepEqual(flow.cardButtons('goal', ' a model '), { showWrap: true, submitDisabled: false });
  assert.deepEqual(flow.cardButtons('question', ''), { showWrap: false, submitDisabled: true }, 'their question, typed or chosen; Skip takes Bart\'s');
  assert.deepEqual(flow.cardButtons('question', 'Which behaviors predict transfer?'), { showWrap: false, submitDisabled: false });
  for (const gone of ['partsOf', 'sentenceOf', 'joinedOf', 'theirWords', 'soFarOf']) assert.equal(flow[gone], undefined, `${gone} is gone with Putting it together`);
});

test('their answers as the description, a question as a question, a plan from their words', async () => {
  const flow = await flowModel();
  assert.equal(flow.descriptionOf({ working: 'predicting student behavior', goal: 'find real data to train a model.' }), 'Predicting student behavior. Trying to: Find real data to train a model.');
  assert.equal(flow.descriptionOf({ working: 'agents', goal: '' }), 'Agents.');
  assert.equal(flow.descriptionOf({}), '');
  assert.equal(flow.questionOf('  whether they help. '), 'Whether they help?');
  assert.equal(flow.questionOf('Which behaviors predict transfer?'), 'Which behaviors predict transfer?');
  assert.equal(flow.questionOf(''), '');
  assert.deepEqual(flow.planFallback({ working: 'Teachable agents for debugging' }, 'Whether they help?'), { name: 'Teachable Agents Debugging', question: 'Whether they help?', starts: [] });
  assert.deepEqual(flow.planFallback({ working: 'I’m working on teachable agents for debugging' }, ''), { name: 'Teachable Agents Debugging', question: '', starts: [] });
});

test('onboardStep: the fastest level, never Opus: Sonnet or Luna at medium', () => {
  const models = normalizeModels(DEFAULT_MODELS);
  assert.deepEqual(onboardStep(models), { provider: 'anthropic', key: 'sonnet', model: 'claude-sonnet-5-5', name: 'Sonnet', effort: 'medium' });
  assert.deepEqual(onboardStep({ ...models, provider: 'openai' }), { provider: 'openai', key: 'luna', model: 'gpt-6-luna', name: 'Luna', effort: 'medium' });
});

test('reading what the model wrote: the line without its label, the searches, the plan, and their words when it wrote none', () => {
  assert.equal(onboard.reflectionOf('working', 'You’re working on how students ask for help.\nsearch: help seeking'), 'How students ask for help');
  assert.equal(onboard.reflectionOf('goal', '"to find real data for a model"'), 'Find real data for a model');
  assert.equal(onboard.reflectionOf('working', 'search: only searches'), '');
  assert.deepEqual(onboard.queriesIn('line\nsearch: help seeking AI tutors\n- search: "metacognition" novices\nsearch: Help seeking AI tutors\nsearch: a\nsearch: b\nsearch: c\nsearch: d'), ['help seeking AI tutors', 'metacognition novices', 'a', 'b', 'c']);
  assert.deepEqual(onboard.queriesOf('How what students do before asking an AI relates to what they learn'), ['students before asking relates learn', 'students before asking', 'asking relates learn']);
  const plan = onboard.readPlan('name: Process-Based Assessment\nquestion: which behaviors predict transfer\n1. How have prior studies measured transfer?\n2) Which behaviors does your data capture\n3. What outcome would show transfer?', { working: 'x' });
  assert.deepEqual(plan, { name: 'Process-Based Assessment', question: 'Which behaviors predict transfer?', starts: ['How have prior studies measured transfer?', 'Which behaviors does your data capture?', 'What outcome would show transfer?'], fallback: false });
  const partial = onboard.readPlan('name: X\n1. Only one?', { working: 'Teachable agents for debugging', question: 'whether novices learn more' });
  assert.equal(partial.question, 'Whether novices learn more?');
  assert.equal(partial.starts.length, 3);
  assert.ok(partial.starts.some((one) => /your own data/.test(one)), 'one is about their own data, even when made from their words');
  assert.equal(partial.fallback, true);
});

test('the sub-questions are asked for as a story: the problem first, then how it has been studied, their own data last', () => {
  const message = onboard.planMessage({ working: 'Teachable agents for debugging' });
  const [problem, studied, theirs] = [/1 is about understanding the problem/, /2 about how it has been studied/, /3, last, about their own data, study or contribution/].map((step) => message.search(step));
  assert.ok(problem > 0 && problem < studied && studied < theirs, 'the order is asked for, in that order');
  assert.match(message, /the way an advisor walks someone in/);
  const made = onboard.fallbackPlan({ working: 'Teachable agents for debugging' }).starts;
  assert.match(made[0], /count as an answer/, 'made from their words: the problem first');
  assert.match(made[1], /already been found/, 'then what has been found');
  assert.match(made[2], /your own data/, 'their own data last');
});

/** A warm session that answers as the model would, from the message (onboard.cjs's fake), counting its turns. */
function countingSession(log, { fail = false } = {}) {
  const fake = onboard.createFakeSession({ delayMs: 1 });
  return { ...fake, warm: () => { log.push('warm'); return fake.warm(); }, turn: (message, options) => { log.push(message.split('\n').pop().slice(0, 30)); return fail ? Promise.reject(new Error('no model')) : fake.turn(message, options); } };
}

/** OpenAlex's search, faked: two papers per query, one of them shared by every query. */
function fakePapers(calls) {
  return {
    async search({ query, limit }) {
      calls.push({ query, limit });
      if (/broken/.test(query)) throw new Error('OpenAlex answered 500.');
      const slug = query.replace(/\W+/g, '-');
      return { total: 2, results: [{ id: 'W1', title: 'Shared paper', authors: ['A'], year: 2020, cited_by: 10 }, { id: `W-${slug}`, title: `About ${query}`, authors: ['B'], year: 2024, cited_by: 1 }] };
    },
  };
}

test('the sessions: opened warm, a line streamed back after a card, the searches run and their papers kept with the project', async () => {
  const log = [], calls = [];
  const models = normalizeModels(DEFAULT_MODELS);
  const made = [];
  const backLog = [];
  const ob = onboard.createOnboard({ readModels: () => models, makeSession: (options) => { made.push(options); return countingSession(made.length === 1 ? log : backLog); }, papers: fakePapers(calls), now: () => '2026-10-07T00:00:00.000Z' });
  const { id } = ob.open();
  assert.equal(made.length, 2, 'the session they wait on, and one beside it for what runs while they read on, made as onboarding opens');
  assert.ok(made.every((options) => options.step.key === 'sonnet' && options.system === onboard.ONBOARD_SYSTEM_PROMPT));
  assert.deepEqual([log, backLog], [['warm'], ['warm']], 'and both warmed at once');

  const streamed = [];
  const first = await ob.answer(id, { card: 'working', answers: { working: 'How students ask AI for help' } }, { onDelta: (line) => streamed.push(line) });
  assert.equal(first.line, 'Fake reflection of how students ask ai for help');
  assert.ok(streamed.length > 1 && streamed.every((line) => !/search:/.test(line)), 'the line arrives as it is written, the searches never shown');
  assert.equal(streamed[streamed.length - 1], first.line);
  assert.equal(first.queries.length, 3);
  await ob.settled(id);
  assert.deepEqual(calls.map((call) => call.query), first.queries, 'each search the reply wrote, straight to OpenAlex');
  assert.ok(calls.every((call) => call.limit === 8));
  let found = ob.candidates(id);
  assert.equal(found.searches.length, 3);
  assert.deepEqual(found.papers.find((paper) => paper.id === 'W1').queries, first.queries, 'a paper two searches found is kept once');
  assert.equal(found.papers.length, 4);

  // Skipped: nothing is said back and nothing searched.
  assert.deepEqual(await ob.answer(id, { card: 'goal', answers: { working: 'How students ask AI for help', goal: '' } }), { line: '', queries: [] });
  const second = await ob.answer(id, { card: 'goal', answers: { working: 'How students ask AI for help', goal: 'Find data on effort' } });
  assert.equal(second.line, 'Fake goal: find data on effort');
  await ob.settled(id);

  // The project exists: everything found so far is written into it, then what the searches still running find too.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-project-'));
  assert.equal(ob.attach(id, projectDir), true);
  await ob.settled(id);
  const kept = onboard.readCandidates(projectDir);
  assert.equal(kept.searches.length, 6);
  assert.deepEqual([...new Set(kept.searches.map((one) => one.after))], ['working', 'goal']);
  assert.ok(kept.papers.length > 4);
  assert.deepEqual(kept.papers.find((paper) => paper.id === 'W1').after, ['working', 'goal']);
  await assert.rejects(ob.answer(id, { card: 'why', answers: { working: 'x' } }), /card must be working or goal|Unknown onboarding/, 'the "why" card is gone');
  assert.equal(made.length, 2, 'every card used those two');
  assert.equal(log.length, 3, 'the warm-up and the two lines said back');
  assert.equal(backLog.length, 1, 'the warm-up: nothing else ran beside');
});

test('the session failing: no line, searches from their own words, a plan from their words; a failed search is noted', async () => {
  const calls = [];
  const ob = onboard.createOnboard({ readModels: () => normalizeModels(DEFAULT_MODELS), makeSession: () => countingSession([], { fail: true }), papers: fakePapers(calls) });
  const { id } = ob.open();
  const out = await ob.answer(id, { card: 'working', answers: { working: 'Teachable agents for debugging broken code' } });
  assert.equal(out.line, '');
  assert.deepEqual(out.queries, onboard.queriesOf('Teachable agents for debugging broken code'));
  await ob.settled(id);
  const found = ob.candidates(id);
  assert.ok(found.searches.some((one) => one.error === 'OpenAlex answered 500.'));
  assert.ok(found.papers.length > 0);
  const plan = await ob.plan(id, { answers: { working: 'Teachable agents for debugging' } });
  assert.equal(plan.fallback, true);
  assert.equal(plan.name, 'Teachable Agents Debugging');
  assert.equal(plan.starts.length, 3);
  assert.deepEqual(await ob.examples(id, { answers: {} }), { examples: [] });
  assert.throws(() => ob.warm('not-open'), /Unknown onboarding/);
});

test('the plan: one asked while another runs waits; one superseded before it starts is never run', async () => {
  const sent = [];
  let release;
  const session = { provider: 'anthropic', warm: async () => 'ready', alive: () => true, close() {}, turn: (message) => { sent.push(message); if (sent.length === 1) return new Promise((resolve) => { release = () => resolve('name: First\nquestion: first?\n1. a?\n2. b?\n3. c?'); }); return Promise.resolve(`name: Latest\nquestion: latest?\n1. a?\n2. b?\n3. c? ${sent.length}`); } };
  const ob = onboard.createOnboard({ readModels: () => normalizeModels(DEFAULT_MODELS), makeSession: () => session, papers: fakePapers([]) });
  const { id } = ob.open();
  const one = ob.plan(id, { answers: { working: 'w', question: 'one?' } });
  const two = ob.plan(id, { answers: { working: 'w', question: 'two?' } });
  const three = ob.plan(id, { answers: { working: 'w', question: 'three?' } });
  release();
  assert.equal((await one).name, 'First');
  assert.equal((await two).name, 'Latest', 'answered with the newer plan');
  assert.equal((await three).name, 'Latest');
  assert.equal(sent.filter((message) => /Write exactly five lines/.test(message)).length, 2, '"two" never ran');
  assert.match(sent[1], /question they want to start with: three\?/);
});

test('the plan: their question kept as written and broken down; Bart writes one only when they skipped', async () => {
  const theirs = onboard.planMessage({ working: 'Teachable agents', goal: 'Decide what to build', question: 'Do teachable agents help novices debug?' });
  assert.match(theirs, /What are you trying to do with it\? Decide what to build/);
  assert.match(theirs, /The research question they want to start with: Do teachable agents help novices debug\?/);
  assert.match(theirs, /question: their question, exactly as they wrote it/);
  const skipped = onboard.planMessage({ working: 'Teachable agents', goal: 'Decide what to build' });
  assert.match(skipped, /question: a research question for them, .* from what they are working on and what they are trying to do with it/);
  assert.deepEqual(onboard.cleanAnswers({ working: ' a ', goal: 'b', question: 'c?', why: 'gone', unsure: 'gone' }), { working: 'a', goal: 'b', question: 'c?' });
  assert.equal(onboard.fallbackPlan({ working: 'Teachable agents', question: 'do they help' }).question, 'Do they help?');
  const ob = onboard.createOnboard({ readModels: () => normalizeModels(DEFAULT_MODELS), makeSession: () => onboard.createFakeSession({ delayMs: 1 }), papers: fakePapers([]) });
  const { id } = ob.open();
  assert.equal((await ob.plan(id, { answers: { working: 'Teachable agents', question: 'Do teachable agents help novices debug?' } })).question, 'Do teachable agents help novices debug?');
});

test('Show examples: three questions, each a different kind, grounded in the papers found; never one already seen', async () => {
  const message = onboard.examplesMessage({ working: 'Predicting student behavior', goal: 'Find real data to train a model' }, { papers: [{ title: 'Early warning systems in higher education', year: 2019 }], before: ['Seen one?'] });
  assert.match(message, /What are you trying to do with it\? Find real data to train a model/);
  assert.match(message, /- Early warning systems in higher education \(2019\)/);
  assert.match(message, /one about what is already known, one about how it has been studied or measured \(methods, data\), one about what is still open or changing/);
  assert.match(message, /Not one of these, which they have seen: "Seen one\?"/);
  assert.doesNotMatch(onboard.examplesMessage({ working: 'w' }), /Papers a search found|Not one of these/);
  assert.deepEqual(onboard.readExamples('1. which datasets have been used to predict dropout\n2) How is engagement measured in online courses?\n- Which datasets have been used to predict dropout?\n3. short?\n4. What is still open about early warning systems?\nfree text'), ['Which datasets have been used to predict dropout?', 'How is engagement measured in online courses?', 'What is still open about early warning systems?']);

  // The session beside: grounded in the papers the searches found, the most-found first; ↻ never repeats.
  const sent = [];
  const fake = onboard.createFakeSession({ delayMs: 1 });
  const ob = onboard.createOnboard({ readModels: () => normalizeModels(DEFAULT_MODELS), makeSession: () => ({ ...fake, turn: (text, options) => { sent.push(text); return fake.turn(text, options); } }), papers: fakePapers([]) });
  const { id } = ob.open();
  await ob.answer(id, { card: 'working', answers: { working: 'Predicting student behavior' } });
  await ob.settled(id);
  const first = await ob.examples(id, { answers: { working: 'Predicting student behavior', goal: 'Find data' } });
  assert.equal(first.examples.length, 3);
  assert.ok(first.examples.every((one) => /\?$/.test(one)));
  assert.match(sent[sent.length - 1], /- Shared paper \(2020\)/, 'the paper every search found is listed first');
  const again = await ob.examples(id, { answers: { working: 'Predicting student behavior', goal: 'Find data' }, seen: first.examples });
  assert.equal(again.examples.length, 3);
  assert.ok(again.examples.every((one) => !first.examples.includes(one)), 'three new ones');
  assert.ok(first.examples.every((one) => sent[sent.length - 1].includes(one)), 'those seen are named as not to say again');
  const failing = onboard.createOnboard({ readModels: () => normalizeModels(DEFAULT_MODELS), makeSession: () => countingSession([], { fail: true }), papers: fakePapers([]) });
  assert.deepEqual(await failing.examples(failing.open().id, { answers: { working: 'w' } }), { examples: [] });
});

test('the warm session: Claude Code once, its turns as stream-json on stdin, the text as it arrives; started again after it dies', async () => {
  const spawned = [];
  const spawn = (shell, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { child.emit('exit', null); };
    spawned.push({ args, options, child });
    let n = 0;
    child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        n += 1;
        const text = message.message.content === 'Reply with the one word: ready' ? 'ready' : `answer ${n}`;
        const event = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
        setImmediate(() => {
          for (const piece of [text.slice(0, 3), text.slice(3)]) event({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
          event({ type: 'result', result: text, is_error: false });
        });
      }
    });
    return child;
  };
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-onboard-run-'));
  const session = createWarmSession({ step: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' }, system: 'be brief', runDirectory, environment: { SHELL: '/bin/zsh', PATH: process.env.PATH, HOME: homeDir, ANTHROPIC_API_KEY: 'never' }, spawn });
  assert.equal(await session.warm(), 'ready');
  const deltas = [];
  assert.equal(await session.turn('first card', { onDelta: (text) => deltas.push(text) }), 'answer 2');
  assert.deepEqual(deltas, ['ans', 'answer 2']);
  assert.equal(await session.turn('second card'), 'answer 3');
  assert.equal(spawned.length, 1, 'one process for every turn');
  const command = spawned[0].args[spawned[0].args.length - 1];
  assert.match(command, /claude -p --input-format stream-json --output-format stream-json .*--no-session-persistence --restricted .*--tools "" --model "\$ENGELBART_ONBOARD_MODEL" --effort medium/);
  assert.equal(spawned[0].options.env.ENGELBART_ONBOARD_MODEL, 'claude-sonnet-5-5');
  assert.equal(spawned[0].options.env.ANTHROPIC_API_KEY, undefined, 'never an API key');

  spawned[0].child.emit('exit', 1);
  assert.equal(session.alive(), false);
  assert.equal(await session.turn('after it died'), 'answer 1');
  assert.equal(spawned.length, 2, 'started again on the next turn');
  session.close();
  await assert.rejects(session.turn('closed'), /closed/);
  assert.deepEqual(claudeEvent('{"type":"result","result":"x","is_error":true}'), { result: 'x', error: true });
  assert.equal(claudeEvent('not json'), null);
});

test('the tools screen: undecided until the first check, then only when something is to be installed (2026-09-28)', async () => {
  const flow = await flowModel();
  const tool = (status, more = {}) => ({ status, installed: status !== 'missing', skip: false, busy: null, autoUpdate: false, ...more });
  const snap = (git, claude, codex, checked = true) => ({ checked, tools: { git, claude, codex } });
  assert.equal(flow.toolsWanted(null), null);
  assert.equal(flow.toolsWanted(snap(tool('missing'), tool('missing'), tool('missing'), false)), null);
  assert.equal(flow.toolsWanted(snap(tool('missing'), tool('missing'), tool('missing'))), true, 'a new Mac');
  assert.equal(flow.toolsWanted(snap(tool('missing'), tool('ready'), tool('missing'))), true, 'Git alone');
  assert.equal(flow.toolsWanted(snap(tool('ready'), tool('missing'), tool('missing'))), true, 'no agent');
  assert.equal(flow.toolsWanted(snap(tool('ready'), tool('missing'), tool('ready'))), false, 'one agent is enough');
  assert.equal(flow.toolsWanted(snap(tool('ready'), tool('signed-out'), tool('missing'))), false, 'signing in waits for the dialog');
  assert.equal(flow.toolsWanted(snap(tool('missing', { busy: { action: 'install' } }), tool('ready'), tool('ready'))), false, 'already installing');
});
