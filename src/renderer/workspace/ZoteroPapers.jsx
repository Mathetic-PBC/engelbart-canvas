import React from 'react';
import { api, errorMessage } from '../api.js';
import { NOTE } from '../ui/Icons.jsx';
import { useZoteroStatus } from './useZoteroStatus.js';

const muted = { font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' };
const plain = { border: 0, background: 'transparent', cursor: 'pointer' };

export default function ZoteroPapers({ onSelected }) {
  const [status] = useZoteroStatus();
  const [list, setList] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [problem, setProblem] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const refresh = React.useRef(null);
  const accountId = status?.connected ? status.account.id : '';
  React.useEffect(() => { setList(null); setQuery(''); }, [accountId]);
  React.useEffect(() => {
    setProblem('');
    if (!accountId) return undefined;
    let live = true, pending = false;
    const load = async (force = false) => {
      if (pending) return;
      pending = true; setLoading(true);
      try {
        const value = await api.zoteroPapers(force);
        if (live && value.accountId === accountId) { setList(value); setProblem(''); }
      } catch (error) { if (live) setProblem(errorMessage(error)); }
      finally { pending = false; if (live) setLoading(false); }
    };
    refresh.current = () => load(true);
    void load();
    const onFocus = () => load();
    const timer = setInterval(() => load(true), 5 * 60 * 1000);
    window.addEventListener('focus', onFocus);
    return () => { live = false; refresh.current = null; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [accountId, status?.updatedAt]);
  if (!accountId) return <div role="status" style={{ ...muted, padding: '4px 10px 8px' }}>{status ? 'Connect Zotero in Connections.' : 'Checking connection…'}</div>;
  const docs = list?.accountId === accountId ? list.papers : [];
  const shown = docs.filter(doc => [doc.name, doc.authors, doc.date].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const open = async doc => {
    try { await api.zoteroOpenPaper(doc.id); onSelected?.(); } catch (error) { setProblem(errorMessage(error)); }
  };
  return <div data-zotero-account={accountId}>
    {(docs.length > 8 || query) && <input aria-label="Search Zotero" placeholder="Search Zotero" value={query} onChange={event => setQuery(event.target.value)}
      style={{ width: 'calc(100% - 20px)', boxSizing: 'border-box', margin: '4px 10px', padding: '5px 8px', border: '1px solid #eaeaea', borderRadius: 6, font: '13px/1.5 var(--font-sans)' }} />}
    <div>
      {shown.map(doc => <button key={doc.id} type="button" className="hov-wash" data-zotero-paper={doc.id} onClick={() => open(doc)}
        title={`${doc.name}${doc.authors ? `\n${doc.authors}${doc.date ? ` · ${doc.date}` : ''}` : ''}\nOpens in Stage`}
        style={{ ...plain, display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 6, textAlign: 'left', color: '#171717' }}>
        <span className="glyph-fit" aria-hidden="true" style={{ flex: 'none', display: 'flex', width: 14, height: 14 }}><NOTE /></span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.5 var(--font-sans)' }}>{doc.name}</span>
      </button>)}
    </div>
    {!list && loading && <div role="status" style={{ ...muted, padding: '6px 10px' }}>Loading papers…</div>}
    {list && !shown.length && <div role="status" style={{ ...muted, padding: '6px 10px' }}>{query ? 'No matching papers.' : 'No papers in your Zotero library yet.'}</div>}
    {problem && <div role="alert" style={{ ...muted, color: 'var(--red-600)', padding: '6px 10px', overflowWrap: 'anywhere' }}>{problem}</div>}
    {list?.incomplete && <div style={{ ...muted, padding: '6px 10px' }}>Showing the first 10,000 library items. Open Zotero to browse the full library.</div>}
    {problem && <button type="button" className="hov-ink" data-zotero-retry="1" disabled={loading} onClick={() => refresh.current?.()}
      style={{ ...plain, ...muted, padding: '4px 10px 6px', opacity: loading ? 0.5 : 1 }}>Retry</button>}
  </div>;
}
