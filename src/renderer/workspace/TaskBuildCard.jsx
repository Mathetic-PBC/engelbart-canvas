import React from 'react';
import { createPortal } from 'react-dom';
import { usePlaced } from '../ui/usePlaced.js';

// A task's Build card (MATH-106, 2026-10-25): the regular Build card, beside the task it was built from, opened from the
// state at the end of the task's row. Built as PostItBuild's popup is (a covering panel placed by usePlaced). What is in
// it is DocEditor's: it fills `onBody`'s element with the card's parts (buildParts) and patches them as the Build moves on,
// and everything done in it (`onEvent`) goes to the same handlers as a `build>` line's card. Escape or a click outside closes it.

const WIDTH = 520;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export default function TaskBuildCard({ id, anchorOf, onBody, onEvent, onClose }) {
  const [, redraw] = React.useReducer((n) => n + 1, 0);
  const anchor = anchorOf();
  const [ref, placed] = usePlaced(anchor, { gap: 6, align: 'end', cap: Math.round((window.innerHeight || 800) * 0.8) });

  // Placed again when the page scrolls or resizes, or the card's contents change its size.
  React.useEffect(() => {
    const again = () => redraw();
    window.addEventListener('scroll', again, true);
    window.addEventListener('resize', again);
    const watch = typeof ResizeObserver === 'function' && ref.current ? new ResizeObserver(again) : null;
    if (watch) watch.observe(ref.current);
    return () => { window.removeEventListener('scroll', again, true); window.removeEventListener('resize', again); if (watch) watch.disconnect(); };
  }, []);
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  React.useEffect(() => {
    const away = (event) => {
      const t = event.target;
      if (t && t.closest && t.closest(`[data-task-card], [data-task-build="${id}"], [data-ctx-pop]`)) return; // its own label toggles it
      onClose();
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [id, onClose]);
  // The task's row went (deleted, or its document closed): nothing to stand beside.
  React.useEffect(() => { if (!anchor) onClose(); });

  const pass = (kind) => (event) => { event.stopPropagation(); onEvent(kind, event.nativeEvent || event); };
  return createPortal(
    <div ref={ref} data-overlay="1" data-cover="1" data-task-card={id} role="dialog" aria-label="Build"
      onMouseDown={pass('mousedown')} onClick={pass('click')} onInput={pass('input')} onKeyDown={pass('keydown')} onPaste={pass('paste')}
      style={{ ...placed, zIndex: 55, width: WIDTH, maxWidth: 'calc(100vw - 24px)', boxSizing: 'border-box', padding: '8px 16px 12px', background: '#fff', font: '14px/1.6 var(--font-sans)', color: '#4d4d4d', userSelect: 'text', cursor: 'default', border: '1px solid #eaeaea', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.08)', overflow: placed.maxHeight != null ? 'auto' : 'visible', animation: `rise 160ms ${EASE}` }}>
      <div ref={onBody} data-task-card-body="1" />
    </div>,
    document.body,
  );
}
