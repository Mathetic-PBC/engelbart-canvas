// Where a page's ink goes on screen or on a PDF page.
//
// Page units: x = 0 at the page's horizontal centre, y = 0 at its top, y downward. A notebook page is Page.width ×
// Page.height of them (1404×1872 on a reMarkable 2, 1620×2160 on a Paper Pro).
//
// On a PDF the frame is the PDF page's crop box: x = 0 at its horizontal centre, y = 0 at its top edge, at a fixed
// number of units per PDF point whatever the page's size. It is not scaled to fit the width, which is the classic
// overlay bug (it only looks right on pages about 447 pt wide). 227/72 was fitted on a Paper Pro page, highlight
// rectangles against the PDF's own text baselines, with no residual; 226/72 (the reMarkable 2's screen density) is
// what others assume and is 0.44% off, about 3 pt at the foot of an A4 page. A rotated page (/Rotate) is drawn on as it
// is shown, so the frame turns with it.

/** Page units per PDF point. */
export const UNITS_PER_POINT = 227 / 72;

/** A PDF box in PDF user space (points, y up): the page's CropBox, or its MediaBox when it has none. */
export interface PdfBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfMapping {
  /** Page units → PDF user space. */
  toPdf(x: number, y: number): [number, number];
  /** PDF user space → page units. */
  fromPdf(X: number, Y: number): [number, number];
  /** The PDF `cm` matrix that lets a content stream draw in page units on this page. */
  matrix: [number, number, number, number, number, number];
  /**
   * The SVG viewBox, in page units, that covers exactly this PDF page: an SVG with it laid over the page (its top-left
   * on the page's top-left, its size the page's) draws ink in place. Ink in the margins falls outside; use
   * overflow: visible to keep it.
   */
  viewBox: string;
}

/**
 * The mapping between page units and a PDF page with crop box `box`. `k`: page units per point. `rotate`: the page's
 * /Rotate (degrees clockwise, as it is shown): the tablet draws on the page as shown, so its frame turns with it.
 */
export function pdfMapping(box: PdfBox, k: number = UNITS_PER_POINT, rotate = 0): PdfMapping {
  const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
  const W = x1 - x0, H = y1 - y0;
  const turn = ((Math.round(rotate / 90) % 4) + 4) % 4;
  // The page as shown: width × height, and its matrix. Each case puts the shown page's top-left at (0, 0) and measures
  // from there as the PDF viewer does (pdf.js PageViewport): x right and y down on the shown page.
  const shownW = turn % 2 ? H : W, shownH = turn % 2 ? W : H;
  const m: [number, number, number, number, number, number] =
    turn === 1 ? [0, 1 / k, 1 / k, 0, x0, y0 + H / 2]
    : turn === 2 ? [-1 / k, 0, 0, 1 / k, x1 - W / 2, y0]
    : turn === 3 ? [0, -1 / k, -1 / k, 0, x1, y1 - H / 2]
    : [1 / k, 0, 0, -1 / k, x0 + W / 2, y1];
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return {
    toPdf: (x, y) => [a * x + c * y + e, b * x + d * y + f],
    fromPdf: (X, Y) => [(d * (X - e) - c * (Y - f)) / det, (a * (Y - f) - b * (X - e)) / det],
    matrix: m,
    viewBox: `${round(-(shownW * k) / 2)} 0 ${round(shownW * k)} ${round(shownH * k)}`,
  };
}

/** A notebook page's frame in page units: { x, y, width, height } with x = -width/2. */
export const notebookFrame = (page: { width: number; height: number }) => ({ x: -page.width / 2, y: 0, width: page.width, height: page.height });

const round = (n: number) => Math.round(n * 1000) / 1000;
