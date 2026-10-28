# EngelbartStage — public surface

The Stage: the right pane that opens anything (browser tabs as WKWebViews, files, pictures, web and disk pdfs through the
host's pdf viewer), its page script (highlights, boxes, selection cards, sections, find with counts), sign-ins (popups,
HTTP auth, permissions, external apps, cookie import from Chrome-family browsers, Firefox and Safari). Ledger:
`mac/parity/stage.md`. Depends on Core, UI and Doc. One definition each, Doc's: `Kind`/`LibRow` (`StageRow` is a
typealias of `LibRow`), `PassageLink`, `PassageText`, `AddressKey`, `MarkdownFile`, `SelectionCard`,
`MarkAnswers.withAsk`, `WebName`. The Stage keeps only what Doc lacks: `GitHubPages` (shared/github.cjs).

## Entry points

- `StageController(host: StageHost, pageMarks: StagePageMarks? = nil)` — an `NSViewController`; its view is the whole
  pane (tab strip, address row, content). One per window/project.
  - Open: `openRow(_ row, find:, to:, newTab:, page:)`, `openInput(_ href, newTab:, sections:)` (links, `#find=` passages,
    paths, words → search), `openFile(_ path)`, `openPaths(_ paths)`, `newTab()`, `closeTab(_ id?)`, `tabAt(_ index)`.
  - What is in front: `front() -> JSONValue?` (`{kind:'web', url, title, tab}` or `{rowId, url, page, kind:'pdf'}`…).
  - Host-set state: `visible` (Stage vs Terminal mode), `full` + `onFull`, `save: StageSave?` (the address field's save
    button, from `stagePageChanged`), `pendingAsks: [JSONValue]` (the workspace's running asks), `onImportSignins`.
  - Keys: `handleKey(_ event, inTerminal:) -> Bool` from the app's key monitor (⌘T, ⌘W, ⌘F, ⌘G, ⇧⌘G as Stage.jsx);
    `menuFind("find" | "find-next" | "find-previous")` from Edit ▸ Find; `shortcut(_ name, from:)`.
  - `landAnswer(rowId:url:page:markId:entry:)` — an ask's answer onto every tab holding that pdf (`paper-ask-done`).
  - `teardown()` — keep the tabs now and close every page (project closes / window goes).
  - `browser: BrowserViews` — the pages (below), for the host's @bart turn: `pageSelection(id)`, `screenshot(id)`,
    `overleafTabs()`, `evaluateInPage(id, script, timeout)`; and Save: `savePage(id, into: dir)`.
- `BrowserViews` (window-level, Electron's `createBrowserViews`): `open/show/hide/command/find/stopFind/section/close/
  closeAll/answerLogin/startBox/endBox/undoBox/setBoxAsks/highlightSelection/savePage/pageSelection/screenshot`.
- `StageSession.shared` — the Stage's browsing session. **Its data store `StageSession.shared.dataStore` is
  `WKWebsiteDataStore(forIdentifier: StageSession.identifier)` (8E1A6C1E-5747-4E5B-9A0B-5354A6E4B001; a run from a
  checkout uses `devIdentifier` …B0DE).** The Connect package's sign-in windows must use this data store so agents see the
  same cookies. Also: `cookieStore` (a `StageCookieStore`), `probe(url, readBody:, timeout:)` (sign-in check without
  following redirects), `cookieImport(userDataDir:installedApps:)`, `dropGithubSession()`, `decide(origin:permission:…)`.
- `CookieImport` (MATH-18): `sources()`, `installedChromium()`, `domains(browser, profile)`, `cookieNames(…)`,
  `check(domain)`, `checkDetail(domain)`, `canRead(browser)`, `run(browser:profile:domains:quiet:)`, `unlock(browser)`,
  `ready(browser)`; `CookieBrowsers` (ids, Keychain names, bundle ids, `bundleOf`), `SignInCheck` (verdict rule, defaults),
  `KeychainRunner.read(service)`, `SafariCookies`, `CookieFormats` (pure decryption and database reading).
- `InstalledApps` — `has`, `ask`, `settled`, `where_`; honours `ENGELBART_INSTALLED_BROWSERS`.
- `StageLinks` — the main window's new-window links (`listen`, `windowOpen`, `parseExternalUrl`, `windowOpenRoute`).
- Pure models: `StageModel` (placeTab, linkPlan, tabKey, stageSnapshot, restoreTabs, stageRows, tab widths…),
  `StageAddress` (kindOf, stripScheme), Doc's `AddressKey`, `WebName`,
  Doc's `Kind`, `PassageLink`, `PassageText`, `MarkdownFile`, `SelectionCard`; `StageFiles.readStageFile`,
  `BrowserRules` (address/pdf rules, page-message shapes), `Boxes` (boxesCss, cardPlace, crops).
- `StageResources.pageScript` — Resources/page.js, generated from `src/main/browser/page-preload.cjs` by
  `Scripts/gen-page-js.py` (rerun after that file changes).

## What the app must provide

- `StageHost` (protocol, MainActor): project id/folder; `library()`, `inRail`, `lookupLibraryItem`; `readStageFile(input)`
  — resolve inside the home folder as projects.cjs `resolveTypedPath` (relative: project dir, data root, root, code dir)
  then `StageFiles.readStageFile(path, cacheDir: <data root>/.cache/stage)`; `readLibraryFile`; annotations read/write
  (row and page); `stage()`/`setStage()` (state.json `stages`, the Store's cleanStage); `pickPaths()`; `openExternal`;
  `makePDFView(StagePDFRequest) -> StagePDFViewing` (the PDF package's PaperView); `ask`/`stopAsk`/`dismissAsk`;
  `openMention`; `openCited`; `stagePageChanged`/`stageFrontChanged`/`stageTabsChanged`; `showStage`; `keysToDoc`;
  `previewRow(for:)`/`openBuildDetails`/`previewTouch` (Sandbox).
- `StagePageMarks` (optional): the library's web marks (`library.cjs` addWebMark, removeWebMark, restoreWebMark,
  updateWebMark, readPageAnnotations' `web` list); `crop` is a box's PNG to keep as `crops/<name>.png`.
- A key monitor that calls `handleKey`, and Edit ▸ Find items that call `menuFind`.

## Events posted (EventHub, Electron channel names)

`browser:state`, `browser:pdf`, `browser:found`, `browser:open-tab`, `browser:closed`, `browser:login`,
`browser:focus-address`, `browser:focused` `{id}` (⌘T/⌘W/⌘F go to the side clicked last), `browser:shortcut`
`{name, tab}`, `engelbart:next-workspace` (⌘J pressed in a page), `browser:boxing` `{id, on}`, `browser:box-removed`,
`browser:box-restored`, `browser:box-ask` (handled by the controller through `StageHost.ask`), `browser:box-stop`.
Listens: `engelbart:open-in-browser` `{url}` (a terminal link → a new tab).

## Needs from other packages

- PDF: a `StagePDFViewing` adapter around PaperView (find with counts, sections, current page, addAsk), built by the host.
- Store: `stage`/`setStage`, annotations, web marks, readStageFile's path resolution, lookupItem; `addressKey` must agree
  with `StageAddressKey.addressKey` (same rules as shared/address-key.cjs).
- Connect: use `StageSession.shared.dataStore` for its sign-in windows; `StageSession.shared.cookieImport(…)` for copies.
- Integrations (Overleaf): its CodeMirror read script, run through `BrowserViews.evaluateInPage`.
- Workspace (wave 2): RightPane (Stage | Terminal), the key monitor, Save's card actions (`StageSave`).

## Decisions recorded (see the ledger)

- User agent: WKWebView's own plus `Engelbart/<version>`; no Safari/Chrome tokens added (Hudson's call; Google may refuse
  sign-in in an embedded WebKit view).
- insertCSS → constructed stylesheets adopted from the isolated world (no DOM node); findInPage → the page script's own
  find with CSS highlights and counts (Chromium's yellow/orange).
- Developer tools: WebKit's private `_inspector show`; Inspect Element is WebKit's own context-menu item.
- Notifications, geolocation and clipboard-read prompts: n/a (WKWebView has no public hooks).
