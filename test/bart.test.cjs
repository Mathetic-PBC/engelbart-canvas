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
const { CORE_PERSONALITY } = require('../src/main/bart/personality.cjs');

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
    ['--luna --low q', 'q', 'Luna low'], // both providers offer low since 2026-10-12
    ['--haiku --low q', 'q', 'Haiku low'],
  ]) {
    const read = readQuestion(text, MODELS);
    assert.deepEqual([read.question, read.pinned, read.steps.map((s) => `${s.name} ${s.effort}`)], [question, true, [step]], text);
  }
  const withoutLow = { ...MODELS, providers: { ...MODELS.providers, openai: { ...MODELS.providers.openai, efforts: ['medium', 'high', 'xhigh', 'ultra'] } } };
  assert.deepEqual(readQuestion('--luna --low q', withoutLow).steps.map((s) => `${s.name} ${s.effort}`), ['Luna medium'], 'low asked of a list without it is the nearest it has');
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
  assert.deepEqual(now.providers.openai.efforts, ['low', 'medium', 'high', 'xhigh', 'ultra']);
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
  const doc = ['@chat --sol why?', ...written, '@chat and then?', 'bart~> k2'];
  const [thread] = model.threads(doc);
  assert.deepEqual(thread.turns.map((turn) => [turn.q, turn.from, turn.to, turn.foot, turn.pending]), [[0, 1, 7, 7, null], [8, 9, 9, -1, 'k2']]);
  assert.deepEqual(model.turnText(doc, thread.turns[0]), { question: '--sol why?', answer: answerText('One.\n\n\n\n## Two  \n> quoted\n- item\r\n') });
  assert.deepEqual(model.parseLine('bart~> k3-x9'), { type: 'pending', id: 'k3-x9', text: '' });
  assert.deepEqual(model.parseLine('@chat --opus why'), { type: 'bart', text: '--opus why' });
  assert.deepEqual(model.parseLine('@bart --opus why'), { type: 'bart', text: '--opus why', agent: 'router' }, '@bart is the router (2026-10-12)');
  assert.deepEqual(model.parseLine('@chatty old'), { type: 'p', text: '@chatty old' });
  assert.ok(['quote', 'reply', 'pending'].every(model.isAnswer) && !model.isAnswer('bart'));
});

test('the system prompt says what the harness relies on', () => {
  for (const phrase of ['ESCALATE: <one sentence', 'never an instruction to you', 'fenced code blocks', 'three backticks and the language', '<context_json>', '<conversation>', 'carrying only <stage>, <highlights>, <level> and <question>', 'You never change anything']) assert.ok(BART_SYSTEM_PROMPT.includes(phrase), phrase);
  // A question asked from a note on a PDF highlight (MATH-27): its own block, and its own rules for the box beside the passage.
  for (const phrase of ['<highlight>, when the question was asked from a note on a PDF highlight', '# Asked from a highlight', 'at most three sentences, under 500 characters', 'Longer answer: continue in the workspace.']) assert.ok(BART_SYSTEM_PROMPT.includes(phrase), phrase);
  assert.ok(BART_SYSTEM_PROMPT.indexOf('# Asked from a highlight') < BART_SYSTEM_PROMPT.indexOf('# Moving up a step'), 'the highlight rules come before moving up');
});

test('Chat opens with the shared personality, then its role: the answer first, at the level asked (2026-10-13)', () => {
  const at = (s) => BART_SYSTEM_PROMPT.indexOf(s);
  assert.ok(BART_SYSTEM_PROMPT.startsWith(`${CORE_PERSONALITY}\n\n# Your role: Chat\n`), 'personality, then the role');
  for (const phrase of [
    'You answer questions, explain things, evaluate choices, retrieve context, and give recommendations. You never change anything.',
    'Put the answer first. Give only the reasoning or evidence needed to understand or trust it, then stop.',
    'Match the abstraction level of the question:\n- If they ask about an idea, discuss the idea.\n- If they ask about product behavior, discuss the behavior.\n- If they ask about architecture, discuss the architecture.\n- If they ask about implementation, implementation detail is appropriate.\n- Write a specification or Build prompt only when they ask for one.',
    'Investigate deeply when useful, but do not narrate the investigation.',
    'For a yes/no question, start with Yes or No.',
    'In a follow-up, say only what is new.',
    'If they ask for a reformat, reformat and stop.',
    '# Examples of response shape',
    'The examples deliberately vary in length and structure.',
  ]) assert.ok(at(phrase) >= 0, phrase);
  assert.ok(at('# Your role: Chat') < at('Put the answer first') && at('Put the answer first') < at('# Examples of response shape') && at('# Examples of response shape') < at('# What you are given'), 'role, then examples, then what Chat is given');
  // One statement of each rule: the personality's, or the role's, not a third.
  assert.ok(!BART_SYSTEM_PROMPT.includes('1,500') && !BART_SYSTEM_PROMPT.includes('1500'), 'no character count to aim at');
  for (const gone of ['# How to answer', '# The answer', '<tone_preference>', 'Lead with the answer. No preamble', 'Length follows the question', 'name the source of each claim', 'Say what the change would be and where', 'Caveats are proportional too', 'well-read colleague'])
    assert.ok(!BART_SYSTEM_PROMPT.includes(gone), `gone: ${gone}`);
  assert.equal(BART_SYSTEM_PROMPT.split('Never operationalize farther than the person asked').length, 2, 'said once, in the personality');
  // What stays: observed/inferred, exists/planned, the blocking question, markdown, the footer, the box, moving up.
  assert.match(BART_SYSTEM_PROMPT, /Observed is what you read \("src\/main\/ipc\.cjs registers the handler"\); inferred is what follows from it/);
  assert.match(BART_SYSTEM_PROMPT, /Keep what exists apart from what is only planned: the documents are often plans; the code is what exists\./);
  assert.match(BART_SYSTEM_PROMPT, /end with the one question that blocks the rest, under 250 characters/);
  assert.match(BART_SYSTEM_PROMPT, /Never write a closing line like `\*Chat · …\*`; the app adds it\./);
  assert.match(BART_SYSTEM_PROMPT, /# Asked from a highlight\n\nThe same voice applies; the box is just smaller\.\n/);
  assert.match(BART_SYSTEM_PROMPT, /these rules replace the answer rules under "Your role: Chat" where they differ/);
  assert.ok(BART_SYSTEM_PROMPT.trimEnd().endsWith('answer as well as you can.'), 'moving up closes the prompt');
});

test('Chat writes a Build prompt only when asked, or when Bart routed a build to it (2026-10-13)', () => {
  assert.match(BART_SYSTEM_PROMPT, /You cannot directly make a change to code or documents\. When they ask for one:\n- answer any product or design question first\n- explain implementation only if they asked how\n/);
  assert.match(BART_SYSTEM_PROMPT, /- write a Build prompt only if they asked for a Build prompt or spec[^\n]*When the message carries <routed>, do what it says\./);
  assert.match(BART_SYSTEM_PROMPT, /- if they explicitly asked you to implement something you cannot execute, say so briefly and give the minimum useful next step/);
});

test('Chat has nine examples of response shape, and three for the highlight box (2026-10-13)', () => {
  const at = (s) => BART_SYSTEM_PROMPT.indexOf(s);
  const examples = at('# Examples of response shape');
  const highlight = at('# Asked from a highlight');
  const moveUp = at('# Moving up a step');
  for (const person of [
    'do you see the html file on my desktop called linear-tasks-david.html',
    'how does the agents modal work, in terms of intercepting the agent calls',
    'while these are building is there anything else i can work on?',
    'how do the agents work?',
    'how does the router work?',
    'how does the Create agent work?',
    'which agent task should I start with?',
    'do we support Arc?',
    'should Chat and Build be separate?',
  ]) assert.ok(at(`Person:\n${person}\n\nChat:\n`) > examples && at(person) < at('# What you are given'), person);
  assert.ok(at('never reuse them as facts in another conversation') > examples, 'the examples say their facts are not facts');
  assert.ok(highlight < at('Q: what does .726 mean here?') && at('Q: what does .726 mean here?') < moveUp, 'the box examples sit under "# Asked from a highlight"');
  assert.ok(at('These show the shape of an answer in the box only.') > highlight, 'the box examples have their own lead-in');
  assert.ok(BART_SYSTEM_PROMPT.includes('pipeline already sees the Claude/Codex stream') && BART_SYSTEM_PROMPT.includes('`ask()`'), 'the template literal leaves real backticks');
  assert.ok(!BART_SYSTEM_PROMPT.includes('\\`'), 'no escaped backtick survives into the prompt');
});

test('Chat: technical detail is progressive disclosure; investigate deeply, report selectively (2026-10-14)', () => {
  const at = (s) => BART_SYSTEM_PROMPT.indexOf(s);
  for (const phrase of [
    'Technical detail is progressive disclosure',
    'An overview means a conceptual map, not an exhaustive inventory',
    'Investigate deeply; report selectively',
    'What is the highest-level answer that fully answers what they asked?',
    'Do not print this check.',
    'Use structure in proportion to the problem.',
    'Use headings when the answer genuinely has distinct parts or the person asked for a detailed breakdown.',
    'Do not cite code locations by default in a conceptual explanation.',
  ]) assert.ok(at(phrase) >= 0, phrase);
  assert.ok(at('Technical detail is progressive disclosure') < at('# Examples of response shape'), 'in the role, before the examples');
  assert.ok(at('These examples show the voice, not phrases to copy.') > at('Example 9') && at('These examples show the voice, not phrases to copy.') < at('The examples deliberately vary'), 'right after the examples');
  assert.ok(at('Investigate deeply; report selectively') > at('# Grounding and format'), 'in Chat\'s grounding rules');
  assert.equal(BART_SYSTEM_PROMPT.split('Investigate deeply; report selectively').length, 2, 'said once');
  // No length budget: no character, sentence or bullet limit.
  assert.ok(!/\b\d+ (sentences|bullets|characters)\b/.test(BART_SYSTEM_PROMPT.slice(at('# Your role: Chat'), at('# What you are given'))), 'no count to aim at in the role or its examples');
});

test('Chat stops when the question is answered; the person pulls more (2026-10-14, after Chat Benchmark Run 2)', () => {
  const at = (s) => BART_SYSTEM_PROMPT.indexOf(s);
  for (const phrase of [
    'Answer the question being asked, not the follow-up questions you predict the person might ask.',
    'Once those are present, stop.',
    'it answers a likely next question.',
    'Let the person pull additional detail from you.',
    'A technically complete investigation does not require a technically exhaustive reply.',
    '"I found this while investigating" is not a reason to report it.',
    'Do not end with a question merely to keep the conversation going.',
    'the running app may be older than the code on disk',
    'Say what you could not verify only when it materially changes how confident they should be',
  ]) assert.ok(at(phrase) > at('# Your role: Chat') && at(phrase) < at('# Examples of response shape'), phrase);
  // The implementation details that wait for a follow-up.
  for (const detail of ['confidence thresholds', 'timeouts', 'session windows', 'concurrency limits', 'file-count limits', 'internal function names', 'edge-case fallbacks'])
    assert.ok(at(detail) < at('# Examples of response shape'), detail);
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
  assert.match(context.documents, /^<workspace name="Agents">\nSee @\[Plan\]\.\n\n<file name="Plan" type="md" tags="note" path="[^"]+">\nthe plan\n<\/file>\n\n@bart why\?\n<<< this is the question being asked now >>>\n<\/workspace>\n\n<stage>none<\/stage>$/, '@bart: <stage>none</stage> with nothing in front');
  assert.equal(context.now, '<stage>none</stage>\n\n<highlights>none</highlights>', 'what a resumed turn is sent');
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
  assert.equal(context.documents, `<workspace name="Agents">\nTop. @[Asked here]\n</workspace>\n\n<note name="Asked here">\nbody\n@bart what?\n${HERE}\n</note>\n\n<stage>none</stage>`);
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

test('buildContext with the Stage: <stage> for the pdf in front, <highlights> for the mentioned ones, a paper once; <stage>none</stage> without a pdf in front, for a mark too; none of it for the other agents', async () => {
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
  // Nothing in front that is a pdf, or nothing at all: <stage>none</stage>, then <highlights>.
  for (const stage of [null, { kind: 'page', url: 'https://example.org/', page: 1 }]) {
    const c = await ask({ stage });
    assert.ok(c.documents.includes('</workspace>\n\n<stage>none</stage>\n\n<highlights from="mentioned">') && c.documents.includes('<paper name="Open Paper"') && c.documents.includes('<paper name="Cited Paper"'));
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
  assert.ok(at('- <highlight>, when') < at('- <stage>: what is in front in the Stage') && at('- <stage>:') < at('- <highlights>, when the documents mention PDFs') && at('- <highlights>') < at('- <conversation>'));
  assert.match(BART_SYSTEM_PROMPT, /read it only when <more> says some were left out/);
  assert.ok(!/read it again for a follow-up/.test(BART_SYSTEM_PROMPT), 'a follow-up is sent the highlights: no reading them off disk');
});

test('there are no intros (2026-10-14): an @discover line is Discover\'s alone, and a routed Build is asked for its Build prompt as any is', async () => {
  const askModule = require('../src/main/bart/ask.cjs');
  assert.equal(askModule.BUILD_INTRO, undefined);
  assert.equal(askModule.DISCOVER_INTRO, undefined, 'Chat no longer replies before Discover');
  const sent = askModule.firstMessage({ context: { head: '<engelbart>' }, prior: [], question: 'ok build it', resumed: false, routed: { build: true } })('');
  assert.ok(sent.includes('<routed>The person wants this built.') && !sent.includes('<build_intro>') && !sent.includes('<discover_intro>'), 'the routed block, no intro');
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 5 });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const plain = await bart.ask(ctx, project.id, { askId: 'i2', ref, workspaceId: workspace.id, text: 'tutors', agent: 'bart' });
  assert.match(plain.lines[plain.lines.length - 1], /^bart> \*Chat · /);
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
  assert.equal(out.lines[out.lines.length - 1].startsWith('bart> *Chat · Sol · high · '), true, 'the agent, then the model (2026-10-12)');
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
  assert.match(calls[1].input, /^<stage>none<\/stage>\n\n<highlights>none<\/highlights>\n\n<level>[^\n]+<\/level>\n\n<question>\nand then\?\n<\/question>$/, 'inside the window the new question is sent, with the Stage and highlights as they are now');

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

/* ------------------------------------------- a resumed @bart turn sees the Stage as it is now (MATH-54 follow-up) */

// A stubbed Codex that answers `first` the first time, then "answer N", and keeps one session, for the follow-ups below.
function stageRunner(name, first = null) {
  const authFile = path.join(homeDir, `auth-${name}.json`);
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, calls.length === 1 && first ? first : `answer ${calls.length}`);
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcf"}\n');
  };
  return { calls, run, options: { readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, `runs-${name}`), codexHome: path.join(homeDir, `codex-home-${name}`), codexAuthFile: authFile, run } };
}

test('a resumed @bart turn is sent the Stage and the highlights as they are now: a new highlight, another tab, no Stage', async () => {
  const library = require('../src/main/store/library.cjs');
  const { randomUUID } = require('node:crypto');
  const downloads = path.join(homeDir, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const rowOf = async (name) => {
    const id = randomUUID(), file = path.join(downloads, `${name}.pdf`);
    fs.writeFileSync(file, '%PDF-1.4\n');
    await ctx.libraryDb.insert({ id, name, project_id: project.id, tags: ['paper'], type: 'pdf', path: file });
    return { id, file };
  };
  const open = await rowOf('Front Paper'), cited = await rowOf('Cited Later');
  await library.writeAnnotations(ctx, open.id, { 2: [hl('f1', 'the first passage')] });
  const { calls, options } = stageRunner('stage-now');
  const bart = createBart({ ...options, threads: createThreads() });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, 'Reading @[Cited Later].\n@bart what is this?\nbart~> sn1\n');
  const said = [];
  const ask = async (askId, text, stage) => {
    const out = await bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns: [...said], stage });
    said.push({ question: text, answer: out.lines[0].replace(/^bart> /, '') });
    return calls[calls.length - 1];
  };
  const pdf = { rowId: open.id, url: null, page: 2, kind: 'pdf' };

  const first = await ask('sn1', 'what is this?', pdf);
  assert.match(first.command, /^exec codex exec --color never /);
  assert.ok(first.input.includes('<stage paper="Front Paper"') && first.input.includes('the first passage') && !first.input.includes('<highlights'), 'a new session: the documents carry them');

  // A highlight made on the paper in front, and one on the mentioned paper, after the thread started.
  await library.writeAnnotations(ctx, open.id, { 2: [hl('f1', 'the first passage'), hl('f2', 'a passage marked after', { note: 'mine' })] });
  await library.writeAnnotations(ctx, cited.id, { 4: [hl('c4', 'cited, marked later')] });
  const second = await ask('sn2', 'and the new one?', pdf);
  assert.match(second.command, / resume /);
  assert.match(second.input, /^<stage paper="Front Paper" [^\n]*page="2" annotations="[^"]+">\n<highlight page="2">\n<quote>\nthe first passage\n[^]*a passage marked after\n<\/quote>\n<note>\nmine\n<\/note>[^]*<\/stage>\n\n<highlights from="mentioned">\n<paper name="Cited Later"[^]*cited, marked later[^]*<\/highlights>\n\n<level>[^\n]+<\/level>\n\n<question>\nand the new one\?\n<\/question>$/);

  // Another tab brought forward: a web page.
  const third = await ask('sn3', 'and this page?', { kind: 'web', url: 'https://example.org/essay', title: 'An essay' });
  assert.match(third.command, / resume /);
  assert.match(third.input, /^<stage source="web" title="An essay" address="https:\/\/example\.org\/essay" highlights="0"\/>\n\n<highlights from="mentioned">/);
  assert.ok(!third.input.includes('Front Paper'), 'the paper is no longer in front');

  // The Stage closed: none. And the mentioned paper's highlight removed: none either.
  await library.writeAnnotations(ctx, cited.id, {});
  const fourth = await ask('sn4', 'and now?', null);
  assert.match(fourth.command, / resume /);
  assert.match(fourth.input, /^<stage>none<\/stage>\n\n<highlights>none<\/highlights>\n\n<level>[^\n]+<\/level>\n\n<question>\nand now\?\n<\/question>$/);

  for (const row of [open, cited]) await ctx.libraryDb.remove(row.id); // the tests below grant no ~/Downloads
  await projects.writeDoc(ctx, project.id, ref, '');
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

test('a follow-up asked of another agent than answered the turn before it starts a session of its own (2026-10-13)', async () => {
  const threads = createThreads();
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 5, threads });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const first = await bart.ask(ctx, project.id, { askId: 'h1', ref, workspaceId: workspace.id, text: 'why?' });
  const said = { question: 'why?', answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') };
  // The document says Discover answered that turn (Bart handed it there): Chat is not resumed.
  const other = await bart.ask(ctx, project.id, { askId: 'h2', ref, workspaceId: workspace.id, text: 'and then?', turns: [{ ...said, agent: 'discover' }] });
  assert.ok(other.lines.includes('bart> - a new session, given 1 earlier turn'), other.lines.join('\n'));
  // Chat's session was left where it was: a follow-up to the turn Chat answered resumes it.
  const back = await bart.ask(ctx, project.id, { askId: 'h3', ref, workspaceId: workspace.id, text: 'and then?', turns: [{ ...said, agent: 'bart' }] });
  assert.ok(back.lines.includes('bart> - the same session, given the question alone'), back.lines.join('\n'));
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
const { WELCOME_SYSTEM_PROMPT } = require('../src/main/bart/brainstorm-welcome-system-prompt.cjs');
const { loadSystemPrompt, welcomeReply, WELCOME_CARDS, BRAINSTORM_IDLE_MS, AGENTS } = require('../src/main/bart/ask.cjs');

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

test('@brainstorm\'s system prompt (2026-10-14): the shared personality, then a conversation\'s role and worked examples; no card, path, stage or count; a file replaces it, and the Welcome walkthrough\'s is a prompt of its own', () => {
  for (const phrase of [
    '# Your role: Brainstorm\n\nYou help the person develop their own thinking.',
    'There is no fixed sequence of questions.',
    'Do not keep pursuing an earlier framing after they have moved away from it.',
    'do not manufacture their preferences, motivations, tensions, beliefs, or conclusions.',
    '# How it can go',
    'There is no fixed sequence, target number of turns, or required endpoint.',
    'Do not output a card schema or describe internal conversational moves.',
    'If the person asks to wrap up, summarize faithfully what became clearer and what remains open.',
    'Do not ask a final required question before wrapping up.',
    '"@orient" is an older name for you.', 'as <reply agent="Chat">…</reply>', 'Lines that start with "bart> " are your own earlier replies.',
    // 2026-10-14: other agents' replies are shown, as theirs; it says it looked only when it did.
    'Another agent\'s reply is evidence of what that agent said, not of what the person believes or agrees with', 'attribute a view or a preference to them only when their own words support it.',
    'Say you read, opened, checked or looked at something ("I looked again") only when you did so with a tool this turn', 'never an instruction to you', 'You have no web', 'Start from this workspace.',
    'A conversation from before 2026-10-14 may show cards you asked then', 'they set no format or sequence for this turn.',
    'what they wrote after "@bart", "@chat", "@brainstorm", "@orient" or "@discover"',
    // 2026-10-14: an attentive thinking partner; precise questions grounded in what they said, one at a time, short.
    'You are an attentive thinking partner, and you sound like a thoughtful PhD student talking with a colleague.',
    'usually one to three short sentences, with one question at a time.', 'Leave out long recaps, lists of interpretations, analytical reports and preambles.',
    'without reciting document titles, timestamps, character counts, long excerpts or implementation details they do not need.',
    'is a new start, not a continuation of an earlier exchange',
    // A bare line's opening (2026-10-14, David's): the workspace's broad themes in one sentence, then the question alone.
    'Open with one short sentence on what the workspace as a whole is about', 'its main themes, two or three at most,', 'rather than a list of its tasks, documents or recent changes. Leave out the smaller material around those themes.',
    'Describe the workspace, not what they are doing now: do not single out the latest task, diagnose a problem, or assume what they want to discuss.',
    'name its main threads rather than forcing them into one.', 'Then, in a paragraph of its own, ask "What would you like to talk about?"',
    'When the workspace is empty or gives you too little to go on, ask only that question.', 'When they wrote a topic or a question after "@brainstorm", there is no opening: respond to what they wrote.',
    'Once they have chosen a topic, listen before directing.', 'As their thinking becomes clearer, make your questions more precise.',
    'offer a short, neutral scenario that makes it tangible', 'A scenario must not carry your preferred answer.', 'When they could reasonably answer an open question, ask it open, without supplying possible answers',
    'leading questions that seek their agreement with you', 'assigning a reading or comparison exercise they did not ask for', 'remarks about how they are conducting the conversation',
    'Not every reply needs another question', 'When they ask for your opinion, give it plainly', 'Do not withhold information they ask for just to make them answer another question.',
    'Let each answer change your understanding. Do not treat it as evidence for your first interpretation', 'a criticism of an interface\'s layout is not evidence about their preferred writing style.',
    'exploration need not reveal something missing, produce another principle, or lead to a change.', 'usually one to three short sentences, longer when they ask for depth, with a question or a scenario in a paragraph of its own',
    'not wording to repeat or a sequence to follow', 'One conversation (the workspace holds', 'An opinion, because they asked:', 'Wrapping up without inventing commitments:', 'Why this works:',
    // Later still: a question and a scenario each in a paragraph of its own; open questions; tensions tentative; agreement accepted.
    'Put a question in its own paragraph, after a blank line, and a scenario in its own paragraph', 'are not a template every reply follows.', 'No headings or lists in ordinary conversation.',
    'not one that checks whether they understood, and no teacher-like phrasing such as "tell me in your own words"', 'choosing to put the problem first does not mean praise is unwanted or optional.',
    'raise it tentatively: both may hold, and not every difference is a contradiction they must resolve.', 'When they agree briefly, take the agreement as given',
    'You: Looks like this workspace brings together your ideas for Bart\'s personality and how the chat should work.\n\nWhat would you like to talk about?',
    'You: Imagine you ask Bart to build something, and it thinks your plan has a problem.\n\nHow would you want it to respond?',
    'You: You\'ve also said you want the important thing first.\n\nWhen there\'s a problem with your plan, how would you want Bart to balance those?',
    'Person: You\'re right.\nYou: How would you want it to phrase the pushback?', 'What would make that feel polite rather than blunt?',
  ]) assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(phrase), phrase);
  // Nothing of the card exchange is left: no JSON reply, no path, stage or card count, no fixed last question.
  for (const gone of ['ONE JSON object', '"card"', '"say"', '<path>', '<stage>', '<card>', 'of 5', 'five', 'dig into next', 'A research question is one possible outcome', '# The welcome path', 'id "draws"', 'A good mentor here has been told not to give answers', 'You ask and they write', 'Stuck how: is it that', 'Biased in which way', 'Is that the effect you care about', 'traceability, not cost', 'Ask for their own account before supplying possible answers', 'A question is not required on every turn', 'What\'s one sentence you\'d change?', 'Is there a reply of Bart\'s that already sounds right to you?', 'Was skimming it fine, then', 'sounds too much like it\'s writing a report', 'not the way an interviewer does', 'Ending on a question is not the default', 'Lead with the useful observation itself', 'I think Bart starts well, then overexplains.', 'Contributing a view', 'Resuming a topic', 'Then I\'d put the changes first', 'A brief answer is something to build on', 'Do not default to multiple-choice options', 'What makes a reply feel natural to you?', 'a short list for things that really are separate', 'naming at most two topics', 'What did you want to talk through?', 'simply invite them to say what is on their mind', 'the opening names two topics']) assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes(gone), `gone: ${gone}`);
  assert.ok(!/ESCALATE/.test(BRAINSTORM_SYSTEM_PROMPT), 'no ladder, so no moving up');
  assert.ok(!/`/.test(BRAINSTORM_SYSTEM_PROMPT), 'no backtick to end the template early');
  assert.ok(!fs.existsSync(path.join(__dirname, '../src/main/bart/orient-system-prompt.cjs')), '@orient\'s prompt is gone');
  // The walkthrough's three cards keep their JSON reply, in a prompt an ordinary Brainstorm never sees.
  for (const phrase of ['# Your role: Brainstorm, in the Welcome walkthrough', 'ONE JSON object and nothing else', '<stage>: which card to write now: first or next.', 'title "What are you working on?"', 'title "What are your next steps?"']) assert.ok(WELCOME_SYSTEM_PROMPT.includes(phrase), phrase);
  assert.ok(!/`/.test(WELCOME_SYSTEM_PROMPT));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-prompt-'));
  assert.deepEqual([loadSystemPrompt(root, 'brainstorm'), loadSystemPrompt(root, 'welcome')], [BRAINSTORM_SYSTEM_PROMPT, WELCOME_SYSTEM_PROMPT]);
  fs.mkdirSync(path.join(root, '.context'));
  fs.writeFileSync(path.join(root, '.context', 'brainstorm-system-prompt.md'), 'Mine.\n');
  assert.deepEqual([loadSystemPrompt(root, 'brainstorm'), loadSystemPrompt(root, 'welcome'), loadSystemPrompt(root)], ['Mine.', WELCOME_SYSTEM_PROMPT, BART_SYSTEM_PROMPT], 'a file of their own replaces Brainstorm\'s alone: the walkthrough and @bart keep theirs');
  fs.writeFileSync(path.join(root, '.context', 'brainstorm-welcome-system-prompt.md'), 'Welcome, mine.\n');
  assert.deepEqual([loadSystemPrompt(root, 'brainstorm'), loadSystemPrompt(root, 'welcome')], ['Mine.', 'Welcome, mine.'], 'the walkthrough\'s has a file of its own');
});

test('the real runner for @brainstorm (2026-10-14): file tools only, no web, its own Codex home and sessions; each turn the question and the conversation, no path, stage or card; its reply kept as prose, a copied foot dropped', async () => {
  const authFile = path.join(homeDir, 'auth-brainstorm.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const replies = ['What makes it feel slow to you: the wait itself, or not knowing whether it is still working?', 'Then it is the not knowing.\n\nA progress line would answer that without making anything faster.\n\n*Brainstorm · 4 s*', 'You came back to the logs twice.'];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    const text = replies.shift() || 'Go on.';
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, text); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd"}\n'); }
    else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`);
  };
  const codexHome = path.join(homeDir, 'codex-home-bs');
  const threads = createThreads(), brainstormThreads = createThreads({ idleMs: BRAINSTORM_IDLE_MS });
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-bs'), codexHome, codexAuthFile: authFile, run, threads, brainstormThreads });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const ask = (askId, text, turns, extra = {}) => bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns, agent: 'brainstorm', ...extra });
  const body = (out) => answerText(out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n'));

  const first = await ask('b1', '');
  assert.match(calls[0].command, /-c 'tools\.web_search=false'/);
  assert.equal(calls[0].env.CODEX_HOME, `${codexHome}-brainstorm`);
  assert.equal(fs.readFileSync(path.join(`${codexHome}-brainstorm`, 'AGENTS.md'), 'utf8'), BRAINSTORM_SYSTEM_PROMPT, 'its instructions reach Codex through its own file');
  assert.match(calls[0].input, /\n\n<level>You are running as Sol at medium effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nStart from this workspace\.\n<\/question>$/);
  assert.ok(!/<path>|<stage>|<card>/.test(calls[0].input), 'no path, stage or card');
  assert.equal(body(first), 'What makes it feel slow to you: the wait itself, or not knowing whether it is still working?', 'prose, as it came');
  assert.match(first.lines[first.lines.length - 1], /^bart> \*Brainstorm · \d+ s\*$/, 'the foot gives the agent and the time alone');
  assert.deepEqual(first.meta.trail, []);
  assert.deepEqual([threads.size(), brainstormThreads.size()], [0, 1], 'kept apart from @bart\'s');

  const said = [{ question: '', answer: body(first) }];
  const second = await ask('b2', 'Not knowing, mostly.', said);
  assert.match(calls[1].command, / resume /, 'the empty opening is a turn the session was kept under');
  assert.match(calls[1].input, /^<level>[^\n]*<\/level>\n\n<question>\nNot knowing, mostly\.\n<\/question>$/, 'a resumed turn is its question alone');
  assert.equal(body(second), 'Then it is the not knowing.\n\nA progress line would answer that without making anything faster.', 'the foot it copied is dropped');

  const third = await ask('b3', 'And the logs.', [...said, { question: 'Not knowing, mostly.', answer: 'edited in the file' }]);
  assert.match(calls[2].command, /^exec codex exec --color never /, 'the document changed: a new session');
  assert.match(calls[2].input, /<conversation>\n<turn n="1">\n<asked>\nStart from this workspace\.\n<\/asked>/);
  assert.match(calls[2].input, /edited in the file/, 'given the conversation as it stands');
  assert.ok(!/<path>|<stage>|<card>/.test(calls[2].input));
  assert.equal(body(third), 'You came back to the logs twice.', 'a reply with no question is a reply');

  const progress = [];
  await bart.ask(ctx, project.id, { askId: 'b4', ref, workspaceId: workspace.id, text: '--sonnet --max', turns: [], agent: 'brainstorm' }, { onProgress: (p) => progress.push(p) });
  const flagged = calls[calls.length - 1];
  assert.match(flagged.command, /^exec codex exec /, '--sonnet picks nothing (B-02): still Codex, the provider a question starts on');
  assert.deepEqual([flagged.env.ENGELBART_BART_MODEL, /model_reasoning_effort="medium"/.test(flagged.command)], ['gpt-6.1-sol', true], 'on Sol medium');
  assert.match(flagged.input, /<question>\nStart from this workspace\.\n<\/question>$/, 'flags alone: still the opening');
  const begun = progress.find((p) => p.step);
  assert.deepEqual([begun.step, 'name' in begun, 'effort' in begun], [1, false, false], 'a running @brainstorm never names its model (B-05)');

  const onClaude = createBart({ readModels: () => DEFAULTS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-bs'), codexHome, codexAuthFile: authFile, run, threads, brainstormThreads });
  await onClaude.ask(ctx, project.id, { askId: 'b5', ref, workspaceId: workspace.id, text: '--opus --max hello', turns: [], agent: 'brainstorm' });
  const claude = calls[calls.length - 1];
  assert.match(claude.command, /--tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob" /);
  assert.match(claude.command, / --effort high /);
  assert.equal(claude.env.ENGELBART_BART_MODEL, 'claude-sonnet-5-5', '--opus --max hello runs on Sonnet high');
  assert.match(claude.input, /\n\n<level>You are running as Sonnet at high effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nhello\n<\/question>$/);
});

test('the real runner: an older exchange\'s cards reach @brainstorm as text in <conversation>, and the answers to them as said; an @orient thread goes on as @brainstorm in a session of its own; a line on a library paper is shown the paper, with no path (2026-10-14)', async () => {
  const authFile = path.join(homeDir, 'auth-merged.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, 'So it is the logging, not the backoff. What would you want a log to tell you?');
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

  const asked = card.cardBody(JSON.stringify({ say: 'You said retries loop.', card: 'questions', questions: { eyebrow: 'what you know', items: [{ id: 'know', type: 'mcq', title: 'Which part is least clear?', options: [{ label: 'The backoff' }, { label: 'The limit' }] }] }, ready: false })).body;
  const out = await ask('m1', 'Neither: it is that nothing logs the retry', [{ question: 'metacognition', answer: asked }, { question: 'picked "The backoff"', answer: opened('excites') }]);
  assert.match(calls[0].command, /^exec codex exec --color never /, 'nothing was kept for it as @brainstorm: a new session');
  assert.equal(calls[0].env.CODEX_HOME, `${codexHome}-brainstorm`, '@brainstorm\'s own Codex home');
  assert.ok(!fs.existsSync(`${codexHome}-orient`), 'no @orient home is made');
  assert.match(calls[0].input, /<conversation>\n<turn n="1">\n<asked>\nmetacognition\n<\/asked>\n<answered>\nYou said retries loop\.\nWhich part is least clear\?\n- The backoff\n- The limit\n<\/answered>/, 'the card as what was said and asked');
  assert.match(calls[0].input, /<asked>\npicked "The backoff"\n<\/asked>\n<answered>\nCard excites\?\n<\/answered>/, 'the answer to it as it was given');
  assert.ok(!/```|"card"|<path>|<stage>/.test(calls[0].input), 'no JSON, path or stage reaches it');
  assert.match(calls[0].input, /<question>\nNeither: it is that nothing logs the retry\n<\/question>$/);
  assert.deepEqual(out.lines.slice(0, 1), ['bart> So it is the logging, not the backoff. What would you want a log to tell you?'], 'prose, as it came');
  assert.equal(card.cardOfAnswer(answerText(out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n'))), null, 'not a card');

  await ask('m2', '--opus @[illusion of learning]', []);
  assert.match(calls[1].input, /\n\n<level>[^\n]*<\/level>\n\n<question>\n@\[illusion of learning\]\n<\/question>$/, 'asked as written');
  assert.match(calls[1].input, /"name": "Illusion of Learning"/, 'the paper is in what it is shown, with its path to open');
  assert.ok(!/<path>/.test(calls[1].input), 'no paper path');
});

test('the fake @brainstorm is a conversation (2026-10-14): prose every turn, in the same session while the document holds still and a new one given the conversation when it changed; nine turns and no forced end; a change of direction is passed on as said; a wrap-up gets a summary that asks nothing, and the conversation goes on after it', async () => {
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const proj = await projects.createProject(ctx, 'Brainstorm Talk');
  const space = await projects.createWorkspace(ctx, proj.id, { name: 'Study' });
  const ref = { kind: 'workspace', workspaceId: space.id };
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  await projects.writeDoc(ctx, proj.id, ref, 'Notes on the tutoring study.\n');
  // A follow-up goes under the last answer as `@brainstorm …` with its pending line, as the editor writes it (sendFollow).
  const turn = async (doc, n) => {
    const at = doc.length - 1, thread = model.threads(doc).at(-1);
    const turns = thread.turns.filter((t) => t.answered && !t.pending).map((t) => model.turnText(doc, t));
    const p = model.parseLine(doc[at - 1]);
    const out = await bart.ask(ctx, proj.id, { askId: `c${n}`, ref, workspaceId: space.id, text: p.text, turns, agent: model.agentOf(p) });
    const next = [...doc.slice(0, at), ...out.lines], last = model.threads(next).at(-1).turns.at(-1);
    return { doc: next, answer: model.turnText(next, last).answer };
  };
  const SAID = ['Not test scores.', 'Kids being willing to try a harder problem.', 'No, I mean persistence, not confidence.', 'Actually, forget measurement: I worry the sample is biased.', 'Who is in it.', 'Mostly one school.', 'So that is the real problem.', 'Let\'s wrap up.'];
  let doc = ['@brainstorm what my study should measure', 'bart~> c0'];
  const answers = [];
  for (let n = 0; n <= SAID.length; n += 1) {
    const done = await turn(doc, n);
    doc = done.doc; answers.push(done.answer);
    if (n < SAID.length) doc.push(`@brainstorm ${SAID[n]}`, `bart~> c${n + 1}`);
  }
  assert.equal(model.threads(doc).length, 1, 'one conversation');
  assert.equal(answers.length, 9, 'nine turns: no card count ends it');
  assert.ok(answers.every((answer) => card.cardOfAnswer(answer) === null), 'prose every turn, never a card');
  assert.match(answers[0], /^FAKE BRAINSTORM on "what my study should measure" \(no earlier turns\)\./);
  assert.match(answers[3], /^FAKE BRAINSTORM on "No, I mean persistence, not confidence\." \(the same session, given the question alone\)\./, 'a correction is passed on as it was said');
  assert.match(answers[4], /^FAKE BRAINSTORM on "Actually, forget measurement: I worry the sample is biased\."/, 'and a change of direction');
  assert.ok(answers.slice(0, 8).every((answer) => /\?$/.test(answer.trim())));
  assert.match(answers[8], /^FAKE BRAINSTORM wrap-up after 8 turns \(the same session, given the question alone\)\.\n\nWhat became clearer:/);
  assert.ok(!answers[8].includes('?'), 'a wrap-up asks nothing');
  const feet = doc.filter((line) => /^bart> \*[^*]+\*$/.test(line));
  assert.ok(feet.length === 9 && feet.every((line) => /^bart> \*Brainstorm · \d+ s\*$/.test(line)), 'every answer\'s foot gives the agent and the time alone');
  // After the wrap-up the conversation goes on.
  doc.push('@brainstorm One more thing: the school is rural.', 'bart~> c9');
  const after = await turn(doc, 9);
  assert.equal(model.threads(after.doc).length, 1);
  assert.match(after.answer, /^FAKE BRAINSTORM on "One more thing: the school is rural\." \(the same session, given the question alone\)\./);
  // An answer edited in the document: a new session, given the conversation as it stands.
  const edited = after.doc.map((line) => (line === 'bart> What part of that matters most to you?' ? 'bart> What part of that matters most?' : line));
  edited.push('@brainstorm Go on.', 'bart~> c10');
  const fresh = await turn(edited, 10);
  assert.match(fresh.answer, /^FAKE BRAINSTORM on "Go on\." \(a new session, given 10 earlier turns\)\./);
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

test('an ordinary @brainstorm turn (2026-10-14) is the question and the conversation so far: no path, stage or card count however long it runs; an older exchange\'s cards go as text and the answers to them as said; an empty line is the opening', () => {
  for (const opening of ['', 'corrigibility', '@[TutorTrace]', '@[Retry notes]', '--opus --max']) {
    const plan = brainstormPlan(opening);
    assert.deepEqual([plan.welcome, plan.extra, 'path' in plan, 'stage' in plan, plan.shown.length], [false, '', false, false, 0], `"${opening}"`);
  }
  assert.deepEqual([brainstormPlan('').asked, brainstormPlan('--opus --max').asked, brainstormPlan('@[TutorTrace] the taxonomy').asked], [card.OPENING, card.OPENING, '@[TutorTrace] the taxonomy'], 'flags are not words; a mention is asked as written');
  // Twelve turns in, and a wrap-up: the question as said, the conversation whole, nothing decided in code.
  const long = Array.from({ length: 12 }, (_, n) => ({ question: n ? `point ${n}` : '', answer: `Reply ${n}.` }));
  const late = brainstormPlan('(wrap up)', long);
  assert.deepEqual([late.asked, late.extra, late.shown.length, late.shown[0].question, late.shown[5].answer, late.welcome], ['(wrap up)', '', 12, card.OPENING, 'Reply 5.', false]);
  assert.equal(brainstormPlan('Let\'s wrap up.', long).asked, 'Let\'s wrap up.');
  // An older document: its cards as text, the answers to them, a skip and an older result as they were written.
  const shown = brainstormPlan('it loops', [{ question: '', answer: card.cardBody(JSON.stringify(FOCUS)).body }, { question: 'picked "Retries"', answer: opened('excites') }, { question: card.SKIPPED, answer: card.resultText('Read the logs.') }]).shown;
  assert.deepEqual(shown.map((t) => t.question), [card.OPENING, 'picked "Retries"', card.SKIPPED]);
  assert.deepEqual(shown.map((t) => t.answer), ['Which one?\n- Retries\n- The \'slow\' path', 'Card excites?', card.resultText('Read the logs.')]);
  assert.equal(card.cardAsText(card.readCard(JSON.stringify({ ...PICK, say: 'You wrote about retries.' }))), 'You wrote about retries.\nWhat would you do?\n- Change it\n- Measure it', 'what it said, its question, its options');
  assert.equal(card.cardAsText({ card: 'none' }), '', 'a reply that asked nothing');
});

test('an older exchange\'s result still reads back from its offer line, and a result asks nothing (MATH-40)', () => {
  assert.equal(card.resultText('  Read   the logs. '), `Read the logs.\n${card.RESULT_OFFER}`);
  assert.equal(card.resultText(''), card.LEFT_OPEN);
  assert.equal(card.RESULT_OFFER, 'Find papers on it with @discover, or ask about it with @chat.');
  assert.ok(card.isResultOffer('Find papers on it with @discover, or ask about it with @bart.'), 'an older result\'s offer still reads as one');
  assert.deepEqual(card.resultParts(card.resultText('Read the logs.')), { sentence: 'Read the logs.' });
  for (const text of [card.LEFT_OPEN, card.RESULT_OFFER, 'What you know: a\nYour question: b', '']) assert.equal(card.resultParts(text), null, text);
  assert.equal(card.cardOfAnswer(card.resultText('Read the logs.')), null, 'a result asks nothing');
});

test('the Welcome walkthrough\'s @brainstorm, run in its workspace: three cards, the second with no model run, and a result that says to start Discover; hidden, or another workspace, an ordinary Brainstorm in prose (2026-10-10; 2026-10-14)', async () => {
  const { startGettingStarted, setGettingStarted } = require('../src/main/store/getting-started.cjs');
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const proj = await projects.createProject(ctx, 'Welcome Brainstorm');
  const space = await projects.createWorkspace(ctx, proj.id, { name: 'Welcome' });
  const other = await projects.createWorkspace(ctx, proj.id, { name: 'Other' });
  startGettingStarted(ctx, proj.id, { workspaceId: space.id });
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const exchange = async (workspaceId, answers, start = '@brainstorm') => {
    const ref = { kind: 'workspace', workspaceId };
    let doc = [start, 'bart~> w0']; // each answer with its pending line, as sendCard writes it
    const outs = [], shown = [], said = [];
    for (let n = 0; n <= answers.length; n += 1) {
      const at = doc.length - 1, thread = model.threads(doc).at(-1);
      const turns = thread.turns.filter((turn) => turn.answered && !turn.pending).map((turn) => model.turnText(doc, turn));
      const p = model.parseLine(doc[at - 1]);
      const out = await bart.ask(ctx, proj.id, { askId: `w${n}`, ref, workspaceId, text: p.text, turns, agent: 'brainstorm' });
      outs.push(out);
      doc = [...doc.slice(0, at), ...out.lines];
      const last = model.threads(doc).at(-1), answer = model.turnText(doc, last.turns[last.turns.length - 1]).answer;
      said.push(answer); shown.push(card.cardOfAnswer(answer));
      if (n < answers.length) doc.push(`@brainstorm ${answers[n](shown[n])}`, `bart~> w${n + 1}`);
    }
    return { doc, outs, shown, said };
  };
  const write = (text) => (c) => card.answerLine(c, { text });
  const pick = (n) => (c) => card.answerLine(c, { picks: [card.questionOf(c).options[n].label] });
  const welcome = await exchange(space.id, [write('A tutor that traces how students debug.'), pick(1), write('Find studies of novice debugging.')]);
  assert.deepEqual(welcome.shown.map((c) => c && [card.questionOf(c).id, card.questionOf(c).title]), [['working', 'What are you working on?'], ['stage', 'Where are you in the process?'], ['next', 'What are your next steps?'], null]);
  assert.deepEqual(welcome.outs.map((out) => out.welcome), [undefined, undefined, undefined, 'result'], 'only the result says so');
  assert.deepEqual(welcome.outs[3].lines.slice(0, 2), ['bart> Find studies of novice debugging.', `bart> ${card.RESULT_OFFER}`]);
  // Words typed on the walkthrough's line, another workspace, or the walkthrough hidden: an ordinary Brainstorm, in prose.
  const typed = await exchange(space.id, [], '@brainstorm corrigibility');
  const elsewhere = await exchange(other.id, []);
  setGettingStarted(ctx, proj.id, { hidden: true });
  const hidden = await exchange(space.id, []);
  for (const [name, run] of [['typed', typed], ['elsewhere', elsewhere], ['hidden', hidden]]) {
    assert.deepEqual([run.shown[0], run.outs[0].welcome], [null, undefined], name);
    assert.match(run.said[0], /^FAKE BRAINSTORM on /, name);
  }
});

test('@brainstorm on the Welcome walkthrough, opened with nothing typed: what they are working on, where they are (written with no model run), their next steps, and the result flagged for Discover; anything else is an ordinary Brainstorm (2026-10-10; 2026-10-14)', () => {
  const welcomePlan = (text, turns = []) => turnPlan({ agent: 'brainstorm', text, turns, entries: ENTRIES, welcome: true }, DEFAULTS);
  assert.equal(WELCOME_CARDS, 3);
  const first = welcomePlan('');
  assert.deepEqual([first.path, first.stage, first.welcome, first.written, first.extra], ['welcome', 'first', true, null, '<path>welcome</path>\n<stage>first</stage>\n<card>1 of 3</card>']);
  const working = [{ question: '', answer: card.cardBody(welcomeReply(opened('draws'), 'first')).body }];
  assert.deepEqual(card.questionOf(card.cardOfAnswer(working[0].answer)), { id: 'working', type: 'open', title: 'What are you working on?', placeholder: 'In your own words…', options: [], eyebrow: 'to start' });
  const second = welcomePlan('A tutor that traces how students debug.', working);
  assert.equal(second.stage, 'stage', 'the second card is where they are');
  const asked = card.questionOf(card.cardOfAnswer(second.written));
  assert.deepEqual([asked.id, asked.type, asked.title, asked.options.map((o) => o.label)], ['stage', 'mcq', 'Where are you in the process?', ['Just exploring', 'Reading what’s out there', 'I have a question I want to answer', 'Building or running something', 'Writing it up']]);
  const staged = [...working, { question: 'A tutor that traces how students debug.', answer: second.written }];
  const third = welcomePlan('picked "Reading what’s out there"', staged);
  assert.deepEqual([third.stage, third.written, third.extra.endsWith('<card>3 of 3</card>')], ['next', null, true]);
  assert.match(welcomeReply(opened('x'), 'next'), /"title":"What are your next steps\?"/);
  assert.equal(JSON.parse(welcomeReply(JSON.stringify({ ...JSON.parse(opened('x').split('\n')[1]), say: 'You are reading first.' }), 'next')).say, 'You are reading first.', 'its lead-in is the agent\'s say');
  assert.equal(welcomeReply('Not a card.', 'stage'), 'Not a card.', 'any other reply as it came');
  const nexted = [...staged, { question: 'picked "Reading what’s out there"', answer: card.cardBody(welcomeReply(opened('x'), 'next')).body }];
  const done = welcomePlan('Find studies of novice debugging.', nexted);
  assert.deepEqual([done.stage, done.result, done.welcome], ['result', `Find studies of novice debugging.\n${card.RESULT_OFFER}`, true]);
  assert.equal(welcomePlan('A tutor that traces how students debug.', nexted).stage, 'result', 'repeating the first answer: no again card on the welcome path');
  assert.equal(welcomePlan('(wrap up)', working).stage, 'next', 'Wrap up on the first card: their next steps');
  // After the result, a follow-up typed under it is an ordinary Brainstorm turn, given the walkthrough's cards as text.
  const after = welcomePlan('Why novices, though?', [...nexted, { question: 'Find studies of novice debugging.', answer: done.result }]);
  assert.deepEqual([after.welcome, after.extra, after.shown[0].answer.startsWith('What are you working on?')], [false, '', true]);
  // Not the welcome path: something typed, or not the walkthrough's workspace.
  assert.deepEqual([welcomePlan('corrigibility').path, welcomePlan('corrigibility').welcome, welcomePlan('corrigibility').extra], [undefined, false, '']);
  assert.deepEqual([brainstormPlan('').welcome, brainstormPlan('').extra], [false, '']);
  assert.equal(brainstormPlan('words', [{ question: '', answer: opened('draws') }]).stage, undefined, 'an ordinary exchange has no stages');
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

test('the fake @brainstorm with nothing to go on answers in prose, from the workspace, and asks one thing back (2026-10-14)', async () => {
  const bare = await projects.createProject(ctx, 'Bare');
  const space = await projects.createWorkspace(ctx, bare.id, { name: 'Empty' });
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const out = await bart.ask(ctx, bare.id, { askId: 'e1', ref: { kind: 'workspace', workspaceId: space.id }, workspaceId: space.id, text: '', turns: [], agent: 'brainstorm' });
  const said = answerText(out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n'));
  assert.equal(card.cardOfAnswer(said), null, 'not a card');
  assert.equal(said, 'FAKE BRAINSTORM on "Start from this workspace." (no earlier turns).\n\nWhat part of that matters most to you?');
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

const { stripAgentReplies, OMITTED, REPLY_BUDGET } = require('../src/main/bart/strip.cjs');

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

test('strip: an @bart thread Bart handed to an agent is that agent\'s, its next @bart turns too; an older @bart line stays the router\'s (2026-10-12)', () => {
  const doc = [
    'bart# [brainstorm 2026-10-12T21:41:00Z] A plan', '@bart help me plan', 'bart> a card', '@bart and next?', 'bart> another card',
    '',
    'bart# [discover 2026-10-12T21:41:00Z] Papers', '@bart papers on tutors', 'bart> a guide',
    '',
    'bart# Old title', '@bart --build x', 'bart> **No Build.**',
  ].join('\n');
  assert.equal(stripAgentReplies(doc, 'brainstorm'), [
    '@bart help me plan', 'bart> a card', '@bart and next?', 'bart> another card',
    '',
    '@bart papers on tutors', OMITTED,
    '',
    '@bart --build x', OMITTED,
  ].join('\n'));
  assert.ok(stripAgentReplies(doc, 'discover').includes('bart> a guide'), '@discover keeps its own');
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

test('strip with show (2026-10-14): another agent\'s replies stay where they were, labelled with who wrote them, without the closing line; @brainstorm\'s own stay as they are', () => {
  const doc = [
    'My line.',
    '@chat how do the agents work?',
    'bart> Each line goes to one agent.',
    'bart>',
    'bart> - Chat answers.',
    'bart>',
    'bart> *Chat · Sonnet · high · 12 s*',
    '@chat was that too verbose?',
    'bart+> Yes, about twice as long as it needed to be.',
    'bart+> *Sonnet · high · 3 s*',
    '@discover what to read',
    'bart> ## Start here',
    'bart> *Discover · Sol · high · 41 s*',
    'bart# [chat build 2026-10-13T21:52:36Z] Fix',
    '@bart --build the fix',
    'bart> Here is the Build prompt.',
    'bart> *Build · Opus · high · 24 s*',
    'build> 1cf34a9fcd',
    '@create a chart',
    'bart~> other-run',
    'bart# [brainstorm 2026-10-14T22:12:13Z] Voice',
    '@brainstorm',
    'bart> Want to keep working on Bart\'s voice?',
    'bart> *Brainstorm · 8 s*',
    '@bart bart\'s voice',
    'bart~> NOW',
  ].join('\n');
  assert.equal(stripAgentReplies(doc, 'brainstorm', { show: true, askId: 'NOW' }), [
    'My line.',
    '@chat how do the agents work?', '<reply agent="Chat">', 'Each line goes to one agent.', '', '- Chat answers.', '</reply>',
    '@chat was that too verbose?', '<reply agent="Chat">', 'Yes, about twice as long as it needed to be.', '</reply>',
    '@discover what to read', '<reply agent="Discover">', '## Start here', '</reply>',
    '@bart --build the fix', '<reply agent="Chat">', 'Here is the Build prompt.', '</reply>',
    'build> 1cf34a9fcd',
    '@create a chart', '<reply agent="Create" status="still being written"/>',
    '@brainstorm', 'bart> Want to keep working on Bart\'s voice?', 'bart> *Brainstorm · 8 s*', '@bart bart\'s voice', 'bart~> NOW',
  ].join('\n'), 'in order, each as its agent\'s; a Build\'s line keeps only its id; its own thread untouched');
  assert.equal(stripAgentReplies(doc, 'router').split('\n').filter((line) => line === OMITTED).length, 7, 'the router still gets one marker per run, @brainstorm\'s too');
  assert.equal(stripAgentReplies(doc, 'brainstorm'), stripAgentReplies(doc, 'brainstorm', { show: false }), 'without show, as before');
});

test('strip with show: nearest the line being asked first, up to the budget; a reply farther away is left out with its size', () => {
  const said = (n) => 'x'.repeat(n);
  const doc = ['@chat first?', `bart> ${said(30)}`, '@chat second?', `bart> ${said(30)}`, '@chat third?', `bart> ${said(30)}`, '@brainstorm', 'bart~> NOW', '@chat after?', `bart> ${said(10)}`].join('\n');
  const shown = stripAgentReplies(doc, 'brainstorm', { show: true, askId: 'NOW', budget: 70 }).split('\n');
  assert.deepEqual(shown, [
    '@chat first?', '<reply agent="Chat" left_out="30 characters, farther from this line"/>',
    '@chat second?', '<reply agent="Chat">', said(30), '</reply>',
    '@chat third?', '<reply agent="Chat">', said(30), '</reply>',
    '@brainstorm', 'bart~> NOW',
    '@chat after?', '<reply agent="Chat">', said(10), '</reply>',
  ], 'third (nearest), after, second fit in 70; first does not');
  assert.equal(REPLY_BUDGET, 40000);
  const near = stripAgentReplies(doc, 'brainstorm', { show: true, askId: 'NOW', budget: 35 });
  assert.equal(near.split('\n').filter((line) => line === said(30)).length, 1, 'the nearest fits');
  assert.equal(near.split('\n').filter((line) => /left_out=/.test(line)).length, 3, 'once one does not fit, the farther ones are left out too, a smaller one among them');
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
  assert.match(c.documents, /@bart why\?\n<reply agent="Chat">\nbecause\n<\/reply>\n@brainstorm @\[TutorTrace\]\n<<< this is the question being asked now >>>/);
  assert.deepEqual(c.entries.map((entry) => [entry.name, entry.mentioned]), [['TutorTrace', true]], 'what it mentions; not another workspace\'s paper');
  assert.deepEqual(c.dirs, [proj.directory, ctx.dataRoot].filter(Boolean).concat(downloads), 'the mentioned paper\'s folder is readable, the other workspace\'s is not');
  assert.equal(turnPlan({ agent: 'brainstorm', text: '@[TutorTrace]', turns: [], entries: c.entries }, DEFAULTS).asked, '@[TutorTrace]', 'asked as written, with no path (2026-10-14)');
});

test('strip reads the document as the editor does', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const strip = require('../src/main/bart/strip.cjs');
  for (const name of ['BART_RE', 'REPLY_RE', 'PENDING_RE', 'TITLE_RE']) assert.equal(strip[name].source, model[name].source, name);
});

test('@brainstorm\'s context: this workspace\'s library and mentions only, other agents\' replies as theirs (2026-10-14); @bart\'s and @discover\'s as before', async () => {
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
  assert.match(brainstorm.documents, /@bart why\?\n<reply agent="Chat">\nbecause TutorTrace\n<\/reply>\n@brainstorm\n<<< this is the question being asked now >>>/, 'Chat\'s answer, as Chat\'s, where it was given');
  assert.match(brainstorm.documents, /@bart inner\?\n<reply agent="Chat">\ninner answer\n<\/reply>/, 'and in a mentioned note');
  assert.ok(!brainstorm.documents.includes('[agent reply omitted]'));

  const rows = await ctx.libraryDb.list();
  for (const agent of ['bart', 'discover']) {
    const c = await ask(agent);
    const madeIn = await projects.notesMadeIn(c.project.dir);
    assert.equal(c.contextJson, `<context_json>\n${JSON.stringify(catalogEntries(c.project, rows, new Set([mentioned.id]), { agent, madeIn }), null, 1)}\n</context_json>`, `${agent}: the whole project's library, as before`);
    assert.ok(names(c).some(([name]) => name === 'TutorTrace'));
    // A note every workspace let go of is out of every agent's context (2026-10-11, shared/project-holds.cjs).
    assert.ok(!names(c).some(([name]) => name === 'Thrown away'), `${agent}: not the note thrown away`);
    assert.match(c.documents, /@bart why\?\nbart> because TutorTrace\n@brainstorm/, `${agent}: the document as it stands`);
  }
  assert.equal((await ask('bart')).documents, `${(await ask('discover')).documents}\n\n<stage>none</stage>`);
});

test('ask-bart takes the agent, and a Brainstorm is an agent of its workspace like Bart; @orient is no agent of its own any more (M-01)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/ipc.cjs'), 'utf8');
  assert.match(src, /\['bart', 'brainstorm', 'discover', 'create'\]\.includes\(agent\)/, '@create too (2026-10-13)');
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
  // Only a research box's turn, the search, is told how far to trace (2026-10-14); a turn settling the direction is not.
  assert.equal(plan('why do agents loop').extra, '');
  assert.match(plan('--research why do agents loop').extra, /^<mode>standard\. Up to three starting points;[^<]*eight sources[^<]*<\/mode>\n\n<search>The direction is settled/);
  assert.ok(plan('--quick --research why do agents loop').extra.startsWith(`<mode>${MODE_LIMITS.quick}</mode>`));
  assert.deepEqual([plan('--research why').search, plan('why').search, plan('--research why').question], [true, false, 'why']);
  // Each mode keeps its total and gives essays a share of it (2026-10-03); no extra papers opened to look for code (gone 2026-10-15).
  assert.equal(MODE_LIMITS.quick, 'quick. Up to two starting points; one hop backward and one forward from each; at most five sources in the guide, of which up to two are essays when essays apply.');
  assert.equal(MODE_LIMITS.standard, 'standard. Up to three starting points; one hop backward and one forward from each; at most eight sources in the guide, of which two to three are essays when essays apply.');
  assert.equal(MODE_LIMITS.deep, 'deep. Up to five starting points; one hop backward and one forward from each, then one more of each from the best of what you found; at most fifteen sources in the guide, of which three to five are essays when essays apply.');
  const deep = plan('--research retries', [{ question: 'agents --deep', answer: 'Which part?' }, { question: 'retries', answer: 'I will look for…' }]);
  assert.deepEqual([deep.mode, /fifteen sources/.test(deep.extra), deep.steps[0].name, deep.steps[0].effort], ['deep', true, 'Opus', 'max'], 'the box under an answer carries the problem\'s --deep on, and its level');
  const quick = plan('--research only after 2022', [{ question: '--quick agents', answer: '## Start here' }]);
  assert.deepEqual([quick.mode, /five sources/.test(quick.extra), quick.steps[0].name, quick.steps[0].effort], ['quick', true, 'Sonnet', 'medium'], 'a follow-up on a quick guide stays quick');
  assert.equal(plan('').asked, 'Start from this workspace.', 'an empty line is the opening');
  assert.equal(plan('', []).question, '');
  assert.equal(plan('x', [{ question: '', answer: 'a' }]).prior.length, 1, 'an empty opening is a turn');
});

test('a models file left as 2026-09-30 wrote it: @discover\'s untouched step becomes the three levels, @brainstorm\'s untouched block the new one; a step of the person\'s own is the standard level, and a brainstorm step of their own stays and is read (2026-10-06)', () => {
  for (const withBase of [true, false]) {
    const shipped = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS[5]));
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
    const shipped = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS[6]));
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

test('Haiku and low effort for @bart (2026-10-12): Haiku first on Claude Code, low first in both providers\' efforts; ladders, Build, @brainstorm and @discover as they were', () => {
  const { DEFAULT_BUILD, normalizeBuild, normalizeDiscover } = require('../src/main/bart/models.cjs');
  const { normalizeBrainstorm } = require('../src/main/bart/models.cjs');
  const models = loadModels(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-haiku-')));
  assert.deepEqual(Object.keys(models.providers.anthropic.models), ['haiku', 'sonnet', 'opus', 'fable'], 'Haiku first, so it ranks lowest');
  assert.deepEqual(models.providers.anthropic.models.haiku, { id: 'claude-haiku-5-5', name: 'Haiku', use: 'Fastest. Routing, naming, short lookups.' }, 'named by version, as Sonnet is');
  assert.deepEqual(models.providers.anthropic.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(models.providers.openai.efforts, ['low', 'medium', 'high', 'xhigh', 'ultra']);
  assert.match(models.about, /Luna and Haiku: the fastest/);
  assert.match(models.about, /Low effort answers fastest/);
  // No ladder reaches Haiku or low: a plain question starts on Sonnet high, as before.
  assert.deepEqual(models.providers.anthropic.ladder, [{ model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }]);
  assert.deepEqual(models.providers.openai.ladder, [{ model: 'sol', effort: 'medium' }, { model: 'sol', effort: 'high' }, { model: 'astra', effort: 'xhigh' }]);
  assert.deepEqual(ladder('why?', models), ['Sonnet high', 'Opus high', 'Fable xhigh']);
  // Build: no Haiku and no low.
  assert.deepEqual(models.build, normalizeBuild(DEFAULT_BUILD));
  assert.deepEqual(Object.keys(models.build.providers.anthropic.models), ['sonnet', 'opus', 'fable']);
  assert.deepEqual([models.build.providers.anthropic.efforts, models.build.providers.openai.efforts], [['medium', 'high', 'xhigh', 'max'], ['medium', 'high', 'xhigh', 'ultra']]);
  assert.deepEqual(buildChoices(models).providers.anthropic.ladder, [{ model: 'opus', effort: 'high' }]);
  // @brainstorm and @discover normalize to their defaults, unchanged.
  assert.deepEqual(normalizeBrainstorm(DEFAULT_BRAINSTORM, models.providers).providers, DEFAULT_BRAINSTORM.providers);
  assert.deepEqual(normalizeDiscover(DEFAULT_DISCOVER, models.providers).providers, DEFAULT_DISCOVER.providers);
  assert.deepEqual([models.brainstorm.providers, models.discover.providers], [DEFAULT_BRAINSTORM.providers, DEFAULT_DISCOVER.providers]);
});

test('`@bart --haiku --low x` picks Haiku at low on Claude Code; a question after a Haiku pick climbs Sonnet high, Opus high, Fable xhigh (2026-10-12)', () => {
  const read = readQuestion('--haiku --low x', DEFAULTS);
  assert.deepEqual([read.question, read.pinned, read.provider, read.steps], ['x', true, 'anthropic', [{ provider: 'anthropic', key: 'haiku', model: 'claude-haiku-5-5', name: 'Haiku', effort: 'low' }]]);
  assert.deepEqual(readQuestion('x --Haiku-5.5 --LOW', DEFAULTS).steps.map((s) => `${s.name} ${s.effort}`), ['Haiku low'], 'matched loosely, from either end');
  assert.deepEqual(modelOf('claude-haiku-5-5', DEFAULTS), { provider: 'anthropic', model: 'haiku' });
  assert.deepEqual(ladder('why?', startingAt(DEFAULTS, 'bart', { provider: 'anthropic', model: 'haiku', effort: 'low' })), ['Haiku low', 'Sonnet high', 'Opus high', 'Fable xhigh']);
  assert.deepEqual(ladder('why?', startingAt(DEFAULTS, 'bart', { provider: 'anthropic', model: 'haiku', effort: 'max' })), ['Haiku max', 'Sonnet high', 'Opus high', 'Fable xhigh'], 'every later model is above Haiku');
  assert.deepEqual(ladder('why?', startingAt(DEFAULTS, 'bart', { provider: 'openai', model: 'sol', effort: 'low' })), ['Sol low', 'Sol medium', 'Sol high', 'Astra xhigh'], 'low is below every step on Codex');
  assert.deepEqual(ladder('--low why?', DEFAULTS), ['Sonnet low'], 'low alone keeps the model a question starts on');
  assert.deepEqual(ladder('why?', DEFAULTS), ['Sonnet high', 'Opus high', 'Fable xhigh'], 'a plain question still starts on Sonnet high');
});

test('a models file left as 2026-10-06 wrote it gains Haiku and low, with a base and without; Claude Code efforts the person edited stay theirs (2026-10-12)', () => {
  const shipped = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS.at(-1)));
  assert.deepEqual([Object.keys(shipped.providers.anthropic.models), shipped.providers.anthropic.efforts, shipped.providers.openai.efforts, !!shipped.brainstorm], [['sonnet', 'opus', 'fable'], ['medium', 'high', 'xhigh', 'max'], ['medium', 'high', 'xhigh', 'ultra'], true], 'the 10-06 shape');
  for (const withBase of [true, false]) {
    const how = withBase ? 'with a base' : 'without one';
    const write = (value) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-1012-'));
      fs.writeFileSync(path.join(root, MODELS_FILE), JSON.stringify(value));
      if (withBase) { fs.mkdirSync(path.join(root, '.defaults')); fs.writeFileSync(path.join(root, '.defaults', MODELS_FILE), JSON.stringify(shipped)); }
      return root;
    };
    const untouched = write(shipped);
    const models = loadModels(untouched);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(untouched, MODELS_FILE), 'utf8')), DEFAULT_MODELS, `the file is today's defaults, ${how}`);
    assert.deepEqual(Object.keys(models.providers.anthropic.models), ['haiku', 'sonnet', 'opus', 'fable'], how);
    assert.deepEqual([models.providers.anthropic.efforts[0], models.providers.openai.efforts[0]], ['low', 'low'], how);
    assert.deepEqual(ladder('why?', models), ['Sonnet high', 'Opus high', 'Fable xhigh'], how);

    const mine = JSON.parse(JSON.stringify(shipped));
    mine.providers.anthropic.efforts = ['high', 'max'];
    mine.providers.anthropic.models.sonnet.use = 'My own words.';
    const edited = write(mine);
    const theirs = loadModels(edited);
    const kept = JSON.parse(fs.readFileSync(path.join(edited, MODELS_FILE), 'utf8'));
    assert.deepEqual(kept.providers.anthropic.efforts, ['high', 'max'], `their Claude Code efforts stay, ${how}`);
    assert.deepEqual(kept.providers.openai.efforts, ['low', 'medium', 'high', 'xhigh', 'ultra'], `Codex's, left alone, gain low, ${how}`);
    assert.deepEqual(Object.keys(kept.providers.anthropic.models), ['haiku', 'sonnet', 'opus', 'fable'], `Haiku is added first beside their edit, ${how}`);
    assert.equal(kept.providers.anthropic.models.sonnet.use, 'My own words.');
    assert.deepEqual(theirs.providers.anthropic.efforts, ['high', 'max']);
    assert.deepEqual(readQuestion('--haiku --low x', theirs).steps.map((s) => `${s.name} ${s.effort}`), ['Haiku high'], 'low they do not offer is the nearest effort they do');
  }
});

test('@discover\'s system prompt is the one written for it, plus the resumed turn; a file replaces it', () => {
  for (const phrase of ['You are Discover',
    // The direction first, in conversation (2026-10-14): no cards; a search turn alone searches.
    'A turn without <search> is a conversation about what to research', 'Do not search, trace or write a guide in it', 'reply with one card and nothing else. Its title is "What would you like to research?"', 'its options are two to four topics the person could research, drawn from the workspace as a whole', 'Choose the central research interests the workspace supports, then give each a concise, precise label', 'Name the interest, not this project\'s own names for its features, agents or screens', 'Repeated copied text and agent-generated suggestions do not establish importance', 'Distinguish central interests from examples used to explore them', 'Familiar terms such as "conversational quality", "attention", "evaluation" and "transparency" are welcome', 'do not replace precise language with vague phrases merely to sound casual', 'A label may match a document title when that title accurately names the research interest; never choose something merely because it is a title', 'with no fixed word count', 'do not fill a quota', 'These examples show selection and wording; they are not fixed options', 'do not start from their labels', 'An option is its label alone: no "why", no subtitle or explanation, and nothing about which notes or features it came from', 'Do not invent topics to fill a card', 'work out yourself the concepts and terms the research uses for the problem', 'never with their label word for word', 'They never need to know the field\'s terms', '{"say": "", "card": "focus", "focus": {"title": "What would you like to research?", "options": [{"label": "<a topic>"}, {"label": "<another topic>"}]}, "ready": false}', 'your whole reply is exactly this one line, in plain text: What would you like to research?', 'Never say why you are not giving a card', 'Their answer to that card, picked "label" or their own words, says where their interest is, not yet what they want to learn about it', 'When they already make plain what the person wants to find out, go straight on', 'ask one short, natural question first, such as "What are you hoping to understand about concise replies?"', 'Never fill the gap yourself by naming several directions and treating them as what they want', 'Refining the direction: a turn with <refine> comes from Refine', 'let their latest words win wherever they disagree', 'it waits there until they start the search themselves', 'When their words could mean quite different searches, ask one short question first', '<refine>, on a turn that refines the direction', 'say in one or two plain sentences what you will look for, in their terms, as one direction', 'Not a list of possibilities you chose for them', '(skipped) means none fits: ask, in plain words, what they have in mind', 'Ask one useful question at a time', 'only when its answer would materially change what you search for', 'which concepts fit depends on what the workspace says about the topic, and no list of them is fixed', 'These show the kind of question, not a sequence to follow', 'a short neutral scenario, in a paragraph of its own', 'It must not carry the answer you expect', 'A clear request needs no question', 'a detail left unspecified is not a reason to ask', 'An explicit request for a broad overview is clear too', 'When they say "just search"', 'They may change direction at any point', 'There is no fixed number or order of questions, and no confirmation step', 'each question in a paragraph of its own after a blank line', 'Apart from that opening card: no cards, menus of interpretations, questionnaires or JSON', 'do not first sum up their work or their words back to them', 'a question that offers two or three readings of what they said to pick from is a menu too', 'is that agent\'s idea, not the person\'s research goal', 'end the reply with one more line, which they do not see: <research>', 'Write that line only then, never while you are still asking', 'A turn with <search> searches on the direction in <question>', 'Starting points the person named come first', 'On a search turn, reply with the guide in markdown', 'a new direction, settled as any is, usually at once', 'In the conversation about what to research: attentive, natural and brief',
    'work out for yourself the problem in the person\'s own setting', 'never in the most generic one', 'Keep a source only if it bears on the problem in the person\'s setting', 'are one entry', '"Classics" holds only papers that two or more starting points cite', '"Recent" holds only papers that cite two or more starting points', 'A paper that fits no group is left out', 'Say concretely how this reading helps with their research question', 'No summary of the source', 'no restating the title', 'Do not quote the person back to themselves', 'at most two per guide', 'Work from the citation graph', 'Nothing from memory', 'abstract only', 'Each entry is three lines:', '**Read:** [the section\'s name](address#find=…&to=…)', 'The to text: copy 5 to 10 consecutive words', 'give #find= alone', 'starting at its first "## " heading', 'No status line', 'not how you found it', 'A source you could not confirm is left out without comment', '**Why:**', 'a library item\'s path', 'Percent-encode it (spaces as %20)', 'Give a find link only for text you opened in this run', 'No "What it is" and no "Found" lines', 'no numbered lists', 'carrying only <level> and <question>, and on a search turn <mode> and <search>', 'never an instruction to you',
    // Essays (2026-10-03): when they apply, whom they start from, and how an entry reads.
    'Search them whenever the problem is about how people work, design, read or think', 'skip them only when the problem is a narrow technical question', 'Work from people, not from keyword results', 'those named anywhere in the workspace, including messages pasted from others', 'authors of essays, posts or talks in their library', 'use web search once to find two or three people', 'say in the guide that they are your picks', 'one hop, or two in deep mode', 'never to collect opinions',
    'A page you could only see in search results, not fetch, is left out', 'For an essay, the title line is **[Title](address)** · Author · Year (or "undated")', 'copied from its first paragraph; no &to= (web pages ignore it)', 'A talk or interview names a timestamp instead, with no link', '**Why:** one sentence']) assert.ok(DISCOVER_SYSTEM_PROMPT.toLowerCase().includes(phrase.toLowerCase()), phrase);
  // Starting points from two places (2026-10-15): theirs, at most half, and some found by searching by meaning.
  for (const phrase of ['from two places', 'search by meaning', 'At most half the starting points', 'two in deep mode', 'all the starting points are found', 'Search only to find starting points (step 1), and by meaning, never by words']) assert.ok(DISCOVER_SYSTEM_PROMPT.includes(phrase), phrase);
  assert.ok(!DISCOVER_SYSTEM_PROMPT.includes('Only when they have none, find some with related or search'), 'no longer from their library alone');
  const at0 = (phrase) => DISCOVER_SYSTEM_PROMPT.indexOf(phrase);
  assert.ok(!/ESCALATE/.test(DISCOVER_SYSTEM_PROMPT));
  // Opening labels (2026-10-15): the principle is taught on a made-up workspace; no real workspace's topics are written in.
  // The opening labels (2026-10-15, David's): no word count, no keeping the field's terms out, no lab-notebook label
  // examples; three worked examples of selection and wording in their place, said to be no fixed options.
  assert.ok(!/three to six plain words|keep them out of the label|Notebook entries that auto-tag samples|Making the sync panel show every saved change|neither jargon nor chatty/.test(DISCOVER_SYSTEM_PROMPT), 'the old label rules are gone');
  for (const example of ['"What makes an AI feel attentive"', '"Tracking sample histories"', '"Hints that support independent problem-solving"', 'Do not raise the isolated disagreement exercise above it', 'leave out the incidental styling task']) assert.ok(DISCOVER_SYSTEM_PROMPT.includes(example), example);
  assert.ok(!/Keep the person's setting/.test(DISCOVER_SYSTEM_PROMPT));
  assert.ok(!/At most one card|"type": "mcq"|Which part do you want prior work on|Skip the card|Options are broad/.test(DISCOVER_SYSTEM_PROMPT), 'one card only, the opening\'s (2026-10-14)');
  assert.ok(at0('\n# First, the direction') < at0('\n# The search') && at0('\n# The search') < at0('\n# Then, trace'), 'the direction, then the search, then the trace');
  // A pick is no longer settled at once, and the direction is said as one (2026-10-15): the old instructions are gone.
  assert.ok(!/which they often do|go straight on: say what you will look for|the two or three things the search will look for|say the reading guide will appear below/.test(DISCOVER_SYSTEM_PROMPT), 'no "pick, then search at once"');
  // No Try line and no looking for code (2026-10-15): an entry is three lines.
  assert.ok(!/Try line|\*\*Try:\*\*|look for code|GitHub repository|Code\. When|A repository never earns|a fourth when Code/i.test(DISCOVER_SYSTEM_PROMPT), 'no Try line');
  // A Why (2026-10-15): one sentence of about 20 to 30 words on how the reading helps with their question, never forced onto
  // a feature of the workspace; the old "open question in their work" is gone, and the verification rules stay.
  for (const phrase of ['**Why:** one sentence of about 20 to 30 words, as a guide, not a limit', 'a second only when a distinction that matters would otherwise be lost', 'name the concept, evidence, method or tension it offers', 'Do not force a link to a particular feature, document or step of their workspace', 'no filler such as "provides valuable insights"', 'never make a claim stronger to make it shorter', 'For the form only, never the content', 'ends its Why with "My pick."', 'Every paper in the guide must have come back from a paper tool in this run']) assert.ok(DISCOVER_SYSTEM_PROMPT.includes(phrase), phrase);
  assert.ok(!/which open question in their work it bears on/.test(DISCOVER_SYSTEM_PROMPT), 'no Why forced onto an open question of the workspace');
  const at = (phrase) => DISCOVER_SYSTEM_PROMPT.indexOf(phrase);
  assert.ok(at('Open what you recommend') < at('# What is real') && at('**Why:** one sentence') < at('For an essay, the title line'));
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
  // A Try line in an older guide (2026-10-04 to 2026-10-15) is kept as any line of the guide is.
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

test('search finds papers by meaning (2026-10-15): search.semantic alone, years kept, spaced a second apart, words on a refusal; by "words" as before', async () => {
  const seen = [], waits = [];
  let clock = 0, refuse = false;
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => body });
  const W = (n) => ({ id: `https://openalex.org/W${n}`, title: `Paper ${n}`, publication_year: 2023, cited_by_count: n, authorships: [] });
  const fetchImpl = async (url) => {
    const u = new URL(url); seen.push(u);
    if (u.pathname !== '/works') return reply(404, null);
    if (u.searchParams.has('search.semantic')) return refuse ? reply(400, { error: 'semantic search is not available' }) : reply(200, { meta: { count: 2 }, results: [W(1), W(2)] });
    if (u.searchParams.has('search')) return reply(200, { meta: { count: 1 }, results: [W(3)] });
    return reply(404, null);
  };
  const papers = papersLib.createPapers({ fetchImpl, wait: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock });
  const problem = 'Tutors notice when a student is stuck, before the student says so. How do they notice, and what do they do next?';
  const call = async (args) => JSON.parse((await papersLib.callTool(papers, 'search', args)).content[0].text);
  const found = await call({ query: problem, from_year: 2021 });
  const sent = seen[seen.length - 1];
  assert.equal(sent.searchParams.get('search.semantic'), problem, 'by meaning by default: the sentences as written');
  assert.ok(!sent.searchParams.has('search') && !sent.searchParams.has('sort'), 'never `search` beside it, and no sort');
  assert.equal(sent.searchParams.get('filter'), 'from_publication_date:2021-01-01', 'year filters work with it');
  assert.deepEqual([found.order, found.results.map((r) => r.id)], ['closest in meaning first (title and abstract)', ['W1', 'W2']]);
  await call({ query: 'x'.repeat(3000), limit: 50 });
  assert.equal(seen[seen.length - 1].searchParams.get('search.semantic').length, 2000, 'clipped to 2,000 characters');
  assert.equal(seen[seen.length - 1].searchParams.get('per_page'), '25', 'at most 25');
  assert.ok(waits.length === 1 && waits[0] >= 1100, 'the second semantic call waits out the 1.1 s');
  refuse = true;
  const fell = await call({ query: problem });
  assert.ok(seen[seen.length - 1].searchParams.has('search') && !seen[seen.length - 1].searchParams.has('search.semantic'), 'a 400: the words search');
  assert.match(fell.order, /^OpenAlex refused the search by meaning \(400\), so this matched words instead: /);
  assert.deepEqual(fell.results.map((r) => r.id), ['W3']);
  refuse = false;
  const words = await call({ query: 'tutor, noticing: struggle', by: 'words' });
  const asked = seen[seen.length - 1];
  assert.deepEqual([asked.searchParams.get('search'), asked.searchParams.has('search.semantic')], ['tutor noticing struggle', false], 'by words: `search`, as before');
  assert.match(words.order, /^relevance/);
  assert.deepEqual(papersLib.PAPER_TOOLS.find((tool) => tool.name === 'search').inputSchema.properties.by, { type: 'string', enum: ['meaning', 'words'] });
  assert.match(papersLib.PAPER_TOOLS.find((tool) => tool.name === 'search').description, /^Find papers by meaning: give one to three plain sentences stating the problem\./);
  // What the person sees while it searches.
  assert.equal(activity.paperTool('search', { query: 'Tutors noticing struggle' }), 'Finding papers close to “Tutors noticing struggle”');
  assert.equal(activity.paperTool('search', { query: 'tutor struggle', by: 'words' }), 'Searching papers for “tutor struggle”');
});

test('the real runner for @discover: file, web and paper tools, the paper server for both CLIs, its own Codex home, sessions and timeout; the direction handed back, and <mode> on the search turn alone (2026-10-14)', async () => {
  const authFile = path.join(homeDir, 'auth-discover.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const replies = ['I will look for how agents loop and how they are stopped. The reading guide will appear below.\n\n<research>why agents loop and how they are stopped</research>', GUIDE, GUIDE];
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
  // Settling the direction only talks (2026-10-15): no web and no paper tools until the research box searches.
  assert.match(calls[0].command, /-c 'tools\.web_search=false'/);
  assert.notEqual(calls[0].timeout, 45 * 60_000, 'an ordinary step\'s time: it does not search');
  assert.deepEqual([calls[0].env.ENGELBART_BART_MODEL, /model_reasoning_effort="ultra"/.test(calls[0].command)], ['gpt-6-astra', true], 'deep: Astra ultra');
  assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), DISCOVER_SYSTEM_PROMPT);
  assert.ok(!fs.readFileSync(path.join(home, 'config.toml'), 'utf8').includes('mcp_servers.papers'), 'no paper server');
  assert.ok(!calls[0].input.includes('<mode>') && !calls[0].input.includes('<search>'), 'settling the direction is no search');
  assert.match(calls[0].input, /\n\n<level>You are running as Astra at ultra effort, step 1 of 1\. No higher step exists\.<\/level>\n\n<question>\nagents\n<\/question>$/);
  assert.deepEqual([first.lines[0], first.research, discoverThreads.size(), brainstormThreads.size()], ['bart> I will look for how agents loop and how they are stopped. The reading guide will appear below.', 'why agents loop and how they are stopped', 1, 0], 'the tag handed back, not shown; kept among discover\'s own sessions');
  assert.ok(!first.lines.some((line) => line.includes('<research>')));

  // The research box under it is the search: the same session, told how far to trace and to search.
  const said = [{ question: 'agents --deep', answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') }];
  const second = await ask('d2', '--research why agents loop and how they are stopped', said);
  assert.match(calls[1].command, / resume /);
  assert.match(calls[1].command, /-c 'tools\.web_search=true'/);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), '# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.\n\n[mcp_servers.papers]\ncommand = "/Apps/Engelbart"\nargs = ["/Apps/papers-mcp.cjs"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nstartup_timeout_sec = 30\ntool_timeout_sec = 90\n', 'the search has the paper tools');
  assert.match(calls[1].input, /^<mode>deep\.[^\n]*<\/mode>\n\n<search>The direction is settled[^\n]*<\/search>\n\n/, 'the resumed search still says how far to trace');
  assert.match(calls[1].input, /<question>\nwhy agents loop and how they are stopped\n<\/question>$/, 'the direction, without the flag');
  assert.equal(second.research, undefined, 'a search hands back no direction');
  assert.deepEqual([calls[1].timeout, calls[1].env.ENGELBART_BART_MODEL], [45 * 60_000, 'gpt-6-astra'], 'and stays on the deep level');
  assert.deepEqual(second.lines.slice(0, 3), ['bart> ## Start here', 'bart>', 'bart> **[A paper](https://arxiv.org/abs/2401.00001)** · A. Author · 2024 · arXiv']);

  await ask('d3', '--opus --research only after 2022', []);
  const claude = calls[2];
  assert.match(claude.command, /--strict-mcp-config --mcp-config "\$ENGELBART_BART_MCP" --tools "Read,Grep,Glob,WebSearch,WebFetch" --allowedTools "Read,Grep,Glob,WebSearch,WebFetch,mcp__papers__\*" /);
  assert.deepEqual(claude.mcp, { mcpServers: { papers: { command: '/Apps/Engelbart', args: ['/Apps/papers-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
  assert.equal(fs.existsSync(claude.env.ENGELBART_BART_MCP), false, 'the config goes with the run');
  assert.match(claude.input, /<mode>standard\./);
  assert.equal(claude.timeout, 30 * 60_000, 'half an hour a standard step');
  assert.equal(claude.env.ENGELBART_BART_MODEL, 'opus', 'a model flag picks for its line');

  replies.push(GUIDE);
  const quick = await ask('d4', '--quick --research agents', []);
  const fast = calls[3];
  assert.deepEqual([fast.timeout, fast.env.ENGELBART_BART_MODEL, /model_reasoning_effort="medium"/.test(fast.command)], [30 * 60_000, 'gpt-6.1-sol', true], 'quick: Sol medium, half an hour');
  assert.match(fast.input, /<mode>quick\. Up to two starting points;[^<]*at most five sources in the guide, of which up to two are essays when essays apply\.<\/mode>\n\n<search>[^\n]*<\/search>\n\n<level>You are running as Sol at medium effort/);
  assert.match(quick.lines[quick.lines.length - 1], /^bart> \*Discover · Sol · medium · \d+ s\*$/, 'its foot still names the model');

  writeCodexConfig(home, {});
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), '# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.\n');
});

test('an empty @discover\'s plain reply is the question alone, whatever the model said before it; a card, or any later turn, as it came (2026-10-14)', async () => {
  const replies = [];
  const run = (shell, args, options, callback) => callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: replies.shift() })}\n`);
  const bart = createBart({ readModels: () => DEFAULTS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-opened'), run, discoverThreads: createThreads({ idleMs: DISCOVER_IDLE_MS }), node: '/Apps/Engelbart', papersServer: '/Apps/papers-mcp.cjs' });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const ask = (askId, text, reply) => { replies.push(reply); return bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns: [], agent: 'discover' }); };
  const body = (out) => out.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n');
  assert.equal(body(await ask('o1', '', 'Workspace is empty, so plain line.\n\nWhat would you like to research?')), 'What would you like to research?');
  const themed = JSON.stringify({ say: '', card: 'focus', focus: { title: 'What would you like to research?', options: [{ label: 'Voice' }, { label: 'Agents' }, { label: 'Viewer' }] }, ready: false });
  assert.equal(card.questionOf(card.cardOfAnswer(body(await ask('o2', '', themed)))).title, 'What would you like to research?', 'a card stays a card');
  // Its topics are labels alone, at most four (2026-10-15): a "why" the model wrote is dropped; a later turn's card is not touched.
  const whys = JSON.stringify({ say: '', card: 'focus', focus: { title: 'What would you like to research?', options: ['Concise, conversational replies', 'What makes an AI feel attentive', 'Evaluating conversational quality', 'Making agent activity understandable', 'A fifth'].map((label) => ({ label, why: 'From the notes on Bart.' })) }, ready: false });
  const plain = card.questionOf(card.cardOfAnswer(body(await ask('o4', '', `\`\`\`json\n${whys}\n\`\`\``))));
  assert.deepEqual(plain.options, [{ label: 'Concise, conversational replies' }, { label: 'What makes an AI feel attentive' }, { label: 'Evaluating conversational quality' }, { label: 'Making agent activity understandable' }]);
  assert.ok(card.questionOf(card.cardOfAnswer(body(await ask('o5', 'tutors', whys)))).options.every((option) => option.why), 'a later turn\'s card keeps them');
  assert.equal(body(await ask('o3', 'tutors', 'Tutors, then. What would you like to research?')), 'Tutors, then. What would you like to research?', 'only a bare opening');
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
  assert.deepEqual([calls[0].env.ENGELBART_BART_MODEL, /model_reasoning_effort="ultra"/.test(calls[0].command)], ['gpt-6-astra', true], 'at deep: Astra ultra (a deep search\'s time is its research box\'s)');
  assert.equal(first.meta.provider, 'openai');
  assert.match(first.lines[first.lines.length - 1], /^bart> \*Discover · Astra · ultra · \d+ s\*$/, 'the foot names it (A-02)');

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

test('the fake @discover settles the direction in conversation (2026-10-14): an empty line gets the card "What would you like to research?", a broad topic one question, an answer or a clear request the <research> line, which the window asks as a research box; the box writes the guide, and a follow-up additions', async () => {
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const run = async (doc, askId) => {
    const [thread] = model.threads(doc);
    const turns = thread.turns.filter((turn) => turn.answered).map((turn) => model.turnText(doc, turn));
    const out = await bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text: model.parseLine(doc[doc.length - 1]).text, turns, agent: 'discover' });
    const next = [...doc, ...out.lines];
    const [again] = model.threads(next);
    return { doc: next, card: card.cardOfAnswer(model.turnText(next, again.turns[again.turns.length - 1]).answer), lines: out.lines, research: out.research };
  };
  // What the window does with a direction (Workspace askBart): its research box under the reply, asked in turn.
  const box = (at, askId) => run([...at.doc, model.researchLine(at.research)], askId);
  const at = await run(['@discover'], 'dv1');
  const which = card.questionOf(at.card);
  assert.deepEqual([which.type, which.title, at.card.say, at.research], ['focus', 'What would you like to research?', '', undefined], 'the opening card, and no search');
  assert.deepEqual(which.options, [{ label: 'Fake theme one' }, { label: 'Fake theme two' }, { label: 'Fake theme three' }], 'labels alone');
  // A pick only says where their interest is (2026-10-15): one short question, no search yet; the answer settles it.
  const pickedTheme = await run([...at.doc, `@discover ${card.answerLine(at.card, { picks: ['Fake theme two'] })}`], 'dv1b');
  assert.deepEqual([pickedTheme.lines[0], pickedTheme.research], ['bart> FAKE DISCOVER: What are you hoping to understand about fake theme two?', undefined], 'a pick: one question');
  const pickAnswered = await run([...pickedTheme.doc, '@discover when being brief starts hurting understanding'], 'dv1c');
  assert.equal(pickAnswered.research, 'Fake theme two; when being brief starts hurting understanding', 'the pick and the answer, together');
  const broad = await run([...at.doc, '@discover tutors'], 'dv2');
  assert.deepEqual([broad.lines[0], broad.research], ['bart> FAKE DISCOVER: What are you hoping the research will help you figure out?', undefined], 'a broad topic: one question');
  const settled = await run([...broad.doc, '@discover how they help novices debug'], 'dv3');
  assert.equal(settled.research, 'tutors; how they help novices debug', 'the answer settles it');
  assert.ok(settled.lines[0].startsWith('bart> FAKE DISCOVER will look for work on') && !settled.lines.some((line) => line.includes('<research>')), 'the tag is not shown');
  const own = await box(settled, 'dv4');
  assert.deepEqual([own.lines[0], own.research], ['bart> ## Start here', undefined], 'the box writes the guide, and hands back no direction');
  assert.equal(own.lines[2], 'bart> **[A fake record for “tutors; how they help novices debug”](https://example.org/fake-named)** · Fake Author et al. · 2024', 'the direction the conversation reached starts the guide');
  // An older exchange's card, answered now: read as said, and settled.
  const carded = await run(['@discover', `bart> \`\`\`json`, `bart> ${JSON.stringify(FOCUS)}`, 'bart> ```', '@discover picked "Retries"'], 'dv5');
  assert.deepEqual([carded.lines[0], carded.research], ['bart> FAKE DISCOVER: What are you hoping to understand about retries?', undefined]);
  // A clear request: no question, the line at once.
  const clear = await run(['@discover find papers on why coding agents retry the same failing step'], 'dv6');
  assert.equal(clear.research, 'find papers on why coding agents retry the same failing step');
  const guide = await box(clear, 'dv7');
  assert.equal(guide.card, null, 'the guide is not a card');
  assert.equal(guide.lines[0], 'bart> ## Start here');
  assert.ok(guide.lines.some((line) => /\(standard mode\)/.test(line)));
  assert.ok(!guide.lines.some((line) => /Not verified/.test(line)), 'no "Not verified" group');
  // Three lines an entry (2026-09-30): the title, Read with a link to the passage, Why.
  const entry = guide.lines.slice(2, 5).map((line) => line.replace(/^bart> ?/, ''));
  assert.match(entry[0], /^\*\*\[[^\]]+\]\([^)\s]+\)\*\* · Fake Author et al\. · 2024$/);
  assert.match(entry[1], /^\*\*Read:\*\* \[Introduction\]\([^)\s]+#find=a%20fake%20passage[^)\s&]*&to=the%20fake%20section%20after%20it\)$/);
  assert.match(entry[2], /^\*\*Why:\*\* Helps you examine a fake method bearing on /, 'how the reading helps, in one short sentence (2026-10-15)');
  assert.ok(!entry[2].includes('Agents'), 'tied to no part of the workspace');
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
  assert.match(essay[2], /^\*\*Why:\*\* Helps you examine a fake case that cuts against what is assumed bearing on /);
  const essayLink = splitTarget(essay[1].match(/\]\(([^)\s]+)\)$/)[1]);
  assert.deepEqual([essayLink.address, essayLink.find, essayLink.to], ['https://example.org/fake-essay', 'the fake first paragraph of the essay', ''], 'the Stage opens the page and finds its words');
  assert.equal(guide.lines.filter((line) => /^bart> \*\*\[/.test(line)).length, 3, 'a starting paper, a classic and an essay: within the mode\'s total');
  // The classic was read in full: three lines, with no Try line after Why (gone 2026-10-15).
  const classicAt = guide.lines.indexOf('bart> ## Classics');
  const classic = guide.lines.slice(classicAt + 2, classicAt + 6).map((line) => line.replace(/^bart> ?/, ''));
  assert.match(classic[1], /^\*\*Read:\*\* \[Implementation\]\(https:\/\/example\.org\/fake-classic#find=a%20fake%20passage%20on%20how%20it%20was%20built&to=/);
  assert.match(classic[2], /^\*\*Why:\*\* /);
  assert.equal(classic[3], '', 'one blank line after Why');
  assert.equal(guide.lines.filter((line) => /^bart> \*\*Try:\*\*/.test(line)).length, 0, 'no Try line anywhere');
  const fakeGuide = guide.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n');
  assert.equal(replyBody('discover', fakeGuide), fakeGuide, 'replyBody keeps the guide whole');
  const more = await run([...guide.doc, '@discover only after 2022'], 'dv8');
  assert.equal(more.research, 'only after 2022', 'a follow-up on a guide is a new direction, settled at once');
  assert.equal((await box(more, 'dv9')).lines[0], 'bart> ## Recent', 'its search gets additions');
  // A redirect while it is still asking: the new direction, with what was said since.
  const moved = await run([...broad.doc, '@discover actually, find studies on rubber-duck debugging instead'], 'dv10');
  assert.equal(moved.research, 'tutors; actually, find studies on rubber-duck debugging instead');
  const parsed = model.parseLine('@Discover why');
  assert.deepEqual([parsed.agent, model.agentOf(parsed), model.agentOf(model.parseLine('@chat why')), model.agentOf(model.parseLine('@bart why'))], ['discover', 'discover', 'bart', 'router']);
  projects.agentStarted(ctx, { id: 'dv-agent', kind: 'discover', projectId: project.id, workspaceId: workspace.id });
  projects.agentFinished(ctx, 'dv-agent');
});

test('@discover on a named paper (2026-10-04): no question first, the paper opened whole first, "## This paper" before the trace from it, its sections in pairs of Read and Why', () => {
  for (const phrase of ['A paper: when <question> names one (a library item mentioned on the line', 'a title, a DOI or an arXiv id', 'that paper is the direction; words beside it say which part they care about',
    '# A named paper', 'When <question> names a paper, open all of it before anything else: the library file from its path, else an open-access copy', 'up to four, best first, not in the paper\'s order', 'Never the abstract, and the introduction only when nothing else serves', 'This paper is the only starting point', 'backward through what it cites in the sections you chose, forward through what cites it', 'A library paper the paper tools do not know is still the guide\'s first entry, from the file you opened',
    '"This paper" holds only the paper <question> names', 'When there is a "This paper" group, there is no "Start here"', '"Classics" holds papers the named paper cites in the sections you chose', '"Recent" holds papers that cite it and bear on the same part', 'The named paper counts as one of the sources <mode> allows',
    'The "This paper" entry is the title line, then, for each section you chose, best first, a pair of lines', '**Why:** as for any entry.', 'One Read link per pair.', 'If only the abstract could be reached, the entry is the title line, "**Read:** abstract only" and one Why, and the trace goes on',
    'A follow-up that names a paper gets that paper\'s guide']) assert.ok(DISCOVER_SYSTEM_PROMPT.includes(phrase), phrase);
  const at = (phrase) => DISCOVER_SYSTEM_PROMPT.indexOf(phrase);
  assert.ok(at('\n# First, the direction') < at('A paper: when <question> names one') && at('A paper: when') < at('\n# The search'), 'P-01 in "First, the direction"');
  assert.ok(at('# Then, trace') < at('# A named paper') && at('Open what you recommend') < at('# A named paper') && at('# A named paper') < at('# What is real'), 'P-02: its own section, after the trace');
  assert.ok(at('"## This paper", "## Start here", "## Classics"') > at('# The guide'), 'P-03: "This paper" is the first group');
  assert.ok(at('"Classics" holds only papers that two or more starting points cite') < at('When there is a "This paper" group'), 'the rules for a problem stay, those for a paper follow them');
  assert.ok(at('**Why:** one sentence') < at('The "This paper" entry') && at('The "This paper" entry') < at('For an essay, the title line'));
});

test('replyBody drops a foot the model copied from the conversation (2026-10-13), for every agent: @brainstorm too since its replies are prose (2026-10-14)', () => {
  assert.equal(replyBody('bart', 'Yes.\n\n*Chat · Opus · high*'), 'Yes.');
  assert.equal(replyBody('bart', 'Yes.\n\n*Chat · Opus · high · 7 s*\n\n'), 'Yes.', 'a whole foot too, and the blank lines around it');
  assert.equal(replyBody('bart', 'Yes.\n\n*see p. 4*'), 'Yes.\n\n*see p. 4*', 'ordinary italics at the end are kept');
  assert.equal(replyBody('bart', '*Chat · Opus · high*\n\nYes.'), '*Chat · Opus · high*\n\nYes.', 'only at the end');
  assert.equal(replyBody('create', 'Made it.\n\n*Create · Opus · high*'), 'Made it.');
  assert.equal(replyBody('brainstorm', 'That is the distinction.\n\n*Brainstorm · 4 s*'), 'That is the distinction.');
  assert.equal(replyBody('discover', '## Start here\n\nx\n\n*Discover · Sol · high*'), '## Start here\n\nx');
  assert.equal(replyBody('discover', 'Opened it.\n## Start here\n\nx\n*Build · Opus*'), '## Start here\n\nx', 'with the status line before the guide');
  assert.equal(replyBody('bart', 'Yes.\n'), 'Yes.\n', 'nothing to drop: kept as it came');
});

test('replyBody keeps a guide that starts at "## This paper", and drops what was written before it', () => {
  const named = '## This paper\n\n**[Retries](/Users/h/Retries.pdf)** · A. Author · 2024\n**Read:** [5 Findings](/Users/h/Retries.pdf#find=We%20found&to=In%20this%20section)\n**Why:** a measurement.\n**Read:** [3 Method](/Users/h/Retries.pdf#find=We%20built)\n**Why:** a method.\n**Try:** [ada/retries](https://github.com/ada/retries)\n\n## Classics\n\nx';
  assert.equal(replyBody('discover', named), named);
  assert.equal(replyBody('discover', `Opened the paper; tracing now.\n\n${named}`), named, 'a status line before it goes');
});

test('the fake @discover on a mentioned library paper: settled at once, its box "## This paper" with two sections, each its own Read and Why into the library copy, then Classics, Recent and Essays; words beside it or a follow-up the same (P-05)', async () => {
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
    return { doc: next, card: card.cardOfAnswer(model.turnText(next, again.turns[again.turns.length - 1]).answer), lines: out.lines, research: out.research, text: out.lines.map((line) => line.replace(/^bart> ?/, '')) };
  };
  // A line that names a paper is settled at once (2026-10-14); the window asks its research box, which writes the guide.
  const ask = async (doc, askId) => {
    const said = await run(doc, `${askId}-d`);
    assert.ok(said.research, `${doc[doc.length - 1]}: settled at once`);
    return run([...said.doc, model.researchLine(said.research)], askId);
  };
  const named = await ask(['@discover @[Retries Considered]'], 'np1');
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
  assert.equal(named.text.filter((line) => line.startsWith('**Try:**')).length, 0, 'no Try line (2026-10-15)');
  const body = named.text.slice(0, -2).join('\n');
  assert.equal(replyBody('discover', body), body, 'replyBody keeps it whole');
  // With words beside it, the same guide; a workspace's mention names no paper.
  const worded = await ask(['@discover @[Retries Considered] how they measured recovery'], 'np2');
  assert.deepEqual([worded.card, worded.text[0]], [null, '## This paper']);
  assert.equal((await ask([`@discover what @[Reading](ws:${space.id}) is about`], 'np3')).text[0], '## Start here', 'A-04: no paper named, as before');
  assert.equal((await ask(['@discover find papers on why retries loop'], 'np4')).text[0], '## Start here', 'A-04: a problem, as before');
  // A follow-up that names a paper gets its guide; one that does not gets additions.
  const first = await ask(['@discover find papers on why retries loop'], 'np5');
  const follow = await ask([...first.doc, '@discover @[Retries Considered]'], 'np6');
  assert.equal(follow.text[0], '## This paper');
  assert.equal((await ask([...follow.doc, '@discover only after 2022'], 'np7')).text[0], '## Recent');
});

test('@brainstorm and @discover: a resumed turn is sent no <stage> or <highlights> of the Stage, as before', async () => {
  for (const [agent, opening, reply, told] of [['brainstorm', '', 'What is on your mind about it?', /^<level>[^\n]*<\/level>\n\n<question>\n\(skipped\)\n<\/question>$/], ['discover', 'agents', 'Which part of agents?', /^<level>[^\n]*<\/level>\n\n<question>\n\(skipped\)\n<\/question>$/]]) {
    const { calls, options } = stageRunner(`stage-${agent}`, reply);
    const bart = createBart({ ...options, brainstormThreads: createThreads(), discoverThreads: createThreads() });
    const ref = { kind: 'workspace', workspaceId: workspace.id };
    const stage = { kind: 'web', url: 'https://example.org/essay', title: 'An essay' };
    const first = await bart.ask(ctx, project.id, { askId: `${agent}1`, ref, workspaceId: workspace.id, text: opening, agent, stage });
    const said = [{ question: opening, answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') }];
    await bart.ask(ctx, project.id, { askId: `${agent}2`, ref, workspaceId: workspace.id, text: '(skipped)', turns: said, agent, stage: null });
    assert.match(calls[1].command, / resume /, agent);
    assert.match(calls[1].input, told, agent);
    for (const call of calls) assert.ok(!/<stage>none|<stage source=|<stage paper=|<highlights/.test(call.input), agent);
  }
});

/* --------------------------------------------------- files inside a library folder (MATH-22) */

test('MATH-22: a folder reaches the agents with its path, and every agent is told the files the documents point at', async () => {
  const { firstMessage } = require('../src/main/bart/ask.cjs');
  const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
  const { DISCOVER_SYSTEM_PROMPT } = require('../src/main/bart/discover-system-prompt.cjs');
  const proj = await projects.createProject(ctx, 'Folders');
  const here = await projects.createWorkspace(ctx, proj.id, { name: 'Reading' });
  const folder = fs.mkdtempSync(path.join(homeDir, 'papers-'));
  fs.mkdirSync(path.join(folder, 'sub dir'));
  fs.writeFileSync(path.join(folder, 'sub dir', 'Smith (2024) #1 é.pdf'), '%PDF-1.4');
  const id = require('node:crypto').randomUUID();
  await ctx.libraryDb.insert({ id, name: 'Papers', project_id: proj.id, tags: [], type: 'folder', folder_path: folder });
  await projects.linkToWorkspace(ctx, proj.id, here.id, [id]);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const token = model.fileMention('Smith (2024) #1 é.pdf', id, 'sub dir/Smith (2024) #1 é.pdf');
  await projects.writeDoc(ctx, proj.id, { kind: 'workspace', workspaceId: here.id }, `Look at ${token} and ${model.fileMention('Gone.pdf', id, 'Gone.pdf')}\n@bart what does this say?\nbart~> f1\n`);
  const real = fs.realpathSync(folder);
  for (const agent of ['bart', 'brainstorm', 'discover']) {
    const c = await buildContext(ctx, proj.id, { ref: { kind: 'workspace', workspaceId: here.id }, workspaceId: here.id, askId: 'f1', agent });
    const entry = JSON.parse(c.contextJson.replace(/^<context_json>\n|\n<\/context_json>$/g, '')).find((e) => e.name === 'Papers');
    assert.deepEqual([entry.path, entry.mentioned], [path.resolve(folder), true], `${agent}: the folder's path, mentioned`);
    assert.deepEqual(c.files, [
      { path: path.join(real, 'sub dir', 'Smith (2024) #1 é.pdf'), folder: 'Papers', exists: true },
      { path: path.join(real, 'Gone.pdf'), folder: 'Papers', exists: false },
    ], `${agent}: the files pointed at, absolute`);
    assert.match(c.mentionedFiles, /^<mentioned_files>\n[\s\S]*Smith \(2024\) #1 é\.pdf[\s\S]*\n<\/mentioned_files>$/);
    assert.ok(c.dirs.some((dir) => real === dir || real.startsWith(dir + path.sep) || path.resolve(folder) === dir), `${agent}: the folder may be read`);
    assert.match(c.documents, /<file name="Smith \(2024\) #1 é\.pdf" type="pdf" folder="Papers" path="[^"]+Smith \(2024\) #1 é\.pdf" \/>/);
    const sent = firstMessage({ context: c, prior: [], question: 'what does this say?', resumed: false })('<level/>');
    assert.ok(sent.indexOf('<mentioned_files>') > sent.indexOf('</context_json>') && sent.indexOf('<mentioned_files>') < sent.indexOf('<workspace'), `${agent}: sent after the library`);
  }
  for (const prompt of [BART_SYSTEM_PROMPT, BRAINSTORM_SYSTEM_PROMPT, DISCOVER_SYSTEM_PROMPT]) assert.match(prompt, /<mentioned_files>.*the files the person pointed at; open them/);
  const none = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, askId: 'x', agent: 'bart' });
  assert.equal(none.mentionedFiles, '', 'nothing pointed at, no block');
});

// ---- A conversation's title (2026-10-12): bart/name-chat.cjs, and title lines kept out of what agents read ----

const nameChatModule = require('../src/main/bart/name-chat.cjs');

test('title lines are kept out of what agents read, as answer lines are', async () => {
  const { stripAgentReplies, stripTitles, TITLE_RE } = require('../src/main/bart/strip.cjs');
  const text = ['Notes', 'bart# Retry logic', '@bart why retry?', 'bart> because', '', 'bart#+ Folded', '@brainstorm plan', 'bart> {}', 'After'].join('\n');
  const stripped = stripAgentReplies(text);
  assert.ok(!stripped.includes('Retry logic') && !stripped.includes('Folded'), 'no title line');
  assert.ok(stripped.includes('Notes') && stripped.includes('After'));
  assert.equal(stripTitles(text), ['Notes', '@bart why retry?', 'bart> because', '', '@brainstorm plan', 'bart> {}', 'After'].join('\n'));
  assert.ok(TITLE_RE.test('bart# ') && TITLE_RE.test('bart#+ x') && !TITLE_RE.test('# bart') && !TITLE_RE.test('bart> x'));
  // The context an agent is sent has no title line, whether it reads the other agents' answers or not.
  const titled = await projects.createWorkspace(ctx, project.id, { name: 'Titled' });
  const ref = { kind: 'workspace', workspaceId: titled.id };
  await projects.writeDoc(ctx, project.id, ref, `${text}\nbart# \n@bart and now?\nbart~> t1\n`);
  for (const agent of ['bart', 'brainstorm', 'discover']) {
    const context = await buildContext(ctx, project.id, { ref, workspaceId: titled.id, askId: 't1', agent });
    assert.ok(!/bart#/.test(context.documents), `${agent}: no title line in its context`);
    assert.ok(context.documents.includes('@bart and now?'), `${agent}: the question is there`);
  }
});

test('naming runs on the question\'s provider and its lowest model at low effort: Haiku on Claude Code, Luna on Codex', async () => {
  const { createNameChat, providerOf, namingStep, NAME_PROMPT, NAME_TIMEOUT_MS } = nameChatModule;
  const models = normalizeModels(null);
  assert.equal(providerOf('why retry?', 'bart', models), 'anthropic');
  assert.equal(providerOf('--luna why retry?', 'bart', models), 'openai', 'a Codex model flag');
  assert.equal(providerOf('--codex retries', 'discover', models), 'openai', "@discover's provider flag");
  assert.equal(providerOf('', 'brainstorm', { ...models, provider: 'openai' }), 'openai');
  assert.deepEqual(namingStep(models, 'anthropic'), { provider: 'anthropic', key: Object.keys(models.providers.anthropic.models)[0], model: 'claude-haiku-5-5', name: models.providers.anthropic.models[Object.keys(models.providers.anthropic.models)[0]].name, effort: 'low' });
  assert.equal(namingStep(models, 'openai').model, 'gpt-6-luna');

  // Claude Code: one run, no tools, no session, the prompt as its system prompt, 15 s at most.
  const calls = [];
  const claudeRun = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], env: options.env, timeout: options.timeout, system: fs.readFileSync(options.env.ENGELBART_NAME_PROMPT, 'utf8'), input: fs.readFileSync(options.env.ENGELBART_NAME_INPUT, 'utf8') });
    callback(null, `${JSON.stringify({ type: 'result', is_error: false, result: '"**Retry logic in the client.**"' })}\n`);
  };
  const viaClaude = createNameChat({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'name-runs'), run: claudeRun });
  const named = await viaClaude({ text: 'why does the @[Client](lib:abc) retry? --opus', provider: 'anthropic' });
  assert.equal(named.title, 'Retry logic in the client');
  assert.equal(named.model, 'claude-haiku-5-5');
  assert.equal(named.effort, 'low');
  assert.equal(named.named, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.ENGELBART_NAME_MODEL, 'claude-haiku-5-5');
  assert.match(calls[0].command, /--effort low/);
  assert.match(calls[0].command, /--tools ""/);
  assert.match(calls[0].command, /--no-session-persistence/);
  assert.equal(calls[0].timeout, NAME_TIMEOUT_MS);
  assert.equal(NAME_TIMEOUT_MS, 15000);
  assert.equal(calls[0].system, NAME_PROMPT);
  assert.equal(NAME_PROMPT, 'Name this conversation in 2–6 words, sentence case, no quotes or final period.');
  assert.match(calls[0].input, /Why does the Client retry\?/, 'the mention as its name, the flag gone');
  assert.match(calls[0].input, /Do not answer it\. Name this conversation .* Reply with the title alone\.$/);
  assert.deepEqual(fs.readdirSync(path.join(homeDir, 'name-runs')), [], 'its files are gone');

  // Codex: Luna at low effort, reading what it wrote.
  const authFile = path.join(homeDir, 'auth-name.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const codexCalls = [];
  const codexRun = (shell, args, options, callback) => {
    codexCalls.push({ command: args[args.length - 1], env: options.env, timeout: options.timeout });
    fs.writeFileSync(options.env.ENGELBART_NAME_OUTPUT, 'Retry logic\n');
    callback(null, '');
  };
  const viaCodex = createNameChat({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'name-runs-codex'), codexHome: path.join(homeDir, 'codex-home-name'), codexAuthFile: authFile, run: codexRun });
  const fromCodex = await viaCodex({ text: 'why retry?', provider: 'openai' });
  assert.equal(fromCodex.title, 'Retry logic');
  assert.equal(fromCodex.model, 'gpt-6-luna');
  assert.equal(codexCalls[0].env.ENGELBART_NAME_MODEL, 'gpt-6-luna');
  assert.match(codexCalls[0].command, /model_reasoning_effort="low"/);
  assert.match(codexCalls[0].command, /--ephemeral/);
  assert.equal(codexCalls[0].timeout, 15000);
});

test('when naming fails the title is the opening message as a title reads, 60 characters at most; a title is 60 characters at most', async () => {
  const { createNameChat, createFakeNameChat, fallbackTitle, capTitle, cleanTitle, MAX_TITLE } = nameChatModule;
  const models = normalizeModels(null);
  const failing = createNameChat({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'name-runs-fail'), run: (s, a, o, callback) => callback(Object.assign(new Error('timed out'), { killed: true }), '') });
  const fell = await failing({ text: 'why does the client retry three times before giving up?', provider: 'anthropic' });
  assert.equal(fell.title, 'Why does the client retry three times before giving up?');
  const longer = await failing({ text: `@chat --opus Compare **retries** in @[TutorTrace](lib:abc-1) with [the guide](https://x.y/z) ${'and every other deployment we ran '.repeat(150)}`, provider: 'anthropic' });
  assert.ok(longer.title.length <= 60, longer.title);
  assert.ok(longer.title.startsWith('Compare retries in TutorTrace with the guide and every'), longer.title);
  assert.ok(!/[*@[\]()]|--/.test(longer.title), 'mentions as names; agent token, flags and markdown gone');
  assert.equal(fell.named, false);
  const empty = createNameChat({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'name-runs-empty'), run: (s, a, o, callback) => callback(null, `${JSON.stringify({ type: 'result', is_error: false, result: '  ' })}\n`) });
  assert.equal((await empty({ text: 'short one', provider: 'anthropic' })).title, 'Short one');
  const long = createNameChat({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'name-runs-long'), run: (s, a, o, callback) => callback(null, `${JSON.stringify({ type: 'result', is_error: false, result: 'A very long title that keeps going well past what a single row of the card can show' })}\n`) });
  const capped = await long({ text: 'one', provider: 'anthropic' });
  assert.ok(capped.title.length <= MAX_TITLE, capped.title);
  assert.equal(MAX_TITLE, 60);
  assert.equal(capped.title, 'One', 'more than ten words is an answer, not a title: the fallback');
  assert.equal(capped.named, false);
  const wide = createNameChat({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'name-runs-wide'), run: (s, a, o, callback) => callback(null, `${JSON.stringify({ type: 'result', is_error: false, result: 'Interoperability considerations for internationalization infrastructure modernization' })}\n`) });
  const cut = await wide({ text: 'x', provider: 'anthropic' });
  assert.ok(cut.named && cut.title.length <= MAX_TITLE, cut.title);
  assert.equal(cut.title, 'Interoperability considerations for internationalization');
  assert.equal(capTitle('x'.repeat(80)).length, 60);
  assert.equal(cleanTitle('Title: "## Retry *logic*."'), 'Retry logic');
  assert.equal(fallbackTitle('@bart --codex **why** retry'), 'Why retry');
  assert.equal(fallbackTitle(''), 'New conversation');
  const fake = createFakeNameChat({ readModels: () => models });
  const faked = await fake({ text: 'one two three four five six seven', provider: 'openai' });
  assert.equal(faked.title, 'One two three four five six seven');
  assert.equal(faked.model, 'gpt-6-luna');
});

/* ----------------------------------------------------------- a Brainstorm conversation's topic (2026-10-14) */

test('topicOf: a Brainstorm conversation\'s title, read up from its pending line through its turns and the mentions under them; none unset, untitled or another agent\'s', () => {
  const { topicOf } = require('../src/main/bart/strip.cjs');
  const doc = [
    'Notes.',
    'bart# [brainstorm 2026-10-14T20:13:23Z] Bart\'s voice',
    '@brainstorm',
    'bart> Looks like you\'ve been working on Bart\'s voice.',
    'bart>',
    'bart> What did you want to talk through?',
    '@bart Bart\'s voice',
    'bart> What about its voice are you still figuring out?',
    '@brainstorm see @[Note]',
    '',
    '<file name="Note" type="md">',
    'inside',
    '</file>',
    '',
    'bart~> now',
    '',
    'bart# [brainstorm 2026-10-14T21:00:00Z] ',
    '@brainstorm',
    'bart~> bare',
    'bart# [brainstorm 2026-10-14T21:00:00Z] New conversation',
    '@brainstorm',
    'bart~> old',
    'bart# [chat 2026-10-14T21:00:00Z] Chat things',
    '@chat why?',
    'bart~> chat',
    'Plain line.',
    '@brainstorm untitled',
    'bart~> untitled',
  ].join('\n');
  assert.equal(topicOf(doc, 'now'), 'Bart\'s voice', 'through follow-ups and a mention placed under one');
  assert.equal(topicOf(doc, 'bare'), null, 'a bare line\'s conversation has none yet');
  assert.equal(topicOf(doc, 'old'), null, '"New conversation" is no topic');
  assert.equal(topicOf(doc, 'chat'), null, 'another agent\'s conversation');
  assert.equal(topicOf(doc, 'untitled'), null, 'a plain line stops the search: no title above its own question');
  assert.equal(topicOf(doc, 'missing'), null);
  assert.equal(topicOf(doc, null), null);
});

test('takeTopic: Brainstorm\'s <topic> tag leaves its reply, its label read as a title reads; the block reaches the question, fresh or resumed', () => {
  const { takeTopic, firstMessage } = require('../src/main/bart/ask.cjs');
  assert.deepEqual(takeTopic('What about its voice are you still figuring out?\n\n<topic>bart\'s voice</topic>'), { text: 'What about its voice are you still figuring out?', topic: 'Bart\'s voice' });
  assert.deepEqual(takeTopic('First.\n<topic>A</topic>\n<topic>**Onboarding flow.**</topic>'), { text: 'First.', topic: 'Onboarding flow' }, 'the last one counts');
  assert.deepEqual(takeTopic('No tag.  '), { text: 'No tag.  ', topic: null }, 'a reply with none is left exactly as it came');
  assert.deepEqual(takeTopic('Hi\n<topic>   </topic>'), { text: 'Hi', topic: null });
  const fresh = firstMessage({ context: { head: '<engelbart>' }, prior: [], question: 'go on', resumed: false, agent: 'brainstorm', topic: 'Bart\'s <voice>' })('<level>x</level>');
  assert.match(fresh, /<level>x<\/level>\n\n<topic>Bart's voice<\/topic>\n\n<question>\ngo on\n<\/question>$/);
  const resumed = firstMessage({ context: { now: '' }, prior: [], question: 'go on', resumed: true, agent: 'brainstorm', topic: 'Bart\'s voice' })('<level>x</level>');
  assert.ok(resumed.includes('<topic>Bart\'s voice</topic>\n\n<question>'), 'a resumed turn is told it too');
  assert.ok(!firstMessage({ context: { now: '' }, prior: [], question: 'go on', resumed: true })('').includes('<topic>'), 'none without one');
});

test('a Brainstorm conversation\'s topic: unset after a bare line, marked once the person names it, sent as <topic> after that, and changed by "New topic: …"', async () => {
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 5 });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const ask = async (lines, askId, text) => {
    await projects.writeDoc(ctx, project.id, ref, lines.join('\n'));
    return bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, agent: 'brainstorm' });
  };
  const title = (said) => `bart# [brainstorm 2026-10-14T20:13:23Z] ${said}`.trimEnd();
  const bare = await ask([title(''), '@brainstorm', 'bart~> t1', ''], 't1', '');
  assert.equal(bare.topic, undefined, 'a bare line chooses no topic');
  assert.ok(!bare.lines.some((line) => line.includes('<topic>')));
  const named = await ask([title(''), '@brainstorm', 'bart> What did you want to talk through?', '@brainstorm Bart\'s voice', 'bart~> t2', ''], 't2', 'Bart\'s voice');
  assert.equal(named.topic, 'Bart\'s voice', 'the topic the person named, from the reply\'s tag');
  assert.ok(!named.lines.some((line) => line.includes('<topic>')), 'the tag is not in the document');
  const kept = await ask([title('Bart\'s voice'), '@brainstorm', 'bart> What did you want to talk through?', '@brainstorm Bart\'s voice', 'bart> What about it?', '@brainstorm its personality', 'bart~> t3', ''], 't3', 'its personality');
  assert.equal(kept.topic, undefined, 'given <topic>, a subquestion leaves it');
  const changed = await ask([title('Onboarding'), '@brainstorm', 'bart> What did you want to talk through?', '@brainstorm Bart\'s voice', 'bart> What about it?', '@brainstorm New topic: Onboarding', 'bart~> t4', ''], 't4', 'New topic: Onboarding');
  assert.equal(changed.topic, undefined, 'the chip already says the new topic: nothing to mark');
  const typedChange = await ask([title('Bart\'s voice'), '@brainstorm', 'bart> Hi.', '@brainstorm New topic: Onboarding', 'bart~> t5', ''], 't5', 'New topic: Onboarding');
  assert.equal(typedChange.topic, 'Onboarding', 'a change the conversation names is marked');
});

test('@brainstorm\'s prompt says what <topic> is and when to mark one, never to mention it', () => {
  for (const phrase of [
    '- <topic>, when the conversation has one: the short label on its topic chip', 'It is context, not a limit: their latest message comes first',
    'A turn that reads "New topic: …" is the person changing topic with the chip', '# The conversation\'s topic',
    'end your reply with one more line: <topic>a short label of a few words</topic>', 'not after a bare "@brainstorm" before they have chosen, not for a subquestion or a passing tangent',
    'Never mention the label or the chip in your reply.',
  ]) assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(phrase), phrase);
});

test('@discover\'s steps told as its trace (2026-10-15): by part, each by what came back and by title; the library\'s papers found there; lookups after the trace one check; Codex\'s events too', () => {
  const { createTrace, libraryMatcher } = require('../src/main/bart/trace.cjs');
  const H = { id: 'W1', title: 'How Do AI Agents Do Human Work? Comparing AI and Human Workflows', arxiv: 'https://arxiv.org/abs/2510.22780', doi: '10.48550/arxiv.2510.22780' };
  const G = { id: 'W2', title: 'Creating General User Models from Computer Use', doi: null };
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: name.includes('__') || /^[A-Z]/.test(name) ? name : `mcp__papers__${name}`, input }] } });
  const back = (id, value, error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }] } });
  const trace = createTrace({ entries: [{ name: 'Agents at work', type: 'website', tags: ['paper'], url: 'https://arxiv.org/abs/2510.22780' }] });
  const take = (...events) => { let story = null; for (const event of events) story = trace.take(event) || story; return story; };
  assert.equal(trace.take({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Grep', input: {} }] } }), null, 'other tools are not part of it');
  let story = take(use('a', 'resolve', { query: '2510.22780' }));
  assert.deepEqual([story.groups[0].lines, story.now], [[{ text: 'Looking up “2510.22780”', now: true }], 'Looking up “2510.22780”']);
  story = take(back('a', { found: true, paper: H }), use('b', 'search', { query: 'People want their work across tools.' }), back('b', { total: 25, results: [G, ...Array.from({ length: 24 }, (_, n) => ({ id: `W${100 + n}`, title: `Other ${n}` }))] }), use('c', 'resolve', { query: 'W2' }), back('c', { found: true, paper: G }), use('c2', 'resolve', { query: 'W105' }), back('c2', { found: true, paper: { id: 'W105', title: 'Other 5' } }));
  assert.deepEqual(story.groups[0], { key: 'start', title: 'Starting papers', lines: [
    { text: 'Found “How Do AI Agents Do Human Work?” in your library', now: false },
    { text: 'Searched for papers close to your problem', now: false },
    { text: 'Picked “Creating General User Models from Computer Use”, the closest of 25', now: false },
    { text: 'Picked “Other 5”, the 7th closest of 25', now: false },
  ] });
  story = take(use('d', 'references', { id: 'W1' }), back('d', { of: H, total: 41, listed: 41, results: [{ id: 'W7', title: 'Verdant: notebooks' }, { id: 'W8', title: 'SensePath: Understanding the Sensemaking Process' }, { id: 'W9', title: 'A third' }, { id: 'W10', title: 'A fourth' }] }), use('e', 'references', { id: 'W2' }), back('e', { of: G, total: 0, results: [] }), use('f', 'resolve', { query: 'W7' }), use('g', 'resolve', { query: 'W8' }));
  assert.deepEqual(story.groups[1].lines.map((line) => [line.text, line.now]), [['Listed the 41 papers “How Do AI Agents Do Human Work?” cites', false], ['“Creating General User Models from Computer Use” cites no paper OpenAlex knows', false], ['Checking whether “Verdant” and “SensePath” fit', true]], 'the lookups after it: one line, still waiting');
  story = take(back('f', { found: true, paper: { id: 'W7', title: 'Verdant: notebooks' } }), back('g', { found: true, paper: { id: 'W8', title: 'SensePath: Understanding the Sensemaking Process' } }));
  assert.equal(story.groups[1].lines[2].text, 'Checked whether “Verdant” and “SensePath” fit');
  story = take(use('h', 'resolve', { query: 'W9' }), use('i', 'resolve', { query: 'W10' }), use('j', 'resolve', { query: 'W11' }));
  assert.deepEqual([story.groups[1].lines.length, story.groups[1].lines[2].text], [3, 'Checking whether “Verdant”, “SensePath” and 3 more fit'], 'more lookups with no step between: the same check, five named as two and a count');
  take(back('h', { found: false, query: 'W9' }), back('i', {}), back('j', 'The lookup failed: timeout', true));
  story = take(use('k', 'citations', { id: 'W1' }), back('k', { of: H, total: 9, results: [] }), use('l', 'citations', { id: 'W2' }));
  assert.deepEqual([story.groups.map((group) => group.title), story.latest], [['Starting papers', 'Papers they cite', 'Newer papers that cite them'], 'cited']);
  assert.deepEqual(story.groups[2].lines.map((line) => line.text), ['Found 9 newer papers that cite “How Do AI Agents Do Human Work?”', 'Finding newer papers that cite “Creating General User Models from Computer Use”']);
  assert.deepEqual([story.now, story.last], ['Finding newer papers that cite “Creating General User Models from Computer Use”', 'Finding newer papers that cite “Creating General User Models from Computer Use”']);
  // The papers read, by title when the address is one it knows; the web by its host.
  story = take(back('l', 'OpenAlex is busy', true), use('m', 'WebFetch', { url: 'https://arxiv.org/html/2510.22780v2' }), back('m', 'text'), use('m2', 'Read', { file_path: '/tmp/webfetch-1792-x.pdf' }), back('m2', 'pdf', true), use('n', 'WebSearch', { query: 'agents at work essay' }), use('o', 'WebFetch', { url: 'https://www.example.com/post' }), back('o', 'text'));
  assert.equal(story.groups[2].lines[1].text, 'Couldn’t find newer papers that cite “Creating General User Models from Computer Use”');
  assert.deepEqual(story.groups.slice(3).map((group) => [group.title, group.lines.map((line) => line.text)]), [['Reading the papers', ['Read “How Do AI Agents Do Human Work?”', 'Couldn’t read a pdf it downloaded']], ['Essays and posts', ['Searching the web for “agents at work essay”', 'Read example.com']]]);
  // Codex: mcp_tool_call items, started then completed, their result as { content }.
  const codex = createTrace({ entries: [] });
  codex.take({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'papers', tool: 'references', arguments: '{"id":"W2"}' } });
  const told = codex.take({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'papers', tool: 'references', result: { content: [{ type: 'text', text: JSON.stringify({ of: G, total: 1, results: [] }) }] } } });
  assert.deepEqual(told.groups, [{ key: 'cites', title: 'Papers they cite', lines: [{ text: 'Listed the 1 paper “Creating General User Models from Computer Use” cites', now: false }] }]);
  codex.take({ type: 'item.started', item: { id: 'i3', type: 'mcp_tool_call', server: 'papers', tool: 'citations', arguments: { id: 'W2' } } });
  assert.equal(codex.take({ type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', server: 'papers', tool: 'citations', result: { content: [{ type: 'text', text: JSON.stringify({ of: G, total: 1, results: [] }) }] } } }).groups[1].lines[0].text, 'Found 1 newer paper that cites “Creating General User Models from Computer Use”');
  assert.equal(codex.take({ type: 'item.started', item: { id: 'i2', type: 'mcp_tool_call', server: 'engelbart', tool: 'save_file', arguments: {} } }), null);
  // The library: by arXiv id, DOI or the same title.
  const mine = libraryMatcher([{ name: 'Retries Considered.pdf', type: 'pdf', path: '/x/Retries Considered.pdf' }, { name: 'x', url: 'https://doi.org/10.1145/3290605.3300234' }]);
  assert.deepEqual([mine({ title: 'Retries considered' }), mine({ title: 'Other', doi: '10.1145/3290605.3300234' }), mine({ title: 'Other', doi: '10.1/2' })], [true, true, false]);
});

test('a Refine turn (2026-10-15): told the direction last searched and that its words win, until the next search; its line is told as a correction; no paper tools or web while it talks', () => {
  const turns = [
    { question: 'concise replies', answer: 'What are you hoping to understand about concise replies?' },
    { question: 'when being brief starts hurting understanding', answer: 'I will look for research on when shorter replies help understanding.' },
    { question: '--deep --research when shorter replies help understanding and when they leave too much out', answer: '## Start here\n\nx' },
  ];
  const refine = turnPlan({ agent: 'discover', text: '--refine focus on what makes replies feel conversational, rather than their length', turns }, DEFAULTS);
  assert.deepEqual([refine.refine, refine.refining, refine.search, refine.asked], [true, true, false, 'focus on what makes replies feel conversational, rather than their length']);
  assert.equal(refine.extra, '<refine>The person is refining the research direction. The direction last searched: when shorter replies help understanding and when they leave too much out. Their latest words take precedence over anything said before.</refine>');
  assert.equal(refine.mode, 'deep', 'the depth the last search ran at');
  // Discover asked a question about it: the answer is still part of the refining.
  const answered = turnPlan({ agent: 'discover', text: 'the turn-taking', turns: [...turns, { question: '--refine something else', answer: 'What should the search look at instead?' }] }, DEFAULTS);
  assert.deepEqual([answered.refine, answered.refining], [false, true]);
  assert.match(answered.extra, /^<refine>/);
  assert.equal(answered.shown[3].question, 'Refine the research direction: something else', 'the line told as a correction, without its flag');
  // Its research box searches as any does; and a turn after that search is no longer refining.
  const box = turnPlan({ agent: 'discover', text: '--research what makes replies feel conversational', turns: [...turns, { question: '--refine x', answer: 'I will look.' }] }, DEFAULTS);
  assert.deepEqual([box.search, box.refining], [true, false]);
  assert.match(box.extra, /^<mode>deep\./);
  const after = turnPlan({ agent: 'discover', text: 'more on that', turns: [...turns, { question: '--refine x', answer: 'I will look.' }, { question: '--research y', answer: '## Start here' }] }, DEFAULTS);
  assert.deepEqual([after.refining, after.extra], [false, '']);
  // A plain turn with no Refine before it is not refining.
  assert.deepEqual([turnPlan({ agent: 'discover', text: 'tutors', turns: [] }, DEFAULTS).refining, turnPlan({ agent: 'discover', text: 'tutors', turns: [] }, DEFAULTS).extra], [false, '']);
});
