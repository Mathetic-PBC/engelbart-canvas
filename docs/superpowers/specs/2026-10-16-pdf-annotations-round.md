# PDF annotations round (2026-10-16)

Branch `annotations` (worktree `.superpowers/worktrees/annotations`), from `hudson-ui-10-16` at d1c57cc. Hudson's request,
"Annotations > PDFs", restores the annotation UX that notes had before MATH-27 (6217120, the MATH-15 round of
2026-10-06) and builds on it. Files: `src/renderer/pdf/PaperView.jsx`, `canvas.js`, `marks.js`,
`src/renderer/model/paper-draw.js`.

## What changed, item by item

| Hudson's item | What it is now | Where |
|---|---|---|
| Lag on trackpad pan and zoom; the whole app freezes | A pinch is one CSS `transform` on the paper, handled by the compositor. When it settles, the same sheets are resized; nothing is rebuilt. Text layers are rescaled through `--total-scale-factor`, highlights through their SVG `viewBox`, notes through their layer's `scale`. Text layers are made once per document, a page at a time, with a turn of the event loop between pages. Text layers out of view are skipped (`content-visibility:auto`). | `pinch`, `rezoom`, `applyGeometry`, `place`, `drawPages`, `drawText` |
| Thin black line around PDFs, weird sizing | No page edge, no rule between pages, no gap. Every page is drawn as wide as the others: the CHI '92 scan's pages are 613–632 pt wide, which put their edges out of line. | `place`, `paper-draw.js columnGeometry` |
| No panning left and right | The sheet is the pane's width and clips what lies past it (`overflow-x: clip`), so a two-finger swipe moves nothing at or below 100%. The desk beside the page shows only when zoomed out. Past 100% the page alone scrolls sideways, never the desk; see open question 1. | `columnGeometry`, `layout` |
| Zoom straight down the center | A pinch is centered on the pane's vertical middle line, at the height the pinch began (tldraw's `behavior: {x: 'fixed'}` with `origin.x: 0.5`). The bar's −/+ zoom about the middle of the view. | `startPinch`, `settleView` |
| Continuous highlights, no outline | A highlight's own boxes on a line are one band across word gaps of up to 1.6 line-heights, which is narrower than a column gutter. The highlight in focus is a deeper fill with no stroke. The highlight layer is `mix-blend-mode: multiply`, as pdf.js does it. | `marks.js bandRects`, `paintFocus`, `markAt` |
| Fill vertical space, less horizontal text | A highlight's note is as wide as its margin (96–240 desk px, `canvas.js noteWidth`), wraps there and grows down. It keeps to the page's edges, or to the desk that showed when it was written (`m.vis`). A typed note runs to the printed text or the pane's edge (`freeNoteWidth`, stored as `m.w`). | `cardWidth`, `arrange` |
| Research how this was engineered | pdf.js viewer (CSS-variable layers, text layer never rebuilt on zoom, rAF-chunked renders); pdf.js highlight editor (multiply, no stroke); tldraw camera constraints (fixed x axis); Chromium docs (`transform` vs `zoom`, `will-change`, `content-visibility`). Brief with sources: see "Sources". | |
| Type anywhere | A click anywhere but the printed words, on the page or the desk, writes a note there with the caret in it, as before MATH-27. A click that puts something away (a pending selection, the highlight in focus, a note being typed in) writes nothing; the next one does. | `pdfMouseUp`, `writeAt` |
| No box around annotations | No border, grip, fill or divider. A card is moved by pressing on its note's words and dragging past 4 px; a click puts the caret in. | `cardBox`, `startPress`, `pressMove` |

Removed with the desk: Space-drag, middle-drag and blank-drag panning; the double-click to write; the fades and chips for
boxes out of view; `deskOf`/`deskNeed`/`fitZoom`/`offscreen`/`blankAt` in `canvas.js`. Kept from David's work: @bart from
a highlight's note and its answer cards, Delete/⌘Z/toast for removing a mark, ⌘C, @mentions and library folders,
"a selection clicked away from is kept as a highlight", sections and find.

## Measurements

`scripts/probe-paper-lag.cjs` renders PaperView alone, offscreen at 60 fps, with pdf.js's decoders. It puts four
highlights and a note on every page, then sends trackpad-like wheel events. The table shows the longest main-thread stall
in the 2.5 s after a pinch settles, where a long task means more than 50 ms.

| PDF | pinch in, before → after | pinch out, before → after | scroll during, before → after | swipe sideways moves the view |
|---|---|---|---|---|
| CHI '92 scan, 11 pp | 206 ms (152 ms task) → 61 ms (none) | 98 → 94 ms (59 ms task left) | 74 → 28 ms | 813 px → 0 |
| CSUR, 36 pp | 262 ms (245 ms task) → 22 ms | 75 → 22 ms | 10 → 7 ms | 800 px → 0 |
| Etherphone, 75 pp | 589 ms (585 ms task) → 23 ms | 335 → 44 ms | 31 → 9 ms | 819 px → 0 |

The 59 ms task left at 15% on the scan comes from all 11 pages being on screen at once: their text layers are in view,
so `content-visibility` cannot skip them.

`scripts/probe-paper-look.cjs` drives the real UI the same way and saves a screenshot per step: a selection with a note
typed on it, a note typed in the margin, a sideways swipe, a pinch out, a note written on the desk, back to 100%, and 200%.

## Validity threats in the probes

- The probes run offscreen. A hidden window skips style, layout and paint, and an unfocused page fires no blur. Both are
  worked around (offscreen rendering, CDP focus emulation), but compositor scrolling on a real display was not measured.
- The marks are synthetic, four highlights and a note per page. Hudson's real annotation density is unknown.
- The wheel listener must stay non-passive, because a pinch needs `preventDefault`. Every two-finger scroll over the
  paper therefore waits for the main thread. The fix keeps that thread free; it does not remove the wait.

## Open questions

1. Past 100% the page scrolls sideways within its own width, so its left and right columns stay readable. Should it
   lock completely instead, with only the middle visible?
2. A margin narrower than 96 desk px (a 612 px pane on an ACM paper) makes a highlight's note overlap the text's edge
   rather than run off the pane. Bart's answers share the note's narrow width. Is that acceptable, or should answers get
   a wider column?
3. A note written while zoomed out (wider, out on the desk) is partly clipped at 100%. That is the "reach it by zooming
   out" model; it shows a sliver at the pane's edge.

## Sources

pdf.js 6.3.289 (`web/pdf_viewer.js`, `web/pdf_page_view.js`, `src/display/text_layer.js`,
`src/display/editor/drawers/highlight.js`, `web/pdf_viewer.css`); tldraw v5.5.2 (`Editor.getConstrainedCamera`,
`useGestureEvents.ts`, `DefaultCanvas.tsx`); Excalidraw (`App.wheel.ts`, `viewport.ts`); web.dev "Stick to
compositor-only properties", developer.chrome.com "Re-rastering composited layers on scale change", web.dev
"content-visibility", developer.chrome.com "Scrolling intervention"; Gwern `sidenotes.js`; Hypothesis `buckets.ts`.

## Round 2: bugs after the edit (2026-10-16, later)

| Hudson's bug | Cause | What it is now | Where |
|---|---|---|---|
| White strip over the zoomed-out PDF (15%) | Pages never drawn (far from where the paper was read) showed white during a pinch and until drawn after it; a pinch out near the top showed the empty space above page 1 until it settled; and pages 3 and 5 of the Etherphone PDF are blank in the file. | A page has a small drawing (180 canvas px wide) under its own: made from its drawing when it gets one, else drawn by pdf.js in the background for pages within 12 of the view (then `page.cleanup()`), and kept when the full drawing is given back. A pinch's transform is shifted so the paper's top (and foot) stay at the pane's edge. Blank pages stay blank. | `keepThumb`, `drawThumb`, `thumbDue`, `pinchTransform` |
| Notes out of view when zoomed in; "annotations don't shift right/left when im zoomed in" | The cards' layer scaled with the page, so a card sat where the page put it, off the pane at 200%. | Cards are laid out in screen px on an unscaled layer. Where a card sits follows the page (its highlight's height and the text's edge, or its `pos`); the pane's sides then narrow it (to NOTE_MIN 96 for a highlight's note, FREE_FIT 160 for a typed or moved one) and move it in. Re-laid out on every zoom and sideways scroll, for the pages near the view; the rest as the drawing loop reaches them. | `arrangePages`, `arrangeNear`, `cardKey`, `canvas.js fitWidth` |
| Notes unreadable when zoomed out; "same size at all zooms" | Same scaled layer. | Cards are screen-sized (Caveat 24px at every zoom). During a pinch each page's cards are counter-scaled (`--inv` = 1 / the pinch's scale, about the corner each hangs from), so they keep their size until the layout settles. | `BOX_LOOK`, `cardsInverse` |
| Move icon on hover | — | A four-arrow handle just under each card's lower-right corner, shown while the pointer is on the card; pressed, it drags the card. A press on the words still drags past PRESS_MOVE, a click still edits. | `cardBox`, `MOVE_ICON` |
| "I should have to hit enter for it to save" | David's 2026-10-07 change kept a selection clicked away from. | A click away drops a pending selection, as before MATH-27; Enter keeps it as a highlight, typing keeps it with a note, Escape drops it. | `onDown` |
| Vertical line on the left when highlighting | The text layer's `<br>`s were painted when selected (pdf.js hides them with `br::selection`, which the copied rules lacked); a dashed line down the page's left. | `br::selection` transparent; the browser's selection paint is hidden in the text layer altogether and the selection is drawn as the bands it will be kept as while it is dragged. | `LAYER_CSS`, `liveSelection`, `partsOf`, `drawParts` |

Measurements after round 2 (same probe, longest stall in the 2.5 s after a pinch settles): Etherphone 25 ms in, 51 ms
out; CSUR 27 / 28 ms; CHI scan 61–77 ms in, 95–103 ms out over three runs (the 11 pages all in view at 15%, as before).
With the background small drawings turned off the scan's pinch out measured 118–125 ms: they do not cost the stall, they
shorten it (the pages' images are decoded before the zoom needs them).

Data: a typed note's `w` is now read as screen px (it was desk px, the same number at 100%); a highlight's `vis`
is no longer written or read.

## Round 3: after round 2 (2026-10-16, evening)

| Hudson's note | Cause | What it is now | Where |
|---|---|---|---|
| "When I hover all the other highlights grey out instead of just the one I am hovering over" | `paintFocus` faded every other card to 0.45 (MATH-15). | Only the pointed-at mark's highlight darkens; no card fades. | `paintFocus` |
| "The font size is way too large … roughly constant to what the font size of the pdf is at 100%, so like 10pt"; "shrinking may actually be more natural" | Round 2 made cards 24px on screen at every zoom: about twice the body text at 100%, and huge next to 15% pages. | A card is laid out in note px and drawn at `--ns` = `noteScale(pageW)` = pageW / NOTE_REF (1050), so Caveat 24 is 14 of the page's 612 pt, the x-height of 10 pt Helvetica. It shrinks and grows with the page, down to NOTE_FLOOR (10px handwriting) where it stops shrinking. A pinch scales cards with the paper and holds them at the floor (`--inv`). | `canvas.js noteScale`, `BOX_LOOK`, `boxScale`, `cardsInverse` |
| "it overlaps and isn't in the margins, and the text avoidance is very clearly bad" | (1) A typed note's room ran to the pane's right side, so a left-margin note spread over the column. (2) The room was measured from where it was placed even when that was off the pane. (3) Round 2's `writeAt` pulled a note begun near the pane's edge onto the text's right edge, and FREE_FIT kept it wider than the margin. (4) A note's `pos` past its own page's foot was checked against that page's column, not the page it lies over (blank page 3 → no column). (5) A highlight's note stayed in a margin too narrow for it when the other had room. | A typed note in the left margin is as wide as the room to the text, then moved out toward the pane's side; one against the text's right edge goes into the right margin; in either margin it narrows to the margin (≥ FREE_MIN) before it goes over the text. Rooms are measured from where a card can show. The column is the page's the note lies over (`pageOver`), re-laid out when that page's text arrives. A highlight's note takes the other margin when its own has under NOTE_MIN and the other does not; `stackNotes` may not move one into a too-narrow margin. Over the text only when neither margin shows (zoomed in). | `arrangePages`, `pageOver`, `textBoxes` |

Data: `w` is note px again (screen px at noteScale 1; at 100% in a 1050 px pane the same number as round 2).

Checked offscreen on Hudson's test notes (Etherphone p. 4, 900 px pane): at 100% the left note sits in the left margin wrapping down, the right one in the right margin, neither over the text; at 15% both are 10px handwriting beside the page. Not measured on his display.

## Round 4: notes hide when their margin does (2026-10-16, night)

Hudson: "if i zoom in such that there are no margins and it is just text the annotations shouldn't still show". This takes
back round 2's "see all annotations … irrespective of zoom and position": a card whose margin shows less than HIDE_ROOM
(40 note px) is hidden (`visibility: hidden`, so it takes no clicks), and so is a note typed inside the text's column whose
place is off the pane. Scrolling sideways (past 100%) until its margin shows brings it back. A note being typed in or
dragged is never hidden. Hidden cards take no room in the spacing. `arrangePages` `show`, `canvas.js HIDE_ROOM`.
