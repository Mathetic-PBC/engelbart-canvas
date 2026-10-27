'use strict';

// Which Codex model a run sends (MATH-159, src/main/tools/codex-models.cjs): the models file's ids where the account's
// Codex lists them, else the listed member of their family, read from the models_cache.json of the home the run uses,
// and only when the Codex that wrote it is the one that runs. One retry when Codex refuses the model. The pickers show
// each family as its listed member and hide a family with none. Onboarding's own pick as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const cm = require('../src/main/tools/codex-models.cjs');
const agents = require('../src/main/connect/agents.cjs');
const { normalizeModels, buildChoices, loadModels, MODELS_FILE } = require('../src/main/bart/models.cjs');
const { createBart } = require('../src/main/bart/ask.cjs');
const { createNameChat } = require('../src/main/bart/name-chat.cjs');
const { createRouter } = require('../src/main/bart/route.cjs');
const { createCliSummarizer } = require('../src/main/context/summarizer.cjs');
const { createRunner } = require('../src/main/build/runner.cjs');
const { buildPolicy } = require('../src/main/build/policy.cjs');
const { modelsInForce } = require('../src/main/bart/settings.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-codex-models-'));
const layout = ensureHome(homeDir);
const RUNNING = '0.164.0';
const tools = { snapshot: () => ({ tools: { codex: { version: RUNNING } } }), binaryFor: () => null, ensure: async () => {}, use: async (_name, fn) => fn(), check: async () => {}, usableAgents: () => null };
const authFile = path.join(homeDir, 'auth.json');
fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));

// As Codex 0.164.0 wrote it on an account without GPT-6.1 Sol: Sol and Astra are other members of their families, no Luna.
const WITHOUT = ['gpt-6-sol', 'gpt-6.2-astra', 'gpt-5.6-codex'];
const cache = (listed, { version = RUNNING, hidden = ['gpt-6.1-sol'] } = {}) => ({
  fetched_at: '2026-10-26T12:00:00Z',
  ...(version === null ? {} : { client_version: version }),
  models: [...listed.map((slug) => ({ slug, visibility: 'list' })), ...hidden.map((slug) => ({ slug, visibility: 'hide' }))],
});
let homes = 0;
/** A Codex home with `content` as its models_cache.json (none when null). */
function home(content) {
  homes += 1;
  const dir = path.join(homeDir, `codex-${homes}`);
  fs.mkdirSync(dir, { recursive: true });
  if (content) fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify(content));
  return dir;
}
const REFUSED = (model) => `{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"code\\":\\"model_not_found\\",\\"message\\":\\"The '${model}' model is not supported when using Codex with a ChatGPT account.\\"}}"}\n{"type":"turn.failed","error":{"message":"The '${model}' model is not supported when using Codex with a ChatGPT account. (code: model_not_found)"}}\n`;

/* ------------------------------------------------------------------ the pick */

test('the pick: unchanged when listed; the listed member of its family, else the first listed, when not; unchanged with no cache or one from another Codex', () => {
  const without = home(cache(WITHOUT));
  const at = (model, dir, version = RUNNING) => cm.codexModel(model, dir, { version });
  assert.deepEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map((model) => at(model, without)), ['gpt-6-sol', 'gpt-6.2-astra', 'gpt-6-sol']);
  const withSol = home(cache(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'], { hidden: [] }));
  assert.deepEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map((model) => at(model, withSol)), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'], 'an account that has them sends exactly what it sent');
  assert.equal(at('gpt-6.1-sol', home(cache(WITHOUT, { version: '0.159.3' }))), 'gpt-6.1-sol', 'written by another Codex');
  assert.equal(at('gpt-6.1-sol', home(cache(WITHOUT, { version: 'codex-cli 0.164.0' }))), 'gpt-6-sol', 'a version as `codex --version` prints it reads the same');
  assert.equal(at('gpt-6.1-sol', home(cache(WITHOUT, { version: null }))), 'gpt-6.1-sol', 'no client_version: nothing to compare');
  assert.equal(at('gpt-6.1-sol', home(null)), 'gpt-6.1-sol', 'no cache');
  assert.equal(at('gpt-6.1-sol', without, null), 'gpt-6.1-sol', 'the running version unknown');
  fs.writeFileSync(path.join(home(null), 'models_cache.json'), 'not json');
  assert.equal(at('gpt-6.1-sol', path.join(homeDir, `codex-${homes}`)), 'gpt-6.1-sol', 'a cache that cannot be read');
  assert.equal(at('gpt-6.1-sol', home(cache([]))), 'gpt-6.1-sol', 'nothing listed');
  assert.equal(cm.runningCodexVersion(tools), RUNNING);
  assert.equal(cm.runningCodexVersion({ snapshot: () => ({ tools: { codex: { version: 'codex-cli 0.159.3' } } }) }), '0.159.3');
  assert.equal(cm.runningCodexVersion(null), null);
});

test('onboarding\'s pick is as it was: any cache, with or without client_version, from the person\'s Codex (connect/agents.cjs)', () => {
  assert.equal(agents.codexModel('gpt-6.1-sol', home(cache(WITHOUT, { version: null }))), 'gpt-6-sol', 'no client_version: still the family member');
  assert.equal(agents.codexModel('gpt-6.1-sol', home(cache(WITHOUT, { version: '0.159.3' }))), 'gpt-6-sol', 'whichever Codex wrote it');
  assert.equal(agents.codexModel('gpt-6-luna', home(cache(WITHOUT))), 'gpt-6-sol', 'no family member: the first listed');
  assert.equal(agents.codexModel('gpt-6.1-sol', home(cache(['gpt-6.1-sol']))), 'gpt-6.1-sol');
  assert.equal(agents.codexModel('gpt-6.1-sol', home(null)), 'gpt-6.1-sol');
  assert.equal(agents.codexModel('gpt-6.1-sol', home(cache([]))), 'gpt-6.1-sol');
});

test('one retry: on model_not_found, on the pick read again from the refreshed cache; never for another failure, never on the model that failed, never twice', async () => {
  assert.ok(cm.modelNotFound(REFUSED('gpt-6.1-sol')));
  assert.ok(!cm.modelNotFound('{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}\n'));
  assert.ok(!cm.modelNotFound('model_not_found in a line that is not an error'));
  const ok = (out) => !!out.text;
  // no cache yet: the model goes as it is, Codex refuses it and writes the cache, the retry is on its family's member
  const dir = home(null);
  const sent = [];
  const once = await cm.codexRun({ model: 'gpt-6.1-sol', home: dir, version: RUNNING, ok, attempt: async (model) => {
    sent.push(model);
    if (model === 'gpt-6.1-sol') { fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify(cache(WITHOUT))); return { stdout: REFUSED(model), text: '' }; }
    return { stdout: '', text: 'answer' };
  } });
  assert.deepEqual([sent, once.ran, once.text], [['gpt-6.1-sol', 'gpt-6-sol'], 'gpt-6-sol', 'answer']);
  // another failure: no retry
  const other = [];
  const failed = await cm.codexRun({ model: 'gpt-6.1-sol', home: home(null), version: RUNNING, ok, attempt: async (model) => { other.push(model); return { stdout: '{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}\n', text: '' }; } });
  assert.deepEqual([other, failed.ran], [['gpt-6.1-sol'], 'gpt-6.1-sol']);
  // refused, but the pick is the model that failed (the cache lists it, or says nothing to go by): no retry
  for (const content of [null, cache(['gpt-6.1-sol']), cache(WITHOUT, { version: '0.159.3' })]) {
    const tried = [];
    await cm.codexRun({ model: 'gpt-6.1-sol', home: home(content), version: RUNNING, ok, attempt: async (model) => { tried.push(model); return { stdout: REFUSED(model), text: '' }; } });
    assert.deepEqual(tried, ['gpt-6.1-sol'], JSON.stringify(content && content.client_version));
  }
  // refused on the retry too: it stops there
  const twice = home(null);
  const both = [];
  const last = await cm.codexRun({ model: 'gpt-6.1-sol', home: twice, version: RUNNING, ok, attempt: async (model) => {
    both.push(model);
    fs.writeFileSync(path.join(twice, 'models_cache.json'), JSON.stringify(cache(both.length === 1 ? WITHOUT : ['gpt-6.3-sol'])));
    return { stdout: REFUSED(model), text: '' };
  } });
  assert.deepEqual([both, last.ran], [['gpt-6.1-sol', 'gpt-6-sol'], 'gpt-6-sol']);
});

/* ------------------------------------------------------------------ every Codex run */

const policyOf = (dataRoot) => buildPolicy({ project: { dir: path.join(dataRoot, 'p') }, dataRoot });

/** A stub CLI: refuses the models in `refused` as Codex does, answers otherwise; each call's env kept. */
function codexCli(outputKey, { refused = [], refresh = null } = {}) {
  const calls = [];
  const run = (shell, args, options, callback) => {
    const env = options.env, model = Object.entries(env).find(([key]) => /^ENGELBART_[A-Z]+_MODEL$/.test(key))[1];
    calls.push({ command: args[args.length - 1], env, model });
    if (refused.includes(model)) { if (refresh) refresh(); callback(null, REFUSED(model)); return null; }
    fs.writeFileSync(env[outputKey], 'Answer on the fallback.');
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n');
    return null;
  };
  return { run, calls };
}

test('Build: on Sol and on Astra it runs on the listed member, a resume too, and says which; the person\'s own home when the runner names none; unchanged where listed', async () => {
  const worktree = path.join(homeDir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const policy = policyOf(layout.root);
  const turn = async (runner, modelId, session = null) => runner.turn({ task: { id: 'abcdef0159', provider: 'openai', modelId, effort: 'high', worktree }, message: 'do it', session, system: 'SYSTEM', policy });
  const without = home(cache(WITHOUT));
  fs.copyFileSync(authFile, path.join(without, 'auth.json'));
  const cli = codexCli('ENGELBART_BUILD_OUTPUT');
  const runner = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'build-runs'), codexHome: without, run: cli.run, tools });
  const sol = await turn(runner, 'gpt-6.1-sol');
  const astra = await turn(runner, 'gpt-6-astra');
  const resumed = await turn(runner, 'gpt-6.1-sol', sol.session);
  assert.deepEqual(cli.calls.map((call) => call.model), ['gpt-6-sol', 'gpt-6.2-astra', 'gpt-6-sol']);
  assert.match(cli.calls[2].command, / exec resume /);
  assert.deepEqual([sol.model, astra.model, resumed.model], ['gpt-6-sol', 'gpt-6.2-astra', 'gpt-6-sol']);
  // no codexHome: the person's (CODEX_HOME), whose cache it reads, and CODEX_HOME is not set for the run
  const own = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir, CODEX_HOME: without }, runDirectory: path.join(homeDir, 'build-runs'), run: cli.run, tools });
  assert.equal((await turn(own, 'gpt-6.1-sol')).model, 'gpt-6-sol');
  // an account that has them: exactly what it sent before
  const withSol = home(cache(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'], { hidden: [] }));
  fs.copyFileSync(authFile, path.join(withSol, 'auth.json'));
  const kept = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'build-runs'), codexHome: withSol, run: cli.run, tools });
  assert.deepEqual([(await turn(kept, 'gpt-6.1-sol')).model, (await turn(kept, 'gpt-6-astra')).model], ['gpt-6.1-sol', 'gpt-6-astra']);
  // another Codex wrote it, or there is none: unchanged
  for (const content of [cache(WITHOUT, { version: '0.159.3' }), null]) {
    const dir = home(content);
    fs.copyFileSync(authFile, path.join(dir, 'auth.json'));
    const other = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'build-runs'), codexHome: dir, run: cli.run, tools });
    assert.equal((await turn(other, 'gpt-6.1-sol')).model, 'gpt-6.1-sol');
  }
});

test('Build: refused with no cache yet, it runs once more on the member the refreshed cache lists; another failure fails as before', async () => {
  const worktree = path.join(homeDir, 'wt-retry');
  fs.mkdirSync(worktree, { recursive: true });
  const dir = home(null);
  fs.copyFileSync(authFile, path.join(dir, 'auth.json'));
  const cli = codexCli('ENGELBART_BUILD_OUTPUT', { refused: ['gpt-6.1-sol'], refresh: () => fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify(cache(WITHOUT))) });
  const runner = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'build-runs'), codexHome: dir, run: cli.run, tools });
  const out = await runner.turn({ task: { id: 'abcdef0160', provider: 'openai', modelId: 'gpt-6.1-sol', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy: policyOf(layout.root) });
  assert.deepEqual([cli.calls.map((call) => call.model), out.model, out.text], [['gpt-6.1-sol', 'gpt-6-sol'], 'gpt-6-sol', 'Answer on the fallback.']);
  const refusing = codexCli('ENGELBART_BUILD_OUTPUT', { refused: ['gpt-6.1-sol'] });
  const stuck = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'build-runs'), codexHome: home(null), codexAuthFile: authFile, run: refusing.run, tools });
  await assert.rejects(stuck.turn({ task: { id: 'abcdef0161', provider: 'openai', modelId: 'gpt-6.1-sol', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy: policyOf(layout.root) }), (error) => error.kind === 'failed' && /model_not_found/.test(error.message));
  assert.equal(refusing.calls.length, 1, 'the cache still names nothing else: no retry');
});

let ctx;
let project;
let workspace;
test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-codex-models-code-'));
  project = await projects.createProject(ctx, { name: 'Models', directory: code });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Codex' });
});
test.after(async () => { await db.closeAll(); });

const MODELS = { ...normalizeModels(null), provider: 'openai' };

test('@bart on Sol: runs on the listed member, on a resumed turn too, and the reply\'s foot says "Sol (ran as gpt-6-sol)"; unchanged and unsaid where Sol is listed', async () => {
  const ask = (bart, askId, text) => bart.ask(ctx, project.id, { askId, ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, text });
  const codexHome = path.join(homeDir, 'codex-home-bart');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify(cache(WITHOUT)));
  const cli = codexCli('ENGELBART_BART_OUTPUT');
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'bart-runs'), codexHome, codexAuthFile: authFile, run: cli.run, tools });
  const out = await ask(bart, 'm1', '--sol --high why?');
  assert.equal(cli.calls[0].model, 'gpt-6-sol');
  assert.equal(cli.calls[0].env.CODEX_HOME, codexHome);
  assert.deepEqual(out.meta.level, { name: 'Sol', effort: 'high', model: 'gpt-6.1-sol', ran: 'gpt-6-sol' });
  assert.match(out.lines[out.lines.length - 1], /^bart> \*Chat · Sol \(ran as gpt-6-sol\) · high · \d+ s\*$/);
  const astra = await ask(bart, 'm2', '--astra --xhigh why?');
  assert.equal(cli.calls[1].model, 'gpt-6.2-astra');
  assert.match(astra.lines[astra.lines.length - 1], /Astra \(ran as gpt-6\.2-astra\) · xhigh/);
  // a follow-up resumes the session: the same pick
  const followed = await bart.ask(ctx, project.id, { askId: 'm3', ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, text: '--sol --high and then?', turns: [{ question: '--astra --xhigh why?', answer: 'Answer on the fallback.' }] });
  assert.match(cli.calls[2].command, / resume /);
  assert.equal(cli.calls[2].model, 'gpt-6-sol');
  assert.match(followed.lines[followed.lines.length - 1], /Sol \(ran as gpt-6-sol\)/);
  // listed: as before, nothing added to the foot
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify(cache(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'], { hidden: [] })));
  const plain = await ask(bart, 'm4', '--sol --high why?');
  assert.equal(cli.calls[3].model, 'gpt-6.1-sol');
  assert.deepEqual(plain.meta.level, { name: 'Sol', effort: 'high', model: 'gpt-6.1-sol' });
  assert.match(plain.lines[plain.lines.length - 1], /^bart> \*Chat · Sol · high · \d+ s\*$/);
});

test('@bart refused on Sol with no cache yet: one more run on the refreshed cache\'s member, and the foot says so', async () => {
  const codexHome = path.join(homeDir, 'codex-home-bart-retry');
  const cli = codexCli('ENGELBART_BART_OUTPUT', { refused: ['gpt-6.1-sol'], refresh: () => fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify(cache(WITHOUT))) });
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'bart-runs'), codexHome, codexAuthFile: authFile, run: cli.run, tools });
  const out = await bart.ask(ctx, project.id, { askId: 'r1', ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, text: '--sol --high why?' });
  assert.deepEqual(cli.calls.map((call) => call.model), ['gpt-6.1-sol', 'gpt-6-sol']);
  assert.match(out.lines[out.lines.length - 1], /Sol \(ran as gpt-6-sol\) · high/);
});

test('a title, a route and a summary run on the fallback by their own homes\' caches; unchanged with a cache from another Codex', async () => {
  const name = home(cache(WITHOUT));
  const nameCli = codexCli('ENGELBART_NAME_OUTPUT');
  const nameChat = createNameChat({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'name-runs'), codexHome: name, codexAuthFile: authFile, run: nameCli.run, tools });
  await nameChat({ text: 'why is the sweep slow?', provider: 'openai' });
  assert.equal(nameCli.calls[0].model, 'gpt-6-sol', 'Luna, which this account has none of: the first listed');

  const routed = home(cache(WITHOUT));
  const routeCli = codexCli('ENGELBART_ROUTE_OUTPUT');
  await createRouter({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'route-runs'), codexHome: routed, codexAuthFile: authFile, run: routeCli.run, tools }).route({ projectId: project.id, text: 'why is it slow?', section: '@bart why is it slow?', workspaceName: 'W', threads: [], specAbove: false });
  assert.equal(routeCli.calls[0].model, 'gpt-6-sol');

  const summaries = home(cache(WITHOUT));
  const summaryCli = codexCli('ENGELBART_SUMMARY_OUTPUT');
  const summarize = createCliSummarizer({ readSettings: () => ({ provider: 'openai', openai: { model: 'gpt-6.1-sol', effort: 'low' } }), environment: { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: homeDir }, runDirectory: path.join(homeDir, 'summary-runs'), codexHome: summaries, codexAuthFile: authFile, run: summaryCli.run, tools });
  const summary = await summarize({ name: 'Note', text: 'body' });
  assert.deepEqual([summaryCli.calls[0].model, summary.meta.model], ['gpt-6-sol', 'gpt-6-sol'], 'the summary records the model it ran on');

  fs.writeFileSync(path.join(summaries, 'models_cache.json'), JSON.stringify(cache(WITHOUT, { version: '0.159.3' })));
  await summarize({ name: 'Note', text: 'body' });
  assert.equal(summaryCli.calls[1].model, 'gpt-6.1-sol');
  // refused: the retry, on the refreshed cache
  const fresh = home(null);
  const retryCli = codexCli('ENGELBART_SUMMARY_OUTPUT', { refused: ['gpt-6.1-sol'], refresh: () => fs.writeFileSync(path.join(fresh, 'models_cache.json'), JSON.stringify(cache(WITHOUT))) });
  const again = await createCliSummarizer({ readSettings: () => ({ provider: 'openai', openai: { model: 'gpt-6.1-sol', effort: 'low' } }), environment: { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: homeDir }, runDirectory: path.join(homeDir, 'summary-runs'), codexHome: fresh, codexAuthFile: authFile, run: retryCli.run, tools })({ name: 'Note', text: 'body' });
  assert.deepEqual([retryCli.calls.map((call) => call.model), again.meta.model], [['gpt-6.1-sol', 'gpt-6-sol'], 'gpt-6-sol']);
});

/* ------------------------------------------------------------------ the pickers */

test('the pickers: each Codex model as its family\'s listed member, a family with none hidden, steps on it moved down; Claude Code and the file untouched; as today with no cache or another version', () => {
  const root = fs.mkdtempSync(path.join(homeDir, 'models-'));
  const inForce = (place) => modelsInForce(root, place, {});
  const file = path.join(root, MODELS_FILE);
  loadModels(root);
  const before = fs.readFileSync(file, 'utf8');
  const listed = cm.listedIn([home(null), home(cache(WITHOUT))], { version: RUNNING });
  assert.deepEqual(listed, WITHOUT, 'the first home with a cache to go by');

  const bart = cm.codexMenu(inForce('bart'), listed);
  const codex = bart.providers.openai;
  assert.deepEqual(Object.keys(codex.models), ['sol', 'astra'], 'Luna, which this account has none of, is hidden');
  assert.deepEqual([codex.models.sol.name, codex.models.sol.id, codex.models.astra.id], ['Sol', 'gpt-6-sol', 'gpt-6.2-astra']);
  assert.deepEqual(codex.ladder.map((step) => step.model), ['sol', 'sol', 'astra']);
  assert.deepEqual(bart.providers.anthropic, inForce('bart').providers.anthropic, 'Claude Code\'s menu does not change');

  // a hidden family a step was on: the nearest kept below it, else the first kept
  const lunaOnly = { ...MODELS, discover: { ...MODELS.discover, providers: { ...MODELS.discover.providers, openai: { quick: { model: 'luna', effort: 'low' }, standard: { model: 'astra', effort: 'high' }, deep: { model: 'astra', effort: 'ultra' } } } } };
  const noAstra = cm.codexMenu(lunaOnly, ['gpt-6-luna', 'gpt-6.1-sol']);
  assert.deepEqual(Object.keys(noAstra.providers.openai.models), ['luna', 'sol']);
  assert.deepEqual(noAstra.providers.openai.ladder.map((step) => `${step.model} ${step.effort}`), ['sol medium', 'sol high', 'sol xhigh']);
  assert.deepEqual(Object.values(noAstra.discover.providers.openai).map((step) => step.model), ['luna', 'sol', 'sol']);
  assert.equal(cm.codexMenu(lunaOnly, WITHOUT).discover.providers.openai.quick.model, 'sol', 'nothing kept below it: the first kept');

  const build = buildChoices(cm.codexMenu(inForce('build'), listed));
  assert.deepEqual(Object.entries(build.providers.openai.models).map(([key, model]) => `${key}=${model.id}`), ['sol=gpt-6-sol', 'astra=gpt-6.2-astra']);
  assert.deepEqual(build.providers.openai.ladder, [{ model: 'sol', effort: 'high' }]);
  assert.deepEqual(build.providers.anthropic, buildChoices(inForce('build')).providers.anthropic);

  // with no cache, or one another Codex wrote, or one listing none of the families: as today
  for (const homes of [[home(null)], [home(cache(WITHOUT, { version: '0.159.3' }))]]) assert.equal(cm.listedIn(homes, { version: RUNNING }), null);
  assert.deepEqual(cm.codexMenu(inForce('bart'), null), inForce('bart'));
  assert.deepEqual(cm.codexMenu(inForce('bart'), ['gpt-5.6-codex']), inForce('bart'), 'hiding every family would leave nothing to pick');
  assert.deepEqual(buildChoices(cm.codexMenu(inForce('build'), null)), buildChoices(inForce('build')));
  // listed as they are: the menu as today
  assert.deepEqual(cm.codexMenu(inForce('bart'), ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']), inForce('bart'));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the models file is never written');
});
