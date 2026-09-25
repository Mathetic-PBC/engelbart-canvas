'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { orderFor, ropeCases, auditCases, cacheCases, trial } = require('../scripts/benchmark-sandbox-installs.cjs');
const { npmEnvironment, analyze } = require('../scripts/sandbox-diagnostics/npm.cjs');
const { canonical, median, httpEvidence, summarize } = require('../scripts/sandbox-diagnostics/summarize.cjs');

test('Rope diagnostic uses exactly the requested four treatments, reversing/rotating order', () => {
  assert.deepEqual(ropeCases.map((c) => [c.template, c.args.join(' ')]), [
    ['engelbart-runner', 'install --prefer-offline --timing'],
    ['engelbart-canvas-cached', 'install --prefer-offline --timing'],
    ['engelbart-canvas-cached', 'ci --prefer-offline --timing'],
    ['engelbart-canvas-cached', 'ci --prefer-offline --no-audit --timing'],
  ]);
  assert.deepEqual(orderFor(1, ropeCases).map((c) => c.id), ropeCases.map((c) => c.id));
  assert.deepEqual(orderFor(2, ropeCases).map((c) => c.id), [...ropeCases].reverse().map((c) => c.id));
  const all = [1, 2, 3].flatMap((round) => orderFor(round, ropeCases));
  for (const variant of ropeCases) assert.equal(all.filter((c) => c.id === variant.id).length, 3);
  assert.deepEqual(auditCases[0].args, ['install', '--timing']);
  assert.deepEqual(auditCases[1].args, ['install', '--no-audit', '--timing']);
  assert.deepEqual(cacheCases[0].args, ropeCases[3].args);
  assert.deepEqual(cacheCases[1].args, cacheCases[0].args);
  assert.notEqual(cacheCases[0].template, cacheCases[1].template);
  assert.deepEqual(orderFor(3, cacheCases), cacheCases);
});

test('diagnostic config preserves scripts and dev dependencies without changing persistent npm config', () => {
  const env = npmEnvironment(true);
  assert.equal(env.npm_config_ignore_scripts, 'false');
  assert.equal(env.npm_config_include, 'dev');
  assert.equal(env.npm_config_audit, 'true');
  assert.equal(env.npm_config_cache, '/home/user/.npm');
  assert.equal(env.npm_config_prefer_offline, 'true');
  assert.equal(env.NODE_ENV, undefined);
  assert.match(env.npm_config_userconfig, /install-diagnostics\/user\.npmrc$/);
  assert.match(env.npm_config_globalconfig, /install-diagnostics\/global\.npmrc$/);
  assert.equal(npmEnvironment(false).npm_config_prefer_offline, 'false');
});

test('timing analysis retains overlapping timers instead of summing them into wall time', () => {
  const result = analyze({ npm: 100, 'reify:unpack': 70, 'reify:audit': 80, 'reifyNode:one': 60, 'reifyNode:two': 50, 'build:run:postinstall:pkg': 3 },
    '1 http fetch GET 200 https://registry.npmjs.org/a 50ms (cache hit)\n2 http fetch GET 200 https://registry.npmjs.org/b 70ms (cache miss)');
  assert.equal(result.timers_ms.npm, 100);
  assert.equal(result.longest_package_timers.length, 2);
  assert.equal(result.http.aggregate_request_ms_NOT_wall_time, 120);
  assert.equal(result.http.cache_hits, 1);
  assert.equal(result.http.cache_misses, 1);
  assert.match(result.warning, /overlapping, not additive/);
});

test('diagnostic summaries compare normalized configuration and do not invent absent phase timing', () => {
  assert.equal(median([55, 61]), 58);
  assert.equal(median([4, 3, 20]), 4);
  assert.equal(median([undefined, null]), null);
  assert.deepEqual(canonical({ z: { b: 2, a: 1 }, a: [1, 2] }), { a: [1, 2], z: { a: 1, b: 2 } });
});

test('HTTP evidence does not misclassify a cold tarball request as a cache hit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-http-evidence-'));
  const logs = path.join(directory, 'npm-logs');
  const file = path.join(logs, 'fixture-debug-0.log');
  try {
    fs.mkdirSync(logs);
    fs.writeFileSync(file, '1 http cache https://registry.npmjs.org/pkg/-/pkg-1.tgz 0ms (cache hit)\n' +
      '2 http fetch GET 200 https://registry.npmjs.org/pkg/-/pkg-1.tgz 1000ms (cache miss)\n' +
      '3 http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 300ms\n');
    const result = httpEvidence(directory);
    assert.equal(result.fetch_lines, 2);
    assert.equal(result.tarball_cache_misses, 1);
    assert.equal(result.metadata_or_audit_fetch_lines, 1);
    assert.equal(result.longest_tarball_ms, 1000);
  } finally { fs.unlinkSync(file); fs.rmdirSync(logs); fs.rmdirSync(directory); }
});

test('identical lockfile rewrites remain comparable but are disclosed; differing rewrites are rejected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-manifest-evidence-'));
  try {
    for (const name of ['a', 'b']) {
      fs.mkdirSync(path.join(directory, name));
      fs.writeFileSync(path.join(directory, name, 'npm-config.json'), JSON.stringify({ audit: name === 'a', include: ['dev'] }));
    }
    const trials = ['a', 'b'].map((name) => ({ repository: 'fixture', commit: 'pinned', artifact_directory: name,
      resources: { cpu: 8 }, cleaned_up: true, measurement: { exit_code: 0, runtime: { npm: '10.9.8' },
        fingerprint: { packages: 1, hash: 'same', version_mismatches: 0 }, input_hashes: { lock: 'original' },
        after_hashes: { lock: 'rewritten' }, install_changes: ' M package-lock.json\n' } }));
    const report = { trials, cases: [] };
    const first = summarize(report, directory).repositories[0];
    assert.equal(first.comparable, true);
    assert.equal(first.inputs_unchanged, false);
    trials[1].measurement.after_hashes.lock = 'different';
    assert.equal(summarize(report, directory).repositories[0].comparable, false);
  } finally {
    for (const name of ['a', 'b']) { fs.unlinkSync(path.join(directory, name, 'npm-config.json')); fs.rmdirSync(path.join(directory, name)); }
    fs.rmdirSync(directory);
  }
});

test('diagnostic uses only its own fresh sandbox and cleans up even when cloning fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-diagnostic-test-'));
  const commands = [];
  let kills = 0, options;
  try {
    const result = await trial({ apiKey: 'fixture', suite: 'rope', repo: require('../scripts/sandbox-cache/profile.json').repositories[0],
      variant: ropeCases[2], round: 1, directory, signal: new AbortController().signal, onCreated() {},
      sandboxApi: { create: async (_template, opts) => {
        options = opts;
        return { sandboxId: 'only-owned-test', getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
          commands: { run: async (command) => { commands.push(command); throw new Error('Clone failed'); } },
          kill: async () => { kills++; } };
      }, connect: () => assert.fail('must not connect to existing sandboxes') },
    });
    assert.equal(result.cleaned_up, true);
    assert.equal(kills, 1);
    assert.match(result.diagnostic_error, /Clone failed/);
    assert.equal(options.timeoutMs, 15 * 60_000);
    assert.equal(options.metadata.runId, undefined);
    assert.equal(options.metadata.canvasRunId, undefined);
    assert.equal(options.envs, undefined);
    assert.match(commands[0], /git fetch --depth 1 origin '1ada01830031e5882f2585577720b182deac6246'/);
  } finally { fs.rmdirSync(directory); }
});
