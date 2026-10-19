'use strict';

// Connecting Claude Code or Codex for onboarding's agents (2026-10-14, a beta tester on a fresh Mac): "Finding projects
// was broken … 'Could not find projects in the background' and then it said try again but it like didnt work ever"; "it
// says installing claude code, even if it is already installed. it should say connecting instead"; "maybe if they dont hit
// connect it doesnt work but fails silently, so test all those edge cases"; and an import that failed before bringing
// anything in should ask to connect the provider from the workspace.
//
// Before the fix (scratch repro with the same fakes): a Claude Code whose sign-in check did not answer (signedIn null)
// counted as signed in, so the project agent ran and failed "Not logged in · Please run /login"; Try again passed the same
// provider and ran it again, failing the same way, forever; an Import your context run failed every job one after another
// with that line and finished with nothing; Install pressed while the launch's background install ran installed it twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { needsProvider } = require('../src/main/connect/provider-failure.cjs');
const { createProviders, claudeAuth, stateOf } = require('../src/main/onboarding/providers.cjs');
const { createDiscovery } = require('../src/main/onboarding/discover.cjs');
const { createFakeTools } = require('../src/main/tools/fake.cjs');
const { createTools } = require('../src/main/tools/manager.cjs');
const { detectTools, desktopCopies } = require('../src/main/tools/detect.cjs');
const { createCliGatedAgents, createFakeConnectAgents } = require('../src/main/connect/fake.cjs');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { createConnect } = require('../src/main/connect/session.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');

const temp = (name = 'provider-connect-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const until = async (read, check, what, tries = 600) => {
  for (let n = 0; n < tries; n += 1) { const now = await read(); if (check(now)) return now; await new Promise((resolve) => { setTimeout(resolve, 10); }); }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(await read()).slice(0, 1500)}`);
};

/** A pretend Mac: the tool manager over ../src/main/tools/fake.cjs, checked once. */
async function machine(spec) {
  const fake = createFakeTools(spec, { delayMs: 0, sleep: async () => {} });
  let pretend = {};
  let installs = 0;
  const actions = { ...fake.actions, installAgent: async (name) => { installs += 1; await new Promise((resolve) => { setTimeout(resolve, 40); }); return fake.actions.installAgent(name); } };
  const tools = createTools({ readTools: () => pretend, writeTools: (value) => { pretend = value; return null; }, detect: fake.detect, actions, signInProcess: fake.signInProcess, signOutProcess: fake.signOutProcess, setTimer: setTimeout, clearTimer: clearTimeout });
  await tools.check();
  return { tools, fake, installs: () => installs };
}
const providersOn = (m, home = temp()) => createProviders({ platform: 'darwin', tools: m.tools, prefs: { get: () => ({}), set() {} }, homeDir: home, fake: '', run: m.fake.execFile });

/* ------------------------------------------------------------------------------------------------- what a failure is */

test('a failure that connecting fixes: not installed, not signed in, an account turned away; not a usage limit or a passing refusal', () => {
  assert.equal(needsProvider({ kind: 'failed', message: 'Not logged in · Please run /login' }), true, 'Claude Code 2.1.300 signed out');
  assert.equal(needsProvider({ kind: 'unavailable', message: 'Claude Code was not found on the login shell PATH.' }), true);
  assert.equal(needsProvider({ kind: 'unavailable', message: 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.' }), true);
  assert.equal(needsProvider({ kind: 'failed', message: 'Credit balance is too low' }), true, 'signed in, but the account cannot run it');
  assert.equal(needsProvider({ kind: 'failed', message: 'OAuth token has expired. Please obtain a new token or refresh your existing token.' }), true);
  assert.equal(needsProvider({ kind: 'failed', message: 'Claude AI usage limit reached|1760000000' }), false, 'connecting again does not lift a limit');
  assert.equal(needsProvider({ kind: 'failed', message: 'Selected model is at capacity. Please try a different model.' }), false);
  assert.equal(needsProvider({ kind: 'stopped', message: 'Stopped.' }), false);
  assert.equal(needsProvider({ kind: 'failed', message: 'The model returned no text.' }), false);
  assert.equal(needsProvider(null), false);
});

/* ---------------------------------------------------------------------------------------------- the provider decision */

test('signed in only when the CLI says so: a check that could not tell, or Claude Code saying it is signed out, is not ready', async () => {
  assert.deepEqual(claudeAuth('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}'), { loggedIn: true, plan: 'max' });
  assert.deepEqual(claudeAuth('{"loggedIn": true, "authMethod": "console"}'), { loggedIn: true, plan: null }, 'an API account: signed in, no plan');
  assert.deepEqual(claudeAuth('{"loggedIn": false}'), { loggedIn: false, plan: null });
  assert.equal(claudeAuth(''), null, 'no answer: unknown');
  // Before: signedIn null (auth status timing out on a fresh Mac's first run) was "ready", and every agent failed.
  const unknown = await machine({ claude: '2.1.300 unknown', codex: 'missing' });
  assert.equal(unknown.tools.snapshot().tools.claude.status, 'ready', 'the check itself calls it ready');
  const out = await providersOn(unknown).status({ fresh: true });
  assert.deepEqual(out.decision, { pick: null, ask: false, choices: [], setup: true }, 'nothing to run on: Connect is asked');
  assert.equal(out.providers[0].signedIn, false);
  // The record says signed in, but the CLI now says it is not (signed out in a terminal since the check).
  const stale = await machine({ claude: '2.1.300', codex: 'missing' });
  stale.fake.state.claude.signedIn = false;
  assert.equal((await providersOn(stale).status({ fresh: true })).decision.setup, true);
  // Signed in with a plan: picked.
  const good = await machine({ claude: '2.1.300', codex: 'missing' });
  const ready = await providersOn(good).status({ fresh: true });
  assert.equal(ready.decision.pick, 'anthropic');
  assert.equal(ready.providers[0].subscription, 'max');
  assert.equal(ready.providers[0].state, 'ready');
});

test('both CLIs there, one signed in: that one runs; a CLI being installed reads "connecting", not installed', async () => {
  const both = await machine({ claude: '2.1.300 signed-out', codex: '0.160.0' });
  const out = await providersOn(both).status({ fresh: true });
  assert.equal(out.decision.pick, 'openai');
  assert.equal(out.providers.find((one) => one.id === 'anthropic').state, 'not-connected');
  assert.equal(stateOf({ installed: false, status: 'installing', busy: { action: 'install' } }, false), 'connecting');
  assert.equal(stateOf({ installed: true, status: 'signed-out', busy: { action: 'sign-in', url: null } }, false), 'signing-in');
  assert.equal(stateOf({ installed: true, status: 'ready', busy: { action: 'check' } }, true), 'ready', 'a check of a ready one is not "connecting"');
});

test('subscribed whatever the version (2026-10-16, S3): an old Claude Code signed in with a plan is updated, not asked about', async () => {
  const old = await machine({ claude: '2.1.1', codex: 'missing' });
  assert.equal(old.tools.snapshot().tools.claude.status, 'outdated');
  const claude = (await providersOn(old).status({ fresh: true })).providers.find((one) => one.id === 'anthropic');
  assert.deepEqual([claude.subscribed, claude.subscription], [true, 'max'], 'too old, but it qualifies');
  old.tools.setUpdates('ask'); // not updated on its own: it cannot run until it is
  const asked = (await providersOn(old).status({ fresh: true })).providers[0];
  assert.deepEqual([asked.signedIn, asked.subscribed], [false, true]);
  const free = (await providersOn(await machine({ claude: '2.1.300 no-plan', codex: 'missing' })).status({ fresh: true })).providers[0];
  assert.deepEqual([free.signedIn, free.subscribed], [true, false], 'signed in without a subscription: it runs, it does not qualify');
  const out = (await providersOn(await machine({ claude: '2.1.300 signed-out', codex: 'missing' })).status({ fresh: true })).providers[0];
  assert.equal(out.subscribed, false);
});

/* --------------------------------------------------------------------------------------------------- the discovery */

function discoveryOn(m, { fail = null } = {}) {
  const home = temp();
  // A repository worked on lately, so there is something to name projects from (an empty home asks no model, 2026-10-15).
  fs.mkdirSync(path.join(home, 'help-seeking', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, 'help-seeking', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  let runs = 0;
  let last = null;
  const rechecked = [];
  const providers = providersOn(m, home);
  const recheck = providers.recheck;
  providers.recheck = (id) => { rechecked.push(id); return recheck(id); };
  const gated = createCliGatedAgents({ turn: async () => ({ text: JSON.stringify({ projects: [{ title: 'Help-seeking study', description: 'An RCT' }] }) }) }, m.fake.state, { delayMs: 1 });
  const agents = { turn: async (input) => { runs += 1; if (fail) throw fail; return gated.turn(input); } };
  const discovery = createDiscovery({ agents, context: async () => ({ dataRoot: path.join(home, 'root') }), homeDir: home, providers, notify: (state) => { last = state; } });
  const settled = () => until(() => last, (state) => state && state.projects.status !== 'running', 'the project agent');
  return { discovery, home, runs: () => runs, rechecked, settled, last: () => last };
}

test('Try again on a provider that cannot run never runs it: it waits, naming the provider to connect; connected, it runs', async () => {
  const m = await machine({ claude: '2.1.300 signed-out', codex: 'missing' });
  const d = discoveryOn(m);
  // The window passes the provider picked before (F.provider); before the fix this ran the signed-out CLI every time.
  const out = await d.discovery.startProjects({ provider: 'anthropic', again: true });
  assert.equal(out.projects.status, 'waiting-provider');
  assert.equal(out.projects.connect, 'anthropic', 'the line says "Connect Claude Code"');
  assert.equal(d.runs(), 0, 'the agent was not run');
  await m.tools.connect('claude'); // Connect: the fake signs in
  assert.equal(m.tools.snapshot().tools.claude.signedIn, true);
  await d.discovery.startProjects({ provider: 'anthropic', again: true });
  const done = await d.settled();
  assert.equal(done.projects.status, 'done');
  assert.equal(d.runs(), 1);
});

test('an agent that fails as its CLI needs the person: the failure names the provider to connect, and the CLI is checked again', async () => {
  const m = await machine({ claude: '2.1.300', codex: 'missing' });
  const d = discoveryOn(m, { fail: Object.assign(new Error('Not logged in · Please run /login'), { kind: 'failed' }) });
  await d.discovery.startProjects({ provider: 'anthropic' });
  const out = await d.settled();
  assert.deepEqual([out.projects.status, out.projects.connect, out.projects.error], ['failed', 'anthropic', 'Not logged in · Please run /login']);
  assert.deepEqual(d.rechecked, ['anthropic']);
  // Any other failure is a plain one: Try again.
  const other = discoveryOn(m, { fail: Object.assign(new Error('The model returned no text.'), { kind: 'failed' }) });
  await other.discovery.startProjects({ provider: 'anthropic' });
  const plain = await other.settled();
  assert.equal(plain.projects.status, 'failed');
  assert.equal(plain.projects.connect, undefined);
});

/* ---------------------------------------------------------------------------------------------------------- Connect */

test('Connect: a missing CLI is installed and signed in from one press; pressed while the launch\'s install runs, it is not installed twice', async () => {
  const m = await machine({ claude: 'missing', codex: 'missing' });
  const background = m.tools.install(['claude']); // the launch's install (installAtLaunch)
  await until(() => m.tools.snapshot().tools.claude.busy, Boolean, 'the install running');
  const pressedInstall = m.tools.install(['claude']); // the old Install button, pressed meanwhile
  const pressedConnect = m.tools.connect('claude');
  await Promise.all([background, pressedInstall, pressedConnect]);
  assert.equal(m.installs(), 1, 'installed once');
  const claude = m.tools.snapshot().tools.claude;
  assert.deepEqual([claude.status, claude.signedIn], ['ready', true], 'and signed in after it, with no second press');
});

test('Connect on a CLI whose sign-in is never finished: it waits in the browser (visible), and Cancel leaves it not connected', async () => {
  const m = await machine({ claude: '2.1.300 signed-out', codex: 'missing', signInNever: ['claude'] });
  const pressed = m.tools.connect('claude');
  await until(() => m.tools.snapshot().tools.claude.busy, (busy) => busy && busy.action === 'sign-in', 'the sign-in waiting');
  const providers = providersOn(m);
  assert.equal((await providers.status({ fresh: true })).providers[0].state, 'signing-in', 'the row says to finish in the browser');
  m.tools.cancelSignIn('claude');
  await pressed;
  const claude = m.tools.snapshot().tools.claude;
  assert.deepEqual([claude.status, claude.busy], ['signed-out', null]);
  assert.equal((await providers.status({ fresh: true })).decision.setup, true, 'still asked to connect');
});

test('Connect on a CLI whose sign-in check could not tell: checked again, then signed in', async () => {
  const m = await machine({ claude: '2.1.300 unknown', codex: 'missing' });
  await m.tools.connect('claude');
  assert.equal(m.tools.snapshot().tools.claude.signedIn, true);
});

/* ------------------------------------------------------------------------------------- the Claude app's Claude Code */

test('the Claude app\'s own Claude Code counts as installed (no install, no "Installing"); one too old is passed over', { skip: process.platform === 'win32' && 'macOS only: the Claude app keeps its Claude Code inside claude.app' }, async () => {
  const home = temp();
  const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code', '2.1.295', '9d6405864fdc', 'claude.app', 'Contents', 'MacOS');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, '', { mode: 0o755 });
  assert.deepEqual(desktopCopies('claude', home), [file]);
  assert.deepEqual(desktopCopies('codex', home), []);
  const runner = (version) => ({
    fish: false, shellPath: '/bin/zsh',
    async shell(command, options = {}) {
      const ok = (stdout) => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false, missing: false, marked: true });
      if (command.startsWith('for tool in')) return ok('@tool git\n@tool claude\n@tool codex\n');
      if (options.env && options.env.ENGELBART_TOOL === file && command.includes('--version')) return ok(`${version} (Claude Code)\n`);
      if (options.env && options.env.ENGELBART_TOOL === file && command.includes('auth status')) return ok('{"loggedIn": true, "email": "a@example.com"}\n');
      return { code: 127, signal: null, stdout: '', stderr: '', timedOut: false, missing: false, marked: true };
    },
    async exec() { return { code: 1, missing: true, stdout: '', stderr: '' }; },
  });
  const found = await detectTools({ runner: runner('2.1.295'), only: ['claude'], home, systemBins: [] });
  assert.deepEqual([found.claude.status, found.claude.path, found.claude.source, found.claude.signedIn, found.claude.updaterOff], ['ready', file, 'desktop', true, true], 'Engelbart never updates the app\'s copy');
  const old = await detectTools({ runner: runner('2.1.100'), only: ['claude'], home, systemBins: [] });
  assert.equal(old.claude.status, 'missing', 'too old to use, and Engelbart can\'t update it: Claude Code is installed instead');
});

/* ------------------------------------------------------------------------------------------------- an import run */

const homeDir = temp('provider-connect-run-');
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => { await db.closeAll(); });

function runOn(m, { ready } = {}) {
  let turns = 0;
  const gated = createCliGatedAgents(createFakeConnectAgents({ delayMs: 2 }), m.fake.state, { delayMs: 1 });
  const agents = { turn: async (input) => { turns += 1; return gated.turn(input); } };
  const checks = [];
  const usable = ready || (() => ['claude', 'codex'].filter((name) => m.tools.snapshot().tools[name].status === 'ready').map((name) => (name === 'claude' ? 'anthropic' : 'openai')));
  const connect = createConnect({ agents, ready: usable, context: async () => ctx, homeDir, env: {}, notify: () => {}, openBridge: openToolBridge, providerCheck: (provider) => checks.push(provider) });
  return { connect, turns: () => turns, checks };
}
const vaultIn = (dir) => { fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Note.md'), '# A note\n'); return dir; };

test('an import run whose CLI is not signed in waits for it (one failed turn, not every job), and goes on once connected', async () => {
  const m = await machine({ claude: '2.1.300 unknown', codex: 'missing' }); // the check could not tell: usable says ready
  const run = runOn(m);
  const vault = vaultIn(path.join(homeDir, 'Vault-a'));
  const started = await run.connect.start({ provider: 'anthropic', direct: { mode: 'manual', projects: [{ id: 'p', title: 'Study' }], apps: ['Obsidian', 'Claude Code'], scopes: { Obsidian: { folders: [{ path: vault }], note: '' } } } });
  const blocked = await until(() => run.connect.state(started.id), (s) => s.blocked, 'the run waiting');
  assert.deepEqual([blocked.blocked.provider, blocked.blocked.name, blocked.blocked.error], ['anthropic', 'Claude Code', 'Not logged in · Please run /login']);
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  const now = run.connect.state(started.id);
  assert.equal(now.jobs.some((job) => job.status === 'failed'), false, 'nothing failed: the jobs wait');
  assert.ok(now.jobs.every((job) => job.status === 'queued'), JSON.stringify(now.jobs.map((job) => job.status)));
  assert.ok(run.turns() <= 2, `no cascade of failing turns (${run.turns()})`);
  assert.deepEqual(run.checks, ['anthropic'], 'its CLI is checked again');
  assert.throws(() => run.connect.unblock(started.id, 'openai'), /Codex is not connected yet/, 'the other is not there');
  await m.tools.connect('claude');
  run.connect.unblock(started.id);
  const done = await until(() => run.connect.state(started.id), (s) => s.jobs.filter((job) => job.kind === 'import').every((job) => job.status === 'done'), 'the imports done');
  assert.equal(done.blocked, null);
  run.connect.stop(started.id);
  run.connect.dismiss(started.id);
});

test('an import started with neither CLI able to run starts waiting (the workspace asks), not an error in the flow', async () => {
  const m = await machine({ claude: 'missing', codex: 'missing' });
  const run = runOn(m, { ready: () => [] });
  const vault = vaultIn(path.join(homeDir, 'Vault-b'));
  const started = await run.connect.start({ provider: 'openai', direct: { mode: 'manual', projects: [{ id: 'p', title: 'Study' }], apps: ['Obsidian'], scopes: { Obsidian: { folders: [{ path: vault }], note: '' } } } });
  assert.equal(started.blocked.provider, 'openai', 'the one the person chose');
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(run.turns(), 0);
  // The librarian's chat (Connect your library) still says so at once.
  await assert.rejects(run.connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } } }), /Sign in to Claude Code or Codex first/);
  run.connect.stop(started.id);
  run.connect.dismiss(started.id);
});

test('a run saved before runs waited (every job "Not logged in", nothing in) is picked up again, waiting for its provider', async () => {
  const id = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const dir = path.join(ctx.dataRoot, '.connect', id);
  fs.mkdirSync(dir, { recursive: true });
  const job = (n, kind, apps) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, key: `${kind}:notes:${apps.join(',')}`, kind, source: 'notes', label: `Importing ${apps[0]}`, apps, status: 'failed', notes: 0, items: 0, error: 'Not logged in · Please run /login', plan: 'Bring in their notes.', started: '2026-10-13T20:00:00.000Z', ended: '2026-10-13T20:00:01.000Z' });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    id, mode: 'onboarding', provider: 'anthropic', created: new Date().toISOString(), done: true, finished: true, stopped: false, dismissed: false, chat: [{ role: 'agent', text: 'Bringing in…', opener: true }],
    jobs: [job(1, 'import', ['Obsidian'])], needs: [], counts: { notes: 0, items: 0 }, memory: { status: 'skipped' },
    direct: { mode: 'manual', projects: ['Study'] }, choices: { sources: { notes: { on: true, apps: ['Obsidian'] } }, direct: { mode: 'manual', projects: [{ id: 'p', title: 'Study' }], apps: ['Obsidian'], scopes: {} } },
  }));
  const m = await machine({ claude: '2.1.300 signed-out', codex: 'missing' });
  const run = runOn(m, { ready: () => [] });
  assert.equal(run.connect.resume(ctx), 1);
  const now = run.connect.state(id);
  assert.equal(now.blocked.provider, 'anthropic');
  assert.deepEqual(now.jobs.map((one) => one.status), ['queued'], 'its job waits to run again');
  run.connect.stop(id);
  run.connect.dismiss(id);
});

/* ------------------------------------------------------------------------------------------------------ the window */

const loadTools = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/tools.js')).href);

test('rows say "Connecting…" for Claude Code and Codex while Engelbart installs or checks them, never "Installing"', async () => {
  const { rowOf } = await loadTools();
  const base = { id: 'claude', name: 'Claude Code', minimum: '2.1.278', installed: false, status: 'missing', busy: null };
  assert.equal(rowOf({ ...base, status: 'installing', busy: { action: 'install', phase: null } }).state, 'Connecting…');
  assert.equal(rowOf({ ...base, status: 'checking' }).state, 'Connecting…');
  assert.equal(rowOf({ ...base, id: 'git', name: 'Git', busy: { action: 'install', phase: 'Waiting for Apple’s installer' } }).state, 'Waiting for Apple’s installer', 'Git keeps its installer\'s steps');
});

// From Amitav (2026-10-15): one tools screen, its categories with what the agents found added to them. The tool agent is
// told the categories and gives each extra tool one; calendars and mail never come back.
test('the tool agent is told the categories, every extra tool comes back in one (else Other), calendars and mail left out', async () => {
  const m = await machine({ claude: '2.1.300', codex: 'missing' });
  const home = temp();
  let told = null;
  let last = null;
  const reply = { tools: [], additional: [{ name: 'Figma', website: 'https://figma.com', used: true, evidence: 'daily visits', category: 'Other' }, { name: 'Readwise', used: true, evidence: 'highlights', category: 'notes' }, { name: 'Google Calendar', used: true, evidence: 'every day', category: 'other' }] };
  const gated = createCliGatedAgents({ turn: async (input) => { if (/Say which tools they use now/.test(input.message)) told = input; return { text: JSON.stringify(reply) }; } }, m.fake.state, { delayMs: 1 });
  const discovery = createDiscovery({ agents: gated, context: async () => ({ dataRoot: path.join(home, 'root') }), homeDir: home, providers: providersOn(m, home), notify: (state) => { last = state; } });
  await discovery.startTools({ provider: 'anthropic' });
  const done = await until(() => last, (state) => state && state.tools.status === 'done', 'the tool agent');
  assert.ok(told, 'the tool agent ran');
  const categories = told.message.match(/<categories[^>]*>\n([^<]+)\n<\/categories>/);
  assert.ok(categories, 'a <categories> block');
  assert.deepEqual(JSON.parse(categories[1]).map((one) => one.id), ['notes', 'transcripts', 'chats', 'sites', 'papers', 'code', 'other']);
  assert.match(told.system, /"category"/);
  assert.match(told.system, /calendar/i);
  assert.deepEqual(done.tools.results.additional.map((tool) => [tool.name, tool.category]), [['Figma', 'other'], ['Readwise', 'notes']]);
});

test('discovery forgets a data root: what it found is read again from that root (test mode\'s reset, 2026-10-15)', async () => {
  const m = await machine({ claude: '2.1.300', codex: 'missing' });
  const d = discoveryOn(m);
  await d.discovery.startProjects({ provider: 'anthropic' });
  const done = await d.settled();
  assert.equal(done.projects.status, 'done');
  const root = (await d.discovery.state()).projects;
  assert.equal(root.status, 'done');
  // the root wiped on disk, then forgotten: idle again, so the next start runs
  const { dataRoot } = { dataRoot: path.join(d.home, 'root') };
  fs.rmSync(path.join(dataRoot, '.connect'), { recursive: true, force: true });
  d.discovery.forget(dataRoot);
  assert.equal((await d.discovery.state()).projects.status, 'idle');
});
