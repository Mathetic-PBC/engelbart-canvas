'use strict';

// Recheck the diagnostic's IPv4/IPv6 startup probe on one fresh Cocoa sandbox.
// Not part of the audit comparison's two-trial install averages.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { readSandboxEnv } = require('../../src/main/sandbox/config.cjs');
const { trial, auditCases } = require('../benchmark-sandbox-installs.cjs');
const profile = require('../sandbox-cache/profile.json');

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  if (!values.output) throw new Error('Specify --output NEW_DIRECTORY');
  const directory = path.resolve(values.output);
  if (fs.existsSync(directory)) throw new Error('Output directory already exists');
  fs.mkdirSync(directory, { recursive: true });
  const { E2B_API_KEY: apiKey } = readSandboxEnv(path.join(os.homedir(), '.engelbart'));
  if (!apiKey) throw new Error('E2B_API_KEY is unavailable');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Smoke test interrupted'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const save = (record) => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(record, null, 2));
  try {
    const result = await trial({ apiKey, suite: 'audit',
      repo: profile.repositories.find((r) => r.name === 'kjfeng/cocoa-canvas'),
      variant: auditCases[1], round: 2, directory, signal: controller.signal,
      expectedResources: { cpu: 8, memory_mb: 8192 }, onCreated: save });
    save(result);
    console.log(JSON.stringify({ startup: result.measurement?.startup, fingerprint: result.measurement?.fingerprint,
      exit: result.measurement?.exit_code, cleaned_up: result.cleaned_up, error: result.diagnostic_error }));
    if (!result.cleaned_up || result.diagnostic_error || result.measurement?.exit_code !== 0 || !result.measurement?.startup?.ok) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
