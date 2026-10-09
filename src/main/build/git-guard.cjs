'use strict';

// The git ban, enforced (2026-10-07, "Bart build agents": "Enforce the git ban"). A Build's agent is told not to commit,
// push, rebase, merge, switch or create branches, or change git settings (./prompt.cjs): Engelbart commits its work
// after every turn, and the repository's branches, remotes and settings are the person's. Until now nothing held it to
// that. Three things do, for both CLIs and whatever runs under them (a test suite, a package script):
//
//   1. Engelbart's own `git`, first on the agent's PATH (bin/git, written here). It hands every command to the real git
//      except one that writes the history, refs or settings of the Build's repository (ENGELBART_BUILD_GIT_DIR: the
//      git folder its worktree, the person's folder and the other Builds share), which it refuses with a line that
//      says what to do instead. Reading (status, diff, log, show, blame…) and file commands (add, restore, rm, mv,
//      checkout -- <path>, reset -- <path>, clean) work. Other repositories (a test's scratch repository, a clone the
//      agent made) are left alone, except that nothing is pushed from a Build anywhere.
//   2. Hooks only that repository runs while the agent's git does (hooks/, through GIT_CONFIG_PARAMETERS, which outranks
//      the repository's own core.hooksPath): reference-transaction refuses any change to a ref under refs/ (a commit, a
//      branch, a tag, a stash, a merge, a rebase), and pre-push any push. They hold when the agent runs a git that is not
//      the one on PATH (/usr/bin/git, a startup file that rebuilt PATH). Its own hooks (husky's…) do not run meanwhile.
//      A push to the network fails in every repository (url.….pushInsteadOf), --no-verify or not.
//   3. After the turn the manager puts the worktree back on its branch at the commit it started from, the agent's own
//      work kept as files for the checkpoint (git.cjs holdBranch): what got past 1 and 2 (`git -c core.hooksPath=…`) is
//      undone there.
//
// Engelbart's own git (./git.cjs) runs without any of it: its environment has no GIT_* variables and its hooks are off.
//
// Windows (2026-10-09, docs/windows-port-log.md "Catch-up to 0.1.13"): the agent starts in Git for Windows' bash, whose
// PATH is written the POSIX way (/c/Users/…), so the guard's folder is converted before it goes first (cygpath, as
// ../terminal/launch.cjs does for Engelbart's Git), and the shim asks whether two names are the same folder (-ef: the
// case of a name, or a short name like RUNNER~1, does not matter). Git reads includeIf patterns and include paths with
// forward slashes, and the repository's folder is named as Git names it (its long name, in its own case; gitdir/i
// besides). Claude Code runs its commands in that bash, so it meets the shim; a git started outside it (from
// PowerShell, by its .exe) meets the hooks, which Git for Windows runs with its own sh.

const fs = require('node:fs');
const path = require('node:path');

// Reading, and commands that change only files (the working tree, the index): allowed in every repository.
const READS = 'status|diff|log|show|blame|annotate|grep|ls-files|ls-tree|ls-remote|rev-parse|rev-list|cat-file|describe|shortlog|whatchanged|name-rev|merge-base|for-each-ref|show-ref|show-branch|diff-tree|diff-files|diff-index|check-ignore|check-attr|check-mailmap|check-ref-format|count-objects|verify-commit|verify-tag|verify-pack|var|help|version|cherry|range-diff|difftool|archive|format-patch|fsck|get-tar-commit-id|column|stripspace|interpret-trailers|bugreport';
const FILES = 'add|rm|mv|restore|apply|clean|clone|init|submodule|update-index|read-tree|write-tree|checkout-index|commit-tree|mktree|hash-object';

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const SHIM = (guard, windows) => `#!/bin/sh
# Engelbart's git for a Build's agent (src/main/build/git-guard.cjs). The real git does everything, except what would
# write the history, refs or settings of the Build's own repository: Engelbart commits the agent's work after each turn.
guard=${windows ? `$(cygpath -u ${quote(guard)})` : quote(guard)}
set -f
real=
saved_ifs=$IFS
IFS=:
for dir in $PATH; do
  if [ -n "$dir" ] && [ "$dir" != "$guard" ] && [ -f "$dir/git" ] && [ -x "$dir/git" ]; then real=$dir/git; break; fi
done
IFS=$saved_ifs
set +f
if [ -z "$real" ]; then echo "git: command not found" >&2; exit 127; fi

# The subcommand, after the options that come before it (-C <dir>, -c <name=value>, --git-dir=<dir> …).
pos=0
sub=
take=
for arg in "$@"; do
  if [ -n "$take" ]; then take=
  else
    case $arg in
      -C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source) take=1 ;;
      -*) ;;
      *) sub=$arg; break ;;
    esac
  fi
  pos=$((pos + 1))
done
[ -n "$sub" ] || exec "$real" "$@"

# Whether an argument is one of the options in $1 (also as --option=value).
has() {
  words=$1; shift
  for a in "$@"; do for w in $words; do case $a in "$w"|"$w"=*) return 0 ;; esac; done; done
  return 1
}
# The arguments that name something (not options, nor the value of an option in $1), up to a --, one a line.
names() {
  takes=$1; shift
  skip=
  for a in "$@"; do
    if [ -n "$skip" ]; then skip=; continue; fi
    case $a in
      --) break ;;
      -*) for t in $takes; do [ "$a" = "$t" ] && skip=1; done ;;
      *) printf '%s\\n' "$a" ;;
    esac
  done
}
first() { names "$@" | head -n 1; }
count() { names "$@" | grep -c . ; }

# 0: reads, or changes files only. 1: writes history, refs or settings (refused in the Build's repository). 2: a push
# (refused everywhere). 3: not a command known here (an alias is looked up).
classify() {
  name=$1; shift
  case $name in
    ${READS}) return 0 ;;
    ${FILES}) return 0 ;;
    push|send-pack|request-pull) return 2 ;;
    lfs) case $(first '' "$@") in push) return 2 ;; install|uninstall|update|migrate) return 1 ;; esac; return 0 ;;
    branch)
      has '-d -D --delete -m -M --move -c -C --copy -u --set-upstream-to --unset-upstream --edit-description -f --force -t --track --no-track --create-reflog' "$@" && return 1
      [ "$(count '' "$@")" -eq 0 ] && return 0
      has '-l --list -a --all -r --remotes --contains --no-contains --merged --no-merged --points-at' "$@" && return 0
      return 1 ;;
    tag)
      has '-a --annotate -s --sign -u --local-user -f --force -d --delete -m --message -F --file -e --edit' "$@" && return 1
      [ "$(count '' "$@")" -eq 0 ] && return 0
      has '-l --list --contains --no-contains --merged --no-merged --points-at' "$@" && return 0
      return 1 ;;
    config)
      takes='-f --file --blob --type --default --comment'
      has '--get --get-all --get-regexp --get-urlmatch --get-color --get-colorbool -l --list' "$@" && return 0
      case $(first "$takes" "$@") in get|list) return 0 ;; set|unset|rename-section|remove-section|edit) return 1 ;; esac
      has '--add --unset --unset-all --replace-all --rename-section --remove-section -e --edit' "$@" && return 1
      [ "$(count "$takes" "$@")" -le 1 ] && return 0
      return 1 ;;
    remote) case $(first '' "$@") in ''|show|get-url) return 0 ;; esac; return 1 ;;
    worktree) [ "$(first '' "$@")" = list ] && return 0; return 1 ;;
    stash|notes) case $(first '' "$@") in list|show) return 0 ;; esac; return 1 ;;
    reflog) case $(first '' "$@") in expire|delete|drop) return 1 ;; esac; return 0 ;;
    reset) [ "$(count '' "$@")" -eq 0 ] && return 0; return 1 ;;
    checkout)
      has '-b -B --orphan --detach' "$@" && return 1
      for a in "$@"; do [ "$a" = -- ] && return 0; done
      [ "$(count '' "$@")" -eq 0 ] && return 0
      return 1 ;;
    commit|merge|rebase|cherry-pick|revert|am|pull|fetch|switch|update-ref|symbolic-ref|replace|filter-branch|gc|prune|repack|pack-refs|bisect|maintenance|sparse-checkout) return 1 ;;
  esac
  return 3
}

# The real git with the options that came before the subcommand, then $extra (word-split).
before() {
  n=$#; i=0
  for a in "$@"; do i=$((i + 1)); [ "$i" -le "$pos" ] && set -- "$@" "$a"; done
  shift "$n"
  set -f
  "$real" "$@" $extra
}
# The subcommand and its own arguments, as classify says.
verdict() { shift "$pos"; classify "$@"; }
# An alias read through once: its expansion in place of the subcommand. One that runs a shell, or another alias, is 1.
aliased() {
  shift "$pos"; shift
  set -f
  set -- $expansion "$@"
  set +f
  classify "$@"
  found=$?
  [ "$found" -eq 3 ] && return 1
  return "$found"
}

refuse() {
  if [ "$1" = push ]; then
    echo "Engelbart: git push is refused in a Build: nothing is pushed from a Build. Leave your changes in the working copy; the person reviews and accepts them." >&2
  else
    echo "Engelbart: \\\`git $1\\\` is refused in this repository during a Build. Engelbart commits your work after each turn, and the repository's branches, remotes and settings are the person's: leave your changes in the working copy. Reading (status, diff, log, show, blame) and file commands (add, restore, rm, mv, checkout -- <path>, reset -- <path>, clean) work." >&2
  fi
  exit 1
}

verdict "$@"
found=$?
if [ "$found" -eq 3 ]; then
  extra="config --get alias.$sub"
  expansion=$(before "$@" 2>/dev/null)
  case $expansion in
    ''|'!'*) found=1 ;;
    *) aliased "$@"; found=$? ;;
  esac
fi
case $found in
  0) exec "$real" "$@" ;;
  2) refuse push ;;
esac
if [ -n "\${ENGELBART_BUILD_GIT_DIR:-}" ]; then
  extra='rev-parse --path-format=absolute --git-common-dir'
  common=$(before "$@" 2>/dev/null)
${windows
    ? `  if [ -n "$common" ] && [ "$common" -ef "$(cygpath -u "$ENGELBART_BUILD_GIT_DIR")" ]; then refuse "$sub"; fi`
    : `  if [ -n "$common" ] && [ "$(cd "$common" 2>/dev/null && pwd -P)" = "$ENGELBART_BUILD_GIT_DIR" ]; then refuse "$sub"; fi`}
fi
exec "$real" "$@"
`;

const REFERENCE_TRANSACTION = `#!/bin/sh
# Engelbart (src/main/build/git-guard.cjs): no ref of a Build's repository changes while its agent runs git, whichever
# git it ran. A ref written as it already was (git reset --hard, which rewrites the branch it is on) is not a change.
[ "$1" = prepared ] || exit 0
while read -r old new ref; do
  [ "$old" = "$new" ] && continue
  case $ref in
    refs/*) echo "Engelbart: $ref cannot change during a Build. Engelbart commits your work after each turn; the repository's branches are the person's. Leave your changes in the working copy." >&2; exit 1 ;;
  esac
done
exit 0
`;

const PRE_PUSH = `#!/bin/sh
# Engelbart (src/main/build/git-guard.cjs): nothing is pushed from a Build's repository while its agent runs git.
echo "Engelbart: git push is refused in a Build: nothing is pushed from a Build." >&2
exit 1
`;

// Where a push to the network goes instead while the agent runs git: a transport no git has, so it fails at once.
const NO_PUSH = 'engelbart-no-push://';
const NETWORK = ['https://', 'http://', 'ssh://', 'git://', 'git@'];

function writeIfChanged(file, text, mode) {
  let held = null;
  try { held = fs.readFileSync(file, 'utf8'); } catch { held = null; }
  if (held !== text) fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}

/** The guard's files under `dir` (written when they differ). → { bin: the folder that goes first on PATH, config } */
function prepareGitGuard(dir, platform = process.platform) {
  const bin = path.join(dir, 'bin');
  const hooks = path.join(dir, 'hooks');
  for (const folder of [bin, hooks]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeIfChanged(path.join(bin, 'git'), SHIM(bin, platform === 'win32'), 0o755);
  writeIfChanged(path.join(hooks, 'reference-transaction'), REFERENCE_TRANSACTION, 0o755);
  writeIfChanged(path.join(hooks, 'pre-push'), PRE_PUSH, 0o755);
  const config = path.join(dir, 'build.gitconfig');
  writeIfChanged(config, `# Engelbart: what a Build's repository runs while its agent runs git (src/main/build/git-guard.cjs).\n[core]\n\thooksPath = ${hooks.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}\n`, 0o644);
  return { bin, config };
}

/**
 * The git folder a worktree shares with its repository (its objects, refs and config), its real path; null when it has
 * none. Read from the files git keeps (.git, commondir), so it needs no git.
 */
function gitCommonDir(worktree) {
  const realpath = process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync; // Windows: long names, as Git gives them
  try {
    const dotGit = path.join(worktree, '.git');
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return realpath(dotGit);
    const named = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!named) return null;
    const own = path.resolve(worktree, named[1]);
    let common = own;
    try { common = path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()); } catch { /* a repository's own git folder */ }
    return realpath(common);
  } catch {
    return null;
  }
}

/**
 * What the agent's process is started with for the guard: its bin folder (put first on PATH by the command, after the
 * login shell's startup files: ../terminal/launch.cjs explains why), the repository whose history is Engelbart's, and
 * the config that brings the hooks to that repository alone and turns network pushes away everywhere. The person's own
 * GIT_CONFIG_PARAMETERS, when set, come after (theirs win where they say the same thing, as `git -c` would).
 */
function guardEnvironment(guard, gitDir, base = {}, platform = process.platform) {
  const pair = (key, value) => `${quote(key)}=${quote(value)}`;
  const windows = platform === 'win32';
  const [condition, dir, config] = windows ? ['gitdir/i', gitDir.replace(/\\/g, '/'), guard.config.replace(/\\/g, '/')] : ['gitdir', gitDir, guard.config];
  const entries = [
    pair(`includeIf.${condition}:${dir}.path`, config),
    pair(`includeIf.${condition}:${dir}/**.path`, config),
    ...NETWORK.map((prefix) => pair(`url.${NO_PUSH}.pushInsteadOf`, prefix)),
  ];
  const theirs = typeof base.GIT_CONFIG_PARAMETERS === 'string' && base.GIT_CONFIG_PARAMETERS.trim() ? ` ${base.GIT_CONFIG_PARAMETERS.trim()}` : '';
  return { ENGELBART_BUILD_GUARD: guard.bin, ENGELBART_BUILD_GIT_DIR: gitDir, GIT_CONFIG_PARAMETERS: `${entries.join(' ')}${theirs}` };
}

const POSIX_GUARD_PATH = 'PATH="$ENGELBART_BUILD_GUARD:$PATH"; ';
const FISH_GUARD_PATH = 'set -gx PATH $ENGELBART_BUILD_GUARD $PATH; ';
const WINDOWS_GUARD_PATH = 'PATH="$(cygpath -u "$ENGELBART_BUILD_GUARD"):$PATH"; ';
/** The start of the agent's command that puts the guard first on PATH, in `shell`'s language. */
const guardPath = (shell, platform = process.platform) => {
  if (platform === 'win32') return WINDOWS_GUARD_PATH; // Git for Windows' bash
  return path.basename(String(shell || '')) === 'fish' ? FISH_GUARD_PATH : POSIX_GUARD_PATH;
};

module.exports = { prepareGitGuard, gitCommonDir, guardEnvironment, guardPath, NO_PUSH };
