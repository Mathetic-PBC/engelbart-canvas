'use strict';

// The Engelbart home: ~/.engelbart. Everything the app writes lives under it.
// In test mode the data root is ~/.engelbart/test (spec §2 #1–2).

const fs = require('node:fs');
const path = require('node:path');

const DIR_MODE = 0o700;
const MAX_NAME = 120;

function ensureHome(homeDir) {
  if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir)) {
    throw new TypeError('homeDir must be an absolute path');
  }
  const root = path.join(homeDir, '.engelbart');
  const testRoot = path.join(root, 'test');
  fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  fs.mkdirSync(testRoot, { recursive: true, mode: DIR_MODE });
  fs.mkdirSync(path.join(testRoot, 'annotations'), { recursive: true, mode: DIR_MODE });
  const configFile = path.join(root, 'config.json');
  if (!fs.existsSync(configFile)) writeConfig(root, {});
  else {
    // A config written before a setting existed gains it, so every switch is there to be edited.
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { onDisk = null; }
    if (!onDisk || typeof onDisk !== 'object' || !onDisk.summarizer) writeConfig(root, {});
  }
  return { root, testRoot, configFile };
}

// Which model writes the catalog summaries (src/main/context). Both providers are the CLIs the
// terminal already offers, run hidden and signed in with your subscription, never an API key:
//   "openai"    → Codex CLI        "anthropic" → Claude Code CLI
// Change `provider` to switch; each provider keeps its own model and effort. The file is read
// again for every summary, so an edit takes effect without a restart.
const SUMMARIZER_DEFAULTS = Object.freeze({
  provider: 'openai',
  openai: Object.freeze({ model: 'gpt-5.6-luna', effort: 'high' }),
  anthropic: Object.freeze({ model: 'claude-opus-5', effort: 'high' }),
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

function normalizeConfig(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    testMode: typeof input.testMode === 'boolean' ? input.testMode : true,
    summarizer: normalizeSummarizer(input.summarizer),
  };
}

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
    if (key !== 'testMode' && key !== 'summarizer') throw new TypeError(`Unsupported config key: ${key}`);
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

// A display name → a filesystem-safe directory or file stem. Keeps spaces and
// unicode; drops path separators, control characters and leading dots.
function sanitizeName(name) {
  let value = typeof name === 'string' ? name : '';
  value = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:]/g, '')
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

module.exports = { SUMMARIZER_DEFAULTS, normalizeSummarizer, ensureHome, normalizeConfig, readConfig, writeConfig, sanitizeName, slugify, uniqueName, readJson, writeJson, DIR_MODE };
