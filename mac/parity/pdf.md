# Parity ledger: Papers (the PDF view with Engelbart's ink)

Sources: `src/renderer/pdf/PaperView.jsx` (PV), `marks.js` (MK), `canvas.js` (CV), `card-look.js` (CL),
`src/renderer/model/paper-zoom.js` (PZ), `paper-draw.js` (PD), `model/find.js` (FD), `shared/selection-card.cjs` (SC),
`shared/mark-answers.cjs` (MA), `shared/passage-text.cjs` (PT), `model/doc.js` note parts (DOC), `model/cite.js` (CT),
`model/rail.js` folderRows (RL), `main/store/library.cjs` ink format (LIB), roughjs 4.6.6 (RJ). Specs: desktop design
§2 #78, #85–#89 and §5 Paper; `2026-10-16-pdf-annotations-round.md` (AR) rounds 1–4; memory `pdf-annotations-round.md`,
`engelbart-desktop-experiment.md`. Tests: `test/paper-*.test.cjs`.

Electron → native mapping (recorded once here, referred to below):
- **No PDFView.** Pages are drawn by EngelbartPDF's own column on `PDFDocument` (PDFKit) in an `NSScrollView`: PDFView
  draws each page at its own width with gaps/shadows, owns selection painting and cannot hold notes in the margins or the
  desk beside a page; the Electron column (every page as wide as page 1's fit width, no gap, no edge, cards above every
  sheet, a centred column with no sideways pan) needs its own layout. PDFKit gives the page drawing, the text, character
  geometry and selections.
- pdf.js canvas → a CGImage per page rendered on a background queue from a render-only `PDFDocument` (one per queue:
  PDFKit documents are not shared across threads); text layer → PDFKit character geometry queried on demand; the
  "text layer only near the view" rule becomes "text read in the background nearest-first, geometry asked only where
  the person acts" (nothing per page is built for far pages). CSS custom highlights → a find layer per sheet.
- CSS transform pinch → `NSScrollView.setMagnification(_:centeredAt:)` (a bounds scale of the clip view, the
  compositor's), with a centring clip view; settle = magnification back to 1 and the sheets resized (rezoom).
- DOM cards → `NSView` cards laid out in note px and drawn scaled (frame = size × ns, bounds = size).
- React props/callbacks → `PaperHost` protocol + `PaperViewController` methods.

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| **Ink file format** |||||
| 1 | Ink JSON is `{ "<page>": [Mark], … }` page keys as strings (1-based), plus any other key (e.g. `"web"`) kept untouched on a round trip | LIB, MA WEB, PV emit | AnnotationJSON.swift | done (cloud run 40759592982) |
| 2 | Mark fields written in Electron's order: highlight `{id, rects, side, y, note, text, pos[, group]}` (+`asks`, `w` when set); free note `{id, rects:[], side:null, y, note, text:"", pos:{x,y}, w}`; unknown fields kept | MK partMarks, PV addMark | Marks.swift | done (cloud run 40759592982) |
| 3 | rects `{x,y,w,h}`, y/pos in page units (fractions of the page's drawn width); `note` string or null; `pos` null or `{x,y}`; `side` "left"/"right"/null | MK, CV | Marks.swift | done (cloud run 40759592982) |
| 4 | Ask entry `{id, question, answer, meta:{provider,name,effort,ms,foot}, at, pos:null, collapsed:false[, crop]}`; `deleted`/`collapsed` flags written when set | MA askEntry, PV askClick | Marks.swift, Answers.swift | done (cloud run 40759592982) |
| 5 | JSON written as JSON.stringify does: no spaces, integer-like keys ascending first, numbers in JS form (1 not 1.0, 0.1, 1e-7, 1e+21), JS string escapes; size cap 20 MiB → error "annotations are too large" | LIB writeJson | AnnotationJSON.swift | done (cloud run 40759592982) |
| 6 | Saved ink = keptMarks: a free note still empty dropped; a deleted answer whose session is gone (30 min after the newest answer) dropped; pages with no marks left out | CV keptMarks, PV emit | Canvas.swift, PaperViewController | done (cloud run 40759592982) |
| 7 | Saves debounced 300 ms after any change; flushed on close/another document; writes go to the host (the Store owns the file; two views on one pdf write last-wins) | PV scheduleSave/flushSave | PaperViewController | done (cloud run 40759592982) |
| 8 | Marks arriving after the bytes are adopted only while nothing was edited here (`dirty` false) | PV componentDidUpdate | PaperViewController.setMarks | done (cloud run 40759592982) |
| **Pure marks (marks.js)** |||||
| 9 | sameLine: vertical overlap ≥ 0.5 × smaller height; boxesOverlap: sameLine and horizontal overlap (touching is not) | MK | Marks.swift | done (cloud run 40759592982) |
| 10 | mergeLineRects: drop unusable, group by line (sorted by centre), join within a line when gap < 0.6 × line height; out top→bottom, left→right | MK | Marks.swift | done (cloud run 40759592982) |
| 11 | bandRects: merged boxes of one mark joined across gaps < 1.6 × line height (a gutter is not crossed) | MK, AR | Marks.swift | done (cloud run 40759592982) |
| 12 | boxesInside with SLACK 0.2 × line height; sideOf: mean centre / width < 0.45 → left; empty → right | MK | Marks.swift | done (cloud run 40759592982) |
| 13 | boxSeed(page, box) = 1 + abs(page·7919 + round(y·1000)·131 + round(x·1000)) mod 2147483646 (JS Math.round) | MK | Marks.swift | done (cloud run 40759592982) |
| 14 | placeHighlight: inside one → nothing added (note/group given to host when it has none); overlapping, no notes/asks, ≤1 group → one mark (earliest id/place, merged rects, side of merged, min y, text covers-or-joined in reading order, group); else added beside | MK | Marks.swift | done (cloud run 40759592982) |
| 15 | dropSlivers (h > 1.8 × median and w < h); selectionParts (bands, side vs layer width, top, sorted by page); scalePart; partMarks (ids, shared `g` group when >1 part, note on first only, page units) | MK | Marks.swift | done (cloud run 40759592982) |
| 16 | passageOf: own text, or every part of its group page by page (y, index), trimmed, one line each | MK | Marks.swift | done (cloud run 40759592982) |
| 17 | stackNotes: NOTE_SLACK 200, gap, other margin only as last resort; pushed back up from the page foot | MK | Marks.swift | done (cloud run 40759592982) |
| 18 | wordBounds (letters, marks, digits, _ ' ’ -, a point/comma between digits; not across a line break) | MK | Marks.swift | done (cloud run 40759592982) |
| 19 | pdfText/findPassage/pageWindow: ~4000 chars centred on the passage (first/last 8 words, `-\n` tolerant), cut at spaces, "… " / " …", tidy; not found → centred at the highlight's height share | MK | Marks.swift | done (cloud run 40759592982) |
| **Pure canvas (canvas.js)** |||||
| 20 | Constants: BOX_GAP 12, NOTE_W 240, SIDE_GAP 12, POS_DY 11, NOTE_MIN 96, FREE_MIN 80, FREE_FIT 160, EDGE_PAD 8, HIDE_ROOM 40, NOTE_REF 1050, NOTE_FLOOR 10/24, PRESS_MOVE 4, THREAD_IDLE_MS 30 min | CV | Canvas.swift | done (cloud run 40759592982) |
| 21 | noteScale(pageW) = max(NOTE_FLOOR, pageW/1050); fitWidth; freeNoteWidth; textColumn (2nd/98th percentile, ≥5 runs) | CV | Canvas.swift | done (cloud run 40759592982) |
| 22 | placeOf/posOf (POS_DY 11); spaceBoxes (fixed boxes, x-overlap only, gap 12, order by want then index) | CV | Canvas.swift | done (cloud run 40759592982) |
| 23 | shownAsks, exchangeOf, emptyFree, keptMarks, turnsOf, runningBack, noteQuestion (`^\s*@bart(?=\s|$)` i), continueLines, askedByNote, runningLabel | CV | Canvas.swift | done (cloud run 40759592982) |
| 24 | answerOf (`bart> ` prefixes, `*foot*` last line), askEntry, withAsk (once, only while the mark is there) | MA | Canvas.swift | done (cloud run 40759592982) |
| **Zoom and layout** |||||
| 25 | 100% = page 1 as wide as the pane; zoom is a fraction of fit width; range 15–200% | PV ZOOM_MIN/MAX, #89 | PaperZoom.swift | done (cloud run 40759592982) |
| 26 | − / + step through 15, 30, 41, 67, 69, 90, 100, 110, 150, 200 (from the rounded percent; null past the ends) | PV zoomStep | PaperZoom.swift | done (cloud run 40759592982) |
| 27 | The percent button goes back to 100% (nothing when already 100) | PV togglePct | PaperViewController | done (cloud run 40759592982) |
| 28 | wheelZooms: ⌃ or ⌘ + scroll, and a trackpad pinch, zoom; plain scroll scrolls | PZ | PaperScrollView | done (cloud run 40759592982); ⌃ scroll as a real NSEvent; a trackpad magnify event cannot be synthesized, so its mapping is checked through pinch(pinchWheel) |
| 29 | wheelZoom: dy clamped ±50 (lines × 16), zoom × exp(−dy·0.01) within range; pinch magnification m mapped as Chromium's dy = −100·ln(1+m) | PZ | PaperZoom.swift | done (cloud run 40759592982) |
| 30 | A pinch scales the paper as one transform about the pane's vertical middle line at the pointer's height; settles 180 ms after the last event, then sheets are resized and the anchor point is put back (settleView) | PV pinch/startPinch/endPinch, AR | PaperViewController | done (cloud run 40759592982) |
| 31 | During a pinch the paper's top never shows white above page 1 (nor its foot above the pane's foot) | PV pinchTransform, AR round 2 | CenteringClipView | done (cloud run 40759592982) |
| 32 | During a pinch cards scale with the paper but never below NOTE_FLOOR (--inv) | PV cardsInverse | PaperViewController | done (cloud run 40759592982) |
| 33 | columnGeometry: pageW = round(W·z), sheet S = max(W, pageW), G = (S − pageW)/2; every page as wide as page 1, heights by own aspect; sheets meet with no gap, rule or edge | PD, AR | PaperDraw.swift, layout | done (cloud run 40759592982) |
| 34 | No sideways pan at or below 100%; past 100% the page alone scrolls sideways; a new layout starts scrolled to the column's middle | PV layout, AR | PaperViewController | done (cloud run 40759592982) |
| 35 | settleView: anchor point kept by page and share of its width; across by distance from the column's middle, scaled; top ≥ 0; left within 0…S−W | PD | PaperDraw.swift | done (cloud run 40759592982) |
| 36 | −/+ and % zoom about the middle of the view | PV zoomTo | PaperViewController | done (cloud run 40759592982) |
| 37 | A resized pane keeps its zoom: sheets resized at once (top of view kept), drawn 150 ms after the resize settles; pane < 40 px wide: no layout | PV onResize | PaperViewController | done (cloud run 40759592982) |
| 38 | pageAt(tops, y) binary search; current page = the one at the view's vertical middle | PV | PaperZoom.swift | done (cloud run 40759592982) |
| **Drawing pages** |||||
| 39 | Pages drawn nearest the view first (nearOrder: current outward, then DRAW_AHEAD 2 each side, below first), re-chosen before each page | PD | PaperDraw.swift, PageRenderer | done (cloud run 40759592982) |
| 40 | Drawings more than KEEP_DRAWN 5 pages from the view are given back and drawn again when near | PD tooFar | PageRenderer | done (cloud run 40759592982) |
| 41 | Device pixels per page capped: canvasScale = min(2, sqrt(4e6 / (w·h))) | PV canvasScale | PaperZoom.swift | done (cloud run 40759592982) |
| 42 | A page has a small drawing THUMB_W 180 px wide kept under its own (from its drawing, or drawn in the background for pages within THUMB_AHEAD 12), shown while a zoom out waits | PV keepThumb/drawThumb | PageRenderer | done (cloud run 40759592982) |
| 43 | A zoom keeps the old drawings stretched until redrawn; only pages near the view redraw | PV rezoom | PageRenderer | done (cloud run 40759592982) |
| 44 | A drawing that fails leaves what was there; tried again at the next zoom; a drawing far from the view is stopped | PV drawPage | PageRenderer | partial: redraw after a zoom tested; a failed drawing and one stopped far from the view are not exercised |
| 45 | Every page's text is read in the background (nearest first) for find and passages; nothing per page built for far pages; 144-page scans must not stall | PV readText/layersFor, eea4073 | TextReader | done (cloud run 40754359833: worst main-thread stall 84.9 ms < 150; ink rasterized only near the view, per-stroke drawing, marks work time-sliced 12 ms a turn, note face warmed off the main thread, text normalized in the background) |
| 46 | Each page's text runs' boxes (upright only) in page units, and its text column from them | PV textBoxes, CV textColumn | TextReader | done (cloud run 40759592982) |
| 47 | Status text top-centre 12px #8f8f8f: "Opening the paper…", "No paper to open.", "Could not open the paper — <msg>", "Could not draw the paper — <msg>" | PV load/render | PaperViewController | partial: the texts that are shown are tested; "Could not draw the paper" is never shown (a failed page keeps its small drawing) and PDFKit gives no error text, so opening says "The file is not a readable pdf" |
| 48 | Where the paper was read to (zoom, at = scrollTop/scrollHeight, left) is told on close and restored on open (unless a target/section is given) | PV onView, MATH-16 | PaperViewController | done (cloud run 40759592982) |
| 49 | Optional title block: 600 15px/1.4 #171717 padded 14px 20px 0, then a 1px #eaeaea rule over the pages; none when no title | PV render | PaperViewController | done (cloud run 40759592982) |
| 50 | The pane is white (#fff) with no border | PV render CARD_GROUND | PaperViewController | done (cloud run 40759592982) |
| **Bottom bar and toast** |||||
| 51 | Bar: centred 16 px from the foot, 34 high, padding 0 4 0 12, white, 1px #eaeaea border, radius 8, 12.5px tabular #4d4d4d: "n" (#171717) "of m" (#8f8f8f), 1×16 #eaeaea separator, − (26×26, 14px), "pct%" (500, min 48), +; shown once pages > 0 and no status | PV BAR | PaperBar.swift | done (cloud run 40759592982) |
| 52 | Bar tooltip "pinch, or ⌘ or ⌃ scroll, to zoom"; % title "100% = fit width"; buttons hover-wash; a press on the bar keeps focus where it was | PV render | PaperBar.swift | partial: tooltip and the step / percent buttons tested; the hover wash and keeping focus on a press compiled, untested |
| 53 | Toast "Highlight removed · Undo" / "Note removed · Undo": centred 60 from foot, 30 high, #171717, radius 8, white 12.5px, shadow 0 2 8 .12; Undo 500; goes after 5 s | PV TOAST, REMOVED_MS | PaperBar.swift | done (cloud run 40759592982) |
| **Highlights (look)** |||||
| 54 | Each page's marks' bands (bandRects per mark, merged across marks) drawn as rough.js zigzag fills: rect (x, y+0.12h, w, 0.76h), fill rgba(0,112,243,.16), zigzag, fillWeight 1.3, hachureGap 2.4, hachureAngle −4, roughness 0.9, no stroke, seed boxSeed(page, band) | PV renderMarks | Rough.swift, PageSheet | done (cloud run 40759592982): geometry byte-identical to rough.js, the band's blue strokes read back as pixels |
| 55 | rough.js port exact: Park–Miller `Math.imul(48271)` RNG, rectangle outline computed first (consumes randomness) even with no stroke, hachure scan lines with JS rounding, zigzag V pairs, doubled curved lines | RJ | Rough.swift | done (cloud run 40759592982) |
| 56 | Highlights drawn in desk px (pane width at drawing time) and scaled to the page (viewBox): a zoom changes their scale, not their shape | PV renderMarks | PageSheet | partial: compiled, untested (the ink layer draws desk px scaled by pageW / deskW) |
| 57 | Highlight layer multiplies with the page (mix-blend-mode multiply): a band darkens paper, never ink | PV LAYER_CSS | PageSheet | done (cloud run 40759592982) |
| 58 | Mark in focus / pointed at: deeper fill rgba(0,112,243,.14), rx 2, no outline, over its bands (y+0.12h, 0.76h); other cards never fade | PV paintFocus, AR round 3 | PageSheet | done (cloud run 40759592982) |
| 59 | A pending or live selection drawn as its bands rgba(0,112,243,.22), over existing highlights | PV drawParts | PageSheet | done (cloud run 40759592982) |
| 60 | No "arrows" from a highlight to its note (taken out 2026-10-06; §5's "arrows" superseded) | PV header, 6217120 | — | n/a: removed in Electron |
| 61 | §5's gutters clamp(20% of width, 64, 150): superseded by #89 (100% = fit width, no artificial margins) | spec §5, #88–89 | — | n/a: superseded |
| **Selection** |||||
| 62 | A drag on the paper's text selects; the selection is drawn live as the bands it will be kept as, never the system's paint | PV liveSelection, AR round 2 | PaperDocumentView | done (cloud run 40759592982) |
| 63 | On release the selection snaps out to whole words at both ends (wordBounds on each end's page text) | PV snapWords | PaperDocumentView | done (cloud run 40759592982) |
| 64 | A selection across pages is one part a page; each part's rects measured on its page; slivers dropped; parts with no rects dropped | PV pageRanges/partsOf, MK | PaperDocumentView | done (cloud run 40759592982) |
| 65 | Released: the selection becomes pending (tinted, nothing kept) and the empty card opens under its last line | PV pdfMouseUp, 2026-10-18 | PaperViewController | done (cloud run 40759592982) |
| 66 | Pending: Enter keeps a bare highlight; a typed character keeps it with that character as its note and the note gets the keyboard at once (caret after it); Escape drops it | PV pendingSelKey | PaperViewController | done (cloud run 40759592982) |
| 67 | A press elsewhere on the paper, another selection, or the selection scrolled out of the pane drops the pending selection (nothing kept) | PV onDown, placeSelCard | PaperViewController | done (cloud run 40759592982) |
| 68 | The pending selection's geometry is carried across a zoom (scalePart) | PV rezoom | PaperViewController | done (cloud run 40759592982) |
| 69 | Pending keys are the paper's only while nothing else has the keyboard (keyFree) | PV keyFree | PaperDocumentView | partial: structural (pending keys reach the paper only through the canvas being first responder); no test |
| **The selection's card (2026-10-18)** |||||
| 70 | Empty card: under the selection's last line, left in line with it, CARD_GAP 8 below; above the first line with no room under; inside the pane (EDGE_PAD 8, clear of the bar's 58 px), whole px | SC selectionCardPlace | SelectionCard.swift | done (cloud run 40759592982) |
| 71 | Empty card look: width min(NOTE_W, paneFit) drawn at the last part's page noteScale, white ground, a blinking 1.5px caret (1.06 s steps) then placeholder "Write a note or ask @bart" (#b5b5b5) in the note's handwriting; pressing it keeps selection and keyboard | PV openSelCard | SelectionCard.swift | partial: size, place, white ground and placeholder pixels tested; the caret's blink not |
| 72 | The mark typed from the card stays where the card was (white ground, above others) until its note is left, then goes beside its highlight; placed again on scroll | PV selCard/placeTypedCard/leaveSelCard | PaperViewController | done (cloud run 40759592982) |
| **Marks from a selection** |||||
| 73 | addMark from a selection: partMarks then placeHighlight per page; new ids `m<ms><4 base36>`, groups `g…`; the note being started is the one being edited; saved | PV addMark, markId | PaperViewController | done (cloud run 40759592982) |
| **Free notes (typing anywhere)** |||||
| 74 | A still click (< PRESS_MOVE) on the page or the desk beside it, not on printed words and not one that put something away (pending selection, focused highlight, a note being typed in), writes a note there with the caret in it; the next click writes | PV onDown/pdfMouseUp/writeAt, AR | PaperViewController | done (cloud run 40759592982) |
| 75 | A note begun at x is kept ≥ EDGE_PAD from the pane's left and FREE_MIN·ns from its right edge; width = freeNoteWidth to the printed text after it on its line band (29 px) or the pane's edge; stored `w` (note px) and `pos` | PV writeAt/freeWidthAt/textAfter | PaperViewController | done (cloud run 40759592982) |
| 76 | A free note left empty (keyboard leaves, Escape) is gone and never saved; a highlight's empty note sets its note to null | PV leaveNote | PaperViewController | done (cloud run 40759592982) |
| 77 | A click on a highlight (its bands ± 2 px, last drawn wins) puts it in focus; a click elsewhere takes focus away | PV markAt/focusMark | PaperViewController | done (cloud run 40759592982) |
| **Cards (notes and answers)** |||||
| 78 | One card a mark with a note, an answer, or an answer being written: note, then each shown answer, then each running ask; 10px between sections, no rule, no box, no grip, no fill | PV cardBox, AR | CardView.swift | done (cloud run 40759592982) |
| 79 | Note handwriting: Caveat 500 24px, line height 1.2, letter-spacing .2, padding 0 6px, ink #1f2633, 4px under the note | CL NOTE_TYPE | CardView.swift | done (cloud run 40759592982) |
| 80 | Cards laid out in note px and drawn at the page's noteScale (frame = size·ns) | PV BOX_LOOK, AR round 3 | CardView.swift | done (cloud run 40759592982) |
| 81 | A card being typed in, empty, or holding answers keeps its whole width; otherwise it is as wide as its text up to its width | PV typingIn/cardBox | CardView.swift | done (cloud run 40759592982) |
| 82 | Card width: a typed note's `w`; a free note without `w` its freeNoteWidth at its place; a highlight's NOTE_W; never over paneFit = max(140, pdfW − 32)/ns | PV cardWidth/paneFit | CardLayout.swift | done (cloud run 40759592982) |
| 83 | Highlight card placement: against the text column (left: right edge SIDE_GAP from it; right: SIDE_GAP right of it) at the highlight's y·pageW − 6; width fitWidth(want, margin room, NOTE_MIN, span); other margin when its own < NOTE_MIN and the other ≥ NOTE_MIN; clamped into the pane [scrollX+8, scrollX+W−8] | PV arrangePages | CardLayout.swift | done (cloud run 40759592982) |
| 84 | Side stacking: stackNotes among a page's highlight cards (slack ∞ when a margin is narrower than NOTE_MIN), then spaceBoxes against moved cards | PV arrangePages | CardLayout.swift | done (cloud run 40759592982) |
| 85 | Moved / typed card (`pos`): at placeOf(pos); column of the page it lies over (pageOver); in the left margin keeps to it (narrow to room ≥ FREE_FIT/FREE_MIN, then moved out); near the text's right edge → pushed into the right margin when that has FREE_MIN room; otherwise narrowed to FREE_FIT then moved in | PV arrangePages | CardLayout.swift | done (cloud run 40759592982) |
| 86 | A card whose margin shows < HIDE_ROOM 40 note px is hidden (no clicks); a note inside the column whose place is off the pane is hidden; never the one being typed in or dragged; hidden cards take no room | PV arrangePages show, AR round 4 | CardLayout.swift | done (cloud run 40759592982) |
| 87 | Cards re-laid out (not redrawn) on zoom, resize and sideways scroll for the pages near the view; the rest when the draw loop reaches them | PV arrangeNear/cardKey | PaperViewController | done (cloud run 40759592982) |
| 88 | Cards above every page's drawing (one running past its page's foot stays in sight) | PV layout notes z-index | PaperDocumentView | done (cloud run 40759592982) |
| 89 | Hovering a card paints its mark's focus; leaving restores the clicked focus | PV cardBox onmouseenter | CardView.swift | done (cloud run 40759592982) |
| 90 | Move handle: four-arrow icon 13px in a 15×15 box just under the card's lower right (#8f8f8f, hover #171717), shown on hover, hidden while dragging; pressed it drags the card; title "Move" | PV MOVE_ICON | CardView.swift | done (cloud run 40759592982) |
| 91 | A press on a shown note's words: moved ≥ PRESS_MOVE it drags the card; let go before, the caret goes where it was pressed (noteOffset) | PV startPress/pressMove/pressUp | CardView.swift | done (cloud run 40759592982) |
| 92 | Drag: starts after 3 px, card leaves spacing, follows the pointer clamped to the sheet (left 0…S−w, top ≥ −page's top); near the pane's edges (28 px) the view scrolls 14 px a frame; on release `pos` = posOf in page units, `w` kept (note px); mark put in focus; saved | PV startDrag/dragTo/dragTick/endDrag | PaperViewController | partial: pos/w on drop and a pointer drag (posted events) tested; edge scroll compiled, untested |
| 93 | A new note, an ask sent, an answer landing scroll the card into the pane by as little as will do (REVEAL_PAD 16); landing answers only when some of the card shows | PV revealCard | PaperViewController | done (cloud run 40759592982) |
| **Notes: editing and mentions** |||||
| 94 | A note not being typed in is shown as text with library mentions as chips (blue #0070f3 500, dotted underline #c9c9c9), renamed items show their name now, gone ones grey "No longer in the library"; file mentions with folder/path tooltip, grey+struck when missing | DOC noteHtml/libHtml/fileHtml | NoteText.swift, CardView | done (cloud run 40759592982) |
| 95 | Clicking a chip opens it (host); clicking elsewhere in the note gives its field back with the caret there | PV noteView/noteCaret | CardView.swift | done (cloud run 40759592982) |
| 96 | Without a mention handler a note is always its field (no shown mode) | PV showsNotes | CardView.swift | done (cloud run 40759592982) |
| 97 | Typing saves (debounced), grows the field down, re-arranges cards | PV noteField oninput | CardView.swift | done (cloud run 40759592982) |
| 98 | Leaving a written note shows it as text a frame later; one taken out to be redrawn is not "left" | PV leaveNote/redrawing | PaperViewController | done (cloud run 40759592982) |
| 99 | `@` in a note opens the menu at the caret (query = `@` + ≤30 chars of no space/@/[]): library items only (no Zotero rows), plus Bart at the start of a highlight's note; ↑↓ move (wrap), Enter/Tab pick, Escape closes the menu alone; caret moves ←→ Home End refresh it; scroll closes it | PV noteMention/mentionList/noteKey | MentionMenu.swift | done (cloud run 40759592982): the look is MentionMenu.jsx's (400 wide, padding 4, rows 32, radius 8, #eaeaea, no shadow, #f2f2f2 row, 18 px kind glyphs #4d4d4d, names cut in the middle, ←/›, rises 160 ms), pixels read back |
| 100 | A pick replaces `@query` with `@[Name](lib:id)` then a space (an existing space is stepped over); Bart writes `@Bart ` (a following space removed); saved; keyboard stays | PV pickMention, DOC libMention | NoteText.swift | done (cloud run 40759592982) |
| 101 | A library folder opens in the menu (MATH-22): back row, "Mention this folder", entries, notes "Opening…", errors, "N more…"; Backspace right after `@` goes up a level; a file is written `@[Name](lib:<folder>:<rel>)` | PV openFolder/leaveFolder, RL folderRows | MentionMenu.swift | done (cloud run 40759592982) |
| 102 | A leading `@bart` in a note that can ask is drawn as the document's blue label (sans 500 .75em) in the shown note and in its field | DOC noteInkHtml/agentLabelHtml | CardView.swift | done (cloud run 40759592982) |
| 103 | Mentioned items' names change (library renamed, file state) → notes redrawn | PV libKey | PaperViewController | done (cloud run 40759592982) |
| **@bart from a highlight (the ask flow)** |||||
| 104 | Enter (no Shift, not composing) in a highlight's note starting with @bart asks: note saved, menu closed, field left; host gets {markId, page, quote: passageOf, note, question, turns: turnsOf, pageText} ; `@bart` with nothing after asks nothing | PV noteKey/askFrom | PaperViewController | done (cloud run 40759592982) |
| 105 | pageText = pageWindow(page's text, mark.text, at = y·pageW/pageH); '' when the text cannot be had within 2 s | PV pageTextAround | PaperViewController | done (cloud run 40759592982) |
| 106 | A free note, a note without @bart, Shift+Enter: no ask | PV noteKey | PaperViewController | done (cloud run 40759592982) |
| 107 | Running asks (host's pendingAsks for this pdf) show in their mark's card: spinner (10px, 1.5px #c9d9f2/#0070f3, .8 s), label runningLabel (#4d4d4d), Stop; grey question when not what the note asks; "▸ n steps" toggles the log (13px/1.7 #8f8f8f); streamed answer (Writing) without citations; scrolls to the end while at the end | PV runBox/fillRun | RunView.swift | done (cloud run 40759592982) |
| 108 | A failed run: "Bart · No answer" (500) and ×; error text #c4372d ("The run failed." default); × dismisses | PV fillRun | RunView.swift | done (cloud run 40759592982) |
| 109 | A running box is updated in place (buttons survive ticks); one that came or went redraws its page and reveals a just-sent ask | PV syncPending | PaperViewController | done (cloud run 40759592982) |
| 110 | addAsk(page, markId, entry): joins the mark once (an answer already there is ignored), drawn, revealed if seen, saved; false when the mark is gone | PV addAsk | PaperViewController | done (cloud run 40759592982) |
| 111 | Answer section: grey question header when not what the note asks; answer 15px/1.55 #171717, paragraphs a line, `- `/`* ` → "• ", headings bold, bold/italic/code/links/mentions; scrolls inside past max(140, 40% of pane height)/ns | PV askSection/answerParas, CL | AnswerView.swift | done (cloud run 40759592982) |
| 112 | Answer buttons (13px #8f8f8f, hover #f2f2f2/#171717, radius 5): Continue in project (when the host takes it; says "Added" 1.4 s), Copy ("Copied" 1.4 s), Delete, Collapse; collapsed → "Bart ›" (500 #171717, title = question) expands | PV askSection/askClick | AnswerView.swift | done (cloud run 40759592982) |
| 113 | Delete hides an answer (`deleted: true`), ⌘Z brings it back; it stays a turn while its session lasts | PV askClick/undo, CV exchangeOf | PaperViewController | done (cloud run 40759592982) |
| 114 | Links in an answer open through the host (never the window); library chips open the item; file chips the file | PV askClick | AnswerView.swift | done (cloud run 40759592982) |
| 115 | Chat's citations in answers: numbered grey circles (same passage same number), a "Sources" list under the answer (500 11px #8f8f8f, numbered rows with names); 3+ adjacent fold into first + "…" | CT | AnswerView.swift | done (cloud run 40759592982): citations, numbering, sources, the card and the passage fold are EngelbartDoc's (Cite, PassageLink, AddressKey); a run of 3+ folds into its first and "…" (opens on a click or the pointer); the hover card is cite.js's (280 wide, quote, rule, document glyph, where · when), gone CARD_GRACE after the pointer leaves |
| 116 | Continue in project sends {markId, page, quote: passageOf, question, answer, foot}; the host adds the paper | PV askClick | PaperViewController | done (cloud run 40759592982) |
| 117 | Removing a mark stops its running asks first (not failed ones) | PV removeMark | PaperViewController | done (cloud run 40759592982) |
| **Removing and undo** |||||
| 118 | Backspace/Delete with a mark in focus (after a press in this pane, nothing having the keyboard, no ⌘⌃⌥) removes it and every part of its group; no confirmation; toast for 5 s | PV markKey/removeMark | PaperViewController | done (cloud run 40759592982) |
| 119 | ⌘Z (after a press in the pane, nothing having the keyboard) brings back the last removal (all parts at their indices) or deleted answer; with nothing to bring back the key is the app's | PV undoKey/undo/undoRemoval | PaperViewController | done (cloud run 40759592982) |
| 120 | The toast's Undo does the same as ⌘Z for its removal and hides the toast | PV render | PaperViewController | done (cloud run 40759592982) |
| 121 | Another paper clears the undo list and the toast | PV load | PaperViewController | done (cloud run 40759592982) |
| **Copy** |||||
| 122 | ⌘C with no text selection and nothing having the keyboard copies the pending selection's text, else (after a press here) the focused mark's passage, through the host | PV copyKey | PaperViewController | done (cloud run 40759592982) |
| **Find and sections** |||||
| 123 | find(query, step): words split on space; each char may be followed by `-\n` (hyphen-newline rule); words joined by `\s*`; case-insensitive; empty stops; → {matches, active} | PV findPattern/find | Find.swift | done (cloud run 40759592982) |
| 124 | nextFind: fresh/step 0 → first match in view or below; ±1 wraps; re-run keeps place; fromStart → 0; scroll on fresh/step/fromStart | FD | Find.swift | done (cloud run 40759592982) |
| 125 | Matches painted rgba(255,196,0,.35), the active one rgba(255,140,0,.6); a match out of view is brought a third of the way down (and across) | PV paintFind/scrollToRange | PageSheet | done (cloud run 40759592982) |
| 126 | A passage of ≥ 3 words found nowhere literally is matched typography-folded (curly quotes, dashes, ligatures, soft hyphens, `-\n` breaks) | PV matchSpots, PT matchPassage | Find.swift | done (cloud run 40759592982) |
| 127 | Find counts over every page's read text; results reported again once every page's text is in | PV textsDone/report | PaperViewController | done (cloud run 40759592982) |
| 128 | Sections: a target `find` (+ optional `to`) shown from page 1 as a tint rgba(255,196,0,.13) from the start words to just before `to` (≤ 6 pages), scrolled to; stays while find runs; cleared on demand; told through onTarget(text, result) once per target | PV showSection/applyTarget, FD | PaperViewController | done (cloud run 40759592982) |
| 129 | A target naming its page goes there at once and shows its passage once that page's text is in | PV targetOn, 5298192 | PaperViewController | done (cloud run 40759592982) |
| 130 | initialSection shown on open when there is no target | PV constructor | PaperViewController | done (cloud run 40759592982) |
| **Keys and focus** |||||
| 131 | Space is never the paper's (scrolls the pane) | test paper-note-ask | PaperDocumentView | done (cloud run 40759592982) |
| 132 | Note field keys never reach the page or the Stage; Escape leaves the note | PV noteKey | CardView.swift | done (cloud run 40759592982) |
| **Host / embedding** |||||
| 133 | PaperViewController (NSViewController) embeddable in the Stage and the workspace; two on one pdf look up only their own sheets | memory: host-scoped lookups | PaperViewController | done (cloud run 40759592982) |
| 134 | PaperHost: annotations read/write, ask, stop/dismiss ask, continue, copy text, open link/mention/file, library names, file state, mention items, list folder, mention menu open, view, find/target reports, errors | PV props | PaperHost.swift | done (cloud run 40759592982) |
| 135 | `bytes` changing → flush save of the old paper, adopt new marks, drop pending, load anew | PV componentDidUpdate | PaperViewController.load | done (cloud run 40759592982) |

## Notes on the port

- Tests: `Tests/EngelbartPDFTests/` — MarksTests (paper-marks), CanvasTests (paper-canvas, zoom/draw/find pure parts, the
  ink JSON, rough.js against `Fixtures/rough-highlights.json` made by rough.js 4.6.6 itself), CardLayoutTests (the
  placement half of paper-canvas-zoom), PaperViewTests (a real offscreen window over a pdf made in the test: the
  behaviour half of paper-blank-arrows, paper-remove-mark, paper-note-ask, paper-draw, and a 144-page stall probe).
  Cloud run 40759592982: 128/128 pass (second pass: PaperTestCase + PaperViewMoreTests, offscreen window, synthesized events, pixels). The probe logs each long run-loop turn's paper phases (PaperTrace) so a regression names its culprit.
- Ink JSON differences that do not change meaning: an answer's `meta` object is written with sorted keys (its original
  order is not kept by JSONValue); unknown fields come after the known ones, sorted.
- Electron quirk kept as-is: a "web" list in a pdf's ink is passed through untouched (Electron would have filtered it
  through keptMarks; a pdf's ink never holds one in practice).
- `Rough.path` is one CGPath of every stroke; the highlights draw `Rough.strokes` (one path a stroke) because
  CoreGraphics resolves every self-crossing of a single stroked path (seconds for one band).
- The selection is PDFKit's (`PDFDocument.selection(from:at:to:at:)`), snapped by marks.js wordBounds on PDFKit's page
  string, measured character by character (`PageChars.rects`, whitespace skipped as textRects did), then merged as in
  Electron. Line breaks in PDFKit text may be \r or \r\n: find and passages search a normalized copy with an index map.
- Text runs (pdf.js items) become PDFKit line selections for the column and a note's room (`TextReader.read`).

- Since the second pass, selection-card, mark-answers, mentions (noteParts, noteOffset, mentionAt, lib/file mentions),
  citations and the passage fold are EngelbartDoc's (SelectionCard, MarkAnswers, Inline, Cite, PassageText): this package
  keeps typed wrappers only. EngelbartDoc holds the one definition.
