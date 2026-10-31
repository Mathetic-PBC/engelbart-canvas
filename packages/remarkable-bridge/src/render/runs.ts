// A stroke as runs of points drawn with one width and one opacity: a new run where the tablet's recorded width changes
// by more than a sixth (or, for pencil and brush, the pressure's opacity by more than 0.1). Each run starts at the
// previous run's last point so the stroke stays joined. Shared by the SVG and PDF output so both draw the same thing.

import type { DecodedPoints } from '../rm/points.ts';
import type { Stroke } from '../rm/page.ts';
import { pointWidth, pressureOpacity, type PenLook } from './pens.ts';

export interface Run {
  /** First and last point index, inclusive. */
  from: number;
  to: number;
  /** Page units. */
  width: number;
  /** 0–1, before the pen's own opacity. */
  opacity: number;
}

const WIDTH_STEP = 1 / 6;
const OPACITY_STEP = 0.1;

export function strokeRuns(stroke: Stroke, p: DecodedPoints, look: PenLook): Run[] {
  if (p.count === 0) return [];
  if (p.count === 1) return [{ from: 0, to: 0, width: pointWidth(p.width[0]!, stroke), opacity: look.pressureOpacity ? pressureOpacity(p.pressure[0]!) : 1 }];
  const runs: Run[] = [];
  let start = 0;
  while (start < p.count - 1) {
    const w0 = pointWidth(p.width[start]!, stroke);
    const o0 = look.pressureOpacity ? pressureOpacity(p.pressure[start]!) : 1;
    let end = start + 1;
    let sum = w0;
    while (end < p.count - 1) {
      const w = pointWidth(p.width[end]!, stroke);
      if (Math.abs(w - w0) > w0 * WIDTH_STEP) break;
      if (look.pressureOpacity && Math.abs(pressureOpacity(p.pressure[end]!) - o0) > OPACITY_STEP) break;
      sum += w;
      end++;
    }
    runs.push({ from: start, to: end, width: sum / (end - start), opacity: o0 });
    start = end;
  }
  return runs;
}
