import React from 'react';
import { createPortal } from 'react-dom';
import { useSandboxes } from './SandboxProgress.jsx';
import { availableBuildNotifications } from '../model/sandbox-notifications.js';
import { localBuildKey, OPEN_LOCAL_BUILD_NOTIFICATION } from '../model/local-build-notifications.js';
import LocalPreview from '../workspace/LocalPreview.jsx';
import './sandbox-notifications.css';

export function BuildNotification({ notification, run, repo, busy, onRepository, onBuild, onOpen, onClear }) {
  const name = repo?.name || 'Repository';
  const building = run.status === 'starting', failed = run.status === 'failed';
  const canOpen = run.status === 'ready' && !!run.preview_url;
  const visit = event => { event.preventDefault(); onRepository(repo); };
  return <div className="notification-row" data-build-status={run.status}>
    <div className="notification-entry">
      <div className="notification-copy">
        {repo?.url ? <a className="notification-repo" href={repo.url} aria-label={`Open ${name} on GitHub in Stage`} onClick={visit}
          onAuxClick={event => { if (event.button === 1) visit(event); }}>{name}</a> : <span className="notification-repo">{name}</span>}
        {!building && <button type="button" className="notification-description" aria-label={`${failed ? 'Build failed' : 'Build finished'} — view build details for ${name}`} aria-haspopup="dialog" disabled={!repo || !onBuild}
          onClick={() => onBuild(repo)}>{failed ? 'Build failed' : 'Build finished'}</button>}
        {failed && run.error && <span className="notification-detail">{run.error}</span>}
        {run.status === 'ready' && !canOpen && <span className="notification-detail">No web preview</span>}
      </div>
      {(building || canOpen) && <div className="notification-run-actions">
        {building && <button type="button" className="notification-build" aria-label={`View build details for ${name}`} aria-haspopup="dialog" disabled={!repo || !onBuild}
          onClick={() => onBuild(repo)}>Building…</button>}
        {canOpen && <button type="button" className="notification-open" aria-label={`Open live preview for ${name}`} disabled={busy} onClick={() => onOpen(run)}>Open live ↗</button>}
      </div>}
    </div>
    <button type="button" className="notification-dismiss" aria-label={`Clear notification for ${name}`} title="Clear notification" onClick={() => onClear([notification.id])}>×</button>
  </div>;
}

export function NotificationBell({ notifications, items, library, markRead, clearNotifications, openPreview, openRepository, openBuild, busy = {}, error, localBuilds }) {
  const [expanded, setExpanded] = React.useState(false);
  const trigger = React.useRef(null);
  const panel = React.useRef(null);
  const closeButton = React.useRef(null);
  const id = React.useId();
  const visibleNotifications = React.useMemo(() => availableBuildNotifications(notifications, items), [notifications, items]);
  const locals = localBuilds?.rows || [];
  const localUnread = locals.map(localBuildKey).filter(key => !localBuilds.read.includes(key));
  const unread = visibleNotifications.filter((row) => !row.read).length + localUnread.length;
  React.useEffect(() => {
    const show = () => setExpanded(true);
    window.addEventListener(OPEN_LOCAL_BUILD_NOTIFICATION, show);
    return () => window.removeEventListener(OPEN_LOCAL_BUILD_NOTIFICATION, show);
  }, []);
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
      if (localUnread.length) localBuilds.markRead(localUnread);
    }
  }, [expanded, unread, visibleNotifications, markRead, localUnread.join('|'), localBuilds?.markRead]);
  return <div className="notification-control window-no-drag">
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
    {expanded && createPortal(<section ref={panel} id={id} role="dialog" aria-label="Notifications" data-overlay="1" className="notification-panel window-no-drag">
      <div className="notification-heading"><span>Notifications</span><div className="notification-actions">
        {(visibleNotifications.length > 0 || locals.length > 0) && <button type="button" className="notification-clear-all" onClick={() => { clear(visibleNotifications.map((row) => row.id)); localBuilds?.clear(locals.map(localBuildKey)); }}>Clear all</button>}
        <button ref={closeButton} type="button" aria-label="Close notifications" onClick={() => close(true)}>×</button>
      </div></div>
      <div className="notification-list">
        {error && <p className="notification-error" role="alert">{error}</p>}
        {localBuilds?.errors.all && <p className="notification-error" role="alert">{localBuilds.errors.all}</p>}
        {!visibleNotifications.length && !locals.length && !error && !localBuilds?.errors.all && <p className="notification-empty" role="status">No notifications.</p>}
        {locals.map(preview => <div key={preview.id} className="notification-row notification-local" data-local-notification={preview.id}>
          <LocalPreview state={{ preview, working: localBuilds.busy[preview.id], error: localBuilds.errors[preview.id], act: action => localBuilds.act(preview, action) }} onOpen={value => { close(); localBuilds.open(value); }} />
          <button type="button" className="notification-dismiss" aria-label={`Clear notification for ${preview.name}`} onClick={() => localBuilds.clear([localBuildKey(preview)])}>×</button>
        </div>)}
        {visibleNotifications.map((notification) => {
          const run = items[notification.libraryId]?.run;
          const repo = library.find(row => row.id === notification.libraryId);
          const use = action => { markRead([notification.id]); close(); action(); };
          return <BuildNotification key={notification.id} notification={notification} run={run} repo={repo} busy={!!busy[run.id]} onClear={clear}
            onRepository={row => use(() => openRepository(row))} onBuild={row => use(() => openBuild(row, trigger.current))}
            onOpen={value => use(() => openPreview(value))} />;
        })}
      </div>
    </section>, document.body)}
  </div>;
}

export default function SandboxNotifications() {
  const sandboxes = useSandboxes();
  return sandboxes ? <NotificationBell notifications={sandboxes.notifications} items={sandboxes.items} library={sandboxes.library}
    markRead={sandboxes.markNotificationsRead} clearNotifications={sandboxes.clearNotifications} openPreview={sandboxes.open}
    openRepository={sandboxes.openRepository} openBuild={sandboxes.openBuild} busy={sandboxes.busy} error={sandboxes.error} localBuilds={sandboxes.localBuilds} /> : null;
}
