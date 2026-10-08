'use strict';

// Post-process immutable trial evidence; never connects to E2B or calls a model.
const fs = require('node:fs');
const path = require('node:path');
const { median } = require('./summarize.cjs');
const { unionDuration } = require('./summarize-e2e.cjs');

function summarizeLaunch(report, directory) {
  const rows = report.trials.map(run => {
    const events = fs.readFileSync(path.join(directory, run.artifact_directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const discovery = events.find(e => e.data?.source === 'railpack' && e.data?.status !== 'running')?.data;
    const jobs = (run.phases?.installs || []).filter(j => j.status === 'succeeded');
    const first = jobs.length ? Math.min(...jobs.map(j => j.started_ms)) : null;
    const last = jobs.length ? Math.max(...jobs.map(j => j.finished_ms)) : null;
    const tools = run.agent?.tool_calls || [];
    const launches = tools.filter(t => t.name === 'mcp__canvas__start_app');
    const verified = launches.find(t => t.is_error === false && Number.isFinite(t.finished_ms));
    return { repository: run.repository, variant: run.variant, round: run.round, status: run.status,
      total_ms: run.end_to_end_ms, preview_only_ms: run.preview_only_ms, worker_ready_ms: run.worker_ready_ms,
      agent_started_ms: run.agent?.started_ms, agent_wall_ms: run.agent?.wall_ms,
      cli_api_ms: run.agent?.cli_result?.duration_api_ms, prompt_bytes: run.agent?.prompt_bytes,
      discovery_ms: discovery?.elapsed_ms ?? 0, discovery_context_bytes: discovery?.context_bytes ?? 0,
      railpack_raw_bytes: discovery?.components.reduce((sum, c) => sum + (c.raw_bytes || 0), 0) ?? 0,
      first_install_ms: first, last_install_ms: last,
      agent_before_first_install_ms: first === null ? null : first - run.agent?.started_ms,
      install_ms: unionDuration(jobs.map(j => [j.started_ms, j.finished_ms])),
      last_install_to_launch_ms: last === null ? null : run.phases.first_app_start_ms - last,
      launch_requested_during_install: !!(launches[0] && last !== null && launches[0].started_ms < last),
      launch_to_verified_tool_ms: verified ? verified.finished_ms - run.phases.first_app_start_ms : null,
      verified_tool_to_ready_ms: verified ? run.worker_ready_ms - verified.finished_ms : null,
      agent_finished_after_ready_ms: run.agent?.finished_ms - run.worker_ready_ms,
      tools: tools.length, launch_attempts: launches.length, ready_events: events.filter(e => e.event === 'ready').length,
      services_check: run.services_check, tracked_changes: run.installed?.install_changes,
      cleaned_up: run.cleaned_up, directory: run.artifact_directory };
  });
  const fields = ['total_ms', 'agent_wall_ms', 'cli_api_ms', 'agent_started_ms', 'agent_before_first_install_ms',
    'install_ms', 'last_install_to_launch_ms', 'launch_to_verified_tool_ms', 'verified_tool_to_ready_ms',
    'agent_finished_after_ready_ms', 'discovery_ms', 'discovery_context_bytes', 'prompt_bytes', 'tools'];
  return { rows, repositories: report.repositories.map(repo => ({ repository: repo.name,
    variants: ['baseline', 'optimized'].map(variant => {
      const selected = rows.filter(r => r.repository === repo.name && r.variant === variant);
      const ok = selected.filter(r => r.status === 'ready');
      return { variant, trials: selected.length, successful: ok.length,
        early_handoffs: ok.filter(r => r.launch_requested_during_install).length,
        medians: Object.fromEntries(fields.map(f => [f, median(ok.map(r => r[f]).filter(Number.isFinite))])) };
    }) })), notes: [
    'Independent medians are not additive. Agent time overlaps installs and tool waits; CLI API time is not pure thinking time.',
    'A small negative verified-tool-to-ready time is expected: early ready is emitted before MCP returns the tool result.',
    'Discovery wall time includes upload/transport; raw Railpack bytes are its formatted JSON, while context is compact JSON plus manifest facts.',
    'No causal per-feature gain can be isolated by this two-bundle comparison. Timing variation and package/source differences remain visible.',
  ] };
}
if (require.main === module) {
  const file = path.resolve(process.argv[2]), directory = path.dirname(file);
  const summary = summarizeLaunch(JSON.parse(fs.readFileSync(file, 'utf8')), directory);
  fs.writeFileSync(path.join(directory, 'launch-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary.repositories, null, 2));
}
module.exports = { summarizeLaunch };
