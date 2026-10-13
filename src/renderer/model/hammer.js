// Lucide's hammer (2026-10-12): the footer's Build (DocEditor's ICON.hammer) and the [[build]] token an answer ends with
// (model/doc.js inlineHtml) draw the same paths.
export const HAMMER_PATHS = '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"></path><path d="m18 15 4-4"></path><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"></path>';
/** The hammer as an svg, `size` px square, in the colour of the text around it. */
export const hammerSvg = (size = 16, width = 1.5) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HAMMER_PATHS}</svg>`;
