import React from 'react';
import { api, errorMessage } from '../api.js';
import { GH } from '../ui/Icons.jsx';
import { useGithubStatus } from './useGithubStatus.js';

const plain = { padding: 0, border: 0, background: 'transparent', cursor: 'pointer' };
const muted = { font: '400 12px/1.5 var(--font-sans)', color: '#8f8f8f' };

export function GithubRepositoryResults({ repos, query, onOpen }) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const shown = repos.filter(repo => words.every(word => (repo.fullName + ' ' + (repo.description || '')).toLowerCase().includes(word)));
  return <div data-github-account-repos="1">
    {shown.map(repo => <button key={repo.id} type="button" className="hov-wash" data-github-account-repo={repo.fullName} onClick={() => onOpen(repo)} title={repo.description ? repo.fullName + '\n' + repo.description : repo.fullName}
      style={{ ...plain, display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 6, textAlign: 'left', color: '#171717' }}>
      <span aria-hidden="true" className="glyph-fit" style={{ display: 'flex', flex: 'none', width: 15, height: 15, color: '#737373' }}><GH /></span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span data-github-repo-name="1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '500 13px/1.4 var(--font-sans)' }}>{repo.fullName.split('/').slice(1).join('/')}</span>
        <span data-github-repo-owner="1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '400 11.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{repo.owner || repo.fullName.split('/')[0]}</span>
      </span>
      {repo.private && <svg role="img" aria-label="Private repository" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ flex: 'none', color: '#8f8f8f' }}><rect x="3" y="7" width="10" height="7.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>}
    </button>)}
    {!shown.length && <div role="status" style={{ ...muted, padding: '12px 8px' }}>{query.trim() ? 'No matching repositories.' : 'No repositories shared with Engelbart yet.'}</div>}
  </div>;
}

// Account repositories load only when their source browser is explicitly opened.
export default function GithubRepositories({ onOpen, onSelected }) {
  const [status] = useGithubStatus();
  const [catalog, setCatalog] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const [query, setQuery] = React.useState('');
  const login = status?.connected ? status.login : '';
  React.useEffect(() => {
    if (!login) return undefined;
    let live = true, pending = false, revision = 0;
    const load = async () => {
      if (pending) return;
      pending = true;
      const ticket = ++revision;
      try {
        const value = await api.githubRepos();
        if (live && ticket === revision) { setCatalog({ login, repos: value.repos }); setProblem(''); }
      } catch (error) { if (live && ticket === revision) setProblem(errorMessage(error)); }
      finally { pending = false; }
    };
    const refreshed = event => {
      if (event.detail?.login !== login) return;
      revision++;
      setCatalog({ login, repos: event.detail.repos }); setProblem('');
    };
    setQuery(''); setProblem(''); void load();
    window.addEventListener('focus', load);
    window.addEventListener('engelbart:github-repos', refreshed);
    return () => { live = false; window.removeEventListener('focus', load); window.removeEventListener('engelbart:github-repos', refreshed); };
  }, [login]);
  if (!login) return <div role="status" style={{ ...muted, padding: '4px 10px 8px' }}>{status ? 'Connect GitHub in Connections.' : 'Checking connection…'}</div>;
  const list = catalog?.login === login ? catalog.repos : null;
  const pick = async repo => {
    try { await onOpen(repo); onSelected?.(); } catch (error) { setProblem(errorMessage(error)); }
  };
  return <div data-github-account={login}>
    {(list?.length > 8 || query) && <input aria-label="Search repositories" placeholder="Search repositories" value={query} onChange={event => setQuery(event.target.value)}
      style={{ width: 'calc(100% - 16px)', boxSizing: 'border-box', margin: '4px 8px', padding: '5px 8px', border: '1px solid #eaeaea', borderRadius: 6, font: '13px/1.5 var(--font-sans)' }} />}
    <div data-github-repository-section="1">
      {list && <GithubRepositoryResults repos={list} query={query} onOpen={pick} />}
      {!list && !problem && <div role="status" style={{ ...muted, padding: '8px' }}>Loading repositories…</div>}
      {problem && <div role="alert" style={{ ...muted, color: 'var(--red-600)', padding: 8, overflowWrap: 'anywhere' }}>{problem}</div>}
    </div>
  </div>;
}
