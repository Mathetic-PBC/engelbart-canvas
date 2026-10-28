# Parity ledger: the Workspace screen (`mac/Packages/Workspace`)

Sources: `src/renderer/screens/Workspace.jsx` (all of it), `workspace/DocTabs.jsx`, `workspace/DocPane.jsx`,
`workspace/NotePicker.jsx`, `workspace/RightPane.jsx`, `model/notepick.js`, `model/panes.js` (ported in UI as `Panes`),
`ui/FluidTab.jsx` (as the strip uses it), the workspace parts of `App.jsx` (entry `{workspaceId, tab, views, stage}`,
`reload`, `onVisit`, cross-window announcements), the screen-owned parts of `model/nav.js`, `model/sidebar.js`,
`model/rail.js`, `model/getting-started.js`, `model/guide.js`, `model/zotero.js`, `model/add-or-find.js`,
`model/drop.js addDropped`; spec 2026-09-16 §2 (#24, 31, 33, 43, 63, 65, 74–77, 83, 85–86, 92–93, 98); commits listed by
`git log -- <those files>` (117, 2026-09-16 … 2026-10-22); memory notes `ui-round-10-16.md`,
`engelbart-desktop-experiment.md` (views, navigation, ⌘J, tabs, Stage, Build, title bar), `no-horizontal-dividers.md`;
tests `test/notepick-model.test.cjs`, `nav-model.test.cjs`, `panes-model.test.cjs`, `key-side.test.cjs`,
`sidebar-model.test.cjs` (agent rows), `rail-model.test.cjs` (mentionRows, pickedChanges), `getting-started.test.cjs`,
`discover-guide-save.test.cjs`.

Swift paths are under `mac/Packages/Workspace/Sources/EngelbartWorkspace/`. "Sidebar slot" / "PostIts slot" = drawn by the
package the app injects through `WorkspaceSidebar` / `WorkspacePostIts` (this screen computes and passes what Electron
passed as props). Status `done` = checked by a passing cloud run of `EngelbartWorkspaceTests`.

## A. Opening a project, entry, reload, place

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 1 | The screen opens on `entry.workspaceId` when the tree has it, else the tree's first workspace; none → no workspace (the empty state) | Workspace.jsx:203-204 | WorkspaceModel.topicId | todo |
| 2 | Its first tabs are the remembered view's (`views[wid]`), less notes that are gone, with their current names; `entry.tab` is opened into them in front | restoredTabs :167 | WorkspaceModels.restoredTabs | todo |
| 3 | Only one Workspace tab ('ws', first, title from the workspace); a remembered `kind: 'workspace'` tab of the 2026-09-23 build is left behind; a remembered Project-page tab keeps its title ('Project page' default) | restoredTabs :167-178 | WorkspaceModels.restoredTabs | todo |
| 4 | The active tab restored: the entry's tab, else the view's `active` when still a tab, else 'ws' | :176 | WorkspaceModels.restoredTabs | todo |
| 5 | Every workspace shown reports itself (`onVisit(id)`: the app's setLastOpen + reportPlace) | :324, App.jsx:532 | WorkspaceModel.visit | todo |
| 6 | `reload()` reads the tree and the library again; the screen takes the new ones (also pushed by the app on another window's change) | App.jsx:165, 382-403 | WorkspaceViewController.update(tree:library:) | todo |
| 7 | Opened from all projects with a Stage request: a row opens on the Stage; `{links}` (sign-in import) open the first in front and the rest in tabs of their own | :1362-1366 | WorkspaceModel.openInitialStage | todo |
| 8 | A project with no code directory: the screen is blurred 6px and inert (`active` false) under the app's DirectoryGate; keys, post-its' trash rect and announcements that need `active` are off | App.jsx:607-608 | WorkspaceViewController.active | todo |
| 9 | DirectoryGate dialog itself | App.jsx:37-65 | — | n/a: the app's (mac/parity/app.md #55) |
| 10 | Workspace ids that are gone fall back: a wanted id not in the tree → first workspace | :204 | WorkspaceModel.topicId | todo |

## B. Header (title bar)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 11 | One header row 44px high (TITLE_LINE 27 + 17), background #fafafa, no rule under it | :142-143, 2411 | HeaderView | todo |
| 12 | Three columns: title lead over the sidebar (its width; auto when folded), 1px gap, the document strip (flex), 1px gap (hidden in full screens), the right switcher (the right pane's width; hidden in document full screen) | :2411-2452 | HeaderView.layout | todo |
| 13 | Title lead: sidebar toggle then the clock, aligned right when the sidebar shows (padding 13 8 0 14), left after the traffic lights when folded (13 12 0 14); `.title-lead` 84px left padding unless full screen | :2414, styles.css, app.md #39 | HeaderView (TitleLead) | todo |
| 14 | Sidebar toggle: panel-close icon when shown / panel-open when folded, tooltip "Hide the sidebar (⌘\\)" / "Show the sidebar (⌘\\)", toggles the sidebar | :2415-2417 | HeaderView.toggle | todo |
| 15 | The clock (Recent pages) right of the toggle: drawn by the sidebar slot (`makeRecentPages`), opening a top/project/note page as `openRecent` does | :2418, RecentPages.jsx | WorkspaceSidebar.makeRecentPages, WorkspaceModel.openRecent | todo |
| 16 | The header drags the window (title bar); its buttons, the tabs (`data-no-drag`) and overlays do not; double click per System Settings | styles.css, 153b08d | HeaderView (UI `.titleBar` rules, TitleBarDragView) | todo |
| 17 | Document strip: left padding 22 (sidebar shown) / 10, right 8 (document full screen: the window controls' width + 8); bottom-aligned tabs; hidden while the right pane is full screen | :2424 | HeaderView | todo |
| 18 | The + after the tabs (28×28 round, 18px "+", #4d4d4d, margin 0 0 3 6, hover wash): opens/closes the note picker; only with a workspace | :2440 | HeaderView.plus | todo |
| 19 | Full-screen button at the strip's end (28×28, radius 6, Expand / Collapse icon, tooltip "Full screen" / "Exit full screen (Esc)"), toggles the document's full screen | :2442 | HeaderView.full | todo |
| 20 | Right switcher: "Stage" and "Terminal" (13px, 600 ink when on with a 2px ink underline, else 400 #4d4d4d), gap 16, padding 16.5 20 0; click sets the right pane's mode | :2445-2451, RightPane.jsx RIGHT_MODES | HeaderView.modes | todo |
| 21 | Breadcrumb `Engelbart / project / …ancestors / current` (spec #83) | spec #83, a379eb2 | — | n/a: removed 2026-10-07 (the sidebar took the project's name and the workspaces; Workspace.jsx:57-59) |
| 22 | While the sidebar shows its own gear, the window's top-right gear hides (`data-sidebar-gear`) | :2249-2254 | WorkspaceContext.onSidebarGear | todo |

## C. Document tabs

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 23 | Tabs drawn as the Stage's (FluidTab): 34 high, as long as the title up to 220, min 44; the one in front white with a 10px rounded top and flared feet, the rest boxless with a #c9c9c9 hairline between two neither of which is in front | DocTabs.jsx, FluidTab.jsx | DocTabsView | todo |
| 24 | Workspace tab first, bold (600), workspace icon (14) before its name, no ×; its title = the workspace's own name cut to "Workspace"'s length (wsLabel: 8 chars + …), full name as tooltip; "Workspace" when unnamed | DocTabs.jsx:97-127, MATH-20 | DocTabsView | todo |
| 25 | Project-page tab: project icon before the project's current name | DocTabs.jsx:122, :2426 | DocTabsView | todo |
| 26 | An untitled note's tab title is grey #8f8f8f; others #171717 in front / #4d4d4d behind | DocTabs.jsx:111 | DocTabsView | todo |
| 27 | Every other tab has a × (20 round, #8f8f8f, tooltip "Close"); the × never starts a drag | DocTabs.jsx:124, FluidTab TabClose | DocTabsView | todo |
| 28 | Click → that tab in front | DocTabs.jsx:116 | DocTabsView.onSelect | todo |
| 29 | Press on a note tab selects it; after 4px of travel it drags: the tab follows the pointer clamped between Workspace's end (+2) and the last tab's end, lifted (#e6e6e6 when not in front, above the rest) | DocTabs.jsx:23-75 | DocTabsView.drag | todo |
| 30 | A neighbour gives way when the dragged tab's leading edge passes its middle (onMove: the tab takes its place); nothing moves past Workspace | DocTabs.jsx:68-75, moveTab :1178 | DocTabsView, WorkspaceModels.moveTab | todo |
| 31 | After each reorder every other tab that changed slot slides from where it was (160 ms cubic-bezier(.25,.1,.25,1)); the dragged one stays under the pointer; release settles it with the same slide | DocTabs.jsx:38-56, 78-89 | DocTabsView (FLIP) | todo |
| 32 | Hovering a tab not in front (not Workspace, not while dragging) shows a card after 650 ms (60 ms while moving along, warm for 400 ms after leaving): its whole name and "Note" / "Project page"; a press hides it | DocTabs.jsx:118-120, FluidTab useTabCard | DocTabsView.card (UI TabCardTimer) | todo |
| 33 | Closing a tab saves its document first; Workspace never closes; the last tab never closes; closing the one in front puts the last one in front | closeTab :1161 | WorkspaceModel.closeTab | todo |
| 34 | A note opens as a tab once (an open one comes to the front); `behind` adds it without bringing it forward | openTab :1153 | WorkspaceModel.openTab | todo |
| 35 | showWs: the Workspace tab in front (re-added first if somehow gone) | :1172 | WorkspaceModel.showWs | todo |
| 36 | A note renamed: its tab and its pane beside take the new name; a library row renamed: its tab too | :1440-1449, 2010-2023 | WorkspaceModel.renameNoteDoc/renameRow | todo |
| 37 | Project page tab: opened from the project menu or the clock, titled with the project's name, its document `project` | :1800-1803, docOf | WorkspaceModel.openProjectPage | todo |
| 38 | An archived version opens as a read-only tab `archive:<file>` in the middle (not on the Stage) | :123, 1372, 3ad5b51 | WorkspaceModel.onRowClick/goToVersion | todo |

## D. The + note picker

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 39 | Rows empty: New note first, then the 8 notes written in last (last_edited, else created) | notepick.js, notepick-model.test | NotePick.rows | todo |
| 40 | Typed: every note of the whole library whose name holds all the words, names starting with the text first then newest; New note last named as typed ("New note “x”") | notepick.js | NotePick.rows | todo |
| 41 | Tag 'open' for a note in a tab, else 'here' for one in this workspace (10px 500 uppercase 1.2 tracking #8f8f8f) | notepick.js, NotePicker.jsx:83 | NotePick.rows, NotePickerView | todo |
| 42 | Panel 320 wide, padding 8, white, 1px #c9c9c9, radius 8, shadow 0 12 32 rgba(0,0,0,.06), rise 160 ms, hung 6 below the + (cap 420) | NotePicker.jsx:65 | NotePickerView (UI FloatingPanel) | todo |
| 43 | Search field focused at once (magnifier, "Search notes", border #eaeaea / #c9c9c9 once typed); ↑/↓ wrap, Enter picks, Esc clears then closes; mouse move highlights (#f2f2f2) | NotePicker.jsx:22-55 | NotePickerView | todo |
| 44 | Picking a note opens it as a tab; New note makes one (named as typed, else the next Untitled Note n) in this workspace, linked, opened in front with the caret in its title when unnamed; the menu closes once done; a failure keeps it open (busy fades the field) and reports | NotePicker.jsx:38-49, makeNote :1881 | NotePickerView, WorkspaceModel.makeNote | todo |
| 45 | A press outside (not on the +) closes it; ⌘T in the middle canvas opens it as the + does (not when already open) | NotePicker.jsx:32, docKeys.newTab | NotePickerView, Keys | todo |
| 46 | Untitled notes' names grey in the list | NotePicker.jsx:80 | NotePickerView | todo |

## E. The pane beside (MATH-23)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 47 | A note's or workspace's mention clicked in either pane opens its document in pane 1 (replacing what was there); one that is the document in front is not opened again (scroll to it); a gone workspace does nothing | openDocBeside :1398, panes.js | WorkspaceModel.openDocBeside (UI Panes) | todo |
| 48 | Changing the workspace or the tab in front closes the pane beside | :315-317 | WorkspaceModel.besideFor | todo |
| 49 | Two panes share the column half each (min 240 each, a 1px #eaeaea rule left of the second); too narrow → the column scrolls sideways and scrolls smoothly to the pane just opened | :2291-2292, revealPane :1394 | DocColumnView | todo |
| 50 | The mention that opened the pane stays marked in the document in front (besideLink / besideWorkspace) | :2556-2557 | WorkspaceViewController.renderPanes | todo |
| 51 | Pane 1's × (26 round, "×" 18px #8f8f8f, "Close") closes it and saves what was typed in it | DocPane.jsx:62, closeBeside :1435 | DocPaneView, WorkspaceModel.closeBeside | todo |
| 52 | A pane beside keeps no scroll place: it opens at its top; its title renames that note / workspace | :2537, 2559-2561 | WorkspaceViewController | todo |
| 53 | A citation of a workspace or note (cite-open) opens it beside, then scrolls to the quoted passage and lights it (tries every 100 ms ×60, then ×20) | openCited :1411 | WorkspaceModel.openCited | todo |

## F. Document pane

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 54 | Title field: 500 22px/1.35, -0.3 tracking, ink; an untitled name is the placeholder, not the value; empty → "Untitled" placeholder | DocPane.jsx:20, 47-61 | DocPaneView.title | todo |
| 55 | Typing `/` or `\` in a title becomes `-` | DocPane.jsx:51 | DocPaneView.title | todo |
| 56 | Enter names it and puts the caret at the document's start; leaving names it; empty/unchanged/read-only → back to the shown name; Escape leaves the field only | DocPane.jsx:22-46 | DocPaneView.title | todo |
| 57 | A new workspace/note made unnamed gets the caret in its title (wantTitleFocus) | :307, 1620, 1885 | WorkspaceModel.wantTitleFocus | todo |
| 58 | The document in front's title renames: the workspace, the note, or (Project page) the project; an archived version's does nothing | renameDoc :2030 | WorkspaceModel.renameDoc | todo |
| 59 | "Opening…" (13px #8f8f8f centred) until the document is read; with no workspace the empty state instead | DocPane.jsx:68-71 | DocPaneView | todo |
| 60 | Empty project: "Nothing in <project> yet. A project holds a document, its sources, and any projects nested inside it." and "+ Project" (8 12 padding, #eaeaea border radius 8, 500 12.5px) which makes an untitled one and goes in | noWorkspace :2399 | DocPaneView.empty, WorkspaceModel.addTopic | todo |
| 61 | Conflict notice (another window saved over edits here): top 10 right 16, white card 1px #eaeaea radius 8 shadow 0 4 14 #0000000f, "Saved in another window while you were editing." + Keep mine (500 ink) + Take theirs | DocPane.jsx:65-71 | DocPaneView.conflict | todo |
| 62 | Footer under the document in front: Copy (15px #8f8f8f, ink while copied "Copied · n files · m missing"), then on a workspace's document Build and Clear (hidden while "Copied" shows); an archived version shows Restore alone; tooltips per spec | footer :2376 | DocPaneView.footer | todo |
| 63 | Copy's tooltip: "Copy current project" / "Copy the project page" / "Copy current note"; Build's "Hand this project to a coding agent"; Clear's "Archive this document and start it blank"; Restore's "Make this version the workspace's document again" | :2381-2395 | DocPaneView.footer | todo |
| 64 | The editor props per pane: autoCollapse on, viewScope/viewOf/onView only for pane 0, footer and walk card only for pane 0, readOnly for an archive, Build only when the doc is a workspace's (or there is a workspace) and not an archive | :2546-2565 | WorkspaceViewController.renderPanes | todo |
| 65 | The title row and the footer scroll with the document (DocEditor header/footer props) | DocPane.jsx:73 | DocPaneView | todo |
| 66 | ⌘F's card over the pane searched (pane 1's stops 52 short of its ×) | :2543, BESIDE_FIND | DocPaneView.find (editor's own find bar) | todo |

## G. Views per workspace (state.json `views`)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 67 | Tabs (less 'ws', {id,title}) and the tab in front saved per workspace 400 ms after a change (no write when unchanged) | :341-348, VIEW_SAVE_DELAY | WorkspaceModel.saveView | todo |
| 68 | Scroll places per document key, most recent last (the oldest go first when there are too many), saved 400 ms later or at once when the editor lets go | recordPosition :350 | WorkspaceModel.recordPosition | todo |
| 69 | Leaving the screen writes every pending view at once | :336-339 | WorkspaceModel.teardown | todo |
| 70 | Going to another workspace restores what it had open; its own name again shows its document | selectTopic :1464 | WorkspaceModel.selectTopic | todo |

## H. Documents: reading, saving, other windows

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 71 | Every pane's document is read once when first shown (not again while a read is under way); an archive by readArchive | :365-378 | WorkspaceModel.readMissing | todo |
| 72 | A document from before the router: answered `@bart` lines become `@chat` (migrateChatLines), saved as an edit; an archive read as it was | :371-375 | WorkspaceModel.readMissing | todo |
| 73 | An edit saves 400 ms after the last change; flushing saves now; a failure is reported | changeDoc :436, flush :404 | WorkspaceModel.changeDoc/flush | todo |
| 74 | Another window's save (`doc:changed` {projectId,key,text,revision}): no edits waiting → taken; edits waiting → the conflict notice and their save waits; an older revision or one during this window's save is held (DocSync) | :380-402 | WorkspaceModel (Doc.DocSync) | todo |
| 75 | Keep mine writes this window's text over theirs; Take theirs drops the edits and shows theirs | :418-433 | WorkspaceModel.keepMine/takeTheirs | todo |
| 76 | Leaving with a notice unanswered saves what was on screen; leaving saves every pending edit | :462-472 | WorkspaceModel.teardown | todo |
| 77 | Typing in this window's documents records the workspace written in (recordEdit): at once when it changes, then at most every 30 s; a workspace document beside counts for that workspace; an archive never; only typed edits | onDocChange :450-460 | WorkspaceModel.onDocChange | todo |

## I. @bart, Chat, Brainstorm, Discover, Create (asks)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 78 | An ask {askId, text, turns, choice, agent, name, routed, place, research, refine, steer} is asked of the pane it was written in (its key/ref; a note beside is answered in that note); everything pending is saved first | askBart :655-766 | WorkspaceModel.askBart | todo |
| 79 | Its answer replaces the pending `bart~> <askId>` line in whatever that document's text is by then (placeAnswer), open or not; Stop removes the line (a research box says "bart> Stopped.") | :660-666, 748 | WorkspaceModel.askBart | todo |
| 80 | Progress events (`engelbart:bart-progress` {askId, step, name, effort, movedUp, activity, log, lines}) update the run's row (askProgressed); entries are merged so a routed line keeps its level until the first step | :532-540, 669 | WorkspaceModel.onBartProgress | todo |
| 81 | @brainstorm ticks the walkthrough's step 2, @discover step 3 | :670-671 | WorkspaceModel.askBart | todo |
| 82 | A thread's title asked alongside (nameChat), written into its `bart# ` line when it comes, found by the ask (tries 20×100 ms); an empty line named from its first answer, else "New conversation"; Brainstorm names its own topic (retitle from `out.topic`); Discover started empty named from the direction | :672-726, 750-754 | WorkspaceModel.askBart (Doc.placeTitle/retitle) | todo |
| 83 | `@bart --build <request>` starts a full Build of the request (its card in the pending line's place); no request → "bart> **No Build.** Write what to build after --build."; a failure "bart> **No Build.** <why>" | :679, 727-738 | WorkspaceModel.askBart/buildFrom | todo |
| 84 | Discover settling a research direction: its research box line goes under the reply (researchLine) and, unless refining, a pending line the editor asks (boxOff: tries every 16 ms ×120) | :747-751, boxOff :630 | WorkspaceModel.askBart | todo |
| 85 | The Welcome's last card answered (`out.welcome == 'result'`): Discover starts on its last result (handOff tries every 100 ms ×30) | :756, handOff :603 | WorkspaceModel.handOff | todo |
| 86 | Create's files: each saved into the library and this workspace, then the first opened on the Stage, only while still in this workspace and this project | :757-759, 1313-1322, madeToOpen | WorkspaceModel.madeLanded | todo |
| 87 | A failure places "bart> **No answer.** <why>"; the run's entry always goes when it ends | :760-765 | WorkspaceModel.askBart | todo |
| 88 | The models (`bartModels`) are read at start, when the window comes forward, after an ask is sent, and on `engelbart:models-changed`; the editors get them | :514-523, 743 | WorkspaceModel.loadBartModels | todo |
| 89 | Stop on a run's row: `stopBart(askId)`; an error is reported | :2324 | WorkspaceEditorHost.stop | todo |
| 90 | The Stage's front (stageNow) goes with an ask only while the Stage shows (rightMode stage, no document full screen) | :230-235 | WorkspaceModel.stageNow | todo |

## J. Asks from a pdf highlight or a web box (MATH-27, MATH-70)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 91 | askHighlight: id `h<time36><rand6>`, a pending entry {askId, markId, page (none for web), rowId or url, question, agent 'bart'}, ref `{kind:'mark', id, rowId|url, page | source:'web'}`, highlight {quote, note, paper, pageText}, the Stage's front | :558-578 | WorkspaceModel.askHighlight | todo |
| 92 | Stopped → its box goes; failed → the box stays with "No answer." stripped from the reason (or "The run failed."); success → the entry (main's or askEntry) back to the Stage | :569-577, paperFailure | WorkspaceModel.askHighlight | todo |
| 93 | Running paper asks come back after a reload (`runningPaperAsks`), and `engelbart:paper-ask-done` ends them (failed → its reason, else gone); ended ones are remembered so a stale list brings none back | :583-598 | WorkspaceModel.paperAsks | todo |
| 94 | Continue in workspace: the passage, question and answer appended to this workspace's document as a thread (continueLines), the Workspace tab shown, a library paper linked | continueAsk :1967 | WorkspaceModel.continueAsk | todo |

## K. The router and Builds from the editor

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 95 | routeLine: the pending row says "Thinking · <level>" (agent 'router'); main's route answer, else the fallback (rule's agent, else the current conversation's, else Chat) marked `by:'error'` with why | :775-784 | WorkspaceModel.routeLine | todo |
| 96 | routeGone drops the run's row | :785 | WorkspaceModel.routeGone | todo |
| 97 | A Build from the editor: an @bart line handed to Build replaces its pending line with the card ("Starting a Build" meanwhile); a footer Build goes on a line after the thread (`after`, found again by its words, else at the end) | buildFromEditor :790 | WorkspaceModel.buildFromEditor | todo |
| 98 | buildFrom: everything saved first; buildStart {workspaceId, text, fromLine, routedFrom?, place {line,text,ref}}; the router told where it went (`routeHanded(routedFrom, 'build:<id>')`) | :618-626 | WorkspaceModel.buildFrom | todo |

## L. Build

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 99 | Builds of this project read at start (buildList) and kept from `engelbart:build`; a turn that ended drops its progress | :855-878 | WorkspaceModel.builds | todo |
| 100 | `engelbart:build-progress` with an activity: kept per Build, `log` entries appended (last 80) | :865-873 | WorkspaceModel.buildProgress | todo |
| 101 | `engelbart:build-diff` kept per Build; a card drawn before any asks once (buildReview) | :874-884 | WorkspaceModel.wantBuildDiff | todo |
| 102 | The footer's Build opens the Build panel hung from it (a second press closes it); Send saves everything, starts the Build of this workspace, appends its `build> <id>` line at the document's end, closes the panel | :2394, startBuild :902 | WorkspaceModel.startBuild, BuildPanelView | todo |
| 103 | "Automatically clear workspace": cleared after the Build froze its input (refused with a conflict: "Not cleared: this document was changed in another window. Keep yours or take theirs, then Clear."); attachments → reload | :912-923 | WorkspaceModel.startBuild | todo |
| 104 | A card's buttons: reply (text, interrupt, images), stop, resume, fix, discard, accept (refusal on the card), reject (confirm dialog), runshow, runstop, runstopone, runstopall; a call that fails is reported and returns false | onBuildAction :937 | WorkspaceModel.onBuildAction | todo |
| 105 | Preview: what the run step got running as a UI opens on the Stage (the first ends in front); nothing running → the Review dialog (diff, what did not run), its error if the review fails | :950-964 | WorkspaceModel.onBuildAction review | todo |
| 106 | Reject asks to confirm (BuildReject), then discards | :945, 2647 | BuildRejectView sheet | todo |
| 107 | Review dialog leaves the right pane uncovered (`aside` = right pane width + 1, 0 in full screens); its Open runs runshow | :2648 | BuildReviewView overlay | todo |
| 108 | `engelbart:build-run` for this project: a UI → a Stage tab (OPEN_IN_BROWSER), a terminal → the session adopted, the Terminal shown and that session in front; `closed` drops the session | :249-259 | WorkspaceModel.onBuildRun | todo |
| 109 | A post-it's Build popup (`engelbart:build-quick`) and its quick task's card (`engelbart:build-quick-open`), hung from the card's button, a second press closes; a quick task added to a workspace goes to the workspace's archived version | :831-854 | WorkspaceModel.postItBuild/quickTask | todo |
| 110 | Quick task started from the popup (buildStart kind 'quick'); promoted to a workspace (buildPromote) | :927-979 | WorkspaceModel.startQuick/promoteQuick | todo |
| 111 | goToVersion: reload, that workspace, its archived version opened in the middle | :891-897 | WorkspaceModel.goToVersion | todo |

## M. Clear, Restore, Copy

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 112 | Clear (B21): only on the workspace's own document; refused during a conflict ("This document was changed in another window: keep yours or take theirs first."); saved, clearWorkspace, revision seen, new text shown, reload | clearDoc :990 | WorkspaceModel.clearDoc | todo |
| 113 | Restore (B22): the same guard; restoreArchive; the Workspace tab shown; reload | :1006-1020 | WorkspaceModel.restoreVersion | todo |
| 114 | Copy: everything saved, copyDoc(ref) (the document with every mention's content in place), "Copied · n files · m missing" for 1.8 s | copyDoc :1027, copiedLabel :95 | WorkspaceModel.copyDoc | todo |

## N. Pictures

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 115 | Every `](img:<id>)` in any pane's text is read once (readImage) and drawn by the editors | :1041-1052 | WorkspaceModel.images | todo |
| 116 | A pasted picture saved (saveImage, its label as name) becomes a library row and its id goes back; reload; failure reported | pasteImage :1057 | WorkspaceModel.pasteImage | todo |

## O. What the sidebar is given (computed here)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 118 | Rows of this workspace: its context, then notes made in it, then what its document mentions (`@[Name]` by name, `(lib:<id>)` by id, pictures by id only), never what it removed, each once | rows :1096, mentioned :1074 | WorkspaceModels.railRows/mentionedRows | todo |
| 119 | The rows ordered by last opened (`engelbart.openedAt`, a note in front, the Stage's front, a sidebar row clicked; 400 kept) | byOpened :1120, noteOpen :1089 | SidebarModels.byOpened/noteOpened | todo |
| 120 | `findable`: the library less notes let go from their last workspace; `mentionable`: the agents first, then every row described (title, summary, facts "<kind> · edited <date>"), let-go notes marked trashed | :1125-1128, describe :103 | WorkspaceModels.describe, SidebarModels.letGoNotes | todo |
| 121 | inRail: a row is on this workspace's rail | :1131 | WorkspaceModel.inRail | todo |
| 122 | activeRowId: the note tab in front, else the Stage's front row when the Stage shows, else 'ws' | :1084 | WorkspaceModel.activeRowId | todo |
| 123 | A row that just arrived flashes 1.7 s | flash :277 | WorkspaceModel.flash | todo |
| 124 | The sidebar slot gets every Rail prop (project, roots, here, recent, visits, entries, counts, rows, folders, trash, post-its toggle, tour step, library request…) and its callbacks | :2458-2515 | WorkspaceSidebarState/Actions | todo |
| 125 | Sidebar folded (⌘\\ or its toggle) remembered across launches (`engelbart.sidebar.hidden`); dragging its edge resizes only the document | :286-287 | WorkspaceModel.railHidden | todo |

## P. Opening things (Stage)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 126 | openItem: a workspace row → Workspace tab; a note → its tab; anything on the Stage (onStage) → the Stage shown, the row opened (⌘-click: a tab of its own) | :1191-1198 | WorkspaceModel.openItem | todo |
| 127 | A sidebar row click: a child workspace → go there; an archive → its tab; a GitHub repo → its sandbox click (preview / terminal / both / start / details); else openItem; non-archives noted as opened | onRowClick :1369 | WorkspaceModel.onRowClick | todo |
| 128 | A link in a document opens on the Stage (never the default browser), ⌘-click in a tab of its own; a citation of a workspace/note opens beside instead | openLink :1227 | WorkspaceModel.openLink | todo |
| 129 | A file inside a library folder: looked up now; gone → "\"<name>\" is no longer in <folder> (<rel>)" and its chips go grey; else opened on the Stage | openFolderFile :1203 | WorkspaceModel.openFolderFile | todo |
| 130 | What opens on the right brings the right pane back from the document's full screen (showRight); a terminal link opens on the Stage and shows it | showRight :238, 242-246 | WorkspaceModel.showRight | todo |
| 131 | ⌘-clicked links the window would open (`browser:open-link` / stage open link) come to the Stage while this screen is active | :1356-1359 | WorkspaceModel (EventHub) | todo |
| 132 | The page in front: the library's answer (lookupLibraryItem) asked again when the page or the library changes; Save states none/lib/here; a made file's Save is Create's (made / made-saved "Library / Assets / <name>") | :1135-1145, 1324-1333 | WorkspaceModel.pageInfo/stageSave | todo |
| 133 | Save: a web pdf as a copy (addLibraryPdf), a plain page as a copy (addLibraryPage, its failure reported and nothing added), else by address; "Workspace" links it here | savePage :1995 | WorkspaceModel.savePage | todo |
| 134 | An @discover guide's paper: state none/lib/here (paperRow), + Save adds and links, + Workspace links, the filled bookmark unlinks (leaves the library) | :1148, 1984-1993, guide.js | WorkspaceModel.saveGuidePaper/unsaveGuidePaper | todo |

## Q. Zotero, folders, @create's files

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 135 | listFolder: Zotero's row lists the mirror (zoteroList), others the folder | :1244 | WorkspaceModel.listFolder | todo |
| 136 | A Zotero chip: its pdf on the Stage, else its DOI/URL in the default browser, else the error (zoteroChipAction) | openZotero :1245, zotero.js | WorkspaceModels.zoteroChipAction | todo |
| 137 | A pdf dropped on a Zotero chip becomes the item's pdf and opens; a download that is the paper opens here (`engelbart:zotero-downloaded`, while active) | :1340-1352 | WorkspaceModel.dropOnZotero | todo |
| 138 | Zotero finding/waiting sets reach the editors | :1241-1242 | WorkspaceModel.zoteroFinding/Waiting | todo |
| 139 | @create's files read once when an editor shows them (createdFile): name, type, path, saved, missing, text, a picture | readMade :1266 | WorkspaceModel.needMade | todo |
| 140 | Save a made file: saving… then saved {id,name} (into the library's Assets, linked here), reload; failure reported | saveMade :1288 | WorkspaceModel.saveMade | todo |
| 141 | Open a made file: on the Stage (gone → "\"<name>\" is no longer there") | openMade :1301 | WorkspaceModel.openMade | todo |
| 142 | Which made files a Stage tab shows (madeOpen) for the editor's grey rows | :1324-1325, madeAt :190 | WorkspaceModels.madeAt | todo |

## R. Agents, next place, ⌘J

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 143 | nav (recent, agents) read at start and on `engelbart:nav` | :1530-1537 | WorkspaceModel.nav | todo |
| 144 | Being in a workspace where an agent waits marks them seen (seenAgents) | :1539-1542 | WorkspaceModel.seeAgents | todo |
| 145 | The next place: only this project's; an agent waiting longest, else the recent workspaces in turn (nav.js nextPlace); named from the tree | :1545-1553, nav.js | SidebarModels.nextPlace | todo |
| 146 | Agent entries: this project's running/waiting asks, its Builds (buildState), Connect notes, repository builds; kept by marks (3 days, a day after a click, × until it changes; a Build in progress stays) | :1681-1695, sidebar.js | SidebarModels.agentEntries/repoEntries/keptAgents | todo |
| 147 | Counts per project (rollUp) and per other top-level project (from nav.agents) | :1696-1708 | SidebarModels.rollUp/summarize | todo |
| 148 | Going to an agent: an ask → its note/workspace at its line; a Build → its card (no flash), else its archived version; a quick task → its card with post-its shown; a repo → preview/terminal/details; Connect → its popup; marked clicked | goAgent :1716 | WorkspaceModel.goAgent | todo |
| 149 | An agent row's ×: put away until it changes; a finished Connect note dismissed; a repo's notification cleared | dismissAgent :1750 | WorkspaceModel.dismissAgent | todo |
| 150 | ⌘J: failed, then needs-you, then finished, oldest first, never the one just gone to, not viewed; none → the next place | goNextAgent :1760 | WorkspaceModel.goNextAgent | todo |
| 151 | Mark all seen: unseen asks seen per workspace, done Connect notes dismissed, unseen entries marked clicked, unread repo notes read | seenAll :1769 | WorkspaceModel.seenAll | todo |
| 152 | Agent marks remembered (`engelbart.agentMarks`, a week); the list re-checked each minute | :1688-1691 | WorkspaceModel.agentMarks | todo |
| 153 | revealAsk (Agent Viewer, `engelbart:agent-reveal`, taken once at start): a mark → its paper on the Stage at the quote; a note/workspace → in front, its line found (findAskLine, else findBuildLine) and shown (flash unless `flash:false`); gone → "This line is no longer here" / "This note is no longer here" / "This workspace is no longer here" / "This highlight's paper is no longer here" | revealAsk :1479 | WorkspaceModel.revealAsk | todo |
| 154 | The @ menu's workspaces ordered by `recent` (this project's), then tree order | mentionSpaces :1556 | WorkspaceModel.mentionSpaces | todo |
| 155 | The @ menu rows (rail.js mentionRows): verbs by first letter, the open page (its row, or fresh by its web name), 3 / 6 workspaces, Zotero when connected, 10 library rows ranked, this workspace's first, pictures last before typing | mentionItems :1566, rail.js | SidebarModels.mentionRows | todo |
| 156 | What the project's things say (bodies) read while the @ menu is open | useBodies, :1565 | WorkspaceModel.mentionOpen | todo |
| 157 | A mentioned workspace's peek: name, workspaces above, Bart waiting/running, edited at, its document as open here or saved | workspacePeek :1574 | WorkspaceModel.workspacePeek | todo |

## S. Keys

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 158 | ⌘J anywhere (capture: before the editor or the terminal), not repeated; also from a Stage page (`engelbart:next-workspace`) | :1597-1610 | Keys, WorkspaceModel.goNextAgent | todo |
| 159 | Ctrl+1–9: this project's top-level workspaces in order, anywhere | :1778-1791 | Keys | todo |
| 160 | ⌘1–9 switch the tabs of the side clicked last: the Stage's (tabAt), the terminal's own (left alone), else the document tabs; not inside the terminal | :2126-2146 | Keys | todo |
| 161 | Side tracking: a press or the keyboard moving into the middle canvas, the Stage or the terminal counts; a Stage page taking the keyboard is the Stage | :2049-2066, key-side.js | Keys (Doc.SideTracker) | todo |
| 162 | ⌘T / ⌘W / ⌘F / ⌘G belong to the middle canvas when it was clicked last (or in its full screen) and it shows: ⌘T opens the note picker, ⌘W closes the pane beside (clicked last) else the tab in front (never Workspace or the last), ⌘F opens find over the pane clicked last, ⌘G / ⇧⌘G step; ⇧⌘W is the window's | :2067-2124, docKeys | Keys | todo |
| 163 | Edit ▸ Find / Find Next / Find Previous reach the document when it has the keys | :2116-2122 | WorkspaceViewController (ctx.actions) | todo |
| 164 | ⌘\\ (or Ctrl+\\) toggles the sidebar, not repeated | :2238-2248 | Keys | todo |
| 165 | Escape in the document's full screen: what had it first (menus, editor menus, a focused field leaves), then leaves the full screen; never closes the workspace from there | :2147-2159 | Keys | todo |
| 166 | Escape elsewhere, unused, not in an editor that is active, a terminal or a field: closes the workspace (all projects) | :2160-2167 | Keys | todo |

## T. Layout and resizing

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 167 | Sidebar 220–520 (default 300), at most what leaves 280 for the document and 320 for the right pane; double-click its edge → 300 | :2178-2180, 2517 | WorkspaceLayout | todo |
| 168 | Right pane: half of what the sidebar leaves until its edge is dragged; 320 ≤ right ≤ window − sidebar − 1 − 280; double-click → half again | :2185-2186, 2571 | WorkspaceLayout | todo |
| 169 | Dragging the sidebar's edge freezes the right pane's width first (it keeps its width), the document gives | railDown :2188-2193 | WorkspaceLayout.railDrag | todo |
| 170 | Edges: 1px (the sidebar's transparent, the right's #eaeaea) with a 6px grab either side, col-resize cursor | Separator :114 | SeparatorView | todo |
| 171 | Under the header the sidebar and the page share #fafafa; the page is a white card with 12px left corners and a 1px rgba(0,0,0,.045) ring while the sidebar shows (square, no ring folded) | :2457, 2519 | PageCardView | todo |
| 172 | Right pane full screen (the Stage's or Terminal's arrows): takes the document's place and header column; the sidebar stays; switching modes keeps it; turning it on turns the document's off | :224-228, 2205-2208 | WorkspaceModel.stageFull | todo |
| 173 | Document full screen: no right pane (the sidebar stays, 2026-10-15); turning it on turns the Stage's off | :225-236, fc8c0c6 | WorkspaceModel.docFull | todo |
| 174 | The window's width followed live (resize) | :212-217 | WorkspaceViewController.layout | todo |

## U. Sidebar plumbing (callbacks this screen implements)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 175 | Starred: read for the project, kept from `engelbart:starred`, set at once then main's answer | :289-300 | WorkspaceModel.starRow | todo |
| 176 | Folders: read, kept from `engelbart:folders`; add (flash the last), remove, create, rename, delete | :1811-1827 | WorkspaceModel.folders | todo |
| 177 | linkIds: link to this workspace (picked flag), reload, flash the last, report a sandbox error | :1836-1842 | WorkspaceModel.linkIds | todo |
| 178 | addInput (addOrFind: an "Already in the library as “…”" refusal answers with the row), into a folder or here; pickFromDisk (each its own row, problems listed); pickRepo | :1844-1926, add-or-find.js | WorkspaceModel.addInput… | todo |
| 179 | Dropped files/pictures/links: each a row in order (addDropped), all linked here, problems joined " · " | :1866-1876, drop.js | WorkspaceModel.addDroppedHere | todo |
| 180 | trashRow: off this workspace (never out of the library); its tab closes | :1929-1938 | WorkspaceModel.trashRow | todo |
| 181 | mentionPicked: an @ menu pick links the row (picked) or adds the open page under the mention's name | :1943-1947 | WorkspaceModel.mentionPicked | todo |
| 182 | unmention (MATH-57): an edit that removes a picked item's last mention unlinks it; ⌘Z bringing it back relinks | :1950-1962, pickedChanges | WorkspaceModel.unmention | todo |
| 183 | create/rename/delete/restore workspace; delete puts the one above (else below, else parent) in front when the open one is inside it; rename project | :1615-1673 | WorkspaceModel | todo |
| 184 | onOpenProject from the sidebar: that project at its last workspace (from nav.recent) | :2462 | WorkspaceSidebarActions.openProject | todo |

## V. Walkthrough and tour

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 185 | Getting started state read per project; ticks/unticks/hide applied at once then main's answer; nothing once hidden | :479-497 | WorkspaceModel.walk | todo |
| 186 | The walk card above the Welcome workspace's document (stepsHere) with "Write your thoughts…" on an empty last line; drawn by the sidebar slot | :2337-2374, getting-started.js | WorkspaceSidebar.makeWalkCard | todo |
| 187 | Walk steps: open Library (tick 1), Write → caret at the end, Brainstorm → @brainstorm started unless one runs, Discover → on the last result or started, a paper → the Stage | :2341-2372 | WorkspaceModel.walkActions | todo |
| 188 | Tour request (import's Open library): its workspace, its tab or the Workspace tab, then the tour unless seen; taken once per request n; paused under popups | :2218-2236 | WorkspaceModel.takeTourRequest | todo |

## W. Post-its

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 189 | Post-its float over everything (PostIts slot) and are hidden/shown from the sidebar's toggle, remembered (`engelbart.postIts.hidden`) | :282-284, 2652 | WorkspacePostIts | todo |
| 190 | The trash rect (the sidebar's foot) sent whenever it may have moved; none while not active or folded | :2259-2272 | WorkspaceModel.trashRect | todo |
| 191 | +Note on a card opens the note as a tab after a reload; a link from a card opens on the Stage | :2661-2662 | WorkspacePostIts hooks | todo |

## X. Sandboxes

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 192 | A sandbox shell (`engelbart:open-sandbox-terminal` {session, show}) adopted as a tab of this project's terminal, shown when asked, its tab in front | :262-273 | WorkspaceModel.onSandboxTerminal | todo |

## Y. Hosts for the wave-1 views

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 193 | DocEditorHost: text changes → onDocChange; saves through the screen; textOf/change for runs handed on | :2547-2548, 2326 | WorkspaceEditorHost | todo |
| 194 | DocEditorHost: mentionable, mentionItems, listFolder, fileState, picked, mention menu open, makeNote (behind) | :2296-2309 | WorkspaceEditorHost | todo |
| 195 | DocEditorHost: models, ask, route, routeGone, stop, build, buildView (Build's card) | :2316-2324, 2551-2554 | WorkspaceEditorHost, BuildCardHost | todo |
| 196 | DocEditorHost: paperState/save/unsave, made files, open link/row/beside/workspace/file/zotero/made, image/paste/drop, copy, viewOf/reportView, error | :2310-2335 | WorkspaceEditorHost | todo |
| 197 | StageHost: library rows, inRail, lookup, readStageFile, library file, annotations, stage tabs (state.json `stages`), pick paths, open external, the pdf viewer, asks, mentions, citations, page/front/tabs changes, showStage, keysToDoc, previews | RightPane.jsx, Stage.jsx props | WorkspaceStageHost | todo |
| 198 | StagePDFViewing over the PDF package's PaperViewController, its PaperHost writing ink through the Stage's callbacks and asking through the Stage | Stage.jsx PaperView props | PaperAdapter | todo |
| 199 | TerminalHost: project id and code directory, links to the Stage, keysToDoc, full screen arrows, sandbox touch | RightPane.jsx, TerminalPane props | WorkspaceTerminalHost | todo |
| 200 | Right pane: the Stage and the Terminal both stay mounted, the one not shown hidden (`visible`) | RightPane.jsx | RightPaneView | todo |

## Z. Covering rules

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 201 | Popups over native views (note picker, tab card, Build panel, review, reject, conflict notice) sit above the Stage's WKWebView, PDFKit and the terminal: child panels / views ordered above (data-overlay result) | data-overlay rule, memory | FloatingPanel / view order | todo |
| 202 | Under the header the Stage's page stops short of the window's resize strips (Stage handles it) | StageController.windowEdge | — | n/a: the Stage's |
