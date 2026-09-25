'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { median, canonical } = require('./summarize.cjs');
const { unionDuration } = require('./summarize-e2e.cjs');

function comparableSignature(run) {
  const installed = run.installed;
  if (!installed || run.artifact_error || installed.install_changes !== '' || run.commit !== run.pinned_commit ||
      !run.agent?.models?.length || !run.resources?.cpu || !installed.node || !installed.npm || !installed.python) return null;
  const fingerprints = Object.fromEntries(Object.entries(installed.packages || {}).map(([key, value]) => [key, value.fingerprint]));
  if (!Object.keys(fingerprints).length || Object.values(fingerprints).some(p => !p?.packages || p.version_mismatches)) return null;
  return JSON.stringify(canonical({ commit: run.commit, resources: run.resources,
    node: installed.node, npm: installed.npm, python: installed.python, platform: installed.platform, arch: installed.arch,
    manifests: installed.manifest_hashes, packages: fingerprints, models: run.agent?.models }));
}

function summarize(report) {
  const repositories = report.repositories.map(repo => {
    const runs = report.trials.filter(r => r.repository === repo.name), success = runs.filter(r => r.status === 'ready');
    const signatures = success.map(comparableSignature);
    const comparable = success.length > 0 && signatures.every(s => s && s === signatures[0]);
    const variants = ['baseline', 'optimized'].map(variant => {
      const all = runs.filter(r => r.variant === variant), ok = all.filter(r => r.status === 'ready');
      const rows = all.map(r => {
        const jobs = r.phases?.installs || [], complete = jobs.filter(j => j.status === 'succeeded');
        const lastInstall = complete.length ? Math.max(...complete.map(j => j.finished_ms)) : null;
        const launches = (r.agent?.tool_calls || []).filter(t => t.name === 'mcp__canvas__start_app');
        const startTool = launches[0];
        const verifiedLaunch = launches.find(t => t.is_error === false && Number.isFinite(t.finished_ms));
        return { round: r.round, status: r.status, total_ms: r.end_to_end_ms ?? null, failure_ms: r.failure_ms ?? null,
          agent_ms: r.agent?.wall_ms ?? null, cli_api_ms: r.agent?.cli_result?.duration_api_ms ?? null,
          tool_roundtrip_union_ms: unionDuration((r.agent?.tool_calls || []).map(t => [t.started_ms, t.finished_ms])),
          installs: jobs, install_job_union_ms: unionDuration(jobs.map(j => [j.started_ms, j.finished_ms])),
          last_install_to_launch_ms: lastInstall !== null && Number.isFinite(r.phases?.first_app_start_ms) ? r.phases.first_app_start_ms - lastInstall : null,
          launch_request_before_install_end: !!(startTool && lastInstall !== null && startTool.started_ms < lastInstall),
          launch_wait_requested: startTool?.wait_for_install ?? false,
          launch_attempts: launches.length, failed_launch_attempts: launches.filter(t => t.is_error).length,
          first_verified_launch_ms: verifiedLaunch?.finished_ms ?? null,
          verified_launch_to_worker_ready_ms: verifiedLaunch && Number.isFinite(r.worker_ready_ms)
            ? r.worker_ready_ms - verifiedLaunch.finished_ms : null,
          parallel_install_used: jobs.some(j => j.command?.startsWith('Parallel dependency installs:')),
          tool_count: r.agent?.tool_calls.length ?? null, usage: r.agent?.cli_result?.usage,
          public_check: r.public_check, cleaned_up: r.cleaned_up, error: r.error || null,
          preview_only_ms: r.preview_only_ms, services_check: r.services_check, prompt_bytes: r.agent?.prompt_bytes,
          tracked_source_changes: r.installed?.install_changes ?? null,
          artifact_error: r.artifact_error || null, directory: r.artifact_directory };
      });
      return { variant, successes: ok.length, trials: all.length, rows,
        median_ms: median(ok.map(r => r.end_to_end_ms)),
        mean_ms: ok.length ? ok.reduce((n, r) => n + r.end_to_end_ms, 0) / ok.length : null,
        median_install_job_union_ms: median(rows.filter(r => r.status === 'ready').map(r => r.install_job_union_ms)),
        median_agent_ms: median(ok.map(r => r.agent?.wall_ms)) };
    });
    const [baseline, optimized] = variants;
    const allSucceeded = runs.length === report.rounds * 2 && runs.every(r => r.status === 'ready');
    return { repository: repo.name, comparable_successful_artifacts: comparable, all_succeeded: allSucceeded, variants,
      median_reduction_ms: comparable && baseline.median_ms !== null && optimized.median_ms !== null ? baseline.median_ms - optimized.median_ms : null,
      percent_reduction: comparable && baseline.median_ms > 0 && optimized.median_ms !== null ? 100 * (baseline.median_ms - optimized.median_ms) / baseline.median_ms : null };
  });
  return { complete: !!report.finished_at, baseline_kind: report.baseline_kind, repositories,
    trials: report.trials.length, all_test_sandboxes_cleaned_up: report.trials.every(r => r.cleaned_up),
    notes: ['End-to-end means worker request through independent HTTP 200 HTML preview; Electron UI/IPC and backend feature correctness are not measured.',
      report.baseline_kind === 'current' ? 'Frozen pre-change optimized baseline and new implementation both use the cached template; this is an incremental comparison.' : report.baseline_kind === 'historical'
        ? 'Exact earliest local-Claude Git sources; this historical baseline already overlaps installation with inspection and is not fully unoptimized.'
        : 'Reconstructed sequential baseline is an explicit ablation, not an exact historical application version.',
      'Agent time overlaps installs/tool waits. CLI API duration is not pure thinking time. Do not sum phases.',
      'Each median uses successful trials; failures and success counts remain visible. Do not call a faster failure an improvement.',
      'Three trials per case are a small sample. Claude decisions, prompt cache, network and service latency vary.',
      'A feature being enabled is not proof the agent used it; parallel install and early handoff usage are recorded.'] };
}

if (require.main === module) {
  const file = path.resolve(process.argv[2]), summary = summarize(JSON.parse(fs.readFileSync(file, 'utf8')));
  fs.writeFileSync(path.join(path.dirname(file), 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
module.exports = { summarize, comparableSignature };
