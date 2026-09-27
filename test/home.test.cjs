'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureHome, readConfig, writeConfig, writeTools, sanitizeName, slugify, uniqueName } = require('../src/main/store/home.cjs');
const { normalizeTools } = require('../src/main/tools/record.cjs');

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
  const summarizer = { provider: 'openai', openai: { model: 'gpt-6-luna', effort: 'high' }, anthropic: { model: 'claude-opus-5-5', effort: 'high' } };
  const providers = ['openai', 'anthropic'];
  const github = { clientId: 'Iv23liAZNYl96zlluMDs', appSlug: 'engelbart-mathetic' };
  const tools = normalizeTools({});
  assert.deepEqual(readConfig(root), { testMode: true, providers, summarizer, github, tools }, 'summaries default to Codex, gpt-6-luna, high; @bart offers both providers; GitHub sign-in is configured without manual setup');
  assert.deepEqual(writeConfig(root, { testMode: false }), { testMode: false, providers, summarizer, github, tools });
  assert.deepEqual(readConfig(root), { testMode: false, providers, summarizer, github, tools });

  // Switching is one word; each provider keeps its own model and effort; nonsense falls back to the defaults.
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ testMode: false, summarizer: { provider: 'claude', anthropic: { model: 'claude-sonnet-5', effort: 'low' }, openai: { model: 'rm -rf /', effort: 'extreme' } } }));
  assert.deepEqual(readConfig(root).summarizer, { provider: 'anthropic', openai: { model: 'gpt-6-luna', effort: 'high' }, anthropic: { model: 'claude-sonnet-5', effort: 'low' } });
  assert.equal(writeConfig(root, { testMode: true }).summarizer.anthropic.model, 'claude-sonnet-5', 'toggling test mode keeps the summarizer settings');

  // A config file from before the setting existed gains it on the next launch.
  fs.writeFileSync(file, JSON.stringify({ testMode: false }));
  ensureHome(path.dirname(root));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { testMode: false, providers, summarizer, github, tools });

  // Earlier builds wrote empty GitHub settings; these users also get the shared app without editing config.
  fs.writeFileSync(file, JSON.stringify({ testMode: false, providers, summarizer, github: { clientId: '', appSlug: '' } }));
  assert.deepEqual(readConfig(root).github, github);

  // The GitHub App's client id and slug are kept through a toggle; anything that is not one is dropped.
  fs.writeFileSync(file, JSON.stringify({ testMode: false, providers, summarizer, github: { clientId: ' Iv23liAbCdEf1234567890 ', appSlug: 'engelbart-mathetic' } }));
  assert.deepEqual(writeConfig(root, { testMode: true }).github, { clientId: 'Iv23liAbCdEf1234567890', appSlug: 'engelbart-mathetic' });
  fs.writeFileSync(file, JSON.stringify({ testMode: false, providers, summarizer, github: { clientId: 'x y', appSlug: 'Not A Slug' } }));
  assert.deepEqual(readConfig(root).github, github);

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

test('a config default changed by a later build reaches an existing config.json; settings the person chose stay (2026-09-23)', () => {
  const home = tempHome();
  const { root } = ensureHome(home);
  const file = path.join(root, 'config.json');
  const base = path.join(root, '.defaults', 'config.json');
  assert.ok(fs.existsSync(base), 'the defaults this file was given are kept beside it');
  // this install was given an older summarizer default, then chose Claude Code for summaries and left test mode off
  const given = JSON.parse(fs.readFileSync(base, 'utf8'));
  given.summarizer.openai.model = 'gpt-5.6-luna';
  given.summarizer.anthropic.model = 'claude-opus-5';
  given.summarizer.anthropic.effort = 'medium';
  fs.writeFileSync(base, JSON.stringify(given));
  const mine = JSON.parse(fs.readFileSync(file, 'utf8'));
  mine.testMode = false;
  mine.summarizer.provider = 'anthropic';
  mine.summarizer.openai.model = 'gpt-5.6-luna';
  mine.summarizer.anthropic.model = 'claude-opus-5';
  mine.summarizer.anthropic.effort = 'low';
  fs.writeFileSync(file, JSON.stringify(mine));
  ensureHome(home);
  const now = readConfig(root);
  assert.equal(now.summarizer.openai.model, 'gpt-6-luna', 'the model they never touched follows the new default');
  assert.equal(now.summarizer.anthropic.model, 'claude-opus-5-5', 'the other provider also follows the new default');
  assert.deepEqual([now.testMode, now.summarizer.provider, now.summarizer.anthropic.effort], [false, 'anthropic', 'low'], 'what they chose stays');
});

test('untouched summary models upgrade without a saved defaults base', () => {
  const home = tempHome();
  const { root } = ensureHome(home);
  const file = path.join(root, 'config.json');
  const config = readConfig(root);
  config.summarizer.openai.model = 'gpt-5.6-luna';
  config.summarizer.anthropic.model = 'claude-opus-5';
  config.summarizer.anthropic.effort = 'medium';
  fs.writeFileSync(file, JSON.stringify(config));
  fs.unlinkSync(path.join(root, '.defaults', 'config.json'));
  ensureHome(home);
  assert.deepEqual(readConfig(root).summarizer, {
    provider: 'openai',
    openai: { model: 'gpt-6-luna', effort: 'high' },
    anthropic: { model: 'claude-opus-5-5', effort: 'medium' },
  });
});

test('a config.json that does not parse is never overwritten by a launch or by the tool check', () => {
  const home = tempHome();
  const { root } = ensureHome(home);
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, '{ "testMode": fal');
  ensureHome(home);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "testMode": fal');
  assert.equal(readConfig(root).testMode, true, 'reads fall back to the defaults meanwhile');
  assert.equal(writeTools(root, normalizeTools({ git: { installed: true } })), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "testMode": fal');
});

test('the tool record is validated: observed values must look right, requires always comes from the source, skip and pin are kept', () => {
  const { root } = ensureHome(tempHome());
  const written = writeTools(root, {
    updates: 'never',
    git: { installed: true, version: '2.50.1', requires: '>=0.0.1', status: 'ready', path: '/usr/bin/git', onPath: true, source: 'apple', checkedAt: '2026-09-23T18:00:00.000Z', skip: false },
    claude: { installed: 'yes', version: 'banana', status: 'on fire', signedIn: 'maybe', path: 'relative/claude', error: `line one\n${'x'.repeat(500)}`, pin: '2.1.278', skip: true },
    codex: { failedUpdate: { from: '0.150.0', at: '2026-09-23T18:00:00.000Z' }, source: 'apt' },
  });
  assert.equal(written.tools.updates, 'auto');
  assert.deepEqual([written.tools.git.installed, written.tools.git.version, written.tools.git.requires, written.tools.git.source], [true, '2.50.1', '>=2.30.0', 'apple']);
  assert.equal('signedIn' in written.tools.git, false, 'Git has no sign-in');
  const claude = written.tools.claude;
  assert.deepEqual([claude.installed, claude.version, claude.status, claude.signedIn, claude.path, claude.pin, claude.skip], [false, null, 'unknown', null, null, '2.1.278', true]);
  assert.equal(claude.error.length, 300);
  assert.ok(!claude.error.includes('\n'));
  assert.deepEqual([written.tools.codex.failedUpdate, written.tools.codex.source], [{ from: '0.150.0', at: '2026-09-23T18:00:00.000Z' }, null]);
  assert.deepEqual(readConfig(root).tools, written.tools);
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
