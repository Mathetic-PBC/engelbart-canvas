## reMarkable: research behind the integration (2026-10-31)

What was read before building `packages/remarkable-bridge` and `src/main/remarkable/`, and why it is built the way it
is. About 45 open-source projects were read (cloud clients, `.rm` parsers and renderers, sync tools, Zotero and Obsidian
bridges); nothing was copied from a GPL or AGPL one.

### 1. Where documents come from: the reMarkable app's library, not the cloud, not USB

- **The cloud is off limits.** reMarkable has no public API. Its account terms (Terms and Conditions for reMarkable
  Accounts, effective 2024-02-28; read from a snapshot, the live page would not load) forbid reverse engineering the Cloud
  Services (§8.3) and make "attempts by you … to use any other software or hardware other than reMarkable's software or
  hardware or third party applications approved by reMarkable to access or use the Cloud Services" a material breach
  allowing termination of the account (§12(iii)). Paid products (Scrybble, SendPaper) use the unofficial API anyway and
  no enforcement was found, but the risk would land on our users' accounts. The unofficial protocol also broke clients
  four times in 2026 (header validation, sorted root indexes, mandatory checksums).
- **USB is out** (decided 2026-10-31). The tablet's USB web interface (`http://10.11.99.1`) works without an account
  but needs the cable, a settings toggle each session, and an awake tablet.
- **The official reMarkable app keeps a plain copy of the library on disk** while it runs and syncs:
  `~/Library/Containers/com.remarkable.desktop/Data/Library/Application Support/remarkable/desktop` (older unsandboxed
  versions: `~/Library/Application Support/remarkable/desktop`; Windows `%APPDATA%\remarkable\desktop`). It is the
  tablet's own layout, so the same parser reads it. Reading it is reading local files the person's own app wrote, not
  the Cloud Services. macOS asks once whether the reading app may read another app's data. Caveats: it is fresh only while
  the app runs; without a Connect subscription the cloud (and so the app) keeps only files used in the last 50 days
  (reMarkable's support page; not yet tried on a non-subscriber's account), so Engelbart keeps every document it has
  seen unless it is put in the tablet's trash, and a non-subscriber brings an older notebook in by opening it on the
  tablet; its layout is undocumented, so it is read leniently and never written to.

### 2. A document on disk

`<id>.metadata` (JSON: `visibleName`, `type` DocumentType / CollectionType, `parent` '' / 'trash' / a folder id,
`lastModified` as a string of epoch ms), `<id>.content` (JSON: `fileType` notebook / pdf / epub, the page list),
`<id>/<pageId>.rm` (one per page with ink; none for a page without), `<id>.pdf` / `<id>.epub`, plus `.pagedata`,
`.local`, thumbnails. Folders are flat: hierarchy is `parent`. A folder put in the trash keeps its children's `parent`,
so the trash is inherited.

**Page order** (`.content` formatVersion 2, `cPages.pages`): sort by `idx.value` as a plain string (the array order is
not the display order once a page was moved); drop `deleted`; `redir.value` is the 0-based PDF page under the page, and
absent on a page inserted on the tablet. Deleted pages keep their `redir`: PDF page numbers are never renumbered.
formatVersion 1: `pages[]` and `redirectionPageMap[]` (-1 inserted).

### 3. The `.rm` page format (v6, firmware 3.x to 3.28, reMarkable 2 and Paper Pro)

A 43-byte header, then blocks of `u32 length, u8 0, u8 min_version, u8 current_version, u8 type`. Inside, fields are
tagged (`varuint (index << 4) | type`, type 1/4/8 bytes, length-prefixed subblock, or CRDT id) and many are optional:
an optional read must never look past its block's end (rmscene PR #60 found corrupted strokes from exactly that).
The scene is a tree of groups (those under the root are layers) whose children are CRDT sequences (left/right ids;
concurrent inserts: higher author index first, then lower counter). Deleted items stay in sequences but are not drawn.
Strokes: tool, colour, an ARGB for highlighter and shader since 3.14, and 14-byte points (x, y, speed, width, direction,
pressure). The `width` is what the tablet drew the point at, so the renderer needs no pen model of its own (rmc's descends
from LGPL code and was not used). Highlights on PDF/EPUB text carry the text itself and one rectangle per line. Typed
text is a per-character CRDT with paragraph styles (3.2x adds heading levels and list nesting in two extra fields).
Paper Pro pages say their size (1620×2160; reMarkable 2: 1404×1872, the default when unsaid). Firmware 1.x/2.x pages
(v3/v5) are flat layers of strokes with x from the left edge. Credit: rmscene (MIT), whose structure the parser follows
and whose test pages are the package's fixtures.

### 4. Where ink goes

- **Notebook pages:** x = 0 at the page's horizontal centre, y = 0 at its top; ink may lie outside (pages scroll).
- **On a PDF:** the same frame sits on the PDF page's crop box, origin at its top centre, at a **fixed 227 units per PDF
  point**, whatever the page's size. Fitted on a Paper Pro document, highlight rectangles against the PDF's own text
  baselines, with no residual; 226/72 (what other tools assume) is 0.44% off. Fit-to-width, which several viewers use,
  is wrong for any page not ~447 pt wide. Confirmed on a real reMarkable 2 library (handwriting in a PDF planner's cells).
- **Strokes beside typed text** are kept relative to an anchor: x = the anchor's `originX`, y = the top of the anchored
  line plus half the anchor's threshold. Measured on rmscene's Lines_v2 / Lines_v2_updated (the same strokes before and
  after the tablet anchored them): exact in x, 0.08 units off in y. Lines below the first are estimates, since the
  tablet's fonts and wrapping are not in the file.

### 5. What other tools taught

Got right elsewhere: the document's id as its identity (never its name or path); skipping unchanged work by content
(root, document, page); bounded concurrency (Electron fails past ~250 requests at once); one-way by default and never
deleting the person's own output; drawing ink over the original PDF and keeping highlights as highlights; parsing
leniently, so one malformed document never blocks a library. Got wrong elsewhere: shelling out to a CLI and parsing its
output (Scrybble, zotero2remarkable: broken by every cloud change); a server holding users' tokens; timestamp-based
two-way sync (rmirro pushes deleted files back); treating a failed listing as "everything deleted"; replacing or
deleting the person's original files (several Zotero tools); re-rendering everything on every sync.

### 6. Measured on a real library (320 documents: 102 notebooks, 207 PDFs, 11 ebooks)

First sync about 40 s (a worker thread; a PDF nobody wrote on, 117 of them, is cloned, not rewritten); a sync with
nothing changed 0.07 s. A 12-page notebook parses in about 0.2 ms (points are decoded only when drawn) and renders to
SVG in about 4 ms; a 36-page, 2 MB annotated PDF is written with its ink in about 70 ms. Five documents first failed
and showed two bugs, both fixed and tested: a word longer than a line (a URL) never finished wrapping, and a heavily
inked page passed more drawing operators to pdf-lib in one call than a call can hold.

### 7. Licences

Used: rmscene (MIT; structure ported, fixtures), notable (Apache-2.0; a fixture notebook), pdf-lib (MIT; writing PDFs).
Read only: rmapi and rmfakecloud (AGPL), remarks, Scrybble and inkstone (GPL/AGPL). rmc's pen model (LGPL ancestry) was
not used.

### 8. Not done

- Handwriting as text: the tablet converts handwriting only when asked (it then becomes typed text, which is read).
  Bart sees a notebook's typed text and highlights, not its handwriting; a vision model on the rendered pages could.
- Sending to the tablet: reMarkable's only supported way is dropping a file into its app.
- Ink on ebooks over their text (it follows the tablet's own reflow of the book); images placed on a page (3.28).
- The cloud, should reMarkable ever offer an approved route: the protocol (a content-addressed hash tree, a root of
  `{hash, generation}` read from `/sync/v4/root` and written by compare-and-swap, blobs by sha256, a WebSocket that says
  when a sync completed) would make incremental sync cheap; a source for it would sit beside the desktop one.
