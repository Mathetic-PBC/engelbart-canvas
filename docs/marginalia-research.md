## Digital marginalia: design findings for handwritten margin notes in a PDF viewer

I checked the main numbers in primary sources: the tufte.css source, Gwern's `sidenotes.js`, Hypothesis's `buckets.ts` and `highlights.scss`, Google's 2021 Docs comment-width announcement and the Fluid Documents "swoopy text" patent. I got the font metrics by downloading the Google Fonts TTFs and measuring them with fontTools. No project files were edited. I did not find primary sources for Zotero 7, Kindle, Medium or Roam, so they are left out.

### 1. Spacing
- **tufte-css:** body text is 1.4rem at 15px root size with line-height 2rem, and the text column is 55% of the section. Sidenotes and margin notes are set to `float:right; clear:right; margin-right:-60%; width:50%`. This puts the note column about 10% of the section width to the right of the text.
- **Google Docs:** comment cards were a fixed 35 characters wide until 2021, when the maximum went to 50 characters (43% wider). The width now scales with the browser window.
- **Word:** the comment balloon area's width can be changed under Advanced Track Changes Options ("Preferred width"). The text says 3.7 in is the default; that figure is from memory, not a source.
- **Vertical spacing:** Gwern's `sidenotes.js` keeps at least `sidenoteSpacing = 60` px between notes. It uses the same 60 px buffer around full-width figures and tables, where notes are not allowed. Hypothesis uses `BUCKET_GAP_SIZE = 60` px for grouping anchors.
- **Recommendation:** use a gap of 16–24 px between note and text, 8–12 px between stacked notes, and a margin 180–260 px wide (about 22–30 characters of handwriting).

### 2. Text size and handwriting legibility
- **tufte-css:** note text is 1.1rem with line-height 1.3, about 0.79× the body size.
- **Readability research:** handwritten and script fonts are the standard "disfluent" condition in reading studies. Easy-to-read cursive did not hurt memory, but hard-to-read cursive did. So pick print-like, unconnected letterforms.
- **Measured x-height in em (my fontTools run; Inter is 0.546 for comparison):**

| Font | x-height (em) | Avg. lowercase width (em) | Notes |
|---|---|---|---|
| Kalam | 0.511 | | Upright-ish, screen-optimised |
| Gochi Hand | 0.490 | | Caps nearly as short as lowercase (cap height 0.558) |
| Patrick Hand | 0.468 | 0.402 | Separate printed letters, compact |
| Architects Daughter | 0.469 | 0.507 | Wide |
| Indie Flower | 0.395 | | |
| Caveat | 0.355 | 0.359 | Very small x-height, condensed |
| Shadows Into Light | | | Thin strokes, very narrow |
| Reenie Beanie | | | Thin strokes, very narrow |
| Shantell Sans | 0.497 | | Designed for legibility |

- **What follows:**
  - Caveat must be set about 1.35–1.5× larger than Patrick Hand or Kalam to get the same x-height.
  - Shadows Into Light and Reenie Beanie are poor below about 18 px.
- **Ranking for small sizes:** Patrick Hand ≈ Kalam > Shantell Sans > Gochi Hand > Architects Daughter > Caveat (good only when set large) > Indie Flower > Shadows Into Light and Reenie Beanie.

### 3. Overlap avoidance
- **tufte-css:** uses `clear:right` only, so a note can only be pushed down. Long or many notes still overlap, and Gwern names this as Tufte-CSS's known limit.
- **Gwern `sidenotes.js`:**
  1. Odd-numbered notes go right and even-numbered notes go left when both margins exist.
  2. The ideal top is the anchor's top + 4 px.
  3. Figures and tables mark areas where notes are not allowed, which splits each margin into "layout cells".
  4. Each note goes to the best cell, scored by vertical distance first, then crowding.
  5. Within a cell, notes are placed top-down. On overlap, `pushNotesUp` moves earlier notes up into free space; it does not only push later notes down.
  6. If nothing fits, the script gives up and falls back to footnotes.
  7. Arrows angle up or down to point at the anchor.
- **Hypothesis:** the annotations themselves sit in a list in the sidebar. The bucket bar merges anchors less than 60 px apart into one count marker, centred on the group. All off-screen anchors go into one "above" and one "below" bucket, placed 25 px from the edges.
- **Google Docs:** threads push the threads below them down. The selected thread snaps to its anchor and the others move out of its way. ProseMirror implementers describe copying this, with debounced realignment so notes don't jitter.
- **Fluid Documents and Fluid Links (PARC, 1998):** a note grows into the margin, between lines, or as an overlay, and the body text reflows to make room. The animation runs from about 0.25 to 2 s.
- **SpaceInk (UIST 2019):** reflows the document to make space for ink notes in context.

### 4. Linking a highlight to its note
- **Hypothesis:** hovering a card turns the matching highlight from yellow `rgba(255,255,60,.4)` to blue `rgba(156,230,255,.5)`. In PDFs, the focused SVG highlight is cloned and drawn on top.
- **Gwern:** hovering a note or its anchor highlights both, and the arrow points toward the anchor.
- **Word:** "All Markup" draws a connector line from each balloon to its text, and users can turn these lines off.
- **Marshall (1997), studying real paper books:** readers drew "arrows and other deictic devices to connect within-text markings to other marginal markings". So arrows read naturally as handwriting.
- **Matuschak:** argues a note only needs to be "in the general vicinity" of its text.
- **Recommendation:**
  - Show no lines at rest; rely on vertical alignment plus a matching colour.
  - On hover or focus, emphasise both highlight and note and dim the others to about 40% opacity.
  - Draw a short hand-drawn curved leader line only when a note has been moved more than about 24 px from its anchor, or only on hover. Always-on lines become clutter once notes are dense.

### Recommended layout algorithm
```
notes.sort(by anchor.top)
for n in notes: n.ideal = anchor.top + 4 ; n.side = preferred (right; left if 2 margins & right column busier)
for side in sides:
  y = -inf
  for n in side.notes:                       # downward pass
    n.top = max(n.ideal, y + GAP)            # GAP = 10px
    y = n.top + n.height
  for n in reversed(side.notes):             # upward pass (Gwern pushNotesUp)
    n.top = min(n.top, next.top - GAP - n.height) but >= max(prev.bottom+GAP, n.ideal - MAX_UP)  # MAX_UP≈ 80px
if focused: pin focused.top = focused.ideal, re-run both passes on notes above/below
if n.top - n.ideal > 24px: draw leader; if a note still exceeds page bottom: collapse it to a numbered marker (Hypothesis bucket style)
debounce relayout ~100ms; animate moves 150–250ms
```

### Recommended note style
- **Font:** Patrick Hand (fallback Kalam), 15–17 px when the PDF body is about 12–14 px on screen. Size by x-height rather than nominal px: aim for a note x-height of about 0.85–1.0× the body's x-height.
- **If you choose Caveat:** use 20–22 px.
- **Line-height:** 1.2–1.3.
- **Column:** about 24–30 characters per line.
- **Colour:** ink about #2b3a67 or match the highlight hue, with contrast of at least 4.5:1.
- **Avoid:** Shadows Into Light, Reenie Beanie and Indie Flower below 18 px.

### Sources
- tufte-css: https://github.com/edwardtufte/tufte-css (tufte.css)
- Gwern, Sidenotes: https://gwern.net/sidenote ; code: https://gwern.net/static/js/sidenotes.js
- Danila Fedorin, sidenotes (CSS-only, two margins): https://danilafe.com/blog/sidenotes/
- Hypothesis buckets: https://github.com/hypothesis/client/blob/main/src/annotator/util/buckets.ts ; highlight styles: src/styles/annotator/highlights.scss, src/annotator/highlighter.ts
- Google Docs comment width: https://workspaceupdates.googleblog.com/2021/09/comment-size-increasing-in-google-docs.html
- ProseMirror sidebar alignment discussion: https://discuss.prosemirror.net/t/vertically-align-sidebar-blocks-to-content/4775
- Word balloons and connector lines: https://www.dummies.com/article/technology/software/microsoft-products/word/how-to-use-comments-in-microsoft-word-2019-259119/
- Zellweger, Chang, Mackinlay, Fluid Links (HT'98): https://homepages.cwi.nl/~media/bridge/entries/ht98:zellweger.html ; Fluid Documents: https://hci.stanford.edu/seminar/abstracts/98-99/990409-zellweger.html ; swoopy-text patent: https://patents.google.com/patent/US7188306
- Marshall 1997, Annotation: from paper books to the digital library: https://www.readkong.com/page/annotation-from-paper-books-to-the-digital-library-2865025
- Romat et al., SpaceInk (UIST 2019): https://www.microsoft.com/en-us/research/publication/spaceink-making-space-for-in-context-annotations/
- Matuschak, digital marginal notes: https://notes.andymatuschak.org/zGsRWkonFv1KGAsWwiYA3he
- LiquidText features (ink links): https://www.liquidtext.net/features
- Cursive disfluency study: https://collaborate.princeton.edu/en/publications/would-disfluency-by-any-other-name-still-be-disfluent-examining-t/
- Font files: https://github.com/google/fonts/tree/main/ofl
