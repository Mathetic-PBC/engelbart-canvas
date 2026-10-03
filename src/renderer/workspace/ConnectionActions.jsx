import React from 'react';
import { usePlaced } from '../ui/usePlaced.js';

// An account's controls in Connections (./Connections.jsx): while its sign-in waits, a spinner with "open the sign-in page
// again" and "cancel"; once connected, a ⋯ menu of what can be done with it. Every page opens in the default browser.

const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });
const button = { flex: 'none', padding: '5px 8px', border: 0, borderRadius: 5, background: 'transparent', cursor: 'pointer', ...text(12, '#4d4d4d') };

export function ConnectionProgress({ label, actionAttribute = 'data-connection-action', active = true, cancelling, disabled, onCancel, onReopen, reopenDisabled }) {
  return <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
    {active && <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', ...text(11.5, '#8f8f8f') }}>
      <svg className="connection-spinner" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ flex: 'none' }}><path d="M14 8a6 6 0 1 1-6-6" /></svg>
      {cancelling ? 'Cancelling…' : 'Connecting…'}
    </span>}
    <button type="button" className="hov-wash" {...{ [actionAttribute]: 'reopen' }} aria-label={`Open ${label} sign-in in your browser`} title="Open sign-in in your browser" disabled={reopenDisabled} onClick={onReopen}
      style={{ ...button, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, padding: 0, opacity: reopenDisabled ? 0.5 : 1, cursor: reopenDisabled ? 'default' : 'pointer' }}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2h5v5M14 2 7 9M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" /></svg>
    </button>
    <button type="button" className="hov-wash" {...{ [actionAttribute]: 'cancel' }} aria-label={`Cancel ${label} connection`} title="Cancel connection" disabled={disabled} onClick={onCancel}
      style={{ ...button, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, padding: 0, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="m4 4 8 8M12 4l-8 8" /></svg>
    </button>
  </div>;
}

export default function ConnectionActions({ provider, label, items, actionAttribute = 'data-connection-action', busy, onAction }) {
  const [anchor, setAnchor] = React.useState(null);
  const triggerRef = React.useRef(null);
  const focusLast = React.useRef(false);
  const id = React.useId();
  const [menuRef, placed] = usePlaced(anchor, { gap: 4, align: 'end' });
  const open = !!anchor;
  const close = (restoreFocus = false) => { setAnchor(null); if (restoreFocus) triggerRef.current?.focus(); };
  React.useEffect(() => {
    if (!open) return undefined;
    const away = event => { if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close(); };
    const reposition = () => setAnchor(triggerRef.current.getBoundingClientRect());
    document.addEventListener('mousedown', away, true);
    document.addEventListener('focusin', away);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('focusin', away);
      window.removeEventListener('resize', reposition);
    };
  }, [open, menuRef]);
  React.useEffect(() => {
    if (!open || placed.visibility === 'hidden') return;
    const items = menuRef.current?.querySelectorAll('button:not(:disabled)');
    items?.[focusLast.current ? items.length - 1 : 0]?.focus();
  }, [open, placed.visibility, menuRef]);
  const show = (last = false) => { focusLast.current = last; setAnchor(triggerRef.current.getBoundingClientRect()); };
  const select = action => { if (busy) return; close(true); onAction(action); };
  const onKeyDown = event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.target === triggerRef.current && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(event.key === 'ArrowUp'); }
    else if (menuRef.current?.contains(event.target)) {
      const items = [...menuRef.current.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === 'Tab') close(true);
    }
  };
  const menuButton = { ...button, display: 'block', width: '100%', padding: '7px 10px', textAlign: 'left', ...text(12.5) };
  return <div style={{ flex: 'none' }} onKeyDown={onKeyDown}>
    <button ref={triggerRef} type="button" className="hov-wash" {...{ [`data-${provider}-actions`]: '1' }} aria-label={`${label} connection options`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={!!busy} onClick={() => open ? close() : show()}
      style={{ ...button, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, opacity: busy ? 0.5 : 1, background: open ? '#f2f2f2' : 'transparent' }}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block', flex: 'none' }}>
        <circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" />
      </svg>
    </button>
    {open && <div id={id} ref={menuRef} role="menu" aria-label={`${label} connection options`} {...{ [`data-${provider}-actions-menu`]: '1' }} data-overlay="1"
      style={{ ...placed, zIndex: 81, width: 184, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', padding: 4, border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', boxShadow: '0 4px 16px #0000000a' }}>
      {items.map(item => <React.Fragment key={item.action}>
        {item.separator && <div role="separator" style={{ borderTop: '1px solid #eaeaea', margin: '4px 0' }} />}
        <button type="button" role="menuitem" className="hov-wash" {...{ [actionAttribute]: item.action }} disabled={!!busy} onClick={() => select(item.action)} style={menuButton}>{item.label}</button>
      </React.Fragment>)}
    </div>}
  </div>;
}
