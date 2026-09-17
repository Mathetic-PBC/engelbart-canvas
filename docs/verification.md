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
