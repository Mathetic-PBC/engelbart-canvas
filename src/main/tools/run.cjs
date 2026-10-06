'use strict';

// Running the programs the tool check asks (2026-09-23). Everything goes through `exec`, which never
// throws: it resolves to what happened, so a hung, missing or failing program is an answer like any
// other. `shell` runs a command in the login shell, the PATH @bart and the terminal use (an app opened
// from Finder has no useful PATH of its own); values reach it through the environment, never quoted.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveShell, sanitizeEnvironment } = require('../terminal/launch.cjs');

const MARK = '__ENGELBART_TOOLS__';

function createRunner({ environment = process.env, execFileImpl = execFile } = {}) {
  const shellPath = resolveShell(environment);
  const fish = path.basename(shellPath) === 'fish';
  const base = sanitizeEnvironment(environment);

  /** → { code, signal, stdout, stderr, timedOut, missing } */
  function exec(file, args, { env = {}, timeout = 20_000, cwd, input } = {}) {
    return new Promise((resolve) => {
      const child = execFileImpl(file, args, { env: { ...base, ...env }, timeout, cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({
          code,
          signal: error && error.signal ? error.signal : null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: !!(error && error.killed),
          missing: !!(error && error.code === 'ENOENT'),
        });
      });
      if (child && child.stdin) {
        if (input != null) child.stdin.end(input);
        else child.stdin.end();
      }
    });
  }

  /** A command in the login shell. Its output is what follows the mark, so whatever the rc files print is skipped. */
  async function shell(command, { env = {}, timeout = 20_000 } = {}) {
    const marked = `printf '${MARK}\\n'; ${command}`;
    const args = fish ? ['--login', '--interactive', '--command', marked] : ['-ilc', marked];
    const out = await exec(shellPath, args, { env, timeout });
    const at = out.stdout.lastIndexOf(`${MARK}\n`);
    return { ...out, stdout: at === -1 ? '' : out.stdout.slice(at + MARK.length + 1), marked: at !== -1 };
  }

  return { exec, shell, shellPath, fish };
}

module.exports = { createRunner, MARK };
