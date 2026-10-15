'use strict';

// Whether macOS already lets Engelbart read the folders it guards (Desktop, Documents, Downloads, iCloud Drive). Nothing
// asks for that any more (2026-10-15, Hudson: "Get rid of this and ANY mentions of full disk access, as well as that weird
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

/** → { status() → { platform, granted } } */
function createDiskAccess({ homeDir = os.homedir(), platform = process.platform, fake = process.env.ENGELBART_DISK_ACCESS || '' } = {}) {
  async function status() {
    if (platform !== 'darwin') return { platform, granted: true };
    const here = fake ? fake === 'granted' : canReadHere(homeDir);
    return { platform, granted: here === true };
  }
  return { status };
}

module.exports = { createDiskAccess, canReadHere, probeFile };
