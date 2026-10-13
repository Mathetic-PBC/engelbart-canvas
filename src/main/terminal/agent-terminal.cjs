'use strict';

// The Engelbart terminal's agent sessions (2026-10-13, the "Onboarding" workspace, second round: "for the import agents
// they should route through the built-in Engelbart terminal"). A browser agent's CLI (../connect/agents.cjs, kind
// 'browse') runs as a terminal session does: a pseudo-terminal from node-pty, the person's login shell, the terminal's
// environment and PATH (./launch.cjs), so Claude Code and Codex see the same setup they see in Engelbart's terminal pane.
// Nobody looks at it: there is no renderer, so the few questions a CLI asks its terminal on start (what terminal it is,
// its size in pixels, its keyboard protocol) are answered here, as xterm.js answers them in the pane (Claude Code waits for
// those answers before it draws). What the session printed is kept (the last MAX_KEPT bytes), with escape codes taken out,
// for the Agent trace; each line is handed on as it ends.

const { loginShellArgs, resolveShell, sanitizeEnvironment } = require('./launch.cjs');

const MAX_KEPT = 2 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

// The questions a full-screen CLI asks its terminal, and xterm's answers.
const QUERIES = Object.freeze([
  [/\x1b\[>0?q/g, '\x1bP>|xterm.js(6.0.0)\x1b\\'], // XTVERSION
  [/\x1b\[0?c/g, '\x1b[?62;22c'], // DA1: a VT220 with colour
  [/\x1b\[>0?c/g, '\x1b[>0;276;0c'], // DA2
  [/\x1b\[\?u/g, '\x1b[?0u'], // the kitty keyboard protocol: off
  [/\x1b\[6n/g, '\x1b[1;1R'], // where the cursor is
  [/\x1b\[14t/g, '\x1b[4;800;1600t'], // the window's size in pixels
  [/\x1b\[16t/g, '\x1b[6;16;8t'], // a cell's size in pixels
  [/\x1b\]10;\?(?:\x07|\x1b\\)/g, '\x1b]10;rgb:1717/1717/1717\x1b\\'], // the text colour
  [/\x1b\]11;\?(?:\x07|\x1b\\)/g, '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'], // the background
  [/\x1b\[\?996n/g, '\x1b[?997;2n'], // light or dark: light
]);

/** Terminal output → plain text: escape sequences out, carriage returns that end lines out. */
function plain(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b_[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78DEHMc]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** The answers owed for the questions in `data` (a chunk the session printed), in the order asked. */
function answersFor(data) {
  const out = [];
  for (const [pattern, reply] of QUERIES) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(data))) out.push({ at: match.index, reply });
  }
  return out.sort((a, b) => a.at - b.at).map((one) => one.reply);
}

/**
 * `pty` node-pty (or a fake); `environment` the app's; `extraEnvironment()` what the terminal adds now (Engelbart's Git,
 * the agents' PATH: ../tools/manager.cjs environment).
 * → { run({ command, env, cwd, signal, timeout, onLine, cols, rows }) → Promise<{ output, exitCode, signal, timedOut, stopped }> }
 * `env`, when given, is the whole environment the session starts with (the caller has taken out what must not reach the
 * CLI, such as API keys); else the terminal's own.
 */
function createAgentTerminal({ pty = null, environment = process.env, extraEnvironment = () => ({}) } = {}) {
  const ptyModule = () => pty || require('node-pty'); // eslint-disable-line global-require

  function run({ command, env = null, cwd, signal = null, timeout = 45 * 60_000, onLine = () => {}, cols = 220, rows = 50 }) {
    return new Promise((resolve) => {
      const base = env ? { ...env } : sanitizeEnvironment({ ...environment, ...extraEnvironment() });
      const shell = resolveShell(base.SHELL ? base : environment);
      const merged = { ...base, TERM: 'xterm-256color', SHELL: shell, TERMINAL_USER_SHELL: shell };
      let handle;
      try {
        handle = ptyModule().spawn(shell, loginShellArgs(shell, command, merged), { name: 'xterm-256color', cols, rows, cwd, env: merged });
      } catch (error) {
        resolve({ output: '', exitCode: 127, signal: null, timedOut: false, stopped: false, error: error.message });
        return;
      }
      let kept = '';
      let partial = '';
      let ended = false;
      let timedOut = false;
      let stopped = false;
      let killTimer = null;
      const finish = (exitCode, exitSignal) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (partial) { try { onLine(partial); } catch { /* the reader's own */ } partial = ''; }
        resolve({ output: kept, exitCode, signal: exitSignal || null, timedOut, stopped });
      };
      const kill = () => {
        try { handle.kill('SIGTERM'); } catch { /* gone */ }
        killTimer = setTimeout(() => { try { handle.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
        if (killTimer.unref) killTimer.unref();
      };
      const onAbort = () => { stopped = true; kill(); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      if (timer.unref) timer.unref();
      if (signal) { if (signal.aborted) { stopped = true; setTimeout(kill, 0); } else signal.addEventListener('abort', onAbort, { once: true }); }
      handle.onData((data) => {
        for (const reply of answersFor(data)) { try { handle.write(reply); } catch { /* gone */ } }
        const text = plain(data);
        kept = (kept + text).slice(-MAX_KEPT);
        const lines = (partial + text).split('\n');
        partial = lines.pop();
        for (const line of lines) { try { onLine(line); } catch { /* the reader's own */ } }
      });
      handle.onExit(({ exitCode, signal: exitSignal }) => finish(exitCode, exitSignal));
    });
  }

  return { run };
}

module.exports = { createAgentTerminal, plain, answersFor, QUERIES };
