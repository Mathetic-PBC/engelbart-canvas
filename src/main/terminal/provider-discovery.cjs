'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { PROVIDERS, resolveShell, sanitizeEnvironment } = require('./launch.cjs');

const RESULT_PREFIX = '__EXPERIMENTAL_TERMINAL_PROVIDER__:';
const ALIAS_LABEL = 'shell alias/function';

function discoveryCommand(shellName, provider) {
  if (shellName === 'fish') {
    return `set provider_path (command -s ${provider} 2>/dev/null); if test -n "$provider_path"; printf '${RESULT_PREFIX}path:%s\\n' "$provider_path"; else if type -q ${provider}; printf '${RESULT_PREFIX}alias\\n'; else; exit 1; end; end`;
  }
  const resolve = shellName === 'bash' ? `type -P ${provider}` : `whence -p ${provider}`;
  const available = shellName === 'bash' ? `type ${provider}` : `whence ${provider}`;
  return `provider_path=$(${resolve} 2>/dev/null); if [ -n "$provider_path" ] && [ -x "$provider_path" ]; then printf '${RESULT_PREFIX}path:%s\\n' "$provider_path"; elif ${available} >/dev/null 2>&1; then printf '${RESULT_PREFIX}alias\\n'; else exit 1; fi`;
}

function probeProvider(shell, provider, sourceEnvironment) {
  const shellName = path.basename(shell);
  const command = discoveryCommand(shellName, provider);
  const args = shellName === 'fish'
    ? ['--login', '--interactive', '--command', command]
    : ['-ilc', command];
  return new Promise((resolve) => {
    execFile(shell, args, {
      env: sanitizeEnvironment(sourceEnvironment),
      timeout: 5000,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) return resolve({ available: false, path: null });
      const result = stdout.split(/\r?\n/).map((line) => line.trim()).findLast((line) => line.startsWith(RESULT_PREFIX));
      if (result === `${RESULT_PREFIX}alias`) return resolve({ available: true, path: ALIAS_LABEL });
      if (!result || !result.startsWith(`${RESULT_PREFIX}path:`)) return resolve({ available: false, path: null });
      const executable = result.slice(`${RESULT_PREFIX}path:`.length);
      try {
        if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new Error('not a file');
        fs.accessSync(executable, fs.constants.X_OK);
        return resolve({ available: true, path: path.resolve(executable) });
      } catch {
        return resolve({ available: false, path: null });
      }
    });
  });
}

// Sign-in belongs to the CLIs: each is asked for its own status, and only true / false / null
// (could not tell) leaves this file — never the account details either one prints.
const AUTH = {
  claude: {
    command: 'claude auth status --json',
    read: (output) => {
      const match = /"loggedIn"\s*:\s*(true|false)/.exec(output);
      return match ? match[1] === 'true' : null;
    },
  },
  codex: {
    command: 'codex login status',
    read: (output) => (/not logged in/i.test(output) ? false : /logged in/i.test(output) ? true : null),
  },
};

function probeAuthentication(shell, provider, sourceEnvironment) {
  const shellName = path.basename(shell);
  const command = `printf '${RESULT_PREFIX}auth\\n'; ${AUTH[provider].command} 2>&1`;
  const args = shellName === 'fish'
    ? ['--login', '--interactive', '--command', command]
    : ['-ilc', command];
  return new Promise((resolve) => {
    execFile(shell, args, {
      env: sanitizeEnvironment(sourceEnvironment),
      timeout: 15000,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      // A signed-out CLI exits non-zero and still says so; only output decides.
      const text = String(stdout || '');
      const start = text.lastIndexOf(`${RESULT_PREFIX}auth`);
      resolve(start === -1 ? null : AUTH[provider].read(text.slice(start)));
    });
  });
}

async function probe(shell, provider, sourceEnvironment) {
  const found = await probeProvider(shell, provider, sourceEnvironment);
  const authenticated = found.available ? await probeAuthentication(shell, provider, sourceEnvironment) : null;
  return { ...found, authenticated, checkedAt: new Date().toISOString() };
}

async function discoverProviders(sourceEnvironment = process.env) {
  const shell = resolveShell(sourceEnvironment);
  const [claude, codex] = await Promise.all([
    probe(shell, 'claude', sourceEnvironment),
    probe(shell, 'codex', sourceEnvironment),
  ]);
  return [
    { id: 'shell', name: PROVIDERS.shell.name, available: true, path: shell },
    { id: 'claude', name: PROVIDERS.claude.name, ...claude },
    { id: 'codex', name: PROVIDERS.codex.name, ...codex },
  ];
}

/**
 * What is installed and signed in, held in memory only (a saved "signed in" goes stale the moment
 * someone logs out elsewhere). refresh() is the launch check; get() answers from the last check and
 * runs one itself when there is none, or when the last one left a sign-in unknown.
 */
function createProviderStatus(sourceEnvironment = process.env, discover = discoverProviders) {
  let known = null;
  let running = null;
  const refresh = () => {
    if (!running) {
      running = discover(sourceEnvironment)
        .then((providers) => { known = providers; return providers; })
        .finally(() => { running = null; });
    }
    return running;
  };
  const unknown = () => !known || known.some((provider) => provider.available && provider.authenticated === null && provider.id !== 'shell');
  const get = () => (unknown() ? refresh() : Promise.resolve(known));
  return { refresh, get, peek: () => known };
}

module.exports = { discoverProviders, createProviderStatus };
