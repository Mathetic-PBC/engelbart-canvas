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
const ZSH_PROVIDER_SCRIPTS = Object.freeze({
  claude: `${POSIX_STARTUP_UNSET}if [ -n "\${ENGELBART_CLAUDE_BIN:-}" ]; then "$ENGELBART_CLAUDE_BIN"; else claude; fi; provider_status=$?; printf "\\r\\n[Claude Code exited with status %d]\\r\\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il`,
  codex: `${POSIX_STARTUP_UNSET}if [ -n "\${ENGELBART_CODEX_BIN:-}" ]; then "$ENGELBART_CODEX_BIN"; else codex; fi; provider_status=$?; printf "\\r\\n[Codex exited with status %d]\\r\\n" "$provider_status"; exec "$TERMINAL_USER_SHELL" -il`,
});

const FISH_PROVIDER_SCRIPTS = Object.freeze({
  claude: `${FISH_STARTUP_UNSET}if set -q ENGELBART_CLAUDE_BIN; $ENGELBART_CLAUDE_BIN; else; claude; end; set provider_status $status; printf "\\r\\n[Claude Code exited with status %d]\\r\\n" $provider_status; exec "$TERMINAL_USER_SHELL" --login --interactive`,
  codex: `${FISH_STARTUP_UNSET}if set -q ENGELBART_CODEX_BIN; $ENGELBART_CODEX_BIN; else; codex; end; set provider_status $status; printf "\\r\\n[Codex exited with status %d]\\r\\n" $provider_status; exec "$TERMINAL_USER_SHELL" --login --interactive`,
});

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

// Windows (2026-10-05, docs/windows-port.md): the same scripts run in Git for Windows' bash, whose PATH is written the
// POSIX way (/c/Users/…, joined by ":"), so the folders, joined the Windows way (path.delimiter), are converted first.
const WINDOWS_GIT_PATH = 'PATH="$(cygpath -p "$ENGELBART_GIT_BIN"):$PATH"; ';
const WINDOWS_AGENT_PATH = 'PATH="$PATH:$(cygpath -p "$ENGELBART_AGENT_PATH")"; ';

const isFish = (shell) => path.basename(shell) === 'fish';
const gitPathFor = (shell, environment, platform) => (environment && environment.ENGELBART_GIT_BIN ? (platform === 'win32' ? WINDOWS_GIT_PATH : isFish(shell) ? FISH_GIT_PATH : POSIX_GIT_PATH) : '');
const agentPathFor = (shell, environment, platform) => (environment && environment.ENGELBART_AGENT_PATH ? (platform === 'win32' ? WINDOWS_AGENT_PATH : isFish(shell) ? FISH_AGENT_PATH : POSIX_AGENT_PATH) : '');

/**
 * How `command` runs in the person's login shell, the PATH the terminal has (an app opened from Finder has none
 * worth using). `environment`: what the shell will be started with; ENGELBART_GIT_BIN in it goes first on PATH,
 * ENGELBART_AGENT_PATH's folders last. On Windows the shell is Git for Windows' bash (resolveShell).
 */
function loginShellArgs(shell, command, environment = {}, platform = process.platform) {
  const full = `${gitPathFor(shell, environment, platform)}${agentPathFor(shell, environment, platform)}${command}`;
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

// Git for Windows (2026-10-05, docs/windows-port.md): its bash.exe runs every POSIX script Engelbart writes (agent runs,
// Builds, sign-in, the summarizer), so they stay as they are. It is looked for beside the `git` on PATH (…\Git\cmd\git.exe
// → …\Git\bin\bash.exe), then where its installer puts it for everyone and for one person. Without it, Engelbart says so
// once as it starts (src/main/index.cjs), with where to get it.
const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/download/win';
const GIT_BASH_MISSING = `Engelbart runs its agents, Builds and sign-ins with Git for Windows, which is not installed. Install it from ${GIT_FOR_WINDOWS_URL}, then open Engelbart again.`;

/** A variable of a Windows environment, whose names have any case (Path, PATH); a copy of process.env keeps theirs. */
function windowsVariable(environment, name) {
  const key = Object.keys(environment || {}).find((each) => each.toUpperCase() === name.toUpperCase());
  return key && typeof environment[key] === 'string' ? environment[key] : '';
}

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** Where Git for Windows' bash.exe may be, in the order they are tried. */
function gitBashPlaces(environment = process.env, { exists = isFile } = {}) {
  const git = windowsVariable(environment, 'PATH').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    .map((dir) => path.win32.join(dir, 'git.exe')).find(exists);
  const programFiles = windowsVariable(environment, 'ProgramFiles');
  const localAppData = windowsVariable(environment, 'LOCALAPPDATA');
  return [
    git && path.win32.join(git, '..', '..', 'bin', 'bash.exe'),
    programFiles && path.win32.join(programFiles, 'Git', 'bin', 'bash.exe'),
    localAppData && path.win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
}

/** Git for Windows' bash.exe, or null when it is not installed. */
function findGitBash(environment = process.env, { exists = isFile } = {}) {
  return gitBashPlaces(environment, { exists }).find(exists) || null;
}

/**
 * The shell Engelbart's own scripts run in: the person's ($SHELL), else zsh, else bash. On Windows, Git for Windows'
 * bash; when it is missing, where its installer would put it, so a command fails as "not found" (and starts working
 * once it is installed) instead of Engelbart failing to start.
 */
function resolveShell(environment = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return findGitBash(environment) || path.win32.join(windowsVariable(environment, 'ProgramFiles') || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  }
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

// A terminal on Windows opens PowerShell: pwsh.exe (PowerShell 7) when it is on PATH, else Windows PowerShell, which
// every Windows has. Claude Code and Codex run in it, and it stays open when they exit.
const POWERSHELL_PROVIDER_SCRIPTS = Object.freeze({
  claude: 'if ($env:ENGELBART_CLAUDE_BIN) { & $env:ENGELBART_CLAUDE_BIN } else { claude }; Write-Host "`r`n[Claude Code exited with status $LASTEXITCODE]"',
  codex: 'if ($env:ENGELBART_CODEX_BIN) { & $env:ENGELBART_CODEX_BIN } else { codex }; Write-Host "`r`n[Codex exited with status $LASTEXITCODE]"',
});

/** The terminal's shell on Windows: pwsh.exe on PATH, else Windows PowerShell. */
function resolvePowerShell(environment = process.env, { exists = isFile } = {}) {
  const dirs = windowsVariable(environment, 'PATH').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const pwsh = dirs.map((dir) => path.win32.join(dir, 'pwsh.exe')).find(exists);
  if (pwsh) return pwsh;
  const system = windowsVariable(environment, 'SystemRoot') || 'C:\\Windows';
  return path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powerShellArguments(provider) {
  return provider === 'shell' ? ['-NoLogo'] : ['-NoLogo', '-NoExit', '-Command', POWERSHELL_PROVIDER_SCRIPTS[provider]];
}

function shellArguments(shell, provider, environment = {}) {
  if (provider === 'shell') {
    return isFish(shell) ? ['--login', '--interactive'] : ['-il']; // zsh's own startup files put Engelbart's Git first and the agents last (../shell-rc.cjs)
  }
  return loginShellArgs(shell, (isFish(shell) ? FISH_PROVIDER_SCRIPTS : ZSH_PROVIDER_SCRIPTS)[provider], environment);
}

function createLaunchSpec(request, sourceEnvironment = process.env, platform = process.platform) {
  const validated = validateCreateRequest(request);
  if (platform === 'win32') {
    const environment = sanitizeEnvironment(sourceEnvironment);
    const shell = resolvePowerShell(environment);
    // Claude Code's and Codex's folders last on PATH (ENGELBART_AGENT_PATH): PowerShell's PATH is the one it is given.
    if (environment.ENGELBART_AGENT_PATH) {
      const key = Object.keys(environment).find((each) => each.toUpperCase() === 'PATH') || 'Path';
      environment[key] = [environment[key], environment.ENGELBART_AGENT_PATH].filter(Boolean).join(';');
    }
    environment.TERMINAL_USER_SHELL = shell;
    return { file: shell, args: powerShellArguments(validated.provider), cwd: validated.cwd, cols: validated.cols, rows: validated.rows, env: environment, provider: validated.provider };
  }
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
  GIT_BASH_MISSING,
  GIT_FOR_WINDOWS_URL,
  createLaunchSpec,
  findGitBash,
  loginShellArgs,
  resolvePowerShell,
  resolveShell,
  sanitizeEnvironment,
  validateCreateRequest,
};
