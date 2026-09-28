import React from 'react';
import { createPortal } from 'react-dom';
import './stage-popover.css';

export function annotationPosition(bounds, slot, popup) {
  const gap = 8, width = Math.max(0, Math.min(300, slot.width - gap * 2));
  const sx = bounds ? slot.width / bounds.viewportWidth : 1, sy = bounds ? slot.height / bounds.viewportHeight : 1;
  const target = bounds ? { x: slot.left + bounds.x * sx, y: slot.top + bounds.y * sy, h: bounds.h * sy } : { x: slot.left + gap, y: slot.top + gap, h: 0 };
  const below = target.y + target.h + gap, above = target.y - popup.height - gap;
  const top = below + popup.height <= slot.bottom - gap ? below : above >= slot.top + gap ? above : below;
  return {
    left: Math.max(slot.left + gap, Math.min(target.x, slot.right - width - gap)),
    top: Math.max(slot.top + gap, Math.min(top, slot.bottom - popup.height - gap)),
    width, maxHeight: Math.max(0, slot.height - gap * 2),
  };
}

export function annotationListPosition(slot) {
  const width = Math.max(0, Math.min(300, slot.width - 16));
  return { left: slot.right - width - 8, top: slot.top + 8, width, maxHeight: Math.max(0, Math.min(420, slot.height - 16)) };
}

// Reuse Stage's existing data-overlay/snapshot mechanism; note text never enters
// the website. Browsing, reading and composing all leave the page full width.
export default function StagePopover({ bounds, slotRef, surfaceRef, children, onKeyDown, onDismiss, name, kind = 'browser', focusKey, className = '', ...rest }) {
  const ref = React.useRef(null);
  const [position, setPosition] = React.useState(null);
  React.useLayoutEffect(() => {
    const slot = slotRef?.current || surfaceRef?.current;
    const place = () => {
      if (!slot || !ref.current) return;
      const box = slot.getBoundingClientRect();
      const next = bounds ? annotationPosition(bounds, box, ref.current.getBoundingClientRect()) : annotationListPosition(box);
      if (kind !== 'composer') next.maxHeight = Math.min(420, next.maxHeight);
      setPosition((old) => old && Object.keys(next).every((key) => old[key] === next[key]) ? old : next);
    };
    const observer = new ResizeObserver(place);
    observer.observe(ref.current); if (slot) observer.observe(slot);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true); place();
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [bounds, slotRef, surfaceRef, kind]);
  React.useEffect(() => {
    if (position && ref.current) {
      ref.current.scrollTop = 0;
      ref.current.querySelector('textarea, [data-popover-heading] button')?.focus({ preventScroll: true });
    }
  }, [!!position, focusKey]);
  React.useEffect(() => {
    if (!onDismiss) return undefined;
    const away = event => { if (!ref.current?.contains(event.target)) onDismiss(); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onDismiss(); } };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', escape, true); };
  }, [onDismiss]);
  return createPortal(<div ref={ref} role="dialog" aria-label={name} data-overlay="1" className={`stage-popover ${className}`} {...rest}
    style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={onKeyDown}>{children}</div>, document.body);
}

