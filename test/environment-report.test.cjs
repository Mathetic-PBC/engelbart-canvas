'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { environmentReport, environmentReportOf, environmentRows, describeEnvironment } = require('../src/shared/environment.cjs');

const scan = (variables) => ({ phase: 'environment', variables });
const variable = (name, status, group = 'required') => ({ name, status, group, requirement: group === 'required' ? 'required' : 'optional' });
const at = '2026-09-22T21:00:00.000Z';

test('a discovered environment exposes only bounded application names and status metadata', () => {
  const report = environmentReport({ ...scan([
    { ...variable('OPENAI_API_KEY', 'found'), value: 'private-key', default: 'private-default', source: '.env' },
    variable('NEXT_PUBLIC_API_URL', 'missing'),
    { ...variable('NEXT_PUBLIC_API_URL', 'found'), public: true },
    variable('HC_ENV_FILE', 'found'), variable('__proto__', 'found'), variable('BAD-NAME', 'missing'),
    null, { name: 'OPTION', status: 'invented', requirement: 'invented', group: 'invented' },
  ]), skipped: ['NEXT_PUBLIC_API_URL', null, 'BAD-NAME'], values: { OPENAI_API_KEY: 'private-key' } }, 'run-1', at);
  assert.deepEqual(report.variables.map((v) => v.name), ['OPENAI_API_KEY', 'NEXT_PUBLIC_API_URL', 'OPTION']);
  assert.equal(report.variables[1].status, 'missing', 'one component still needing a value must not be hidden by another');
  assert.equal(report.variables[2].status, 'uncertain');
  assert.equal(report.variables[2].requirement, 'unknown');
  assert.deepEqual(report.missing, ['NEXT_PUBLIC_API_URL']);
  assert.equal(JSON.stringify(report).includes('private-'), false);
  assert.equal(environmentReport({ phase: 'environment', warning: 'scan failed' }, 'run-1', at), null);
  assert.equal(environmentReport({ variables: [] }, 'run-1', at), null);
});

test('detected fields merge with saved names and drafts, with missing secrets first', () => {
  const report = environmentReport(scan([
    variable('PORT', 'optional', 'optional'), variable('OPENAI_API_KEY', 'missing'),
    variable('DATABASE_URL', 'local'), { ...variable('VITE_API_URL', 'found'), public: true, source: '.env.example' },
    variable('SAVED_KEY', 'missing'),
  ]), 'run-1', at);
  const drafts = { CUSTOM: 'new-value', OPENAI_API_KEY: 'typed-key' };
  const rows = environmentRows(report, ['SAVED_KEY', 'EXTRA_KEY'], Object.keys(drafts));
  assert.equal(rows[0].name, 'OPENAI_API_KEY');
  assert.equal(rows.filter((r) => r.name === 'OPENAI_API_KEY').length, 1);
  assert.equal(rows.length, 7);
  assert.deepEqual(drafts, { CUSTOM: 'new-value', OPENAI_API_KEY: 'typed-key' }, 'discovering fields does not create empty draft overrides');
  const row = (name) => rows.find((r) => r.name === name);
  assert.equal(describeEnvironment(row('OPENAI_API_KEY')), 'Required · no value');
  assert.equal(describeEnvironment(row('SAVED_KEY'), { pending: true }), 'Saved · used on the next launch');
  assert.equal(describeEnvironment(row('SAVED_KEY'), { removed: true }), 'Saved override removed');
  assert.equal(describeEnvironment(row('DATABASE_URL')), 'Provided by the sandbox');
  assert.equal(describeEnvironment(row('PORT')), 'Optional');
  assert.equal(row('VITE_API_URL').variable.public, true);
  assert.equal(describeEnvironment(row('VITE_API_URL')), 'Found in .env.example');
  assert.deepEqual(environmentRows(null, ['CUSTOM']), [{ name: 'CUSTOM', variable: null, saved: true }]);
});

test('legacy logs supply the last successful scan; a later empty scan clears old names', () => {
  const run = { id: 'old-run', build_log: [
    { time: at, data: scan([variable('OLD_KEY', 'missing')]) },
    { time: at, data: { phase: 'environment', warning: 'Could not scan again' } },
  ] };
  assert.equal(environmentReportOf(run).variables[0].name, 'OLD_KEY');
  run.build_log.push({ time: at, data: scan([]) });
  assert.deepEqual(environmentReportOf(run).variables, []);
  const persisted = environmentReport(scan([variable('RETAINED_KEY', 'found')]), run.id, at);
  assert.deepEqual(environmentReportOf({ ...run, build_log: [], env_report: persisted }), persisted);
  assert.equal(environmentReportOf({ id: 'unscanned', build_log: [] }), null);
});
