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

## Test mode

The pill top-right is the only control that exists on every screen. **Test · on** roots the app at `~/.engelbart/test/` and seeds the library once (the HypoCompass paper, its repository, the arXiv page, a small dataset). **Test · off** leaves the window blank except the pill. The non-test root is reserved and untouched.

## What lands on disk

```
~/.engelbart/
  config.json                        { "testMode": true }
  test/
    library.pglite/                  Postgres (PGlite): table `library`
    annotations/<libraryId>.json     paper marks (highlights, notes, positions)
    seed/                            the seeded fixtures
    <Project>/
      project.json                   { id, created }
      notes.pglite/                  Postgres (PGlite): table `notes`
      <Note>.md                      every note of the project, flat, plain markdown
      <Goal>/meta.json               { id, box, created }
      <Goal>/future.md               the Future list, one "- idea" per line
      <Goal>/<Topic>/meta.json       { id, status, context: [libraryId], created }
      <Goal>/<Topic>/workspace.md    the topic's document
```

Renaming a project, goal, topic or note renames the directory or file; ids stay in the json files. SQL schema: spec §6.

## Layout of the code

```
src/main/index.cjs           app lifecycle, window, engelbart:// protocol, menu, terminal IPC (from Experimental Terminal)
src/main/ipc.cjs             engelbart:* handlers, argument validation, lazy store context + seeding
src/main/store/              home layout + config, PGlite databases, projects/goals/topics/notes/docs, library + annotations
src/main/terminal/           Experimental Terminal engine, unchanged (session manager, launch, providers, settings)
src/preload.cjs              window.terminalAPI (ET contract) + window.engelbartAPI
src/renderer/App.jsx         home | canvas | workspace, the zoom-and-fade transition, the test pill
src/renderer/screens/        Home, Canvas, Workspace
src/renderer/workspace/      Rail, DocTabs, DocEditor (+ MentionMenu, Popover), CtxModal, RightPane
src/renderer/pdf/PaperView   pdf.js + rough.js + Caveat
src/renderer/terminal/       xterm client over terminalAPI; sessions survive navigation
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
node scripts/drive.mjs clicksel "[data-canvas] div[style*='zoom-in']" -- wait 800 -- shot /tmp/ws.png
node scripts/drive.mjs errors          # anything the renderer caught
```

To test against a scratch home instead of your real `~/.engelbart`:

```sh
ENGELBART_HOME_DIR=/tmp/eb-home electron . --user-data-dir=/tmp/eb-userdata --remote-debugging-port=9223
ENGELBART_DEBUG_PORT=9223 node scripts/drive.mjs text
```

## Known kinks (deliberately open)

See spec §9: the unused non-test root, library ingestion beyond seeds, whether goals/topics want SQL rows, deletion, note↔goal association living in the notes table rather than frontmatter, simulated build/chat, images in documents, one project open at a time.
