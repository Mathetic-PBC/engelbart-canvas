import React from 'react';
import { api, errorMessage } from '../api.js';
import { NOTE } from '../ui/Icons.jsx';
import { useZoteroStatus } from './useZoteroStatus.js';
import ConnectionActions, { ConnectionProgress } from './ConnectionActions.jsx';

const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });
const button = { flex: 'none', padding: '5px 8px', border: 0, borderRadius: 5, background: 'transparent', cursor: 'pointer', ...text(12, '#4d4d4d') };

export function ZoteroConnectionRow({ status, busy, error, onAction }) {
  const connected = !!status?.connected, pending = !!status?.pending;
  const action = pending ? 'cancel' : connected ? 'disconnect' : 'connect';
  const disabled = (!!busy && busy !== 'retry') || !status;
  const problem = error || status?.error;
  const connecting = busy === 'connect' || (pending && (!problem || !!busy || !!status.loading));
  // The connection status and Reconnect button already cover an expired sign-in.
  const showProblem = problem && problem !== 'Sign in to Zotero in Stage, then reconnect to load your papers.';
  return <div data-connection="zotero" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eaeaea' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="glyph-fit" aria-hidden="true" style={{ flex: 'none', display: 'flex', width: 18, height: 18, color: '#4d4d4d' }}><NOTE /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={text(13, '#171717', 500)}>Zotero</div>
        {!connecting && <div role="status" style={{ ...text(11.5, '#8f8f8f'), overflowWrap: 'anywhere' }}>
          {!status ? 'Checking connection…' : busy === 'disconnect' ? 'Disconnecting…' : status.loading ? 'Loading papers…' : pending ? problem ? 'Could not load papers' : 'Waiting for Zotero in Stage…' : connected ? `Connected · ${status.account.name}` : 'Not connected'}
        </div>}
      </div>
      {connected && !pending ? <ConnectionActions provider="zotero" label="Zotero" actionAttribute="data-zotero-action" busy={busy} onAction={onAction} items={[
        { action: 'reopen', label: 'Open Zotero' },
        { action: 'retry', label: 'Refresh papers' },
        { action: 'disconnect', label: 'Disconnect', separator: true },
      ]} /> : pending ? <ConnectionProgress label="Zotero" actionAttribute="data-zotero-action" active={!problem || !!busy || !!status.loading} cancelling={busy === 'cancel'} disabled={disabled} onCancel={() => onAction('cancel')} onReopen={() => onAction('reopen')} reopenDisabled={!!busy} />
        : <button type="button" className="hov-wash" data-zotero-action={action} disabled={disabled} onClick={() => onAction(action)}
        style={{ ...button, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer', ...(!connected && !pending ? { border: '1px solid #eaeaea' } : {}) }}>
        {busy === action ? 'Connecting…' : status?.error ? 'Reconnect' : 'Connect'}
      </button>}
    </div>
    {!connecting && connected && !status.persisted && <p style={{ ...text(11.5, '#8f8f8f'), margin: '8px 0 0' }}>Paper links are kept only until Engelbart quits.</p>}
    {!connecting && showProblem && <p role="alert" style={{ ...text(12, 'var(--red-600)'), margin: '8px 0 0', overflowWrap: 'anywhere' }}>{problem}</p>}
    {!connecting && problem && (pending || connected) && <button type="button" className="hov-wash" data-zotero-action="retry" disabled={!!busy || status.loading} onClick={() => onAction('retry')} style={{ ...button, marginTop: 8, border: '1px solid #dedede' }}>Retry loading papers</button>}
  </div>;
}

export default function ZoteroConnection() {
  const [status] = useZoteroStatus();
  const [busy, setBusy] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const revision = React.useRef(0);
  const act = async action => {
    if (busy && action !== 'cancel' && action !== 'disconnect') return;
    const ticket = ++revision.current;
    setBusy(action); setProblem('');
    try {
      if (action === 'reopen') await api.zoteroReopen();
      else if (action === 'retry') await api.zoteroPapers(true);
      else await ({ connect: api.zoteroConnect, cancel: api.zoteroCancel, disconnect: api.zoteroDisconnect }[action])();
    } catch (error) { if (ticket === revision.current) setProblem(errorMessage(error)); }
    finally { if (ticket === revision.current) setBusy(null); }
  };
  return <ZoteroConnectionRow status={status} busy={busy} error={problem} onAction={act} />;
}
