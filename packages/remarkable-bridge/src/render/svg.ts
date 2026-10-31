// A page as SVG, in page units. A stroke is drawn as runs of points of about the same width (./runs.ts), each a path
// with that width. Small, and faithful to what the tablet drew.

import type { Rgba } from '../rm/codes.ts';
import { layoutText } from '../rm/layout.ts';
import type { Page, Stroke } from '../rm/page.ts';
import { lookOf, pointWidth } from './pens.ts';
import { strokeRuns } from './runs.ts';

export interface SvgOptions {
  /**
   * The area drawn, in page units. 'page' (the default): the page itself; ink outside it is still in the SVG and shows
   * with overflow: visible. 'content': the page and all its ink. Or an explicit viewBox, e.g. a PDF page's from
   * ../geometry.ts pdfMapping, to lay the SVG over that page.
   */
  frame?: 'page' | 'content' | { viewBox: string };
  /** The SVG's width and height attributes. Default: the frame in PDF points (page units × 72/227). */
  width?: number | string;
  height?: number | string;
  /** Fill under everything, e.g. '#fff'. Default none: transparent, for laying over a PDF page or a template. */
  background?: string | null;
  /** The paper's colour, for eraser strokes on older pages. Default white. */
  paper?: string;
  /** Draw highlights made on a PDF's or EPUB's text. Default true. */
  highlights?: boolean;
  /** Draw the page's typed text, laid out approximately (../rm/layout.ts). Default true. */
  text?: boolean;
  /** Draw layers hidden on the tablet. Default false. */
  hiddenLayers?: boolean;
  /** Decimal places kept in coordinates. Default 1 (a tenth of a page unit, ~0.03 pt). */
  precision?: number;
}

const POINTS_PER_UNIT = 72 / 227;

export function pageToSvg(page: Page, options: SvgOptions = {}): string {
  const precision = options.precision ?? 1;
  const f = (n: number) => fmt(n, precision);
  const showHidden = options.hiddenLayers ?? false;
  const visible = (layer: number) => showHidden || page.layers[layer]?.visible !== false;

  const viewBox = typeof options.frame === 'object' ? options.frame.viewBox : frameOf(page, options.frame === 'content');
  const [, , vw = page.width, vh = page.height] = viewBox.split(/\s+/).map(Number);
  const width = options.width ?? fmt(vw * POINTS_PER_UNIT, 2);
  const height = options.height ?? fmt(vh * POINTS_PER_UNIT, 2);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" overflow="visible">`);
  if (options.background) {
    const [x, y] = viewBox.split(/\s+/).map(Number);
    out.push(`<rect x="${x}" y="${y}" width="${vw}" height="${vh}" fill="${attr(options.background)}"/>`);
  }
  if (options.highlights ?? true) {
    for (const h of page.highlights) {
      if (!visible(h.layer)) continue;
      const rects = h.rects.map((r) => `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}"/>`).join('');
      out.push(`<g fill="${css(h.color)}" fill-opacity="${opacity(h.color)}" style="mix-blend-mode:multiply">${rects}</g>`);
    }
  }
  if ((options.text ?? true) && page.text) out.push(textSvg(page, f));
  const paper = options.paper ?? '#fff';
  for (const stroke of page.strokes) if (visible(stroke.layer)) out.push(strokeSvg(stroke, f, paper));
  out.push('</svg>');
  return out.join('\n');
}

function strokeSvg(stroke: Stroke, f: (n: number) => string, paper: string): string {
  const look = lookOf(stroke);
  if (look.hidden || stroke.points.count === 0) return '';
  const p = stroke.points.decode();
  const { dx, dy } = stroke;
  const color = look.erase ? paper : css(stroke.color);
  const alpha = look.opacity * (look.erase ? 1 : stroke.color.a);
  const blend = look.multiply ? ' style="mix-blend-mode:multiply"' : '';
  const head = `<g fill="none" stroke="${color}" stroke-linecap="${look.cap}" stroke-linejoin="round"${alpha < 1 ? ` stroke-opacity="${fmt(alpha, 3)}"` : ''}${blend}>`;
  if (p.count === 1) {
    return `${head}<path d="M${f(p.x[0]! + dx)} ${f(p.y[0]! + dy)}h0.01" stroke-width="${f(pointWidth(p.width[0]!, stroke))}" stroke-linecap="round"/></g>`;
  }
  const paths = strokeRuns(stroke, p, look).map((run) => {
    let d = `M${f(p.x[run.from]! + dx)} ${f(p.y[run.from]! + dy)}`;
    for (let i = run.from + 1; i <= run.to; i++) d += `L${f(p.x[i]! + dx)} ${f(p.y[i]! + dy)}`;
    return `<path d="${d}" stroke-width="${f(run.width)}"${run.opacity < 1 ? ` stroke-opacity="${fmt(run.opacity, 2)}"` : ''}/>`;
  });
  return `${head}${paths.join('')}</g>`;
}

function textSvg(page: Page, f: (n: number) => string): string {
  const text = page.text!;
  const out: string[] = ['<g fill="#000" font-family="Noto Sans, Helvetica, Arial, sans-serif">'];
  for (const line of layoutText(text).lines) {
    const marker = line.marker ? `<tspan x="${f(line.x - 36)}">${esc(line.marker)}</tspan><tspan x="${f(line.x)}">` : '';
    const spans = line.spans.map((s) => {
      const styles = [s.bold && !line.bold ? 'font-weight="bold"' : '', s.italic ? 'font-style="italic"' : ''].filter(Boolean).join(' ');
      return styles ? `<tspan ${styles}>${esc(s.text)}</tspan>` : esc(s.text);
    }).join('');
    out.push(`<text x="${f(line.x)}" y="${f(line.baseline)}" font-size="${line.fontSize}"${line.bold ? ' font-weight="bold"' : ''} xml:space="preserve">${marker}${spans}${marker ? '</tspan>' : ''}</text>`);
  }
  out.push('</g>');
  return out.join('');
}

/** The viewBox of the page, or of the page and all its ink. */
function frameOf(page: Page, content: boolean): string {
  let minX = -page.width / 2, minY = 0, maxX = page.width / 2, maxY = page.height;
  if (content) {
    for (const s of page.strokes) {
      const b = s.points.bounds();
      minX = Math.min(minX, b.minX + s.dx); maxX = Math.max(maxX, b.maxX + s.dx);
      minY = Math.min(minY, b.minY + s.dy); maxY = Math.max(maxY, b.maxY + s.dy);
    }
    for (const h of page.highlights) for (const r of h.rects) {
      minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.w);
      minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + r.h);
    }
  }
  return [minX, minY, maxX - minX, maxY - minY].map((n) => fmt(n, 1)).join(' ');
}

const fmt = (n: number, places: number) => {
  const s = n.toFixed(places);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
};
const css = (c: Rgba) => `rgb(${c.r},${c.g},${c.b})`;
const opacity = (c: Rgba) => fmt(c.a, 3);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
