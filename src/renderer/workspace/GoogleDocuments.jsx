import React from 'react';
import { api, errorMessage } from '../api.js';
import { GOOGLE_DOCS } from '../ui/Icons.jsx';
import { useGoogleStatus } from './useGoogleStatus.js';

const muted = { font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' };
const plain = { border: 0, background: 'transparent', cursor: 'pointer' };
const WEEK = 7 * 24 * 60 * 60 * 1000;

export default function GoogleDocuments({ onSelected }) {
  const [status] = useGoogleStatus();
  const [list, setList] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [problem, setProblem] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const refresh = React.useRef(null);
  const accountId = status?.connected ? status.account.id : '';
  React.useEffect(() => {
    setList(null); setProblem(''); setQuery('');
    if (!accountId) return undefined;
    let live = true, pending = false;
    const load = async (force = false) => {
      if (pending) return;
      pending = true; setLoading(true);
      try {
        const value = await api.googleDocuments(force);
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
  if (!accountId) return <div role="status" style={{ ...muted, padding: '4px 10px 8px' }}>{status ? 'Connect Google Docs in Connections.' : 'Checking connection…'}</div>;
  const docs = list?.accountId === accountId ? list.documents.filter(doc => !doc.modifiedTime && list.dateFiltered || Date.parse(doc.modifiedTime) >= Date.now() - WEEK) : [];
  const shown = docs.filter(doc => doc.name.toLowerCase().includes(query.trim().toLowerCase()));
  const open = async doc => {
    try { await api.googleOpenDocument(doc.id); onSelected?.(); } catch (error) { setProblem(errorMessage(error)); }
  };
  return <div data-google-account={accountId}>
    {(docs.length > 8 || query) && <input aria-label="Search Google Docs" placeholder="Search Google Docs" value={query} onChange={event => setQuery(event.target.value)}
      style={{ width: 'calc(100% - 20px)', boxSizing: 'border-box', margin: '4px 10px', padding: '5px 8px', border: '1px solid #eaeaea', borderRadius: 6, font: '13px/1.5 var(--font-sans)' }} />}
    <div>
      {shown.map(doc => <button key={doc.id} type="button" className="hov-wash" data-google-doc={doc.id} onClick={() => open(doc)}
        title={`${doc.name}${doc.modifiedTime ? `\nModified ${new Date(doc.modifiedTime).toLocaleString()}` : ''}\nOpens in Stage`}
        style={{ ...plain, display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '6px 8px', minHeight: 32, borderRadius: 6, textAlign: 'left', color: '#3d3d3d' }}>
        <span className="glyph-fit" data-document-provider="google-docs" title="Google Docs" aria-hidden="true" style={{ flex: 'none', display: 'flex', width: 14, height: 14 }}><GOOGLE_DOCS /></span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '400 14px/20px var(--font-sans)' }}>{doc.name}</span>
      </button>)}
    </div>
    {!list && loading && <div role="status" style={{ ...muted, padding: '6px 10px' }}>Loading Google Docs…</div>}
    {list && !shown.length && <div role="status" style={{ ...muted, padding: '6px 10px' }}>{query ? 'No matching documents.' : 'No Google Docs modified in the past 7 days.'}</div>}
    {(problem || status.error) && <div role="alert" style={{ ...muted, color: 'var(--red-600)', padding: '6px 10px', overflowWrap: 'anywhere' }}>{problem || status.error}</div>}
    {list?.incomplete && <div style={{ ...muted, padding: '6px 10px' }}>Some Drive rows could not be loaded. Open Google Drive in Connections to see the full list.</div>}
  </div>;
}
