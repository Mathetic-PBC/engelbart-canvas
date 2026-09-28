'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = Object.freeze({
  shell: Object.freeze({ id: 'shell', name: 'Shell', command: null }),
  claude: Object.freeze({ id: 'claude', name: 'Claude Code', command: 'claude' }),
  codex: Object.freeze({ id: 'codex', name: 'Codex', command: 'codex' }),
});

const TRANSIENT_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_AGENT_ID',
  'CLAUDE_PARENT_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'CODEX_VERSION',
  'NODE_CHANNEL_FD',
  'NODE_UNIQUE_ID',
  'NO_COLOR',
]);

const POSIX_STARTUP_UNSET = 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; ';
const FISH_STARTUP_UNSET = 'set -e CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_AGENT_ID CLAUDE_PARENT_SESSION_ID CODEX_SESSION_ID CODEX_THREAD_ID CODEX_CI CODEX_VERSION NO_COLOR; ';

const ZSH_PROVIDER_SCRIPTS = Object.freeze({
  claude: `${POSIX_STARTUP_UNSET}claude; provider_status=$?; printf "\\r\\n[Claude Code exited with status %d]\\r\\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il`,
  codex: `${POSIX_STARTUP_UNSET}codex; provider_status=$?; printf "\\r\\n[Codex exited with status %d]\\r\\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il`,
});

const FISH_PROVIDER_SCRIPTS = Object.freeze({
  claude: `${FISH_STARTUP_UNSET}claude; set provider_status $status; printf "\\r\\n[Claude Code exited with status %d]\\r\\n" $provider_status; exec "$TERMINAL_USER_SHELL" --login --interactive`,
  codex: `${FISH_STARTUP_UNSET}codex; set provider_status $status; printf "\\r\\n[Codex exited with status %d]\\r\\n" $provider_status; exec "$TERMINAL_USER_SHELL" --login --interactive`,
});

// Engelbart's own Git, while it stands in for a missing one (../tools/bundled-git.cjs), goes first on PATH for what a
// login shell runs. It has to be put there by the command, after the person's startup files: those rebuild PATH
// (macOS's path_helper puts /usr/bin first, and with it Apple's stub, which opens Apple's installer).
const POSIX_GIT_PATH = 'PATH="$ENGELBART_GIT_BIN:$PATH"; ';
const FISH_GIT_PATH = 'set -gx PATH $ENGELBART_GIT_BIN $PATH; ';

const isFish = (shell) => path.basename(shell) === 'fish';
const gitPathFor = (shell, environment) => (environment && environment.ENGELBART_GIT_BIN ? (isFish(shell) ? FISH_GIT_PATH : POSIX_GIT_PATH) : '');

/**
 * How `command` runs in the person's login shell, the PATH the terminal has (an app opened from Finder has none
 * worth using). `environment`: what the shell will be started with; ENGELBART_GIT_BIN in it goes first on PATH.
 */
function loginShellArgs(shell, command, environment = {}) {
  const full = `${gitPathFor(shell, environment)}${command}`;
  return isFish(shell) ? ['--login', '--interactive', '--command', full] : ['-ilc', full];
}

function isTransientEnvironmentKey(key, value) {
  return TRANSIENT_KEYS.has(key)
    || key.startsWith('ELECTRON_')
    || key.startsWith('WARP_')
    || key.startsWith('INSPECT')
    || key.includes('INSPECTOR')
    || (key.startsWith('NODE_') && key.includes('INSPECT'))
    || (key === 'NODE_OPTIONS' && /(?:^|\s)--inspect(?:-brk)?(?:[=\s]|$)/.test(value || ''));
}

function sanitizeEnvironment(source = process.env) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Environment must be an object');
  }

  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !isTransientEnvironmentKey(key, value)) {
      environment[key] = value;
    }
  }
  environment.TERM = 'xterm-256color';
  environment.COLORTERM = 'truecolor';
  environment.TERM_PROGRAM = 'Engelbart';
  environment.TERM_PROGRAM_VERSION = '0.1.0';
  if (!environment.LANG && !Object.keys(environment).some((key) => key.startsWith('LC_'))) {
    environment.LANG = 'en_US.UTF-8';
  }
  return environment;
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveShell(environment = process.env) {
  const candidate = typeof environment.SHELL === 'string' ? environment.SHELL : '';
  const supported = new Set(['zsh', 'bash', 'fish']);
  if (path.isAbsolute(candidate) && supported.has(path.basename(candidate)) && isExecutableFile(candidate)) {
    return candidate;
  }
  if (isExecutableFile('/bin/zsh')) return '/bin/zsh';
  if (isExecutableFile('/bin/bash')) return '/bin/bash';
  throw new Error('No supported shell found (zsh, bash, or fish)');
}

function assertDimension(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validateCreateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Session request must be an object');
  }
  const { provider, cwd, cols, rows } = request;
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) {
    throw new TypeError('Unknown provider');
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096 || cwd.includes('\0')) {
    throw new TypeError('Working directory must be a valid path');
  }
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new TypeError('Working directory does not exist');
  }
  if (!stat.isDirectory()) {
    throw new TypeError('Working directory must be a directory');
  }
  assertDimension('cols', cols, 2, 500);
  assertDimension('rows', rows, 1, 500);
  return { provider, cwd: path.resolve(cwd), cols, rows };
}

function shellArguments(shell, provider, environment = {}) {
  if (provider === 'shell') {
    return isFish(shell) ? ['--login', '--interactive'] : ['-il']; // zsh's own startup files put Engelbart's Git first (../shell-rc.cjs)
  }
  return loginShellArgs(shell, (isFish(shell) ? FISH_PROVIDER_SCRIPTS : ZSH_PROVIDER_SCRIPTS)[provider], environment);
}

function createLaunchSpec(request, sourceEnvironment = process.env) {
  const validated = validateCreateRequest(request);
  const shell = resolveShell(sourceEnvironment);
  const environment = sanitizeEnvironment(sourceEnvironment);
  environment.SHELL = shell;
  environment.TERMINAL_USER_SHELL = shell;
  return {
    file: shell,
    args: shellArguments(shell, validated.provider, environment),
    cwd: validated.cwd,
    cols: validated.cols,
    rows: validated.rows,
    env: environment,
    provider: validated.provider,
  };
}

module.exports = {
  PROVIDERS,
  createLaunchSpec,
  loginShellArgs,
  resolveShell,
  sanitizeEnvironment,
  validateCreateRequest,
};
