import React from 'react';
import { api } from '../api.js';

// New versions (MATH-43, src/main/updates.cjs): what the updater is doing, in every window and on every screen. While the
// install command downloads the new version, how far it is (the bar runs back and forth until curl gives a percentage);
// once it is ready, Restart to Update or Later. Later hides it in every window until the state changes; the Engelbart
// menu keeps Restart to Update, and the new version is installed at the next quit. Anything else shows nothing.
// Styled as App's error toast, in the other corner. On the workspace screen it keeps to the document's bottom-right
// corner, clear of the Stage: a page there is a native view, which anything reaching over it turns into a picture of
// itself (Stage.jsx). With the Stage full screen there is no document, and it sits in the window's corner.

const EDGE_RIGHT = 24;
const EDGE_BOTTOM = 18;
const EASE = 'cubic-bezier(.25,.1,.25,1)';
const BUTTON = { padding: '3px 6px', border: 0, borderRadius: 5, background: '#fff', cursor: 'pointer', font: '12.5px/1.4 var(--font-sans)', color: '#8f8f8f', transition: 'color 120ms' };

/** Whether a snapshot ({ enabled, state, version, percent, dismissed }) has anything to show. */
export const showsUpdate = (update) => !!update && !!update.enabled && (update.state === 'installing' || (update.state === 'ready' && !update.dismissed));

/** The banner itself, for a snapshot; nothing when it has nothing to show. */
export function UpdateNotice({ update, onRestart, onLater, style }) {
  if (!showsUpdate(update)) return null;
  const name = update.version ? `Engelbart ${update.version}` : 'Engelbart';
  const box = { position: 'fixed', zIndex: 140, boxSizing: 'border-box', maxWidth: 'calc(100vw - 48px)', padding: '7px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', font: '12.5px/1.5 var(--font-sans)', color: '#171717', animation: `rise 160ms ${EASE}`, ...style };
  if (update.state === 'installing') {
    const known = typeof update.percent === 'number';
    return (
      <div data-overlay="1" data-update-banner="installing" role="status" style={{ ...box, width: 260, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span>{`Downloading ${name}…${known ? ` ${update.percent}%` : ''}`}</span>
        <div aria-hidden="true" style={{ height: 2, borderRadius: 1, background: '#eaeaea', overflow: 'hidden' }}>
          <div data-update-progress={known ? update.percent : 'waiting'} style={known
            ? { width: `${update.percent}%`, height: '100%', background: '#0070f3', transition: 'width 200ms linear' }
            : { width: '33%', height: '100%', background: '#0070f3', animation: 'update-slide 1.2s ease-in-out infinite' }} />
        </div>
      </div>
    );
  }
  return (
    <div data-overlay="1" data-update-banner="ready" role="status" style={{ ...box, padding: '5px 6px 5px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <span style={{ marginRight: 6 }}>{`${name} is ready.`}</span>
      <button type="button" className="hov-ink" data-update-restart="1" onClick={onRestart} title="Quit and open again as the new version" style={{ ...BUTTON, fontWeight: 500, color: '#171717' }}>Restart to Update</button>
      <button type="button" className="hov-ink" data-update-later="1" onClick={onLater} title="It is installed the next time you quit" style={BUTTON}>Later</button>
    </div>
  );
}

/** Where the banner goes: the document's bottom-right corner on the workspace screen, else the window's. */
function corner() {
  const column = document.querySelector('[data-doc-column]');
  const r = column ? column.getBoundingClientRect() : null;
  if (!r || r.width < 1 || r.height < 1) return { right: EDGE_RIGHT, bottom: EDGE_BOTTOM };
  return { right: Math.max(EDGE_RIGHT, Math.round(window.innerWidth - r.right + 16)), bottom: Math.max(EDGE_BOTTOM, Math.round(window.innerHeight - r.bottom + EDGE_BOTTOM)) };
}

export default function UpdateBanner() {
  const [update, setUpdate] = React.useState(null);
  const [place, setPlace] = React.useState({ right: EDGE_RIGHT, bottom: EDGE_BOTTOM });

  // The state now, then every change (an event that comes before the answer wins).
  React.useEffect(() => {
    let live = true;
    const off = api.onUpdate((next) => { if (next) setUpdate(next); });
    api.updateState().then((now) => { if (live && now) setUpdate((current) => current || now); }).catch(() => {});
    return () => { live = false; off(); };
  }, []);

  // The document's corner moves with the window and with the panes beside it.
  const shown = showsUpdate(update);
  React.useEffect(() => {
    if (!shown) return undefined;
    let timer = 0;
    const measure = () => {
      timer = 0;
      const next = corner();
      setPlace((now) => (now.right === next.right && now.bottom === next.bottom ? now : next));
    };
    const schedule = () => { if (!timer) timer = setTimeout(measure, 16); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', schedule);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', schedule); clearTimeout(timer); };
  }, [shown]);

  const restart = () => { api.updateRestart().catch(() => {}); };
  const later = () => {
    setUpdate((current) => (current ? { ...current, dismissed: true } : current));
    api.updateLater().catch(() => {});
  };
  return <UpdateNotice update={update} onRestart={restart} onLater={later} style={place} />;
}
