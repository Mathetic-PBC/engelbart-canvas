'use strict';

// Engelbart's own Git (2026-09-28): dugite-native's build of Git, the one GitHub Desktop ships, inside the app at
// Contents/Resources/git, or in a checkout at vendor/git/darwin-<arch> (both put there by scripts/fetch-git.mjs).
// It stands in when the person has no Git of their own that works (./detect.cjs): on a Mac without Apple's developer
// tools /usr/bin/git is a stub that opens Apple's installer, which can take the better part of an hour. It is run
// through its launcher, engelbart-bin/git, which tells it where its helpers and templates are; while it stands in,
// that folder goes first on PATH for everything Engelbart starts (../terminal/launch.cjs, ENGELBART_GIT_BIN), so
// Claude Code and Codex find it and never reach Apple's stub. A person's own Git, once they have one, is used instead.

const fs = require('node:fs');
const path = require('node:path');

const LAUNCHER = path.join('engelbart-bin', 'git');

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The launcher of the Git that came with Engelbart, or null. `resourcesPath`: the packaged app's Resources folder;
 * `appRoot`: the checkout (`npm start`); `override`: ENGELBART_BUNDLED_GIT, a folder laid out the same way (tests).
 */
function findBundledGit({ resourcesPath = process.resourcesPath, appRoot = path.join(__dirname, '..', '..', '..'), arch = process.arch, platform = process.platform, override = process.env.ENGELBART_BUNDLED_GIT } = {}) {
  if (platform !== 'darwin' && !override) return null;
  const folders = override ? [override] : [resourcesPath && path.join(resourcesPath, 'git'), path.join(appRoot, 'vendor', 'git', `darwin-${arch}`)];
  for (const folder of folders.filter(Boolean)) {
    const launcher = path.join(folder, LAUNCHER);
    if (isExecutable(launcher)) return launcher;
  }
  return null;
}

module.exports = { findBundledGit, LAUNCHER };
