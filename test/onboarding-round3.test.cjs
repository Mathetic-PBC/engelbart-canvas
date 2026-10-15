'use strict';

// Onboarding round 3 (2026-10-13, docs/onboarding-round-3.md): the causes found in Hudson's run, each pinned.
//   - OneNote and Gemini ticked though not used: shared sites (live.com) and the shared google.com sign-in counted as use.
//   - the Mac spinner between screens: the scans run in the scanner process (here: in-process, through the same jobs).
//   - Granola "needs you to connect it": the connector the person signed in to in their own CLI is handed to the agent.
//   - manual scopes are optional: an empty "Specify context" doesn't tell the agent to read nothing.
//   - the Full Disk Access helper docks against System Settings, and says when a quit is the one it needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { toolEvidence } = require('../src/main/onboarding/discover.cjs');
const { createOwnConnectors, claudeServersOf, codexServersOf } = require('../src/main/connect/own-connectors.cjs');
const { createScanner, accessSpec } = require('../src/main/connect/offthread.cjs');
const { claudeServers, writeImportConfig, CHROME_REFUSED, CODEX_KEPT_SERVERS } = require('../src/main/connect/agents.cjs');
const { importPlan } = require('../src/shared/import-flow.cjs');
const { createDiskAccess } = require('../src/main/onboarding/disk-access.cjs');

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eb-r3-'));

/** A `run` that answers sqlite3 with these history rows (Chromium's browserHistory) and nothing else. */
function chromeHome(rows) {
  const dir = home();
  const profile = path.join(dir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'History'), '');
  const run = (cmd, args, opts, cb) => { const done = typeof opts === 'function' ? opts : cb; done(null, JSON.stringify(rows), ''); };
  return { dir, run };
}

test('OneNote is not "used" for Outlook visits on live.com; Gemini not for the google.com sign-in alone', async () => {
  const { dir, run } = chromeHome([{ url: 'https://outlook.live.com/mail/0/', visits: 151 }, { url: 'https://mail.google.com/mail/u/0/', visits: 40 }]);
  const cookies = (app) => ['Gmail', 'Gemini', 'Google Docs', 'Google Meet'].includes(app);
  const { evidence } = await toolEvidence({ homeDir: dir, browserId: 'chrome', cookies, run, detected: { apps: {}, localRepos: [] }, applications: [] });
  assert.equal(evidence.OneNote.used, false, JSON.stringify(evidence.OneNote));
  assert.equal(evidence.Gemini.used, false, JSON.stringify(evidence.Gemini));
  assert.equal(evidence['Google Meet'].used, false);
  // Gmail is paused (From Amitav, 2026-10-15): not looked for at all.
  assert.equal(evidence.Gmail, undefined);
});

test('an app with a sign-in of its own (Notion) still counts on its cookie alone', async () => {
  const { dir, run } = chromeHome([]);
  const { evidence } = await toolEvidence({ homeDir: dir, browserId: 'chrome', cookies: (app) => app === 'Notion', run, detected: { apps: {}, localRepos: [] }, applications: [] });
  assert.equal(evidence.Notion.used, true);
});

test('toolEvidence takes the scanner process\'s detect answer instead of scanning on the main process', async () => {
  const { dir, run } = chromeHome([]);
  const detected = { apps: { Obsidian: { found: true, where: '~/vault' } }, localRepos: [{ path: '/x', shown: '~/x' }] };
  const { evidence } = await toolEvidence({ homeDir: dir, browserId: 'chrome', run, detected, applications: [] });
  assert.equal(evidence.Obsidian.used, true);
  assert.match(evidence.Obsidian.evidence, /~\/vault/);
  assert.equal(evidence['Folders on this Mac'].used, true);
});

test('the scanner runs its jobs off the caller (no fork: in-process), and fails a job it does not know', async () => {
  const scanner = createScanner();
  const dir = home();
  const repos = await scanner.run('localRepos', { homeDir: dir, access: accessSpec({ answers: {} }, dir) });
  assert.deepEqual(repos, []);
  const digest = await scanner.run('projectDigest', { homeDir: dir, access: null, existing: ['A'] });
  assert.deepEqual(digest.projects, ['A']);
  await assert.rejects(scanner.run('nothing', {}), /No scanner job/);
});

test('the scanner talks to a forked process by message and gives each answer to its own job', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.postMessage = ({ id, job }) => { setImmediate(() => child.emit('message', job === 'bad' ? { id, ok: false, error: 'nope' } : { id, ok: true, value: `${job}!` })); };
  child.kill = () => child.emit('exit');
  const scanner = createScanner({ fork: () => child });
  const [a, b] = await Promise.all([scanner.run('detect'), scanner.run('localRepos')]);
  assert.equal(a, 'detect!');
  assert.equal(b, 'localRepos!');
  await assert.rejects(scanner.run('bad'), /nope/);
});

test('a scanner process that never starts is given up on: its jobs, and later ones, run here', async () => {
  const { EventEmitter } = require('node:events');
  let forks = 0;
  const silent = () => { forks += 1; const child = new EventEmitter(); child.postMessage = () => {}; child.kill = () => {}; return child; };
  const scanner = createScanner({ fork: silent, spawnMs: 30 });
  const dir = home();
  assert.deepEqual(await scanner.run('localRepos', { homeDir: dir }), [], 'answered here once the process gave no sign of life');
  assert.deepEqual(await scanner.run('localRepos', { homeDir: dir }), []);
  assert.equal(forks, 1, 'not forked again');
});

test('the person\'s own connectors: Claude Code\'s user servers and Codex\'s signed-in ones, matched by the official address', async () => {
  const dir = home();
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: {
    granola: { type: 'http', url: 'https://mcp.granola.ai/mcp/' },
    notes: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    gmail: { command: 'python' },
    Weird_Name: { type: 'http', url: 'https://mcp.notion.com/mcp' },
  } }));
  assert.deepEqual(claudeServersOf({ homeDir: dir, env: {} }).map((one) => one.name).sort(), ['Weird_Name', 'granola', 'notes']);
  const codex = JSON.stringify([
    { name: 'granola', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.granola.ai/mcp', bearer_token_env_var: null }, auth_status: 'o_auth' },
    { name: 'notion', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.notion.com/mcp' }, auth_status: 'not_logged_in' },
  ]);
  assert.deepEqual(codexServersOf(codex).map((one) => [one.name, one.signedIn]), [['granola', true], ['notion', false]]);
  const own = createOwnConnectors({ homeDir: dir, env: {}, codexList: async () => codex });
  assert.deepEqual(await own.serversFor(['Granola', 'Notion'], 'anthropic'), [
    { app: 'Granola', name: 'granola', url: 'https://mcp.granola.ai/mcp/', type: 'http', own: true },
    { app: 'Notion', name: 'notes', url: 'https://mcp.notion.com/mcp', type: 'http', own: true },
  ]);
  assert.deepEqual((await own.serversFor(['Granola', 'Notion'], 'openai')).map((one) => one.app), ['Granola']);
  assert.equal(await own.reaches('Notion', 'openai'), false);
});

test('an own connector reaches the agent with no token of Engelbart\'s: Claude Code by name and address, Codex likewise', () => {
  const connectors = [{ app: 'Granola', name: 'granola', url: 'https://mcp.granola.ai/mcp', own: true }, { app: 'Notion', name: 'notion', url: 'https://mcp.notion.com/mcp', token: 'T' }];
  const servers = claudeServers({ node: 'node', server: 'srv', connection: 'conn', connectors }).mcpServers;
  assert.deepEqual(servers.granola, { type: 'http', url: 'https://mcp.granola.ai/mcp' });
  assert.deepEqual(servers.notion.headers, { Authorization: 'Bearer T' });
  const dir = home();
  writeImportConfig(dir, { command: 'node', args: ['a'], env: {} }, connectors);
  const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  const granola = toml.slice(toml.indexOf('[mcp_servers.granola]'), toml.indexOf('[mcp_servers.notion]'));
  assert.doesNotMatch(granola, /bearer_token_env_var/);
  assert.match(toml.slice(toml.indexOf('[mcp_servers.notion]')), /bearer_token_env_var = "ENGELBART_CONNECTOR_NOTION"/);
});

test('the browser fallback may close its own tabs but never switch, resize or drive the screen', () => {
  assert.ok(!CHROME_REFUSED.includes('mcp__claude-in-chrome__tabs_close_mcp'));
  for (const name of ['switch_browser', 'select_browser', 'resize_window', 'javascript_tool']) assert.ok(CHROME_REFUSED.includes(`mcp__claude-in-chrome__${name}`), name);
  assert.ok(!CODEX_KEPT_SERVERS.has('computer-use'));
});

test('manual "Specify context" is optional: nothing said reads like an automatic import, projects narrow the source', () => {
  const projects = [{ id: 'a', title: 'Memex' }, { id: 'b', title: 'Fundraising' }];
  const open = importPlan({ app: 'Obsidian', mode: 'manual', projects, scope: { kind: 'folders', folders: [], items: [], people: [], note: '', projects: [] } });
  assert.doesNotMatch(open, /narrowed it down|Read only/);
  assert.match(open, /Find what belongs with these projects yourself/);
  const narrowed = importPlan({ app: 'Obsidian', mode: 'manual', projects, scope: { kind: 'folders', folders: [{ path: '/Users/x/vault/Memex', name: 'Memex' }], items: [], people: [], note: 'only my reading notes', projects: ['Memex'] } });
  assert.match(narrowed, /For this source, only these of the projects: Memex\./);
  assert.match(narrowed, /In their words, what to bring in from it: only my reading notes/);
  assert.match(narrowed, /only these folders and files: \/Users\/x\/vault\/Memex/);
});

test('the Full Disk Access helper docks against System Settings: right of it, else left of it, else the screen edge', () => {
  const screen = { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }), getCursorScreenPoint: () => ({ x: 0, y: 0 }) };
  const disk = createDiskAccess({ screen, platform: 'darwin', fake: 'denied' });
  assert.deepEqual(disk.placement({ x: 100, y: 100, width: 700, height: 600 }), { x: 804, y: 277, side: 'left' });
  assert.equal(disk.placement({ x: 700, y: 100, width: 700, height: 600 }).side, 'right');
  assert.equal(disk.placement({ x: 700, y: 100, width: 700, height: 600 }).x, 700 - 4 - 330);
  const wide = disk.placement({ x: 100, y: 100, width: 1300, height: 600 });
  assert.equal(wide.side, 'left');
  assert.equal(wide.x, 1440 - 330 - 12);
  assert.equal(disk.waiting(), false);
});
