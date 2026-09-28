'use strict';

// The Engelbart home: ~/.engelbart. Everything the app writes lives under it.
// In test mode the data root is ~/.engelbart/test (spec §2 #1–2); only a developer's copy has test mode (../developer.cjs).

const fs = require('node:fs');
const path = require('node:path');
const { carryDefaults } = require('./defaults.cjs');
const { normalizeTools } = require('../tools/record.cjs');

const DIR_MODE = 0o700;
const MAX_NAME = 120;

// `rootDir` (ENGELBART_ROOT_DIR, `npm run new-mac` only) puts the Engelbart home somewhere else while the person's home
// directory stays theirs: a second copy of the app runs beside the first on data of its own.
// `test`: false in a copy without test mode, which never makes ~/.engelbart/test (one already there is left alone).
function ensureHome(homeDir, rootDir = null, { test = true } = {}) {
  if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir)) {
    throw new TypeError('homeDir must be an absolute path');
  }
  if (rootDir != null && (typeof rootDir !== 'string' || !path.isAbsolute(rootDir))) throw new TypeError('rootDir must be an absolute path');
  const root = rootDir || path.join(homeDir, '.engelbart');
  const testRoot = path.join(root, 'test');
  fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  if (test) {
    fs.mkdirSync(testRoot, { recursive: true, mode: DIR_MODE });
    fs.mkdirSync(path.join(testRoot, 'annotations'), { recursive: true, mode: DIR_MODE });
  }
  const configFile = path.join(root, 'config.json');
  // Every setting is in the file to be edited, and a default changed by a later build reaches it
  // wherever the person left that setting alone (./defaults.cjs). A file that does not parse is left
  // for its editor to finish; the settings read from it are the defaults until then.
  carryDefaults({ file: configFile, defaults: normalizeConfig({}), past: PAST_CONFIG_DEFAULTS, normalize: normalizeConfig, fillMissing: true, backupDir: path.join(root, '.backups') });
  return { root, testRoot, configFile };
}

// Which model writes the catalog summaries (src/main/context). Both providers are the CLIs the
// terminal already offers, run hidden and signed in with your subscription, never an API key:
//   "openai"    → Codex CLI        "anthropic" → Claude Code CLI
// Change `provider` to switch; each provider keeps its own model and effort. The file is read
// again for every summary, so an edit takes effect without a restart.
const SUMMARIZER_DEFAULTS = Object.freeze({
  provider: 'openai',
  openai: Object.freeze({ model: 'gpt-6-luna', effort: 'high' }),
  anthropic: Object.freeze({ model: 'claude-opus-5-5', effort: 'high' }),
});
const PROVIDER_ALIASES = { openai: 'openai', codex: 'openai', anthropic: 'anthropic', claude: 'anthropic' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function normalizeSummarizer(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { provider: PROVIDER_ALIASES[String(input.provider || '').toLowerCase()] || SUMMARIZER_DEFAULTS.provider };
  for (const name of ['openai', 'anthropic']) {
    const given = input[name] && typeof input[name] === 'object' ? input[name] : {};
    out[name] = {
      model: typeof given.model === 'string' && MODEL_RE.test(given.model) ? given.model : SUMMARIZER_DEFAULTS[name].model,
      effort: EFFORTS.includes(given.effort) ? given.effort : SUMMARIZER_DEFAULTS[name].effort,
    };
  }
  return out;
}

// Which providers @bart offers (src/main/bart): its selector lists these and no others, and a flag
// naming a model of one that is not here is not a flag. Take a name out to stop offering it.
const PROVIDERS_DEFAULT = Object.freeze(['openai', 'anthropic']);

function normalizeProviders(value) {
  const named = (Array.isArray(value) ? value : []).map((name) => PROVIDER_ALIASES[String(name || '').toLowerCase()]).filter(Boolean);
  return named.length ? [...new Set(named)] : [...PROVIDERS_DEFAULT];
}

// The GitHub App that "Add from GitHub…" signs in to (src/main/github/connection.cjs; how to make one:
// docs/github-app-setup.md). `clientId` is the App's client id (public: the device flow needs no secret);
// `appSlug` is the last part of the App's page, github.com/apps/<slug>, where it is installed on an account.
// Shared public registration: every install can sign in without creating an App or editing config.
// Each person still authorizes their own access and selects repositories on GitHub.
const GITHUB_DEFAULTS = Object.freeze({ clientId: 'Iv23liAZNYl96zlluMDs', appSlug: 'engelbart-mathetic' });

function normalizeGithub(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clientId = typeof input.clientId === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(input.clientId.trim()) ? input.clientId.trim() : GITHUB_DEFAULTS.clientId;
  const appSlug = typeof input.appSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(input.appSlug.trim()) ? input.appSlug.trim() : GITHUB_DEFAULTS.appSlug;
  return { clientId, appSlug };
}

function normalizeConfig(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    // Off by default (2026-09-28; it was on): a new install starts on ~/.engelbart. A copy without test mode ignores it.
    testMode: typeof input.testMode === 'boolean' ? input.testMode : false,
    providers: normalizeProviders(input.providers),
    summarizer: normalizeSummarizer(input.summarizer),
    github: normalizeGithub(input.github),
    // Git, Claude Code and Codex as the last check saw them, and what the person chose about them (../tools/record.cjs).
    tools: normalizeTools(input.tools),
  };
}

// Every config.json default shipped before defaults were carried forward, oldest first (git history of
// this file). Settings were added: summarizer 09-19, providers 09-21, github 09-23. Keep the old
// summarizer IDs here so installs without a saved defaults base can inherit their replacements.
const PAST_CONFIG_DEFAULTS = (() => {
  const summarizer = {
    provider: 'openai',
    openai: { model: 'gpt-5.6-luna', effort: 'high' },
    anthropic: { model: 'claude-opus-5', effort: 'high' },
  };
  const providers = [...PROVIDERS_DEFAULT];
  const github = { ...GITHUB_DEFAULTS };
  return [
    { testMode: true },
    { testMode: true, summarizer },
    { testMode: true, providers, summarizer },
    { testMode: true, providers, summarizer, github },
  ];
})();

function readConfig(root) {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')));
  } catch {
    return normalizeConfig({});
  }
}

function writeConfig(root, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Config update must be an object');
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'testMode' && key !== 'summarizer' && key !== 'providers' && key !== 'github' && key !== 'tools') throw new TypeError(`Unsupported config key: ${key}`);
  }
  if (Object.hasOwn(patch, 'testMode') && typeof patch.testMode !== 'boolean') {
    throw new TypeError('testMode must be a boolean');
  }
  const next = normalizeConfig({ ...readConfig(root), ...patch });
  const file = path.join(root, 'config.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return next;
}

/**
 * The tool check's record, written into config.json only while the file parses: a background check
 * must never overwrite a file someone is halfway through editing. → the config written, or null.
 */
function writeTools(root, tools) {
  const file = path.join(root, 'config.json');
  let onDisk;
  try { onDisk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!onDisk || typeof onDisk !== 'object' || Array.isArray(onDisk)) return null;
  return writeConfig(root, { tools });
}

// A display name → a filesystem-safe directory or file stem. Keeps spaces and
// unicode; slashes become hyphens; drops colons, control characters and leading dots.
function sanitizeName(name) {
  let value = typeof name === 'string' ? name : '';
  value = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/:/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (value.length > MAX_NAME) value = value.slice(0, MAX_NAME).trim();
  return value || 'Untitled';
}

// A directory name the way the create screen shows it after "./": lower-case, dashes.
function slugify(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// 'Goal', then 'Goal 2', 'Goal 3' … until no entry with that name (+ext) exists.
function uniqueName(parentDir, base, ext = '') {
  let candidate = base;
  let counter = 2;
  while (fs.existsSync(path.join(parentDir, candidate + ext))) {
    candidate = `${base} ${counter}`;
    counter += 1;
  }
  return candidate;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

module.exports = { SUMMARIZER_DEFAULTS, GITHUB_DEFAULTS, PAST_CONFIG_DEFAULTS, normalizeGithub, normalizeSummarizer, ensureHome, normalizeConfig, readConfig, writeConfig, writeTools, sanitizeName, slugify, uniqueName, readJson, writeJson, DIR_MODE };
