# EngelbartPDF — API

The Paper: a PDF drawn as one white column with Engelbart's ink (rough zigzag highlights, Caveat notes, @bart answers),
ported from `src/renderer/pdf/PaperView.jsx`. Ledger: `mac/parity/pdf.md`.

## Entry points

```swift
let paper = PaperViewController()          // NSViewController; embed its view anywhere (Stage tab, workspace)
paper.host = myHost                        // PaperHost (below)
paper.paperTitle = "Optional title"        // title block + 1px rule; nil for none (the Stage passes none)
paper.load(data: pdfBytes,                 // Data of the pdf; nil/empty → "No paper to open."
           marks: ink,                     // PaperMarks?; nil → host.paperReadAnnotations()
           view: lastState,                // PaperViewState? where it was read to (ignored with a target/section)
           target: "start words", targetTo: "next section's words", targetPage: 4,
           initialSection: (find: "...", to: "..."))
paper.setMarks(ink)                        // ink that arrived after the bytes (adopted only if nothing was edited)
paper.pendingAsks = [PendingAsk]           // the running @bart asks for THIS pdf (Stage's paperAsks)
paper.addAsk(page:markId:entry:)           // a finished answer → joins its mark once, saves; false if mark gone
paper.find(query, step: 0/±1, scroll:, fromStart:) -> (matches, active)   // ⌘F; "" stops
paper.stopFind()
paper.setTarget(find, to:, page:)          // a link's passage; reported via host.paperTarget
paper.showSection(find, to:) / clearSection()   // the Stage's Sections menu
paper.zoomTo(percent) / zoomStepBy(±1) / togglePct() / currentZoom
paper.toPage(n)
paper.libraryChanged()                     // library renamed/removed items or file states changed → mentions redrawn
paper.currentMarks                         // the ink as it would be saved
paper.close()                              // tells host.paperView, flushes the save, lets the document go
```

Pure helpers usable elsewhere: `Marks` (marks.js), `Canvas` (canvas.js + mark-answers + selection-card), `PaperZoom`,
`PaperDraw`, `PaperFind`/`TargetGate`/`PassageText`, `NoteText`/`FolderMenu`, `Rough` (rough.js port, same seeds →
same strokes), `CardLayout` (card placement), `AnnotationJSON` (read/write the ink file exactly as Electron does:
`decode(Data)`, `encode(PaperMarks) throws -> String`, 20 MiB cap → "annotations are too large").

Model: `PaperMarks { pages: [Int: [Mark]], other: [String: JSONValue] }`, `Mark`, `PRect`, `PPoint`, `AskEntry`,
`PendingAsk`, `PaperAsk`, `PaperContinue`, `PaperViewState`, `MentionRow`, `FolderListing`, `PaperFileState`.

## PaperHost (what the app provides; every method has a default)

| Method | When / what |
|---|---|
| `paperMarksChanged(_:json:)` | ink changed (300 ms debounce, flushed on close/load). Write `json` to the Store: `writeAnnotations(rowId)` or `writePageAnnotations(url)`. Two views on one pdf: last write wins (as Electron). |
| `paperReadAnnotations()` | ink when `load` got none |
| `paperCanAsk` / `paperAsk(_:)` | @bart from a highlight's note. The host adds rowId/url/paper name, calls `ask-bart` (ref kind `mark`), keeps `pendingAsks` updated with progress, and on success calls `addAsk` (main also puts it in the ink file: `library.addMarkAnswer`). |
| `paperStopAsk` / `paperDismissAsk` | Stop / × on a running or failed ask (also: removing a mark stops its running asks) |
| `paperCanContinue` / `paperContinue(_:)` | "Continue in project": host appends `Canvas.continueLines(...)` with its paper ref |
| `paperCanCopy` / `paperCopy` | ⌘C and Copy; default writes the general pasteboard |
| `paperOpenLink` | links in answers (never the window: the Stage opens them) |
| `paperOpensMentions` / `paperOpenMention` / `paperOpenFile` | library/file chips in notes and answers; without it notes are always fields |
| `paperLibraryName(id) -> String??` | `.some(nil)` = gone from the library, `nil` = unknown |
| `paperFileState`, `paperCitationSource` | file chips; a citation's source name (cite.js libraryName) |
| `paperMentionItems(query) -> [MentionRow]?` | the note's @ menu rows (`.item(...)`, `.bart`); nil = no menu |
| `paperListFolder(id, rel:, done:) -> Bool` | MATH-22 folder browsing in the menu |
| `paperMentionMenu(open:)` | the Stage blocks ⌘W while it is open |
| `paperView`, `paperFound`, `paperTarget`, `paperError` | reports |

## Events posted

None on `EventHub`; everything goes through `PaperHost`.

## Needs from other packages

- **Stage / app**: own the tab, the bytes, `pendingAsks`, the ask round-trip (`ask-bart`, `running-paper-asks`,
  `paper-ask-done` → `addAsk` on every controller showing that pdf), the ⌘F bar UI, Sections menu.
- **Store**: `readAnnotations` / `writeAnnotations` / `readPageAnnotations` / `writePageAnnotations` (file layout
  `<root>/annotations/<id>.json`, `annotations/pages/<sha256(address)>.json`) and `addMarkAnswer`; this package only
  formats the JSON.
- **Editor**: the note's @ menu is a lookalike of MentionMenu.jsx (`MentionMenuView`); a shared AppKit menu would replace it.
- **UI**: `Fonts.caveat` must load (woff2 registration); Caveat 500 is the note face.
- **Doc** (a dependency since the second pass): SelectionCard, MarkAnswers, Inline (mentions, noteParts), Cite and PassageText are its; this package wraps them in typed form.
