import Foundation

/// The git ban, enforced (git-guard.cjs, 2026-10-07 "Enforce the git ban"). Three things hold a Build's agent to it, for
/// both CLIs and whatever runs under them:
///   1. Engelbart's own `git`, first on the agent's PATH (bin/git): every command goes to the real git except one that
///      writes the history, refs or settings of the Build's repository, which it refuses with what to do instead.
///   2. Hooks only that repository runs while the agent's git does (through GIT_CONFIG_PARAMETERS, which outranks the
///      repository's own core.hooksPath): reference-transaction refuses any ref change, pre-push any push. A push to the
///      network fails in every repository (url.….pushInsteadOf).
///   3. After the turn the manager puts the worktree back on its branch (BuildGit.holdBranch).
/// Engelbart's own git (Git.swift) runs without any of it: its environment has no GIT_* variables and its hooks are off.
public enum GitGuard {
    // Reading, and commands that change only files (the working tree, the index): allowed in every repository.
    static let reads = "status|diff|log|show|blame|annotate|grep|ls-files|ls-tree|ls-remote|rev-parse|rev-list|cat-file|describe|shortlog|whatchanged|name-rev|merge-base|for-each-ref|show-ref|show-branch|diff-tree|diff-files|diff-index|check-ignore|check-attr|check-mailmap|check-ref-format|count-objects|verify-commit|verify-tag|verify-pack|var|help|version|cherry|range-diff|difftool|archive|format-patch|fsck|get-tar-commit-id|column|stripspace|interpret-trailers|bugreport"
    static let files = "add|rm|mv|restore|apply|clean|clone|init|submodule|update-index|read-tree|write-tree|checkout-index|commit-tree|mktree|hash-object"

    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /// The shim, as git-guard.cjs writes it (its JS template's escapes resolved).
    static func shim(_ guardDir: String) -> String {
        #"""
#!/bin/sh
# Engelbart's git for a Build's agent (src/main/build/git-guard.cjs). The real git does everything, except what would
# write the history, refs or settings of the Build's own repository: Engelbart commits the agent's work after each turn.
guard=\#(quote(guardDir))
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
      *) printf '%s\n' "$a" ;;
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
    \#(reads)) return 0 ;;
    \#(files)) return 0 ;;
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
    echo "Engelbart: \`git $1\` is refused in this repository during a Build. Engelbart commits your work after each turn, and the repository's branches, remotes and settings are the person's: leave your changes in the working copy. Reading (status, diff, log, show, blame) and file commands (add, restore, rm, mv, checkout -- <path>, reset -- <path>, clean) work." >&2
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
if [ -n "${ENGELBART_BUILD_GIT_DIR:-}" ]; then
  extra='rev-parse --path-format=absolute --git-common-dir'
  common=$(before "$@" 2>/dev/null)
  if [ -n "$common" ] && [ "$(cd "$common" 2>/dev/null && pwd -P)" = "$ENGELBART_BUILD_GIT_DIR" ]; then refuse "$sub"; fi
fi
exec "$real" "$@"

"""#
    }

    static let referenceTransaction = #"""
#!/bin/sh
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

"""#

    static let prePush = #"""
#!/bin/sh
# Engelbart (src/main/build/git-guard.cjs): nothing is pushed from a Build's repository while its agent runs git.
echo "Engelbart: git push is refused in a Build: nothing is pushed from a Build." >&2
exit 1

"""#

    /// Where a push to the network goes instead while the agent runs git: a transport no git has, so it fails at once.
    public static let noPush = "engelbart-no-push://"
    static let network = ["https://", "http://", "ssh://", "git://", "git@"]

    static func writeIfChanged(_ file: String, _ text: String, _ mode: Int) throws {
        if FS.readText(file) != text { try FS.write(file, text) }
        chmod(file, mode_t(mode))
    }

    public struct Prepared: Sendable, Equatable {
        /// The folder that goes first on PATH.
        public var bin: String
        public var config: String
    }

    /// The guard's files under `dir` (written when they differ).
    @discardableResult
    public static func prepare(_ dir: String) throws -> Prepared {
        let bin = NodePath.join(dir, "bin"), hooks = NodePath.join(dir, "hooks")
        for folder in [bin, hooks] { try FS.mkdirs(folder, mode: 0o700) }
        try writeIfChanged(NodePath.join(bin, "git"), shim(bin), 0o755)
        try writeIfChanged(NodePath.join(hooks, "reference-transaction"), referenceTransaction, 0o755)
        try writeIfChanged(NodePath.join(hooks, "pre-push"), prePush, 0o755)
        let config = NodePath.join(dir, "build.gitconfig")
        let escaped = hooks.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        try writeIfChanged(config, "# Engelbart: what a Build's repository runs while its agent runs git (src/main/build/git-guard.cjs).\n[core]\n\thooksPath = \(escaped)\n", 0o644)
        return Prepared(bin: bin, config: config)
    }

    /// The git folder a worktree shares with its repository (its objects, refs and config), its real path; nil when it
    /// has none. Read from the files git keeps (.git, commondir), so it needs no git.
    public static func commonDir(_ worktree: String) -> String? {
        let dotGit = NodePath.join(worktree, ".git")
        if FS.isDirectory(dotGit) { return NodePath.realOrNil(dotGit) }
        guard FS.isFile(dotGit), let text = FS.readText(dotGit),
              let re = try? NSRegularExpression(pattern: #"^gitdir:\s*(.+?)\s*$"#, options: .anchorsMatchLines),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let r = Range(m.range(at: 1), in: text) else { return nil }
        let own = NodePath.resolve(worktree, String(text[r]))
        var common = own
        if let named = FS.readText(NodePath.join(own, "commondir")) {
            common = NodePath.resolve(own, named.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return NodePath.realOrNil(common)
    }

    /// What the agent's process is started with for the guard: its bin folder (put first on PATH by the command, after
    /// the startup files), the repository whose history is Engelbart's, and the config that brings the hooks to that
    /// repository alone and turns network pushes away everywhere. The person's own GIT_CONFIG_PARAMETERS come after.
    public static func environment(_ prepared: Prepared, gitDir: String, base: [String: String] = [:]) -> [String: String] {
        func pair(_ key: String, _ value: String) -> String { "\(quote(key))=\(quote(value))" }
        var entries = [pair("includeIf.gitdir:\(gitDir).path", prepared.config), pair("includeIf.gitdir:\(gitDir)/**.path", prepared.config)]
        entries += network.map { pair("url.\(noPush).pushInsteadOf", $0) }
        let given = base["GIT_CONFIG_PARAMETERS"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let theirs = given.isEmpty ? "" : " \(given)"
        return ["ENGELBART_BUILD_GUARD": prepared.bin, "ENGELBART_BUILD_GIT_DIR": gitDir, "GIT_CONFIG_PARAMETERS": entries.joined(separator: " ") + theirs]
    }

    /// The start of the agent's command that puts the guard first on PATH, in `shell`'s language.
    public static func path(_ shell: String) -> String {
        NodePath.basename(shell) == "fish" ? "set -gx PATH $ENGELBART_BUILD_GUARD $PATH; " : "PATH=\"$ENGELBART_BUILD_GUARD:$PATH\"; "
    }
}
