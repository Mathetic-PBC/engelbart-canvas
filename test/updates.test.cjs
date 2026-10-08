'use strict';

// New versions (src/main/updates.cjs, 2026-09-28): electron-updater, the dialogs and the install command are faked.
// MATH-43 (2026-10-05): the ad hoc download's percentage, the ready dialog (Restart to Update / Later), and Restart to
// Update after the install command has stopped. Its follow-ups: Restart to Update from the menu or a banner asks about
// terminal sessions as any quit does (only the ready dialog's has said already), and only Restart to Update leaves the
// install command the reopen file that has it open the new version, so a plain quit after Later opens nothing.

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

/** A packaged app whose package.json says `engelbart`, and everything around it. `quit`: what requestQuit says (whether
 * it goes on to quit), given what it was asked. */
function harness({ engelbart = { downloads: DOWNLOADS, developerId: false }, packaged = true, answers = [], found = null, env = {}, runningSessions, quit = () => true } = {}) {
  const appPath = temp();
  fs.writeFileSync(path.join(appPath, 'package.json'), JSON.stringify({ name: 'engelbart', version: '0.1.0', ...(engelbart ? { engelbart } : {}) }));
  const logs = temp();
  const dialogs = [];
  const quits = [];
  const spawned = [];
  const repeats = [];
  const changes = [];
  const bars = []; // the window's (the Dock icon's) progress bar
  const win = { isDestroyed: () => false, setProgressBar: (value) => bars.push(value) };
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
    getWindow: () => win,
    platform: 'darwin',
    requestQuit: async (options) => { quits.push(options); return quit(options); },
    onChange: (snapshot) => changes.push(snapshot),
    ...(runningSessions ? { runningSessions } : {}),
    env: { HOME: os.homedir(), ...env },
    loadUpdater: () => updater,
    spawnImpl: (file, args, options) => { const child = Object.assign(new EventEmitter(), { unref() {} }); spawned.push({ file, args, options, child }); return child; },
    setTimer: () => null,
    setRepeat: (fn) => { repeats.push(fn); return repeats.length; },
    clearRepeat: (id) => { repeats[id - 1] = null; },
  });
  return { updates, updater, dialogs, quits, spawned, repeats, changes, bars, logs, appPath };
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

/** An ad hoc build that found 0.2.0 and was told Update (then `answers` for the dialogs after). */
async function updating(options = {}) {
  const h = harness({ found: '0.2.0', ...options, answers: [0, ...(options.answers || [])] });
  await h.updates.check();
  await tick();
  return { ...h, log: path.join(h.logs, 'update.log'), ready: (n = 0) => h.spawned[n].options.env.ENGELBART_READY_FILE, reopen: (n = 0) => h.spawned[n].options.env.ENGELBART_REOPEN_FILE };
}

test('ad hoc: a new version is offered once per launch; Update runs the install command and shows how far its download is', async () => {
  const later = harness({ found: '0.2.0', answers: [1] });
  await later.updates.check();
  await tick();
  assert.equal(later.dialogs.length, 1);
  assert.equal(later.dialogs[0].message, 'Engelbart 0.2.0 is available');
  assert.equal(later.updater.autoDownload, false, 'macOS would refuse an ad hoc update: electron-updater only looks');
  await later.updates.check();
  await tick();
  assert.equal(later.dialogs.length, 1, 'Later: not asked again this launch');

  const { updates, dialogs, spawned, repeats, quits, changes, bars, log } = await updating();
  assert.equal(dialogs.length, 1);
  assert.equal(spawned.length, 1);
  const { file, args, options } = spawned[0];
  assert.equal(file, '/bin/bash');
  assert.match(args[1], /curl -fsSL .* -o "\$script" "\$\{ENGELBART_DOWNLOADS\}install\.sh" && exec \/bin\/bash "\$script"/);
  assert.equal(options.detached, true);
  assert.deepEqual([options.env.ENGELBART_DOWNLOADS, options.env.ENGELBART_WAIT_PID, options.env.ENGELBART_APP_PATH], [DOWNLOADS, String(process.pid), bundleOf(process.execPath)]);
  assert.deepEqual(updates.snapshot(), { enabled: true, state: 'installing', available: '0.2.0', version: '0.2.0', percent: null, dismissed: false });
  assert.deepEqual(updates.menuItem(), { label: 'Downloading Update…', enabled: false });
  assert.deepEqual(bars, [2], 'indeterminate on the Dock until curl says how far it is');

  const before = changes.length;
  repeats[0]();
  assert.equal(changes.length, before, 'nothing downloaded yet: nothing to tell');
  fs.writeFileSync(log, 'Downloading Engelbart 0.2.0 for Apple silicon Macs…\n\r##                    12.0%\r#########             42.3%');
  repeats[0]();
  assert.equal(updates.snapshot().percent, 42);
  assert.equal(changes.length, before + 1);
  assert.deepEqual([changes.at(-1).state, changes.at(-1).percent], ['installing', 42], 'the windows hear of it');
  assert.equal(bars.at(-1), 0.42);
  assert.deepEqual(updates.menuItem(), { label: 'Downloading Update… 42%', enabled: false });
  fs.appendFileSync(log, '\r#########             42.9%');
  repeats[0]();
  assert.equal(changes.length, before + 1, 'told again only when the whole percentage changes');
  assert.equal(quits.length, 0, 'still downloading');
});

test('ad hoc: once the new version is ready the app asks, not quits; Restart to Update quits without the terminal-session question', async () => {
  const { updates, dialogs, repeats, quits, bars, ready } = await updating({ answers: [0] });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  assert.equal(fs.existsSync(ready()), false);
  assert.equal(updates.snapshot().state, 'ready');
  assert.equal(bars.at(-1), -1, 'the Dock bar is cleared');
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[1].message, 'Engelbart 0.2.0 is ready');
  assert.deepEqual([dialogs[1].buttons, dialogs[1].defaultId, dialogs[1].cancelId], [['Restart to Update', 'Later'], 0, 1]);
  assert.doesNotMatch(dialogs[1].detail, /terminal/, 'no terminal sessions to speak of');
  assert.deepEqual(quits, [{ update: true }]);
});

test('ad hoc: Later on the ready dialog leaves it ready, to be installed at the next quit; the banner\'s Later only hides the banner', async () => {
  const { updates, dialogs, spawned, repeats, quits, changes, ready, reopen } = await updating({ answers: [1] });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  assert.equal(dialogs[1].message, 'Engelbart 0.2.0 is ready');
  assert.equal(quits.length, 0);
  assert.equal(updates.snapshot().state, 'ready');
  assert.equal(updates.menuItem().label, 'Restart to Update');
  assert.equal(updates.snapshot().dismissed, false, 'the banner still offers it');

  const before = changes.length;
  updates.later();
  assert.deepEqual([updates.snapshot().state, updates.snapshot().dismissed, changes.length], ['ready', true, before + 1]);
  assert.equal(updates.menuItem().label, 'Restart to Update', 'the menu keeps it');
  assert.equal(quits.length, 0);
  assert.equal(fs.existsSync(reopen()), false, 'Later: no reopen file, so the next quit installs it and opens nothing');

  updates.menuItem().click();
  assert.deepEqual(quits, [{ update: false }], 'the install command still waits: the menu quits into it, asking about terminal sessions as any quit does');
  assert.equal(spawned.length, 1);
});

test('ad hoc: Restart to Update writes the reopen file the install command was given before it quits; a quit that does not go ahead removes it, as after Later', async () => {
  let goesAhead = false;
  const marked = []; // whether the reopen file was there each time requestQuit was asked
  const h = await updating({ answers: [1], quit: () => { marked.push(fs.existsSync(h.reopen())); return goesAhead; } });
  const { updates, spawned, repeats, quits, ready, reopen } = h;
  assert.equal(path.dirname(reopen()), path.dirname(ready()), 'next to the ready file');
  assert.equal(path.basename(reopen(), '.reopen'), path.basename(ready(), '.ready'), 'one name for the run');
  assert.match(path.basename(reopen()), new RegExp(`^engelbart-update-${process.pid}-\\d+-\\d+\\.reopen$`));
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  assert.equal(fs.existsSync(reopen()), false, 'Later: none');

  updates.menuItem().click(); // Cancel on the terminal-session question
  await tick();
  assert.deepEqual([quits, marked], [[{ update: false }], [true]]);
  assert.equal(fs.existsSync(reopen()), false, 'the quit did not go ahead: removed');
  assert.deepEqual([updates.snapshot().state, updates.menuItem().label], ['ready', 'Restart to Update'], 'still waiting for the next quit');

  goesAhead = true;
  assert.equal(updates.restart(), true); // a window's banner
  await tick();
  assert.deepEqual([quits, marked], [[{ update: false }, { update: false }], [true, true]]);
  assert.equal(fs.existsSync(reopen()), true, 'quitting: left for the install command, to open the new version');
  assert.equal(spawned.length, 1);
  fs.unlinkSync(reopen());
});

test('ad hoc: the ready dialog says a restart ends the terminal sessions that are running', async () => {
  const { dialogs, repeats, ready } = await updating({ answers: [1], runningSessions: () => 2 });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  assert.equal(dialogs[1].message, 'Engelbart 0.2.0 is ready');
  assert.match(dialogs[1].detail, /Restarting ends 2 running terminal sessions/);
});

test('ad hoc: Restart to Update while the install command waits quits into it, and starts nothing', async () => {
  const { updates, spawned, repeats, quits, ready } = await updating({ answers: [1] });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  assert.equal(updates.restart(), true);
  assert.deepEqual(quits, [{ update: false }], 'from a banner: the terminal-session question, as any quit');
  assert.equal(spawned.length, 1);
});

test('ad hoc: an install command stopped after it was ready leaves Restart to Update, which downloads again and then quits by itself', async () => {
  const { updates, dialogs, spawned, repeats, quits, ready, reopen } = await updating({ answers: [1] });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  spawned[0].child.emit('exit', 1); // killed, or it failed while it waited
  await tick();
  assert.equal(updates.snapshot().state, 'ready');
  assert.equal(updates.menuItem().label, 'Restart to Update');
  assert.equal(dialogs.length, 2, 'no failure dialog: it was ready');

  updates.menuItem().click();
  assert.equal(quits.length, 0, 'nothing waits for the quit yet');
  assert.equal(spawned.length, 2, 'the install command runs again');
  assert.deepEqual([updates.snapshot().state, updates.snapshot().version], ['installing', '0.2.0'], 'the banner shows the download again');
  assert.notEqual(ready(1), ready(0));
  assert.notEqual(reopen(1), reopen(0));
  assert.deepEqual([fs.existsSync(reopen(0)), fs.existsSync(reopen(1))], [false, true], 'the reopen file is the new run\'s');
  fs.writeFileSync(ready(1), '');
  repeats[1]();
  await tick();
  assert.deepEqual(quits, [{ update: false }], 'from the menu: the terminal-session question comes now, once it is ready');
  assert.equal(dialogs.length, 2, 'Restart to Update was asked for already: no second dialog');
  fs.unlinkSync(reopen(1));
});

test('ad hoc: the ready dialog\'s Restart to Update after the install command has stopped downloads again, then quits without the terminal-session question', async () => {
  const { spawned, repeats, quits, ready, reopen } = await updating({ answers: [0] });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  spawned[0].child.emit('exit', 1); // stopped while the dialog was open
  await tick();
  assert.equal(spawned.length, 2, 'the install command runs again');
  assert.equal(fs.existsSync(reopen(1)), true);
  fs.writeFileSync(ready(1), '');
  repeats[1]();
  await tick();
  assert.deepEqual(quits, [{ update: true }], 'the dialog said already');
  fs.unlinkSync(reopen(1));
});

test('ad hoc: when the quit after a second run does not go ahead, its reopen file is removed', async () => {
  const { updates, spawned, repeats, quits, ready, reopen } = await updating({ answers: [1], quit: () => false });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  spawned[0].child.emit('exit', 1);
  updates.restart();
  assert.equal(fs.existsSync(reopen(1)), true);
  fs.writeFileSync(ready(1), '');
  repeats[1]();
  await tick();
  assert.deepEqual(quits, [{ update: false }]);
  assert.equal(fs.existsSync(reopen(1)), false);
  assert.equal(updates.snapshot().state, 'ready', 'it waits for the next quit');
});

test('ad hoc: Restart to Update whose second run fails before it is ready says why and goes back to idle', async () => {
  const { updates, dialogs, spawned, repeats, quits, ready, reopen } = await updating({ answers: [1] });
  fs.writeFileSync(ready(), '');
  repeats[0]();
  await tick();
  spawned[0].child.emit('exit', 0);
  updates.restart();
  spawned[1].child.emit('exit', 1);
  await tick();
  assert.equal(updates.snapshot().state, 'idle');
  assert.equal(dialogs.at(-1).message, 'Engelbart 0.2.0 could not be installed');
  assert.equal(quits.length, 0);
  assert.equal(fs.existsSync(reopen(1)), false, 'no reopen file left behind');
  spawned[0].child.emit('error', new Error('late'));
  assert.equal(dialogs.at(-1).message, 'Engelbart 0.2.0 could not be installed', 'the first run says nothing more');
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
