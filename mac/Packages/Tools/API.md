# EngelbartTools — API

Git, Claude Code and Codex (detect, install, update, sign in/out, the per-tool lock, the environment every child process
gets) and app updates (the state machine, the install command, the banner). Ports `src/main/tools/**`,
`src/main/updates.cjs`, `src/renderer/ui/ToolSetup.jsx`, `src/renderer/ui/UpdateBanner.jsx`, `src/renderer/model/tools.js`
and the tools/update parts of `ipc.cjs`, `index.cjs`, `preload.cjs`, `App.jsx`. Behaviour ledger: `mac/parity/tools.md`.
Depends on EngelbartCore and EngelbartUI (tokens only: Palette, Fonts, Radius, Motion).

## Starting it (what index.cjs did)

```swift
let tools = ToolsSetup(storage: ToolsStorage(read: { store.config()["tools"] },          // config.json → tools, or nil
                                             write: { store.writeTools($0) }))            // → the tools written, or nil
// ToolsSetup reads ENGELBART_TOOLS_FAKE (pretend machine, records in memory only, config.json never touched),
// ENGELBART_TOOLS=off (no launch check), ENGELBART_GIT=bundled, ENGELBART_BUNDLED_GIT; installAtLaunch = ["claude"];
// finds Engelbart's own Git in Bundle.main's Resources/git/engelbart-bin/git; starts the launch check in the background.
tools.manager      // ToolsManager (@MainActor)
tools.channels     // ToolsChannels: the IPC channels as methods
await tools.beforeQuit()       // a quit ends sign-ins still waiting in the browser (stopSignIns, ≤3 s)
await tools.afterTestReset()   // test mode's reset: a pretend machine back to its first state, then a check
```

`ToolsStorage.write` must write `tools` into config.json **only while config.json parses** (home.cjs `writeTools`: a
background check never overwrites a file someone is editing) and return the `tools` written, or nil. The manager re-reads
`skip`, `pin` and `tools.updates` from `read()` on every write, so hand edits survive.

## ToolsManager (`@MainActor`)

| Member | Electron | Notes |
|---|---|---|
| `start() async -> ToolsSnapshot` | `start` | launch check once, then first-launch install, then automatic updates |
| `check(_ only: [String] = TOOL_NAMES) async` | `check` | |
| `install(_ names:) async -> [String: ActionResult]` | `install` | one at a time, verified by finding the program |
| `update(_ name:, auto:) async -> ActionResult` | `update` | rollback of a broken native/standalone launcher |
| `connect(_ name:) async -> ToolsSnapshot` | `connect` | install/update/check/sign in; a second press joins |
| `signIn(_:)`, `cancelSignIn(_:) -> Bool`, `stopSignIns(timeout:) async -> Int`, `signOut(_:) async -> ActionResult` | same | sign-in in a hidden PTY (`Pty.swift`, forkpty) |
| `skip(_:)`, `askAgain(_:)`, `setUpdates(_:)` | same | |
| `ensure(_ name:) async` | `ensure` | call before a run: re-check when the file is gone or the check is >10 min old |
| `nonisolated use(_ name:, _ fn:) async rethrows -> T` | `use` | a run holds the tool's lock shared (installs/updates wait) |
| `usableAgents() -> [String]?` | `usableAgents` | nil before the first check |
| `nonisolated environment() -> [String: String]` | `environment` | `ENGELBART_GIT_BIN`, `ENGELBART_AGENT_PATH`, `ENGELBART_CLAUDE_BIN`/`ENGELBART_CODEX_BIN`: add to **every** child process (terminal sessions, agent terminal, run processes, `codex mcp list`) |
| `nonisolated binaryFor(_ name:) -> String?` | `binaryFor` | full path when the name runs another copy (run `"$ENGELBART_<NAME>_BIN"`) |
| `providers(shellPath:) async -> [ToolProvider]` | `providers` | the terminal's Shell / Claude Code / Codex menu (`terminal:providers`) |
| `snapshot() -> ToolsSnapshot`, `canAutoUpdate(_:)`, `current: ToolsRecord`, `checked` | | |

Snapshot types: `ToolsSnapshot { checked, platform, updates, tools: [id: ToolSnapshot] }`, `ToolSnapshot { record:
ToolRecord, busy: Busy?, autoUpdate }` (+ `id`, `name`, `minimum`, field accessors), `.json` = the Electron shape.

## Channels (`ToolsChannels`, names = the IPC channels)

`tools()`, `check()`, `install(_:)` / `update(_:)` / `signIn(_:)` / `connect(_:)` (answer the snapshot at once, run in the
background), `cancelSignIn(_:)`, `signOut(_:) async` (answers once checked again), `skip(_:)`, `askAgain(_:)`,
`setUpdates(_:)` ('ask' else 'auto'), `openSetup()`. Names are checked: `ToolsChannelError.unknownTool` ("Unknown tool"),
at most three.

## Events (EventHub, Electron channel names)

| Name | Payload | Posted by |
|---|---|---|
| `engelbart:tools` | `ToolsSnapshot.json` | every manager change (ToolsSetup wires it) |
| `engelbart:tools-open` | `{}` | `ToolsChannels.openSetup()` (Engelbart ▸ Set Up Tools…; on other platforms File ▸ Set Up Tools…) |
| `engelbart:update` | `UpdateSnapshot.json` | every `Updates` change |

## Setup dialog

- `SetupGate` (`@MainActor`, ObservableObject): App.jsx's gating. Feed it every snapshot (`take`), `openAll()` for Set Up
  Tools…, `onboardingNew` while a new install's onboarding is on screen, `onboardingTools("install"|"skip")`; it publishes
  `request: (mode, ids)?`; call `close()` when the dialog closes. The app decides when no other popup is up.
- `ToolSetupModel(snapshot:ids:mode:backend:onClose:)` + `ToolSetupView(model:)` (SwiftUI, full-window overlay; Escape
  closes it before anything else sees it). `ToolSetupBackend.channels(toolsChannels)` wires the buttons; Open page goes to
  the default browser. Keep `model.snapshot` current from `engelbart:tools`.
- Pure model: `launchRows`, `installedSignedOut`, `needsAction`, `rowOf`, `installable`, `skipWarnings`, `allDone`,
  `TOOL_ORDER`, `ACTION_LABEL` (Connections and onboarding use `rowOf`/`launchRows`/`installable` too).

## App updates

```swift
let updates = Updates(options: .init(info: UpdateFeedSetting.read(), packaged: Bundle.main.bundleURL.pathExtension == "app",
                                     currentVersion: <CFBundleShortVersionString>),
                      ask: UpdateAlerts.ask,                 // sheet on the key window
                      progress: { DockProgress.set($0) },     // 2 indeterminate, -1 none
                      requestQuit: { update in await app.requestQuit(update: update) },   // true when it goes on to quit
                      runningSessions: { terminal.runningCount },
                      onChange: { _ in rebuildMenu() })
updates.start()     // first check after 60 s, then every 6 h; false when off
updates.menuItem()  // UpdateMenuItem(label, enabled): above Set Up Tools…; click → updates.performMenuItem()
updates.snapshot() / restart() / later()   // update-state / update-restart / update-later
```

**The feed is off by default**: `UpdateFeedSetting.read()` = defaults `engelbart.updates.downloads` (+
`engelbart.updates.developerId`), else Info.plist `EngelbartDownloads` / `EngelbartDeveloperID`; neither is set, so nothing
is checked until a Swift release folder exists. ENGELBART_UPDATES=off, ENGELBART_CONFIRM_ALL=1, ENGELBART_NO_OPEN=1 as in
Electron. The update log is `~/Library/Logs/Engelbart Swift/update.log`. The default checker (`FeedChecker`) reads
`<downloads>latest-mac.yml`; a Developer ID build would need a real downloader behind `UpdateChecker`.

Banner: `UpdateBannerModel(updates:)` (or with closures) + `UpdateBanner(model:column:)` overlaid on every window; pass the
document column's frame (top-left origin) on the workspace screen so it keeps to the document's corner, clear of the Stage.

## Other public pieces

`detectTools(runner:only:options:)`, `ToolRunner` / `ToolRunning`, `ToolShell` (sanitize / resolve / loginShellArgs),
`ToolInstaller` / `ToolActions`, `FakeTools` (also `authStatusJSON` for onboarding's providers), `ToolLock`,
`BundledGit.find`, `inspectRepository(_:)` / `findGitDir(_:)` (Build's repository checks, D17), `Requirements`,
`parseVersion` / `compareVersions` / `judge`, `normalizeTools` / `ToolRecord`, `PtyProcess`, `makeSignInStarter`,
`makeSignOutRunner`, `markRollback` / `rollback`, `classifyFailure`, `roomFor`.

## Needs from other packages

- **Store**: `ToolsStorage` over config.json → `tools` (read the current value; write only while the file parses; return the
  tools written). `normalizeConfig` should use `normalizeTools` from here for the `tools` key.
- **Terminal**: put `manager.environment()` on top of every session's environment and honour `ENGELBART_GIT_BIN` (first on
  PATH) / `ENGELBART_AGENT_PATH` (last) / `ENGELBART_CLAUDE_BIN` / `ENGELBART_CODEX_BIN` as `launch.cjs` does (Tools has its
  own copy of `loginShellArgs` for the sign-in); `terminal:providers` = `manager.providers(shellPath:)`, refreshed on
  `engelbart:tools`. Report the running session count for the ready dialog.
- **Bart / Build / Connect** (every CLI run): `await manager.ensure(name)` before, `manager.use(name) { … }` around,
  `binaryFor`/`environment()` for the command, `usableAgents()` for the model choice (spec #95).
- **App (wave 2)**: the menu (update item + Set Up Tools…), `requestQuit(update:)` returning whether it quits, calling
  `ToolsSetup.beforeQuit()` during the quit, showing `ToolSetupView` when `SetupGate.request` is set and no other popup is
  up, and the banner overlay. The bundle script must copy dugite's Git to `Contents/Resources/git` for the stand-in Git, and
  a Swift `install.sh` must exist in the download folder before a feed is set.
- **UI**: two colours ToolSetup.jsx uses literally are local here (`#a35200` warn, `#1a7f37` check); EngelbartUI's
  `.hover`, `.waiting()`, `.rise()` and `KeyMonitor` can replace `ViewHelpers.swift`'s private copies once that package
  settles.
