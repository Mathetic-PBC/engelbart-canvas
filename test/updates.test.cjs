'use strict';

// New versions (src/main/updates.cjs, 2026-09-28): electron-updater, the dialogs and the install command are faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createUpdates, releaseInfo, bundleOf } = require('../src/main/updates.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-updates-'));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const DOWNLOADS = 'https://example.com/engelbart/';

/** A packaged app whose package.json says `engelbart`, and everything around it. */
function harness({ engelbart = { downloads: DOWNLOADS, developerId: false }, packaged = true, answers = [], found = null, env = {} } = {}) {
  const appPath = temp();
  fs.writeFileSync(path.join(appPath, 'package.json'), JSON.stringify({ name: 'engelbart', version: '0.1.0', ...(engelbart ? { engelbart } : {}) }));
  const logs = temp();
  const dialogs = [];
  const quits = [];
  const spawned = [];
  const repeats = [];
  const updater = Object.assign(new EventEmitter(), {
    checks: 0,
    installs: 0,
    async checkForUpdates() {
      this.checks += 1;
      if (found) this.emit(this.autoDownload ? 'update-downloaded' : 'update-available', { version: found });
      return { isUpdateAvailable: !!found, updateInfo: { version: found || '0.1.0' } };
    },
    quitAndInstall() { this.installs += 1; },
  });
  const updates = createUpdates({
    app: { isPackaged: packaged, getAppPath: () => appPath, getVersion: () => '0.1.0', getPath: () => logs },
    dialog: { showMessageBox: async (_win, options) => { const shown = options || _win; dialogs.push(shown); return { response: answers.length ? answers.shift() : 1 }; } },
    getWindow: () => null,
    platform: 'darwin',
    requestQuit: async () => { quits.push(true); },
    env: { HOME: os.homedir(), ...env },
    loadUpdater: () => updater,
    spawnImpl: (file, args, options) => { const child = Object.assign(new EventEmitter(), { unref() {} }); spawned.push({ file, args, options, child }); return child; },
    setTimer: () => null,
    setRepeat: (fn) => { repeats.push(fn); return repeats.length; },
    clearRepeat: (id) => { repeats[id - 1] = null; },
  });
  return { updates, updater, dialogs, quits, spawned, repeats, logs, appPath };
}

test('releaseInfo: the download folder the build was made with, an https address ending in /; else nothing is checked', () => {
  const dir = temp();
  const write = (engelbart) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engelbart }));
  write({ downloads: DOWNLOADS, developerId: true });
  assert.deepEqual(releaseInfo(dir), { downloads: DOWNLOADS, developerId: true });
  write({ downloads: 'http://127.0.0.1:8767/' });
  assert.deepEqual(releaseInfo(dir), { downloads: 'http://127.0.0.1:8767/', developerId: false }, 'a folder on this Mac, for scripted runs');
  for (const bad of [null, { downloads: null }, { downloads: 'http://example.com/e/' }, { downloads: 'http://127.0.0.1.example.com/' }, { downloads: 'https://example.com/e' }, { downloads: 'https://example.com/$(x)/' }]) {
    write(bad);
    assert.equal(releaseInfo(dir), null, JSON.stringify(bad));
  }
  assert.equal(bundleOf('/Applications/Engelbart.app/Contents/MacOS/Engelbart'), '/Applications/Engelbart.app');
});

test('nothing runs in a checkout, in a build without a download folder, or with ENGELBART_UPDATES=off', async () => {
  for (const options of [{ packaged: false }, { engelbart: null }, { env: { ENGELBART_UPDATES: 'off' } }]) {
    const { updates, updater } = harness({ ...options, found: '0.2.0' });
    assert.equal(updates.enabled, false);
    assert.equal(updates.start(), false);
    await updates.check({ manual: true });
    assert.equal(updater.checks, 0);
  }
});

test('ad hoc: a new version is offered once per launch; Update runs the install command, and the app quits when it says the new version is ready', async () => {
  const later = harness({ found: '0.2.0', answers: [1] });
  await later.updates.check();
  await tick();
  assert.equal(later.dialogs.length, 1);
  assert.equal(later.dialogs[0].message, 'Engelbart 0.2.0 is available');
  assert.equal(later.updater.autoDownload, false, 'macOS would refuse an ad hoc update: electron-updater only looks');
  await later.updates.check();
  await tick();
  assert.equal(later.dialogs.length, 1, 'Later: not asked again this launch');

  const { updates, dialogs, spawned, repeats, quits } = harness({ found: '0.2.0', answers: [0] });
  await updates.check();
  await tick();
  assert.equal(dialogs.length, 1);
  assert.equal(spawned.length, 1);
  const { file, args, options } = spawned[0];
  assert.equal(file, '/bin/bash');
  assert.match(args[1], /curl -fsSL .* -o "\$script" "\$\{ENGELBART_DOWNLOADS\}install\.sh" && exec \/bin\/bash "\$script"/);
  assert.equal(options.detached, true);
  assert.deepEqual([options.env.ENGELBART_DOWNLOADS, options.env.ENGELBART_WAIT_PID, options.env.ENGELBART_APP_PATH], [DOWNLOADS, String(process.pid), bundleOf(process.execPath)]);
  assert.deepEqual(updates.snapshot(), { enabled: true, state: 'installing', available: '0.2.0' });
  assert.deepEqual(updates.menuItem(), { label: 'Downloading Update…', enabled: false });
  repeats[0]();
  assert.equal(quits.length, 0, 'still downloading');
  fs.writeFileSync(options.env.ENGELBART_READY_FILE, '');
  repeats[0]();
  assert.deepEqual([quits.length, updates.snapshot().state, fs.existsSync(options.env.ENGELBART_READY_FILE)], [1, 'ready', false]);
  spawned[0].child.emit('exit', 0);
  assert.equal(updates.snapshot().state, 'ready', 'the command goes on to replace the app');
  assert.equal(updates.menuItem().label, 'Restart to Update');
});

test('ad hoc: an install command that fails before the new version is ready says why, and leaves this version running', async () => {
  const { updates, dialogs, spawned, quits, logs } = harness({ found: '0.2.0', answers: [0] });
  await updates.check();
  await tick();
  fs.writeFileSync(path.join(logs, 'update.log'), 'Downloading Engelbart 0.2.0 for Apple silicon Macs…\n######################## 100.0%\n\nEngelbart was not installed: the download does not match its checksum; run the command again.\n');
  spawned[0].child.emit('exit', 1);
  await tick();
  assert.equal(quits.length, 0);
  assert.equal(updates.snapshot().state, 'idle');
  assert.equal(dialogs[1].message, 'Engelbart 0.2.0 could not be installed');
  assert.match(dialogs[1].detail, /does not match its checksum/);
  assert.doesNotMatch(dialogs[1].detail, /#####/, 'curl\'s progress bar is left out');
});

test('Check for Updates… says what it found, and offers a new version once', async () => {
  const none = harness();
  await none.updates.check({ manual: true });
  assert.equal(none.dialogs[0].message, 'Engelbart 0.1.0 is the newest version.');
  const some = harness({ found: '0.3.0', answers: [1] });
  await some.updates.check({ manual: true });
  await tick();
  assert.equal(some.dialogs.length, 1, 'one dialog, not one from the event and one from the menu');
  assert.equal(some.dialogs[0].message, 'Engelbart 0.3.0 is available');
  await some.updates.check({ manual: true });
  assert.equal(some.dialogs.length, 2, 'asked for: offered again');
});

test('Developer ID: electron-updater downloads by itself and installs at quit; Restart Now installs at once', async () => {
  const { updates, updater, dialogs, spawned } = harness({ engelbart: { downloads: DOWNLOADS, developerId: true }, found: '0.2.0', answers: [0] });
  await updates.check();
  await tick();
  assert.deepEqual([updater.autoDownload, updater.autoInstallOnAppQuit], [true, true]);
  assert.equal(dialogs[0].message, 'Engelbart 0.2.0 is ready');
  assert.equal(updater.installs, 1);
  assert.equal(spawned.length, 0, 'no install command');
});
