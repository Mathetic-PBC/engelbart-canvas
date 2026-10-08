import React from 'react';
import { api, errorMessage } from '../api.js';
import Button from '../ui/Button.jsx';
import ThinkingDots from '../ui/ThinkingDots.jsx';
import { GH, SEARCH } from '../ui/Icons.jsx';
import { useGithubStatus } from './useGithubStatus.js';

// Onboarding's "Add to your library", part 2a (2026-09-28), shared since 2026-10-07 with Connect your library's Code
// source: "for github the UI should change to step 3 instead of" the cramped list the Connect window had. Same rows,
// spacing and search wherever it is shown.

const riseSub = 'rise 220ms cubic-bezier(.25,.1,.25,1)';
const plain = { padding: 0, border: 0, background: 'none', cursor: 'pointer' };
const faint = { font: 'italic 13px/1.5 var(--font-sans)', color: '#8f8f8f' };

function Glyph({ children, size = 16, color = '#4d4d4d' }) {
  return <span className="glyph-fit" aria-hidden="true" style={{ flex: 'none', width: size, height: size, display: 'flex', color }}>{children}</span>;
}

/**
 * The GitHub repositories the app's own sign-in (src/main/github) can read, a tick per repository: signing in, waiting for
 * GitHub, then the list with its search. `held(repo)` says whether one is ticked, `onToggle(repo)` ticks or unticks it,
 * `busyId` the one being added or removed. Fills its parent's height (it scrolls inside).
 */
export default function GithubRepos({ held, onToggle, busyId }) {
  const [status, setStatus] = useGithubStatus();
  const [starting, setStarting] = React.useState(false);
  const [problem, setProblem] = React.useState('');
  const [list, setList] = React.useState(null);
  const [q, setQ] = React.useState('');
  const connected = !!(status && status.connected);

  const load = React.useCallback(() => {
    api.githubRepos().then((value) => { setList(value.repos || []); setProblem(''); }).catch((error) => { setList([]); setProblem(errorMessage(error)); });
  }, []);
  React.useEffect(() => {
    if (!connected) { setList(null); return undefined; }
    load();
    window.addEventListener('focus', load); // an install on GitHub may have added repositories
    return () => window.removeEventListener('focus', load);
  }, [connected, load]);

  const connect = async () => {
    setStarting(true);
    setProblem('');
    try { setStatus(await api.githubConnect()); } catch (error) { setProblem(errorMessage(error)); } finally { setStarting(false); }
  };

  const error = problem || (status && status.error) || '';
  const pending = status && !connected && status.pending;
  if (!status) return <div style={{ flex: 1 }} />;
  if (!status.configured) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', font: '13px/1.6 var(--font-sans)', color: '#e70022' }}>{problem || 'GitHub is not set up in this build.'}</div>;
  if (!connected && (pending || starting)) {
    return (
      <div data-github-pane="code" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, animation: riseSub }}>
        <ThinkingDots label="waiting for GitHub" />
        {pending && (
          <div style={{ display: 'flex', gap: 14 }}>
            <button type="button" className="hov-ink" onClick={() => api.githubOpen('device').catch((failure) => setProblem(errorMessage(failure)))} style={{ ...plain, font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Open browser again</button>
            <button type="button" className="hov-ink" data-github-cancel="1" onClick={() => api.githubCancel().then(setStatus).catch((failure) => setProblem(errorMessage(failure)))} style={{ ...plain, font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Cancel</button>
          </div>
        )}
      </div>
    );
  }
  if (!connected) {
    return (
      <div data-github-pane="signed-out" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center', animation: riseSub }}>
        <span style={{ maxWidth: 300, font: '13.5px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>Sign in to choose which repositories Engelbart can read.</span>
        <span data-github-signin="1"><Button variant="filled" onClick={connect}>Sign in with GitHub</Button></span>
        {error && <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</span>}
      </div>
    );
  }
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (list || []).filter((repo) => { const hay = `${repo.fullName} ${repo.description || ''}`.toLowerCase(); return words.every((word) => hay.includes(word)); });
  return (
    <div data-github-pane="repos" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', animation: riseSub }}>
      <div style={{ flex: 'none', padding: '10px 0 6px' }}>
        <div className="focus-bd2" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8 }}>
          <Glyph size={14} color="#8f8f8f"><SEARCH /></Glyph>
          <input value={q} onChange={(event) => setQ(event.target.value)} autoFocus placeholder="search repositories…" spellCheck={false} data-github-search="1" style={{ flex: 1, minWidth: 0, padding: '7px 0', border: 0, background: 'transparent', font: '13.5px/1.4 var(--font-sans)', color: '#171717' }} />
        </div>
      </div>
      <div data-github-repos="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '0 0 4px', margin: '0 -10px' }}>
        {!list && <span style={{ padding: 10, ...faint }}>…</span>}
        {rows.map((repo) => {
          const on = !!held(repo);
          return (
            <button key={repo.id} type="button" className="hov-ink-wash" data-github-repo={repo.fullName} data-on={on ? '1' : '0'} disabled={busyId === repo.id} onClick={() => onToggle(repo)} title={repo.description || repo.fullName} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 10px', textAlign: 'left', background: 'transparent', border: 0, borderRadius: 6, cursor: 'pointer' }}>
              <Glyph size={14} color="#8f8f8f"><GH /></Glyph>
              <span style={{ flex: 1, minWidth: 0, font: '13.5px/1.4 var(--font-sans)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#8f8f8f' }}>{repo.owner}/</span><span style={{ color: '#171717' }}>{repo.fullName.slice(repo.owner.length + 1)}</span></span>
              {repo.private && <span aria-label="private" style={{ flex: 'none', display: 'flex', color: '#8f8f8f', opacity: 0.8 }}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="7.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg></span>}
              <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: on ? '#1f9d55' : 'transparent', color: '#fff', font: '600 10px/1 var(--font-sans)' }}>{on ? '✓' : ''}</span>
            </button>
          );
        })}
        {list && !rows.length && <span style={{ padding: 10, ...faint }}>no repositories match…</span>}
        {error && <span style={{ padding: '6px 10px', font: '12.5px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</span>}
      </div>
    </div>
  );
}
