'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../sandbox-cache/common.cjs');
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function configuration(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete config.audit; // deliberate treatment variable, not a hidden confounder
  return hash(JSON.stringify(canonical(config)));
}
function httpEvidence(directory) {
  const debug = fs.readdirSync(path.join(directory, 'npm-logs')).filter((f) => f.endsWith('-debug-0.log'))
    .map((f) => fs.readFileSync(path.join(directory, 'npm-logs', f), 'utf8')).join('\n');
  const records = [];
  for (const line of debug.split('\n')) {
    const match = /\bhttp fetch (\S+) (\d+) (\S+) (\d+)ms(.*)/.exec(line);
    if (!match) continue;
    const [, method, status, url, duration, extra] = match;
    records.push({ method, status: Number(status), url, duration_ms: Number(duration),
      tarball: /\.tgz(?:\?|$)/.test(url), cache: /cache (hit|miss|revalidated)/.exec(extra)?.[1] || null });
  }
  return { fetch_lines: records.length, tarball_fetch_lines: records.filter((r) => r.tarball).length,
    tarball_cache_misses: records.filter((r) => r.tarball && r.cache === 'miss').length,
    metadata_or_audit_fetch_lines: records.filter((r) => !r.tarball).length,
    longest_tarball_ms: Math.max(0, ...records.filter((r) => r.tarball).map((r) => r.duration_ms)),
    hosts: Object.fromEntries([...new Set(records.map((r) => new URL(r.url).hostname))].sort().map((host) => [host, records.filter((r) => new URL(r.url).hostname === host).length])),
    note: 'Counts are log records, not a packet trace. http cache labels are excluded: a cold run also emits those before a later tarball cache-miss fetch.' };
}
function summarize(report, directory) {
  const repositories = [];
  for (const name of [...new Set(report.trials.map((t) => t.repository))]) {
    const trials = report.trials.filter((t) => t.repository === name);
    const signatures = trials.map((t) => {
      const m = t.measurement;
      if (!m || m.exit_code !== 0 || !m.fingerprint?.packages || m.fingerprint.version_mismatches || t.diagnostic_error || !t.cleaned_up) return null;
      return hash(JSON.stringify(canonical({ commit: t.commit, resources: t.resources, runtime: m.runtime,
        fingerprint: m.fingerprint, input_hashes: m.input_hashes, after_hashes: m.after_hashes,
        install_changes: m.install_changes,
        config: configuration(path.join(directory, t.artifact_directory, 'npm-config.json')) })));
    });
    const comparable = signatures.every((s) => s && s === signatures[0]);
    const cases = report.cases.map((c) => {
      const rows = trials.filter((t) => t.case === c.id);
      const measurements = rows.map((t) => t.measurement).filter(Boolean);
      const http = rows.filter((t) => t.measurement).map((t) => httpEvidence(path.join(directory, t.artifact_directory)));
      const timer = (key) => median(measurements.map((m) => m.analysis.timers_ms[key]));
      return { case: c.id, template: c.template, command: ['npm', ...c.args],
        trials_ms: measurements.map((m) => m.wall_ms), median_ms: median(measurements.map((m) => m.wall_ms)),
        mean_ms: measurements.length ? measurements.reduce((sum, m) => sum + m.wall_ms, 0) / measurements.length : null,
        exit_codes: measurements.map((m) => m.exit_code),
        timer_medians_ms: Object.fromEntries(['idealTree', 'reify:loadTrees', 'reify:unpack', 'reify:build', 'reify:audit', 'auditReport:getReport', 'auditReport:init', 'reify:save', 'reify', 'npm'].map((key) => [key, timer(key)])),
        user_cpu_median_seconds: median(measurements.map((m) => m.resources?.user_seconds)),
        system_cpu_median_seconds: median(measurements.map((m) => m.resources?.system_seconds)),
        output_blocks_median: median(measurements.map((m) => m.resources?.output_blocks)),
        http, fingerprints: [...new Set(measurements.map((m) => m.fingerprint?.hash))],
        startup: rows.filter((t) => t.measurement?.startup).map((t) => ({ round: t.round, ...t.measurement.startup })),
        cleaned_up: rows.every((t) => t.cleaned_up) };
    });
    repositories.push({ repository: name, comparable,
      inputs_unchanged: trials.every((t) => t.measurement && !t.measurement.install_changes &&
        JSON.stringify(canonical(t.measurement.input_hashes)) === JSON.stringify(canonical(t.measurement.after_hashes))),
      note: 'Comparability requires matching before AND after manifest hashes. npm install may rewrite a lockfile identically across treatments; inputs_unchanged reports that separately.',
      signatures, cases });
  }
  return { suite: report.suite, complete: !!report.finished_at, repositories,
    notes: ['Durations are install-only, not end-to-end preview latency.', 'Nested/concurrent npm timers and request durations must not be added.',
      'CPU and IO counters, when present, cover the entire npm process tree; they do not isolate phases. No /usr/bin/time was present for the earlier audit comparison.'] };
}

if (require.main === module) {
  for (const input of process.argv.slice(2)) {
    const file = path.resolve(input), directory = path.dirname(file);
    const result = summarize(JSON.parse(fs.readFileSync(file, 'utf8')), directory);
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ file: path.join(directory, 'summary.json'), complete: result.complete,
      repositories: result.repositories.map((repo) => ({ repository: repo.repository, comparable: repo.comparable,
        cases: repo.cases.map((c) => ({ case: c.case, trials_ms: c.trials_ms, median_ms: c.median_ms, exit_codes: c.exit_codes })) })) }));
  }
}
module.exports = { median, canonical, httpEvidence, summarize };
