'use strict';

// A pretend Mac for scripts/mac-states (2026-09-30): a home folder of its own, its startup files, a Homebrew folder of
// its own, and the environment an Engelbart opened from Finder starts with. Engelbart's real code then runs against it:
// the login shell it asks is the real /bin/zsh (or bash), reading this home's startup files.
//
// This Mac's own /etc/zprofile (path_helper) puts its /usr/local/bin and /opt/homebrew/bin on every login shell's PATH,
// and with them whatever is installed there (an old Claude Code, here). A Mac being simulated has neither: the first
// lines of its .zprofile (or .bash_profile) take them off again, and put its own Homebrew folder where the real one
// was, when it has Homebrew. Everything after those lines is the scenario's.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, installerScript } = require('./pretend.cjs');

const REAL_BREW = '/opt/homebrew/bin';
const REAL_LOCAL = '/usr/local/bin';

function zshPreamble(brew, local, hasBrew) {
  return `# scripts/mac-states: this is a simulated Mac. What this real Mac's /etc/zprofile put on PATH from its own
# Homebrew and /usr/local/bin is taken off, and the simulated Mac's own folders are put where they were.
__mac_path=()
for __mac_dir in $path; do
  case "$__mac_dir" in
    /opt/homebrew/*) ${hasBrew ? `__mac_path+=("${brew}/bin")` : ':'} ;;
    ${REAL_LOCAL}) __mac_path+=("${local}") ;;
    *) __mac_path+=("$__mac_dir") ;;
  esac
done
path=($__mac_path); unset __mac_path __mac_dir
# ---- the scenario's own .zprofile ----
`;
}

function bashPreamble(brew, local, hasBrew) {
  return `# scripts/mac-states: this is a simulated Mac (see .zprofile in the same scenario for why).
__mac_path=
__mac_ifs=$IFS; IFS=:
for __mac_dir in $PATH; do
  case "$__mac_dir" in
    /opt/homebrew/*) ${hasBrew ? `__mac_dir="${brew}/bin"` : 'continue'} ;;
    ${REAL_LOCAL}) __mac_dir="${local}" ;;
  esac
  __mac_path="\${__mac_path:+$__mac_path:}$__mac_dir"
done
IFS=$__mac_ifs; PATH=$__mac_path; export PATH; unset __mac_path __mac_dir __mac_ifs
# ---- the scenario's own .bash_profile ----
`;
}

/**
 * Builds the Mac a scenario (./scenarios.cjs) describes, under `parent`. → {
 *   root, home, brew, local, userData, tmp,
 *   env          what Engelbart's process has, opened from Finder
 *   systemBins   where detect looks when PATH misses a program (the simulated Mac's /opt/homebrew/bin, /usr/local/bin)
 *   bundledGit   the launcher of the Git that came with Engelbart, when the scenario has one
 *   installers   the pretend installers, as ../../src/main/tools/install.cjs INSTALLERS
 *   paths        where each install in `scenario.installs` is run from
 * }
 */
function makeMac(scenario, parent) {
  const root = fs.mkdtempSync(path.join(parent, `${scenario.name}-`));
  const home = path.join(root, 'home');
  const brew = path.join(root, 'opt', 'homebrew');
  const local = path.join(root, 'usr', 'local', 'bin');
  const userData = path.join(root, 'electron');
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, path.join(brew, 'bin'), local, userData, tmp]) fs.mkdirSync(dir, { recursive: true });
  const shell = scenario.shell === 'bash' ? '/bin/bash' : '/bin/zsh';
  const hasBrew = !!scenario.homebrew;
  const mac = { root, home, brew: path.join(brew), local, userData, tmp, shell };

  // Both shells' login files, whichever the person uses: a .zshrc can hand over to bash (`exec bash -l`), whose
  // /etc/profile would put this Mac's Homebrew back.
  const rc = { ...(scenario.rc || {}) };
  rc['.zprofile'] = zshPreamble(brew, local, hasBrew) + (rc['.zprofile'] || '');
  rc['.bash_profile'] = bashPreamble(brew, local, hasBrew) + (rc['.bash_profile'] || '');
  for (const [name, text] of Object.entries(rc)) {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text.replace(/\$MAC_BREW/g, brew));
  }
  for (const [name, text] of Object.entries(scenario.files || {})) {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  const paths = (scenario.installs || []).map((spec, index) => install(mac, { ...spec, dir: spec.dir && spec.dir.replace(/^~/, home) }, index));
  for (const [tool, how] of Object.entries(scenario.signedIn || {})) {
    const file = tool === 'claude' ? path.join(home, '.claude', '.pretend-auth') : path.join(home, '.codex', '.pretend-auth');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, how === true ? (tool === 'claude' ? 'claude.ai' : 'chatgpt') : String(how));
  }

  let bundledGit = null;
  if (scenario.bundledGit) {
    bundledGit = path.join(root, 'Engelbart.app', 'Contents', 'Resources', 'git', 'engelbart-bin', 'git');
    fs.mkdirSync(path.dirname(bundledGit), { recursive: true });
    fs.writeFileSync(bundledGit, '#!/bin/sh\n# The Git that came with Engelbart (pretend): its version, and Apple\'s for the rest.\ncase "$1" in --version) echo "git version 2.53.0";; *) exec /usr/bin/git "$@";; esac\n', { mode: 0o755 });
  }

  const installers = {};
  for (const tool of ['claude', 'codex']) {
    const file = path.join(root, 'installers', `${tool}.sh`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, installerScript(mac, tool));
    const offline = (scenario.offline || []).includes(tool);
    installers[tool] = { url: offline ? 'https://127.0.0.1:9/install.sh' : `file://${file}`, interpreter: tool === 'claude' ? 'bash' : 'sh', env: tool === 'codex' ? { CODEX_NON_INTERACTIVE: '1' } : {} };
  }

  // An app opened from Finder: launchd's PATH, no TERM, the person's shell.
  const env = { HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: shell, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: `${tmp}/`, __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' };
  return { ...mac, env, systemBins: [path.join(brew, 'bin'), local], bundledGit, installers, paths };
}

module.exports = { makeMac, REAL_BREW, REAL_LOCAL };
