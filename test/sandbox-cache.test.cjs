'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Template } = require('e2b');
const { CACHE_ENV, TOOLS, hash, quote, validateProfile, seedCommand, cacheTemplate } = require('../scripts/sandbox-cache/common.cjs');
const { runCase, summarize, median } = require('../scripts/benchmark-sandbox-cache.cjs');
const { pythonFingerprint } = require('../scripts/sandbox-cache/measure.cjs');
const profile = require('../scripts/sandbox-cache/profile.json');

test('cache profile contains pinned, public dependency manifests, never application source or secrets', () => {
  assert.equal(validateProfile(profile), profile);
  assert.equal(profile.repositories.length, 3);
  for (const mutation of [
    (p) => { p.repositories[0].commit = 'main'; },
    (p) => { p.repositories[0].name = 'owner/repo; echo secret'; },
    (p) => { p.repositories[0].files.push('.env'); },
    (p) => { p.repositories[0].files.push('../package.json'); },
    (p) => { p.repositories[0].files.push('/package.json'); },
    (p) => { p.repositories[0].files = ['system/package.json']; },
    (p) => { p.repositories[0].installs[0].cwd = '../repository'; },
    (p) => { p.repositories[0].installs[0].manager = 'shell'; },
    (p) => { p.repositories.push(p.repositories[0]); },
  ]) {
    const invalid = structuredClone(profile); mutation(invalid);
    assert.throws(() => validateProfile(invalid));
  }
});

test('seeding caches downloads without running npm app scripts or globally installing app dependencies', () => {
  assert.deepEqual(seedCommand({ manager: 'npm' }), ['npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']]);
  assert.deepEqual(seedCommand({ manager: 'pip' }, '/tmp/wheels'), ['python3', ['-m', 'pip', 'wheel', '--disable-pip-version-check', '--wheel-dir', '/tmp/wheels', '-r', 'requirements.txt']]);
  assert.equal(CACHE_ENV.npm_config_cache, '/home/user/.npm');
  assert.equal(CACHE_ENV.PIP_CACHE_DIR, '/home/user/.cache/pip');
  assert.equal(CACHE_ENV.npm_config_prefer_offline, 'true');
  assert.equal(CACHE_ENV.npm_config_offline, undefined, 'a cache miss can still use the network');
  assert.equal(CACHE_ENV.npm_config_ignore_scripts, undefined, 'normal runs retain lifecycle scripts');
});

test('derived template inherits the runner and copies only explicit cache tooling', async () => {
  const result = JSON.parse(await Template.toJSON(cacheTemplate(Template, 'engelbart-runner', profile)));
  const json = JSON.stringify(result);
  assert.equal(result.fromTemplate, 'engelbart-runner');
  assert.match(json, /npm_config_prefer_offline/);
  assert.match(json, new RegExp(`${TOOLS}/seed.cjs`));
  assert.ok(result.steps.some((step) => step.type === 'RUN' && step.args[0] === 'npm config set prefer-offline=true --location=user'),
    'the npm preference must survive beyond build-time template ENV');
  assert.doesNotMatch(json, /API_KEY|sandbox\.env|node_modules|\.env\.local/);
  assert.throws(() => cacheTemplate(Template, 'runner; echo bad', profile));
});

test('cache builder accepts an optional disk target and rejects invalid values before building', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const script = path.join(__dirname, '../scripts/build-sandbox-cache.cjs');
  for (const value of ['0', '4096']) {
    const run = spawnSync(process.execPath, [script, '--base', 'engelbart-runner', '--name', 'cache-dry-test', '--min-free-disk-mb', value, '--dry-run'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).fromTemplate, 'engelbart-runner');
  }
  for (const value of ['-1', '1.5', 'invalid', '9007199254740992']) {
    const run = spawnSync(process.execPath, [script, `--min-free-disk-mb=${value}`, '--dry-run'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /must be a non-negative integer/);
  }
});

function fakeSandbox(failure) {
  const seen = { killed: 0, commands: [], writes: [] };
  const sandbox = {
    sandboxId: 'only-this-benchmark',
    getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
    commands: { run: async (command) => { seen.commands.push(command); if (failure) throw new Error(failure); } },
    files: { write: async (file) => { seen.writes.push(file); }, read: async () => JSON.stringify({ success: true, total_ms: 10 }) },
    kill: async () => { seen.killed++; },
  };
  const Sandbox = { create: async (template, options) => { seen.template = template; seen.options = options; return sandbox; } };
  return { Sandbox, seen };
}
const caseOptions = { apiKey: 'test-api-key', template: 'cached', repo: profile.repositories[0], benchmarkId: 'benchmark-test', round: 1 };

test('benchmark uses fresh expiring sandboxes and kills exactly its own sandbox on success', async () => {
  const { Sandbox, seen } = fakeSandbox();
  const result = await runCase({ ...caseOptions, Sandbox });
  assert.equal(seen.killed, 1);
  assert.equal(seen.options.timeoutMs, 15 * 60_000);
  assert.equal(seen.options.metadata.app, 'engelbart-cache-benchmark');
  assert.equal(seen.options.metadata.runId, undefined);
  assert.equal(seen.options.envs, undefined, 'host credentials are not forwarded into the sandbox');
  assert.match(seen.commands[0], new RegExp(profile.repositories[0].commit));
  assert.deepEqual(seen.writes, ['/home/user/cache-benchmark/common.cjs', '/home/user/cache-benchmark/measure.cjs', '/home/user/cache-benchmark/repo.json']);
  assert.equal(result.sandbox_id, 'only-this-benchmark');
  assert.deepEqual(result.resources, { cpu: 8, memory_mb: 8192 });
});

test('benchmark cleans up after command failure and creates nothing if cancelled before starting', async () => {
  const { Sandbox, seen } = fakeSandbox('install failed');
  await assert.rejects(runCase({ ...caseOptions, Sandbox }), /install failed/);
  assert.equal(seen.killed, 1);
  const unused = fakeSandbox();
  await assert.rejects(runCase({ ...caseOptions, Sandbox: unused.Sandbox, signal: AbortSignal.abort() }));
  assert.equal(unused.seen.template, undefined);
  assert.equal(unused.seen.killed, 0);
});

test('benchmark never labels different packages, machines, runtimes, or failed installs as comparable', () => {
  const base = { repository: 'owner/repo', commit: 'a'.repeat(40), template: 'base', total_ms: 100, success: true,
    resources: { cpu: 8, memory_mb: 8192 }, runtime: { node: 'v22', npm: '10', python: '3.11' },
    fingerprints: { 'npm:.': { hash: hash('packages'), packages: 10 } } };
  const warm = { ...structuredClone(base), template: 'cached', total_ms: 75 };
  assert.deepEqual(summarize([base, warm], 'base', 'cached'), [{ repository: 'owner/repo', comparable: true,
    baseline_median_ms: 100, cached_median_ms: 75, saved_percent: 25 }]);
  for (const mutation of [
    (r) => { r.commit = 'b'.repeat(40); }, (r) => { r.resources.cpu = 2; },
    (r) => { r.runtime.npm = '11'; }, (r) => { r.fingerprints['npm:.'].hash = hash('different packages'); },
    (r) => { r.fingerprints = {}; }, (r) => { r.total_ms = 0; }, (r) => { r.success = false; },
  ]) {
    const changed = structuredClone(warm); mutation(changed);
    const [summary] = summarize([base, changed], 'base', 'cached');
    assert.equal(summary.comparable, false);
    assert.equal(summary.saved_percent, null);
  }
  assert.equal(summarize([base], 'base', 'cached')[0].comparable, false);
  assert.equal(median([10, 1, 3, 2]), 2.5);
  assert.equal(quote("a'b"), "'a'\\''b'");
});

test('Python package comparisons normalize distribution spelling, never versions or source URLs', () => {
  assert.deepEqual(pythonFingerprint(['func_timeout==4.3.5', 'Flask==2.2.3']),
    pythonFingerprint(['flask==2.2.3', 'func-timeout==4.3.5']));
  assert.deepEqual(pythonFingerprint(['Example.Pkg_Name==1']), pythonFingerprint(['example-pkg-name==1']));
  assert.notDeepEqual(pythonFingerprint(['func_timeout==4.3.5']), pythonFingerprint(['func-timeout==4.3.6']));
  assert.notDeepEqual(pythonFingerprint(['pkg @ https://example.test/a']), pythonFingerprint(['pkg @ https://example.test/b']));
});

test('measurement runs normal installs and fingerprints npm plus the complete Python package list', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/sandbox-cache/measure.cjs'), 'utf8');
  const packages = Array.from({ length: 120 }, (_, i) => `long_example_distribution_${i}==1.2.3`).sort();
  assert.ok(packages.join('\n').length > 2500);
  const commands = [], entry = { exports: {} };
  const dependencies = {
    'node:path': path,
    'node:fs': { existsSync: () => false, readFileSync: () => JSON.stringify({ packages: { 'node_modules/example': { version: '1.0.0', integrity: 'sha512-test' } } }) },
    'node:child_process': { spawnSync: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0, stdout: args.includes('freeze') ? packages.join('\n') : 'fixture-version\n', stderr: '' };
    } },
    './common.cjs': require('../scripts/sandbox-cache/common.cjs'),
  };
  let clock = 0;
  vm.runInNewContext(source, { module: entry, require: (name) => dependencies[name], process: { version: 'v22' }, performance: { now: () => clock++ } });
  const result = entry.exports.measure({ name: 'fixture/repo', commit: 'a'.repeat(40),
    files: ['package.json', 'package-lock.json', 'backend/requirements.txt'], installs: [{ manager: 'npm', cwd: '.' }, { manager: 'pip', cwd: 'backend' }] });
  assert.equal(result.success, true);
  assert.equal(result.fingerprints['npm:.'].packages, 1);
  assert.equal(result.fingerprints['npm:.'].hash, hash([['node_modules/example', '1.0.0', 'sha512-test', false]]));
  assert.equal(result.fingerprints['pip:backend'].packages, 120);
  assert.equal(result.fingerprints['pip:backend'].hash, pythonFingerprint(packages).hash);
  assert.deepEqual(commands[0], ['npm', 'install']);
  assert.equal(commands.some((args) => args.includes('--ignore-scripts')), false);
  assert.ok(commands.some((args) => args.join(' ').endsWith('-m pip install -r requirements.txt')));
});
