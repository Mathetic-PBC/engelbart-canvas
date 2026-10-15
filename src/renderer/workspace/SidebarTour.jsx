import React from 'react';
import { createPortal } from 'react-dom';

// The sidebar tour (2026-10-14): three coach marks after an import's "Open library", on the project's Welcome page. Hudson:
// "this card should highlight the library section of sidebar the button and then the popup that shows up when they click
// it, all of that should be opened and highlighted, like how some onboarding has guided onboarding". Each card spotlights
// part of the sidebar (the rest of the window dimmed, the parts cut out of the veil; no ring round them, 2026-10-15:
// "get rid of the ugly border around the highlighted sections") and sits beside
// it; → goes on, Finish ends it, × ends it early. Shown once: TOUR_SEEN in this machine's storage once it ends (App's
// "Start as a new user…" clears every engelbart.* key, so a fresh start sees it again). No dividing lines anywhere.
// What the cards point at is found in the page by these selectors and measured every frame while a card is up, so the
// Library popup rising, the sidebar scrolling or the window resizing never leave the spotlight behind.

export const TOUR_SEEN = 'engelbart.sidebarTour.seen';

export const TOUR_STEPS = [
  {
    key: 'library',
    title: 'Engelbart library',
    body: 'All of your sources are saved inside your Engelbart library, which you can attach to any of your projects.',
    // the Library row, and the popup it opens (Rail opens it for this step)
    holes: [['[data-sidebar] [data-sb-trigger="library"]'], ['[data-sb-panel="library"]']],
  },
  {
    key: 'sources',
    title: 'Project-specific sources',
    body: 'Each project gets its own folder that holds its notes, code, URLs, and any other project-specific sources from your library.',
    // Sources' head and this project's folder with what is in it
    holes: [['[data-sidebar] [data-sb-head="sources"]', '[data-sidebar] [data-sb-folder-group="project"]']],
  },
  {
    key: 'folders',
    title: 'Create folders for your sources',
    body: 'Folders allow you to organize frequently-visited sources so you can easily find them when working between projects.',
    // the person's own folders (state.json `folders`) and Create new
    holes: [['[data-sidebar] [data-sb-folder-group]:not([data-sb-folder-group="project"])', '[data-sidebar] [data-sb-create-folder]']],
  },
];

export function tourSeen() {
  try { return window.localStorage.getItem(TOUR_SEEN) === '1'; } catch { return false; }
}
export function markTourSeen() {
  try { window.localStorage.setItem(TOUR_SEEN, '1'); } catch { /* shown again next time */ }
}

const PAD = 5; // the cut-out's margin round what it shows
const CARD = 304;
const GAP = 16;
const EDGE = 16;
const TOP = 52; // under the 44px title bar
const VEIL = 'rgba(23,23,23,.26)';

/** One hole: the union of every element its selectors match, clipped to the sidebar's scrolling part when inside it. */
function measure(selectors) {
  let box = null;
  let clip = null;
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const r = element.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      box = box ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      const scroller = element.closest('[data-sb-scroll]');
      if (scroller && !clip) clip = scroller.getBoundingClientRect();
    }
  }
  if (!box) return null;
  if (clip) box = { left: box.left, right: box.right, top: Math.max(box.top, clip.top), bottom: Math.min(box.bottom, clip.bottom) };
  if (box.bottom - box.top < 4) return null;
  return { left: Math.round(box.left - PAD), top: Math.round(box.top - PAD), width: Math.round(box.right - box.left + PAD * 2), height: Math.round(box.bottom - box.top + PAD * 2) };
}

/** Where the card goes beside the last hole: to its right, else its left, else under it; kept in the window. */
function placeCard(hole, height) {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!hole) return { left: Math.round((vw - CARD) / 2), top: Math.round(vh * 0.3), side: 'none' };
  const top = Math.max(TOP, Math.min(hole.top, vh - height - EDGE));
  if (hole.left + hole.width + GAP + CARD <= vw - EDGE) return { left: hole.left + hole.width + GAP, top, side: 'right' };
  if (hole.left - GAP - CARD >= EDGE) return { left: hole.left - GAP - CARD, top, side: 'left' };
  return { left: Math.max(EDGE, Math.min(hole.left, vw - CARD - EDGE)), top: Math.min(hole.top + hole.height + GAP, vh - height - EDGE), side: 'below' };
}

const ARROW = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>;
const CROSS = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6 6 18" /></svg>;

/**
 * `step` 0–2 (null: nothing); `paused` while a popup of the app is up (nothing drawn, the step kept); `onNext()` → and
 * Finish; `onClose()` × and Escape.
 */
export default function SidebarTour({ step, paused = false, onNext, onClose }) {
  const spec = step != null ? TOUR_STEPS[step] : null;
  const [holes, setHoles] = React.useState([]);
  const [cardHeight, setCardHeight] = React.useState(176);
  const cardRef = React.useRef(null);
  const nextRef = React.useRef(null);

  // Bring what this card points at into the sidebar's view once, then follow it every frame.
  React.useEffect(() => {
    if (!spec || paused) return undefined;
    const first = document.querySelector(spec.holes[0][spec.holes[0].length - 1]) || document.querySelector(spec.holes[0][0]);
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
    let frame = 0;
    let last = '';
    const tick = () => {
      const next = spec.holes.map(measure).filter(Boolean);
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setHoles(next); }
      if (cardRef.current) { const h = Math.round(cardRef.current.getBoundingClientRect().height); if (h) setCardHeight((now) => (now === h ? now : h)); }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [spec, paused]);

  // Escape ends the tour, before the sidebar's popup or the workspace sees the key (Escape alone would leave the project);
  // → and Enter go on.
  React.useEffect(() => {
    if (!spec || paused) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); return; }
      if (event.key === 'ArrowRight' || event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); onNext(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [spec, paused, onNext, onClose]);

  React.useEffect(() => { if (spec && !paused && nextRef.current) nextRef.current.focus({ preventScroll: true }); }, [spec, paused]);

  if (!spec || paused) return null;
  const anchor = holes[holes.length - 1] || null;
  const card = placeCard(anchor, cardHeight);
  const last = step === TOUR_STEPS.length - 1;
  // The caret on the card's edge points at what it shows: its middle, or 32px down a tall one (kept off the card's corners).
  const caretTop = anchor ? Math.max(20, Math.min(cardHeight - 20, anchor.top + Math.min(anchor.height, 64) / 2 - card.top)) : 0;
  return createPortal(
    // data-sb-layer above every sidebar layer: a press here never shuts the Library popup the first card shows.
    <div data-overlay="1" data-sb-layer="1000000" data-sidebar-tour={spec.key} data-tour-step={step} onMouseDown={(event) => { if (!(event.target.closest && event.target.closest('button'))) event.preventDefault(); }} style={{ position: 'fixed', inset: 0, zIndex: 250 }}>
      <svg aria-hidden="true" width="100%" height="100%" style={{ position: 'absolute', inset: 0, display: 'block' }}>
        <defs>
          <mask id="eb-tour-veil" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <rect x="0" y="0" width="100%" height="100%" fill="#fff" />
            {holes.map((hole, i) => <rect key={i} x={hole.left} y={hole.top} width={hole.width} height={hole.height} rx="10" fill="#000" style={{ transition: 'all 220ms cubic-bezier(.25,.1,.25,1)' }} />)}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill={VEIL} mask="url(#eb-tour-veil)" />
      </svg>
      {holes.map((hole, i) => (
        <div key={i} data-tour-hole={i} aria-hidden="true" style={{ position: 'absolute', left: hole.left, top: hole.top, width: hole.width, height: hole.height, boxSizing: 'border-box', borderRadius: 10, pointerEvents: 'none', transition: 'all 220ms cubic-bezier(.25,.1,.25,1)' }} />
      ))}
      <section
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        data-tour-card={spec.key}
        style={{ position: 'absolute', left: card.left, top: card.top, width: CARD, boxSizing: 'border-box', padding: '18px 18px 16px 20px', background: '#fff', borderRadius: 14, boxShadow: '0 16px 48px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.06)', fontFamily: 'var(--font-sans)', color: '#171717', transition: 'left 220ms cubic-bezier(.25,.1,.25,1), top 220ms cubic-bezier(.25,.1,.25,1)' }}
      >
        {card.side === 'right' && <span aria-hidden="true" style={{ position: 'absolute', left: -6, top: caretTop - 6, width: 12, height: 12, background: '#fff', transform: 'rotate(45deg)', borderRadius: 2, boxShadow: '-2px 2px 4px rgba(0,0,0,.04)' }} />}
        {card.side === 'left' && <span aria-hidden="true" style={{ position: 'absolute', right: -6, top: caretTop - 6, width: 12, height: 12, background: '#fff', transform: 'rotate(45deg)', borderRadius: 2 }} />}
        <div key={spec.key} style={{ position: 'relative', animation: 'rise 180ms cubic-bezier(.25,.1,.25,1)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <h3 style={{ flex: 1, margin: 0, font: '600 15px/1.35 var(--font-sans)', letterSpacing: '-0.15px', color: '#171717' }}>{spec.title}</h3>
            <button type="button" className="hov-ink" data-tour-close="1" aria-label="Close the tour" title="Close" onClick={onClose} style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, margin: '-2px -4px 0 0', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: '#8f8f8f', cursor: 'pointer' }}>{CROSS}</button>
          </div>
          <p style={{ margin: '8px 0 0', font: '13.5px/1.55 var(--font-sans)', color: '#4d4d4d' }}>{spec.body}</p>
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 16 }}>
            <span data-tour-dots="1" aria-label={`${step + 1} of ${TOUR_STEPS.length}`} style={{ display: 'flex', gap: 5 }}>
              {TOUR_STEPS.map((one, i) => <span key={one.key} style={{ width: i === step ? 14 : 6, height: 6, borderRadius: 3, background: i === step ? '#171717' : '#dcdcdc', transition: 'width 200ms, background 200ms' }} />)}
            </span>
            <span style={{ flex: 1 }} />
            {last
              ? <button ref={nextRef} type="button" className="hov-dim" data-tour-finish="1" onClick={onNext} style={{ height: 32, padding: '0 16px', border: 0, borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)' }}>Finish</button>
              : <button ref={nextRef} type="button" className="hov-dim" data-tour-next="1" aria-label="Next" title="Next" onClick={onNext} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, padding: 0, border: 0, borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer' }}>{ARROW}</button>}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
