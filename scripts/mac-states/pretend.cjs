'use strict';

// Pretend Claude Code, Codex and Git for scripts/mac-states (2026-09-30): small sh scripts that answer what Engelbart
// asks of the real ones (--version, sign-in status, sign-in, update, a run), laid out where each installer puts them.
// Each install keeps its version and behaviour in a state folder of its own, so an update or a new install changes
// what it answers; sign-in lives in the home folder, shared by every copy of the same CLI, as the real ones keep it.
//
// Behaviours: ok, broken (does not start: a missing library), hang (--version never answers), garbage (--version
// prints no version), clash (another program of the same name), auth-hang (the sign-in status never answers),
// update-offline (its updater cannot reach the network).

const fs = require('node:fs');
const path = require('node:path');
const { REQUIREMENTS } = require('../../src/main/tools/requirements.cjs');

const q = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

function claudeScript(state, kind) {
  const update = {
    homebrew: 'echo "Claude Code is managed by Homebrew. To update, run: brew upgrade claude-code"; exit 1',
    npm: 'echo "npm error code EACCES"; echo "npm error syscall rename"; echo "npm error Error: EACCES: permission denied, rename \'/usr/local/lib/node_modules/@anthropic-ai/claude-code\'"; exit 243',
  }[kind] || 'NV=$(cat "$S/update-to"); echo "Updating Claude Code from $V to $NV…"; echo "$NV" > "$S/version"; echo "Successfully updated to version $NV"';
  // The native install's sign-in says so when ~/.local/bin is not on the PATH it runs with (as Claude Code does).
  const pathCheck = kind === 'native' ? 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Native installation exists but ~/.local/bin is not in your PATH"; exit 1;; esac' : ':';
  return `#!/bin/sh
# A pretend Claude Code (scripts/mac-states), ${kind} install.
S=${q(state)}
V=$(cat "$S/version"); B=$(cat "$S/behaviour" 2>/dev/null)
AUTH="$HOME/.claude/.pretend-auth"
case "$B" in broken) echo "dyld[4242]: Library not loaded: @rpath/libclaude.dylib" >&2; exit 134;; esac
case "$1" in
  --version|-v)
    case "$B" in hang) sleep 120;; garbage) echo "usage: claude [options] [command] [prompt]"; exit 0;; clash) echo "claude 3.1 (a different program)"; exit 0;; esac
    echo "$V (Claude Code)";;
  auth)
    case "$2" in
      status) [ "$B" = auth-hang ] && sleep 120; if [ -s "$AUTH" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai"}'; else echo '{"loggedIn": false}'; exit 1; fi;;
      login) ${pathCheck}
        echo "Opening your browser to sign in…"; echo "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&client_id=pretend"
        sleep 1; mkdir -p "$HOME/.claude"; echo claude.ai > "$AUTH"; echo "Login successful.";;
      *) echo "error: unknown command auth $2"; exit 1;;
    esac;;
  update) [ "$B" = update-offline ] && { echo "Failed to check for updates: getaddrinfo ENOTFOUND storage.googleapis.com"; exit 1; }
    ${update};;
  *) if [ -s "$AUTH" ]; then echo "PRETEND-CLAUDE-RAN $V"; else echo "Invalid API key · Please run /login"; exit 1; fi;;
esac
`;
}

function codexScript(state, kind) {
  const update = {
    homebrew: 'echo "Codex was installed with Homebrew. Run: brew upgrade codex"; exit 1',
  }[kind] || 'NV=$(cat "$S/update-to"); echo "Updating Codex from $V to $NV…"; echo "$NV" > "$S/version"; echo "Updated to $NV"';
  return `#!/bin/sh
# A pretend Codex (scripts/mac-states), ${kind} install.
S=${q(state)}
V=$(cat "$S/version"); B=$(cat "$S/behaviour" 2>/dev/null)
AUTH="\${CODEX_HOME:-$HOME/.codex}/.pretend-auth"
case "$B" in broken) echo "dyld[4242]: Library not loaded: @rpath/libcodex.dylib" >&2; exit 134;; esac
if [ "$B" = clash ]; then
  case "$1" in --version) echo "1.0.2";; *) echo "codex: generates documentation from source comments. Unknown command: $1"; exit 1;; esac
  exit 0
fi
case "$1" in
  --version|-V)
    case "$B" in hang) sleep 120;; garbage) echo "Usage: codex [OPTIONS] [PROMPT]"; exit 0;; esac
    echo "codex-cli $V";;
  login)
    case "$2" in
      status) [ "$B" = auth-hang ] && sleep 120
        case "$(cat "$AUTH" 2>/dev/null)" in
          chatgpt) echo "Logged in using ChatGPT";;
          apikey) echo "Logged in using an API key - sk-proj-***ABCD";;
          *) echo "Not logged in"; exit 1;;
        esac;;
      "") echo "Starting local login server on http://localhost:1455."; echo "If your browser did not open, navigate to this URL to authenticate:"
        echo ""; echo "https://auth.openai.com/oauth/authorize?response_type=code&client_id=pretend"
        sleep 1; mkdir -p "$(dirname "$AUTH")"; echo chatgpt > "$AUTH"; echo "Successfully logged in";;
      *) echo "error: unexpected argument '$2'"; exit 2;;
    esac;;
  update) [ "$B" = update-offline ] && { echo "error sending request for url (https://api.github.com/repos/openai/codex/releases/latest)"; exit 1; }
    ${update};;
  *) if [ "$(cat "$AUTH" 2>/dev/null)" = chatgpt ]; then echo "PRETEND-CODEX-RAN $V"; else echo "Not logged in. Run: codex login"; exit 1; fi;;
esac
`;
}

function gitScript(version) {
  return `#!/bin/sh
# A pretend Git (scripts/mac-states): answers its version, and hands everything else to Apple's.
case "$1" in --version) echo "git version ${version}";; *) exec /usr/bin/git "$@";; esac
`;
}

function writeExecutable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
}

function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try { fs.unlinkSync(at); } catch { /* none */ }
  fs.symlinkSync(target, at);
}

/**
 * Lays out one install of a pretend CLI in `mac` (./machine.cjs) where its installer puts it, → the path it is run by.
 * install: { tool: 'claude' | 'codex' | 'git', kind, version, behaviour = 'ok', updateTo = minimum, dir (kind 'dir') }
 *   claude kinds: native (~/.local/bin → ~/.local/share/claude/versions), npm (under nvm), homebrew, bun, dir
 *   codex kinds:  standalone (~/.local/bin → ~/.codex/packages/standalone), npm (under nvm), homebrew, dir
 *   git kinds:    homebrew, dir
 */
function install(mac, spec, index = 0) {
  const { tool, kind, behaviour = 'ok' } = spec;
  const version = spec.version || (REQUIREMENTS[tool] ? REQUIREMENTS[tool].minimum : '2.50.1');
  const state = path.join(mac.root, 'state', `${tool}-${kind}-${index}`);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'version'), version);
  fs.writeFileSync(path.join(state, 'behaviour'), behaviour);
  fs.writeFileSync(path.join(state, 'update-to'), spec.updateTo || (REQUIREMENTS[tool] ? REQUIREMENTS[tool].minimum : version));
  if (tool === 'git') {
    const at = kind === 'homebrew' ? path.join(mac.brew, 'bin', 'git') : path.join(spec.dir, 'git');
    const real = kind === 'homebrew' ? path.join(mac.brew, 'Cellar', 'git', version, 'bin', 'git') : at;
    writeExecutable(real, gitScript(version));
    if (real !== at) link(real, at);
    return at;
  }
  const script = tool === 'claude' ? claudeScript(state, kind) : codexScript(state, kind);
  const home = mac.home;
  const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v22.12.0', 'bin');
  const layouts = {
    claude: {
      native: () => [path.join(home, '.local', 'share', 'claude', 'versions', version), path.join(home, '.local', 'bin', 'claude')],
      npm: () => [path.join(home, '.nvm', 'versions', 'node', 'v22.12.0', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), path.join(nvmBin, 'claude')],
      homebrew: () => [path.join(mac.brew, 'Caskroom', 'claude-code', version, 'claude'), path.join(mac.brew, 'bin', 'claude')],
      bun: () => [path.join(home, '.bun', 'install', 'global', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), path.join(home, '.bun', 'bin', 'claude')],
      dir: () => [path.join(spec.dir, 'claude'), path.join(spec.dir, 'claude')],
    },
    codex: {
      standalone: () => [path.join(home, '.codex', 'packages', 'standalone', 'releases', version, 'codex'), path.join(home, '.local', 'bin', 'codex')],
      npm: () => [path.join(home, '.nvm', 'versions', 'node', 'v22.12.0', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), path.join(nvmBin, 'codex')],
      homebrew: () => [path.join(mac.brew, 'Cellar', 'codex', version, 'bin', 'codex'), path.join(mac.brew, 'bin', 'codex')],
      dir: () => [path.join(spec.dir, 'codex'), path.join(spec.dir, 'codex')],
    },
  };
  const [real, at] = layouts[tool][kind]();
  writeExecutable(real, script);
  if (tool === 'codex' && kind === 'standalone') {
    const current = path.join(home, '.codex', 'packages', 'standalone', 'current');
    link(path.dirname(real), current);
    link(path.join(current, 'codex'), at);
  } else if (real !== at) {
    link(real, at);
  }
  return at;
}

/** A pretend installer (what `curl … | bash` runs), installing `tool` the way its real installer does. */
function installerScript(mac, tool) {
  const kind = tool === 'claude' ? 'native' : 'standalone';
  const version = REQUIREMENTS[tool].minimum;
  const state = path.join(mac.root, 'state', `${tool}-installed`);
  const script = tool === 'claude' ? claudeScript(state, kind) : codexScript(state, kind);
  const payload = path.join(mac.root, 'payload', tool);
  writeExecutable(payload, script);
  const name = tool === 'claude' ? 'Claude Code' : 'Codex';
  const place = tool === 'claude'
    ? `mkdir -p "$HOME/.local/share/claude/versions" "$HOME/.local/bin"; cp ${q(payload)} "$HOME/.local/share/claude/versions/${version}"; ln -sf "$HOME/.local/share/claude/versions/${version}" "$HOME/.local/bin/claude"`
    : `R="$HOME/.codex/packages/standalone/releases/${version}"; mkdir -p "$R" "$HOME/.local/bin"; cp ${q(payload)} "$R/codex"; ln -sfn "$R" "$HOME/.codex/packages/standalone/current"; ln -sf "$HOME/.codex/packages/standalone/current/codex" "$HOME/.local/bin/codex"`;
  return `#!/bin/sh
# A pretend ${name} installer (scripts/mac-states).
set -e
mkdir -p ${q(state)}; echo ${version} > ${q(path.join(state, 'version'))}; echo ok > ${q(path.join(state, 'behaviour'))}; echo ${version} > ${q(path.join(state, 'update-to'))}
${place}
echo "✔ ${name} successfully installed!"
echo "  Version: ${version}"
echo "  Location: ~/.local/bin/${tool}"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "⚠ Setup notes: Native installation exists but ~/.local/bin is not in your PATH.";; esac
`;
}

module.exports = { install, installerScript, claudeScript, codexScript, gitScript };
