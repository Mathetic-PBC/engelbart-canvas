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

// By its full path when its name runs another copy (ENGELBART_CLAUDE_BIN, ../tools/manager.cjs environment: an old one
// first on PATH, 2026-09-30); else by its name, which also runs an alias of it.
// Engelbart's Stage tool (MATH-79, ./stage-bridges.cjs): the agent the script starts, by either route, is given the
// `engelbart-stage` MCP server and a line saying what it is for, read from the environment main started the session
// with (STAGE_ENVIRONMENT), so nothing in them is quoted here. Without those variables the command is as it was.
const STAGE_ENVIRONMENT = Object.freeze({
  claude: Object.freeze(['ENGELBART_TERMINAL_MCP', 'ENGELBART_TERMINAL_NOTE']),
  codex: Object.freeze(['ENGELBART_TERMINAL_CODEX_COMMAND', 'ENGELBART_TERMINAL_CODEX_ARGS', 'ENGELBART_TERMINAL_CODEX_ENV', 'ENGELBART_TERMINAL_CODEX_NOTE']),
});
// The same words in zsh, bash and fish: each "$NAME" is one argument.
const STAGE_FLAGS = Object.freeze({
  claude: ' --mcp-config "$ENGELBART_TERMINAL_MCP" --append-system-prompt "$ENGELBART_TERMINAL_NOTE"',
  codex: ' -c "$ENGELBART_TERMINAL_CODEX_COMMAND" -c "$ENGELBART_TERMINAL_CODEX_ARGS" -c "$ENGELBART_TERMINAL_CODEX_ENV" -c "$ENGELBART_TERMINAL_CODEX_NOTE"',
});
const PROVIDER_SCRIPT = Object.freeze({
  claude: { bin: 'ENGELBART_CLAUDE_BIN', name: 'claude', label: 'Claude Code' },
  codex: { bin: 'ENGELBART_CODEX_BIN', name: 'codex', label: 'Codex' },
});

const zshProviderScript = ({ bin, name, label }, flags) => `${POSIX_STARTUP_UNSET}if [ -n "\${${bin}:-}" ]; then "$${bin}"${flags}; else ${name}${flags}; fi; provider_status=$?; printf "\\r\\n[${label} exited with status %d]\\r\\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il`;
const fishProviderScript = ({ bin, name, label }, flags) => `${FISH_STARTUP_UNSET}if set -q ${bin}; $${bin}${flags}; else; ${name}${flags}; end; set provider_status $status; printf "\\r\\n[${label} exited with status %d]\\r\\n" $provider_status; exec "$TERMINAL_USER_SHELL" --login --interactive`;

/** Whether the session's environment carries everything the provider's Stage flags read. */
const hasStage = (provider, environment) => !!STAGE_ENVIRONMENT[provider] && STAGE_ENVIRONMENT[provider].every((key) => !!(environment && environment[key]));

// Engelbart's own Git, while it stands in for a missing one (../tools/bundled-git.cjs), goes first on PATH for what a
// login shell runs. It has to be put there by the command, after the person's startup files: those rebuild PATH
// (macOS's path_helper puts /usr/bin first, and with it Apple's stub, which opens Apple's installer).
const POSIX_GIT_PATH = 'PATH="$ENGELBART_GIT_BIN:$PATH"; ';
const FISH_GIT_PATH = 'set -gx PATH $ENGELBART_GIT_BIN $PATH; ';

// Claude Code and Codex where the login shell's PATH does not reach them (../tools/manager.cjs environment: a new account,
// whose .zshrc never added ~/.local/bin, where their installers put them) go last on PATH, so `claude` and `codex` run
// by name in the terminal as they do anywhere else, and the person's own copies, when PATH has them, still come first.
const POSIX_AGENT_PATH = 'PATH="$PATH:$ENGELBART_AGENT_PATH"; ';
const FISH_AGENT_PATH = 'set -gx PATH $PATH (string split : -- $ENGELBART_AGENT_PATH); ';

const isFish = (shell) => path.basename(shell) === 'fish';
const gitPathFor = (shell, environment) => (environment && environment.ENGELBART_GIT_BIN ? (isFish(shell) ? FISH_GIT_PATH : POSIX_GIT_PATH) : '');
const agentPathFor = (shell, environment) => (environment && environment.ENGELBART_AGENT_PATH ? (isFish(shell) ? FISH_AGENT_PATH : POSIX_AGENT_PATH) : '');

/**
 * How `command` runs in the person's login shell, the PATH the terminal has (an app opened from Finder has none
 * worth using). `environment`: what the shell will be started with; ENGELBART_GIT_BIN in it goes first on PATH,
 * ENGELBART_AGENT_PATH's folders last.
 */
function loginShellArgs(shell, command, environment = {}) {
  const full = `${gitPathFor(shell, environment)}${agentPathFor(shell, environment)}${command}`;
  return isFish(shell) ? ['--login', '--interactive', '--command', full] : ['-ilc', full];
}

function isTransientEnvironmentKey(key, value) {
  return TRANSIENT_KEYS.has(key)
    || key.startsWith('ELECTRON_')
    || key.startsWith('WARP_')
    || key.startsWith('ENGELBART_TERMINAL_') // a session's own Stage tool, never another's (createLaunchSpec `stage`)
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
    return isFish(shell) ? ['--login', '--interactive'] : ['-il']; // zsh's own startup files put Engelbart's Git first and the agents last (../shell-rc.cjs)
  }
  const flags = hasStage(provider, environment) ? STAGE_FLAGS[provider] : '';
  return loginShellArgs(shell, (isFish(shell) ? fishProviderScript : zshProviderScript)(PROVIDER_SCRIPT[provider], flags), environment);
}

/**
 * `stage`: the Stage tool's variables for a Claude Code or Codex session (STAGE_ENVIRONMENT, from ./stage-bridges.cjs);
 * a shell session, or a provider whose variables are not all there, gets none of them.
 */
function createLaunchSpec(request, sourceEnvironment = process.env, { stage = null } = {}) {
  const validated = validateCreateRequest(request);
  const shell = resolveShell(sourceEnvironment);
  const environment = sanitizeEnvironment(sourceEnvironment);
  environment.SHELL = shell;
  environment.TERMINAL_USER_SHELL = shell;
  const keys = STAGE_ENVIRONMENT[validated.provider];
  if (keys && stage && keys.every((key) => typeof stage[key] === 'string' && stage[key] && !stage[key].includes('\0'))) {
    for (const key of keys) environment[key] = stage[key];
  }
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
  STAGE_ENVIRONMENT,
  createLaunchSpec,
  loginShellArgs,
  resolveShell,
  sanitizeEnvironment,
  validateCreateRequest,
};
