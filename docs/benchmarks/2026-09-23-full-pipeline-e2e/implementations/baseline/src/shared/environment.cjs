'use strict';

// The same scan metadata used by engelbart-web's Environment tab. Values
// stay in the encrypted store; a report contains names and statuses only.
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED = /^(?:HC_|HUMAN_COMPACT_|ENGELBART_CANVAS_|ELECTRON_)/;
const isEnvironmentName = (name) => typeof name === 'string' && NAME.test(name)
  && !RESERVED.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
const STATUSES = new Set(['missing', 'found', 'provided', 'local', 'optional', 'uncertain', 'not_applicable']);
const REQUIREMENTS = new Set(['required', 'optional', 'unknown']);
const GROUPS = new Set(['required', 'optional', 'other', 'unresolved']);
const names = (list) => [...new Set((Array.isArray(list) ? list : []).filter(isEnvironmentName))].slice(0, 500);

function environmentReport(event, runId, at) {
  if (event?.phase !== 'environment' || !Array.isArray(event.variables)) return null;
  const variables = new Map();
  for (const variable of event.variables.slice(0, 500)) {
    if (!isEnvironmentName(variable?.name)) continue;
    if (variables.get(variable.name)?.status === 'missing') continue;
    variables.set(variable.name, {
      name: variable.name,
      status: STATUSES.has(variable.status) ? variable.status : 'uncertain',
      requirement: REQUIREMENTS.has(variable.requirement) ? variable.requirement : 'unknown',
      group: GROUPS.has(variable.group) ? variable.group : 'unresolved',
      source: typeof variable.source === 'string' ? variable.source.slice(0, 256) : null,
      public: !!variable.public,
    });
  }
  return {
    variables: [...variables.values()], missing: names(event.skipped),
    local: names(event.local),
    scannedAt: at, runId,
  };
}

function environmentReportOf(run) {
  if (!run) return null;
  if (run.env_report) return run.env_report;
  // Runs made before reports were stored separately can still supply their scan.
  for (const entry of [...(run.build_log || [])].reverse()) {
    const report = environmentReport(entry.data, run.id, entry.time);
    if (report) return report;
  }
  return null;
}

function environmentRows(report, savedNames = [], draftNames = []) {
  const saved = new Set(savedNames);
  const rows = new Map((report?.variables || []).map((variable) => [variable.name, { name: variable.name, variable, saved: saved.has(variable.name) }]));
  for (const name of [...savedNames, ...draftNames]) {
    if (!rows.has(name)) rows.set(name, { name, variable: null, saved: saved.has(name) });
  }
  const rank = (row) => row.variable?.status === 'missing' && !row.saved ? 0
    : row.variable?.group === 'unresolved' && !row.saved ? 1
    : row.saved ? 2 : row.variable?.status === 'found' ? 3
    : row.variable?.group === 'other' ? 5 : 4;
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function describeEnvironment(row, { pending = false, removed = false } = {}) {
  if (removed) return 'Saved override removed';
  if (row.saved) return pending ? 'Saved · used on the next launch' : 'Saved';
  const variable = row.variable;
  if (!variable) return 'New variable';
  switch (variable.status) {
    case 'missing': return 'Required · no value';
    case 'provided': return 'Provided to the last launch';
    case 'local': return 'Provided by the sandbox';
    case 'found': return variable.source ? `Found in ${variable.source}` : 'Found in the repository';
    case 'optional': return 'Optional';
    case 'not_applicable': return 'Not used by this launch';
    default: return variable.requirement === 'required' ? 'Required · unresolved' : 'Needs a value check';
  }
}

module.exports = { isEnvironmentName, environmentReport, environmentReportOf, environmentRows, describeEnvironment };
