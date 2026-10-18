const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLaunchSpec,
  loginShellArgs,
  sanitizeEnvironment,
  validateCreateRequest,
} = require('../src/main/terminal/launch.cjs');
const { normalizeSettings, mergeSettings } = require('../src/main/terminal/settings.cjs');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'experimental-terminal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('sanitizeEnvironment removes host transients without changing its source', () => {
  const source = {
    HOME: '/Users/tester',
    LANG: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/private/tmp/ssh.sock',
    CODEX_HOME: '/Users/tester/.codex-custom',
    CLAUDE_CONFIG_DIR: '/Users/tester/.claude-custom',
    ANTHROPIC_API_KEY: 'preserve-anthropic-key',
    OPENAI_API_KEY: 'preserve-openai-key',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'parent',
    CLAUDE_CODE_SESSION_ID: 'claude-session',
    CLAUDE_AGENT_ID: 'agent',
    CLAUDE_PARENT_SESSION_ID: 'parent-session',
    CODEX_SESSION_ID: 'codex-session',
    CODEX_THREAD_ID: 'codex-thread',
    CODEX_CI: '1',
    CODEX_VERSION: '9.9.9',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    NODE_CHANNEL_FD: '3',
    NODE_UNIQUE_ID: 'worker',
    NODE_OPTIONS: '--inspect=9229',
    INSPECT_BRK: '1',
    WARP_IS_LOCAL_SHELL_SESSION: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  const original = { ...source };

  const result = sanitizeEnvironment(source);

  assert.deepEqual(source, original);
  assert.equal(result.HOME, '/Users/tester');
  assert.equal(result.LANG, 'en_US.UTF-8');
  assert.equal(result.SSH_AUTH_SOCK, '/private/tmp/ssh.sock');
  assert.equal(result.CODEX_HOME, '/Users/tester/.codex-custom');
  assert.equal(result.CLAUDE_CONFIG_DIR, '/Users/tester/.claude-custom');
  assert.equal(result.ANTHROPIC_API_KEY, 'preserve-anthropic-key');
  assert.equal(result.OPENAI_API_KEY, 'preserve-openai-key');
  for (const key of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_AGENT_ID', 'CLAUDE_PARENT_SESSION_ID', 'CODEX_SESSION_ID',
    'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_VERSION', 'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID',
    'NODE_OPTIONS', 'INSPECT_BRK', 'WARP_IS_LOCAL_SHELL_SESSION', 'NO_COLOR',
  ]) {
    assert.equal(Object.hasOwn(result, key), false, `${key} should be removed`);
  }
  assert.equal(result.TERM, 'xterm-256color');
  assert.equal(result.COLORTERM, 'truecolor');
  assert.equal(result.TERM_PROGRAM, 'Engelbart');
  assert.equal(result.TERM_PROGRAM_VERSION, '0.1.0');
});

test('sanitizeEnvironment removes dynamic Electron, inspector and Warp variables', () => {
  const result = sanitizeEnvironment({
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_INSPECT_RESUME_ON_START: '1',
    INSPECTOR_PORT: '9230',
    WARP_HONOR_PS1: '1',
    USER_SETTING: 'retained',
  });

  assert.equal(Object.hasOwn(result, 'ELECTRON_ENABLE_LOGGING'), false);
  assert.equal(Object.hasOwn(result, 'NODE_INSPECT_RESUME_ON_START'), false);
  assert.equal(Object.hasOwn(result, 'INSPECTOR_PORT'), false);
  assert.equal(Object.hasOwn(result, 'WARP_HONOR_PS1'), false);
  assert.equal(result.USER_SETTING, 'retained');
});

test('sanitizeEnvironment supplies a UTF-8 locale only when the parent has none', () => {
  assert.equal(sanitizeEnvironment({ HOME: '/Users/tester' }).LANG, 'en_US.UTF-8');
  assert.equal(sanitizeEnvironment({ LANG: 'de_DE.UTF-8' }).LANG, 'de_DE.UTF-8');
  assert.equal(sanitizeEnvironment({ LC_ALL: 'C.UTF-8' }).LANG, undefined);
});

test('validateCreateRequest rejects provider text outside the fixed enum', (t) => {
  const cwd = temporaryDirectory(t);

  assert.throws(
    () => validateCreateRequest({ provider: 'claude; touch /tmp/pwned', cwd, cols: 80, rows: 24 }),
    /provider/i,
  );
  assert.throws(
    () => validateCreateRequest({ provider: { toString: () => 'shell' }, cwd, cols: 80, rows: 24 }),
    /provider/i,
  );
});

test('validateCreateRequest requires an existing directory and bounded dimensions', (t) => {
  const cwd = temporaryDirectory(t);
  const file = path.join(cwd, 'not-a-directory');
  fs.writeFileSync(file, 'fixture');

  assert.throws(
    () => validateCreateRequest({ provider: 'shell', cwd: path.join(cwd, 'missing'), cols: 80, rows: 24 }),
    /directory/i,
  );
  assert.throws(
    () => validateCreateRequest({ provider: 'shell', cwd: file, cols: 80, rows: 24 }),
    /directory/i,
  );
  assert.throws(
    () => validateCreateRequest({ provider: 'shell', cwd, cols: 0, rows: 24 }),
    /cols/i,
  );
  assert.throws(
    () => validateCreateRequest({ provider: 'shell', cwd, cols: 80, rows: 1001 }),
    /rows/i,
  );
  assert.deepEqual(
    validateCreateRequest({ provider: 'codex', cwd, cols: 120, rows: 40 }),
    { provider: 'codex', cwd, cols: 120, rows: 40 },
  );
});

test('createLaunchSpec uses login-interactive shell args and fixed provider commands', { skip: process.platform === 'win32' && 'POSIX terminals only: a Windows terminal opens PowerShell (test/windows-platform.test.cjs)' }, (t) => {
  const cwd = temporaryDirectory(t);
  const environment = { HOME: cwd, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };

  const shell = createLaunchSpec({ provider: 'shell', cwd, cols: 80, rows: 24 }, environment);
  assert.equal(shell.file, '/bin/zsh');
  assert.deepEqual(shell.args, ['-il']);
  assert.equal(shell.cwd, cwd);

  const claude = createLaunchSpec({ provider: 'claude', cwd, cols: 80, rows: 24 }, environment);
  assert.equal(claude.file, '/bin/zsh');
  assert.deepEqual(claude.args.slice(0, 2), ['-ilc', 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; if [ -n "${ENGELBART_CLAUDE_BIN:-}" ]; then "$ENGELBART_CLAUDE_BIN"; else claude; fi; provider_status=$?; printf "\\r\\n[Claude Code exited with status %d]\\r\\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il']);
  assert.equal(claude.env.TERMINAL_USER_SHELL, '/bin/zsh');

  const codex = createLaunchSpec({ provider: 'codex', cwd, cols: 80, rows: 24 }, environment);
  assert.deepEqual(codex.args.slice(0, 2), ['-ilc', 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; if [ -n "${ENGELBART_CODEX_BIN:-}" ]; then "$ENGELBART_CODEX_BIN"; else codex; fi; provider_status=$?; printf "\\r\\n[Codex exited with status %d]\\r\\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il']);
});

test('an agent started from the terminal gets Engelbart\'s own Git first on PATH while it stands in; bash and fish too (2026-09-28)', { skip: process.platform === 'win32' && 'POSIX terminals only: a Windows terminal opens PowerShell (test/windows-platform.test.cjs)' }, (t) => {
  const cwd = temporaryDirectory(t);
  const environment = { HOME: cwd, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', ENGELBART_GIT_BIN: '/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin' };
  const claude = createLaunchSpec({ provider: 'claude', cwd, cols: 80, rows: 24 }, environment);
  assert.equal(claude.args[0], '-ilc');
  assert.ok(claude.args[1].startsWith('PATH="$ENGELBART_GIT_BIN:$PATH"; unset CLAUDECODE '), claude.args[1]);
  assert.equal(claude.env.ENGELBART_GIT_BIN, environment.ENGELBART_GIT_BIN);
  assert.deepEqual(createLaunchSpec({ provider: 'shell', cwd, cols: 80, rows: 24 }, environment).args, ['-il'], 'a plain zsh gets it from its startup files');
  assert.deepEqual(loginShellArgs('/usr/local/bin/fish', 'codex', environment), ['--login', '--interactive', '--command', 'set -gx PATH $ENGELBART_GIT_BIN $PATH; codex']);
  assert.deepEqual(loginShellArgs('/bin/bash', 'codex', environment), ['-ilc', 'PATH="$ENGELBART_GIT_BIN:$PATH"; codex']);
});

test('Claude Code and Codex installed where the login shell\'s PATH misses them run by name in the terminal: their folders go last on PATH (2026-09-29)', { skip: process.platform === 'win32' && 'POSIX terminals only: a Windows terminal opens PowerShell (test/windows-platform.test.cjs)' }, (t) => {
  const cwd = temporaryDirectory(t);
  const environment = { HOME: cwd, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', ENGELBART_AGENT_PATH: `${cwd}/.local/bin` };
  const claude = createLaunchSpec({ provider: 'claude', cwd, cols: 80, rows: 24 }, environment);
  assert.ok(claude.args[1].startsWith('PATH="$PATH:$ENGELBART_AGENT_PATH"; unset CLAUDECODE '), claude.args[1]);
  assert.equal(claude.env.ENGELBART_AGENT_PATH, environment.ENGELBART_AGENT_PATH);
  assert.deepEqual(loginShellArgs('/bin/zsh', 'codex', { ...environment, ENGELBART_GIT_BIN: '/git/bin' }), ['-ilc', 'PATH="$ENGELBART_GIT_BIN:$PATH"; PATH="$PATH:$ENGELBART_AGENT_PATH"; codex'], 'Engelbart\'s Git first, the agents last');
  assert.deepEqual(loginShellArgs('/usr/local/bin/fish', 'codex', environment), ['--login', '--interactive', '--command', 'set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); codex']);
  assert.deepEqual(loginShellArgs('/bin/zsh', 'codex', { HOME: cwd }), ['-ilc', 'codex'], 'on PATH already: left as it is');
});

test('normalizeSettings clamps corrupt persisted values to app-owned defaults', (t) => {
  const home = temporaryDirectory(t);
  assert.deepEqual(
    normalizeSettings({ fontSize: 999, lastCwd: '/missing/path', sidebarVisible: 'yes' }, home),
    { fontSize: 14, lastCwd: home, sidebarVisible: true },
  );
});

test('mergeSettings accepts only supported keys and validates the working directory', (t) => {
  const home = temporaryDirectory(t);
  const cwd = temporaryDirectory(t);
  const current = { fontSize: 14, lastCwd: home, sidebarVisible: true };

  assert.deepEqual(
    mergeSettings(current, { fontSize: 19, lastCwd: cwd, sidebarVisible: false }, home),
    { fontSize: 19, lastCwd: cwd, sidebarVisible: false },
  );
  assert.throws(() => mergeSettings(current, { fontSize: 'large' }, home), /fontSize/i);
  assert.throws(() => mergeSettings(current, { lastCwd: path.join(home, 'missing') }, home), /directory/i);
  assert.throws(() => mergeSettings(current, { transcript: 'not-app-owned' }, home), /setting/i);
});

