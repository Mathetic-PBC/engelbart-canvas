# EngelbartEditor — API

The document editor (DocEditor.jsx and its popups). Ledger: `mac/parity/editor.md`. Depends on Core, Doc, UI.

## Shape
- `EditorCore` — the pure document engine (no AppKit): text, lines, the caret's line (`activeLine`), the caret to put
  after an edit (`caret`), undo/redo (200 steps, `{text, caret}`), edit mode, armed blocks, reply-field texts, research
  countdowns. Every edit of DocEditor.jsx is a method here (`insert`, `typeLine`, `key(KeyPress, sel:)`,
  `deleteSelection`, `paste`, `copy`, `placeImage`, `besidePicture`, `placeDropped`, `askInline`, `routeLine`,
  `handOff`, `sendFollow`, `regenerate`, `startEdit/commitEdit/cancelEdit`, `toggleFold/collapseTurn/collapseAll/
  toggleThread/foldAll/autoCollapse`, `deleteTurn`, `copyText`, `footBuild`, `pickModel`, `pickLevel`,
  `pickMention`, `startResearch/restartResearch/cancelWait`, `startAgent`, `askBoxed`, `toggleTodo`, `indent`,
  `removeLine`, `moveImage`, `resizeImage`, `openGap`, `focusEnd`). It talks out through `core.hooks` (closures), which
  `DocEditorView` wires to its host. Tests drive it directly.
- `DocEditorView: NSView` — the embeddable editor: an `NSScrollView` + `DocTextView` (NSTextView, TextKit 1) + overlay
  controls + popups. Use it in the Workspace's middle canvas and, with `compact = true`, in a post-it.

### Why TextKit 1
`DocLayoutManager` (an NSLayoutManager and its own delegate) gives a hidden line a zero-height line fragment and nulls
its glyphs, and draws the cards (grey #fafafa, radius 10, left rules), row marks (checkbox, bullet, number), inline
pills and mention glyphs from attributes over whole runs of paragraphs. TextKit 2 could not hide a paragraph without its
line height and has no per-paragraph background pass, so TextKit 1 is the reliable choice.

### How drawing works
`Renderer` turns the model into one attributed string, one paragraph per source line (line i = paragraph i), and a
`LineMap` per line (`range`, `segs`, `base`): what each drawn character stands for in the source. The caret's line shows
its source except tokens with markup the caret does not touch (DocEditor openIdx: mentions open only strictly inside,
pictures never, links stay drawn on an answer line the mouse clicked). Controls are `Decoration`s (foot, chip, corner,
pending row, title row, folded row, Build card, Copy, reply field, research head) placed as overlay views on their
line's rect; space for them is the paragraph's own height or its paragraph spacing. All edits go to `EditorCore`; the
text view's own text changes only for IME marked text.

### Math
SwiftMath (1.7.3, SwiftPM) typesets inline `$…$` (text style) and display `$$…$$` / ```math blocks as images
(`MTMathImage`), each one attachment character sitting on the baseline by its descent (`MathTypeset`, 500-entry cache).
What SwiftMath cannot parse falls back to `EngelbartDoc.MathText`'s Unicode; what neither reads shows as code. A
formula is one unit for the caret.

## Public entry points (DocEditorView)
- `host: DocEditorHost?`, `compact`, `readOnly`, `viewScope`, `autoCollapse`, `emptyHint`, `besideLink`,
  `besideWorkspace`, `handlesFind`.
- `setDocument(key:text:)` (doc switch: reports/restores the scroll place, flushes the save, drops edit mode);
  `setText(_:)` (an outside change: an answer landing keeps the caret's line); `setAsks([String: AskProgress])`;
  `setBuilds([String: BuildState])`; `setModels(QuestionModels?)`; `flush()`.
- `focusStart()`, `focusEnd()`, `isActive`, `shutMenus()`, `caretNow()`, `placeCaret(line:a:b:)`, `showLine(_:flash:)`
  (#fff1b8, 2.4 s), `showPassage(_:find:)`, `startAgent(_:)`, `askBoxed(_:)`, `handOff(_:pick:key:)`, `foldAll(_:)`,
  `anyAnswerOpen`, `openFind()`, `findStep(_:)`, `captureView()`, `applyView(_:)`.
- `AskProgress.progressed(step:name:effort:movedUp:activity:lines:log:)` = DocEditor askProgressed (60-entry log);
  `making` (what a Create run said it makes) and `at` (when asked: the Create row's m:ss) for @create's running row.

### Cards and agents' rows (EditorCards.swift, CardsView.swift, CardsWiring.swift)
@brainstorm/@discover cards (`Doc.Card`) are drawn over their answer's lines: boxed rows (David's mock) with their own
field and Submit, or a list; Skip and Wrap up on the foot; an answered boxed card repicks after a confirm
(`EditorCore.cardsOf/pickCard/sendCard/repickCard/answerShown`). Recaps are sections; a result's offer line asks
@discover/@chat (`askResult`); Send to Discover sits after a recap (`discoverLook`). An @discover guide's titles carry
a bookmark (`EditorCore.guideTitle`, `unsavedPapers`, Save all on the foot). @create's files are rows (Save/Saved,
inline frame, Open in Stage, a 350 ms peek); a running Create shows `CreateWords.makingLabel/creatingLine/createDoing`,
m:ss and Stop; `CreateWords.madeToOpen` says which file a finished run opens. Every action goes through the core's
`ask` hook or the host.

## What the host provides (`DocEditorHost`, every method defaulted)
- Text: `changed` (every edit), `save` (400 ms after typing stops, flushed on switch/close), `textOf`/`change` for a run
  handed on in a document no longer shown.
- Mentions: `docEditorMentionable` (`EditorRow`: LibRow + title/facts/trashed; ids `bart`/`chat` rows are the agents),
  `mentionItems(query)` (the @ menu's rows: model/rail.js mentionRows — verbs, Note, open page, workspaces 3/6, library),
  `listFolder`, `fileState`, `picked`, `mentionMenuOpen`, `makeNote`.
- Agents: `docEditorModels`, `docEditorCanAsk`, `ask(AskRequest)`, `docEditorHasRouter`, `route(RouteRequest, done:)`,
  `routeGone`, `stop`, `docEditorCanBuild`, `build(BuildRequest)`, `buildView(id) -> NSView?` (the Build card).
- Opening: `openLink(href, newTab, sections)`, `open(LibRow)`, `openBeside(kind,id,name)`, `openWorkspace`,
  `openFile`, `openZotero`, `openMade`.
- Pictures/drops: `image(id) -> NSImage?`, `pasteImage(data, mime, label, done: id?)`, `dropItems([Drop.Item])`,
  `dropOnZotero`.
- Papers in a guide: `paperState(address) -> 'none'|'lib'|'here'|nil`, `savePaper(title,address,done)`,
  `docEditorCanUnsavePaper`, `unsavePaper(title,address,done)`.
- Made files: `madeFile(key) -> MadeFile?` (`name, type, saved, saving, missing, error, image, text`), `saveMade(key,name)`,
  `madeNeeded(keys)` (asked once per key). When made files or papers' states change, call `rowsChanged()`.
- Folders in the @ menu: `listFolder(id, rel, done: FolderListing{entries[name, rel, dir, type, zotero, hint, find],
  error, missing, total})`.
- `copy(text)` (defaults to NSPasteboard), `viewOf(scope,key)`, `reportView(position, scope, key, now)`, `error`.

## Events posted
None on EventHub: the editor reports through its host only (the Electron component had no IPC of its own either).

## Needs from other packages
- Workspace (wave 2): implement `DocEditorHost`; compute `mentionItems` (rail.js mentionRows, folderRows), keep `asks`
  (feed `setAsks`), `builds`, the router (`route`), name-chat titles (`Doc.placeTitle`), and place answers
  (`Doc.placeAnswer`) then call `setText`.
- Build: a card view for `buildView(id)`.
- Bart: nothing (the card data model is Doc's `Card`, which Bart links). SwiftMath from GitHub (SwiftPM).
