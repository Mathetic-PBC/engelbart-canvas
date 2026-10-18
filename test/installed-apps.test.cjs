'use strict';

// Whether a browser's app is installed, without ever blocking Engelbart (2026-10-12, src/main/browser/installed-apps.cjs):
// /Applications first, Spotlight only in the background, its answer kept and waited for at most ~2 s. Fakes only.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createInstalledApps, installedApp, plistNames } = require('../src/main/browser/installed-apps.cjs');

const plist = (id) => `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key>\n\t<string>${id}</string></dict></plist>`;

/**
 * A fake file system: `apps` { '/Applications/Google Chrome.app': 'com.google.Chrome' | null (binary plist) }. The paths
 * it is asked about are taken with `/` (path.join gives `\` on Windows, where the tests run too).
 */
function fakeFs(apps) {
  const reads = [];
  const slashed = (p) => String(p).split(path.sep).join('/');
  return {
    reads,
    fsx: {
      exists: (p) => Object.hasOwn(apps, slashed(p)),
      readdir: (dir) => Object.keys(apps).filter((p) => path.posix.dirname(p) === slashed(dir)).map((p) => path.posix.basename(p)),
      readFile: (raw) => {
        const file = slashed(raw);
        reads.push(file);
        const app = file.replace(/\/Contents\/Info\.plist$/, '');
        if (!Object.hasOwn(apps, app)) throw new Error('ENOENT');
        if (apps[app] == null) return 'bplist00\u0000\u0001';
        return plist(apps[app]);
      },
    },
  };
}

test('an app in /Applications needs no Spotlight: by its known name, or any app whose Info.plist names the bundle id', async () => {
  const asked = [];
  const { fsx } = fakeFs({ '/Applications/Google Chrome.app': 'com.google.Chrome', '/Applications/Brave Browser.app': null, '/Applications/My Firefox.app': 'org.mozilla.firefox' });
  const apps = createInstalledApps({ platform: 'darwin', appDirs: ['/Applications'], fsx, spotlight: async (id) => { asked.push(id); return false; } });
  assert.equal(apps.has('com.google.Chrome'), true);
  assert.equal(apps.has('com.brave.Browser'), true, 'a binary Info.plist is taken on its name');
  assert.equal(apps.has('org.mozilla.firefox'), true, 'renamed, found by its bundle id');
  assert.equal(await apps.settled('com.google.Chrome'), true);
  await apps.ask(['com.google.Chrome', 'com.brave.Browser', 'org.mozilla.firefox']);
  assert.deepEqual(asked, [], 'Spotlight never asked');
});

test('a known name whose Info.plist names another app is not taken', () => {
  const { fsx } = fakeFs({ '/Applications/Google Chrome.app': 'com.example.Other' });
  const apps = createInstalledApps({ platform: 'darwin', appDirs: ['/Applications'], fsx, spotlight: async () => false });
  assert.equal(apps.where('com.google.Chrome'), '');
});

test('not in /Applications: counts as installed until Spotlight answers in the background, then its answer is kept', async () => {
  const asked = [];
  let answer;
  const { fsx } = fakeFs({});
  const apps = createInstalledApps({ platform: 'darwin', appDirs: ['/Applications'], fsx, spotlight: (id) => { asked.push(id); return new Promise((resolve) => { answer = resolve; }); } });
  assert.equal(apps.has('com.brave.Browser'), true, 'no answer yet: installed');
  assert.deepEqual(asked, ['com.brave.Browser'], 'asked once, in the background');
  assert.equal(apps.has('com.brave.Browser'), true);
  assert.equal(asked.length, 1, 'not asked again while it answers');
  answer(false);
  await apps.ask(['com.brave.Browser']);
  assert.equal(apps.has('com.brave.Browser'), false);
  assert.equal(await apps.settled('com.brave.Browser'), false);
  assert.equal(asked.length, 1, 'the answer kept');
});

test('settled waits for Spotlight at most ~2 s (settleMs); no answer by then counts as installed', async () => {
  const { fsx } = fakeFs({});
  const apps = createInstalledApps({ platform: 'darwin', appDirs: ['/Applications'], fsx, spotlight: () => new Promise(() => {}), settleMs: 20 });
  const started = Date.now();
  assert.equal(await apps.settled('com.brave.Browser'), true);
  assert.ok(Date.now() - started < 1000);
  const quick = createInstalledApps({ platform: 'darwin', appDirs: ['/Applications'], fsx, spotlight: async () => false, settleMs: 2000 });
  assert.equal(await quick.settled('com.brave.Browser'), false, 'answered in time: not installed');
});

test('ENGELBART_INSTALLED_BROWSERS stands in for this Mac: nothing looked at or asked', async () => {
  const { fsx, reads } = fakeFs({ '/Applications/Google Chrome.app': 'com.google.Chrome' });
  const apps = createInstalledApps({ platform: 'darwin', appDirs: ['/Applications'], fsx, override: ['org.mozilla.firefox'], spotlight: async () => { throw new Error('never asked'); } });
  assert.equal(apps.has('com.google.Chrome'), false);
  assert.equal(apps.has('org.mozilla.firefox'), true);
  assert.equal(await apps.settled('com.google.Chrome'), false);
  await apps.ask();
  assert.deepEqual(reads, []);
});

test('installedApp asks Spotlight asynchronously (never execFileSync): its answer, the Trash, an error not taken as uninstalled', async () => {
  const run = (out) => (file, args, options, callback) => {
    assert.equal(file, '/usr/bin/mdfind');
    assert.deepEqual(args, ["kMDItemCFBundleIdentifier == 'com.google.Chrome'"]);
    assert.equal(typeof callback, 'function', 'a callback: asynchronous');
    setImmediate(() => (out instanceof Error ? callback(out, '') : callback(null, out)));
  };
  const exists = () => true;
  assert.equal(await installedApp('com.google.Chrome', { run: run('/Applications/Google Chrome.app\n'), exists }), true);
  assert.equal(await installedApp('com.google.Chrome', { run: run('/Users/me/.Trash/Google Chrome.app\n'), exists }), false, 'dragged to the Trash');
  assert.equal(await installedApp('com.google.Chrome', { run: run(''), exists }), false, 'none');
  assert.equal(await installedApp('com.google.Chrome', { run: run('/Applications/Google Chrome.app\n'), exists: () => false }), false, 'gone since Spotlight looked');
  assert.equal(await installedApp('com.google.Chrome', { run: run(new Error('mdfind failed')), exists }), true);
  assert.equal(await installedApp("x' || true", { run: () => { throw new Error('not run'); }, exists }), false, 'never a quote into the query');
});

test('nothing in the main process calls mdfind synchronously', () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..', 'src', 'main');
  const files = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) walk(p); else if (/\.c?js$/.test(entry.name)) files.push(p); } };
  walk(root);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/execFileSync\([^)]*mdfind|mdfind[^\n]*execFileSync|spawnSync\([^)]*mdfind/.test(text), false, `${path.relative(root, file)} calls mdfind synchronously`);
  }
});

test('plistNames reads an XML Info.plist\'s bundle id; a binary one is not read', () => {
  assert.equal(plistNames(plist('com.google.Chrome'), 'com.google.Chrome'), true);
  assert.equal(plistNames(plist('com.other'), 'com.google.Chrome'), false);
  assert.equal(plistNames('bplist00', 'com.google.Chrome'), null);
});
