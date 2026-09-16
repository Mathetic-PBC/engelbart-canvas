const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { SessionManager } = require('../src/main/terminal/session-manager.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experimental-terminal-pty-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.zshenv'), '');
  fs.writeFileSync(path.join(home, '.zprofile'), '');
  fs.writeFileSync(path.join(home, '.zshrc'), 'PROMPT="fixture> "\n');
  fs.writeFileSync(path.join(home, '.zlogin'), '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home,
    environment: {
      HOME: home,
      ZDOTDIR: home,
      SHELL: '/bin/zsh',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
    },
  };
}

function waitFor(manager, eventName, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off(eventName, listener);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeout);
    function listener(event) {
      if (!predicate(event)) return;
      clearTimeout(timer);
      manager.off(eventName, listener);
      resolve(event);
    }
    manager.on(eventName, listener);
  });
}

function runtimeMarker(label) {
  return `${label}_${randomUUID().replaceAll('-', '')}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function waitForOutput(manager, sessionId, predicate, timeout = 5000) {
  let output = '';
  return waitFor(manager, 'data', (event) => {
    if (event.id !== sessionId) return false;
    output += event.data;
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
      output = Buffer.from(output).subarray(-1024 * 1024).toString('utf8');
    }
    return predicate(output, event);
  }, timeout).then((event) => ({ event, output }));
}

function waitForPausedOutput(manager, sessionId, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let lastEvent = null;
    const timer = setTimeout(() => {
      manager.off('data', listener);
      reject(new Error('Timed out waiting for PTY backpressure'));
    }, timeout);
    function listener(event) {
      if (event.id !== sessionId) return;
      lastEvent = event;
      queueMicrotask(() => {
        if (!lastEvent || !manager.flowState(sessionId).paused) return;
        clearTimeout(timer);
        manager.off('data', listener);
        resolve(lastEvent);
      });
    }
    manager.on('data', listener);
  });
}

async function writeAndWaitForMarker(manager, sessionId, command, expected) {
  assert.equal(command.includes(expected), false, 'expected output marker must not occur in echoed input');
  const seen = waitForOutput(manager, sessionId, (output) => output.includes(expected));
  manager.write(sessionId, command);
  return seen;
}

async function waitForProcessToDisappear(pid, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} survived PTY closure`);
}

async function createManager(t, options = {}) {
  const files = fixture(t);
  const manager = new SessionManager({ environment: files.environment, batchDelayMs: 1, ...options });
  t.after(async () => manager.shutdown());
  return { manager, ...files };
}

test('real PTY executes input and reports a controlling terminal', async (t) => {
  const { manager, root } = await createManager(t);
  const session = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  const marker = runtimeMarker('TTY');
  const expected = `${marker}:yes`;
  const command = `if test -t 0; then printf '%s:%s\\n' '${marker}' yes; else printf '%s:%s\\n' '${marker}' no; fi\n`;

  const seen = await writeAndWaitForMarker(manager, session.id, command, expected);

  assert.match(seen.output, new RegExp(escapeRegExp(expected)));
});

test('resize reaches stty inside the PTY', async (t) => {
  const { manager, root } = await createManager(t);
  const session = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  manager.resize(session.id, 91, 33);
  const marker = runtimeMarker('SIZE');
  const expected = `${marker}:33 91`;
  const command = `printf '%s:%s\\n' '${marker}' "$(stty size)"\n`;

  const seen = await writeAndWaitForMarker(manager, session.id, command, expected);

  assert.match(seen.output, new RegExp(escapeRegExp(expected)));
});

test('Ctrl-C interrupts a foreground command and leaves the shell usable', async (t) => {
  const { manager, root } = await createManager(t);
  const session = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  const startedMarker = runtimeMarker('FOREGROUND');
  const recoveredMarker = runtimeMarker('RECOVERED');
  const startedPattern = new RegExp(`${escapeRegExp(startedMarker)}:(\\d+)`);
  const startCommand = `sh -c 'printf "%s:%d\\n" "$1" "$$"; exec sleep 10' sh '${startedMarker}'\n`;
  assert.equal(startedPattern.test(startCommand), false, 'foreground PID marker must not occur in echoed input');
  const started = waitForOutput(manager, session.id, (output) => startedPattern.test(output));
  manager.write(session.id, startCommand);
  const startedOutput = (await started).output;
  const childPid = Number(startedOutput.match(startedPattern)[1]);
  assert.doesNotThrow(() => process.kill(childPid, 0));

  manager.write(session.id, '\x03');
  await waitForProcessToDisappear(childPid);
  const recovered = `${recoveredMarker}:ready`;
  const recoveryCommand = `printf '%s:%s\\n' '${recoveredMarker}' ready\n`;
  const recoveredOutput = await writeAndWaitForMarker(manager, session.id, recoveryCommand, recovered);

  assert.match(recoveredOutput.output, new RegExp(escapeRegExp(recovered)));
});

test('shell exit code is retained and emitted', async (t) => {
  const { manager, root } = await createManager(t);
  const session = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  const exited = waitFor(manager, 'exit', (event) => event.id === session.id);
  manager.write(session.id, 'exit 7\n');

  assert.equal((await exited).exitCode, 7);
  assert.equal(manager.get(session.id).status, 'exited');
  assert.equal(manager.get(session.id).exitCode, 7);
});

test('two sessions keep working directories and process state isolated', async (t) => {
  const { manager, root } = await createManager(t);
  const firstDirectory = path.join(root, 'first');
  const secondDirectory = path.join(root, 'second');
  fs.mkdirSync(firstDirectory);
  fs.mkdirSync(secondDirectory);
  const first = manager.create({ provider: 'shell', cwd: firstDirectory, cols: 80, rows: 24 });
  const second = manager.create({ provider: 'shell', cwd: secondDirectory, cols: 80, rows: 24 });
  const firstMarker = runtimeMarker('FIRST');
  const secondMarker = runtimeMarker('SECOND');
  const firstExpected = `${firstMarker}:${firstDirectory}`;
  const secondExpected = `${secondMarker}:${secondDirectory}`;
  const firstCommand = `printf '%s:%s\\n' '${firstMarker}' "$PWD"\n`;
  const secondCommand = `printf '%s:%s\\n' '${secondMarker}' "$PWD"\n`;
  const firstOutput = writeAndWaitForMarker(manager, first.id, firstCommand, firstExpected);
  const secondOutput = writeAndWaitForMarker(manager, second.id, secondCommand, secondExpected);

  assert.match((await firstOutput).output, new RegExp(escapeRegExp(firstExpected)));
  assert.match((await secondOutput).output, new RegExp(escapeRegExp(secondExpected)));
});

test('replay is bounded and lifecycle close removes only the target session', async (t) => {
  const { manager, root } = await createManager(t, { maxReplayBytes: 160, maxReplayEntries: 3, maxSessions: 2 });
  const first = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  const second = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  assert.throws(
    () => manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 }),
    /at most 2 sessions/i,
  );
  const marker = runtimeMarker('REPLAY');
  const expected = `${marker}:done`;
  const command = `printf '%0600d%s:%s\\n' 0 '${marker}' done\n`;
  await writeAndWaitForMarker(manager, first.id, command, expected);

  const snapshot = manager.get(first.id);
  assert.ok(snapshot.history.length <= 3);
  assert.ok(snapshot.history.reduce((sum, entry) => sum + Buffer.byteLength(entry.data), 0) <= 160);
  assert.equal(await manager.close(first.id), true);
  assert.equal(manager.get(first.id), null);
  assert.equal(manager.get(second.id).status, 'running');
});

test('closing a session terminates its foreground child process', async (t) => {
  const { manager, root } = await createManager(t);
  const session = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  const marker = runtimeMarker('CHILD_PID');
  const pidPattern = new RegExp(`${escapeRegExp(marker)}:(\\d+)`);
  let childPid;
  const started = waitForOutput(manager, session.id, (output) => {
    const match = output.match(pidPattern);
    if (!match) return false;
    childPid = Number(match[1]);
    return true;
  });
  const command = `sh -c 'printf "%s:%d\\n" "$1" "$$"; exec sleep 30' sh '${marker}'\n`;
  assert.equal(pidPattern.test(command), false, 'child PID marker must not occur in echoed input');
  manager.write(session.id, command);
  await started;

  assert.equal(await manager.close(session.id), true);
  await waitForProcessToDisappear(childPid);
  assert.equal(manager.get(session.id), null);
});

test('large PTY output is emitted in bounded renderer batches', async (t) => {
  const { manager, root } = await createManager(t, { maxOutputBatchBytes: 96 });
  const session = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  const byteLengths = [];
  manager.on('data', (event) => {
    if (event.id === session.id) byteLengths.push(Buffer.byteLength(event.data));
  });
  const marker = runtimeMarker('BATCH_END');
  const expected = `${marker}:done`;
  const command = `head -c 2000 /dev/zero | tr '\\0' z; printf '%s:%s\\n' '${marker}' done\n`;
  await writeAndWaitForMarker(manager, session.id, command, expected);

  assert.ok(byteLengths.length > 2);
  assert.ok(byteLengths.every((length) => length <= 96), `oversized batches: ${byteLengths.join(', ')}`);
});

test('input limits and renderer detachment release PTY backpressure', async (t) => {
  const { manager, root } = await createManager(t, { maxUnackedBytes: 64, resumeUnackedBytes: 16 });
  const session = manager.create({ provider: 'shell', cwd: root, cols: 80, rows: 24 });
  assert.throws(() => manager.write(session.id, 'x'.repeat(70_000)), /input/i);
  assert.throws(() => manager.resize(session.id, 0, 24), /cols/i);
  assert.equal(manager.acknowledge(session.id, 999999), false);
  const firstPause = waitForPausedOutput(manager, session.id);
  manager.write(session.id, `printf '%0200d\\n' 0\n`);
  const floodEvent = await firstPause;
  assert.equal(manager.flowState(session.id).paused, true);
  assert.equal(manager.acknowledge('not-this-session', floodEvent.sequence), false);
  assert.equal(manager.acknowledge(session.id, floodEvent.sequence), true);
  assert.equal(manager.flowState(session.id).paused, false);

  const secondPause = waitForPausedOutput(manager, session.id);
  manager.write(session.id, `printf '%0200d\\n' 0\n`);
  await secondPause;
  assert.equal(manager.flowState(session.id).paused, true);

  manager.detachRenderer();

  assert.equal(manager.flowState(session.id).paused, false);
});

test('close never reports success without a confirmed PTY exit', async (t) => {
  const files = fixture(t);
  let exitListener = () => {};
  const inertProcess = {
    pid: 12345,
    onData: () => ({ dispose() {} }),
    onExit: (listener) => {
      exitListener = listener;
      return { dispose() {} };
    },
    write() {}, resize() {}, pause() {}, resume() {}, kill() {},
  };
  const manager = new SessionManager({
    environment: files.environment,
    pty: { spawn: () => inertProcess },
    closeTimeoutMs: 5,
    forceCloseTimeoutMs: 5,
  });
  t.after(() => exitListener({ exitCode: 0 }));
  const session = manager.create({ provider: 'shell', cwd: files.root, cols: 80, rows: 24 });

  await assert.rejects(manager.close(session.id), /did not exit/i);
  assert.equal(manager.get(session.id).status, 'running');
});
