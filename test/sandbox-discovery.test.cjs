'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { discoverLaunch } = require('../src/main/sandbox/launch-discovery.cjs');

test('discovery caps responses, redacts saved secrets, and degrades safely without Railpack', async () => {
  const events = [];
  const sandbox = { files: { write: async () => {} }, commands: { run: async () => ({ stdout: JSON.stringify({ components: [{ cwd: '.', scripts: { start: 'SECRET' }, railpack: { status: 'planned', raw_bytes: 20000 } }] }) }) } };
  const data = await discoverLaunch({ sandbox, secrets: ['SECRET'], onEvent: e => events.push(e) });
  assert.equal(data.components[0].scripts.start, '[redacted]');
  assert.equal(events.at(-1).status, 'ok');
  assert.ok(events.at(-1).context_bytes < 12000);
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  for (const stdout of ['x'.repeat(12001), '{}', 'broken']) {
    sandbox.commands.run = async () => ({ stdout });
    assert.equal((await discoverLaunch({ sandbox })).status, 'unavailable');
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverLaunch({ sandbox, signal: controller.signal }), /abort/i);
});

test('Python discovery allowlist, bounded scan, workspace grouping and context cap', () => {
  execFileSync('python3', [path.join(__dirname, 'sandbox_discovery_check.py')], { encoding: 'utf8' });
});
