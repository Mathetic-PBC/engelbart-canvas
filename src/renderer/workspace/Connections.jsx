import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { GH } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import { useGithubStatus } from './useGithubStatus.js';
import GoogleConnection from './GoogleConnection.jsx';
import ZoteroConnection from './ZoteroConnection.jsx';
import OverleafConnection from './OverleafConnection.jsx';
import ConnectionActions, { ConnectionProgress } from './ConnectionActions.jsx';

const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });
const button = { flex: 'none', padding: '5px 8px', border: 0, borderRadius: 5, background: 'transparent', cursor: 'pointer', ...text(12, '#4d4d4d') };

// Account controls only. Repository browsing and imports live elsewhere in the sidebar.
export function GithubConnection({ status, busy, error, onAction }) {
  const connected = !!status?.connected;
  const pending = !connected && status?.pending;
  const problem = error || status?.error || '';
  const connecting = busy === 'connect' || (pending && (!problem || !!busy));
  const description = !status ? 'Checking connection…' : connected && busy === 'disconnect' ? 'Disconnecting…' : connected && busy === 'refresh' ? 'Refreshing repositories…' : connected ? `Connected${status.login ? ` · @${status.login}` : ''}`
    : pending ? 'Waiting for sign-in…' : !status.configured ? 'Not configured' : 'Not connected';
  const action = pending ? 'cancel' : 'connect';
  const label = status?.error ? 'Reconnect' : 'Connect';
  const disabled = !!busy || !status || (!status.configured && !connected && !pending);
  return <div data-connection="github">
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="glyph-fit" style={{ flex: 'none', display: 'flex', width: 18, height: 18, color: '#4d4d4d' }}><GH /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...text(13, '#171717', 500), display: 'flex', alignItems: 'center', gap: 6 }}>GitHub
          {pending?.userCode && <button type="button" className="hov-wash" data-connection-action="copy" aria-label="Copy sign-in code" title="Copy sign-in code" disabled={!!busy} onClick={() => onAction('copy')} style={{ ...button, padding: '2px 0', font: '11px/1.4 var(--font-mono)' }}>{pending.userCode}</button>}
        </div>
        {!connecting && <div role="status" style={{ ...text(11.5, '#8f8f8f'), overflowWrap: 'anywhere' }}>{description}</div>}
      </div>
      {connected ? <ConnectionActions provider="github" label="GitHub" busy={busy} onAction={onAction} items={[
        ...(status.installUrl ? [{ action: 'manage', label: 'Repository access' }] : []),
        { action: 'refresh', label: 'Refresh repositories' },
        { action: 'disconnect', label: 'Disconnect', separator: true },
      ]} /> : pending ? <ConnectionProgress label="GitHub" active={!problem || !!busy} cancelling={busy === 'cancel'} disabled={disabled} onCancel={() => onAction('cancel')} onReopen={() => onAction('reopen')} reopenDisabled={!!busy} />
        : <button type="button" className="hov-wash" data-connection-action={action} disabled={disabled} onClick={() => onAction(action)}
        style={{ ...button, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer', ...(!connected && !pending ? { border: '1px solid #eaeaea' } : {}) }}>
        {busy === action ? (action === 'connect' ? 'Connecting…' : 'Cancelling…') : label}
      </button>}
    </div>
    {connected && status.persisted === false && <p style={{ ...text(11.5, '#8f8f8f'), margin: '8px 0 0' }}>Connected until Engelbart quits.</p>}
    {status && !status.configured && !connected && <p style={{ ...text(12, '#8f8f8f'), margin: '10px 0 0' }}>GitHub sign-in isn’t configured.</p>}
    {!connecting && problem && <p role="alert" style={{ ...text(12, 'var(--red-600)'), margin: '10px 0 0', overflowWrap: 'anywhere' }}>{problem}</p>}
  </div>;
}

function ConnectionsPanel({ id, anchor, triggerRef, onClose }) {
  const [status, setStatus] = useGithubStatus();
  const [busy, setBusy] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [ref, placed] = usePlaced(anchor, { gap: 6, cap: 400 });
  const [, remeasure] = React.useReducer(value => value + 1, 0);
  React.useLayoutEffect(() => {
    // Google renders its async states independently of this parent. Reposition
    // and cap the panel when sign-in instructions or retry controls change size.
    const observer = new ResizeObserver(() => remeasure());
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  const focused = React.useRef(false);
  React.useEffect(() => {
    if (!focused.current && placed.visibility !== 'hidden' && ref.current) {
      focused.current = true;
      ref.current.focus({ preventScroll: true });
    }
  }, [placed.visibility, ref]);
  React.useEffect(() => {
    const away = event => { if (!ref.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose(); };
    const key = event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(true); } };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('focusin', away);
    // A nested options menu handles Escape first, before the enclosing panel.
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('focusin', away);
      document.removeEventListener('keydown', key);
    };
  }, [onClose, ref, triggerRef]);
  const act = async action => {
    if (busy) return;
    setBusy(action); setProblem(''); setNotice('');
    try {
      if (action === 'connect') setStatus(await api.githubConnect());
      else if (action === 'disconnect') setStatus(await api.githubDisconnect());
      else if (action === 'cancel') setStatus(await api.githubCancel());
      else if (action === 'copy') await api.copyText(status.pending.userCode);
      else if (action === 'refresh') {
        const value = await api.githubRepos();
        window.dispatchEvent(new CustomEvent('engelbart:github-repos', { detail: { login: status.login, repos: value.repos } }));
        setStatus(await api.githubStatus()); setNotice('Repositories refreshed.');
      }
      else await api.githubOpen(action === 'manage' ? 'install' : 'device');
    } catch (error) { setProblem(errorMessage(error)); }
    finally { setBusy(null); }
  };
  return createPortal(<div id={id} ref={ref} role="dialog" aria-label="Connections" tabIndex={-1} data-overlay="1" data-connections-panel="1"
    style={{ ...placed, zIndex: 80, width: 320, maxWidth: 'calc(100vw - 16px)', padding: 12, boxSizing: 'border-box', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, outline: 'none' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <span style={text(13, '#171717', 500)}>Connections</span>
      <button type="button" className="hov-wash" aria-label="Close connections" onClick={() => onClose(true)} style={{ ...button, width: 24, height: 24, padding: 0, fontSize: 18, lineHeight: 1 }}>×</button>
    </div>
    <GithubConnection status={status} busy={busy} error={problem} onAction={act} />
    {notice && status?.connected && <div role="status" data-connection-notice="1" style={{ ...text(11.5, '#8f8f8f'), margin: '6px 0 0 28px' }}>{notice}</div>}
    <GoogleConnection />
    <OverleafConnection />
    <ZoteroConnection />

  </div>, document.body);
}

// Kept outside the material scroller: accounts belong to the app, not this workspace.
export default function Connections({ onOpenChange, shut, compact = false }) {
  const [anchor, setAnchor] = React.useState(null);
  const triggerRef = React.useRef(null);
  const id = React.useId();
  const open = !!anchor;
  const close = React.useCallback((restoreFocus = false) => {
    setAnchor(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  React.useEffect(() => { onOpenChange(open); }, [open, onOpenChange]);
  React.useEffect(() => { if (shut) close(); }, [shut, close]);
  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => setAnchor(triggerRef.current.getBoundingClientRect());
    const observer = new ResizeObserver(measure);
    observer.observe(triggerRef.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [open]);
  return <div data-rail-connections="1" style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
    <button ref={triggerRef} type="button" className="hov-ink-wash" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setAnchor(triggerRef.current.getBoundingClientRect())}
      style={{ position: 'relative', top: 4, display: 'flex', alignItems: 'center', gap: 8, maxWidth: '100%', padding: compact ? '7px 2px 7px 8px' : '9px 2px 9px 8px', border: 0, borderRadius: 6, background: open ? '#f2f2f2' : 'transparent', cursor: 'pointer', textAlign: 'left', ...text(compact ? 13 : 14, open ? '#171717' : '#8f8f8f') }}>
      <svg aria-hidden="true" width={compact ? 16 : 18} height={compact ? 16 : 18} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
        <path d="M5.5 1.5v3M10.5 1.5v3M4 4.5h8v2a4 4 0 0 1-8 0zM8 10.5v2a2 2 0 0 1-2 2H4" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Connections</span>
    </button>
    {open && <ConnectionsPanel id={id} anchor={anchor} triggerRef={triggerRef} onClose={close} />}
  </div>;
}
