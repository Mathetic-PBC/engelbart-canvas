// A document as one PDF, with the ink drawn in as vectors.
//
// A PDF or EPUB-from-PDF document: its own pages, in the tablet's order (pages moved, inserted or deleted on the tablet
// moved, inserted or left out here), each with its ink and highlights over it at the tablet's fixed scale
// (../geometry.ts). When the pages are the PDF's own in their own order, which is nearly always, the PDF is written on
// in place, so its links, outline and text stay as they were.
//
// A notebook: one PDF page per tablet page, the page's own size at 227 units to the point (445×594 pt for a reMarkable
// 2, 514×685 for a Paper Pro), longer when the ink runs further down. Typed text is set in Helvetica, so it is real,
// searchable text; characters Helvetica lacks are left out of the PDF (the text extraction keeps them).

import {
  closePath, concatTransformationMatrix, fill, LineCapStyle, LineJoinStyle, lineTo, moveTo, PDFDocument, PDFName,
  popGraphicsState, pushGraphicsState, setFillingRgbColor, setGraphicsState, setLineCap, setLineJoin, setLineWidth,
  setStrokingRgbColor, StandardFonts, stroke as strokePath, type PDFFont, type PDFOperator, type PDFPage,
} from 'pdf-lib';
import type { ReadDocument } from '../document.ts';
import { pdfMapping, UNITS_PER_POINT, type PdfMapping } from '../geometry.ts';
import type { Rgba } from '../rm/codes.ts';
import { layoutText } from '../rm/layout.ts';
import { RM2_PAGE, type Page } from '../rm/page.ts';
import { lookOf } from '../render/pens.ts';
import { strokeRuns } from '../render/runs.ts';

export interface PdfOptions {
  /** The document's PDF (bundle.source()). Without it, a PDF document's ink is drawn on blank pages. */
  source?: Uint8Array | null;
  /** The paper's colour, for eraser strokes on older pages. Default white. */
  paper?: Rgba;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

export async function documentToPdf(doc: ReadDocument, options: PdfOptions = {}): Promise<Uint8Array> {
  const source = doc.bundle.content.fileType === 'pdf' && options.source ? await loadOrNull(options.source) : null;
  const paper = options.paper ?? WHITE;
  if (source) {
    const count = source.getPageCount();
    const own = doc.pages.length === count && doc.pages.every(({ ref }, i) => ref.sourcePage === i);
    if (own) {
      const pages = source.getPages();
      const font = await fontFor(source, doc.pages);
      doc.pages.forEach(({ page }, i) => { if (page) drawOnPdfPage(source, pages[i]!, page, font, paper); });
      return source.save();
    }
    const out = await PDFDocument.create();
    const onPdf = (n: number | null): n is number => n !== null && Number.isInteger(n) && n >= 0 && n < count;
    const wanted = doc.pages.map(({ ref }) => ref.sourcePage).filter(onPdf);
    const copied = await out.copyPages(source, wanted);
    const font = await fontFor(out, doc.pages);
    let next = 0;
    let lastSize: [number, number] = [RM2_PAGE.width / UNITS_PER_POINT, RM2_PAGE.height / UNITS_PER_POINT];
    for (const { ref, page } of doc.pages) {
      let pdfPage: PDFPage;
      if (onPdf(ref.sourcePage)) {
        pdfPage = out.addPage(copied[next++]!);
        const box = pdfPage.getCropBox();
        lastSize = [box.width, box.height];
      } else {
        pdfPage = out.addPage(lastSize); // inserted on the tablet: a blank page like the one before it
      }
      if (page) drawOnPdfPage(out, pdfPage, page, font, paper);
    }
    return out.save();
  }

  const out = await PDFDocument.create();
  out.setTitle(doc.bundle.metadata.name);
  const font = await fontFor(out, doc.pages);
  for (const { page } of doc.pages) {
    if (!page) {
      out.addPage([RM2_PAGE.width / UNITS_PER_POINT, RM2_PAGE.height / UNITS_PER_POINT]);
      continue;
    }
    const height = Math.max(page.height, contentBottom(page) + 40);
    const W = page.width / UNITS_PER_POINT, H = height / UNITS_PER_POINT;
    const pdfPage = out.addPage([W, H]);
    draw(out, pdfPage, page, pdfMapping({ x0: 0, y0: 0, x1: W, y1: H }), font, paper);
  }
  return out.save();
}

/** The PDF, or null when pdf-lib cannot open it (encrypted, damaged): its ink then goes on blank pages. */
async function loadOrNull(bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    pdf.getPages(); // pdf-lib opens some broken files and fails only once their pages are asked for
    return pdf;
  } catch {
    return null;
  }
}

/** Helvetica, embedded only when some page has typed text to set. */
async function fontFor(pdf: PDFDocument, pages: ReadDocument['pages']): Promise<PDFFont | null> {
  return pages.some(({ page }) => page?.text?.paragraphs.some((p) => p.text)) ? pdf.embedFont(StandardFonts.Helvetica) : null;
}

function drawOnPdfPage(pdf: PDFDocument, pdfPage: PDFPage, page: Page, font: PDFFont | null, paper: Rgba): void {
  const box = pdfPage.getCropBox();
  const rotate = pdfPage.getRotation().angle;
  // Typed text on a turned page would need turning too; ink and highlights are what such pages carry.
  draw(pdf, pdfPage, page, pdfMapping({ x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height }, undefined, rotate), rotate % 360 === 0 ? font : null, paper);
}

/** The page's highlights, ink and typed text onto `pdfPage`, through `map`. */
function draw(pdf: PDFDocument, pdfPage: PDFPage, page: Page, map: PdfMapping, font: PDFFont | null, paper: Rgba): void {
  const states = new Map<string, PDFName>();
  const state = (alpha: number, multiply: boolean): PDFName | null => {
    if (alpha >= 1 && !multiply) return null;
    const key = `${alpha.toFixed(3)}:${multiply}`;
    let name = states.get(key);
    if (!name) {
      const dict = pdf.context.obj({ Type: 'ExtGState', CA: alpha, ca: alpha, ...(multiply ? { BM: 'Multiply' } : {}) });
      name = pdfPage.node.newExtGState('RMGS', dict);
      states.set(key, name);
    }
    return name;
  };
  const visible = (layer: number) => page.layers[layer]?.visible !== false;
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...map.matrix), setLineJoin(LineJoinStyle.Round)];

  for (const h of page.highlights) {
    if (!visible(h.layer) || h.rects.length === 0) continue;
    ops.push(pushGraphicsState());
    const gs = state(h.color.a, true);
    if (gs) ops.push(setGraphicsState(gs));
    ops.push(setFillingRgbColor(h.color.r / 255, h.color.g / 255, h.color.b / 255));
    for (const r of h.rects) ops.push(moveTo(r.x, r.y), lineTo(r.x + r.w, r.y), lineTo(r.x + r.w, r.y + r.h), lineTo(r.x, r.y + r.h), closePath());
    ops.push(fill(), popGraphicsState());
  }

  for (const s of page.strokes) {
    if (!visible(s.layer)) continue;
    const look = lookOf(s);
    if (look.hidden || s.points.count === 0) continue;
    const p = s.points.decode();
    const color = look.erase ? paper : s.color;
    ops.push(pushGraphicsState(), setStrokingRgbColor(color.r / 255, color.g / 255, color.b / 255));
    ops.push(setLineCap(look.cap === 'butt' ? LineCapStyle.Butt : look.cap === 'square' ? LineCapStyle.Projecting : LineCapStyle.Round));
    let current = '';
    for (const run of strokeRuns(s, p, look)) {
      const alpha = look.opacity * (look.erase ? 1 : color.a) * run.opacity;
      const key = `${alpha}`;
      if (key !== current) {
        const gs = state(alpha, look.multiply);
        if (gs) ops.push(setGraphicsState(gs));
        current = key;
      }
      ops.push(setLineWidth(run.width), moveTo(p.x[run.from]! + s.dx, p.y[run.from]! + s.dy));
      // A dot (one point) is a zero-length line, which a round cap draws as a dot.
      if (run.to === run.from) ops.push(lineTo(p.x[run.from]! + s.dx + 0.01, p.y[run.from]! + s.dy));
      for (let i = run.from + 1; i <= run.to; i++) ops.push(lineTo(p.x[i]! + s.dx, p.y[i]! + s.dy));
      ops.push(strokePath());
    }
    ops.push(popGraphicsState());
  }
  ops.push(popGraphicsState());
  // A heavily inked page is hundreds of thousands of operators: more than one call's arguments can hold.
  for (let i = 0; i < ops.length; i += 10_000) pdfPage.pushOperators(...ops.slice(i, i + 10_000));

  if (font && page.text) {
    const k = UNITS_PER_POINT;
    for (const line of layoutText(page.text).lines) {
      const text = `${line.marker ? `${line.marker} ` : ''}${line.spans.map((s) => s.text).join('')}`;
      const safe = encodable(font, text);
      if (!safe.trim()) continue;
      const [X, Y] = map.toPdf(line.x - (line.marker ? 36 : 0), line.baseline);
      pdfPage.drawText(safe, { x: X, y: Y, size: line.fontSize / k, font });
    }
  }
}

/** The lowest point any ink or highlight reaches, page units. */
function contentBottom(page: Page): number {
  let bottom = 0;
  for (const s of page.strokes) bottom = Math.max(bottom, s.points.bounds().maxY + s.dy);
  for (const h of page.highlights) for (const r of h.rects) bottom = Math.max(bottom, r.y + r.h);
  return bottom;
}

/** `text` less the characters `font` cannot set (Helvetica covers Western European text). */
function encodable(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      // not in the font's encoding
    }
  }
  return out;
}
