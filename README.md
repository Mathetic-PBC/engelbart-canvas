# Engelbart (desktop experiment)

A macOS app that turns the *Goal Canvas* design into a working simulation environment: projects, goals, topics, notes and a library on disk under `~/.engelbart/`, an Obsidian-style document with inline todos and a placeholder `@chat`, a paper reader with rough.js ink and handwritten margin notes, and the Experimental Terminal engine embedded for real shell / Claude Code / Codex sessions. Nothing talks to a model yet; that is the point.

- Spec (every interpretation listed): `docs/superpowers/specs/2026-09-16-engelbart-desktop-design.md`
- Plan: `docs/superpowers/plans/2026-09-16-engelbart-desktop.md`
- The design it implements, plus your 33 tweak messages: `design/goal-canvas/`
- Verification record: `docs/verification.md`

## Run

Requires macOS, Node 22.12+, and (for the launchers) your installed `claude` / `codex` CLIs.

```sh
npm install          # also rebuilds node-pty for Electron
npm start            # build the renderer and open the app
npm run start:debug  # same, with a DevTools port for scripts/drive.mjs
```

Install as an app:

```sh
npm run package
open "release/Engelbart-darwin-arm64/Engelbart.app"
```

Unsigned and not notarised: first launch needs right-click → Open. The first launch creates `~/.engelbart/`.

## First run, test mode, reset

With no project in the current root the app opens on **Create a new project** (name + `./slug` path). Creating a project makes `<root>/<slug>/`, a first goal *First steps*, a first topic *Getting started* and a *Welcome!* note, and opens the workspace with that note. From then on the app opens straight into the topic you were last in (`<root>/state.json`); `Engelbart` in the header, or Escape, shows all projects — a card grid that ends with a dashed **+ Project** card. There is no kanban screen: the goal crumb in the header lists the project's goals and adds new ones.

The pill top-right exists on every screen. **Test · on** roots the app at `~/.engelbart/test/` and seeds that library once (the HypoCompass paper, its repository, the arXiv page, a small dataset); the `⚙` beside the pill can reveal the folder or **Reset everything** (native confirmation, then `~/.engelbart/test/` is deleted and recreated). **Test · off** roots the same app at `~/.engelbart/` with its own library database and no seeds.

## What lands on disk

```
~/.engelbart/                        test off: this is the root
  config.json                        { "testMode": true }
  library.pglite/                    Postgres (PGlite): table `library` (normal)
  annotations/<libraryId>.json       paper marks (normal)
  test/                              test on: this is the root — same layout, own library, seeds
    library.pglite/  annotations/  seed/
  <slug>/                            one project (slug = the path field of the create screen)
    project.json                     { id, name, created }
    notes.pglite/                    Postgres (PGlite): table `notes`
    <Note>.md                        every note of the project, flat, plain markdown
    <Goal>/meta.json                 { id, box, created }
    <Goal>/future.md                 the Later list, one "- idea" per line
    <Goal>/<Topic>/meta.json         { id, status, context: tree of library ids and { id, name, children } folders, created }
    <Goal>/<Topic>/workspace.md      the topic's document
```

Renaming a goal, topic or note renames the directory or file; renaming a project updates `project.json` and renames the directory only while it still is the name's own slug. Ids stay in the json files. SQL schema: spec §6.

## Layout of the code

```
src/main/index.cjs           app lifecycle, window, engelbart:// protocol, menu, terminal IPC (from Experimental Terminal)
src/main/ipc.cjs             engelbart:* handlers, argument validation, lazy store context + seeding
src/main/store/              home layout + config, PGlite databases, projects/goals/topics/notes/docs, library + annotations
src/main/terminal/           Experimental Terminal engine, unchanged (session manager, launch, providers, settings)
src/preload.cjs              window.terminalAPI (ET contract) + window.engelbartAPI
src/renderer/App.jsx         create | all projects | workspace; reopens the last topic; the test pill
src/renderer/screens/        CreateProject, Home (all projects), Workspace (three-column header: crumbs + goal menu, doc tabs, pane switcher)
src/renderer/workspace/      Rail (topic header + sibling switcher + context tree), DocTabs, DocEditor (+ MentionMenu, Popover), CtxModal, RightPane, Browser
src/renderer/pdf/PaperView   pdf.js + rough.js + Caveat
src/renderer/terminal/       the Terminal pane (tabs, cwd chip, Terminal / Claude Code / Codex switcher) over terminalAPI; sessions survive navigation
src/renderer/model/doc.js    the pure editor model (regexes, todo lines, caret offset mapping)
scripts/drive.mjs            CDP driver for exploratory testing (screenshots, clicks, typing)
```

## Tests

```sh
npm test            # stores, databases, editor model, IPC validation, terminal helpers
npm run test:pty    # real PTY round trip under Electron's ABI
```

Exploratory testing against a running app:

```sh
npm run start:debug
node scripts/drive.mjs shot /tmp/home.png
node scripts/drive.mjs clicksel "[data-right-mode='terminal']" -- wait 800 -- shot /tmp/terminal.png
node scripts/drive.mjs errors          # anything the renderer caught
```

To test against a scratch home instead of your real `~/.engelbart`:

```sh
ENGELBART_HOME_DIR=/tmp/eb-home electron . --user-data-dir=/tmp/eb-userdata --remote-debugging-port=9223
ENGELBART_DEBUG_PORT=9223 node scripts/drive.mjs text
```

`ENGELBART_CONFIRM_ALL=1` makes the native confirmation dialogs (reset) answer yes, for scripted runs only.

## Known kinks (deliberately open)

See spec §9: library ingestion beyond seeds (test seeds only; the normal root starts empty), whether goals/topics want SQL rows, deletion, note↔goal association living in the notes table rather than frontmatter, simulated build/chat, images in documents, one project open at a time.
