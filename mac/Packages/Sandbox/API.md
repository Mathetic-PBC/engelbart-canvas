# EngelbartSandbox — public surface

E2B sandboxes for saved GitHub repositories: live previews, sandbox terminals, saved environments, sleep/wake and the
7-day sweep, the local Claude Code setup agent, and their UI (build notifications, environment panel). Ports
`src/main/sandbox/**`, `src/main/github/e2b-key.cjs`, `src/shared/{sandbox-sleep,environment}.cjs`, the sandbox channels
of `ipc.cjs`/`index.cjs`/`preload.cjs`, `ui/SandboxProgress.jsx`, `ui/SandboxNotifications.jsx`,
`model/sandbox-notifications.js`, `workspace/EnvironmentPanel.jsx`. Ledger: `mac/parity/sandbox.md`.

## Wiring (what the app does at launch)

```swift
let e2b = E2BHTTPClient()                                    // E2B_DOMAIN / E2B_API_URL honoured
let key = try E2BKey(token: { await github.token() }, version: appVersion,
                     host: env["ENGELBART_E2B_KEY_HOST"] ?? E2BKey.keyHost,
                     override: isPackaged ? nil : env["E2B_API_KEY"])   // developer key: unpackaged copies only
var o = SandboxManager.Options(notify: { _ in }, launch: InProcessWorker.launcher(e2b: e2b))
o.secure = KeychainSecureStorage()
o.e2bKey = { try await key.get() }
o.githubLogin = { github.status().login ?? "" }
o.repoAccess = <Integrations' repo-access adapter>          // SandboxRepoAccess
o.claudeReady = { _ = try await LocalClaude.prepare() }
o.e2b = e2b
o.terminals = SandboxTerminals(sessions: { terminalSessions }, own: {…}, closed: {…})
let manager = SandboxService.makeManager(o)                 // nil when ENGELBART_SANDBOXES=off; posts EventHub events
let service = SandboxService(manager: manager, context: { SandboxContext(dataRoot: root, db: storeAdapter) })
```

`--mcp sandbox-local <connection.json>` → `exit(SandboxLocalMCP.main(arguments: rest))` (the local Claude's tools).

## Entry points

| Type | Role (Electron counterpart) |
|---|---|
| `SandboxService` | the IPC channels: `runs()` (sandbox-runs), `ensure()` (sandbox-ensure), `start(libraryId)`, `stop(runId)`, `touch(libraryId)`, `terminal(libraryId)`, `environment(libraryId)`, `saveEnvironment(libraryId, changes, revision:)`, `restart(libraryId)`; `added(ctx,row:value:)` (start after a library add → row with `sandbox_error`), `startsOnAdd(row:value:)`, `startLinked(ctx,before:context:)` (workspace links; returns the `sandbox_error` text), `release(ctx,libraryId)` (before deleting a row), `queued{}` / `changeMode(before:_:)` (data-mode change), `githubChanged(connected:key:developerKey:)`, `quit()` |
| `SandboxManager` | manager.cjs: `start`, `stop`, `restart`, `list`, `touch`, `terminal`, `environment`, `saveEnvironment`, `release`, `signedOut`, `poll`, `close`, `dispose`. Options: `notify`, `launch`, `readEnv`, `secure`, `e2bKey`, `githubLogin`, `repoAccess`, `claudeReady`, `e2b`, `terminals`, `now`, `pollEvery` (15 s) |
| `SandboxContext` | `{ dataRoot, root, db: SandboxDatabase }` |
| `RunStore`, `EnvironmentStore` | runs.cjs, environment.cjs's store (usable directly, e.g. Build's details) |
| `EnvironmentReport`, `EnvironmentRows`, `EnvironmentNames`, `Redact`, `SandboxSleep`, `BuildHistory.milestoneKey` | shared/environment, redaction, sandbox-sleep, a copy of build-history's milestone key |
| `SandboxNotifications` | the renderer model: `reduce`, `available`, `read/write` storage (key `engelbart:preview-notifications:<root>`), `runKind`, `canOpenPreview`, `canOpenTerminal`, `failureReason`, `repositoryClick` (`start`/`both`/`preview`/`terminal`/`details`/nil), `previewLibraryId`, `sandboxStatus` |
| `SandboxProgressModel` (@MainActor) | SandboxProgress.jsx: `state`, `rows`, `unread`, `error`, `busy`, `buildRepoId`, `library`, `inWorkspace`, `open(run)`, `openRepository(row)`, `openTerminal(run, show:)`, `openBuild/closeBuild`, `markRead`, `clear`, `setDataRoot`, `setGithubSignedIn`, `setClaudeSignedIn`, `prepare()` |
| `SandboxTouch` (@MainActor) | useSandboxTouch/usePreviewTouch: `update(libraryId:focused:)`, `updatePreview(url:showing:items:focused:)` — pings now and every 60 s |
| `EnvironmentPanelModel` / `EnvironmentPanelView` | EnvironmentPanel.jsx (`embedded:` true inside build details) |
| `NotificationBellView`, `NotificationRowsView`, `BuildNotificationView`, `SandboxViews.bell/rows/environment` | the bell (all-projects screen), the Inbox rows (sidebar), AppKit hosts |
| `SandboxPty` / `SandboxShell` / `SandboxShellSpec` | pty.cjs: a PTY-like shell (`pid`, `onData`, `onExit`, `write`, `resize`, `kill`, `wake`, `pause/resume` no-ops); `spawnSession(spec, cols:rows:)` does session-manager's `createSandbox` checks, env (`TERM`, `COLORTERM`) and `# Try:` banner; `spec.sessionTitle` |
| `SandboxTerminals` | terminals.cjs over a `SandboxSessions` |
| `E2BHTTPClient` (`E2BService`, `E2BSandbox`, `E2BCommandHandle`) | the E2B SDK calls Engelbart makes |
| `E2BKey` | e2b-key.cjs |
| `SandboxConfig.read(root:env:localFile:)` | config.cjs |
| `WorkerRuntime`, `InProcessWorker` | worker.cjs + transport.cjs (in-process) |
| `LocalSetup.run`, `SandboxTools`, `SandboxToolsSpec`, `DependencyInstall`, `InstallPlanner`, `LaunchDiscovery.discover/discoverLocal`, `NpmAudit.run` | local-setup/tools/install/launch-discovery/npm-audit |
| `LocalClaude.prepare/arguments/run/subscriptionEnvironment/subscriptionStatus/knownPlaces` | local-claude.cjs (Build's run step uses `prepare`, `run`, `discoverLocal`, `ToolBridge`, `SandboxWorker.respondsAt` too) |
| `ToolBridge` (`open`, `connection`, `close`, `mcpContent`) | local-tools.cjs's `openToolBridge` |
| `SandboxLocalMCP` | `--mcp sandbox-local` (local-mcp.cjs) |
| `SandboxResources.url/text` | the bundled Python helpers |

## Protocols the app provides

- `SandboxDatabase` — `query(sql, params)`, `transaction{}`, `libraryRow(id)`, `libraryRows()` over `<root>/library.sqlite`
  (tables `sandbox_runs`, `sandbox_environments` as db.cjs; SQLite dialect, `RETURNING`, `ON CONFLICT`, window functions).
  `SQLiteSandboxDatabase(path:)` is a ready adapter; `SQLiteSandboxDatabase.createSchema` makes the tables for a fresh file.
- `SecureStorage` — `KeychainSecureStorage` (generic password, service `Engelbart Swift Safe Storage`, account
  `sandbox-environments`, an AES-256-GCM key). Rows copied from Electron cannot be decrypted (Electron's own key): the
  panel says "Saved environment could not be unlocked…" and the values are saved again.
- `SandboxRepoAccess` — `describe(repo) → RepoAccessInfo(isPrivate, docker, branch)`, `archive(repo) → codeload link`.
- `SandboxSessions` — the terminal pane: `get(id)`, `createSandbox(spec)` (register `SandboxPty.spawnSession(spec)` as a
  session with provider `sandbox`, title `spec.sessionTitle`, cwd, shell `bash`, `libraryId`), `wake(id)`, `close(id)`.
- `NotificationStorage` — `UserDefaultsNotificationStorage` by default.
- `SandboxAPI` — built with `SandboxAPI(service:openURL:)`; `openURL(url, inWorkspace)` opens in the Stage
  (`OPEN_IN_BROWSER`) or the default browser.

## Events (EventHub)

| Name | Payload |
|---|---|
| `engelbart:sandbox-progress` | `{ dataRoot, run, message, sandbox: "asleep"/"running"/null, notification?: "preview-ready" }` |
| `engelbart:open-sandbox-terminal` | `{ session, show }` — the workspace adopts the session as a terminal tab |
| `sandbox-notifications:saved` | `{ root, window }` — another window saved its inbox (the localStorage `storage` event) |

## MCP servers

- `sandbox-local` — `<Engelbart> --mcp sandbox-local <connection.json>` (`{ url, token }`), server name `canvas-sandbox`,
  key `canvas` in Claude's `--mcp-config` (tools `mcp__canvas__*`).

## Needs from other packages

- **Store**: an adapter to `SandboxDatabase` on its connection (and the tables with db.cjs's constraints, which it owns);
  call `service.added` after `add-library-item`/`add-library-url`, `service.startLinked` after workspace context changes,
  `service.release` before onboarding's untick deletes a row, `service.changeMode` around data-mode changes.
- **Terminal**: `SandboxSessions` (SessionManager.createSandbox/wake/close/get) hosting `SandboxShell`; TerminalPane's
  sandbox tab in front should drive `SandboxTouch.update(libraryId:focused:)`.
- **Integrations**: `SandboxRepoAccess` (github/repo-access.cjs); the GitHub token and login for `E2BKey`/`githubLogin`;
  sign-in changes → `service.githubChanged`.
- **Tools**: Claude Code sign-in changes → `progressModel.setClaudeSignedIn` (re-prepares).
- **Stage**: the page in front → `SandboxTouch.updatePreview`; "Waking <repo>'s sandbox…" is the Stage's.
- **Build**: BuildDetails for `progressModel.buildRepoId` (embeds `EnvironmentPanelView(embedded: true)`).
- **What Build's run step and engelbart tools use from here** (they stay in this package; the app hands them to Build as
  closures, since Build cannot import EngelbartSandbox):
  - `LocalClaude.prepare(_ env:run:) async throws -> LocalClaudeAuth` (run-step's `prepareClaude`)
  - `LocalClaude.run(auth:bridge:prompt:model:effort:maxTurns:server:signal:onMessage:onEvent:spawnProcess:) async throws -> String`
    (run-step's `runAgent`; `server` gives Build's own `--mcp` adapter name for the connection file, e.g. `run-tools`/`engelbart`)
  - `ToolBridge.open(_ call:secrets:signal:maxBody:) async throws -> ToolBridge` with `.connection` (`url`, `token`) and
    `.close()`; `ToolBridge.mcpContent(_:)` for answers that are MCP content (Connect's screenshots)
  - `SandboxLocalMCP.server(_ connection:definitions:name:)` to serve another tool set over the same bridge (run-mcp,
    engelbart-mcp), and `SandboxLocalMCP.connection(_ file:)` to read the connection file
  - `LaunchDiscovery.discoverLocal(_ root: String) -> JSONValue` (run-step's `discover`)
  - `SandboxWorker.respondsAt(_ href:fetcher:) async -> Bool` (run-processes' UI check)
  - `GithubRepo.parse(_:)` (build/manager's `githubRepo`)
- **App**: the `--mcp sandbox-local` branch in its entry point; `service.quit()` on quit.
