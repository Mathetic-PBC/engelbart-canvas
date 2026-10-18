'use strict';

// The 0.1.23 beta on Windows (2026-10-18, docs/windows-port-log.md "Beta catch-up to 0.1.23 on windows-beta-deployment"):
// the import flow and onboarding written for the Mac since 0.1.19, made to work off it. Every test here is given the
// platform (and, where it looks at the disk, a Windows-shaped home or a fake file system), so they run on a Mac too.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { shownNameOn, thisMachine, LOCAL_PDFS } = require('../src/shared/connect-sources.cjs');
const { LOCAL_FOLDERS } = require('../src/shared/import-flow.cjs');

test('off the Mac, what says "this Mac" says "this computer": the PDFs and folders rows; a Mac\'s as before', () => {
  assert.equal(shownNameOn(LOCAL_PDFS, 'darwin'), 'PDFs on this Mac');
  assert.equal(shownNameOn(LOCAL_FOLDERS, 'darwin'), 'Folders on this Mac');
  assert.equal(shownNameOn(LOCAL_PDFS, 'win32'), 'PDFs on this computer');
  assert.equal(shownNameOn(LOCAL_FOLDERS, 'win32'), 'Folders on this computer');
  assert.equal(shownNameOn('Google Docs', 'win32'), 'Google Drive', 'the other shown names as they were');
  assert.equal(shownNameOn('Notion', 'win32'), 'Notion');
  assert.equal(thisMachine('darwin'), 'this Mac');
  assert.equal(thisMachine('win32'), 'this computer');
  assert.equal(thisMachine('linux'), 'this computer');
});

const { createInstalledApps } = require('../src/main/browser/installed-apps.cjs');

test('a browser installed on Windows: its program under Program Files or the person\'s AppData\\Local; never Spotlight, never Safari', async () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' };
  const there = new Set([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\ada\\AppData\\Local\\Programs\\Opera\\opera.exe',
    'C:\\Users\\ada\\AppData\\Local\\Mozilla Firefox\\firefox.exe',
  ]);
  let asked = 0;
  const apps = createInstalledApps({ platform: 'win32', env, homeDir: 'C:\\Users\\ada', spotlight: () => { asked += 1; return Promise.resolve(true); }, fsx: { exists: (p) => there.has(p), readdir: () => [], readFile: () => '' } });
  for (const id of ['com.google.Chrome', 'com.microsoft.edgemac', 'com.operasoftware.Opera', 'org.mozilla.firefox']) {
    assert.equal(apps.has(id), true, id);
    assert.equal(await apps.settled(id), true, id);
  }
  for (const id of ['com.apple.Safari', 'com.brave.Browser', 'company.thebrowser.Browser', 'ai.perplexity.comet']) {
    assert.equal(apps.has(id), false, id);
    assert.equal(await apps.settled(id), false, id);
  }
  await apps.ask();
  assert.equal(asked, 0, 'Spotlight is the Mac\'s: not asked on Windows');
  assert.equal(apps.where('com.google.Chrome'), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  // No LOCALAPPDATA in the environment: the home's own.
  const bare = createInstalledApps({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\ada', fsx: { exists: (p) => p === 'C:\\Users\\ada\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', readdir: () => [], readFile: () => '' } });
  assert.equal(bare.has('com.brave.Browser'), true);
});

const { createBrowsers } = require('../src/main/onboarding/browsers.cjs');

test('the browser\'s sign-ins off the Mac: never asked (nothing is copied; sign-ins go through Engelbart\'s own window), Safari never listed', async () => {
  const kept = {};
  const prefs = { get: () => ({ ...kept }), set: (patch) => Object.assign(kept, patch) };
  let unlocked = 0;
  const installedApps = { ask: async () => {}, settled: async (bundle) => ['com.apple.Safari', 'com.google.Chrome', 'org.mozilla.firefox'].includes(bundle) };
  const browsers = createBrowsers({ platform: 'win32', installedApps, defaultName: () => 'Google Chrome', prefs, unlock: async () => { unlocked += 1; return { keychain: 'refused' }; }, diskAccess: async () => ({ granted: false }) });
  const out = await browsers.list();
  assert.deepEqual(out.browsers.map((browser) => browser.id), ['chrome', 'firefox'], 'the default first; no Safari');
  assert.equal(out.chosenId, 'chrome');
  assert.equal(out.keychain, 'allowed', 'answered already: the import flow\'s question is not drawn');
  assert.deepEqual(await browsers.setKeychain('allowed'), { keychain: 'allowed' });
  assert.equal(unlocked, 0, 'nothing of the browser\'s is asked for');
  // A Mac's list, the same installs: Safari there, the question still to ask.
  const mac = createBrowsers({ platform: 'darwin', installedApps, defaultName: () => 'Google Chrome', prefs: { get: () => ({}), set: () => {} } });
  const onMac = await mac.list();
  assert.deepEqual(onMac.browsers.map((browser) => browser.id), ['chrome', 'safari', 'firefox']);
  assert.equal(onMac.keychain, null);
});

const fs = require('node:fs');
const os = require('node:os');
const readers = require('../src/main/connect/readers.cjs');
const { historySites, toolEvidence, createDiscovery } = require('../src/main/onboarding/discover.cjs');

const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-windows-beta-')));
/** A history database where `file` is: Chromium's urls (`kind` 'chromium') or Firefox's moz_places. */
function historyAt(file, kind) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  if (kind === 'chromium') {
    const recent = readers.chromeTime(Date.now() - 86_400_000);
    db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0);
      INSERT INTO urls(url,title,visit_count,last_visit_time) VALUES ('https://www.notion.so/a','A',7,${recent}),('https://github.com/x','X',4,${recent});`);
  } else {
    const recent = (Date.now() - 86_400_000) * 1000;
    db.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER, last_visit_date INTEGER);
      INSERT INTO moz_places(url,visit_count,last_visit_date) VALUES ('https://www.overleaf.com/project','9',${recent});`);
  }
  db.close();
}
/** `fn` run with no sqlite3 command to be found (Windows has none). */
async function withoutSqlite3(fn) {
  const was = process.env.PATH;
  process.env.PATH = temp();
  try { return await fn(); } finally { process.env.PATH = was; }
}

test('the tools screen\'s history on Windows: Chrome\'s and Opera\'s from AppData\\Local and Roaming, Firefox\'s from Roaming, all with node:sqlite; Safari has none', async () => {
  const home = temp();
  historyAt(path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History'), 'chromium');
  historyAt(path.join(home, 'AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'History'), 'chromium');
  historyAt(path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'abc.default-release', 'places.sqlite'), 'firefox');
  const chrome = await withoutSqlite3(() => historySites({ homeDir: home, browserId: 'chrome', platform: 'win32' }));
  assert.deepEqual(chrome.map((site) => [site.host, site.visits]), [['notion.so', 7], ['github.com', 4]]);
  const opera = await withoutSqlite3(() => historySites({ homeDir: home, browserId: 'opera', platform: 'win32' }));
  assert.deepEqual(opera.map((site) => site.host), ['notion.so', 'github.com'], 'Opera keeps one profile, its folder itself');
  const firefox = await withoutSqlite3(() => historySites({ homeDir: home, browserId: 'firefox', platform: 'win32' }));
  assert.deepEqual(firefox.map((site) => [site.host, site.visits]), [['overleaf.com', 9]]);
  assert.deepEqual(await historySites({ homeDir: home, browserId: 'safari', platform: 'win32', diskAccess: async () => true }), []);
});

test('the tools screen on Windows says "this computer", and a desktop app counts by its program in AppData or Program Files', async () => {
  const home = temp();
  historyAt(path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History'), 'chromium');
  const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), ProgramFiles: path.join(home, 'Program Files') };
  fs.mkdirSync(path.join(env.LOCALAPPDATA, 'Programs', 'Evernote'), { recursive: true });
  fs.writeFileSync(path.join(env.LOCALAPPDATA, 'Programs', 'Evernote', 'Evernote.exe'), '');
  const detected = { apps: { Obsidian: { found: true, where: '~/Vault' } }, localRepos: ['a', 'b'] };
  const out = await withoutSqlite3(() => toolEvidence({ homeDir: home, env, browserId: 'chrome', detected, platform: 'win32' }));
  assert.doesNotMatch(Object.values(out.evidence).map((fact) => fact.evidence).join('\n'), /this Mac/);
  assert.equal(out.evidence.__sites.evidence, 'Chrome history on this computer');
  assert.equal(out.evidence['Folders on this Mac'].evidence, '2 repositories on this computer');
  assert.equal(out.evidence.Obsidian.evidence, 'Found on this computer (~/Vault)');
  assert.deepEqual([out.evidence.Evernote.used, out.evidence.Evernote.method], [true, 'app'], 'Evernote.exe in AppData\\Local\\Programs');
  // A Mac's words as before.
  const mac = await toolEvidence({ homeDir: home, env, browserId: 'chrome', detected, platform: 'darwin', applications: [] });
  assert.equal(mac.evidence['Folders on this Mac'].evidence, '2 repositories on this Mac');
});

test('recent projects off the Mac: ChatGPT and Claude asked at once, never after a wait for a sign-ins answer nobody is asked for', async () => {
  const home = temp();
  const dataRoot = path.join(home, 'root');
  const asked = [];
  let last = null;
  const providers = { status: async () => ({ providers: [{ id: 'anthropic', installed: true, signedIn: true }], decision: { pick: 'anthropic' } }) };
  const discovery = createDiscovery({
    platform: 'win32', agents: { turn: async () => ({ text: 'null' }) }, context: async () => ({ dataRoot }), homeDir: home, providers,
    notify: (state) => { last = state; }, assistants: { ask: async (input) => { asked.push(input); return [{ app: 'Claude', outcome: 'none' }, { app: 'ChatGPT', outcome: 'none' }]; } },
    keychainWaitMs: 10 * 60_000, keychainPollMs: 5,
  });
  const started = Date.now();
  await discovery.startProjects({ provider: 'anthropic' });
  while (!(last && last.projects.status !== 'running') && Date.now() - started < 5000) await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.equal(last.projects.status, 'done');
  assert.equal(asked.length, 1, 'asked, through Engelbart\'s own browser');
  assert.ok(Date.now() - started < 5000);
});
