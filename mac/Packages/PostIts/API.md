# EngelbartPostIts — public surface

Post-its: sticky cards over a project (`src/renderer/post-its/**`, `src/main/post-its/**`, `src/post-it-preload.cjs`, and
the post-it halves of `screens/Workspace.jsx` and `workspace/Rail.jsx`). Ledger: `mac/parity/postits.md` (including the
Electron → Swift mechanism table). Depends on Core, UI, Store, Doc, Editor, Build.

## How it is drawn

One `PostItsOverlayView` per workspace window, inside the window's content view, above the workspace and below every
`FloatingPanel` (those are child windows, so a panel that reaches a card covers it, B29). Each card is a `PostItCardView`
hosting a compact `DocEditorView`. Presses off the cards fall through to the workspace. The Build popup, its Context
popout, the quick task's card and its model grid are `FloatingPanel`s owned by the controller.

## Entry point: `PostItsController` (`@MainActor`, `ObservableObject`)

```swift
var ctx = PostItsContext(data: StorePostItsData(store: store), build: buildService)   // BuildService conforms to PostItsBuild
ctx.peers = appPostItPeers                     // ONE PostItPeers for the whole app (windows on a project hear each other)
ctx.openNote = { projectId, id, name in … }    // +Note: reload the library, open the note as a tab (Workspace.jsx onOpenNote)
ctx.openLink = { url in … }                    // a link on a card: open it on the Stage
ctx.onError = { error in … }                   // the window's error line (post-its:error)
ctx.goToVersion = { workspaceId, version in … }// a quick task added to a workspace: go there, open `version` ({file, title}) in the middle
ctx.focusWorkspace = { … }                     // optional: where the keyboard goes when it leaves a card (default: the window)
ctx.library = { … [PickRow] }                  // Context's rows: the window's library (LibRow + last edited)
ctx.bodies = { await … [id: text] }            // optional (useBodies): what each row says, matched too
ctx.addLibraryItem = { input in … PickRow }    // "Upload URL or path" / disk / GitHub adds
ctx.pickPaths = { await … [String] }           // "Choose from disk…" (Store.pickLibraryPaths)
ctx.githubPane = { busy, back, pick in AnyView(GithubPaneView(…)) }  // "Add from GitHub…" (Integrations)
ctx.libraryChanged = { … }                     // Context added something: the sidebar reads the library again
ctx.workspaces = { PostItLists.flatWorkspaces(tree.workspaces) }     // the task card's project field
ctx.hereWorkspaceId = { topic?.id }
// optional: events (EventHub, default .shared), visibility (.shared), pickMemory, now

let postIts = PostItsController(context: ctx)
postIts.attach(to: window.contentView!)        // fills it, above what is there; call bringToFront() after adding views over the workspace
await postIts.activate(projectId)              // while the workspace screen shows this project
await postIts.activate(nil)                    // the screen left, the window closing, the data root changing, quit (flushes first)
postIts.dispose()                              // the window is gone
```

The controller hears `engelbart:build` and `engelbart:build-progress` itself on `ctx.events` (the Build manager's notify
must post them there); records whose `projectId` is the active project update the cards and the task card.

### What the Sidebar calls (Rail.jsx foot, Workspace.jsx)
- `try await create()` — the add menu's Sticky (also shows hidden cards). → the new card's id.
- `hidden` (published), `setHidden(_:)`, `toggleHidden()` — the foot's Show/Hide stickies (the sticky glyph dotted while
  hidden); one app-wide flag (`PostItsVisibility.shared`, UserDefaults `engelbart.postIts.hidden`), every window hears it.
- `drag` (published `PostItDrag {active, over, thrown}`) or `onDrag` — while `active`, the foot says "Drop here to throw
  it away", darker while `over`.
- `trashView = footView` (weak; measured at every drag move, nil/hidden = no trash) or `trashRect` (overlay coordinates).
- `trashCount` (published) or `onTrashCount(projectId, count)` — the trash button shows while > 0 (or the tree has trash).
- The trash panel: `PostItsTrashPanel.present(in: window, anchor: trashButtonRect, model: TrashPanelModel(controller:
  postIts, projects: tree.trash mapped to .init(id:name:nested:expires:), restoreProject: { id in … }), ignore: footRect)`;
  `TrashPanelView(model:)` to embed it elsewhere. Pass `controller: nil` when the project is not in front.
- `openQuickTask(id:postItId:anchor:)` — a sticky's quick task picked in the Agents panel (rect = the row's, window
  content coordinates, y down).

### Also public
- `layout()` (the overlay calls it on resize), `zoom`, `cancelGesture()` (window blur is handled), `setBlocking(_:)`
  (optional step-aside for something drawn inside the window), `trashed()`, `restore(_:)`, `throwOut(_:)`, `flush()`,
  `cards`, `card(_:)`, `row(_:)`, `tasks`, `progress`, `buildState(_:)` (feed a record by hand when not using EventHub).
- Pure models: `PostItGeometry` (geometry.cjs), `PostItWords` (noteName, timeLeft, preview, externalURL), `BuildBrief`,
  `QuickTaskText`, `ModelPick` (+ `PickMemory`), `PostItLists` (flatWorkspaces, findWorkspaces, attachRows).
- `PostItBuildModel`, `ContextModel`, `PostItTaskModel`, `TrashPanelModel` (the panels' state).

## Drive identifiers (`.driveID`, mac/Engelbart/API.md)
Every one is a `DriveRegistry` marker (SwiftUI views use `.driveID`; AppKit views carry a `DriveTag` subview that never
takes a press) and the accessibility identifier, named after the Electron `data-*` attribute:
`post-its` (overlay), `post-it=<id>` (card), `copy-post-it`, `note-post-it`, `build-post-it`,
`post-it-build-state=<status>` (the state word), `resize-post-it`,
`post-error`, `post-it-build=<cardId>`, `build-choice`, `build-context`, `build-send`, `build-note`, `ctx-pop`,
`ctx-search`, `ctx-row=<id>`, `post-it-task=<id>`, `post-it-task-word`, `post-it-activity`, `quick-act=stop|discard|promote`,
`post-it-model`, `ny-model`, `post-it-ws=<id>`, `post-it-ws-search`, `post-it-ws-row=<id>`, `model-grid`, `trash-panel`,
`trashed-post-it=<id>`, `restore-post-it=<id>`, `trashed-workspace=<id>`, `restore-workspace=<id>`.

## Needs from other packages
- **Editor:** a public way to make a compact editor transparent and labelled "Sticky" (this package reaches the
  `NSTextView`/`NSScrollView` inside `DocEditorView` through the view tree: `drawsBackground = false`, no scroller,
  accessibility label); and `compact` should not show a scroller of its own.
- **UI:** the post-it colours (`#fff2a0`, `#ffd08a`, `#705717`, `#8a752d`, `#a08f52`, `#b42318`, `#e8d77a`) are local
  (`PostItLook`); move them into `Palette` if another package needs them. `FloatingPanel` has no "not while busy" press
  rule, so the post-it popups use `dismissible: false` and their own monitors.
- **Workspace/App:** create one `PostItsController` per workspace window and one `PostItPeers` for the app; route
  `engelbart:build`/`engelbart:build-progress` through the EventHub given in the context.
- **Sidebar:** draws the foot and the add menu's Sticky with the API above.
