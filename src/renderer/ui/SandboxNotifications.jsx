import React from 'react';
import { createPortal } from 'react-dom';
import { useSandboxes } from './SandboxProgress.jsx';
import { availableBuildNotifications, canOpenPreview, canOpenTerminal, failureReason, runKind, sandboxStatus } from '../model/sandbox-notifications.js';
import './sandbox-notifications.css';

// A failed build says so and, at most, why in a few words (failureReason): its whole error is in its build details. A
// finished one says whether its sandbox is asleep or running (sandboxStatus), so a wait to wake it is no surprise.
export function BuildNotification({ notification, run, sandbox = null, repo, busy, onRepository, onBuild, onOpen, onTerminal, onClear }) {
  const name = repo?.name || 'Repository';
  const building = run.status === 'starting', failed = run.status === 'failed';
  const canOpen = canOpenPreview(run), canTerminal = canOpenTerminal(run) && !!onTerminal;
  const reason = failureReason(run);
  const status = sandboxStatus(run, sandbox);
  const visit = event => { event.preventDefault(); onRepository(repo); };
  return <div className="notification-row" data-build-status={run.status}>
    <div className="notification-entry">
      <div className="notification-copy">
        {repo?.url ? <a className="notification-repo" href={repo.url} aria-label={`Open ${name} on GitHub in Stage`} onClick={visit}
          onAuxClick={event => { if (event.button === 1) visit(event); }}>{name}</a> : <span className="notification-repo">{name}</span>}
        {!building && <span className="notification-status-line">
          <button type="button" className="notification-description" aria-label={`${failed ? 'Build failed' : 'Build finished'} — view build details for ${name}`} aria-haspopup="dialog" disabled={!repo || !onBuild}
            onClick={() => onBuild(repo)}>{failed ? 'Build failed' : 'Build finished'}</button>
          {status && <span className="notification-sandbox" data-sandbox={sandbox} title={sandbox === 'asleep' ? 'Opening it wakes it, which can take a few seconds' : 'Its sandbox is awake'}>{status}</span>}
        </span>}
        {failed && reason && <span className="notification-detail">{reason}</span>}
        {run.status === 'ready' && runKind(run) !== 'terminal' && !canOpen && <span className="notification-detail">No web preview</span>}
      </div>
      {(building || canOpen || canTerminal) && <div className="notification-run-actions">
        {building && <button type="button" className="notification-build" aria-label={`View build details for ${name}`} aria-haspopup="dialog" disabled={!repo || !onBuild}
          onClick={() => onBuild(repo)}>Building…</button>}
        {canOpen && <button type="button" className="notification-open" aria-label={`Open live preview for ${name}`} disabled={busy} onClick={() => onOpen(run)}>Open live</button>}
        {canTerminal && <button type="button" className="notification-open notification-terminal" aria-label={`Open terminal for ${name}`} disabled={busy} onClick={() => onTerminal(run)}>Open terminal</button>}
      </div>}
    </div>
    <button type="button" className="notification-dismiss" aria-label={`Clear notification for ${name}`} title="Clear notification" onClick={() => onClear([notification.id])}>×</button>
  </div>;
}

// The header bell (App.jsx, every screen): one row per repository, Building… → Build finished / Build failed.
export function NotificationBell({ notifications, items, library, markRead, clearNotifications, openPreview, openTerminal, openRepository, openBuild, busy = {}, error }) {
  const [expanded, setExpanded] = React.useState(false);
  const trigger = React.useRef(null);
  const panel = React.useRef(null);
  const closeButton = React.useRef(null);
  const id = React.useId();
  const visibleNotifications = React.useMemo(() => availableBuildNotifications(notifications, items), [notifications, items]);
  const unread = visibleNotifications.filter((row) => !row.read).length;
  const close = (restoreFocus = false) => {
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const clear = (ids) => {
    clearNotifications(ids);
    closeButton.current?.focus({ preventScroll: true });
  };
  React.useEffect(() => {
    if (!expanded) return undefined;
    closeButton.current?.focus({ preventScroll: true });
    const outside = (event) => {
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setExpanded(false);
    };
    const escape = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    const blur = () => setExpanded(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', escape, true);
    // Native preview views receive their own pointer events and blur the app renderer.
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
    };
  }, [expanded]);
  React.useEffect(() => {
    if (expanded && unread) {
      const ids = visibleNotifications.filter(row => !row.read).map(row => row.id);
      if (ids.length) markRead(ids);
    }
  }, [expanded, unread, visibleNotifications, markRead]);
  return <div className="notification-control" data-no-drag="1">
    <button ref={trigger} type="button" className="notification-bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      title="Notifications" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      onClick={() => setExpanded((value) => !value)}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.268 21a2 2 0 0 0 3.464 0" />
        <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8a6 6 0 0 0-12 0c0 4.499-1.411 5.956-2.738 7.326" />
      </svg>
      {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
    </button>
    <span className="notification-announcement" role="status" aria-live="polite">{unread ? `${unread} unread build ${unread === 1 ? 'notification' : 'notifications'}` : ''}</span>
    {expanded && createPortal(<section ref={panel} id={id} role="dialog" aria-label="Notifications" data-overlay="1" data-no-drag="1" className="notification-panel">
      <div className="notification-heading"><span>Notifications</span><div className="notification-actions">
        {visibleNotifications.length > 0 && <button type="button" className="notification-clear-all" onClick={() => clear(visibleNotifications.map((row) => row.id))}>Clear all</button>}
        <button ref={closeButton} type="button" aria-label="Close notifications" onClick={() => close(true)}>×</button>
      </div></div>
      <div className="notification-list">
        {error && <p className="notification-error" role="alert">{error}</p>}
        {!visibleNotifications.length && !error && <p className="notification-empty" role="status">No notifications.</p>}
        {visibleNotifications.map((notification) => {
          const run = items[notification.libraryId]?.run;
          const repo = library.find(row => row.id === notification.libraryId);
          const use = action => { markRead([notification.id]); close(); action(); };
          return <BuildNotification key={notification.id} notification={notification} run={run} sandbox={items[notification.libraryId]?.sandbox ?? null} repo={repo} busy={!!busy[run.id]} onClear={clear}
            onRepository={row => use(() => openRepository(row))} onBuild={row => use(() => openBuild(row, trigger.current))}
            onOpen={value => use(() => openPreview(value))} onTerminal={openTerminal ? value => use(() => openTerminal(value)) : undefined} />;
        })}
      </div>
    </section>, document.body)}
  </div>;
}

export default function SandboxNotifications() {
  const sandboxes = useSandboxes();
  return sandboxes ? <NotificationBell notifications={sandboxes.notifications} items={sandboxes.items} library={sandboxes.library}
    markRead={sandboxes.markNotificationsRead} clearNotifications={sandboxes.clearNotifications} openPreview={sandboxes.open} openTerminal={sandboxes.openTerminal}
    openRepository={sandboxes.openRepository} openBuild={sandboxes.openBuild} busy={sandboxes.busy} error={sandboxes.error} /> : null;
}
