# Parity ledger: Post-its (sticky cards over a project)

Sources: `src/renderer/post-its/` (Card.jsx, ProjectPostIts.jsx, PostItBuild.jsx, PostItTask.jsx, ModelGrid.jsx,
TrashPanel.jsx, face.jsx, face.css, card.css, post-it.html), `src/main/post-its/views.cjs` and `geometry.cjs`,
`src/post-it-preload.cjs`, the post-it handlers of `src/main/ipc.cjs` / `index.cjs` / `windows.cjs` / `preload.cjs`, the
post-it parts of `screens/Workspace.jsx` (postItBuild, quickTask, startQuick, promoteQuick, goToVersion, goAgent's quick
branch, trash rect, hidden toggle) and of `workspace/Rail.jsx`'s foot (drawn by the Sidebar package through this API).
Specs: desktop design §2 #68, #79–82, #101; build workflow B23, B26, B28, B29; `design/post-it-quick-task/TWEAKS.md`.
Memory: engelbart-desktop-experiment.md (2026-09-22 round 2, 2026-09-25 toggle, 2026-09-27 popup/task card).
Tests ported: `test/post-its.test.cjs` (geometry, trash week, noteName; the PGlite part is the Store's), the post-it
halves of `test/windows.test.cjs` (two windows on one project), `test/escape-panels.test.cjs` (trash Escape).

Swift paths are relative to `mac/Packages/PostIts/Sources/EngelbartPostIts/`. Status per ARCHITECTURE §6.

## Electron mechanism → Swift mapping

| Electron | Swift |
|---|---|
| One `WebContentsView` per card, a sibling above the window's page, its own renderer (post-it.html + Card.jsx) | One `PostItsOverlayView` inside the window's content view (above the workspace, below every FloatingPanel child window); each card a `PostItCardView` hosting a compact `DocEditorView` |
| IPC `post-it:*` (card → main) and `post-its:*` (window ↔ main), `assertTrustedRenderer`, `forEvent` | direct method calls on `PostItsController`; nothing to validate across a process boundary |
| Stand-in pictures (`capturePage`, `post-its:stand-ins`, z-index 54) for cards a `data-cover` panel is over | not needed: panels are child windows above the overlay, so they cover the cards natively |
| `post-its:block` rects + `visible()`: a card under a menu steps aside because a native view cannot go under the DOM | every panel covers the cards it reaches (B29's rule for all); `setBlocking` kept for the app that wants step-aside |
| `raise()` re-adding views re-parented them and dropped the keyboard (Enter lost the caret) | `sortSubviews` re-stacks without removing a view; the first responder is checked and restored |
| `post-its:trash-rect` from a ResizeObserver | `trashView` (weak; measured at every drag move) or `trashRect` |
| `localStorage engelbart.postIts.hidden` per window | `UserDefaults` `engelbart.postIts.hidden`, one app-wide flag every controller hears |
| `localStorage engelbart.postIt.build` (per-model efforts) | `UserDefaults` same key, same JSON |
| `webContents.getZoomFactor()` | `zoom` (1 unless the app scales the window's content) |
| CSS `zoom` on `.postit-fit` | the editor's bounds scaled against its frame |
| crumple: the view shrinks and the face is drawn full size with `transform: scale()` | the card's frame shrinks while its bounds stay full size |

## Behaviours

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 1 | cardBounds: MARGIN 8, TOP 56; width ≤ w−16, height ≤ h−56−8 (≥1); x = 8 + nx·max(0, w−width−16), y = 56 + ny·max(0, h−height−64), × zoom, rounded | geometry.cjs:9 | Geometry.swift | done |
| 2 | layoutFromBounds: the inverse, nx/ny clamped to [0,1], width 180…2400, height 140…2400 | geometry.cjs:20 | Geometry.swift | done |
| 3 | Clamping to a small window never writes back to the preferred layout | geometry.cjs:7, test | Geometry.swift, Controller | done |
| 4 | inTrash: the pointer (÷ zoom) inside the trash rect, edges included; no rect → false | geometry.cjs:32 | Geometry.swift | done |
| 5 | trashRect: nil → nil; four finite numbers under 100000, width and height > 0, else "Invalid trash rect" | geometry.cjs:39 | Geometry.swift | done |
| 6 | crumpleAmount: REACH 220 px from the can, t = 1 − d/220 clamped, smoothstep t²(3−2t) | geometry.cjs:52 | Geometry.swift | done |
| 7 | draggedBounds: scale 1 − 0.72t; at t=0 the grabbed spot stays under the pointer; at t=1 0.28 of the size, centred on the pointer's height, left edge at max(pointer+14, can right+10) | geometry.cjs:66 | Geometry.swift | done |
| 8 | overlaps: touching edges do not overlap | geometry.cjs:77 | Geometry.swift | done |
| 9 | blockingRects: at most 64, each validated; `cover` only when exactly true | geometry.cjs:85 | Geometry.swift | done |
| 10 | tallest = clamp(h/zoom − 64, 140, 2400) | geometry.cjs:91 | Geometry.swift | done |
| 11 | grown: top edge kept until the window bottom stops it, then it grows upwards; height ≤ tallest; nx and width kept | geometry.cjs:99 | Geometry.swift | done |
| 12 | noteName: fences skipped, line markers dropped, pictures removed, @mentions/links → their text, ** __ ~~ ` * dropped, spaces collapsed, cut at 60 (at a space past 30), nil when no words | views.cjs:19 | NoteName.swift | done |
| 13 | A new card: 260×260, text '', nx .22 + (n mod 8)·.045, ny .16 + (n mod 8)·.045, z = now (ms), on top | views.cjs:287 | Controller | done |
| 14 | Create while another project (or none) is active → "Open this project before adding a sticky" | views.cjs:289 | Controller | done |
| 15 | A fresh card takes the keyboard with the caret at its start once shown | Card.jsx:54, views.cjs:336 | Controller/CardView | done |
| 16 | Create and Restore show hidden cards again (the toggle flips to shown, the sidebar hears it) | views.cjs:311 | Controller | done |
| 17 | activate(id): last edits flushed, gesture cancelled, old cards gone, trash older than 7 days purged, cards listed in z order, trash count announced | views.cjs:267 | Controller | done |
| 18 | activate(nil) (screen left, window closing, data root changing, quit): cards flushed and gone | views.cjs:267, windows.cjs:99, index.cjs:272 | Controller | done |
| 19 | activate of the project already active does nothing | views.cjs:269 | Controller | done |
| 20 | Every edit is saved at once (no debounce), in order per card; ≤ 400000 characters else "Sticky text must be at most 400000 characters" | Card.jsx:57, views.cjs:403 | Controller | done |
| 21 | A failed save shows "Couldn’t save: <message>" on the card (white box, red #b42318, 12/1.4, bottom 30, sides 12, max 80 high); the next good save clears it | Card.jsx:61,150, card.css:11 | CardView | done |
| 22 | A card taking the keyboard comes to the top: z = max(now, every other z + 1), saved | views.cjs:223,247 | Controller | done |
| 23 | Re-stacking only when the order is wrong, and the card being typed in keeps the keyboard (Enter must not lose the caret) | views.cjs:131, spec #79 | Overlay.raise | done |
| 24 | A press on a card's whitespace (not on a glyph, button, link or picture) starts a drag; on a glyph it is the editor's | Card.jsx:18,64 | CardView.hitTest | done |
| 25 | Moved = 4 px from the press; until then nothing moves | Card.jsx:77, views.cjs:504 | CardView/Controller | done |
| 26 | A press that did not move puts the caret at the end of the text | Card.jsx:88 | CardView | done |
| 27 | A drag that moved swallows the click | Card.jsx:84,117 | CardView | done |
| 28 | While moving: grabbing cursor, no text selection; grab cursor over the card at rest | card.css:3,12 | CardView | partial: the grab/grabbing/pointer/nwse cursors are set (cursor rects, NSCursor push) but no test reads them; macOS 14 has no public diagonal cursor (crosshair there, frameResize on 15+) |
| 29 | Drag begin: gesture cancelled first, the card focused (raised, saved), the grabbed fraction (0…1) kept | views.cjs:492 | Controller | done |
| 30 | A gesture begins only on a visible card | views.cjs:493 | Controller | done |
| 31 | Resize from the 22×22 lower-right handle (bottom 2, right 2): width 180…2400, height 140…2400 from where it began; its glyph (opacity .7, #705717) only on hover or focus; nwse cursor | Card.jsx:151, views.cjs:518, card.css:7 | CardView/Controller | done |
| 32 | Keyboard resize: arrows on the focused handle, ±20 px through the same path | Card.jsx:152 | CardView | done |
| 33 | Let go elsewhere: the preferred layout from where it is; a drag keeps the preferred width and height (a clamped card does not shrink); placed again, saved | views.cjs:535 | Controller | done |
| 34 | Over the trash while dragging: face #ffd08a (120 ms), the window told {active, over}; crumpling shrinks and slides it beside the can | views.cjs:506, card.css:5, spec #80 | Controller/CardView | done |
| 35 | Let go short of the can: full size again under the pointer | spec #80, views.cjs:510 | Controller | done |
| 36 | Let go over the can (having moved): into the trash (deleted set), card gone, keyboard to the window if it had it, trash count announced, other windows told; drag {active false, thrown true} | views.cjs:424,531 | Controller | done |
| 37 | cancelGesture: bounds restored, tint/crumple/moving reset on the card, drag {false, false}; on window blur, Escape, hide, a card going | views.cjs:475, index.cjs:574 | Controller | done |
| 38 | Escape in a card: gesture cancelled, the keyboard leaves the card for the window (before the editor sees it) | views.cjs:249 | Controller key monitor | done |
| 39 | Window resize: every card placed again from its preferred layout, except the one being dragged | views.cjs:213, index.cjs:567 | Controller.layout | done |
| 40 | Hide/Show: every card out of sight, nothing written; a gesture cancelled and the keyboard taken off a card; remembered across launches; one flag for every project and window | views.cjs:301, Workspace.jsx:281 | Controller, PostItsVisibility | done |
| 41 | trashed: purge, then newest first {id, text (first 4000), deleted, expires = deleted + 7 days}; [] when the project is not active | views.cjs:435 | Controller | done |
| 42 | restore: back where it was, on top (z = max(now, others + 1)), saved, shown, count announced, other windows told; false when not in the trash; "Open this project before restoring a sticky" | views.cjs:446 | Controller | done |
| 43 | throwOut ("Delete task", after promote): into the trash as a drop does; "Open this project first"; false without the card | views.cjs:393 | Controller | done |
| 44 | Purged only when the project opens and when the trash is listed, never on a timer | spec #80 | Controller | done |
| 45 | Trash count reaches the sidebar (`post-its:trash` {projectId, count}) after every change | views.cjs:207 | Controller.onTrashCount | done |
| 46 | Grow: text that does not fit makes the card taller (top edge kept, as far as the window lets it), saved; never during its own gesture; invalid heights refused | views.cjs:411, face.jsx:43 | Controller.grow | done |
| 47 | Fit: a card never scrolls; what still does not fit gets smaller type, largest zoom in [0.35, 1] by 9 bisections, floored to 0.001; refitted whenever the card's size changes, back up to 1 | face.jsx | CardView.refit | done |
| 48 | Placeholder "Write something…" while empty: left 16, top 4, #8a752d, 17/1.6, clicks pass through | Card.jsx:124, card.css:6 | CardView | done |
| 49 | Face: flat #fff2a0, no shadow, tilt or folded corner; head 14; body padding 0 16; foot 30, padding 0 26 0 10; text 17/1.6 #171717 | face.css, card.css:2 | CardView | done |
| 50 | Copy (lower left, 22×22, 14 px glyph): the card's markdown as written to the clipboard; a check for 1.4 s; title "Copy this sticky" | Card.jsx:91,127, spec #82 | CardView | done |
| 51 | Note: note glyph + "Note"; a new note named by noteName else the first free "Untitled Note n", holding the card's text, in no workspace; the window opens it as a tab; "Opened" for 1.6 s; the card stays | Card.jsx:94, views.cjs:463, spec #81 | Controller.toNote | done |
| 52 | Build: "Build" + circled up arrow, only while idle (no task, discarded, or merged and not moved); disabled while the text is blank; title "Hand this to a coding agent as a quick task" | Card.jsx:143 | CardView | done |
| 53 | State word: none/discarded '' · moved (kind build with a workspace) → workspace icon + name · accepted → Merged · setting-up/queued/running/accepting → Building + three dots · stopped/interrupted → Stopped · else Needs you; ink unless idle or moved; ≤120 px with ellipsis; disabled when merged | Card.jsx:103 | BuildBrief.swift, CardView | done |
| 54 | Footer words: 500 12 px, #705717, hover #171717, gap 14 (word gap 5, strong 6), no background; focus ring #a08f52 | face.css:8-16 | CardView | done |
| 55 | Building's dots: three 4 px circles, gap 3, rising 2 px, 1.1 s ease-in-out, delays 0/.15/.3 s, opacity .25→1 | face.css:18-22 | DotsView | done |
| 56 | A card's state follows its quick task live (every window showing the project), and a card opened later shows its latest task (buildFor) | views.cjs:338,376, index.cjs:724 | Controller.buildState | done |
| 57 | A link clicked on a card opens on the Stage (http/https only, `parseExternalUrl`) | views.cjs:564 | Controller.openLink | done |
| 58 | The card's editor is DocEditor compact: no scrolling, no reply fields or folds, labelled "Sticky" | Card.jsx:122, DocEditor.jsx:5127 | CardView (DocEditorView.compact) | done |
| 59 | Another window's save of a card (text, nx, ny, width, height, z) reaches this window's card without being saved again; its text replaces the card's; a card being dragged here keeps its gesture | views.cjs:49,92 | PostItPeers, Controller.hear | done |
| 60 | Another window's new, thrown-away or restored card appears/disappears here | views.cjs:94-106 | Controller.hear | done |
| 61 | A window closing lets its cards go after their last edits are saved | windows.cjs:119, windows.test | Controller.activate(nil) | done |
| 62 | Clicks anywhere off the cards reach the workspace under the overlay | — (WebContentsView bounds) | Overlay.hitTest | done |
| 63 | Cards only on the workspace screen while it is active; switching projects swaps the set | ProjectPostIts.jsx:33 | Controller.activate | done |
| 64 | Build button → the Build popup hangs from it (420 wide, gap 8, aligned to its right edge), the quick task card closes; pressing it again closes the popup; the keyboard leaves the card | views.cjs:361, Workspace.jsx:841 | Controller.askBuild | done |
| 65 | Popup: the model grid; a 1 px #eaeaea rule; a red problem line (error, else preflight's first problem); foot: "<Model> <Effort> · in <target>" (12/1.3 #4d4d4d), ⊕ Context (· n picked), the 30 px send (blue #0070f3 with ↑ when ready, #eaeaea grey otherwise) | PostItBuild.jsx:177 | PostItBuildPanel.swift | partial: the popup's model (label, problem, ready, send) is tested; its drawing (rule, foot spacing, colours) is not pixel-checked |
| 66 | Ready = a choice, preflight ok, not busy, non-blank text | PostItBuild.jsx:151 | PostItBuildModel | done |
| 67 | Starts on main's last 'quick' pick, else the quick default; a pick kept by an older build in localStorage is handed to main once and dropped | PostItBuild.jsx:30 | ModelPick.startingChoice | done |
| 68 | A pick is remembered for the next post-it (rememberModelChoice 'quick'); each model's last effort kept here (`engelbart.postIt.build` {efforts}) | PostItBuild.jsx:144 | PostItBuildModel | done |
| 69 | Send: build-start {kind quick, postItId, text, provider, model, effort, attach, target default}; the popup closes; an error stays in it and it is usable again | Workspace.jsx:927, PostItBuild.jsx:152 | PostItBuildModel.send | done |
| 70 | A post-it's Build always works in the default repo (no picker) | PostItBuild.jsx:129 | PostItBuildModel | done |
| 71 | Escape closes Context first, else the popup (not while busy); ⌘/Ctrl+Enter sends; a press outside the popup and its popout closes it unless busy | PostItBuild.jsx:158-173 | PostItPanels | done |
| 72 | Context popout: 290 wide, beside the popup (right when it fits with 6 + 8 to spare, else left), bottoms level; the search focused on open | PostItBuild.jsx:54, ModelGrid.jsx:113 | ContextPopout | done |
| 73 | Context rows: attachRows (8 most recent when nothing typed; typed: every word in name/url/path/folder/kind/summary, names starting with the first word first, then what holds it only in its text); picked rows listed first while nothing is typed; ✓ and weight 500 when picked; a click toggles; "Nothing in the library matches." | PostItBuild.jsx:67-103, rail.js:141 | AttachRows.swift, ContextPopout | done |
| 74 | "Upload URL or path" (Enter adds it to the library and picks it; red border on error); "Choose from disk…" (each path added, problems joined " · "); "Add from GitHub…" → the GitHub pane (back; a pick is added and picked); the sidebar re-reads the library after an add | PostItBuild.jsx:74-113 | ContextPopout | partial: Upload URL or path and Choose from disk are tested; Add from GitHub shows the app's injected GithubPaneView (not tested here) |
| 75 | Escape in the popout clears the query, else closes it | PostItBuild.jsx:83 | ContextPopout | done (what the user saw: the popup's capture-phase Escape listener ran first in Electron, so Escape closed the popout and its clear-the-query branch never ran) |
| 76 | Model grid: provider field (#fafafa, 1 px border #eaeaea/#c9c9c9 open, caret only with >1 provider, a list of providers); MODEL head (9 px, 500, uppercase, 1.6 tracking, #8f8f8f); models with radio (ink 1.5 px, ✓), the previewed one washed #f2f2f2, hover previews, › trailing #c9c9c9; a 1 px column rule; right column #fafafa "EFFORT · <model>" with the efforts, the marked one on white | ModelGrid.jsx:55 | ModelGridView.swift | partial: the grid's picks (effortFor, provider, preview) are tested through the models; its drawing is not pixel-checked; the provider list is a floating panel 193.5 wide under the field |
| 77 | Picking a model takes effortFor (its last effort here, else its ladder step's, else the provider's first step's if offered, else the first effort); picking an effort picks the previewed model with it | ModelGrid.jsx:15,86,100 | ModelPick.swift | done |
| 78 | choiceLabel "Opus High" (effort labels: Low Medium High Extra high Max Ultra) | ModelGrid.jsx:23 | ModelPick.swift | done |
| 79 | State click: a task added to a workspace with a version → that workspace with the version open (goToVersion); else the task card toggles beside the card; the Build popup closes | Workspace.jsx:846 | Controller.openBuild | done |
| 80 | Task card: 420 wide from the state (gap 8, right-aligned); word (Building + dots / Stopped / Needs you) and × | PostItTask.jsx:137 | PostItTaskPanel.swift | partial: placement and contents tested through the model; drawing not pixel-checked |
| 81 | While working: activity (progress, else "Setting up its copy of the code" / "Waiting for a slot" / "Working"), one line with ellipsis; Stop (not while accepting) | PostItTask.jsx:121,147 | PostItTaskPanel | done |
| 82 | Done: the message (stopped → STOPPED; failed → "This task failed: <error>. Add it to a workspace below to continue."; review/conflict → could not be merged; else TOO_BIG) | PostItTask.jsx:33 | BuildBrief.messageFor | done |
| 83 | Done: "Continue building this task in a project.", the project field, Discard (a second click within 4 s: red "Discard for good?"), the model chip (starts on the task's model; its grid opens beside), the send | PostItTask.jsx:153 | PostItTaskPanel | done |
| 84 | Send (promote): build-promote(workspaceId, choice) → the post-it thrown out → the workspace with its imported version open → closed; an error stays | PostItTask.jsx:124, Workspace.jsx:975 | PostItTaskModel | done |
| 85 | Project field: icon + name or "Choose a project" + caret; open: a focused search, every workspace (indented 16 per level), typed → findWorkspaces with "in <parent>"; ✓ on the current; Enter takes the first; Escape clears, else closes; "No project matches." | PostItTask.jsx:41 | WorkspacePick | partial: rows, search, pick, Enter-first tested through the model; the dropdown's drawing (a floating panel under the field) not pixel-checked |
| 86 | The field starts on the workspace open now when listed, else the first | PostItTask.jsx:98 | PostItTaskModel | done |
| 87 | findWorkspaces: every word in the name, names starting with the first word first, else listed order | nav.js:76 | Workspaces.swift | done |
| 88 | Task card Escape: the model grid first, else the card; a press outside closes it unless busy | PostItTask.jsx:107-116 | PostItPanels | done |
| 89 | Shown only while the task's record is known; follows its record and progress live | Workspace.jsx:2632 | Controller | done |
| 90 | A quick task picked in the Agents panel: stickies shown, the Build popup closed, its task card at the row | Workspace.jsx:1728 | Controller.openQuickTask | done |
| 91 | Trash panel: 320 wide, padding 4, white, 1 px #eaeaea, radius 8; "Projects and stickies in the trash are deleted a week after they’re thrown away." (no projects: "Stickies …"), 12/1.5 #8f8f8f | TrashPanel.jsx:42 | TrashPanel.swift | partial: 320 wide and the heading words tested; padding/border not pixel-checked |
| 92 | Trash panel project rows: workspace glyph, name (13/1.4), "Project and N inside it · " or "Project · " + time left (11/1.4 #8f8f8f), Restore (outline, 500 12) | TrashPanel.jsx:44 | TrashPanel.swift | partial: rows and Restore tested through the model; drawing not pixel-checked |
| 93 | Trash panel sticky rows: 14 px swatch #fff2a0 with #e8d77a border, preview (first three lines, markers stripped, " · ") or grey "Empty sticky", time left, Restore; "No stickies in the trash." when none and no projects; a problem line in red | TrashPanel.jsx:56 | TrashPanel.swift | partial: rows, preview, Empty sticky words and Restore tested through the model; the swatch's drawing not pixel-checked |
| 94 | timeLeft: ceil(days); ≤ 1 → "deleted within a day", else "deleted in N days" | TrashPanel.jsx:10 | NoteName.swift (TrashText) | done |
| 95 | The trash panel reads the list again when the count changes; Escape closes it and is used (the workspace's Escape never sees it); a press outside closes it except on the trash button | TrashPanel.jsx:30-39, escape-panels.test | TrashPanel (FloatingPanel ignore) | partial: reload on a count change tested; Escape and press-outside come from FloatingPanel (dismissible, ignore = the foot) and are not driven here |
| 96 | Sidebar foot API: whether hidden (label Hide/Show stickies, sticky glyph dotted while hidden), drag {active, over} ("Drop here to throw it away"), trash count (the trash button) | Rail.jsx:841, Workspace.jsx:278 | Controller callbacks | done |
| 97 | Errors of the cards' work reach the window (`post-its:error`) | views.cjs:74, ProjectPostIts.jsx:45 | Controller.onError | done |
| 98 | Copy text ≤ 400000 characters | views.cjs:560 | Controller.copy | done |
| 99 | A thrown card's late save leaves it in the trash with its text | test post-its.test.cjs:74 | Store NotesDB (ported there) | done |
| 100 | Menus over a card step aside (non-covering); hover previews never do | views.cjs:143, ProjectPostIts.jsx:11 | Controller.setBlocking | done (optional in Swift: panels already cover the cards; `setBlocking` keeps step-aside for anything drawn inside the window) |
| 101 | Covering panels (Build popups, their dropdowns, image viewer, import scrims) draw over the cards | B29 | native stacking | done (child windows above the overlay; tested: the popup is a child window of the card's window) |
| 102 | Pins (`:::post-it` blocks) removed; never re-add | spec #82 | — | n/a: removed in Electron; nothing to port |
| 103 | A card whose renderer crashed reports "A sticky stopped responding…" | views.cjs:248 | — | n/a: no separate process per card |
| 104 | IPC validation (trusted renderer, card bound to its sender, ids checked) | views.cjs:325,578 | — | n/a: no IPC; Swift calls are typed |
| 105 | Stand-in pictures kept fresh (400 ms stale timer, 250 ms after ready, 60 ms reshow on build state) | views.cjs:160-205 | — | n/a: covering is native (see mapping) |
| 106 | Card bundle must never import renderer/api.js (else "Engelbart bridge is unavailable") | memory 2026-09-25 | — | n/a: one process |
| 107 | `setBackgroundThrottling(false)` for hidden-window cards | memory 2026-09-22 | — | n/a: no web contents |
