'use strict';

// Settings › Intelligence (2026-10-06, MATH-53): the default model and effort per agent and provider, written into the
// models file (src/main/bart/settings.cjs), and the last action winning over a pick by hand (src/main/bart/choices.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { MODELS_FILE, DEFAULT_MODELS, DEFAULT_BRAINSTORM, normalizeModels, withFirstStep, loadModels, buildChoices, resolveBuildChoice, readQuestion, readDiscover, readBrainstorm } = require('../src/main/bart/models.cjs');
const { CHOICES_FILE, readChoices, rememberChoice, forgetChoice } = require('../src/main/bart/choices.cjs');
const { modelsInForce, settingsModels, saveSettingsModels, createModelSettings, cliNotes } = require('../src/main/bart/settings.cjs');
const { createFakeBart, turnPlan } = require('../src/main/bart/ask.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-settings-'));
const readFile = (root, name = MODELS_FILE) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const steps = (models, text = 'why?') => readQuestion(text, models).steps.map((step) => `${step.name} ${step.effort}`);
const DEFAULTS = normalizeModels(null);

test('forgetChoice drops one place\'s pick and keeps the others, written whole; nothing to forget writes nothing', () => {
  const root = home();
  assert.equal(forgetChoice(root, 'bart'), false);
  assert.equal(fs.existsSync(path.join(root, CHOICES_FILE)), false, 'no file is made to forget nothing');
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'high' });
  rememberChoice(root, 'build', { provider: 'openai', model: 'astra', effort: 'xhigh' });
  rememberChoice(root, 'quick', { provider: 'anthropic', model: 'fable', effort: 'max' });
  const before = fs.statSync(path.join(root, CHOICES_FILE)).mtimeMs;
  assert.equal(forgetChoice(root, 'elsewhere'), false, 'not a place');
  assert.equal(fs.statSync(path.join(root, CHOICES_FILE)).mtimeMs, before);
  assert.equal(forgetChoice(root, 'build'), true);
  assert.deepEqual(readChoices(root), { bart: { provider: 'anthropic', model: 'opus', effort: 'high' }, quick: { provider: 'anthropic', model: 'fable', effort: 'max' } });
  assert.equal(forgetChoice(root, 'build'), false, 'gone already');
  assert.match(readFile(root, CHOICES_FILE).about, /cleared for a place when you set its default in Settings/);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), [], 'no temporary left behind');
  forgetChoice(root, 'bart'); forgetChoice(root, 'quick');
  assert.deepEqual(readChoices(root), {});
});

test('@bart\'s default is its ladder\'s first step, then every step of the built-in ladder above it, so the ladder still only goes up (S-03)', () => {
  const claude = DEFAULTS.providers.anthropic, codex = DEFAULTS.providers.openai;
  const ladder = (provider, entry, step) => withFirstStep(provider, entry, step).map((rung) => `${rung.model} ${rung.effort}`);
  assert.deepEqual(ladder('anthropic', claude, { model: 'sonnet', effort: 'medium' }), ['sonnet medium', 'sonnet high', 'opus high', 'fable xhigh'], 'below the first: every built-in step stays');
  assert.deepEqual(ladder('anthropic', claude, { model: 'sonnet', effort: 'high' }), ['sonnet high', 'opus high', 'fable xhigh'], 'the built-in first step: the built-in ladder');
  assert.deepEqual(ladder('anthropic', claude, { model: 'sonnet', effort: 'max' }), ['sonnet max', 'opus high', 'fable xhigh'], 'a later model is above whatever the effort');
  assert.deepEqual(ladder('anthropic', claude, { model: 'opus', effort: 'high' }), ['opus high', 'fable xhigh'], 'at step 2: step 2 goes');
  assert.deepEqual(ladder('anthropic', claude, { model: 'opus', effort: 'max' }), ['opus max', 'fable xhigh'], 'above step 2, below step 3');
  assert.deepEqual(ladder('anthropic', claude, { model: 'fable', effort: 'medium' }), ['fable medium', 'fable xhigh']);
  assert.deepEqual(ladder('anthropic', claude, { model: 'fable', effort: 'max' }), ['fable max'], 'above them all: a ladder of one');
  assert.deepEqual(ladder('openai', codex, { model: 'luna', effort: 'ultra' }), ['luna ultra', 'sol medium', 'sol high', 'astra xhigh']);
  assert.deepEqual(ladder('openai', codex, { model: 'sol', effort: 'high' }), ['sol high', 'astra xhigh']);
  // From the built-in ladder, not the saved one: steps a ladder of one lost come back.
  assert.deepEqual(ladder('anthropic', { ...claude, ladder: [{ model: 'fable', effort: 'xhigh' }] }, { model: 'sonnet', effort: 'xhigh' }), ['sonnet xhigh', 'opus high', 'fable xhigh']);
  assert.deepEqual(ladder('anthropic', { ...claude, ladder: [{ model: 'opus', effort: 'max' }, { model: 'fable', effort: 'max' }] }, { model: 'opus', effort: 'max' }), ['opus max', 'fable xhigh'], 'a saved step that is not built in goes');
  // Only what the file still lists: a model or an effort taken out of it is not climbed to.
  const { fable, ...noFable } = claude.models;
  assert.deepEqual(ladder('anthropic', { ...claude, models: noFable }, { model: 'sonnet', effort: 'high' }), ['sonnet high', 'opus high']);
  assert.deepEqual(ladder('openai', { ...codex, efforts: ['medium', 'high'] }, { model: 'luna', effort: 'high' }), ['luna high', 'sol medium', 'sol high']);
});

// A press on a model in a cell's ModelGrid, as the panel makes it: the effort the grid gives that model (effortFor, from
// the cell's ladder), saved at once.
function pressModel(root, provider, key) {
  const { cellModels, patchOf } = load('model/intelligence.js');
  const { effortFor } = load('post-its/ModelGrid.jsx');
  const cell = cellModels(settingsModels(root).models, 'bart', provider);
  return saveSettingsModels(root, patchOf('bart', provider, { model: key, effort: effortFor(cell, key) }));
}
const ladderOn = (root, provider) => readFile(root).providers[provider].ladder.map((rung) => `${rung.model} ${rung.effort}`);

test('picking Fable and then Sonnet in @bart\'s Claude Code cell keeps the ladder whole: Sonnet, then Opus and Fable above it', () => {
  const root = home();
  loadModels(root);
  assert.deepEqual(ladderOn(root, 'anthropic'), ['sonnet high', 'opus high', 'fable xhigh']);
  pressModel(root, 'anthropic', 'fable');
  assert.deepEqual(ladderOn(root, 'anthropic'), ['fable xhigh'], 'Fable Extra high is the top: nothing above it');
  pressModel(root, 'anthropic', 'sonnet');
  assert.deepEqual(ladderOn(root, 'anthropic'), ['sonnet xhigh', 'opus high', 'fable xhigh'], 'not Sonnet alone: Opus and Fable come back');
  assert.deepEqual(steps(modelsInForce(root)), ['Sonnet xhigh', 'Opus high', 'Fable xhigh'], 'and a run climbs them');
  saveSettingsModels(root, { bart: { anthropic: { model: 'sonnet', effort: 'high' } } });
  assert.deepEqual(readFile(root).providers.anthropic.ladder, DEFAULT_MODELS.providers.anthropic.ladder, 'back to the built-in first step: the built-in ladder');
});

test('picking Astra and then Sol in @bart\'s Codex cell keeps the ladder whole too', () => {
  const root = home();
  loadModels(root);
  pressModel(root, 'openai', 'astra');
  assert.deepEqual(ladderOn(root, 'openai'), ['astra xhigh']);
  pressModel(root, 'openai', 'sol');
  assert.deepEqual(ladderOn(root, 'openai'), ['sol xhigh', 'astra xhigh'], 'Astra stays above Sol');
  pressModel(root, 'openai', 'luna');
  assert.deepEqual(ladderOn(root, 'openai'), ['luna xhigh', 'sol medium', 'sol high', 'astra xhigh'], 'every built-in step above Luna');
  saveSettingsModels(root, { bart: { openai: { model: 'sol', effort: 'medium' } } });
  assert.deepEqual(readFile(root).providers.openai.ladder, DEFAULT_MODELS.providers.openai.ladder);
  assert.deepEqual(ladderOn(root, 'anthropic'), ['sonnet high', 'opus high', 'fable xhigh'], 'Claude Code\'s untouched');
});

test('settingsModels: the file normalized with every provider, the last picks, the usable CLIs, the providers offered, and why a CLI cannot run', () => {
  const root = home();
  rememberChoice(root, 'bart', { provider: 'openai', model: 'sol', effort: 'high' });
  const tools = { usableAgents: () => ['claude'], snapshot: () => ({ tools: { claude: { installed: true, status: 'ready' }, codex: { installed: true, status: 'signed-out' } } }) };
  const read = settingsModels(root, { only: ['anthropic'], tools });
  assert.deepEqual(read.models, loadModels(root), 'before startingAt and preferUsable');
  assert.deepEqual(Object.keys(read.models.providers), ['openai', 'anthropic'], 'every provider, whatever config.json offers');
  assert.equal(read.models.provider, 'anthropic', 'the last pick on Codex does not move it');
  assert.deepEqual([read.choices, read.usable, read.offered, read.cli], [{ bart: { provider: 'openai', model: 'sol', effort: 'high' } }, ['claude'], ['anthropic'], { openai: 'signed out', anthropic: null }]);
  assert.deepEqual(settingsModels(root, { only: [] }).offered, ['openai', 'anthropic'], 'a list that names none: all, as a run has them');
  assert.deepEqual(settingsModels(root).cli, { openai: null, anthropic: null }, 'before the first check nothing is greyed');
  const record = (status, installed = true) => ({ usableAgents: () => [], snapshot: () => ({ tools: { claude: { installed, status }, codex: { installed: false, status: 'missing' } } }) });
  assert.deepEqual(cliNotes(DEFAULTS.providers, record('outdated')), { openai: 'not installed', anthropic: 'out of date' });
  assert.deepEqual(cliNotes(DEFAULTS.providers, record('failed')), { openai: 'not installed', anthropic: 'cannot run' });
});

test('saveSettingsModels checks every pick against that provider\'s models and efforts first: a bad one refuses the whole save and writes nothing', () => {
  const root = home();
  loadModels(root);
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'high' });
  const file = fs.readFileSync(path.join(root, MODELS_FILE), 'utf8'), choices = fs.readFileSync(path.join(root, CHOICES_FILE), 'utf8');
  for (const [patch, error] of [
    [null, /settings must be an object/],
    [{ theme: 'dark' }, /theme is not a setting/],
    [{ provider: 'mistral' }, /provider must be one of openai, anthropic/],
    [{ buildProvider: 3 }, /buildProvider must be one of/],
    [{ bart: { anthropic: { model: 'sol', effort: 'high' } } }, /@bart on anthropic must be one of its provider's models and efforts/],
    [{ bart: { anthropic: { model: 'opus', effort: 'ultra' } } }, /must be one of its provider's models and efforts/],
    [{ bart: { mistral: { model: 'opus', effort: 'high' } } }, /@bart's provider must be one of/],
    [{ bart: 'opus' }, /@bart must name providers/],
    [{ brainstorm: { openai: { model: 'luna' } } }, /@brainstorm on openai/],
    [{ discover: { anthropic: { model: 'opus', effort: 'high' } } }, /@discover's level must be one of quick, standard, deep/],
    [{ discover: { anthropic: 'deep' } }, /@discover on anthropic must name its levels/],
    [{ discover: { openai: { deep: { model: 'astra', effort: 'max' } } } }, /@discover deep on openai/],
    [{ build: { anthropic: { model: 'opus', effort: 'low' } } }, /Build on anthropic/],
    // One good pick and one bad: neither is written, and no pick is forgotten.
    [{ provider: 'openai', bart: { openai: { model: 'sol', effort: 'high' } }, brainstorm: { anthropic: { model: 'rm -rf', effort: 'high' } } }, /@brainstorm on anthropic/],
  ]) {
    assert.throws(() => saveSettingsModels(root, patch), error, JSON.stringify(patch));
    assert.equal(fs.readFileSync(path.join(root, MODELS_FILE), 'utf8'), file, `nothing written: ${JSON.stringify(patch)}`);
    assert.equal(fs.readFileSync(path.join(root, CHOICES_FILE), 'utf8'), choices, `nothing forgotten: ${JSON.stringify(patch)}`);
  }
  // Build's picks are checked against Build's own list, @bart's against @bart's.
  const edited = readFile(root);
  edited.build.providers.openai.models = { sol: edited.build.providers.openai.models.sol };
  fs.writeFileSync(path.join(root, MODELS_FILE), JSON.stringify(edited));
  assert.throws(() => saveSettingsModels(root, { build: { openai: { model: 'astra', effort: 'high' } } }), /Build on openai/);
  assert.doesNotThrow(() => saveSettingsModels(root, { bart: { openai: { model: 'astra', effort: 'high' } } }));
});

test('saveSettingsModels writes only what changes into the file as it is on disk: abouts, edits and keys Engelbart does not know stay', () => {
  const root = home();
  loadModels(root);
  const mine = readFile(root);
  mine.about = 'My own notes on this file.';
  mine.providers.openai.models.sol.use = 'My words.';
  mine.discover.about = 'Mine too.';
  mine.mySetting = { anything: [1, 2] };
  mine.build.providers.anthropic.note = 'kept';
  fs.writeFileSync(path.join(root, MODELS_FILE), JSON.stringify(mine, null, 2));
  const out = saveSettingsModels(root, {
    provider: 'anthropic', // unchanged: not written
    buildProvider: 'openai',
    bart: { anthropic: { model: 'opus', effort: 'max' } },
    brainstorm: { openai: { model: 'astra', effort: 'xhigh' } },
    discover: { anthropic: { standard: { model: 'fable', effort: 'high' }, deep: { model: 'opus', effort: 'max' } } }, // deep is the default already
    build: { openai: { model: 'luna', effort: 'medium' } },
  });
  const now = readFile(root);
  const expected = JSON.parse(JSON.stringify(mine));
  expected.build.provider = 'openai';
  expected.providers.anthropic.ladder = [{ model: 'opus', effort: 'max' }, { model: 'fable', effort: 'xhigh' }];
  expected.brainstorm.providers.openai = { model: 'astra', effort: 'xhigh' };
  expected.discover.providers.anthropic.standard = { model: 'fable', effort: 'high' };
  expected.build.providers.openai.default = { model: 'luna', effort: 'medium' };
  assert.deepEqual(now, expected);
  assert.deepEqual(Object.keys(now), Object.keys(mine), 'in the order it had');
  assert.deepEqual(out, settingsModels(root), 'the save answers what the panel reads next');
  assert.deepEqual([out.models.build.provider, out.models.providers.anthropic.ladder[0], out.models.brainstorm.providers.openai, out.models.discover.providers.anthropic.standard], ['openai', { model: 'opus', effort: 'max' }, { model: 'astra', effort: 'xhigh' }, { model: 'fable', effort: 'high' }]);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(loadModels(root), out.models, 'the next load keeps it: what Settings wrote is the person\'s, not a default to carry over');

  // Nothing that changes: the file is not touched.
  const before = fs.readFileSync(path.join(root, MODELS_FILE), 'utf8');
  saveSettingsModels(root, { bart: { anthropic: { model: 'opus', effort: 'max' } }, brainstorm: { anthropic: DEFAULT_BRAINSTORM.providers.anthropic } });
  assert.equal(fs.readFileSync(path.join(root, MODELS_FILE), 'utf8'), before);
});

test('saveSettingsModels on a file without a brainstorm block, with an old one-step @discover entry or with values that do not run: those are read as defaults and the save lands (A4)', () => {
  const root = home();
  const old = JSON.parse(JSON.stringify(DEFAULT_MODELS));
  delete old.brainstorm;
  old.discover.providers.openai = { model: 'sol', effort: 'xhigh' }; // 2026-09-30's shape, edited
  old.providers.openai.ladder = [{ model: 'gone', effort: 'high' }];
  fs.mkdirSync(path.join(root, '.defaults'));
  fs.writeFileSync(path.join(root, '.defaults', MODELS_FILE), JSON.stringify(DEFAULT_MODELS)); // up to date: nothing is carried
  fs.writeFileSync(path.join(root, MODELS_FILE), JSON.stringify(old));
  const read = settingsModels(root);
  assert.deepEqual(read.models.brainstorm.providers, DEFAULT_BRAINSTORM.providers, 'no block (deleted, so it stays deleted): the defaults');
  assert.deepEqual(read.models.discover.providers.openai.standard, { model: 'sol', effort: 'xhigh' }, 'the old step is the standard level');
  assert.deepEqual(read.models.providers.openai.ladder, DEFAULT_MODELS.providers.openai.ladder, 'a ladder of nothing listed: the default');
  saveSettingsModels(root, { brainstorm: { anthropic: { model: 'opus', effort: 'high' } }, discover: { openai: { quick: { model: 'luna', effort: 'medium' } } }, bart: { openai: { model: 'luna', effort: 'high' } } });
  const now = readFile(root);
  assert.deepEqual(now.brainstorm, { providers: { anthropic: { model: 'opus', effort: 'high' } } });
  assert.deepEqual(now.discover.providers.openai, { quick: { model: 'luna', effort: 'medium' }, standard: { model: 'sol', effort: 'xhigh' }, deep: DEFAULT_MODELS.discover.providers.openai.deep });
  assert.deepEqual(now.providers.openai.ladder, [{ model: 'luna', effort: 'high' }, ...DEFAULT_MODELS.providers.openai.ladder], 'the new first step, then the built-in steps above it');
  const models = loadModels(root);
  assert.deepEqual([models.brainstorm.providers, readDiscover('--quick why', { ...models, provider: 'openai' }).steps[0].name], [{ openai: DEFAULT_BRAINSTORM.providers.openai, anthropic: { model: 'opus', effort: 'high' } }, 'Luna']);
});

test('a models file that does not parse is refused, never written over: the person may be halfway through an edit', () => {
  const root = home();
  loadModels(root);
  assert.equal(settingsModels(root).fileError, null);
  fs.writeFileSync(path.join(root, MODELS_FILE), '{ "provider": "openai", ');
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'high' });
  assert.throws(() => saveSettingsModels(root, { provider: 'openai' }), /model-effort-inline-question\.json is not valid JSON/);
  assert.equal(fs.readFileSync(path.join(root, MODELS_FILE), 'utf8'), '{ "provider": "openai", ');
  assert.ok(readChoices(root).bart, 'and no pick is forgotten');
});

test('the panel is told when the models file cannot be read, since runs and the panel are then on the built-in defaults', () => {
  const root = home();
  assert.equal(settingsModels(root).fileError, null, 'a new home: the file is written, and read');
  fs.writeFileSync(path.join(root, MODELS_FILE), '{ "provider": "openai", ');
  const broken = settingsModels(root);
  assert.match(broken.fileError, /^model-effort-inline-question\.json is not valid JSON, so every agent runs on the built-in defaults/);
  assert.deepEqual(broken.models, normalizeModels(null), 'what is shown: the built-in defaults');
  fs.writeFileSync(path.join(root, MODELS_FILE), '[]');
  assert.match(settingsModels(root).fileError, /is not valid JSON/, 'JSON, but not an object');
  fs.rmSync(path.join(root, MODELS_FILE));
  fs.mkdirSync(path.join(root, MODELS_FILE));
  assert.match(settingsModels(root).fileError, /^model-effort-inline-question\.json cannot be read \(EISDIR\), so every agent runs on the built-in defaults/);
});

test('the last action wins: a Settings save forgets the pick by hand it overrules, a pick by hand after it is used, and "Use default" goes back (S-05, A2, A3)', () => {
  const root = home();
  const run = (place) => modelsInForce(root, place);
  const build = (place) => { const choices = buildChoices(run(place)); const step = choices.providers[choices.provider].ladder[0]; return `${choices.provider} ${step.model} ${step.effort}`; };

  // Hand pick, then a Settings save of the other provider's default: the pick stays, and the next run is on it.
  rememberChoice(root, 'bart', { provider: 'openai', model: 'astra', effort: 'xhigh' });
  assert.deepEqual(steps(run('bart')), ['Astra xhigh']);
  saveSettingsModels(root, { bart: { anthropic: { model: 'opus', effort: 'high' } } });
  assert.deepEqual(readChoices(root).bart, { provider: 'openai', model: 'astra', effort: 'xhigh' }, 'Claude Code\'s default does not overrule a pick on Codex');
  assert.deepEqual(steps(run('bart')), ['Astra xhigh']);
  // A save of the default on the pick's provider overrules it, even one that changes nothing: the next run is on the save.
  saveSettingsModels(root, { bart: { openai: DEFAULT_MODELS.providers.openai.ladder[0] } });
  assert.equal(readChoices(root).bart, undefined);
  assert.deepEqual(steps(run('bart')), ['Opus high', 'Fable xhigh']);
  // A save, then a hand pick: the next run is on the pick.
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'sonnet', effort: 'medium' });
  assert.deepEqual(steps(run('bart')), ['Sonnet medium', 'Opus high', 'Fable xhigh']);
  // The default provider is @bart's too.
  saveSettingsModels(root, { provider: 'openai' });
  assert.deepEqual([readChoices(root).bart, steps(run('bart'))], [undefined, ['Sol medium', 'Sol high', 'Astra xhigh']]);

  // Build: a save of its provider, or of its default on the provider a pick is on, forgets Build's pick and the quick task's.
  rememberChoice(root, 'build', { provider: 'anthropic', model: 'fable', effort: 'max' });
  rememberChoice(root, 'quick', { provider: 'anthropic', model: 'sonnet', effort: 'medium' });
  assert.deepEqual([build('build'), build('quick')], ['anthropic fable max', 'anthropic sonnet medium']);
  saveSettingsModels(root, { build: { openai: DEFAULT_MODELS.build.providers.openai.default } });
  assert.deepEqual(Object.keys(readChoices(root)), ['build', 'quick'], 'Codex\'s default leaves picks on Claude Code alone');
  saveSettingsModels(root, { build: { anthropic: { model: 'opus', effort: 'xhigh' } } });
  assert.deepEqual([readChoices(root).build, readChoices(root).quick, build('build'), build('quick')], [undefined, undefined, 'anthropic opus xhigh', 'anthropic opus xhigh']);
  rememberChoice(root, 'quick', { provider: 'openai', model: 'luna', effort: 'medium' });
  saveSettingsModels(root, { buildProvider: 'openai' });
  assert.deepEqual([readChoices(root).quick, build('quick')], [undefined, 'openai sol high']);

  // @brainstorm's and @discover's saves overrule no pick: they have none, and follow @bart's provider.
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'max' });
  rememberChoice(root, 'build', { provider: 'anthropic', model: 'opus', effort: 'max' });
  saveSettingsModels(root, { brainstorm: { anthropic: { model: 'fable', effort: 'high' } }, discover: { anthropic: { standard: { model: 'sonnet', effort: 'high' } } } });
  assert.deepEqual(Object.keys(readChoices(root)), ['bart', 'build']);
  assert.deepEqual([readBrainstorm('', run('bart')).steps[0].name, readDiscover('why', run('bart')).steps[0].name], ['Fable', 'Sonnet'], 'on the provider @bart\'s pick is on');

  // "Use default" (S-07): that place starts on its default again; the others keep their picks.
  const settings = createModelSettings({ homeRoot: () => root });
  const after = settings.forget('bart');
  assert.deepEqual([after.choices, steps(run('bart'))], [{ build: { provider: 'anthropic', model: 'opus', effort: 'max' } }, ['Sol medium', 'Sol high', 'Astra xhigh']]);
  assert.throws(() => settings.forget('elsewhere'), /place must be one of bart, build, quick/);
});

test('a saved default is what the next run starts on, read again with no restart: @bart, @brainstorm, @discover, Build and a post-it\'s quick task; flags still pick per line (S-09, A1, A5)', async () => {
  const homeDir = home();
  const layout = ensureHome(homeDir);
  const ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  try {
    const project = await projects.createProject(ctx, { name: 'Settings', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-settings-code-')) });
    const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Defaults' });
    const root = layout.root;
    // The app's own readModels (index.cjs), made once: every call reads the files again.
    const readModels = (place = 'bart') => modelsInForce(root, place, { only: ['openai', 'anthropic'], usable: ['claude', 'codex'] });
    const picked = [];
    const bart = createFakeBart({ readModels, delayMs: 2, onPicked: (choice) => rememberChoice(root, 'bart', choice) && picked.push(choice) });
    const ref = { kind: 'workspace', workspaceId: workspace.id };
    let n = 0;
    const ask = async (text, agent = 'bart') => bart.ask(ctx, project.id, { askId: `s${n += 1}`, ref, workspaceId: workspace.id, text, agent });

    const first = await ask('why?');
    assert.deepEqual([first.meta.provider, first.meta.level.name, first.meta.level.effort], ['anthropic', 'Sonnet', 'high'], 'the shipped default');
    await ask('--fable --max why?'); // a pick by hand, kept as the next start
    assert.equal(picked.length, 1);
    assert.equal((await ask('why?')).meta.level.name, 'Fable');

    createModelSettings({ homeRoot: () => root }).save({ bart: { anthropic: { model: 'opus', effort: 'xhigh' } }, brainstorm: { anthropic: { model: 'opus', effort: 'high' } }, discover: { anthropic: { standard: { model: 'fable', effort: 'xhigh' }, deep: { model: 'fable', effort: 'max' } } }, build: { anthropic: { model: 'sonnet', effort: 'medium' } } });
    const next = await ask('why?');
    assert.deepEqual([next.meta.level.name, next.meta.level.effort], ['Opus', 'xhigh'], '@bart: the saved default, with no restart');
    const plan = (agent, text) => turnPlan({ agent, text, turns: [] }, readModels('bart')).steps.map((step) => `${step.name} ${step.effort}`);
    assert.deepEqual(plan('brainstorm', ''), ['Opus high'], '@brainstorm');
    assert.deepEqual(plan('discover', 'what to read'), ['Fable xhigh'], '@discover');
    assert.deepEqual(plan('discover', '--deep what to read'), ['Fable max'], '@discover --deep (A5)');
    assert.deepEqual(plan('discover', '--quick what to read'), ['Sonnet medium'], '@discover --quick is still its default');
    assert.deepEqual(plan('bart', '--opus --high why?'), ['Opus high'], '@bart --opus --high (A5)');
    for (const place of ['build', 'quick']) {
      const choice = resolveBuildChoice(readModels(place), {});
      assert.deepEqual([choice.provider, choice.modelName, choice.effort], ['anthropic', 'Sonnet', 'medium'], place);
    }
  } finally {
    await db.closeAll();
  }
});

test('the IPC: settings-models, save-settings-models and clear-model-choice, each announced to every window (S-08)', async () => {
  const root = home();
  const handlers = new Map(), announced = [];
  const modelSettings = createModelSettings({ homeRoot: () => root, only: () => ['anthropic'] });
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, modelSettings, announce: (channel, payload, options) => announced.push([channel, options]) });
  const read = await handlers.get('engelbart:settings-models')();
  assert.deepEqual([read.offered, read.usable, Object.keys(read.models.providers)], [['anthropic'], null, ['openai', 'anthropic']]);
  rememberChoice(root, 'build', { provider: 'anthropic', model: 'fable', effort: 'max' });
  const saved = await handlers.get('engelbart:save-settings-models')({ build: { anthropic: { model: 'opus', effort: 'max' } } });
  assert.deepEqual([saved.models.build.providers.anthropic.default, saved.choices], [{ model: 'opus', effort: 'max' }, {}]);
  assert.deepEqual(announced, [['engelbart:models-changed', undefined]], 'every window, the one that saved too');
  assert.throws(() => handlers.get('engelbart:save-settings-models')({ build: { anthropic: { model: 'opus', effort: 'ultra' } } }), /Build on anthropic/);
  assert.equal(announced.length, 1, 'a refused save is not announced');
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'fable', effort: 'max' });
  assert.deepEqual((await handlers.get('engelbart:clear-model-choice')('bart')).choices, {});
  assert.throws(() => handlers.get('engelbart:clear-model-choice')(42), /place/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  for (const [name, channel] of [['settingsModels', 'settings-models'], ['saveSettingsModels', 'save-settings-models'], ['clearModelChoice', 'clear-model-choice']]) assert.ok(preload.includes(`${name}: invoke('${channel}')`), name);
  assert.ok(preload.includes("onModelsChanged: (callback) => subscribe('engelbart:models-changed', callback)"));
});

/* ------------------------------------------------------------- the panel */

function load(file) {
  const filename = path.join(__dirname, '__settings-unit.cjs');
  const build = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', file)], bundle: true, platform: 'node', format: 'cjs',
    jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/server'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' } });
  const compiled = new Module(filename, module); compiled.paths = module.paths;
  const previous = global.window;
  global.window = { engelbartAPI: {} };
  try { compiled._compile(build.outputFiles[0].text, filename); }
  finally { if (previous === undefined) delete global.window; else global.window = previous; }
  return compiled.exports;
}

const shown = (root, options = {}) => settingsModels(root, options);
// The tool check with `usable` the CLIs that can run; the others not installed.
const toolsFor = (usable) => ({ usableAgents: () => usable, snapshot: () => ({ tools: Object.fromEntries(['claude', 'codex'].map((name) => [name, usable.includes(name) ? { installed: true, status: 'ready' } : { installed: false, status: 'missing' }])) }) });

test('the rows: each agent\'s default per provider, the default providers as a run sees them, and what a pick saves', () => {
  const { AGENT_ROWS, defaultStep, defaultProvider, shownProviders, cellModels, patchOf, stepLabel, lastPick } = load('model/intelligence.js');
  assert.deepEqual(AGENT_ROWS.map((row) => row.id), ['bart', 'brainstorm', 'discover', 'build']);
  const root = home();
  const settings = shown(root);
  const models = settings.models;
  assert.deepEqual(['bart', 'brainstorm', 'discover', 'build'].map((agent) => stepLabel(cellModels(models, agent, 'anthropic').providers.anthropic, defaultStep(models, agent, 'anthropic'))), ['Sonnet High', 'Sonnet High', 'Opus High', 'Opus High']);
  assert.deepEqual(['bart', 'brainstorm', 'discover', 'build'].map((agent) => stepLabel(cellModels(models, agent, 'openai').providers.openai, defaultStep(models, agent, 'openai'))), ['Sol Medium', 'Sol Medium', 'Astra High', 'Sol High']);
  assert.deepEqual(defaultStep(models, 'discover', 'anthropic', 'deep'), { model: 'opus', effort: 'max' });
  assert.deepEqual(Object.keys(cellModels(models, 'build', 'openai').providers), ['openai'], 'a cell lists its provider alone');
  assert.deepEqual(cellModels(models, 'build', 'openai').providers.openai.ladder, [{ model: 'sol', effort: 'high' }]);
  assert.deepEqual(patchOf('discover', 'openai', { model: 'sol', effort: 'high' }, 'quick'), { discover: { openai: { quick: { model: 'sol', effort: 'high' } } } });
  assert.deepEqual(patchOf('bart', 'openai', { model: 'sol', effort: 'high', provider: 'openai' }), { bart: { openai: { model: 'sol', effort: 'high' } } });
  const claudeOnly = shown(root, { only: ['anthropic'] });
  assert.deepEqual([shownProviders(claudeOnly), defaultProvider(claudeOnly, 'bart')], [['anthropic'], 'anthropic']);
  saveSettingsModels(root, { provider: 'openai', buildProvider: 'openai' });
  assert.deepEqual([defaultProvider(shown(root), 'bart'), defaultProvider(shown(root), 'build'), defaultProvider(shown(root, { only: ['anthropic'] }), 'build')], ['openai', 'openai', 'anthropic'], 'a provider config.json does not offer gives way, as in a run');

  // "Using your last pick" only where the pick is one a run would start on, and not the default itself.
  assert.equal(lastPick(shown(root), 'bart'), null, 'none kept');
  rememberChoice(root, 'bart', { provider: 'openai', model: 'sol', effort: 'medium' });
  assert.equal(lastPick(shown(root), 'bart'), null, 'the default itself');
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'xhigh' });
  assert.deepEqual(lastPick(shown(root), 'bart'), { provider: 'anthropic', model: 'opus', effort: 'xhigh', label: 'Opus Extra high' });
  assert.equal(lastPick(shown(root, { only: ['openai'] }), 'bart'), null, 'on a provider config.json does not offer: a run passes it over');
  rememberChoice(root, 'quick', { provider: 'openai', model: 'astra', effort: 'ultra' });
  assert.deepEqual([lastPick(shown(root), 'quick').label, lastPick(shown(root), 'build')], ['Astra Ultra', null]);
});

test('the gear opens the settings window at Model, with Test data only in test mode', () => {
  const { PAGES } = load('ui/Settings.jsx');
  const ids = (props) => PAGES.filter((page) => !page.shown || page.shown(props)).map((page) => page.id);
  assert.deepEqual(ids({ test: null }), ['model']);
  assert.deepEqual(ids({ test: { testMode: false } }), ['model']);
  assert.deepEqual(ids({ test: { testMode: true } }), ['model', 'test-data']);
  assert.equal(PAGES[0].title, 'Model');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/Settings.jsx'), 'utf8');
  assert.ok(!source.includes('⚙'), 'a drawn gear, not the character');
  assert.match(source, /className="settings-gear"/);
  assert.match(source, /aria-haspopup="dialog" onClick=\{\(\) => setOpen\(true\)\}/, 'no menu: a press opens the window');
  assert.ok(!source.includes('role="menu"'));
});

test('Model: Quick, Standard and Deep of the provider @discover runs on, each a model and an effort', () => {
  const { IntelligenceLevels, LEVELS } = load('ui/Settings.jsx');
  assert.deepEqual(LEVELS.map((level) => level.id), ['quick', 'standard', 'deep']);
  const root = home();
  const html = renderToStaticMarkup(React.createElement(IntelligenceLevels, { initial: settingsModels(root, { tools: toolsFor(['claude']) }) }));
  // One group per provider offered, the one @discover runs on first; a provider whose CLI cannot run says so.
  const groups = (markup) => [...markup.matchAll(/data-levels-provider="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(groups(html), ['anthropic', 'openai']);
  assert.ok(!html.includes('role="tab"'), 'every provider shown at once');
  for (const level of ['quick', 'standard', 'deep']) assert.ok(html.includes(`data-level="anthropic:${level}"`), level);
  const row = (markup, key) => { const at = markup.indexOf(`data-level="${key}"`); const next = markup.indexOf('data-level="', at + 1); return markup.slice(at, next < 0 ? undefined : next); };
  assert.match(row(html, 'anthropic:quick'), /Used by @discover --quick/);
  assert.match(row(html, 'anthropic:quick'), /<option value="sonnet" selected="">Sonnet<\/option>/);
  assert.match(row(html, 'anthropic:quick'), /<option value="medium" selected="">Medium<\/option>/);
  assert.match(row(html, 'anthropic:deep'), /<option value="opus" selected="">Opus<\/option>/);
  assert.match(row(html, 'anthropic:deep'), /<option value="max" selected="">Max<\/option>/);
  assert.ok(!html.includes('data-cli-note="anthropic"'), 'Claude Code can run');
  assert.ok(html.includes('data-cli-note="openai"'), 'Codex cannot');
  const codex = renderToStaticMarkup(React.createElement(IntelligenceLevels, { initial: settingsModels(root, { tools: toolsFor(['codex']) }) }));
  assert.deepEqual(groups(codex), ['openai', 'anthropic'], 'the provider runs use, first');
  assert.match(row(codex, 'openai:standard'), /<option value="astra" selected="">Astra<\/option>/);
  saveSettingsModels(root, { provider: 'openai' });
  const saved = renderToStaticMarkup(React.createElement(IntelligenceLevels, { initial: settingsModels(root, { tools: toolsFor(['claude', 'codex']) }) }));
  assert.deepEqual(groups(saved), ['openai', 'anthropic'], 'the saved provider, first');
  const one = renderToStaticMarkup(React.createElement(IntelligenceLevels, { initial: settingsModels(root, { only: ['openai'] }) }));
  assert.deepEqual(groups(one), ['openai'], 'one provider offered: one group');
});

test('the provider runs use: a saved one whose CLI cannot run gives way, as in a run (preferUsable)', () => {
  const { defaultProvider, savedProvider, lastPick } = load('model/intelligence.js');
  const root = home();
  const codexOnly = settingsModels(root, { tools: toolsFor(['codex']) });
  assert.deepEqual([savedProvider(codexOnly, 'bart'), savedProvider(codexOnly, 'build')], ['anthropic', 'anthropic'], 'Claude Code is saved for both');
  assert.deepEqual([defaultProvider(codexOnly, 'bart'), defaultProvider(codexOnly, 'build')], ['openai', 'openai'], 'but Codex runs');
  const run = (place) => modelsInForce(root, place, { usable: ['codex'] });
  assert.deepEqual([run('bart').provider, run('build').build.provider], ['openai', 'openai'], 'as a run has it');
  assert.equal(defaultProvider(settingsModels(root), 'bart'), 'anthropic', 'before the first check nothing moves');
  // A pick by hand on a provider whose CLI cannot run is passed over by a run, so the panel does not claim it is used.
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'max' });
  assert.equal(lastPick(settingsModels(root, { tools: toolsFor(['codex']) }), 'bart'), null);
  assert.deepEqual(steps(run('bart')), ['Sol medium', 'Sol high', 'Astra xhigh']);
});

test('@bart\'s pick on the other provider moves @brainstorm and @discover there (followedPick)', () => {
  const { followedPick, lastPick } = load('model/intelligence.js');
  const root = home();
  const both = () => settingsModels(root, { tools: toolsFor(['claude', 'codex']) });
  const run = () => modelsInForce(root, 'bart', { usable: ['claude', 'codex'] });
  assert.equal(followedPick(both()), null, 'no pick');

  // A pick on Codex while Claude Code is the default: a run of either is on Codex, at Codex's default for it.
  rememberChoice(root, 'bart', { provider: 'openai', model: 'astra', effort: 'xhigh' });
  assert.deepEqual(followedPick(both()), { provider: 'openai', label: 'Codex' });
  const brainstorm = readBrainstorm('', run()).steps[0], discover = readDiscover('what to read', run()).steps[0];
  assert.deepEqual([brainstorm.provider, brainstorm.name, brainstorm.effort, discover.provider, discover.name, discover.effort], ['openai', 'Sol', 'medium', 'openai', 'Astra', 'high'], 'as a run has it');

  // Use default forgets @bart's pick, and both lines go with it.
  createModelSettings({ homeRoot: () => root }).forget('bart');
  assert.equal(followedPick(both()), null);

  // A pick on the default provider moves only @bart.
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'max' });
  assert.ok(lastPick(both(), 'bart'));
  assert.equal(followedPick(both()), null);

  // A pick on Codex while Codex cannot run is passed over: nothing moves, so nothing is said.
  rememberChoice(root, 'bart', { provider: 'openai', model: 'astra', effort: 'xhigh' });
  const claudeOnly = settingsModels(root, { tools: toolsFor(['claude']) });
  assert.deepEqual([followedPick(claudeOnly), lastPick(claudeOnly, 'bart')], [null, null]);
  assert.equal(modelsInForce(root, 'bart', { usable: ['claude'] }).provider, 'anthropic');
});

test('Intelligence levels warn when the models file cannot be read, before anything else', () => {
  const { IntelligenceLevels } = load('ui/Settings.jsx');
  const root = home();
  assert.ok(!renderToStaticMarkup(React.createElement(IntelligenceLevels, { initial: settingsModels(root) })).includes('data-models-file-error'));
  fs.writeFileSync(path.join(root, MODELS_FILE), '{ "provider": ');
  const html = renderToStaticMarkup(React.createElement(IntelligenceLevels, { initial: settingsModels(root) }));
  assert.match(html, /^<div data-intelligence-levels="1"><div role="alert" data-models-file-error="1"[^>]*>model-effort-inline-question\.json is not valid JSON/);
});

test('one gear: the test pill has none of its own, and Settings sits after the notification bell (S-12)', () => {
  const { default: TestToggle } = load('ui/TestToggle.jsx');
  const pill = renderToStaticMarkup(React.createElement(TestToggle, { testMode: true, onToggle: () => {}, busy: false }));
  assert.ok(!pill.includes('⚙') && pill.includes('Test · on'));
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/WindowControls.jsx'), 'utf8');
  assert.ok(source.indexOf('<SandboxNotifications />') < source.indexOf('<Settings test={test} />') && source.indexOf('<Settings test={test} />') < source.indexOf('{children}'));
});
