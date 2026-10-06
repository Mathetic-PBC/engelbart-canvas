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

test('@bart\'s default is its ladder\'s first step: the steps above it stay, those at or below it go so the ladder still only goes up (S-03)', () => {
  const claude = DEFAULTS.providers.anthropic, codex = DEFAULTS.providers.openai;
  const ladder = (entry, step) => withFirstStep(entry, step).map((rung) => `${rung.model} ${rung.effort}`);
  assert.deepEqual(ladder(claude, { model: 'sonnet', effort: 'medium' }), ['sonnet medium', 'opus high', 'fable xhigh'], 'below step 2: only the first changes');
  assert.deepEqual(ladder(claude, { model: 'sonnet', effort: 'max' }), ['sonnet max', 'opus high', 'fable xhigh'], 'a later model is above whatever the effort');
  assert.deepEqual(ladder(claude, { model: 'opus', effort: 'high' }), ['opus high', 'fable xhigh'], 'at step 2: step 2 goes');
  assert.deepEqual(ladder(claude, { model: 'opus', effort: 'max' }), ['opus max', 'fable xhigh'], 'above step 2, below step 3');
  assert.deepEqual(ladder(claude, { model: 'fable', effort: 'medium' }), ['fable medium', 'fable xhigh']);
  assert.deepEqual(ladder(claude, { model: 'fable', effort: 'max' }), ['fable max'], 'above them all: a ladder of one');
  assert.deepEqual(ladder(codex, { model: 'luna', effort: 'ultra' }), ['luna ultra', 'sol high', 'astra xhigh']);
  assert.deepEqual(ladder(codex, { model: 'sol', effort: 'high' }), ['sol high', 'astra xhigh']);
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
  assert.deepEqual(now.providers.openai.ladder, [{ model: 'luna', effort: 'high' }, ...DEFAULT_MODELS.providers.openai.ladder.slice(1)], 'the first step of the ladder in force replaced');
  const models = loadModels(root);
  assert.deepEqual([models.brainstorm.providers, readDiscover('--quick why', { ...models, provider: 'openai' }).steps[0].name], [{ openai: DEFAULT_BRAINSTORM.providers.openai, anthropic: { model: 'opus', effort: 'high' } }, 'Luna']);
});

test('a models file that does not parse is refused, never written over: the person may be halfway through an edit', () => {
  const root = home();
  loadModels(root);
  fs.writeFileSync(path.join(root, MODELS_FILE), '{ "provider": "openai", ');
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'high' });
  assert.throws(() => saveSettingsModels(root, { provider: 'openai' }), /model-effort-inline-question\.json is not valid JSON/);
  assert.equal(fs.readFileSync(path.join(root, MODELS_FILE), 'utf8'), '{ "provider": "openai", ');
  assert.ok(readChoices(root).bart, 'and no pick is forgotten');
});

test('the last action wins: a Settings save forgets the pick by hand it overrules, a pick by hand after it is used, and "Use default" goes back (S-05, A2, A3)', () => {
  const root = home();
  const run = (place) => modelsInForce(root, place);
  const build = (place) => { const choices = buildChoices(run(place)); const step = choices.providers[choices.provider].ladder[0]; return `${choices.provider} ${step.model} ${step.effort}`; };

  // Hand pick, then a Settings save: the next run is on the save.
  rememberChoice(root, 'bart', { provider: 'openai', model: 'astra', effort: 'xhigh' });
  assert.deepEqual(steps(run('bart')), ['Astra xhigh']);
  saveSettingsModels(root, { bart: { anthropic: { model: 'opus', effort: 'high' } } });
  assert.equal(readChoices(root).bart, undefined);
  assert.deepEqual(steps(run('bart')), ['Opus high', 'Fable xhigh']);
  // A save, then a hand pick: the next run is on the pick.
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'sonnet', effort: 'medium' });
  assert.deepEqual(steps(run('bart')), ['Sonnet medium', 'Opus high', 'Fable xhigh']);
  // The default provider is @bart's too.
  saveSettingsModels(root, { provider: 'openai' });
  assert.deepEqual([readChoices(root).bart, steps(run('bart'))], [undefined, ['Sol medium', 'Sol high', 'Astra xhigh']]);

  // Build: a save of its default or provider forgets Build's pick and the quick task's.
  rememberChoice(root, 'build', { provider: 'anthropic', model: 'fable', effort: 'max' });
  rememberChoice(root, 'quick', { provider: 'anthropic', model: 'sonnet', effort: 'medium' });
  assert.deepEqual([build('build'), build('quick')], ['anthropic fable max', 'anthropic sonnet medium']);
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

test('the panel draws every agent on every provider offered, greys a provider whose CLI cannot run, and shows a last pick with Use default (S-10, S-11, S-07)', () => {
  const { Intelligence, TestData, SECTIONS } = load('ui/Settings.jsx');
  const root = home();
  rememberChoice(root, 'bart', { provider: 'anthropic', model: 'opus', effort: 'xhigh' });
  rememberChoice(root, 'quick', { provider: 'anthropic', model: 'fable', effort: 'max' });
  const tools = { usableAgents: () => ['claude'], snapshot: () => ({ tools: { claude: { installed: true, status: 'ready' }, codex: { installed: false, status: 'missing' } } }) };
  const html = renderToStaticMarkup(React.createElement(Intelligence, { initial: settingsModels(root, { tools }) }));
  for (const agent of ['bart', 'brainstorm', 'discover', 'build']) {
    for (const provider of ['anthropic', 'openai']) assert.ok(html.includes(`data-settings-cell="${agent}:${provider}:standard"`), `${agent} on ${provider}`);
  }
  assert.ok(html.includes('data-cli-note="openai"') && html.includes('not installed'), 'Codex: not installed');
  assert.ok(!html.includes('data-cli-note="anthropic"'));
  assert.match(html, /data-last-pick="bart"[^>]*>.*Using your last pick: <span[^>]*>Opus Extra high<\/span>.*data-use-default="bart"/);
  assert.match(html, /data-last-pick="quick"[^>]*>.*Post-its use your last pick: <span[^>]*>Fable Max<\/span>/);
  assert.ok(!html.includes('data-last-pick="build"'));
  assert.ok(html.includes('data-settings-advanced="1"') && !html.includes('discover:anthropic:deep'), '@discover\'s quick and deep wait under Advanced');
  assert.ok(html.includes('data-settings-provider="bart"') && html.includes('data-settings-provider="build"'));
  const one = renderToStaticMarkup(React.createElement(Intelligence, { initial: settingsModels(root, { only: ['openai'] }) }));
  assert.ok(!one.includes(':anthropic:') && one.includes('data-settings-cell="bart:openai:standard"'), 'only the providers config.json offers');

  // Test data: in test mode only, with test mode's three actions.
  const ids = (props) => SECTIONS.filter((section) => !section.shown || section.shown(props)).map((section) => section.id);
  assert.deepEqual([ids({ test: null }), ids({ test: { testMode: false } }), ids({ test: { testMode: true } })], [['intelligence'], ['intelligence'], ['intelligence', 'test']]);
  const testHtml = renderToStaticMarkup(React.createElement(TestData, { test: {}, close: () => {} }));
  for (const item of ['Reveal in Finder', 'Start as a new user…', 'Reset everything…']) assert.ok(testHtml.includes(item), item);
});

test('one gear: the test pill has none of its own, and Settings sits after the notification bell (S-12)', () => {
  const { default: TestToggle } = load('ui/TestToggle.jsx');
  const pill = renderToStaticMarkup(React.createElement(TestToggle, { testMode: true, onToggle: () => {}, busy: false }));
  assert.ok(!pill.includes('⚙') && pill.includes('Test · on'));
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/WindowControls.jsx'), 'utf8');
  assert.ok(source.indexOf('<SandboxNotifications />') < source.indexOf('<Settings test={test} />') && source.indexOf('<Settings test={test} />') < source.indexOf('{children}'));
});
