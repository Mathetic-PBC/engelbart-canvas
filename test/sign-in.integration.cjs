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
