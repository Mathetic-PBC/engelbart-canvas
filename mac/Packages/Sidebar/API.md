# EngelbartSidebar — API

The workspace's left pane (Electron `workspace/Rail.jsx`, `SidebarPanels.jsx`, `SidebarTour.jsx`, `GettingStarted.jsx`,
`RecentPages.jsx`, `useAddRun.js`, `useBodies.js`) and the pure models it reads (`model/sidebar.js` whole, the sidebar's
part of `model/rail.js`, `model/nav.js`, `model/add-or-find.js`, `model/getting-started.js`). Ledger:
`mac/parity/sidebar.md`. Depends on Core, UI, Store, Doc, Integrations. macOS 14, AppKit (the sidebar itself, drawn in
`draw(_:)` so bitmaps match the screen) + SwiftUI (the panels, in UI's `FloatingPanel`).

## Entry point (the Workspace screen calls this)

```swift
let sidebar = SidebarViewController(context: SidebarContext(
    services: .store(store),            // lookups, previews, bodies, listProjects, the file picker, folders (Store)
    actions: actions,                   // SidebarActions: the Workspace's handlers (below)
    storage: UserDefaultsStorage(suite: "Engelbart Swift"),  // localStorage's keys (engelbart.sidebar.open, …)
    hub: .shared,                       // follows engelbart:folders
    github: GithubPaneModel(channels: githubChannels)),      // the + menu's GitHub view (nil: not offered)
  input: input)                         // SidebarInput (below)
// place sidebar.view as the left column, `input.width` wide, full height; then on every change of the Workspace's state:
sidebar.update(input)
sidebar.openLibrary(chip: "papers")     // the Welcome walkthrough's step 1 (Rail.jsx libraryRequest)
sidebar.trashView                       // the foot: PostIts' drop target for a sticky thrown away (Rail.jsx trashRef)
sidebar.tourHoles(step: 0...2)          // the tour's spotlight rects (window content, y down)
sidebar.close()                         // the panel beside it
sidebar.openPanel                       // "agents" | "library" | "add" | "projects" | "siblings" | "sources" | "project" | nil
```

### `SidebarInput` (Rail.jsx's data props; `Equatable`)
`width` (220–520, the Workspace clamps), `hidden` (⌘\ or the document's full screen: not drawn, kept), `project:
SidebarProject {id, name}` (the top-level project), `roots: [ProjectNode]` (`ProjectNode(WorkspaceNode)`), `hereId`
(the project open here), `recent: [RecentPlace]` (state.json `recent`, this top-level project's), `visits: [Visit]`
(the clock's), `entries: [AgentEntry]`, `projectCounts: [String: AgentSummary]`, `rows: [LibraryRow]` (this project's
sources, `SidebarModel.byOpened(rows, opened: storage.openedAt())`), `activeRowId`, `flashId`, `library: [LibraryRow]`
(letGo notes left out: `RailModel.letGoNotes`), `inRail: Set<String>`, `canNewNote` (a project is open),
`canToggleStickies`, `stickiesHidden`, `trashFull`, `stickyDrag: StickyDrag?`, `railHidden`, `tourStep: Int?`,
`folders: [AppState.Folder]?` (nil: the sidebar loads them and follows `engelbart:folders` itself — the normal case).

How the Workspace computes `entries` and `projectCounts` (Workspace.jsx 1679-1707):
```swift
let marks = storage.agentMarks()
let entries = SidebarModel.keptAgents(SidebarModel.agentEntries(agents: nav.agents, builds: builds, connect: connectNotes, projectId: pid)
                                      + SidebarModel.repoEntries(notifications, items: repoItems, library: library), marks: marks, now: minute)
let counts = SidebarModel.projectCounts(agents: nav.agents, entries: entries, projectId: pid, marks: marks, now: minute)
storage.setAgentMarks(SidebarModel.markAgent(marks, entry.id, "clicked"))   // goAgent / seenAll; "dismissed" for ×
```

### `SidebarActions` (closures; defaults do nothing)
`openProject(id)`, `newProject()`, `allProjects()`, `renameProject(name)`, `openProjectPage()`, `openSettings()`,
`selectWorkspace(id)`, `createWorkspace(name, parentId) async throws`, `renameWorkspace(id, name)`, `deleteWorkspace(id)`,
`openVersion(ArchivedVersion)`, `goAgent(entry, rect?)`, `dismissAgent: ((AgentEntry) -> Void)?` (nil: no ×),
`nextAgent()` (⌘J's), `seenAll()`, `toggleRail()`, `openRow(row)`, `renameRow(row, name)`, `removeRow(row)` (off this
project), `linkRow(row) async throws`, `openHeld(projectId, workspaceId?)`, `dropItems([Drop.Item]) async`,
`addInput(String) async throws -> LibraryRow` (addOrFind + link here), `pickDisk() async -> [problems]`,
`newNote() async throws -> String?` (the new note's id; opened as a tab), `pickRepo(GithubRow) async throws`,
`libraryChanged() async` (the sidebar added a row into a folder: reload), `flash(id)`, `toggleStickies()`,
`openTrash(window, rectOfTheTrashButton)` (PostIts' TrashPanel), `panelOpened(kind)` (the walkthrough ticks step 1 on
"library").

Adding into a folder (`+` on a folder, its picker, GitHub, files) is the sidebar's own: `AddOrFind` through
`services.addLibraryItem`/`lookup`, `actions.libraryChanged()`, then `services.addToFolder`, then `actions.flash(id)`.

### Other views the app places
- `RecentPagesButton()` — the clock for the title bar (`button` is its NSView; set `pages` and `onOpen`).
- `GettingStartedView(state:steps:library:papers:onTick:onHide:onOpenLibrary:onWrite:onBrainstorm:onDiscover:onOpenPaper:)`
  — under the Welcome project's title; `GettingStartedModel.stepsHere/discoverPapers` give its inputs.
- `SidebarTourOverlay()` — `holes = { sidebar.tourHoles(step: $0) }`, `onNext`, `onClose`, `show(step:paused:in:)`, `hide()`;
  `storage.tourSeen()/markTourSeen()`; `SidebarTour.STEPS`.
- `AddToLibraryView(model: AddMenuModel(search:library:inRail:lookup:), github:)` + `AddMenuModel.onAdd/onPickDisk/
  onPickRepo/onSearchPick/onNewNote/onNewSticky/onNewChild` — Home's "Add context" (Screens).
- `SidebarMarks.trash` (Home's card Delete can, TRASH_MARK), `SidebarMarks.circlePlus`.

## Pure models (no AppKit)
- `SidebarModel` — every function of model/sidebar.js: `indexTree`, `within`, `openPath`, `toggleOpen`, `projectSlots`,
  `projectPlan`, `shortcutProjects/shortcutOf` (Ctrl+1–9: the Workspace's key handler uses these), `buildState`,
  `agentEntries`, `repoEntries`, `summarize`, `markAgent`, `keptAgents`, `buildInProgress`, `rollUp`, `summaryOf`,
  `projectCounts`, `countLabel`, `libraryLabel`, `recentPages`, `visited`, `crumbFrom`, `sourceIcon`, `byOpened`,
  `noteOpened`, `folderRows`, `versionsOf`, `archivedVersions`, `sinceWords`, `since`, and the pre-10-13 helpers still
  tested (`workspaceActivity`, `pathTo`, `countWorkspaces`, `recentWorkspaces`, `fitChildren`, `sourceKind/Group/Groups`,
  `fitGroups`, `inboxEntries`, `agentGroups`). Types: `ProjectNode`, `TreeIndex`, `TreeEntry`, `ProjectPlan`,
  `AgentEntry`, `AgentSummary`, `AgentMark`, `NavAgent(json:)`, `RecentPlace(json:)`, `BuildInfo(json:)`, `ConnectNote`,
  `RepoNotification`, `RepoItem`, `Visit`, `RecentPage`, `ArchivedVersion`, `JSTime` (Date.parse).
- `RailModel` — `looksAddable`, `parseSources`, `searchRows`, `bodyMaps`, `libraryPanelRows`, `LIBRARY_RECENT`,
  `letGoNotes`; `SearchResult`, `Bodies`, `ParsedSource`; `LibraryRow.lib` (→ Doc's `LibRow`).
- `NavModel` — `nextPlace` (⌘J's fallback), `placesToGo`, `ago`, `flatWorkspaces`, `findWorkspaces`; `Place`, `FlatProject`.
- `AddOrFind.addOrFind(input, add:, lookup:)`.
- `GettingStartedModel` — `STEPS`, `EMPTY_HINT`, `stepsHere`, `firstOpen`, `libraryTabs`, `discoverPapers`, `stepMeta`.
- `KeyValueStorage` (`MemoryStorage`, `UserDefaultsStorage`) with `opened/slots/tourSeen/agentMarks/openedAt/visits`
  readers and writers under Electron's localStorage keys (`StorageKeys`).
- `StoreValues` — make Store values whose initializers are internal (lookup, preview, holder, bodies, folder, project).

## Events
Listened to: `engelbart:folders` ({folders}) when `input.folders == nil`. Posted: none (the Store posts the folder and
library events when the sidebar calls it; Electron's Rail posted none either).

## Accessibility identifiers (the Electron data-* attributes)
Rows and buttons carry `accessibilityIdentifier` (and `identifier`) named after Rail.jsx's attributes:
`sb-trigger=project|agents|library|add:<folder|project>`, `sb-fixed-row=search`, `sb-count=agents|library|<id>`,
`sb-head=projects|sources`, `sb-next-agent`, `sb-new-workspace`, `sb-project-row=<id>`, `sb-new-child=<id>`,
`sb-chevron=<id>`, `sb-more=projects|<id>|project|<folder>`, `sb-add-sources`, `sb-folder=<project|id>`,
`sb-folder-add=…`, `sb-folder-chevron=…`, `sb-source=<id>`, `sb-remove=<id>`, `sb-plus-note`, `sb-create-folder`,
`toggle-post-its=shown|hidden`, `sb-trash`, `sb-settings`, `sb-new-note`, `rename`. Panels use `driveID`
(`sb-panel=<kind>`, `library-chip=<id>`, `agent-entry=<id>`, `add-result=<id>`, …).

## Needs from other packages
- **UI**: a public `DriveRegistry.register(id, view)` so the AppKit rows can be found by the app's `ENGELBART_DRIVE`
  driver the way `driveID` views are (they carry accessibility identifiers meanwhile).
- **PostIts**: the trash panel (TrashPanel.jsx), opened through `actions.openTrash(window, rect)`.
- **Workspace**: computes `entries`/`projectCounts` (above), keeps `engelbart.agentMarks`, `engelbart.openedAt`,
  `engelbart.recentPages` through `KeyValueStorage`, owns ⌘J (with `NavModel.nextPlace` as its fallback), Ctrl+1–9
  (`SidebarModel.shortcutProjects`), ⌘\ and the width drag, and places `RecentPagesButton`, `GettingStartedView`,
  `SidebarTourOverlay`.
- **Screens** (Home): `AddToLibraryView`, `SidebarMarks.trash`; Home's ItemPeek is ported here too (`ItemPeekView`, internal)
  — if Screens publishes one, the sidebar can take it instead.
