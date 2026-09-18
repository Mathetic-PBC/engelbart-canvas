# Verification record — 2026-09-16

What was checked, how, and what was not. Automated coverage is `npm test` (53 tests: home layout and config, PGlite library/notes schema and queries, projects/goals/topics/notes/docs on disk, seeds and annotations, IPC validation, editor model, terminal helpers) plus the inherited PTY integration test. Everything below was driven against a running app through `scripts/drive.mjs` (Chrome DevTools Protocol) on an isolated home (`ENGELBART_HOME_DIR`), never against the live window.

## Walkthrough (screenshots in `docs/verification/`)

| Step | Result | Evidence |
|---|---|---|
| First launch | `~/.engelbart/`, `config.json`, `test/` with `library.pglite`, `annotations/`, `seed/` created; window blank except wordmark, `+ Project`, `TEST · ON` | `01-home` (scratch) |
| `+ Project` → "Thesis" | project dir + `project.json` + `notes.pglite`; canvas opens with Current 70 / Experimental 15 / Past 15 | `03-canvas.png` |
| `+ Goal` in Current → "HypoCompass replication" | `<Goal>/meta.json {box:'current'}`; card shows `0 sources` | `04-canvas-goal.png` |
| Click the card | zoom-and-fade into the workspace; crumbs `Engelbart / Thesis / Current / HypoCompass replication`; empty-goal hint | `05-workspace` |
| `+ Topic` | `Topic 1/meta.json {status:'open'}` + empty `workspace.md`; rail row active with Workspace child; title input shows the topic name | `07-chat` |
| Typing in the document | paragraph, `- [ ]` todos with `–` marks, Build, ×, `n todos · m done` + blue **Build all**; `workspace.md` written verbatim after 400 ms | `07-chat.png`, file diff |
| `@chat …` + Enter | `@chat` blue, ↑ send button, reply inserted as two `> ` quote lines (placeholder text) | `08-chat-reply.png` |
| `+ Context` | modal `ADD CONTEXT TO TOPIC 1` with New note / Library (4 available) | `09-ctx-modal.png` |
| Library → paper | `meta.json.context` gains the paper id; rail row `How to Teach Programmi… PDF` | file diff |
| Click the paper row | right pane switches to Paper; pdf.js renders both pages as white sheets with gutters on the grey desk, text layer selectable | `10-paper.png` |
| Click blank gutter, type | Caveat note "check this claim" in the left gutter | `11-paper-ink.png` |
| Select abstract text, Enter | rough.js zigzag highlight; marks saved to `annotations/<id>.json` in page-relative units; restored on reopen (`1 notes restored, 18 paths`) | `11-paper-ink.png`, file |
| Terminal | a real zsh in the project directory, prompt `… Thesis %`; launchers `shell · claude · codex`; sessions persist across mode switches and Escape | `08-chat-reply.png` |
| Escape | back to the canvas; card now `1 source · Topic 1` | text dump |
| `+ Note` | flat `<Project>/Untitled note.md`, notes + library rows, opens in a tab, autosaves | `17-note-idea-status.png`, files |
| `+ Idea` | `future.md` gets `- try rough.js for the canvas too` | file |
| Topic mark click | `open → progress` (dashed ring), persisted | `17-note-idea-status.png`, `meta.json` |
| Home → click project name → rename | directory renamed both directions, library note paths rewritten | `ls` before/after |
| `TEST · ON` → off | window blank except `TEST · OFF`; `config.json {testMode:false}`; databases closed | `18-test-off.png` |
| off → on | home restored with the project | text dump |

## Defects found and fixed during verification

- Leaving a workspace with the Paper pane open unmounted the whole React tree: pdf.js 6 removed `PDFDocumentProxy.destroy()`; teardown now goes through `loadingTask.destroy()`. An error boundary and `window.__errors` capture were added so a renderer error reads as a message instead of a blank window.

## Not verified / known limits

- Drag-resizing the rail and the middle/right split (pointer capture) was not driven; the code is the design's, unchanged.
- ⌘/pinch zoom on the canvas was dispatched but not visually confirmed at high zoom (the crash above interrupted that run).
- Free-placed notes can land over printed text if you click between lines; the design only avoids text to the right of the note (`freeWidth`).
- The Claude Code / Codex launchers were exercised by Hudson in the live window (both started); the isolated run only used the shell.
- Packaged app: see the last section.

## Packaged app

`npm run package` → `release/Engelbart-darwin-arm64/Engelbart.app` (468 MB; `node-pty` and `@electric-sql/pglite` unpacked from asar). Smoke-launched with a scratch home on a separate DevTools port: home listed the project, the canvas opened (`2 sources · Topic 1`), the workspace mounted xterm with a live shell, and the paper rendered 21 pages with the 3 saved notes restored; no renderer errors. Unsigned: first launch on another machine needs right-click → Open.


# Round 2 — 2026-09-16 evening (first-run screen, roots, sidebar)

Driven on a fresh scratch home (`ENGELBART_HOME_DIR`, port 9223, `ENGELBART_CONFIRM_ALL=1`). Unit tests: 58 passing, including `test/store-modes.test.cjs` (test root vs normal root, separate libraries, reset leaves the normal root alone).

| Step | Result | Evidence |
|---|---|---|
| First launch, empty root | **Create a new project** screen: title, subtitle, `#fafafa` card with *Project name* / *Project path* (`./` + mono slug), filled button disabled until a name exists; gear + pill top-right | `20-first-open.png`, `21-create-filled.png` |
| Name "Reading Group" | path hint follows as `reading-group`; *Create project* enabled | `21-create-filled.png` |
| Create | `test/reading-group/{project.json, notes.pglite, Welcome!.md, First steps/Getting started/…}`; the workspace opens with the **Welcome!** tab active, sidebar header *Getting started · 1 / 1*, rows Workspace + Welcome!, `+ Context` `+ Folder`, `+ Later` at the bottom; shell in `reading-group` | `22-welcome.png`, file listing |
| `+ Folder`, type "Reading", Enter | folder row with chevron, name saved in `meta.json.context` | `23-sidebar-folder.png` |
| `+ Context` → Library → paper | paper attached at the tree root (a folder receives items when it is the selected row) | `23-sidebar-folder.png`, `meta.json` |
| Gear → Reset everything (auto-confirmed) | `~/.engelbart/test` wiped to `annotations/ library.pglite/ seed/`; app returns to the create screen | text dump, `ls` |
| Sibling switcher on hover | not driven: the CDP mouse-enter did not trigger React's hover; the code is the design's popover. Hudson exercised it live (a second topic appeared as `2 / 2`). | — |
| Normal root (`TEST · OFF`) | covered by `store-modes.test.cjs`: separate `library.pglite`, no seeds, projects listed per root | test |


# Round 3 — 2026-09-16 night (editor defects from Hudson's in-app bug list)

Reproduced and fixed on a scratch instance (port 9224) with the caret placed programmatically where clicks were ambiguous.

| Report | Cause | Fix | Check |
|---|---|---|---|
| "if I type `- ` it does not necessarily format it into a TODO … if I delete everything it won't register again" | Deleting a todo's text with a selection left an empty todo row (marker kept, text gone); typing `- ` into it produced the literal text `- [ ] - x`. Text the browser inserted outside the line structure was never read. | A selection-delete that empties a todo now leaves a plain empty line; a list marker typed into an empty todo starts the todo instead of nesting; stray text at the editor root is folded into the last line; a click on the editor's own empty space goes to the end of the last line. | select-all + Backspace → `[""]`; `- z` → `- [ ] z`; Enter, `- `, `x` → `- [ ] x` with the DOM redrawn after the marker; root text node folded, none left |
| "Do not show the `#-###` even after it has bolded … don't wait for me to hit enter" | The active line always rendered a heading's `# ` prefix token as source. | The prefix is a hidden marker token like `**`: shown only while the caret is inside it; display↔raw offset mapping treats it as zero-width. | active heading: innerText `Title`, prefix span empty, typing appends `# Titles` |

`npm test`: 58 passing.


# Round 4 — 2026-09-17 (Claude Design revision + Hudson's screen and editor requests)

Design revision pulled from Claude Design (messages 34–54: terminal pane, browser pane, header columns, todo/chat cards, Copy all, PDF margin fix) and Hudson's message of the same day (no kanban, open into *Getting started*, dashed `+ Project` card, hidden heading marks, nested-todo Enter, `- ` after deleting everything). Driven on a fresh scratch home (`ENGELBART_HOME_DIR`, port 9225, `ENGELBART_CONFIRM_ALL=1`). Unit tests: 60 passing (two new: last-open state, `read-text-file` path rules).

| Step | Result | Evidence |
|---|---|---|
| Create "HypoCompass" | Workspace opens with **Welcome!** active; header = `Engelbart / Current / First steps` · tabs `Workspace · Welcome! ×` · `Browser Terminal Paper Dataset`; the welcome todos sit in one grey card with *Copy all* / *Build all* | `32-workspace.png` |
| Terminal | Own pane: tab `›_ hypocompass ×` + `+`, light xterm with the shell prompt in the project directory, bottom bar `›_ Terminal` · `▭ <cwd>` · `Terminal / Claude Code / Codex` | `33-terminal.png` |
| Browser: `example.com` | tab `◎ example.com`, badge `WEB`, page in the iframe centred on `#f2f2f2`; blank state text before that | `35-browser-web.png` |
| Browser: `./Welcome!.md` | badge `FILE`, the note's markdown as mono text (read through `read-text-file`, project-relative) | `38-browser-file.png` |
| Workspace doc: `- ` on the empty document | becomes a todo row (card) at once; `second` + Tab nests; Enter on the empty nested row steps out to the root, the next Enter leaves the list; `# Heading here` renders as a 26px heading with no `#` while the caret is still on it | `36-editor-todo-heading.png`, stored lines dumped |
| `@chat what is this document about` + Enter | question and the two simulated replies form one card; replies `contenteditable=false`; send button gone once answered; an editable empty line follows | `37-chat-card.png` |
| Select all (editing command) + Backspace, then `- fresh`, Enter, `second` | document → `['']`; then `- [ ] fresh`, `- [ ] second` — the earlier failure was the editor collapsing cross-line selections to line 0; with a document that ended on a read-only reply, select-all itself collapsed, hence the trailing editable line rule | stored lines dumped |
| Paper: select two spans, then click the margin | 2 pending rects drawn, native selection released; typing `n…` opens the Caveat note with the text, highlight cleared, arrow drawn | `41-paper-note.png` |
| `Engelbart` in the header | all projects: card `HypoCompass · 1 goal · edited …` + dashed `+ Project`; clicking the card reopens `Getting started`; Escape returns to all projects | `43-home.png` |
| Hover the goal crumb → `+ New goal` | menu lists `CURRENT · First steps 0 / 1`; new goal opens as `Goal 2 / Topic 1` | `44-goal-menu.png` |
| Quit and relaunch | opens straight into `Goal 2 / Topic 1`; `test/state.json` holds the ids | `45-reopen.png` |
| Not driven | ⌘T / ⌘1–9 in the terminal, the Claude Code / Codex switcher (would start real agents in the scratch directory), the device presets' visual result, `sandbox:` and `localhost:` addresses. All are the design's code paths with no I/O beyond the iframe. | — |

### Addendum — terminal as a chat box (same day)

Driven on the scratch instance (port 9225) after the change. Unit tests: 62 passing (two new in `test/shell-rc.test.cjs`, one of which runs `/bin/zsh -il` against a fake home whose `.zshrc` sets a prompt from `precmd`).

| Step | Result | Evidence |
|---|---|---|
| Open the Terminal pane | transcript empty (no prompt), the *Run commands* box focused, dropdown reads `Terminal ⌄`, chip shows the project directory | `46-terminal-empty.png` |
| Type `echo hello from the box`, Enter | transcript lines: `echo hello from the box`, `hello from the box`; box cleared | DOM dump |
| Dropdown | `✓ Terminal · Claude Code · Codex` | `47-terminal-menu.png` |
| Not driven | the folder picker (native dialog), starting Claude Code / Codex from the dropdown (real agents), ^C into a running command | — |

### Addendum — 2026-09-18 (Hudson's second list: headings, terminal keyboard, untitled names, sidebar spacing)

Reproduced first: typing `# Header` **one character at a time** (new driver command `typeslow`; the bulk `type` used on 09-17 inserts the whole string in one event and hid this) stored `# ` and showed `Header`; Enter then lost the text. Cause: the hidden `#` was an empty span and the browser put the typed characters inside it. Unit tests: 65 passing (`test/shell-rc.test.cjs` now runs real `/bin/zsh` through the launcher four ways).

| Step | Result | Evidence |
|---|---|---|
| `# Header` typed character by character | stored `# Header`; shown `# Header` at 26px/500 while the caret is on the line; Enter → line shows `Header`, `body text` lands on the next line; same for `### Small one` | stored/shown lines dumped |
| Topic switcher → `+ New` | caret in the document title, field empty, hint `Untitled Workspace 1` (also grey in the sidebar); type `User Interface`, Enter → topic renamed, caret in the document, `typed without clicking` stored | `48-untitled-flow.png`, DOM dump |
| `+ Context` → New note | same flow with `Untitled Note 1` → `Thoughts`; tab and sidebar follow | `48-untitled-flow.png` |
| Terminal opens | transcript empty, box focused | DOM dump |
| `echo hi`, `cd /tmp` from the box | output in the transcript; the `▭` chip follows to `/tmp` | DOM dump |
| ↑ ↑ ↓ ↓ in the box | recalls `cd /tmp`, then `command -v claude`, then back to empty | DOM dump |
| A key aimed at the transcript while idle | lands in the box (`x`), focus returns to the box | DOM dump |
| `sleep 3` | after 200 ms: note `sleep has the keyboard · type in the window above`, focus in the transcript; when it ends the box and the focus return | DOM dump |
| `claude` typed by hand (a shell function standing in for the real one) | chip and dropdown read `Claude Code`, box replaced by the note, keys go to the program; on exit the box returns | `49-terminal-agent-typed.png` |
| Untouched terminal at `/usr`, dropdown → Claude Code | same tab (count stays 1), `claude` runs in `/usr`; on exit the box returns | `50-terminal-agent-inplace.png` |
| Shell that follows a dropdown-launched agent | covered by a unit test: `launcher -ilc 'true; exec "$TERMINAL_USER_SHELL" -il'` emits the ready mark with an empty prompt | `test/shell-rc.test.cjs` |
| Sidebar | 8px more air between the topic switcher and the first context row | `48-untitled-flow.png` |
| Test-harness incident | one run picked Claude Code on a *used* terminal, which correctly opened a new tab — with the real Claude Code, in the scratch instance at `/usr`. No message was sent; it ended with the instance. It exposed that terminals inherited the outer Claude Code session's variables; those are now stripped (unit-tested). | — |
| Not driven | the folder picker (native dialog); a real Claude Code / Codex session end to end | — |

### Addendum — 2026-09-18, second change set (workspace tree, code directory, pasted images, no folders)

Unit tests: 69 passing. Driven on the scratch instance, whose project was still in the goal/topic layout.

| Step | Result | Evidence |
|---|---|---|
| Launch on the old layout | `First steps/Getting started`, `Goal 2/Topic 1`, `Goal 2/User Interface` became `Getting started`, `Topic 1`, `User Interface` at the project level; goals parked in `.legacy/`; backup in `test/.backups/`; the app reopened *User Interface* from the old `topicId` | directory listings before/after |
| Project without `directory` | modal *Where does this project's code live?* over the workspace (`filter: blur(6px)`, `pointer-events: none`); Escape does not dismiss it | `51-directory-gate.png` |
| Directory chosen (through the API; the native picker cannot be driven) | `project.json` gains `directory`; gate gone; the terminal's chip shows that folder | `project.json`, DOM dump |
| `+ Workspace`, type `Terminal pane`, Enter | nested under *User Interface* on disk (`User Interface/Terminal pane/workspace.md`); crumbs `Engelbart / HypoCompass / User Interface`; caret in the document | DOM dump, `find` |
| Paste a PNG on a plain line | `![Attachment 1](img:<id>)` on its own line, rendered as the image; `assets/<id>.png` written; *Attachment 1* appears in the sidebar | `52-image-paste.png` |
| Paste a PNG inside `- fix this` | inserted at the caret, reads `[Attachment 2]` in the todo | `52-image-paste.png` |
| Reload | the image comes back from disk through `read-image` | DOM dump |
| Crumb → parent | *User Interface* lists `Workspace · Thoughts · Terminal pane →` | DOM dump |
| Create screen | third field *Code directory*; *Create project* disabled until a folder is chosen | `53-create-directory.png` |
| Hudson's real data | only `npm run migrate -- --dry-run` was run against `~/.engelbart` (read-only): 4 projects would convert, and the context folder *New folder* in *Agents* would be flattened | terminal output |
