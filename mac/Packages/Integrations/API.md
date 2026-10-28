# EngelbartIntegrations — public surface

GitHub, Zotero and Overleaf (backends and panes), and the developer-only Agent Viewer (runs, asks, design, benchmark)
plus the onboarding Agent trace window. Ported from `src/main/{github,zotero,overleaf,agent-map}/**`,
`src/main/onboarding/trace-window.cjs` + `trace.html`, and the renderer pieces listed in `mac/parity/integrations.md`
(the behaviour ledger). Depends on Core and UI only. Every service class is `@MainActor`.

## Shared plumbing (`Common/`)
- `HTTPClient` (`send(HTTPRequest) async throws -> HTTPResponse`): fetch with `redirect: .follow/.manual/.error`,
  `timeout`, `bodyTimeout`, `maxBytes`. `URLSessionHTTPClient` (no cookies, no cache = `credentials: 'omit'`),
  `ClosureHTTPClient` (fakes, adapters). Every service takes one; tests pass fakes.
- `SecretCrypt` (`available/encrypt/decrypt`), `KeychainCrypt.shared` (AES-GCM key in the login Keychain, service
  "Engelbart Swift Safe Storage"): Electron's safeStorage. `NoKeychain` = sign-ins in memory only.
- `LoopbackServer.start { request in response }` (127.0.0.1, free port), `close()`/`closeAll()`.
- `BrowserFlow<T>` (url, expiresAt, `result()`, `cancel()`): a browser sign-in under way.

## GitHub
- `GithubChannels.make(environment:config:dataRoot:crypt:http:openExternal:localRepoDirs:onConnected:onStatus:hub:)`
  → the app's GitHub. Channels: `status()` (github-status), `connect()`, `cancel()`, `disconnect()`, `repos(dirs:)`,
  `open(which, page:)` (github-open: "install" or the waiting sign-in page, default browser). `github` is the
  `GithubConnection` (`token()`, `authHeaders()` for page-meta / the library's private clones).
- `GithubEnvironment` reads ENGELBART_GITHUB_WEB / _API / _BROKER / _CLIENT_ID / _APP_SLUG.
- `GithubRepoAccess(token:http:api:installUrl:)`: `describe(RepoRef)`, `archive(RepoRef)` (the sandbox's one-archive link).
- `GithubOrgs` (remoteOwner, remoteUrls, configOf, macOrgs, missingOrgs, installUrlFor), `GithubModel` (heldRow, rows,
  typedRepo, filter), `GithubRepo`, `GithubStatus` (`.json` = the `engelbart:github` payload).
- Views: `GithubPaneModel(channels:)`; `GithubPaneView(model:library:inRail:busy:onBack:onPick:)` (the + menu's view);
  `GithubReposView(model:held:onToggle:busyId:)` and `RepoRow` (Connect/onboarding picker).

## Zotero
- `ZoteroChannels.make(sources:dataRoot:crypt:http:openExternal:downloadsDir:onConnected:onDownloaded:hub:startClocks:)`
  → sign-in + mirror (<dataRoot>/.zotero) + schedule (first sync 4 s after launch, every 10 min). Channels: `status()`
  (zotero-status, with `sync`), `connect()`, `cancel()`, `disconnect()` (clears the mirror), `sync()` (answers at once),
  `list(rel)` (zotero-list, `ZoteroListing.json`), `open(ref)` (zotero-open, `ZoteroOpenTarget.json`), `waiting()`,
  `attach(ref, file:)`. App calls: `windowFocused()` (browser-window-focus), `willQuit()`.
- `ZoteroSources(environment:)` reads ENGELBART_ZOTERO_API / _BROKER / _STORAGE, ENGELBART_OPENALEX_API,
  ENGELBART_SEMANTIC_SCHOLAR_API, ENGELBART_ARXIV_API, ENGELBART_ARXIV.
- For Bart (context): `ZoteroMirror.pointerLine(root)`, `ZoteroMirror.mentionBlock(base, ref, name:, service: { library.library($0) })`
  → `ZoteroBlock` (lines, file to grant, missing); for the @ menu `ZoteroMirror.listLibraries`.
- Chips: `ZoteroChips.chipAction(target, name:)`, `ZoteroChips.RefSet.finding()/waiting(seed:)` (observable ref sets),
  `ZoteroChips.syncLine(sync)`.

## Overleaf
- `OverleafCopies(http: <the Stage's cookie-carrying client>)`: `ensure(dataRoot, id)`, `refresh`, `info`, `inFlight`.
- `OverleafEditor.projectId(url)`, `projectTitle`, `readScript` (run in the page's main world), `editorInput(json)`,
  `readEditor(evaluate)` (500 ms).
- `OverleafTurn.forTurn(tabs:read:stageKind:stageTab:copies:)` → `gather(dataRoot:)` → (front, background);
  `OverleafStage.stageBlock(name:live:copy:screenshot:)`, `OverleafStage.tabsBlock(background)`.

## Connections (Settings ▸ Connections)
- `ConnectionsModel(github:zotero:)` + `IntegrationConnectionRows(model:)`: the GitHub and Zotero rows (with their ⋯ menus
  and sign-in progress), to sit first in the page's "Accounts" `SettingsGroup`, before Tools' Claude Code / Codex rows.

## Agent Viewer
- `AgentMapChannels(runLog:design:saveFile:reveal:placeNamer:builtInPrompt:benchmark:window:hub:)`: agentMap:open /
  runs / run / asks / ask / reveal / design / export / benchmark* (benchmark changes are posted as
  `engelbart:chat-benchmark`). `AgentRevealHold` per window for agentMap:take-reveal.
- `AgentMapWindow(available:makeContent:)` (1280×860, "Agent Viewer"): `open()`, `close()`, `closeUnlessAvailable()`.
  Content: `AgentMapView(model: AgentMapModel(channels:), benchmark: { AnyView(BenchmarkView(model: BenchmarkModel(channels:))) })`.
- `AgentsButtonView(available:onOpen:)` (hidden: `AgentsButton.shown` is false, as App.jsx has it).
- Pure: `AgentAsks` (group, askOf, revealTarget, promptSource), `RunText` (runText.js whole), `AgentDesign.agentDesign(source, dataRoot:)`,
  `ChatBenchmark(file:source:runLog:)`, `BenchmarkText`, `BenchmarkPage`.
- `TraceWindow(source:)`: `open()` for View ▸ Agent Trace (⌥⌘T); listens to `trace:entry`.

## Events posted (EventHub, Electron channel names)
`engelbart:github` (GithubStatus.json), `engelbart:zotero` (ZoteroStatus.json with sync), `engelbart:zotero-finding`
({key, finding}), `engelbart:zotero-waiting` ({key, waiting}), `engelbart:zotero-downloaded` ({key, path}),
`engelbart:chat-benchmark` ({run, key, new, running}). Listened to: `engelbart:agent-run` (run summaries, posted by the
app from Bart's run log), `trace:entry` (posted by Connect's trace).

## What the app must provide
- `openExternal(url)` (NSWorkspace), the open data root, config.json's `github` {clientId, appSlug}.
- GitHub `onConnected` (restore + focus the focused window, fetch the E2B key), `onStatus` (signed out → forget the E2B key,
  stop sandboxes), `localRepoDirs()` (Connect's localRepos, re-read at most every 5 minutes).
- Zotero `onConnected` (focus window), `onDownloaded(ref, path)` (open in the Stage of the window focused last, activate),
  `windowFocused()` on window focus, `willQuit()`.
- Agent Viewer: an `AgentRunLog` over Bart's run log (and post its changes as `engelbart:agent-run`), an
  `AgentDesignSource` over Bart's/Build's constants, an `AgentPlaceNamer` over the Store, `builtInPrompt(record)`,
  `saveFile(text, name)` (NSSavePanel at ~/Downloads/<name>), `reveal(target)` (bring the project's window forward,
  post `engelbart:agent-reveal`, keep it in that window's `AgentRevealHold`), a `BenchmarkSource`
  (file `~/Library/Application Support/Engelbart Swift/chat-benchmark.json`), and `available()` = a copy with test mode.
- Trace: an `AgentTraceSource` (Connect's trace).

## Needs from other packages
- **Stage**: an `HTTPClient` carrying the Stage's WKWebsiteDataStore cookies (Overleaf's zip); `evaluate(script)` in an
  Overleaf tab's page world (`OverleafEditor.readEditor`); the window's Overleaf tabs ([OverleafTab]).
- **Bart**: the run log (as `AgentRunLog`), the design constants (as `AgentDesignSource`), `systemPrompt`/`ask`/`message`
  for the benchmark, built-in prompts for `promptSource`; consumes `ZoteroMirror.pointerLine/mentionBlock` and
  `OverleafStage` blocks in its context.
- **Doc / Editor**: the editor's reading of a document's threads (`BenchmarkSource.threads`) and of an answer
  (`BenchmarkView(answer:answerHTML:)`; a plain reading stands in until then).
- **Store**: projects, workspaces, notes-made-in and library rows for `BenchmarkSource` and `AgentPlaceNamer`.
- **Connect**: the onboarding trace (`AgentTraceSource`, `trace:entry`) and `localRepos` for MATH-111.
- **Sandbox**: uses `GithubConnection.token()`, `GithubRepoAccess`, and `onStatus` to stop sandboxes when signed out.
- **Tools**: the Claude Code / Codex rows of the same Connections group.
