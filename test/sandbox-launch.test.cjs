const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('sandbox adapter applies environment overrides and safely retires stopped native launches', { skip: process.platform === 'win32' && 'E2B sandbox helper: it runs in the sandbox\'s Linux, never on Windows, and needs POSIX Python (fcntl, os.killpg)' }, () => {
  const result = spawnSync('python3', [path.join(__dirname, 'sandbox_launch_check.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('application ownership, socket diagnostics, delayed-start fencing, and cleanup are deterministic', { skip: process.platform === 'win32' && 'E2B sandbox helper: it runs in the sandbox\'s Linux, never on Windows, and needs POSIX Python (fcntl, os.killpg)' }, () => {
  const result = spawnSync('python3', [path.join(__dirname, 'sandbox_app_check.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
