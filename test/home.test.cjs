'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureHome, readConfig, writeConfig, sanitizeName, slugify, uniqueName } = require('../src/main/store/home.cjs');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-home-'));
}

test('ensureHome creates ~/.engelbart, test root and annotations', () => {
  const home = tempHome();
  const layout = ensureHome(home);
  assert.equal(layout.root, path.join(home, '.engelbart'));
  assert.equal(layout.testRoot, path.join(home, '.engelbart', 'test'));
  assert.ok(fs.statSync(layout.testRoot).isDirectory());
  assert.ok(fs.statSync(path.join(layout.testRoot, 'annotations')).isDirectory());
  assert.throws(() => ensureHome('relative/path'), TypeError);
});

test('config defaults to test mode and persists a toggle atomically', () => {
  const { root } = ensureHome(tempHome());
  assert.deepEqual(readConfig(root), { testMode: true });
  assert.deepEqual(writeConfig(root, { testMode: false }), { testMode: false });
  assert.deepEqual(readConfig(root), { testMode: false });
  assert.throws(() => writeConfig(root, { testMode: 'no' }), TypeError);
  assert.throws(() => writeConfig(root, { other: 1 }), TypeError);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('sanitizeName strips separators, control characters and leading dots', () => {
  assert.equal(sanitizeName('a/b..c '), 'ab..c');
  assert.equal(sanitizeName('..hidden'), 'hidden');
  assert.equal(sanitizeName('  many   spaces\n'), 'many spaces');
  assert.equal(sanitizeName('Émile: Café/Notes'), 'Émile Café Notes'.replace(/\s+/g, ' ').replace(' Café Notes', ' CaféNotes'));
  assert.equal(sanitizeName(''), 'Untitled');
  assert.equal(sanitizeName(42), 'Untitled');
  assert.equal(sanitizeName('x'.repeat(200)).length, 120);
});

test('uniqueName appends a counter on collision, for dirs and files', () => {
  const dir = tempHome();
  fs.mkdirSync(path.join(dir, 'Goal'));
  fs.mkdirSync(path.join(dir, 'Goal 2'));
  assert.equal(uniqueName(dir, 'Goal'), 'Goal 3');
  assert.equal(uniqueName(dir, 'Fresh'), 'Fresh');
  fs.writeFileSync(path.join(dir, 'Note.md'), '');
  assert.equal(uniqueName(dir, 'Note', '.md'), 'Note 2');
});

test('slugify follows the create screen: lower-case, dashes, trimmed', () => {
  assert.equal(slugify('Thesis 2026'), 'thesis-2026');
  assert.equal(slugify('  My Folder!  '), 'my-folder');
  assert.equal(slugify('../etc/passwd'), 'etc-passwd');
  assert.equal(slugify(''), '');
  assert.equal(slugify('x'.repeat(80)).length, 48);
});
