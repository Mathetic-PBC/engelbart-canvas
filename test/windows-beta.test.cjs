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
