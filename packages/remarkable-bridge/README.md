# remarkable-bridge

Read reMarkable tablet documents without the reMarkable cloud: notebooks and annotated PDFs and ebooks, their typed text
and highlights, and their ink, as SVG or drawn into a PDF. Nothing Electron-specific; one dependency (pdf-lib, for
writing PDFs). Used by Engelbart (`src/main/remarkable/`), and meant for other projects too.

It reads from **the official reMarkable app's library** on this computer (macOS, Windows, Linux), which the app keeps as a
plain copy of the tablet's files while it syncs: no sign-in, no network, and nothing written there. It can read any other
folder in the tablet's layout too (a copy taken over SSH, an unpacked `.rmdoc`). It does not talk to the reMarkable cloud:
reMarkable's account terms forbid unapproved software accessing it.

## In a terminal

```sh
remarkable                 # what it found
remarkable list            # every notebook and PDF, by folder
remarkable read meeting    # a notebook's typed text and highlights (any part of its name)
remarkable save meeting    # a PDF of it, ink and all, and its text, into Downloads
remarkable watch           # notebooks as they change
```

The reMarkable app has to be installed and signed in. On a Mac, the terminal app needs permission to read another app's
data the first time (macOS asks). To get the command from this repository: `bun run build`, then put
`dist/cli.js` on your PATH as `remarkable` (`ln -s "$PWD/dist/cli.js" ~/.local/bin/remarkable`).

## In code

```ts
import { createDesktopSource, readDocument, documentMarkdown, documentToPdf, pageToSvg } from 'remarkable-bridge';

const source = createDesktopSource();            // or createFolderSource(dir)
const entries = await source.list();             // every document and folder: id, name, parent, kind, version
const bundle = await source.open(entries[0].id);
const doc = await readDocument(bundle);          // every page parsed

documentMarkdown(doc);                           // typed text and highlights as Markdown
await documentToPdf(doc, { source: await bundle.source() });  // a PDF with the ink drawn in
pageToSvg(doc.pages[0].page!, { background: '#fff' });        // one page as SVG
```

`Entry.version` changes whenever a document's files change, so a sync keeps the versions it saw and opens only what moved.
`source.watch(ids => …)` reports changes as they happen.

### Ink on a PDF

A page's ink is in page units: x = 0 at the page's horizontal centre, y = 0 at its top. On a PDF, that frame sits on the
PDF page's crop box at a fixed 227 units per 72 points, whatever the page's size (not scaled to the width). Checked on a
Paper Pro document: highlights land on their lines of text.

```ts
const map = pdfMapping({ x0, y0, x1, y1 });      // the PDF page's CropBox (or MediaBox), in points
map.toPdf(x, y);                                 // a point of ink in PDF user space
pageToSvg(page, { frame: { viewBox: map.viewBox } });  // an SVG to lay exactly over that PDF page
```

`bundle.content.pages[i].sourcePage` is the PDF page under each tablet page (`null` for a page inserted on the tablet).

## What is and is not read

- `.rm` v6 (firmware 3.x, reMarkable 2 and Paper Pro, through 3.28) and v3/v5 (1.x and 2.x).
- Strokes with the width the tablet drew each point at; highlighter and shader colours; layers and their visibility.
- Typed text (headings, lists, checkboxes, bold, italic) and highlights made on PDF and ebook text, with the text itself.
- Approximate: where typed text wraps (the tablet's fonts are not in the file), and so where strokes written beside
  typed text sit. Within a line or so.
- Handwriting as text, on a Mac: `readHandwriting(doc)` reads it with the Mac's own text recognition (Vision), about
  half a second a page, kept by page in a cache you pass; `documentToPdf(doc, { handwriting })` lays it into the PDF as
  invisible text and `documentMarkdown(doc, { handwriting })` writes it out, marked as read by machine. Elsewhere nothing
  is read (`supported: false`).
- Not read: images placed on a page (firmware 3.28), ink on ebooks over their text (it follows the tablet's own reflow).

## Speed

Points are decoded only when drawn, so reading a page's text and highlights costs almost nothing: a 12-page notebook
parses in about 0.2 ms, and renders to SVG in about 4 ms. Listing a 1,000-document library takes about 80 ms. A 36-page,
2 MB annotated PDF is written with its ink in about 70 ms.

## Develop

```sh
bun test          # straight from the TypeScript sources (the tests also run under node --test, Node 22.18 or later)
bun run check     # tsc over src and test
bun run build     # dist/
```

Format knowledge comes from rmscene (MIT); see THIRD_PARTY_NOTICES.md.
