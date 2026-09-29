import React from 'react';

// A tab drawn as the Stage draws its own (Add - Mention Stage.dc.html, 2026-09-23), for the strips that are not the Stage's:
// the document's tabs over the middle canvas and the Terminal's (2026-09-25, "make the styles match stage"). The one in
// front is white and runs into what is under it, its foot flaring out; the rest have no box until hovered, a hairline
// between two of them. Unlike the Stage's, which share one width, these are as long as their titles, up to TAB_MAX
// ("make the tab lengths match their title or the max note title length"), and shrink together only when the strip fills.

export const TAB_MAX = 220;
const EASE = 'cubic-bezier(.25,.1,.25,1)';
const CARD_MS = 650; // the first card; then quickly while moving along the strip, as the Stage's
const FADE = 'linear-gradient(90deg,#000 calc(100% - 18px),transparent)';

/** A tab's name: it fades out at the tab's end only when the tab is too short for it, so a whole name never loses its last letters. */
export function TabTitle({ children, weight = 400, color = '#4d4d4d', size = 12.5 }) {
  const ref = React.useRef(null);
  const [clipped, setClipped] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);
  const mask = clipped ? { WebkitMaskImage: FADE, maskImage: FADE } : null;
  return <span ref={ref} data-clipped={clipped ? '1' : '0'} style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', ...mask, font: `${weight} ${size}px/1.3 var(--font-sans)`, color }}>{children}</span>;
}

export function TabClose({ onClose, label = 'Close tab', title = '⌘W' }) {
  return (
    <button type="button" className="hov-x" data-tab-close="1" onClick={(event) => { event.stopPropagation(); onClose(); }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} aria-label={label} title={title} style={{ flex: 'none', width: 20, height: 20, marginLeft: 'auto', padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '14px/1 var(--font-sans)', color: '#8f8f8f', transition: 'background 120ms' }}>×</button>
  );
}

/** The tab itself. Extra props (handlers, data-*) go on the outer element, which is what a strip measures and drags. */
export const FluidTab = React.forwardRef(function FluidTab({ on, sep, lifted, variant, children, style, ...rest }, ref) {
  const document = variant === 'document';
  return (
    <div ref={ref} data-on={on ? '1' : '0'} {...rest} style={{ position: 'relative', zIndex: lifted ? 2 : on ? 1 : undefined, flex: '0 1 auto', maxWidth: TAB_MAX, minWidth: 44, height: document ? 36 : 34, display: 'flex', alignItems: 'stretch', cursor: 'default', userSelect: 'none', WebkitUserSelect: 'none', ...style }}>
      {on ? (
        <div style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box', padding: document ? '0 12px' : '0 6px 0 12px', background: '#fff', borderRadius: '10px 10px 0 0' }}>
          {!document && <>
          <span aria-hidden="true" style={{ position: 'absolute', left: -10, bottom: 0, width: 10, height: 10, background: 'radial-gradient(circle at 0 0, transparent 9.5px, #fff 10px)' }} />
          <span aria-hidden="true" style={{ position: 'absolute', right: -10, bottom: 0, width: 10, height: 10, background: 'radial-gradient(circle at 100% 0, transparent 9.5px, #fff 10px)' }} />
          </>}
          {children}
        </div>
      ) : (
        <div className="hov-tab" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box', margin: document ? 0 : '0 2px 4px', padding: document ? '0 12px' : '0 4px 0 10px', borderRadius: document ? '10px 10px 0 0' : 8, background: lifted ? '#e6e6e6' : 'transparent', transition: 'background 120ms' }}>
          {children}
        </div>
      )}
      {sep && <span aria-hidden="true" style={{ position: 'absolute', right: 0, top: 9, width: 1, height: 16, background: '#c9c9c9' }} />}
    </div>
  );
});

/** The card a tab shows after a moment under the pointer: its whole name and where it is. Fixed, so a strip's overflow never cuts it. */
export function useTabCard() {
  const [card, setCard] = React.useState(null); // { id, left, top, width }
  const timer = React.useRef(0);
  const cool = React.useRef(0);
  const warm = React.useRef(false);
  React.useEffect(() => () => { clearTimeout(timer.current); clearTimeout(cool.current); }, []);
  const enter = (event, id) => {
    clearTimeout(timer.current);
    const r = event.currentTarget.getBoundingClientRect();
    const width = 260;
    const left = Math.max(8, Math.min(r.left + 4, (window.innerWidth || 1200) - width - 8));
    timer.current = setTimeout(() => { warm.current = true; setCard({ id, left, top: r.bottom + 6, width }); }, warm.current ? 60 : CARD_MS);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setCard(null);
    clearTimeout(cool.current);
    cool.current = setTimeout(() => { warm.current = false; }, 400);
  };
  const hide = () => { clearTimeout(timer.current); setCard(null); };
  return { card, enter, leave, hide };
}

export function TabCard({ card, title, detail }) {
  if (!card) return null;
  return (
    <div data-overlay="1" data-tab-card="1" style={{ position: 'fixed', left: card.left, top: card.top, zIndex: 60, width: card.width, boxSizing: 'border-box', padding: '10px 12px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, pointerEvents: 'none', animation: `rise 160ms ${EASE}` }}>
      <div style={{ font: '500 13px/1.4 var(--font-sans)', color: '#171717', overflowWrap: 'anywhere', textWrap: 'pretty' }}>{title}</div>
      {detail && <div style={{ marginTop: 3, font: '12px/1.4 var(--font-sans)', color: '#8f8f8f', overflowWrap: 'anywhere' }}>{detail}</div>}
    </div>
  );
}
