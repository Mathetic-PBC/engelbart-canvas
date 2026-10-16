'use strict';

// Whether macOS already lets Engelbart read the folders it guards (Desktop, Documents, Downloads, iCloud Drive). Nothing in
// the folders' flow asks for that any more (2026-10-15, Hudson: "Get rid of this and ANY mentions of full disk access, as well as that weird
// toggle setting popup"): the import asks for the folders themselves, in one popup ("Allow Engelbart to organize your
// research", ../../renderer/import/ImportFlow.jsx). When the person granted it on their own, the folder guard counts
// those folders as allowed and that popup is not needed. ENGELBART_DISK_ACCESS ('granted' | 'denied') stands in for this
// Mac in scripted runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const probeFile = (homeDir) => path.join(homeDir, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');

/** Whether this process may read it → true | false | null (no such file: unknown). */
function canReadHere(homeDir) {
  try { fs.closeSync(fs.openSync(probeFile(homeDir), 'r')); return true; } catch (error) { return error && error.code === 'ENOENT' ? null : false; }
}

// Safari brings it back for one purpose (2026-10-16, S9, C1): Safari's sign-ins are in a file only Full Disk Access reads.
// "Grant disk access" opens System Settings ▸ Privacy & Security ▸ Full Disk Access, nothing else: no guide window, no
// helper popup (Hudson: "ensure there is no weird popup like there used to be to guide them with full disk access!").
const FULL_DISK_ACCESS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/**
 * → { status() → { platform, granted }, open() → { opened } }. `run(file, args, callback)` runs `open` (execFile; a fake
 * in tests).
 */
function createDiskAccess({ homeDir = os.homedir(), platform = process.platform, fake = process.env.ENGELBART_DISK_ACCESS || '', run = null } = {}) {
  async function status() {
    if (platform !== 'darwin') return { platform, granted: true };
    const here = fake ? fake === 'granted' : canReadHere(homeDir);
    return { platform, granted: here === true };
  }
  /** System Settings opened on the Full Disk Access list → { opened } (false off the Mac, or when `open` failed). */
  function open() {
    if (platform !== 'darwin') return Promise.resolve({ opened: false });
    const exec = run || require('node:child_process').execFile;
    return new Promise((resolve) => {
      try { exec('/usr/bin/open', [FULL_DISK_ACCESS_PANE], { timeout: 10_000 }, (error) => resolve({ opened: !error })); } catch { resolve({ opened: false }); }
    });
  }
  return { status, open };
}

module.exports = { createDiskAccess, canReadHere, probeFile, FULL_DISK_ACCESS_PANE };
