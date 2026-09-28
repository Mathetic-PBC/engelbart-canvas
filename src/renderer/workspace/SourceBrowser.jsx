import React from 'react';
import { createPortal } from 'react-dom';
import { usePlaced } from '../ui/usePlaced.js';

function SourcePanel({ id, catalog, anchor, triggerRef, onClose, children }) {
  const [ref, placed] = usePlaced(anchor, { gap: 6, cap: 420 });
  const contentRef = React.useRef(null);
  const [, remeasure] = React.useReducer(value => value + 1, 0);
  const focused = React.useRef(false);
  React.useLayoutEffect(() => {
    const observer = new ResizeObserver(() => remeasure());
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    if (!focused.current && placed.visibility !== 'hidden') {
      focused.current = true;
      (ref.current?.querySelector('input') || contentRef.current)?.focus({ preventScroll: true });
    }
  }, [placed.visibility, ref]);
  React.useEffect(() => {
    const away = event => { if (!ref.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose(); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); } };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('focusin', away);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('focusin', away); document.removeEventListener('keydown', escape, true); };
  }, [onClose, ref, triggerRef]);
  const key = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const rows = [...contentRef.current.querySelectorAll('button:not(:disabled)')];
    if (!rows.length) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement);
    const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
    rows[next].focus({ preventScroll: true }); rows[next].scrollIntoView({ block: 'nearest' });
  };
  return createPortal(<div id={id} ref={ref} role="dialog" aria-label={catalog.title} data-source-browser={catalog.provider} data-overlay="1" onKeyDown={key}
    style={{ ...placed, zIndex: 80, width: 340, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', overscrollBehavior: 'contain', padding: 8, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, boxShadow: '0 8px 24px #0000000f' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 4px 8px' }}>
      <span style={{ font: '500 13px/1.4 var(--font-sans)', color: '#171717' }}>{catalog.title}</span>
      <button type="button" className="hov-wash" aria-label="Close browser" onClick={() => onClose(true)} style={{ width: 24, height: 24, padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: '#737373', fontSize: 18, cursor: 'pointer' }}>×</button>
    </div>
    <div ref={contentRef} tabIndex={-1} data-catalog-content="1" style={{ outline: 'none' }}>{children}</div>
  </div>, document.body);
}

// The same explicit Browse control for each account catalog; no catalog mounts
// until its button is clicked, and all source browsers start closed.
export default function SourceBrowser({ catalog, onOpenChange, shut, children }) {
  const [anchor, setAnchor] = React.useState(null);
  const triggerRef = React.useRef(null);
  const id = React.useId();
  const open = !!anchor;
  const close = React.useCallback((restoreFocus = false) => {
    setAnchor(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  React.useEffect(() => { onOpenChange(catalog.provider, open); return () => onOpenChange(catalog.provider, false); }, [catalog.provider, open, onOpenChange]);
  React.useEffect(() => { if (shut) close(); }, [shut, close]);
  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => setAnchor(triggerRef.current.getBoundingClientRect());
    const scrolled = () => close();
    const aside = triggerRef.current.closest('aside');
    const observer = new ResizeObserver(measure);
    observer.observe(triggerRef.current);
    if (aside) observer.observe(aside);
    aside?.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); aside?.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', measure); };
  }, [open, close]);
  return <div style={{ minWidth: 0 }}>
    <button ref={triggerRef} type="button" className="hov-ink-wash" data-browse-source={catalog.provider} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setAnchor(triggerRef.current.getBoundingClientRect())}
      style={{ display: 'block', width: '100%', padding: '7px 10px', boxSizing: 'border-box', border: 0, borderRadius: 6, background: open ? '#f2f2f2' : 'transparent', color: '#8f8f8f', textAlign: 'left', font: '12.5px/1.5 var(--font-sans)', cursor: 'pointer' }}>{catalog.label}</button>
    {open && <SourcePanel id={id} catalog={catalog} anchor={anchor} triggerRef={triggerRef} onClose={close}>{children(() => close(true))}</SourcePanel>}
  </div>;
}
