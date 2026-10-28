# Parity ledger: the Stage (right pane: browser tabs, files, images, web pdfs)

Package `mac/Packages/Stage` (module `EngelbartStage`). Sources: `src/main/browser/*`, `src/main/stage/files.cjs`,
`src/main/stage-links.cjs`, `src/main/window-open.cjs`, browser/stage parts of `src/main/index.cjs`, `ipc.cjs`,
`preload.cjs`, `src/renderer/workspace/Stage.jsx`, `RightPane.jsx`, `RecentPages.jsx`, `ImportSignins.jsx`,
`src/renderer/box-card/*`, `src/renderer/model/{stage,address,web-name,kind,markdown}.js`, `src/shared/{address-key,
github,passage-link,passage-text,selection-card}.cjs`; spec §2 #48 #49 #51 #78 #85–#91; STAGE-TWEAKS.md; memory notes.

Electron → WebKit mappings (decided here, see rows): one `WKWebView` per tab in `WKWebsiteDataStore(forIdentifier:
StageSession.identifier)` (= `persist:browser`); a debug (unbundled) run uses `StageSession.devIdentifier` (= 
`persist:browser-dev`). The page preload is `Resources/page.js`, a `WKUserScript` in the content world `engelbart-page`
(= contextIsolation) talking over `WKScriptMessageHandler(WithReply)` named `engelbartPage`; main → page goes through
`window.__engelbartPage.receive(channel, payload)` in that world. `insertCSS` = a constructed `CSSStyleSheet` added to
`document.adoptedStyleSheets` from the isolated world (no DOM node). The drawing layer and both cards are native views.
A native view in AppKit can be covered by other native views, so Electron's snapshot-under-overlay machinery is n/a.

Status: `done` = implemented and checked by a test or a run; `partial: …`; `todo`; `n/a: …`.

## A. Addresses (model/address.js, web-name.js, shared/address-key.cjs, shared/github.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| A1 | kindOf: '' / about:blank → blank; `sandbox:` → sandbox with name (default 'sandbox'); `file://` → disk; path-like (`/ ./ ../ ~/` or name.md/txt/py/js/ts/json/csv/html/css/pdf) → file | address.js kindOf | Address.swift | done |
| A2 | kindOf: `3000`, `:5173/docs` → local `http://localhost:<port><rest>` | address.js | Address.swift | done |
| A3 | kindOf: localhost, *.localhost, *.local, [::1], 0.0.0.0, 127/8, 10/8, 192.168/16, 169.254/16, 172.16–31, bare `name:port` → local with http:// unless scheme given; 0.0.0.0 rewritten localhost | address.js isLocalHost | Address.swift | done |
| A4 | kindOf: a scheme → web as typed; words or a non-web host → `https://www.google.com/search?q=` + encoded; else `https://` + input | address.js | Address.swift | done |
| A5 | stripScheme: '' for blank; file:// shown as decoded path; scheme hidden only when typing the rest leads back to the same place | address.js stripScheme | Address.swift | done |
| A6 | webLabel/webName/isAddress/sameAddress (mention names: title unless it is the address; host+path, ≤60 chars with …, 'Untitled page') | web-name.js | Doc (WebName.swift, one definition) | done |
| A7 | addressKey: http/https, www., trailing slash, #fragment, tracking params (utm_*, fbclid, gclid, mc_cid, mc_eid, ref) ignored; other query kept; other schemes lose #fragment only; non-URLs as they came | address-key.cjs | Doc (AddressKey.swift, one definition) | done |
| A8 | isPreviewAddress: localhost, *.localhost, ::1, 0.0.0.0, 127.x, *.e2b.app/.dev (http/https only) | address-key.cjs | Doc (AddressKey.swift, one definition) | done |
| A9 | isGithubSignIn (github.com/www/gist; login, logout, session(s), signup, join, password_reset, login/oauth|device, auth, apps/*/installations, settings/installations|connections/applications|apps/authorizations; no userinfo) | shared/github.cjs | GitHubRules.swift | done |
| A10 | endedGithubSession(from,to): a non-sign-in GitHub page redirected to github.com/login; GITHUB_SESSION_COOKIES = user_session, __Host-user_session_same_site | shared/github.cjs | GitHubRules.swift | done |
| A11 | OPEN_IN_BROWSER ('engelbart:open-in-browser'): a terminal link asks for a page in a new tab → openInput | address.js, Stage.jsx | StageController (EventHub) | done — compiled, untested (EventHub engelbart:open-in-browser → openInput) |

## B. Library kinds (model/kind.js)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| B1 | hasTag/isNote; kindKey (git tag first; md → note/md; csv,tsv,json,jsonl,parquet,xlsx → data; else type) | kind.js | Doc (Kind.swift, one definition) | done |
| B2 | KIND_ORDER note, md, docx, pdf, git, folder, website, html, data; unknown last (kindRank) | kind.js | Doc (Kind.swift, one definition) | done |
| B3 | kindLabel: type ('link' for website) then tags, joined ' · ' | kind.js | Doc (Kind.swift, one definition) | done |
| B4 | LIBRARY_CHIPS all/notes/papers/repos/web/files/assets with nouns; libraryFilter (create source → all+assets only; images under none; files = no other chip); libraryCounts | kind.js | Doc (Kind.swift, one definition) | done |

## C. Stage model (model/stage.js, rail.js looksAddable, markdown.js, passage-link, passage-text)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| C1 | MAX_TABS = 15 | stage.js | StageModel.swift | done |
| C2 | splitTarget: `#find=` passage (decoded), `&to=`, cite/counter/note/page keys in any order; other fragments stay on the address; a path's %-encoding decoded | passage-link.cjs | Doc (PassageLink.swift, one definition) | done |
| C3 | guideSections(replyLines, address): links with #find= to that address, in order, each (find,to) once, code spans ignored, label whitespace-collapsed | stage.js | StageModel.swift | done |
| C4 | sectionAt, withPassage (pendingFind/To/Page, sections, activeSection), landTab, landingFinds (no find card in a pdf with sections) | stage.js | StageModel.swift | done |
| C5 | rowForAddress (path, file: address or addressKey of url; only onStage rows), libraryAddress (arXiv pdf/version → abs, DOI → doi.org), paperRow | stage.js | StageModel.swift | done |
| C6 | SAVE_LABEL none '+ Save', lib '+ Workspace', here '✓'; savesPageCopy (web page in a tab, found website with no tags) | stage.js | StageModel.swift | done |
| C7 | linkPlan(href, library) → {address, find, to, page, row, key}: passage/cite to a library row opens it (`i:<id>`); page addresses key `l:<addressKey>`; a passage in a path keys its file: address | stage.js | StageModel.swift | done |
| C8 | tabKey: restore → kept key; item → `i:`; file path / pdf url / url → `l:<addressKey>`; blank '' | stage.js | StageModel.swift | done |
| C9 | placeTab: open comes forward (also-key too); blank front not pdf/file/claimed is replaced; at 15 replace front; else append; newTab skips the focus rule | stage.js | StageModel.swift | done |
| C10 | stageSnapshot: {active, tabs}: rows as {item,title}, places {address,title} (pdf input, file path, url); blank, popups (from), loading/error files, sandbox, about: never kept; title ≤200 | stage.js | StageModel.swift | done |
| C11 | restoreTabs: kept tabs back unopened in order, rows gone from the library dropped, duplicates once, what was opened meanwhile kept once, lone untouched tab gives way, ≤15 (drop made ones), front = saved.active's | stage.js | StageModel.swift | done |
| C12 | WAKE_MS 60000, WAKE_RETRY_MS 3000; previewWait → waking / failed after a minute / nil once drawn; previewName (last path part of the row's name) | stage.js | StageModel.swift | done |
| C13 | afterClose: right neighbour, else left; -1 when none | stage.js | StageModel.swift | done |
| C14 | TAB_MAX_W 220, TAB_MIN_W 36, TAB_NARROW_W 90, TAB_ICON_X_W 56, TAB_ICON_SIDE_W 50; tabWidth; tabLook full/icon/icon-x/x | stage.js | StageModel.swift | done |
| C15 | tabPlace: '' for blank; path as is; file:// decoded path; site host (no scheme/www) | stage.js | StageModel.swift | done |
| C16 | onStage: not notes, workspaces, children; folder only with url or folder_path; else url or path | stage.js | StageModel.swift | done |
| C17 | looksLikePlace (looksAddable, http(s), ports, localhost, bare host, path-like); looksAddable (rail.js) | stage.js, rail.js | StageModel.swift | done |
| C18 | stageRows: a typed place is one row (library's row via lookup when onStage, else place); words: workspace rows then library (6 each, never notes), web search; 'disk' row last always | stage.js | StageModel.swift | done |
| C19 | parseTable: quotes, doubled quotes, delimiter/newlines in quotes, CRLF, limit | stage.js | StageModel.swift | done |
| C20 | markdownBlocks (h/p/li ordered marker depth checked/quote merged/code fence/hr) and inlineRuns (code, bold, italic, links, bare http(s)) | markdown.js | Doc (Markdown.swift, one definition) | done |
| C21 | matchPassage/foldPassage (case, spaces, quotes, dashes, ligatures, soft hyphen, line-end hyphen joins, prefixes, markdown) for find in a drawn file | passage-text.cjs | Doc (PassageText.swift, one definition) | done |

## D. Tabs (Stage.jsx tab strip)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| D1 | Starts with one blank tab; closing the last leaves a fresh blank tab | Stage.jsx dropTab | StageController | done (cloud: StageControllerTests) |
| D2 | Closing the tab in front: back to the tab that opened it (`from`), else afterClose | Stage.jsx dropTab | StageController | done — compiled, untested |
| D3 | Strip 40pt tall, #fafafa, padding 0 8 0 10; tabs 34pt tall; widths from room (strip width − 18 − 40 − 28 when full-screen button) | Stage.jsx | TabStripView | done — compiled, untested (look) |
| D4 | Front tab white, radius 10 top corners, 10px concave curves at both feet; others no box, hover wash #f2f2f2 radius 8 margin 0 2 4; 1×16 #c9c9c9 separators between unfocused tabs | Stage.jsx | TabStripView | done — compiled, untested (look) |
| D5 | Tab look: full (glyph 16, title 12.5px fading mask 22px, × 20 round), icon-x, x, icon (× appears at right edge under the pointer, icon shifts left; a crowded tab hides its icon) | Stage.jsx, 7b7d1dc, ee6c231 | TabStripView | done — compiled, untested (look) |
| D6 | Title: restore title/row name/address; row name; pdf name; file name; 'New tab' (#8f8f8f) for blank; page title else stripped url | Stage.jsx titleOf | StageController.titleOf | done (cloud: titleOf) |
| D7 | Hover card after 650ms (60ms while warm, warm until 400ms after leaving): title 13/500 and place 12 #8f8f8f; 160–260 wide; not for the front tab unless narrow | Stage.jsx enterTab | TabStripView | done — compiled, untested |
| D8 | Middle click closes; a close by mouse freezes widths until the pointer leaves the strip; a new tab unfreezes | Stage.jsx | TabStripView | done — compiled, untested |
| D9 | Right-click menu: Close tab, Close other tabs (disabled <2), Close tabs to the right (disabled at last) | Stage.jsx openTabMenu | TabStripView | done — compiled, untested |
| D10 | Strip scrolls when tabs are at 36pt; wheel scrolls sideways; fades 28px at scrolled edges; front tab scrolled into sight with 28px margin | Stage.jsx | TabStripView | done — compiled, untested |
| D11 | + button 28 round, disabled at 15 (opacity .4, tooltip '15 tabs is the most — close one first'), tooltip ⌘T | Stage.jsx | TabStripView | done (cloud: 15 max); look untested |
| D12 | Full-screen button (Expand/Collapse) at the strip's right, only when the host gives onFull | Stage.jsx | TabStripView | done — compiled, untested |
| D13 | Kind glyph per tab: row, pdf, image/md/docx/csv/html/folder by extension, disk → html, else website; restore by its item/address | Stage.jsx glyphItem | StageController.glyphItem | done — compiled, untested |
| D14 | newTab: nothing at 15; blank tab in front, find closed, the caret in the address (selected) | Stage.jsx newTab | StageController | done (cloud) |
| D15 | ⌘1–9 select the n-th tab (tabAt) | Stage.jsx | StageController.tabAt | done — compiled, untested |

## E. Address row (Stage.jsx)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| E1 | ← → ↻ (× while loading) 26pt buttons; disabled colour #c9c9c9 | Stage.jsx | AddressBarView | done — compiled, untested |
| E2 | Address field 30 tall, #fafafa, radius 8, border #c9c9c9 while typing, kind glyph 14 at its left, 13px sans, no placeholder | Stage.jsx | AddressBarView | done — compiled, untested (look) |
| E3 | Follows the tab (stripScheme of pdf input / file path / restore address / url) unless it has the keyboard; focus selects all | Stage.jsx | AddressBarView | done — compiled, untested |
| E4 | List under the field while typing: stageRows; lookup of a typed place debounced 120ms; ↑/↓ pick, mouse move picks; Enter takes the pick; Enter with nothing typed reloads; Esc restores and leaves | Stage.jsx onAddressKey | AddressBarView | done — compiled, untested |
| E5 | choose: disk → file picker; item → openRow; place/search → navigate in this tab (sections dropped) | Stage.jsx choose | StageController | done — compiled, untested |
| E6 | Save button at the right: + Save (card) / + Workspace (link) / ✓; @create: Save → '✓ Saved' and the crumb 'Library / Assets / name' in place of the field until typed | Stage.jsx | AddressBarView | done — compiled, untested (the made file's Save icon is a text glyph, not Lucide folder-plus) |
| E7 | Save card: name field (selected), Library only / Workspace (Enter), error in red, closes on outside press or Esc, tooltips | Stage.jsx SaveCard | SaveCardView | done — compiled, untested |
| E8 | ⋮ menu: Device preset (Fit panel, iPhone SE 375×667, iPhone 12 Pro 390×844, iPhone 15 Pro Max 430×932, Pixel 8 412×915, iPad mini 768×1024), Custom width (digits), Open in default browser, Developer tools, Import sign-ins… | Stage.jsx | StageController.moreMenu | partial: Custom width is asked in an NSAlert field, not an inline field in the menu; the rest compiled, untested |
| E9 | Box button (dashed square glyph) only on a boxable page; on (#f2f2f2, blue) while boxing | Stage.jsx | AddressBarView | done — compiled, untested |
| E10 | 'Box removed · Undo' toast in the address row for 5 s | Stage.jsx | AddressBarView | done — compiled, untested |
| E11 | onPage(host): savable page {input, title, bytes (web pdf), tabId, webPage}; onFront(row id); onTabs(places) | Stage.jsx | StageHost callbacks | done — compiled, untested (StageHost.stagePageChanged / stageFrontChanged / stageTabsChanged) |

## F. Opening and loading

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| F1 | openRow: GitHub sign-in row → default browser; claim `i:<id>` (also its address); showRow | Stage.jsx | StageController.openRow | done (cloud) |
| F2 | showRow: pdf row → library bytes (loading, error), ink by row; url (not an html/image with path) → load; path → readPath; folder_path → readPath | Stage.jsx showRow | StageController | done (cloud: pdf row → viewer request) |
| F3 | openInput: linkPlan; a row → openRow with passage; GitHub sign-in → default browser; claim key; navigate | Stage.jsx | StageController.openInput | done (cloud: GitHub sign-in → openExternal) |
| F4 | navigate: path-like (disk, file, or an unschemed name with an extension that is not a TLD) → stage-file via host; failure on file/disk shows the error; else tries https:// | Stage.jsx navigate | StageController | done — compiled, untested |
| F5 | openFile / openPaths (at most 15 tabs, each a tab of its own unless open) ; chooseFiles (NSOpenPanel through host.pickPaths) | Stage.jsx | StageController | done (cloud: openPaths / openFile) |
| F6 | apply(result): pdf → viewer + ink; page/doc → load file: url (doc keeps the file); else drawn here | Stage.jsx apply | StageController | done (cloud: md, pdf) |
| F7 | A local server refused (code −102 / NSURLErrorCannotConnectToHost) is retried every 2 s while in front | Stage.jsx | StageController | done — compiled, untested (NSURLErrorCannotConnectToHost mapped to −102) |
| F8 | Preview waiting: Waking <name>'s sandbox… / Couldn't load …'s preview with Retry and Build details; reload every 3 s while waking and failed | Stage.jsx | StageController | done — compiled, untested |
| F9 | Load failure: Plain (address, description or 'error <code>') with Retry; a refused page (outside home) fails like one that did not load | Stage.jsx | StageController | done (cloud: missing path); a page failure compiled, untested |
| F10 | Back/Forward/Reload rules: pdf Back → page under it (pdfForward), Forward → the pdf again; Reload of a pdf refetches/rereads; a file rereads | Stage.jsx | StageController | done — compiled, untested |
| F11 | Page state: url follows the page; the pdf goes when the page under it moves; a row's tab leaves the row when the page goes elsewhere; a doc's file goes when the page leaves disk | Stage.jsx onBrowserState | StageController | done — compiled, untested |
| F12 | Blank tab: 'Engelbart' 34/500 −0.4 tracking and Choose a file… button | Stage.jsx | BlankView | done (cloud: blank after the last close); look untested |
| F13 | Restore: kept tabs come back on project open; a row opens when it comes forward (gone → tab closes), a place navigates; written 150ms after a change and on close | Stage.jsx | StageController | done (cloud: kept tabs come back) |
| F14 | front(): {kind:'web', url, title, tab} for a page; pdf {rowId,url,page,kind:'pdf'}; else {kind:'file'|'page'}; >4096 address → nil | Stage.jsx front | StageController.front | done (cloud: a pdf in front) |
| F15 | An adopted tab (a page's new window) arrives with its view; tab.from = opener | Stage.jsx adoptTab | StageController | done — compiled, untested |

## G. Files on the Stage (main/stage/files.cjs, Stage.jsx views)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| G1 | readStageFile kinds: folder, pdf (≤200 MB, bytes, file url), page (.html/.htm), image (png/jpg/jpeg/gif/webp/svg ≤50 MB), heic/heif via sips → jpeg, docx/doc/rtf/odt via textutil → html page, md/markdown, csv/tsv table, text, unsupported (NUL in first 8 KB or >2 MB) | files.cjs | StageFiles.swift | done |
| G2 | Text cut at 500 000 chars with truncated | files.cjs | StageFiles.swift | done |
| G3 | Conversion cache `<data root>/.cache/stage/<sha256(path\nmtimeMs\nsize)[:32]>.ext`, made once per version, temp then rename, 30 s timeout | files.cjs | StageFiles.swift | done |
| G4 | readFailure: ENOENT 'Nothing is at that path'; EPERM/EACCES 'macOS blocked Engelbart from reading this file. Allow access in System Settings → Privacy & Security → Files and Folders.' | files.cjs | StageFiles.swift | done |
| G5 | Markdown view: max 65ch centred, 14.5/1.7, headings 22/18/16/14.5, list markers/boxes, quotes, code blocks, rules; links open on the Stage | Stage.jsx MarkdownView | FileViews.swift | done — compiled, untested (look) |
| G6 | Table view: 2000 rows, row numbers, header row #fafafa/500, 200-wide cells, 'N(+) rows · M columns' | Stage.jsx TableView | FileViews.swift | done — compiled, untested |
| G7 | Text view: mono 12.5/1.7 pre-wrap; image view centred, contain; folder/unsupported/error Plain | Stage.jsx | FileViews.swift | done — compiled, untested |
| G8 | Paths resolved by the host (resolveTypedPath: ~, absolute, project dir, data root, root, code dir; home only) | projects.cjs | StageHost.readStageFile | done — the host resolves (StageHost.readStageFile), documented in API.md |

## H. Find (⌘F/⌘G)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| H1 | Find card at top right (top 10, right 14, ≤360 wide, 34 tall, border #c9c9c9 radius 8): query, 'n of m' / '0 matches' (red), ↑ ↓ ×; Enter/⇧Enter step; Esc closes | FindCard.jsx | FindCardView | done — compiled, untested (look) |
| H2 | Over a page a 54pt band holds the card so the page is never covered | Stage.jsx | StageController | done — compiled, untested |
| H3 | Page find with counts (in-page highlights; new query starts over, same steps, case-insensitive; empty stops) | views.cjs find | page.js find + PageTab | done (cloud: 2 matches, steps to 2 of 2) |
| H4 | PDF find through the viewer (host PDF view); drawn file find over its text (matchPassage fallback for ≥3 words) | Stage.jsx runFind | StageController | done — compiled, untested (pdf through the host's viewer; a file through TextFileView/TableFileView) |
| H5 | ⌘F while the Stage shows and has the keyboard or nothing editable has it; ⌘G/⇧⌘G step while finding; Edit ▸ Find menu routes here with the tab whose page has the keyboard | Stage.jsx, views.cjs shortcut | StageController.menuFind | done (cloud: ⌘F opens the card); the menu route compiled, untested |
| H6 | A link's passage lands once ready: pdf via viewer target (find card unless guide sections), page via section then find, file via find without the card | Stage.jsx land | StageController | done (cloud: a drawn file lands with no card; a page's section shown) |
| H7 | Sections menu over a pdf (guide's sections): label, list with ✓, × clears | Stage.jsx SectionsMenu | SectionsMenuView | done — compiled, untested |

## I. Pages (views.cjs rules)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| I1 | One persistent data store for every tab and popup (WKWebsiteDataStore(forIdentifier:)); a debug build keeps its own (persist:browser-dev) | views.cjs PARTITION | StageSession.swift | done — compiled, untested (WKWebsiteDataStore(forIdentifier:) with fixed UUIDs, packaged vs checkout) |
| I2 | parseBrowserUrl: bounded (≤8192), http/https only, 0.0.0.0 → localhost | views.cjs | BrowserRules.swift | done |
| I3 | parseFileUrl: file: without host, real path inside home (links followed; a missing file judged where it would be); 'Only files inside your home directory can be opened' | views.cjs | BrowserRules.swift | done |
| I4 | allowed(url, from): about:blank; http(s) from anywhere; file: only from a disk page | views.cjs allowed | BrowserRules.swift, PageTab | done (cloud) |
| I5 | externalScheme + handOver: 'Open this <scheme>// link in its app?' (detail the url ≤300), Open / Don't Allow, one question at a time; internal schemes never offered | views.cjs | PageTab | done — compiled, untested (NSAlert, one question at a time) |
| I6 | Self-signed certificates accepted on loopback hosts only | views.cjs isLoopback | PageTab | done — compiled, untested |
| I7 | User agent: Electron's token removed, app token kept (WKWebView: applicationNameForUserAgent 'Engelbart/<version>') | views.cjs cleanUserAgent | StageSession | done — compiled, untested (applicationNameForUserAgent Engelbart/<version>; no Safari tokens added: Hudson to decide, see memory note on UA spoofing) |
| I8 | Pdf answers never shown inline: application/pdf (or x-pdf), or a download that is a .pdf by name or address → bytes (≤200 MB) to the viewer, name from file name else last path part, 'pdf' default; loading state first; 'The pdf is larger than 200 MB' / 'The pdf did not download' | views.cjs receivePdf | PageTab (WKDownload) | done — compiled, untested (navigationResponse → .download → WKDownload → temp file → viewer, 200 MB cap) |
| I9 | A pdf on disk is read, never loaded ('Nothing is at that path'); a disk page linking to a disk pdf opens it in the viewer | views.cjs openPdfFile | PageTab | done (cloud) |
| I10 | A first load cancelled with no page (204, no answer) is an error 'The page did not load'; not after a page, a replaced load, a pdf download, or a GitHub retry | views.cjs did-stop-loading | PageTab | done — compiled, untested |
| I11 | browser:state {id, url (pending/error url until commit), title, loading, canGoBack, canGoForward, error {code, description, url}, drawn} | views.cjs emit | PageTab → StageController | done (cloud: url, title, drawn, loading) |
| I12 | command back/forward/reload (reload of an error reloads its url, keeping the error until a page arrives)/stop/devtools (Web Inspector: isInspectable) | views.cjs command | PageTab | done — compiled, untested (devtools through WebKit's private _inspector show; Inspect Element is WebKit's own menu item) |
| I13 | GitHub sign-in pages go to the default browser (open, will-navigate, window.open) | views.cjs | PageTab | done — compiled, untested |
| I14 | A GitHub page redirected to /login by an ended sign-in: its session cookies dropped and the page asked again once | views.cjs will-redirect | PageTab | done — compiled, untested (didReceiveServerRedirect) |
| I15 | Context menu: Open Link in New Tab (allowed links, tabs only), Copy Link, editable cut/copy/paste/select all, Highlight (selection, fileable page), Copy, Back, Forward, Reload, Inspect Element | views.cjs contextMenu | StageWebView.willOpenMenu | done — compiled, untested (the page reports linkURL / selection / editable on contextmenu, ahead of the menu) |
| I16 | savePage(id, dir): not loading ('The page is still loading'), not failed ('The page did not load'), 'That tab is not open'; index.html complete (webarchive → html + index_files), 2 min timeout → {file, url, title} | views.cjs savePage | PageTab.savePage | done (cloud: savePage; the web archive unpacked into index.html + index_files) |
| I17 | Page frame stops 6pt short of the window's right and bottom edges (resize strips) | Stage.jsx WINDOW_EDGE | StageController.layout | done — compiled, untested |
| I18 | Device presets constrain the page width centred on #f2f2f2 | Stage.jsx | StageController | done — compiled, untested |
| I19 | Cookies persist (WKHTTPCookieStore writes itself; flush on quit is n/a) | views.cjs flush | — | n/a: WKHTTPCookieStore persists itself; no flush timer or flush on quit |
| I20 | ⌘R reload, ⌘L focus address, ⌘[ ⌘] back/forward, ⌘J next workspace, ⌘T new tab (focus app), ⌘W close tab (⇧⌘W stays the window's), ⌘1–9 tabs: taken before the page | views.cjs before-input-event | StageWebView.performKeyEquivalent | done — compiled, untested (performKeyEquivalent before the page) |
| I21 | A page taking the keyboard reports browser:focused {id} (⌘T/⌘W/⌘F go to the side clicked last) | views.cjs | StageWebView.becomeFirstResponder | done — compiled, untested (becomeFirstResponder → browser:focused on EventHub) |
| I22 | window.close() from the page closes its tab (browser:closed) | views.cjs destroyed | PageTab webViewDidClose | done — compiled, untested (webViewDidClose) |
| I23 | screenshot(id): PNG, longer edge ≤1568, 1.5 s timeout, nil on failure | views.cjs | PageTab.screenshot | done (cloud: PNG) |
| I24 | pageSelection(id): the page's quote + pageText within 300 ms, else nil | views.cjs | PageTab.pageSelection | done (cloud: whole words, prefix) |
| I25 | overleafTabs / readOverleaf (CodeMirror read in the page's main world, timeout) | views.cjs | BrowserViews.overleafTabs | partial: overleafTabs and evaluateInPage(id, script) in the page's world are here; the CodeMirror read script is the Integrations package's |

## J. Sign-ins, popups, auth, permissions (decision 49)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| J1 | window.open with features → a real child window (min 320×320, white, not full-screenable) keeping its opener; title 'host — title' | views.cjs windowOpenHandler/watchPopup | PopupWindow.swift | done — compiled, untested (PopupWindow: child window, min 320, title host — title) |
| J2 | Any other new window (target=_blank, plain window.open) → an adopted tab around the web view WebKit made (browser:open-tab {id,url,from}) | views.cjs adopt | BrowserViews.adopt | done — compiled, untested |
| J3 | Popups get the same guards (allowed, external schemes, GitHub sign-in, loopback certs, auth) and context menu without Highlight | views.cjs protect | PageTab/Popup | done — compiled, untested |
| J4 | HTTP authentication asks (host, realm; Username/Password; Cancel / Sign in); 5 min timeout; credentials ≤1024 chars | views.cjs login, Stage.jsx LoginPrompt | LoginPromptView | done — compiled, untested (an NSAlert sheet with two fields; 5 min timeout) |
| J5 | Camera/microphone ask once per origin per run: 'Allow <origin> to use the camera or microphone?' Allow / Don't Allow (shared across windows) | views.cjs decide | StageSession.permissions | done — compiled, untested (WKUIDelegate media capture, once per origin per run, shared by windows) |
| J6 | Geolocation, notifications, clipboard-read asks | views.cjs ASKED_PERMISSIONS | — | n/a: WKWebView has no notification API; geolocation and clipboard read are WebKit's own prompts with no public delegate |

## K. Highlights on web pages (MATH-54)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| K1 | Page text map (whitespace runs one space), quote {exact, prefix 32, suffix 32}, max exact 5000, snap to whole words within a text node | page-preload.cjs | page.js | done |
| K2 | Anchor a quote: best prefix/suffix fit among occurrences (Dice + run lengths), first of equals | page-preload.cjs anchor | page.js | done |
| K3 | Marks asked on load (marks for a fileable page only; ≤2000; noted flag), placed and tinted; missed ones retried once after load | page-preload.cjs, views.cjs marksForPage | page.js, BrowserRules.marksForPage | done (cloud: a kept quote painted) |
| K4 | Tint: yellow rgba(255,214,0,.22) with 2px underline rgba(240,190,0,.9) offset 3px; section tint rgba(255,196,0,.13) | views.cjs MARK_CSS | BrowserRules.markCSS | done (cloud: the rule adopted, no DOM node) |
| K5 | Right-click Highlight: quote asked (2 s), saved through host pageMarks.add, tinted; not on previews/local servers | views.cjs highlightSelection | PageTab | done — compiled, untested |
| K6 | Message validation: only the tab's main frame; bounded shapes (quoteInput, selectionInput, selectionCardInput, boxReportInput…) | views.cjs | BrowserRules.swift | done |
| K7 | A same-document navigation re-sends that address's boxes | views.cjs did-navigate-in-page | PageTab | done (cloud: pushState asks the new address marks) |

## L. Selection and highlight cards (2026-10-18)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| L1 | A settled selection (mouse up, or keys still 450 ms) outside fields is offered with token, quote, pageText, line and rect; follows scroll once a frame; withdrawn on press, none, or another | page-preload.cjs offer | page.js | done — compiled, untested (page.js is page-preload.cjs word for word) |
| L2 | selectionCardPlace / shadedCardPlace (card 340 wide, shade 18/24/30, gap 8): under the last line, else above, else as far down as fits; inside the pane | selection-card.cjs | Doc (SelectionCardPlace.swift, one definition) | done |
| L3 | No card on unfileable pages, with a field focused, while boxing or with a box selected | views.cjs | BrowserViews | done — compiled, untested |
| L4 | A printable key in the page goes into the card (card takes keyboard); Esc closes; ⌘C/Enter/arrows stay the page's | views.cjs selectionKey | StageWebView.keyDown | done — compiled, untested |
| L5 | Save keeps the highlight with its note (the same passage once: the twin's note updated), closes unless @bart (asked, card stays); empty Save keeps nothing; ⌘Enter saves | views.cjs saveSelectionCard, BoxCard SelectionCard | SelectionCardView | done — compiled, untested |
| L6 | Cancel/Esc closes without saving; the page is told (card-gone) | views.cjs closeOffer | BrowserViews | done — compiled, untested |
| L7 | A click on a highlight's text (plain click, no link) or its note symbol, or a selection inside it, opens its own card with its note; Remove takes it out (unmark) | page-preload.cjs openMark | page.js, SelectionCardView | done — compiled, untested |
| L8 | Note symbol: 15px blue #0070f3 disc, white ring and three white lines, over the top right of the first line; shown once noted | page-preload.cjs symbolPlace, boxes.cjs noteChip | Boxes.swift, page.js | done — compiled, untested (symbolPlace in the JS tests) |
| L9 | Selection card look: white, radius 12, border #ececec, shadow 0 6 24 rgba(0,0,0,.12), padding 16 18 14, 15px sans #1f2633, placeholder 'Write a note or ask @bart' #9a9a9a, Remove/Cancel/Save (blue pill, disabled .4) | BoxCard.jsx SelectionCard | SelectionCardView | partial: native card; the blinking stand-in caret of an unfocused empty card is not drawn |

## M. Boxes (MATH-70)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| M1 | Box button / ⌥ held (no field focused, page in front, fileable) lays the drawing layer over the page; Esc or ⌥ up cancels (a drag under way finishes) | views.cjs startBox, box-layer-preload | BoxLayerView | done — compiled, untested (native BoxLayerView) |
| M2 | Layer look: hidden cursor, 21px crosshair (white 1px lines with 3px half-black halo, 12px grey circle), readout pill (11px/500 white on rgba(0,0,0,.72), radius 4) of screen point before press, size while dragging; rect 1px white edge, 1px halo, 6% grey tint; MIN 6 | box-layer-preload.cjs | BoxLayerView | done — compiled, untested (look) |
| M3 | A click (drag < 6) on the layer selects the box whose edge is there | box-layer-preload, views.cjs | BoxLayerView | done — compiled, untested |
| M4 | A drawn box: page says anchor + text (2 s), crop captured (≤1568), saved as {id, box, crop 'crops/<id>.png', text, note null, at}; drawn and selected | views.cjs makeBox | BrowserViews.makeBox | done — compiled, untested |
| M5 | Boxes drawn by one html::after rule (boxesCss): 1px white outline, 1px halo, handles 5px for the selected, tint while resizing, notes' chips; replaced as they move | boxes.cjs boxesCss | Boxes.swift | done |
| M6 | Edge click selects (8px band, smallest of nested); handles resize (6px reach, min 6, kept in view), report once a frame; release → new anchor + crop under nextCropName, mark updated | page-preload.cjs, views.cjs resizeBox | page.js, BrowserViews | done — compiled, untested (the handle maths tested in JS) |
| M7 | Resize readout: html::before fixed pill with the size in points beside the pointer, flipped at the viewport edges | boxes.cjs readoutCss | Boxes.swift | done |
| M8 | Cursor over handles (nwse/nesw/ns/ew-resize) or a box edge (pointer) via an inserted rule | views.cjs setCursor | page.js | done — compiled, untested |
| M9 | Backspace/Delete removes the selected box (not in a field) → 'Box removed · Undo'; Esc deselects; ⌘Z or Undo restores it with its picture | views.cjs boxKey | StageWebView.keyDown | done — compiled, untested |
| M10 | refind: selector (same element), image src, document coordinates when width within max(16, 5%), else not drawn | page-preload.cjs refind | page.js | done |
| M11 | Text under a box: words whose centre is in the box and viewport, visible and on top; image alt as [image: alt]; ≤2000 chars | page-preload.cjs textUnder | page.js | done (JS shows() tested); in a page untested |
| M12 | crop names: cropName, cropNumber, cropsOf, nextCropName | boxes.cjs | Boxes.swift | done |

## N. Box card

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| N1 | One card per window beside the selected box on the tab in front: right, else left, else under, else over, else against the page's right edge; hidden out of view, on navigation, another tab, hide, close | boxes.cjs cardPlace, views.cjs placeCard | Boxes.cardPlace, BoxCardView | done — compiled, untested (placement tested) |
| N2 | Card look: white ground, trash at top right (18px, #8f8f8f, hover #f2f2f2), Caveat 24/1.2 note ink #1f2633, answers 15/1.55 #171717, earlier question #8f8f8f, error #c4372d, gap 10 | BoxCard.jsx, card-look.js | BoxCardView | done — compiled, untested (look) |
| N3 | Width: as wide as the note's longest line + 20 within 140…320; 320 once answered or running | BoxCard.jsx noteWidth | BoxCardView | done — compiled, untested |
| N4 | Note saved 300 ms after typing (and on leaving); Enter in an @bart note asks (Shift+Enter newline); leading @bart drawn in the document's blue | BoxCard.jsx | BoxCardView | done — compiled, untested |
| N5 | Running asks: wave label, Stop (or × on failure 'Bart · No answer' + error); answers paragraphs with bullets/headings | BoxCard.jsx Running | BoxCardView | partial: the running label is plain grey text, not the document's wave; Chat's citation circles are drawn as links |
| N6 | browser:box-ask {tab, markId, url, title, question, note, turns (last 40), quote?, pageText?} → host.ask; box-stop → host stop/dismiss; setBoxAsks list back | views.cjs cardAsk, Stage.jsx | BrowserViews, StageHost | done — compiled, untested |
| N7 | Esc in the card gives the keyboard back to the page (selection card: closes it) | views.cjs | BoxCardView | done — compiled, untested |

## O. Sections (guide's Read links)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| O1 | showSection: words matched as find would (fold quotes/dashes, any case/space, no-space fallback), first drawn occurrence; tinted to just before the next heading at the level above or higher, inside the holder/article; else the holder's end (≤30000) else its paragraph; scrolled a little below the top | page-preload.cjs showSection | page.js | done (cloud: a section shown on a local page) |
| O2 | Words not there yet are watched for 3 s (scroll, key, press end the wait) | page-preload.cjs watchFor | page.js | done — page.js word for word, untested |
| O3 | section(id, words) answers whether shown within 300 ms; not shown → find runs | views.cjs section | PageTab.section | done (cloud: true / false) |

## P. Links into the Stage

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| P1 | createStageLinks: listen counts; windowOpen sends http(s) (not GitHub sign-in) to the Stage as newTab when listening and delivered, else the default browser; other schemes closed | stage-links.cjs | StageLinks.swift | done |
| P2 | windowOpenRoute(value, stage) → stage / external / nil | window-open.cjs | StageLinks.swift | done |

## Q. Cookie import (MATH-18, C1–C9 backend)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| Q1 | Browser table (chrome, brave, edge, vivaldi, opera, chromium, arc, comet, dia; firefox; safari) with dirs, Keychain names, bundle ids; bundleOf | import-cookies.cjs | CookieImport.swift | done |
| Q2 | deriveKey PBKDF2-SHA1 'saltysalt' 1003 rounds 16 bytes; v10 AES-128-CBC IV 16 spaces; meta ≥24 drops a 32-byte hash; non-v10 → plaintext or nil | import-cookies.cjs | ChromiumCookies.swift | done |
| Q3 | chromeTimeToUnixSeconds; CHROMIUM_SAMESITE / FIREFOX_SAMESITE mapping | import-cookies.cjs | ChromiumCookies.swift | done |
| Q4 | Read a private copy (+ -wal/-shm) deleted afterwards; Chromium columns across versions; Firefox schema 14 ms expiry | import-cookies.cjs | CookieDatabases.swift | done |
| Q5 | registrableDomain with multi-part suffixes; expired and partitioned/contained rows left out uncounted; Google bound cookies skipped and counted | import-cookies.cjs | CookieImport.swift | done |
| Q6 | cookieSetDetails → HTTPCookie (host-only vs domain, __Host- no domain, session vs expiry, secure, httpOnly, sameSite) into WKHTTPCookieStore | import-cookies.cjs | CookieImport.swift | done |
| Q7 | Sign-in checks: verdict rule (2xx in; login redirect or 401 out; else nil), GitHub session cookie gate, Claude 403 body, timeout 10 s, all at once; shownLocation | import-cookies.cjs | SignInChecks.swift | done |
| Q8 | sources / installedChromium / domains (counts, defaults) / cookieNames / check / checkDetail / canRead / import (counts only, record) / unlock / ready | import-cookies.cjs createCookieImport | CookieImport.swift | done |
| Q9 | Keychain runner: `security find-generic-password -w -s`, exit 44 not found, 128/51 denied, timeout denied; messages by browser name | import-cookies.cjs keychainRunner | Keychain.swift | done |
| Q10 | Record userData/browser-imports.json (domains and counts, never values) | import-cookies.cjs recordImport | CookieImport.swift | done |
| Q11 | Profiles: Chromium Local State info_cache (name, user_name email), Default; Firefox profiles.ini names | import-cookies.cjs | CookieImport.swift | done |
| Q12 | Safari binarycookies parser (BE page table, LE records, flags 1 secure 4 httpOnly, Mac epoch), skipped counts; locations (container, old, profiles by UUID, names from SafariTabs.db); Full Disk Access gate; needs: 'disk-access' | safari-cookies.cjs | SafariCookies.swift | done |
| Q13 | Import sign-ins picker: browser → profile → domains (search, ticked defaults, counts) → Importing… → done (checks, Sign in again) | ImportSignins.jsx | ImportSigninsView | done — compiled, untested (ImportSigninsWindow sheet; the host may replace it through onImportSignins) |

## R. Installed apps

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| R1 | APP_NAMES; /Applications and ~/Applications by known name (plist naming another app refused, unreadable taken) or any app whose plist names the id | installed-apps.cjs | InstalledApps.swift | done |
| R2 | Not there: installed until Spotlight answers in the background (mdfind, Trash ignored, error = installed), kept 10 min; local 1 min | installed-apps.cjs | InstalledApps.swift | done |
| R3 | settled waits ≤2 s; ENGELBART_INSTALLED_BROWSERS override; plistNames | installed-apps.cjs | InstalledApps.swift | done |

## S. Other

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| S1 | RightPane: Stage | Terminal modes, both mounted | RightPane.jsx | — | n/a: RightPane is the Workspace screen's (wave 2): it mounts StageController beside the terminal and sets `visible` |
| S2 | RecentPages clock list | RecentPages.jsx | — | n/a: RecentPages is the sidebar's clock over the sidebar tree, not the Stage (wave-2 sidebar) |
| S3 | Snapshot of a page under overlays (browser:hide snapshot), data-overlay occlusion | Stage.jsx, views.cjs hide | — | n/a: native views can be covered by other views in AppKit; no snapshot or data-overlay occlusion needed |
| S4 | IPC validation (assertTrustedRenderer, bounded args) | views.cjs registerBrowserIpc | — | n/a: no IPC; calls are typed Swift |
| S5 | Electron-only: onHeadersReceived rewrite, will-download, registerPreloadScript, cookies flushStore timer | views.cjs | — | n/a: Electron mechanics replaced by the response policy, WKDownload and a WKUserScript in a content world |
