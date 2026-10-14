'use strict';

// The scanner process (2026-10-13, onboarding lag: "I often see the Mac spinner for like a second between screens").
// What Connect and onboarding read from this Mac before anything is picked — the apps here (scan.detect), the
// repositories the Claude Code and Codex sessions ran in (scan.localRepos), the recent-projects digest — reads every
// session file synchronously: 1.4 s for Claude Code, 3.9 s for the repositories, 5.4 s for the digest on Hudson's Mac.
// On Electron's main process that froze every window (the beachball between screens). It runs here instead, in an
// Electron utility process (./offthread.cjs forks it), and answers one message per job. The session lists are kept for a
// minute, so the detect → digest → tool evidence of one onboarding reads them once.

const readers = require('./readers.cjs');
const scan = require('./scan.cjs');
const folderAccess = require('./folder-access.cjs');
const { projectDigest } = require('../onboarding/digest.cjs');

const KEEP_MS = 60_000;
const kept = new Map();
const localChats = readers.localChats;
readers.localChats = (app, options = {}) => {
  const key = JSON.stringify([app, { ...options, env: undefined }]);
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
  const value = localChats(app, options);
  kept.set(key, { at: Date.now(), value });
  return value;
};

/** The folder guard rebuilt from what main sent (the answers it holds, so a Full Disk Access grant counts). */
const accessOf = (homeDir, spec) => (spec ? folderAccess.guard({ homeDir, dataRoot: spec.dataRoot || null, ...(spec.answers ? { answers: spec.answers } : {}) }) : null);

const JOBS = {
  detect: ({ homeDir, access, zotero = null, github = null, signedIn = [], connectors = {}, applications }) => scan.detect({
    homeDir,
    access: accessOf(homeDir, access),
    zotero: () => zotero,
    github: () => github,
    signedIn,
    connectors: (app) => !!connectors[app],
    ...(applications ? { applications } : {}),
  }),
  localRepos: ({ homeDir, access }) => scan.localRepos({ homeDir, access: accessOf(homeDir, access) }),
  projectDigest: ({ homeDir, access, zoteroRoot = null, existing = [] }) => projectDigest({ homeDir, access: accessOf(homeDir, access), zoteroRoot, existing }),
};

function answer(message) {
  const { id, job, args } = message || {};
  try {
    if (!JOBS[job]) throw new Error(`No scanner job ${job}`);
    return { id, ok: true, value: JOBS[job](args || {}) };
  } catch (error) {
    return { id, ok: false, error: (error && error.message) || String(error) };
  }
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => { process.parentPort.postMessage(answer(event.data)); });
}

module.exports = { answer, JOBS };
