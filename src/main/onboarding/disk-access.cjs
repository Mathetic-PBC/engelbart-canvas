'use strict';

// Full Disk Access (2026-10-13, the "Onboarding" workspace). Hudson: "i really dont like there being four popups" and
// "we want bart to be able to see everything that the user has saved", so one permission instead of macOS's four folder
// prompts (Desktop, Documents, Downloads, iCloud Drive). macOS has no prompt for it: the person turns Engelbart on in
// System Settings ▸ Privacy & Security ▸ Full Disk Access. So that they do not get lost there (Granola's way), Engelbart:
//   1. reads a protected file first (`register`), so it is in that list when Settings opens;
//   2. opens Settings on that page (`open`: x-apple.systempreferences:…?Privacy_AllFiles);
//   3. shows a small window of its own beside it, always on top (`helper`, ./disk-helper.html). Round 3 (2026-10-13): only
//      "Toggle Setting" and a thick arrow toward Settings ("there is way too much text and like nothing is in the right
//      location"), docked against the Settings window itself (its frame read from the window list, which needs no
//      permission; `settingsFrame`). Where Settings' own switch is can't be read without Accessibility access, which
//      would be another prompt, so the arrow points at the window, not the switch (the review mockup's simulated
//      Settings guide was left out: Hudson, "that requires some pretty advanced and tricky engineering");
//   4. watches for the grant (`watch`) from a new process every 1.5 s (the running app keeps the access it started with;
//      a process started after the switch is turned on has it), then relaunches itself (`relaunch`) so the running app
//      has it too, onboarding coming back where it was (./prefs.cjs flow).
// The app named in that list is the bundle Engelbart runs as: "Engelbart", or "Electron" in a copy run from a checkout.
// ENGELBART_DISK_ACCESS ('granted' | 'denied') stands in for this Mac in scripted runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const WATCH_MS = 1500;
const WATCH_FOR_MS = 15 * 60_000;
const HELPER = { width: 330, height: 150 };
const GAP = 4;
// System Settings' window frame (CoreGraphics' window list, through JavaScript for Automation: no prompt), as the points
// Electron's screen uses → '[{"x":…,"y":…,"width":…,"height":…}]'.
const SETTINGS_FRAME_JXA = "ObjC.import('CoreGraphics');ObjC.import('Foundation');const l=ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,0));const o=[];for(let i=0;i<l.count;i++){const w=l.objectAtIndex(i);if(ObjC.unwrap(w.objectForKey('kCGWindowOwnerName'))!=='System Settings'||ObjC.unwrap(w.objectForKey('kCGWindowLayer'))!==0)continue;const b=w.objectForKey('kCGWindowBounds');o.push({x:ObjC.unwrap(b.objectForKey('X')),y:ObjC.unwrap(b.objectForKey('Y')),width:ObjC.unwrap(b.objectForKey('Width')),height:ObjC.unwrap(b.objectForKey('Height'))});}JSON.stringify(o);";

/** A file only Full Disk Access lets an app read (the per-user privacy database). */
const probeFile = (homeDir) => path.join(homeDir, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');

/** Whether this process may read it → true | false | null (no such file: unknown). */
function canReadHere(homeDir) {
  try { fs.closeSync(fs.openSync(probeFile(homeDir), 'r')); return true; } catch (error) { return error && error.code === 'ENOENT' ? null : false; }
}

/** The .app bundle Engelbart runs as → its name ("Engelbart", "Electron"), as System Settings lists it. */
function bundleName(execPath = process.execPath) {
  const match = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(execPath);
  return match ? match[1] : 'Engelbart';
}

/**
 * `BrowserWindow`, `screen`, `shell` (Electron's, or fakes); `homeDir`; `requestQuit({ update, relaunch })` the app's own quit,
 * which opens it again once it has quit; `notify(status)` to the windows; `preload` the helper's preload; `iconPath` the app icon.
 * → { status, register, open, helper, closeHelper, watch, stopWatching, relaunch }
 */
function createDiskAccess({ BrowserWindow = null, screen = null, shell = null, homeDir = os.homedir(), requestQuit = async () => false, notify = () => {}, preload = path.join(__dirname, 'disk-helper-preload.cjs'), page = path.join(__dirname, 'disk-helper.html'), iconPath = '', run = execFile, execPath = process.execPath, fake = process.env.ENGELBART_DISK_ACCESS || '', platform = process.platform }) {
  let helperWindow = null;
  let timer = null;
  let started = 0;
  let granted = null; // eslint-disable-line no-unused-vars
  let fakeGranted = fake === 'granted';
  let grantSeen = false; // the switch was turned on, and the relaunch it needs has not happened yet
  let ticks = 0;

  /** System Settings' largest window → { x, y, width, height } | null (not open, or not on screen). */
  function settingsFrame() {
    if (fake || platform !== 'darwin') return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        run('osascript', ['-l', 'JavaScript', '-e', SETTINGS_FRAME_JXA], { timeout: 4000 }, (error, stdout) => {
          if (error) { resolve(null); return; }
          let frames = [];
          try { frames = JSON.parse(String(stdout || '[]').trim() || '[]'); } catch { frames = []; }
          frames = frames.filter((frame) => frame && frame.width > 200 && frame.height > 200).sort((a, b) => b.width * b.height - a.width * a.height);
          resolve(frames[0] || null);
        });
      } catch { resolve(null); }
    });
  }

  /** Where the helper goes: against Settings' right edge (its arrow pointing left), else its left edge, else the screen's right. */
  function placement(frame) {
    let area = null;
    try { area = (frame ? screen.getDisplayNearestPoint({ x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) }) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea; } catch { area = null; }
    if (!frame || !area) return area ? { x: Math.round(area.x + area.width - HELPER.width - 28), y: Math.round(area.y + (area.height - HELPER.height) / 2), side: 'left' } : { side: 'left' };
    const y = Math.round(Math.min(Math.max(frame.y + frame.height * 0.42 - HELPER.height / 2, area.y), area.y + area.height - HELPER.height));
    if (frame.x + frame.width + GAP + HELPER.width <= area.x + area.width) return { x: Math.round(frame.x + frame.width + GAP), y, side: 'left' };
    if (frame.x - GAP - HELPER.width >= area.x) return { x: Math.round(frame.x - GAP - HELPER.width), y, side: 'right' };
    return { x: Math.round(area.x + area.width - HELPER.width - 12), y, side: 'left' };
  }

  /** The helper moved against Settings again (it may have opened late, or been moved). */
  async function dock() {
    if (!helperWindow || helperWindow.isDestroyed()) return;
    const spot = placement(await settingsFrame());
    if (!helperWindow || helperWindow.isDestroyed()) return;
    if (Number.isFinite(spot.x) && Number.isFinite(spot.y)) { try { helperWindow.setPosition(spot.x, spot.y); } catch { /* gone */ } }
    helperWindow.webContents.send('disk-helper:state', helperState({ side: spot.side }));
  }

  /** A new process's answer (it has a grant the running app does not have yet) → Promise<boolean|null>. */
  function canReadFresh() {
    if (fake) return Promise.resolve(fakeGranted);
    return new Promise((resolve) => {
      const script = `try{require('fs').closeSync(require('fs').openSync(${JSON.stringify(probeFile(homeDir))},'r'));process.exit(0)}catch(e){process.exit(e&&e.code==='ENOENT'?3:2)}`;
      try {
        run(execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 8000 }, (error) => {
          if (!error) resolve(true);
          else resolve(error.code === 3 ? null : false);
        });
      } catch { resolve(null); }
    });
  }

  /** → { platform, granted (this process), grantedFresh (a new process), app, needsRelaunch } */
  async function status() {
    if (platform !== 'darwin') return { platform, granted: true, grantedFresh: true, app: bundleName(execPath), needsRelaunch: false };
    const here = fake ? fakeGranted : canReadHere(homeDir);
    const fresh = here === true ? true : await canReadFresh();
    granted = here;
    return { platform, granted: here === true, grantedFresh: fresh === true, unknown: here === null && fresh === null, app: bundleName(execPath), needsRelaunch: !fake && here !== true && fresh === true };
  }

  /** A protected read, so macOS lists Engelbart under Full Disk Access before Settings opens. */
  function register() {
    if (platform !== 'darwin' || fake) return;
    canReadHere(homeDir);
    try { fs.readdirSync(path.join(homeDir, 'Library', 'Mail')); } catch { /* refused, and noted by macOS */ }
  }

  function helperState(extra = {}) {
    return { app: bundleName(execPath), icon: iconPath && fs.existsSync(iconPath) ? `file://${iconPath}` : '', ...extra };
  }

  /** The helper against System Settings (dock), always on top, never taking the keyboard. */
  function helper(extra = {}) {
    if (!BrowserWindow || platform !== 'darwin') return false;
    if (helperWindow && !helperWindow.isDestroyed()) { helperWindow.webContents.send('disk-helper:state', helperState(extra)); helperWindow.showInactive(); void dock(); return true; }
    const { x, y } = placement(null);
    helperWindow = new BrowserWindow({
      width: HELPER.width, height: HELPER.height, x, y, frame: false, resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: true, transparent: true, backgroundColor: '#00000000', title: 'Full Disk Access',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    helperWindow.setAlwaysOnTop(true, 'floating');
    helperWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    helperWindow.loadFile(page).catch(() => {});
    helperWindow.webContents.once('did-finish-load', () => { if (helperWindow && !helperWindow.isDestroyed()) { helperWindow.webContents.send('disk-helper:state', helperState(extra)); void dock().then(() => { if (helperWindow && !helperWindow.isDestroyed()) helperWindow.showInactive(); }); } });
    helperWindow.on('closed', () => { helperWindow = null; });
    // Settings takes a moment to open (seconds, cold): docked again as soon as its window is there.
    for (const ms of [600, 1500, 3000, 5000]) setTimeout(() => { void dock(); }, ms);
    return true;
  }

  function closeHelper() {
    if (helperWindow && !helperWindow.isDestroyed()) helperWindow.close();
    helperWindow = null;
  }

  /** Settings on the Full Disk Access page, the helper beside it, and the watch for the switch. */
  async function open() {
    register();
    if (fake) { setTimeout(() => { fakeGranted = true; }, 2500); }
    else if (shell) await shell.openExternal(SETTINGS_URL).catch(() => {});
    helper();
    watch();
    return status();
  }

  /** Every WATCH_MS, a new process asks: once it may read, the windows are told (and the helper says so). */
  function watch() {
    if (timer) return;
    started = Date.now();
    const tick = async () => {
      timer = null;
      const out = await status();
      if (out.granted || out.grantedFresh) {
        grantSeen = !!out.needsRelaunch;
        // Gone at once: the window comes back in front of Settings on the same step (round 3: "popups go everywhere").
        closeHelper();
        notify({ ...out, done: true });
        return;
      }
      ticks += 1;
      if (ticks % 2 === 0) void dock();
      if (Date.now() - started > WATCH_FOR_MS) { notify({ ...out, done: false, gaveUp: true }); return; }
      timer = setTimeout(tick, WATCH_MS);
    };
    timer = setTimeout(tick, WATCH_MS);
  }

  function stopWatching() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /**
   * Whether a quit now is the one Full Disk Access needs (round 3: macOS's "Quit & Reopen" did nothing): the switch is
   * being waited for, or was turned on and this process can't read yet. index.cjs's before-quit then quits at once and
   * opens Engelbart again on the same step.
   */
  function waiting() {
    return !!timer || !!(helperWindow && !helperWindow.isDestroyed()) || grantSeen;
  }

  /**
   * The app reopened so it has the access too ("Restarting Engelbart to finish setup…"); onboarding comes back where it
   * was. `confirm`: terminal sessions may be running (over a workspace), so the quit asks about them as any quit does;
   * cancelled, nothing is relaunched.
   */
  async function relaunch({ confirm = false } = {}) {
    stopWatching();
    closeHelper();
    if (fake) { notify({ platform, granted: true, grantedFresh: true, app: bundleName(execPath), needsRelaunch: false, done: true, relaunched: true }); return true; }
    return requestQuit({ update: !confirm, relaunch: true });
  }

  /** What the helper's buttons do: 'missing' (Engelbart is not listed), 'fallback' (folder by folder), 'close'. */
  function helperAction(action) {
    if (action === 'close') { closeHelper(); stopWatching(); notify({ cancelled: true }); return true; }
    if (action === 'fallback') { closeHelper(); stopWatching(); notify({ fallback: true }); return true; }
    if (action === 'open') { if (shell && !fake) void shell.openExternal(SETTINGS_URL).catch(() => {}); return true; }
    return false;
  }

  return { status, register, open, helper, closeHelper, watch, stopWatching, relaunch, helperAction, waiting, settingsFrame, placement, SETTINGS_URL };
}

module.exports = { createDiskAccess, bundleName, canReadHere, probeFile, SETTINGS_URL };
