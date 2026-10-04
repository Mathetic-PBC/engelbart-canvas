'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

// Keys stay in main/worker processes; config() and renderer IPC never expose them.
function readSandboxEnv(root, env = process.env) {
  const read = (file) => {
    try { return parseEnv(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  const local = read(path.join(__dirname, '../../..', '.env.local'));
  const personal = read(path.join(root, 'sandbox.env'));
  const selected = env.ENGELBART_SANDBOX_ENV_FILE || personal.ENGELBART_SANDBOX_ENV_FILE || local.ENGELBART_SANDBOX_ENV_FILE;
  const values = { ...local, ...(selected ? read(selected) : {}), ...personal, ...env };
  // Setup is the local Claude Code subscription's alone (worker.cjs): no Anthropic API key or hc model settings are read.
  return Object.fromEntries(Object.entries(values).filter(([key]) =>
    ['E2B_API_KEY', 'E2B_TEMPLATE', 'E2B_DOCKER_TEMPLATE', 'ENGELBART_SANDBOX_CLAUDE_MODEL'].includes(key)));
}

module.exports = { readSandboxEnv };
