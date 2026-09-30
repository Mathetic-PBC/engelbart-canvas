'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareZshDir, prepareLauncher, environmentForSessions } = require('../src/main/shell-rc.cjs');
const { createLaunchSpec, loginShellArgs } = require('../src/main/terminal/launch.cjs');
const { parseHistory, unmetafy, readShellHistory } = require('../src/main/shell-history.cjs');

// Every shell here runs `detached` (2026-09-29): in a session of its own, with no controlling terminal. Run from a
// terminal (npm test, or an Engelbart started with npm start running a Build's checks), an interactive zsh reads that
// terminal's keyboard instead of the input it is given, and never runs its commands.
function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-zsh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('the wrappers are written once; sessions launch through an executable launcher named after the shell', (t) => {
  const userData = temporaryDirectory(t);
  const dir = prepareZshDir(userData);
  assert.equal(dir, path.join(userData, 'zsh'));
  for (const name of ['.zshenv', '.zprofile', '.zshrc']) assert.ok(fs.existsSync(path.join(dir, name)), name);
  const rc = fs.readFileSync(path.join(dir, '.zshrc'), 'utf8');
  assert.match(rc, /source "\$ZDOTDIR\/\.zshrc"/);
  assert.match(rc, /precmd_functions\+=\(engelbart_precmd\)/);
  assert.match(rc, /preexec_functions\+=\(engelbart_preexec\)/);
  const before = fs.statSync(path.join(dir, '.zshrc')).mtimeMs;
  prepareZshDir(userData);
  assert.equal(fs.statSync(path.join(dir, '.zshrc')).mtimeMs, before, 'unchanged files are not rewritten');

  const env = environmentForSessions({ PATH: '/usr/bin:/bin', HOME: '/tmp/x', SHELL: '/bin/zsh', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: '9', CLAUDE_VAULT: 'mine', ANTHROPIC_API_KEY: 'k' }, userData);
  assert.equal(env.SHELL, path.join(userData, 'shell', 'zsh'));
  assert.deepEqual([env.CLAUDE_CODE_CHILD_SESSION, env.CLAUDE_CODE_MESSAGING_TOKEN, env.CLAUDE_PID], [undefined, undefined, undefined], "an outer agent's session does not leak into terminals");
  assert.deepEqual([env.CLAUDE_VAULT, env.ANTHROPIC_API_KEY], ['mine', 'k'], 'your own settings pass through');
  assert.ok(fs.statSync(env.SHELL).mode & 0o100, 'launcher is executable');
  const spec = createLaunchSpec({ provider: 'shell', cwd: userData, cols: 80, rows: 24 }, env);
  assert.equal(spec.file, env.SHELL, 'the engine accepts the launcher as the shell');
  assert.deepEqual(spec.args, ['-il']);
  assert.equal(spec.env.TERMINAL_USER_SHELL, env.SHELL, 'the shell that follows an agent uses it too');
});

test('through the launcher, zsh runs the user rc files, hides the prompt, emits marks, and restores ZDOTDIR and SHELL', { skip: !fs.existsSync('/bin/zsh') }, (t) => {
  const userData = temporaryDirectory(t);
  const home = temporaryDirectory(t);
  fs.writeFileSync(path.join(home, '.zshenv'), 'export FROM_ZSHENV=1\n');
  fs.writeFileSync(path.join(home, '.zprofile'), 'export FROM_ZPROFILE=1\n');
  fs.writeFileSync(path.join(home, '.zshrc'), "export FROM_ZSHRC=1\nPROMPT='user> '\nRPROMPT='right'\nmy_prompt() { PROMPT='again> ' }\nprecmd_functions+=(my_prompt)\n");
  const launcher = prepareLauncher(userData, '/bin/zsh');
  const script = [
    'for f in $precmd_functions; do $f; done',
    'for f in $preexec_functions; do $f "echo hi; ls"; done',
    'print -r -- "env=$FROM_ZSHENV$FROM_ZPROFILE$FROM_ZSHRC prompt=[$PROMPT] rprompt=[$RPROMPT] zdotdir=[${ZDOTDIR-unset}] shell=[$SHELL]"',
  ].join('; ');
  const result = spawnSync(launcher, ['-ilc', script], { detached: true, env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /env=111 prompt=\[\] rprompt=\[\] zdotdir=\[unset\] shell=\[\/bin\/zsh\]/);
  assert.ok(result.stdout.includes(`\u001b]633;P;Cwd=${process.cwd()}\u0007\u001b]633;A\u0007`), 'prompt mark with the directory');
  assert.ok(result.stdout.includes('\u001b]633;E;echo hi; ls\u0007\u001b]633;C\u0007'), 'command mark with the command line');
});

test('the shell that replaces an agent when it exits is integrated too (prompt mark, no prompt)', { skip: !fs.existsSync('/bin/zsh') }, (t) => {
  const userData = temporaryDirectory(t);
  const home = temporaryDirectory(t);
  fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='user> '\n");
  const launcher = prepareLauncher(userData, '/bin/zsh');
  // What the engine runs for Claude Code / Codex: `<agent>; …; exec "$TERMINAL_USER_SHELL" -il`.
  const result = spawnSync(launcher, ['-ilc', 'true; exec "$TERMINAL_USER_SHELL" -il'], { detached: true, env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb', TERMINAL_USER_SHELL: launcher }, input: 'print -r -- "prompt=[$PROMPT]"\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('\u001b]633;A\u0007'), 'ready mark from the follow-up shell');
  assert.ok(result.stdout.includes('prompt=[]'), result.stdout);
});

test('a ZDOTDIR the user sets in ~/.zshenv is honoured and handed back', { skip: !fs.existsSync('/bin/zsh') }, (t) => {
  const userData = temporaryDirectory(t);
  const home = temporaryDirectory(t);
  const custom = path.join(home, '.config', 'zsh');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(home, '.zshenv'), `export ZDOTDIR=${JSON.stringify(custom)}\n`);
  fs.writeFileSync(path.join(custom, '.zshrc'), 'export FROM_CUSTOM=1\n');
  const launcher = prepareLauncher(userData, '/bin/zsh');
  const result = spawnSync(launcher, ['-ilc', 'print -r -- "custom=$FROM_CUSTOM zdotdir=[$ZDOTDIR]"'], { detached: true, env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`custom=1 zdotdir=[${custom}]`), result.stdout);
});

test('Engelbart\'s own Git comes first on PATH after the person\'s startup files (and macOS\'s path_helper) rebuilt it, and only while it stands in (2026-09-28)', { skip: !fs.existsSync('/bin/zsh') }, (t) => {
  const userData = temporaryDirectory(t);
  const home = temporaryDirectory(t);
  const bin = path.join(temporaryDirectory(t), 'Application Support', 'engelbart-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho engelbart-git\n', { mode: 0o755 });
  // Startup files that rebuild PATH from scratch, as some do; /etc/zprofile's path_helper puts /usr/bin first on its own.
  fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH=/usr/bin:/bin:/usr/sbin:/sbin\n');
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'dumb', ENGELBART_GIT_BIN: bin };
  const hidden = spawnSync('/bin/zsh', loginShellArgs('/bin/zsh', 'command -v git', env), { detached: true, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stdout.trim().split('\n').pop(), path.join(bin, 'git'), 'a hidden run (@bart, Build, summaries)');
  const launcher = prepareLauncher(userData, '/bin/zsh');
  const terminal = spawnSync(launcher, ['-il'], { detached: true, env, input: 'command -v git\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes(path.join(bin, 'git')), `the terminal: ${terminal.stdout}`);
  const without = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'dumb' };
  assert.deepEqual(loginShellArgs('/bin/zsh', 'command -v git', without), ['-ilc', 'command -v git'], 'the person\'s own Git: the command is left as it is');
  const own = spawnSync(launcher, ['-il'], { detached: true, env: without, input: 'command -v git\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.ok(!own.stdout.includes(path.join(bin, 'git')), own.stdout);
});

test('an agent whose folder the person\'s PATH misses is found by name in the terminal and in hidden runs, after their own (2026-09-29)', { skip: !fs.existsSync('/bin/zsh') }, (t) => {
  const userData = temporaryDirectory(t);
  const home = temporaryDirectory(t);
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho engelbart-claude\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH=/usr/bin:/bin:/usr/sbin:/sbin\n'); // a new account's: no ~/.local/bin
  const env = { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb', ENGELBART_AGENT_PATH: bin };
  const hidden = spawnSync('/bin/zsh', loginShellArgs('/bin/zsh', 'command -v claude', env), { detached: true, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(hidden.stdout.trim().split('\n').pop(), path.join(bin, 'claude'), hidden.stderr);
  const launcher = prepareLauncher(userData, '/bin/zsh');
  const terminal = spawnSync(launcher, ['-il'], { detached: true, env, input: 'command -v claude\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes(path.join(bin, 'claude')), `the terminal: ${terminal.stdout}`);
  const without = spawnSync(launcher, ['-il'], { detached: true, env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, input: 'command -v claude || echo none\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.ok(!without.stdout.includes(path.join(bin, 'claude')), without.stdout);
});

test('shell history: extended-format prefixes, continuation lines, metafied bytes, latest-use order', (t) => {
  assert.deepEqual(parseHistory(': 1700000000:0;ls -la\n: 1700000001:0;git status\n: 1700000002:0;ls -la\nplain command\n'), ['git status', 'ls -la', 'plain command']);
  assert.deepEqual(parseHistory(': 1:0;echo one \\\ntwo\n: 2:0;pwd\n'), ['echo one \ntwo', 'pwd']);
  assert.deepEqual(parseHistory('a\nb\nc\nd\n', 2), ['c', 'd']);
  assert.equal(unmetafy(Buffer.from([0x63, 0x83, 0xc3 ^ 0x20, 0x83, 0xa9 ^ 0x20])).toString('utf8'), 'cé');
  const home = temporaryDirectory(t);
  fs.writeFileSync(path.join(home, '.zsh_history'), ': 1:0;first\n: 2:0;second\n');
  assert.deepEqual(readShellHistory({ homeDir: home, environment: {} }), ['first', 'second']);
  assert.deepEqual(readShellHistory({ homeDir: path.join(home, 'missing'), environment: {} }), []);
});
