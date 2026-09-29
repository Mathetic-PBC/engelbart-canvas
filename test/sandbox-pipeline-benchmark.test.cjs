'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { schedule } = require('../scripts/benchmark-sandbox-pipeline.cjs');
const { snapshot, copyFrozen, loadImplementation, sequentialSource, HISTORICAL_COMMIT } = require('../scripts/sandbox-diagnostics/implementations.cjs');
const { execFileSync } = require('node:child_process');
const { comparableSignature, summarize } = require('../scripts/sandbox-diagnostics/summarize-pipeline.cjs');
const { createAgentMetrics } = require('../scripts/sandbox-diagnostics/agent-metrics.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('full pipeline schedule alternates cases and rotates all three repositories across three rounds', () => {
  const repos = ['a', 'b', 'c'].map(name => ({ name }));
  const rows = schedule(repos, 3);
  assert.equal(rows.length, 18);
  for (const repo of repos) for (const round of [1, 2, 3]) {
    assert.deepEqual(rows.filter(r => r.repository === repo.name && r.round === round).map(r => r.variant),
      round % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']);
  }
  assert.deepEqual([rows[0].repository, rows[6].repository, rows[12].repository], ['a', 'b', 'c']);
});

test('frozen optimized sources are byte-identical; reconstructed baseline is labeled and preserves safety code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pipeline-snapshot-test-'));
  try {
    const current = snapshot(path.join(root, 'optimized'), 'optimized');
    assert.deepEqual(current.source_hashes, current.original_source_hashes);
    const base = snapshot(path.join(root, 'baseline'), 'sequential');
    assert.equal(base.reconstructed, true);
    assert.equal(base.source_hashes['src/main/sandbox/launch.py'], current.source_hashes['src/main/sandbox/launch.py']);
    assert.equal(base.source_hashes['src/main/sandbox/local-claude.cjs'], current.source_hashes['src/main/sandbox/local-claude.cjs']);
    assert.notEqual(base.source_hashes['src/main/sandbox/local-setup.cjs'], current.source_hashes['src/main/sandbox/local-setup.cjs']);
    assert.equal(typeof loadImplementation(base.directory, 'sequential').runtimeFactory, 'function');
    const tools = require(path.join(base.directory, 'src/main/sandbox/local-tools.cjs'));
    assert.throws(() => tools.validateTool('start_app', { command: 'npm start', port: 3000, wait_for_install: true }));
    assert.throws(() => tools.validateTool('dependency_install', { action: 'start', parallel: [{ manager: 'npm', cwd: 'a' }, { manager: 'pip', cwd: 'b' }] }));
    const promptSource = fs.readFileSync(path.join(base.directory, 'src/main/sandbox/local-setup.cjs'), 'utf8');
    assert.match(promptSource, /Never request, print or search for credentials/);
    assert.match(promptSource, /Do not claim success without a successful start_app/);
    assert.doesNotMatch(promptSource, /LAUNCH PROMPTLY|Work IN PARALLEL|wait_for_install:true/);
    assert.throws(() => sequentialSource('src/main/sandbox/local-install.cjs', 'changed source'), /anchor changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('historical baseline loads exact Git sources without prompt or runtime patches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pipeline-history-test-'));
  try {
    const base = snapshot(path.join(root, 'historical'), 'historical');
    assert.equal(base.reconstructed, false);
    assert.deepEqual(base.source_hashes, base.original_source_hashes);
    assert.ok(base.revision.startsWith(HISTORICAL_COMMIT));
    for (const file of Object.keys(base.source_hashes)) {
      assert.deepEqual(fs.readFileSync(path.join(base.directory, file)),
        execFileSync('git', ['show', `${base.revision}:${file}`], { cwd: path.resolve(__dirname, '..') }));
    }
    assert.ok(!Object.keys(base.source_hashes).some(file => /npm-audit\./.test(file)));
    const implementation = loadImplementation(base.directory, 'historical');
    assert.equal(typeof implementation.runtimeFactory, 'function');
    assert.equal(typeof implementation.setupRunner, 'function');
    assert.equal(typeof implementation.agentRunner, 'function');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('incremental baseline copies the frozen bytes and rejects changed source evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pipeline-frozen-test-'));
  try {
    const original = snapshot(path.join(root, 'original'), 'optimized');
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify(original));
    const copy = copyFrozen(path.join(root, 'copy'), manifest);
    assert.deepEqual(copy.source_hashes, original.source_hashes);
    assert.equal(typeof loadImplementation(copy.directory, copy.kind).setupRunner, 'function');
    fs.appendFileSync(path.join(original.directory, 'src/main/sandbox/local-setup.cjs'), '\n// changed\n');
    assert.throws(() => copyFrozen(path.join(root, 'invalid'), manifest), /hash mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sequential baseline disables automatic start, blocks inspection until installation ends and retains inline audit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pipeline-serial-test-'));
  let install, tools;
  try {
    snapshot(path.join(root, 'implementation'), 'sequential');
    const base = path.join(root, 'implementation/src/main/sandbox');
    const { createDependencyInstall } = require(path.join(base, 'local-install.cjs'));
    const { createSandboxTools } = require(path.join(base, 'local-tools.cjs'));
    let complete, jobs = 0, reads = 0, audit;
    const sandbox = {
      files: { write: async () => {}, read: async () => { reads++; return new Response('README').body; } },
      commands: { run: async (command, options) => {
        if (command.endsWith(' inspect')) return { exitCode: 0, stdout: JSON.stringify({
          package: { name: 'app' }, lockfiles: ['package-lock.json'], versions: { node: '22.23.2', npm: '10.9.8' },
        }) };
        if (command.includes('install-job.py run')) {
          jobs++; audit = options.envs.npm_config_audit;
          const done = new Promise(resolve => { complete = resolve; });
          return { wait: () => done, disconnect: async () => {} };
        }
        return { exitCode: 0 };
      } },
    };
    install = createDependencyInstall({ sandbox });
    assert.equal((await install.prepare()).install.status, 'needs_agent');
    assert.equal(jobs, 0);
    tools = createSandboxTools({ sandbox, install, onEvent() {} });
    const start = tools('dependency_install', { action: 'start', command: 'npm ci' });
    await tick();
    const reading = tools('read_file', { path: 'README.md' });
    await tick();
    assert.equal(reads, 0);
    assert.equal(audit, 'true');
    complete({ exitCode: 0 });
    assert.equal((await start).status, 'succeeded');
    const read = await reading;
    assert.equal(read.content, 'README');
    assert.equal(read.dependency_install, undefined);
  } finally { await tools?.close(); await install?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('pipeline metrics allowlist handoff/parallel choices without copying arbitrary tool arguments', () => {
  const metrics = createAgentMetrics(() => 10);
  metrics.push(JSON.stringify({ type: 'assistant', message: { id: 'a', content: [
    { type: 'tool_use', id: 's', name: 'mcp__canvas__start_app', input: { command: 'SECRET', wait_for_install: true } },
    { type: 'tool_use', id: 'i', name: 'mcp__canvas__dependency_install', input: { action: 'start', parallel: [{ manager: 'npm', cwd: 'SECRET' }, { manager: 'pip', cwd: 'SECRET' }], secret: 'SECRET' } },
  ] } }) + '\n');
  assert.equal(metrics.result.tool_calls[0].wait_for_install, true);
  assert.deepEqual(metrics.result.tool_calls[1].parallel_install_managers, ['npm', 'pip']);
  assert.ok(!JSON.stringify(metrics.result).includes('SECRET'));
});

test('full comparisons refuse mismatched packages, incomplete evidence and failed outcomes', () => {
  const sample = { repository: 'owner/repo', variant: 'baseline', round: 1, status: 'ready', commit: 'abc', pinned_commit: 'abc',
    resources: { cpu: 8, memory_mb: 8192 }, agent: { models: ['same'], tool_calls: [], wall_ms: 90 },
    phases: { installs: [], first_app_start_ms: 80 }, end_to_end_ms: 100, cleaned_up: true,
    installed: { node: '22', npm: '10', python: '3.11', arch: 'x64', platform: 'linux', install_changes: '',
      manifest_hashes: { 'package.json': 'same' }, packages: { 'npm:.': { fingerprint: { hash: 'same', packages: 2, version_mismatches: 0 } } } } };
  const optimized = { ...sample, variant: 'optimized', end_to_end_ms: 50 };
  const report = { repositories: [{ name: 'owner/repo' }], rounds: 1, trials: [sample, optimized], finished_at: 'done' };
  assert.equal(summarize(report).repositories[0].percent_reduction, 50);
  assert.equal(comparableSignature({ ...sample, artifact_error: 'missing data' }), null);
  assert.equal(comparableSignature({ ...sample, installed: { ...sample.installed, install_changes: 'M package.json' } }), null);
  const failed = { ...optimized, status: 'failed', error: 'Startup failed', failure_ms: 20 };
  const summary = summarize({ ...report, trials: [sample, failed] });
  assert.equal(summary.repositories[0].percent_reduction, null);
  assert.equal(summary.repositories[0].variants[1].successes, 0);
  assert.equal(summary.repositories[0].variants[1].rows[0].error, 'Startup failed');

  const recovered = { ...optimized, worker_ready_ms: 120,
    phases: { first_app_start_ms: 81, installs: [{ status: 'succeeded', started_ms: 10, finished_ms: 80 }] },
    agent: { ...sample.agent, tool_calls: [
      { name: 'mcp__canvas__start_app', started_ms: 60, finished_ms: 90, wait_for_install: true, is_error: true },
      { name: 'mcp__canvas__start_app', started_ms: 95, finished_ms: 110, is_error: false },
    ] } };
  const row = summarize({ ...report, trials: [recovered] }).repositories[0].variants[1].rows[0];
  assert.equal(row.launch_request_before_install_end, true);
  assert.equal(row.last_install_to_launch_ms, 1);
  assert.equal(row.launch_attempts, 2);
  assert.equal(row.failed_launch_attempts, 1);
  assert.equal(row.first_verified_launch_ms, 110);
  assert.equal(row.verified_launch_to_worker_ready_ms, 10);
});
