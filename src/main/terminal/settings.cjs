'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

function isDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 4096 || directory.includes('\0')) {
    return false;
  }
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function normalizeSettings(value, home) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    fontSize: Number.isInteger(input.fontSize) && input.fontSize >= MIN_FONT_SIZE && input.fontSize <= MAX_FONT_SIZE
      ? input.fontSize
      : DEFAULT_FONT_SIZE,
    lastCwd: isDirectory(input.lastCwd) ? path.resolve(input.lastCwd) : home,
    sidebarVisible: typeof input.sidebarVisible === 'boolean' ? input.sidebarVisible : true,
  };
}

function mergeSettings(current, patch, home) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Settings update must be an object');
  }
  const supported = new Set(['fontSize', 'lastCwd', 'sidebarVisible']);
  for (const key of Object.keys(patch)) {
    if (!supported.has(key)) throw new TypeError(`Unsupported setting: ${key}`);
  }
  const next = { ...current };
  if (Object.hasOwn(patch, 'fontSize')) {
    if (!Number.isInteger(patch.fontSize) || patch.fontSize < MIN_FONT_SIZE || patch.fontSize > MAX_FONT_SIZE) {
      throw new TypeError(`fontSize must be an integer between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}`);
    }
    next.fontSize = patch.fontSize;
  }
  if (Object.hasOwn(patch, 'lastCwd')) {
    if (!isDirectory(patch.lastCwd)) throw new TypeError('lastCwd must be an existing directory');
    next.lastCwd = path.resolve(patch.lastCwd);
  }
  if (Object.hasOwn(patch, 'sidebarVisible')) {
    if (typeof patch.sidebarVisible !== 'boolean') throw new TypeError('sidebarVisible must be a boolean');
    next.sidebarVisible = patch.sidebarVisible;
  }
  return normalizeSettings(next, home);
}

class SettingsStore {
  constructor(userDataDirectory, home) {
    this.home = home;
    this.file = path.join(userDataDirectory, 'settings.json');
    this.value = this.#read();
  }

  #read() {
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.home);
    } catch {
      return normalizeSettings({}, this.home);
    }
  }

  get() {
    return { ...this.value };
  }

  save(patch) {
    const next = mergeSettings(this.value, patch, this.home);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.value = next;
    return this.get();
  }
}

module.exports = { SettingsStore, mergeSettings, normalizeSettings };
