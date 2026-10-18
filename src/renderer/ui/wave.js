// Text at work (2026-10-16, David: no blinking blue dot beside it): the wave of ../wave.css's .eb-wave, on a span as wide as
// the words, so the band crosses them rather than the empty end of a wide row; a line too long ends in its ellipsis, which
// waves with it. The document's rows (../workspace/DocEditor.jsx) and a web box's card (../box-card/BoxCard.jsx) both use
// it, so the two cannot drift apart.
export const WAVE_SPAN = 'display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top';
/** The words `html` (escaped already) waving. */
export const waveText = (html) => `<span class="eb-wave" style="${WAVE_SPAN}">${html}</span>`;
// Rows at work are drawn again as they change (a Create run's clock each second, an answer as it streams), which would
// start each wave over before it crosses its words: every wave is put on the page's clock instead, so a row drawn again
// goes on where the last one was. Its HTML is left as it was (the Web Animations API, not a style), so the document's
// patchPending comparisons still hold.
export function keepWaves(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const el of root.querySelectorAll('.eb-wave')) for (const anim of (typeof el.getAnimations === 'function' ? el.getAnimations() : [])) if (anim.startTime !== 0) anim.startTime = 0;
}
