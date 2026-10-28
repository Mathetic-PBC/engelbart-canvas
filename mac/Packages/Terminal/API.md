# EngelbartTerminal — public surface

Ports `src/main/terminal/**`, `src/main/shell-rc.cjs`, `src/main/shell-history.cjs`, `src/renderer/terminal/**` (and the
terminal half of `ui/FluidTab.jsx`). Ledger: `mac/parity/terminal.md`. Depends on Core, UI, SwiftTerm.

Threading: `SessionManager`'s callbacks and everything UI (`TerminalSessions`, `TerminalPaneController`) are main-thread
(`@MainActor` for the UI types). `AgentTerminal` runs on its own queue.

## App wiring (once, at launch)

```swift
var config = TerminalSessions.Configuration()
config.environment = ProcessInfo.processInfo.environment          // the launcher is put in as SHELL
config.extraEnvironment = { tools.environment() }                  // ENGELBART_GIT_BIN, ENGELBART_AGENT_PATH, ENGELBART_{CLAUDE,CODEX}_BIN
config.providers = { shell, done in done(.success(tools.providers(shell).map { TerminalProviderInfo(...) })) }
config.openLink = { url in /* a link from a session no pane shows: open on the Stage of the front window */ }
// config.userData defaults to ~/Library/Application Support/Engelbart Swift, config.home to ENGELBART_HOME_DIR or ~
let terminals = TerminalSessions.configure(config)
```

- The store re-asks `providers` whenever `EventHub` posts `engelbart:tools` (the Tools package's snapshot event).
- Quit: `TerminalQuit.confirm(running: terminals.runningCount, window:)` asks "Quit and end N running terminal
  session(s)?" (skip it for Restart to Update), then `terminals.manager.shutdown { }` (SIGHUP, then SIGKILL).
- `WindowLifecycle.shouldHideWindowOnClose(quitReady:)`: the last window hides until Quit.

## The pane (Workspace screen)

```swift
let pane = TerminalPaneController(store: nil /* = .shared */, host: workspaceAdapter)
pane.visible = (rightPaneMode == .terminal)   // hidden: views detach, sessions keep running
pane.projectDidChange()                        // after the project or its directory changed
pane.show(sessionId:)                          // SHOW_TERMINAL; also EventHub "engelbart:show-terminal" {id}
```

`TerminalHost` (per pane; all but the project have defaults):

| member | Electron |
|---|---|
| `terminalProjectId`, `terminalProjectDirectory` | TerminalPane `projectId`, `cwd` (project.json `directory`) |
| `terminalOpenLink(url)` | OPEN_IN_BROWSER: open on the Stage and show the Stage (http/https only, already normalized) |
| `terminalPickDirectory(current:window:completion:)` | `terminal:pick-directory` (default `DirectoryPicker.pick`) |
| `terminalPdfText(_:)` | `model/paste.js` pdfText for pastes into a transcript (default identity) |
| `terminalKeysToDoc()` | `keysToDoc` (model/key-side.js): middle canvas clicked last → ⌘T is the document's |
| `terminalFullScreen: Bool?`, `terminalToggleFullScreen()` | `full` / `onFull` (nil hides the arrows) |
| `terminalTouchSandbox(libraryId:)` | useSandboxTouch → `touchSandbox` (now and every 60 s while a sandbox tab is in front of the key window) |

Keys the pane takes (local monitor, only while visible and in its window): ⌘T (unless `terminalKeysToDoc()` and the
keyboard is outside the pane), ⌘W and ⌘1–9 from inside the pane, the box's Enter/↑/↓/Tab/Esc/⌘C/^C/^D/^L, Shift+Enter
in a transcript. Everything else (Ctrl+1–9, ⌘J…) passes through.

## Sessions for other packages

- `TerminalSessions.shared.adopt(snapshot, projectId:)` → `TerminalRecord`; `drop(id)`; `closeSession(id)`;
  `createSession(provider:cwd:projectId:cols:rows:)`; `sendInput(id, text)`; `clearSession(id)`; `setFontSize(_:)`;
  `selectionText(id)`; `runningCount`; `subscribe { }` for changes.
- `SessionManager` (`terminals.manager`): `create(Launch.CreateRequest)`, `write`, `resize`, `close(id) async throws`,
  `list()`, `get(id)`, `onData`/`onExit` (`terminal:data` {id, sequence, bytes}, `terminal:exit` {id, exitCode, signal}),
  `acknowledge`, `flowState`, `wake(id)`.
- Build's run step: `manager.openCommand(cwd:command:)` → a 100×30 shell that types `command\r` once quiet (150 ms, ≤3 s);
  then `adopt(snapshot, projectId:)` + `pane.show(sessionId:)`; `drop(id)` when the Build closes it.
- Sandbox shells: `manager.createSandbox(SandboxSessionRequest, process: { banner in <TerminalProcess> })`; the app adapts
  the Sandbox package's E2B PTY to `TerminalProcess` (started with `request.processEnvironment`, printing `banner`).
- Headless agent CLI (Connect's browser agents): `AgentTerminal(environment:extraEnvironment:).run(.init(command:env:cwd:stop:timeout:onLine:))`
  → `Result {output, exitCode, signal, timedOut, stopped, error}`; answers the CLI's terminal queries as xterm.js does;
  `StopSignal.stop()` = Stop (SIGTERM, SIGKILL after 2 s). `environment` should be
  `ShellRC.environmentForSessions(processEnv, userData:)`.
- Pure helpers: `Launch` (sanitizeEnvironment, loginShellArgs, resolveShell, createLaunchSpec), `ShellRC`
  (prepareLauncher, environmentForSessions), `ShellHistory.read(homeDir:)`, `TerminalSettingsStore`,
  `TerminalHelpers`, `ShellState`/`OscScanner`/`TabDescription`.

## Events

- Listens: `engelbart:tools` (refresh providers), `engelbart:show-terminal` {id}.
- Posts: none on EventHub (data/exit are `SessionManager` callbacks, not app-wide broadcasts).

## Needs from other packages

- **Tools**: `environment()` and `providers(shell)` (adapted in `Configuration`), and an `engelbart:tools` post on every
  check.
- **Workspace (wave 2)**: a `TerminalHost` adapter, `visible`, `projectDidChange()`, the Stage for links, the full-screen
  toggle, routing Build run-step sessions (`adopt` + `show`).
- **Doc/Editor**: `pdfText` (model/paste.js) for `terminalPdfText`.
- **Sandbox**: a `TerminalProcess` adapter for the E2B PTY and `touchSandbox(libraryId)`.
- **UI**: tokens for `#e6e6e6` (`.hov-tab`) and `#e3e3e3` (`.hov-x`), kept in `TerminalTheme` until Palette has them.
