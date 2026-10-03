// npm test (2026-10-03): `node --test test/*.test.cjs` with a temporary folder of its own (TMPDIR), removed when the run
// ends. The tests make their homes, repos and databases with mkdtemp in os.tmpdir() and leave them there: one run left
// about 7 GB, and several Builds running it filled the disk in the middle of an Accept's check (ENOSPC).
//
//   npm test
//   npm test -- --test-name-pattern="readStageFile"

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = fs.readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.cjs')).sort().map((name) => path.join('test', name));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-test-')); // short: paths made inside it stay short
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: scratch } });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* left for macOS to clear */ }
  process.exit(code ?? (signal ? 1 : 0));
});
