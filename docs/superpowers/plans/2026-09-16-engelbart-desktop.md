# Engelbart Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Engelbart macOS app: Goal Canvas UI over a `~/.engelbart/test/` file tree, PGlite library/notes tables, pdf.js + rough.js + Caveat paper annotation, the Experimental Terminal engine embedded, and placeholder chat/todo simulation.

**Architecture:** Electron main process owns the filesystem, the two PGlite databases and the PTY sessions; a sandboxed React renderer served from `engelbart://app/` talks to it through two frozen preload bridges (`terminalAPI`, unchanged from Experimental Terminal, and `engelbartAPI`). The renderer is a port of `design/goal-canvas/Goal Canvas.dc.html` (DC template + class logic) into React components, keeping the design's algorithms (editor caret mapping, PDF mark layout, canvas zoom) intact.

**Tech Stack:** Electron 44.4.1, Node 22, esbuild 0.28, React 19, @electric-sql/pglite 0.5.8, pdfjs-dist 6.3, roughjs 4.6.6, @xterm/xterm 6 + node-pty 1.1, @fontsource/caveat + source-code-pro, node:test.

**Spec:** `docs/superpowers/specs/2026-09-16-engelbart-desktop-design.md` (read it first; §2 lists every interpretation).

## Global Constraints

- Home root is `~/.engelbart/`; all app data in test mode under `~/.engelbart/test/`; nothing written anywhere else.
- Test pill fixed top-right on every screen; test off ⇒ blank page + pill.
- Library table columns exactly: `id, name, type, path, url, folder_path, project_id, created, last_edited`; `type in ('note','paper','git_repo','dataset','website')`.
- Notes table columns: `id, name, path, goal_id, topic_id, created, last_edited`.
- Notes are flat `<project>/<name>.md`; topic doc is `<project>/<goal>/<topic>/workspace.md`; ideas `<project>/<goal>/future.md`.
- No LLM, no import UI, no CDN: pdf.js, rough.js, fonts bundled locally.
- Design values (colors, sizes, copy) come from `design/goal-canvas/Goal Canvas.dc.html`; DS tokens from `design/goal-canvas/_ds/.../tokens/*.css`. No emoji, no shadows except focus rings and popovers, Unicode glyphs as icons except the five SVG kind icons the design defines (GH, PDF, LAYERS, WS, NOTE, IMAGE).
- Renderer: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self'; connect-src 'self'`.
- Terminal modules under `src/main/terminal/` stay byte-identical to `~/experimental-terminal/src/main/` except `TERM_PROGRAM`.

---

## File structure

```
scripts/build.mjs                 esbuild: renderer bundle, pdf worker, fonts, xterm css → dist/
src/main/index.cjs                lifecycle, window, menu, engelbart:// protocol, IPC wiring
src/main/ipc-validation.cjs       assertTrustedRenderer (engelbart://app/index.html), parseExternalUrl
src/main/terminal/{session-manager,launch,provider-discovery,settings,window-lifecycle}.cjs
src/main/store/home.cjs           home dir, config.json, test root, name sanitising
src/main/store/db.cjs             PGlite: library + notes schema and queries
src/main/store/projects.cjs       projects/goals/topics/notes/docs on disk + notes index
src/main/store/library.cjs        seeds, list, file bytes, annotations
src/main/ipc.cjs                  engelbart:* handlers
src/preload.cjs                   terminalAPI + engelbartAPI
src/renderer/index.html, index.jsx, styles.css, api.js
src/renderer/model/doc.js         pure editor model (tested)
src/renderer/ui/{Button,TestToggle,Icons}.jsx
src/renderer/screens/{Home,Canvas,Workspace}.jsx
src/renderer/workspace/{Rail,DocTabs,DocEditor,MentionMenu,Popover,CtxModal,RightPane}.jsx
src/renderer/pdf/PaperView.jsx
src/renderer/terminal/{TerminalPane.jsx,helpers.cjs}
test/{home,db,projects,library,ipc-validation,doc-model,renderer-helpers}.test.cjs
test/session.integration.cjs
fixtures/{hypocompass.pdf,problems.csv}
```

---

### Task 1: Build pipeline, protocol, window, blank app with the test pill

**Files:** Create `scripts/build.mjs`, `src/main/index.cjs`, `src/main/ipc-validation.cjs`, `src/preload.cjs`, `src/renderer/index.html`, `src/renderer/index.jsx`, `src/renderer/styles.css`, `src/renderer/ui/TestToggle.jsx`, `test/ipc-validation.test.cjs`.

**Interfaces produced:** `engelbart://app/index.html` serves `dist/`; `window.engelbartAPI.config()` → `{home, testMode}`; `window.engelbartAPI.setTestMode(bool)` → config.

- [ ] Step 1: `scripts/build.mjs` — esbuild `src/renderer/index.jsx` → `dist/renderer.js` (bundle, jsx automatic, target chrome148, loader css/woff2 file), copy `index.html`, copy `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` → `dist/pdf.worker.min.mjs`, import `@xterm/xterm/css/xterm.css` and the two fontsource css files from `index.jsx` so esbuild emits `dist/renderer.css` + font files.
- [ ] Step 2: `src/main/index.cjs` — `protocol.registerSchemesAsPrivileged([{scheme:'engelbart',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:false}}])` before ready; in ready: `protocol.handle('engelbart', req => net.fetch(pathToFileURL(path.join(DIST, safeRelPath(req.url)))))` restricted to files inside `dist/`; `BrowserWindow` like Experimental Terminal (`titleBarStyle:'hiddenInset'`, `backgroundColor:'#ffffff'`, sandbox/contextIsolation); `loadURL('engelbart://app/index.html')`.
- [ ] Step 3: `ipc-validation.cjs` — `assertTrustedRenderer(event, trustedUrl)` compares `mainFrame.url` with `'engelbart://app/index.html'`; keep `parseExternalUrl`. Test file copied from ET and adapted to the URL.
- [ ] Step 4: Blank app: `index.jsx` renders `<TestToggle/>` (fixed top-right pill `TEST · ON/OFF`, caps style from the DS) and nothing else when off.
- [ ] Step 5: `npm run build && npm test` pass; `npm start` shows the pill. Commit.

### Task 2: Home store

**Files:** Create `src/main/store/home.cjs`, `test/home.test.cjs`.

**Produces:**
```js
ensureHome(homeDir) → { root:`${homeDir}/.engelbart`, configFile, testRoot:`${root}/test` } (creates dirs, mode 0o700)
readConfig(root) → { testMode:boolean }        writeConfig(root, patch) → config (atomic tmp+rename)
sanitizeName(name) → string   // strips / \ NUL control chars, leading dots, trims, collapses spaces, max 120, fallback 'Untitled'
uniqueDirName(parentDir, base) → string       // base, 'base 2', 'base 3' …
```
- [ ] Tests: creates dirs; config default `{testMode:true}`; `sanitizeName('a/b..c ')==='ab..c'`, leading `.` stripped; `uniqueDirName` with an existing collision.
- [ ] Implement, run, commit.

### Task 3: Databases (PGlite)

**Files:** Create `src/main/store/db.cjs`, `test/db.test.cjs`.

**Produces:**
```js
openLibraryDb(testRoot) → LibraryDb   // ${testRoot}/library.pglite
  .insert({id,name,type,path,url,folder_path,project_id}) .list() .get(id) .rename(id,name)
  .touch(id) .rewritePathPrefix(oldPrefix,newPrefix) .close()
openProjectDb(projectDir) → NotesDb    // ${projectDir}/notes.pglite
  .insert({id,name,path,goal_id,topic_id}) .list() .rename(id,name,path) .touch(id) .close()
```
Schema is spec §6 verbatim. Both use `new PGlite(dir)`; `ensureSchema()` runs `create table if not exists` on open. Instances are cached per dir in a Map.
- [ ] Tests (temp dir): schema creates; insert/list round-trip with `type` check constraint rejecting `'chat'`; `rewritePathPrefix` updates only rows under the old prefix; project notes rename updates `path` and `last_edited`.
- [ ] Implement, run, commit.

### Task 4: Projects store

**Files:** Create `src/main/store/projects.cjs`, `test/projects.test.cjs`.

**Consumes:** Task 2 + 3. **Produces (all async, `ctx = {testRoot, libraryDb}`):**
```js
listProjects(ctx) → [{id,name,dir,created,goalCount,lastEdited}]
createProject(ctx,name) → project           // dir + project.json + notes.pglite
renameProject(ctx,id,name) → project        // rename dir, rewrite library paths
loadProject(ctx,id) → { project, goals:[{id,name,box,dir,topics:[{id,name,status,context:[libraryId]}], notes:[{id,name,path,goalId,topicId}], future:[string]}], notes:[…all project notes…] }
createGoal(ctx,pid,{name,box}) / renameGoal(ctx,pid,gid,name)
createTopic(ctx,pid,gid,name) / renameTopic(ctx,pid,gid,tid,name)
setTopicStatus(ctx,pid,gid,tid,status) / setTopicContext(ctx,pid,gid,tid,ids)
createNote(ctx,pid,{name,goalId,topicId}) → note   // <project>/<name>.md ('' body) + notes row + library row type 'note'
renameNote(ctx,pid,id,name) → note                   // rename file, both rows
readDoc(ctx,pid,ref) → string ; writeDoc(ctx,pid,ref,text) → {lastEdited}
   ref = {kind:'note',id} | {kind:'workspace',goalId,topicId} | {kind:'future',goalId}
```
`meta.json` shapes: goal `{id,box,created}`, topic `{id,status,context,created}`, project `{id,created}`. Ids via `crypto.randomUUID()`. Directory names via `sanitizeName` + `uniqueDirName`. Goal/topic lookup walks directories and reads `meta.json` (no cache).
- [ ] Tests (temp root): create → list; rename project moves dir and rewrites the library note path; goal/topic dirs and meta; createNote writes flat md + both rows; workspace doc read/write; future.md round-trip.
- [ ] Implement, run, commit.

### Task 5: Library store + seeds + annotations

**Files:** Create `src/main/store/library.cjs`, `fixtures/problems.csv`, `test/library.test.cjs`.

**Produces:**
```js
seedIfEmpty(ctx, fixturesDir) → count      // copies fixtures into ${testRoot}/seed/, inserts: paper (hypocompass.pdf, name 'How to Teach Programming in the AI Era?'), website (https://arxiv.org/abs/2310.05292), git_repo (url https://github.com/mqo00/hypocompass, folder_path null), dataset (seed/problems.csv, name 'backend/problems')
listLibrary(ctx) → rows
readLibraryFile(ctx,id) → {name, bytes:Uint8Array}   // only rows with a path inside allowed roots (seed dir, ~/Downloads, ~/Desktop, ~/Documents, home) and extension .pdf
readAnnotations(ctx,id) → object|null ; writeAnnotations(ctx,id,obj) → true   // ${testRoot}/annotations/${id}.json
```
- [ ] Tests: seed inserts 4 rows once (second call inserts 0); annotations round-trip; readLibraryFile rejects a non-pdf path.
- [ ] Implement, run, commit.

### Task 6: IPC + preload + terminal wiring

**Files:** Create `src/main/ipc.cjs`; modify `src/main/index.cjs`, `src/preload.cjs`; copy ET terminal modules to `src/main/terminal/` and `test/session.integration.cjs`, `test/launch.test.cjs`, `test/lifecycle.test.cjs`.

**Produces:** `window.engelbartAPI` = every function in Tasks 4–5 plus `config`, `setTestMode`, `openExternal`, `revealInFinder(path)`; `window.terminalAPI` = ET contract (`docs/bridge-contract.md` of ET). All handlers wrapped in `trustedHandler`; every argument type-checked (strings ≤ 4096, ids uuid regex, enums).
- [ ] Register terminal IPC exactly as ET `registerIpc()`; menu with File/Edit/View/Session; quit confirmation when PTYs run.
- [ ] `npm run build && npm start`; DevTools console: `await engelbartAPI.config()` works. Commit.

### Task 7: Renderer foundation + Home

**Files:** Create `src/renderer/api.js`, `src/renderer/ui/Button.jsx` (port of `design/.../components/actions/Button.jsx`), `src/renderer/ui/Icons.jsx` (GH, PDF, LAYERS, WS, NOTE, IMAGE from `Goal Canvas.dc.html` lines 395–402), `src/renderer/App.jsx`, `src/renderer/screens/Home.jsx`.

**Produces:** `App` state `{screen:'home'|'canvas'|'workspace', projectId, goalId, topicId, project /*loadProject tree*/, library}`; `reload()` refetches the tree; `KIND` map `{note,paper,git_repo,dataset,website}` → `{glyph, label}` with labels `note · pdf · git repo · dataset · link`.
- [ ] Home: wordmark, `+ Project` (top-right, left of the pill), inline name field (DS field styling), cards grid, click name → rename input.
- [ ] Manual check + commit.

### Task 8: Canvas

**Files:** Create `src/renderer/screens/Canvas.jsx`.

Port lines 49–99 (template) and `renderVals().boxes`, `onWheel`, `openGoal`, `canvasStyle/wsStyle` (lines 475–486, 604–631, 1019–1024). Goals of the loaded project grouped by `box`; `sources` of a goal = union of its topics' `context` ids + notes with `goalId` (KIND icons + titles); topic previews from the tree. Add `+ Goal` (micro-caps, right of the box header, inline name field, box = that box). Transition phases `pre-open → opening → workspace` drive `App.screen`.
- [ ] Manual check: zoom/pan, open, Esc back. Commit.

### Task 9: Workspace shell

**Files:** Create `src/renderer/screens/Workspace.jsx`, `src/renderer/workspace/{Rail,DocTabs,CtxModal,RightPane}.jsx`.

Port lines 101–192 (header, rail, separators, tabs) and 192–328 (right pane tabs) with placeholders for Live preview (card + word *placeholder*) and Dataset (*placeholder*); the terminal slot below the preview is a `<div id="terminal-slot">` until Task 13. Rail actions call `engelbartAPI` then `reload()`. CtxModal options: New note, Library (list of library rows not yet in the topic; click adds to `context`).

**Produces for Tasks 11–13:** props contracts
```
<DocEditor docRef text onChange(text) library topicContext onOpenItem(item) onMention(name) placeholderReply(prompt)→string buildSpeed='normal'/>
<PaperView item={libraryRow} bytes marks onMarksChange(marks)/>
<TerminalPane cwd projectId visible/>
```
- [ ] Manual check + commit.

### Task 10: Editor model (pure)

**Files:** Create `src/renderer/model/doc.js`, `test/doc-model.test.cjs`.

Extract from lines 439–456 and 692–730, 801–812: `TODO_RE, HEAD_RE, IMG_RE, CHAT_RE, QUOTE_RE, INLINE, parseLine, todoLine, esc, tokShown, rawOffset, tokensOf, inlineHtml(text, {mentionAttr})`.
- [ ] Tests: `parseLine('  - [x] a')` → `{type:'todo',depth:1,done:true,text:'a'}`; `parseLine('@chat hi')` → chat; `todoLine(2,false,'x')==='    - [ ] x'`; INLINE splits `**b** and @[n]`; `rawOffset` maps display→raw across a bold token.
- [ ] Implement, run, commit.

### Task 11: DocEditor (port)

**Files:** Create `src/renderer/workspace/{DocEditor,MentionMenu,Popover}.jsx`.

Port lines 458–466 (state), 492–512 (listeners), 678–983 (document engine) into a class component holding `text` from props and reporting changes via `onChange`; keep `history/future`, caret mapping (`segs/displayToRaw/rawToDisplay`), `editorKey/editorInput/editorPaste(text only)/editorClick`, todo build simulation (`buildIdx/setStatus/shiftStatuses`, HELD labels), `askInline` inserting `> ` reply lines from `placeholderReply`, mention menu (chat + library rows), popover on hover, ⌘1–9 handled by DocTabs, not here.
- [ ] Manual check of the caret bug the design fixed (`happy` must not become `appyh`). Commit.

### Task 12: PaperView (port)

**Files:** Create `src/renderer/pdf/PaperView.jsx`.

Port lines 518–602 using `pdfjs-dist` 6 (`getDocument({data:bytes})`, `new TextLayer({textContentSource, container, viewport}).render()`, `GlobalWorkerOptions.workerSrc='./pdf.worker.min.mjs'`), rough.js from npm (`rough.svg`), Caveat via fontsource. Marks in/out via props; debounce `onMarksChange` 300 ms; re-layout on width change (`fitPdf`).
- [ ] Manual check: select+type note with arrow, select+Enter highlight, click-anywhere note, persistence after reopening. Commit.

### Task 13: TerminalPane (port)

**Files:** Create `src/renderer/terminal/TerminalPane.jsx`, copy `~/experimental-terminal/src/renderer/helpers.cjs` → `src/renderer/terminal/helpers.cjs`, `test/renderer-helpers.test.cjs`.

Port `makeTerminalRecord/queueOutput/applyExit/addSession/removeSession/fitActiveTerminal/createSession` and the `onData/onExit` pending-event merge from ET `index.js` (lines 291–430, 746–764) into a component that bootstraps once (module-level singleton so sessions survive unmount), shows a small tab row (`shell · claude · codex` launchers + open sessions), theme `{background:'#0a0a0a', foreground:'#ededed'}`, font 12px Source Code Pro. First mount with no session for `projectId` → `createSession({provider:'shell', cwd})`.
- [ ] `npm run test:pty` passes (ET's integration test). Manual check: `claude` launcher starts Claude Code. Commit.

### Task 14: Integration, verification, packaging

- [ ] Mentions → topic context (union) shown in the rail; click a mention / rail item: paper → right pane Paper + load bytes/marks; website/git_repo → `openExternal`; note → tab; dataset → Dataset placeholder.
- [ ] Autosave (400 ms) for workspace/note/future docs; `last_edited` touch.
- [ ] ⌘1–9 tabs, Esc closes workspace when nothing is focused; test pill toggles and persists.
- [ ] Walkthrough with screenshots → `docs/verification.md`; `README.md` (run, package, layout, kinks); `npm run package` produces `release/Engelbart-darwin-arm64/Engelbart.app`; smoke-launch it. Commit.
