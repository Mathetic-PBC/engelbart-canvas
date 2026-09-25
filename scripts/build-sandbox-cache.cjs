'use strict';

const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Template, defaultBuildLogger } = require('e2b');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');
const { cacheTemplate, hash } = require('./sandbox-cache/common.cjs');
const profile = require('./sandbox-cache/profile.json');

async function main() {
  const { values } = parseArgs({ options: { base: { type: 'string' }, name: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('Build an opt-in cached runner: node scripts/build-sandbox-cache.cjs --base engelbart-runner --name engelbart-canvas-cached [--dry-run]'); return; }
  const env = readSandboxEnv(path.join(os.homedir(), '.engelbart'));
  const base = values.base || env.E2B_TEMPLATE || 'engelbart-runner';
  const name = values.name || 'engelbart-canvas-cached';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || name === base.split(':')[0]) throw new Error('Choose a separate template name; the base template must not be replaced');
  const template = cacheTemplate(Template, base, profile);
  if (values['dry-run']) { console.log(await Template.toJSON(template)); return; }
  if (!env.E2B_API_KEY) throw new Error('Set E2B_API_KEY in ~/.engelbart/sandbox.env');
  const info = await Template.build(template, name, { apiKey: env.E2B_API_KEY, cpuCount: 8, memoryMB: 8192, minFreeDiskMb: 25 * 1024,
    onBuildLogs: defaultBuildLogger({ minLevel: 'info' }) });
  console.log(JSON.stringify({ ...info, base, profile: hash(profile) }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
