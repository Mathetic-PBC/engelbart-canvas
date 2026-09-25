'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { median, canonical } = require('./summarize.cjs');

function unionDuration(intervals) {
  const sorted = intervals.filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a,b)=>a[0]-b[0]);
  let total = 0, start = null, end = null;
  for (const [a,b] of sorted) {
    if (start === null) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b);
    else { total += end-start; start = a; end = b; }
  }
  return total + (start === null ? 0 : end-start);
}
function summarize(report) {
  const rows = report.trials.map((r) => ({ template: r.template, round: r.round, status: r.status,
    total_ms: r.end_to_end_ms ?? null, worker_ready_ms: r.worker_ready_ms ?? null,
    auth_ms: r.phases.auth_ms, detection_and_creation_ms: r.phases.detection_and_creation_ms, clone_ms: r.phases.clone_ms,
    agent_ms: r.agent?.wall_ms ?? null, cli_api_ms: r.agent?.cli_result?.duration_api_ms ?? null,
    tool_roundtrip_union_ms: unionDuration((r.agent?.tool_calls || []).map(t=>[t.started_ms,t.finished_ms])),
    tool_count: r.agent?.tool_calls.length ?? null, start_to_ready_ms: r.phases.first_start_to_ready_ms,
    installs: r.phases.installs, models: r.agent?.models, usage: r.agent?.cli_result?.usage,
    fingerprint: r.installed?.fingerprint, tracked_changes: r.installed?.install_changes,
    error: r.error || null, cleaned_up: r.cleaned_up }));
  const success = report.trials.filter((r)=>r.status==='ready');
  const signatures = success.map(r=>JSON.stringify(canonical({ commit:r.commit, hardware:r.resources,
    node:r.installed?.node,npm:r.installed?.npm,arch:r.installed?.arch,platform:r.installed?.platform,
    packages:r.installed?.fingerprint,manifests:r.installed?.manifest_hashes,models:r.agent?.models,
    sourceChanges:r.installed?.install_changes })));
  const comparable = success.length > 0 && success.every(r=>r.installed?.fingerprint?.packages && !r.installed.fingerprint.version_mismatches && !r.artifact_error)
    && signatures.every(s=>s===signatures[0]);
  const cases = [...new Set(rows.map(r=>r.template))].map(template=>{
    const all=rows.filter(r=>r.template===template), ok=all.filter(r=>r.status==='ready');
    return { template, successes:ok.length,trials:all.length,
      medians_ms:Object.fromEntries(['total_ms','worker_ready_ms','auth_ms','detection_and_creation_ms','clone_ms','agent_ms','cli_api_ms','tool_roundtrip_union_ms','start_to_ready_ms']
        .map(k=>[k,median(ok.map(r=>r[k]))])),
      installs:ok.map(r=>r.installs.map(i=>({command:i.command,status:i.status,elapsed_ms:i.elapsed_ms}))),
      mean_total_ms:ok.length?ok.reduce((n,r)=>n+r.total_ms,0)/ok.length:null };
  });
  return { complete:!!report.finished_at, successful_artifacts_comparable:comparable, cases, rows,
    notes:['This is real-agent worker-request-to-public-preview time, not Electron UI/library/IPC/paint time.',
      'Agent wall time includes tool waits and overlaps install/startup. CLI API duration is not pure thinking; do not add these phases.',
      'Tool round-trip union avoids double counting simultaneous tool requests, but includes local queue/CLI/transport overhead.',
      'Fresh sandboxes do not reset Claude prompt caches. Cache token usage is retained; sampling, service latency, and agent decisions may differ.',
      'Comparability checks source revision, hardware, runtimes, actual model, installed packages and manifest hashes—not identical agent trajectories.',
      'Medians include successful trials only; all failures remain in rows and success counts.'] };
}
if(require.main===module){
  const file=path.resolve(process.argv[2]), result=summarize(JSON.parse(fs.readFileSync(file,'utf8')));
  fs.writeFileSync(path.join(path.dirname(file),'summary.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({complete:result.complete,comparable:result.successful_artifacts_comparable,cases:result.cases}));
}
module.exports={unionDuration,summarize};
