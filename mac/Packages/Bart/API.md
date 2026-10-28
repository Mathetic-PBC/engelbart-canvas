# EngelbartBart — public surface

Ports `src/main/bart/**`, `src/main/context/**` (not expand-mentions), the @bart handlers of `src/main/ipc.cjs`, the
bart wiring of `src/main/index.cjs`, `src/renderer/model/route.js` (rules) and `src/renderer/model/intelligence.js`.
Depends on **Core only** (see "Needs from other packages"). Behaviour ledger: `mac/parity/bart.md`.

## Entry points

| Type | What it is |
|---|---|
| `Bart` (`Bart.Config`, `Bart.Config.app(userData:readModels:)`) | The service. `ask(store:projectId:_:onProgress:) async throws -> AskAnswer`, `askStream(…) -> (AsyncStream<BartProgress>, Task<AskAnswer, Error>)`, `stop(_ askId) -> Bool`, `stopAll()`, `route(_ RouteRequest) -> RouteResult`, `routeHanded(_:to:)`. `config.fake` (ENGELBART_BART_FAKE=1) runs the fake agents. |
| `AskRequest`, `AskAnswer`, `Turn`, `DocRef`, `HighlightInput`, `StageInput`, `LivePage`, `OverleafTabs`, `Steer`, `Routed`, `BartError` (kind unavailable/failed/stopped) | One ask in and out. |
| `BartProgress` | `.step`, `.activity(label, log:)`, `.lines([String])` (the preview), `.making(line)`, `.trace(story)`; `.payload(askId:)` is Electron's `{ askId, ...progress }`. |
| `BartIPC` | The window-facing handlers with Electron's checks: `askBart` (ask-bart, incl. highlight asks: running-paper-asks, addMarkAnswer, `paper-ask-done`), `runningPaperAsks`, `routeLine`, `routeHanded`, `stopBart`, `nameChat`, `bartModels`, `rememberModelChoice`, `settingsModels`, `saveSettingsModels`, `clearModelChoice` (both announce `engelbart:models-changed`), `createdFile`, `createdSave`. `AskInput.*` are the validators (`docRef`, `stage`, `turns`, `routed`, `highlight`, `placeOf`, `request`, `routeRequest`). |
| `ModelSettings` | `modelsInForce(home:place:only:usable:)` (what every run reads), `read`, `save(patch:)`, `forget(place:)`. |
| `Models`, `ModelDefaults`, `Question`, `InForce`, `Choices`, `CarryDefaults`, `Intelligence` | The models file (`model-effort-inline-question.json`, carried defaults, `.defaults/`, `.backups/`), flags, ladders, `model-choices.json`, Settings › Intelligence logic. `ModelsList.json` is the shape the renderer read. |
| `Reply`, `Clip`, `Card`, `Strip`, `Highlights`, `PassageLink`, `PassageText`, `Cite`, `Context`, `SourceText`, `Shots`, `AddressKey`, `HTMLText` | Pure pieces (answer lines, cards, stripping, highlight blocks, citations, the context an ask is given). |
| `Router`, `Route`, `RouteRules` | Bart, the router (`Router.live`, `Router.fake`), its decisions, and the editor's rules (`routeByRule`, `questionLine`, `fallbackAgent`). |
| `ChatNamer`, `NameChat`, `QuickRun`, `Making` | Conversation titles (name-chat) and @create's "what it is making" line. |
| `Create`, `CreatedPreview` | @create's draft folders, kept files (`<project>/.created/<askId>/`), `madeMention`, readCreated/saveCreated, a page's picture (WKWebView). |
| `Papers`, `PapersMCP` | @discover's paper tools over OpenAlex, and the `--mcp papers` server: the app's entry point calls `PapersMCP.run()` when launched with `--mcp papers`. |
| `RunLog`, `ToolCalls`, `Trace` | The Agent Viewer's log (`agent-runs.jsonl`; its `onChange` gets each run summary: post it as `engelbart:agent-run`), tool-call extraction, @discover's trace. |
| `Summarizer`, `SummarizerSettings`, `Sweeper`, `Catalog`, `PdfText`, `PdfKind` | The context layer: summaries (`Summarizer.cli`, `Summarizer.fake` for ENGELBART_SUMMARY_FAKE=1), the minute sweep (`Sweeper(getStore:summarize:options:)`, `.start()`, `.sweepSoon()` on wake / pdf added, `.stop()` before quit; `Sweeper.Options.from(environment:)` reads ENGELBART_SUMMARIES / _QUIET_MS / _INTERVAL_MS), `catalog.json`, `status.json`, pdf text/abstract/paper-ness/title (PDFKit). |
| `AgentShell`, `BartTools`, `AgentRunner` | How the CLIs are launched (login shell, scrubbed env, no API keys, `$ENGELBART_<CLI>_BIN`); `AgentRunner` stubs the process in tests. |

## What the app must provide

- `BartStore` (Store + Doc + other packages): data root, home, `libraryDb: BartLibraryDB`, `findWorkspace`, `findProject`,
  `projects()`, `flattenWorkspaces`, `notesMadeIn`, `recountWorkspaces`, `expandDoc` (Doc's expand-mentions, returning the
  `seen` set incl. `file:<folderId>:<rel>` and `zfile:<path>` keys), `imagePaths`, `instructionsBlock` (onboarding),
  `memoryBlock` (Connect), `zoteroPointerLine` (Integrations), `gettingStarted`, ink reads (`readAnnotations`,
  `readPageAnnotations`, `annotationsFile`, `lookupItem`, `readWebMark`, `inkFile(of:)`), `fileInRow`, `addMarkAnswer`, and
  the nav bookkeeping `agentStarted/Finished/Stopped`.
- `BartLibraryDB`: list/get, library_text (`texts(for:max:)`, `textStamps`, `setText`), `setSummary`, `setCharCount`,
  `papersWithFiles`, `uncountedNotes`, `summaryCandidates(before:minChars:)`.
- `CreatedLibrary` (Store + Build's keepCopy/linkMade) for @create's Save; `BartTools` (Tools' manager) and
  `BartToolStatus` (usableAgents + per-tool record) for the tool lock and Settings' CLI notes.
- `LivePage` (Stage's tab: selection + screenshot) and `OverleafTabs` (Integrations' forTurn) per ask, when present.
- The `readModels` closure: `{ ModelSettings.modelsInForce(home: root, place: "bart", only: config.providers, usable: tools.usableAgents()) }`.
- Thread files under Application Support: `Bart.Config.app(userData:)` puts them where index.cjs did (bart-threads.json, brainstorm-threads.json, discover-threads.json, bart-runs/, codex-home-*).

## Events posted (EventHub names = Electron channels)

`engelbart:bart-progress` (`BartIPC.askBart`, `Bart.askStream(hub:)`), `engelbart:paper-ask-done`, `engelbart:models-changed`.
`engelbart:agent-run` is the app's to post from `RunLog(onChange:)`; `engelbart:agent-reveal` and the Benchmark's
`engelbart:chat-benchmark` belong to the Agent Viewer (Integrations).

## MCP servers

`--mcp papers` → `PapersMCP.run(environment:)` (OPENALEX_API_KEY passed through when set).

## Needs from other packages

- **Doc**: `expandDoc` / `projectSource` / `imagePaths` (expand-mentions) behind `BartStore`; `routeInputs` and
  `buildTextOf` (renderer route.js) read Doc's thread model, so the editor computes `RouteRequest`. `shared/passage-*`
  and `address-key` are restated in Bart (Passage.swift, AddressKey): Doc's/Store's ports must agree with them.
- **Core**: `MCPServer.Tool` has no `annotations`; Bart answers `tools/list` itself (PapersMCP.handle). An `annotations`
  field in Core would let it drop that.
- **Store**: carryDefaults is restated in Bart over ordered JSON for the models file (Store keeps config.json's).
- **Integrations**: the Chat Benchmark (agent-map/benchmark.cjs askChat) runs `Bart` with `Prompts.bart`; the Agent Viewer
  reads `RunLog.list()/get()`.
