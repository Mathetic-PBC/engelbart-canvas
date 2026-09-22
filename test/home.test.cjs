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
  const summarizer = { provider: 'openai', openai: { model: 'gpt-5.6-luna', effort: 'high' }, anthropic: { model: 'claude-opus-5', effort: 'high' } };
  const providers = ['openai', 'anthropic'];
  assert.deepEqual(readConfig(root), { testMode: true, providers, summarizer }, 'summaries default to Codex, gpt-5.6-luna, high; @bart offers both providers');
  assert.deepEqual(writeConfig(root, { testMode: false }), { testMode: false, providers, summarizer });
  assert.deepEqual(readConfig(root), { testMode: false, providers, summarizer });

  // Switching is one word; each provider keeps its own model and effort; nonsense falls back to the defaults.
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ testMode: false, summarizer: { provider: 'claude', anthropic: { model: 'claude-sonnet-5', effort: 'low' }, openai: { model: 'rm -rf /', effort: 'extreme' } } }));
  assert.deepEqual(readConfig(root).summarizer, { provider: 'anthropic', openai: { model: 'gpt-5.6-luna', effort: 'high' }, anthropic: { model: 'claude-sonnet-5', effort: 'low' } });
  assert.equal(writeConfig(root, { testMode: true }).summarizer.anthropic.model, 'claude-sonnet-5', 'toggling test mode keeps the summarizer settings');

  // A config file from before the setting existed gains it on the next launch.
  fs.writeFileSync(file, JSON.stringify({ testMode: false }));
  ensureHome(path.dirname(root));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { testMode: false, providers, summarizer });

  // The providers @bart offers: aliases are read, a name listed twice counts once, and a list naming none of them is the default.
  fs.writeFileSync(file, JSON.stringify({ testMode: false, providers: ['claude', 'Anthropic', 'gemini'], summarizer }));
  assert.deepEqual(readConfig(root).providers, ['anthropic']);
  assert.deepEqual(writeConfig(root, { testMode: true }).providers, ['anthropic'], 'toggling test mode keeps the list');
  fs.writeFileSync(file, JSON.stringify({ testMode: false, providers: ['gemini'], summarizer }));
  assert.deepEqual(readConfig(root).providers, providers);
  assert.throws(() => writeConfig(root, { testMode: 'no' }), TypeError);
  assert.throws(() => writeConfig(root, { other: 1 }), TypeError);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('sanitizeName turns slashes into hyphens and strips colons, control characters and leading dots', () => {
  assert.equal(sanitizeName('a/b..c '), 'a-b..c');
  assert.equal(sanitizeName('09/20 plan\\v2'), '09-20 plan-v2');
  assert.equal(sanitizeName('..hidden'), 'hidden');
  assert.equal(sanitizeName('  many   spaces\n'), 'many spaces');
  assert.equal(sanitizeName('Émile: Café/Notes'), 'Émile Café-Notes');
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
