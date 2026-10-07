// Where a text field's caret is on screen, for the @ menu to hang there: a follow-up field's (2026-10-02), and a PDF
// margin note's (MATH-21, moved here from DocEditor.jsx). A textarea has no range to measure, so a hidden copy laid over
// it is: the same width, padding and type, holding the text up to the caret and then a mark with the rest (so a word
// wraps as it does in the field). The field's bottom-left corner when that cannot be measured. `scale`: how many screen px
// one of the field's own px is, for a field in a scaled layer (a PDF note's box at another zoom, MATH-27): the copy is laid
// out at the field's own size, and where its caret falls is scaled from the field's corner.
const MIRRORED = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak'];
export function fieldCaret(input, pos = input.selectionStart, scale = 1) {
  const box = input.getBoundingClientRect(), corner = { left: box.left, right: box.left, top: box.top, bottom: box.bottom };
  let copy = null;
  try {
    const css = getComputedStyle(input);
    copy = document.createElement('div');
    for (const key of MIRRORED) copy.style[key] = css[key];
    Object.assign(copy.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top - input.scrollTop}px`, margin: '0', overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none' });
    copy.textContent = input.value.slice(0, pos);
    const mark = document.createElement('span'); mark.textContent = input.value.slice(pos) || '\u200b';
    copy.appendChild(mark); document.body.appendChild(copy);
    const r = mark.getClientRects()[0];
    if (!r) return corner;
    const x = box.left + (r.left - box.left) * scale;
    return { left: x, right: x, top: box.top + (r.top - box.top) * scale, bottom: box.top + (r.bottom - box.top) * scale };
  } catch { return corner; } finally { if (copy) copy.remove(); }
}
