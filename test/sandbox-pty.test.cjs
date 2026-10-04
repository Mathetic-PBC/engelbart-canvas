'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandboxPty, ASLEEP } = require('../src/main/sandbox/pty.cjs');
const { createSandboxTerminals } = require('../src/main/sandbox/terminals.cjs');
const { SessionManager } = require('../src/main/terminal/session-manager.cjs');

// A fake of the E2B pieces pty.cjs uses, behaving as a live sandbox did (2026-10-03): a pty's stream drops when its
// sandbox pauses (wait() rejects with a TimeoutError, no exit code) while the shell lives on; pty.connect(pid) takes it
// back; an exit is an exit code; a pid or sandbox that is gone is a NotFoundError.
function fakeE2B({ sandboxes = ['sb-1'] } = {}) {
  const calls = [], processes = new Map();
  let nextPid = 100, failConnect = null;
  const live = new Set(sandboxes);
  const encode = (text) => new TextEncoder().encode(text);
  function proc(pid) {
    const p = { pid, listener: null, inputs: [], exited: false, settle: null };
    p.attach = (listener) => {
      p.listener = listener;
      return { pid, wait: () => new Promise((resolve, reject) => { p.settle = { resolve, reject }; }) };
    };
    p.print = (text) => p.listener?.(typeof text === 'string' ? encode(text) : text);
    p.exit = (code) => {
      p.exited = true;
      if (code === 0) p.settle?.resolve({ exitCode: 0 });
      else p.settle?.reject(Object.assign(new Error(`exit status ${code}`), { exitCode: code }));
    };
    p.drop = () => { p.listener = null; p.settle?.reject(Object.assign(new Error('[unavailable] the connection to sandbox ended before the stream completed'), { name: 'TimeoutError' })); };
    return p;
  }
  const api = (id) => ({ pty: {
    async create(options) {
      calls.push(['create', id, { cols: options.cols, rows: options.rows, cwd: options.cwd, envs: options.envs, timeoutMs: options.timeoutMs }]);
      const p = proc(nextPid++);
      processes.set(p.pid, p);
      return p.attach(options.onData);
    },
    async connect(pid, options) {
      calls.push(['connect', pid]);
      const p = processes.get(pid);
      if (!p || p.exited) throw Object.assign(new Error(`process ${pid} not found`), { name: 'NotFoundError' });
      return p.attach(options.onData);
    },
    async sendInput(pid, bytes) { calls.push(['input', pid, new TextDecoder().decode(bytes)]); processes.get(pid).inputs.push(new TextDecoder().decode(bytes)); },
    async resize(pid, size) { calls.push(['resize', pid, size]); },
    async kill(pid) { calls.push(['kill', pid]); const p = processes.get(pid); if (p) { p.exited = true; p.settle?.reject(Object.assign(new Error('signal: killed'), { exitCode: -1 })); } return true; },
  } });
  const Sandbox = { async connect(id, options) {
    calls.push(['sandbox', id, { apiKey: options.apiKey, timeoutMs: options.timeoutMs }]);
    if (failConnect) { const error = failConnect; failConnect = null; throw error; }
    if (!live.has(id)) throw Object.assign(new Error(`Sandbox ${id} not found`), { name: 'NotFoundError' });
    return api(id);
  } };
  return { Sandbox, calls, processes, live, failNextConnect: (error) => { failConnect = error; } };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
const plain = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

function open(e2b, options = {}) {
  const output = [], exits = [];
  const handle = createSandboxPty({ Sandbox: e2b.Sandbox }).spawn('sb-1', [], { cols: 80, rows: 24, cwd: '/home/user/repository/cli',
    env: { API_TOKEN: 'saved-secret', TERM: 'xterm-256color' }, apiKey: async () => 'e2b-key', ...options });
  handle.onData((text) => output.push(text));
  handle.onExit((event) => exits.push(event));
  return { handle, output, exits, text: () => output.join('') };
}

test('spawn connects with the main process\'s key, opens bash in the directory with the saved values as its environment, and streams UTF-8', async () => {
  const e2b = fakeE2B();
  const t = open(e2b, { banner: '# Try: python main.py --help\r\n' });
  assert.equal(t.handle.pid, null, 'no pid until the pty is up');
  await settle();
  assert.deepEqual(e2b.calls.slice(0, 2), [
    ['sandbox', 'sb-1', { apiKey: 'e2b-key', timeoutMs: 600_000 }],
    ['create', 'sb-1', { cols: 80, rows: 24, cwd: '/home/user/repository/cli', envs: { API_TOKEN: 'saved-secret', TERM: 'xterm-256color' }, timeoutMs: 0 }],
  ]);
  assert.equal(t.handle.pid, 100);
  assert.ok(!e2b.calls.some(([kind, , value]) => kind === 'input' && String(value).includes('saved-secret')), 'values are never typed into the shell');
  const shell = e2b.processes.get(100);
  const bytes = new TextEncoder().encode('héllo ✓ 日本 🙂\r\nuser@e2b:~$ ');
  shell.print(bytes.slice(0, 2)); shell.print(bytes.slice(2, 7)); shell.print(bytes.slice(7)); // split inside characters
  assert.equal(plain(t.text()), 'Waking…# Try: python main.py --help\nhéllo ✓ 日本 🙂\nuser@e2b:~$ ', '"Waking…" until the pty is up, then the hint, never run');
  t.handle.write('ls\r');
  t.handle.write('echo é\r');
  t.handle.resize(132, 40);
  await settle();
  assert.deepEqual(shell.inputs, ['ls\r', 'echo é\r'], 'in order');
  assert.deepEqual(e2b.calls.filter(([kind]) => kind === 'resize'), [['resize', 100, { cols: 132, rows: 40 }]]);
  assert.ok(!shell.inputs.some((input) => input.includes('python main.py')), 'the hint is never run');
  shell.exit(3);
  await settle();
  assert.deepEqual(t.exits, [{ exitCode: 3 }]);
  t.handle.write('ignored');
  await settle();
  assert.deepEqual(shell.inputs, ['ls\r', 'echo é\r']);
});

test('kill ends the shell, never the sandbox, and says it exited at once', async () => {
  const e2b = fakeE2B();
  const t = open(e2b);
  await settle();
  t.handle.kill();
  await Promise.resolve();
  assert.deepEqual(t.exits, [{ exitCode: 0 }], 'without waiting for E2B');
  await settle();
  assert.deepEqual(e2b.calls.filter(([kind]) => kind === 'kill'), [['kill', 100]]);
  assert.equal(t.exits.length, 1, 'the remote kill\'s own end is not another exit');
  assert.ok(e2b.live.has('sb-1'));
});

test('its sandbox asleep, the shell says so instead of exiting; a keystroke wakes it and takes the same shell back', async () => {
  const e2b = fakeE2B();
  const t = open(e2b, { banner: '# Try: make\r\n' });
  await settle();
  e2b.processes.get(100).drop(); // the sandbox paused
  await settle();
  assert.deepEqual(t.exits, []);
  assert.ok(t.text().includes(ASLEEP));
  t.handle.resize(100, 30); // while asleep: applied when it wakes
  t.handle.write('\r');
  t.handle.write('pwd\r');
  await settle();
  assert.deepEqual(e2b.calls.filter(([kind]) => ['sandbox', 'connect', 'create'].includes(kind)).map(([kind]) => kind), ['sandbox', 'create', 'sandbox', 'connect']);
  assert.deepEqual(e2b.processes.get(100).inputs, ['\r', 'pwd\r'], 'what was typed while it woke, in order');
  assert.deepEqual(e2b.calls.filter(([kind]) => kind === 'resize').at(-1), ['resize', 100, { cols: 100, rows: 30 }]);
  assert.equal(plain(t.text()).match(/# Try: make/g).length, 1, 'the hint only on first open');
  assert.equal(e2b.calls.filter(([kind]) => kind === 'create').length, 1);
  e2b.processes.get(100).print('/home/user/repository\r\n');
  assert.match(t.text(), /\/home\/user\/repository/);
});

test('reopening an asleep shell wakes it; a shell that ended while asleep is replaced; a sandbox that is gone ends the session', async () => {
  const e2b = fakeE2B();
  const t = open(e2b);
  await settle();
  const first = e2b.processes.get(100);
  first.drop();
  first.exited = true; // its shell ended meanwhile
  await settle();
  await t.handle.wake();
  await settle();
  assert.equal(t.handle.pid, 101);
  assert.match(plain(t.text()), /the shell had ended while the sandbox slept; this is a new one/);
  assert.deepEqual(t.exits, []);
  e2b.processes.get(101).drop();
  e2b.live.delete('sb-1');
  await settle();
  await t.handle.wake();
  await settle();
  assert.match(plain(t.text()), /This sandbox is gone/);
  assert.deepEqual(t.exits, [{ exitCode: null }]);
});

test('an unreachable sandbox is said, and the next keystroke tries again', async () => {
  const e2b = fakeE2B();
  e2b.failNextConnect(new Error('network down'));
  const t = open(e2b);
  await settle();
  assert.match(plain(t.text()), /Could not reach the sandbox: network down/);
  assert.equal(t.handle.pid, null);
  t.handle.write('ls\r');
  await settle();
  assert.equal(t.handle.pid, 100);
  assert.deepEqual(e2b.processes.get(100).inputs, ['ls\r']);
});

test('SessionManager.createSandbox: a sandbox session titled for its repository, its hint a comment, its output and input through the adapter', async () => {
  const e2b = fakeE2B();
  const manager = new SessionManager({ sandboxPty: createSandboxPty({ Sandbox: e2b.Sandbox }), batchDelayMs: 0 });
  const data = [], exits = [];
  manager.on('data', (event) => data.push(event.data));
  manager.on('exit', (event) => exits.push(event));
  const request = { sandboxId: 'sb-1', libraryId: 'repo-1', title: 'owner/cli (sandbox)', cwd: '/home/user/repository', envs: { KEY: 'v' }, hint: 'python main.py --help\u001b[2J', apiKey: async () => 'k' };
  for (const bad of [{ sandboxId: '../x' }, { cwd: 'relative' }, { apiKey: 'k' }, { envs: { KEY: 1 } }, { cols: 1 }]) assert.throws(() => manager.createSandbox({ ...request, ...bad }), JSON.stringify(bad));
  const session = manager.createSandbox(request);
  assert.deepEqual([session.provider, session.libraryId, session.title, session.cwd, session.status], ['sandbox', 'repo-1', 'owner/cli (sandbox)', '/home/user/repository', 'running']);
  await settle();
  assert.deepEqual(e2b.calls[1][2].envs, { KEY: 'v', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(plain(data.join('')), /# Try: python main\.py --help \[2J\n/, 'escape sequences in the hint are printed as text');
  manager.write(session.id, 'ls\r');
  manager.resize(session.id, 120, 40);
  await settle();
  assert.deepEqual(e2b.processes.get(100).inputs, ['ls\r']);
  assert.deepEqual(manager.get(session.id).cols, 120);
  e2b.processes.get(100).drop();
  await settle();
  await manager.wake(session.id);
  await settle();
  assert.equal(e2b.calls.filter(([kind]) => kind === 'connect').length, 1, 'woken through the manager');
  assert.equal(await manager.close(session.id), true);
  assert.ok(e2b.calls.some(([kind]) => kind === 'kill'));
  assert.equal(exits.length, 1);
  assert.throws(() => new SessionManager({}).createSandbox(request), /unavailable/);
});

test('terminals.cjs: one shell per repository, reused (and woken) while it runs, replaced for a new sandbox, closed with its tab taken away', async () => {
  const e2b = fakeE2B({ sandboxes: ['sb-1', 'sb-2'] });
  const sessions = new SessionManager({ sandboxPty: createSandboxPty({ Sandbox: e2b.Sandbox }), batchDelayMs: 0 });
  const owned = [], closed = [];
  const terminals = createSandboxTerminals({ sessions: () => sessions, own: (id) => owned.push(id), closed: (id) => closed.push(id) });
  const spec = { libraryId: 'repo-1', sandboxId: 'sb-1', title: 'owner/cli (sandbox)', cwd: '/home/user/repository', envs: {}, hint: '', apiKey: async () => 'k' };
  const first = terminals.open(spec);
  await settle();
  assert.equal(terminals.open(spec).id, first.id, 'the same session');
  assert.deepEqual(owned, [first.id, first.id], 'shown in the window that asked, each time');
  const replaced = terminals.open({ ...spec, sandboxId: 'sb-2' });
  await settle();
  assert.notEqual(replaced.id, first.id);
  assert.deepEqual(closed, [first.id]);
  assert.equal(sessions.get(first.id), null);
  await sessions.close(replaced.id); // its tab closed by the person
  const again = terminals.open({ ...spec, sandboxId: 'sb-2' });
  assert.notEqual(again.id, replaced.id, 'a closed tab is opened anew');
  await terminals.close('repo-1');
  assert.deepEqual(closed, [first.id, again.id]);
  assert.equal(sessions.list().length, 0);
  assert.ok(e2b.live.has('sb-1') && e2b.live.has('sb-2'), 'no sandbox was ended');
});
