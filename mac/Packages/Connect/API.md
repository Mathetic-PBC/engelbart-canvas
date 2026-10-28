# Connect (module `EngelbartConnect`)

Import your context and the backend of onboarding: the librarian session (`src/main/connect/**`), the onboarding
backends (`src/main/onboarding/**`), the shared `connect-sources` / `import-flow` modules and the `connect-*` /
`import-*` IPC surface. Ledger: `mac/parity/connect.md`. Depends on **Core only** (UI left out: the sign-in windows are
plain AppKit/WebKit, and the UI package did not build when this was written; nothing visual of UI is used).

## Entry point

`@MainActor ConnectEngine(_ host: ConnectEngine.Host)` wires everything (index.cjs 1003–1248). One per app.

`Host` (what the app provides):

| field | what |
|---|---|
| `store: ConnectStore` | the library (Store package adapter, below) |
| `homeDir`, `env` | the person's home, the process environment (the fakes read it) |
| `appSupportDir` | userData: `connect-runs/`, codex homes, trace |
| `tools: ConnectToolManager?` | Tools package: `binaryFor`, `environment`, `ensure`, `use(cli){}`, `check` |
| `toolRecords`, `toolsFakeState` | Tools' records (provider status) and its fake (ENGELBART_TOOLS_FAKE) |
| `terminal: AgentTerminal?` | Terminal package: headless CLI runs for the browser agents |
| `models`, `ready` | Build's model list; providers whose CLI can run now (connectReady) |
| `zotero: ConnectZotero`, `github: ConnectGitHub` | Integrations adapters (closures; `.none` = not connected) |
| `importer: CookieImporter?` | Stage's cookie import (import-cookies.cjs) |
| `parentWindow` | the window sign-in sheets sit over |
| `post` | defaults to `EventHub.shared.post` |

Methods (one per IPC channel, same names): `detect`, `connectSignedIn`, `providersList`, `start`, `answer`, `grant`,
`authorize`, `cancelSignIn`, `signInNote/Pick/Browser/Unlock/AnotherAccount/BrowserCancel/Check/WindowOpen/WindowClose`,
`foldersNeeded/Asked/Ask`, `need`, `importNow`, `stop`, `unblock`, `stopJob`, `setProvider`, `retryMemory`, `minimize`,
`dismiss`, `state`, `list` (resumes first), `notesPermission`, `connectorsList/SignIn/Cancel`, `offer`,
`offerSeen`, `memoryInfo`, `importProviders`, `importProviderRemember`, `importBrowsers`, `importBrowserChoose`,
`importBrowserProfile`, `importKeychain`, `importBrowserAgents(+Answer)`, `importDiscovery`, `importDiscoverProjects`,
`importDiscoverTools`, `importDiscoveryStop/Reset`, `importDiskAccess`, `importOpenDiskAccess`, `importFlow(+Save)`,
`importTraceOpen`, `importObsidianTree`, `attachProject(id:projectId:workspaceId:)`, `suspendAll()` (will-quit),
`afterTestReset(dataRoot:)`. Errors are `ConnectError(kind, message)`; `message` is the text the renderer showed.

Lower-level pieces, usable alone: `Connect` (session engine, `ConnectDeps`), `Discovery`, `Scanner`, `Providers`,
`Browsers`, `BrowserAgents`, `DiskAccess`, `OnboardingPrefs`, `Digest`, `ObsidianTree`, `Connectors` (+ `KeychainCrypt`),
`WebSignIn`, `SignInWindow`, `AgentBrowserWindows`, `TraceWindow`/`Trace`, `AppleNotes`, `Readers`, `Scan`, `Tools`,
`ImportTools`, `ToolBridge`, `ImportFlow`, `ConnectSources`, `Memory`, `Skills`, `FolderAccess`, `Notes`, `Cursor`,
`OwnConnectors`, `SigninProfiles`, `ProviderFailure`, `FakeAgents`.

## Events (EventHub, Electron channel names)

- `engelbart:connect` — a session's snapshot (as `state(id)`), on every change.
- `engelbart:discovery` — onboarding discovery state.
- `engelbart:connectors` — a connector's status.
- `engelbart:project-changed` — `{projectId}` when an import placed rows on a project.
- Trace entries go to `TraceWindow` (its own page, `Resources/trace.html`, verbatim).

## MCP server

`--mcp import <connection.json>` → `ImportMCP.run(arguments:)` (import-mcp.cjs): stdio MCP that relays `tools/call` to
the session's loopback `ToolBridge` with its Bearer token, passing image content through. The app's `main` must route
this argv before starting AppKit (Core's `MCPLaunch`). Not built on Core's `MCPServer`, which returns text only.

## Needs from other packages

- **App**: route `--mcp import`; build `Host`; set `ConnectBrowserStore.identifier` to `StageSession.shared`'s identifier
  (default is Stage's packaged one, `8E1A6C1E-…B001`; dev runs use Stage's `devIdentifier`) and
  `ConnectBrowserStore.userAgent` to the Stage's user agent, before anything opens.
- **Store**: a `ConnectStore` adapter (`dataRoot`, `rows`, `addMarkdownCopy`, `addItem` throwing `LibraryExists`,
  `addFileCopy`, `inspectPdf`, `projectDir`, `workspaceExists`, `saveImage`, `createNote`, `keepInProject`,
  `linkToWorkspace`, `projectNames`); guided-offer / getting-started stay the Store's (ledger 316).
- **Stage**: a `CookieImporter` over `StageSession.shared.cookieImport(…)` / `CookieImport` (copied sign-ins).
- **Tools**: a `ConnectToolManager` and its records / fake state.
- **Terminal**: an `AgentTerminal` over `AgentTerminal.run` (browser agents' headless CLI).
- **Integrations**: `ConnectZotero` / `ConnectGitHub` closures over `ZoteroChannels` / `GithubChannels`; Integrations
  reads `Scan.localRepos` and the trace from here.
- **Core**: an `MCPServer` that can return image content would let `ImportMCP` use it.
