import React from 'react';
import { api, errorMessage } from '../api.js';
import { LEAF } from '../ui/Icons.jsx';
import { useOverleafStatus } from './useOverleafStatus.js';

const muted = { font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' };
const plain = { border: 0, background: 'transparent', cursor: 'pointer' };

export default function OverleafProjects({ onSelected }) {
  const [status] = useOverleafStatus();
  const [list, setList] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const refresh = React.useRef(null);
  const accountId = status?.connected ? status.account.id : '';
  React.useEffect(() => {
    setList(null); setProblem('');
    if (!accountId) return undefined;
    let live = true, pending = false;
    const load = async (force = false) => {
      if (pending) return;
      pending = true; setLoading(true);
      try {
        const value = await api.overleafProjects(force);
        if (live && value.accountId === accountId) { setList(value); setProblem(''); }
      } catch (error) { if (live) setProblem(errorMessage(error)); }
      finally { pending = false; if (live) setLoading(false); }
    };
    refresh.current = load;
    void load();
    const onFocus = () => load();
    const timer = setInterval(() => load(true), 5 * 60 * 1000);
    window.addEventListener('focus', onFocus);
    return () => { live = false; refresh.current = null; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [accountId]);
  React.useEffect(() => { void refresh.current?.(false); }, [status?.updatedAt]);
  if (!accountId) return <div role="status" style={{ ...muted, padding: '4px 10px 8px' }}>{status ? 'Connect Overleaf in Connections.' : 'Checking connection…'}</div>;
  const docs = list?.accountId === accountId ? list.projects : [];
  const error = problem || status.error;
  const open = async doc => {
    try { await api.overleafOpenProject(doc.id); onSelected?.(); } catch (error) { setProblem(errorMessage(error)); }
  };
  return <div data-overleaf-account={accountId}>
    <div>
      {docs.map(doc => <button key={doc.id} type="button" className="hov-wash" data-overleaf-project={doc.id} onClick={() => open(doc)}
        title={`${doc.name}${doc.archived ? " · Archived" : ""}${doc.modifiedTime ? `\nModified ${new Date(doc.modifiedTime).toLocaleString()}` : ''}\nOpens in Stage`}
        style={{ ...plain, display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 6, textAlign: 'left', color: '#171717' }}>
        <span className="glyph-fit" data-document-provider="overleaf" title="Overleaf" aria-hidden="true" style={{ flex: 'none', display: 'flex', width: 14, height: 14 }}><LEAF /></span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.5 var(--font-sans)' }}>{doc.name}</span>
      </button>)}
    </div>
    {!list && loading && <div role="status" style={{ ...muted, padding: '6px 10px' }}>Loading Overleaf projects…</div>}
    {list && !docs.length && <div role="status" style={{ ...muted, padding: '6px 10px' }}>No Overleaf projects yet.</div>}
    {error && <div role="alert" style={{ ...muted, color: 'var(--red-600)', padding: '6px 10px', overflowWrap: 'anywhere' }}>{error}</div>}

  </div>;
}
