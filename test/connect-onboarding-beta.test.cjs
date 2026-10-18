'use strict';

// The onboarding beta (2026-10-16, docs/onboarding-beta-10-16.md M1-M5): the librarian's one grant in place of a popup per
// app, a connector allowed but not connected getting its Connect step, the Other tools' sign-ins brought back under their
// own names, a connector whose server doesn't serve the account read through its website, and the chat's new pieces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { createConnect } = require('../src/main/connect/session.cjs');
const { createFakeConnectAgents } = require('../src/main/connect/fake.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-onboarding-beta-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => { await db.closeAll(); });

const until = async (read, check, what, tries = 800) => {
  for (let n = 0; n < tries; n += 1) { const now = read(); if (check(now)) return now; await new Promise((resolve) => { setTimeout(resolve, 10); }); }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(read()).slice(0, 2000)}`);
};

function connectWith(rest) {
  return createConnect({ ready: () => ['anthropic', 'openai'], context: async () => ctx, homeDir, env: {}, notify: () => {}, openBridge: openToolBridge, platform: 'darwin', ...rest, deps: { stepPollMs: 15, recoverWaitsMs: [0], ...(rest.deps || {}) } });
}

/** Fake agents whose import of an Other tool calls needs_you for a sign-in, once, and says what it was told. */
function toolAgents(answers) {
  const base = createFakeConnectAgents({ delayMs: 5 });
  return {
    async turn(args) {
      const meta = args.meta;
      if (!meta || meta.kind !== 'import' || !meta.job.label.startsWith('Other tools')) return base.turn(args);
      const out = await meta.callTool('needs_you', { kind: 'signin', reason: 'Vercel shows its login page' });
      answers.push(out);
      return { text: `Vercel: ${out.status}`, session: null };
    },
  };
}

test('an Other tool\'s sign-in is its own (never "Other tools: Vercel"): copied from the chosen profile, then its card, signed in inside Engelbart, and its agent goes on', async () => {
  const copied = [];
  const sites = [];
  const webSignIn = { supports: () => false, canSignIn: () => false, signedIn: async () => false, browserName: () => 'Chrome', copyFor: async (input) => { copied.push(input); return { copied: 0, signedIn: false }; } };
  const signInWindow = { open: async () => ({ status: 'closed' }), openSite: async (input) => { sites.push(input); return { status: 'signed-in' }; }, close: () => {} };
  const answers = [];
  const connect = connectWith({ agents: toolAgents(answers), webSignIn, signInWindow, deps: { allowed: true } });
  const started = await connect.start({ librarian: true, provider: 'openai', direct: { mode: 'manual', projects: [{ title: 'Study', description: 'A study.' }], roles: [], work: '', apps: ['Obsidian'], scopes: {}, additional: [{ name: 'Vercel', website: 'https://vercel.com' }] } });
  const state = () => connect.state(started.id);
  await until(state, (s) => s.chat.some((entry) => entry.grant), 'the grant');
  connect.grant(started.id, { apps: ['Vercel'] });
  const now = await until(state, (s) => s.needs.some((need) => need.kind === 'signin-here'), 'Vercel\'s card');
  const card = now.needs.find((need) => need.kind === 'signin-here');
  assert.deepEqual([card.app, card.reason, card.where], ['Vercel', 'Sign in to Vercel', 'here']);
  assert.ok(copied.length >= 2, 'copied when its import started, then again before the card');
  assert.deepEqual(copied[0], { name: 'Vercel', domains: ['vercel.com'] });
  await connect.need(started.id, card.id, 'open');
  await until(state, () => answers.length === 1, 'the agent told');
  assert.deepEqual(sites, [{ name: 'Vercel', url: 'https://vercel.com', domains: ['vercel.com'] }], 'its own site, in Engelbart\'s window');
  assert.equal(answers[0].status, 'done');
  assert.match(answers[0].note, /Vercel sign-in works in Engelbart's browser again/);
  assert.ok(state().log.some((entry) => entry.text === 'Signed in to Vercel inside Engelbart' && entry.who === 'You'));
  connect.stop(started.id);
});

test('a connector the person allowed but never connected gets its Connect step, the librarian is told it waits; connected, its survey starts (2026-10-16: Notion and Granola did nothing after Allow)', async () => {
  const connected = { Notion: false };
  const connectors = { status: (app) => ({ app, connected: !!connected[app], state: connected[app] ? 'connected' : 'signed-out', action: `Connect ${app}` }), signIn: async (app) => { connected[app] = true; }, cancel: () => {}, serversFor: async () => [], check: async (app) => connectors.status(app) };
  const connect = connectWith({ agents: createFakeConnectAgents({ delayMs: 5 }), connectors });
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Notion'] } }, provider: 'openai' });
  const state = () => connect.state(started.id);
  await until(state, (s) => s.chat.some((entry) => entry.grant) && s.chat[0].text !== 'Looking at what you picked…', 'the grant');
  connect.grant(started.id, { apps: ['Notion'] });
  let now = await until(state, (s) => s.needs.some((need) => need.app === 'Notion'), 'Notion\'s Connect step');
  assert.deepEqual(now.needs.map((need) => [need.app, need.kind]), [['Notion', 'connector']]);
  assert.equal(now.jobs.some((job) => job.apps.includes('Notion')), false, 'its survey waits for the connection');
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.match(saved.found.notes.Notion.connector, /asked the person to connect it/, 'the librarian hears it waits on the person');
  await connect.need(started.id, now.needs[0].id, 'open');
  now = await until(state, (s) => s.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'Notion'), 'Notion\'s survey once connected');
  assert.deepEqual(now.needs, []);
  connect.stop(started.id);
});

test('a connector whose server doesn\'t serve the account (Evernote\'s MCP, in beta) is read through its website as an Other tool would be; one with no website is skipped with a quiet line', async () => {
  const connectors = { status: (app) => ({ app, connected: false, state: 'unavailable', reason: 'refused', fallback: app === 'Evernote' ? 'web' : null }), reaches: async () => false, check: async (app) => connectors.status(app), serversFor: async () => [], signIn: async () => {}, cancel: () => {} };
  const webSignIn = { supports: () => false, canSignIn: () => false, signedIn: async () => false, browserName: () => 'Chrome', copyFor: async () => ({ copied: 3, signedIn: null }) };
  const connect = connectWith({ agents: createFakeConnectAgents({ delayMs: 5 }), connectors, webSignIn, deps: { allowed: true } });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'auto', projects: [{ title: 'Study' }], roles: [], work: '', apps: ['Evernote', 'Granola'], scopes: {} } });
  const state = () => connect.state(started.id);
  const now = await until(state, (s) => s.jobs.some((job) => job.label === 'Other tools: Evernote'), 'Evernote through its website');
  assert.deepEqual(now.needs, [], 'no Connect step for a connector that can\'t be connected for this account');
  assert.equal(now.jobs.some((job) => job.apps.includes('Evernote')), false, 'no connector import');
  assert.ok(now.leftOut.some((entry) => entry.app === 'Granola'), 'Granola has no website to fall back on');
  assert.ok(now.chat.some((entry) => entry.notice && entry.text === 'Couldn\'t connect to Granola. Skipped.'));
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.deepEqual(saved.jobs.find((job) => job.label === 'Other tools: Evernote').extra.sites, ['evernote.com']);
  connect.stop(started.id);
});

/* ---------------------------------------------------------------------------------------------------- the chat */

let compiled = null;
function chat() {
  if (compiled) return compiled;
  const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"test"' } });
  const filename = path.join(__dirname, '__ConnectLibrary.cjs');
  // The preload bridge the screens' api.js reads as it loads (renderToStaticMarkup runs no effects, so nothing calls it).
  if (!globalThis.window) globalThis.window = { engelbartAPI: {}, addEventListener() {}, removeEventListener() {} };
  const mod = new Module(filename, module);
  mod.paths = module.paths;
  mod._compile(built.outputFiles[0].text, filename);
  compiled = mod.exports;
  return compiled;
}

test('the grant: one message, every app unticked with its name and a circle, Select all beside a Grant access that waits for a tick; answered, one line', () => {
  const { GrantCard } = chat();
  const grant = { rows: [{ id: 'Notion', name: 'Notion' }, { id: 'ChatGPT', name: 'ChatGPT' }, { id: 'Linear', name: 'Linear', tool: true }], answered: null };
  const html = renderToStaticMarkup(React.createElement(GrantCard, { grant, live: true, onGrant() {} }));
  assert.match(html, /Allow Engelbart to access the following apps:/);
  assert.equal((html.match(/data-connect-grant-app=/g) || []).length, 3);
  assert.equal((html.match(/aria-checked="true"/g) || []).length, 0, 'every one unticked');
  assert.match(html, />Select all</);
  assert.match(html, /<button[^>]*data-connect-grant-go="1"[^>]*disabled=""[^>]*>Grant access<\/button>/, 'Grant access waits for a tick');
  assert.doesNotMatch(html, /Saved websites/);
  const done = renderToStaticMarkup(React.createElement(GrantCard, { grant: { ...grant, answered: { allowed: ['Notion', 'Linear'], skipped: ['ChatGPT'] } }, live: false, onGrant() {} }));
  assert.match(done, /Allowed Notion and Linear/);
  assert.doesNotMatch(done, /Grant access/);
});

test('a line Engelbart adds after a question never closes it; nothing says "Your answer"; a sign-in brought back says only what its button does', async () => {
  const { lastTurn } = chat();
  const chatOf = [{ role: 'agent', opener: true, text: 'Found 1 vault.' }, { role: 'agent', grant: { rows: [], answered: { allowed: [], skipped: [] } } }, { role: 'agent', text: 'Which folders?', ask: { title: 'Which folders?' } }, { role: 'agent', notice: true, text: 'Couldn\'t connect to Linear. Skipped.' }];
  assert.equal(lastTurn(chatOf), 2, 'the question is still the last turn');
  assert.equal(lastTurn([...chatOf, { role: 'user', text: 'Research' }]), 4);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  assert.deepEqual(model.dockLine({ needs: [], done: false, thinking: false, chat: chatOf, jobs: [] }), { tone: 'busy', short: 'Importing', text: 'Importing your library…' });
  assert.deepEqual(model.needView({ app: 'ChatGPT', kind: 'signin-here', where: 'here' }), { title: 'Sign in to ChatGPT', action: 'Sign in inside Engelbart', hint: '' });
  assert.equal(model.needView({ app: 'Google Docs', kind: 'signin-here', where: 'browser', browser: 'Chrome' }).action, 'Sign in in Chrome');
});
