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
No KaTeX: LaTeX becomes Unicode math text (`EngelbartDoc.MathText`), drawn in STIX Two Math (Times italic fallback);
display math (`$$…$$`, ```math blocks) centred at 1.2×. Undrawable LaTeX shows as code. A formula is one unit.

## Public entry points (DocEditorView)
- `host: DocEditorHost?`, `compact`, `readOnly`, `viewScope`, `autoCollapse`, `emptyHint`, `besideLink`,
  `besideWorkspace`, `handlesFind`.
- `setDocument(key:text:)` (doc switch: reports/restores the scroll place, flushes the save, drops edit mode);
  `setText(_:)` (an outside change: an answer landing keeps the caret's line); `setAsks([String: AskProgress])`;
  `setBuilds([String: BuildState])`; `setModels(QuestionModels?)`; `flush()`.
- `focusStart()`, `focusEnd()`, `isActive`, `shutMenus()`, `caretNow()`, `placeCaret(line:a:b:)`, `showLine(_:flash:)`
  (#fff1b8, 2.4 s), `showPassage(_:find:)`, `startAgent(_:)`, `askBoxed(_:)`, `handOff(_:pick:key:)`, `foldAll(_:)`,
  `anyAnswerOpen`, `openFind()`, `findStep(_:)`, `captureView()`, `applyView(_:)`.
- `AskProgress.progressed(step:name:effort:movedUp:activity:lines:log:)` = DocEditor askProgressed (60-entry log).

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
- `copy(text)` (defaults to NSPasteboard), `viewOf(scope,key)`, `reportView(position, scope, key, now)`, `error`.

## Events posted
None on EventHub: the editor reports through its host only (the Electron component had no IPC of its own either).

## Needs from other packages
- Workspace (wave 2): implement `DocEditorHost`; compute `mentionItems` (rail.js mentionRows, folderRows), keep `asks`
  (feed `setAsks`), `builds`, the router (`route`), name-chat titles (`Doc.placeTitle`), and place answers
  (`Doc.placeAnswer`) then call `setText`.
- Build: a card view for `buildView(id)`.
- Bart: main/bart/card.cjs (cardOfAnswer, questionOf, answerLine, readAnswer, recapLine, resultParts) for the older
  @brainstorm/@discover cards; not ported here (see ledger).
