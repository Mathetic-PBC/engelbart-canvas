# Engelbart (the app) — how wave 2 plugs in

`mac/Engelbart` is the app package: library `EngelbartApp` (everything, testable) and executable `Engelbart`
(`main.swift` → `EngelbartMain.run()`). Wave 1 depends only on Core and UI; wave 2 adds the feature packages to
`Package.swift` and fills the slots below, preferably from one new file `Sources/EngelbartApp/Wiring.swift` with an
`EngelbartWiring.install()` called first thing in `AppDelegate.applicationWillFinishLaunching` (before `menu.rebuild()`).
Behaviours and status: `mac/parity/app.md`.

## Start-up
1. `EngelbartMain.run()`: `--mcp <name> [args…]` anywhere in argv → `MCPServers.registerAll()` then
   `MCPRegistry.serve(name, args:)` and exit (0 served, 2 unknown/failed). No AppKit is touched on that path.
2. Else: `AppPaths()` (data root `~/.engelbart-swift` or `ENGELBART_ROOT_DIR`; home `ENGELBART_HOME_DIR`; userData
   `~/Library/Application Support/Engelbart Swift` or `ENGELBART_USER_DATA_DIR`). A data root inside Electron's
   `~/.engelbart` is refused (exit 1).
3. `SingleInstance(userData:)`: a second launch tells the first to show a window and exits 0.
4. NSApplication with `AppDelegate`: `Fonts.register()`, `WindowManager`, `MainMenu.rebuild()`, then `manager.restore()`
   (saved windows, else one window), then `SelfTest` if asked.

## The MCP registry (`MCPRegistry.swift`)
```swift
MCPRegistry.register("papers") { args in try Papers.mcpServer(arguments: args) }   // → EngelbartCore.MCPServer
```
Add the calls to `MCPServers.registerAll()`. The CLIs are told to launch `MCPLaunch.claudeConfigEntry("papers", args)`
(Core), i.e. this executable with `--mcp papers …`. `ping` is registered as a smoke server.

## Screen slots (`ScreenSlots.shared`, `ScreenSlots.swift`)
Each window has a `RootModel` (App.jsx's state and logic) and a `WindowContext` (windows.cjs's). A slot gets both.
| Slot | Electron | Plug in |
|---|---|---|
| `home` | screens/Home.jsx | `model.projects/trashed/shownLibrary/error`; `model.openProject(id, prefer:)`, `newProject()`, `deleteProject`, `restoreProject`, `renameProject` |
| `onboarding` | screens/Onboarding.jsx | `model.onboardMode`, `model.run` (rebuild on change), `model.backTitle`; finish `model.onboarded(…)`, back `model.leaveOnboarding()`, tools `model.onboardingTools(install:)` |
| `workspace` | screens/Workspace.jsx | `model.tree/entry/shownLibrary`; `model.onVisit(workspaceId)` on every workspace shown; `model.goHome()`; open Settings with `model.settingsPage = "connections"`; read `model.tree?.project.directory` (nil: the window sits blurred and inert behind the DirectoryGate) |
| `updateBanner` | ui/UpdateBanner.jsx | Tools |
| `toolSetup` | ui/ToolSetup.jsx | shown when `model.setup` is set and the PopupGate allows; close with `model.setup = nil` |
| `sandboxProgress` | ui/SandboxProgress.jsx | wraps the window's whole root |
| `notificationBell` | ui/SandboxNotifications.jsx | first in the top-right controls (not on onboarding) |
| `connectChip` | ui/ConnectDock.jsx | after the gear |
| `importFlow` | import/ImportFlow.jsx | inside the 1000×800 modal while `model.importModal` is set; close with `model.importModal = nil` |
| `guidedOffer` | ui/GuidedSetup.jsx | shown when the gate allows; `model.acceptOffer()` / `model.dismissOffer()` |
| `popups` | NeedPopup, ImportStatus, ProviderPopup, ConnectPopup | each decides from `PopupGate.compute(…)` with its own sessions |
| `settingsConnections` | workspace/Connections.jsx | a Settings page body (`SettingsGroup`/`SettingsRow` from EngelbartUI) |
| `modelSettings` | bart/settings.cjs | `ModelSettingsSource` for the Models page |
| `backend` | api.* (ipc.cjs) | `() -> ShellBackend`, the Store adapter (`ShellBackend.swift`, one method per api call). The backend never asks for confirmation: the shell confirms resets (`Dialogs.confirmReset`) |
| `windowPlaces` | store/projects.cjs readWindows/writeWindows | `WindowPlacesStore` (state.json `windows`: `[SavedWindow]`, bounds y-down) |
| `toolsGate` | model/tools.js | `ToolsGate` (launchRows, installedSignedOut, busy, order) on the tool snapshot JSON |
| `updateMenuItem` | updates.cjs menuItem | `() -> UpdateMenuItem?` (label + action, nil action = disabled); call `menu.rebuild()` when it changes |
| `openAgentTrace` | trace-window.cjs | View ▸ Agent Trace |
| `lastWindowClosed` | index.cjs:590-594 | close the Agent map window |

Announcements arrive on `EventHub.shared` under the Electron channel names (`ShellEvents`: `engelbart:library-changed`,
`engelbart:project-changed {projectId, trashed}`, `engelbart:data-root-changed`, `engelbart:tools`,
`engelbart:agent-reveal`) — post them from the Store/Tools adapters; every window's root listens. The manager posts
`window:focus {window, focused}`, `window:reset {window}`, `window:closed {window}` (window = `WindowContext.id`).

## The window manager (`WindowManager`, `WindowRegistry`)
- `open(place:bounds:from:)`, `newWindow(from:)`, `showWindow()`, `bringForward()` (sign-ins, downloads), `reload(ctx)`,
  `reveal(target)` / `takeReveal(ctx, projectId:)` (Agent Viewer), `dialogWindow()`, `saveWindows(now:)`, `restore()`.
- `registry`: `focused()`, `showing(projectId)`, `all()`, `target(ctx)`, `places()`, terminal ownership `own/ownerOf/
  forget/attached/bootstrap(ctx, sessions:)` + `onOwnerChange` (Terminal), `routeTarget(projectId:)` (Build run output,
  sandbox terminals), `dialogContext()`. Wrap work a window asked for in `WindowRegistry.$asking.withValue(ctx) { … }` so
  dialogs and routing go to that window.
- `WindowContext`: `id`, `place`, `stageListeners` (Stage), `closedHidden`, `agentReveal`, `terminalAttached`, `actions`,
  `parts[String: AnyObject]` for a package's per-window objects (Stage tabs, post-it views), `root` (its RootModel).
- Windows: `EngelbartWindow` (1440×900, min 900×560, hidden inset title bar, traffic lights {18,20}, white), content
  `WindowContentView` (root + resize strips kept on top of any native view a screen adds). Header rows use
  `.titleBar()` / `.titleLead()` from EngelbartUI.

## Menus and actions (`MainMenu.swift`, `ActionRouter.swift`)
The menu is Electron's (app, File, Edit, View, Window, Dock). Items that act on a window send a `WindowAction` to the
focused window: `find`, `find-next`, `find-previous`, `tools-open`, `reload`, `toggle-dev-tools`. A screen registers:
```swift
let token = ctx.actions.on(.find) { stage.showFind(); return true }   // newest first; return false to pass it on
ctx.actions.off(token)
```
Edit's Undo/Redo/Cut/Copy/Paste/Select All go down the responder chain (`undo:` `redo:` `cut:` `copy:` `paste:`
`selectAll:`). Close Window is ⇧⌘W: ⌘W is left for the tabs.

## Quitting (`Quit.swift`)
Register in Electron's order at start-up: `appDelegate.quit.register(participant)` where `QuitParticipant` has `name`,
`runningSessions()` (the terminal manager's count: the quit asks when > 0), `shutdown() async throws`, `failureIsFatal`
(false for the sandboxes). `quit.request(update:relaunch:)` is requestQuit (an updater's Restart to Update passes
`update: true`).

## Dialogs (`Dialogs.swift`)
`pickDirectory(current:home:window:)`, `pickPaths(pdfOnly:window:)`, `confirmReset(fresh:testRootShown:window:)`,
`openExternal(_:)` (http/https only), `reveal(_:)`, `writeClipboard`, `writeImage`, `errorBox`. They honour
`ENGELBART_PICK_DIRECTORY`, `ENGELBART_PICK_PATHS`, `ENGELBART_CONFIRM_ALL`.

## Test mode
`Developer.hasTestMode`: a `swift run` copy has it; a bundle only with `build.json {"developer": true}`
(`ENGELBART_DEVELOPER=1 mac/scripts/bundle.sh`); `ENGELBART_TEST_MODE=off` removes it. `ShellConfig.testModeAvailable`
carries it to the window (the Test pill, Settings ▸ Test data).

## Self-test hooks (cloud runs; `SelfTest.swift`, `mac/scripts/selftest.sh`)
Testing happens in the cloud (GitHub Actions macOS runner, `mac/scripts/cloud-test.sh`), never on Hudson's Mac.
- `ENGELBART_SNAPSHOT=<dir>`: launch, wait until every window's root has left the boot phase (+600 ms for entrances and
  layout; `ENGELBART_SELFTEST_TIMEOUT` caps the wait, default 20 s), write `<dir>/window-<n>.png` per window (the app's own
  drawing via `cacheDisplay` of the window's frame view: title bar and traffic lights included; visible floating panels as
  `window-<n>-panel-<k>.png`) and `<dir>/windows.json` (`index file title frame phase error visible key fullScreen place
  childWindows`), then quit with status 0 (1 if the windows never drew). No Screen Recording permission needed.
- `ENGELBART_DRIVE=<script.json>`: the Swift drive.mjs. Steps, run after the windows drew:
  `{"wait":ms}` `{"waitFor":"id","timeout":ms}` `{"click":"id"}` (scrolled into sight, then a click queued at its
  centre; an AppKit-only element falls back to an accessibility press) `{"click":{"x":,"y":}}` (window content point,
  y down) `{"type":"text"}` (into the first responder) `{"key":"cmd+shift+n"|"Escape"|"Enter"…}` (queued, so menu key
  equivalents and key monitors see it) `{"menu":"File/New Window"}` `{"action":"find"}` `{"expect":"id"}`
  `{"expectMissing":"id"}` `{"expectTitle":"…"}` `{"window":n}` `{"snapshot":"name"}`. Exit 0 when every step passed,
  else 1 at the first failure: stderr, `drive-report.json` (each step, the error, the identifiers on screen) and
  `failure-<n>.png`. Views are found by their `.driveID(_:)` (EngelbartUI) in the window and its floating panels.
  Mouse and key events are posted to the queue, not sent: a control's mouse-down tracks the mouse-up from the queue (a
  sent click hung the run).
- A script may carry `"env": { "ENGELBART_SHELL_DEMO": "…", "ENGELBART_SHELL_SETTINGS": "…" }` (the runner sets only
  ENGELBART_DRIVE; only these two keys are read).
- Identifiers so far: `window-controls`, `settings-gear`, `test-toggle`, `screen=home|create|workspace|kit` (placeholders),
  `directory-gate`, `directory-gate-choose`, `directory-gate-home`, `error-toast`, `kit-*`, and EngelbartUI's Settings ids.
- Wave 1 demo data (until the Store is wired): `ENGELBART_SHELL_DEMO=home|workspace|gate|kit` (`DemoBackend.swift`;
  `kit` = every UI-kit primitive on one screen, KitGallery.swift), `ENGELBART_SHELL_SETTINGS=<page>` opens Settings.
- Scripts (all pass on the runner): `mac/scripts/drive/shell.json` (controls, Settings search and Escape order, New
  Window), `kit.json` (the gallery, InlineField commit, a floating panel opened and closed by Escape, Settings rows),
  `gate.json` (DirectoryGate → All projects). Run: `mac/scripts/cloud-test.sh app --filter mac/scripts/drive/kit.json`.
  The app package's XCTests: `mac/scripts/cloud-test.sh Engelbart` (ci-run.sh maps it to mac/Engelbart).

## Bundle (`mac/scripts/bundle.sh`)
`mac/build/Engelbart.app`: id `com.mathetic.engelbart.swift`, name Engelbart, version 0.1.25, icon from `build/icon.icns`,
every SwiftPM `*.bundle` in `Contents/Resources` (use `ResourceBundle.named(…)`, see UI/API.md), `build.json`, ad-hoc
signature verified with `codesign --verify --strict`. `ENGELBART_CONFIG=debug` for a quick build.

## Needs from other packages
- Store: a `ShellBackend` (one method per `api.*` call the root uses) and a `WindowPlacesStore`; post the `ShellEvents`.
- Tools: `ToolsGate`, `updateBanner`, `toolSetup`, `updateMenuItem`, Connections' tool rows.
- Bart: `ModelSettingsSource` (with `providerOrder`/`modelOrder`, see UI/API.md); its MCP server(s) registered.
- Terminal: a `QuitParticipant` with `runningSessions()`; use `registry.own/bootstrap/onOwnerChange`.
- Stage: `find`/`find-next`/`find-previous` and `toggle-dev-tools` handlers; `stageListeners`; per-window tabs in `parts`.
- Connect / ImportUI: `importFlow`, `guidedOffer`, `popups`, `connectChip`; Sandbox: `sandboxProgress`, `notificationBell`.
- Integrations: `settingsConnections`, the Agent map (`lastWindowClosed`, `manager.reveal`), `openAgentTrace`.
- Every package with resources: look them up with `ResourceBundle.named("<Package>_<Module>", fallback: Bundle.module)`.
