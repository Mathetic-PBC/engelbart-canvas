import React from 'react';
import { api } from '../api.js';
import ConnectLibrary from '../screens/ConnectLibrary.jsx';
import { isOpen, onOpenChange } from './connect-open.js';
import { dockLine } from '../model/connect.js';

// Connect your library in the background (2026-10-07: "Once the questions are done they should be able to minimize/close
// and it goes in the background"). A session put away keeps running in main; the chip in the top-right controls (beside
// the sandbox bell, so it is never under a native view: the Stage's pages and the post-its) says how it goes, amber when
// an agent needs the person (a few words; the whole line is its tooltip), and opens it again as a popup. The same popup is the one-time offer to someone who has
// projects already ("Existing users should see a popup to do this once, but not as an onboarding flow just like a popup
// they can dismiss"), its notes going into the project open then. In every library since 2026-10-08, as all of Connect.

/** The sessions main holds for this data root, kept current from its announcements. */
export function useConnectSessions(enabled, dataRoot = '') {
  const [sessions, setSessions] = React.useState([]);
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) { setSessions([]); return undefined; }
    let alive = true;
    api.connectList().then((list) => { if (alive) setSessions(list || []); }).catch(() => {});
    const off = api.onConnect((snapshot) => {
      if (!snapshot || !snapshot.id) return;
      setSessions((now) => {
        const at = now.findIndex((entry) => entry.id === snapshot.id);
        if (snapshot.dismissed) return at < 0 ? now : now.filter((entry) => entry.id !== snapshot.id);
        if (at < 0) return [snapshot, ...now];
        const next = [...now];
        next[at] = snapshot;
        return next;
      });
    });
    const offOpen = onOpenChange(() => setTick((n) => n + 1));
    return () => { alive = false; off(); offOpen(); };
  }, [enabled, dataRoot]);
  return sessions;
}

// 2026-10-14 (Hudson: "Remove the pill and blinking blue dot but keep the 'Importing i/n' text. To show it is in progress,
// it should 'wave gradient'"): plain text in the title bar, no border, fill or dot. Working, the words carry the
// left-to-right wave (styles.css .eb-wave); needing the person, amber; done, ink.
const TONES = {
  busy: { color: '#8f8f8f', wave: true },
  warn: { color: '#a35200', wave: false },
  done: { color: '#171717', wave: false },
};

/** The chip: the newest session not shown in this window, what it is doing, a click to open it. */
/**
 * An Import your context run whose imports have all ended (round 3, 2026-10-13): no chip. Its completion is a popup of its
 * own ("instead of having the pill in the header once it is done a popup should just come"), and what goes on after it
 * (MEMORY.md) is background work never shown ("No need to say anything about MEMORY.md").
 */
const importsEnded = (entry) => {
  if (!entry || !entry.direct) return false;
  const work = (entry.jobs || []).filter((job) => job.kind === 'import' || job.kind === 'recall' || job.kind === 'survey');
  return work.length > 0 && work.every((job) => ['done', 'failed', 'stopped'].includes(job.status)) && !(entry.needs || []).length;
};

export function ConnectChip({ sessions, onOpen }) {
  const shown = (sessions || []).filter((entry) => !isOpen(entry.id) && !importsEnded(entry));
  const top = shown.find((entry) => entry.needs && entry.needs.length) || shown[0];
  if (!top) return null;
  const view = dockLine(top);
  if (!view) return null;
  const tone = TONES[view.tone] || TONES.busy;
  return (
    <span data-connect-dock={view.tone} style={{ display: 'inline-flex', alignItems: 'center', height: 28, animation: 'rise 200ms cubic-bezier(.25,.1,.25,1)' }}>
      <button type="button" className="hov-dim" data-connect-dock-open={top.id} data-connect-dock-text={view.text} onClick={() => onOpen(top.id)} title={`${view.text}: open it`} style={{ display: 'inline-flex', alignItems: 'center', height: '100%', maxWidth: 160, padding: '0 4px', border: 0, background: 'transparent', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: tone.color }}>
        <span className={tone.wave ? 'eb-wave' : undefined} data-connect-dock-wave={tone.wave ? '1' : undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '2px 0' }}>{view.short}{view.tone === 'done' ? ' ✓' : ''}</span>
      </button>
      {view.tone === 'done' && <button type="button" className="hov-ink" data-connect-dock-dismiss={top.id} aria-label="Dismiss" title="Dismiss" onClick={() => api.connectDismiss(top.id).catch(() => {})} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', color: '#c9c9c9', font: '14px/1 var(--font-sans)' }}>×</button>}
    </span>
  );
}

/**
 * The popup: a session again (`request.sessionId`, from the chip), or a new one for the project open (`request.projectId`,
 * the one-time offer; `request.workspaceId`, the workspace open, which what comes in joins too). Closing it puts a session away (it goes on); "Not now" before anything began dismisses the offer.
 */
export function ConnectPopup({ request, onClose }) {
  React.useEffect(() => {
    // The Keychain modal open over it (ConnectLibrary.jsx KeychainModal) takes Escape for itself.
    const onKey = (event) => { if (event.key === 'Escape' && !document.querySelector('[data-connect-keychain]')) { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div data-overlay="1" data-cover="1" data-connect-popup={request.sessionId ? 'session' : 'offer'} style={{ position: 'fixed', inset: 0, zIndex: 140, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <ConnectLibrary
        mode="popup"
        sessionId={request.sessionId || null}
        projectId={request.projectId || null}
        workspaceId={request.workspaceId || null}
        onSession={() => { api.connectOfferSeen('started').catch(() => {}); }}
        onClose={onClose}
        onSkip={onClose}
      />
      {!request.sessionId && <span style={{ font: '12px/1.4 var(--font-sans)', color: '#4d4d4d', textShadow: '0 0 6px #fff' }}>Shown once. Close it to dismiss.</span>}
    </div>
  );
}
