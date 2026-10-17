import React from 'react';

// The picture viewer (2026-10-15, David; was DocEditor's lightbox): a click on a picture in a note opens it over the whole
// window. It is marked data-overlay so the Stage swaps its native page for a picture of it (Stage.jsx) and data-cover so
// post-its are covered (ProjectPostIts.jsx): without that both drew above the backdrop, the Stage page undimmed.
// The picture fits the window less 56px a side, never past 1 image pixel per CSS pixel; a click on it toggles fit and
// 100%, where it scrolls or is dragged. One control, Close, on the picture's top-right corner (of what shows of it).
// ⌘C or the right-click menu copies it; ← → step through the note's pictures; Esc or the backdrop closes it.
const MARGIN = 56;
const HINT = 'Click to zoom · ⌘C to copy · Esc to close';
const CSS = '@keyframes lb-fade{from{opacity:0}to{opacity:1}}@keyframes lb-rise{from{transform:scale(.98)}to{transform:scale(1)}}'
  + '[data-lightbox]{animation:lb-fade 150ms ease-out}[data-lightbox] img{animation:lb-rise 150ms ease-out}'
  + '@media (prefers-reduced-motion: reduce){[data-lightbox],[data-lightbox] img{animation:none}}'
  + '[data-lightbox-area=scroll]::-webkit-scrollbar{display:none}'
  // Close is a bare ×, with no box around it (2026-10-16, David).
  + '.lb-x{background:none;color:#262626}.lb-x:hover{color:#000}.lb-x:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.35)}'
  + '.lb-item:hover{background:#f2f2f2}';

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

/** pics: [{ src, alt }] in document order; at: the one shown. onStep(i), onClose(), onCopy(src) → Promise<boolean>. */
export default function ImageViewer({ pics, at, onStep, onClose, onCopy }) {
  const pic = pics[at] || pics[0];
  const rootRef = React.useRef(null);
  const scrollRef = React.useRef(null); // the root has backdrop-filter, which would carry fixed controls with a scroll: this scrolls
  const xRef = React.useRef(null);
  const [view, setView] = React.useState(viewport);
  const [nat, setNat] = React.useState(null); // the picture's own size, once loaded
  const [zoomed, setZoomed] = React.useState(false);
  const [scroll, setScroll] = React.useState({ x: 0, y: 0 });
  const [copied, setCopied] = React.useState(false);
  const [menu, setMenu] = React.useState(null);
  const anchor = React.useRef(null); // where a zoom was clicked, to keep that point under the pointer
  const drag = React.useRef(null);
  const downOnBackdrop = React.useRef(false);
  const copiedTimer = React.useRef(0);

  React.useEffect(() => { setNat(null); setZoomed(false); setScroll({ x: 0, y: 0 }); }, [pic.src]);
  React.useEffect(() => {
    const resize = () => setView(viewport());
    window.addEventListener('resize', resize);
    // Focus stays in the viewer while it is open.
    const keep = (e) => { const root = rootRef.current; if (root && !root.contains(e.target)) root.focus({ preventScroll: true }); };
    document.addEventListener('focusin', keep);
    if (rootRef.current) rootRef.current.focus({ preventScroll: true });
    return () => { window.removeEventListener('resize', resize); document.removeEventListener('focusin', keep); clearTimeout(copiedTimer.current); };
  }, []);

  const fit = nat ? Math.min((view.w - 2 * MARGIN) / nat.w, (view.h - 2 * MARGIN) / nat.h, 1) : 1;
  const canZoom = !!nat && fit < 1;
  const scale = zoomed ? 1 : fit;
  const w = nat ? nat.w * scale : 0, h = nat ? nat.h * scale : 0;
  const areaW = zoomed ? Math.max(view.w, w) : view.w, areaH = zoomed ? Math.max(view.h, h) : view.h;
  const left = (areaW - w) / 2, top = (areaH - h) / 2;

  // A zoom keeps the clicked point of the picture under the pointer.
  React.useLayoutEffect(() => {
    const root = scrollRef.current, a = anchor.current; if (!root) return;
    anchor.current = null;
    if (zoomed && a) { root.scrollLeft = left + a.px - a.x; root.scrollTop = top + a.py - a.y; }
    if (!zoomed) { root.scrollLeft = 0; root.scrollTop = 0; }
    setScroll({ x: root.scrollLeft, y: root.scrollTop });
  }, [zoomed]); // eslint-disable-line react-hooks/exhaustive-deps

  const showCopied = () => {
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1400);
  };
  const copy = async () => { setMenu(null); if (await onCopy(pic.src)) showCopied(); };
  const step = (by) => { const i = at + by; if (pics.length > 1 && i >= 0 && i < pics.length) { setMenu(null); onStep(i); } };

  const onKeyDown = (e) => {
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); if (menu) setMenu(null); else onClose(); return; }
    if ((e.metaKey || e.ctrlKey) && (k === 'c' || k === 'C')) { e.preventDefault(); e.stopPropagation(); void copy(); return; }
    if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(k === 'ArrowRight' ? 1 : -1); return; }
    if (k === 'Tab') { e.preventDefault(); (document.activeElement === xRef.current ? rootRef.current : xRef.current).focus(); }
  };

  // A press on the picture: a click toggles fit and 100%; at 100% a drag moves it instead.
  const onImgDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    setMenu(null);
    const root = scrollRef.current, start = { x: e.clientX, y: e.clientY, sx: root.scrollLeft, sy: root.scrollTop, moved: false };
    drag.current = start;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      if (zoomed) { root.scrollLeft = start.sx - dx; root.scrollTop = start.sy - dy; }
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      drag.current = null;
      if (start.moved || !canZoom) return;
      if (!zoomed) anchor.current = { x: ev.clientX, y: ev.clientY, px: (ev.clientX - (left - root.scrollLeft)) / fit, py: (ev.clientY - (top - root.scrollTop)) / fit };
      setZoomed(!zoomed);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  // Close sits 10px in from the top-right corner of what shows of the picture.
  const visRight = Math.min(left + w - scroll.x, view.w), visTop = Math.max(top - scroll.y, 0);
  const xStyle = { position: 'absolute', left: visRight - 10 - 30, top: visTop + 10, zIndex: 2, width: 30, height: 30, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 7, cursor: 'pointer', visibility: nat ? 'visible' : 'hidden' };

  return (
    <div
      ref={rootRef}
      data-lightbox="1"
      data-overlay="1"
      data-cover="1"
      role="dialog"
      aria-modal="true"
      aria-label={pic.alt || 'Image'}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget || !!e.target.dataset.lightboxArea; if (menu && !e.target.closest('[data-lightbox-menu]')) setMenu(null); }}
      onClick={(e) => { const back = e.target === e.currentTarget || !!e.target.dataset.lightboxArea; if (back && downOnBackdrop.current && !menu) onClose(); downOnBackdrop.current = false; }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, overflow: 'hidden', background: 'rgba(10,10,10,.66)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)', outline: 'none' }}
    >
      <style>{CSS}</style>
      <div ref={scrollRef} data-lightbox-area="scroll" onScroll={(e) => setScroll({ x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop })} style={{ position: 'absolute', inset: 0, overflow: zoomed ? 'auto' : 'hidden', scrollbarWidth: 'none' }}>
      <div data-lightbox-area="1" style={{ position: 'relative', width: areaW, height: areaH }}>
        <img
          key={pic.src}
          src={pic.src}
          alt={pic.alt}
          draggable={false}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onMouseDown={onImgDown}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
          style={{ position: 'absolute', left, top, width: nat ? w : 'auto', height: nat ? h : 'auto', maxWidth: nat ? 'none' : `calc(100vw - ${2 * MARGIN}px)`, maxHeight: nat ? 'none' : `calc(100vh - ${2 * MARGIN}px)`, visibility: nat ? 'visible' : 'hidden', borderRadius: 8, background: '#fff', boxShadow: '0 24px 70px rgba(0,0,0,.45)', userSelect: 'none', cursor: drag.current && drag.current.moved ? 'grabbing' : canZoom ? (zoomed ? 'zoom-out' : 'zoom-in') : 'default' }}
        />
      </div>
      </div>
      <button ref={xRef} type="button" className="lb-x" aria-label="Close" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(); }} style={xStyle}>
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
      {menu && (
        <div data-lightbox-menu="1" role="menu" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: Math.min(menu.x, view.w - 150), top: Math.min(menu.y, view.h - 50), zIndex: 3, minWidth: 140, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.16)' }}>
          <button type="button" role="menuitem" className="lb-item" onClick={() => void copy()} style={{ display: 'block', width: '100%', padding: '6px 10px', border: 0, borderRadius: 5, background: 'none', textAlign: 'left', font: '13px/1.4 var(--font-sans)', color: '#171717', cursor: 'pointer' }}>Copy image</button>
        </div>
      )}
      <div data-lightbox-hint="1" aria-live="polite" style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 2, pointerEvents: 'none', whiteSpace: 'nowrap', font: '12.5px/1.4 var(--font-sans)', ...(copied ? { padding: '5px 12px', borderRadius: 999, background: 'rgba(255,255,255,.95)', color: '#171717', boxShadow: '0 4px 14px rgba(0,0,0,.2)' } : { color: 'rgba(255,255,255,.55)' }) }}>{copied ? 'Copied' : HINT}</div>
    </div>
  );
}
