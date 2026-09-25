'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { Sandbox } = require('e2b');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');
const { hash, quote, validateProfile } = require('./sandbox-cache/common.cjs');
const profile = require('./sandbox-cache/profile.json');

async function runCase({ Sandbox, apiKey, template, repo, benchmarkId, round, signal }) {
  validateProfile({ version: 1, repositories: [repo] });
  signal?.throwIfAborted();
  let sandbox;
  try {
    sandbox = await Sandbox.create(template, { apiKey, timeoutMs: 15 * 60_000, requestTimeoutMs: 60_000,
      metadata: { app: 'engelbart-cache-benchmark', benchmarkId, repository: repo.name } });
    signal?.throwIfAborted();
    const info = await sandbox.getInfo({ requestTimeoutMs: 15_000 });
    await sandbox.commands.run(`mkdir -p /home/user/cache-benchmark /home/user/repository && cd /home/user/repository && git init -q && git remote add origin ${quote(`https://github.com/${repo.name}.git`)} && git fetch --depth 1 origin ${quote(repo.commit)} && git checkout -q --detach FETCH_HEAD`, { timeoutMs: 120_000, signal });
    for (const file of ['common.cjs', 'measure.cjs']) await sandbox.files.write(`/home/user/cache-benchmark/${file}`, fs.readFileSync(path.join(__dirname, 'sandbox-cache', file), 'utf8'));
    await sandbox.files.write('/home/user/cache-benchmark/repo.json', JSON.stringify(repo));
    await sandbox.commands.run('node /home/user/cache-benchmark/measure.cjs /home/user/cache-benchmark/repo.json', { timeoutMs: 12 * 60_000, signal });
    const result = JSON.parse(await sandbox.files.read('/home/user/cache-benchmark/result.json', { requestTimeoutMs: 15_000 }));
    return { repository: repo.name, commit: repo.commit, template, template_id: info.templateId, round, sandbox_id: sandbox.sandboxId,
      resources: { cpu: info.cpuCount, memory_mb: info.memoryMB }, ...result };
  } finally {
    // Only the sandbox created by THIS case; never a saved application run.
    if (sandbox) {
      try { await sandbox.kill({ requestTimeoutMs: 15_000 }); }
      catch (error) { throw new Error(`Could not clean up benchmark sandbox ${sandbox.sandboxId}; its 15-minute timeout remains in place`, { cause: error }); }
    }
  }
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
function summarize(results, baseline, candidate) {
  return [...new Set(results.map((row) => row.repository))].map((repository) => {
    const rows = results.filter((row) => row.repository === repository);
    const cold = rows.filter((row) => row.template === baseline), warm = rows.filter((row) => row.template === candidate);
    const signature = (row) => hash({ commit: row.commit, resources: row.resources, runtime: row.runtime, fingerprints: row.fingerprints });
    const comparable = cold.length > 0 && cold.length === warm.length && rows.every((row) => row.success
      && Number.isFinite(row.total_ms) && row.total_ms > 0 && row.resources?.cpu > 0 && row.resources?.memory_mb > 0
      && row.runtime?.node && row.runtime?.npm && row.runtime?.python
      && Object.keys(row.fingerprints || {}).length > 0
      && Object.values(row.fingerprints).every((entry) => /^[a-f0-9]{64}$/.test(entry.hash) && entry.packages > 0)
      && signature(row) === signature(rows[0]));
    return { repository, comparable, baseline_median_ms: cold.length ? median(cold.map((row) => row.total_ms)) : null,
      cached_median_ms: warm.length ? median(warm.map((row) => row.total_ms)) : null,
      saved_percent: comparable ? Math.round((1 - median(warm.map((row) => row.total_ms)) / median(cold.map((row) => row.total_ms))) * 1000) / 10 : null };
  });
}

async function main() {
  const { values } = parseArgs({ options: { baseline: { type: 'string', default: 'engelbart-runner' }, candidate: { type: 'string', default: 'engelbart-canvas-cached' },
    rounds: { type: 'string', default: '2' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('node scripts/benchmark-sandbox-cache.cjs [--baseline engelbart-runner] [--candidate engelbart-canvas-cached] [--rounds 2] [--output report.json]\nCreates fresh, short-lived E2B sandboxes (billed compute); no agents or application runs are started.'); return; }
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5 || values.baseline === values.candidate) throw new Error('Use 1–5 rounds and two different templates');
  validateProfile(profile);
  const { E2B_API_KEY: apiKey } = readSandboxEnv(path.join(os.homedir(), '.engelbart'));
  if (!apiKey) throw new Error('Set E2B_API_KEY in ~/.engelbart/sandbox.env');
  const output = values.output ? path.resolve(values.output) : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-cache-benchmark-')), 'report.json');
  const report = { benchmark_id: randomUUID(), started_at: new Date().toISOString(), profile: hash(profile), rounds,
    baseline: values.baseline, candidate: values.candidate, results: [], summary: [] };
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Benchmark interrupted'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const save = () => {
    report.summary = summarize(report.results, values.baseline, values.candidate);
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  };
  try {
    save();
    for (let round = 1; round <= rounds; round++) for (const repo of profile.repositories) {
      // Alternate ordering to reduce a consistent first-run/network timing bias.
      const order = round % 2 ? [values.baseline, values.candidate] : [values.candidate, values.baseline];
      for (const template of order) {
        console.log(`Round ${round}/${rounds}: ${repo.name} · ${template}`);
        const result = await runCase({ Sandbox, apiKey, template, repo, benchmarkId: report.benchmark_id, round, signal: controller.signal });
        report.results.push(result); save();
        console.log(JSON.stringify({ repository: repo.name, template, seconds: result.total_ms / 1000, success: result.success }));
        if (!result.success) throw new Error('An install failed; see the report before comparing timings');
        if (template === values.candidate && (result.cache?.seed_profile !== report.profile || result.cache?.npm_prefer_offline !== 'true')) {
          throw new Error('The candidate does not have this cache profile and persistent npm preference; rebuild it before comparing');
        }
      }
    }
    report.finished_at = new Date().toISOString(); save();
    console.log(JSON.stringify(report.summary, null, 2));
  } catch (error) {
    report.error = error.message; save(); throw error;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    console.log(`Benchmark report: ${output}`);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { runCase, summarize, median };
