// How each tool's strokes look. The tablet stores the width it drew every point at (Points.width, in quarters of a page
// unit), already worked out from pressure, speed and tilt for that tool, so the shape of a stroke comes from the file and
// not from a model of the pen. What the file does not say is how ink looks on screen: whether it is translucent, how a
// highlighter mixes with the text under it, and the grain of a pencil. That is decided here.

import type { Tool } from '../rm/codes.ts';
import type { Stroke } from '../rm/page.ts';

export interface PenLook {
  /** 0–1, for the whole stroke, or per point when `pressureOpacity`. */
  opacity: number;
  /** Pencil and paintbrush lay down less ink when pressed lightly. */
  pressureOpacity: boolean;
  /** Highlighters and the shader darken what is under them instead of covering it. */
  multiply: boolean;
  cap: 'round' | 'butt' | 'square';
  /** Not drawn at all (the area eraser's strokes are selections, not ink). */
  hidden: boolean;
  /** Drawn in the paper's colour (an eraser stroke on older pages). */
  erase: boolean;
}

const LOOKS: Record<Tool, Partial<PenLook>> = {
  ballpoint: {},
  fineliner: {},
  marker: {},
  calligraphy: {},
  'mechanical-pencil': { opacity: 0.8 },
  pencil: { pressureOpacity: true },
  paintbrush: { pressureOpacity: true },
  highlighter: { multiply: true, cap: 'butt', opacity: 0.9 },
  shader: { multiply: true, cap: 'butt' },
  eraser: { erase: true },
  'erase-area': { hidden: true },
  unknown: {},
};

export function lookOf(stroke: Stroke): PenLook {
  return { opacity: 1, pressureOpacity: false, multiply: false, cap: 'round', hidden: false, erase: false, ...LOOKS[stroke.tool] };
}

/** Opacity of a pencil or brush point at `pressure` (0–255): light touches stay visible, never fully transparent. */
export const pressureOpacity = (pressure: number): number => 0.35 + 0.65 * Math.min(1, Math.max(0, pressure / 255));

/** A point's width in page units. Older pages (no per-point width) fall back to the stroke's scale. */
export const pointWidth = (width: number, stroke: Stroke): number => (width > 0 ? width / 4 : Math.max(1, stroke.thicknessScale * 2));
