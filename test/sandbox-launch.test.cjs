const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('sandbox adapter applies environment overrides and safely retires stopped native launches', () => {
  const result = spawnSync('python3', [path.join(__dirname, 'sandbox_launch_check.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
