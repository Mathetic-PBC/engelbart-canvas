import React from 'react';
import { api } from '../api.js';
import ConnectLibrary from '../screens/ConnectLibrary.jsx';
import { isOpen, onOpenChange } from './connect-open.js';
import { dockLine } from '../model/connect.js';

// Connect your library in the background (2026-10-07: "Once the questions are done they should be able to minimize/close
// and it goes in the background"). A session put away keeps running in main; the chip in the top-right controls (beside
// the sandbox bell, so it is never under a native view: the Stage's pages and the post-its) says how it goes, amber when
// an agent needs the person (a few words; the whole line is its tooltip), and opens it again as a popup. The same popup is
// what "Import Context"'s Import opens (2026-10-12, ui/GuidedSetup.jsx ImportContextOffer): the tick-and-import screen,
// its notes going into the project open then. In every library since 2026-10-08, as all of Connect.

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

const TONES = {
  busy: { border: '#eaeaea', background: '#fff', color: '#4d4d4d', dot: '#0070f3' },
  warn: { border: '#f5c26b', background: '#fffaf0', color: '#a35200', dot: '#e8a317' },
  done: { border: '#eaeaea', background: '#fff', color: '#171717', dot: '#1f9d55' },
};

/** The chip: the newest session not shown in this window, what it is doing, a click to open it. */
export function ConnectChip({ sessions, onOpen }) {
  const shown = (sessions || []).filter((entry) => !isOpen(entry.id));
  const top = shown.find((entry) => entry.needs && entry.needs.length) || shown[0];
  if (!top) return null;
  const view = dockLine(top);
  if (!view) return null;
  const tone = TONES[view.tone] || TONES.busy;
  return (
    <span data-connect-dock={view.tone} style={{ display: 'inline-flex', alignItems: 'center', height: 28, border: `1px solid ${tone.border}`, borderRadius: 999, background: tone.background, animation: 'rise 200ms cubic-bezier(.25,.1,.25,1)' }}>
      <button type="button" data-connect-dock-open={top.id} data-connect-dock-text={view.text} onClick={() => onOpen(top.id)} title={`${view.text}: open it`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: '100%', maxWidth: 140, padding: view.tone === 'done' ? '0 2px 0 10px' : '0 11px 0 10px', border: 0, background: 'transparent', cursor: 'pointer', font: '12px/1 var(--font-sans)', color: tone.color }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: tone.dot, animation: view.tone === 'busy' ? 'github-wait 1.4s ease-in-out infinite' : 'none' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{view.short}{view.tone === 'done' ? ' ✓' : ''}</span>
      </button>
      {view.tone === 'done' && <button type="button" data-connect-dock-dismiss={top.id} aria-label="Dismiss" title="Dismiss" onClick={() => api.connectDismiss(top.id).catch(() => {})} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: '100%', padding: '0 6px 0 0', border: 0, background: 'transparent', cursor: 'pointer', color: '#c9c9c9', font: '14px/1 var(--font-sans)' }}>×</button>}
    </span>
  );
}

/**
 * The popup: a session again (`request.sessionId`, from the chip), or a new one for the project open (`request.projectId`,
 * Import Context's Import; `request.workspaceId`, the workspace open, which what comes in joins too). Closing it puts a
 * session away (it goes on); closed before anything began, it is only closed: the offer comes back on a later launch
 * until its Not now dismisses it.
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
    </div>
  );
}
