// The hidden sign-in (src/main/tools/sign-in.cjs) in a real PTY, with a pretend CLI that waits for Enter and
// prints its sign-in page, as Claude Code and Codex do (2026-09-23). Run with `npm run test:pty`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { createSignInProcess } = require('../src/main/tools/sign-in.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-sign-in-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) fs.writeFileSync(path.join(root, file), '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, bin, environment: { HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh', PATH: `${bin}:/usr/bin:/bin`, LANG: 'en_US.UTF-8' } };
}

test('sign-in answers "press Enter", passes the page on, and ends when the CLI does', async (t) => {
  const { bin, environment } = fixture(t);
  const cli = path.join(bin, 'claude');
  // Stands in for `claude auth login --claudeai`: refuses to go on until Enter, then prints the page and finishes.
  fs.writeFileSync(cli, '#!/bin/sh\n[ "$1 $2 $3" = "auth login --claudeai" ] || exit 9\nprintf "\\033[1mPress Enter to open your browser\\033[0m\\n"\nread answer\necho "If the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&state=abc"\nsleep 0.2\necho "Login successful."\n', { mode: 0o755 });
  const signIn = createSignInProcess({ pty, shell: '/bin/zsh', environment });
  const pages = [];
  const run = signIn('claude', cli, { onUrl: (url) => pages.push(url) });
  const exit = await Promise.race([run.done, new Promise((_, reject) => setTimeout(() => reject(new Error('sign-in did not end')), 8000))]);
  assert.deepEqual(exit, { code: 0, output: '' });
  assert.deepEqual(pages, ['https://claude.ai/oauth/authorize?code=true&state=abc']);
});

test('a sign-in that asks for the page\'s code says so, and the code sent is typed in with Enter (2026-10-19, Linux)', async (t) => {
  const { bin, environment } = fixture(t);
  const cli = path.join(bin, 'claude');
  // Stands in for Claude Code when the browser could not be opened: the page's code is pasted into its prompt.
  fs.writeFileSync(cli, '#!/bin/sh\necho "Browser didn\'t open? Use the url below to sign in"\necho "https://claude.ai/oauth/authorize?code=true&state=abc"\nprintf "Paste code here if prompted > "\nread code\n[ "$code" = "abc#123" ] || { echo "Wrong code: $code"; exit 3; }\necho "Login successful."\n', { mode: 0o755 });
  const signIn = createSignInProcess({ pty, shell: '/bin/zsh', environment });
  let asked = 0;
  const run = signIn('claude', cli, { onCode: () => { asked += 1; } });
  const start = Date.now();
  while (!asked && Date.now() - start < 5000) await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(asked, 1, 'asked once');
  assert.equal(run.send('abc#123'), true);
  const exit = await Promise.race([run.done, new Promise((_, reject) => setTimeout(() => reject(new Error('sign-in did not end')), 8000))]);
  assert.deepEqual(exit, { code: 0, output: '' });
});

test('a sign-in that fails reports its last line, and Cancel ends one that waits for ever', async (t) => {
  const { bin, environment } = fixture(t);
  const failing = path.join(bin, 'codex');
  fs.writeFileSync(failing, '#!/bin/sh\necho "Error: login server could not bind to port 1455"\nexit 1\n', { mode: 0o755 });
  const signIn = createSignInProcess({ pty, shell: '/bin/zsh', environment });
  const failed = await signIn('codex', failing).done;
  assert.deepEqual(failed, { code: 1, output: 'Error: login server could not bind to port 1455' });

  const waiting = path.join(bin, 'waits');
  fs.writeFileSync(waiting, '#!/bin/sh\necho "Waiting for the browser…"\nsleep 60\n', { mode: 0o755 });
  const run = signIn('codex', waiting);
  setTimeout(() => run.kill(), 300);
  const ended = await Promise.race([run.done, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel did not end it')), 5000))]);
  assert.deepEqual(ended, { code: null, output: '' }, 'cancelled, not a success');
});

test('a CLI found where PATH does not reach signs in with its folder on PATH (Claude Code warns when it is not)', async (t) => {
  const { root, environment } = fixture(t);
  const away = path.join(root, '.local', 'bin');
  fs.mkdirSync(away, { recursive: true });
  const cli = path.join(away, 'claude');
  // Stands in for Claude Code's own check: its folder has to be on the PATH it was started with.
  fs.writeFileSync(cli, `#!/bin/sh\ncase ":$PATH:" in *":${away}:"*) echo "Login successful."; exit 0;; esac\necho "Native installation exists but ${away} is not in your PATH"\nexit 7\n`, { mode: 0o755 });
  const signIn = createSignInProcess({ pty, shell: '/bin/zsh', environment });
  const exit = await Promise.race([signIn('claude', cli).done, new Promise((_, reject) => setTimeout(() => reject(new Error('sign-in did not end')), 8000))]);
  assert.deepEqual(exit, { code: 0, output: '' });
});

test('a quit ends a sign-in still waiting in the browser and waits for its terminal to exit (2026-10-16)', async (t) => {
  // node-pty's exit callback landing while Node shuts down aborts the app (a Napi::Error at FreeEnvironment), and the
  // sign-in's terminal is outside the session manager the quit closes: ../src/main/index.cjs requestQuit asks the tools
  // manager to end it first.
  const { createTools } = require('../src/main/tools/manager.cjs');
  const { createFakeTools } = require('../src/main/tools/fake.cjs');
  const { bin, environment } = fixture(t);
  const waiting = path.join(bin, 'claude');
  fs.writeFileSync(waiting, '#!/bin/sh\necho "Opening the browser to sign in…"\nsleep 60\n', { mode: 0o755 });
  const fake = createFakeTools({ claude: '2.1.300 signed-out', codex: 'missing' }, { delayMs: 0, sleep: async () => {} });
  const real = createSignInProcess({ pty, shell: '/bin/zsh', environment });
  let pretend = {};
  // the real sign-in terminal, running the stand-in where the pretend Mac says Claude Code is
  const tools = createTools({ readTools: () => pretend, writeTools: (value) => { pretend = value; return null; }, detect: fake.detect, actions: fake.actions, signInProcess: (name, _file, options) => real(name, waiting, options), signOutProcess: fake.signOutProcess, setTimer: setTimeout, clearTimer: clearTimeout });
  await tools.check();
  const pressed = tools.signIn('claude');
  await new Promise((resolve) => { setTimeout(resolve, 400); });
  const busy = tools.snapshot().tools.claude.busy;
  assert.equal(busy && busy.action, 'sign-in', 'waiting in the browser');
  const started = Date.now();
  assert.equal(await tools.stopSignIns({ timeoutMs: 4000 }), 1, 'one sign-in ended');
  assert.ok(Date.now() - started < 3000, `ended by the kill, not the bound (${Date.now() - started} ms)`);
  await pressed;
  assert.equal(tools.snapshot().tools.claude.busy, null);
  assert.equal(await tools.stopSignIns(), 0, 'nothing left to end');
});
