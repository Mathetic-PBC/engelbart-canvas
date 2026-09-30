'use strict';

// The setup dialog's rows (src/renderer/model/tools.js, 2026-09-23).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeTools } = require('../src/main/tools/record.cjs');
const { REQUIREMENTS } = require('../src/main/tools/requirements.cjs');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/tools.js')).href);

/** A snapshot as the manager sends it: `states` gives each tool's status fields. */
function snapshot(states, checked = true) {
  const records = normalizeTools({});
  const tools = {};
  for (const id of ['git', 'claude', 'codex']) {
    const given = states[id] || {};
    const status = given.status || 'ready';
    tools[id] = { id, name: REQUIREMENTS[id].name, minimum: REQUIREMENTS[id].minimum, ...records[id], installed: status !== 'missing', version: status === 'missing' ? null : REQUIREMENTS[id].minimum, status, busy: null, autoUpdate: false, ...given };
  }
  return { checked, updates: 'auto', platform: 'darwin', tools };
}

test('no dialog when everything is ready, or before the first check', async () => {
  const { launchRows } = await load();
  assert.deepEqual(launchRows(snapshot({})), []);
  assert.deepEqual(launchRows(snapshot({ git: { status: 'missing' } }, false)), []);
  assert.deepEqual(launchRows(null), []);
});

test('Git missing, and neither agent installed, are asked about; a skip is remembered per tool', async () => {
  const { launchRows } = await load();
  assert.deepEqual(launchRows(snapshot({ git: { status: 'missing' } })), ['git']);
  assert.deepEqual(launchRows(snapshot({ claude: { status: 'missing' }, codex: { status: 'missing' } })), ['claude', 'codex'], 'Claude Code, Codex, or both');
  assert.deepEqual(launchRows(snapshot({ claude: { status: 'missing' } })), [], 'one agent is enough');
  assert.deepEqual(launchRows(snapshot({ git: { status: 'missing', skip: true }, claude: { status: 'missing', skip: true }, codex: { status: 'missing', skip: true } })), []);
  assert.deepEqual(launchRows(snapshot({ git: { status: 'failed', error: "Xcode's license has not been accepted" } })), ['git'], 'a Git that cannot run is asked about too');
});

test('agents that are installed but cannot run a question are asked about, and one not signed in always is (2026-09-29)', async () => {
  const { launchRows, installedSignedOut } = await load();
  assert.deepEqual(launchRows(snapshot({ claude: { status: 'signed-out' }, codex: { status: 'missing' } })), ['claude']);
  assert.deepEqual(launchRows(snapshot({ claude: { status: 'signed-out' } })), ['claude'], 'Codex could run a question, but Claude Code still asks to sign in');
  assert.deepEqual(launchRows(snapshot({ claude: { status: 'signed-out', skip: true } })), [], 'unless skipped');
  const installing = snapshot({ claude: { status: 'installing', installed: false, busy: { action: 'install' } }, codex: { status: 'missing' } });
  const installed = snapshot({ claude: { status: 'signed-out' }, codex: { status: 'missing' } });
  assert.deepEqual(installedSignedOut(installing, installed), ['claude'], 'an install that ends without a sign-in asks for one');
  assert.deepEqual(installedSignedOut(installing, snapshot({ codex: { status: 'missing' } })), [], 'one signed in already asks nothing');
  assert.deepEqual(installedSignedOut(null, installed), []);
  assert.deepEqual(launchRows(snapshot({ codex: { status: 'outdated', version: '0.150.0' } })), ['codex'], 'an update waiting for the person');
  assert.deepEqual(launchRows(snapshot({ codex: { status: 'outdated', version: '0.150.0', autoUpdate: true } })), [], 'an update that happens by itself asks nothing');
});

test('rows say what a tool is doing in a few words, with one button', async () => {
  const { rowOf } = await load();
  const tools = snapshot({ git: { status: 'missing' }, claude: { status: 'outdated', version: '2.1.200', error: 'The installer could not be reached: no internet connection.' }, codex: { status: 'signed-out' } }).tools;
  assert.deepEqual([rowOf(tools.git).state, rowOf(tools.git).action], ['Not installed', 'install']);
  assert.deepEqual([rowOf({ ...tools.git, status: 'ready', version: '2.53.0', source: 'bundled' }).state, rowOf({ ...tools.git, status: 'ready', version: '2.53.0', source: 'bundled' }).tone], ['2.53.0 · built in', 'ok'], 'the Git that came with Engelbart');
  assert.deepEqual([rowOf(tools.claude).state, rowOf(tools.claude).action, rowOf(tools.claude).detail], ['2.1.200 · needs 2.1.278', 'update', 'The installer could not be reached: no internet connection.']);
  assert.deepEqual([rowOf(tools.codex).state, rowOf(tools.codex).action], ['Not signed in', 'sign-in']);
  assert.equal(rowOf({ ...tools.git, busy: { action: 'install', phase: 'Waiting for Apple’s installer' } }).state, 'Waiting for Apple’s installer');
  const signing = rowOf({ ...tools.codex, busy: { action: 'sign-in', url: 'https://auth.openai.com/x' } });
  assert.deepEqual([signing.action, signing.page], ['cancel', 'https://auth.openai.com/x']);
  assert.equal(rowOf({ ...tools.git, status: 'outdated', version: '2.20.0', source: 'apple' }).action, null, 'Apple’s Git is updated by macOS');
  assert.deepEqual([rowOf({ ...tools.claude, status: 'ready', version: '3.0.1', untested: true }).state, rowOf({ ...tools.claude, status: 'ready' }).tone], ['3.0.1 · untested', 'ok']);
  assert.equal(rowOf({ ...tools.git, skip: true }).state, 'Skipped');
});

test('Skip warns that Engelbart will be restricted, and only when it will be', async () => {
  const { skipWarnings } = await load();
  const both = snapshot({ git: { status: 'missing' }, claude: { status: 'missing' }, codex: { status: 'missing' } });
  assert.deepEqual(skipWarnings(both, ['git', 'claude', 'codex']), ['Without Git, Engelbart can’t build or keep your code’s history.', 'Without Claude Code or Codex, @bart and summaries can’t run.']);
  assert.deepEqual(skipWarnings(snapshot({ codex: { status: 'missing' } }), ['codex']), [], 'Claude Code still runs questions');
});

test('Install all takes the rows not installed; the dialog is done when every row is ready', async () => {
  const { installable, allDone } = await load();
  const tools = snapshot({ git: { status: 'missing' }, claude: { status: 'missing' }, codex: { status: 'signed-out' } });
  assert.deepEqual(installable(tools, ['git', 'claude', 'codex']), ['git', 'claude']);
  assert.equal(allDone(tools, ['git']), false);
  assert.equal(allDone(snapshot({}), ['git', 'claude']), true);
  assert.equal(allDone(snapshot({ claude: { status: 'signed-out' } }), ['claude']), false, 'installed but not signed in is not done');
});
