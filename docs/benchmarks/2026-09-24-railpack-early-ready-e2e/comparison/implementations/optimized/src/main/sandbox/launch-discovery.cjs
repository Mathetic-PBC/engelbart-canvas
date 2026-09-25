'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./environment.cjs');
const REMOTE = '/home/user/.engelbart-canvas/launch-discovery.py';

async function discoverLaunch({ sandbox, signal, secrets = [], onEvent = () => {} }) {
  const started = performance.now();
  signal?.throwIfAborted();
  onEvent({ phase: 'plan', source: 'railpack', status: 'running', message: 'Discovering launch facts with Railpack' });
  let result;
  try {
    await sandbox.files.write(REMOTE, fs.readFileSync(path.join(__dirname, 'launch-discovery.py'), 'utf8'));
    const output = await sandbox.commands.run(`python3 ${REMOTE}`, { timeoutMs: 12_000, signal });
    if (Buffer.byteLength(output.stdout || '') > 12000) throw new Error('Discovery exceeds context limit');
    result = redact(JSON.parse(output.stdout), secrets);
    if (!Array.isArray(result.components)) throw new Error('Invalid discovery response');
  } catch {
    signal?.throwIfAborted();
    result = { status: 'unavailable', components: [], scan_truncated: true };
  }
  signal?.throwIfAborted();
  const available = result.components.some(c => c.railpack?.status === 'planned');
  onEvent({ phase: 'plan', source: 'railpack', status: available ? 'ok' : 'unavailable',
    message: available ? 'Launch hints discovered; Claude verifies the preview recipe' : 'Railpack hints unavailable; Claude will inspect the repository',
    elapsed_ms: Math.round(performance.now() - started), context_bytes: Buffer.byteLength(JSON.stringify(result)),
    components: result.components.map(c => ({ cwd: c.cwd, status: c.railpack?.status, raw_bytes: c.railpack?.raw_bytes })) });
  return result;
}

module.exports = { discoverLaunch };
