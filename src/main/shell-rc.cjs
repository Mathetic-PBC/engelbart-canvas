'use strict';

// The terminal pane types into its own box at the bottom (design 2026-09-17, "Run commands"),
// so the shell must not draw a prompt in the transcript, and the pane has to know when a
// command is running (then the keyboard belongs to the program, not the box).
//
// Sessions start through a tiny launcher, <userData>/shell/zsh, which points zsh at wrapper
// startup files (ZDOTDIR = <userData>/zsh) and execs your real shell. The wrappers run your own
// ~/.zshenv, ~/.zprofile and ~/.zshrc (honouring a ZDOTDIR they set), then:
//   * empty the prompt, again before every prompt, so prompt frameworks cannot put it back;
//   * emit shell-integration marks (OSC 633: A prompt, C command started, E command line,
//     P Cwd=…) that the pane reads to show or hide the box and keep the directory chip true;
//   * hand ZDOTDIR back to your own value, so ~/.zlogin runs as usual and anything started from
//     the shell (installers that edit ${ZDOTDIR:-$HOME}/.zshrc, nested shells) sees your setup.
// Because the launcher is also $TERMINAL_USER_SHELL, the shell that replaces Claude Code or
// Codex when they exit gets the same treatment. bash and fish run through the launcher untouched.

const fs = require('node:fs');
const path = require('node:path');
const { resolveShell } = require('./terminal/launch.cjs');

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const FILES = {
  '.zshenv': (dir) => `# Engelbart wrapper: your own .zshenv, then keep reading this directory.
ENGELBART_ZDOTDIR=${quote(dir)}
ZDOTDIR="\${ENGELBART_PRIOR_ZDOTDIR:-$HOME}"
[[ "$ZDOTDIR" == "$ENGELBART_ZDOTDIR" ]] && ZDOTDIR="$HOME"
[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
ENGELBART_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
ZDOTDIR="$ENGELBART_ZDOTDIR"
`,
  '.zprofile': () => `# Engelbart wrapper: your own .zprofile.
ZDOTDIR="\${ENGELBART_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
ZDOTDIR="$ENGELBART_ZDOTDIR"
`,
  '.zshrc': () => `# Engelbart wrapper: your own .zshrc, then no prompt (the terminal pane has its own input box)
# and marks that tell the pane when a command starts, when the shell is ready, and where it is.
ZDOTDIR="\${ENGELBART_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
engelbart_hide_prompt() { PROMPT='' PS1='' RPROMPT='' RPS1='' PROMPT_EOL_MARK='' }
engelbart_precmd() { engelbart_hide_prompt; printf '\\e]633;P;Cwd=%s\\a\\e]633;A\\a' "$PWD" }
engelbart_preexec() { local line="\${1//[[:cntrl:]]/ }"; printf '\\e]633;E;%s\\a\\e]633;C\\a' "\${line[1,400]}" }
engelbart_hide_prompt
precmd_functions+=(engelbart_precmd)
preexec_functions+=(engelbart_preexec)
unset ENGELBART_ZDOTDIR ENGELBART_USER_ZDOTDIR ENGELBART_PRIOR_ZDOTDIR
[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR
`,
};

function writeIfChanged(file, text, mode) {
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (existing !== text) fs.writeFileSync(file, text, { mode });
  try { fs.chmodSync(file, mode); } catch { /* best effort */ }
}

/** Writes the wrapper startup files under <userData>/zsh and returns that directory. */
function prepareZshDir(userDataDir) {
  const dir = path.join(userDataDir, 'zsh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, render] of Object.entries(FILES)) writeIfChanged(path.join(dir, name), render(dir), 0o600);
  return dir;
}

/** Writes the launcher (named after your shell, as the engine requires) and returns its path. */
function prepareLauncher(userDataDir, realShell) {
  const zdotdir = prepareZshDir(userDataDir);
  const dir = path.join(userDataDir, 'shell');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const launcher = path.join(dir, path.basename(realShell));
  writeIfChanged(launcher, `#!/bin/sh
# Engelbart: start your shell with Engelbart's startup wrappers (zsh finds them through ZDOTDIR).
ENGELBART_PRIOR_ZDOTDIR="\${ZDOTDIR-}"; export ENGELBART_PRIOR_ZDOTDIR
ZDOTDIR=${quote(zdotdir)}; export ZDOTDIR
SHELL=${quote(realShell)}; export SHELL
exec ${quote(realShell)} "$@"
`, 0o700);
  return launcher;
}

// When Engelbart itself is started from inside an agent session (`! npm run relaunch -- --dev`
// in Claude Code), that session's private variables would flow into every terminal, and an agent
// started there would believe it is a child of the outer one (no transcript, borrowed sockets).
// The engine already drops the older names; these are the rest. Your own settings (ANTHROPIC_*,
// CLAUDE_VAULT, CLAUDE_CODE_USE_*, …) pass through.
const SESSION_SCOPED = [/^CLAUDE_CODE_(CHILD_SESSION|EXECPATH|MESSAGING_|SESSION_|SSE_PORT)/, /^CLAUDE_(PID|EFFORT)$/, /^CODEX_(SANDBOX|MANAGED_BY)/];

/** `base` without an outer agent session's private variables. */
function scrubAgentSession(base) {
  const environment = {};
  for (const [key, value] of Object.entries(base)) {
    if (!SESSION_SCOPED.some((pattern) => pattern.test(key))) environment[key] = value;
  }
  return environment;
}

/** The environment terminal sessions start with: the process environment, minus an outer agent's session, with SHELL = the launcher. */
function environmentForSessions(base, userDataDir) {
  const realShell = resolveShell(base);
  const environment = scrubAgentSession(base);
  environment.SHELL = prepareLauncher(userDataDir, realShell);
  return environment;
}

module.exports = { prepareZshDir, prepareLauncher, environmentForSessions, scrubAgentSession, FILES };
