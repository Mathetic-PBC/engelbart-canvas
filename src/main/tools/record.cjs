'use strict';

// config.json → `tools` (2026-09-23; design D5): what the last check saw of Git, Claude Code and Codex,
// and the person's own choices about them. Observed fields are rewritten by every check and never
// trusted between checks; `requires` always comes from ./requirements.cjs; `skip`, `pin` and
// `tools.updates` belong to the person.

const path = require('node:path');
const { TOOL_NAMES, AGENTS, requiresText } = require('./requirements.cjs');
const { isVersion } = require('./version.cjs');

const STATUSES = Object.freeze(['unknown', 'checking', 'ready', 'missing', 'outdated', 'incompatible', 'signed-out', 'installing', 'updating', 'signing-in', 'failed']);
// Where a program came from, which decides how it is updated and whether an update can be undone.
// `bundled`: the Git that came with Engelbart (./bundled-git.cjs), updated with the app.
const SOURCES = Object.freeze(['apple', 'homebrew', 'bundled', 'native', 'standalone', 'npm', 'bun', 'other']);
const UPDATES = Object.freeze(['auto', 'ask']);
const MAX_ERROR = 300;

function blankTool(name) {
  return {
    installed: false,
    version: null,
    requires: requiresText(name),
    status: 'unknown',
    ...(AGENTS.includes(name) ? { signedIn: null, account: null } : {}),
    path: null,
    onPath: null,
    source: null,
    untested: false,
    updaterOff: false,
    checkedAt: null,
    error: null,
    note: null,
    failedUpdate: null,
    skip: false,
    pin: null,
  };
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const oneLine = (value) => (typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR) : null);
const isoTime = (value) => (typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null);

function normalizeTool(name, value) {
  const input = isObject(value) ? value : {};
  const out = blankTool(name);
  if (typeof input.installed === 'boolean') out.installed = input.installed;
  if (isVersion(input.version)) out.version = input.version;
  if (STATUSES.includes(input.status)) out.status = input.status;
  if (AGENTS.includes(name) && (input.signedIn === true || input.signedIn === false)) out.signedIn = input.signedIn;
  // Who is signed in (an email address, ../tools/detect.cjs), only while signed in.
  if (AGENTS.includes(name) && out.signedIn === true && typeof input.account === 'string' && /^\S{1,254}$/.test(input.account)) out.account = input.account;
  if (typeof input.path === 'string' && input.path.length <= 4096 && path.isAbsolute(input.path) && !input.path.includes('\0')) out.path = input.path;
  if (typeof input.onPath === 'boolean') out.onPath = input.onPath;
  if (SOURCES.includes(input.source)) out.source = input.source;
  out.untested = input.untested === true;
  out.updaterOff = input.updaterOff === true;
  out.checkedAt = isoTime(input.checkedAt);
  out.error = oneLine(input.error);
  out.note = oneLine(input.note);
  if (isObject(input.failedUpdate) && isVersion(input.failedUpdate.from) && isoTime(input.failedUpdate.at)) out.failedUpdate = { from: input.failedUpdate.from, at: input.failedUpdate.at };
  out.skip = input.skip === true;
  if (isVersion(input.pin)) out.pin = input.pin;
  return out;
}

function normalizeTools(value) {
  const input = isObject(value) ? value : {};
  return {
    updates: UPDATES.includes(input.updates) ? input.updates : 'auto',
    ...Object.fromEntries(TOOL_NAMES.map((name) => [name, normalizeTool(name, input[name])])),
  };
}

module.exports = { STATUSES, SOURCES, UPDATES, blankTool, normalizeTool, normalizeTools };
