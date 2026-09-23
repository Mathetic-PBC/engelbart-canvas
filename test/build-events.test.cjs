const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/renderer/model/build-events.js');
const event = (text, kind = 'stdout', data) => ({ text, kind, data });

test('carriage returns replace progress frames, including status-kind clone output and trailing CR', async () => {
  const { terminalLines } = await load();
  assert.deepEqual(terminalLines([event('Resolving deltas: 41% (7/17)\rResolving deltas: 47% (8/17)\r', 'status')]), [
    { kind: 'status', text: 'Resolving deltas: 47% (8/17)' },
  ]);
  assert.deepEqual(terminalLines([event('10%\r'), event('50%\r'), event('100%\nDone\n')]), [
    { kind: 'stdout', text: '100%' }, { kind: 'stdout', text: 'Done' },
  ]);
});

test('real newlines, empty lines, CRLF split between chunks, and partial lines are preserved', async () => {
  const { terminalLines } = await load();
  assert.deepEqual(terminalLines([event('one\r'), event('\ntw'), event('o\n\nthree\r\nfour')]).map((line) => line.text), ['one', 'two', '', 'three', 'four']);
});

test('independent records, stdout/stderr, and stages do not concatenate or overwrite each other', async () => {
  const { terminalLines } = await load();
  const lines = terminalLines([
    event('10%\r'), event('Error: permission denied\n', 'stderr'), event('20%\r'),
    event('First status', 'status'), event('Second status', 'status'), event('fatal error\nDetails retained', 'error'),
    event('install fragment', 'stdout', { stage: 'install' }), event('app fragment', 'stdout', { stage: 'app' }),
  ]);
  assert.deepEqual(lines.map((line) => line.text), ['10%', 'Error: permission denied', '20%', 'First status', 'Second status', 'fatal error', 'Details retained', 'install fragment', 'app fragment']);
  assert.equal(lines[1].kind, 'stderr');
  assert.equal(lines[5].kind, 'error');
});

test('terminal color and erase-line codes do not pollute readable output', async () => {
  const { terminalLines } = await load();
  assert.deepEqual(terminalLines([event('\x1b[32mWorking\x1b[0m\r\x1b[2KDone\n')]), [{ kind: 'stdout', text: 'Done' }]);
});

test('Canvas retains structured stream boundaries and keeps legacy entries separate without mutating persisted data', async () => {
  const { terminalLines } = await load();
  const { buildEvents } = await import('../src/renderer/model/canvas-build.js');
  const run = { id: 'run', build_log: [
    { message: 'Partial ', kind: 'stdout', data: { phase: 'log', stream: 'stdout' } },
    { message: 'line\n10%\r', kind: 'stdout', data: { phase: 'log', stream: 'stdout' } },
    { message: '100%\r\n', kind: 'stdout', data: { phase: 'log', stream: 'stdout' } },
    { message: 'Legacy first', kind: 'stdout' }, { message: 'Legacy second', kind: 'stdout' },
    { message: 'Clone 40%\rClone 100%', kind: 'status' },
  ] };
  const saved = JSON.stringify(run);
  assert.deepEqual(terminalLines(buildEvents(run)).map((line) => line.text), ['Partial line', '100%', 'Legacy first', 'Legacy second', 'Clone 100%']);
  assert.equal(JSON.stringify(run), saved);
});
