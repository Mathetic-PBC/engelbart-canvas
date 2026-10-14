'use strict';

// A sandbox worker that dies before it reads anything (2026-10-14: the app's bundle was moved away under the running app by
// an install from another macOS account; every 15-second probe forked a worker that exited at once, and the first send
// threw "Uncaught Exception: write EPIPE" as a dialog, again and again). It ends the run's `done` quietly instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchWorker } = require('../src/main/sandbox/transport.cjs');

test('a worker that exits before reading: done rejects, nothing is thrown, and detach/stop do not throw EPIPE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-transport-'));
  const dead = path.join(dir, 'dead.cjs');
  fs.writeFileSync(dead, 'process.exit(3);\n');
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    for (let i = 0; i < 5; i++) {
      const worker = launchWorker({ command: 'probe', run_id: `r${i}` }, {}, async () => {}, { workerPath: dead });
      await assert.rejects(worker.done);
      await assert.rejects(worker.detach(), /no longer connected/);
      await worker.stop().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(uncaught.map((error) => error.message), [], 'no uncaught exception');
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('a missing worker file: done rejects without an uncaught exception', async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    const worker = launchWorker({ command: 'probe', run_id: 'gone' }, {}, async () => {}, { workerPath: path.join(os.tmpdir(), 'no-such-dir', 'worker.cjs') });
    await assert.rejects(worker.done);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(uncaught.map((error) => error.message), []);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('the app bundle gone from under it: no fork, one plain reason', async () => {
  const { bundleGone, MOVED } = require('../src/main/sandbox/transport.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-bundle-'));
  fs.writeFileSync(path.join(dir, 'app.asar'), '');
  assert.equal(bundleGone(path.join(dir, 'app.asar', 'src', 'main', 'sandbox')), false, 'there');
  assert.equal(bundleGone(path.join(dir, 'gone.asar', 'src', 'main', 'sandbox')), true, 'moved away');
  assert.equal(bundleGone(__dirname), false, 'not packaged: never gone');
  const worker = launchWorker({ command: 'probe', run_id: 'x' }, {}, async () => {}, { workerPath: path.join(dir, 'gone.asar', 'src', 'main', 'sandbox', 'worker.cjs') });
  await assert.rejects(worker.done, (error) => error.message === MOVED);
});
