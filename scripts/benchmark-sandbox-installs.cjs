'use strict';

// Independent diagnostic harness; intentionally NOT wired into package.json or
// Canvas's app/worker. Only fresh, expiring test sandboxes can be accessed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { Sandbox } = require('e2b');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');
const { hash, quote, validateProfile } = require('./sandbox-cache/common.cjs');
const profile = require('./sandbox-cache/profile.json');
const REMOTE = '/home/user/install-diagnostics';

const ropeCases = [
  { id: 'runner-install', template: 'engelbart-runner', args: ['install', '--prefer-offline', '--timing'] },
  { id: 'cached-install', template: 'engelbart-canvas-cached', args: ['install', '--prefer-offline', '--timing'] },
  { id: 'cached-ci', template: 'engelbart-canvas-cached', args: ['ci', '--prefer-offline', '--timing'] },
  { id: 'cached-ci-no-audit', template: 'engelbart-canvas-cached', args: ['ci', '--prefer-offline', '--no-audit', '--timing'] },
];
const auditCases = [
  { id: 'audit-on', template: 'engelbart-runner', args: ['install', '--timing'] },
  { id: 'audit-off', template: 'engelbart-runner', args: ['install', '--no-audit', '--timing'] },
];
// Supplemental control: isolate cache benefit after the already-staged audit
// deferral, rather than attributing install/ci or audit differences to caching.
const cacheCases = [
  { id: 'runner-ci-no-audit', template: 'engelbart-runner', args: ['ci', '--prefer-offline', '--no-audit', '--timing'] },
  { ...ropeCases[3] },
];
function orderFor(round, cases) {
  const rotate = cases.length > 2 ? Math.floor((round - 1) / 2) % cases.length : 0;
  const order = [...cases.slice(rotate), ...cases.slice(0, rotate)];
  return round % 2 ? order : order.reverse();
}

async function copyArtifacts(sandbox, directory) {
  const listing = await sandbox.commands.run(`find ${REMOTE} -maxdepth 3 -type f`, { timeoutMs: 15_000 });
  const files = listing.stdout.trim().split('\n').filter(Boolean);
  const result = [];
  for (const file of files) {
    const relative = path.posix.relative(REMOTE, file);
    if (relative.startsWith('../') || path.isAbsolute(relative) || !/^[a-zA-Z0-9_./-]+$/.test(relative)) throw new Error('Unsafe artifact path');
    const data = await sandbox.files.read(file, { format: 'bytes', requestTimeoutMs: 30_000 });
    if (data.length > 32 * 1024 * 1024) throw new Error(`Artifact too large: ${relative}`);
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
    result.push({ file: relative, bytes: data.length });
  }
  return result;
}

async function trial({ apiKey, suite, repo, variant, round, directory, signal, onCreated, expectedResources, sandboxApi = Sandbox }) {
  let sandbox;
  const record = { repository: repo.name, commit: repo.commit, case: variant.id, template: variant.template, round,
    artifact_directory: path.basename(directory), started_at: new Date().toISOString() };
  try {
    signal.throwIfAborted();
    sandbox = await sandboxApi.create(variant.template, { apiKey, timeoutMs: 15 * 60_000, requestTimeoutMs: 60_000,
      metadata: { app: 'engelbart-install-diagnostics', benchmarkId: path.basename(directory), repo: repo.name } });
    record.sandbox_id = sandbox.sandboxId;
    onCreated(record);
    const info = await sandbox.getInfo({ requestTimeoutMs: 15_000 });
    record.template_id = info.templateId;
    record.resources = { cpu: info.cpuCount, memory_mb: info.memoryMB };
    if (expectedResources && JSON.stringify(record.resources) !== JSON.stringify(expectedResources)) throw new Error('Template resources differ; trial excluded');
    await sandbox.commands.run(`mkdir -p ${REMOTE} /home/user/repository && cd /home/user/repository && git init -q && git remote add origin ${quote(`https://github.com/${repo.name}.git`)} && git fetch --depth 1 origin ${quote(repo.commit)} && git checkout -q --detach FETCH_HEAD`, { timeoutMs: 120_000, signal });
    await sandbox.files.write(`${REMOTE}/npm.cjs`, fs.readFileSync(path.join(__dirname, 'sandbox-diagnostics/npm.cjs'), 'utf8'));
    await sandbox.files.write(`${REMOTE}/spec.json`, JSON.stringify({ repo, args: variant.args, preferOffline: suite !== 'audit', resourceStats: suite !== 'audit', verify: round === (suite === 'audit' ? 2 : 3) }));
    try { await sandbox.commands.run(`node ${REMOTE}/npm.cjs`, { timeoutMs: 13 * 60_000, signal }); }
    catch (error) { record.diagnostic_error = String(error.message).slice(-2000); }
    record.artifacts = await copyArtifacts(sandbox, directory);
    const measurement = path.join(directory, 'measurement.json');
    if (!fs.existsSync(measurement)) throw new Error('Diagnostic did not produce a measurement report');
    record.measurement = JSON.parse(fs.readFileSync(measurement, 'utf8'));
    return record;
  } catch (error) {
    record.diagnostic_error = String(error.message).slice(-2000);
    return record;
  } finally {
    if (sandbox) {
      try { await sandbox.kill({ requestTimeoutMs: 15_000 }); record.cleaned_up = true; }
      catch (error) { record.cleaned_up = false; record.cleanup_error = `Could not clean up ${sandbox.sandboxId}; 15-minute TTL remains. ${error.message}`; }
    }
    record.finished_at = new Date().toISOString();
  }
}

async function main() {
  const { values } = parseArgs({ options: { suite: { type: 'string', default: 'rope' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('node scripts/benchmark-sandbox-installs.cjs --suite audit|rope|cache --output NEW_DIRECTORY\nAudit: Rope + Cocoa, 2 trials/case. Rope: the four requested cases, 3 trials/case. Cache: Rope ci/no-audit on both templates, 3 trials/case. Fresh billed E2B sandboxes only; no app/template/config changes.');
    return;
  }
  if (!['audit', 'rope', 'cache'].includes(values.suite) || !values.output) throw new Error('Specify --suite audit|rope|cache and a new --output directory');
  validateProfile(profile);
  const output = path.resolve(values.output);
  if (fs.existsSync(output)) throw new Error('Output directory already exists; do not overwrite prior evidence');
  fs.mkdirSync(output, { recursive: true });
  const { E2B_API_KEY: apiKey } = readSandboxEnv(path.join(os.homedir(), '.engelbart'));
  if (!apiKey) throw new Error('E2B_API_KEY is unavailable');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Benchmark interrupted'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const suite = values.suite, rounds = suite === 'audit' ? 2 : 3;
  const cases = suite === 'rope' ? ropeCases : suite === 'cache' ? cacheCases : auditCases;
  const repos = profile.repositories.filter((r) => suite !== 'audit' ? r.name === 'mqo00/rope' : r.name !== 'mqo00/hypocompass');
  const report = { id: randomUUID(), suite, started_at: new Date().toISOString(), rounds, profile_hash: hash(profile),
    cases, schedule: [], trials: [], notes: ['Sequential fresh sandboxes; reverse alternate rounds, rotate the third.',
      'Cold node_modules in every trial. Published cache contents are neither cleaned nor changed.',
      'Lifecycle scripts/devDependencies enabled. Isolated identical npm user/global config; audit/command/cache are treatment variables.',
      'Wall time excludes clone, diagnostics, package fingerprinting and startup. Never fall back from ci.'] };
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  try {
    for (let round = 1; round <= rounds; round++) for (const repo of repos) for (const variant of orderFor(round, cases)) report.schedule.push({ round, repo: repo.name, case: variant.id });
    save();
    for (const scheduled of report.schedule) {
      controller.signal.throwIfAborted();
      const repo = repos.find((r) => r.name === scheduled.repo), variant = cases.find((c) => c.id === scheduled.case);
      const directory = path.join(output, `${repo.name.replace('/', '--')}-r${scheduled.round}-${variant.id}`);
      fs.mkdirSync(directory);
      console.log(`Trial ${report.trials.length + 1}/${report.schedule.length}: ${repo.name}, round ${scheduled.round}, ${variant.id}`);
      const result = await trial({ apiKey, suite, repo, variant, round: scheduled.round, directory, signal: controller.signal,
        expectedResources: report.resources, onCreated: (record) => { report.active_trial = { ...record }; save(); } });
      report.resources ||= result.resources;
      report.trials.push(result); delete report.active_trial; save();
      console.log(JSON.stringify({ case: result.case, repo: result.repository, seconds: result.measurement?.wall_ms / 1000,
        exit: result.measurement?.exit_code, startup: result.measurement?.startup?.ok, error: result.diagnostic_error, cleaned_up: result.cleaned_up }));
      if (!result.cleaned_up) throw new Error(result.cleanup_error || 'Test sandbox cleanup unconfirmed');
      if (result.diagnostic_error) throw new Error('Diagnostic failed; see saved evidence. No replacement install attempted.');
    }
    report.finished_at = new Date().toISOString(); save();
  } catch (error) { report.error = error.message; save(); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); console.log(`Evidence: ${output}`); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { orderFor, ropeCases, auditCases, cacheCases, trial };
