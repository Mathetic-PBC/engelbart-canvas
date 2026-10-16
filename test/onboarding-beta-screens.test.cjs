'use strict';

// The onboarding beta's screens (2026-10-16, docs/onboarding-beta-10-16.md S1–S13): the decisions behind the agent popup
// that replaced "Set up your tools", the pager, the fluid scale, and the browser's sign-ins gate
// (src/renderer/model/onboarding.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeTools } = require('../src/main/tools/record.cjs');
const { REQUIREMENTS } = require('../src/main/tools/requirements.cjs');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);

/** A tool check's snapshot: `states` gives each tool's fields (status 'ready' unless said). */
function snap(states = {}, checked = true) {
  const records = normalizeTools({});
  const tools = {};
  for (const id of ['git', 'claude', 'codex']) {
    const given = states[id] || {};
    const status = given.status || 'ready';
    tools[id] = { id, name: REQUIREMENTS[id].name, minimum: REQUIREMENTS[id].minimum, ...records[id], installed: status !== 'missing', status, signedIn: status === 'ready' ? true : null, busy: null, autoUpdate: false, error: null, ...given };
  }
  return { checked, platform: 'darwin', updates: 'auto', tools };
}
/** providers.cjs's status: `who` { anthropic: { signedIn, subscription, subscribed } , openai: … }. */
function prov(who = {}) {
  return { providers: ['anthropic', 'openai'].map((id) => ({ id, installed: true, signedIn: false, subscription: null, ...(who[id] || {}) })), decision: null };
}
const SUB = { signedIn: true, subscription: 'max', subscribed: true };
const FREE = { signedIn: true, subscription: null, subscribed: false };
const OUT = { signedIn: false, subscription: null, subscribed: false };

test('S3: one qualifying CLI goes straight on; both qualify, both are updated when too old', async () => {
  const m = await load();
  assert.equal(m.agentGate(snap({}, false), prov()), null, 'no answer before the tool check');
  assert.equal(m.agentGate(snap(), null), null, 'nor before the providers');
  const one = m.agentGate(snap({ codex: { status: 'missing' } }), prov({ anthropic: SUB }));
  assert.equal(one.go, true);
  assert.deepEqual(one.update, []);
  const both = m.agentGate(snap({ claude: { status: 'outdated' }, codex: { status: 'outdated' } }), prov({ anthropic: SUB, openai: { ...SUB, subscription: 'plus' } }));
  assert.deepEqual([both.go, both.update], [true, ['claude', 'codex']], 'both qualify: both update');
  const auto = m.agentGate(snap({ claude: { status: 'outdated', autoUpdate: true } }), prov({ anthropic: SUB }));
  assert.deepEqual(auto.update, [], 'one the manager updates on its own is left to it');
  const updating = m.agentGate(snap({ claude: { status: 'outdated', busy: { action: 'update' } } }), prov({ anthropic: SUB }));
  assert.deepEqual(updating.update, [], 'nor one already updating');
});

test('S3: neither qualifying asks; a CLI signed in without a subscription does not qualify', async () => {
  const m = await load();
  assert.equal(m.agentGate(snap(), prov({ anthropic: FREE, openai: OUT })).go, false);
  assert.equal(m.agentGate(snap({ claude: { status: 'missing' }, codex: { status: 'missing' } }), prov()).go, false);
  // An older main without `subscribed`: signed in with a plan named.
  assert.equal(m.agentGate(snap(), { providers: [{ id: 'anthropic', installed: true, signedIn: true, subscription: 'pro' }] }).go, true);
  assert.equal(m.agentGate(snap({ git: { status: 'missing' } }), prov()).git, true, 'Git missing is installed in the background');
  assert.equal(m.agentGate(snap({ git: { status: 'ready', source: 'bundled' } }), prov()).git, false, 'Engelbart’s own Git stands in');
});

test('S3: the popup for each choice: install, update, connect, and on by itself once one runs', async () => {
  const m = await load();
  const missing = m.agentChoice(snap({ claude: { status: 'missing' }, codex: { status: 'missing' } }), prov(), 'both');
  assert.deepEqual([missing.install, missing.primary.label, missing.primary.disabled], [['claude', 'codex'], 'Connecting…', true]);
  const old = m.agentChoice(snap({ codex: { status: 'outdated' } }), prov(), 'codex');
  assert.deepEqual(old.update, ['codex']);
  const signedOut = snap({ claude: { status: 'signed-out', signedIn: false }, codex: { status: 'signed-out', signedIn: false } });
  assert.equal(m.agentChoice(signedOut, prov(), 'claude').primary.label, 'Connect to Claude');
  assert.equal(m.agentChoice(signedOut, prov(), 'codex').primary.label, 'Connect to ChatGPT');
  const bothOut = m.agentChoice(signedOut, prov(), 'both');
  assert.deepEqual([bothOut.primary.label, bothOut.primary.action, bothOut.primary.ids], ['Connect to Claude and ChatGPT', 'sign-in', ['claude', 'codex']]);
  const free = m.agentChoice(snap(), prov({ anthropic: FREE }), 'claude');
  assert.equal(free.primary.label, 'Connect to Claude', 'signed in without a subscription: its sign-in again');
  const refused = m.agentChoice(snap(), prov({ anthropic: SUB }), 'claude', { refused: 'claude' });
  assert.equal(refused.primary.action, 'sign-in', 'turned the agents away while signed in: signed in again');
  const half = m.agentChoice(snap({ codex: { status: 'missing', busy: { action: 'install' } } }), prov({ anthropic: SUB }), 'both');
  assert.equal(half.done, true, 'one runs: the flow goes on while the other installs');
  const signing = m.agentChoice(snap({ claude: { status: 'signed-out', busy: { action: 'sign-in', url: 'https://claude.ai/x' } } }), prov(), 'claude');
  assert.deepEqual([signing.primary.action, signing.primary.url], ['open', 'https://claude.ai/x']);
  const failed = m.agentChoice(snap({ codex: { status: 'missing', error: 'The installer could not be reached: no internet connection. More.' } }), prov(), 'codex');
  assert.deepEqual([failed.primary.label, failed.problem], ['Try again', 'The installer could not be reached: no internet connection.']);
  assert.equal(m.agentChoice(snap(), prov(), null).primary.disabled, true, 'nothing chosen yet');
});

test('S3: no version anywhere, and the labels in plain words', async () => {
  const m = await load();
  for (const choice of ['claude', 'codex', 'both']) {
    for (const state of [snap({ claude: { status: 'outdated', version: '2.1.1' }, codex: { status: 'missing' } }), snap({ claude: { status: 'signed-out' } })]) {
      const out = m.agentChoice(state, prov(), choice);
      assert.doesNotMatch(`${out.primary.label} ${out.problem}`, /\d+\.\d+\.\d+/);
    }
  }
  assert.equal(m.connectLabel(['codex', 'claude']), 'Connect to Claude and ChatGPT');
});

test('S3 pager: only the screens that draw it count', async () => {
  const m = await load();
  assert.equal(m.shownPager('new', 'welcome', { tools: false, connect: true }), null, 'Welcome is the only one in a new user’s flow');
  assert.deepEqual(m.shownPager('guided', 'welcome', { tools: false, connect: true }), { count: 2, index: 0 });
  assert.deepEqual(m.shownPager('guided', 'connect', { tools: false, connect: true }), { count: 2, index: 1 });
  assert.deepEqual(m.shownPager('new', 'create', { tools: false, connect: false }), { count: 4, index: 1 }, 'Connect dropped: Create and its screens');
  assert.deepEqual(m.shownPager('existing', 'context', { tools: false }), { count: 2, index: 1 });
});

test('S2: one fluid scale, from a minimum, growing with the window', async () => {
  const m = await load();
  const small = m.fluidScale(1000, 700), mid = m.fluidScale(1440, 900), big = m.fluidScale(2560, 1440);
  assert.equal(small, 1.1);
  assert.ok(mid > small && big > mid, `${small} < ${mid} < ${big}`);
  assert.ok(big <= 2);
  assert.equal(m.fluidScale(800, 500), 1.1, 'never below the minimum');
  assert.equal(m.fluidScale(0, 0), 1.1);
});

test('S9–S12: the browser’s sign-ins are asked, never skipped for want of an answer', async () => {
  const m = await load();
  const chrome = { id: 'chrome', name: 'Google Chrome', keychain: true, profiles: [] };
  assert.equal(m.keychainStep(null), 'wait', 'still looking for the browsers: wait, then ask');
  assert.deepEqual(m.keychainStep({ browsers: [], keychain: null }), { go: 'declined' }, 'no browser: nothing to ask, macOS never asked');
  assert.equal(m.keychainStep({ browsers: [chrome], chosenId: 'chrome', keychain: null }), 'ask');
  assert.deepEqual(m.keychainStep({ browsers: [chrome], chosenId: 'chrome', keychain: 'allowed' }), { go: 'allowed' });
  assert.deepEqual(m.keychainStep({ browsers: [chrome], chosenId: 'chrome', keychain: 'refused' }), { go: 'declined' });
  const safari = { id: 'safari', name: 'Safari', keychain: false, profiles: [] };
  assert.equal(m.keychainStep({ browsers: [safari, chrome], chosenId: 'safari', keychain: null, safari: { diskAccess: false } }), 'safari');
  assert.equal(m.keychainStep({ browsers: [safari], chosenId: 'safari', keychain: null }), 'safari', 'unknown disk access: asked for');
  assert.equal(m.keychainStep({ browsers: [safari], chosenId: 'safari', keychain: null, safari: { diskAccess: true } }), 'ask', 'granted: Safari like any other');
  const two = { ...chrome, profiles: [{ id: 'Default', name: 'Hudson', email: 'h@x' }, { id: 'Profile 1', name: 'Work' }] };
  assert.equal(m.afterAllow({ browsers: [two], chosenId: 'chrome' }), 'profile');
  assert.equal(m.afterAllow({ browsers: [two], chosenId: 'chrome', chosenProfile: 'Profile 1' }), 'macos', 'chosen once');
  assert.equal(m.afterAllow({ browsers: [two], chosenId: 'chrome', chosenProfile: 'Gone' }), 'profile');
  assert.equal(m.afterAllow({ browsers: [chrome], chosenId: 'chrome' }), 'macos');
  assert.equal(m.runKeychain(null), false, 'unanswered: false');
  assert.equal(m.runKeychain({ keychain: 'declined' }), false);
  assert.equal(m.runKeychain({ keychain: 'allowed' }), true);
});
