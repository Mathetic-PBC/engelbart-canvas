# Engelbart (desktop experiment)

A macOS app that turns the *Goal Canvas* design into a working simulation environment: projects, goals, topics, notes and a library on disk under `~/.engelbart/`, an Obsidian-style document with bullet lists, `- [ ]` tasks (typed `@Task`) and inline `@bart` questions, a paper reader with rough.js ink and handwritten margin notes, and the Experimental Terminal engine embedded for real shell / Claude Code / Codex sessions. Nothing talks to a model yet; that is the point.

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

Install as an app on this Mac:

```sh
npm run package                            # release/mac-arm64/Engelbart.app (release/mac/ on an Intel Mac), signed ad hoc
open release/mac-arm64/Engelbart.app
```

A release for other people's Macs (both kinds, a .dmg and a .zip each, an install command and a download page):

```sh
ENGELBART_DOWNLOAD_URL=https://example.com/engelbart npm run dist:mac   # then upload release/upload/ there
```

People install it with `curl -fsSL https://example.com/engelbart/install.sh | bash`, and it updates itself from that folder. The whole procedure, what they see, and signing and notarizing: `docs/releasing-mac.md`. The first launch creates `~/.engelbart/`; a release has no test mode (see First run, test mode, reset).

## Catalog and summaries

While the app is open it sweeps the library once a minute (and at launch, and when the computer wakes). A note longer than 1,000 characters that has been left alone for 30 minutes gets a summary of under 1,000 characters saying why it matters and what is in it; after an edit it is rewritten, with a closing "Changed:" sentence. A PDF that prints an Abstract uses that abstract instead and never calls a model. Each project's `.context/catalog.json` lists its workspaces and items with those summaries.

The model is chosen in `~/.engelbart/config.json`, which is read again for every summary:

```json
"summarizer": {
  "provider": "openai",
  "openai":    { "model": "gpt-6-luna",    "effort": "high" },
  "anthropic": { "model": "claude-opus-5-5", "effort": "high" }
}
```

`provider` is `openai` (Codex CLI) or `anthropic` (Claude Code CLI); effort is `low`, `medium`, `high`, `xhigh` or `max`. Both run as hidden processes on your subscription sign-in, never an API key, and isolated from your own Codex and Claude Code configuration. `ENGELBART_SUMMARIES=off` turns the sweep off.

## The sidebar

The current workspace's name on top (its hover lists the workspaces beside it and **+ New**), then **Workspace**, its own document, then the workspace's library on a grey card:

- **Search** brings in what the library already holds. Empty, it offers a new **Note** and a nested **Workspace** and four things that are not here yet; typed, the library's matches first, then Note and Workspace named after what you typed. A pasted link or path is the one row the library has for it (or a new one). Hover a result for its card.
- The rows: hover for the item's card (what it is, where it is, its summary, who holds it), double-click to rename, drag onto the trash to take it out of this workspace.
- **+** (hover) adds something new to the library and to this workspace: a link or path in the field, **Choose from disk…** (files and folders, several at once, linked where they are, never copied), **Add from GitHub…**. Something the library already holds is refused ("Already in the library as …"); pages compare without scheme, `www.`, trailing slash or `#fragment`.

At the bottom, three pictures that size with the sidebar: the **trash** (a row dropped on it leaves this workspace, never the library — meta.json `removed` keeps it off the rail whatever put it there, until it is brought back; a post-it dropped on it is deleted; the can shows paper while something is in it), the **sticky note** (a post-it), and **Copy**. The sidebar's edge resizes only the document; the edge between document and right pane moves those two (double-click either for its default).

The Browser's address ends in the page's place in the library: **+ Save** (a card names it; *Library only* or *Workspace*), **+ Workspace** (in the library, not here: one click), or **✓**. The `@` menu lists **Bart**, **Task**, **Note** (`@Note name` + Enter makes that note here and mentions it), the page open in the Browser (a **+** when the library does not hold it yet: picking it adds it), then the library. Whatever an `@` mention names comes into the workspace.

## Copy and @bart

**Copy** (the papers at the bottom of the sidebar) puts the open document on the clipboard with every `@[mentioned]` file's content in `<file>` tags directly under the line that mentions it: notes whole (with their own mentions), anything else as its path or URL plus its summary.

**`@bart <question>`** then Enter asks an agent that can read the project's notes and library, read (never edit) the code directory, and search the web. The answer appears under the question as a draft: **Hide** removes it, **Save** keeps it, read-only, ending with which model said it. It runs hidden on your Claude Code or Codex subscription, never an API key.

- No flags: the question starts at the first step of the ladder and the agent moves itself up when it judges the question needs it, keeping what it has read. Codex: Sol medium, Sol high, Astra xhigh. Claude Code: Sonnet medium, Opus high, Fable xhigh.
- By hand: `@bart --opus --high why …` (also `--fable`, `--sol`, `--luna`, `--xhigh`, `--extra high`). Picking by hand turns moving up off.
- Or hover the chip beside the send arrow: it names the model and effort the question starts on, and a pick there writes those same flags into the line. Flags the list recognises are slightly bolder.
- Which providers are offered at all: `providers` in `~/.engelbart/config.json` (`["openai", "anthropic"]`).
- The list, the ladders and the default provider: `~/.engelbart/model-effort-inline-question.json`, read again for every question.
- The instructions it runs under: `src/main/bart/system-prompt.cjs`, or your own in `<data root>/.context/bart-system-prompt.md`.

## Build

**Build** (beside Copy, in the strip under the Workspace tab's document) hands the workspace to Claude Code or Codex, hidden, on your subscription, in a git worktree of its own (`<data root>/worktrees/<project>/<id>`, branch `engelbart/<id>`), so several workspaces can build at once without touching each other or your folder. Design: `docs/superpowers/specs/2026-09-25-build-workflow-design.md`.

- The panel (it opens above the button, no backdrop; the post-it it lands on hides under it, the others stay): **Add from library** (a ringed +, then a search) for items to attach, **Automatically clear workspace** (unticked each time: ticked, Send archives the document right after the Build froze it, the blank one keeping the new card), a line when uncommitted files are left out (a Build starts from your last commit) or the folder cannot take a Build (**Start history** gives a folder without git its first commit), and at the lower right the model and effort chip with the send in it, as on an @bart line (defaults in `model-effort-inline-question.json` → `build`: GPT-6-Sol high, Opus high).
- What the agent gets: @bart's context (the document with every mention in place, the library as Context.json), what you attached, and the newest archived version of the workspace marked as history; frozen when you press send. It writes only in its worktree (Claude Code `--restricted` + auto mode; Codex's workspace-write sandbox + auto-review), with no MCP servers, hooks or computer use (`src/main/build/policy.cjs` is where the sandbox will go).
- The card: the document gets one `build> <id>` line, drawn from the Build's record — what it is doing, what it said, `NEEDS YOU:` questions, a reply field (a reply while it works cuts the turn short, its work saved, and goes on in the same session), **Review** (the diff since it started), **Accept**, **Discard** (two clicks), **Resume** (after Stop, a failure or a quit), **Send to agent** (a conflict or failed checks).
- Every turn ends in a checkpoint commit. **Accept** squashes them into one commit on the branch your folder is on, after replaying past whatever you committed meanwhile, running the checks (`project.json` → `build.check`, else `npm test` when there is one) and refusing, with nothing changed, on a conflict, leftover conflict markers, failed checks or your own uncommitted edits to the same files.
- **Clear** saves the document to `<Workspace>/.archive/<time>.md` (plus the ids of what it mentioned) and starts it blank; everything it mentioned stays on the sidebar, and the **Archived** section lists the old versions (click to read, **Restore** to bring one back, the current one archived first).
- A post-it's **Build** (Claude Design "Post-it Quick Task", `design/post-it-quick-task/TWEAKS.md`) opens a popup from the card: the model and effort grid, **Context** (a library search in a popout beside it), and the send. It runs as a quick task: no questions, a slot of its own, lands by itself when clean. The card's footer then shows **Building** (three dots), **Needs you** or **Stopped**; a click opens the task beside the card: Stop while it works, otherwise a search over every workspace (sub-workspaces too), the model (set to what the task ran on) and the send, which adds it to that workspace. It is put in there as an archived version (`Imported from Task:`, the post-it, the Build's card), the document untouched; the app goes to that workspace (first of ⌘J's recent ones) with that version open, and the card asks **Keep task** or **Delete task** (into the post-it trash). Panels opened by a click (the Build panels) cover the post-its under them: main swaps each covered card for a picture of itself drawn under the panel.
- `ENGELBART_BUILD_FAKE=1` runs a fake agent (git and records stay real) for scripted runs.

## GitHub repository previews (E2B)

A GitHub repository added to the library (or linked into a workspace) is cloned into an E2B sandbox, set up by a local Claude Code task on your subscription through tools bound to that one sandbox (the Anthropic API as an optional fallback), and served as a verified live preview. Saved repositories are prepared once per app session. The bell at the top right of every screen follows each one through **Building…**, **Build finished** or **Build failed**; its inspector has the Build steps, the Logs and the app's Environment variables (encrypted with the system keychain, applied by **Save & restart app** in the same sandbox). Quitting stops every sandbox. The E2B key is `E2B_API_KEY` in `~/.engelbart/sandbox.env`. Details, configuration and verification: [docs/sandbox-runs.md](docs/sandbox-runs.md); the runner template: [docs/e2b-template-migration.md](docs/e2b-template-migration.md), [docs/sandbox-cache.md](docs/sandbox-cache.md). `ENGELBART_SANDBOXES=off` turns them off for scripted runs.

## Project post-its (prototype)

The sticky note at the bottom of the sidebar adds a titleless post-it. The card uses `design/assets/yellow-sticky-note.svg`, including its paper texture, curled corner, and transparent shadow. The card uses the note editor's font and inline Markdown. Click text to edit; drag blank space to move; drag the curled corner to resize (or focus the grip and use arrow keys). Let go over the sidebar's trash can to delete it permanently (the can lifts while the pointer is over it, and the card takes a red tint). Escape cancels a drag.

Cards belong to the project and remain visible across its workspaces and notes. Content and preferred layout persist in `post_its` inside the project's `notes.pglite`. A smaller window temporarily clamps the cards into view. There is no hidden/completed state, drawer, attachment picker, or `@btw` command in this prototype.

Each card is an app-owned `WebContentsView` above the live browser. Its restricted preload can edit only that card. Native browser tabs are restacked below cards, and cards temporarily yield to app dialogs/menus. Each view has a substantial renderer cost: approximately 100 MB working set per card in the development smoke run; this architecture is intended for trying the interaction, not hundreds of cards.

Verification: `npm test`, then `npm run build && npx electron scripts/smoke-post-its.cjs`. The smoke test uses a hidden window and disposable data, checks editing/geometry/browser interaction/trash, and prints a checkpoint directory. To check a full relaunch:

```sh
ENGELBART_POST_IT_SMOKE_ROOT=/path/from/checkpoint ENGELBART_POST_IT_SMOKE_RESTORE=1 npx electron scripts/smoke-post-its.cjs
```

## Git, Claude Code and Codex

Checked at every launch, in the background (`src/main/tools/`; design: `docs/superpowers/specs/2026-09-23-tools-and-defaults-design.md`). What the last check saw is written to `~/.engelbart/config.json` → `tools`: for each, `installed` (false until a check finds it), `version`, `requires` (from `src/main/tools/requirements.cjs`: Git ≥ 2.30.0, Claude Code ≥ 2.1.278, Codex ≥ 0.155.0), `status`, `signedIn`, `path`, `source`, `error`. These are rewritten by every check; edit only `skip`, `pin` (a version Engelbart must never update) and `tools.updates` (`auto` | `ask`).

The app carries its own Git (2.53.0 from dugite-native, GitHub Desktop's build; `scripts/fetch-git.mjs` puts it in `vendor/git` for a checkout, electron-builder in the app's Resources). It stands in only when the Mac has no Git of its own that works (a Mac without Apple's developer tools has just `/usr/bin/git`, a stub that opens Apple's installer): then its record says `source: "bundled"`, the dialog shows it as `· built in`, and its folder goes first on PATH for everything Engelbart starts (@bart, Build, summaries, the terminal), after the login shell's startup files (`src/main/tools/bundled-git.cjs`, `src/main/terminal/launch.cjs`). On a Mac with neither Claude Code nor Codex, Claude Code is installed at launch without asking (unless skipped); signing in is still yours.

When something needs you — Git missing, neither agent installed, no agent signed in, an update waiting for approval, an install that failed — a dialog opens after the check: Install (Git through Apple's Command Line Tools dialog; Claude Code and Codex through their vendors' installers), Update, Sign in (the CLI's own login, which opens the browser), Skip (with a warning; remembered per tool). **Engelbart ▸ Set Up Tools…** shows all three at any time, with Ask again and Update automatically. A tool below its minimum is updated by itself at launch unless it is pinned, skipped, `updates` is `ask`, or you turned the CLI's own updater off (`autoUpdates: false` in `~/.claude.json`, `DISABLE_AUTOUPDATER`, Codex's `check_for_update_on_startup = false`).

@bart starts on the saved default provider when its CLI can run, else on the other one; nothing is written. `config.json` and `model-effort-inline-question.json` take new defaults from later builds wherever you left a value alone (`src/main/store/defaults.cjs`).

## Terminal pane

Each tab is a real PTY (the Experimental Terminal engine). While the shell is idle you type into the **Run commands** box at the bottom, like a chat: Enter sends, ↑/↓ recall your shell history, and the transcript above starts empty and does not take keys. While a program runs — an arrow-key menu, a REPL, Claude Code or Codex, started from the dropdown or by typing its name — the keyboard belongs to the transcript, as in any terminal, and the box comes back when the program ends. The dropdown at the right of the tab strip turns an untouched terminal into the agent in place, so to choose an agent's directory: click the `▭` chip, pick the folder, pick the agent. The mechanism (a launcher plus zsh wrapper startup files that blank the prompt and emit shell-integration marks, then hand your configuration back) is described in `src/main/shell-rc.cjs`; bash and fish are left alone.

## Restarting after a code change

```sh
npm run relaunch                 # quit every running copy, rebuild + repackage, open release/…/Engelbart.app
npm run relaunch -- --dev        # quit, rebuild, run `electron .` in the background instead (faster, same data)
npm run relaunch -- --no-build   # just quit and reopen
```

It works from a terminal inside Engelbart too (say, from a Claude Code session running there): quitting Engelbart closes that terminal, so the script hands the rest to a detached copy (log: `~/Library/Logs/Engelbart-relaunch.log`) and you resume the agent afterwards with `claude -r`. `--dry-run` says what would happen without touching anything.

Both use the real data root, `~/.engelbart`. The packaged app under `release/` only changes when it is repackaged, so opening it from Finder after a code change shows the old build. `ENGELBART_HOME_DIR` (a different data root) is for scripted test runs only; the relaunch script clears it.

## First run, test mode, reset

With no project in the current root the app opens on **Create a new project** (name + `./slug` path). Creating a project makes `<root>/<slug>/`, a first goal *First steps*, a first topic *Getting started* and a *Welcome!* note, and opens the workspace with that note. From then on the app opens straight into the topic you were last in (`<root>/state.json`); `Engelbart` in the header, or Escape, shows all projects — a card grid that ends with a dashed **+ Project** card. There is no kanban screen: the goal crumb in the header lists the project's goals and adds new ones.

The pill top-right exists on every screen of a developer's copy. **Test · on** roots the app at `~/.engelbart/test/` and seeds that library once (the HypoCompass paper, its repository, the arXiv page, a small dataset); the `⚙` beside the pill can reveal the folder or **Reset everything** (native confirmation, then `~/.engelbart/test/` is deleted and recreated). **Test · off** roots the same app at `~/.engelbart/` with its own library database and no seeds. A new install starts with it off.

Test mode is only in a developer's copy (`src/main/developer.cjs`): Engelbart run from a checkout (`npm start`, `npm run relaunch -- --dev`), or packaged by `npm run relaunch`, which builds with `ENGELBART_DEVELOPER=1`. Any other package, which is what ships, has no pill and no `⚙`, uses `~/.engelbart` whatever `config.json` says (without rewriting it, so a developer's copy on the same Mac keeps its setting), refuses the switch and the reset, and never makes `~/.engelbart/test/`. A release has to be built with `npm run build` right before packaging, without `ENGELBART_DEVELOPER`: the build writes `dist/build.json`, which is what the package reads. `ENGELBART_TEST_MODE=off` takes test mode away from a developer's copy too, to see the app as it ships (`npm run new-mac` sets it).

## What lands on disk

```
~/.engelbart/                         (test mode: ~/.engelbart/test/, same shape, plus seed/)
  config.json  state.json             test toggle, providers, summarizer, github, tools; { projectId, workspaceId } to reopen
  model-effort-inline-question.json   @bart's models, efforts and ladders
  .defaults/<file>                    the defaults each of those two was last given (how new defaults reach them)
  library.pglite/                     table `library`: every md, pdf, folder, website, data file, image; `type` is the format, `tags` what was inferred: paper, git, note (+ summary, summary_edited, char_count)
  .context/status.json                the last summary sweep that did something
  .context/summary-system-prompt.md   optional: replaces the built-in summary prompt
  annotations/<library id>.json       PDF highlights and margin notes
  .backups/<project>-<time>/          copies taken before a layout conversion (and of a settings file's first merge)
  <project>/
    project.json                      { id, name, created, directory }   directory = where the code lives
    notes.pglite/                     tables `notes` (topic_id holds the workspace id), `post_its` (text and preferred layout)
    <Note>.md                         notes, flat
    assets/<id>.png                   pasted images (library rows of type `image`)
    .context/catalog.json             what the project holds, with summaries, for agents that read files
    <Workspace>/workspace.md          a workspace's document
    <Workspace>/meta.json             { id, status, context: [library ids], removed: [library ids the trash took off], created, builds: [ids], archives: [{ file, clearedAt, title }] }
    <Workspace>/.archive/<time>.md    the document when Clear was pressed; <time>.json: what it had linked and mentioned (ids)
    <Workspace>/<Child>/…             workspaces nest to any depth
    builds/<id>/task.json             a Build: provider, model, session, worktree, branch, base, status, checkpoints, conversation
    builds/<id>/context.md            what it was given, frozen at Build
  worktrees/<project>/<id>/           a running Build's checkout (removed at Accept or Discard)
    .legacy/                          goal directories from the first layout, parked, never deleted
```

Terminals, Claude Code and Codex start in the project's `directory`. A project without one opens behind a modal until you pick a folder. Projects in the first layout (`<project>/<Goal>/<Topic>/`) are converted the first time the app opens them; preview with `npm run migrate -- --dry-run`.

## Layout of the code

```
src/main/index.cjs           app lifecycle, window, engelbart:// protocol, menu, terminal IPC (from Experimental Terminal)
src/main/ipc.cjs             engelbart:* handlers, argument validation, lazy store context + seeding
src/main/store/              home layout + config, PGlite databases, projects/goals/topics/notes/docs, library + annotations
src/main/terminal/           Experimental Terminal engine (session manager, launch, settings)
src/main/tools/              Git, Claude Code, Codex: requirements, detect, install/update/rollback, lock, sign-in, manager; repository checks for Build; bundled-git (the app's own Git)
src/main/updates.cjs         new versions of the packaged app (docs/releasing-mac.md)
src/main/build/              Build: git (worktrees, checkpoints, Accept), store (task records), context, prompt, policy (the sandbox stub), runner (one CLI turn), manager
src/main/store/archive.cjs   Clear, the archived versions of a workspace, Restore
src/main/browser/            views.cjs: the Browser pane's pages as WebContentsViews (decision 48)
src/main/sandbox/            E2B previews of GitHub repositories: manager (runs, lifecycle), worker (forked; the E2B SDK), local Claude setup + its MCP tools, the Python helpers run inside the sandbox
src/preload.cjs              window.terminalAPI (ET contract) + window.engelbartAPI
src/renderer/App.jsx         create | all projects | workspace; reopens the last topic; the test pill
src/renderer/screens/        CreateProject, Home (all projects), Workspace (three-column header: crumbs + goal menu, doc tabs, pane switcher)
src/renderer/workspace/      Rail (workspace header, library card: search, rows, +; trash / sticky note / copy), DocTabs, DocEditor (+ MentionMenu, Popover), RightPane, Browser (+ Save)
src/renderer/pdf/PaperView   pdf.js + rough.js + Caveat
src/renderer/terminal/       the Terminal pane (tabs, cwd chip, Terminal / Claude Code / Codex switcher) over terminalAPI; sessions survive navigation
src/renderer/model/doc.js    the pure editor model (regexes, task and bullet lines, caret offset mapping)
src/renderer/model/rail.js   what the sidebar's search and the @ menu list
scripts/drive.mjs            CDP driver for exploratory testing (screenshots, clicks, typing)
scripts/package-mac.mjs      npm run package / dist:mac (electron-builder.config.cjs); fetch-git, install-mac.sh, release-site, make-icon: the rest of a release
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

`ENGELBART_TOOLS_FAKE='{"git":"missing","claude":"2.1.300 signed-out","codex":"0.150.0","failInstall":["codex"]}'` pretends a machine (each tool `missing`, `broken`, or a version with an optional ` signed-out`; Git also `bundled`) so the setup dialog can be driven without touching real installs; `ENGELBART_TOOLS=off` skips the launch check; `ENGELBART_GIT=bundled` uses the app's own Git even where the Mac has one; `ENGELBART_UPDATES=off` stops a packaged app checking for new versions. `ENGELBART_CONFIRM_ALL=1` makes the native confirmation dialogs (reset, a new version's offer) answer yes, for scripted runs only. So are `ENGELBART_SUMMARY_FAKE=1` (no model, a recognisable blurb), `ENGELBART_SUMMARY_QUIET_MS` and `ENGELBART_SUMMARY_INTERVAL_MS` (shorten the 30-minute and one-minute clocks).

## Known kinks (deliberately open)

See spec §9: library ingestion beyond seeds (test seeds only; the normal root starts empty), whether goals/topics want SQL rows, deletion, note↔goal association living in the notes table rather than frontmatter, simulated build/chat, images in documents, one project open at a time.
