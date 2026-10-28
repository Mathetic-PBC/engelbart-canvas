# EngelbartWorkspace — the workspace screen

The three-pane window where people work (screens/Workspace.jsx, DocTabs, DocPane, NotePicker, RightPane), and the hosts
that connect the wave-1 views (Editor, Stage, PDF, Terminal, Build) to the rest of the app. Ledger: `mac/parity/workspace.md`.
Depends on Core, UI, Store, Doc, Editor, Bart, Build, Terminal, Tools, Stage, PDF, Sandbox, Integrations — not Sidebar or
PostIts: those come in through the slots below.

## Entry point (what the app's `workspace` slot does)

```swift
var ctx = WorkspaceContext(api: LiveWorkspaceAPI(services), tree: model.tree!, library: model.shownLibrary,
                           entry: WorkspaceEntry(workspaceId: entry.workspaceId, tab: entry.tab.map { DocTab(id: $0.id, title: $0.title) },
                                                 views: entry.views, stage: entry.stage.map { .row($0) } /* or .links([...]) */)) {
    await model.reload()  // App.jsx reload → (tree, library) or nil
}
ctx.onVisit = { model.onVisit($0) }          // every workspace shown
ctx.onClose = { model.goHome() }; ctx.onHome = { model.goHome() }
ctx.onOpenProject = { id, wid in model.openProject(id, prefer: …) }; ctx.onNewProject = { … }
ctx.onError = { model.error = $0 }; ctx.onOpenConnect = { … }; ctx.onOpenSettings = { model.settingsPage = $0 }
ctx.onSidebarGear = { shown in /* hide the window controls' gear while the sidebar shows its own */ }
ctx.controlsRoom = { /* width the top-right controls take from the right edge */ }
ctx.makeSidebar = { host in SidebarAdapter(host) }   // WorkspaceSidebar over the Sidebar package
ctx.makePostIts = { host in PostItsAdapter(host) }   // WorkspacePostIts over the PostIts package
ctx.buildActions = buildService                       // BuildService conforms to BuildActions (the Build panel)
ctx.sandboxes = window's SandboxProgressModel; ctx.touchSandbox = { try await sandboxService.touch($0) }
ctx.adoptTerminal = { session, pid in TerminalSessions.shared.adopt(<snapshot from session JSON>, projectId: pid).id }
ctx.dropTerminal = { TerminalSessions.shared.drop($0) }
ctx.zoteroConnected = { zotero.status().connected }
ctx.stagePageMarks = <library web marks>              // optional
let screen = WorkspaceViewController(ctx)              // NSViewController: the whole screen
window.contentViewController = screen                  // (embed screen.view under the shell's chrome)
```
Then, while it shows:
- `screen.update(tree:library:)` whenever the app reads the tree again (another window's `engelbart:project-changed`).
- `screen.setConnectNotes([ConnectNote])` when Connect's sessions change (connectInbox + dockLine tone).
- `screen.setTour(TourRequest?, paused:)` for the import's "Open library" and the popup gate.
- `screen.model.setActive(project.directory != nil)` happens by itself on `update`; the app draws the DirectoryGate and
  blurs the screen (ledger #8–9).
- Edit ▸ Find / Find Next / Find Previous: `ctx.actions.on(.find) { screen.menuFind("find") }` (returns false to pass on
  to the Stage). ⌘T/⌘W/⌘F/⌘G/⌘1–9/⌘J/Ctrl+1–9/⌘\/Escape are the screen's own key monitor (installed while it is in a
  window), routed by the side clicked last (model/key-side.js).
- `screen.close()` when leaving the project (saves pending edits and views, tears the Stage's pages down).

## The API (`WorkspaceAPI`)
One method per `api.*` call Workspace.jsx makes (documents, state.json, the tree, the library, @bart, Build, Zotero,
sandboxes, Connect, the Agent Viewer's reveal, post-its' trash rect). `LiveWorkspaceAPI(LiveServices)` answers them:
```swift
var services = LiveServices(store: store, bart: bartIPC, build: buildService, zotero: zoteroChannels, window: ctx.id)
services.copyDoc = { pid, refJSON in … }          // copy-doc: Bart's expandDoc + the clipboard (nil: the text alone)
services.createdFile = { pid, askId, rel in try await bartIPC.createdFile(pid:askId:rel:library:).jsonValue }
services.saveCreated = { pid, askId, rel, wid in try await bartIPC.createdSave(…) }
services.startSandbox = { try await sandboxService.start($0) }
services.connectDismiss = { … }; services.takeAgentReveal = { window's AgentRevealHold.take($0) }
services.postItsTrashRect = { … }; services.postItsThrowOut = { pid, id in … }
```
Events it listens to on `ctx.hub` (Electron channel names, `WorkspaceEvents`): doc:changed, engelbart:bart-progress,
paper-ask-done, models-changed, build, build-progress, build-diff, build-run, build-quick(-open), nav, starred, folders,
zotero-finding/-waiting/-downloaded, agent-reveal, open-sandbox-terminal, next-workspace, open-in-browser,
stage:open-link, browser:focused, browser:shortcut. Per-window ones are taken only by the key window.

## Slots the app adapts
- `WorkspaceSidebar` (Rail, RecentPages, GettingStarted, SidebarTour): `view`, `update(WorkspaceSidebarState)` (every
  prop Workspace.jsx passed to <Rail>: width, hidden, project, roots, trash, hereId, recent, visits, notes, entries,
  projectCounts, nodeCounts, rows, activeRowId, flashId, library, railIds, starred, folders, post-its toggle/trash/drag,
  libraryRequest, tourStep, walk, walkShown, walkPapers), `makeRecentPages()` (the clock in the title lead),
  `makeWalkCard()`. The sidebar calls back through `WorkspaceSidebarHost` (implemented by `WorkspaceModel`): select /
  create / rename / delete / restore workspaces, versions, agents (go, dismiss, next, seen all), rows (open, rename,
  remove, link, child, archive), drops, add input / from disk / repo, notes, folders, stars, post-its toggle, projects,
  the walkthrough's steps, the tour, `trashMoved(rect)`.
- `WorkspacePostIts` (ProjectPostIts, PostItBuild, PostItTask): `overlay` (drawn over the screen) and
  `update(WorkspacePostItsState)`; callbacks through `WorkspacePostItsHost` (implemented by the model).

## Pieces usable alone
- `WorkspaceModel` (the component's state and logic; `@MainActor`), `WorkspaceTabs` (docOf, restoredTabs, moveTab,
  closeTab), `NotePick.rows`, `WorkspaceRows` (mentioned, rail, describe), `WorkspaceLayout`, `MadeRef`, `WorkspaceText`,
  `ZoteroChip`, `Walkthrough`, `Nav` (nextPlace, flatWorkspaces, findWorkspaces), `Agents` (entries, repoEntries, kept,
  mark, summarize, rollUp, queue), `Visits`, `MentionRows` (rows, letGoNotes, pickedChanges). The nav/sidebar/rail
  pieces are local copies of what the Sidebar package also ports (a wave-2 package cannot depend on another).
- Hosts: `WorkspaceEditorHost` (DocEditorHost per pane), `BuildCardHost` (a `build> <id>` card), `WorkspaceStageHost`
  (StageHost), `PaperAdapter` (StagePDFViewing + PaperHost over PaperViewController), `WorkspaceTerminalHost`.

## Accessibility identifiers (ENGELBART_DRIVE)
`screen=workspace`, `workspace-header`, `title-lead`, `sidebar-toggle=shown|hidden`, `doc-strip`, `doc-tab=<id>`,
`doc-tab-close=<id>`, `note-plus`, `doc-full=0|1`, `right-mode=stage|terminal`, `rail-edge`, `right-edge`, `page-card`,
`doc-column`, `doc-pane=<i>`, `doc-title`, `pane-close=<i>`, `doc-conflict`, `conflict-keep`, `conflict-take`,
`doc-footer`, `copy-doc`, `build-doc`, `clear-doc`, `restore-doc`, `add-project`, `right-pane`, `note-search` and
`note-pick=<key>` (SwiftUI `.driveID`), `build-card=<id>`, `build-review`, `build-reject`.

## Needs from other packages
- **Editor**: header/above slots inside DocEditorView's scroll (the title row and the walkthrough card scroll with the
  document in Electron; here they sit above the editor's scroll — ledger #65); `discoverLastResult(_:)` on the view
  (the host calls `core.discoverLastResult` then `setAsks` to redraw); the sections a guide's link carries (it sends nil).
- **PDF**: a public current page (StagePDFViewing.currentPage answers 0 now).
- **Stage**: a public `StageAsk` initializer (PaperAdapter asks through the model and lands answers with `landAnswer`).
- **Sandbox**: `SandboxProgressModel.act` public (a repository's Start shows busy/error on its row); public inits on
  `BuildNotificationRow`/`SandboxItem` (tests build them through `reduce`).
- **Store**: `cleanView` sorts positions by key (JSONValue objects are unordered), so "the oldest go first" past 200 is
  lost; keep insertion order.
- **UI**: `DriveRegistry.add` public, so AppKit views could register markers (they rely on accessibilityIdentifier now).
- **Bart**: `Card.cardOfAnswer/questionOf` for naming an empty line from an old card answer (WorkspaceText.answerText uses
  the answer's words).
- **App**: the adapters above; DirectoryGate (app ledger #55).
