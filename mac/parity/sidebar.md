# Parity ledger: the sidebar (`mac/Packages/Sidebar`, module EngelbartSidebar)

Sources (read in full): `src/renderer/workspace/Rail.jsx`, `SidebarPanels.jsx`, `SidebarTour.jsx`, `GettingStarted.jsx`,
`RecentPages.jsx` (the clock: its panel is the sidebar's), `useAddRun.js`, `useBodies.js`, `model/sidebar.js`, `model/rail.js`
(the searches), `model/nav.js`, `model/add-or-find.js`, `model/getting-started.js`; the sidebar parts of `screens/Workspace.jsx`
(how it fills Rail's props, folders, agent marks, visits, ⌘J, Ctrl+1–9); `screens/Home.jsx` ItemPeek (the peek card's
content); `styles.css` `.sb-*`, `.hov-*`, `.rail-field`, `@keyframes added/rise/sb-outline/sb-number`. Design:
`design/sidebar-mockup/Sidebar.html` + `BUILD-NOTES.md` (the 2026-10-13 rebuild, "exactly how I want it"),
`design/goal-canvas/SIDEBAR-TWEAKS.md` (2026-09-22/23 history). Commits: 2289464, 406c973, b640639, fd4f980, b792dac,
d1c57cc, d69af0a, d41b6ca (and their predecessors listed by `git log -- src/renderer/workspace/Rail.jsx`). Tests:
`sidebar-model`, `sidebar-plan` (with the mockup's own script: replayed here as a fixture the JS produced),
`sidebar-ui`, `rail-model` (sidebar parts), `nav-model`, `add-or-find`, `getting-started` (model part). Memory notes:
`sidebar-built-projects`, `ui-round-10-16`, `no-horizontal-dividers`, `sidebar-mockup-v2`, `rail-add-designs`,
`add-to-library-design`, the sidebar sections of `engelbart-desktop-experiment`.

**What the code at 9413a56 is, and what the task text described.** The task brief lists the 2026-09-23 sidebar (a grey
head with "Workspace", sections Notes/Websites/GitHub/Files/Sub-Workspaces, Collapse all, Copy at the lower left, the
next row). That sidebar was replaced on 2026-10-13 (commit 2289464, from `design/sidebar-mockup/Sidebar.html`) and
again tuned on 2026-10-15/16/17. The code wins (ARCHITECTURE §1): those older behaviours are listed at the end as
`n/a: superseded`, each with what replaced it.

Swift paths are under `mac/Packages/Sidebar/Sources/EngelbartSidebar/` unless written in full. Tests are in
`mac/Packages/Sidebar/Tests/EngelbartSidebarTests/`.

## A. Pure models

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| 1 | `indexTree(roots)`: id → { node, parent, level (2 at the top), path (ids from level 2 down) } | sidebar.js:283 | Model/SidebarModel.swift | todo |
| 2 | `within(index, id, from)`: id is `from` or lies under it | sidebar.js:300 | Model/SidebarModel.swift | todo |
| 3 | `openPath(index, id)`: the way down to it, and it when it has children; unknown → empty | sidebar.js:306 | Model/SidebarModel.swift | todo |
| 4 | `toggleOpen`: an open project with children folds with everything under it; a folded one opens and folds its siblings' branches (accordion) | sidebar.js:315 | Model/SidebarModel.swift | todo |
| 5 | `projectSlots`: ≤3 level-2 projects in the tree's order; the held shortlist kept (a click never reorders); the focus's branch takes the last place; empty places filled by recency, ties by tree order | sidebar.js:334 | Model/SidebarModel.swift | todo |
| 6 | `projectPlan`: siblings dealt before children in tree order; a group >5 shows 4 and More; ten lines in all counting each More and the section's More; → order, shown, hidden, visible, opened, guide (deepest opened), rows | sidebar.js:354 | Model/SidebarModel.swift | todo |
| 7 | The plan equals the mockup's own plan for every project of its tree, walked down and back up (79 steps), and its chevron toggles | sidebar-plan.test.cjs | Tests/Fixtures/mockup-walk.json | todo |
| 8 | `shortcutProjects` (first nine level-2 ids) and `shortcutOf` (1–9, else 0) | sidebar.js:400 | Model/SidebarModel.swift | todo |
| 9 | `buildState`: setting-up/queued/running/accepting → running; needs-you/review → needs; failed/conflict/interrupted/escalated → failed; else done | sidebar.js:414 | Model/SidebarModel.swift | todo |
| 10 | `agentEntries`: this project's running/waiting asks (not kind build), its Builds by state with BUILD_STATE words, Connect notes (warn/needs → needs, else unseen); newest first | sidebar.js:428 | Model/SidebarModel.swift | todo |
| 11 | `repoEntries`: the bell's repository builds as rows (starting → running, failed → failed, else unseen; read and not running → viewed); title the library row's name or "Repository" | sidebar.js:452 | Model/SidebarModel.swift | todo |
| 12 | `summarize`: running + ready (needs/unseen/failed not viewed) | sidebar.js:468 | Model/SidebarModel.swift | todo |
| 13 | `markAgent`: sets clicked/dismissed at a time; drops marks older than a week | sidebar.js:484 | Model/SidebarModel.swift | todo |
| 14 | `keptAgents`: dismissed since it changed → gone (not a Build in progress); not running and >3 d old, or >1 d past a click → gone; clicked since it changed → viewed | sidebar.js:505 | Model/SidebarModel.swift | todo |
| 15 | `buildInProgress`: running and kind build/quick | sidebar.js:503 | Model/SidebarModel.swift | todo |
| 16 | `rollUp`: each project's summary with everything under it, each agent once; agents in no project left out | sidebar.js:524 | Model/SidebarModel.swift | todo |
| 17 | `summaryOf(ids)`: several projects together, each agent once | sidebar.js:537 | Model/SidebarModel.swift | todo |
| 18 | `countLabel` (9+) and `libraryLabel` (999+) | sidebar.js:543 | Model/SidebarModel.swift | todo |
| 19 | `recentPages`: the top page first, then visits newest first, once each, ≤10, gone projects/notes left out; `visited` moves to the front, keeps 60; `crumbFrom` | sidebar.js:555 | Model/SidebarModel.swift | todo |
| 20 | `sourceIcon`: note, git, website, image, html, pdf, folder, file | sidebar.js:583 | Model/SidebarModel.swift | todo |
| 21 | `byOpened` (last opened, else created, ties in order) and `noteOpened` (keeps the 400 newest) | sidebar.js:600 | Model/SidebarModel.swift | todo |
| 22 | `folderRows`: five, or four and More | sidebar.js:614 | Model/SidebarModel.swift | todo |
| 23 | `versionsOf` (a project's own archives, newest first, "Untitled" title) and `archivedVersions` | sidebar.js:240-261 | Model/SidebarModel.swift | todo |
| 24 | `sinceWords`: just now, 4 min ago, 2 h ago, 3 d ago, '' | sidebar.js:228 | Model/SidebarModel.swift | todo |
| 25 | `workspaceActivity` (own/within: edited or typed in `recent`) and `pathTo`, `countWorkspaces` | sidebar.js:106-179 | Model/SidebarModel.swift | todo |
| 26 | Pre-10-13 helpers still exported and tested: `sourceKind`/`sourceGroup`/`sourceGroups`/`fitGroups`, `recentWorkspaces`, `fitChildren`, `inboxEntries`, `agentGroups` | sidebar.js:19-225 | Model/SidebarModel.swift | todo |
| 27 | `since` (panel times): now, 4m, 2h, 3d | SidebarPanels.jsx:273 | Model/SidebarModel.swift | todo |
| 28 | `looksAddable`: https, arXiv, DOI, ssh/git remotes, user@host:path, ~/ / file://, a bare host (not a file's bare name); quotes stripped; whitespace → no | rail.js:15 | Model/RailModel.swift | todo |
| 29 | `parseSources`: split on commas/lines/spaces; a ~/ or / path with spaces tried whole with `split` words; each not-one says `"x" is not a link or a path` | rail.js:31 | Model/RailModel.swift | todo |
| 30 | `searchRows`: empty → four not here, no notes, no pictures; typed → every match ranked (name starts, name holds, place/kind, summary, body); an address → the one row main found or a fresh row; a bare host searched as text first, then main's row | rail.js:81 | Model/RailModel.swift | todo |
| 31 | `bodyMaps`: lowercased once | rail.js:53 | Model/RailModel.swift | todo |
| 32 | `libraryPanelRows`: the chip narrows first; empty → the 40 last edited; typed → searchRows over that kind; a pasted link is main's answer whatever the chip | rail.js:110 | Model/RailModel.swift | todo |
| 33 | `letGoNotes` (MATH-58): notes trashed from every workspace that held them are left out of the search (rule from Store's ProjectHolds.letGo) | rail.js:125 | Model/RailModel.swift | todo |
| 34 | nav.js `nextPlace`: the longest-waiting agent's workspace (not here), else recent in turn; `placesToGo`; `ago`; `flatWorkspaces`; `findWorkspaces` (every word, starts first) | nav.js | Model/NavModel.swift | todo |
| 35 | `addOrFind`: an "Already in the library" refusal answers with the library's row (EXISTS row, else lookup), anything else throws | add-or-find.js | Model/AddOrFind.swift | todo |
| 36 | getting-started.js: STEPS, stepsHere, firstOpen, libraryTabs, stepMeta, discoverPapers, EMPTY_HINT | getting-started.js | Model/GettingStartedModel.swift | todo |
| 37 | Kind/chip rules (libraryCounts, LIBRARY_CHIPS, kindLabel, isUntitled) come from EngelbartDoc | kind.js, names.js | (Doc) | todo |

## B. The sidebar (Rail.jsx)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 38 | The aside: `width` from the Workspace, padding 0 8, background #fafafa, column; `hidden` → not drawn, state kept | Rail.jsx:767 | SidebarView.swift | todo |
| 39 | Head (height 36, gap 2): the top-level project's name (600 15px #171717, ellipsis) and a grey chevron (14, #9b9b9b) that never turns, in a 30-high button (padding 0 8, radius 6; #ececec while its menu is open, hover #ececec) | Rail.jsx:769-790 | SidebarView.swift | todo |
| 40 | Head: Settings (gear) then New note (compose) icon buttons 28×28, radius 6, #5c5c5c → #171717 on #ececec; New note disabled with no project open here | Rail.jsx:792-793 | SidebarView.swift | todo |
| 41 | The head's name renamed in place: a white field with #c9c9c9 border, radius 6; Enter/leave keeps, Escape restores, / and \ become - | Rail.jsx:770-775, SidebarPanels.jsx:542 | SidebarView.swift, RenameField | todo |
| 42 | Fixed rows (padding-top 4, gap 1): Agents (its pill), Library (its size 12px #8f8f8f, 999+), Search; each active while its panel is open | Rail.jsx:798-802 | SidebarView.swift | todo |
| 43 | A row: 30 high, radius 6, padding 0 6 0 8 (indented 0 6 0 10), icon box 18 (margin-right 10, #5c5c5c, #171717 active), label 14.5 (indented 13.5) #262626 (indented #4d4d4d, faint #9b9b9b, strong #171717 500) | Rail.jsx:356-385 | RowView.swift | todo |
| 44 | Row hover #efefef; active #e6e6e6 (hover #e0e0e0); 120 ms | styles.css:111-114 | RowView.swift | todo |
| 45 | A row that just arrived flashes #e6f0fd → transparent over 1600 ms ease-out | Rail.jsx:377, styles.css:56 | RowView.swift | todo |
| 46 | Agents pill: number in a 22×22 rounded square (radius 4); running: outline breathing #8f8f8f↔#eaeaea over 1.8 s, text #4d4d4d; all ready: filled #eaeaea, #171717; 9+; none → no pill; tooltip "n to look at, m running" | SidebarPanels.jsx:259, styles.css:147-155 | Controls.swift | todo |
| 47 | Section head (margin-top 12, 30 high): the name 500 13px #8f8f8f, its chevron after it; hover → #4d4d4d; a click folds the section, remembered | Rail.jsx:400-411 | SidebarView.swift | todo |
| 48 | Projects head: ⌘J (12px #8f8f8f, hover wash) "Next agent needing attention" tooltip → next agent; + "Create project within <top>" | Rail.jsx:806-809 | SidebarView.swift | todo |
| 49 | Projects: "No projects yet" (13px #a3a3a3) when there are none | Rail.jsx:812 | SidebarView.swift | todo |
| 50 | Project rows per the plan; level >2 indented, no icon; level 2 the workspace icon; `data-level`; untitled names faint | Rail.jsx:594-650 | SidebarView.swift | todo |
| 51 | The row here is active; an ancestor of here whose group is folded/out of room is bold ("holds") | Rail.jsx:598-599 | SidebarView.swift | todo |
| 52 | Right tools (gap 5, margin-left 6): + slot 22 (on hover, never at level 4 or while renaming), count slot 22, chevron slot 18 | Rail.jsx:629-635, styles.css:127-135 | SidebarView.swift | todo |
| 53 | Project count: a bare number 12px; running → #8f8f8f pulsing opacity 1↔.4 (1.8 s); ready → #171717; 9+ | SidebarPanels.jsx:266, styles.css:150-154 | Controls.swift | todo |
| 54 | Chevrons 18×18 radius 4 #9b9b9b (hover #e0e0e0 bg, #4d4d4d): down while open, up while folded (rotated 180°, 160 ms); a level-2 project you are not in shows its chevron only on hover | Rail.jsx:343, styles.css:138-144 | Controls.swift | todo |
| 55 | Children under an open row, indented 24 (level 3) or 22 (level 4); a guide line (1px #dcdcdc, 2 from top/bottom, x 15.5 / 10.5) only beside the deepest open group | Rail.jsx:644, styles.css:157-160 | SidebarView.swift | todo |
| 56 | A group's hidden children → "... More" (indented) with their count, opening Siblings beside it; the section's hidden level-2 → "... More" opening Projects | Rail.jsx:646, 814 | SidebarView.swift | todo |
| 57 | More row: "..." + "More" #8f8f8f (hover #4d4d4d), active while its panel is open | Rail.jsx:388-397, styles.css:116 | RowView.swift | todo |
| 58 | Click a project → goes there (quiet hover first); double click → rename in place; right click → Open / Create project within X (disabled at level 4, tooltip "Projects go four levels deep") / Rename / Delete (red) | Rail.jsx:581-592, 624-626 | SidebarViewController.swift | todo |
| 59 | Chevron press: an open project with no room for its children opens Siblings instead; else toggleOpen | Rail.jsx:575-579 | SidebarViewController.swift | todo |
| 60 | What is open follows where you are (openPath) and resets when here changes | Rail.jsx:504-506 | SidebarViewController.swift | todo |
| 61 | Recency of each level-2: the tree's edited / state.json recent within it, and the clock's project visits | Rail.jsx:509-519 | SidebarViewController.swift | todo |
| 62 | The shortlist is remembered per top-level project (`engelbart.sidebar.slots`) and written back only when it changes | Rail.jsx:520-526 | SidebarViewController.swift | todo |
| 63 | Hover card: resting 350 ms on a folded project with children shows them beside the sidebar (90 ms to switch to another, gone 180 ms after the pointer leaves row and card); not while renaming or another panel is open; not from its + / chevron | Rail.jsx:532-543, 603-607 | SidebarViewController.swift, Panels/ProjectFlyout.swift | todo |
| 64 | Tooltips after 350 ms: a level-2 project's "⌃n Toggle project with Ctrl + n" (no panel open), a +'s label; gone at once | Rail.jsx:545-557, 870-872 | SidebarViewController.swift, Panels/Tip.swift | todo |
| 65 | Escape with a hover card, tooltip or peek showing puts it away and goes no further (never leaves the project) | Rail.jsx:560-572 | SidebarViewController.swift | todo |
| 66 | Scrolling the sidebar puts away peeks, hover cards and tooltips | Rail.jsx:796 | SidebarView.swift | todo |
| 67 | Sources head: + "Add sources to this project and library" (#8f8f8f) only with a project here | Rail.jsx:828-830 | SidebarView.swift | todo |
| 68 | This project's folder (named after the project here, else "This project"), open by default; then the person's folders, folded by default; folds remembered (`folder:<id>`) | Rail.jsx:833-834 | SidebarView.swift | todo |
| 69 | A folder row: folder icon; its + (on hover, only while open) "Add sources to <name>"; its chevron | Rail.jsx:701-728, styles.css:164-165 | SidebarView.swift | todo |
| 70 | A folder's rows (indent 24): five or four and "... More" (opens Sources beside it); no icon beside a file in a folder (2026-10-15) | Rail.jsx:669-740 | SidebarView.swift | todo |
| 71 | An empty project folder offers "+ Note" (13.5 #8f8f8f) | Rail.jsx:733-735 | SidebarView.swift | todo |
| 72 | A source: click opens it; double click renames; hover 350 ms peeks (not while a panel is open); its minus (on hover) takes it out of the folder, or off this project when it is here; right click: Open, Rename, Add to <folder> (≤6 folders not holding it), Remove from … | Rail.jsx:657-694 | SidebarViewController.swift | todo |
| 73 | A source row is draggable into the document: it writes the library drag (LIB_DRAG_TYPE + the mention) | Rail.jsx:686-687, d41b6ca | RowView.swift (NSDraggingSource) | todo |
| 74 | A user folder: double click renames; right click Rename / Delete folder (red) | Rail.jsx:716-721 | SidebarViewController.swift | todo |
| 75 | "Create new" (folder-plus icon) opens the new-folder dialog | Rail.jsx:835 | SidebarView.swift | todo |
| 76 | Files, pictures or links dropped on Sources become rows of this project (2px #c9c9c9 inset ring while over); a sidebar row dropped on the sidebar is refused | Rail.jsx:745-755, 820-827 | SidebarView.swift | todo |
| 77 | Foot (margin 6 0 10): "Hide stickies" / "Show stickies" (sticky icon, dotted while hidden), a switch; the trash (16) only while it holds something, opening the trash panel | Rail.jsx:842-866 | SidebarView.swift | todo |
| 78 | While a sticky is dragged: the foot turns #f0f0f0 (#e6e6e6 over) with a 1px #dedede inset ring and reads "Drop here to throw it away"; the foot is the drop target (`trashView`) | Rail.jsx:847-850 | SidebarView.swift | todo |
| 79 | A press on a row does not move the keyboard there | Rail.jsx:326-338 | RowView.swift | todo |
| 80 | Folds kept for the next launch in `engelbart.sidebar.open` (`section:<key>`, `folder:<id>`) | Rail.jsx:315-324 | Model/SidebarStorage.swift | todo |
| 81 | One panel beside the sidebar at a time, hung at the row's height; a second press on what opened it closes it; opening one drops peeks and hover cards | Rail.jsx:466-476 | SidebarViewController.swift | todo |
| 82 | `libraryRequest` {n, chip}: opens Library on that chip (the Welcome walkthrough); `onPanel(kind)` told when a panel opens | Rail.jsx:478-483 | SidebarViewController.swift | todo |
| 83 | Tour step 0 holds Library's panel open (only the one it opened is shut after); steps 1–2 unfold Sources | Rail.jsx:487-496 | SidebarViewController.swift | todo |

## C. Panels (SidebarPanels.jsx)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 84 | Floating panel: white, 1px #e6e6e6, radius 10, shadow 0 12 32 /.08 + 0 2 6 /.04, rise 140 ms; placed beside its anchor inside the window, capped | SidebarPanels.jsx:78-89 | (UI FloatingPanel) | todo |
| 85 | Layers: Escape is the newest panel's; a press elsewhere closes it unless inside a newer layer or on what opened it | SidebarPanels.jsx:35-75 | (UI FloatingPanel) | todo |
| 86 | Centered dialog over a veil rgba(23,23,23,.12), at 14vh, radius 12, 1px #e2e2e2, shadow 0 16 48 /.16 | SidebarPanels.jsx:92-104 | Panels/Centered.swift | todo |
| 87 | Panel head: title 600 13px, count 12 #8f8f8f when >0, padding 12 14 6 | SidebarPanels.jsx:108 | Panels/PanelParts.swift | todo |
| 88 | Panel row: 42 high with a meta line (else 32), radius 6, hover #f3f3f3, active #efefef; icon 16 #4d4d4d; title 13.5; meta 12 #8f8f8f; actions on hover | SidebarPanels.jsx:132-153 | Panels/PanelParts.swift | todo |
| 89 | Search field in a panel: 14 search icon, 13.5 text, border #eaeaea → #c9c9c9 with text, radius 7, × clears; focused when the panel shows | SidebarPanels.jsx:175-190 | Panels/PanelParts.swift | todo |
| 90 | Peek: after 350 ms (90 ms switching) on a row, a 360-wide card beside the panel/sidebar edge (left of the row when no room), padding 14 16 16, 1px #c9c9c9, radius 8; the pointer may cross onto it; gone 180 ms after leaving; preview fetched once per row and edit | SidebarPanels.jsx:208-254 | Panels/Peek.swift | todo |
| 91 | Peek content (Home's ItemPeek): kind (9px caps), name 500 14.5, source (mono 11.5), local folder or missing (struck), summary, a note's text, files, lines, which projects hold it (clickable) | Home.jsx:90-124 | Panels/Peek.swift | todo |
| 92 | Agents panel (360 wide, cap 620): groups Running, Failed, Needs you, Finished (unseen+done); "Mark all as seen" when something unseen; empty → "Nothing yet. When an agent finishes or asks you something, it shows here."; foot "Next agent needing attention ⌘J" | SidebarPanels.jsx:303-370 | Panels/AgentsPanel.swift | todo |
| 93 | Agent row: icon by kind (connect library, repo git, bart/brainstorm/discover chat, else agents), title 14 (wave while running), its crumb (path or "A sticky", a repo build's state, a Connect note's did), since(at) and a black 7px dot while waiting; × (top right, on hover) not on a Build in progress; refreshed every 30 s | SidebarPanels.jsx:304-351 | Panels/AgentsPanel.swift | todo |
| 94 | FitCrumb: a path that does not fit loses its front a level at a time to "./" | SidebarPanels.jsx:284-295 | Panels/PanelParts.swift | todo |
| 95 | Library panel (360, cap 600): "Library" + count; search "Search the library, or paste a link"; chips; "Recent <noun>" heading before typing; rows with Glyph; ↑↓ Enter; Tab to the chips | SidebarPanels.jsx:435-537 | Panels/LibraryPanel.swift | todo |
| 96 | Library chips: All + kinds with something under them; one on; pressing the one on → All; counts shown only when every count fits; ←→ move, Space/Enter pick, focus back to the search | SidebarPanels.jsx:380-428 | Panels/LibraryPanel.swift | todo |
| 97 | Library rows: a press opens (and closes the panel); + "Add to this project" (or "In this project"); a fresh link → "Add" adds it; hovering peeks; empty texts per chip/typed; errors in red 12px | SidebarPanels.jsx:507-531 | Panels/LibraryPanel.swift | todo |
| 98 | "Open full library" foot → the all-projects screen | SidebarPanels.jsx:533 | Panels/LibraryPanel.swift | todo |
| 99 | Library as a picker (beside the add picker): leaves out what is there, a press adds, × closes, no foot | SidebarPanels.jsx:468-470, 501 | Panels/LibraryPanel.swift | todo |
| 100 | ProjectTree: level-2 icon, counts, chevrons (on hover below level 1 when not in it), guide line, the context root bold, archived versions (archive icon, grey, "Cleared <since>") under their project; a search matches a row or anything in it | SidebarPanels.jsx:572-620 | Panels/ProjectTree.swift | todo |
| 101 | Projects panel (Projects' More, 340): count, + "Create project", "Find a project", every level-2 folded but yours; "No project by that name." | SidebarPanels.jsx:632-650 | Panels/ProjectTree.swift | todo |
| 102 | Siblings panel (a level's More, 320): every sibling there, open, foldable | SidebarPanels.jsx:653-663 | Panels/ProjectTree.swift | todo |
| 103 | Project flyout (270, cap 440): the project and everything in it, open, no chevrons; guide only beside the deepest group | SidebarPanels.jsx:670-684 | Panels/ProjectTree.swift | todo |
| 104 | Tip: 240 max, under the anchor (+5) or above (−45), left = anchor+28; white, 1px #eaeaea, radius 6, 12px #4d4d4d; a key cap (⌃n) | SidebarPanels.jsx:687-692, styles.css:169-171 | Panels/Tip.swift | todo |
| 105 | Sources panel (a folder whole, 330): title + count, a search past 8 rows ("Find in X"), each row's icon, the open one marked, minus removes, peeks | SidebarPanels.jsx:700-729 | Panels/SourcesPanel.swift | todo |
| 106 | Add picker (320, padding 8): "Search library" (focused), the five newest not there yet (no pictures) or the typed matches, "Nothing matches", "... More" opening the library beside it | SidebarPanels.jsx:745-864 | Panels/AddPicker.swift | todo |
| 107 | Add picker: "Upload URL or path" with a +, several at once (parseSources), "Add source(s)" only when something can be added; what could not stays in the field with why | SidebarPanels.jsx:793-813, 866-873 | Panels/AddPicker.swift | todo |
| 108 | Add picker: what was added listed under the field; "Add from GitHub" (the GitHub pane); "Upload or add files" (the file picker) | SidebarPanels.jsx:815-889 | Panels/AddPicker.swift | todo |
| 109 | Add picker hides itself 180 ms after the pointer is >12 pt outside it, the library beside it, a peek and the +; never while adding, in GitHub, or with a link typed; Escape and a press elsewhere still close it (not while busy) | SidebarPanels.jsx:757-781, 839 | Panels/AddPicker.swift | todo |
| 110 | Enter in the picker's search picks the row, or moves a typed link into the link field | SidebarPanels.jsx:830-835 | Panels/AddPicker.swift | todo |
| 111 | No line between the picker's library and the rest (2026-10-14) | SidebarPanels.jsx:865 | Panels/AddPicker.swift | todo |
| 112 | Project menu (under the name, 230): Switch project › (opens on hover/click; the list beside it with counts, this one ticked, Loading…, New project, All projects and library), Rename, Project page ↗, Keyboard shortcuts ⌃1–9 · ⌘J; the list stays while the pointer crosses Rename (300 ms) | SidebarPanels.jsx:923-980 | Panels/ProjectMenu.swift | todo |
| 113 | Keyboard shortcuts dialog (480): Next agent ⌘J; Projects Ctrl+1–9 rows (go there); Hide/Show sidebar ⌘\; no subtext, no lines | SidebarPanels.jsx:983-1011 | Panels/ShortcutsDialog.swift | todo |
| 114 | Search dialog (560): "Search projects, sources and the library" (15px, 52 high); groups Projects / In this project / Library, six each; ↑↓ Enter; project → go, source → open, fresh → add; + on a library row; "Nothing matches “x”." | SidebarPanels.jsx:1022-1113 | Panels/SearchDialog.swift | todo |
| 115 | Name dialog (440): title, field (36 high), Cancel and the action (disabled until named, "Creating…"); Enter makes it; error in red; / \ → - | SidebarPanels.jsx:1121-1147 | Panels/NameDialog.swift | todo |
| 116 | "Create project within <parent>" and "Create folder" dialogs | SidebarPanels.jsx:1150-1157 | Panels/NameDialog.swift | todo |
| 117 | Context menu at the pointer (min 190), kept in the window; items 30 high, 13px, red danger, disabled at .4 with a tooltip; separators | SidebarPanels.jsx:1162-1185 | Panels/ContextMenu.swift | todo |
| 118 | The trash panel is the PostIts package's (TrashPanel): the sidebar opens it beside the trash and passes the post-it and workspace trash | Rail.jsx:902 | SidebarContext (closure) | todo |
| 119 | Recent pages (the clock, 330 wide, below its button): "Recent pages", the top page, projects with their crumb and count, notes | RecentPages.jsx | Panels/RecentPages.swift | todo |
| 120 | Each panel's search/lookup asks main 120 ms after typing stops; a reply for an older query is dropped | SidebarPanels.jsx:443-452, 1029-1038 | Panels/Lookup.swift | todo |
| 121 | What things say (bodies) asked when a search opens, dropped when it closes | useBodies.js | Panels/Lookup.swift | todo |
| 122 | An add's busy and error: problems joined with " · ", else done | useAddRun.js | Panels/Lookup.swift | todo |

## D. The tour and the walkthrough

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 123 | Sidebar tour: three cards (Engelbart library / Project-specific sources / Create folders for your sources) with their texts; holes over the Library row + its panel, Sources' head + this project's folder, the user's folders + Create new | SidebarTour.jsx:13-40 | Tour/SidebarTour.swift | todo |
| 124 | Veil rgba(23,23,23,.26) with rounded (10) holes padded 5, no ring; card 304 wide beside the last hole (right, left, else below), under the 52 title line; caret on its edge | SidebarTour.jsx:52-178 | Tour/SidebarTour.swift | todo |
| 125 | → / Enter go on, Finish ends, × and Escape end; seen once (`engelbart.sidebarTour.seen`); paused while a popup is up | SidebarTour.jsx:41-140 | Tour/SidebarTour.swift | todo |
| 126 | Get started (Welcome workspace): three steps with circles (dashed, blue filled when done), numbers, titles (hint as tooltip), meta at the right, chevron; first and first-not-done open; a thin line between circles; Hide | GettingStarted.jsx | GettingStarted/GettingStartedView.swift | todo |
| 127 | Step 1 lists the Library's tabs with counts (or "Library · Nothing yet"); step 2 @brainstorm; step 3 @discover then the papers found | GettingStarted.jsx:65-79 | GettingStarted/GettingStartedView.swift | todo |

## E. What the Workspace owns (inputs the sidebar receives)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 128 | The sidebar's toggle and the clock in the title bar, ⌘\, width drag 220–520 (double click → 300), hidden remembered | Workspace.jsx:2178-2272, 2414-2417 | — | n/a: Workspace package (the sidebar takes `width`/`hidden`; `RecentPagesButton` is provided here) |
| 129 | ⌘J (failed, needs, unseen, oldest first, never the one just gone to; else nextPlace) and Ctrl+1–9 | Workspace.jsx:1598-1791 | — | n/a: Workspace's key handling; it calls `NavModel`/`SidebarModel.shortcutProjects` from here |
| 130 | Agent marks (`engelbart.agentMarks`), opened times (`engelbart.openedAt`), visits (`engelbart.recentPages`) kept per machine | Workspace.jsx:127-131, 1688-1799 | Model/SidebarStorage.swift | todo |
| 131 | Entries = keptAgents(agentEntries + repoEntries, marks, minute); projectCounts for the switcher (other projects from state.json agents) | Workspace.jsx:1679-1707 | Model/SidebarModel.swift (`SidebarModel.projectCounts`) | todo |
| 132 | Folders: loaded from the Store, followed on `engelbart:folders`, made/renamed/deleted/filled/emptied through it; the last added flashes | Workspace.jsx:1810-1827 | SidebarViewController.swift (Folders) | todo |
| 133 | Adding into a folder (addOrFind, then addToFolder) vs into the project (Workspace's linkIds) | Workspace.jsx:1897-1926 | SidebarViewController.swift | todo |

## F. Mapped mechanisms

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 134 | localStorage → a key-value store with the same keys (UserDefaults suite in the app, in memory in tests) | Rail.jsx:315 | Model/SidebarStorage.swift | todo |
| 135 | React portals / `data-overlay` → child NSPanels (UI FloatingPanel), which sit over the Stage's web view | SidebarPanels.jsx | (UI) | todo |
| 136 | CSS hover classes → tracking areas on each row; `:focus-within` → while renaming | styles.css | RowView.swift | todo |
| 137 | HTML drag (dataTransfer) → NSDraggingSource with `LIB_DRAG_TYPE` and the mention as plain text | mention.js writeLibDrag | RowView.swift | todo |
| 138 | `data-*` attributes → accessibility identifiers (`sb-project-row=ui`, …) for drivers and tests | Rail.jsx | RowView.swift | todo |

## G. Owned elsewhere (sources in this area's list that the sidebar does not use)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 139 | WorkspacePeek (a mentioned project's peek) | WorkspacePeek.jsx | — | n/a: DocEditor's (Editor package) |
| 140 | TopicMenu (Brainstorm topic chip) | TopicMenu.jsx | — | n/a: DocEditor's (Editor package) |
| 141 | DiscoverLevels (@discover's level menu) | DiscoverLevels.jsx | — | n/a: DocEditor's (Editor package) |
| 142 | ImportSignins (browser sign-ins picker) | ImportSignins.jsx | — | n/a: the Stage's ⋮ menu and Onboarding (Stage/Screens) |
| 143 | useFolderFiles (chips' file states), useZoteroStatus, useGithubStatus | use*.js | — | n/a: Workspace/Editor chips and the GitHub pane (Integrations' GithubPaneModel follows `engelbart:github` itself) |
| 144 | guide.js (guideTitle, paperState, savePaper) | guide.js | — | n/a: DocEditor + Workspace (needs the Stage's paperRow) |
| 145 | hammer.js | hammer.js | — | n/a: DocEditor's Build icon (Editor) |
| 146 | rail.js mentionRows / folderRows / attachRows / pickedChanges / nameParts | rail.js:141-298 | — | n/a: the @ menu (Editor) and the Build panel (Build) |

## H. Superseded behaviours from the task brief and older notes

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 147 | Head = grey box with "Workspace" label + icon + name; a click opens the switcher with search | spec #92, memory | — | n/a: superseded 2026-10-13 by the project name + menu (row 39, 112) |
| 148 | Sections Notes / Websites / GitHub / Files / Sub-Workspaces, › on hover, Collapse all / Expand all | spec #92, 0422042 | — | n/a: superseded 2026-10-13 by Projects + Sources (rows 47-76); "Expand all" was already removed 2026-10-06 |
| 149 | + Add context opening on click and hover with its own search; GitHub/Zotero panes in the + menu | spec #92-93 | — | n/a: superseded by the add picker (106-111, GitHub pane inside); Zotero left the + menu (it is the @ menu's) |
| 150 | Copy at the lower left; next row with its hover list | spec #93, #76 | — | n/a: Copy is the document's foot (Workspace/Editor); the next row became ⌘J on Projects' head (48) and in Agents (92) |
| 151 | Starred subsection | sidebar.js SOURCE_GROUPS | Model only | n/a: removed from the drawing 2026-10-13 (sidebar-ui test "Starred is gone"); the model is kept (26) |
| 152 | Inbox and Connections rows | 2289464 | — | n/a: Inbox folded into Agents; Connections moved to Settings (2026-10-13) |

## I. Hudson's standing rules

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 153 | No horizontal divider lines (the add picker, the shortcuts dialog); the code at 9413a56 keeps a 1px #efefef rule in the project menu and the context menu's separators, so those are kept as the code has them | memory no-horizontal-dividers, SidebarPanels.jsx:954, 973, 1175 | Panels/ProjectMenu.swift, ContextMenu.swift | todo |
| 154 | No hint subtext under rows or in Search | d1c57cc | — | todo |
| 155 | "Stickies" not "post-its" in every label | d1c57cc | SidebarView.swift | todo |
