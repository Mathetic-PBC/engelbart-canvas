'use strict';

// New versions (2026-09-28; docs/releasing-mac.md). A release is uploaded to one folder on the web with the feed
// electron-builder writes there (latest-mac.yml). The app was built knowing that folder (package.json → engelbart,
// from electron-builder.config.cjs) and checks it a minute after launch, every six hours after, and from
// Engelbart ▸ Check for Updates…. How a new version goes in depends on how this one was signed:
//
//   Developer ID  electron-updater downloads it in the background; it is installed when the app quits, and a dialog
//                 offers to restart now.
//   ad hoc        macOS installs an update only when it is signed like the app it replaces, which an ad hoc signature
//                 never is, so the new version comes the way the first one did: Update runs the install command
//                 (scripts/install-mac.sh) in the background while the app stays open, its download shown in every
//                 window (ui/UpdateBanner.jsx) and on the Dock. Once the new version is downloaded and checked the app
//                 asks to restart (MATH-43): Restart to Update quits, the app is replaced where it is and opens again;
//                 Later leaves the command waiting for as long as the app stays open, to install it at the next quit.
//                 Restart to Update after the command has stopped (it was killed) runs it again, and the app quits by
//                 itself once that one is ready. The command's output: ~/Library/Logs/Engelbart/update.log.
//
// Each version is offered once per launch; Later leaves it until the next. Nothing runs in a checkout (`npm start`),
// in a build made without a download folder, with ENGELBART_UPDATES=off, or off the Mac (a Windows build is not set up). For scripted runs only: a folder on this
// Mac (http://127.0.0.1:<port>/) is accepted, ENGELBART_CONFIRM_ALL=1 answers the dialogs with their first button,
// and ENGELBART_NO_OPEN=1 reaches the install command.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FIRST_CHECK_MS = 60_000;
const EVERY_MS = 6 * 60 * 60_000;
const READY_POLL_MS = 500;
const LOG_TAIL = 4096; // bytes of the log read for curl's progress bar

/** What the build says about itself (package.json → engelbart): { downloads, developerId }, or null. */
function releaseInfo(appPath) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8')).engelbart;
    const safe = /^(https:\/\/[^\s"'`$\\]+|http:\/\/127\.0\.0\.1:\d+(\/[^\s"'`$\\]*)?)\/$/;
    if (!info || typeof info.downloads !== 'string' || !safe.test(info.downloads)) return null;
    return { downloads: info.downloads, developerId: info.developerId === true };
  } catch {
    return null;
  }
}

/** The .app this process runs from (…/Engelbart.app/Contents/MacOS/Engelbart). */
const bundleOf = (execPath) => path.resolve(path.dirname(execPath), '..', '..');

/** The last lines the install command wrote, for a dialog. */
function lastLines(file, count = 3) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line && !/[#=]{8,}/.test(line)).slice(-count).join('\n');
  } catch {
    return '';
  }
}

/** curl's progress bar in the install command's log (`####   42.3%`, drawn again after each \r): the last percentage it
 * drew, or null before the first. Only the end of the log is read. */
function lastPercent(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, LOG_TAIL);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const found = buffer.toString('utf8').match(/\d{1,3}(?:[.,]\d+)?(?=%)/g);
    const value = found ? Number(found[found.length - 1].replace(',', '.')) : NaN;
    return value >= 0 && value <= 100 ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// `runningSessions()`: how many terminal sessions are running, which a restart ends (the ready dialog says so).
function createUpdates({ app, dialog, getWindow, requestQuit, onChange = () => {}, runningSessions = () => 0, env = process.env, platform = process.platform, loadUpdater = () => require('electron-updater').autoUpdater, spawnImpl = spawn, setTimer = setTimeout, setRepeat = setInterval, clearRepeat = clearInterval }) {
  const info = app.isPackaged && platform === 'darwin' && env.ENGELBART_UPDATES !== 'off' ? releaseInfo(app.getAppPath()) : null;
  const offered = new Set();
  let updater = null;
  let state = 'idle'; // idle | checking | installing | ready (downloaded, or the install command waits for the quit)
  let available = null; // the newer version, once seen
  let manualCheck = false; // Check for Updates… offers what it finds itself
  let run = null; // ad hoc: the install command started last, { version, alive }
  let runs = 0; // how many have started, for each its own ready file
  let percent = null; // how much of it curl has downloaded (whole, 0–100), once it says
  let dismissed = false; // Later on a window's banner: hidden until the state changes

  const parent = () => { const win = getWindow(); return win && !win.isDestroyed() ? win : null; };
  const ask = (options) => {
    if (env.ENGELBART_CONFIRM_ALL === '1') return Promise.resolve({ response: 0 }); // scripted runs only
    return parent() ? dialog.showMessageBox(parent(), options) : dialog.showMessageBox(options);
  };
  const progress = (value) => { const win = parent(); if (win) win.setProgressBar(value); };
  const notify = () => { try { onChange(snapshot()); } catch { /* a closed window */ } };
  const set = (next) => { if (next !== state) dismissed = false; state = next; notify(); };
  // `version`: the one being installed (else the newer one seen); `percent`: while installing, once curl says.
  const snapshot = () => ({ enabled: !!info, state, available, version: (run && run.version) || available, percent: state === 'installing' ? percent : null, dismissed });

  /** Ad hoc: the install command, in the background. When it says the new version is ready the app asks to restart, or,
   * `quitWhenReady` (Restart to Update ran it again), quits. */
  function runInstaller(version, { quitWhenReady = false } = {}) {
    const logs = app.getPath('logs');
    fs.mkdirSync(logs, { recursive: true });
    const log = path.join(logs, 'update.log');
    const ready = path.join(os.tmpdir(), `engelbart-update-${process.pid}-${Date.now()}-${(runs += 1)}.ready`);
    const out = fs.openSync(log, 'w');
    let child;
    try {
      // Downloaded to a file and run from there: a download that fails is an error here, not an empty script run.
      child = spawnImpl('/bin/bash', ['-c', 'script=$(mktemp "${TMPDIR:-/tmp}/engelbart-install.XXXXXX") && curl -fsSL --retry 2 --connect-timeout 20 -o "$script" "${ENGELBART_DOWNLOADS}install.sh" && exec /bin/bash "$script"'], {
        detached: true, // it outlives the app, which it replaces
        stdio: ['ignore', out, out],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: env.HOME || os.homedir(), TMPDIR: env.TMPDIR || os.tmpdir(), LANG: 'en_US.UTF-8', ENGELBART_DOWNLOADS: info.downloads, ENGELBART_WAIT_PID: String(process.pid), ENGELBART_APP_PATH: bundleOf(process.execPath), ENGELBART_READY_FILE: ready, ...(env.ENGELBART_NO_OPEN === '1' ? { ENGELBART_NO_OPEN: '1' } : {}) },
      });
    } finally {
      fs.closeSync(out);
    }
    const current = { version, alive: true };
    run = current;
    percent = null;
    set('installing');
    progress(2); // indeterminate, on the Dock icon, until curl draws its first percentage
    const poll = setRepeat(() => {
      if (!fs.existsSync(ready)) {
        const now = lastPercent(log);
        if (now === null || Math.floor(now) === percent) return;
        percent = Math.floor(now);
        progress(percent / 100);
        set('installing');
        return;
      }
      clearRepeat(poll);
      try { fs.unlinkSync(ready); } catch { /* gone */ }
      set('ready');
      progress(-1);
      if (quitWhenReady) void requestQuit({ update: true });
      else void askRestart(version).catch(() => {});
    }, READY_POLL_MS);
    // Whether it still runs, whatever the state: once ready, Restart to Update needs it waiting for the quit.
    child.on('error', (error) => {
      current.alive = false;
      if (run !== current || state !== 'installing') return;
      clearRepeat(poll);
      progress(-1);
      set('idle');
      void ask({ type: 'warning', message: 'Engelbart could not be updated', detail: error.message, buttons: ['OK'] }).catch(() => {});
    });
    child.on('exit', (code) => {
      current.alive = false;
      // Ready: it went on to replace the app, or it was stopped, and Restart to Update runs it again.
      if (run !== current || state !== 'installing') return;
      clearRepeat(poll);
      progress(-1);
      set('idle');
      if (code !== 0) void ask({ type: 'warning', message: `Engelbart ${version} could not be installed`, detail: `${lastLines(log) || `The install command stopped (exit status ${code}).`}\n\nThis version is still installed. The details are in ${log}.`, buttons: ['OK'] }).catch(() => {});
    });
    child.unref();
  }

  /** Ad hoc: the new version is ready and the install command waits for the quit. Later installs it at the next quit. */
  async function askRestart(version) {
    let sessions = 0;
    try { sessions = runningSessions(); } catch { /* none known */ }
    const { response } = await ask({
      type: 'info',
      buttons: ['Restart to Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Engelbart ${version} is ready`,
      detail: sessions > 0
        ? `Restarting ends ${sessions} running terminal session${sessions === 1 ? '' : 's'}, which cannot be recovered. Later, it is installed the next time you quit. Documents are already saved.`
        : 'Engelbart quits and opens again with it. Later, it is installed the next time you quit. Your projects and notes stay as they are.',
      noLink: true,
    });
    if (response === 0) restart();
  }

  /** Restart to Update (the ready dialog, the menu, a window's banner). Ad hoc: the install command waiting for the quit
   * gets it; one that has stopped since runs again, its download shown, and the app quits by itself once it is ready. A
   * run that fails before then says why and goes back to idle, as any does. */
  function restart() {
    if (!info || state !== 'ready') return false;
    if (info.developerId) updater.quitAndInstall();
    else if (run && run.alive) void requestQuit({ update: true });
    else runInstaller((run && run.version) || available, { quitWhenReady: true });
    return true;
  }

  /** Later on a window's banner: every banner hides until the state changes. The menu keeps Restart to Update. */
  function later() {
    if (state === 'ready' && !dismissed) { dismissed = true; notify(); }
    return snapshot();
  }

  async function offer(version, { manual = false } = {}) {
    if (!manual && offered.has(version)) return;
    offered.add(version);
    const developerId = info.developerId;
    const { response } = await ask({
      type: 'info',
      buttons: developerId ? ['Restart Now', 'Later'] : ['Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: developerId ? `Engelbart ${version} is ready` : `Engelbart ${version} is available`,
      detail: developerId
        ? 'Restart to finish updating, or it will be installed the next time you quit. Your projects and notes stay as they are.'
        : `You have ${app.getVersion()}. Engelbart downloads the new version, then quits and opens again with it. Your projects and notes stay as they are.`,
      noLink: true,
    });
    if (response !== 0) return;
    if (developerId) { set('ready'); updater.quitAndInstall(); } else runInstaller(version);
  }

  function ensureUpdater() {
    if (updater) return updater;
    updater = loadUpdater();
    updater.autoDownload = info.developerId;
    updater.autoInstallOnAppQuit = info.developerId;
    updater.on('update-available', (found) => {
      available = found.version;
      if (!info.developerId && !manualCheck) void offer(found.version).catch(() => {});
    });
    updater.on('update-downloaded', (found) => { available = found.version; set('ready'); void offer(found.version).catch(() => {}); });
    updater.on('error', (error) => console.warn(`[engelbart] update check: ${error && error.message}`));
    return updater;
  }

  /** `manual`: from the menu, which says what it found either way. */
  async function check({ manual = false } = {}) {
    if (!info || state !== 'idle') return snapshot();
    set('checking');
    manualCheck = manual;
    try {
      const result = await ensureUpdater().checkForUpdates();
      const newer = result && result.isUpdateAvailable ? result.updateInfo.version : null;
      manualCheck = false;
      if (state === 'checking') set('idle'); // an offer taken meanwhile has moved it on
      if (manual && !newer) await ask({ type: 'info', message: `Engelbart ${app.getVersion()} is the newest version.`, buttons: ['OK'] });
      else if (manual && newer && info.developerId) await ask({ type: 'info', message: `Engelbart ${newer} is downloading.`, detail: 'You will be asked to restart when it is ready.', buttons: ['OK'] });
      else if (manual && newer) await offer(newer, { manual: true });
    } catch (error) {
      manualCheck = false;
      if (state === 'checking') set('idle');
      if (manual) await ask({ type: 'warning', message: 'Engelbart could not check for updates', detail: String(error && error.message ? error.message : error).split('\n')[0], buttons: ['OK'] });
    }
    return snapshot();
  }

  function start() {
    if (!info) return false;
    setTimer(() => { void check().catch(() => {}); }, FIRST_CHECK_MS);
    const every = setRepeat(() => { void check().catch(() => {}); }, EVERY_MS);
    if (every && every.unref) every.unref();
    return true;
  }

  /** The app menu's item, by state. */
  function menuItem() {
    if (state === 'ready') return { label: 'Restart to Update', click: () => { restart(); } };
    if (state === 'installing') return { label: percent === null ? 'Downloading Update…' : `Downloading Update… ${percent}%`, enabled: false };
    if (state === 'checking') return { label: 'Checking for Updates…', enabled: false };
    return { label: 'Check for Updates…', click: () => { void check({ manual: true }).catch(() => {}); } };
  }

  return { start, check, snapshot, menuItem, restart, later, enabled: !!info };
}

module.exports = { createUpdates, releaseInfo, bundleOf, lastPercent };
