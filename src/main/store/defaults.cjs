'use strict';

// Defaults that reach existing installs (2026-09-23; design: docs/superpowers/specs/2026-09-23-tools-and-defaults-design.md D1–D3).
//
// Engelbart writes its defaults into the files people edit (config.json, model-effort-inline-question.json),
// so a default written there used to look exactly like a choice, and a later build's default never
// arrived. Each such file now keeps, in <home>/.defaults/, the defaults it was last given: the base.
// At load, a value still equal to the base was left alone and moves to the new default; a value that
// differs is the person's and stays; a key they deleted stays deleted; a key only the new defaults have
// is added; a key the new defaults dropped goes unless they changed it. Arrays are one value each.
// It is the three-way merge dpkg/ucf apply to configuration files on upgrade, with the person winning
// every conflict.
//
// A file written before there were bases gets one rebuilt from every default Engelbart ever shipped
// for it (`past`): a value equal to any of them counts as left alone. Its first rewrite keeps a copy in
// <home>/.backups/. A file that does not parse is never written: the person may be halfway through an edit.

const fs = require('node:fs');
const path = require('node:path');

const isPlain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Same JSON value, whatever the key order. */
function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index]));
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

const valueAt = (object, key) => (isPlain(object) && Object.hasOwn(object, key) ? object[key] : undefined);

/** base: the defaults last given; ours: the file now; theirs: the defaults now. undefined = absent. */
function merge3(base, ours, theirs) {
  if (equal(ours, base)) return theirs;
  if (equal(theirs, base)) return ours;
  if (isPlain(base) && isPlain(ours) && isPlain(theirs)) {
    const out = {};
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
      const merged = merge3(valueAt(base, key), valueAt(ours, key), valueAt(theirs, key));
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }
  return ours;
}

/**
 * The base a file would have had, rebuilt from `versions`: the value at this place in every default ever
 * shipped, oldest first (undefined where one lacked it). Only versions that had the enclosing object are
 * asked about its keys, since a file holding that object was written by one of them.
 */
function rebuildBase(ours, versions) {
  const had = versions.filter((value) => value !== undefined);
  if (!had.length) return undefined;
  if (ours === undefined) return had.length === versions.length ? had[had.length - 1] : undefined;
  if (had.some((value) => equal(value, ours))) return ours;
  const objects = had.filter(isPlain);
  if (isPlain(ours) && objects.length) {
    const out = {};
    for (const key of new Set([...objects.flatMap((value) => Object.keys(value)), ...Object.keys(ours)])) {
      const base = rebuildBase(valueAt(ours, key), objects.map((value) => valueAt(value, key)));
      if (base !== undefined) out[key] = base;
    }
    return out;
  }
  return had[had.length - 1];
}

function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return { missing: error.code === 'ENOENT', value: null }; }
  try { return { missing: false, value: JSON.parse(text) }; } catch { return { missing: false, value: null, broken: true }; }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Where a file's base lives: <dir>/.defaults/<name>. */
function baseFileFor(file) {
  return path.join(path.dirname(file), '.defaults', path.basename(file));
}

/** `ours` with every key `theirs` has and it lacks put back, at every depth. */
function fill(ours, theirs) {
  if (!isPlain(ours) || !isPlain(theirs)) return ours;
  const out = { ...ours };
  for (const [key, value] of Object.entries(theirs)) out[key] = Object.hasOwn(ours, key) ? fill(ours[key], value) : value;
  return out;
}

/**
 * The file's settings, with every default the person left alone brought up to `defaults`, written back
 * when that changed anything. `past`: every earlier shipped version of `defaults`, oldest first.
 * `normalize` (optional) is applied before writing, so the file keeps the shape the app reads.
 * `fillMissing`: a key missing from the file is put back rather than read as deleted — for files where
 * deleting a setting cannot turn it off, only hide it (config.json: "every switch is there to be edited").
 * → { value, wrote } — value is null when the file exists but is not a JSON object (nothing is written then).
 */
function carryDefaults({ file, defaults, past = [], normalize = (value) => value, fillMissing = false, baseFile = baseFileFor(file), backupDir = null, now = () => new Date() }) {
  const current = readJsonFile(file);
  if (current.missing) {
    const value = normalize(defaults);
    writeJsonFile(file, value);
    writeJsonFile(baseFile, defaults);
    return { value, wrote: true };
  }
  if (!isPlain(current.value)) return { value: null, wrote: false };
  const stored = readJsonFile(baseFile);
  const hasBase = isPlain(stored.value);
  const upToDate = hasBase && equal(stored.value, defaults);
  let next = upToDate ? current.value : merge3(hasBase ? stored.value : rebuildBase(current.value, [...past, defaults]), current.value, defaults);
  if (fillMissing) next = fill(next, defaults);
  if (upToDate && equal(next, current.value)) return { value: current.value, wrote: false };
  const value = normalize(next);
  const changed = !equal(value, current.value);
  if (changed) {
    if (!hasBase && backupDir) {
      try {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(file, path.join(backupDir, `${path.basename(file, '.json')}-${now().toISOString().replace(/[:.]/g, '-')}.json`));
      } catch { /* the merge only moves values nobody chose; it still runs */ }
    }
    writeJsonFile(file, value);
  }
  if (!upToDate) writeJsonFile(baseFile, defaults);
  return { value, wrote: changed };
}

module.exports = { equal, merge3, rebuildBase, carryDefaults, baseFileFor };
