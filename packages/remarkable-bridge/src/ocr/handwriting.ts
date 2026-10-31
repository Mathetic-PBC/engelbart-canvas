// Handwriting as text. The tablet stores handwriting as strokes and converts it to text only when asked; this reads it
// with the Mac's own text recognition (Vision, as Live Text does): on the computer, free, about half a second a page.
// The pages are drawn ink only (no PDF under them, no highlighter) into a PDF, which a short JavaScript for
// Automation script rasterises with PDFKit and hands to Vision; what it finds comes back as lines with boxes, in the
// page's own units, so they can be laid into a PDF as invisible text (../export/pdf.ts) and written out as Markdown.
// Machine reading of handwriting makes mistakes: whatever shows it says so. On other systems nothing is read.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LineCapStyle, LineJoinStyle, PDFDocument, concatTransformationMatrix, lineTo, moveTo, popGraphicsState, pushGraphicsState, setLineCap, setLineJoin, setLineWidth, setStrokingRgbColor, stroke as strokePath, type PDFOperator } from 'pdf-lib';
import type { ReadDocument } from '../document.ts';
import { UNITS_PER_POINT } from '../geometry.ts';
import type { Tool } from '../rm/codes.ts';
import type { Page, Stroke } from '../rm/page.ts';
import { lookOf } from '../render/pens.ts';
import { strokeRuns } from '../render/runs.ts';

/** One line of handwriting as read: its text, how sure the reading is (0–1), and its box in page units. */
export interface HandwrittenLine {
  text: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each page's handwriting by page id; a page without handwriting is absent. */
export type Handwriting = Map<string, HandwrittenLine[]>;

/** What handwriting read by machine is labelled with, in the Markdown and (invisibly) in the PDF: it can be wrong. */
export const MACHINE_READ = 'Handwriting, as read by machine (it can be wrong):';

/** Readings kept between runs, by a page's digest (DocumentPage.digest): a page is read once while it is unchanged. */
export interface HandwritingCache {
  get(digest: string): HandwrittenLine[] | undefined | Promise<HandwrittenLine[] | undefined>;
  set(digest: string, lines: HandwrittenLine[]): void | Promise<void>;
}

/** What one page's reading gives: lines with boxes as fractions of the image, origin bottom-left (Vision's). */
export interface RawLine {
  text: string;
  confidence: number;
  box: [number, number, number, number];
}
/** Reads every page of a PDF (its bytes) → one list of lines per page. Stops (rejects) when `signal` fires. */
export type Recognizer = (pdf: Uint8Array, signal?: AbortSignal) => Promise<RawLine[][]>;

export interface ReadHandwritingOptions {
  cache?: HandwritingCache;
  /** 'all' (the default) reads what the cache does not have; 'cached' only takes what it has, reading nothing. */
  mode?: 'all' | 'cached';
  /** How pages are read: the Mac's Vision by default. Injected by tests. */
  recognize?: Recognizer;
  /** Stops reading: what was read before stays in the cache; the call rejects with an AbortError. */
  signal?: AbortSignal;
}

export interface ReadHandwritingResult {
  handwriting: Handwriting;
  /** Pages with handwriting on them. */
  pages: number;
  /** Of those, how many are not read (mode 'cached' and not in the cache). */
  unread: number;
  /** Whether this computer can read handwriting at all. When it cannot, `unread` is 0: there is nothing to wait for. */
  supported: boolean;
}

/** The tools people write with; highlighters, the shader and erasers are not handwriting. */
const WRITING: ReadonlySet<Tool> = new Set(['ballpoint', 'fineliner', 'marker', 'pencil', 'mechanical-pencil', 'calligraphy', 'paintbrush', 'unknown']);
const isWriting = (s: Stroke) => WRITING.has(s.tool) && !lookOf(s).hidden && s.points.count > 0;

/** Whether a page has anything written on it by hand. */
export const hasHandwriting = (page: Page | null): boolean => !!page && page.strokes.some((s) => shown(page, s));

const MARGIN = 40; // page units around the ink, so letters at the edge are whole

interface Frame { x: number; y: number; w: number; h: number }

/** Handwriting that is drawn: a writing tool's stroke on a layer that is not hidden. */
const shown = (page: Page, s: Stroke) => isWriting(s) && page.layers[s.layer]?.visible !== false;

/** The box around a page's handwriting, page units. */
function frameOf(page: Page): Frame {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of page.strokes) {
    if (!shown(page, s)) continue;
    const b = s.points.bounds();
    minX = Math.min(minX, b.minX + s.dx); maxX = Math.max(maxX, b.maxX + s.dx);
    minY = Math.min(minY, b.minY + s.dy); maxY = Math.max(maxY, b.maxY + s.dy);
  }
  return { x: minX - MARGIN, y: minY - MARGIN, w: maxX - minX + 2 * MARGIN, h: maxY - minY + 2 * MARGIN };
}

/**
 * The handwriting of `pages` as a PDF, one page each, framed on its ink and drawn in black (Vision reads dark on
 * light best; a yellow pen would read poorly). → the PDF and each page's frame, to map what is read back.
 */
export async function handwritingPdf(pages: Page[]): Promise<{ bytes: Uint8Array; frames: Frame[] }> {
  const pdf = await PDFDocument.create();
  const frames: Frame[] = [];
  const k = UNITS_PER_POINT;
  for (const page of pages) {
    const f = frameOf(page);
    frames.push(f);
    const pdfPage = pdf.addPage([f.w / k, f.h / k]);
    // Page units → this page: x from the frame's left, y down from its top.
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(1 / k, 0, 0, -1 / k, -f.x / k, (f.y + f.h) / k), setLineJoin(LineJoinStyle.Round), setLineCap(LineCapStyle.Round), setStrokingRgbColor(0, 0, 0)];
    for (const s of page.strokes) {
      if (!shown(page, s)) continue;
      const p = s.points.decode();
      for (const run of strokeRuns(s, p, lookOf(s))) {
        ops.push(setLineWidth(Math.max(1.5, run.width)), moveTo(p.x[run.from]! + s.dx, p.y[run.from]! + s.dy));
        if (run.to === run.from) ops.push(lineTo(p.x[run.from]! + s.dx + 0.01, p.y[run.from]! + s.dy));
        for (let i = run.from + 1; i <= run.to; i++) ops.push(lineTo(p.x[i]! + s.dx, p.y[i]! + s.dy));
        ops.push(strokePath());
      }
    }
    ops.push(popGraphicsState());
    for (let i = 0; i < ops.length; i += 10_000) pdfPage.pushOperators(...ops.slice(i, i + 10_000));
  }
  return { bytes: await pdf.save(), frames };
}

/** Pages read in one go: a pass is seconds, so a long notebook is read (and kept) a batch at a time, and can stop between. */
const BATCH = 16;

/**
 * Reads the handwriting of a document's pages: from `cache` where a page was read before, else (mode 'all') with the
 * Mac's text recognition, BATCH pages at a time, each batch kept as it is read. Lines come back top to bottom.
 */
export async function readHandwriting(doc: ReadDocument, options: ReadHandwritingOptions = {}): Promise<ReadHandwritingResult> {
  const recognize = options.recognize ?? (process.platform === 'darwin' ? recognizeOnMac : null);
  const handwriting: Handwriting = new Map();
  const written = doc.pages.filter(({ page }) => hasHandwriting(page));
  const toRead: typeof written = [];
  for (const entry of written) {
    const kept = options.cache && entry.digest ? await options.cache.get(entry.digest) : undefined;
    if (kept) handwriting.set(entry.ref.id, kept);
    else toRead.push(entry);
  }
  if (!recognize) return { handwriting, pages: written.length, unread: 0, supported: false };
  if (options.mode === 'cached' || toRead.length === 0) return { handwriting, pages: written.length, unread: toRead.length, supported: true };

  for (let start = 0; start < toRead.length; start += BATCH) {
    options.signal?.throwIfAborted();
    const batch = toRead.slice(start, start + BATCH);
    const { bytes, frames } = await handwritingPdf(batch.map(({ page }) => page!));
    const read = await recognize(bytes, options.signal);
    for (let i = 0; i < batch.length; i++) {
      const lines = linesOf(read[i] ?? [], frames[i]!);
      const entry = batch[i]!;
      handwriting.set(entry.ref.id, lines);
      if (options.cache && entry.digest) await options.cache.set(entry.digest, lines);
    }
  }
  return { handwriting, pages: written.length, unread: 0, supported: true };
}

/** Lines as read (boxes as fractions of the image, origin bottom-left) → in page units, top to bottom. */
function linesOf(read: RawLine[], f: Frame): HandwrittenLine[] {
  return read
    .filter((l) => typeof l.text === 'string' && l.text.trim())
    .map((l) => ({
      text: l.text.trim(),
      confidence: l.confidence,
      x: f.x + l.box[0] * f.w,
      y: f.y + (1 - l.box[1] - l.box[3]) * f.h,
      w: l.box[2] * f.w,
      h: l.box[3] * f.h,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/* --------------------------------------------------------------------------------------------- the Mac's Vision */

// JavaScript for Automation: rasterise each page of the PDF at 2× (144 dpi: fast, and reads as well as larger), read it
// with Vision (accurate, language correction, languages detected), print the lines as JSON.
// (JXA cannot hold an NSAutoreleasePool; a run's memory is bounded by BATCH pages, each run its own process.)
const SCRIPT = `ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('PDFKit'); ObjC.import('Vision');
function run(argv) {
  const pdf = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  const scale = Number(argv[1]) || 2;
  const out = [];
  for (let i = 0; i < pdf.pageCount; i++) {
    const page = pdf.pageAtIndex(i);
    const box = page.boundsForBox($.kPDFDisplayBoxMediaBox);
    const image = page.thumbnailOfSizeForBox($.NSMakeSize(box.size.width * scale, box.size.height * scale), $.kPDFDisplayBoxMediaBox);
    const cg = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation).CGImage;
    const request = $.VNRecognizeTextRequest.alloc.init;
    request.recognitionLevel = 0;
    request.usesLanguageCorrection = true;
    request.automaticallyDetectsLanguage = true;
    $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $.NSDictionary.dictionary).performRequestsError($([request]), null);
    const lines = [];
    const results = request.results;
    for (let k = 0; k < results.count; k++) {
      const o = results.objectAtIndex(k);
      const best = o.topCandidates(1).firstObject;
      const b = o.boundingBox;
      lines.push({ text: ObjC.unwrap(best.string), confidence: best.confidence, box: [b.origin.x, b.origin.y, b.size.width, b.size.height] });
    }
    out.push(lines);
  }
  return JSON.stringify(out);
}`;

const PREFIX = 'remarkable-read-';
/** Folders an earlier run left (a process ended while reading): gone after an hour. */
function sweep(): void {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith(PREFIX)) continue;
      const dir = path.join(os.tmpdir(), name);
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 3_600_000) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use, or gone */ }
    }
  } catch { /* no temporary folder to look in */ }
}

/**
 * The Mac's text recognition over every page of `pdf`. The script and the pages go in a folder of this run's own
 * (private to this user, made fresh: nothing left in a shared place is ever run), removed after; `signal` stops the
 * reading process.
 */
export async function recognizeOnMac(pdf: Uint8Array, signal?: AbortSignal): Promise<RawLine[][]> {
  sweep();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const file = path.join(dir, 'pages.pdf');
  const script = path.join(dir, 'read.js');
  try {
    fs.writeFileSync(file, pdf);
    fs.writeFileSync(script, SCRIPT);
    const out = await new Promise<string>((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', script, file, '2'], { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000, ...(signal ? { signal } : {}) }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as RawLine[][]) : [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
