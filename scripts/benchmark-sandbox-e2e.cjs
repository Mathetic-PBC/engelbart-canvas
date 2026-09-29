'use strict';

// Real production worker + local Claude pipeline, without the user's DB/UI.
// Fresh diagnostic sandboxes only; no app/config/template changes or API fallback.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { Sandbox } = require('e2b');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');
const { createRuntime } = require('../src/main/sandbox/worker.cjs');
const { runLocalSetup } = require('../src/main/sandbox/local-setup.cjs');
const { runLocalClaude } = require('../src/main/sandbox/local-claude.cjs');
const { redact, redactOutput } = require('../src/main/sandbox/environment.cjs');
const { createAgentMetrics, phaseSummary } = require('./sandbox-diagnostics/agent-metrics.cjs');
const { median } = require('./sandbox-diagnostics/summarize.cjs');
const { hash, quote } = require('./sandbox-cache/common.cjs');
const profile = require('./sandbox-cache/profile.json');
const repo = profile.repositories.find((r) => r.name === 'mqo00/rope');
const variants = ['engelbart-runner', 'engelbart-canvas-cached'];
const ROOT = '/home/user/repository';
const REMOTE = '/home/user/install-diagnostics';
const sourceFiles = ['worker.cjs', 'local-claude.cjs', 'local-setup.cjs', 'local-tools.cjs', 'local-install.cjs', 'install-job.py', 'launch.py', 'npm-audit.cjs', 'npm-audit.py', 'launch-discovery.cjs', 'launch-discovery.py'];

function safeSdk(create) {
  return { create, connect() { throw new Error('Benchmark must not reconnect to existing sandboxes'); },
    list() { throw new Error('Benchmark must not list user sandboxes'); },
    kill() { throw new Error('Only owned instance cleanup is allowed'); } };
}
async function verifyPublic(url, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const reader = response.body?.getReader();
  let prefix = '';
  try {
    while (reader && prefix.length < 8192) {
      const { value, done } = await reader.read();
      if (done) break;
      prefix += new TextDecoder().decode(value).slice(0, 8192 - prefix.length);
      if (/<html|<!doctype/i.test(prefix)) break;
    }
  } finally { await reader?.cancel(); }
  return { status: response.status, html: /<html|<!doctype/i.test(prefix), ok: response.status === 200 && /<html|<!doctype/i.test(prefix) };
}
async function artifacts(sandbox, record, directory, repository = repo) {
  await sandbox.commands.run(`mkdir -p ${REMOTE}`, { timeoutMs: 10_000 });
  await sandbox.files.write(`${REMOTE}/npm.cjs`, fs.readFileSync(path.join(__dirname, 'sandbox-diagnostics/npm.cjs'), 'utf8'));
  const program = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
    const {packageFingerprint}=require('${REMOTE}/npm.cjs');
    const files=${JSON.stringify(repository.files)};
    console.log(JSON.stringify({fingerprint:packageFingerprint('${ROOT}/${repository.installs.find(i => i.manager === 'npm').cwd}'),
      node:process.version,npm:cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),
      arch:process.arch,platform:process.platform,
      manifest_hashes:Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync('${ROOT}/'+f)).digest('hex')])),
      install_changes:cp.execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:'${ROOT}',encoding:'utf8'})}));`;
  const result = await sandbox.commands.run(`node -e ${quote(program)}`, { timeoutMs: 30_000 });
  record.installed = JSON.parse(result.stdout);
  if (record.installed.fingerprint) fs.writeFileSync(path.join(directory, 'packages.json'),
    await sandbox.files.read(`${REMOTE}/packages.json`, { format: 'bytes' }));
}

async function trial({ template, round, directory, environment, onCreated, signal, repository = repo,
  sandboxApi = Sandbox, runtimeFactory = createRuntime, setupRunner = runLocalSetup,
  agentRunner = runLocalClaude, collectArtifacts = artifacts, verifyServices = async () => ({ ok: true, checks: [] }) }) {
  const record = { id: randomUUID(), template, round, repository: repository.name, pinned_commit: repository.commit,
    started_at: new Date().toISOString(), provider: 'claude-local', model_requested: environment.ENGELBART_SANDBOX_CLAUDE_MODEL || 'claude-sonnet-5-5' };
  const secrets = [environment.E2B_API_KEY, environment.ANTHROPIC_API_KEY].filter(Boolean);
  const save = () => fs.writeFileSync(path.join(directory, 'measurement.json'), JSON.stringify(redact(record, secrets), null, 2));
  const start = performance.now(), now = () => Math.round(performance.now() - start);
  const events = [];
  let owned, runtime, running, timeout, aborted = false, killed = false, resolve, reject;
  let agentStarted = false, agentFinished;
  const agentSettled = new Promise(resolve => { agentFinished = resolve; });
  const terminal = new Promise((yes, no) => { resolve = yes; reject = no; });
  terminal.catch(() => {});
  const stop = () => { aborted = true; reject(new Error(signal?.reason?.message || 'Benchmark interrupted')); runtime?.stop().catch(() => {}); };
  const sdk = safeSdk(async (name, options) => {
    if (owned || aborted) throw new Error('Only one fresh sandbox per trial is allowed');
    if (name !== template) throw new Error(`Unexpected template ${name}; pinned repository benchmark expects ${template}`);
    owned = await sandboxApi.create(name, { ...options, apiKey: environment.E2B_API_KEY, timeoutMs: 20 * 60_000,
      metadata: { app: 'engelbart-e2e-benchmark', benchmarkId: record.id, repo: repository.name } });
    record.sandbox_id = owned.sandboxId; save(); onCreated(record);
    if (aborted) throw new Error('Benchmark interrupted');
    const info = await owned.getInfo({ requestTimeoutMs: 15_000 });
    record.template_id = info.templateId; record.resources = { cpu: info.cpuCount, memory_mb: info.memoryMB };
    if (info.cpuCount !== 8 || info.memoryMB !== 8192) throw new Error('Hardware differs from the controlled 8 CPU / 8192 MiB benchmark');
    const commands = new Proxy(owned.commands, { get(target, key) {
      if (key !== 'run') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
      return async (command, options) => {
        const result = await target.run(command, options);
        if (command.startsWith('git clone --progress --depth 1 ')) {
          const revision = await target.run(`git -C ${ROOT} rev-parse HEAD`, { timeoutMs: 10_000 });
          record.commit = revision.stdout.trim();
          if (record.commit !== repository.commit) throw new Error('Remote HEAD changed from the pinned commit; stop instead of benchmarking different source');
        }
        return result;
      };
    } });
    return new Proxy(owned, { get(target, key) {
      if (key === 'commands') return commands;
      if (key === 'kill') return async (...args) => { const result = await target.kill(...args); killed = true; return result; };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  const agent = async (options) => {
    agentStarted = true;
    const metrics = createAgentMetrics(now);
    record.agent = { started_ms: now(), prompt_bytes: Buffer.byteLength(options.prompt), ...metrics.result };
    try {
      await agentRunner({ ...options, spawnProcess(file, args, config) {
        const child = spawn(file, args, config);
        child.stdout.on('data', (chunk) => metrics.push(chunk));
        return child;
      } });
    } finally {
      metrics.finish();
      record.agent = { ...record.agent, ...metrics.result, finished_ms: now(), wall_ms: now() - record.agent.started_ms };
      save();
      agentFinished();
    }
  };
  runtime = runtimeFactory({ Sandbox: sdk, env: { ...environment, E2B_TEMPLATE: template, ENGELBART_SANDBOX_SETUP: 'claude-local' },
    localSetup: (options) => setupRunner({ ...options, runAgent: agent }),
    waitForAck: async () => { save(); },
    emit(event) {
      const safe = redact({ elapsed_ms: now(), ...event }, secrets);
      events.push(safe); fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify(safe) + '\n');
      if (event.event === 'ready') resolve(event);
      if (event.event === 'failed' || (event.event === 'stopped' && !record.worker_ready_ms)) reject(new Error(event.error || 'Stopped before ready'));
    },
  });
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    timeout = setTimeout(() => { aborted = true; reject(new Error('End-to-end trial exceeded 17 minutes')); runtime.stop().catch(() => {}); }, 17 * 60_000);
    running = runtime.run({ command: 'start', run_id: record.id, github_url: `https://github.com/${repository.name}`,
      environment: { values: {}, removed: [] } });
    running.catch(reject);
    const ready = await terminal;
    record.worker_ready_ms = now(); record.preview_url = ready.preview_url; record.port = ready.port;
    record.public_check = await verifyPublic(ready.preview_url);
    record.preview_only_ms = now();
    record.services_check = await verifyServices(owned, repository);
    record.end_to_end_ms = now();
    record.status = record.public_check.ok ? record.services_check.ok ? 'ready' : 'partial' : 'failed';
    if (!record.public_check.ok) record.error = 'Worker reported ready, but independent public HTTP 200 HTML check failed';
    else if (!record.services_check.ok) record.error = 'Frontend ready, but a required backend check failed';
    save();
    // Early readiness deliberately precedes the final model result. Drain it
    // outside timing, otherwise cleanup would interrupt the agent and bias its
    // usage/tool metrics. Production itself bounds this finalization at 30s.
    if (agentStarted) {
      let drain;
      try { await Promise.race([agentSettled, new Promise(resolve => { drain = setTimeout(resolve, 40_000); })]); }
      finally { clearTimeout(drain); }
    }
    // Collection is outside the timed interval; the existing background audit
    // may begin after ready, just as it does in Canvas. Cleanup aborts that job.
    try { await collectArtifacts(owned, record, directory, repository); }
    catch (error) { record.artifact_error = redactOutput(error.message, secrets); }
  } catch (error) {
    record.status = 'failed'; record.error = redactOutput(error.message, secrets); record.failure_ms = now();
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', stop);
    try { await runtime.stop(); } catch (error) { record.cleanup_error = redactOutput(error.message, secrets); }
    if (owned && !killed) {
      try { await owned.kill({ requestTimeoutMs: 15_000 }); killed = true; delete record.cleanup_error; }
      catch (error) { record.cleanup_error = redactOutput(error.message, secrets); }
    }
    if (running) await Promise.race([running, new Promise((resolve) => { const timer = setTimeout(resolve, 15_000); timer.unref(); })]);
    record.cleaned_up = !owned || killed;
    record.phases = phaseSummary(events, record.agent);
    record.finished_at = new Date().toISOString(); save();
  }
  return record;
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, rounds: { type: 'string', default: '3' } } });
  const rounds = Number(values.rounds);
  if (!values.output || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error('Use --output NEW_DIRECTORY [--rounds 1..3]');
  const output = path.resolve(values.output);
  if (fs.existsSync(output)) throw new Error('Output already exists; do not overwrite evidence');
  fs.mkdirSync(output, { recursive: true });
  const environment = { ...process.env, ...readSandboxEnv(path.join(os.homedir(), '.engelbart')) };
  if (!environment.E2B_API_KEY) throw new Error('E2B_API_KEY unavailable');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Benchmark interrupted'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const report = { started_at: new Date().toISOString(), repository: repo, rounds,
    source_hashes: Object.fromEntries(sourceFiles.map((file) => [file, hash(fs.readFileSync(path.join(__dirname, '../src/main/sandbox', file), 'utf8'))])),
    methodology: ['Real unchanged worker/local Claude prompts and tools; API fallback disabled for consistent subscription provider.',
      'Fresh sequential sandboxes. Order: runner/cached, cached/runner, runner/cached. Same pinned HEAD asserted after clone.',
      'Timed from worker request to ready plus independent public HTTP 200 HTML check. Agent tools/startup included; artifacts/cleanup excluded.',
      'Not a renderer/UI benchmark: library insertion, Electron IPC, local DB writes, browser painting excluded. Handle acknowledgement saved to diagnostic JSON.',
      'No app secrets supplied; root preview only, not authenticated AI/database features. Normal post-ready background audit retained.',
      'Agent wall time overlaps tools/installs. CLI API time is not pure thinking time. No raw CLI account/MCP details, prompts, arguments or stderr retained.'],
    trials: [] };
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  try {
    save();
    for (let round = 1; round <= rounds; round++) for (const template of round % 2 ? variants : [...variants].reverse()) {
      controller.signal.throwIfAborted();
      const directory = path.join(output, `r${round}-${template}`); fs.mkdirSync(directory);
      console.log(`Round ${round}/${rounds}: ${template}, real local Claude`);
      const result = await trial({ template, round, directory, environment, signal: controller.signal,
        onCreated: (record) => { report.active_trial = { id: record.id, sandbox_id: record.sandbox_id, template, round }; save(); } });
      report.trials.push(result); delete report.active_trial; save();
      console.log(JSON.stringify({ template, round, status: result.status, seconds: result.end_to_end_ms / 1000,
        agent_seconds: result.agent?.wall_ms / 1000, error: result.error, cleaned_up: result.cleaned_up }));
      if (!result.cleaned_up) throw new Error('Owned test sandbox cleanup could not be confirmed');
      if (result.error && /sign.in|subscription|usage limits|Remote HEAD changed|Hardware differs|Unexpected template/i.test(result.error)) throw new Error('Benchmark blocked; see recorded failure. No provider fallback attempted.');
    }
    report.finished_at = new Date().toISOString();
    report.summary = variants.map((template) => {
      const rows = report.trials.filter((r) => r.template === template), successful = rows.filter((r) => r.status === 'ready');
      return { template, success: successful.length, total: rows.length, times_ms: successful.map((r) => r.end_to_end_ms),
        median_ms: median(successful.map((r) => r.end_to_end_ms)), mean_ms: successful.length ? successful.reduce((sum,r)=>sum+r.end_to_end_ms,0)/successful.length : null,
        failures: rows.filter((r) => r.status !== 'ready').map((r) => ({ round: r.round, error: r.error, failure_ms: r.failure_ms })) };
    });
    save();
  } catch (error) { report.error = error.message; save(); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); console.log(`Evidence: ${output}`); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { safeSdk, verifyPublic, trial };
