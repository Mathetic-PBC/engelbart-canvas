import Foundation

// Port of src/main/shell-rc.cjs.
//
// The terminal pane types into its own box at the bottom (design 2026-09-17, "Run commands"), so the shell must not draw
// a prompt in the transcript, and the pane has to know when a command is running (then the keyboard belongs to the
// program, not the box).
//
// Sessions start through a tiny launcher, <userData>/shell/zsh, which points zsh at wrapper startup files
// (ZDOTDIR = <userData>/zsh) and execs your real shell. The wrappers run your own ~/.zshenv, ~/.zprofile and ~/.zshrc
// (honouring a ZDOTDIR they set), then:
//   * empty the prompt, again before every prompt, so prompt frameworks cannot put it back;
//   * emit shell-integration marks (OSC 633: A prompt, C command started, E command line, P Cwd=…) that the pane reads
//     to show or hide the box and keep the directory chip true (ShellMarks.swift);
//   * hand ZDOTDIR back to your own value, so ~/.zlogin runs as usual and anything started from the shell (installers
//     that edit ${ZDOTDIR:-$HOME}/.zshrc, nested shells) sees your setup;
//   * put Engelbart's own Git first on PATH while it stands in for a missing one (ENGELBART_GIT_BIN), after your .zshrc,
//     which may have rebuilt PATH, and Claude Code's and Codex's folders last when your PATH misses them
//     (ENGELBART_AGENT_PATH; both come from the Tools package's environment through the host).
// Because the launcher is also $TERMINAL_USER_SHELL, the shell that replaces Claude Code or Codex when they exit gets the
// same treatment.
//
// bash (2026-09-30, scripts/mac-states): a terminal's login bash is started interactive with an init file instead,
// <userData>/bash/init.bash, which reads what a login bash reads (/etc/profile, then the first of ~/.bash_profile,
// ~/.bash_login, ~/.profile) and then puts the same folders on PATH, so `claude` typed in the terminal runs there too. It
// has no prompt marks yet, and `shopt login_shell` is off in it. fish runs through the launcher untouched.
//
// The Swift app's userData is "~/Library/Application Support/Engelbart Swift": it has a space, and every place a path is
// written into a script goes through `quote`.

public enum ShellRC {
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: #"'\''"#) + "'" }

    /// The wrapper files, by name, rendered for the directory they live in (shell-rc.cjs FILES).
    public static func files(dir: String) -> [(name: String, text: String)] {
        [
            (".zshenv", #"""
            # Engelbart wrapper: your own .zshenv, then keep reading this directory.
            ENGELBART_ZDOTDIR=\#(quote(dir))
            ZDOTDIR="${ENGELBART_PRIOR_ZDOTDIR:-$HOME}"
            [[ "$ZDOTDIR" == "$ENGELBART_ZDOTDIR" ]] && ZDOTDIR="$HOME"
            [[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
            ENGELBART_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
            ZDOTDIR="$ENGELBART_ZDOTDIR"

            """#),
            (".zprofile", #"""
            # Engelbart wrapper: your own .zprofile.
            ZDOTDIR="${ENGELBART_USER_ZDOTDIR:-$HOME}"
            [[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
            ZDOTDIR="$ENGELBART_ZDOTDIR"

            """#),
            (".zshrc", #"""
            # Engelbart wrapper: your own .zshrc, then no prompt (the terminal pane has its own input box)
            # and marks that tell the pane when a command starts, when the shell is ready, and where it is.
            ZDOTDIR="${ENGELBART_USER_ZDOTDIR:-$HOME}"
            [[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
            [[ -n "${ENGELBART_GIT_BIN:-}" ]] && path=("$ENGELBART_GIT_BIN" $path)
            [[ -n "${ENGELBART_AGENT_PATH:-}" ]] && path=($path ${(s.:.)ENGELBART_AGENT_PATH})
            engelbart_hide_prompt() { PROMPT='' PS1='' RPROMPT='' RPS1='' PROMPT_EOL_MARK='' }
            engelbart_precmd() { engelbart_hide_prompt; printf '\e]633;P;Cwd=%s\a\e]633;A\a' "$PWD" }
            engelbart_preexec() { local line="${1//[[:cntrl:]]/ }"; printf '\e]633;E;%s\a\e]633;C\a' "${line[1,400]}" }
            engelbart_hide_prompt
            precmd_functions+=(engelbart_precmd)
            preexec_functions+=(engelbart_preexec)
            unset ENGELBART_ZDOTDIR ENGELBART_USER_ZDOTDIR ENGELBART_PRIOR_ZDOTDIR
            [[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR

            """#),
        ]
    }

    static let bashInit = #"""
    # Engelbart wrapper: what a login bash reads, then Engelbart's own Git first on PATH while it stands in, and
    # Claude Code's and Codex's folders last when your PATH misses them.
    [ -r /etc/profile ] && . /etc/profile
    if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
    elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
    elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
    fi
    [ -n "${ENGELBART_GIT_BIN:-}" ] && PATH="$ENGELBART_GIT_BIN:$PATH"
    [ -n "${ENGELBART_AGENT_PATH:-}" ] && PATH="$PATH:$ENGELBART_AGENT_PATH"
    export PATH

    """#

    /// Writes `text` only when the file holds something else (an unchanged file keeps its mtime), then sets `mode`.
    static func writeIfChanged(_ file: String, _ text: String, mode: mode_t) throws {
        let existing = try? String(contentsOfFile: file, encoding: .utf8)
        if existing != text {
            let url = URL(fileURLWithPath: file)
            try Data(text.utf8).write(to: url)
            chmod(file, mode)
        }
        chmod(file, mode) // best effort, as Electron's
    }

    static func makeDirectory(_ path: String) throws {
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    /// Writes the wrapper startup files under <userData>/zsh and returns that directory.
    @discardableResult
    public static func prepareZshDir(userData: String) throws -> String {
        let dir = (userData as NSString).appendingPathComponent("zsh")
        try makeDirectory(dir)
        for file in files(dir: dir) { try writeIfChanged((dir as NSString).appendingPathComponent(file.name), file.text, mode: 0o600) }
        return dir
    }

    /// Writes the launcher (named after your shell, as the engine requires) and returns its path.
    @discardableResult
    public static func prepareLauncher(userData: String, realShell: String) throws -> String {
        let zdotdir = try prepareZshDir(userData: userData)
        let dir = (userData as NSString).appendingPathComponent("shell")
        try makeDirectory(dir)
        let name = (realShell as NSString).lastPathComponent
        let launcher = (dir as NSString).appendingPathComponent(name)
        if name == "bash" {
            let init_ = ((userData as NSString).appendingPathComponent("bash") as NSString).appendingPathComponent("init.bash")
            try makeDirectory((init_ as NSString).deletingLastPathComponent)
            try writeIfChanged(init_, bashInit, mode: 0o600)
            // Only a terminal's own shell (-il): a command it is given (-ilc, the Claude Code and Codex items) runs as before.
            try writeIfChanged(launcher, #"""
            #!/bin/sh
            # Engelbart: start bash reading Engelbart's init file, which reads what a login bash would.
            SHELL=\#(quote(realShell)); export SHELL
            if [ "$#" -eq 1 ] && [ "$1" = "-il" ]; then exec \#(quote(realShell)) --init-file \#(quote(init_)) -i; fi
            exec \#(quote(realShell)) "$@"

            """#, mode: 0o700)
            return launcher
        }
        try writeIfChanged(launcher, #"""
        #!/bin/sh
        # Engelbart: start your shell with Engelbart's startup wrappers (zsh finds them through ZDOTDIR).
        ENGELBART_PRIOR_ZDOTDIR="${ZDOTDIR-}"; export ENGELBART_PRIOR_ZDOTDIR
        ZDOTDIR=\#(quote(zdotdir)); export ZDOTDIR
        SHELL=\#(quote(realShell)); export SHELL
        exec \#(quote(realShell)) "$@"

        """#, mode: 0o700)
        return launcher
    }

    // When Engelbart itself is started from inside an agent session (an app launched from Claude Code's `!`), that
    // session's private variables would flow into every terminal, and an agent started there would believe it is a child
    // of the outer one (no transcript, borrowed sockets). The launch rules already drop the older names; these are the
    // rest. Your own settings (ANTHROPIC_*, CLAUDE_VAULT, CLAUDE_CODE_USE_*, …) pass through.
    static let sessionScoped: [NSRegularExpression] = [
        #"^CLAUDE_CODE_(CHILD_SESSION|EXECPATH|MESSAGING_|SESSION_|SSE_PORT)"#, #"^CLAUDE_(PID|EFFORT)$"#, #"^CODEX_(SANDBOX|MANAGED_BY)"#,
    ].map { try! NSRegularExpression(pattern: $0) }

    /// `base` without an outer agent session's private variables.
    public static func scrubAgentSession(_ base: [String: String]) -> [String: String] {
        base.filter { key, _ in !sessionScoped.contains { $0.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)) != nil } }
    }

    /// The environment terminal sessions start with: the process environment, minus an outer agent's session, with
    /// SHELL = the launcher.
    public static func environmentForSessions(_ base: [String: String], userData: String) throws -> [String: String] {
        let realShell = try Launch.resolveShell(base)
        var environment = scrubAgentSession(base)
        environment["SHELL"] = try prepareLauncher(userData: userData, realShell: realShell)
        return environment
    }
}
