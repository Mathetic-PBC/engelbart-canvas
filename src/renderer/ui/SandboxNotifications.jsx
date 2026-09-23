import React from 'react';
import { createPortal } from 'react-dom';
import { useSandboxes } from './SandboxProgress.jsx';
import './sandbox-notifications.css';

export function NotificationBell({ notifications, items, library, markRead, openPreview }) {
  const [expanded, setExpanded] = React.useState(false);
  const trigger = React.useRef(null);
  const panel = React.useRef(null);
  const closeButton = React.useRef(null);
  const id = React.useId();
  const unread = notifications.filter((row) => !row.read).length;
  const close = (restoreFocus = false) => {
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
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
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [expanded]);
  React.useEffect(() => {
    if (expanded && unread) markRead(notifications.filter((row) => !row.read).map((row) => row.id));
  }, [expanded, unread, notifications, markRead]);
  return <div className="notification-control window-no-drag">
    <button ref={trigger} type="button" className="notification-bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      title="Notifications" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      onClick={() => setExpanded((value) => !value)}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.268 21a2 2 0 0 0 3.464 0" />
        <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8a6 6 0 0 0-12 0c0 4.499-1.411 5.956-2.738 7.326" />
      </svg>
      {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
    </button>
    <span className="notification-announcement" role="status" aria-live="polite">{unread ? `${unread} unread preview ${unread === 1 ? 'notification' : 'notifications'}` : ''}</span>
    {expanded && createPortal(<section ref={panel} id={id} role="dialog" aria-label="Notifications" data-overlay="1" className="notification-panel window-no-drag">
      <div className="notification-heading"><span>Notifications</span><button ref={closeButton} type="button" aria-label="Close notifications" onClick={() => close(true)}>×</button></div>
      <div className="notification-list">
        {!notifications.length && <p className="notification-empty">No notifications yet.</p>}
        {notifications.map((notification) => {
          const run = items[notification.libraryId]?.run;
          const available = run?.id === notification.runId && run.status === 'ready' && !!run.preview_url;
          const name = library.find((row) => row.id === notification.libraryId)?.name || 'Repository';
          return <button key={notification.id} type="button" className="notification-entry" disabled={!available}
            aria-label={available ? `Open live preview for ${name}` : `Preview no longer available for ${name}`}
            onClick={() => { markRead([notification.id]); close(); openPreview(run); }}>
            <span className="notification-repo">{name}</span>
            <span className="notification-description">{available ? 'Preview ready' : 'Preview no longer available'}{available && <span className="notification-open">Open live ↗</span>}</span>
          </button>;
        })}
      </div>
    </section>, document.body)}
  </div>;
}

export default function SandboxNotifications() {
  const sandboxes = useSandboxes();
  return sandboxes ? <NotificationBell notifications={sandboxes.notifications} items={sandboxes.items} library={sandboxes.library}
    markRead={sandboxes.markNotificationsRead} openPreview={sandboxes.open} /> : null;
}
