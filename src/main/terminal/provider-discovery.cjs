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

async function discoverProviders(sourceEnvironment = process.env) {
  const shell = resolveShell(sourceEnvironment);
  const [claude, codex] = await Promise.all([
    probeProvider(shell, 'claude', sourceEnvironment),
    probeProvider(shell, 'codex', sourceEnvironment),
  ]);
  return [
    { id: 'shell', name: PROVIDERS.shell.name, available: true, path: shell },
    { id: 'claude', name: PROVIDERS.claude.name, ...claude },
    { id: 'codex', name: PROVIDERS.codex.name, ...codex },
  ];
}

module.exports = { discoverProviders };
