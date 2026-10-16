// Where ⌘T, ⌘W and ⌘F go (2026-10-16: "cmd + w and cmd + t should work in middle canvas or stage or terminal, depending
// on where i clicked"). The window has three places that take them: the middle canvas (the document's panes and its tab
// strip), the Stage and the terminal. Whichever the person last clicked in, or moved the keyboard into, has them. A page
// on the Stage is a native view the window's page never sees a click in, so main says when one takes the keyboard
// (views.cjs, browser:focused). Pure: Workspace.jsx keeps the tracker and listens; Stage.jsx and TerminalPane.jsx step
// aside while the middle canvas has the keys.

const DOC = '[data-doc-pane], [data-doc-strip], [data-doc-find]';

/** The place an element is in: 'stage', 'terminal' or 'doc', or null for none of them (the sidebar, a menu on the body). */
export function sideOf(el) {
  if (!el || typeof el.closest !== 'function') return null;
  if (el.closest('[data-stage]')) return 'stage';
  if (el.closest('[data-terminal]')) return 'terminal';
  if (el.closest(DOC)) return 'doc';
  return null;
}

/** Which of the middle column's panes an element is in (0 the document in front, 1 the one beside); the tab strip is the
 * document in front's. null outside them. */
export function paneOf(el) {
  if (!el || typeof el.closest !== 'function') return null;
  const pane = el.closest('[data-doc-pane]');
  if (pane) return Number(pane.dataset && pane.dataset.docPane) || 0;
  return el.closest('[data-doc-strip]') ? 0 : null;
}

/**
 * The place last clicked or given the keyboard, and the middle column's pane last clicked. It starts on the middle canvas,
 * as ⌘1–9 always has. The window's page losing the keyboard (`left`, with what had it) and getting it back gives the same
 * element the keyboard again: that is no move (a page on the Stage clicked, then ⌘T there handing the keyboard back to the
 * app, must not count as the document being clicked).
 */
export function createSideTracker(start = 'doc') {
  let side = start, pane = 0, held = null;
  const take = (el) => {
    const now = sideOf(el);
    if (!now) return;
    side = now;
    const at = now === 'doc' ? paneOf(el) : null;
    if (at != null) pane = at;
  };
  return {
    side: () => side,
    pane: () => pane,
    /** A press anywhere in the window's page. */
    pressed(el) { held = null; take(el); },
    /** The window's page gave up the keyboard; `active` is what had it. */
    left(active) { held = active || null; },
    /** Something in the window's page took the keyboard. */
    focused(el) { const back = held; held = null; if (el && el === back) return; take(el); },
    /** A page on the Stage (or its box layer or card) took the keyboard. */
    page() { side = 'stage'; },
  };
}

/** Whether the middle canvas takes ⌘T, ⌘W and ⌘F: it was clicked last and is on screen, or it is all there is (its full
 * screen hides the right pane). */
export function docHasKeys(side, { docShown = true, docFull = false } = {}) {
  return !!docShown && (!!docFull || side === 'doc');
}

/**
 * What ⌘W closes in the middle canvas. The pane beside, when it was the pane clicked last (its × does the same); else the
 * tab in front, as its × would, unless it is one that does not close: Workspace, or the only tab left (Workspace.jsx
 * closeTab). `tabs` the strip's tabs ({ id }), `active` the id in front, `pane` the pane clicked last, `beside` how many
 * panes are open beside the document. → { pane } | { tab } | null for nothing
 */
export function docClose({ tabs, active, pane = 0, beside = 0 }) {
  if (pane >= 1 && pane <= beside) return { pane };
  const list = Array.isArray(tabs) ? tabs : [];
  if (!active || active === 'ws' || list.length < 2 || !list.some((tab) => tab && tab.id === active)) return null;
  return { tab: active };
}
