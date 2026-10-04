'use strict';

// Full agent-inclusive bundle comparison. Diagnostic snapshots only; never
// switches the working tree or user configuration, and never reconnects to previews.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { trial } = require('./benchmark-sandbox-e2e.cjs');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');
const { hash, validateProfile } = require('./sandbox-cache/common.cjs');
const { snapshot, copyFrozen, loadImplementation } = require('./sandbox-diagnostics/implementations.cjs');
const { collectArtifacts } = require('./sandbox-diagnostics/pipeline-artifacts.cjs');
const { verifyServices } = require('./sandbox-diagnostics/verify-services.cjs');
const { summarize } = require('./sandbox-diagnostics/summarize-pipeline.cjs');
const profile = require('./sandbox-cache/profile.json');

function schedule(repositories, rounds) {
  const result = [];
  for (let round = 1; round <= rounds; round++) {
    const rotate = (round - 1) % repositories.length;
    const order = [...repositories.slice(rotate), ...repositories.slice(0, rotate)];
    for (const repo of order) for (const variant of round % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']) {
      result.push({ round, repository: repo.name, variant });
    }
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, baseline: { type: 'string' },
    'baseline-snapshot': { type: 'string' },
    rounds: { type: 'string', default: '3' }, repo: { type: 'string' }, 'prepare-only': { type: 'boolean' } } });
  const rounds = Number(values.rounds);
  if (!values.output || !['sequential', 'historical', 'current'].includes(values.baseline) || (values.baseline === 'current' && !values['baseline-snapshot']) || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
    throw new Error('Use --output NEW_DIRECTORY --baseline sequential|historical|current [--baseline-snapshot MANIFEST] [--rounds 1..3] [--repo owner/name] [--prepare-only]');
  }
  validateProfile(profile);
  const repos = profile.repositories.filter(r => !values.repo || r.name === values.repo);
  if (!repos.length) throw new Error('Repository is not in the pinned profile');
  const output = path.resolve(values.output);
  if (fs.existsSync(output)) throw new Error('Output directory already exists; preserve previous evidence');
  const environment = { ...process.env, ...readSandboxEnv(path.join(os.homedir(), '.engelbart')) };
  if (!values['prepare-only'] && !environment.E2B_API_KEY) throw new Error('E2B_API_KEY unavailable');
  fs.mkdirSync(output, { recursive: true });
  const implementations = {
    baseline: values.baseline === 'current' ? copyFrozen(path.join(output, 'implementations/baseline'), values['baseline-snapshot']) : snapshot(path.join(output, 'implementations/baseline'), values.baseline),
    optimized: snapshot(path.join(output, 'implementations/optimized'), 'optimized'),
  };
  const loaded = Object.fromEntries(Object.entries(implementations).map(([name, info]) => [name, loadImplementation(info.directory, info.kind)]));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Benchmark interrupted'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const report = { started_at: new Date().toISOString(), baseline_kind: values.baseline, rounds, repositories: repos,
    profile_hash: hash(profile), implementations, schedule: schedule(repos, rounds), trials: [],
    methodology: [
      values.baseline === 'current' ? 'Byte-identical pre-change optimized snapshot supplied by manifest, verified against hashes. Both variants use engelbart-canvas-cached; measures incremental changes only.'
        : values.baseline === 'sequential' ? 'Reconstructed sequential baseline: same current safety/supervision, no warm cache, inline npm audit, agent-selected blocking sequential installs, no install/inspection overlap or early handoff. Not an exact historical version.'
        : 'Exact earliest committed local-Claude snapshot. Already has deterministic/overlapped installation; therefore not a fully unoptimized baseline.',
      'Optimized: frozen working implementation, including Railpack-assisted compact launch discovery before Claude and immediate publication after verified launch; previously enabled install/cache optimizations retained.',
      'Fresh sequential E2B instances; alternate baseline/optimized order by round; rotate repository order. 8 CPU / 8192 MiB required.',
      'Same pinned repository revision asserted after normal clone. Same local Claude subscription/CLI and configured model, the only setup provider.',
      'Clock covers worker request to ready plus independent public HTTP 200 HTML and required local service checks. Preview-only timing also recorded. Artifacts, final agent-summary drain and cleanup excluded. No UI/IPC/browser-paint timing.',
      'Cocoa requires /api/health on owned port 3001; Hypocompass requires its owned Flask listener and login page on 8090, as in the pinned source. These checks do not verify credential-dependent backend features or frontend-to-backend routing.',
      'Existing user previews, configuration, repository worktree and published templates are never modified.',
    ] };
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  try {
    save();
    if (values['prepare-only']) { console.log(`Prepared without creating sandboxes: ${output}`); return; }
    for (const item of report.schedule) {
      controller.signal.throwIfAborted();
      const repository = repos.find(r => r.name === item.repository);
      const directory = path.join(output, `${repository.name.replace('/', '--')}-r${item.round}-${item.variant}`);
      fs.mkdirSync(directory);
      console.log(`Trial ${report.trials.length + 1}/${report.schedule.length}: ${repository.name}, ${item.variant}, round ${item.round}`);
      const result = await trial({ ...loaded[item.variant], repository,
        template: item.variant === 'baseline' && values.baseline !== 'current' ? 'engelbart-runner' : 'engelbart-canvas-cached',
        round: item.round, directory, environment, signal: controller.signal, collectArtifacts, verifyServices,
        onCreated(record) {
          record.variant = item.variant; record.baseline_kind = values.baseline;
          record.artifact_directory = path.basename(directory);
          report.active_trial = { ...item, sandbox_id: record.sandbox_id }; save();
        },
      });
      result.variant = item.variant; result.artifact_directory = path.basename(directory);
      report.trials.push(result); delete report.active_trial; save();
      console.log(JSON.stringify({ repo: repository.name, variant: item.variant, status: result.status,
        seconds: result.end_to_end_ms / 1000, failure_seconds: result.failure_ms / 1000,
        cleaned_up: result.cleaned_up, error: result.error, artifact_error: result.artifact_error }));
      if (!result.cleaned_up) throw new Error('Owned test sandbox cleanup unconfirmed; stopping the suite');
      if (result.error && /Sign in to your Claude subscription|Claude Code was not found|Update Claude Code|hit your (?:usage )?limit|rate.?limit|Remote HEAD changed|Hardware differs|Unexpected template/i.test(result.error)) {
        throw new Error('Benchmark stopped for comparability/provider issue; retained failure evidence.');
      }
    }
    report.finished_at = new Date().toISOString(); save();
  } catch (error) { report.error = error.message; save(); throw error; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summarize(report), null, 2));
    console.log(`Evidence: ${output}`);
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { schedule };
