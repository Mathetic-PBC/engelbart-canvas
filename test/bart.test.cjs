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
  // A question asked from a note on a PDF highlight (MATH-27): its own block, and its own rules for the box beside the passage.
  for (const phrase of ['<highlight>, when the question was asked from a note on a PDF highlight', '# Asked from a highlight', 'at most three sentences, under 500 characters', 'Longer answer: continue in the workspace.']) assert.ok(BART_SYSTEM_PROMPT.includes(phrase), phrase);
  assert.ok(BART_SYSTEM_PROMPT.indexOf('# Asked from a highlight') < BART_SYSTEM_PROMPT.indexOf('# Moving up a step'), 'the highlight rules come before moving up');
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

/* ------------------------------------------------------------- the person's pdf highlights (MATH-27, 2026-10-06) */

const { marksOf, stageBlock, mentionedBlock, STAGE_BUDGET, MENTIONED_BUDGET } = require('../src/main/bart/highlights.cjs');
const box = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.015 }];
const hl = (id, text, extra = {}) => ({ id, rects: box, y: 0.2, text, note: null, pos: null, ...extra });
const asked = (question, answer) => ({ id: `a-${question}`, question, answer, meta: {}, at: 'now', pos: null, collapsed: false });

test('marksOf: one highlight a mark, in page order; a selection across pages is one, labelled with its first page; nothing empty', () => {
  const ink = {
    4: [hl('m4b', 'second part', { group: 'g1', y: 0.05, asks: [asked('what?', 'that.')] }), hl('m4', 'later on four', { y: 0.6 })],
    3: [hl('m3', 'first part', { group: 'g1', y: 0.9, note: 'a note on it' }), { id: 'free', rects: [], y: 0.1, note: 'a free note', text: '' }, hl('bare', '   ')],
    x: [hl('junk', 'not a page')],
    0: [hl('zero', 'no page 0')],
    5: 'not a list',
  };
  assert.deepEqual(marksOf(ink), [
    { page: 3, quote: '', note: 'a free note', asks: [] },
    { page: 3, quote: 'first part\nsecond part', note: 'a note on it', asks: [{ question: 'what?', answer: 'that.' }] },
    { page: 4, quote: 'later on four', note: '', asks: [] },
  ]);
  assert.deepEqual([marksOf(null), marksOf([]), marksOf('x')], [[], [], []]);
});

test('stageBlock: the page in view first, then the nearest; noted before bare; within its budget, <more> when any was left out; shown in page order', () => {
  const paper = { name: 'Paper "A"', where: '/p/a.pdf', annotations: '/d/annotations/x.json' };
  assert.equal(stageBlock(paper, 7, {}), '<stage paper="Paper  A " path="/p/a.pdf" page="7" highlights="0"/>');
  assert.equal(stageBlock(paper, 7, null), '<stage paper="Paper  A " path="/p/a.pdf" page="7" highlights="0"/>');
  const small = stageBlock(paper, 2, { 2: [hl('a', 'alpha', { note: 'mine', asks: [asked('why?', 'because')] })] });
  assert.equal(small, '<stage paper="Paper  A " path="/p/a.pdf" page="2" annotations="/d/annotations/x.json">\n<highlight page="2">\n<quote>\nalpha\n</quote>\n<note>\nmine\n</note>\n<ask>\n<question>\nwhy?\n</question>\n<answer>\nbecause\n</answer>\n</ask>\n</highlight>\n</stage>');
  // Quotes past 600 and answers past 1,500 are cut in the middle.
  const long = stageBlock(paper, 1, { 1: [hl('l', 'q'.repeat(5000), { asks: [asked('a?', 'w'.repeat(9000))] })] });
  assert.ok(/<quote>\nq+\n\[… 4,4\d\d characters cut …\]\nq+\n<\/quote>/.test(long) && /characters cut[^]*characters cut/.test(long));
  assert.ok(long.match(/<quote>\n([^]*?)\n<\/quote>/)[1].length <= 600 && long.match(/<answer>\n([^]*?)\n<\/answer>/)[1].length <= 1500);
  // Twenty bare highlights of ~560 characters on pages 1–20 and one noted on page 20: on page 10, the noted one and the
  // nearest pages are kept, the far ones left out.
  const ink = {};
  for (let p = 1; p <= 20; p += 1) ink[p] = [hl(`b${p}`, `p${p} `.padEnd(560, 'x'))];
  ink[20].push(hl('n20', 'noted far away', { note: 'keep me', y: 0.5 }));
  const out = stageBlock(paper, 10, ink);
  assert.ok(out.length <= STAGE_BUDGET, `${out.length}`);
  const pages = [...out.matchAll(/<highlight page="(\d+)">/g)].map((m) => Number(m[1]));
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b), 'in page order');
  assert.ok(out.includes('keep me'), 'a noted highlight is kept over bare ones');
  assert.ok(out.includes('p10 ') && out.includes('p9 ') && out.includes('p11 '), 'the page in view and its neighbours');
  assert.ok(!out.includes('p1 x') && !out.includes('p19 '), 'the far ones are left out');
  const kept = pages.length;
  assert.match(out, new RegExp(`<more n="${21 - kept}"/>\\n</stage>$`));
  assert.ok(!small.includes('<more'), 'nothing left out: no <more>');
});

test('mentionedBlock: papers without highlights left out, a shared budget, every paper some, noted before bare, <more> per paper', () => {
  const many = (tag, n) => { const ink = {}; for (let p = 1; p <= n; p += 1) ink[p] = [hl(`${tag}${p}`, `${tag}${p} `.padEnd(560, 'x'))]; return ink; };
  assert.equal(mentionedBlock([]), '');
  assert.equal(mentionedBlock([{ name: 'Empty', where: '/e.pdf', annotations: '/a/e.json', ink: { 1: [] } }, { name: 'None', where: '/n.pdf', annotations: '', ink: null }]), '');
  const a = { name: 'A', where: '/a.pdf', annotations: '/ink/a.json', ink: many('A', 30) };
  const b = { name: 'B', where: '/b.pdf', annotations: '/ink/b.json', ink: { ...many('B', 30), 30: [hl('Bn', 'noted at the end', { asks: [asked('q?', 'an answer')] })] } };
  const out = mentionedBlock([a, { name: 'Empty', where: '/e.pdf', annotations: '', ink: {} }, b]);
  assert.ok(out.length <= MENTIONED_BUDGET, `${out.length}`);
  assert.ok(out.startsWith('<highlights from="mentioned">\n<paper name="A" path="/a.pdf" annotations="/ink/a.json">\n<highlight page="1">') && out.endsWith('</paper>\n</highlights>'));
  assert.ok(!out.includes('Empty'));
  assert.ok(out.includes('an answer'), 'the asked one is kept though it is on the last page');
  const count = (tag) => (out.match(new RegExp(`<quote>\\n${tag}\\d+ `, 'g')) || []).length;
  assert.ok(count('A') >= 9 && count('B') >= 9 && Math.abs(count('A') - count('B')) <= 1, `${count('A')} and ${count('B')}: shared`);
  assert.ok(out.includes(`<more n="${30 - count('A')}"/>\n</paper>\n<paper name="B"`), 'A says how many were left out');
  const fits = mentionedBlock([{ name: 'S', where: '/s.pdf', annotations: '/ink/s.json', ink: { 2: [hl('s', 'short')] } }]);
  assert.equal(fits, '<highlights from="mentioned">\n<paper name="S" path="/s.pdf" annotations="/ink/s.json">\n<highlight page="2">\n<quote>\nshort\n</quote>\n</highlight>\n</paper>\n</highlights>');
});

test('stageInput: a pdf in front by library row or address, its page a page number; anything else in front is none', () => {
  const { stageInput } = require('../src/main/ipc.cjs');
  const ROW = '3f0a6c1e-6b1d-4a57-9a51-1c2b3d4e5f60';
  assert.deepEqual(stageInput({ rowId: ROW, url: null, page: 3, kind: 'pdf' }), { rowId: ROW, url: null, page: 3, kind: 'pdf' });
  assert.deepEqual(stageInput({ url: 'https://x.y/a.pdf', page: 1, kind: 'pdf', extra: 1 }), { rowId: null, url: 'https://x.y/a.pdf', page: 1, kind: 'pdf' });
  for (const none of [null, undefined, { kind: 'page', url: 'x'.repeat(9000) }, { kind: 'file' }, { kind: 'pdf', page: 1 }]) assert.equal(stageInput(none), null);
  for (const bad of ['x', [], { kind: 'pdf', rowId: 'nope', page: 1 }, { kind: 'pdf', rowId: 7, page: 1 }, { kind: 'pdf', url: 'x'.repeat(4097), page: 1 }, { kind: 'pdf', url: 'u', page: 0 }, { kind: 'pdf', url: 'u', page: 1.5 }, { kind: 'pdf', url: 'u', page: '2' }, { kind: 7 }]) {
    assert.throws(() => stageInput(bad), TypeError, JSON.stringify(bad));
  }
});

test('ask-bart hands @bart the Stage, and no other agent; a Stage it cannot read fails the question', async () => {
  const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const handlers = new Map(), seenQuestions = [];
  const bart = { async ask(c, pid, question) { seenQuestions.push(question); return { lines: ['bart> ok'], meta: {} }; }, stop: () => true };
  registerEngelbartIpc({ store: { context: async () => ctx }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {}, bart, windowHandler: (fn) => (...args) => fn({ id: 'w' }, ...args), reply: () => {}, announce: () => {} });
  const call = (input) => handlers.get('engelbart:ask-bart')(project.id, { workspaceId: workspace.id, ref: { kind: 'workspace', workspaceId: workspace.id }, text: 'why?', turns: [], ...input });
  const stage = { rowId: null, url: 'https://x.y/a.pdf', page: 4, kind: 'pdf' };
  await call({ askId: 'st1', stage });
  await call({ askId: 'st2', stage, agent: 'brainstorm' });
  await call({ askId: 'st3', stage: { kind: 'page', url: 'https://x.y/', page: 1 } });
  await call({ askId: 'st4' });
  assert.deepEqual(seenQuestions.map((q) => q.stage || null), [stage, null, null, null]);
  const out = await call({ askId: 'st5', stage: { kind: 'pdf', url: 'u', page: -1 } });
  assert.ok(out.failed && seenQuestions.length === 4, 'refused before it is asked');
});

test('buildContext with the Stage: <stage> for the pdf in front, <highlights> for the mentioned ones, a paper once; none of it without a pdf in front, for a mark too, or for the other agents', async () => {
  const library = require('../src/main/store/library.cjs');
  const { randomUUID } = require('node:crypto');
  const downloads = path.join(homeDir, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const rowOf = async (name, extra = {}) => {
    const id = randomUUID(), file = path.join(downloads, `${name}.pdf`);
    fs.writeFileSync(file, '%PDF-1.4\n');
    await ctx.libraryDb.insert({ id, name, project_id: project.id, tags: ['paper'], type: 'pdf', path: file, ...extra });
    return { id, file };
  };
  const open = await rowOf('Open Paper'), cited = await rowOf('Cited Paper'), plain = await rowOf('Plain Paper');
  await library.writeAnnotations(ctx, open.id, { 2: [hl('o2', 'on page two', { note: 'my note', asks: [asked('what does it mean?', 'it means this')] })], 5: [hl('o5', 'on page five')] });
  await library.writeAnnotations(ctx, cited.id, { 1: [hl('c1', 'cited passage')] });
  const wsRef = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, wsRef, 'See @[Cited Paper], @[Open Paper] and @[Plain Paper].\n@bart what did I note on this page?\nbart~> s1\n');
  const ask = (input) => buildContext(ctx, project.id, { ref: wsRef, workspaceId: workspace.id, askId: 's1', ...input });
  const space = (await ask({ agent: 'discover' })).documents; // the workspace alone
  assert.ok(/^<workspace name="Agents">[^]*<\/workspace>$/.test(space));
  const withStage = await ask({ stage: { rowId: open.id, url: null, page: 2, kind: 'pdf' } });
  assert.equal(withStage.documents.slice(0, space.length + 2), `${space}\n\n`, 'the rest is as it was');
  const stageText = withStage.documents.slice(space.length + 2);
  assert.ok(stageText.startsWith(`<stage paper="Open Paper" path="${open.file}" page="2" annotations="${path.join(ctx.dataRoot, 'annotations', `${open.id}.json`)}">\n<highlight page="2">\n<quote>\non page two\n</quote>\n<note>\nmy note\n</note>\n<ask>\n<question>\nwhat does it mean?\n</question>\n<answer>\nit means this\n</answer>\n</ask>\n</highlight>\n<highlight page="5">`), stageText.slice(0, 400));
  assert.ok(stageText.includes(`</stage>\n\n<highlights from="mentioned">\n<paper name="Cited Paper" path="${cited.file}" annotations="${path.join(ctx.dataRoot, 'annotations', `${cited.id}.json`)}">\n<highlight page="1">\n<quote>\ncited passage\n</quote>\n</highlight>\n</paper>\n</highlights>`));
  assert.ok(stageText.includes('<stage paper="Open Paper"') && !stageText.includes('<paper name="Open Paper"'), 'open and mentioned: in <stage> alone');
  assert.ok(!stageText.includes('Plain Paper"'), 'a mentioned pdf without highlights is left out');
  // Nothing in front that is a pdf, or nothing at all: <highlights> alone.
  for (const stage of [null, { kind: 'page', url: 'https://example.org/', page: 1 }]) {
    const c = await ask({ stage });
    assert.ok(!c.documents.includes('<stage') && c.documents.includes('<paper name="Open Paper"') && c.documents.includes('<paper name="Cited Paper"'));
  }
  // An open pdf with no highlights: one line.
  const bare = await ask({ stage: { rowId: plain.id, url: null, page: 3, kind: 'pdf' } });
  assert.ok(bare.documents.includes(`<stage paper="Plain Paper" path="${plain.file}" page="3" highlights="0"/>`));
  // A pdf in front the library does not hold: by its address (readPageAnnotations), its folder granted.
  const loose = path.join(fs.mkdtempSync(path.join(homeDir, 'loose-')), 'Loose.pdf'); // a folder the library's rows are not in
  fs.writeFileSync(loose, '%PDF-1.4\n');
  const looseUrl = pathToFileURL(loose).href;
  await library.writePageAnnotations(ctx, looseUrl, { 9: [hl('l9', 'a loose passage')] });
  const byUrl = await ask({ stage: { rowId: null, url: looseUrl, page: 9, kind: 'pdf' } });
  assert.match(byUrl.documents, new RegExp(`<stage paper="Loose\\.pdf" path="${loose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" page="9" annotations="[^"]+pages[^"]+\\.json">\\n<highlight page="9">\\n<quote>\\na loose passage`));
  assert.ok(byUrl.dirs.includes(path.dirname(loose)), 'its folder can be read');
  // Mentioned nothing: no <highlights>.
  await projects.writeDoc(ctx, project.id, wsRef, '@bart what did I note on this page?\nbart~> s1\n');
  const alone = await ask({ stage: { rowId: open.id, url: null, page: 5, kind: 'pdf' } });
  assert.ok(alone.documents.includes('<stage paper="Open Paper"') && !alone.documents.includes('<highlights'));
  // @brainstorm and @discover: as they were.
  await projects.writeDoc(ctx, project.id, wsRef, 'See @[Cited Paper].\n@brainstorm\nbart~> s1\n');
  for (const agent of ['brainstorm', 'discover']) {
    const before = await ask({ agent });
    const after = await ask({ agent, stage: { rowId: open.id, url: null, page: 2, kind: 'pdf' } });
    assert.equal(after.documents, before.documents, agent);
    assert.ok(!after.documents.includes('<stage') && !after.documents.includes('<highlights'), agent);
  }
  // From a highlight: <highlight> as it was, <stage> beside it; the paper it is on is not "mentioned" for being asked from.
  const mark = { kind: 'mark', id: 'o2', rowId: open.id, page: 2 };
  const fromMark = await buildContext(ctx, project.id, { ref: mark, workspaceId: workspace.id, askId: 's2', highlight: { quote: 'on page two', note: '@bart why?' }, stage: { rowId: open.id, url: null, page: 2, kind: 'pdf' } });
  assert.match(fromMark.documents, /<\/workspace>\n\n<highlight paper="Open Paper" [^]*<\/highlight>\n\n<stage paper="Open Paper"[^]*<\/stage>\n\n<highlights from="mentioned">\n<paper name="Cited Paper"[^]*<\/highlights>$/);
  const markOnly = await buildContext(ctx, project.id, { ref: mark, workspaceId: workspace.id, askId: 's2', highlight: { quote: 'on page two', note: '' } });
  assert.ok(!markOnly.documents.includes('<paper name="Open Paper"'), 'not in <highlights> for being asked from');
  for (const row of [open, cited, plain]) await ctx.libraryDb.remove(row.id); // the tests below grant no ~/Downloads
  await projects.writeDoc(ctx, project.id, wsRef, '');
});

test('the system prompt tells @bart what <stage> and <highlights> are, after <highlight>', () => {
  const at = (s) => BART_SYSTEM_PROMPT.indexOf(s);
  assert.ok(at('- <highlight>, when') < at('- <stage>, when a PDF is open in the Stage') && at('- <stage>, when') < at('- <highlights>, when the documents mention PDFs') && at('- <highlights>') < at('- <conversation>'));
  assert.match(BART_SYSTEM_PROMPT, /read it again for a follow-up, or when <more> says some were left out/);
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
const { readBrainstorm, DEFAULT_BRAINSTORM } = require('../src/main/bart/models.cjs');
const { loadSystemPrompt, BRAINSTORM_IDLE_MS, BRAINSTORM_PATHS, MAX_BRAINSTORM_CARDS, AGENTS } = require('../src/main/bart/ask.cjs');

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

test('a reply holding more than one object is the last of them that is a card (2026-10-04)', () => {
  const ONE = { say: 'You wrote about retries.', card: 'focus', focus: { title: 'Where should we start?', options: [{ label: 'Retries' }] }, ready: false };
  const FOUR = { ...ONE, focus: { title: 'Where should we start?', options: ['Retries', 'Timeouts', 'The logs', 'The tests'].map((label) => ({ label })) } };
  const four = card.readCard(JSON.stringify(FOUR));
  const fenced = (value) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  // What the model wrote: a focus card with one option, a sentence, then the card again with four.
  const corrected = `${JSON.stringify(ONE)}\n\nWait — I need to give three or four options. Corrected reply:\n\n${JSON.stringify(FOUR)}`;
  assert.deepEqual(card.readCard(corrected), four, 'the four-option card');
  assert.deepEqual(card.cardBody(corrected), { body: fenced(four), card: four }, 'kept as fenced JSON, not as the text it came as');
  assert.deepEqual(card.readCard(`${fenced(ONE)}\n\nWait — I need to give three or four options. Corrected reply:\n\n${fenced(FOUR)}`), four, 'each in a fence of its own');
  assert.deepEqual(card.readCard(`${JSON.stringify(FOUR)}\nOr, as a note: {"card": "focus", "focus": {"options": []}}`), four, 'a valid card first, a rejected one second');
  assert.deepEqual(card.readCard(`${JSON.stringify(FOUR)} and {"done": true}`), four, 'a valid card first, an object that is no card second');
  assert.deepEqual(card.parseJson(`${JSON.stringify(FOUR)} and {"done": true}`), { done: true }, 'parseJson alone takes the last object that parses');
  assert.deepEqual(card.readCard(`${JSON.stringify(FOCUS)}\nBetter:\n${JSON.stringify(PICK)}`), card.readCard(JSON.stringify(PICK)), 'two cards: the last');
  assert.deepEqual(card.readCard(`Note { oops ${JSON.stringify(FOUR)}`), four, 'a brace that never closes is passed over');

  // Braces and quotes inside a string are the string's.
  const quoted = { ...FOUR, say: 'use {x} and "y"' };
  assert.deepEqual(card.jsonBlocks(JSON.stringify(quoted)), [JSON.stringify(quoted)], 'one object');
  const lone = JSON.stringify({ ...ONE, say: 'a lone } after "z {"' });
  assert.deepEqual(card.jsonBlocks(`${lone} Corrected: ${JSON.stringify(quoted)}`), [lone, JSON.stringify(quoted)], 'an escaped quote does not end the string');
  assert.equal(card.readCard(`${lone} Corrected: ${JSON.stringify(quoted)}`).say, 'use {x} and "y"');
  assert.deepEqual(card.jsonBlocks('a {"x": {"y": "}"}} b { c {"z": 2}'), ['{"x": {"y": "}"}}', '{"z": 2}'], 'an object inside another is part of it; a brace that never closes is passed over');

  // One object reads as it did.
  assert.deepEqual(card.parseJson(JSON.stringify(FOUR)), FOUR, 'bare');
  assert.deepEqual(card.parseJson(fenced(FOUR)), FOUR, 'in a fence');
  assert.deepEqual(card.parseJson(`Here you go: ${JSON.stringify(FOUR)} Thanks.`), FOUR, 'with words around it');
  assert.deepEqual(card.readCard(`Here you go: ${JSON.stringify(FOUR)} Thanks.`), four);
  assert.equal(card.parseJson('the {retries} part, and the loop {x}.'), null, 'braces that hold no JSON');

  // No card in it: null, and kept as it came.
  const none = `${JSON.stringify(ONE)}\nCorrected: ${JSON.stringify({ card: 'focus', focus: { options: [{ label: 'Only' }] } })}`;
  assert.equal(card.readCard(none), null);
  assert.deepEqual(card.cardBody(none), { body: none, card: null });
  assert.equal(card.readCard(JSON.stringify(ONE)), null, 'one option alone is still no card');

  // The recap is as it was.
  const recap = '{"say": "Where you are: a\\nYour question: b", "card": "none", "ready": true}';
  assert.deepEqual(card.readCard(recap), { say: 'Where you are: a\nYour question: b', card: 'none', ready: true });
  assert.equal(card.cardBody(recap).body, 'Where you are: a\nYour question: b');
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

test('@brainstorm runs on the models file\'s step: Sonnet high on Claude Code, Sol medium on Codex unless edited; a flag picks nothing and is not part of the question (2026-10-02; in the file again 2026-10-06)', () => {
  const step = (text, models) => readBrainstorm(text, models).steps.map((s) => `${s.name} ${s.effort}`);
  assert.deepEqual(DEFAULT_BRAINSTORM.providers, { anthropic: { model: 'sonnet', effort: 'high' }, openai: { model: 'sol', effort: 'medium' } });
  assert.deepEqual(DEFAULT_MODELS.brainstorm, DEFAULT_BRAINSTORM, 'the models file offers it');
  assert.deepEqual(step('', DEFAULTS), ['Sonnet high']);
  assert.deepEqual(step('picked "x"', MODELS), ['Sol medium']);
  for (const [models, at] of [[DEFAULTS, 'Sonnet high'], [MODELS, 'Sol medium']]) {
    const read = readBrainstorm('--opus --max hello', models);
    assert.deepEqual([step('--opus --max hello', models), read.question, read.pinned], [[at], 'hello', false], `--opus --max on ${at}`);
  }
  assert.deepEqual([readBrainstorm('--fable picked "x" --high', MODELS).provider, readBrainstorm('--fable picked "x" --high', MODELS).question], ['openai', 'picked "x"'], 'a model of the other provider moves nothing either');
  assert.equal(readBrainstorm('', DEFAULTS).pinned, false, 'nothing picked by hand, so nothing is kept as the next start');
  assert.deepEqual(step('', startingAt(DEFAULTS, 'bart', { provider: 'openai', model: 'astra', effort: 'xhigh' })), ['Sol medium'], 'on the provider an @bart question would start on, at its own step');
  // The file's step is read; a provider without the step's model starts on the default, then on its ladder's first step.
  const edited = normalizeModels({ ...DEFAULT_MODELS, brainstorm: { providers: { anthropic: { model: 'opus', effort: 'xhigh' }, openai: { model: 'astra', effort: 'high' } } } });
  assert.deepEqual(edited.brainstorm.providers, { anthropic: { model: 'opus', effort: 'xhigh' }, openai: { model: 'astra', effort: 'high' } });
  assert.deepEqual([step('', edited), step('', { ...edited, provider: 'openai' })], [['Opus xhigh'], ['Astra high']]);
  assert.deepEqual(step('--sonnet hello', edited), ['Opus xhigh'], 'a flag still picks nothing');
  const anthropic = DEFAULT_MODELS.providers.anthropic;
  const noSonnet = normalizeModels({ ...DEFAULT_MODELS, providers: { ...DEFAULT_MODELS.providers, anthropic: { ...anthropic, models: { opus: anthropic.models.opus, fable: anthropic.models.fable }, ladder: [{ model: 'opus', effort: 'medium' }] } } });
  assert.deepEqual(step('', noSonnet), ['Opus medium']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-brainstorm-'));
  loadModels(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, MODELS_FILE), 'utf8')).brainstorm, DEFAULT_BRAINSTORM, 'a new file is written with one');
});

test('normalizeBrainstorm: each step one of its provider\'s @bart models and efforts, else the default, else the ladder\'s first; loose words are read as flags are', () => {
  const { normalizeBrainstorm } = require('../src/main/bart/models.cjs');
  const steps = (value, providers = DEFAULTS.providers) => normalizeBrainstorm(value, providers).providers;
  assert.deepEqual(steps(null), DEFAULT_BRAINSTORM.providers);
  assert.deepEqual(steps({ providers: 'nope' }), DEFAULT_BRAINSTORM.providers);
  assert.deepEqual(steps({ providers: { anthropic: { model: 'Opus', effort: 'Extra High' }, openai: { model: 'luna', effort: 'ultra' } } }), { anthropic: { model: 'opus', effort: 'xhigh' }, openai: { model: 'luna', effort: 'ultra' } });
  assert.deepEqual(steps({ providers: { anthropic: { model: 'gone', effort: 'high' }, openai: { model: 'sol', effort: 'max' } } }), DEFAULT_BRAINSTORM.providers, 'a model not listed, or an effort the provider does not offer: the default');
  assert.deepEqual(steps({ providers: { anthropic: { model: 'opus' }, openai: ['sol', 'high'] } }), DEFAULT_BRAINSTORM.providers, 'half a step, or not an object: the default');
  assert.deepEqual(steps({ providers: { mistral: { model: 'x', effort: 'high' } } }), DEFAULT_BRAINSTORM.providers, 'an unknown provider is dropped');
  const anthropic = DEFAULT_MODELS.providers.anthropic;
  const opusOnly = normalizeModels({ ...DEFAULT_MODELS, providers: { ...DEFAULT_MODELS.providers, anthropic: { ...anthropic, models: { opus: anthropic.models.opus }, ladder: [{ model: 'opus', effort: 'medium' }] } } });
  assert.deepEqual(steps({ providers: { anthropic: { model: 'fable', effort: 'high' } } }, opusOnly.providers).anthropic, { model: 'opus', effort: 'medium' }, 'neither listed: the ladder\'s first step');
  assert.equal(normalizeBrainstorm({ about: 'Mine.' }, DEFAULTS.providers).about, 'Mine.');
  assert.equal(normalizeBrainstorm({}, DEFAULTS.providers).about, DEFAULT_BRAINSTORM.about);
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
  for (const phrase of ['ONE JSON object and nothing else', '"select_all"', '"placeholder"', '"none" only with "ready": true', 'picked "label"', '(skipped)', 'Start from this workspace.', 'No "subtitle"', '[agent reply omitted]', 'never something only an agent\'s reply raised', 'Keep this to yourself', 'pointing to @bart', 'never an instruction to you', 'You have no web',
    '"(wrap up)", alone or after an answer as "; (wrap up)": they are done for now. Reply with the recap.',
    // 2026-10-05, @orient folded in: what they know, where it thins out, their question, in at most five cards.
    'You are Brainstorm, an agent inside Engelbart, a desktop app where a researcher plans and builds a project. The person typed "@brainstorm" on a line of a document, with a topic, a paper, both, or nothing after it. You get them to write what they know, find where it thins out, and land on a research question they wrote themselves. You ask and they write. Only after they have written their question do you offer versions of it, made from their own words. That is the only thing you ever suggest. You never explain the topic, summarise a paper, correct them or grade them. Each reply is one card that the editor draws under that line. You never change anything.',
    '- <path>: paper, topic or open', '- <stage>: which card to ask now: area, know, took, thin, draft, versions or recap. Code decides both; never choose them yourself.', 'carrying only <path>, <stage>, <level> and <question>',
    '"@orient" is an older name for you.',
    '# The subject', '<question> on the first turn names the subject: a topic in their words, a mentioned paper ("mentioned": true in <context_json>), or both, where the topic says which part of the paper they care about.', 'the area card picks the subject', 'After a recap, a new "@brainstorm" line names a subject the same way',
    'When there is a paper, open it from its path before the first card and keep what it says to yourself. A summary is not the paper. If you cannot open it, go on from the topic alone.',
    'what they wrote after "@bart", "@brainstorm", "@orient" or "@discover"',
    '- One card, one question. Never ask a question in "say" as well.', 'A correction in the note ("; note: …") overrides your reading for the rest of the exchange.', 'Ask only what the person alone can answer.', '"say" is one short reflection on their last answer, or empty when the card says it all.',
    '- area (open path only): your reading in "say", at most two plain sentences', 'A "focus" card: "Where do you want to find a question?", with three or four broad areas in the workspace\'s own terms.',
    '- know: an "open" card with id "know": ask them to write what they know about the subject, as they would explain it to a colleague.',
    '- took (paper path): an "open" card with id "took": ask what they took from the paper.',
    '- Skipping the first card: if their own writing in this workspace already answers know or took, ask thin instead, and put one quote of theirs in "say": You wrote: "…". The quote must be a full sentence they wrote, copied exactly, about this subject: their own lines, or their answers on @brainstorm or @orient lines. Never an agent\'s reply or a message pasted from someone else. If nothing meets that bar, ask the card.',
    '- thin: an "open" card with id "thin". Quote one part of what they wrote that they stated loosely, guessed at or left out, and ask what they would need to find out to be sure of it. With a paper, you may name the section that part belongs to; never say what the section says.',
    '- draft: an "open" card with id "draft": ask them to write what they want to find out as one question, in one sentence. Give no example and never draft it for them.',
    'versions: one "mcq" card, id "versions", title "Which one is your question?" The first option is their draft, word for word, with "why": "as you wrote it".', 'Add no concept, method, population, measure or comparison they did not write.', 'Each label is one question under 200 characters.', 'With none, ask an "open" card with id "versions" instead: "Read your question once more. Would you change anything?"',
    'Never skip thin, draft or versions', 'A skip is not an answer: ask the card <stage> names. Nothing is graded',
    '# The recap', 'When <stage> is recap, return "card": "none", "ready": true, and put this in "say":\nWhat you know: …\nWhere it thins out: …\nYour question: …\nOn the paper path the first line is "What you took from it: …" instead.',
    'Each line is their words from this exchange, or "not said" ("not written yet" for the question).', '"Your question" is the option they picked on the versions card, or the words they typed there, or their draft when they skipped that card, exactly as written. Never write or improve it yourself.', 'Never say what they did or didn\'t do, and never judge an answer. Add nothing else', '"ready": true only when <stage> is recap']) assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(phrase), phrase);
  for (const gone of ['# Closing', '"closing"', 'before you go', 'So what will you do first?', 'closing card']) assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes(gone), `round 6: no closing card (${gone})`);
  for (const gone of ['<answers>', '# Wrapping up', 'Where do you want to put your attention?', 'What pulls apart', 'Next, you said', 'Prefer "free" and "open"', 'puzzle', 'What puzzles you', 'What draws you', 'id "subject"', 'oriented on']) assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes(gone), `gone (${gone})`);
  for (const gone of ['lookFor', 'Look for', 'prior work', 'suggest a search', 'others may have studied']) assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes(gone), `MATH-31, no search suggested: ${gone}`);
  assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(' "focus": {"title": "<the one question>", "options": [{"label": "<one point, in their terms>", "why": "<optional>"}]},\n "ready": true | false}'), 'the reply shape goes from focus to ready');
  assert.ok(BRAINSTORM_SYSTEM_PROMPT.endsWith('"none" only with "ready": true, and "ready": true only when <stage> is recap.'), 'its rule ends there');
  assert.ok(!/ESCALATE/.test(BRAINSTORM_SYSTEM_PROMPT), 'no ladder, so no moving up');
  assert.ok(!/"map"|\bmap\b/.test(BRAINSTORM_SYSTEM_PROMPT), 'round 3: no map is asked for');
  assert.ok(!fs.existsSync(path.join(__dirname, '../src/main/bart/orient-system-prompt.cjs')), '@orient\'s prompt is gone');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-prompt-'));
  assert.equal(loadSystemPrompt(root, 'brainstorm'), BRAINSTORM_SYSTEM_PROMPT);
  fs.mkdirSync(path.join(root, '.context'));
  fs.writeFileSync(path.join(root, '.context', 'brainstorm-system-prompt.md'), 'Mine.\n');
  assert.deepEqual([loadSystemPrompt(root, 'brainstorm'), loadSystemPrompt(root)], ['Mine.', BART_SYSTEM_PROMPT], '@bart\'s is its own');
});

test('the real runner for @brainstorm: file tools only, no web, its own Codex home and sessions, the opening, the stage, and a card or a fallback', async () => {
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
  assert.match(calls[0].input, /<path>open<\/path>\n<stage>area<\/stage>\n\n<level>You are running as Sol at medium effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nStart from this workspace\.\n<\/question>$/);
  assert.equal(first.lines[0], 'bart> ```json');
  assert.match(first.lines[first.lines.length - 1], /^bart> \*\d+ s\*$/, 'the foot gives the time alone');
  assert.deepEqual(first.meta.trail, []);
  assert.deepEqual([threads.size(), brainstormThreads.size()], [0, 1], 'kept apart from @bart\'s');

  const said = [{ question: '', answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') }];
  const second = await ask('b2', 'picked "Retries"', said);
  assert.match(calls[1].command, / resume /, 'the empty opening is a turn the session was kept under');
  assert.match(calls[1].input, /^<path>open<\/path>\n<stage>know<\/stage>\n\n<level>/, 'a resumed turn is told its path and stage too');
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
  assert.match(claude.input, /<path>topic<\/path>\n<stage>know<\/stage>\n\n<level>You are running as Sonnet at high effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nhello\n<\/question>$/);
});

test('the real runner: an @orient thread left halfway is asked as @brainstorm in a session of its own, at the stage its last card leads to; a line on a library paper is told <path>paper</path> (M-02, M-03, A-02, A-06)', async () => {
  const authFile = path.join(homeDir, 'auth-merged.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const reply = JSON.stringify({ say: '', card: 'questions', questions: { items: [{ id: 'thin', type: 'open', title: 'What would you need to find out?' }] }, ready: false });
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, reply);
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd"}\n');
  };
  const proj = await projects.createProject(ctx, 'Merged Runner');
  const space = await projects.createWorkspace(ctx, proj.id, { name: 'Reading' });
  const pdf = require('node:crypto').randomUUID();
  await ctx.libraryDb.insert({ id: pdf, name: 'Illusion of Learning', project_id: proj.id, tags: ['paper'], type: 'pdf', path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-merged-pdf-')), 'illusion.pdf') });
  await projects.linkToWorkspace(ctx, proj.id, space.id, [pdf]);
  const codexHome = path.join(homeDir, 'codex-home-merged');
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-merged'), codexHome, codexAuthFile: authFile, run, brainstormThreads: createThreads({ idleMs: BRAINSTORM_IDLE_MS }) });
  const ask = (askId, text, turns) => bart.ask(ctx, proj.id, { askId, ref: { kind: 'workspace', workspaceId: space.id }, workspaceId: space.id, text, turns, agent: 'brainstorm' });

  const know = card.cardBody(JSON.stringify({ say: '', card: 'questions', questions: { eyebrow: 'what you know', items: [{ id: 'know', type: 'free', title: 'Write what you know about “metacognition”.' }] }, ready: false })).body;
  await ask('m1', 'people overrate what they learn', [{ question: 'metacognition', answer: know }]);
  assert.match(calls[0].command, /^exec codex exec --color never /, 'nothing was kept for it as @brainstorm: a new session');
  assert.equal(calls[0].env.CODEX_HOME, `${codexHome}-brainstorm`, '@brainstorm\'s own Codex home');
  assert.ok(!fs.existsSync(`${codexHome}-orient`), 'no @orient home is made');
  assert.match(calls[0].input, /<conversation>\n<turn n="1">\n<asked>\nmetacognition\n<\/asked>/);
  assert.match(calls[0].input, /<path>topic<\/path>\n<stage>thin<\/stage>\n\n<level>/);

  await ask('m2', '--opus @[illusion of learning]', []);
  assert.match(calls[1].input, /<path>paper<\/path>\n<stage>took<\/stage>\n\n<level>[^\n]*<\/level>\n\n<question>\n@\[illusion of learning\]\n<\/question>$/);
  assert.match(calls[1].input, /"name": "Illusion of Learning"/, 'the paper is in what it is shown, with its path to open');
});

test('the fake @brainstorm asks each path\'s cards, then recaps what they know, where it thins out and their question, with no search suggested; the first card gives way to thin when their own writing answers it; a skipped draft goes to the recap; Wrap up ends it on any card; it starts again after a recap; "malformed" gets a reply that is not a card (2026-10-05, M-09)', async () => {
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const proj = await projects.createProject(ctx, 'Merged Brainstorm');
  const space = await projects.createWorkspace(ctx, proj.id, { name: 'Agents' });
  const ref = { kind: 'workspace', workspaceId: space.id };
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const retry = await projects.createNote(ctx, proj.id, { name: 'Retry notes', text: 'loops' });
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-merged-downloads-'));
  await ctx.libraryDb.insert({ id: require('node:crypto').randomUUID(), name: 'TutorTrace', project_id: proj.id, tags: ['paper'], type: 'pdf', path: path.join(downloads, 'tutortrace.pdf') });
  const paperRow = (await ctx.libraryDb.list()).find((row) => row.name === 'TutorTrace' && row.project_id === proj.id);
  await projects.linkToWorkspace(ctx, proj.id, space.id, [retry.id, paperRow.id]); // only this workspace's library is read (round 3)
  await projects.writeDoc(ctx, proj.id, ref, 'Notes on agents.\n');
  const progress = [];
  const run = async (answers, start = ['@brainstorm']) => {
    let doc = [...start];
    const cards = [];
    for (let n = 0; n <= answers.length; n += 1) {
      const thread = model.threads(doc).at(-1);
      const turns = thread.turns.filter((turn) => turn.answered).map((turn) => model.turnText(doc, turn));
      const p = model.parseLine(doc[doc.length - 1]);
      const out = await bart.ask(ctx, proj.id, { askId: `z${n}`, ref, workspaceId: space.id, text: p.text, turns, agent: model.agentOf(p) }, { onProgress: (step) => progress.push({ n, ...step }) });
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
  const pick = (n) => (c) => card.answerLine(c, { picks: [card.questionOf(c).options[n].label] });
  const write = (text) => (c) => card.answerLine(c, { text });
  const wrapUp = (text) => (c) => card.withWrap(card.answerLine(c, { text }));
  const ids = (cards) => cards.map((c) => c && (c.card === 'focus' ? 'area' : card.questionOf(c).id));
  const KNOW = 'an agent that lets you correct it', THIN = 'whether it still lets you once it is smarter', DRAFT = 'Why do agents resist correction?', NARROWER = 'Why specifically do agents resist correction?';

  // topic: know, thin, draft, versions, then the recap (A-01).
  const topic = await run([write(KNOW), write(THIN), write(DRAFT), pick(1)], ['@brainstorm corrigibility']);
  assert.deepEqual(ids(topic.cards), ['know', 'thin', 'draft', 'versions', null]);
  assert.deepEqual(topic.cards.slice(0, 3).map((c) => card.questionOf(c).type), ['open', 'open', 'open']);
  assert.equal(card.questionOf(topic.cards[0]).title, 'Write what you know about “corrigibility”, as you would explain it to a colleague.');
  assert.match(card.questionOf(topic.cards[1]).title, new RegExp(`You wrote “${KNOW}”\\. What would you need to find out to be sure of it\\?`), 'thin quotes what they wrote');
  assert.ok(!/section/.test(card.questionOf(topic.cards[1]).title), 'no paper, no section');
  assert.equal(card.questionOf(topic.cards[2]).title, 'Write what you want to find out as one question, in one sentence.');
  assert.deepEqual(card.questionOf(topic.cards[3]).options, [{ label: DRAFT, why: 'as you wrote it' }, { label: NARROWER, why: 'narrower' }], 'their draft word for word, then a version of it');
  assert.deepEqual(topic.recap.lines, [`What you know: ${KNOW}`, `Where it thins out: ${THIN}`, `Your question: ${NARROWER}`]);
  assert.deepEqual(topic.recap.lines.map((line) => card.recapLine(line).label), ['What you know', 'Where it thins out', 'Your question'], 'drawn as three sections (A-05)');
  assert.deepEqual(topic.recap.lookFor, [], 'no Look for line (MATH-31)');
  assert.ok(!topic.doc.some((line) => /lookFor|look ?for/i.test(line)), 'nor any search anywhere in the exchange');

  // paper: took, thin naming a section, draft, versions, then a recap of what they took from it (A-02); the paper is opened first.
  progress.length = 0;
  const paper = await run([write('learners query before trying'), write(THIN), write(DRAFT), pick(0)], ['@brainstorm @[TutorTrace]']);
  assert.deepEqual(ids(paper.cards), ['took', 'thin', 'draft', 'versions', null]);
  assert.equal(card.questionOf(paper.cards[0]).title, 'What did you take from “TutorTrace”?');
  assert.match(card.questionOf(paper.cards[1]).title, /Method section/, 'thin may name a section');
  assert.deepEqual(paper.recap.lines, ['What you took from it: learners query before trying', `Where it thins out: ${THIN}`, `Your question: ${DRAFT}`]);
  assert.equal(card.recapLine(paper.recap.lines[0]).label, 'What you took from it');
  assert.deepEqual(progress.filter((p) => p.activity === 'Reading tutortrace.pdf').map((p) => p.n), [0], 'the paper is opened on the first turn alone');

  // open: the area first, then know on the area picked; never more than five cards (A-04).
  const open = await run([pick(1), write(KNOW), write(THIN), write(DRAFT), pick(0)]);
  assert.deepEqual(ids(open.cards), ['area', 'know', 'thin', 'draft', 'versions', null]);
  assert.equal(card.questionOf(open.cards[0]).title, 'Where do you want to find a question?');
  assert.ok(open.cards[0].say.includes('Agents') && open.cards[0].say.includes('Retry notes'), 'the reading names the workspace and its library');
  assert.ok(open.cards[0].say.split(/(?<=\.)\s+/).length <= 2, 'at most two sentences');
  const picked = card.questionOf(open.cards[0]).options[1].label;
  assert.ok(card.questionOf(open.cards[1]).title.includes(picked), 'what they know about the area picked');
  assert.deepEqual(open.recap.lines, [`What you know: ${KNOW}`, `Where it thins out: ${THIN}`, `Your question: ${DRAFT}`]);

  // Their own writing already says what they know: thin first, quoting their sentence exactly (A-03), and that is what they know.
  const OWN = 'Corrigibility is when an agent lets you correct it without fighting back.';
  await projects.writeDoc(ctx, proj.id, ref, `Notes on agents.\n${OWN} More later\n@bart what is corrigibility?\nbart> Corrigibility is a property.\n`);
  const given = await run([write(THIN), write(DRAFT), () => card.SKIPPED], ['@brainstorm corrigibility']);
  assert.deepEqual(ids(given.cards), ['thin', 'draft', 'versions', null], 'the know card gave way to thin');
  assert.equal(given.cards[0].say, `You wrote: "${OWN}"`, 'their full sentence, copied exactly; never the agent\'s');
  assert.deepEqual(given.recap.lines, [`What you know: ${OWN}`, `Where it thins out: ${THIN}`, `Your question: ${DRAFT}`], 'versions skipped: their draft');
  await projects.writeDoc(ctx, proj.id, ref, 'Notes on agents.\n');

  // A skipped draft goes straight to the recap: no versions card.
  const undrafted = await run([write(KNOW), write(THIN), () => card.SKIPPED], ['@brainstorm corrigibility']);
  assert.deepEqual(ids(undrafted.cards), ['know', 'thin', 'draft', null]);
  assert.deepEqual(undrafted.recap.lines, [`What you know: ${KNOW}`, `Where it thins out: ${THIN}`, 'Your question: not written yet']);
  const skippedAll = await run([() => card.SKIPPED, () => card.SKIPPED, () => card.SKIPPED], ['@brainstorm corrigibility']);
  assert.deepEqual(ids(skippedAll.cards), ['know', 'thin', 'draft', null], 'skips move on');
  assert.deepEqual(skippedAll.recap.lines, ['What you know: not said', 'Where it thins out: not said', 'Your question: not written yet']);
  assert.ok(card.questionOf(skippedAll.cards[1]).title.startsWith('Which part of this'), 'with nothing written, thin quotes nothing');

  // Wrap up on any card: the recap at once, with what was given.
  const early = await run([wrapUp(KNOW)], ['@brainstorm corrigibility']);
  assert.deepEqual([ids(early.cards), early.recap.lines], [['know', null], [`What you know: ${KNOW}`, 'Where it thins out: not said', 'Your question: not written yet']]);
  const wrappedDraft = await run([write(KNOW), write(THIN), wrapUp(DRAFT)], ['@brainstorm corrigibility']);
  assert.deepEqual([ids(wrappedDraft.cards), wrappedDraft.recap.lines[2]], [['know', 'thin', 'draft', null], `Your question: ${DRAFT}`], 'a draft given with Wrap up is their question');

  // After a recap, the next exchange starts again and builds on nothing from the earlier one.
  const again = await run([write('something new')], [...topic.doc, '@brainstorm']);
  assert.deepEqual(ids(again.cards), ['area', 'know']);
  assert.ok(!card.questionOf(again.cards[1]).title.includes('corrigibility'));

  // An older document's cards: round 7's closing card answered gets the recap in the new form; an @orient thread goes on.
  const closing = card.cardBody(JSON.stringify({ say: '', card: 'questions', questions: { eyebrow: 'before you go', items: [{ id: 'closing', type: 'open', title: 'So what will you do first?' }] }, ready: false })).body;
  const older = await bart.ask(ctx, proj.id, { askId: 'zold', ref, workspaceId: space.id, text: 'read the logs', turns: [{ question: '', answer: card.cardBody(JSON.stringify(FOCUS)).body }, { question: 'picked "Retries"', answer: closing }], agent: 'brainstorm' });
  assert.deepEqual(card.recapParts(answerText(older.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n'))).lines, ['What you know: not said', 'Where it thins out: not said', 'Your question: not written yet']);
  const orient = await run([write(THIN), write(DRAFT)], ['@orient metacognition', ...topic.doc.slice(1, topic.doc.indexOf(`@brainstorm ${card.answerLine(topic.cards[0], { text: KNOW })}`)), `@brainstorm ${KNOW}`]);
  assert.deepEqual(ids(orient.cards), ['thin', 'draft', 'versions'], 'an @orient thread left at its know card goes on as @brainstorm');

  const feet = topic.doc.filter((line) => /^bart> \*[^*]+\*$/.test(line));
  assert.ok(feet.length >= 5 && feet.every((line) => /^bart> \*\d+ s\*$/.test(line)), 'every card\'s foot gives the time alone');
  const bad = await bart.ask(ctx, proj.id, { askId: 'zm', ref, workspaceId: space.id, text: 'malformed please', agent: 'brainstorm' });
  assert.equal(bad.lines[0], 'bart> FAKE REPLY that is not a card: {"say": "cut off');
  assert.equal(card.cardOfAnswer(bad.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n')), null, 'drawn as plain answer lines');
});

const fenced = (value) => ['```json', JSON.stringify(value), '```'].join('\n');
const opened = (id) => fenced({ say: '', card: 'questions', questions: { items: [{ id, type: 'open', title: `Card ${id}?` }] }, ready: false });
const ENTRIES = [
  { name: 'TutorTrace', type: 'pdf', tags: [] },
  { name: 'Illusion of Learning', type: 'website', tags: ['paper'] },
  { name: 'Retry notes', type: 'md', tags: ['note'] },
  { name: 'Agents', type: 'md', tags: ['note'] },
];
const brainstormPlan = (text, turns = [], entries = ENTRIES) => turnPlan({ agent: 'brainstorm', text, turns, entries }, DEFAULTS);

test('@brainstorm\'s path is decided on an exchange\'s first turn: a library paper mentioned on the line, words, or nothing; a mentioned note is words; it carries on, and after a recap the next line opens again (M-03)', () => {
  const plan = brainstormPlan, at = (now) => [now.path, now.stage, now.extra];
  assert.deepEqual(BRAINSTORM_PATHS, { paper: ['took', 'thin', 'draft', 'versions'], topic: ['know', 'thin', 'draft', 'versions'], open: ['area', 'know', 'thin', 'draft', 'versions'] });
  assert.deepEqual(at(plan('@[TutorTrace]')), ['paper', 'took', '<path>paper</path>\n<stage>took</stage>'], 'a pdf of the library');
  assert.equal(plan('@[TutorTrace]').paper.name, 'TutorTrace');
  assert.equal(plan('@[TutorTrace] the taxonomy').path, 'paper', 'with words beside it');
  assert.equal(plan('@[tutortrace]').path, 'paper', 'named in any case, as a mention finds it');
  assert.equal(plan('@[Illusion of Learning] what it claims').path, 'paper', 'an item tagged "paper"');
  assert.equal(plan('why runs loop, see @[Retry notes] and @[TutorTrace]').path, 'paper', 'any paper the line mentions');
  assert.deepEqual(at(plan('@[Retry notes]')), ['topic', 'know', '<path>topic</path>\n<stage>know</stage>'], 'a mentioned note is words, not a paper');
  assert.equal(plan('@[Agents](ws:w1)').path, 'topic', 'a workspace mention is not a paper');
  assert.equal(plan('@[Not in the library]').path, 'topic', 'a mention that leads nowhere');
  assert.equal(plan('@[TutorTrace]', [], []).path, 'topic', 'read against the library the turn is shown');
  assert.deepEqual(at(plan('corrigibility')), ['topic', 'know', '<path>topic</path>\n<stage>know</stage>']);
  assert.deepEqual([...at(plan('')), plan('').asked], ['open', 'area', '<path>open</path>\n<stage>area</stage>', 'Start from this workspace.']);
  assert.deepEqual([plan('--opus --max').path, plan('--sonnet @[TutorTrace]').path], ['open', 'paper'], 'flags are not words');
  // Carried on: a later turn reads the exchange's opening, not what it says itself.
  const took = { question: '@[TutorTrace]', answer: opened('took') };
  assert.deepEqual(at(plan('learners query before trying', [took])), ['paper', 'thin', '<path>paper</path>\n<stage>thin</stage>']);
  const know = { question: '--sonnet corrigibility', answer: opened('know') };
  assert.equal(plan('@[TutorTrace] is all I know', [know]).path, 'topic', 'a paper named in an answer changes nothing');
  assert.equal(plan('it lets you correct it', [{ question: '', answer: card.cardBody(JSON.stringify(FOCUS)).body }]).path, 'open');
  // After a recap, or a reply that was not a card, the next line opens again.
  const recapped = [know, { question: 'x', answer: 'What you know: x\nWhere it thins out: not said\nYour question: not written yet' }];
  assert.deepEqual(at(plan('@[TutorTrace]', recapped)), ['paper', 'took', '<path>paper</path>\n<stage>took</stage>']);
  assert.deepEqual([plan('', recapped).path, plan('', recapped).stage, plan('', recapped).asked], ['open', 'area', 'Start from this workspace.'], 'Brainstorm again with nothing typed: the area card');
  assert.deepEqual(at(plan('', [know, { question: 'y', answer: 'I would rather just talk.' }])).slice(0, 2), ['open', 'area']);
  assert.deepEqual(plan('', recapped).shown.map((turn) => turn.question), ['--sonnet corrigibility', 'x']);
  assert.equal(brainstormPlan('').shown.length, 0);
});

test('@brainstorm\'s next stage is read from the last card\'s id, whatever the path; older documents\' ids lead on too; a focus card is the area\'s, and an id no path knows goes on from the stage it was asked as (M-04)', () => {
  const after = { area: 'know', subject: 'know', know: 'thin', took: 'thin', thin: 'draft', puzzle: 'draft', interest: 'draft', draft: 'versions', versions: 'recap', closing: 'recap' };
  for (const opening of ['', 'corrigibility', '@[TutorTrace]']) {
    for (const [id, stage] of Object.entries(after)) {
      const now = brainstormPlan('an answer', [{ question: opening, answer: opened(id) }]);
      assert.deepEqual([now.stage, now.close], [stage, stage === 'recap' ? 'recap' : null], `"${opening}": ${id} → ${stage}`);
    }
    assert.equal(brainstormPlan('picked "Retries"', [{ question: opening, answer: card.cardBody(JSON.stringify(FOCUS)).body }]).stage, 'know', `"${opening}": a focus card is the area's`);
  }
  // Each path in full.
  const walk = (opening, stages) => {
    const turns = [];
    const seen = [brainstormPlan(opening).stage];
    for (const stage of stages) {
      turns.push({ question: turns.length ? 'an answer' : opening, answer: stage === 'area' ? card.cardBody(JSON.stringify(FOCUS)).body : opened(stage) });
      seen.push(brainstormPlan('an answer', turns).stage);
    }
    return seen;
  };
  assert.deepEqual(walk('corrigibility', ['know', 'thin', 'draft', 'versions']), ['know', 'thin', 'draft', 'versions', 'recap'], 'topic (A-01)');
  assert.deepEqual(walk('@[TutorTrace]', ['took', 'thin', 'draft', 'versions']), ['took', 'thin', 'draft', 'versions', 'recap'], 'paper (A-02)');
  assert.deepEqual(walk('', ['area', 'know', 'thin', 'draft', 'versions']), ['area', 'know', 'thin', 'draft', 'versions', 'recap'], 'open (A-04)');
  // Older documents: round 7's area, puzzle, draft and versions; @orient's know, thin and interest, and its subject card.
  assert.deepEqual(walk('', ['area', 'puzzle', 'draft', 'versions']), ['area', 'know', 'draft', 'versions', 'recap'], 'a round 7 thread');
  assert.deepEqual(walk('metacognition', ['know', 'thin', 'interest']), ['know', 'thin', 'draft', 'draft'], 'an @orient thread');
  assert.deepEqual(walk('', ['subject', 'know']), ['area', 'know', 'thin'], 'an @orient thread that asked for a subject');
  // An id no path knows: the stage it was asked as.
  assert.equal(brainstormPlan('x', [{ question: 'corrigibility', answer: opened('gap') }]).stage, 'thin', 'asked as know');
  assert.equal(brainstormPlan('x', [{ question: '', answer: opened('where') }]).stage, 'know', 'asked as area');
  assert.equal(brainstormPlan('x', [{ question: 'corrigibility', answer: opened('know') }, { question: 'y', answer: opened('next-2') }]).stage, 'draft', 'asked as thin');
  assert.equal(brainstormPlan('Why?', [{ question: 'corrigibility', answer: opened('thin') }, { question: 'y', answer: opened('q') }]).stage, 'versions', 'asked as draft, and answered');
  assert.equal(brainstormPlan(card.SKIPPED, [{ question: 'corrigibility', answer: opened('thin') }, { question: 'y', answer: opened('q') }]).stage, 'recap', 'asked as draft, and skipped');
  assert.equal(brainstormPlan('--sonnet Why do agents resist?', [{ question: 'x', answer: opened('know') }]).asked, 'Why do agents resist?', 'flags are not part of the answer');
});

test('@brainstorm\'s first card may give way to thin, and only the first: the code goes on from whichever was asked; a person\'s skip moves on (M-05)', () => {
  // The agent asked thin in place of know or took: draft next, on every path.
  assert.equal(brainstormPlan('it might stop once it is smarter', [{ question: 'corrigibility', answer: opened('thin') }]).stage, 'draft');
  assert.equal(brainstormPlan('the taxonomy', [{ question: '@[TutorTrace]', answer: opened('thin') }]).stage, 'draft');
  assert.equal(brainstormPlan('x', [{ question: '', answer: card.cardBody(JSON.stringify(FOCUS)).body }, { question: 'picked "Retries"', answer: opened('thin') }]).stage, 'draft', 'after the area too');
  const given = [{ question: 'corrigibility', answer: opened('thin') }, { question: 'x', answer: opened('draft') }];
  assert.deepEqual([brainstormPlan('Why?', given).stage, brainstormPlan('picked "Why?"', [...given, { question: 'Why?', answer: opened('versions') }]).stage], ['versions', 'recap'], 'then draft, versions and the recap: four cards');
  // The person skipped a card: the next one comes.
  for (const [opening, first] of [['corrigibility', 'know'], ['@[TutorTrace]', 'took']]) {
    assert.equal(brainstormPlan(card.SKIPPED, [{ question: opening, answer: opened(first) }]).stage, 'thin', `${first} skipped`);
    assert.equal(brainstormPlan('--sonnet (skipped)', [{ question: opening, answer: opened(first) }, { question: card.SKIPPED, answer: opened('thin') }]).stage, 'draft', 'thin skipped');
  }
  assert.equal(brainstormPlan(card.SKIPPED, [{ question: '', answer: card.cardBody(JSON.stringify(FOCUS)).body }]).stage, 'know', 'the area skipped');
});

test('@brainstorm: a skipped draft goes to the recap, an answered one to versions; five cards since the last recap, skips included, get the recap; Wrap up gets it on any card of any path', () => {
  const draft = [{ question: 'corrigibility', answer: opened('know') }, { question: 'a', answer: opened('thin') }, { question: 'b', answer: opened('draft') }];
  for (const text of [card.SKIPPED, '--opus (skipped)', '(wrap up)']) assert.deepEqual([brainstormPlan(text, draft).stage, brainstormPlan(text, draft).close], ['recap', 'recap'], `draft: ${text}`);
  assert.equal(brainstormPlan('Why do agents resist correction?', draft).stage, 'versions');
  assert.equal(brainstormPlan('Why?', [{ ...draft[0], question: 'corrigibility' }, { ...draft[1], question: card.SKIPPED }, draft[2]]).stage, 'versions', 'an earlier skip does not matter: the draft was answered');
  // At most five cards.
  assert.equal(MAX_BRAINSTORM_CARDS, 5);
  const stuck = (n) => Array.from({ length: n }, (_, k) => ({ question: k ? card.SKIPPED : 'corrigibility', answer: opened('know') }));
  assert.equal(brainstormPlan(card.SKIPPED, stuck(4)).stage, 'thin', 'four cards: the next one');
  assert.deepEqual([brainstormPlan(card.SKIPPED, stuck(5)).stage, brainstormPlan('words', stuck(5)).stage], ['recap', 'recap'], 'five cards, skipped or not: the recap');
  const open = [{ question: '', answer: card.cardBody(JSON.stringify(FOCUS)).body }, ...['know', 'thin', 'draft'].map((id) => ({ question: 'x', answer: opened(id) }))];
  assert.equal(brainstormPlan('Why?', open).stage, 'versions', 'the open path\'s fifth card is versions');
  assert.equal(brainstormPlan('picked "Why?"', [...open, { question: 'Why?', answer: opened('versions') }]).stage, 'recap');
  const recapped = [...open, { question: 'Why?', answer: opened('versions') }, { question: 'z', answer: 'What you know: z' }];
  assert.deepEqual([brainstormPlan('', recapped).stage, brainstormPlan('a new topic', recapped).stage], ['area', 'know'], 'the count starts again after a recap');
  // Wrap up, alone or after an answer, on any card of any path.
  for (const [opening, stages] of [['corrigibility', BRAINSTORM_PATHS.topic], ['@[TutorTrace]', BRAINSTORM_PATHS.paper], ['', BRAINSTORM_PATHS.open]]) {
    for (let n = 0; n <= stages.length; n += 1) {
      const turns = stages.slice(0, n).map((id, k) => ({ question: k ? 'an answer' : opening, answer: id === 'area' ? card.cardBody(JSON.stringify(FOCUS)).body : opened(id) }));
      for (const text of ['(wrap up)', 'it loops; (wrap up)', 'picked "Retries"; note: soon; (wrap up)', '--sonnet (wrap up)', '  (wrap up) ']) {
        const now = brainstormPlan(text, turns);
        assert.deepEqual([now.stage, now.close], ['recap', 'recap'], `"${opening}", ${n} cards: ${text}`);
      }
    }
  }
  assert.equal(brainstormPlan('I will (wrap up) later', [draft[0]]).stage, 'thin', 'words that only mention it are an answer');
  assert.equal(brainstormPlan('Why?; (wrap up)', draft).asked, 'Why?; (wrap up)', 'the agent is sent the answer and the wrap up as written');
  // The others are as they were.
  assert.equal(turnPlan({ agent: 'bart', text: 'q', turns: draft, entries: ENTRIES }, DEFAULTS).extra, '', '@bart is unchanged');
  assert.equal(turnPlan({ agent: 'discover', text: '(wrap up)', turns: [] }, DEFAULTS).close, undefined, '@discover has no wrap up');
  assert.deepEqual(AGENTS, ['bart', 'brainstorm', 'discover'], 'no @orient');
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

test('a card no longer keeps a search (MATH31-02): readCard drops lookFor from a reply, and an older document\'s card that holds one reads back without it', async () => {
  const look = 'how others have handled “it stops when the lock frees”';
  const focus = card.readCard({ ...FOCUS, lookFor: look });
  assert.ok(focus && !('lookFor' in focus), 'a focus card is kept, its search is not');
  const free = card.readCard({ say: '', card: 'questions', questions: { items: [{ id: 'next-1', type: 'free', title: 'What?' }] }, lookFor: look });
  assert.deepEqual(free, { say: '', card: 'questions', questions: { items: [{ id: 'next-1', type: 'free', title: 'What?' }] }, ready: false });
  assert.equal(card.readCard({ card: 'none', ready: true, say: 'Your question: a', lookFor: look }).lookFor, undefined, 'nor does a recap');
  assert.ok(!card.cardBody(JSON.stringify({ ...FOCUS, lookFor: look })).body.includes('lookFor'), 'a reply is written into the document without it');
  // As a document saved before MATH-31 holds it: the fenced JSON with lookFor in it.
  const older = ['@brainstorm', 'bart> ```json', ...JSON.stringify({ ...FOCUS, lookFor: look }, null, 2).split('\n').map((line) => `bart> ${line}`), 'bart> ```', 'bart> *Sonnet · high · 3 s*'];
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const read = card.cardOfAnswer(model.turnText(older, model.threads(older)[0].turns[0]).answer);
  assert.deepEqual(read, card.readCard(FOCUS), 'it still reads as the card, without its search');
  assert.equal(typeof card.LOOK_FOR_CHARS, 'number', 'kept for older recaps (recapParts)');
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
  assert.deepEqual(card.recapLine('Your question: Why do retries loop when the lock frees?'), { label: 'Your question', text: 'Why do retries loop when the lock frees?' }, 'round 7');
  assert.deepEqual(card.recapLine('your question: not written yet'), { label: 'Your question', text: 'not written yet' });
  assert.deepEqual(card.recapLine('What puzzles you: it stops when the lock frees'), { label: 'What puzzles you', text: 'it stops when the lock frees' });
  assert.deepEqual(card.recapLine('Look for: retries'), { label: 'Look for', text: 'retries' }, 'an older recap\'s search is a section, no longer a button (MATH31-06)');
  assert.ok(card.RECAP_LABELS.includes('Look for'));
  assert.equal(card.recapLine('Where I am: elsewhere'), null);
});

test('the fake @brainstorm with nothing to go on: says so and asks the area card as an open question', async () => {
  const bare = await projects.createProject(ctx, 'Bare');
  const space = await projects.createWorkspace(ctx, bare.id, { name: 'Empty' });
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const out = await bart.ask(ctx, bare.id, { askId: 'e1', ref: { kind: 'workspace', workspaceId: space.id }, workspaceId: space.id, text: '', turns: [], agent: 'brainstorm' });
  const shown = card.cardOfAnswer(answerText(out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n')));
  assert.deepEqual([shown.map, card.questionOf(shown).type, card.questionOf(shown).id, card.questionOf(shown).title], [undefined, 'open', 'area', 'Where do you want to find a question?'], 'the area card, asked in their own words');
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

test('strip: an @orient line is @brainstorm\'s (M-02): its cards and recap stay for @brainstorm, as its own threads do; other agents\' replies go', () => {
  const doc = [
    'My line.',
    '@bart why?',
    'bart> because',
    '@orient metacognition',
    'bart> ```json',
    'bart> {"card": "questions"}',
    'bart> ```',
    '@brainstorm people overrate what they learn',
    'bart> What you know: people overrate what they learn',
    'Between.',
    '@brainstorm',
    'bart> ```json',
    'bart> {"card": "focus"}',
    'bart> ```',
    '@brainstorm picked "x"',
    'bart~> now',
    '@discover what to read',
    'bart> ## Start here',
  ].join('\n');
  assert.equal(stripAgentReplies(doc, 'brainstorm'), [
    'My line.', '@bart why?', OMITTED,
    '@orient metacognition', 'bart> ```json', 'bart> {"card": "questions"}', 'bart> ```', '@brainstorm people overrate what they learn', 'bart> What you know: people overrate what they learn',
    'Between.', '@brainstorm', 'bart> ```json', 'bart> {"card": "focus"}', 'bart> ```', '@brainstorm picked "x"', 'bart~> now',
    '@discover what to read', OMITTED,
  ].join('\n'));
  assert.equal(stripAgentReplies(doc), stripAgentReplies(doc, 'brainstorm'), '@brainstorm by default, as before');
});

test('strip: what a mention placed under a question stays with it, so the replies after it are still that question\'s; under a reply left out it goes too', () => {
  const doc = [
    '@brainstorm @[Paper] the taxonomy',
    '',
    '<file name="Paper" type="pdf" path="/x/paper.pdf" />',
    '',
    'bart> ```json',
    'bart> {"card": "questions"}',
    'bart> ```',
    '@bart see @[Note]?',
    '',
    '<file name="Note" type="md">',
    'inside',
    '@bart inner?',
    'bart> inner answer',
    '</file>',
    '',
    'bart> because @[Other]',
    '',
    '<file name="Other" type="pdf" contains="summary">',
    'a summary',
    '</file>',
    '',
    'bart> more',
    'Mine again.',
    'With @[Plain]',
    '',
    '<file name="Plain" type="md">',
    'text @[Deeper]',
    '',
    '<file name="Deeper" type="pdf" contains="summary">',
    'deeper summary',
    '</file>',
    '</file>',
    'bart> orphan reply under nothing',
  ];
  const bartPart = ['@bart see @[Note]?', '', '<file name="Note" type="md">', 'inside', '@bart inner?', OMITTED, '</file>', '', OMITTED, 'Mine again.'];
  const plainPart = ['With @[Plain]', '', '<file name="Plain" type="md">', 'text @[Deeper]', '', '<file name="Deeper" type="pdf" contains="summary">', 'deeper summary', '</file>', '</file>', 'bart> orphan reply under nothing'];
  assert.equal(stripAgentReplies(doc.join('\n'), 'brainstorm'), [...doc.slice(0, 7), ...bartPart, ...plainPart].join('\n'), 'its own card stays, under the mention');
  assert.equal(stripAgentReplies(doc.join('\n'), 'discover'), ['@brainstorm @[Paper] the taxonomy', '', doc[2], '', OMITTED, ...bartPart, ...plainPart].join('\n'), 'another agent\'s card goes, the mention stays with its line');
});

test('@brainstorm\'s context keeps an older @orient thread whole, and on the paper path the mentioned paper\'s folder is readable (M-02, A-02, A-06)', async () => {
  const proj = await projects.createProject(ctx, 'Scoped Orient');
  const here = await projects.createWorkspace(ctx, proj.id, { name: 'Here' });
  const there = await projects.createWorkspace(ctx, proj.id, { name: 'There' });
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-orient-downloads-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-orient-elsewhere-'));
  const add = async (name, file, space) => {
    const id = require('node:crypto').randomUUID();
    await ctx.libraryDb.insert({ id, name, project_id: proj.id, tags: ['paper'], type: 'pdf', path: file });
    if (space) await projects.linkToWorkspace(ctx, proj.id, space.id, [id]);
    return id;
  };
  await add('TutorTrace', path.join(downloads, 'tutortrace.pdf'));
  await add('Far paper', path.join(elsewhere, 'far.pdf'), there);
  const know = replyLines(card.cardBody(JSON.stringify({ say: '', card: 'questions', questions: { items: [{ id: 'know', type: 'open', title: 'The know card?' }] }, ready: false })).body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false });
  const text = ['Mine.', '@orient @[TutorTrace] the taxonomy', ...know, '@orient learners query before trying', 'bart> What you know: learners query before trying', '', '@bart why?', 'bart> because', '@brainstorm @[TutorTrace]', 'bart~> s1', ''].join('\n');
  await projects.writeDoc(ctx, proj.id, { kind: 'workspace', workspaceId: here.id }, text);
  const c = await buildContext(ctx, proj.id, { ref: { kind: 'workspace', workspaceId: here.id }, workspaceId: here.id, askId: 's1', agent: 'brainstorm' });
  assert.match(c.documents, /@orient @\[TutorTrace\] the taxonomy\n\n<file name="TutorTrace"[^\n]*\/>\n\nbart> ```json/, 'the @orient line, what it mentions, and its card');
  assert.match(c.documents, /bart> What you know: learners query before trying/, 'and its recap');
  assert.match(c.documents, /@bart why\?\n\[agent reply omitted\]\n@brainstorm @\[TutorTrace\]\n<<< this is the question being asked now >>>/);
  assert.deepEqual(c.entries.map((entry) => [entry.name, entry.mentioned]), [['TutorTrace', true]], 'what it mentions; not another workspace\'s paper');
  assert.deepEqual(c.dirs, [proj.directory, ctx.dataRoot].filter(Boolean).concat(downloads), 'the mentioned paper\'s folder is readable, the other workspace\'s is not');
  assert.equal(turnPlan({ agent: 'brainstorm', text: '@[TutorTrace]', turns: [], entries: c.entries }, DEFAULTS).path, 'paper', 'read against the catalog the turn is built');
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

test('ask-bart takes the agent, and a Brainstorm is an agent of its workspace like Bart; @orient is no agent of its own any more (M-01)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/ipc.cjs'), 'utf8');
  assert.match(src, /\['bart', 'brainstorm', 'discover'\]\.includes\(agent\)/);
  projects.agentStarted(ctx, { id: 'bs-agent', kind: 'brainstorm', projectId: project.id, workspaceId: workspace.id });
  projects.agentFinished(ctx, 'bs-agent');
  assert.throws(() => projects.agentStarted(ctx, { id: 'or-agent', kind: 'orient', projectId: project.id, workspaceId: workspace.id }));
  assert.throws(() => projects.agentStarted(ctx, { id: 'bs-nope', kind: 'chat', projectId: project.id }));
  // Its sessions file is left where it is and never read; its Codex home is no longer made.
  const index = fs.readFileSync(path.join(__dirname, '../src/main/index.cjs'), 'utf8');
  assert.ok(!/orientThreads|orientCodexHome|ORIENT_IDLE_MS|codex-home-orient/.test(index));
  assert.ok(!/createThreads\([^)]*orient-threads\.json/.test(index));
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

test('a models file left as 2026-09-30 wrote it: @discover\'s untouched step becomes the three levels, @brainstorm\'s untouched block the new one; a step of the person\'s own is the standard level, and a brainstorm step of their own stays and is read (2026-10-06)', () => {
  for (const withBase of [true, false]) {
    const shipped = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS.at(-2)));
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
    assert.deepEqual(file.brainstorm, DEFAULT_BRAINSTORM, `the brainstorm block is the new one, ${how}`);
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
    assert.deepEqual([readDiscover('why', theirs).steps[0].name, readDiscover('why', theirs).steps[0].effort, readBrainstorm('', theirs).steps[0].name, readBrainstorm('', theirs).steps[0].effort], ['Fable', 'xhigh', 'Opus', 'max'], 'and it is read');
  }
});

test('a models file left as 2026-10-02 wrote it (no brainstorm block) gets the new one; values the person edited stay, a brainstorm block of their own too (2026-10-06)', () => {
  for (const withBase of [true, false]) {
    const shipped = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS.at(-1)));
    assert.deepEqual([!!shipped.brainstorm, !!shipped.discover.providers.anthropic.deep], [false, true], 'the 10-02 shape');
    const write = (value) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-1006-'));
      fs.writeFileSync(path.join(root, MODELS_FILE), JSON.stringify(value));
      if (withBase) { fs.mkdirSync(path.join(root, '.defaults')); fs.writeFileSync(path.join(root, '.defaults', MODELS_FILE), JSON.stringify(shipped)); }
      return root;
    };
    const how = withBase ? 'with a base' : 'without one';
    const untouched = write(shipped);
    const models = loadModels(untouched);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(untouched, MODELS_FILE), 'utf8')), DEFAULT_MODELS, `the file is today's defaults, ${how}`);
    assert.deepEqual(models.brainstorm.providers, DEFAULT_BRAINSTORM.providers);

    const mine = JSON.parse(JSON.stringify(shipped));
    mine.providers.anthropic.ladder = [{ model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }];
    mine.discover.providers.openai.deep = { model: 'astra', effort: 'xhigh' };
    mine.build.providers.anthropic.default = { model: 'fable', effort: 'max' };
    mine.myOwnKey = { kept: true };
    const edited = write(mine);
    const theirs = loadModels(edited);
    const kept = JSON.parse(fs.readFileSync(path.join(edited, MODELS_FILE), 'utf8'));
    assert.deepEqual(kept.brainstorm, DEFAULT_BRAINSTORM, `the block is added, ${how}`);
    assert.deepEqual([kept.providers.anthropic.ladder, kept.discover.providers.openai.deep, kept.build.providers.anthropic.default, kept.myOwnKey], [mine.providers.anthropic.ladder, { model: 'astra', effort: 'xhigh' }, { model: 'fable', effort: 'max' }, { kept: true }], `what they edited stays, ${how}`);
    assert.deepEqual(readQuestion('why?', theirs).steps.map((s) => `${s.name} ${s.effort}`), ['Opus high', 'Fable xhigh']);

    // A brainstorm block a person kept from 2026-09-30 (the 10-02 merge left it, unread) stays, and is read now.
    const theirsBlock = JSON.parse(JSON.stringify(shipped));
    theirsBlock.brainstorm = { about: 'Mine.', providers: { anthropic: { model: 'fable', effort: 'high' }, openai: { model: 'sol', effort: 'medium' } } };
    const old = write(theirsBlock);
    const read = loadModels(old);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(old, MODELS_FILE), 'utf8')).brainstorm, theirsBlock.brainstorm, `their block is not replaced, ${how}`);
    assert.deepEqual([readBrainstorm('', read).steps[0].name, readBrainstorm('', read).steps[0].effort], ['Fable', 'high']);
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
  const rejected = JSON.stringify({ card: 'focus', focus: { options: [{ label: 'One' }] } });
  assert.equal(replyBody('discover', `${rejected}\nCorrected: ${JSON.stringify(FOCUS)}`), card.cardBody(JSON.stringify(FOCUS)).body, 'a card corrected after a rejected one is the card');
  const quotes = `## Start here\n\nWhy: it asks ${JSON.stringify(FOCUS)} of its readers.`;
  assert.equal(replyBody('discover', quotes), quotes, 'a guide that holds a card in its words stays a guide');
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

test('@discover on a named paper (2026-10-04): no card, the paper opened whole first, "## This paper" before the trace from it, its sections in pairs of Read and Why', () => {
  for (const phrase of ['Skip it too when <question> names a paper: a library item mentioned on the line', 'a title, a DOI or an arXiv id', 'Words beside it say which part of the paper the person cares about', 'With no words, the problem is the one nearest the marked line, read in their setting',
    '# A named paper', 'When <question> names a paper, open all of it before anything else: the library file from its path, else an open-access copy', 'up to four, best first, not in the paper\'s order', 'Never the abstract, and the introduction only when nothing else serves', 'This paper is the only starting point', 'backward through what it cites in the sections you chose, forward through what cites it', 'A library paper the paper tools do not know is still the guide\'s first entry, from the file you opened',
    '"This paper" holds only the paper <question> names', 'When there is a "This paper" group, there is no "Start here"', '"Classics" holds papers the named paper cites in the sections you chose', '"Recent" holds papers that cite it and bear on the same part', 'The named paper counts as one of the sources <mode> allows',
    'The "This paper" entry is the title line, then, for each section you chose, best first, a pair of lines', '**Why:** as for any entry.', 'One Read link per pair. A Try line may follow the last pair', 'If only the abstract could be reached, the entry is the title line, "**Read:** abstract only" and one Why, and the trace goes on',
    'A follow-up that names a paper gets that paper\'s guide']) assert.ok(DISCOVER_SYSTEM_PROMPT.includes(phrase), phrase);
  const at = (phrase) => DISCOVER_SYSTEM_PROMPT.indexOf(phrase);
  assert.ok(at('# First, refine') < at('Skip it too when <question> names a paper') && at('Skip it too when') < at('Otherwise ask one card'), 'P-01 in "First, refine"');
  assert.ok(at('# Then, trace') < at('# A named paper') && at('If none qualifies, say nothing about it') < at('# A named paper') && at('# A named paper') < at('# What is real'), 'P-02: its own section, after the trace');
  assert.ok(at('"## This paper", "## Start here", "## Classics"') > at('# The guide'), 'P-03: "This paper" is the first group');
  assert.ok(at('"Classics" holds only papers that two or more starting points cite') < at('When there is a "This paper" group'), 'the rules for a problem stay, those for a paper follow them');
  assert.ok(at('The Try line comes after Why') < at('The "This paper" entry') && at('The "This paper" entry') < at('For an essay, the title line'));
});

test('replyBody keeps a guide that starts at "## This paper", and drops what was written before it', () => {
  const named = '## This paper\n\n**[Retries](/Users/h/Retries.pdf)** · A. Author · 2024\n**Read:** [5 Findings](/Users/h/Retries.pdf#find=We%20found&to=In%20this%20section)\n**Why:** a measurement.\n**Read:** [3 Method](/Users/h/Retries.pdf#find=We%20built)\n**Why:** a method.\n**Try:** [ada/retries](https://github.com/ada/retries)\n\n## Classics\n\nx';
  assert.equal(replyBody('discover', named), named);
  assert.equal(replyBody('discover', `Opened the paper; tracing now.\n\n${named}`), named, 'a status line before it goes');
});

test('the fake @discover on a mentioned library paper: no card, "## This paper" with two sections, each its own Read and Why into the library copy, then Classics, Recent and Essays; words beside it or a follow-up the same (P-05)', async () => {
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const lib = await projects.createProject(ctx, 'Named Paper');
  const space = await projects.createWorkspace(ctx, lib.id, { name: 'Reading' });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-named-')), 'Retries Considered.pdf');
  await ctx.libraryDb.insert({ id: require('node:crypto').randomUUID(), name: 'Retries Considered', project_id: lib.id, tags: ['paper'], type: 'pdf', path: file });
  const ref = { kind: 'workspace', workspaceId: space.id };
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const { guideSections, splitTarget } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/stage.js')).href);
  const { guideTitle } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/guide.js')).href);
  const run = async (doc, askId) => {
    const [thread] = model.threads(doc);
    const turns = thread.turns.filter((turn) => turn.answered).map((turn) => model.turnText(doc, turn));
    const out = await bart.ask(ctx, lib.id, { askId, ref, workspaceId: space.id, text: model.parseLine(doc[doc.length - 1]).text, turns, agent: 'discover' });
    const next = [...doc, ...out.lines];
    const [again] = model.threads(next);
    return { doc: next, card: card.cardOfAnswer(model.turnText(next, again.turns[again.turns.length - 1]).answer), lines: out.lines, text: out.lines.map((line) => line.replace(/^bart> ?/, '')) };
  };
  const named = await run(['@discover @[Retries Considered]'], 'np1');
  assert.equal(named.card, null, 'A-01: no card');
  assert.equal(named.text[0], '## This paper', 'the guide opens with the paper');
  assert.ok(!named.text.includes('## Start here'), 'P-04: no "Start here" beside it');
  const address = file.split('/').map(encodeURIComponent).join('/');
  assert.equal(named.text[2], `**[Retries Considered](${address})** · Fake Author et al. · 2024`, 'the library item, by its path');
  const reads = named.text.slice(3, 7);
  assert.deepEqual(reads.map((line) => line.slice(0, 9)), ['**Read:**', '**Why:** ', '**Read:**', '**Why:** '], 'a Read and a Why for each section, no blank line between');
  assert.ok(reads.filter((line) => line.startsWith('**Read:**')).every((line) => (line.match(/\]\(/g) || []).length === 1), 'one Read link per pair');
  assert.equal(named.text[7], '', 'the entry ends after its last pair');
  // A-02: each link opens the library copy at its section, and the Sections menu lists both, best first as the guide gave them.
  const sections = guideSections(named.text, file);
  assert.deepEqual(sections.map((s) => s.label), ['5 Findings', '3 Method'], 'best first, not in the paper\'s order');
  assert.ok(sections.every((s) => s.find && s.to), 'each with where it starts and ends');
  assert.equal(splitTarget(reads[0].match(/\]\(([^)\s]+)\)$/)[1]).address, file, 'into the library copy');
  assert.deepEqual(guideTitle(named.text[2], named.text[3]), { title: 'Retries Considered', address: file }, 'its title line still reads as a paper');
  // A-03: the trace from it follows, within the mode's limit.
  const groups = named.text.filter((line) => line.startsWith('## '));
  assert.deepEqual(groups, ['## This paper', '## Classics', '## Recent', '## Essays']);
  assert.ok(named.text.some((line) => /^\*\*\[A fake classic it cites \(standard mode\)\]/.test(line)));
  assert.ok(named.text.filter((line) => /^\*\*\[/.test(line)).length <= 8, 'within standard\'s eight sources, the paper among them');
  assert.equal(named.text.filter((line) => line.startsWith('**Try:**')).length, 1);
  const body = named.text.slice(0, -2).join('\n');
  assert.equal(replyBody('discover', body), body, 'replyBody keeps it whole');
  // With words beside it, the same guide; a workspace's mention names no paper.
  const worded = await run(['@discover @[Retries Considered] how they measured recovery'], 'np2');
  assert.deepEqual([worded.card, worded.text[0]], [null, '## This paper']);
  assert.equal((await run([`@discover what @[Reading](ws:${space.id}) is about`], 'np3')).text[0], '## Start here', 'A-04: no paper named, as before');
  assert.equal((await run(['@discover why do retries loop'], 'np4')).text[0], '## Start here', 'A-04: a problem, as before');
  // A follow-up that names a paper gets its guide; one that does not gets additions.
  const first = await run(['@discover why do retries loop'], 'np5');
  const follow = await run([...first.doc, '@discover @[Retries Considered]'], 'np6');
  assert.equal(follow.text[0], '## This paper');
  assert.equal((await run([...follow.doc, '@discover only after 2022'], 'np7')).text[0], '## Recent');
});
