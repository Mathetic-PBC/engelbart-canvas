'use strict';

// The Macs scripts/mac-states runs Engelbart against (2026-09-30). Each: what is on it, and what should happen.
//
//   installs   pretend programs and where their installers put them (./pretend.cjs install)
//   signedIn   { claude: true, codex: true | 'apikey' }
//   rc         the home folder's startup files (.zprofile and .bash_profile come after the simulated Mac's own lines)
//   files      other files in the home folder
//   homebrew   the Mac has Homebrew (its folder goes where this Mac's is on PATH)
//   offline    the installers of these tools cannot be reached
//   bundledGit Engelbart came with its own Git (the app people download; a checkout has none until npm run fetch-git)
//   person     what the person does in the setup dialog, per tool: 'fix' (the default: Install, Update or Sign In,
//              whatever the row offers) or 'skip'
//   expect     launch: statuses after the launch check, before the person does anything (checked when given)
//              final:  statuses after the person is done (default: ready for Claude Code and Codex)
//              reach:  per tool, where it must run by name: menu (the terminal's Claude Code / Codex item), shell (typed
//                      in a terminal), hidden (@bart, Build, summaries). Default: all three for a tool that ends ready.
//              errors: per tool, a pattern the row's message must match at the end
//              notes:  per tool, a pattern the row's note must match at the end (an older copy first on PATH, …)
//              git:    the Git status at the end (default ready)
//   why        the bug this would show, or why this Mac matters

const LOCAL_BIN = 'export PATH="$HOME/.local/bin:$PATH"\n';
const NVM = 'export NVM_DIR="$HOME/.nvm"\nexport PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"\n';
const BREW_FIRST = 'export PATH="$MAC_BREW/bin:$MAC_BREW/sbin:$PATH"\n'; // what `brew shellenv` does

const SCENARIOS = [
  // ---------------------------------------------------------------- nothing, or only one
  {
    name: 'fresh-mac',
    about: 'A new Mac: neither agent, a fresh account. The launch installs Claude Code by itself; the person installs Codex and signs in to both.',
    expect: { launch: { claude: 'signed-out', codex: 'missing' } },
  },
  {
    name: 'fresh-mac-offline',
    about: 'A new Mac with no internet: every install fails, and says why.',
    offline: ['claude', 'codex'],
    expect: { final: { claude: 'missing', codex: 'missing' }, errors: { claude: /internet|reach/i, codex: /internet|reach/i } },
  },
  {
    name: 'only-claude',
    about: 'Claude Code from its installer, on PATH and signed in; no Codex. Nothing is installed by itself; the person adds Codex.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }],
    signedIn: { claude: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'ready', codex: 'missing' } },
  },
  {
    name: 'only-codex',
    about: 'Codex from npm under nvm, signed in; no Claude Code. Claude Code is not installed by itself (an agent exists); the person adds it.',
    installs: [{ tool: 'codex', kind: 'npm', version: '0.156.0' }],
    signedIn: { codex: true },
    rc: { '.zshrc': NVM },
    expect: { launch: { claude: 'missing', codex: 'ready' } },
  },
  {
    name: 'only-claude-codex-skipped',
    about: 'Claude Code only, and the person skips Codex: Claude Code works everywhere, Codex stays missing.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }],
    signedIn: { claude: true },
    rc: { '.zshrc': LOCAL_BIN },
    person: { codex: 'skip' },
    expect: { final: { claude: 'ready', codex: 'missing' } },
  },

  // ---------------------------------------------------------------- installed, but PATH does not reach them
  {
    name: 'claude-off-path',
    about: 'Claude Code from its installer in ~/.local/bin, on an account whose startup files never added that folder (what its installer warns about).',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'npm', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': NVM },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'both-off-path',
    about: 'Both agents in ~/.local/bin, neither on PATH, both signed out: found, signed in to, and run everywhere.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    expect: { launch: { claude: 'signed-out', codex: 'signed-out' } },
  },
  {
    name: 'both-off-path-bash',
    about: 'The same, for a person whose login shell is bash.',
    shell: 'bash',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'nvm-in-bashrc-only',
    about: 'bash, with nvm set up only in .bashrc, which a login shell does not read: both npm installs are off the login PATH.',
    shell: 'bash',
    installs: [{ tool: 'claude', kind: 'npm', version: '2.1.300' }, { tool: 'codex', kind: 'npm', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.bashrc': NVM },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'claude-custom-folder',
    about: 'Claude Code in a folder of the person\'s own (~/tools/bin) that no installer uses and PATH misses: Engelbart cannot know it is there.',
    installs: [{ tool: 'claude', kind: 'dir', dir: '~/tools/bin', version: '2.1.300' }],
    signedIn: { claude: true },
    expect: { launch: { claude: 'ready', codex: 'missing' } },
    why: 'Nothing points at ~/tools/bin; the launch installs another copy, as for a Mac without one.',
  },
  {
    name: 'claude-alias-only',
    about: 'Claude Code reachable only through an alias in .zshrc (to a folder PATH misses).',
    installs: [{ tool: 'claude', kind: 'dir', dir: '~/tools/claude-dev', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': 'alias claude="$HOME/tools/claude-dev/claude"\n' + LOCAL_BIN },
    person: { claude: 'skip' },
    expect: { launch: { claude: 'missing', codex: 'ready' }, final: { claude: 'missing', codex: 'ready' }, reach: { claude: { menu: true, shell: true, hidden: false } } },
    why: 'The terminal can run an alias; a hidden run (@bart, Build) cannot, and is never given its definition.',
  },

  // ---------------------------------------------------------------- versions
  {
    name: 'claude-outdated-native',
    about: 'Claude Code from its installer, older than Engelbart needs: the launch updates it by itself.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.200' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'claude-outdated-updater-off',
    about: 'The same, but the person turned Claude Code\'s own updater off: Engelbart waits for them, and Update works.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.200' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    files: { '.claude.json': '{"autoUpdates": false, "projects": {}}\n' },
    expect: { launch: { claude: 'outdated', codex: 'ready' } },
  },
  {
    name: 'claude-outdated-homebrew-only',
    about: 'Claude Code from Homebrew, older than Engelbart needs (as on David\'s Mac): its own updater refuses, since Homebrew owns it.',
    homebrew: true,
    installs: [{ tool: 'claude', kind: 'homebrew', version: '2.1.223' }, { tool: 'codex', kind: 'homebrew', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zprofile': BREW_FIRST },
    expect: { launch: { claude: 'outdated', codex: 'ready' }, final: { claude: 'outdated', codex: 'ready' }, errors: { claude: /brew upgrade/ } },
    why: 'The row should say to run `brew upgrade claude-code`, not only that the update failed.',
  },
  {
    name: 'claude-old-homebrew-shadows-new',
    about: 'An old Homebrew Claude Code first on PATH, and a current one from its installer in ~/.local/bin after it.',
    homebrew: true,
    installs: [{ tool: 'claude', kind: 'homebrew', version: '2.1.223' }, { tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zprofile': BREW_FIRST, '.zshrc': 'export PATH="$PATH:$HOME/.local/bin"\n' },
    expect: { launch: { claude: 'ready', codex: 'ready' }, notes: { claude: /brew uninstall --cask claude-code/ }, reach: { claude: { menu: true, shell: false, hidden: true } } },
    why: 'A copy that meets the minimum is right there; the old one first on PATH should not make Claude Code unusable. Typed in a terminal, the old one still runs: that is the person\'s PATH, and the note says how to remove it.',
  },
  {
    name: 'codex-outdated-npm',
    about: 'Codex from npm, older than Engelbart needs: the launch updates it by itself.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'npm', version: '0.150.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN + NVM },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'claude-update-offline',
    about: 'Claude Code too old, and its updater cannot reach the network: the row says the network is why.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.200', behaviour: 'update-offline' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { final: { claude: 'outdated', codex: 'ready' }, errors: { claude: /internet|network|reach/i } },
  },
  {
    name: 'codex-newer-major',
    about: 'Codex 1.0, a major version Engelbart was not tested on: allowed, and marked untested.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '1.0.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },

  // ---------------------------------------------------------------- signed out
  {
    name: 'both-signed-out',
    about: 'Both installed and on PATH, neither signed in: Sign In for each, in its hidden terminal.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'signed-out', codex: 'signed-out' } },
  },
  {
    name: 'codex-api-key',
    about: 'Codex signed in with an API key, which Engelbart does not use: signed out, with why, until the person signs in with ChatGPT.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: 'apikey' },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'ready', codex: 'signed-out' } },
  },
  {
    name: 'claude-auth-hangs',
    about: 'Claude Code\'s sign-in status never answers.',
    slow: true,
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300', behaviour: 'auth-hang' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { codex: 'ready' } },
  },

  // ---------------------------------------------------------------- broken, or not what it seems
  {
    name: 'claude-broken',
    about: 'Claude Code that does not start (a missing library after a half-finished update): failed, and installing again fixes it.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300', behaviour: 'broken' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'failed', codex: 'ready' } },
  },
  {
    name: 'claude-version-unreadable',
    about: 'A claude in ~/.local/bin whose --version prints no Claude Code version: not taken for Claude Code; Install puts the real one there.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300', behaviour: 'garbage' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'missing', codex: 'ready' } },
  },
  {
    name: 'codex-name-clash',
    about: 'Another program called codex first on PATH (an old documentation tool from npm), and no OpenAI Codex.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'npm', version: '1.0.2', behaviour: 'clash' }],
    signedIn: { claude: true },
    rc: { '.zshrc': LOCAL_BIN + NVM },
    person: { codex: 'skip' },
    expect: { launch: { claude: 'ready', codex: 'missing' }, final: { claude: 'ready', codex: 'missing' }, errors: { codex: /another program called codex/ } },
    why: 'It is not Codex: it should not be taken for one (ready, "untested"), and nothing should try to run it as one.',
  },
  {
    name: 'codex-name-clash-install',
    about: 'The same, and the person installs Codex: the real one goes to ~/.local/bin, behind the other on PATH, and Engelbart runs it by its full path.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'npm', version: '1.0.2', behaviour: 'clash' }],
    signedIn: { claude: true },
    rc: { '.zshrc': LOCAL_BIN + NVM },
    expect: { launch: { claude: 'ready', codex: 'missing' }, notes: { codex: /another program of the same name/ }, reach: { codex: { menu: true, shell: false, hidden: true } } },
  },
  {
    name: 'claude-version-hangs',
    about: 'Claude Code whose --version never answers.',
    slow: true,
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300', behaviour: 'hang' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': LOCAL_BIN },
    expect: { launch: { claude: 'failed', codex: 'ready' } },
  },

  // ---------------------------------------------------------------- startup files
  {
    name: 'rc-noisy',
    about: 'Startup files that print a banner and a fortune.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': `echo "Welcome back!"; echo "claude codex git"; echo "/usr/bin/claude"\n${LOCAL_BIN}`, '.zprofile': 'echo "Last login: today"\n' },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'rc-slow',
    about: 'Startup files that take four seconds (a slow plugin manager).',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': `sleep 4\n${LOCAL_BIN}` },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'rc-error-before-path',
    about: 'A .zshrc that fails on a missing file before it adds ~/.local/bin.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': `source "$HOME/.oh-my-zsh/oh-my-zsh.sh"\nplugins=(git\n${LOCAL_BIN}` },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },
  {
    name: 'rc-execs-another-shell',
    about: 'A .zshrc that replaces itself with bash when interactive (people do this, or `exec tmux`).',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': `${LOCAL_BIN}[[ -o interactive ]] && exec /bin/bash -l\n` },
    expect: { launch: { claude: 'failed', codex: 'failed' }, final: { claude: 'failed', codex: 'failed' }, errors: { claude: /exec tmux.*if \[\[ -t 1 \]\]/, codex: /exec tmux/ }, git: 'missing' },
    why: 'The login shell never runs the command it is given: nothing Engelbart runs works, and the rows say why and what to change, instead of "ready".',
  },
  {
    name: 'rc-execs-guarded',
    about: 'The same .zshrc with the line the message suggests: another shell only in a terminal window, and everything works.',
    installs: [{ tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zshrc': `${LOCAL_BIN}if [[ -t 1 ]]; then exec /bin/bash -l; fi\n` },
    expect: { launch: { claude: 'ready', codex: 'ready' } },
  },

  // ---------------------------------------------------------------- Git
  {
    name: 'git-homebrew-outdated-bundled',
    about: 'An old Homebrew Git first on PATH, and the Git that comes with Engelbart: Engelbart\'s stands in, and every run gets it.',
    homebrew: true,
    bundledGit: true,
    installs: [{ tool: 'git', kind: 'homebrew', version: '2.20.1' }, { tool: 'claude', kind: 'native', version: '2.1.300' }, { tool: 'codex', kind: 'standalone', version: '0.156.0' }],
    signedIn: { claude: true, codex: true },
    rc: { '.zprofile': BREW_FIRST, '.zshrc': LOCAL_BIN },
    expect: { git: 'ready', gitSource: 'bundled' },
  },
];

module.exports = { SCENARIOS };
