'use strict';

// Import your context's remembered answers (2026-10-13), one file per data root: <dataRoot>/.connect/onboarding.json.
//   provider   'anthropic' | 'openai': the provider picked when both had a subscription, so it is not asked again
//   browser    the browser whose sign-ins Engelbart uses (an id of shared/import-flow.cjs BROWSERS), when the person chose
//              one other than their default ("Use another browser")
//   keychain   'allowed' | 'declined': the answer to "Allow Engelbart to use your <browser> sign-ins?"
//   browserAgents  'allowed' | 'declined': the answer to "Let agents use your browser?" (./browser-agents.cjs), asked
//              only when the person's Claude Code or Codex does not already let its agents drive their browser
//   flow       where onboarding was (its screen and answers), so a relaunch (Full Disk Access needs one) comes back to it
// Ids and short words only: never a cookie, a path the person did not pick, or anything an account holds.

const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER_IDS, browserById } = require('../../shared/import-flow.cjs');

const FILE = 'onboarding.json';
const MAX_FLOW_BYTES = 200_000;

const fileOf = (dataRoot) => path.join(dataRoot, '.connect', FILE);

function read(dataRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(fileOf(dataRoot), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function clean(value) {
  const out = {};
  if (PROVIDER_IDS.includes(value.provider)) out.provider = value.provider;
  if (browserById(value.browser)) out.browser = value.browser;
  if (value.keychain === 'allowed' || value.keychain === 'declined') out.keychain = value.keychain;
  if (value.browserAgents === 'allowed' || value.browserAgents === 'declined') out.browserAgents = value.browserAgents;
  if (value.flow && typeof value.flow === 'object' && JSON.stringify(value.flow).length <= MAX_FLOW_BYTES) out.flow = value.flow;
  return out;
}

/** What is remembered → { provider?, browser?, keychain?, browserAgents?, flow? } */
function get(dataRoot) {
  return clean(read(dataRoot));
}

/** Remember `patch` (null removes a key) → what is remembered now. */
function set(dataRoot, patch) {
  const next = { ...read(dataRoot) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const kept = clean(next);
  fs.mkdirSync(path.dirname(fileOf(dataRoot)), { recursive: true, mode: 0o700 });
  const temp = `${fileOf(dataRoot)}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, fileOf(dataRoot));
  return kept;
}

module.exports = { get, set, FILE };
