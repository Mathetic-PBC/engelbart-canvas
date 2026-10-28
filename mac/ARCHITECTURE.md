# Engelbart for Mac, in Swift — architecture and working rules

Branch `swift`. The Electron app in `src/` stays exactly as it is: it is the **reference implementation**. The Swift app
in `mac/` rebuilds it natively with the same behaviour, including every tweak Hudson asked for along the way. Where the
two differ, the Electron code at the commit this branch started from (9413a56, branch `testing`, shipped as 0.1.25) is
right unless a line in a parity ledger says otherwise and why.

## 1. Where the behaviour is written down (read these for your area before writing code)

1. The JS source itself (`src/main/**`, `src/renderer/**`, `src/shared/**`, `src/preload.cjs`). Comments in it record
   decisions; keep their intent.
2. `git log --format='%h %ad %s%n%b' --date=short -- <the files you port>`: commit messages describe each tweak.
3. `docs/superpowers/specs/*.md` (decision table in `2026-09-16-engelbart-desktop-design.md` §2, numbers 1–101+;
   `2026-09-25-build-workflow-design.md` B1–B29; `2026-09-23-tools-and-defaults-design.md` D1–D17; others).
4. `design/**/TWEAKS.md`, `design/**/*-TWEAKS.md`, `design/goal-canvas/USER-TWEAKS.md`: Hudson's design corrections.
5. Claude Code memory notes: `~/.claude/projects/-Users-hudsonmitchell-pullman-engelbart-canvas/memory/*.md`
   (start with `MEMORY.md`, an index). They record corrections Hudson made in person ("never horizontal divider lines",
   "no helper/hint subtext", etc.). They are point-in-time: the code wins when they disagree.
6. `test/*.test.cjs`: the unit tests are executable specifications. Port the ones for your area to XCTest.

## 2. Layout

```
mac/
  ARCHITECTURE.md          this file
  parity/<area>.md         one behaviour ledger per area (format in §6)
  Packages/<Name>/         one Swift package per area; module EngelbartX; tests in Tests/EngelbartXTests
  Engelbart/               the app package: executable target `Engelbart` that wires every package together
  scripts/bundle.sh        builds Engelbart.app (Info.plist, icon, resources)
```

Packages (each is its own SwiftPM package so a half-finished edit in one cannot break another's build; dependencies are
local `path:` packages):

| Package | Module | Ports (Electron) | Depends on |
|---|---|---|---|
| Core | EngelbartCore | shared helpers: JSON, processes, login-shell PATH, event hub, atomic files | — |
| UI | EngelbartUI | `renderer/tokens`, `styles.css`, `ui/*` primitives (buttons, popovers/`usePlaced`, icons, fonts) | Core |
| Store | EngelbartStore | `main/store/**`, data parts of `ipc.cjs`, `windows.cjs` state, `shared/project-holds`, `address-key` | Core |
| Doc | EngelbartDoc | `renderer/model/doc.js` + the pure editor models, `shared/mentions`, `mark-answers`, `passage-*`, `selection-card`, `context/expand-mentions` | Core |
| Editor | EngelbartEditor | `workspace/DocEditor.jsx`, `MentionMenu`, `BartPicker`, `caret.js`, `DocFind`, answer/build cards | Core, Doc, UI |
| Bart | EngelbartBart | `main/bart/**`, `main/context/**` | Core, Doc |
| Build | EngelbartBuild | `main/build/**`, `shared/build-history`, the Build panels (BuildPanel, BuildReview, RunTimeline…) | Core, Doc, UI |
| Terminal | EngelbartTerminal | `main/terminal/**`, `shell-rc`, `shell-history`, `renderer/terminal/**` (SwiftTerm) | Core, UI |
| Tools | EngelbartTools | `main/tools/**`, `updates.cjs`, `ui/ToolSetup`, `ui/UpdateBanner`, `model/tools.js` | Core, UI |
| Stage | EngelbartStage | `main/browser/**`, `main/stage/**`, `stage-links`, `workspace/Stage.jsx`, `RightPane`, `model/stage.js`, `address.js`, `kind.js` (WKWebView) | Core, UI, Doc |
| PDF | EngelbartPDF | `renderer/pdf/**`, `model/paper-*`, annotations (PDFKit) | Core, UI |
| Sandbox | EngelbartSandbox | `main/sandbox/**`, `shared/sandbox-sleep`, `shared/environment`, sandbox UI | Core, UI |
| Connect | EngelbartConnect | `main/connect/**`, `main/onboarding/**` (backend), `shared/connect-sources`, `shared/import-flow` (+ its sign-in windows) | Core, UI |
| Integrations | EngelbartIntegrations | `main/zotero/**`, `main/github/**`, `main/overleaf/**`, `main/agent-map/**` (backend), GitHub/Zotero panes, Agent Map + Benchmark screens | Core, UI |
| Sidebar (wave 2) | EngelbartSidebar | `workspace/Rail.jsx`, `SidebarPanels.jsx`, `WorkspacePeek`, `GettingStarted`, `SidebarTour`, `model/sidebar.js`, `rail.js`, `nav.js`, `add-or-find.js` | Core, UI, Store, Doc, Integrations |
| Workspace (wave 2) | EngelbartWorkspace | `screens/Workspace.jsx`, `DocTabs`, `DocPane`, `NotePicker`, `model/notepick.js`; implements the Editor/Stage/Terminal/Paper hosts | most packages (not Sidebar: injected) |
| Screens (wave 2) | EngelbartScreens | `screens/Home.jsx`, `Onboarding.jsx`, `ui/GuidedSetup.jsx`, `model/onboarding.js` | Core, UI, Store, Doc, Integrations |
| PostIts (wave 2) | EngelbartPostIts | `renderer/post-its/**`, `main/post-its/**`, `post-it-preload.cjs` | Core, UI, Store, Doc, Editor, Build |
| ImportUI (wave 2) | EngelbartImportUI | `renderer/import/**`, `screens/ConnectLibrary.jsx`, `ui/ConnectDock.jsx`, `model/connect.js` | Core, UI, Store, Connect |

**Dependency rule.** A wave-1 package never depends on Store or on another wave-1 feature package. When it needs data
that the Store owns (library rows, a project's directory, config values), it declares a small protocol or a struct of
closures in its own module (e.g. `public protocol BartLibrary { func rows(ids: [String]) -> [BartRow] }`) and the app
package adapts the Store to it. This keeps every package buildable and testable on its own.

Every package documents its public surface in `mac/Packages/<Name>/API.md` (types, entry points, the protocol it needs
from the app, events it posts) so the wave-2 screens and the app can wire it without reading the implementation.

## 3. Data

- **Data root:** `~/.engelbart-swift/` (override: `ENGELBART_ROOT_DIR`; home override `ENGELBART_HOME_DIR` as in
  Electron). Same layout as Electron's `~/.engelbart/` (config.json, state.json, model files, `<Project>/…`,
  `test/` for test mode, `.backups`, `.defaults`, `assets`, `annotations`, …) so a root can be read by either layout
  rule. App-private files Electron keeps in `userData` go to `~/Library/Application Support/Engelbart Swift/`.
- **Never write to `~/.engelbart/`** (Hudson's real planning data used by the Electron app every day). The only code
  that may read it is the Store's one-time importer, which copies it first (APFS `clonefile`/`cp -c`) and reads the
  copy. Tests use temporary directories only.
- **Database:** SQLite (system `libsqlite3`, `import SQLite3`) replaces PGlite. Same tables and columns as
  `src/main/store/db.cjs` (`library`, `library_text`, `sandbox_runs`, `sandbox_environments`, `repo_runnables` in
  `<root>/library.sqlite`; `notes`, `post_its` in `<project>/notes.sqlite`). Type mapping: uuid → TEXT (lowercase),
  timestamptz → TEXT ISO-8601 with milliseconds and `Z`, `text[]` → TEXT holding a JSON array, jsonb → TEXT JSON,
  boolean → INTEGER 0/1. Check constraints and partial unique indexes are kept (SQLite supports both).
- **Importer:** PGlite is Postgres-in-WASM and cannot be read natively. The importer runs a short Node script against a
  *copy* of `library.pglite` / `notes.pglite` with `@electric-sql/pglite`: first choice the installed Electron app's own
  runtime (`ELECTRON_RUN_AS_NODE=1 /Applications/Engelbart.app/Contents/MacOS/Engelbart script.cjs`, pglite from its
  `app.asar.unpacked`), fallback `node` + this repo's `node_modules`. It dumps JSON; Swift inserts it into SQLite.
- Secrets Electron kept with `safeStorage` (GitHub token, Zotero key, sandbox environments) go to the macOS Keychain.

## 4. Models and agents

Exactly as Electron: models are reached only through the installed `claude` and `codex` CLIs on the person's
subscriptions, never an API key, with the same flags, private `CODEX_HOME`s, session resume, effort ladders and
streaming JSON parsing. GUI apps launched from Finder lack the shell's PATH: use `EngelbartCore.ShellEnvironment`.
Keep the Electron test hooks with the same names (`ENGELBART_BART_FAKE`, `ENGELBART_TOOLS_FAKE`, `ENGELBART_TOOLS=off`,
`ENGELBART_BUILD_FAKE_MS`, `ENGELBART_PICK_PATHS`, `ENGELBART_HEADLESS`, `ENGELBART_WEB_PDFS`, …).

## 5. UI

AppKit + SwiftUI on macOS 14+. Native pieces: the document editor is an `NSTextView` (TextKit 2 or 1, the Editor
package's choice), the terminal is SwiftTerm, the browser is `WKWebView`, papers are PDFKit with Engelbart's own ink
layer. Values (sizes, colors, radii, fonts, spacing, timings) are the CSS's, 1 CSS px = 1 pt. Colors and fonts come
only from `EngelbartUI` tokens. Hudson's standing UI rules (memory notes): no horizontal divider lines; no explanatory
hint/subtext ("looks like AI"); selected state is black 1.5px; no drop shadows except where the CSS has one.

## 6. Parity ledgers (`mac/parity/<area>.md`)

Before writing Swift, list every behaviour of your area as a numbered row, from the sources in §1. Then keep the
ledger current as you work. Format:

```
| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 12 | Enter on an empty nested todo outdents before leaving the list | DocEditor.jsx:1234, spec #24 | Editor/Keys.swift | done |
```

Status is one of `done` (implemented and checked by a passing cloud test run, or by the app's cloud self-test), `partial: <what is missing>`, `todo`,
`n/a: <why>` (Electron-only mechanics such as asar or IPC validation). The ledger is how Hudson and the next agent know
what "everything" means; an unlisted behaviour is a lost behaviour. Commit messages and memory-note corrections count.

## 7. Working rules for every agent

- Write only inside the directories you own (your package(s), your ledger(s)). Never edit `src/`, `test/`, `scripts/`,
  root files, another package, or this file. If you need something from another package, record it under
  "Needs from other packages" in your `API.md`.
- Do not commit, push, switch branches, or touch other worktrees. The orchestrator commits.
- Never read or write `~/.engelbart/` (except the Store importer, as described), never launch or drive the Electron
  Engelbart app, never kill a process you did not start, never upload releases.
- **Testing happens in the cloud, never on this Mac** (Hudson, 2026-10-28). Locally you may only compile:
  `cd mac/Packages/<Name> && swift build` and `swift build --build-tests`. Never run `swift test`, a test binary, the
  app, a PTY session or a real CLI here, and never take local screenshots. Run tests with
  `mac/scripts/cloud-test.sh <Package> [--filter <XCTest filter>]` (Bash timeout 600000): it snapshots `mac/` through a
  temporary git index (nothing in the worktree changes), runs on a GitHub Actions macOS 26 runner
  (`.github/workflows/swift-cloud-test.yml`, runner side `mac/scripts/ci-run.sh`) and prints
  `CI RESULT <Package>: PASS|BUILD FAILED|TESTS FAILED` with the failures. `cloud-test.sh app` bundles and launches the
  app there with `ENGELBART_SNAPSHOT` and returns window PNGs. Exit 3 = still running (`--result <run id>`). Runs take
  3–6 min and share ~5 concurrent macOS jobs: run at milestones. Keep the package compiling; work in small steps.
  Swift 5 language mode (tools-version 5.10), macOS 14 minimum.
- Tests: XCTest, temporary directories, no network (fakes for CLIs and HTTP, as the Electron tests do).
- Match the Electron code's names where they help someone read both side by side (file `ask.cjs` → `Ask.swift`).
- Comment like the Electron code does: say why, record decisions, cite the source file the behaviour came from.
