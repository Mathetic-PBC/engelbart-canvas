'use strict';

// The import's sign-ins off the Mac (2026-10-18, the beta's Windows catch-up, docs/windows-port-log.md): nothing of the
// person's browser is copied there (windows-port: every sign-in goes through Engelbart's own window), so a sign-in brought
// back goes straight to its card, and an app with no known sign-in cookie (OneNote, Evernote…) signs in inside Engelbart
// rather than in the person's browser, from which nothing could be brought over. `platform` is given: these run on a Mac.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { createConnect } = require('../src/main/connect/session.cjs');
const { createFakeConnectAgents } = require('../src/main/connect/fake.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connect-windows-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => { await db.closeAll(); });

const until = async (read, check, what, tries = 800) => {
  for (let n = 0; n < tries; n += 1) { const now = read(); if (check(now)) return now; await new Promise((resolve) => { setTimeout(resolve, 10); }); }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(read()).slice(0, 2000)}`);
};

function connectWith(rest) {
  return createConnect({ ready: () => ['anthropic', 'openai'], context: async () => ctx, homeDir, env: {}, notify: () => {}, openBridge: openToolBridge, ...rest, deps: { stepPollMs: 15, ...(rest.deps || {}) } });
}

/** Fake agents whose import of `app` (or an Other tool named so) calls needs_you for a sign-in, once, and says what it was told. */
function signInAgents(app, answers) {
  const base = createFakeConnectAgents({ delayMs: 5 });
  return {
    async turn(args) {
      const meta = args.meta;
      if (!meta || meta.kind !== 'import' || !meta.job.label.includes(app)) return base.turn(args);
      const out = await meta.callTool('needs_you', { kind: 'signin', reason: `${app} shows its login page` });
      answers.push(out);
      return { text: `${app}: ${out.status}`, session: null };
    },
  };
}

const offMac = () => ({ supports: () => false, canSignIn: () => false, signedIn: async () => false, browserName: () => 'Chrome', copyFor: async () => ({ copied: 0, signedIn: null }), signInQuiet: async () => ({ signedIn: false, browser: '' }), openApp: async () => { throw new Error('the person\'s browser was opened'); } });

test('off the Mac a sign-in brought back goes straight to its card: no quiet copies to wait through, nothing to copy them from', async () => {
  const answers = [];
  const signInWindow = { open: async () => ({ status: 'closed' }), openSite: async () => ({ status: 'signed-in' }), close: () => {} };
  const connect = connectWith({ platform: 'win32', agents: signInAgents('Vercel', answers), webSignIn: offMac(), signInWindow, deps: { allowed: true, recoverWaitsMs: [0, 60_000] } });
  const started = await connect.start({ librarian: true, provider: 'openai', direct: { mode: 'manual', projects: [{ title: 'Study', description: 'A study.' }], roles: [], work: '', apps: ['Obsidian'], scopes: {}, additional: [{ name: 'Vercel', website: 'https://vercel.com' }] } });
  const state = () => connect.state(started.id);
  await until(state, (s) => s.chat.some((entry) => entry.grant), 'the grant');
  connect.grant(started.id, { apps: ['Vercel'] });
  const now = await until(state, (s) => s.needs.some((need) => need.kind === 'signin-here'), 'Vercel\'s card', 300);
  assert.equal(now.needs.find((need) => need.kind === 'signin-here').app, 'Vercel');
  connect.stop(started.id);
});

test('off the Mac OneNote\'s sign-in (no known cookie) is made in Engelbart\'s window, never in the person\'s browser, and closes once made', async () => {
  const answers = [];
  const opened = [];
  const signInWindow = { open: async (app) => { opened.push(app); return { status: 'signed-in' }; }, openSite: async () => ({ status: 'signed-in' }), close: () => {} };
  const connect = connectWith({ platform: 'win32', agents: signInAgents('OneNote', answers), webSignIn: offMac(), signInWindow, deps: { allowed: true, recoverWaitsMs: [0] } });
  const started = await connect.start({ librarian: true, provider: 'openai', direct: { mode: 'manual', projects: [{ title: 'Study', description: 'A study.' }], roles: [], work: '', apps: ['OneNote'], scopes: {}, additional: [] } });
  const state = () => connect.state(started.id);
  await until(state, (s) => s.chat.some((entry) => entry.ask), 'the survey\'s question');
  await connect.importNow(started.id);
  const now = await until(state, (s) => s.needs.some((need) => need.app === 'OneNote' && !need.closed), 'OneNote\'s step');
  const need = now.needs.find((one) => one.app === 'OneNote' && !one.closed);
  await connect.need(started.id, need.id, 'open');
  await until(state, () => answers.length === 1, 'the agent told');
  assert.deepEqual(opened, ['OneNote'], 'Engelbart\'s own window');
  assert.equal(answers[0].status, 'done');
  connect.stop(started.id);
});
