'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { equal, merge3, rebuildBase, carryDefaults, baseFileFor } = require('../src/main/store/defaults.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-defaults-'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

test('equal ignores key order and treats arrays as ordered', () => {
  assert.ok(equal({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!equal([1, 2], [2, 1]));
  assert.ok(!equal({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(equal(undefined, undefined));
  assert.ok(!equal(null, undefined));
});

test('merge3: what was left alone moves to the new default, what was changed stays, arrays are one value', () => {
  const base = { model: 'luna', effort: 'high', efforts: ['medium', 'high'], about: 'old words' };
  const theirs = { model: 'sol', effort: 'high', efforts: ['medium', 'high', 'ultra'], about: 'new words' };
  const ours = { model: 'luna', effort: 'low', efforts: ['medium', 'high'], about: 'old words' };
  assert.deepEqual(merge3(base, ours, theirs), { model: 'sol', effort: 'low', efforts: ['medium', 'high', 'ultra'], about: 'new words' });
  // the person changed a list and the default changed it too: the person's list stays whole
  assert.deepEqual(merge3(base, { ...ours, efforts: ['high'] }, theirs).efforts, ['high']);
});

test('merge3: added, deleted and dropped keys', () => {
  const base = { models: { luna: 1, sol: 2 }, keep: true };
  // a key only the new defaults have is added
  assert.deepEqual(merge3(base, base, { ...base, models: { ...base.models, astra: 3 } }).models, { luna: 1, sol: 2, astra: 3 });
  // a key the person deleted stays deleted, even when its default changed
  assert.deepEqual(merge3(base, { models: { sol: 2 }, keep: true }, { models: { luna: 9, sol: 2 }, keep: true }).models, { sol: 2 });
  // a key the new defaults dropped goes, unless the person changed it
  assert.deepEqual(merge3(base, base, { models: { sol: 2 }, keep: true }).models, { sol: 2 });
  assert.deepEqual(merge3(base, { models: { luna: 7, sol: 2 }, keep: true }, { models: { sol: 2 }, keep: true }).models, { luna: 7, sol: 2 });
  // keys the person added are theirs
  assert.deepEqual(merge3(base, { ...base, mine: 'x' }, { ...base, keep: false }), { models: { luna: 1, sol: 2 }, keep: false, mine: 'x' });
});

test('rebuildBase: a value equal to any shipped default counts as left alone; one no version shipped is the person\'s', () => {
  const v1 = { about: 'one', efforts: ['m', 'h'], ladder: ['a'] };
  const v2 = { about: 'two', efforts: ['m', 'h', 'u'], ladder: ['a'] };
  const file = { about: 'one', efforts: ['m', 'h', 'u'], ladder: ['mine'] };
  const base = rebuildBase(file, [v1, v2]);
  assert.deepEqual(base, { about: 'one', efforts: ['m', 'h', 'u'], ladder: ['a'] });
  assert.deepEqual(merge3(base, file, v2), { about: 'two', efforts: ['m', 'h', 'u'], ladder: ['mine'] });
  // a key missing from the file: deleted when every version had it, not yet given when one lacked it
  assert.deepEqual(rebuildBase({ testMode: false }, [{ testMode: true }, { testMode: true, github: { id: 'x' } }]), { testMode: true });
  assert.deepEqual(rebuildBase({ a: 1 }, [{ a: 1, b: 2 }, { a: 1, b: 3 }]), { a: 1, b: 3 });
  // a key inside an object only asks the versions that had that object: only the second could have written `s`,
  // and it had `y`, so a missing `y` was deleted; when a version with `s` lacked `y`, `y` is simply new
  assert.deepEqual(rebuildBase({ s: { x: 1 } }, [{}, { s: { x: 1, y: 2 } }]), { s: { x: 1, y: 2 } });
  assert.deepEqual(rebuildBase({ s: { x: 1 } }, [{ s: { x: 1 } }, { s: { x: 1, y: 2 } }]), { s: { x: 1 } });
});

test('carryDefaults: a missing file is written with the defaults and its base', () => {
  const dir = temp();
  const file = path.join(dir, 'models.json');
  const out = carryDefaults({ file, defaults: { a: 1 } });
  assert.deepEqual(out, { value: { a: 1 }, wrote: true });
  assert.deepEqual(readJson(file), { a: 1 });
  assert.deepEqual(readJson(baseFileFor(file)), { a: 1 });
  assert.equal(baseFileFor(file), path.join(dir, '.defaults', 'models.json'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // Windows has no such modes
});

test('carryDefaults: a new default reaches an existing file, the person\'s edits stay, and nothing is rewritten when nothing changed', () => {
  const dir = temp();
  const file = path.join(dir, 'models.json');
  carryDefaults({ file, defaults: { provider: 'openai', about: 'v1', effort: 'high' } });
  writeJson(file, { provider: 'openai', about: 'v1', effort: 'low' });
  const out = carryDefaults({ file, defaults: { provider: 'anthropic', about: 'v2', effort: 'high' } });
  assert.deepEqual(out.value, { provider: 'anthropic', about: 'v2', effort: 'low' });
  assert.deepEqual(readJson(file), { provider: 'anthropic', about: 'v2', effort: 'low' });
  assert.deepEqual(readJson(baseFileFor(file)), { provider: 'anthropic', about: 'v2', effort: 'high' });
  const before = fs.statSync(file).mtimeMs;
  const again = carryDefaults({ file, defaults: { provider: 'anthropic', about: 'v2', effort: 'high' } });
  assert.equal(again.wrote, false);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('carryDefaults: a file from before bases existed is merged against every shipped version and backed up once', () => {
  const dir = temp();
  const file = path.join(dir, 'models.json');
  const backups = path.join(dir, '.backups');
  const v1 = { about: 'v1', efforts: ['m'], provider: 'openai' };
  const v2 = { about: 'v2', efforts: ['m', 'u'], provider: 'openai' };
  const v3 = { about: 'v3', efforts: ['m', 'u'], provider: 'openai', ladder: ['sol'] };
  writeJson(file, { about: 'v1', efforts: ['m', 'u'], provider: 'anthropic' });
  const out = carryDefaults({ file, defaults: v3, past: [v1, v2], backupDir: backups, now: () => new Date('2026-09-23T12:00:00Z') });
  assert.deepEqual(out.value, { about: 'v3', efforts: ['m', 'u'], provider: 'anthropic', ladder: ['sol'] });
  assert.deepEqual(fs.readdirSync(backups), ['models-2026-09-23T12-00-00-000Z.json']);
  assert.deepEqual(readJson(path.join(backups, 'models-2026-09-23T12-00-00-000Z.json')).about, 'v1');
  carryDefaults({ file, defaults: { ...v3, about: 'v4' }, past: [v1, v2, v3], backupDir: backups });
  assert.equal(fs.readdirSync(backups).length, 1, 'with a base on disk there is nothing to guess, so no second copy');
  assert.equal(readJson(file).about, 'v4');
});

test('carryDefaults: a file that does not parse, or is not an object, is left alone', () => {
  const dir = temp();
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, '{ "half": ');
  assert.deepEqual(carryDefaults({ file, defaults: { a: 1 } }), { value: null, wrote: false });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "half": ');
  assert.equal(fs.existsSync(baseFileFor(file)), false);
  fs.writeFileSync(file, '[]');
  assert.deepEqual(carryDefaults({ file, defaults: { a: 1 } }), { value: null, wrote: false });
  assert.equal(fs.readFileSync(file, 'utf8'), '[]');
});

test('carryDefaults: normalize gives the written file the shape the app reads', () => {
  const dir = temp();
  const file = path.join(dir, 'config.json');
  writeJson(file, { testMode: false, junk: 1 });
  const normalize = (value) => ({ testMode: typeof value.testMode === 'boolean' ? value.testMode : true, providers: Array.isArray(value.providers) ? value.providers : ['openai'] });
  const out = carryDefaults({ file, defaults: normalize({}), past: [{ testMode: true }], normalize });
  assert.deepEqual(out.value, { testMode: false, providers: ['openai'] });
  assert.deepEqual(readJson(file), { testMode: false, providers: ['openai'] });
});

test('carryDefaults: fillMissing puts deleted keys back (config.json), without it a deletion stays (the models file)', () => {
  const dir = temp();
  const file = path.join(dir, 'config.json');
  const defaults = { testMode: true, summarizer: { provider: 'openai', effort: 'high' } };
  carryDefaults({ file, defaults });
  writeJson(file, { testMode: false, summarizer: { provider: 'anthropic' } });
  assert.deepEqual(carryDefaults({ file, defaults }).value, { testMode: false, summarizer: { provider: 'anthropic' } });
  assert.deepEqual(carryDefaults({ file, defaults, fillMissing: true }).value, { testMode: false, summarizer: { provider: 'anthropic', effort: 'high' } });
  assert.deepEqual(readJson(file), { testMode: false, summarizer: { provider: 'anthropic', effort: 'high' } });
  assert.equal(carryDefaults({ file, defaults, fillMissing: true }).wrote, false);
});
