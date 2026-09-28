'use strict';

// Test mode (~/.engelbart/test, the Test pill and its ⚙) is for developing Engelbart, never for the app people download
// (2026-09-28). A copy has it when it runs from a checkout (`npm start`, `electron .`: not packaged, so nobody downloaded
// it) or when it was packaged from a developer build: `npm run relaunch` builds with ENGELBART_DEVELOPER=1, and
// scripts/build.mjs then writes dist/build.json { "developer": true }. Every other package, which is what ships, has
// none: it uses ~/.engelbart whatever config.json says, and nothing in the app switches or resets test data.
// ENGELBART_TEST_MODE=off takes it away from a developer's copy too, to see the app as it ships (`npm run new-mac`);
// nothing turns it on in a package that has none.

const fs = require('node:fs');
const path = require('node:path');

const BUILD_FILE = 'build.json';

/** Whether this copy of Engelbart has test mode. `packaged`: app.isPackaged; `distDir`: the renderer build (dist/);
 *  `env`: process.env. A package whose dist/build.json is missing or unreadable has none. */
function hasTestMode({ packaged, distDir, env = {} }) {
  if (env.ENGELBART_TEST_MODE === 'off') return false;
  if (!packaged) return true;
  try {
    return JSON.parse(fs.readFileSync(path.join(distDir, BUILD_FILE), 'utf8')).developer === true;
  } catch {
    return false;
  }
}

module.exports = { BUILD_FILE, hasTestMode };
