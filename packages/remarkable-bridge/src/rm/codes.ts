// The codes a v6 page stores for tools, colours and paragraph styles. Plain objects, not enums: newer firmware adds
// codes, and a code this table does not know must pass through as a number, never fail a page.

/** Line field 1. The `…2` codes are what firmware 2.x and later write; the others are older pages'. */
export const Pen = Object.freeze({
  PAINTBRUSH_1: 0,
  PENCIL_1: 1,
  BALLPOINT_1: 2,
  MARKER_1: 3,
  FINELINER_1: 4,
  HIGHLIGHTER_1: 5,
  ERASER: 6,
  MECHANICAL_PENCIL_1: 7,
  ERASER_AREA: 8,
  PAINTBRUSH_2: 12,
  MECHANICAL_PENCIL_2: 13,
  PENCIL_2: 14,
  BALLPOINT_2: 15,
  MARKER_2: 16,
  FINELINER_2: 17,
  HIGHLIGHTER_2: 18,
  CALLIGRAPHY: 21,
  SHADER: 23,
});

/** The tool a pen code means, the same for both generations of codes. */
export type Tool = 'paintbrush' | 'pencil' | 'ballpoint' | 'marker' | 'fineliner' | 'highlighter' | 'mechanical-pencil' | 'calligraphy' | 'shader' | 'eraser' | 'erase-area' | 'unknown';

const TOOLS: Record<number, Tool> = {
  0: 'paintbrush', 12: 'paintbrush',
  1: 'pencil', 14: 'pencil',
  2: 'ballpoint', 15: 'ballpoint',
  3: 'marker', 16: 'marker',
  4: 'fineliner', 17: 'fineliner',
  5: 'highlighter', 18: 'highlighter',
  7: 'mechanical-pencil', 13: 'mechanical-pencil',
  6: 'eraser',
  8: 'erase-area',
  21: 'calligraphy',
  23: 'shader',
};
export const toolOf = (code: number): Tool => TOOLS[code] ?? 'unknown';

/** Line field 2 and a highlight's field 4. HIGHLIGHT means the real colour is the stroke's own ARGB value. */
export const PenColor = Object.freeze({
  BLACK: 0,
  GRAY: 1,
  WHITE: 2,
  YELLOW: 3,
  GREEN: 4,
  PINK: 5,
  BLUE: 6,
  RED: 7,
  GRAY_OVERLAP: 8,
  HIGHLIGHT: 9,
  GREEN_2: 10,
  CYAN: 11,
  MAGENTA: 12,
  YELLOW_2: 13,
});

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

/**
 * Screen colours for the colour codes. The tablet's e-ink colours are not published and look different from any RGB;
 * these are picked to read well on a white page. Highlighter yellow and the Paper Pro palette match the ARGB values
 * the tablet itself writes for its highlighter.
 */
const PALETTE: Record<number, Rgba> = {
  0: { r: 0, g: 0, b: 0, a: 1 },
  1: { r: 128, g: 128, b: 128, a: 1 },
  2: { r: 255, g: 255, b: 255, a: 1 },
  3: { r: 255, g: 237, b: 117, a: 1 },
  4: { r: 68, g: 170, b: 68, a: 1 },
  5: { r: 236, g: 120, b: 168, a: 1 },
  6: { r: 46, g: 94, b: 204, a: 1 },
  7: { r: 204, g: 48, b: 48, a: 1 },
  8: { r: 128, g: 128, b: 128, a: 1 },
  9: { r: 255, g: 237, b: 117, a: 1 },
  10: { r: 120, g: 190, b: 90, a: 1 },
  11: { r: 80, g: 180, b: 220, a: 1 },
  12: { r: 180, g: 90, b: 200, a: 1 },
  13: { r: 240, g: 210, b: 40, a: 1 },
};

/** A packed 0xAARRGGBB value (the tablet's ARGB fields and the `…ColorCode` strings in .content) as Rgba. */
export const argbToRgba = (argb: number): Rgba => ({ r: (argb >>> 16) & 255, g: (argb >>> 8) & 255, b: argb & 255, a: ((argb >>> 24) & 255) / 255 });

/** The colour to draw: the stroke's own ARGB when it has one, else the code's, else black. */
export const colorOf = (code: number, argb: number | null): Rgba => (argb !== null ? argbToRgba(argb) : PALETTE[code] ?? { r: 0, g: 0, b: 0, a: 1 });

/** A paragraph's style codes (the typed text). */
export const ParagraphStyle = Object.freeze({
  BASIC: 0,
  PLAIN: 1,
  HEADING: 2,
  BOLD: 3,
  BULLET: 4,
  BULLET2: 5,
  CHECKBOX: 6,
  CHECKBOX_CHECKED: 7,
  NUMBERED: 10,
  NUMBERED_NESTED: 11,
});
