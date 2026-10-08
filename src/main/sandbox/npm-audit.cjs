'use strict';

const fs = require('node:fs');
const path = require('node:path');
const HELPER = '/home/user/.engelbart-canvas/npm-audit.py';

// This task deliberately has no readiness/installation authority. Its summaries
// go through the worker's normal redaction + Build log event persistence.
async function runNpmAudit({ sandbox, signal, onEvent }) {
  let buffer = '', reported = false;
  const receive = (chunk) => {
    if (signal.aborted) return;
    buffer += String(chunk);
    if (buffer.length > 64_000) throw new Error('Audit event exceeded its size limit');
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.phase !== 'audit' || !['checking', 'findings', 'complete', 'unavailable', 'skipped'].includes(event.status) || typeof event.message !== 'string') throw new Error('Invalid audit event');
      reported = true;
      onEvent(event);
    }
  };
  signal.throwIfAborted();
  await sandbox.files.write(HELPER, fs.readFileSync(path.join(__dirname, 'npm-audit.py'), 'utf8'));
  signal.throwIfAborted();
  const result = await sandbox.commands.run(`python3 -u ${HELPER}`, {
    timeoutMs: 120_000, requestTimeoutMs: 130_000, signal, onStdout: receive,
  });
  if (result.exitCode !== 0) throw new Error('Background npm audit did not finish');
  if (buffer.trim()) receive('\n');
  if (!reported && !signal.aborted) throw new Error('Background npm audit returned no report');
}

module.exports = { runNpmAudit };
