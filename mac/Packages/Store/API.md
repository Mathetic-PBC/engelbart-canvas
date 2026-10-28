# EngelbartStore — API

Ports `src/main/store/**`, `developer.cjs`, `context/pdf-kind.cjs`, the persisted part of `windows.cjs`,
`shared/project-holds.cjs`, `address-key.cjs`, `github.cjs`, `mentions.cjs` (mentionedIds) and the data handlers of
`ipc.cjs`. Ledger: `mac/parity/store.md`. Depends on Core only.

## Data root and files

- Root: `~/.engelbart-swift` (`ENGELBART_ROOT_DIR` overrides; home `ENGELBART_HOME_DIR`). Test mode: `<root>/test`.
- `<dataRoot>/library.sqlite` (library, library_text, sandbox_runs, sandbox_environments, repo_runnables),
  `<project>/notes.sqlite` (notes, post_its). Everything else is the Electron layout unchanged (project.json, meta.json,
  workspace.md, `.project.md`, state.json, config.json + `.defaults/`, annotations/, assets/, `.trash/`, `.archive/`,
  `.migrations/web-pdfs.json`, `.guided-setup.json`, `.connect/offer.json`, instructions.md).

## The facade: `Store` (one per app)

```swift
let store = try Store(homeDir:rootDir:fixturesDir:inspectPdf:pdfTitle:testModeAvailable:hooks:events:webPdfs:)
// testModeAvailable: Developer.hasTestMode(packaged:distDir:)   events: EventHub.shared   webPdfs: ENGELBART_WEB_PDFS != "off"
```
Every method is `async throws` and named as preload.cjs's `engelbartAPI`:

| engelbartAPI | Swift | answers |
|---|---|---|
| config / setTestMode / resetTestData | `config()`, `setTestMode(_:)`, `resetTestData(fresh:)` | config JSON (+ testMode, testModeAvailable, mode, home, testRoot, dataRoot); reset adds `reset: true` (the confirmation dialog is the app's) |
| lastOpen / setLastOpen | `lastOpen()`, `setLastOpen(JSONValue)` | `AppState.LastOpen` |
| views / setView, stage / setStage | `views(pid)`, `setView(pid, wid, JSONValue)`, `stage(pid)`, `setStage(pid, JSONValue)` | cleaned JSON |
| nav / recordEdit / seenAgents | `nav()`, `recordEdit(pid, wid)`, `seenAgents(pid, wid)` | `{recent, agents}` |
| (agents, for Bart/Build) | `agentStarted(id:kind:projectId:workspaceId:doc:)`, `agentFinished(_:)`, `agentStopped(_:)` | |
| (window places, for the App) | `windows()`, `setWindows(JSONValue)`; `WindowPlaces.placement(...)`, `cleanPlace` | |
| folders + create/rename/delete/addTo/removeFrom | `folders()`, `createFolder`, `renameFolder`, `deleteFolder`, `addToFolder`, `removeFromFolder` | `[AppState.Folder]` |
| starred / setStarred | `starred(pid)`, `setStarred(pid, itemId, on)` | ids |
| listProjects / createProject / createProjectWithWelcome | `listProjects()`, `createProject(Projects.NewProject)`, `createProjectWithWelcome(_:)` | `PublicProject`, `Projects.Welcomed` |
| instructions / setInstructions / freeFolder / checkFolder | same names | |
| startProject / welcomeWorkspace / discardLibraryItem | `startProject(Onboarding.StartProject, connect:, onboarding:)`, `welcomeWorkspace(pid, context:, connect:)`, `discardLibraryItem(id)` | |
| gettingStarted / setGettingStarted / guidedOffer(Seen) / connectOffer(Seen) / connectMemory | same names | |
| renameProject / trashProject / restoreProject / trashedProjects / loadProject / setProjectDirectory | same names | `ProjectTree` = `{project, workspaces: [WorkspaceNode], notes: [NoteInfo], trash: [TrashedWorkspace]}` |
| createWorkspace / renameWorkspace / trashWorkspace / restoreWorkspace / setWorkspaceContext | same names | `PublicWorkspace` (context changes answer `(workspace, sandboxError)`) |
| linkToWorkspace / unlinkFromWorkspace / addToProject / removeFromProject / projectItemMentions | same names | |
| saveImage / readImage / createNote / renameNote / readDoc / writeDoc | same names; `DocRef` = `.note(id:)`, `.workspace(workspaceId:)`, `.project` (`DocRef(json:)` parses the renderer's ref) | writeDoc → `Store.Saved {lastEdited, revision}` |
| clearWorkspace / restoreArchive / readArchive | same names | `Archive.Cleared {text, archive, linked, revision}` |
| readTextFile / resolvePageFile | same names | `Documents.TextFile`, `Documents.PageFile?` |
| library / projectsForLibraryItem / libraryForProject / libraryBodies | same names | `[LibraryRow]`, `[Library.Holder]`, `[Library.HeldRow]` (row + origin + workspaces, flattened when encoded), `Library.Bodies` |
| addLibraryItem / addLibraryUrl | same names | `Store.Added {row, sandboxError}`; duplicates throw `StoreError(code: "EXISTS", row:)` |
| addLibraryFile / addLibraryPdf / addLibraryPage | same names | `LibraryRow` |
| lookupLibraryItem / pickLibraryPaths / previewLibraryItem | same names | `Library.Lookup`, `[String]`, `Library.Preview` |
| listFolder / folderFile / folderFiles | same names | `FolderFiles.Level/File/Seen` |
| renameLibraryItem / readLibraryFile | same names | |
| readAnnotations / writeAnnotations / readPageAnnotations / writePageAnnotations | same names | JSON |

`store.context()` gives the `StoreContext` (homeDir, root, dataRoot, mode, libraryDb) for the lower-level enums, which
other packages' adapters may call directly (all synchronous unless noted):
`Projects`, `Workspaces`, `Documents`, `AppState`, `Archive` (incl. `importTask` for post-its, `latestArchive` for
Build's history), `Library` (incl. `addMarkdownCopy`, `addMarkAnswer`, `addWebMark`/`updateWebMark`/`removeWebMark`/
`restoreWebMark`/`readWebMark`, `annotationsFileOf`, `inkFileOf`, `recategorize`, `describeRows` (async),
`headAbout`, `canonicalRemote`, `readCloneRemote`, `resolveAddition`, `sameAs`), `FolderFiles` (`fileInRow` needs no
database), `Onboarding` (`instructionsBlock(dataRoot)` for agents' first message), `Documents.projectPageBlock`,
`Projects.keepInProject` (Connect imports), `Workspaces.addBuild`, `ProjectHolds.holder/letGo`, `Mentions.mentionedIds`,
`AddressKey.key/isPreviewAddress`, `GitHubLinks`, `PdfKind.inspectPdf/pdfTitle/paperSignals`, `WebPdfs.check`,
`PageMeta.describer/repoIdentifier/remoteFileLister/readHtmlMeta`, `Home.readConfig/writeConfig/writeTools`,
`Defaults.carryDefaults` (for other packages' default-carrying files), `ToolsRecord.normalizeTools`,
`Developer.hasTestMode`, `BuildRecords` (read/write `builds/<id>/task.json`), `LibraryDB` (incl. `query` for the
sandbox and runnables tables), `NotesDB` (+ `postIts`).

## Events posted (EventHub, Electron channel names)

`engelbart:project-changed {projectId[, trashed]}`, `engelbart:library-changed {}` (debounced 400 ms after a web pdf is
saved), `doc:changed {projectId, key, text, revision}`, `engelbart:nav {}`, `engelbart:starred {projectId, ids}`,
`engelbart:folders {folders}`, `engelbart:data-root-changed {config, fresh}`. Electron excluded the window that saved;
the Swift store has no windows, so the App/Workspace layer ignores its own saves by `revision`.

## What the app provides (`StoreHooks`, all optional)

`describe`, `identifyRepo`, `listRemoteFiles` (defaults: unauthenticated network; pass GitHub-signed-in ones from
Integrations), `fetchUrl`/`fetchPdf` (pass the Stage's cookie session), `pdfAdded` (sweeper), `startSandbox`,
`releaseSandbox`, `beforeContextChange` (Sandbox/Connect suspend), `stopBuilds`, `removeWorktrees`, `moveWorktree`,
`openBuildIds`, `prepareDefault` (Build), `stopAsk` (Bart), `attachProject` (Connect), `savePage` (Stage's
`webContents.savePage` equivalent: write the tab into a folder), `pickPaths` (default NSOpenPanel; `ENGELBART_PICK_PATHS`).

## Importer

`StoreImporter.importElectronRoot(from: ~/.engelbart, to: ~/.engelbart-swift)` — app-only, never in tests. Clones files,
converts each `.pglite` from a copy with `Resources/pglite-dump.cjs` run by `findRuntime()` (the installed Engelbart.app
with `ELECTRON_RUN_AS_NODE=1`, else `node` + `ENGELBART_NODE_MODULES` / the checkout's node_modules). Refuses a target
that already has a library unless `replace: true`.

## MCP servers

None.

## Needs from other packages

- Stage: `stage-file` (readStageFile) uses `Documents.resolveTypedPath(ctx, project, input)`; `savePage` hook.
- Bart: `created-file`/`created-save` (bart/create.cjs) and `copy-doc` (expandDoc) are Bart's; it adds rows through
  `ctx.libraryDb` / `Library.addMarkdownCopy` and `setSource`.
- Build: worktree hooks above; Build's own records live beside the store's `BuildRecords` (same `task.json`).
- App: wire `StoreHooks`, call `Store(...testModeAvailable: Developer.hasTestMode(...))`, persist window places with
  `setWindows` (800 ms after a change and at quit), run the importer once with the person's consent.
