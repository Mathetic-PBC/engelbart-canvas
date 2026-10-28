# Parity ledger: Terminal

Sources: `src/main/terminal/{session-manager,launch,window-lifecycle,settings,agent-terminal}.cjs`, `src/main/shell-rc.cjs`,
`src/main/shell-history.cjs`, `src/renderer/terminal/{sessions.js,helpers.cjs,TerminalPane.jsx}`, `src/renderer/ui/FluidTab.jsx`
(the tab look the terminal shares), terminal parts of `src/main/index.cjs`, `src/main/ipc.cjs`, `src/main/windows.cjs`,
`src/preload.cjs`; spec `2026-09-16-engelbart-desktop-design.md` #12, #26, #32, #37, #85, kink 11; memory notes
(engelbart-desktop-experiment.md lines 35, 44, 150, 177). Tests: `test/launch.test.cjs`, `test/shell-rc.test.cjs`,
`test/session.integration.cjs`, `test/lifecycle.test.cjs`, `test/renderer-helpers.test.cjs`, `test/browser-agents.test.cjs`
(agent terminal part), `test/windows.test.cjs` (terminal part).

Swift paths are under `mac/Packages/Terminal/Sources/EngelbartTerminal/`.

Status notes. `done (local)`: implemented and checked by an XCTest that passed in a local `swift test` run on 2026-10-28
(78 tests, 0 failures), before the cloud-only testing rule; a cloud run (`mac/scripts/cloud-test.sh Terminal`) is still
owed. `done (compiled, untested)`: implemented, its test compiles, not yet run. Tests are in
`mac/Packages/Terminal/Tests/EngelbartTerminalTests/` (LaunchTests, ShellRCTests, HelpersTests, SessionIntegrationTests,
AgentTerminalTests, PaneTests).

## Launch (launch.cjs)

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 1 | Providers fixed enum: shell "Shell" (no command), claude "Claude Code" (`claude`), codex "Codex" (`codex`); anything else → "Unknown provider" | launch.cjs PROVIDERS | Launch.swift `TerminalProvider` | done (local) |
| 2 | Transient env keys removed: CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID, CLAUDE_AGENT_ID, CLAUDE_PARENT_SESSION_ID, CODEX_SESSION_ID, CODEX_THREAD_ID, CODEX_CI, CODEX_VERSION, NODE_CHANNEL_FD, NODE_UNIQUE_ID, NO_COLOR; plus ELECTRON_*, WARP_*, INSPECT*, *INSPECTOR*, NODE_*INSPECT*, NODE_OPTIONS containing --inspect / --inspect-brk | launch.cjs isTransientEnvironmentKey | Launch.swift | done (local) |
| 3 | sanitizeEnvironment sets TERM=xterm-256color, COLORTERM=truecolor, TERM_PROGRAM=Engelbart, TERM_PROGRAM_VERSION=0.1.0; LANG=en_US.UTF-8 only when no LANG and no LC_* key; source not mutated; API keys and CODEX_HOME/CLAUDE_CONFIG_DIR pass | launch.cjs sanitizeEnvironment; launch.test | Launch.swift | done (local) |
| 4 | resolveShell: $SHELL if absolute, basename zsh/bash/fish and an executable file; else /bin/zsh; else /bin/bash; else error "No supported shell found (zsh, bash, or fish)" | launch.cjs | Launch.swift | done (local) |
| 5 | validateCreateRequest: cwd string 1–4096 chars without NUL ("Working directory must be a valid path"), must exist ("Working directory does not exist") and be a directory ("Working directory must be a directory"); cols 2–500, rows 1–500 ("cols must be an integer between 2 and 500"); cwd resolved | launch.cjs | Launch.swift | done (local) |
| 6 | Shell provider args: zsh/bash `-il`; fish `--login --interactive` | launch.cjs shellArguments | Launch.swift | done (local) |
| 7 | Claude/Codex provider scripts (exact text): unset the transient names; run `$ENGELBART_CLAUDE_BIN` when set else `claude`; print `\r\n[Claude Code exited with status %d]\r\n`; `exec "$TERMINAL_USER_SHELL" -il` (fish variant with `set -e`, `set -q`, `--login --interactive`) | launch.cjs ZSH/FISH_PROVIDER_SCRIPTS; launch.test | Launch.swift | done (local) |
| 8 | loginShellArgs: prefix `PATH="$ENGELBART_GIT_BIN:$PATH"; ` when ENGELBART_GIT_BIN set, then `PATH="$PATH:$ENGELBART_AGENT_PATH"; ` when ENGELBART_AGENT_PATH set (fish: `set -gx PATH …`, `(string split : -- …)`); zsh/bash → `-ilc`, fish → `--login --interactive --command` | launch.cjs; launch.test | Launch.swift | done (local) |
| 9 | createLaunchSpec: env = sanitized(source + extra), SHELL = TERMINAL_USER_SHELL = resolved shell (the launcher), file = shell | launch.cjs | Launch.swift | done (local) |

## Shell startup wrappers (shell-rc.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 10 | `<userData>/zsh/.zshenv/.zprofile/.zshrc` written with exact wrapper text (ZDOTDIR dance through ENGELBART_PRIOR_ZDOTDIR / ENGELBART_USER_ZDOTDIR, sources the person's files) mode 0600, dir 0700, rewritten only when text differs | shell-rc.cjs FILES, writeIfChanged; shell-rc.test | ShellRC.swift | done (local) |
| 11 | .zshrc empties PROMPT/PS1/RPROMPT/RPS1/PROMPT_EOL_MARK now and in precmd; precmd prints `ESC]633;P;Cwd=$PWD BEL ESC]633;A BEL`; preexec prints `ESC]633;E;<line, controls→space, first 400 chars> BEL ESC]633;C BEL` | shell-rc.cjs | ShellRC.swift | done (local) |
| 12 | .zshrc puts ENGELBART_GIT_BIN first and ENGELBART_AGENT_PATH folders last on path after the person's .zshrc; unsets the helper vars; unsets ZDOTDIR when it is $HOME | shell-rc.cjs | ShellRC.swift | done (local) |
| 13 | Launcher `<userData>/shell/<shell basename>` 0700: exports ENGELBART_PRIOR_ZDOTDIR, ZDOTDIR=<userData>/zsh, SHELL=real; execs the real shell with "$@" | shell-rc.cjs prepareLauncher | ShellRC.swift | done (local) |
| 14 | bash: launcher runs `--init-file <userData>/bash/init.bash -i` only for exactly `-il`; otherwise `exec bash "$@"`; init.bash reads /etc/profile then first of ~/.bash_profile, ~/.bash_login, ~/.profile, then the Git/agent PATH lines, export PATH | shell-rc.cjs BASH_INIT | ShellRC.swift | done (local) |
| 15 | fish runs through the launcher untouched (prompt visible, no marks) | shell-rc.cjs header | ShellRC.swift | done (local) |
| 16 | environmentForSessions: drops CLAUDE_CODE_(CHILD_SESSION\|EXECPATH\|MESSAGING_\|SESSION_\|SSE_PORT)*, CLAUDE_PID, CLAUDE_EFFORT, CODEX_SANDBOX*, CODEX_MANAGED_BY*; keeps CLAUDE_VAULT, ANTHROPIC_*; SHELL = launcher | shell-rc.cjs; shell-rc.test | ShellRC.swift | done (local) |
| 17 | Through the launcher zsh runs the person's .zshenv/.zprofile/.zshrc, prompt empty even with a precmd that sets it, ZDOTDIR handed back (unset when $HOME), SHELL = real shell; marks emitted | shell-rc.test (real zsh) | Tests/ShellRCTests | done (local) |
| 18 | The shell that replaces an agent (`exec "$TERMINAL_USER_SHELL" -il`) is integrated too (ready mark, no prompt) | shell-rc.test | Tests/ShellRCTests | done (local) |
| 19 | A ZDOTDIR the person sets in ~/.zshenv is honoured and handed back | shell-rc.test | Tests/ShellRCTests | done (local) |
| 20 | Engelbart's Git first on PATH after startup files rebuilt it (terminal and hidden runs), only while ENGELBART_GIT_BIN is set | shell-rc.test | Tests/ShellRCTests | done (local) |
| 21 | Agent folders missing from PATH found by name in terminal and hidden runs, after the person's own | shell-rc.test | Tests/ShellRCTests | done (local) |
| 22 | userData = `~/Library/Application Support/Engelbart Swift/` (ARCHITECTURE §3) — paths with a space are quoted in the launcher | ARCHITECTURE §3 | TerminalPaths.swift | done (local) |

## Shell history (shell-history.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 23 | Candidates in order: $HISTFILE, ~/.zsh_history, ~/.zhistory, ~/.bash_history; first readable wins; missing → [] | shell-history.cjs | ShellHistory.swift | done (local) |
| 24 | Reads the last 512 KiB only; when truncated, drops the partial first line | shell-history.cjs | ShellHistory.swift | done (local) |
| 25 | unmetafy: 0x83 then byte → byte ^ 0x20 | shell-history.cjs; shell-rc.test | ShellHistory.swift | done (local) |
| 26 | parseHistory: strips `: <ts>:<n>;`, joins `\`-continued lines with `\n`, trims, drops entries > 2000 chars and empty, collapses duplicates onto latest use, keeps the last `limit` (300), oldest first | shell-history.cjs; shell-rc.test | ShellHistory.swift | done (local) |

## Settings (settings.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 27 | `<userData>/settings.json` {fontSize, lastCwd, sidebarVisible}; normalize: fontSize integer 10–24 else 14; lastCwd existing dir (resolved) else home; sidebarVisible bool else true; unreadable file → defaults | settings.cjs; launch.test | Settings.swift | done (local) |
| 28 | save(patch): only those 3 keys ("Unsupported setting: x"), fontSize validated ("fontSize must be an integer between 10 and 24"), lastCwd existing dir ("lastCwd must be an existing directory"), sidebarVisible bool ("sidebarVisible must be a boolean"); write tmp then rename, file 0600, dir 0700, JSON 2-space + newline | settings.cjs | Settings.swift | done (local) |
| 29 | The transcript font size is the settings' fontSize (14 by default: the renderer's 12.5 default is replaced by main's normalized 14 at bootstrap) | sessions.js bootstrap + settings.cjs | SessionStore.swift | done (compiled, untested) |

## Session manager (session-manager.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 30 | At most 12 sessions: "At most 12 sessions may be open" | session-manager.cjs | SessionManager.swift | done (local) |
| 31 | create: PTY named xterm-256color with launch spec; title = shell basename for shell, provider name otherwise; snapshot {id (uuid), provider, libraryId?, title, cwd, shell, pid, cols, rows, status running/exited, exitCode when exited, createdAt ISO, history} | session-manager.cjs | SessionManager.swift | done (local) |
| 32 | Environment = base (environmentForSessions) + extraEnvironment() read at every start (the tool check's Git/agent paths) | session-manager.cjs; index.cjs:619 | SessionManager.swift | done (local) |
| 33 | Output batched: 8 ms timer, a batch over 64 KiB is cut at a UTF-8 boundary and flushed in pieces; each flush gets sequence n+1 and is emitted as `terminal:data` {id, sequence, data} | session-manager.cjs; session.integration "bounded batches" | SessionManager.swift | done (local) |
| 34 | Replay history: ≤ 600 entries and ≤ 1 MiB (each entry UTF-8 tail-trimmed); bounded test (160 B / 3 entries) | session-manager.cjs; session.integration | SessionManager.swift | done (local) |
| 35 | Flow control: while the session's consumer is attached, unacked bytes counted per sequence; > 512 KiB pauses the PTY read; acknowledge(seq) frees all ≤ seq and resumes at ≤ 128 KiB; acknowledge rejects unknown id, seq ≤ acknowledged or > sequence → false | session-manager.cjs; session.integration | SessionManager.swift | done (local) |
| 36 | attach/detach (scoped or all) reset acknowledged = sequence, clear outstanding, resume | session-manager.cjs | SessionManager.swift | done (local) |
| 37 | write: string ≤ 64 KiB UTF-8 else "Terminal input must be a string of at most 65536 bytes"; unknown "Unknown session"; exited "Session has exited" | session-manager.cjs | SessionManager.swift | done (local) |
| 38 | resize validates 2–500 × 1–500 and updates snapshot cols/rows; reaches `stty size` | session-manager.cjs; session.integration | SessionManager.swift | done (local) |
| 39 | close: SIGHUP (node-pty's default kill), wait 1500 ms; then SIGKILL, wait 500 ms; then throw "PTY did not exit after termination signals" (record kept, still running); success removes the record; unknown id → false | session-manager.cjs; session.integration | SessionManager.swift | done (local) |
| 40 | Closing a session ends its foreground child | session.integration | Tests | done (local) |
| 41 | shutdown closes all | session-manager.cjs | SessionManager.swift | done (local) |
| 42 | exit: pending batch flushed first, status exited, exitCode (and signal when killed; exitCode 0 with a signal, as node-pty), `terminal:exit` {id, exitCode, signal?}; close waiters resolved | session-manager.cjs; memory note 177 | SessionManager.swift | done (local) |
| 43 | Real PTY: controlling terminal (`test -t 0`), Ctrl-C interrupts the foreground job and the shell stays usable, exit code kept (exit 7), two sessions isolated by cwd | session.integration | Tests/SessionIntegrationTests | done (local) |
| 44 | createSandbox({sandboxId /^[\w-]{1,200}$/, libraryId 1–64, title, cwd absolute ≤4096 no NUL, envs strings, hint, apiKey fn, cols=100, rows=30}) over a sandbox PTY; env envs + TERM/COLORTERM; banner `ESC[2m# Try: <hint, controls→space, trim, 200> ESC[0m\r\n`; title controls stripped ≤200 default "Sandbox"; provider 'sandbox', shell 'bash'; errors "Sandbox terminals are unavailable", "Invalid sandbox", "Invalid library id", "Invalid sandbox directory", "A sandbox terminal needs the E2B key", "Invalid sandbox environment" | session-manager.cjs createSandbox | SessionManager.swift `createSandbox(_:process:)` (the app adapts the Sandbox package's PTY to `TerminalProcess`) | partial: validation, banner and bookkeeping done and tested with a fake process; the E2B PTY itself is the Sandbox package's |
| 45 | wake(id): a running session whose process can wake (sandbox) wakes; others nothing | session-manager.cjs | SessionManager.swift | done (local) |
| 46 | Build run step's terminal: shell session 100×30 in cwd; the command typed with `\r` once output has been quiet 150 ms after a draw, at most 3 s after start | index.cjs openTerminal | SessionManager.swift `openCommand` | done (local) |
| 47 | Quitting with running sessions asks "Quit and end N running terminal session(s)?" / detail "Terminal sessions live in this app process and cannot be recovered after quitting. Documents are already saved." buttons "Quit and End Sessions" / "Cancel" (default Cancel); Restart to Update skips it | index.cjs requestQuit | QuitPrompt.swift (`TerminalQuit.confirm`) — the app calls it | done (local: the message text; the NSAlert itself compiled, untested) |
| 48 | Sessions belong to the window they were opened from; a closed window's sessions keep running and the next window to attach (on that project) takes them; only the owner consumes/acknowledges output | windows.cjs; windows.test | SessionStore.swift owner token | done (local: a pane claims its project's sessions no pane holds; the window-closed handover compiled, untested). Mapping: owner = the pane controller |

## Agent terminal (agent-terminal.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 49 | run({command, env?, cwd, cancel, timeout 45 min, onLine, cols 220, rows 50}) → {output, exitCode, signal, timedOut, stopped, error?}; env given = the whole environment, else sanitized(environment + extra) | agent-terminal.cjs; browser-agents.test | AgentTerminal.swift | done (local) |
| 50 | Shell = resolveShell(base.SHELL ? base : environment); env + TERM=xterm-256color, SHELL, TERMINAL_USER_SHELL; args loginShellArgs | agent-terminal.cjs | AgentTerminal.swift | done (local) |
| 51 | Spawn failure → {output '', exitCode 127, error message} | agent-terminal.cjs | AgentTerminal.swift | done (local) |
| 52 | Terminal queries answered in order asked: XTVERSION `ESC P>|xterm.js(6.0.0) ESC\`, DA1 `ESC[?62;22c`, DA2 `ESC[>0;276;0c`, kitty `ESC[?0u`, DSR `ESC[1;1R`, 14t `ESC[4;800;1600t`, 16t `ESC[6;16;8t`, OSC10 rgb:1717/1717/1717, OSC11 rgb:ffff/ffff/ffff, 996n `ESC[?997;2n` | agent-terminal.cjs QUERIES; test | AgentTerminal.swift | done (local) |
| 53 | plain(): OSC, DCS, APC, CSI, charset, single ESC codes removed; CRLF/CR → LF | agent-terminal.cjs; test | AgentTerminal.swift | done (local) |
| 54 | Output kept: last 2 MiB of plain text; onLine per completed line, the partial line at the end; reader exceptions ignored | agent-terminal.cjs; test | AgentTerminal.swift | done (local) |
| 55 | Stop (cancel) → stopped=true, SIGTERM, SIGKILL after 2000 ms; already cancelled → kill next tick; timeout → timedOut=true and the same kill | agent-terminal.cjs; test | AgentTerminal.swift | done (local) |

## Renderer helpers (helpers.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 56 | splitUtf8Chunks(value, 48 KiB): never splits a scalar; limit < one scalar → "Chunk limit cannot contain one complete character" | helpers.cjs; renderer-helpers.test | Helpers.swift | done (local) |
| 57 | terminalKeyAction: plain Shift+Enter (not composing) → line-feed (sends `\n` once on keydown, swallowed); ⌘C (no alt/ctrl) → copy | helpers.cjs; test | Helpers.swift + TerminalPaneController key monitor | done (local) |
| 58 | workspaceKeyAction (⌘+ font-increase, ⌘1–9 activate, Escape close-find; inert behind a dialog), CrossSourceShortcutGate (100 ms echo), initialTerminalGeometry, preservedChromeFocus: Experimental Terminal helpers kept with their tests | helpers.cjs; test | Helpers.swift | done (local) |
| 59 | browserLink: http/https only ("URL protocol must be http or https"), invalid → "URL is invalid"; returns normalized href (`http://localhost:5173` → `http://localhost:5173/`) | helpers.cjs; test | Helpers.swift | done (local) |
| 60 | PendingEvents: buffered data/exit for sessions not yet adopted, bounded 1200 entries / 2 MiB, merge with bootstrap history by sequence (live wins), dropped entries acknowledged | helpers.cjs; test | Helpers.swift | done (local) (native: adoption reads history synchronously on main, so the store never needs it; ported with its tests) |

## Session store (sessions.js)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 61 | Sessions and their terminal views survive the pane being hidden or unmounted (module singleton) | sessions.js header | SessionStore.shared | done (local) |
| 62 | Light theme: bg #ffffff fg #171717 cursor #0070f3 accent #ffffff selection #dbe8fb/#171717; ANSI black #171717 red #c8102e green #1a7f37 yellow #9a6700 blue #0070f3 magenta #8250df cyan #0e7490 white #e2e2e2; bright #8f8f8f #e70022 #2da44e #bf8700 #3291ff #a475f9 #0891b2 #ffffff | sessions.js THEME | TerminalTheme.swift | done (compiled, untested; strip/footer drawn and looked at locally, the transcript's colours not) |
| 63 | Font Source Code Pro (Menlo fallback) at fontSize, lineHeight 1.18, letterSpacing 0; bar cursor blinking; scrollback 10000; minimumContrastRatio 4.5; option is meta | sessions.js Terminal options | TerminalTheme.swift / TranscriptView | done (compiled, untested) |
| 64 | No cursor while the transcript does not have the keys (cursorInactiveStyle none) | sessions.js | TranscriptView (caret colour cleared when not first responder) | done (compiled, untested) |
| 65 | Scroll feel: scrollSensitivity 2.5, fastScrollSensitivity 10 (Option held), smooth 90 ms / WebGL renderer | sessions.js; memory note 35 | TranscriptView (SwiftTerm Metal renderer + precise scrolling; sensitivity 2.5, 10 with Option via a scroll monitor) | done (compiled, untested). Mapping: WebGL → SwiftTerm's Metal renderer (CoreGraphics fallback), smoothScrollDuration → native precise scrolling |
| 66 | rightClickSelectsWord | sessions.js | TranscriptView.rightMouseDown | done (compiled, untested) |
| 67 | Links (OSC 8 and plain URLs, plain click) open on the Stage (host openInStage); non-http(s) refused with "Link could not be opened: URL protocol must be http or https" in the pane's errors | sessions.js openLink, helpers browserLink; spec #86 | SessionStore / TranscriptView delegate | done (local) |
| 68 | Terminal view inset 10px top, 14px left, 0 right/bottom inside the stage | sessions.js view.style; memory note 44 | TerminalPaneController layout | done (local) |
| 69 | Transcript locked while the box is the input: never holds focus (focus moves to the box), a press on empty space is swallowed and clears the selection, only a press on printed text starts a selection (drag), keys that reach it go to the box (printable ones appended) | sessions.js mousedown/focusin/custom key handler; memory note 44 | TranscriptView.mouseDown + first-responder observer | done (local) |
| 70 | Pasted text from a PDF loses page layout (pdfText) before reaching the PTY; other pastes unchanged; bracketed paste respected, newlines → CR | sessions.js paste; MATH-24 | TranscriptView.paste + host.pdfText | done (local: the host's transform reaches the view; the bracketed send compiled, untested) |
| 71 | OSC 633 marks: A → integrated, idle, command ''; C → busy; E;<line> → command; P;Cwd=<dir> → cwd (empty keeps old) | sessions.js applyShellMark | ShellMarks.swift (scanned from the byte stream, split across chunks) | done (local) |
| 72 | Initial shell state: integrated false, busy = provider ≠ shell, command '', cwd = snapshot cwd | sessions.js | SessionStore.swift | done (local) |
| 73 | Window title (OSC 0/2) → display title, controls stripped, trimmed, ≤160, fallback snapshot title | sessions.js truncateTitle | SessionStore.swift | done (compiled, untested) |
| 74 | Input to the PTY in ≤ 48 KiB chunks, in order; failure → "Input could not be sent: …" | sessions.js inputFor | SessionStore.swift | done (local) |
| 75 | Errors list keeps the last 10 {at, message}; dismissable | sessions.js pushError | SessionStore.swift | done (local) |
| 76 | createSession: cwd = given or settings.lastCwd or home; default dims when none 800×300 estimate; saves lastCwd | sessions.js createSession | SessionStore.swift | done (local) |
| 77 | estimateDimensions: cols = clamp(floor((w−24)/(fs·0.61)), 20, 500), rows = clamp(floor((h−18)/(fs·1.2)), 5, 500) | sessions.js | Helpers.swift | done (local) |
| 78 | Fit on mount and on every stage resize; resize PTY only when running and the grid changed; failure → "Terminal could not be resized: …" | sessions.js fitSession | TerminalPaneController / SessionStore | done (local: resize reaches stty; the view→PTY fit path compiled, untested) |
| 79 | clearSession wipes transcript and scrollback, clears selection, leaves the process alone | sessions.js clearSession | SessionStore.swift | done (local) |
| 80 | closeSession: a running process is ended without asking; failure → "Session could not be closed: …" | sessions.js; memory note 35 | SessionStore.swift | done (local) |
| 81 | adoptSession(snapshot, projectId): the project's from now on (re-homed if another project had it); dropSession(id) removes the tab; SHOW_TERMINAL {id} brings it to front | sessions.js; Workspace.jsx | SessionStore.adopt/drop, pane.show(sessionId:), EventHub `engelbart:show-terminal` | done (local) |
| 82 | Providers asked of the host at bootstrap and again on every `engelbart:tools` event; failure → "CLI availability could not be checked: …"; default only shell | sessions.js refreshProviders | SessionStore.swift | done (local) |
| 83 | setFontSize clamps 10–24, applies to every view, saves | sessions.js | SessionStore.swift | done (compiled, untested) |
| 84 | Exited session: status exited, exitCode/signal kept | sessions.js applyExit | SessionStore.swift | done (local in SessionManager; the store's copy compiled, untested) |

## Pane (TerminalPane.jsx)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 85 | One shell auto-started in the project directory when this project has none (once per project per pane; failure → "Shell could not be started: …" and retried next time) | TerminalPane.jsx | TerminalPaneController | done (local) |
| 86 | No terminal without a project directory: stage text "no project directory"; before bootstrap "starting…"; no session "no terminal yet — press + or ⌘T" (mono 12.5/1.7 #8f8f8f) | TerminalPane.jsx; spec #37 | TerminalPaneController | done (local) |
| 87 | Project directory changes: untouched idle integrated shells still in the old directory get `cd -- '<new>'\r` | TerminalPane.jsx; spec #37 | TerminalPaneController.projectDirectoryChanged | done (local) |
| 88 | ↑ history seeded from the shell history file merged before the pane's own, ≤500 | TerminalPane.jsx | TerminalPaneController | done (local) |
| 89 | describe(): integrated → busy from marks, agent = claude/codex when the running command line matches AGENT_COMMAND (prefixes command/exec/noglob/nocorrect/sudo and VAR=val, any path) else shell; not integrated → busy = provider ≠ shell, agent = provider | TerminalPane.jsx | ShellMarks.swift `describe` | done (local) |
| 90 | Takeover: not busy → box; busy and (not integrated or agent ≠ shell) → transcript at once; busy shell command → transcript after 200 ms | TerminalPane.jsx TAKEOVER_DELAY | TerminalPaneController | done (local) |
| 91 | boxIsInput = running && integrated && !takeover; showBox = running && !takeover; conversation = running && agent ≠ shell | TerminalPane.jsx | TerminalPaneController | done (local) |
| 92 | Where typing goes: takeover → transcript focused; else box focused (on show, tab switch, takeover change) | TerminalPane.jsx | TerminalPaneController | done (local) |
| 93 | Box: Enter sends `text\r` (when running), non-blank lines join history (deduped, ≤500) and mark the tab touched; draft cleared; Shift+Enter nothing | TerminalPane.jsx onInputKey | TerminalPaneController | done (local) |
| 94 | ↑ walks back from the newest; ↓ forward, past the end → empty box; typing resets the walk | TerminalPane.jsx | TerminalPaneController | done (local) |
| 95 | ⌘C in the box with no box selection copies the transcript selection (if any) | TerminalPane.jsx | TerminalPaneController | done (compiled, untested) |
| 96 | Ctrl+C sends ^C (running) and clears the draft and walk; Ctrl+D sends ^D only with an empty draft; Ctrl+L sends ^L; Tab swallowed; Escape leaves the box | TerminalPane.jsx | TerminalPaneController | done (local) |
| 97 | Click on the stage: a running program takes the keyboard; under an idle shell the box keeps the caret | TerminalPane.jsx onStageClick | TerminalPaneController | done (compiled, untested) |
| 98 | ⌘T opens a shell in the project directory whenever the Terminal shows, unless keysToDoc() says the middle canvas was clicked last and the keyboard is not inside the pane | TerminalPane.jsx; commit 6f121d4 | TerminalPaneController key monitor | done (local) |
| 99 | ⌘W inside the pane closes the current tab (never asks); ⌘1–9 inside the pane switch tabs; Ctrl+digits pass through | TerminalPane.jsx; memory note 35; BUILD-NOTES | TerminalPaneController key monitor | done (local) |
| 100 | The last tab never goes: × clears an idle integrated shell in place (draft and walk cleared, box focused); a busy or exited last tab is replaced by a fresh shell at its directory, then closed | TerminalPane.jsx close; commit 471e439 | TerminalPaneController.close | done (local) |
| 101 | Closing another tab: the next tab at the same index (or the last) comes forward | TerminalPane.jsx | TerminalPaneController.close | done (local) |
| 102 | Dropdown "Terminal ⌄" (Terminal / Claude Code / Codex): same agent already running here → focus; Terminal → newest other idle shell tab else new shell at current cwd; agent: untouched idle integrated tab types `claude\r` in place; else newest running tab with that agent at the same cwd; else new tab launching the provider at current cwd; unavailable agents greyed with "not installed", tooltip "not found on PATH" | TerminalPane.jsx pickAgent; spec #32 | TerminalPaneController | done (local) |
| 103 | cwd chip: folder picker starting at the tab's directory; idle integrated shell → `cd -- '<dir>'\r`; non-integrated shell → cd and remembered; otherwise remembered for the tab; box refocused; disabled with no session and for sandbox tabs ("In the repository's sandbox") | TerminalPane.jsx changeCwd | TerminalPaneController | done (local: idle shell cd; the sandbox-disabled chip compiled, untested) |
| 104 | Folder picker: title "Choose working directory", opens at the given directory when it exists else home (never the data folder), can create folders; ENGELBART_PICK_DIRECTORY returns that path (driver hook) | index.cjs terminal:pick-directory | DirectoryPicker.swift | done (local: start directory; the panel compiled, untested) |
| 105 | Tab strip: height 40, #fafafa, padding 0 8 0 10, no rule under it; tabs as FluidTab (34 high, ≤220 wide, ≥44, front white with 10px top radius and flared feet, others radius 8 hover #e6e6e6, hairline #c9c9c9 16px between two non-front tabs) | TerminalPane.jsx; FluidTab.jsx | PaneViews.swift TabStripView | done (local: drawn offscreen and looked at) |
| 106 | Tab content: `›_` 11px mono (#4d4d4d front, #8f8f8f), title = sandbox title or basename(cwd) + " · exited N", 12.5px sans (#171717 front, #4d4d4d), fades over its last 18px only when clipped; × 20px circle (#8f8f8f, hover #e3e3e3/#171717), tooltip "Close" or "Clear — the last terminal stays" | TerminalPane.jsx; FluidTab.jsx | PaneViews.swift | done (local: drawn offscreen and looked at) |
| 107 | Tab hover card after 650 ms (60 ms while warm, cools 400 ms after leaving): 260 wide, 6 below, left clamped to the window; agent label (500 13/1.4) and cwd (12/1.4 #8f8f8f), border #c9c9c9 radius 8; press hides it | FluidTab.jsx useTabCard | PaneViews.swift TabCardView | done (compiled, untested) |
| 108 | `+` (28px circle, 18px #4d4d4d, hover #e6e6e6/#171717) opens a shell in the project directory; tooltip "New terminal (⌘T) in the project's code directory" | TerminalPane.jsx | PaneViews.swift | done (local) |
| 109 | Agent menu button: label + ⌄ (10px #8f8f8f), 500 12.5 sans, padding 4 8 radius 6, #eaeaea while open, hover wash #f2f2f2; menu 200 wide right-aligned to the button, 6 below, clamped 8 from window edges, 4 padding, border #eaeaea radius 8, rise 160 ms; items 7 10 radius 6, ✓ column 14, label 13/1.4 (500 when current), hover #f2f2f2; closes on a press outside | TerminalPane.jsx | PaneViews.swift AgentMenu | done (compiled, untested: open/close test; the panel's look not seen) |
| 110 | Full-screen button (28px, radius 6, hover #eaeaea, Expand/Collapse 16px icons), only when the host offers it | TerminalPane.jsx; commit bc0a56e | PaneViews.swift | done (local) |
| 111 | Footer: #fafafa, 1px #eaeaea top border, padding 10 14 12 (conversation 10 14 10), gap 10; agent chip (`›_` #8f8f8f + label, 500 11.5/1.4 mono, padding 3 8, border #eaeaea radius 6, white); cwd chip (`▭` + path ellipsized, 400 11.5 mono #4d4d4d, hover border #c9c9c9, tooltip "Change working directory…") | TerminalPane.jsx | PaneViews.swift FooterView | done (local: drawn offscreen and looked at) |
| 112 | Box "Run commands": mono 12.5/1.7 #171717, caret #0070f3, no spellcheck/autocomplete; while a program has the keys a one-line blank of the same height (no resize); exited → "this terminal has exited — press + for a new one"; a conversation shows no line at all | TerminalPane.jsx; spec #32 | FooterView | done (local) |
| 113 | Stage errors: launch error and the store's errors as `# message` in #e70022 mono, each store error with a × to dismiss | TerminalPane.jsx | TerminalPaneController | done (local). Deliberate departure: Electron's absolute xterm view covered the stage's error lines, so an error showed only with no terminal; here they sit above the transcript |
| 114 | Stage cursor: default while the box is the input, text otherwise | TerminalPane.jsx | TranscriptView cursor | partial: the arrow over a locked transcript is set from a mouse-moved monitor (SwiftTerm's cursor rects cannot be overridden); not checked on screen |
| 115 | A sandbox tab in front of a focused window touches its sandbox now and every 60 s | TerminalPane.jsx useSandboxTouch | TerminalPaneController + host.touchSandbox | done (compiled, untested) |
| 116 | Detach on unmount: views leave, sessions and PTYs stay; input locks released | TerminalPane.jsx | TerminalPaneController.viewWillDisappear / deinit | done (local: hiding detaches; viewDidDisappear compiled, untested) |

## Electron-only mechanics

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 117 | IPC validation (trusted renderer, windowHandler), preload bridge, `terminal:menu` channel (never sent) | ipc-validation.cjs, preload.cjs | — | n/a: no renderer process; direct calls |
| 118 | RendererLifecycle gating of sends until the pane bootstraps; send failure detaches | window-lifecycle.cjs; lifecycle.test | — | n/a: no IPC; mapping: a session's consumer is attached while a pane owns its view (#48) |
| 119 | shouldHideWindowOnClose(darwin, !quitReady) | window-lifecycle.cjs | WindowLifecycle.swift `shouldHideWindowOnClose` | done (local) |
| 120 | open-external (http/https only) used by the bridge | index.cjs | host.openExternal | n/a: links go to the Stage (spec #86); the host keeps openExternal for the app |
