'use strict';

// Engelbart's beta on Linux (2026-10-18, docs/windows-port-log.md "Beta catch-up to 0.1.23 on linux-beta-deployment"):
// Hudson, "on Linux it is not accessing Obsidian files and other files well". Every place that finds an app's or the
// person's files is given the platform, a home and an environment here, so these run on the Mac too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const readers = require('../src/main/connect/readers.cjs');
const scan = require('../src/main/connect/scan.cjs');
const { cursorDb } = require('../src/main/connect/cursor.cjs');
const { obsidianTree } = require('../src/main/onboarding/obsidian-tree.cjs');
const { historySites, toolEvidence } = require('../src/main/onboarding/discover.cjs');
const linuxApps = require('../src/main/connect/linux-apps.cjs');
const { createBrowsers } = require('../src/main/onboarding/browsers.cjs');

const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-linux-platform-')));
const write = (file, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const vault = (dir) => { write(path.join(dir, '.obsidian', 'app.json'), '{}'); write(path.join(dir, 'Note.md'), '# Note\nhttps://example.org/a\n'); return dir; };
const obsidianJson = (file, vaults) => write(file, JSON.stringify({ vaults: Object.fromEntries(vaults.map(([id, dir, ts, open]) => [id, { path: dir, ts, ...(open ? { open: true } : {}) }])) }));

test('Obsidian on Linux: ~/.config/obsidian (or $XDG_CONFIG_HOME), Flatpak\'s and Snap\'s, all read, a vault named twice once', () => {
  const home = temp();
  const a = vault(path.join(home, 'Notes', 'Deb vault'));
  const b = vault(path.join(home, 'Notes', 'Flatpak vault'));
  const c = vault(path.join(home, 'Snap vault'));
  obsidianJson(path.join(home, '.config', 'obsidian', 'obsidian.json'), [['a', a, 100], ['b', b, 50]]);
  obsidianJson(path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'), [['x', b, 300, true], ['gone', path.join(home, 'Gone'), 400]]);
  obsidianJson(path.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'), [['c', c, 200]]);
  const found = readers.obsidianVaults(home, 'linux', {});
  assert.deepEqual(found.map((one) => one.path), [b, c, a], 'newest opened first; the vault two installs know is listed once, with its newest time');
  assert.equal(found[0].open, true);
  assert.equal(found[0].shown, '~/Notes/Flatpak vault');
  // XDG_CONFIG_HOME moves the native install's settings.
  const xdg = path.join(home, 'xdg');
  obsidianJson(path.join(xdg, 'obsidian', 'obsidian.json'), [['c', c, 999]]);
  assert.deepEqual(readers.obsidianVaults(home, 'linux', { XDG_CONFIG_HOME: xdg }).map((one) => one.path), [c, b], '$XDG_CONFIG_HOME/obsidian, not ~/.config/obsidian');
  assert.deepEqual(readers.obsidianVaults(home, 'linux', { XDG_CONFIG_HOME: 'relative/xdg' }).map((one) => one.path), [b, c, a], 'a relative XDG_CONFIG_HOME is ignored, as the spec says');
  // The Mac's file is still the Mac's only: a Linux home with only it finds nothing, a Mac finds nothing in ~/.config.
  assert.deepEqual(readers.obsidianVaults(home, 'darwin', {}), []);
});

test('the Obsidian picker and Connect\'s scan see the vaults of a Linux install', async () => {
  const home = temp();
  const dir = vault(path.join(home, 'Vault'));
  obsidianJson(path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'), [['v', dir, 1]]);
  const tree = await obsidianTree(home, { platform: 'linux', env: {} });
  assert.deepEqual(tree.vaults.map((one) => one.path), [dir]);
  assert.deepEqual(tree.vaults[0].tree.map((node) => node.name), ['Note']);
  const detected = scan.detect({ homeDir: home, env: {}, platform: 'linux', applications: [] });
  assert.equal(detected.apps.Obsidian.found, true);
  assert.equal(detected.apps.Obsidian.where, '~/Vault');
});

test('Chromium browsers on Linux: ~/.config\'s, Flatpak\'s and Snap\'s profiles; the Mac\'s and Windows\' folders as they were', () => {
  const home = temp();
  const profile = (base, name = 'Default') => { write(path.join(base, name, 'History'), 'x'); return path.join(base, name); };
  profile(path.join(home, '.config', 'google-chrome'));
  profile(path.join(home, '.config', 'google-chrome'), 'Profile 2');
  write(path.join(home, '.config', 'google-chrome', 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work' } } } }));
  profile(path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'));
  profile(path.join(home, '.var', 'app', 'org.chromium.Chromium', 'config', 'chromium'));
  profile(path.join(home, 'snap', 'chromium', 'common', 'chromium'));
  profile(path.join(home, '.config', 'microsoft-edge'));
  profile(path.join(home, '.config', 'vivaldi'));
  profile(path.join(home, '.var', 'app', 'com.google.Chrome', 'config', 'google-chrome'));
  const found = readers.browserProfiles(home, 'linux', {});
  const seen = found.map((one) => `${one.browser}:${path.relative(home, one.dir)}`).sort();
  assert.deepEqual(seen, [
    'Brave:.config/BraveSoftware/Brave-Browser/Default',
    'Chrome:.config/google-chrome/Default',
    'Chrome:.config/google-chrome/Profile 2',
    'Chrome:.var/app/com.google.Chrome/config/google-chrome/Default',
    'Chromium:.var/app/org.chromium.Chromium/config/chromium/Default',
    'Chromium:snap/chromium/common/chromium/Default',
    'Edge:.config/microsoft-edge/Default',
    'Vivaldi:.config/vivaldi/Default',
  ]);
  assert.equal(found.find((one) => one.profile === 'Profile 2').name, 'Work');
  const xdg = path.join(home, 'elsewhere');
  profile(path.join(xdg, 'google-chrome'), 'Profile 9');
  assert.ok(readers.browserProfiles(home, 'linux', { XDG_CONFIG_HOME: xdg }).some((one) => one.profile === 'Profile 9'), '$XDG_CONFIG_HOME/google-chrome');
  assert.deepEqual(readers.browserProfiles(home, 'darwin', {}), [], 'a Mac does not read ~/.config');
});

test('a browser\'s history without the sqlite3 command: read in this process (node:sqlite), as on Windows', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { t.skip('no node:sqlite'); return; }
  const dir = path.join(temp(), 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)');
  const now = readers.chromeTime(Date.now());
  db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)').run('https://www.overleaf.com/project/1', 'Paper', 7, now);
  db.close();
  assert.equal(readers.hasCommand('sqlite3', { PATH: temp() }, 'linux'), false);
  const bin = temp();
  write(path.join(bin, 'sqlite3'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'sqlite3'), 0o755);
  assert.equal(readers.hasCommand('sqlite3', { PATH: `/nowhere${path.delimiter}${bin}` }, 'linux'), true);
  const run = readers.sqliteRunner({ PATH: temp() }, 'linux');
  const sites = await readers.browserHistory(dir, { run });
  assert.deepEqual(sites.map((site) => [site.host, site.visits]), [['overleaf.com', 7]]);
  assert.notEqual(readers.sqliteRunner({ PATH: bin }, 'linux'), run, 'the command when it is there');
});

test('Firefox\'s history on Linux: ~/.mozilla/firefox, Snap\'s and Flatpak\'s profiles', async () => {
  const home = temp();
  for (const root of [['.mozilla', 'firefox'], ['snap', 'firefox', 'common', '.mozilla', 'firefox'], ['.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox']]) write(path.join(home, ...root, 'abc.default-release', 'places.sqlite'), 'x');
  write(path.join(home, '.mozilla', 'firefox', 'Crash Reports', 'events', 'x'), '');
  const files = [];
  const run = (command, args, options, callback) => { files.push(path.basename(path.dirname(args[2]))); setImmediate(() => callback(null, JSON.stringify([{ url: 'https://scholar.google.com/x', visits: 3 }]))); };
  const sites = await historySites({ homeDir: home, browserId: 'firefox', run, platform: 'linux' });
  assert.equal(files.length, 3, 'each install\'s profile read');
  assert.deepEqual(sites, [{ host: 'scholar.google.com', visits: 9 }]);
});

test('apps on Linux: found by their .desktop entries (deb, Flatpak, Snap, an AppImage\'s) and Obsidian by its settings', () => {
  const home = temp();
  const system = temp();
  const entry = (dir, id, name) => write(path.join(dir, `${id}.desktop`), `[Desktop Entry]\nType=Application\nName=${name}\nName[de]=Anders\nExec=x\n\n[Desktop Action new]\nName=New Window\n`);
  entry(path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), 'org.zotero.Zotero', 'Zotero');
  entry(path.join(system, 'share', 'applications'), 'cursor', 'Cursor');
  entry(path.join(home, '.local', 'share', 'applications'), 'appimagekit_0f1e-Zoom_Workplace', 'Zoom Workplace');
  write(path.join(home, '.local', 'share', 'applications', 'gone.desktop'), '[Desktop Entry]\nName=Notion\nHidden=true\n');
  const env = { XDG_DATA_DIRS: path.join(system, 'share') };
  const has = (app) => linuxApps.installed(app, { homeDir: home, env });
  assert.equal(has('Zotero'), true);
  assert.equal(has('Cursor'), true);
  assert.equal(has('Zoom'), true);
  assert.equal(has('Notion'), false, 'an entry marked Hidden is not an app');
  assert.equal(has('Obsidian'), false);
  write(path.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'), '{}');
  assert.equal(has('Obsidian'), true, 'Obsidian\'s settings there: it was run (an AppImage leaves no .desktop entry)');
  const evidence = scan.detect({ homeDir: home, env, platform: 'linux', applications: [] });
  assert.equal(evidence.apps.Zotero.found, false, 'Zotero is found by its sign-in or ~/Zotero, as on the Mac');
});

test('the browsers on Linux: by their .desktop entries; Safari, Arc and Comet never', async () => {
  const home = temp();
  const system = temp();
  const entry = (dir, id, name) => write(path.join(dir, `${id}.desktop`), `[Desktop Entry]\nName=${name}\n`);
  entry(path.join(system, 'applications'), 'google-chrome', 'Google Chrome');
  entry(path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), 'org.mozilla.firefox', 'Firefox');
  entry(path.join(system, 'applications'), 'brave_brave', 'Brave');
  const apps = linuxApps.createLinuxInstalledApps({ homeDir: home, env: { XDG_DATA_DIRS: system } });
  assert.equal(apps.has('com.google.Chrome'), true);
  assert.equal(apps.has('org.mozilla.firefox'), true);
  assert.equal(apps.has('com.brave.Browser'), true);
  assert.equal(apps.has('com.apple.Safari'), false);
  assert.equal(apps.has('company.thebrowser.Browser'), false);
  assert.equal(apps.has('org.chromium.Chromium'), false);
  assert.equal(await apps.settled('com.google.Chrome'), true);
  assert.equal(await apps.settled('ai.perplexity.comet'), false);
  await apps.ask();
  const browsers = createBrowsers({ installedApps: apps, defaultName: () => 'Firefox', prefs: { get: () => ({}), set: () => {} } });
  const out = await browsers.list();
  assert.deepEqual(out.browsers.map((one) => one.id), ['firefox', 'chrome', 'brave']);
  const fixed = linuxApps.createLinuxInstalledApps({ homeDir: home, env: {}, override: ['com.google.Chrome'] });
  assert.equal(fixed.has('com.google.Chrome'), true);
  assert.equal(fixed.has('org.mozilla.firefox'), false, 'ENGELBART_INSTALLED_BROWSERS stands in for the machine');
});

test('off the Mac the browser\'s sign-ins are never asked about, and the run keeps its sign-ins: those made in Engelbart\'s own window (copiesSignIns)', async () => {
  const m = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);
  const chrome = { id: 'chrome', name: 'Chrome', keychain: true, profiles: [] };
  assert.deepEqual(m.keychainStep({ browsers: [chrome], chosenId: 'chrome', keychain: null }, 'other'), { go: 'allowed' });
  assert.deepEqual(m.keychainStep({ browsers: [{ id: 'safari', name: 'Safari' }], chosenId: 'safari', keychain: null, safari: { diskAccess: false } }, 'linux'), { go: 'allowed' });
  assert.equal(m.keychainStep(null, 'other'), 'wait');
  assert.equal(m.keychainStep({ browsers: [chrome], chosenId: 'chrome', keychain: null }, 'darwin'), 'ask', 'the Mac as before');
  assert.equal(m.keychainStep({ browsers: [chrome], chosenId: 'chrome', keychain: null }), 'ask', 'no platform given: the Mac');
  // Declined, the import would leave out every app that needs a sign-in (connect/session.cjs: "its sign-in can only be used
  // with your browser's sign-ins, which you turned down"), when nobody was asked and Engelbart's window can sign in.
  assert.equal(m.runKeychain({ browsers: [chrome], keychain: 'allowed' }), true);
});

test('recent projects on Linux: ChatGPT and Claude asked at once, never after a wait for a sign-ins answer nobody is asked for', async () => {
  const { createDiscovery } = require('../src/main/onboarding/discover.cjs');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-linux-discovery-')));
  const dataRoot = path.join(home, 'root');
  const asked = [];
  let last = null;
  const providers = { status: async () => ({ providers: [{ id: 'anthropic', installed: true, signedIn: true }], decision: { pick: 'anthropic' } }) };
  const discovery = createDiscovery({
    platform: 'linux', agents: { turn: async () => ({ text: 'null' }) }, context: async () => ({ dataRoot }), homeDir: home, providers,
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

test('Cursor on Linux: ~/.config/Cursor (or $XDG_CONFIG_HOME)', () => {
  const home = temp();
  assert.equal(cursorDb(home, 'linux', {}), path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  assert.equal(cursorDb(home, 'linux', { XDG_CONFIG_HOME: '/x/conf' }), path.join('/x/conf', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  assert.equal(cursorDb(home, 'darwin', {}), path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
});

test('an export\'s .zip without the unzip command: read in this process', () => {
  const zlib = require('node:zlib');
  const dir = temp();
  const body = Buffer.from(JSON.stringify([{ uuid: 'u1', name: 'Hello', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', chat_messages: [{ sender: 'human', text: 'hi' }, { sender: 'assistant', text: 'hello' }] }]));
  const packed = zlib.deflateRawSync(body);
  const name = Buffer.from('conversations.json');
  const crc = zlib.crc32 ? zlib.crc32(body) : 0;
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4); localHeader.writeUInt16LE(8, 8); localHeader.writeUInt32LE(crc, 14); localHeader.writeUInt32LE(packed.length, 18); localHeader.writeUInt32LE(body.length, 22); localHeader.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([localHeader, name, packed]);
  const centralPart = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  const file = path.join(dir, 'claude-export.zip');
  fs.writeFileSync(file, Buffer.concat([localPart, centralPart, end]));
  const text = readers.exportText(file, { env: { PATH: temp() }, platform: 'linux' });
  assert.equal(JSON.parse(text)[0].uuid, 'u1');
});

test('PDFs on Linux: the folders xdg-user-dirs names in the person\'s language too', () => {
  const home = temp();
  write(path.join(home, 'Téléchargements', 'paper.pdf'), '%PDF-1.4');
  write(path.join(home, 'Documents', 'x.pdf'), '%PDF-1.4');
  write(path.join(home, '.config', 'user-dirs.dirs'), '# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\nXDG_DOCUMENTS_DIR="$HOME/Documents"\n');
  assert.deepEqual(readers.pdfRoots(home, { platform: 'linux', env: {} }).map((dir) => path.basename(dir)), ['Documents', 'Téléchargements'], 'a desktop folder set to the home itself is not a PDF folder');
  assert.deepEqual(readers.pdfRoots(home, { platform: 'darwin', env: {} }).map((dir) => path.basename(dir)), ['Documents']);
});
