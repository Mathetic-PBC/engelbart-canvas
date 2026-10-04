'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { DEFAULT_MODELS, PAST_DEFAULT_MODELS, MODELS_FILE, normalizeModels, onlyProviders, preferUsable, startingAt, buildChoices, loadModels, effortOf, modelOf, readFlags, readQuestion, withChoice } = require('../src/main/bart/models.cjs');
const { CHOICES_FILE, readChoices, rememberChoice } = require('../src/main/bart/choices.cjs');
const { climb, levelBlock, createBart, createFakeBart, createThreads, threadKey, cleanTurns, THREAD_IDLE_MS } = require('../src/main/bart/ask.cjs');
const { PENDING_RE, replyLines, answerText, failureLines, attribution } = require('../src/main/bart/reply.cjs');
const { buildContext, markPlace, conversationBlock, catalogEntries, HERE } = require('../src/main/bart/context.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');

const DEFAULTS = normalizeModels(null);
// Most tests below were written while Codex was the default provider (until 2026-09-29). They test flags, the loop and
// the runners, not the default, so they keep Codex as it; the defaults themselves are tested with DEFAULTS.
const MODELS = { ...DEFAULTS, provider: 'openai' };
const ladder = (text, models = MODELS) => readQuestion(text, models).steps.map((step) => `${step.name} ${step.effort}`);

test('the ladders are the ones asked for: Sol medium, Sol high, Astra xhigh; Sonnet high, Opus high, Fable xhigh; Claude Code first (2026-09-29)', () => {
  assert.deepEqual(ladder('why?'), ['Sol medium', 'Sol high', 'Astra xhigh']);
  assert.deepEqual(readQuestion('why?', { ...MODELS, provider: 'anthropic' }).steps.map((step) => `${step.model} ${step.effort}`), ['claude-sonnet-5-5 high', 'opus high', 'fable xhigh']);
  assert.equal(readQuestion('why?', MODELS).pinned, false);
  assert.deepEqual(ladder('why?', DEFAULTS), ['Sonnet high', 'Opus high', 'Fable xhigh'], '@bart starts on Sonnet high');
  assert.deepEqual([DEFAULTS.providers.openai.models.sol.id, DEFAULTS.providers.openai.models.luna.id, DEFAULTS.providers.anthropic.models.sonnet.id], ['gpt-6.1-sol', 'gpt-6-luna', 'claude-sonnet-5-5'], 'GPT-6.1 Sol (2026-09-29), GPT-6 Luna (still the latest), Sonnet 5.5 by version');
});

test('flags are matched loosely, from either end, and pin one step', () => {
  for (const [text, question, step] of [
    ['--fable why', 'why', 'Fable xhigh'],
    ['--Opus --Extra-High prove it', 'prove it', 'Opus xhigh'],
    ['--extra high how', 'how', 'Astra xhigh'],
    ['why --sonnet', 'why', 'Sonnet high'],
    ['--high hm', 'hm', 'Sol high'],
    ['--fable5.1 --XHIGH q', 'q', 'Fable xhigh'],
    ['--gpt-6-sol --med q', 'q', 'Sol medium'],
    ['--claude-opus-5-5 q --max', 'q', 'Opus max'], // Claude Code's top effort (2026-09-21)
    ['--sol --ultra q', 'q', 'Sol ultra'], // Codex's top effort
    ['--astra --max q', 'q', 'Astra ultra'], // max is not in Codex's list: of the two equally near, the higher
    ['--opus --ultra q', 'q', 'Opus max'], // ultra is not in Claude Code's list: the nearest that is
    ['--luna --low q', 'q', 'Luna medium'],
  ]) {
    const read = readQuestion(text, MODELS);
    assert.deepEqual([read.question, read.pinned, read.steps.map((s) => `${s.name} ${s.effort}`)], [question, true, [step]], text);
  }
  const kept = readQuestion('--nope what does --verbose do', MODELS);
  assert.deepEqual([kept.question, kept.pinned], ['--nope what does --verbose do', false]);
  assert.equal(effortOf(' X-High '), 'xhigh');
  assert.deepEqual(modelOf('Fable 5.1', MODELS), { provider: 'anthropic', model: 'fable' });
  assert.equal(modelOf('gemini', MODELS), null);
});

test('flags are found where they stand, so the editor can mark them, and a choice from the selector rewrites them', () => {
  const at = (text) => readFlags(text, MODELS).spans.map(([from, to]) => text.slice(from, to));
  assert.deepEqual(at('--Opus  --Extra-High prove --it'), ['--Opus', '--Extra-High']);
  assert.deepEqual(at('--extra high how --sonnet'), ['--extra', 'high', '--sonnet']);
  assert.deepEqual(at('--nope what does --verbose do'), []);
  assert.deepEqual(at('why --gemini --high'), ['--high'], 'a word that names nothing ends the taking');
  assert.equal(withChoice('--fable why --max', MODELS, { model: 'luna', effort: 'medium' }), '--luna --medium why');
  assert.equal(withChoice('', MODELS, { model: 'opus', effort: 'high' }), '--opus --high');
  const read = readQuestion(withChoice('why', MODELS, { model: 'opus', effort: 'xhigh' }), MODELS);
  assert.deepEqual([read.question, read.pinned, read.provider, read.steps.map((s) => `${s.name} ${s.effort}`)], ['why', true, 'anthropic', ['Opus xhigh']]);
});

test('--build on an @bart line: found anywhere, in any case, and the rest is the request without it or the model and effort flags (2026-10-02)', () => {
  const { readBuildFlag, buildRequestOf } = require('../src/main/bart/question.cjs');
  assert.deepEqual(readBuildFlag('--build add a hello comment to README', MODELS), { build: true, rest: 'add a hello comment to README' });
  assert.deepEqual(readBuildFlag('add a hello --Build comment', MODELS), { build: true, rest: 'add a hello comment' }, 'in the middle');
  assert.deepEqual(readBuildFlag('what does --builder do', MODELS), { build: false, rest: 'what does --builder do' }, 'absent: --builder is not it');
  assert.deepEqual(readBuildFlag('--opus --high --build implement @[Some Note]', MODELS), { build: true, rest: 'implement @[Some Note]' }, 'mixed with --opus --high');
  assert.deepEqual(readBuildFlag('--build', MODELS), { build: true, rest: '' });
  assert.deepEqual(buildRequestOf({ agent: 'bart', text: '--build add tests' }, MODELS), { request: 'add tests' });
  assert.deepEqual(buildRequestOf({ text: '--build add tests' }, MODELS), { request: 'add tests' }, 'an ask with no agent is @bart');
  assert.equal(buildRequestOf({ agent: 'bart', text: 'why is it slow?' }, MODELS), null, 'without the flag it is an ask');
  for (const agent of ['discover', 'brainstorm']) assert.equal(buildRequestOf({ agent, text: '--build a parser' }, MODELS), null, `@${agent}: --build is words for the agent`);
});

test('only the providers config.json lists are offered: the rest have no models, no flags and cannot be the default', () => {
  const claude = onlyProviders(MODELS, ['anthropic']);
  assert.deepEqual([Object.keys(claude.providers), claude.provider], [['anthropic'], 'anthropic']);
  assert.deepEqual(readQuestion('why?', claude).steps.map((s) => `${s.name} ${s.effort}`), ['Sonnet high', 'Opus high', 'Fable xhigh']);
  const kept = readQuestion('--sol why?', claude);
  assert.deepEqual([kept.question, kept.pinned], ['--sol why?', false], 'a model of a provider that is not offered is not a flag');
  assert.equal(onlyProviders(MODELS, ['openai', 'anthropic']).provider, 'openai');
  assert.deepEqual(Object.keys(onlyProviders(MODELS, []).providers), ['openai', 'anthropic'], 'a list that leaves nothing is ignored: a question can always run');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-only-'));
  assert.deepEqual(Object.keys(loadModels(root, { only: ['openai'] }).providers), ['openai']);
});

test('@bart starts on a CLI that can run: the saved default when it can, else the other; nothing is written (2026-09-23)', () => {
  const start = (usable, models = MODELS) => readQuestion('why?', preferUsable(models, usable)).steps[0].name;
  assert.equal(start(null), 'Sol', 'before the first check: the saved default');
  assert.equal(start(['codex', 'claude']), 'Sol', 'both: the saved default');
  assert.equal(start(['claude']), 'Sonnet', 'only Claude Code');
  assert.equal(start(['codex']), 'Sol', 'only Codex');
  assert.equal(start([]), 'Sol', 'neither: the saved default, which reports what is missing');
  assert.equal(start(['codex'], { ...MODELS, provider: 'anthropic' }), 'Sol', 'a saved Claude default moves to Codex while Claude Code cannot run');
  const picked = readQuestion('--opus why?', preferUsable(MODELS, ['codex']));
  assert.deepEqual([picked.provider, picked.pinned], ['anthropic', true], 'a model picked by flag is never moved');
  assert.equal(preferUsable(onlyProviders(MODELS, ['openai']), ['claude']).provider, 'openai', 'a provider config.json does not offer is never chosen');
  assert.equal(start(['codex', 'claude'], DEFAULTS), 'Sonnet', 'the default since 2026-09-29: Claude Code, Sonnet high');
  assert.equal(start(['codex'], DEFAULTS), 'Sol', 'signed in to Codex only: Codex, as before');
});

test('Build and a post-it\'s quick task start on Opus high while Claude Code can run, else on Codex (2026-09-29)', () => {
  const opening = (usable, models = DEFAULTS) => { const choices = buildChoices(preferUsable(models, usable)); const step = choices.providers[choices.provider].ladder[0]; return `${choices.provider} ${step.model} ${step.effort}`; };
  assert.equal(opening(null), 'anthropic opus high');
  assert.equal(opening(['codex', 'claude']), 'anthropic opus high');
  assert.equal(opening(['codex']), 'openai sol high', 'only signed in to Codex');
  assert.equal(opening(['claude'], { ...DEFAULTS, provider: 'openai' }), 'anthropic opus high', 'Build has a provider of its own, not @bart\'s');
});

test('what was last picked by hand is where @bart, Build and a quick task start next time, each on its own (2026-09-29)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-choices-'));
  assert.deepEqual(readChoices(root), {});
  assert.deepEqual(rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'high' }), { provider: 'anthropic', model: 'opus', effort: 'high' });
  rememberChoice(root, 'build', { provider: 'openai', model: 'astra', effort: 'xhigh' });
  assert.equal(rememberChoice(root, 'quick', { provider: 'openai', model: 'rm -rf', effort: 'high' }), null, 'a pick that is not one is not kept');
  assert.equal(rememberChoice(root, 'elsewhere', { provider: 'openai', model: 'sol', effort: 'high' }), null);
  assert.deepEqual(readChoices(root), { bart: { provider: 'anthropic', model: 'opus', effort: 'high' }, build: { provider: 'openai', model: 'astra', effort: 'xhigh' } });
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, CHOICES_FILE), 'utf8')).about.length > 50);
  const held = readChoices(root);
  // @bart: a question without flags starts on the pick, and the ladder goes on above it.
  assert.deepEqual(ladder('why?', startingAt(DEFAULTS, 'bart', held.bart)), ['Opus high', 'Fable xhigh']);
  assert.deepEqual(ladder('why?', startingAt(DEFAULTS, 'bart', { provider: 'anthropic', model: 'sonnet', effort: 'medium' })), ['Sonnet medium', 'Sonnet high', 'Opus high', 'Fable xhigh']);
  assert.deepEqual(ladder('why?', startingAt(DEFAULTS, 'bart', { provider: 'openai', model: 'luna', effort: 'high' })), ['Luna high', 'Sol medium', 'Sol high', 'Astra xhigh']);
  assert.deepEqual(ladder('--sonnet why?', startingAt(DEFAULTS, 'bart', held.bart)), ['Sonnet high'], 'flags still pick by hand');
  assert.deepEqual(ladder('--max why?', startingAt(DEFAULTS, 'bart', held.bart)), ['Opus max'], 'an effort alone keeps the model it would start on');
  assert.deepEqual(ladder('why?', preferUsable(startingAt(DEFAULTS, 'bart', held.bart), ['codex'])), ['Sol medium', 'Sol high', 'Astra xhigh'], 'a pick whose CLI cannot run gives way');
  assert.deepEqual(ladder('why?', startingAt(DEFAULTS, 'bart', { provider: 'anthropic', model: 'gone', effort: 'high' })), ['Sonnet high', 'Opus high', 'Fable xhigh'], 'a model no longer listed is not started on');
  // Build and a quick task: the pick is the dialog's first choice.
  const build = buildChoices(startingAt(DEFAULTS, 'build', held.build));
  assert.deepEqual([build.provider, build.providers.openai.ladder], ['openai', [{ model: 'astra', effort: 'xhigh' }]]);
  assert.deepEqual(buildChoices(startingAt(DEFAULTS, 'quick', held.quick)).providers.anthropic.ladder, [{ model: 'opus', effort: 'high' }], 'nothing picked for a quick task: the default');
  assert.equal(buildChoices(preferUsable(startingAt(DEFAULTS, 'build', held.build), ['claude'])).provider, 'anthropic');
});

test('the models file is written with the defaults, read again each time, keeps what the person edited, and a broken one falls back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-'));
  assert.deepEqual(loadModels(root), normalizeModels(DEFAULT_MODELS));
  const file = path.join(root, MODELS_FILE);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).about.length > 100);
  fs.writeFileSync(file, JSON.stringify({ provider: 'anthropic', providers: { anthropic: { models: { opus: { id: 'opus' }, bad: { id: 'rm -rf $HOME' } }, ladder: [{ model: 'opus', effort: 'Extra High' }, { model: 'gone', effort: 'high' }] } } }));
  const edited = loadModels(root);
  assert.equal(edited.provider, 'anthropic');
  assert.deepEqual(Object.keys(edited.providers.anthropic.models), ['opus']);
  assert.deepEqual(edited.providers.anthropic.ladder, [{ model: 'opus', effort: 'xhigh' }]);
  assert.deepEqual(edited.providers.openai.ladder, DEFAULT_MODELS.providers.openai.ladder);
  fs.writeFileSync(file, '{ not json');
  assert.equal(loadModels(root).provider, DEFAULT_MODELS.provider);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'a file being edited is never overwritten');
});

test('a default changed in a later build reaches installs that already have the file; what the person changed stays (2026-09-23)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-carry-'));
  const file = path.join(root, MODELS_FILE);
  loadModels(root);
  // this install's file was given an older set of defaults, and its owner changed Claude Code's ladder
  const given = JSON.parse(JSON.stringify(DEFAULT_MODELS));
  given.provider = 'openai';
  given.providers.openai.ladder = [{ model: 'luna', effort: 'medium' }];
  fs.writeFileSync(path.join(root, '.defaults', MODELS_FILE), JSON.stringify(given));
  const theirs = JSON.parse(JSON.stringify(given));
  theirs.providers.anthropic.ladder = [{ model: 'opus', effort: 'high' }];
  fs.writeFileSync(file, JSON.stringify(theirs));
  const loaded = loadModels(root);
  assert.equal(loaded.provider, 'anthropic', 'the default provider they never touched follows the new default');
  assert.deepEqual(loaded.providers.openai.ladder, DEFAULT_MODELS.providers.openai.ladder, 'so does the ladder they never touched');
  assert.deepEqual(loaded.providers.anthropic.ladder, [{ model: 'opus', effort: 'high' }], 'the ladder they changed is theirs');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.defaults', MODELS_FILE), 'utf8')), DEFAULT_MODELS);
});

test('a file written before defaults were carried (Hudson\'s: 09-20 wording, 09-21 efforts added by hand) comes up to date and is backed up', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-legacy-'));
  const file = path.join(root, MODELS_FILE);
  const legacy = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS[0]));
  legacy.providers.openai.efforts = [...DEFAULT_MODELS.providers.openai.efforts];
  legacy.providers.anthropic.efforts = [...DEFAULT_MODELS.providers.anthropic.efforts];
  legacy.providers.anthropic.models.sonnet.use = 'My own words.';
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  loadModels(root);
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(now.about, DEFAULT_MODELS.about);
  assert.deepEqual(now.providers.openai.efforts, ['medium', 'high', 'xhigh', 'ultra']);
  assert.equal(now.providers.anthropic.models.sonnet.use, 'My own words.');
  const copies = fs.readdirSync(path.join(root, '.backups'));
  assert.equal(copies.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.backups', copies[0]), 'utf8')).about, PAST_DEFAULT_MODELS[0].about);
});

test('untouched 5.6 models move to the latest in a model file without a saved defaults base', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-upgrade-'));
  const file = path.join(root, MODELS_FILE);
  const old = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS[2]));
  old.providers.openai.models.astra.use = 'My own words.';
  fs.writeFileSync(file, JSON.stringify(old));
  const models = loadModels(root);
  assert.equal(models.providers.openai.models.sol.id, 'gpt-6.1-sol');
  assert.equal(models.providers.openai.models.luna.id, 'gpt-6-luna');
  assert.equal(models.providers.openai.models.astra.use, 'My own words.');
});

test('a file left as 2026-09-27 wrote it moves to GPT-6.1 Sol, Sonnet 5.5, Claude Code first and Build on Opus; a choice of its own stays', () => {
  for (const withBase of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-0929-'));
    const shipped = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS[3]));
    const mine = JSON.parse(JSON.stringify(shipped));
    mine.providers.openai.ladder = [{ model: 'luna', effort: 'high' }];
    fs.writeFileSync(path.join(root, MODELS_FILE), JSON.stringify(mine));
    if (withBase) { fs.mkdirSync(path.join(root, '.defaults')); fs.writeFileSync(path.join(root, '.defaults', MODELS_FILE), JSON.stringify(shipped)); }
    const models = loadModels(root);
    assert.deepEqual([models.provider, models.providers.openai.models.sol.id, models.providers.anthropic.models.sonnet.id], ['anthropic', 'gpt-6.1-sol', 'claude-sonnet-5-5'], withBase ? 'with a base' : 'without one');
    assert.deepEqual(models.providers.anthropic.ladder[0], { model: 'sonnet', effort: 'high' });
    assert.deepEqual([models.build.provider, models.build.providers.openai.models.sol.id, models.build.providers.anthropic.models.sonnet.id], ['anthropic', 'gpt-6.1-sol', 'claude-sonnet-5-5']);
    assert.deepEqual(models.providers.openai.ladder, [{ model: 'luna', effort: 'high' }], 'what they changed stays');
  }
});

test('climb: an answer ends it; ESCALATE resumes the same session one step up; the top step is told to answer', async () => {
  const steps = readQuestion('q', MODELS).steps;
  const seen = [];
  const progress = [];
  const replies = ['ESCALATE: needs a proof', 'ESCALATE: still hard', 'ESCALATE: no', 'the answer'];
  const out = await climb({ steps, pinned: false, first: (level) => `FIRST ${level}`, onProgress: (p) => progress.push(`${p.step}/${p.of} ${p.name} ${p.effort} up${p.movedUp}`), turn: async ({ level, message, session }) => { seen.push({ level: `${level.name} ${level.effort}`, session, message }); return { text: replies.shift(), session: 's1' }; } });
  assert.equal(out.text, 'the answer');
  assert.deepEqual(seen.map((call) => [call.level, call.session]), [['Sol medium', null], ['Sol high', 's1'], ['Astra xhigh', 's1'], ['Astra xhigh', 's1']]);
  assert.match(seen[0].message, /^FIRST <level>You are running as Sol at medium effort, step 1 of 3\. A higher step exists: Sol at high effort\.<\/level>$/);
  assert.match(seen[2].message, /step 3 of 3\. No higher step exists\./);
  assert.match(seen[3].message, /Answer the question now, as well as you can/);
  assert.deepEqual(out.trail.map((step) => [step.name, step.effort, step.why]), [['Sol', 'medium', 'needs a proof'], ['Sol', 'high', 'still hard']]);
  assert.deepEqual(progress, ['1/3 Sol medium up0', '2/3 Sol high up1', '3/3 Astra xhigh up2', '3/3 Astra xhigh up2']);
  assert.match(levelBlock(readQuestion('--opus q', MODELS).steps, 0, true), /chose this model and effort by hand: no higher step exists/);
});

test('climb: a long reply that merely starts with the word is an answer, and a model that never answers is reported', async () => {
  const steps = readQuestion('--sonnet q', MODELS).steps;
  const long = `ESCALATE: ${'x'.repeat(600)}`;
  assert.equal((await climb({ steps, pinned: true, first: () => 'm', turn: async () => ({ text: long, session: 's' }) })).text, long);
  const stuck = await climb({ steps, pinned: true, first: () => 'm', turn: async () => ({ text: 'ESCALATE: cannot', session: 's' }) });
  assert.equal(stuck.text, 'I could not answer this at the highest step available. cannot');
});

test('an answer becomes kept lines that say which model gave it; quotes are flattened, code blocks kept as written', async () => {
  const meta = { level: { name: 'Sol', effort: 'high' }, trail: [{ name: 'Sol', effort: 'medium' }], ms: 41_400 };
  assert.equal(attribution(meta), '*Sol · high · 41 s · moved up from Sol medium*');
  assert.equal(attribution(meta, { model: false }), '*41 s*', '@brainstorm\'s foot: the time alone (2026-10-02)');
  assert.deepEqual(replyLines('One.', meta, { model: false }), ['bart> One.', 'bart>', 'bart> *41 s*']);
  const written = replyLines('One.\n\n\n\n## Two  \n> quoted\n- item\r\n', meta);
  assert.deepEqual(written, ['bart> One.', 'bart>', 'bart> ## Two', 'bart> quoted', 'bart> - item', 'bart>', 'bart> *Sol · high · 41 s · moved up from Sol medium*']);
  // 2026-09-22: a fenced block is kept line for line, indent, blank lines and all; one left open is closed.
  assert.deepEqual(replyLines('Use:\n```json\n{\n  "a": 1,\n\n\n\n> not a quote\n}\n```\nDone.', null), ['bart> Use:', 'bart> ```json', 'bart> {', 'bart>   "a": 1,', 'bart>', 'bart>', 'bart>', 'bart> > not a quote', 'bart> }', 'bart> ```', 'bart> Done.']);
  assert.deepEqual(replyLines('Cut off:\n~~~~sh\nls -la\n\n', null), ['bart> Cut off:', 'bart> ~~~~sh', 'bart> ls -la', 'bart> ~~~~']);
  assert.deepEqual(replyLines('', null), ['bart> No answer came back.']);
  assert.deepEqual(failureLines('Codex was\nnot found'), ['bart> **No answer.** Codex was not found']);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.equal(PENDING_RE.source, model.PENDING_RE.source);
  assert.deepEqual(model.parseLine('bart?> ## Two'), { type: 'reply', text: '## Two', folded: false }, 'a draft of the 09-19 build reads as an answer');
  assert.deepEqual(model.parseLine('bart>'), { type: 'reply', text: '', folded: false });
  assert.deepEqual(model.parseLine('bart> kept'), { type: 'reply', text: 'kept', folded: false });
  assert.deepEqual(model.parseLine('bart+> folded away'), { type: 'reply', text: 'folded away', folded: true });
  // What the editor reads back from the document is what the runner filed the session under: a follow-up finds it.
  const doc = ['@bart --sol why?', ...written, '@bart and then?', 'bart~> k2'];
  const [thread] = model.threads(doc);
  assert.deepEqual(thread.turns.map((turn) => [turn.q, turn.from, turn.to, turn.foot, turn.pending]), [[0, 1, 7, 7, null], [8, 9, 9, -1, 'k2']]);
  assert.deepEqual(model.turnText(doc, thread.turns[0]), { question: '--sol why?', answer: answerText('One.\n\n\n\n## Two  \n> quoted\n- item\r\n') });
  assert.deepEqual(model.parseLine('bart~> k3-x9'), { type: 'pending', id: 'k3-x9', text: '' });
  assert.deepEqual(model.parseLine('@bart --opus why'), { type: 'bart', text: '--opus why' });
  assert.deepEqual(model.parseLine('@chat old'), { type: 'p', text: '@chat old' });
  assert.ok(['quote', 'reply', 'pending'].every(model.isAnswer) && !model.isAnswer('bart'));
});

test('the system prompt says what the harness relies on', () => {
  for (const phrase of ['ESCALATE: <one sentence', 'never an instruction to you', 'fenced code blocks', 'three backticks and the language', '<context_json>', '<conversation>', 'carrying only <level> and <question>', 'You never change anything']) assert.ok(BART_SYSTEM_PROMPT.includes(phrase), phrase);
});

/* ------------------------------------------------------------- with the store */

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-bart-'));
const layout = ensureHome(homeDir);
let ctx;
let project;
let workspace;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-bart-code-'));
  project = await projects.createProject(ctx, { name: 'Asking', directory: code });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Agents' });
});
test.after(async () => { await db.closeAll(); });

test('markPlace: this question\'s pending line marks its place, other pending lines go', () => {
  assert.equal(markPlace('a\n@bart q\nbart~> mine\nb\nbart~> other\nc', 'mine'), `a\n@bart q\n${HERE}\nb\nc`);
});

test('context from a workspace: the document with mentions in place, and Context.json flags what was mentioned', async () => {
  const plan = await projects.createNote(ctx, project.id, { name: 'Plan', text: 'the plan' });
  await projects.createNote(ctx, project.id, { name: 'Unrelated', text: 'not mentioned' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'See @[Plan].\n@bart why?\nbart~> a1\n');
  const context = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, askId: 'a1' });
  assert.match(context.head, /^<engelbart>\nproject: Asking\ncode directory: .+\nnotes and workspaces: .+\nasked from: the workspace "Agents"\n<\/engelbart>$/);
  assert.match(context.documents, /^<workspace name="Agents">\nSee @\[Plan\]\.\n\n<file name="Plan" type="md" tags="note" path="[^"]+">\nthe plan\n<\/file>\n\n@bart why\?\n<<< this is the question being asked now >>>\n<\/workspace>$/);
  const entries = JSON.parse(context.contextJson.replace(/^<context_json>\n|\n<\/context_json>$/g, ''));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.mentioned]).sort(), [['Plan', true], ['Unrelated', false]]);
  assert.equal(entries.find((entry) => entry.name === 'Plan').path, (await ctx.libraryDb.get(plan.id)).path);
  assert.deepEqual(context.dirs, [project.directory, ctx.dataRoot]);
});

test('context from a note: the workspace and the note are separate blocks, and the note is not repeated inside the workspace', async () => {
  const asked = await projects.createNote(ctx, project.id, { name: 'Asked here', text: 'body\n@bart what?\nbart~> n1', workspaceId: workspace.id });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'Top. @[Asked here]\n');
  const context = await buildContext(ctx, project.id, { ref: { kind: 'note', id: asked.id }, workspaceId: workspace.id, askId: 'n1' });
  assert.match(context.head, /asked from: the note "Asked here", opened from the workspace "Agents"/);
  assert.equal(context.documents, `<workspace name="Agents">\nTop. @[Asked here]\n</workspace>\n\n<note name="Asked here">\nbody\n@bart what?\n${HERE}\n</note>`);
});

test('the fake agent (scripted runs) answers through the same loop, moves up on "hard", and stops', async () => {
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 5 });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const progress = [];
  const out = await bart.ask(ctx, project.id, { askId: 'f1', ref, workspaceId: workspace.id, text: 'a hard one' }, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(progress.filter((p) => p.step).map((p) => p.step), [1, 2]);
  assert.deepEqual(progress.filter((p) => p.log).map((p) => p.activity).slice(0, 2), ['Reading notes.md', 'Searching the web for “fake”']);
  const previews = progress.filter((p) => p.lines).map((p) => p.lines.join('\n'));
  assert.ok(previews.length > 1 && previews[previews.length - 1].startsWith('FAKE ANSWER to "a hard one".'), 'the answer arrives in pieces');
  assert.ok(previews.every((text) => !/ESCALATE/.test(text)), 'a request to move up is never shown as an answer');
  assert.equal(out.lines[0], 'bart> FAKE ANSWER to "a hard one".');
  assert.equal(out.lines[out.lines.length - 1].startsWith('bart> *Sol · high · '), true);
  assert.match(out.lines[out.lines.length - 1], /moved up from Sol medium\*$/);
  const slow = createFakeBart({ readModels: () => MODELS, delayMs: 5000 });
  const waiting = slow.ask(ctx, project.id, { askId: 'f2', ref, workspaceId: workspace.id, text: 'q' });
  setTimeout(() => slow.stop('f2'), 20);
  await assert.rejects(waiting, (error) => error.kind === 'stopped');
});

test('a question asked with a model picked by hand hands it on to be kept; one without flags does not', async () => {
  const picked = [];
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 5, onPicked: (choice) => picked.push(choice) });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await bart.ask(ctx, project.id, { askId: 'p1', ref, workspaceId: workspace.id, text: 'why?' });
  await bart.ask(ctx, project.id, { askId: 'p2', ref, workspaceId: workspace.id, text: '--opus --xhigh why?' });
  await bart.ask(ctx, project.id, { askId: 'p3', ref, workspaceId: workspace.id, text: 'why?', choice: { model: 'sol', effort: 'high' } });
  assert.deepEqual(picked, [{ provider: 'anthropic', model: 'opus', effort: 'xhigh' }, { provider: 'openai', model: 'sol', effort: 'high' }]);
});

test('with the tool check: a question holds its CLI\'s lock, and a CLI the login PATH misses runs by its full path (2026-09-23)', async () => {
  const authFile = path.join(homeDir, 'auth-tools.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const events = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], env: options.env });
    events.push('run');
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, 'answer');
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n');
  };
  const tools = {
    binaryFor: (name) => (name === 'codex' ? '/Users/someone/.local/bin/codex' : null),
    ensure: async (name) => { events.push(`ensure ${name}`); },
    use: async (name, fn) => { events.push(`lock ${name}`); try { return await fn(); } finally { events.push(`unlock ${name}`); } },
    check: async () => {},
  };
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-tools'), codexHome: path.join(homeDir, 'codex-home-tools'), codexAuthFile: authFile, run, tools });
  const out = await bart.ask(ctx, project.id, { askId: 't1', ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, text: 'why?' });
  assert.equal(out.lines[0], 'bart> answer');
  assert.deepEqual(events, ['ensure codex', 'lock codex', 'run', 'unlock codex']);
  assert.match(calls[0].command, /^exec "\$ENGELBART_CODEX_BIN" exec --color never /);
  assert.equal(calls[0].env.ENGELBART_CODEX_BIN, '/Users/someone/.local/bin/codex');
});

test('while Engelbart\'s own Git stands in, a question\'s CLI finds it first on PATH (2026-09-28)', async () => {
  const authFile = path.join(homeDir, 'auth-git.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], env: options.env });
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, 'answer');
    callback(null, '');
  };
  const tools = { binaryFor: () => null, ensure: async () => {}, use: async (_name, fn) => fn(), check: async () => {}, environment: () => ({ ENGELBART_GIT_BIN: '/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin' }) };
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-git'), codexHome: path.join(homeDir, 'codex-home-git'), codexAuthFile: authFile, run, tools });
  await bart.ask(ctx, project.id, { askId: 'g1', ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, text: 'why?' });
  assert.match(calls[0].command, /^PATH="\$ENGELBART_GIT_BIN:\$PATH"; exec codex exec --color never /);
  assert.equal(calls[0].env.ENGELBART_GIT_BIN, '/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin');
});

test('the real runner: command lines, private folders, the subscription, and a resumed session (the CLI itself is stubbed)', async () => {
  const authFile = path.join(homeDir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const replies = ['ESCALATE: deeper', 'done'];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, cwd: options.cwd, env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    const text = replies.shift();
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, text); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n'); }
    else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`);
  };
  const runDirectory = path.join(homeDir, 'runs');
  const codexHome = path.join(homeDir, 'codex-home-bart');
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir, OPENAI_API_KEY: 'sk-never', ANTHROPIC_API_KEY: 'sk-never' }, runDirectory, codexHome, codexAuthFile: authFile, run });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const out = await bart.ask(ctx, project.id, { askId: 'r1', ref, workspaceId: workspace.id, text: 'why?' });
  assert.equal(out.lines[0], 'bart> done');
  assert.deepEqual([out.meta.level.name, out.meta.level.effort, out.meta.trail.length, out.meta.pinned], ['Sol', 'high', 1, false]);
  assert.match(calls[0].command, /^exec codex exec --color never --skip-git-repo-check -m "\$ENGELBART_BART_MODEL" -c 'model_reasoning_effort="medium"' -c 'sandbox_mode="read-only"' -c 'tools\.web_search=true'/);
  assert.match(calls[1].command, /^exec codex exec resume "\$ENGELBART_BART_SESSION" .*model_reasoning_effort="high"/);
  assert.equal(calls[1].env.ENGELBART_BART_SESSION, '01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc');
  assert.equal(calls[0].env.CODEX_HOME, codexHome);
  assert.equal(calls[0].cwd, path.join(runDirectory, project.id));
  assert.ok(!('OPENAI_API_KEY' in calls[0].env) && !('ANTHROPIC_API_KEY' in calls[0].env));
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), BART_SYSTEM_PROMPT);
  assert.match(calls[0].input, /<question>\nwhy\?\n<\/question>$/);
  assert.match(calls[1].input, /You asked to move up, and you have\./);
  assert.ok(!fs.existsSync(calls[0].env.ENGELBART_BART_INPUT), 'the question does not stay on disk');

  replies.push('from claude');
  const claude = await bart.ask(ctx, project.id, { askId: 'r2', ref, workspaceId: workspace.id, text: '--opus why?' });
  assert.equal(claude.lines[0], 'bart> from claude');
  const last = calls[calls.length - 1];
  assert.match(last.command, /^exec claude -p --output-format stream-json --verbose --include-partial-messages --session-id "\$ENGELBART_BART_SESSION" --restricted --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,WebSearch,WebFetch" --allowedTools "Read,Grep,Glob,WebSearch,WebFetch" --add-dir "\$ENGELBART_BART_DIR0" --add-dir "\$ENGELBART_BART_DIR1" --model "\$ENGELBART_BART_MODEL" --effort high /);
  assert.deepEqual([last.env.ENGELBART_BART_MODEL, last.env.ENGELBART_BART_DIR0, last.env.ENGELBART_BART_DIR1], ['opus', project.directory, ctx.dataRoot]);
  assert.match(last.input, /chose this model and effort by hand/);
});

test('activity: each CLI\'s events become short labels and the text so far; nothing else gets through', () => {
  const { pathLabeller, claudeUpdate, codexUpdate, commandLabel, eventReader } = require('../src/main/bart/activity.cjs');
  const short = pathLabeller(['/code/app', '/home/me/.engelbart']);
  assert.equal(short('/code/app/src/main/ipc.cjs'), 'src/main/ipc.cjs');
  assert.equal(short('/etc/secret/passwd'), 'passwd');
  assert.equal(short('./src/a.js'), 'src/a.js');
  // Claude Code 2.1.278, --output-format stream-json --verbose --include-partial-messages
  const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
  assert.deepEqual(claudeUpdate(tool('Read', { file_path: '/code/app/src/a.js' }), short), { activity: 'Reading src/a.js', log: true });
  assert.deepEqual(claudeUpdate(tool('Grep', { pattern: 'onProgress' }), short), { activity: 'Searching code for “onProgress”', log: true });
  assert.deepEqual(claudeUpdate(tool('WebSearch', { query: 'engelbart 1968' }), short), { activity: 'Searching the web for “engelbart 1968”', log: true });
  assert.deepEqual(claudeUpdate(tool('WebFetch', { url: 'https://www.dougengelbart.org/x?y=1' }), short), { activity: 'Reading dougengelbart.org', log: true });
  const stream = (event) => ({ type: 'stream_event', event });
  assert.deepEqual(claudeUpdate(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), short), { activity: 'Thinking' });
  assert.deepEqual(claudeUpdate(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), short), { textStart: true });
  assert.deepEqual(claudeUpdate(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'The secret' } }), short), { delta: 'The secret' });
  assert.equal(claudeUpdate(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } }), short), null);
  assert.equal(claudeUpdate({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } }, short), null);
  assert.equal(claudeUpdate({ type: 'result', result: 'x' }, short), null);
  // codex-cli 0.155.0, exec --json
  assert.deepEqual(codexUpdate({ type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", status: 'in_progress' } }, short), { activity: 'Reading note.txt', log: true });
  assert.equal(codexUpdate({ type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", aggregated_output: 'the secret word' } }, short), null);
  assert.deepEqual(codexUpdate({ type: 'item.started', item: { type: 'web_search', query: '', action: { type: 'other' } } }, short), { activity: 'Searching the web' });
  assert.deepEqual(codexUpdate({ type: 'item.completed', item: { type: 'web_search', query: 'Douglas Engelbart birth year', action: { type: 'search' } } }, short), { activity: 'Searching the web for “Douglas Engelbart birth year”', log: true });
  assert.deepEqual(codexUpdate({ type: 'item.completed', item: { type: 'agent_message', text: 'It is **1925**.' } }, short), { text: 'It is **1925**.' });
  assert.equal(codexUpdate({ type: 'item.completed', item: { type: 'error', message: 'Skill descriptions were shortened' } }, short), null);
  assert.equal(commandLabel("/bin/zsh -lc \"rg -n 'execFile' /code/app/src | head\"", short), 'Searching code for “execFile”');
  assert.equal(commandLabel("/bin/zsh -lc \"sed -n '1,80p' /code/app/src/main/bart/ask.cjs\"", short), 'Reading src/main/bart/ask.cjs');
  assert.equal(commandLabel('python3 -c "import os; os.system(\'x\')"', short), 'Running python3');
  // Lines split across chunks, and lines that are not events.
  const seen = [];
  const read = eventReader((event) => seen.push(event.n));
  read('Restored session\n{"n":1}\n{"n"'); read(':2}\n{broken\n'); read('{"n":3}\n');
  assert.deepEqual(seen, [1, 2, 3]);
});

test('the real runner streams while the CLI is still running: labels, then the text so far, then the answer', async () => {
  const { EventEmitter } = require('node:events');
  const progress = [];
  const run = (shell, args, options, callback) => {
    const child = { stdout: new EventEmitter() };
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(project.directory, 'src', 'a.js') } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET FILE BODY' }] } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Half an ' } } },
    ];
    setTimeout(() => child.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n'), 5);
    setTimeout(() => callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Half an answer, finished.' })}\n`), 200);
    return child;
  };
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-stream'), run });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const out = await bart.ask(ctx, project.id, { askId: 's1', ref, workspaceId: workspace.id, text: '--opus why?' }, { onProgress: (p) => progress.push(p) });
  assert.equal(out.lines[0], 'bart> Half an answer, finished.');
  assert.deepEqual(progress.map((p) => (p.step ? 'step' : p.activity || p.lines.join('\n'))), ['step', path.join('Reading src', 'a.js'), 'Writing', 'Half an']);
  assert.ok(!JSON.stringify(progress).includes('SECRET'), 'what a tool returned is never sent on');
});

/* ------------------------------------------------------------- follow-ups (2026-09-21) */

test('sessions are held for 30 idle minutes, handed out once, and only to the provider that made them', () => {
  assert.equal(THREAD_IDLE_MS, 30 * 60_000);
  const timers = [];
  const threads = createThreads({ setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; }, clearTimer: (timer) => { timer.live = false; } });
  threads.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  assert.equal(timers[0].ms, THREAD_IDLE_MS);
  assert.equal(threads.take('k', 'anthropic'), null, 'another provider cannot resume it');
  assert.equal(threads.size(), 0, 'and a session that was reached for is gone either way');
  threads.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  assert.equal(threads.take('k', 'openai').session, 's1');
  assert.equal(threads.take('k', 'openai'), null, 'handed out once: a turn that fails leaves nothing to resume');
  threads.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  threads.keep('k', { provider: 'openai', session: 's2', projectId: 'p', workspaceId: 'w' });
  assert.deepEqual(timers.map((timer) => timer.live), [false, false, false, true], 'keeping again starts the clock again');
  timers[3].fn();
  assert.equal(threads.take('k', 'openai'), null, 'idle for 30 minutes: gone');
  threads.keep('a', { provider: 'openai', session: 's', projectId: 'p', workspaceId: 'w1' });
  threads.keep('b', { provider: 'openai', session: 's', projectId: 'p', workspaceId: 'w2' });
  threads.forget((entry) => entry.workspaceId === 'w1');
  assert.deepEqual([threads.take('a', 'openai'), threads.take('b', 'openai').session], [null, 's']);
});

test('an exchange is known by what the document says was said', () => {
  const ref = { kind: 'workspace', workspaceId: 'w' };
  const said = [{ question: 'why?', answer: 'because' }];
  assert.equal(threadKey('p', ref, said), threadKey('p', ref, cleanTurns([{ question: ' why? ', answer: 'because\n' }])));
  assert.notEqual(threadKey('p', ref, said), threadKey('p', ref, [{ question: 'why?', answer: 'because, edited' }]));
  assert.notEqual(threadKey('p', ref, said), threadKey('p', { kind: 'note', id: 'w' }, said));
  assert.deepEqual(cleanTurns([{ question: '' }, null, { question: 'q', answer: 5 }]), [{ question: 'q', answer: '5' }]);
  assert.equal(conversationBlock([]), '');
  assert.equal(conversationBlock(said), '<conversation>\n<turn n="1">\n<asked>\nwhy?\n</asked>\n<answered>\nbecause\n</answered>\n</turn>\n</conversation>');
});

test('a follow-up resumes the session inside the window and is given everything again outside it', async () => {
  const authFile = path.join(homeDir, 'auth-follow.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  let fail = false;
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    if (fail && / resume /.test(command)) { callback(new Error('no rollout found'), ''); return; }
    if (!/codex/.test(command)) { callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `answer ${calls.length}` })}\n`); return; }
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, `answer ${calls.length}`);
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n');
  };
  const threads = createThreads();
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-follow'), codexHome: path.join(homeDir, 'codex-home-follow'), codexAuthFile: authFile, run, threads });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, '@bart why?\nbart> answer 1\n@bart and then?\nbart~> f2\n');
  const ask = (askId, text, turns, choice) => bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns, choice });

  await ask('f1', 'why?');
  const second = await ask('f2', 'and then?', [{ question: 'why?', answer: 'answer 1' }]);
  assert.equal(second.lines[0], 'bart> answer 2');
  assert.match(calls[1].command, /^exec codex exec resume "\$ENGELBART_BART_SESSION" /);
  assert.equal(calls[1].env.ENGELBART_BART_SESSION, '01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc');
  assert.match(calls[1].input, /^<level>[^\n]+<\/level>\n\n<question>\nand then\?\n<\/question>$/, 'inside the window only the new question is sent');

  // The person edited the first answer: the session's memory and the document disagree, so the document wins.
  const edited = [{ question: 'why?', answer: 'answer 1, corrected' }, { question: 'and then?', answer: 'answer 2' }];
  await ask('f2', 'a third', edited);
  assert.match(calls[2].command, /^exec codex exec --color never /);
  assert.match(calls[2].input, /^<engelbart>[\s\S]+<context_json>[\s\S]+<workspace name="Agents">[\s\S]+<<< this is the question being asked now >>>[\s\S]+<conversation>\n<turn n="1">\n<asked>\nwhy\?\n<\/asked>\n<answered>\nanswer 1, corrected\n<\/answered>[\s\S]+<turn n="2">[\s\S]+<\/conversation>\n\n<level>[^\n]+<\/level>\n\n<question>\na third\n<\/question>$/, 'the same context flow as a first question, with the earlier turns added');

  // Idle for 30 minutes (here: let go by hand): nothing to resume.
  const third = [...edited, { question: 'a third', answer: 'answer 3' }];
  threads.forget();
  await ask('f2', 'a fourth', third);
  assert.match(calls[3].command, /^exec codex exec --color never /);

  // A session that will not resume is started again without a word to the person.
  fail = true;
  const fifth = await ask('f2', 'a fifth', [...third, { question: 'a fourth', answer: 'answer 4' }]);
  assert.deepEqual([/ resume /.test(calls[4].command), /^exec codex exec --color never /.test(calls[5].command), fifth.lines[0]], [true, true, 'bart> answer 6']);
  assert.match(calls[5].input, /<conversation>/);
  assert.ok(!/resumed/i.test(fifth.lines.join('\n')), 'which of the two happened is never shown');
  fail = false;

  // Regenerate with a model from its selector: the line keeps its words, the run takes the choice, another provider starts anew.
  const again = await ask('f2', 'a fifth', [...third, { question: 'a fourth', answer: 'answer 4' }], { model: 'opus', effort: 'max' });
  assert.deepEqual([again.meta.provider, again.meta.level.name, again.meta.level.effort, again.meta.pinned], ['anthropic', 'Opus', 'max', true]);
});

test('an image pasted into a question is sent as its file\'s path, to a resumed session and a new one alike (2026-10-02)', async () => {
  const authFile = path.join(homeDir, 'auth-image.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, `answer ${calls.length}`);
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd"}\n');
  };
  const threads = createThreads();
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-image'), codexHome: path.join(homeDir, 'codex-home-image'), codexAuthFile: authFile, run, threads });
  const space = await projects.createWorkspace(ctx, project.id, { name: 'Pictures' });
  const ref = { kind: 'workspace', workspaceId: space.id };
  const image = await projects.saveImage(ctx, project.id, { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', name: 'Attachment 1' });
  const file = (await ctx.libraryDb.get(image.id)).path;
  assert.ok(path.isAbsolute(file) && fs.existsSync(file));
  const shot = `![Attachment 1](img:${image.id})`, gone = '![Attachment 2](img:0b6c1a9e-0000-4000-8000-000000000000)';
  await projects.writeDoc(ctx, project.id, ref, `@bart why?\nbart> answer 1\n@bart what is ${shot} showing?\nbart~> p2\n`);
  const ask = (askId, text, turns) => bart.ask(ctx, project.id, { askId, ref, workspaceId: space.id, text, turns });
  const question = (input) => input.match(/<question>\n([\s\S]*)\n<\/question>$/)[1];

  await ask('p1', 'why?');
  const first = [{ question: 'why?', answer: 'answer 1' }];
  await ask('p2', `what is ${shot} showing?`, first);
  assert.match(calls[1].command, / resume /, 'a follow-up inside the window resumes');
  assert.equal(question(calls[1].input), `what is ![Attachment 1](${file}) showing?`, 'the resumed session, sent the question alone, gets the path');
  assert.ok(!calls[1].input.includes('img:'));

  // Kept under the line as the document holds it, img:<id> and all: the next follow-up the editor sends resumes again.
  const second = [...first, { question: `what is ${shot} showing?`, answer: 'answer 2' }];
  await ask('p3', `and ${gone}?`, second);
  assert.match(calls[2].command, / resume /);
  assert.equal(question(calls[2].input), `and ${gone}?`, 'an image that is gone stays as written');

  threads.forget(); // idle past the window: a new session
  await ask('p4', `again ${shot}`, [...second, { question: `and ${gone}?`, answer: 'answer 3' }]);
  assert.match(calls[3].command, /^exec codex exec --color never /);
  assert.equal(question(calls[3].input), `again ![Attachment 1](${file})`, 'a new session\'s question gets the path too');
});

test('the fake agent follows up the same way, so a scripted run can show which path was taken', async () => {
  const threads = createThreads();
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 5, threads });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const first = await bart.ask(ctx, project.id, { askId: 'g1', ref, workspaceId: workspace.id, text: 'why?' });
  const said = [{ question: 'why?', answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') }];
  const second = await bart.ask(ctx, project.id, { askId: 'g2', ref, workspaceId: workspace.id, text: 'and then?', turns: said });
  assert.ok(second.lines.includes('bart> - the same session, given the question alone'));
  threads.forget();
  const third = await bart.ask(ctx, project.id, { askId: 'g3', ref, workspaceId: workspace.id, text: 'and then?', turns: said });
  assert.ok(third.lines.includes('bart> - a new session, given 1 earlier turn'));
});

test('what can be resumed outlives the app, and another workspace open in between changes nothing', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-threads-')), 'bart-threads.json');
  let clock = 1_000_000;
  const first = createThreads({ file, now: () => clock });
  first.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  first.keep('old', { provider: 'openai', session: 's0', projectId: 'p', workspaceId: 'w' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(([key, entry]) => [key, Object.keys(entry).sort()]), [['k', ['at', 'projectId', 'provider', 'session', 'workspaceId']], ['old', ['at', 'projectId', 'provider', 'session', 'workspaceId']]], 'ids and times only: nothing of what was said');
  clock += 29 * 60_000;
  first.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' }); // a turn at minute 29 starts its clock again
  clock += 2 * 60_000;
  const afterRestart = createThreads({ file, now: () => clock });
  assert.equal(afterRestart.take('old', 'openai'), null, '31 idle minutes: gone, whatever the app did meanwhile');
  assert.equal(afterRestart.take('k', 'openai').session, 's1', '2 idle minutes and a restart: resumed');
  assert.equal(createThreads({ file, now: () => clock }).size(), 0, 'handed out once, on disk too');
  fs.writeFileSync(file, '{ not json');
  assert.equal(createThreads({ file }).size(), 0);
  // No renderer call can let a session go any more: leaving a workspace is not the end of a conversation.
  assert.ok(!/forget/.test(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8')) && !/forget/.test(fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8')));
});

/* ------------------------------------------------------------- @brainstorm (2026-09-30) */

const card = require('../src/main/bart/card.cjs');
const { BRAINSTORM_SYSTEM_PROMPT } = require('../src/main/bart/brainstorm-system-prompt.cjs');
const { readBrainstorm, BRAINSTORM_STEPS } = require('../src/main/bart/models.cjs');
const { loadSystemPrompt, BRAINSTORM_IDLE_MS } = require('../src/main/bart/ask.cjs');

const FOCUS = { say: '', card: 'focus', focus: { title: 'Which one?', options: [{ label: 'Retries', why: 'In notes.md.' }, { label: 'The "slow" path' }] }, ready: false };
const PICK = { say: 'Good.', card: 'questions', questions: { eyebrow: 'aim', items: [{ id: 'aim', type: 'select_all', title: 'What would you do?', options: ['Change it', 'Measure it', 'Change it'] }] }, ready: false };

test('a card is read from what the model wrote, cleaned, or not at all', () => {
  const focus = card.readCard(JSON.stringify(FOCUS));
  assert.deepEqual(focus.focus.options, [{ label: 'Retries', why: 'In notes.md.' }, { label: 'The \'slow\' path' }], 'a label never holds a double quote: answers quote labels');
  assert.deepEqual(card.readCard(`\`\`\`json\n${JSON.stringify(FOCUS)}\n\`\`\``), focus, 'in a fence');
  assert.deepEqual(card.readCard(`Here you go: ${JSON.stringify(FOCUS)} Thanks.`), focus, 'with words around it');
  assert.deepEqual(card.readCard(JSON.stringify(PICK)).questions.items[0].options, [{ label: 'Change it' }, { label: 'Measure it' }], 'options as strings, the same one once');
  const two = { ...PICK, questions: { items: [{ id: 'a', type: 'free', title: 'First?', placeholder: 'x', options: [{ label: 'no' }] }, { id: 'b', type: 'open', title: 'Second?' }] } };
  assert.deepEqual(card.readCard(JSON.stringify(two)).questions, { items: [{ id: 'a', type: 'free', title: 'First?', placeholder: 'x' }] }, 'one question per card; free takes no options');
  assert.deepEqual(card.readCard('{"say": "Interest: retries\\nAim: measure\\nQuestion: why they loop", "card": "none", "ready": true}'), { say: 'Interest: retries\nAim: measure\nQuestion: why they loop', card: 'none', ready: true });
  assert.equal(card.readCard({ ...FOCUS, ready: true, say: 'Enough.' }).card, 'none', 'ready ends it whatever card it names');
  for (const broken of ['not json', '{"say": "cut', JSON.stringify({ card: 'focus', focus: { options: [{ label: 'one' }] } }), JSON.stringify({ card: 'questions', questions: { items: [{ type: 'essay', title: 'x' }] } }), JSON.stringify({ card: 'none', ready: true }), '[1, 2]']) {
    assert.equal(card.readCard(broken), null, broken);
  }
});

test('a card is kept as a fenced JSON block of answer lines, a recap as its words, anything else as it came; the editor reads the block back', async () => {
  const kept = card.cardBody(JSON.stringify(FOCUS));
  assert.equal(kept.body, `\`\`\`json\n${JSON.stringify(card.readCard(JSON.stringify(FOCUS)), null, 2)}\n\`\`\``);
  const lines = replyLines(kept.body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 });
  assert.deepEqual([lines[0], lines[1], lines[lines.length - 2], lines[lines.length - 1]], ['bart> ```json', 'bart> {', 'bart>', 'bart> *Sonnet · high · 3 s*']);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const doc = ['@brainstorm', ...lines];
  const [thread] = model.threads(doc);
  const answer = model.turnText(doc, thread.turns[0]).answer;
  assert.equal(answer, answerText(kept.body), 'what the session is kept under is what the document reads back');
  assert.deepEqual(card.cardOfAnswer(answer), card.readCard(JSON.stringify(FOCUS)));
  assert.equal(card.cardBody('{"say": "Interest: a\\nAim: b\\nQuestion: c", "card": "none", "ready": true}').body, 'Interest: a\nAim: b\nQuestion: c');
  assert.equal(card.cardBody('Sorry, I got confused.').body, 'Sorry, I got confused.', 'malformed: plain answer lines, never an empty card');
  assert.equal(card.cardOfAnswer('Sorry, I got confused.'), null);
  assert.equal(card.cardOfAnswer('```json\n{"say": "a", "card": "none", "ready": true}\n```'), null, 'a recap asks nothing: it is not drawn as a card');
  assert.equal(card.cardOfAnswer('```json\n{ "card": "focus", "focus": { "title": "Edited?", "options": [{ "label": "a" }, { "label": "b" }] } }\n```').focus.title, 'Edited?', 'a card edited in the file is the card it now says');
});

test('on a choice card the field under the options is a note to a pick, or the answer itself in the person\'s own words (2026-09-30)', () => {
  const options = [{ label: 'Retries' }, { label: 'Timeouts' }];
  const cards = {
    mcq: card.readCard({ card: 'questions', questions: { items: [{ id: 'm', type: 'mcq', title: 'Which?', options }] } }),
    select_all: card.readCard({ card: 'questions', questions: { items: [{ id: 's', type: 'select_all', title: 'Which ones?', options }] } }),
    focus: card.readCard({ card: 'focus', focus: { title: 'Where?', options } }),
  };
  for (const [type, c] of Object.entries(cards)) {
    assert.equal(card.answerLine(c, { picks: ['Retries'] }), 'picked "Retries"', `${type}: a pick`);
    assert.equal(card.answerLine(c, { picks: ['Retries'], note: ' and the  backoff ' }), 'picked "Retries"; note: and the backoff', `${type}: a pick and a note`);
    const own = card.answerLine(c, { note: '  choosing among my research   threads ' });
    assert.equal(own, 'choosing among my research threads', `${type}: words alone are the answer, as written`);
    assert.deepEqual(card.readAnswer(own, c), { skipped: false, picks: [], text: 'choosing among my research threads', note: '' }, `${type}: read back as their words`);
    assert.equal(card.answerLine(c, {}), card.SKIPPED, `${type}: nothing`);
    assert.equal(card.answerLine(c, { note: '   ' }), card.SKIPPED, `${type}: blank words are nothing`);
  }
});

test('an answer is written as picked "label", read back against its card, and counted until the recap', () => {
  const focus = card.readCard(JSON.stringify(FOCUS)), pick = card.readCard(JSON.stringify(PICK));
  const free = card.readCard(JSON.stringify({ card: 'questions', questions: { items: [{ id: 'q', type: 'open', title: 'What?' }] } }));
  assert.equal(card.answerLine(focus, { picks: ['Retries'] }), 'picked "Retries"');
  assert.equal(card.answerLine(pick, { picks: ['Change it', 'Measure it'], note: '  on the  harness ' }), 'picked "Change it", "Measure it"; note: on the harness');
  assert.equal(card.answerLine(free, { text: 'why they\nloop' }), 'why they loop');
  assert.equal(card.answerLine(focus, { picks: ['Not offered'] }), '(skipped)', 'nothing it offered: nothing picked');
  assert.equal(card.answerLine(free, {}), card.SKIPPED);
  assert.deepEqual(card.readAnswer('picked "Change it", "Measure it"; note: on the harness', pick), { skipped: false, picks: ['Change it', 'Measure it'], text: '', note: 'on the harness' });
  assert.deepEqual(card.readAnswer('retries', focus), { skipped: false, picks: ['Retries'], text: '', note: '' }, 'a label typed by hand is that pick');
  assert.deepEqual(card.readAnswer('something of my own', focus), { skipped: false, picks: [], text: 'something of my own', note: '' });
  assert.equal(card.readAnswer('(skipped)', focus).skipped, true);
  const fenced = card.cardBody(JSON.stringify(FOCUS)).body;
  const turns = [{ question: '', answer: fenced }, { question: 'picked "Retries"', answer: fenced }, { question: '(skipped)', answer: fenced }];
  assert.equal(card.answersSoFar([], ''), 0, 'the opening answers nothing');
  assert.equal(card.answersSoFar(turns, '--opus picked "Retries"'), 2, 'Skip is not an answer; flags are not part of one');
  assert.equal(card.answersSoFar([...turns, { question: 'x', answer: 'Interest: a\nAim: b\nQuestion: c' }, { question: '', answer: fenced }], 'y'), 1, 'counted again from the last recap');
});

const MAP = {
  settled: [{ text: 'Why runs retry', from: '"retries come from the lock" (workspace)' }],
  open: [{ text: 'Whether the backoff loops', from: 'mentioned: Retry notes' }, { text: 'What counts as done', from: '@bart what is done?' }],
  untouched: [],
};
const MAPPED = { say: '', card: 'focus', map: MAP, focus: { title: 'Which of these is least clear to you right now?', options: [{ label: 'Whether the backoff loops' }, { label: 'What counts as done' }] }, ready: false };

test('a map card: kept cleaned, bounded, and dropped alone when it is not a map (2026-09-30)', () => {
  assert.deepEqual(card.readCard(JSON.stringify(MAPPED)), MAPPED, 'a good map is kept as it came');
  const long = 'x'.repeat(500);
  const big = card.readCard({ ...MAPPED, map: { settled: Array.from({ length: 7 }, (_, n) => ({ text: `${n} ${long}`, from: long })), open: ['a line as a string'], untouched: [{ text: '  spaced   out  ' }] } });
  assert.equal(big.map.settled.length, 4, 'at most four per group');
  assert.deepEqual([big.map.settled[0].text.length, big.map.settled[0].from.length], [200, 160]);
  assert.deepEqual([big.map.open, big.map.untouched], [[{ text: 'a line as a string', from: '' }], [{ text: 'spaced out', from: '' }]]);
  const messy = card.readCard({ ...MAPPED, map: { settled: [null, 3, { from: 'no text' }, { text: '' }, { text: 'kept', from: 7 }], open: 'not a list' } });
  assert.deepEqual(messy.map, { settled: [{ text: 'kept', from: '' }], open: [], untouched: [] }, 'malformed items dropped, missing groups empty');
  assert.equal(card.mapHolds(messy.map), true);
  for (const bad of ['a map', [MAP], 42, null]) {
    const kept = card.readCard({ ...MAPPED, map: bad });
    assert.ok(kept && !('map' in kept) && kept.focus.options.length === 2, `the card stays without a map: ${JSON.stringify(bad)}`);
  }
  const empty = card.readCard({ say: 'There is little of your own writing to go on.', card: 'questions', map: {}, questions: { items: [{ id: 'where', type: 'open', title: 'Where are you with this?' }] } });
  assert.deepEqual([empty.map, card.mapHolds(empty.map)], [{ settled: [], open: [], untouched: [] }, false], 'too little to go on: an empty map');
  assert.equal(card.readCard({ ...MAPPED, card: 'none', ready: true, say: 'Where you are: a' }).map, undefined, 'a recap carries no map');
  assert.equal(card.readCard(JSON.stringify(FOCUS)).map, undefined, 'a card without one is as before');
});

test('a map card round-trips through the document, answers as before, and its answer counts', async () => {
  const kept = card.cardBody(JSON.stringify(MAPPED));
  const lines = replyLines(kept.body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 });
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const doc = ['@brainstorm', ...lines];
  const answer = model.turnText(doc, model.threads(doc)[0].turns[0]).answer;
  assert.deepEqual(card.cardOfAnswer(answer), MAPPED);
  const mapped = card.cardOfAnswer(answer);
  assert.equal(card.answerLine(mapped, { picks: ['What counts as done'], note: 'I do know the backoff' }), 'picked "What counts as done"; note: I do know the backoff');
  assert.deepEqual(card.readAnswer('picked "What counts as done"; note: I do know the backoff', mapped), { skipped: false, picks: ['What counts as done'], text: '', note: 'I do know the backoff' });
  const plain = card.cardBody(JSON.stringify(FOCUS)).body;
  const turns = [{ question: '', answer: kept.body }, { question: 'picked "What counts as done"', answer: plain }];
  assert.equal(card.answersSoFar(turns, 'finished means the test passes'), 2, 'the map card\'s answer is one of the three');
  assert.equal(card.answersSoFar([{ question: '', answer: kept.body }], '(skipped)'), 0);
});

test('@brainstorm runs on its fixed step: Sonnet high on Claude Code, Sol medium on Codex; a flag picks nothing and is not part of the question, and the models file has no say (2026-10-02)', () => {
  const step = (text, models) => readBrainstorm(text, models).steps.map((s) => `${s.name} ${s.effort}`);
  assert.deepEqual(BRAINSTORM_STEPS, { openai: { model: 'sol', effort: 'medium' }, anthropic: { model: 'sonnet', effort: 'high' } });
  assert.deepEqual(step('', DEFAULTS), ['Sonnet high']);
  assert.deepEqual(step('picked "x"', MODELS), ['Sol medium']);
  for (const [models, at] of [[DEFAULTS, 'Sonnet high'], [MODELS, 'Sol medium']]) {
    const read = readBrainstorm('--opus --max hello', models);
    assert.deepEqual([step('--opus --max hello', models), read.question, read.pinned], [[at], 'hello', false], `--opus --max on ${at}`);
  }
  assert.deepEqual([readBrainstorm('--fable picked "x" --high', MODELS).provider, readBrainstorm('--fable picked "x" --high', MODELS).question], ['openai', 'picked "x"'], 'a model of the other provider moves nothing either');
  assert.equal(readBrainstorm('', DEFAULTS).pinned, false, 'nothing picked by hand, so nothing is kept as the next start');
  assert.deepEqual(step('', startingAt(DEFAULTS, 'bart', { provider: 'openai', model: 'astra', effort: 'xhigh' })), ['Sol medium'], 'on the provider an @bart question would start on, at its own step');
  // A brainstorm block left in a file is not read; a provider without the step's model starts on its ladder's first step.
  const edited = normalizeModels({ ...DEFAULT_MODELS, brainstorm: { providers: { anthropic: { model: 'opus', effort: 'xhigh' }, openai: { model: 'astra', effort: 'high' } } } });
  assert.equal(edited.brainstorm, undefined);
  assert.deepEqual([step('', edited), step('', { ...edited, provider: 'openai' })], [['Sonnet high'], ['Sol medium']]);
  const anthropic = DEFAULT_MODELS.providers.anthropic;
  const noSonnet = normalizeModels({ ...DEFAULT_MODELS, providers: { ...DEFAULT_MODELS.providers, anthropic: { ...anthropic, models: { opus: anthropic.models.opus, fable: anthropic.models.fable }, ladder: [{ model: 'opus', effort: 'medium' }] } } });
  assert.deepEqual(step('', noSonnet), ['Opus medium']);
  assert.ok(!('brainstorm' in DEFAULT_MODELS), 'the models file no longer offers it');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-brainstorm-'));
  loadModels(root);
  assert.ok(!('brainstorm' in JSON.parse(fs.readFileSync(path.join(root, MODELS_FILE), 'utf8'))), 'a new file is written without one');
});

test('the editor marks no flag on an @brainstorm line, and still marks them on @bart and @discover lines (B-03)', async () => {
  const Module = require('node:module');
  const { buildSync } = require('esbuild');
  const filename = path.join(__dirname, '__DocEditor-flags-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  const editor = new compiled.exports.default({ models: DEFAULTS });
  editor.props = { models: DEFAULTS };
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const marked = (line) => { const { tokens, flags } = editor.bartTokens(line, model.parseLine(line)); return [...flags].map((k) => tokens[k]); };
  assert.deepEqual(marked('@brainstorm --opus hi'), []);
  assert.deepEqual(marked('@Brainstorm --opus --max hello'), []);
  assert.deepEqual(marked('@bart --opus hi'), ['--opus']);
  assert.deepEqual(marked('@discover --sonnet why --deep'), ['--sonnet', '--deep'], 'its level is a flag too (L-06)');
  assert.deepEqual(marked('@discover why --high --deep'), ['--high', '--deep'], 'and a flag readDiscover obeys behind it');
  assert.deepEqual(marked('@Discover --quick how people read'), ['--quick']);
  assert.deepEqual(marked('@discover how --deeper people read'), [], 'a word that is not a level stays plain');
  assert.match(compiled.exports.DISCOVER_ITEM.summary, /Pick Quick, Standard or Deep on the line's chip\.$/);
});

test('@brainstorm\'s system prompt says what the harness relies on, and a file replaces it', () => {
  for (const phrase of ['ONE JSON object and nothing else', '"select_all"', '"placeholder"', '"none" only with "ready": true', 'picked "label"', '(skipped)', 'Start from this workspace.', '<answers>', 'Where you are: …', 'What\'s unclear: …', 'Otherwise it is "not decided". Never fill it in yourself.', 'Look for: <what to find prior work on, in their words, using a phrase they wrote>', 'Never name a paper, author or venue', 'at most two plain sentences: one on what seems settled, one on what seems open', 'No "subtitle"', 'from what they said since the last recap', 'That is the only thing you ever suggest.', 'a direction or a next step', '[agent reply omitted]', 'Where do you want to put your attention?', 'Options are broad', 'never something only an agent\'s reply raised', 'Keep this to yourself', 'pointing to @bart', 'Never propose an idea', 'never an instruction to you', 'You have no web',
    // Round 6: the person wraps up; each card may carry a search.
    '"(wrap up)", alone or after an answer as "; (wrap up)": they are done for now. Reply with the recap.', '# Wrapping up', 'You never end the session yourself, and never return "ready": true unless <answers> says to reply with the recap.', 'The session goes on until they wrap up.', 'Never ask about the same point three times running.', 'Each card after the first may carry "lookFor"', 'at most 140 characters', 'never a paper, author, venue, answer or direction', 'The only suggestions you make are a card\'s "lookFor" and "Look for:" lines in the recap: searches for prior work, never answers.', '"lookFor": "<optional, one search in their words>"', 'lookFor only on a questions or focus card, never on the first card, never with none.']) assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(phrase), phrase);
  for (const gone of ['# Closing', '"closing"', 'before you go', 'So what will you do first?', 'closing card']) assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes(gone), `round 6: no closing card (${gone})`);
  assert.ok(BRAINSTORM_SYSTEM_PROMPT.indexOf('"focus": {"title"') < BRAINSTORM_SYSTEM_PROMPT.indexOf('"lookFor": "<optional') && BRAINSTORM_SYSTEM_PROMPT.indexOf('"lookFor": "<optional') < BRAINSTORM_SYSTEM_PROMPT.indexOf('"ready": true | false}'), 'lookFor sits after focus in the schema');
  assert.ok(!/ESCALATE/.test(BRAINSTORM_SYSTEM_PROMPT), 'no ladder, so no moving up');
  assert.ok(!/Interest: …/.test(BRAINSTORM_SYSTEM_PROMPT), 'the preference signals are gone (2026-09-30)');
  assert.ok(!/"map"|\bmap\b/.test(BRAINSTORM_SYSTEM_PROMPT), 'round 3: no map is asked for');
  assert.equal(BRAINSTORM_SYSTEM_PROMPT.match(/a turn should take seconds/gi), null, 'the first turn takes what the map needs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-prompt-'));
  assert.equal(loadSystemPrompt(root, 'brainstorm'), BRAINSTORM_SYSTEM_PROMPT);
  fs.mkdirSync(path.join(root, '.context'));
  fs.writeFileSync(path.join(root, '.context', 'brainstorm-system-prompt.md'), 'Mine.\n');
  assert.deepEqual([loadSystemPrompt(root, 'brainstorm'), loadSystemPrompt(root)], ['Mine.', BART_SYSTEM_PROMPT], '@bart\'s is its own');
});

test('the real runner for @brainstorm: file tools only, no web, its own Codex home and sessions, the opening, the count, and a card or a fallback', async () => {
  const authFile = path.join(homeDir, 'auth-brainstorm.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const replies = [JSON.stringify(FOCUS), `\`\`\`json\n${JSON.stringify(PICK)}\n\`\`\``, 'I would rather just talk.'];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    const text = replies.shift();
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, text); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd"}\n'); }
    else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`);
  };
  const codexHome = path.join(homeDir, 'codex-home-bs');
  const threads = createThreads(), brainstormThreads = createThreads({ idleMs: BRAINSTORM_IDLE_MS });
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-bs'), codexHome, codexAuthFile: authFile, run, threads, brainstormThreads });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const ask = (askId, text, turns, extra = {}) => bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns, agent: 'brainstorm', ...extra });

  const first = await ask('b1', '');
  assert.match(calls[0].command, /-c 'tools\.web_search=false'/);
  assert.equal(calls[0].env.CODEX_HOME, `${codexHome}-brainstorm`);
  assert.equal(fs.readFileSync(path.join(`${codexHome}-brainstorm`, 'AGENTS.md'), 'utf8'), BRAINSTORM_SYSTEM_PROMPT, 'the JSON-only rule reaches Codex through its instructions file');
  assert.match(calls[0].input, /<answers>Meaningful answers in this exchange so far, this one included: 0\.[^\n]*<\/answers>\n\n<level>You are running as Sol at medium effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nStart from this workspace\.\n<\/question>$/);
  assert.equal(first.lines[0], 'bart> ```json');
  assert.match(first.lines[first.lines.length - 1], /^bart> \*\d+ s\*$/, 'the foot gives the time alone');
  assert.deepEqual(first.meta.trail, []);
  assert.deepEqual([threads.size(), brainstormThreads.size()], [0, 1], 'kept apart from @bart\'s');

  const said = [{ question: '', answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') }];
  const second = await ask('b2', 'picked "Retries"', said);
  assert.match(calls[1].command, / resume /, 'the empty opening is a turn the session was kept under');
  assert.match(calls[1].input, /^<answers>[^\n]*: 1\.[^\n]*<\/answers>\n\n<level>/);
  assert.deepEqual(second.lines.slice(0, 2), ['bart> ```json', 'bart> {'], 'a card in a fence is a card');

  const third = await ask('b3', 'picked "Measure it"', [...said, { question: 'picked "Retries"', answer: 'edited in the file' }]);
  assert.match(calls[2].command, /^exec codex exec --color never /, 'the document changed: a new session');
  assert.match(calls[2].input, /<conversation>\n<turn n="1">\n<asked>\nStart from this workspace\.\n<\/asked>/);
  assert.equal(third.lines[0], 'bart> I would rather just talk.', 'not a card: written as it came');

  replies.push(JSON.stringify(FOCUS));
  const progress = [];
  await bart.ask(ctx, project.id, { askId: 'b4', ref, workspaceId: workspace.id, text: '--sonnet --max', turns: [], agent: 'brainstorm' }, { onProgress: (p) => progress.push(p) });
  const flagged = calls[calls.length - 1];
  assert.match(flagged.command, /^exec codex exec /, '--sonnet picks nothing (B-02): still Codex, the provider a question starts on');
  assert.deepEqual([flagged.env.ENGELBART_BART_MODEL, /model_reasoning_effort="medium"/.test(flagged.command)], ['gpt-6.1-sol', true], 'on Sol medium');
  assert.match(flagged.input, /<question>\nStart from this workspace\.\n<\/question>$/, 'flags alone: still the opening');
  const begun = progress.find((p) => p.step);
  assert.deepEqual([begun.step, 'name' in begun, 'effort' in begun], [1, false, false], 'a running @brainstorm never names its model (B-05)');

  replies.push(JSON.stringify(FOCUS));
  const onClaude = createBart({ readModels: () => DEFAULTS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-bs'), codexHome, codexAuthFile: authFile, run, threads, brainstormThreads });
  await onClaude.ask(ctx, project.id, { askId: 'b5', ref, workspaceId: workspace.id, text: '--opus --max hello', turns: [], agent: 'brainstorm' });
  const claude = calls[calls.length - 1];
  assert.match(claude.command, /--tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob" /);
  assert.match(claude.command, / --effort high /);
  assert.equal(claude.env.ENGELBART_BART_MODEL, 'claude-sonnet-5-5', '--opus --max hello runs on Sonnet high');
  assert.match(claude.input, /<level>You are running as Sonnet at high effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nhello\n<\/question>$/);
});

test('the fake @brainstorm runs a reading with broad options, then free cards on the area picked, each with a search from the last answer, until Wrap up gets the recap with a Look for line; it starts again after it; "malformed" gets a reply that is not a card (round 6)', async () => {
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const retry = await projects.createNote(ctx, project.id, { name: 'Retry notes', text: 'loops' });
  await projects.linkToWorkspace(ctx, project.id, workspace.id, [retry.id]); // only this workspace's library is read (round 3)
  const run = async (answers, start = ['@brainstorm']) => {
    let doc = [...start];
    const cards = [];
    for (let n = 0; n <= answers.length; n += 1) {
      const thread = model.threads(doc).at(-1);
      const turns = thread.turns.filter((turn) => turn.answered).map((turn) => model.turnText(doc, turn));
      const out = await bart.ask(ctx, project.id, { askId: `z${n}`, ref, workspaceId: workspace.id, text: model.parseLine(doc[doc.length - 1]).text, turns, agent: 'brainstorm' });
      doc = [...doc, ...out.lines];
      const again = model.threads(doc).at(-1);
      const shown = card.cardOfAnswer(model.turnText(doc, again.turns[again.turns.length - 1]).answer);
      cards.push(shown);
      if (!shown || n === answers.length) break;
      doc.push(`@brainstorm ${answers[n](shown)}`);
    }
    const thread = model.threads(doc).at(-1);
    const recap = card.recapParts(model.turnText(doc, thread.turns[thread.turns.length - 1]).answer);
    return { doc, cards, recap };
  };
  const pickSecond = (c) => card.answerLine(c, { picks: [card.questionOf(c).options[1].label], note: 'I know the first one' });
  const write = (text) => (c) => card.answerLine(c, { text });
  const wrapUp = (text) => (c) => card.withWrap(card.answerLine(c, { text }));
  // pick → free → free → wrap up → recap
  const { doc, cards, recap } = await run([pickSecond, write('it stops when the lock frees'), write('keep the lock, read the logs'), wrapUp('')]);
  assert.deepEqual(cards.map((c) => c && card.questionOf(c).type), ['focus', 'free', 'free', 'free', null], 'pick, free cards for as long as they go on, then the recap');
  assert.equal(cards[0].map, undefined, 'no map is shown');
  assert.ok(cards[0].say.includes('Agents') && cards[0].say.includes('Retry notes'), 'the reading names the workspace and its library');
  assert.ok(cards[0].say.split(/(?<=\.)\s+/).length <= 2, 'at most two sentences');
  const offered = card.questionOf(cards[0]).options.map((o) => o.label);
  assert.ok(offered.length >= 3 && offered.length <= 4, 'three or four options');
  assert.ok(offered.some((label) => label.includes('Retry notes')));
  assert.equal(card.questionOf(cards[0]).title, 'Where do you want to put your attention?');
  assert.equal(cards[0].lookFor, undefined, 'no search on the first card');
  const picked = card.questionOf(cards[0]).options[1].label;
  assert.deepEqual(cards.slice(1, 4).map((c) => c.questions.items[0].id), ['next-1', 'next-2', 'next-3'], 'each card an id of its own');
  for (const c of cards.slice(1, 4)) assert.ok(card.questionOf(c).title.includes(picked), 'every card stays on the area picked');
  assert.equal(new Set(cards.slice(1, 4).map((c) => card.questionOf(c).title)).size, 3, 'asked a different way each time');
  assert.deepEqual(cards.slice(1, 4).map((c) => c.lookFor), [`how others have handled “${`${picked}; I know the first one`.slice(0, 60)}”`, 'how others have handled “it stops when the lock frees”', 'how others have handled “keep the lock, read the logs”'], 'a search from the last answer, in their words');
  assert.ok(cards.every((c) => !c || c.questions?.items[0].id !== 'closing'), 'no closing card');
  assert.deepEqual(recap.lines, [`Where you are: ${picked}; I know the first one`, `What pulls apart: “${picked}; I know the first one” against “it stops when the lock frees”`, 'Next, you said: keep the lock, read the logs'], '"Next, you said" is the last thing said; Wrap up alone adds nothing');
  assert.deepEqual(recap.lookFor, ['how others have worked on “Agents”'], 'one Look for line, from the workspace name');
  assert.deepEqual(doc.filter((line) => /^@brainstorm /.test(line)).slice(-1), ['@brainstorm (wrap up)']);

  // Five written answers after the pick: still a card (A-01); Wrap up with words keeps them (A-02).
  const long = await run([pickSecond, write('one'), write('two'), write('three'), write('four'), write('five'), wrapUp('I will read the logs first')]);
  assert.deepEqual(long.cards.map((c) => c && card.questionOf(c).type), ['focus', 'free', 'free', 'free', 'free', 'free', 'free', null]);
  assert.equal(long.cards[6].questions.items[0].id, 'next-6');
  assert.equal(long.recap.lines[2], 'Next, you said: I will read the logs first', 'the answer given with Wrap up is in the recap');

  // Wrap up on the first card: the recap at once.
  const early = await run([(c) => card.withWrap(card.answerLine(c, { picks: [card.questionOf(c).options[0].label] }))]);
  assert.deepEqual(early.cards.map((c) => c && c.card), ['focus', null]);
  assert.deepEqual(early.recap.lines, [`Where you are: ${card.questionOf(early.cards[0]).options[0].label}`, 'What\'s unclear: not said', 'Next, you said: not decided']);

  const again = await run([pickSecond, write('something new'), wrapUp('')], [...doc, '@brainstorm']);
  assert.deepEqual(again.cards.map((c) => c && card.questionOf(c).type), ['focus', 'free', 'free', null], 'after a recap, the next exchange starts again from the pick');
  assert.ok(!card.questionOf(again.cards[2]).title.includes('keep the lock') && !again.cards[2].lookFor.includes('keep the lock'), 'and builds on nothing from the earlier exchange');
  assert.equal(again.recap.lines[2], 'Next, you said: something new');

  const undecided = await run([pickSecond, () => card.SKIPPED, () => card.SKIPPED, wrapUp('')]);
  assert.deepEqual(undecided.cards.map((c) => c && c.card), ['focus', 'questions', 'questions', 'questions', null], 'skips go on to another card');
  assert.equal(undecided.cards[3].lookFor, `how others have handled “${`${picked}; I know the first one`.slice(0, 60)}”`, 'after skips, the search is from the last thing said');
  assert.equal(undecided.recap.lines[2], 'Next, you said: not decided', 'never filled in for them');

  // An older document's closing card, answered: the recap, as before (A-06).
  const closing = card.cardBody(JSON.stringify({ say: '', card: 'questions', questions: { eyebrow: 'before you go', items: [{ id: 'closing', type: 'open', title: 'So what will you do first?' }] }, ready: false })).body;
  const older = await bart.ask(ctx, project.id, { askId: 'zold', ref, workspaceId: workspace.id, text: 'read the logs', turns: [{ question: '', answer: card.cardBody(JSON.stringify(FOCUS)).body }, { question: 'picked "Retries"', answer: closing }], agent: 'brainstorm' });
  assert.deepEqual(card.recapParts(answerText(older.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n'))).lines, ['Where you are: Retries', 'What pulls apart: “Retries” against “read the logs”', 'Next, you said: read the logs']);

  const feet = doc.filter((line) => /^bart> \*[^*]+\*$/.test(line));
  assert.ok(feet.length >= 5 && feet.every((line) => /^bart> \*\d+ s\*$/.test(line)), 'every card\'s foot gives the time alone');
  const bad = await bart.ask(ctx, project.id, { askId: 'zm', ref, workspaceId: workspace.id, text: 'malformed please', agent: 'brainstorm' });
  assert.equal(bad.lines[0], 'bart> FAKE REPLY that is not a card: {"say": "cut off');
  assert.equal(card.cardOfAnswer(bad.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n')), null, 'drawn as plain answer lines');
});

test('turnPlan never closes @brainstorm on a count: the next card at one, two, three and five answers; Wrap up, alone or after an answer, gets the recap, as does an older closing card; a new exchange counts again (round 6)', () => {
  const fence = (value) => ['```json', JSON.stringify(value), '```'].join('\n');
  const open = (id) => fence({ say: '', card: 'questions', questions: { items: [{ id, type: 'open', title: `Card ${id}?` }] }, ready: false });
  const plan = (text, turns) => turnPlan({ agent: 'brainstorm', text, turns }, DEFAULTS);
  const next = (n) => `<answers>Meaningful answers in this exchange so far, this one included: ${n}. Ask the next card.</answers>`;
  const turns = [{ question: '', answer: open('a') }];
  const said = ['picked "An area"', 'it stops when the lock frees', 'the backoff', 'the logs', 'the lock'];
  said.forEach((text, n) => {
    const at = plan(text, turns);
    if ([1, 2, 3, 5].includes(n + 1)) assert.deepEqual([at.extra, at.close], [next(n + 1), null], `${n + 1} answers: the next card`);
    turns.push({ question: text, answer: open(`next-${n + 1}`) });
  });
  assert.equal(plan(card.SKIPPED, turns).close, null, 'a skip asks another card');
  const wrapped = '<answers>The person wrapped up. Reply with the recap and no card.</answers>';
  for (const text of ['(wrap up)', 'I will read the logs; (wrap up)', 'picked "An area"; note: soon; (wrap up)', '--sonnet (wrap up)', '  (wrap up) ']) {
    const at = plan(text, turns);
    assert.deepEqual([at.extra, at.close], [wrapped, 'recap'], text);
  }
  assert.equal(plan('(wrap up)', turns.slice(0, 1)).close, 'recap', 'Wrap up on the first card');
  assert.equal(plan('I will (wrap up) later', turns).close, null, 'words that only mention it are an answer');
  assert.equal(plan('I will read the logs; (wrap up)', turns).asked, 'I will read the logs; (wrap up)', 'the agent is sent the answer and the wrap up as written');
  // An older document's closing card (rounds 4 and 5): its answer, or its skip, still gets the recap.
  const asked = [...turns.slice(0, 2), { question: 'it stops when the lock frees', answer: open('closing') }];
  const answered = plan('I will read the logs', asked);
  assert.deepEqual([answered.extra, answered.close], ['<answers>The person answered the closing card. Reply with the recap and no card.</answers>', 'recap']);
  assert.equal(plan(card.SKIPPED, asked).extra, '<answers>The person skipped the closing card. Reply with the recap and no card.</answers>');
  assert.equal(plan('--sonnet (skipped)', asked).close, 'recap', 'flags do not hide the skip');
  // A second exchange in the same thread: only the turns after the recap count.
  const after = [...asked, { question: 'I will read the logs', answer: 'Where you are: x\nWhat pulls apart: y\nNext, you said: z' }, { question: '', answer: open('d') }];
  assert.equal(card.answersSoFar(after, 'picked "Another"'), 1);
  assert.equal(plan('picked "Another"', after).extra, next(1), 'after a recap, the count starts again at 1');
  assert.equal(plan('', after.slice(0, -1)).close, null, 'the turn right after a recap opens a new exchange, not the recap again');
  assert.equal(plan('more', [...after, { question: 'picked "Another"', answer: open('e') }]).close, null, 'two answers no longer close it');
  assert.equal(turnPlan({ agent: 'bart', text: 'q', turns: asked }, DEFAULTS).extra, '', '@bart is unchanged');
  assert.equal(turnPlan({ agent: 'discover', text: '(wrap up)', turns: [] }, DEFAULTS).close, undefined, '@discover has no wrap up');
});

test('Wrap up is "(wrap up)", alone or after an answer: read off what the answer was, counted only for what was said, and written after answerLine (round 6)', () => {
  assert.equal(card.WRAP, '(wrap up)');
  assert.deepEqual(card.readWrap('(wrap up)'), { wrap: true, rest: '' });
  assert.deepEqual(card.readWrap(' it loops ; (wrap up) '), { wrap: true, rest: 'it loops' });
  assert.deepEqual(card.readWrap('picked "a"; note: b; (wrap up)'), { wrap: true, rest: 'picked "a"; note: b' });
  for (const text of ['it loops', '(wrap up) now', 'I will (wrap up)', '', null]) assert.equal(card.readWrap(text).wrap, false, String(text));
  const focus = card.readCard(JSON.stringify(FOCUS)), free = card.readCard({ card: 'questions', questions: { items: [{ id: 'q', type: 'free', title: 'What?' }] } });
  assert.deepEqual(card.readAnswer('(wrap up)', free), { skipped: true, picks: [], text: '', note: '', wrap: true }, 'Wrap up alone: nothing said');
  assert.deepEqual(card.readAnswer('it loops; (wrap up)', free), { skipped: false, picks: [], text: 'it loops', note: '', wrap: true });
  assert.deepEqual(card.readAnswer('picked "Retries"; note: soon; (wrap up)', focus), { skipped: false, picks: ['Retries'], text: '', note: 'soon', wrap: true });
  assert.deepEqual(card.readAnswer('it loops', free), { skipped: false, picks: [], text: 'it loops', note: '' }, 'an answer without it is as before');
  // answerLine, then Wrap up: what the editor writes.
  const wrap = (c, given) => card.withWrap(card.answerLine(c, given));
  assert.equal(wrap(free, { text: '  it   loops ' }), 'it loops; (wrap up)');
  assert.equal(wrap(free, {}), '(wrap up)', 'nothing typed: Wrap up alone');
  assert.equal(wrap(focus, { picks: ['Retries'], note: 'soon' }), 'picked "Retries"; note: soon; (wrap up)');
  assert.equal(wrap(focus, { note: 'my own words' }), 'my own words; (wrap up)');
  assert.equal(wrap(focus, { picks: ['Not offered'] }), '(wrap up)');
  const fenced = card.cardBody(JSON.stringify(FOCUS)).body;
  const turns = [{ question: '', answer: fenced }, { question: 'picked "Retries"', answer: fenced }];
  assert.equal(card.answersSoFar(turns, '(wrap up)'), 1, 'Wrap up alone is not an answer');
  assert.equal(card.answersSoFar(turns, '--opus (wrap up)'), 1);
  assert.equal(card.answersSoFar(turns, 'it loops; (wrap up)'), 2, 'what was said with it counts');
  assert.equal(card.answersSoFar([...turns, { question: '(wrap up)', answer: fenced }], 'x'), 2, 'an earlier Wrap up counts for nothing either');
});

test('a card may carry a search, lookFor (round 6): on questions and focus cards, one line of at most 140 characters, never an address, kept through the document', async () => {
  const look = 'how others have handled “it stops when the lock frees”';
  const focus = card.readCard({ ...FOCUS, lookFor: look });
  assert.equal(focus.lookFor, look);
  const free = card.readCard({ say: '', card: 'questions', questions: { items: [{ id: 'next-1', type: 'free', title: 'What?' }] }, lookFor: `  ${'x'.repeat(100)}\n  ${'y'.repeat(100)}  ` });
  assert.equal(free.lookFor, `${'x'.repeat(100)} ${'y'.repeat(39)}`, 'one line, clipped at 140');
  for (const bad of ['', '   ', 'https://example.org/a-paper', 'HTTP://x.org', 'www.example.org', 42, null, ['a']]) {
    assert.ok(!('lookFor' in card.readCard({ ...FOCUS, lookFor: bad })), `dropped: ${JSON.stringify(bad)}`);
  }
  assert.equal(card.readCard({ card: 'none', ready: true, say: 'Where you are: a', lookFor: look }).lookFor, undefined, 'a recap carries none: its searches are its Look for lines');
  const kept = card.cardBody(JSON.stringify(free));
  assert.deepEqual(card.cardOfAnswer(kept.body), free, 'cardBody round-trips it');
  const lines = replyLines(card.cardBody(JSON.stringify({ ...FOCUS, lookFor: look })).body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 });
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const doc = ['@brainstorm', ...lines];
  assert.equal(card.cardOfAnswer(model.turnText(doc, model.threads(doc)[0].turns[0]).answer).lookFor, look, 'and the document reads it back');
});

test('recapParts splits a recap from its Look for lines: none, one, two, at most two, and a stray "@discover" taken off (round 4)', () => {
  const older = 'Where you are: a\nWhat\'s unclear: b\nWhere you\'ll look next: c';
  assert.deepEqual(card.recapParts(older), { lines: older.split('\n'), lookFor: [] }, 'an older recap comes back whole');
  const base = 'Where you are: a\nWhat pulls apart: b\nNext, you said: c';
  assert.deepEqual(card.recapParts(`${base}\nLook for: how people choose between agent options`), { lines: base.split('\n'), lookFor: ['how people choose between agent options'] });
  assert.deepEqual(card.recapParts(`${base}\nLook for: one thing\nlook for:  another   thing `).lookFor, ['one thing', 'another thing']);
  assert.deepEqual(card.recapParts(`${base}\nLook for: @discover one\nLook for: two\nLook for: three`).lookFor, ['one', 'two'], 'at most two; "@discover" dropped');
  assert.equal(card.recapParts(`Look for: ${'x'.repeat(200)}`).lookFor[0].length, 140);
  assert.deepEqual(card.recapParts('Look for:').lookFor, [], 'an empty search is no search');
  assert.equal(card.readCard('{"say": "Where you are: a\\nLook for: b", "card": "none", "ready": true}').say, 'Where you are: a\nLook for: b', 'readCard keeps the recap as text');
});

test('recapLine reads a recap line as a section: its label and its words, older labels and curly quotes too', () => {
  assert.deepEqual(card.recapLine('Where you are: deciding what to build'), { label: 'Where you are', text: 'deciding what to build' });
  assert.deepEqual(card.recapLine('What’s unclear: who picks'), { label: 'What\'s unclear', text: 'who picks' });
  assert.deepEqual(card.recapLine('Next, you said: not decided'), { label: 'Next, you said', text: 'not decided' });
  assert.deepEqual(card.recapLine('Where you\'ll look next: the logs'), { label: 'Where you\'ll look next', text: 'the logs' }, 'an older recap draws the same way');
  assert.equal(card.recapLine('Look for: retries'), null, 'a search is a button, not a section');
  assert.equal(card.recapLine('Where I am: elsewhere'), null);
});

test('the fake @brainstorm with nothing to go on: says so and asks an open question', async () => {
  const bare = await projects.createProject(ctx, 'Bare');
  const space = await projects.createWorkspace(ctx, bare.id, { name: 'Empty' });
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const out = await bart.ask(ctx, bare.id, { askId: 'e1', ref: { kind: 'workspace', workspaceId: space.id }, workspaceId: space.id, text: '', turns: [], agent: 'brainstorm' });
  const shown = card.cardOfAnswer(answerText(out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n')));
  assert.deepEqual([shown.map, card.questionOf(shown).type], [undefined, 'open']);
  assert.match(shown.say, /little of your own writing/);
});

test('@bart and @discover may open the folders the project library\'s files are in, @brainstorm those of this workspace\'s (MB-06, round 3)', async () => {
  const lib = await projects.createProject(ctx, 'Library Dirs');
  const space = await projects.createWorkspace(ctx, lib.id, { name: 'Reading' });
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-downloads-'));
  const nested = path.join(downloads, 'inner');
  fs.mkdirSync(nested);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-repo-'));
  const add = (name, fields) => ctx.libraryDb.insert({ id: require('node:crypto').randomUUID(), name, project_id: lib.id, tags: [], ...fields });
  await add('A paper', { type: 'pdf', path: path.join(downloads, 'paper.pdf') });
  await add('Another', { type: 'pdf', path: path.join(nested, 'other.pdf') });
  await add('Gone', { type: 'pdf', path: path.join(os.tmpdir(), 'engelbart-no-such-dir', 'x.pdf') });
  await add('At home', { type: 'pdf', path: path.join(os.homedir(), 'loose.pdf') });
  await add('A folder', { type: 'folder', folder_path: repo });
  const ask = (agent) => buildContext(ctx, lib.id, { ref: { kind: 'workspace', workspaceId: space.id }, workspaceId: space.id, askId: 'd1', agent });
  const granted = [lib.directory, ctx.dataRoot].filter(Boolean);
  const dirs = (await ask('discover')).dirs;
  assert.deepEqual(dirs.slice(0, granted.length), granted);
  assert.deepEqual(dirs.slice(granted.length).sort(), [downloads, repo].sort(), 'a file\'s folder once (not one inside it), a folder item itself; never home, never a folder that is gone');
  assert.deepEqual((await ask('bart')).dirs, dirs, '@bart: the same as @discover');
  assert.deepEqual((await ask()).dirs, dirs, 'by default @bart');
  assert.deepEqual((await ask('brainstorm')).dirs, granted, '@brainstorm: nothing in this workspace, nothing granted');
  const folder = (await ctx.libraryDb.list()).find((row) => row.name === 'A folder');
  await projects.linkToWorkspace(ctx, lib.id, space.id, [folder.id]);
  assert.deepEqual((await ask('brainstorm')).dirs, [...granted, repo], '@brainstorm: only what this workspace holds');
});

/* ----------------------------------------------------------- @brainstorm, round 3 (2026-09-30) */

const { stripAgentReplies, OMITTED } = require('../src/main/bart/strip.cjs');

test('strip: @bart and @discover replies become one marker per run; their questions and @brainstorm threads stay', () => {
  const doc = [
    'My own line.',
    '@bart why do runs loop?',
    'bart> Because of the lock.',
    'bart> See *TutorTrace*.',
    'bart> *Sonnet · high · 3 s*',
    '@bart and then?',
    'bart+> folded answer',
    'Back to me.',
    '@discover what should I read?',
    'bart> ## Start here',
    'bart> **Illusion of Learning** · 2024',
    '@brainstorm',
    'bart> ```json',
    'bart> {"card": "focus"}',
    'bart> ```',
    '@brainstorm picked "Retries"',
    'bart~> ask-now',
    '@bart pending one',
    'bart~> other-ask',
    'Plain again.',
    'bart> orphan reply under nothing',
  ].join('\n');
  assert.equal(stripAgentReplies(doc), [
    'My own line.',
    '@bart why do runs loop?',
    OMITTED,
    '@bart and then?',
    OMITTED,
    'Back to me.',
    '@discover what should I read?',
    OMITTED,
    '@brainstorm',
    'bart> ```json',
    'bart> {"card": "focus"}',
    'bart> ```',
    '@brainstorm picked "Retries"',
    'bart~> ask-now',
    '@bart pending one',
    OMITTED,
    'Plain again.',
    'bart> orphan reply under nothing',
  ].join('\n'));
  assert.equal(stripAgentReplies('no agents here\n\n- [ ] a task'), 'no agents here\n\n- [ ] a task');
  assert.equal(stripAgentReplies(''), '');
});

test('strip reads the document as the editor does', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const strip = require('../src/main/bart/strip.cjs');
  for (const name of ['BART_RE', 'REPLY_RE', 'PENDING_RE']) assert.equal(strip[name].source, model[name].source, name);
});

test('@brainstorm\'s context: this workspace\'s library and mentions only, other agents\' replies out; @bart\'s and @discover\'s as before', async () => {
  const proj = await projects.createProject(ctx, 'Scoped');
  const here = await projects.createWorkspace(ctx, proj.id, { name: 'Brainstorm and Discover' });
  const there = await projects.createWorkspace(ctx, proj.id, { name: 'Elsewhere' });
  const added = await projects.createNote(ctx, proj.id, { name: 'Added here', text: 'mine' });
  const made = await projects.createNote(ctx, proj.id, { name: 'Made here', text: 'made', workspaceId: here.id });
  const mentioned = await projects.createNote(ctx, proj.id, { name: 'Mentioned', text: 'pointed at\n@bart inner?\nbart> inner answer' });
  const thrown = await projects.createNote(ctx, proj.id, { name: 'Thrown away', text: 'gone' });
  const far = await projects.createNote(ctx, proj.id, { name: 'TutorTrace', text: 'elsewhere' });
  await projects.linkToWorkspace(ctx, proj.id, here.id, [added.id, thrown.id]);
  await projects.unlinkFromWorkspace(ctx, proj.id, here.id, thrown.id);
  await projects.linkToWorkspace(ctx, proj.id, there.id, [far.id]);
  await projects.writeDoc(ctx, proj.id, { kind: 'workspace', workspaceId: here.id }, 'Mine.\nSee @[Mentioned].\n@bart why?\nbart> because TutorTrace\n@brainstorm\nbart~> s1\n');
  const ask = (agent) => buildContext(ctx, proj.id, { ref: { kind: 'workspace', workspaceId: here.id }, workspaceId: here.id, askId: 's1', agent });
  const names = (c) => JSON.parse(c.contextJson.replace(/^<context_json>\n|\n<\/context_json>$/g, '')).map((entry) => [entry.name, entry.mentioned]).sort();

  const brainstorm = await ask('brainstorm');
  assert.deepEqual(names(brainstorm), [['Added here', false], ['Made here', false], ['Mentioned', true]], 'its context, the notes made in it, what it mentions; not what was thrown away, not another workspace\'s');
  assert.ok(!/TutorTrace|because|inner answer/.test(brainstorm.documents), 'no agent\'s answer, in the workspace or a mentioned note');
  assert.match(brainstorm.documents, /@bart why\?\n\[agent reply omitted\]\n@brainstorm\n<<< this is the question being asked now >>>/);
  assert.match(brainstorm.documents, /@bart inner\?\n\[agent reply omitted\]/);

  const rows = await ctx.libraryDb.list();
  for (const agent of ['bart', 'discover']) {
    const c = await ask(agent);
    assert.equal(c.contextJson, `<context_json>\n${JSON.stringify(catalogEntries(c.project, rows, new Set([mentioned.id])), null, 1)}\n</context_json>`, `${agent}: the whole project's library, as before`);
    assert.ok(names(c).some(([name]) => name === 'TutorTrace'));
    assert.match(c.documents, /@bart why\?\nbart> because TutorTrace\n@brainstorm/, `${agent}: the document as it stands`);
  }
  assert.equal((await ask('bart')).documents, (await ask('discover')).documents);
});

test('ask-bart takes the agent, and a Brainstorm is an agent of its workspace like Bart', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/ipc.cjs'), 'utf8');
  assert.match(src, /\['bart', 'brainstorm', 'discover'\]\.includes\(agent\)/);
  projects.agentStarted(ctx, { id: 'bs-agent', kind: 'brainstorm', projectId: project.id, workspaceId: workspace.id });
  projects.agentFinished(ctx, 'bs-agent');
  assert.throws(() => projects.agentStarted(ctx, { id: 'bs-nope', kind: 'chat', projectId: project.id }));
});

/* ------------------------------------------------------------- @discover (2026-09-30) */

const { DISCOVER_SYSTEM_PROMPT } = require('../src/main/bart/discover-system-prompt.cjs');
const { readDiscover, DEFAULT_DISCOVER } = require('../src/main/bart/models.cjs');
const { turnPlan, replyBody, writeCodexConfig, DISCOVER_IDLE_MS, MODE_LIMITS } = require('../src/main/bart/ask.cjs');
const papersLib = require('../src/main/bart/papers.cjs');
const activity = require('../src/main/bart/activity.cjs');

const GUIDE = '## Start here\n\n**[A paper](https://arxiv.org/abs/2401.00001)** · A. Author · 2024 · arXiv\nWhat it is: they did a thing.\nRead: Section 3\nWhy: the retries part.\nFound: in your library · full text: open access';

test('@discover has three levels a provider: Sonnet medium, Opus high, Opus max on Claude Code; Sol medium, Astra high, Astra ultra on Codex; --quick and --deep are words of their own, and a flag still picks for its line (2026-10-02)', () => {
  const step = (text, models, earlier) => readDiscover(text, models, earlier).steps.map((s) => `${s.name} ${s.effort}`);
  for (const [models, levels] of [[DEFAULTS, ['Sonnet medium', 'Opus high', 'Opus max']], [MODELS, ['Sol medium', 'Astra high', 'Astra ultra']]]) {
    assert.deepEqual([step('--quick why do agents loop', models), step('why do agents loop', models), step('why do agents loop --deep', models)], levels.map((level) => [level]), levels.join(', '));
    assert.deepEqual(step('--standard why', models), [levels[1]]);
  }
  assert.deepEqual(readDiscover('why do agents loop --deep', DEFAULTS).steps[0].model, 'opus', 'the id the CLI gets');
  assert.deepEqual([readDiscover('why do agents loop --deep', DEFAULTS).question, readDiscover('--quick why', DEFAULTS).question, readDiscover('why --deep', DEFAULTS).mode, readDiscover('--quick why', DEFAULTS).mode, readDiscover('why', DEFAULTS).mode], ['why do agents loop', 'why', 'deep', 'quick', 'standard']);
  assert.equal(readDiscover('why', DEFAULTS).pinned, false);
  // A model or effort flag picks by hand for its line, whatever the level; the mode stays.
  const flagged = readDiscover('--sonnet why --deep', DEFAULTS);
  assert.deepEqual([flagged.steps.map((s) => `${s.name} ${s.effort}`), flagged.question, flagged.mode, flagged.pinned], [['Sonnet high'], 'why', 'deep', true]);
  assert.deepEqual(step('--quick --fable why', DEFAULTS), ['Fable xhigh']);
  // The mode an earlier turn named carries on; the line's own wins; the latest earlier one counts.
  assert.deepEqual([step('picked "Retries"', DEFAULTS, [{ question: 'agents --deep' }]), step('more', MODELS, [{ question: '--quick agents' }, { question: 'x' }])], [['Opus max'], ['Sol medium']]);
  assert.deepEqual(step('--quick more', DEFAULTS, [{ question: 'agents --deep' }]), ['Sonnet medium']);
  assert.equal(readDiscover('more', DEFAULTS, [{ question: 'a --deep' }, { question: 'b --quick' }]).mode, 'quick');
  assert.deepEqual(DEFAULTS.discover.providers, DEFAULT_DISCOVER.providers);
  assert.ok(/`quick`/.test(DEFAULT_DISCOVER.about) && /--deep/.test(DEFAULT_DISCOVER.about) && /--quick/.test(DEFAULT_DISCOVER.about), 'its about names the levels and the flags');
  // Each level is checked as a step is: an unusable one falls back to its default, then to the ladder's first.
  const edited = normalizeModels({ ...DEFAULT_MODELS, discover: { providers: { anthropic: { quick: { model: 'Fable', effort: 'Extra High' }, standard: { model: 'gone', effort: 'high' }, deep: { model: 'opus', effort: 'ultra' } } } } });
  assert.deepEqual(edited.discover.providers, { ...DEFAULT_DISCOVER.providers, anthropic: { quick: { model: 'fable', effort: 'xhigh' }, standard: { model: 'opus', effort: 'high' }, deep: { model: 'opus', effort: 'max' } } });
  const noOpus = normalizeModels({ ...DEFAULT_MODELS, providers: { ...DEFAULT_MODELS.providers, anthropic: { ...DEFAULT_MODELS.providers.anthropic, models: { sonnet: DEFAULT_MODELS.providers.anthropic.models.sonnet } } } });
  assert.deepEqual(noOpus.discover.providers.anthropic, { quick: { model: 'sonnet', effort: 'medium' }, standard: { model: 'sonnet', effort: 'high' }, deep: { model: 'sonnet', effort: 'high' } }, 'Opus gone: its levels on the ladder\'s first step');
  // The one-step shape of 2026-09-30 is that provider's standard level, quick and deep from the defaults.
  const old = normalizeModels({ ...DEFAULT_MODELS, discover: { providers: { anthropic: { model: 'fable', effort: 'xhigh' }, openai: { effort: 'xhigh' } } } });
  assert.deepEqual(old.discover.providers.anthropic, { ...DEFAULT_DISCOVER.providers.anthropic, standard: { model: 'fable', effort: 'xhigh' } });
  assert.deepEqual(old.discover.providers.openai, { ...DEFAULT_DISCOVER.providers.openai, standard: { model: 'sol', effort: 'xhigh' } }, 'half a step: the other half as that day\'s default had it');
  assert.deepEqual([step('why', old), step('--quick why', old), step('--deep why', old)], [['Fable xhigh'], ['Sonnet medium'], ['Opus max']]);
  const plan = (text, turns = []) => turnPlan({ agent: 'discover', text, turns }, DEFAULTS);
  assert.match(plan('why do agents loop').extra, /^<mode>standard\. Up to three starting points;[^<]*eight sources[^<]*<\/mode>$/);
  assert.equal(plan('--quick why do agents loop').extra, `<mode>${MODE_LIMITS.quick}</mode>`);
  // Each mode keeps its total and gives essays a share of it (2026-10-03), and says how many more papers may be opened only
  // to look for code (2026-10-04): none in quick mode.
  assert.equal(MODE_LIMITS.quick, 'quick. Up to two starting points; one hop backward and one forward from each; at most five sources in the guide, of which up to two are essays when essays apply. No extra papers opened to look for code.');
  assert.equal(MODE_LIMITS.standard, 'standard. Up to three starting points; one hop backward and one forward from each; at most eight sources in the guide, of which two to three are essays when essays apply. Up to two extra papers opened to look for code.');
  assert.equal(MODE_LIMITS.deep, 'deep. Up to five starting points; one hop backward and one forward from each, then one more of each from the best of what you found; at most fifteen sources in the guide, of which three to five are essays when essays apply. Up to four extra papers opened to look for code.');
  const deep = plan('picked "Retries"', [{ question: 'agents --deep', answer: '```json\n{}\n```' }]);
  assert.deepEqual([deep.mode, /fifteen sources/.test(deep.extra), deep.steps[0].name, deep.steps[0].effort], ['deep', true, 'Opus', 'max'], 'an answer to a card carries the problem\'s --deep on, and its level');
  const quick = plan('only after 2022', [{ question: '--quick agents', answer: '## Start here' }]);
  assert.deepEqual([quick.mode, /five sources/.test(quick.extra), quick.steps[0].name, quick.steps[0].effort], ['quick', true, 'Sonnet', 'medium'], 'a follow-up on a quick guide stays quick');
  assert.equal(plan('').asked, 'Find what I should read about the problem this workspace is about.', 'an empty line asks from the workspace');
  assert.equal(plan('', []).question, '');
  assert.equal(plan('x', [{ question: '', answer: 'a' }]).prior.length, 1, 'an empty opening is a turn');
});

test('a models file left as 2026-09-30 wrote it: @discover\'s untouched step becomes the three levels, @brainstorm\'s block goes; a step of the person\'s own is the standard level, and a brainstorm block of their own stays unread', () => {
  for (const withBase of [true, false]) {
    const shipped = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS.at(-1)));
    assert.deepEqual([shipped.discover.providers.anthropic, !!shipped.brainstorm], [{ model: 'opus', effort: 'high' }, true], 'the 09-30 shape');
    const write = (value) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-1002-'));
      fs.writeFileSync(path.join(root, MODELS_FILE), JSON.stringify(value));
      if (withBase) { fs.mkdirSync(path.join(root, '.defaults')); fs.writeFileSync(path.join(root, '.defaults', MODELS_FILE), JSON.stringify(shipped)); }
      return root;
    };
    const untouched = write(shipped);
    const models = loadModels(untouched);
    const file = JSON.parse(fs.readFileSync(path.join(untouched, MODELS_FILE), 'utf8'));
    const how = withBase ? 'with a base' : 'without one';
    assert.deepEqual(file.discover, DEFAULT_DISCOVER, `the new levels and their about reach the file, ${how}`);
    assert.equal(file.brainstorm, undefined, `the brainstorm block goes, ${how}`);
    assert.deepEqual(models.discover.providers, DEFAULT_DISCOVER.providers);
    assert.deepEqual(loadModels(untouched), models, 'and stays so');

    const mine = JSON.parse(JSON.stringify(shipped));
    mine.discover.providers.anthropic = { model: 'fable', effort: 'xhigh' };
    mine.discover.providers.openai.effort = 'xhigh';
    mine.brainstorm.providers.anthropic = { model: 'opus', effort: 'max' };
    const edited = write(mine);
    const theirs = loadModels(edited);
    const kept = JSON.parse(fs.readFileSync(path.join(edited, MODELS_FILE), 'utf8'));
    assert.deepEqual(kept.discover.providers, { anthropic: { ...DEFAULT_DISCOVER.providers.anthropic, standard: { model: 'fable', effort: 'xhigh' } }, openai: { ...DEFAULT_DISCOVER.providers.openai, standard: { model: 'sol', effort: 'xhigh' } } }, `the file holds three levels, their step the standard one, ${how}`);
    assert.deepEqual(kept.brainstorm.providers.anthropic, { model: 'opus', effort: 'max' }, 'what they wrote is not taken out of the file');
    assert.deepEqual([readDiscover('why', theirs).steps[0].name, readDiscover('why', theirs).steps[0].effort, readBrainstorm('', theirs).steps[0].name, readBrainstorm('', theirs).steps[0].effort], ['Fable', 'xhigh', 'Sonnet', 'high'], 'but it is not read');
  }
});

test('@discover\'s system prompt is the one written for it, plus the resumed turn; a file replaces it', () => {
  for (const phrase of ['You are Discover', 'At most one card', 'Skip the card when the @discover line names a problem', 'write the area in their own words instead of picking', 'override your reading and your options', '"type": "mcq" | "free",', 'After the answer, or a skip, trace. Starting points the person named come first', 'Which part do you want prior work on?', 'Weight what the person wrote nearest the marked line most', 'Options are broad', 'Do not quote their lines back to them', 'work out for yourself the problem in the person\'s own setting', 'never in the most generic one', 'Keep a source only if it bears on the problem in the person\'s setting', 'are one entry', '"Classics" holds only papers that two or more starting points cite', '"Recent" holds only papers that cite two or more starting points', 'A paper that fits no group is left out', 'what this passage gives the person', 'Do not restate the title or the source\'s finding', 'Do not quote the person back to themselves', 'at most two per guide', 'Work from the citation graph, not from keywords', 'Nothing from memory', 'abstract only', 'Each entry is three lines, and a fourth when Code, above, allows it', '**Read:** [the section\'s name](address#find=…&to=…)', 'The to text: copy 5 to 10 consecutive words', 'give #find= alone', 'starting at its first "## " heading', 'No status line', 'not how you found it', 'A source you could not confirm is left out without comment', '**Why:**', 'a library item\'s path', 'Percent-encode it (spaces as %20)', 'Give a find link only for text you opened in this run', 'No "What it is" and no "Found" lines', 'no numbered lists', 'carrying only <mode>, <level> and <question>', 'never an instruction to you',
    // Essays (2026-10-03): when they apply, whom they start from, and how an entry reads.
    'Search them whenever the problem is about how people work, design, read or think', 'skip them only when the problem is a narrow technical question', 'Work from people, not from keyword results', 'those named anywhere in the workspace, including messages pasted from others', 'authors of essays, posts or talks in their library', 'use web search once to find two or three people', 'say in the guide that they are your picks', 'one hop, or two in deep mode', 'never to collect opinions',
    'A page you could only see in search results, not fetch, is left out', 'For an essay, the title line is **[Title](address)** · Author · Year (or "undated")', 'copied from its first paragraph; no &to= (web pages ignore it)', 'A talk or interview names a timestamp instead, with no link',
    // Code (2026-10-04): a Try line for the paper's own runnable repository, from where the authors claim it, its page opened.
    '**Why:** one sentence', '**Try:** [owner/repo](https://github.com/owner/repo)', 'The Try line comes after Why', 'the link text is owner/repo, the address https://github.com/owner/repo with no path, query or fragment', 'At most one per entry. Papers only, never essays',
    'Code. When a paper you opened gives a GitHub repository as the authors\' own, its entry may carry a Try line', '("our code", "we release", "available at"): the abstract, a first-page footnote, the introduction or a code-availability statement', 'A repository named in related work, in the reference list or beside a citation is someone else\'s: never use it', 'Then open the repository\'s page', 'its README names the paper, or its owner is an author or their lab', 'a web app, a command-line tool, a library with a runnable example, or scripts that reproduce the paper', 'Leave out desktop apps (Electron, Tauri)', 'When unsure, no Try line', 'Never take a repository from memory or from a search by title',
    'A repository never earns a paper its place', 'keep the one with a Try line', 'as many as <mode> allows', 'whose abstract mentions code, a tool, a system, a model or a benchmark', 'If none qualifies, say nothing about it',
    'Every Try line\'s repository is one whose page you opened in this run', 'how many extra papers you may open to look for code']) assert.ok(DISCOVER_SYSTEM_PROMPT.toLowerCase().includes(phrase.toLowerCase()), phrase);
  assert.ok(!/ESCALATE/.test(DISCOVER_SYSTEM_PROMPT));
  assert.ok(!/exactly three lines/.test(DISCOVER_SYSTEM_PROMPT), 'an entry may have a fourth line');
  // The Code paragraphs sit after "Open what you recommend", in the trace; the Try line after Why in the guide's form.
  const at = (phrase) => DISCOVER_SYSTEM_PROMPT.indexOf(phrase);
  assert.ok(at('Open what you recommend') < at('Code. When a paper') && at('Code. When a paper') < at('A repository never earns') && at('A repository never earns') < at('# What is real'));
  assert.ok(at('**Why:** one sentence') < at('**Try:** [owner/repo]') && at('**Try:** [owner/repo]') < at('For an essay, the title line'));
  assert.ok(!/Not verified|say so at the end|already trust on this|which part of the person's problem it touches|Which of these should I start from|Card 2|select_all/.test(DISCOVER_SYSTEM_PROMPT), 'no "Not verified" group, no account of failures, no free card 2, no old Why');
  assert.ok(!/keeps in their library; fetch their own pages|not to find opinions/.test(DISCOVER_SYSTEM_PROMPT), 'essays no longer start only from people the person names or keeps');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-prompt-discover-'));
  assert.equal(loadSystemPrompt(root, 'discover'), DISCOVER_SYSTEM_PROMPT);
  fs.mkdirSync(path.join(root, '.context'));
  fs.writeFileSync(path.join(root, '.context', 'discover-system-prompt.md'), 'Mine.\n');
  assert.deepEqual([loadSystemPrompt(root, 'discover'), loadSystemPrompt(root, 'brainstorm')], ['Mine.', BRAINSTORM_SYSTEM_PROMPT]);
});

test('a discover reply is kept as a card when it is one, else as the guide it came as: a guide with braces in it stays a guide', () => {
  assert.equal(replyBody('discover', JSON.stringify(FOCUS)), card.cardBody(JSON.stringify(FOCUS)).body);
  assert.equal(replyBody('discover', GUIDE), GUIDE);
  const braces = 'Why: the {retries} part, and the loop {x}.';
  assert.equal(replyBody('discover', braces), braces, 'only a reply that starts as JSON is read as a card');
  assert.equal(replyBody('discover', '{"say": "Enough.", "card": "none", "ready": true}'), '{"say": "Enough.", "card": "none", "ready": true}', 'Discover has no recap card: kept as it came');
  assert.equal(replyBody('bart', JSON.stringify(FOCUS)), JSON.stringify(FOCUS));
});

test('a discover guide starts at its first "## " heading: a status line before it is dropped; @bart and @brainstorm keep theirs (round 2)', () => {
  const said = 'I traced from Park, Xu and Scott. Writing up the guide now.\n\n';
  assert.equal(replyBody('discover', said + GUIDE), GUIDE.slice(GUIDE.indexOf('## ')));
  assert.equal(replyBody('discover', `${said}Some notes\n## Start here\n\nx\n## Recent\ny`), '## Start here\n\nx\n## Recent\ny', 'everything before the first heading only');
  assert.equal(replyBody('discover', 'No headings here, just words.'), 'No headings here, just words.', 'no heading: kept as it came');
  assert.equal(replyBody('discover', 'Intro ### small\n#### deep'), 'Intro ### small\n#### deep', 'only a line starting "## " counts');
  assert.equal(replyBody('bart', said + '## Answer'), said + '## Answer');
  assert.equal(replyBody('brainstorm', said + '## Answer'), said + '## Answer');
  // With essays (2026-10-03): the whole guide from its first heading, its Essays group too, or a guide of essays alone.
  const essays = '## Essays\n\n**[An essay](https://example.org/essay)** · A. Writer · undated\n**Read:** [Margins](https://example.org/essay#find=the%20margin%20is%20where)\n**Why:** a design to compare against.';
  assert.equal(replyBody('discover', `${said}${GUIDE}\n\n${essays}`), `${GUIDE}\n\n${essays}`);
  assert.equal(replyBody('discover', said + essays), essays);
  // A Try line (2026-10-04) is kept as any line of the guide is.
  const tried = `${GUIDE}\n**Try:** [ada/retries](https://github.com/ada/retries)\n\n${essays}`;
  assert.equal(replyBody('discover', said + tried), tried);
});

test('the paper tools turn OpenAlex records into what a guide needs, and say what went wrong', async () => {
  const W = { id: 'https://openalex.org/W1', title: 'Retries considered', publication_year: 2021, doi: 'https://doi.org/10.1000/abc', cited_by_count: 12, type: 'article', referenced_works_count: 2, referenced_works: ['https://openalex.org/W2', 'https://openalex.org/W3'], related_works: ['https://openalex.org/W3'],
    authorships: [{ author: { display_name: 'Ada' } }, { author: { display_name: 'Bo' } }], primary_location: { source: { display_name: 'CHI' } }, abstract_inverted_index: { loop: [1], Agents: [0], forever: [2] },
    best_oa_location: { pdf_url: 'https://example.org/w1.pdf' }, locations: [{ landing_page_url: 'https://arxiv.org/abs/2101.00001v2' }] };
  const W2 = { id: 'https://openalex.org/W2', title: 'Older', publication_year: 1999, cited_by_count: 90, authorships: [], primary_location: { raw_source_name: 'Tech report' } };
  const W3 = { id: 'https://openalex.org/W3', title: 'Old', publication_year: 1998, cited_by_count: 5, authorships: [] };
  const seen = [];
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => body });
  let busy = 0;
  const fetchImpl = async (url) => {
    seen.push(url);
    const u = new URL(url);
    if (u.pathname === '/works/doi:10.1000/abc' || u.pathname === '/works/W1') return reply(200, W);
    if (u.pathname === '/works/doi:10.48550/arxiv.2101.00001') return reply(404, null);
    if (u.hostname === 'export.arxiv.org') return reply(200, '<feed><title>arXiv Query</title><entry><id>x</id><title>Retries\n  considered</title></entry></feed>');
    if (u.pathname === '/works' && /^title\.search:/.test(u.searchParams.get('filter'))) return reply(200, { results: [{ id: 'https://openalex.org/W9', title: 'Retries considered harmful', cited_by_count: 999 }, { id: 'https://openalex.org/W1', title: 'Retries: considered', cited_by_count: 1 }] });
    if (u.pathname === '/works' && /^openalex:/.test(u.searchParams.get('filter'))) return reply(200, { results: [W3, W2] });
    if (u.pathname === '/works' && /^cites:W1/.test(u.searchParams.get('filter'))) { if (busy++ === 0) return reply(429, {}); return reply(200, { meta: { count: 1 }, results: [W3] }); }
    return reply(404, null);
  };
  const papers = papersLib.createPapers({ fetchImpl, wait: async () => {} });
  const got = JSON.parse((await papersLib.callTool(papers, 'resolve', { query: 'https://doi.org/10.1000/abc' })).content[0].text).paper;
  assert.deepEqual([got.id, got.authors, got.venue, got.abstract, got.open_access, got.arxiv, got.doi], ['W1', ['Ada', 'Bo'], 'CHI', 'Agents loop forever', 'https://example.org/w1.pdf', 'https://arxiv.org/abs/2101.00001', '10.1000/abc']);
  const byArxiv = JSON.parse((await papersLib.callTool(papers, 'resolve', { query: 'arXiv:2101.00001v1' })).content[0].text);
  assert.equal(byArxiv.paper.id, 'W1', 'an arXiv id without its DOI in OpenAlex is found by its title, the exact title first');
  const refs = JSON.parse((await papersLib.callTool(papers, 'references', { id: 'W1' })).content[0].text);
  assert.deepEqual([refs.total, refs.results.map((r) => [r.id, r.venue])], [2, [['W2', 'Tech report'], ['W3', null]]], 'most cited first');
  const cites = JSON.parse((await papersLib.callTool(papers, 'citations', { id: 'W1', from_year: 2020 })).content[0].text);
  assert.deepEqual([cites.total, cites.order], [1, 'most recent first'], 'a 429 is tried once more');
  assert.ok(seen.some((url) => /filter=cites%3AW1%2Cfrom_publication_date%3A2020-01-01/.test(url) && /sort=publication_date%3Adesc/.test(url)));
  const refused = await papersLib.callTool(papers, 'search', { query: 'x', nope: 1 });
  assert.deepEqual([refused.isError, refused.content[0].text], [true, 'Invalid argument: nope.']);
  const missing = await papersLib.callTool(papers, 'references', { id: '10.9999/none' });
  assert.deepEqual([missing.isError, missing.content[0].text], [true, 'No paper was found for "10.9999/none".']);
  assert.deepEqual(papersLib.PAPER_TOOLS.map((tool) => [tool.name, tool.annotations.readOnlyHint]), ['resolve', 'references', 'citations', 'author_works', 'related', 'search'].map((name) => [name, true]));
  assert.deepEqual([activity.paperTool('resolve', { query: 'Retries' }), activity.claudeUpdate({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__papers__citations', input: { id: 'W1' } }] } }).activity], ['Looking up “Retries”', 'Reading what cites “W1”']);
});

test('the real runner for @discover: file, web and paper tools, the paper server for both CLIs, its own Codex home, sessions and timeout, and <mode>', async () => {
  const authFile = path.join(homeDir, 'auth-discover.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const replies = [JSON.stringify(FOCUS), GUIDE, GUIDE];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    const mcp = options.env.ENGELBART_BART_MCP ? JSON.parse(fs.readFileSync(options.env.ENGELBART_BART_MCP, 'utf8')) : null;
    calls.push({ command, env: options.env, timeout: options.timeout, mcp, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    const text = replies.shift();
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, text); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbce"}\n'); }
    else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`);
  };
  const codexHome = path.join(homeDir, 'codex-home-dv');
  const discoverThreads = createThreads({ idleMs: DISCOVER_IDLE_MS }), brainstormThreads = createThreads();
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-dv'), codexHome, codexAuthFile: authFile, run, brainstormThreads, discoverThreads, node: '/Apps/Engelbart', papersServer: '/Apps/papers-mcp.cjs' });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const ask = (askId, text, turns, extra = {}) => bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns, agent: 'discover', ...extra });

  const first = await ask('d1', 'agents --deep');
  const home = `${codexHome}-discover`;
  assert.equal(calls[0].env.CODEX_HOME, home);
  assert.match(calls[0].command, /-c 'tools\.web_search=true'/);
  assert.equal(calls[0].timeout, 45 * 60_000, 'three quarters of an hour a deep step');
  assert.deepEqual([calls[0].env.ENGELBART_BART_MODEL, /model_reasoning_effort="ultra"/.test(calls[0].command)], ['gpt-6-astra', true], 'deep: Astra ultra');
  assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), DISCOVER_SYSTEM_PROMPT);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), '# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.\n\n[mcp_servers.papers]\ncommand = "/Apps/Engelbart"\nargs = ["/Apps/papers-mcp.cjs"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nstartup_timeout_sec = 30\ntool_timeout_sec = 90\n');
  assert.match(calls[0].input, /<mode>deep\.[^\n]*<\/mode>\n\n<level>You are running as Astra at ultra effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nagents\n<\/question>$/);
  assert.deepEqual([first.lines[0], discoverThreads.size(), brainstormThreads.size()], ['bart> ```json', 1, 0], 'a card, kept among discover\'s own sessions');

  const said = [{ question: 'agents --deep', answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') }];
  const second = await ask('d2', '(skipped)', said);
  assert.match(calls[1].command, / resume /);
  assert.match(calls[1].input, /^<mode>deep\./, 'the resumed turn still says how far to trace');
  assert.deepEqual([calls[1].timeout, calls[1].env.ENGELBART_BART_MODEL], [45 * 60_000, 'gpt-6-astra'], 'and stays on the deep level');
  assert.deepEqual(second.lines.slice(0, 3), ['bart> ## Start here', 'bart>', 'bart> **[A paper](https://arxiv.org/abs/2401.00001)** · A. Author · 2024 · arXiv']);

  await ask('d3', '--opus only after 2022', []);
  const claude = calls[2];
  assert.match(claude.command, /--strict-mcp-config --mcp-config "\$ENGELBART_BART_MCP" --tools "Read,Grep,Glob,WebSearch,WebFetch" --allowedTools "Read,Grep,Glob,WebSearch,WebFetch,mcp__papers__\*" /);
  assert.deepEqual(claude.mcp, { mcpServers: { papers: { command: '/Apps/Engelbart', args: ['/Apps/papers-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
  assert.equal(fs.existsSync(claude.env.ENGELBART_BART_MCP), false, 'the config goes with the run');
  assert.match(claude.input, /<mode>standard\./);
  assert.equal(claude.timeout, 30 * 60_000, 'half an hour a standard step');
  assert.equal(claude.env.ENGELBART_BART_MODEL, 'opus', 'a model flag picks for its line');

  replies.push(GUIDE);
  const quick = await ask('d4', '--quick agents', []);
  const fast = calls[3];
  assert.deepEqual([fast.timeout, fast.env.ENGELBART_BART_MODEL, /model_reasoning_effort="medium"/.test(fast.command)], [30 * 60_000, 'gpt-6.1-sol', true], 'quick: Sol medium, half an hour');
  assert.match(fast.input, /<mode>quick\. Up to two starting points;[^<]*at most five sources in the guide, of which up to two are essays when essays apply\. No extra papers opened to look for code\.<\/mode>\n\n<level>You are running as Sol at medium effort/);
  assert.match(quick.lines[quick.lines.length - 1], /^bart> \*Sol · medium · \d+ s\*$/, 'its foot still names the model');

  writeCodexConfig(home, {});
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), '# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.\n');
});

test('a --codex @discover line runs Codex at its level when Claude Code is the default; a follow-up stays on Codex and resumes its session; --claude starts Claude Code afresh (P-07)', async () => {
  const authFile = path.join(homeDir, 'auth-discover-provider.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, env: options.env, timeout: options.timeout });
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, GUIDE); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcf"}\n'); }
    else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: GUIDE })}\n`);
  };
  const discoverThreads = createThreads({ idleMs: DISCOVER_IDLE_MS });
  const bart = createBart({ readModels: () => DEFAULTS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-dv-provider'), codexHome: path.join(homeDir, 'codex-home-dv-provider'), codexAuthFile: authFile, run, discoverThreads, node: '/Apps/Engelbart', papersServer: '/Apps/papers-mcp.cjs' });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const ask = (askId, text, turns = []) => bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns, agent: 'discover' });
  const answerOf = (out) => out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n');

  assert.equal(DEFAULTS.provider, 'anthropic');
  const first = await ask('dp1', 'agents --codex --deep');
  assert.match(calls[0].command, /^exec \S*codex exec --color never /, 'Codex, a new session');
  assert.deepEqual([calls[0].env.ENGELBART_BART_MODEL, /model_reasoning_effort="ultra"/.test(calls[0].command), calls[0].timeout], ['gpt-6-astra', true, 45 * 60_000], 'at deep: Astra ultra');
  assert.equal(first.meta.provider, 'openai');
  assert.match(first.lines[first.lines.length - 1], /^bart> \*Astra · ultra · \d+ s\*$/, 'the foot names it (A-02)');

  // The follow-up line says no provider: the exchange's carries, and so does its session.
  const said = [{ question: 'agents --codex --deep', answer: answerOf(first) }];
  const second = await ask('dp2', 'only after 2022', said);
  assert.match(calls[1].command, /codex exec resume "\$ENGELBART_BART_SESSION"/, 'the Codex session resumed');
  assert.deepEqual([calls[1].env.ENGELBART_BART_SESSION, calls[1].env.ENGELBART_BART_MODEL, /model_reasoning_effort="ultra"/.test(calls[1].command)], ['01a0bc2d-7c18-77d2-8b21-3cc7e942cbcf', 'gpt-6-astra', true]);
  assert.equal(second.meta.provider, 'openai');

  // A third turn, after the follow-up: still Codex, still resumed.
  await ask('dp3', 'and essays', [...said, { question: 'only after 2022', answer: answerOf(second) }]);
  assert.match(calls[2].command, /codex exec resume /);

  // Claude Code named in the same exchange: its own CLI, a new session given the document's turns, at the carried level.
  const claude = await ask('dp4', 'more --claude', said);
  assert.match(calls[3].command, /claude -p .*--session-id "\$ENGELBART_BART_SESSION"/);
  assert.deepEqual([calls[3].env.ENGELBART_BART_MODEL, / --effort max /.test(calls[3].command), claude.meta.provider], ['opus', true, 'anthropic'], 'deep on Claude Code: Opus max');
});

test('the fake @discover asks one card (which part, in broad areas) for a line with no problem, then writes a guide; a problem gets the guide at once, and a follow-up additions', async () => {
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const run = async (doc, askId) => {
    const [thread] = model.threads(doc);
    const turns = thread.turns.filter((turn) => turn.answered).map((turn) => model.turnText(doc, turn));
    const out = await bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text: model.parseLine(doc[doc.length - 1]).text, turns, agent: 'discover' });
    const next = [...doc, ...out.lines];
    const [again] = model.threads(next);
    return { doc: next, card: card.cardOfAnswer(model.turnText(next, again.turns[again.turns.length - 1]).answer), lines: out.lines };
  };
  const at = await run(['@discover'], 'dv1');
  const which = card.questionOf(at.card);
  assert.deepEqual([which.type, which.title], ['focus', 'Which part do you want prior work on?']);
  assert.ok(which.options.length >= 3 && which.options.length <= 4, 'three or four broad areas');
  assert.equal(at.card.say, '');
  const picked = await run([...at.doc, `@discover ${card.answerLine(at.card, { picks: [which.options[0].label] })}`], 'dv2');
  assert.deepEqual([picked.card, picked.lines[0]], [null, 'bart> ## Start here'], 'one card: a pick goes straight to the guide');
  assert.ok(!picked.lines.some((line) => /Which of these should I start from/.test(line)));
  const own = await run([...at.doc, `@discover ${card.answerLine(at.card, { note: 'choosing among research threads, from the ReAct paper' })}`], 'dv2b');
  assert.equal(own.card, null, 'their own words: the guide');
  assert.equal(own.lines[2], 'bart> **[A fake record for “choosing among research threads, from the ReAct paper”](https://example.org/fake-named)** · Fake Author et al. · 2024', 'their words start the guide');
  const guide = await run([...at.doc, '@discover (skipped)'], 'dv3');
  assert.equal(guide.card, null, 'the guide is not a card');
  assert.equal(guide.lines[0], 'bart> ## Start here');
  assert.ok(!guide.lines.some((line) => /Not verified/.test(line)), 'no "Not verified" group');
  // Three lines an entry (2026-09-30): the title, Read with a link to the passage, Why.
  const entry = guide.lines.slice(2, 5).map((line) => line.replace(/^bart> ?/, ''));
  assert.match(entry[0], /^\*\*\[[^\]]+\]\([^)\s]+\)\*\* · Fake Author et al\. · 2024$/);
  assert.match(entry[1], /^\*\*Read:\*\* \[Introduction\]\([^)\s]+#find=a%20fake%20passage[^)\s&]*&to=the%20fake%20section%20after%20it\)$/);
  assert.match(entry[2], /^\*\*Why:\*\* a fake method to set against the open question in “Agents” of /, 'what the passage gives and the open question (round 3)');
  assert.ok(!guide.lines.some((line) => /^bart> \*\*Why:\*\*.*agents”/.test(line)), 'never the person\'s words quoted back');
  assert.equal(guide.lines[5], 'bart>', 'one blank line between entries');
  assert.ok(!guide.lines.some((line) => /What it is:|Found:/.test(line)));
  const { splitTarget } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/stage.js')).href);
  const link = entry[1].match(/\]\(([^)\s]+)\)$/)[1];
  assert.deepEqual([splitTarget(link).find, splitTarget(link).to], ['a fake passage the fake did not read', 'the fake section after it'], 'the Stage reads the passage and the section\'s end back');
  // An "## Essays" group (2026-10-03): one essay, its author alone and a year or "undated", its Read a heading linked to the
  // first paragraph's words with no &to=.
  const essaysAt = guide.lines.indexOf('bart> ## Essays');
  assert.ok(essaysAt > guide.lines.indexOf('bart> ## Classics'), 'the Essays group, after the papers');
  assert.equal(guide.lines[essaysAt + 1], 'bart>');
  const essay = guide.lines.slice(essaysAt + 2, essaysAt + 5).map((line) => line.replace(/^bart> ?/, ''));
  assert.equal(essay[0], '**[A fake essay](https://example.org/fake-essay)** · Fake Essayist · undated');
  assert.match(essay[0], /^\*\*\[[^\]]+\]\(https:\/\/[^)\s#]+\)\*\* · [^·]+ · (?:\d{4}|undated)$/, 'the E-03 title line');
  assert.equal(essay[1], '**Read:** [A fake heading](https://example.org/fake-essay#find=the%20fake%20first%20paragraph%20of%20the%20essay)');
  assert.ok(!/&to=/.test(essay[1]), 'no &to=: a web page ignores it');
  assert.match(essay[2], /^\*\*Why:\*\* a fake case that cuts against what is assumed to set against the open question in “Agents” of /);
  const essayLink = splitTarget(essay[1].match(/\]\(([^)\s]+)\)$/)[1]);
  assert.deepEqual([essayLink.address, essayLink.find, essayLink.to], ['https://example.org/fake-essay', 'the fake first paragraph of the essay', ''], 'the Stage opens the page and finds its words');
  assert.equal(guide.lines.filter((line) => /^bart> \*\*\[/.test(line)).length, 3, 'a starting paper, a classic and an essay: within the mode\'s total');
  // The classic was read in full and ends in a Try line, its authors' repository (2026-10-04): a fourth line, after Why.
  const classicAt = guide.lines.indexOf('bart> ## Classics');
  const classic = guide.lines.slice(classicAt + 2, classicAt + 7).map((line) => line.replace(/^bart> ?/, ''));
  assert.match(classic[1], /^\*\*Read:\*\* \[Implementation\]\(https:\/\/example\.org\/fake-classic#find=a%20fake%20passage%20on%20how%20it%20was%20built&to=/);
  assert.match(classic[2], /^\*\*Why:\*\* /);
  assert.equal(classic[3], '**Try:** [fake-lab/fake-classic](https://github.com/fake-lab/fake-classic)', 'the T-01 form');
  assert.equal(classic[4], '', 'one blank line after it');
  assert.equal(guide.lines.filter((line) => /^bart> \*\*Try:\*\*/.test(line)).length, 1, 'one Try line, on a paper, none on the essay');
  const { guideRepo } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/guide.js')).href);
  assert.deepEqual(guideRepo(classic[3]), { name: 'fake-lab/fake-classic', address: 'https://github.com/fake-lab/fake-classic' });
  const fakeGuide = guide.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n');
  assert.equal(replyBody('discover', fakeGuide), fakeGuide, 'replyBody keeps the Try line');
  const more = await run([...guide.doc, '@discover only after 2022'], 'dv4');
  assert.equal(more.lines[0], 'bart> ## Recent', 'a follow-up on a guide gets additions');
  assert.equal((await run(['@discover agents'], 'dv5a')).lines[0], 'bart> ## Start here', 'a line that names a problem, however short, asks no card');
  const long = await run(['@discover why do coding agents retry the same failing step'], 'dv5');
  assert.equal(long.lines[0], 'bart> ## Start here');
  assert.ok(long.lines.some((line) => /\(standard mode\)/.test(line)));
  const parsed = model.parseLine('@Discover why');
  assert.deepEqual([parsed.agent, model.agentOf(parsed), model.agentOf(model.parseLine('@bart why'))], ['discover', 'discover', 'bart']);
  projects.agentStarted(ctx, { id: 'dv-agent', kind: 'discover', projectId: project.id, workspaceId: workspace.id });
  projects.agentFinished(ctx, 'dv-agent');
});
