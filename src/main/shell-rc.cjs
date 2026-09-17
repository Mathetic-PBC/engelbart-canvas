'use strict';

// The terminal pane types into its own box at the bottom (design 2026-09-17, "Run commands"),
// so the shell must not draw a prompt in the transcript. zsh locates its startup files through
// ZDOTDIR: this directory holds wrappers that run your own ~/.zshenv, ~/.zprofile and ~/.zshrc
// (honouring a ZDOTDIR they set), then empty the prompt — again before every prompt, so prompt
// frameworks cannot put it back. Your ~/.zlogin runs as usual. Other shells are left alone.

const fs = require('node:fs');
const path = require('node:path');

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const FILES = {
  '.zshenv': (dir) => `# Engelbart wrapper: your own ~/.zshenv, then keep reading this directory.
ENGELBART_ZDOTDIR=${quote(dir)}
ZDOTDIR="$HOME"
[[ -r "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
ENGELBART_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
ZDOTDIR="$ENGELBART_ZDOTDIR"
`,
  '.zprofile': () => `# Engelbart wrapper: your own .zprofile.
ZDOTDIR="\${ENGELBART_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
ZDOTDIR="$ENGELBART_ZDOTDIR"
`,
  '.zshrc': () => `# Engelbart wrapper: your own .zshrc, then no prompt — the terminal pane has its own input box.
ZDOTDIR="\${ENGELBART_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
engelbart_hide_prompt() { PROMPT='' PS1='' RPROMPT='' RPS1='' PROMPT_EOL_MARK='' }
engelbart_hide_prompt
precmd_functions+=(engelbart_hide_prompt)
unset ENGELBART_ZDOTDIR ENGELBART_USER_ZDOTDIR
`,
};

/** Writes the wrapper files under <userData>/zsh and returns that directory. */
function prepareZshDir(userDataDir) {
  const dir = path.join(userDataDir, 'zsh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, render] of Object.entries(FILES)) {
    const file = path.join(dir, name);
    const text = render(dir);
    let existing = null;
    try { existing = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
    if (existing !== text) fs.writeFileSync(file, text, { mode: 0o600 });
  }
  return dir;
}

/** The environment terminal sessions start with: the process environment plus ZDOTDIR. */
function environmentWithHiddenPrompt(base, userDataDir) {
  return { ...base, ZDOTDIR: prepareZshDir(userDataDir) };
}

module.exports = { prepareZshDir, environmentWithHiddenPrompt, FILES };
