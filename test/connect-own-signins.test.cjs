'use strict';

// The steps whose sign-in Engelbart can see for itself (2026-10-14, a beta tester's Zotero: "she authenticated in google
// but then she still saw the sign into chrome thing, which did not let her click later. when she finally hit later,
// nothing was imported, so she was super confused"): Zotero's and GitHub's own sign-ins and the connectors' (Granola),
// and every other way an Import your context run can end with nothing from an app, each with its reason.
//
// Before the fix, with the same fakes: the Zotero import started signed out; its agent asked to sign in; the step closed;
// the agent read the mirror before the first sync had landed ("has not finished its first sync") and asked again with
// kind "confirm", whose popup fell through to "Sign in to Zotero · Continue in Chrome · Open Chrome"; Later then left
// "Zotero was skipped." and nothing in the status said why.

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
const { createConnect } = require('../src/main/connect/session.cjs');
const { createImportTools } = require('../src/main/connect/tools.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-own-signins-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => { await db.closeAll(); });

const until = async (read, check, what, tries = 800) => {
  for (let n = 0; n < tries; n += 1) { const now = read(); if (check(now)) return now; await new Promise((resolve) => { setTimeout(resolve, 10); }); }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(read()).slice(0, 2000)}`);
};
const ENDED = ['done', 'failed', 'stopped'];
const project = [{ id: 'p', title: 'Help-seeking study' }];

/** Zotero's sign-in and mirror as main has them (zotero/connection.cjs, sync.cjs): signed out, then what the person does. */
function fakeZotero(mirror, { syncMs = 80 } = {}) {
  const state = { connected: false, pending: null, error: '', connects: 0, readies: 0 };
  return {
    state,
    status: () => ({ connected: state.connected, pending: state.pending, error: state.error }),
    root: () => (state.connected ? mirror : null),
    connect: async () => { state.connects += 1; state.error = ''; state.pending = { kind: 'browser', expiresAt: Date.now() + 600_000 }; return { connected: false, pending: state.pending, error: '' }; },
    finish() { state.pending = null; state.connected = true; }, // the person signed in on zotero.org (Google login and all)
    fail(message) { state.pending = null; state.error = message; },
    // the first sync, which lands a little after the sign-in
    ready: () => { state.readies += 1; return new Promise((resolve) => { setTimeout(() => { fs.mkdirSync(mirror, { recursive: true }); fs.writeFileSync(path.join(mirror, 'items.json'), JSON.stringify([{ key: `ABCD234${path.basename(mirror).slice(-1)}`, title: 'Help-seeking in CS1', url: `https://example.org/help-seeking/${path.basename(mirror)}`, creators: [], collections: [] }])); fs.writeFileSync(path.join(mirror, 'collections.json'), '[]'); resolve({ state: 'synced' }); }, syncMs); }); },
  };
}

/**
 * An import agent that does what its skills say, as a model would: Zotero's tools, asking the person when a tool says to
 * (and, on any other Zotero error, with kind "confirm", as the beta's agent did); GitHub's repos; Granola through its
 * connector when its turn has one, else a connector step.
 */
function skilledAgents(calls) {
  return {
    async turn({ meta, connectors = [] }) {
      const { callTool, job } = meta;
      const tryTool = async (name, args = {}) => { try { const out = await callTool(name, args); calls.push(`${name}: ok`); return out; } catch (error) { calls.push(`${name}: ${error.message}`); return { error: error.message }; } };
      if (meta.kind !== 'import') return { text: '', session: null };
      if (job.apps.includes('Zotero')) {
        let out = null;
        for (let n = 0; n < 4; n += 1) {
          out = await tryTool('zotero_collections');
          if (!out.error) break;
          const asked = await callTool('needs_you', { kind: /not signed in/.test(out.error) ? 'signin' : 'confirm', reason: /not signed in/.test(out.error) ? 'Sign in to Zotero' : 'Let Zotero finish syncing your library' });
          calls.push(`needs_you → ${asked.status}`);
          if (asked.status === 'skipped') return { text: 'Zotero was skipped.', session: null };
        }
        const items = await tryTool('zotero_items', {});
        if (items.error) return { text: `Could not read Zotero: ${items.error}`, session: null };
        const added = await tryTool('import_zotero_items', { keys: items.map((item) => item.key) });
        return { text: `Brought in ${added.added || 0} papers.`, session: null };
      }
      if (job.apps.includes('GitHub')) {
        const repos = await tryTool('github_repos');
        if (repos.error) { const asked = await callTool('needs_you', { kind: 'signin', reason: 'Sign in to GitHub' }); calls.push(`needs_you → ${asked.status}`); return { text: 'GitHub: nothing.', session: null }; }
        for (const repo of repos) await callTool('add_note', { title: repo.fullName, markdown: `The ${repo.fullName} repository.`, source: `test:${repo.fullName}` });
        return { text: `Brought in ${repos.length} repositories.`, session: null };
      }
      if (job.apps.includes('Granola')) {
        if (connectors.some((server) => server.app === 'Granola')) {
          await callTool('add_note', { title: 'Lab meeting', markdown: 'The lab meeting\'s notes, from Granola.', source: `test:granola:${job.id}` });
          return { text: 'Brought in 1 meeting.', session: null };
        }
        const asked = await callTool('needs_you', { kind: 'connector', reason: 'Connect Granola' });
        calls.push(`needs_you(connector) → ${asked.status}`);
        return { text: 'No Granola connection in this run.', session: null };
      }
      return { text: 'Nothing.', session: null };
    },
  };
}

function connectWith(rest) {
  return createConnect({ ready: () => ['anthropic', 'openai'], context: async () => ctx, homeDir, env: {}, notify: () => {}, openBridge: openToolBridge, deps: { stepPollMs: 15, allowed: true }, ...rest });
}
const imports = (s, app) => s.jobs.filter((job) => job.kind === 'import' && job.apps.includes(app));

test('Zotero signed out: held on one Sign in step; signing in closes it by itself and starts the import, which waits for the first sync and brings the papers in, with no second step', async () => {
  const zotero = fakeZotero(path.join(homeDir, 'mirror-1'));
  const calls = [];
  const connect = connectWith({ agents: skilledAgents(calls), zotero });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Zotero'], scopes: {} } });
  const state = () => connect.state(started.id);
  let now = await until(state, (s) => s.finished && s.needs.length, 'the Zotero step');
  assert.deepEqual(now.needs.map((need) => [need.app, need.kind]), [['Zotero', 'signin']], 'one step: Engelbart\'s own sign-in');
  assert.deepEqual(imports(now, 'Zotero'), [], 'no agent started signed out (it raced the first sync and asked again)');
  const step = now.needs[0];
  assert.equal(step.opened, false);
  // Sign in: Engelbart's own sign-in, started in main (the window no longer waits on events it can miss).
  now = await connect.need(started.id, step.id, 'open');
  assert.equal(zotero.state.connects, 1);
  assert.equal(now.needs[0].opened, true, 'its page is open in the browser: the popup says to finish there');
  assert.equal(now.needs[0].error, '');
  // Pressed again while it waits: the same sign-in's page again, never a second step.
  await connect.need(started.id, step.id, 'open');
  assert.equal(connect.state(started.id).needs.length, 1);
  zotero.finish();
  now = await until(state, (s) => !s.needs.length, 'the step closing once Zotero is connected');
  now = await until(state, (s) => imports(s, 'Zotero').some((job) => ENDED.includes(job.status)), 'the Zotero import');
  const job = imports(now, 'Zotero')[0];
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.items, 1, 'the paper came in');
  assert.ok(calls.includes('zotero_collections: ok'), `the first read waited for the sync: ${calls.join(' | ')}`);
  assert.equal(calls.some((call) => call.startsWith('needs_you')), false, `the agent never had to ask: ${calls.join(' | ')}`);
  assert.ok(now.log.some((entry) => /Waiting for your Zotero library to sync/.test(entry.text)));
  assert.deepEqual(now.leftOut, []);
  connect.stop(started.id);
});

test('Zotero: an agent that asks anyway (any kind, "confirm" included) once Zotero is connected gets no step; it is told to try again', async () => {
  const zotero = fakeZotero(path.join(homeDir, 'mirror-2'), { syncMs: 30 });
  zotero.finish(); // connected, its library not synced yet
  const calls = [];
  // The beta's agent: Zotero's collections while the sync had not landed, then needs_you "confirm".
  const agents = {
    async turn({ meta }) {
      if (meta.kind !== 'import') return { text: '', session: null };
      const asked = await meta.callTool('needs_you', { kind: 'confirm', reason: 'Let Zotero finish syncing' });
      calls.push(asked);
      const collections = await meta.callTool('zotero_collections', {});
      calls.push(collections);
      return { text: 'Read the collections.', session: null };
    },
  };
  const connect = connectWith({ agents, zotero });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Zotero'], scopes: {} } });
  const now = await until(() => connect.state(started.id), (s) => imports(s, 'Zotero').some((job) => ENDED.includes(job.status)), 'the import');
  assert.equal(calls[0].status, 'done');
  assert.match(calls[0].note, /signed in already.*Do not call needs_you/);
  assert.equal(calls[1].items, 1, 'the collections, once the sync landed');
  assert.equal(now.needs.length, 0);
  assert.ok(!now.log.some((entry) => /^Needs you/.test(entry.text)), 'no step was ever made');
  connect.stop(started.id);
});

test('Zotero: the sync that never lands, or fails, is said to the agent as such, never as a sign-in to ask for', async () => {
  const root = path.join(homeDir, 'mirror-never');
  const log = [];
  const tools = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(homeDir, 'tools-dir') }, context: async () => ctx, zotero: { root: () => root, ready: async () => ({ state: 'error', error: 'Zotero could not be reached.' }) }, log: (text) => log.push(text) });
  await assert.rejects(tools('zotero_collections', {}), /could not be synced: Zotero could not be reached\..*do not call needs_you/);
  const slow = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(homeDir, 'tools-dir') }, context: async () => ctx, zotero: { root: () => root, syncWaitMs: 60, ready: () => new Promise(() => {}) } });
  await assert.rejects(slow('zotero_items', {}), /still syncing.*do not call needs_you/);
  const none = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(homeDir, 'tools-dir') }, context: async () => ctx, zotero: { root: () => null } });
  await assert.rejects(none('zotero_collections', {}), /Zotero is not signed in\. Call needs_you/);
  assert.deepEqual(log, ['Waiting for your Zotero library to sync']);
});

test('Zotero: a sign-in that ends without an account says why on the step, and Sign in starts it again', async () => {
  const zotero = fakeZotero(path.join(homeDir, 'mirror-3'));
  const connect = connectWith({ agents: skilledAgents([]), zotero });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Zotero'], scopes: {} } });
  const state = () => connect.state(started.id);
  const step = (await until(state, (s) => s.finished && s.needs.length, 'the step')).needs[0];
  await connect.need(started.id, step.id, 'open');
  zotero.fail('Cancelled on Zotero.');
  let now = await until(state, (s) => s.needs[0] && s.needs[0].error, 'the reason on the step');
  assert.equal(now.needs[0].error, 'Cancelled on Zotero.');
  assert.equal(now.needs[0].opened, false, 'Sign in again');
  // "I'm signed in" is never taken on the person's word for Engelbart's own sign-in.
  now = await connect.need(started.id, step.id, 'done');
  assert.match(now.needs[0].error, /Still not signed in to Zotero/);
  await connect.need(started.id, step.id, 'open');
  assert.equal(zotero.state.connects, 2);
  zotero.finish();
  await until(state, (s) => imports(s, 'Zotero').length === 1, 'the import, once signed in');
  connect.stop(started.id);
});

test('Zotero: Later leaves it out with its reason, the run ends with nothing to run, and the status says why', async () => {
  const zotero = fakeZotero(path.join(homeDir, 'mirror-4'));
  const connect = connectWith({ agents: skilledAgents([]), zotero });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Zotero'], scopes: {} } });
  const state = () => connect.state(started.id);
  const step = (await until(state, (s) => s.finished && s.needs.length, 'the step')).needs[0];
  await connect.need(started.id, step.id, 'open');
  const now = await connect.need(started.id, step.id, 'skip'); // Later
  assert.deepEqual(now.needs, []);
  assert.deepEqual(imports(now, 'Zotero'), [], 'nothing runs for it');
  assert.deepEqual(now.leftOut, [{ app: 'Zotero', why: 'you skipped signing in' }]);
  assert.equal(now.finished, true);
  zotero.finish(); // signed in after Later (the tab was still open): nothing starts, Later holds
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.deepEqual(imports(connect.state(started.id), 'Zotero'), []);
  const { nothingLines } = status();
  assert.deepEqual(nothingLines(now, [], []), [{ name: 'Zotero', line: 'Nothing came in from Zotero: you skipped signing in.' }]);
  const html = renderStatus(now);
  assert.match(html, /Your imports have finished/, 'ended, though nothing was left to run');
  // The completion says nothing about what did not come in (2026-10-15: "no one will read any of it").
  assert.doesNotMatch(html, /Nothing came in from/);
  assert.doesNotMatch(html, /border-(top|bottom)/, 'no dividing lines');
  connect.stop(started.id);
});

test('Zotero: a step kept across a restart, signed in meanwhile: its import starts with no step', async () => {
  const zotero = fakeZotero(path.join(homeDir, 'mirror-5'), { syncMs: 10 });
  const first = connectWith({ agents: skilledAgents([]), zotero });
  const started = await first.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Zotero'], scopes: {} } });
  await until(() => first.state(started.id), (s) => s.finished && s.needs.length === 1, 'the Zotero step');
  first.suspendAll();
  zotero.finish();
  const again = connectWith({ agents: skilledAgents([]), zotero });
  assert.equal(again.resume(ctx), 1);
  const now = await until(() => again.state(started.id), (s) => imports(s, 'Zotero').some((job) => ENDED.includes(job.status)), 'the Zotero import after the restart');
  assert.equal(now.needs.length, 0);
  assert.equal(imports(now, 'Zotero')[0].items, 1);
  again.stop(started.id);
});

test('GitHub signed out: held on its step, the device code on the popup, the import once connected; Later leaves it out with why', async () => {
  const gh = { connected: false, pending: null, error: '' };
  const github = {
    status: () => ({ ...gh }),
    connect: async () => { gh.pending = { kind: 'device', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 900_000 }; return { ...gh }; },
    repos: async () => ({ repos: [{ fullName: 'hudson/engelbart', url: 'https://github.com/hudson/engelbart', private: true }] }),
  };
  const calls = [];
  const connect = connectWith({ agents: skilledAgents(calls), github });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['GitHub'], scopes: {} } });
  const state = () => connect.state(started.id);
  const step = (await until(state, (s) => s.finished && s.needs.length, 'the GitHub step')).needs[0];
  assert.deepEqual([step.app, step.kind], ['GitHub', 'signin']);
  assert.deepEqual(imports(connect.state(started.id), 'GitHub'), []);
  const now = await connect.need(started.id, step.id, 'open');
  assert.equal(now.needs[0].code, 'WDJB-MJHT', 'the code to enter on GitHub');
  Object.assign(gh, { connected: true, pending: null });
  const ended = await until(state, (s) => imports(s, 'GitHub').some((job) => ENDED.includes(job.status)), 'the GitHub import');
  assert.equal(imports(ended, 'GitHub')[0].notes, 1, calls.join(' | '));
  assert.equal(calls.some((call) => call.startsWith('needs_you')), false);
  connect.stop(started.id);

  // Later, on another run.
  gh.connected = false;
  const later = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['GitHub'], scopes: {} } });
  const card = (await until(() => connect.state(later.id), (s) => s.finished && s.needs.length, 'the step')).needs[0];
  const left = await connect.need(later.id, card.id, 'skip');
  assert.deepEqual(left.leftOut, [{ app: 'GitHub', why: 'you skipped signing in' }]);
  connect.stop(later.id);
});

test('Granola (a connector nothing reaches): held on a Connect step, the import once connected and with the connection; Later calls the sign-in off', async () => {
  let signedIn = false;
  let release = null;
  const cancelled = [];
  const connectors = {
    status: (app) => ({ app, connected: app === 'Granola' && signedIn }),
    reaches: async (app) => app === 'Granola' && signedIn,
    signIn: () => new Promise((resolve, reject) => { release = { resolve: () => { signedIn = true; resolve({ connected: true }); }, reject }; }),
    cancel: (app) => { cancelled.push(app); if (release) release.reject(new Error('Granola sign-in was cancelled')); },
    serversForRun: async (apps) => (signedIn && apps.includes('Granola') ? [{ app: 'Granola', name: 'granola', url: 'https://mcp.granola.ai/mcp', token: 't' }] : []),
  };
  const calls = [];
  const connect = connectWith({ agents: skilledAgents(calls), connectors });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Granola'], scopes: {} } });
  const state = () => connect.state(started.id);
  const step = (await until(state, (s) => s.finished && s.needs.length, 'the Granola step')).needs[0];
  assert.deepEqual([step.app, step.kind], ['Granola', 'connector']);
  assert.deepEqual(imports(connect.state(started.id), 'Granola'), [], 'not started without its connection');
  // Connect: waited for in the background, so the window's call returns at once and Later stays usable.
  const opened = await connect.need(started.id, step.id, 'open');
  assert.equal(opened.needs[0].busy, true);
  release.resolve();
  const now = await until(state, (s) => imports(s, 'Granola').some((job) => ENDED.includes(job.status)), 'the Granola import');
  assert.equal(imports(now, 'Granola')[0].notes, 1, calls.join(' | '));
  connect.stop(started.id);

  signedIn = false;
  const later = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Granola'], scopes: {} } });
  const card = (await until(() => connect.state(later.id), (s) => s.finished && s.needs.length, 'the step')).needs[0];
  await connect.need(later.id, card.id, 'open');
  const left = await connect.need(later.id, card.id, 'skip');
  assert.deepEqual(cancelled, ['Granola'], 'its sign-in, still waiting in the browser, called off');
  assert.deepEqual(left.leftOut, [{ app: 'Granola', why: 'you skipped connecting it' }]);
  connect.stop(later.id);
});

test('a connector signed in while its agent ran: the agent finishes, and the import runs again with the connection', async () => {
  let signedIn = false;
  const connectors = {
    status: (app) => ({ app, connected: app === 'Granola' && signedIn }),
    reaches: async () => true, // the person's own CLI was thought to reach it, so nothing held it
    signIn: async () => { signedIn = true; return { connected: true }; },
    cancel: () => {},
    serversForRun: async (apps) => (signedIn && apps.includes('Granola') ? [{ app: 'Granola', name: 'granola', url: 'https://mcp.granola.ai/mcp', token: 't' }] : []),
  };
  const calls = [];
  const connect = connectWith({ agents: skilledAgents(calls), connectors });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Granola'], scopes: {} } });
  const state = () => connect.state(started.id);
  const step = (await until(state, (s) => s.needs.some((need) => need.kind === 'connector'), 'the agent\'s connector step')).needs[0];
  assert.equal(step.jobs, 1);
  await connect.need(started.id, step.id, 'open');
  const now = await until(state, (s) => imports(s, 'Granola').length === 2 && imports(s, 'Granola').every((job) => ENDED.includes(job.status)), 'the import again');
  assert.deepEqual(imports(now, 'Granola').map((job) => job.notes), [0, 1], `the second run had the connection: ${calls.join(' | ')}`);
  assert.ok(now.log.some((entry) => /Again, now that Granola is connected/.test(entry.text)));
  connect.stop(started.id);
});

test('the other steps: "confirm" and a folder permission are done on their button; Apple Notes\' Don\'t allow and a Google sign-in Engelbart can\'t use are left out with why', async () => {
  const asked = [];
  const agents = {
    async turn({ meta }) {
      if (meta.kind !== 'import') return { text: '', session: null };
      const app = meta.job.apps[0];
      const kind = app === 'Apple Notes' ? 'permission' : app === 'Obsidian' ? 'confirm' : 'permission';
      const out = await meta.callTool('needs_you', { kind, reason: app === 'Obsidian' ? 'Open Obsidian once so its vault is indexed' : `Allow ${app}` });
      asked.push([app, kind, out.status]);
      return { text: `${app}: ${out.status}`, session: null };
    },
  };
  // Google Drive: signed in in the browser, the copy refused by Engelbart's (Google's binding), and no browser agents. (It
  // was Gmail, the same Google sign-in, until Gmail was paused, From Amitav 2026-10-15.)
  const webSignIn = { supports: () => true, canSignIn: () => true, signInQuiet: async () => ({ signedIn: false, held: true }), signedIn: async () => false, keychainNote: () => '', browserName: () => 'Chrome' };
  const appleNotes = { permission: async () => ({ allowed: false, error: 'macOS did not allow it' }) };
  const connect = connectWith({ agents, webSignIn, appleNotes });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: project, apps: ['Obsidian', 'Apple Notes', 'Google Docs', 'PDFs on this Mac'], scopes: {} } });
  const state = () => connect.state(started.id);
  await until(state, (s) => s.needs.length === 3, 'three steps');
  for (const need of connect.state(started.id).needs) {
    if (need.kind === 'confirm') await connect.need(started.id, need.id, 'open'); // Done
    else if (need.app === 'Apple Notes') await connect.need(started.id, need.id, 'skip'); // Don't allow
    else await connect.need(started.id, need.id, 'open'); // Allow (a folder macOS guards)
  }
  const now = await until(state, (s) => s.jobs.filter((job) => job.kind === 'import').every((job) => ENDED.includes(job.status)) && !s.needs.length, 'every import ended');
  assert.deepEqual(asked.sort(), [['Apple Notes', 'permission', 'skipped'], ['Obsidian', 'confirm', 'done'], ['PDFs on this Mac', 'permission', 'done']]);
  assert.deepEqual(now.leftOut.sort((a, b) => a.app.localeCompare(b.app)), [
    { app: 'Apple Notes', why: 'you didn’t allow Engelbart to read it' },
    { app: 'Google Docs', why: 'you\'re signed in to it in Chrome, but it doesn\'t let Engelbart use that sign-in' },
  ]);
  const lines = status().nothingLines(now, now.jobs.filter((job) => job.kind === 'import'), []).map((entry) => entry.line);
  assert.ok(lines.includes('Nothing came in from Apple Notes: you didn’t allow Engelbart to read it.'), lines.join('\n'));
  assert.ok(lines.includes('Nothing came in from Google Drive: you\'re signed in to it in Chrome, but it doesn\'t let Engelbart use that sign-in.'), lines.join('\n'));
  assert.ok(lines.includes('Nothing came in from Obsidian. Obsidian: done.'), lines.join('\n'));
  connect.stop(started.id);
});

/* ------------------------------------------------------------------------------------------------- the popups */

let compiled = null;
function components() {
  if (compiled) return compiled;
  const out = {};
  for (const [name, file] of [['NeedPopup', 'NeedPopup.jsx'], ['ImportStatus', 'ImportStatus.jsx']]) {
    const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/import', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.svg': 'dataurl', '.png': 'dataurl' } });
    const filename = path.join(__dirname, `__${name}.cjs`);
    const mod = new Module(filename, module);
    mod.paths = module.paths;
    mod._compile(built.outputFiles[0].text, filename);
    out[name] = mod.exports;
  }
  compiled = out;
  return out;
}
const status = () => components().ImportStatus;
const renderStatus = (session) => renderToStaticMarkup(React.createElement(components().ImportStatus.default, { session, onClose() {}, onNeed() {}, onSkip() {}, onStop() {}, onDone() {} }));
const renderNeed = (need) => renderToStaticMarkup(React.createElement(components().NeedPopup.default, { need, onOpen() {}, onDone() {}, onSkip() {}, onLater() {} }));

test('the step popups: Zotero\'s and GitHub\'s never name a browser they don\'t open, "confirm" has words of its own, Skip is never disabled, and the scrim is the overlay', () => {
  const { needCopy } = components().NeedPopup;
  const base = { id: 'n', app: 'Zotero', kind: 'signin', browser: 'Chrome', opened: false, busy: false, error: '' };
  assert.deepEqual(needCopy(base), { title: 'Sign in to Zotero', text: '', primary: 'Sign in', secondary: 'Skip' });
  assert.deepEqual(needCopy({ ...base, kind: 'confirm' }).primary, 'Sign in', 'any kind, for Zotero, is its own sign-in');
  assert.equal(needCopy({ ...base, opened: true }).primary, 'Open again');
  assert.equal(needCopy({ ...base, opened: true }).text, 'Finish signing in in your browser.');
  assert.equal(needCopy({ ...base, app: 'GitHub', opened: true, code: 'WDJB-MJHT' }).text, 'Enter WDJB-MJHT on GitHub, then come back.');
  for (const words of [needCopy(base), needCopy({ ...base, opened: true }), needCopy({ ...base, app: 'GitHub' })]) assert.doesNotMatch(JSON.stringify(words), /Chrome/);
  assert.deepEqual(needCopy({ ...base, app: 'Obsidian', kind: 'confirm', reason: 'Open Obsidian once so its vault is indexed.' }), { title: 'Open Obsidian once so its vault is indexed', text: '', primary: 'Done', secondary: 'Skip' });
  assert.deepEqual(needCopy({ ...base, app: 'Granola', kind: 'connector' }), { title: 'Connect Granola', text: '', primary: 'Connect', secondary: 'Skip', waiting: false });
  assert.equal(needCopy({ ...base, app: 'Granola', kind: 'connector', busy: true }).primary, 'Waiting…');
  // From Amitav (2026-10-15): "get rid of the 'Continue in Chrome' subtext on all these permission prompts, and change
  // 'Later' to 'Skip'".
  for (const kind of ['signin', 'code', '2fa', 'captcha', 'confirm', 'folder', 'connector']) {
    const words = needCopy({ ...base, app: 'Notion', kind });
    assert.doesNotMatch(words.text, /Continue in/, kind);
    assert.equal(words.secondary, 'Skip', kind);
  }
  assert.equal(needCopy({ ...base, app: 'Notion', kind: 'signin' }).primary, 'Open Chrome', 'the button still says where it goes');
  // Waiting on a sign-in disables only the primary button; Skip always works.
  for (const need of [{ ...base, busy: true }, { ...base, app: 'Granola', kind: 'connector', busy: true, opened: true }]) {
    const html = renderNeed(need);
    assert.match(html, /<button type="button" class="link" data-need-later="n">Skip<\/button>/);
    assert.match(html, /data-need-primary="n" disabled=""/);
  }
  // The overlay is the scrim (fixed, the whole window), so native views (the Stage's page, post-its) step aside for it;
  // the outer element has no height.
  const html = renderNeed(base);
  assert.match(html, /<div class="scrim" data-overlay="1" data-cover="1">/);
  assert.doesNotMatch(html, /<div class="ix ix-overlay" data-overlay/);
  assert.match(renderStatus({ id: 's', jobs: [], needs: [], leftOut: [] }), /<div class="scrim" data-overlay="1" data-cover="1">/);
});

test('the completion: what came in as a list, an icon and a name a row, each logo once (2026-10-15: "no duplicate globe icons or claude")', () => {
  const job = (id, apps, label) => ({ id, kind: 'import', apps, label, status: 'done', notes: 2, items: 0 });
  const jobs = [job('1', ['Obsidian'], 'Notes: Obsidian'), job('2', ['Claude'], 'AI chats: Claude'), job('3', ['Claude Code'], 'AI chats: Claude Code'), job('4', ['__sites'], 'Websites: Saved URLs'), job('5', [], 'Other tools: Linear')];
  const html = renderStatus({ id: 's', finished: true, jobs, needs: [], leftOut: [] });
  assert.match(html, /Your imports are complete!/);
  assert.deepEqual([...html.matchAll(/data-imported="([^"]+)"/g)].map((m) => m[1]), ['Obsidian', 'Claude, Claude Code', 'Saved URLs, Linear']);
  assert.equal((html.match(/class="imported-row"/g) || []).length, 3);
  assert.doesNotMatch(html, /review-logo/, 'no tiles');
});

test('the status: each source that ended with nothing says why, in one line, and an app left out before it ran has its row', () => {
  const { nothingLines } = status();
  const jobs = [
    { id: '1', kind: 'import', apps: ['Zotero'], label: 'Papers: Zotero', status: 'done', notes: 0, items: 0, summary: 'Zotero was skipped.' },
    { id: '2', kind: 'import', apps: ['Granola'], label: 'Meeting transcripts: Granola', status: 'failed', notes: 0, items: 0, error: 'The model is at capacity. Try later.' },
    { id: '3', kind: 'import', apps: ['Obsidian'], label: 'Notes: Obsidian', status: 'done', notes: 4, items: 0 },
    { id: '4', kind: 'import', apps: ['Overleaf'], label: 'Papers: Overleaf', status: 'done', notes: 0, items: 0, summary: 'No project matched the study. Looked at 12.' },
  ];
  const session = { id: 's', finished: true, jobs, needs: [], leftOut: [{ app: 'Zotero', why: 'you skipped signing in' }, { app: 'GitHub', why: 'you skipped signing in' }] };
  assert.deepEqual(nothingLines(session, jobs, [jobs[2]]).map((entry) => entry.line), [
    'Nothing came in from Zotero: you skipped signing in.',
    'Nothing came in from Granola: its import failed (The model is at capacity).',
    'Nothing came in from Overleaf. No project matched the study.',
    'Nothing came in from GitHub: you skipped signing in.',
  ]);
  const html = renderStatus(session);
  assert.match(html, /Your imports have finished/);
  // 2026-10-15: only what came in, as a list; nothing about the rest.
  assert.equal((html.match(/class="missed-line"/g) || []).length, 0);
  assert.deepEqual([...html.matchAll(/data-imported="([^"]+)"/g)].map((m) => m[1]), ['Obsidian']);
  // During the run, the app left out before it ran is a row of its own.
  const running = renderStatus({ ...session, jobs: [{ ...jobs[2], status: 'running' }] });
  assert.match(running, /data-background-job="left-GitHub"[\s\S]*?Left out/);
});
