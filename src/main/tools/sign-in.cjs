'use strict';

// Signing in to Claude Code or Codex (2026-09-23; design D16): the CLI's own sign-in, run in a hidden
// terminal (a PTY, so it behaves as it does in one). The CLI opens the browser itself and ends when the
// browser hands it the sign-in. The page's address, when it prints one, is passed on so the dialog can
// open it again; a "press Enter" before opening the browser is answered. The CLI's folder goes last on PATH, as in
// the terminal (../terminal/launch.cjs): Claude Code found where the login shell's PATH does not reach (~/.local/bin
// on a new account) otherwise signs in saying its installation "is not in your PATH" (2026-09-29).
//
// Signing out (2026-10-03, Connections): the CLI's own logout, `claude auth logout` / `codex logout` (both listed by
// --help on Claude Code 2.1.223 and 2.1.288, Codex 0.159.3). Neither asks anything, so it runs in the login shell as the
// sign-in check does (./detect.cjs AUTH), not in a terminal.

const os = require('node:os');
const path = require('node:path');
const { sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { shellSilent } = require('./detect.cjs');

const COMMANDS = Object.freeze({
  claude: 'exec "$ENGELBART_TOOL" auth login --claudeai',
  codex: 'exec "$ENGELBART_TOOL" login',
});
const SIGN_OUT_COMMANDS = Object.freeze({
  claude: 'exec "$ENGELBART_TOOL" auth logout 2>&1',
  codex: 'exec "$ENGELBART_TOOL" logout 2>&1',
});
const SIGN_OUT_TIMEOUT_MS = 30_000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_RE = /https:\/\/[^\s"'<>]+/;

function createSignInProcess({ pty, shell, environment = process.env }) {
  return (name, file, { onUrl = () => {} } = {}) => {
    const env = { ...sanitizeEnvironment(environment), ENGELBART_TOOL: file, ENGELBART_AGENT_PATH: path.dirname(file) };
    const child = pty.spawn(shell, loginShellArgs(shell, COMMANDS[name], env), {
      name: 'xterm-256color',
      cols: 400, // wide, so a long sign-in address is never wrapped
      rows: 40,
      cwd: os.homedir(),
      env,
    });
    let output = '';
    let url = null;
    let pressed = false;
    child.onData((data) => {
      output = (output + data).slice(-50_000);
      const text = output.replace(ANSI, '');
      if (!url) {
        const match = URL_RE.exec(text);
        if (match) { url = match[0]; onUrl(url); }
      }
      if (!pressed && /press (enter|return)/i.test(text)) { pressed = true; try { child.write('\r'); } catch { /* ended */ } }
    });
    // A sign-in ended by Cancel (or the ten-minute limit) comes back with a signal and exit code 0 from node-pty:
    // it is reported as { code: null }, never as a success, and says nothing.
    const done = new Promise((resolve) => child.onExit(({ exitCode, signal }) => {
      if (signal) { resolve({ code: null, output: '' }); return; }
      const lines = output.replace(ANSI, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      resolve({ code: exitCode, output: exitCode === 0 ? '' : (lines[lines.length - 1] || '').slice(0, 200) });
    }));
    return { done, kill: () => { try { child.kill(); } catch { /* already gone */ } } };
  };
}

/** The CLI's logout, through the tool check's runner (./run.cjs). → { code, output }: output is the last line when it failed. */
function createSignOutProcess({ runner }) {
  return async (name, file) => {
    const out = await runner.shell(SIGN_OUT_COMMANDS[name], { env: { ENGELBART_TOOL: file }, timeout: SIGN_OUT_TIMEOUT_MS });
    if (out.timedOut) return { code: null, output: `it did not finish within ${SIGN_OUT_TIMEOUT_MS / 1000} seconds` };
    if (out.marked === false) return { code: null, output: shellSilent(runner) };
    const lines = out.stdout.replace(ANSI, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return { code: out.code, output: out.code === 0 ? '' : (lines[lines.length - 1] || `exit status ${out.code}`).slice(0, 200) };
  };
}

module.exports = { createSignInProcess, createSignOutProcess, COMMANDS, SIGN_OUT_COMMANDS };
