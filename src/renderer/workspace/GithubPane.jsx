import React from 'react';
import { api, errorMessage } from '../api.js';
import { KIND } from '../ui/Icons.jsx';
import { githubRows } from '../model/github.js';

// The + menu's "Add from GitHub…" (2026-09-22): the menu's panel turns into GitHub. Signed out, opening it starts
// GitHub's device flow (src/main/github/connection.cjs): the code shows here, already on the clipboard, and a window
// opens on github.com/login/device, sharing the Browser pane's sign-in, to paste it into; Browser does the same in the
// default browser (a passkey only works there). The window closes itself once GitHub says yes. Signed in, the
// repositories the App can read: a search, the list (the lock marks a private one; `here` one already in this
// workspace), and the App's install page for an account whose repositories are missing. Picking one adds it (or, when
// the library holds it, brings it here); the menu closes.

const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });
const plainButton = { padding: 0, border: 0, background: 'transparent', cursor: 'pointer' };

const LOCK = (
  <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <rect x="3" y="7" width="10" height="7.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);

function GhGlyph({ size = 14, color = '#171717' }) {
  return <span className="glyph-fit" style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}><span style={{ display: 'flex', width: size, height: size }}>{KIND.git.glyph}</span></span>;
}

/** What the main process says of the sign-in, kept current. */
function useGithubStatus() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    api.githubStatus().then((value) => { if (live) setStatus(value); }).catch(() => {});
    const off = api.onGithub((value) => { if (live && value) setStatus(value); });
    return () => { live = false; off(); };
  }, []);
  return [status, setStatus];
}

function Code({ code }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => { api.copyText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {}); };
  React.useEffect(() => { copy(); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button type="button" data-github-code={code} onClick={copy} title="Copy" style={{ ...plainButton, position: 'relative', display: 'block', width: '100%', padding: '14px 0 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', font: '600 21px/1 var(--font-mono)', letterSpacing: '2.5px', color: '#171717', textAlign: 'center', cursor: 'copy' }}>
      {code}
      <span style={{ position: 'absolute', right: 8, bottom: 4, ...text(10.5, '#8f8f8f'), letterSpacing: 0, opacity: copied ? 1 : 0, transition: 'opacity 160ms' }}>Copied</span>
    </button>
  );
}

export default function GithubPane({ library, inRail, onBack, onPick, busy }) {
  const [status, setStatus] = useGithubStatus();
  const [starting, setStarting] = React.useState(false);
  const [problem, setProblem] = React.useState('');
  const [list, setList] = React.useState(null); // { repos, accounts } | null while it loads
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const fieldRef = React.useRef(null);
  const started = React.useRef(false);

  const connect = React.useCallback(async () => {
    setStarting(true);
    setProblem('');
    try { setStatus(await api.githubConnect()); } catch (error) { setProblem(errorMessage(error)); } finally { setStarting(false); }
  }, [setStatus]);

  // Opening the view signed out is asking to sign in: it starts once, at once.
  React.useEffect(() => {
    if (!status || started.current) return;
    started.current = true;
    if (!status.connected && !status.pending && status.configured) void connect();
  }, [status, connect]);

  const connected = !!(status && status.connected);
  const load = React.useCallback(() => {
    api.githubRepos().then((value) => { setList(value); setProblem(''); }).catch((error) => { setList({ repos: [], accounts: [] }); setProblem(errorMessage(error)); });
  }, []);
  // The list, when signed in, and again whenever the app comes back to the front (an install on GitHub may have added some).
  React.useEffect(() => {
    if (!connected) { setList(null); return undefined; }
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [connected, load]);
  React.useEffect(() => { if (connected && fieldRef.current) setTimeout(() => fieldRef.current && fieldRef.current.focus({ preventScroll: true }), 0); }, [connected]);

  const rows = connected && list ? githubRows({ repos: list.repos, query: q, library, inRail }) : [];
  const at = rows.length ? Math.min(idx, rows.length - 1) : -1;
  const pick = (entry) => { if (entry && !busy) onPick(entry); };
  const onKey = (event) => {
    const n = rows.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pick(rows[at]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onBack(); }
  };

  const error = problem || (status && status.error) || '';
  const pending = status && !connected ? status.pending : null;
  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
      <button type="button" className="hov-ink" onClick={onBack} aria-label="Back" data-github-back="1" style={{ ...plainButton, flex: 'none', width: 18, ...text(16, '#8f8f8f'), lineHeight: 1 }}>‹</button>
      <GhGlyph />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(13, '#171717', 500) }}>{connected ? status.login : 'GitHub'}</span>
      {connected && <button type="button" className="hov-ink" data-github-signout="1" onClick={() => { api.githubDisconnect().then(setStatus).catch((failure) => setProblem(errorMessage(failure))); }} style={{ ...plainButton, flex: 'none', ...text(12, '#8f8f8f') }}>Sign out</button>}
    </div>
  );

  return (
    <div data-github-pane={connected ? 'repos' : pending ? 'code' : 'signed-out'}>
      {head}
      {!status && null}
      {status && !status.configured && <div style={{ ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{problem || 'GitHub is not set up: put the GitHub App’s client id in ~/.engelbart/config.json (github.clientId).'}</div>}
      {status && status.configured && !connected && (
        <>
          {pending && <Code code={pending.userCode} />}
          {pending && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
              <button type="button" className="hov-dim" data-github-window="1" onClick={() => api.githubOpen('device').catch((failure) => setProblem(errorMessage(failure)))} style={{ ...plainButton, padding: '7px 12px', borderRadius: 6, background: '#171717', ...text(12.5, '#fff', 500) }}>Open GitHub</button>
              <button type="button" className="hov-ink" data-github-browser="1" onClick={() => api.openExternal(pending.verificationUri).catch((failure) => setProblem(errorMessage(failure)))} style={{ ...plainButton, ...text(12.5, '#4d4d4d') }}>Browser</button>
              <span aria-hidden="true" className="github-wait" style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: '#0070f3' }} />
            </div>
          )}
          {!pending && (
            <button type="button" className="hov-dim" data-github-signin="1" disabled={starting} onClick={connect} style={{ ...plainButton, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '9px 12px', borderRadius: 6, background: '#171717', ...text(12.5, '#fff', 500), opacity: starting ? 0.6 : 1 }}>
              <GhGlyph color="#fff" />Sign in with GitHub
            </button>
          )}
          {error && <div data-github-error="1" style={{ marginTop: 8, ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{error}</div>}
        </>
      )}
      {connected && (
        <>
          <div className="rail-search rail-field" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 6, background: '#fafafa', border: '1px solid #eaeaea', transition: 'box-shadow 120ms' }}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
            <input ref={fieldRef} value={q} onChange={(event) => { setQ(event.target.value); setIdx(0); }} onKeyDown={onKey} readOnly={busy} placeholder="Search" aria-label="Search repositories" data-github-search="1" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', ...text(13), opacity: busy ? 0.5 : 1 }} />
          </div>
          <div data-github-repos="1" style={{ maxHeight: 'min(340px, calc(100vh - 320px))', overflowY: 'auto', margin: '6px -4px 0' }}>
            {!list && <div style={{ padding: '8px 10px', ...text(13, '#8f8f8f') }}>…</div>}
            {rows.map((entry, i) => (
              <button key={entry.repo.id} type="button" data-github-repo={entry.repo.fullName} disabled={busy} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => { if (idx !== i) setIdx(i); }} onClick={() => pick(entry)} title={entry.repo.description || entry.repo.fullName} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: i === at ? '#f2f2f2' : 'transparent', textAlign: 'left', cursor: 'pointer' }}>
                <GhGlyph size={13} color="#4d4d4d" />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(13) }}>
                  <span style={{ color: '#8f8f8f' }}>{entry.repo.owner}/</span>{entry.repo.fullName.slice(entry.repo.owner.length + 1)}
                </span>
                {entry.repo.private && <span aria-label="Private" style={{ flex: 'none', display: 'flex', color: '#8f8f8f' }}>{LOCK}</span>}
                {entry.here && <span style={{ flex: 'none', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>here</span>}
              </button>
            ))}
          </div>
          {status.installUrl && (
            <button type="button" className="hov-ink-wash" data-github-install="1" onClick={() => api.githubOpen('install').catch((failure) => setProblem(errorMessage(failure)))} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', margin: '4px 0 0', padding: '7px 8px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', color: '#8f8f8f', transition: 'color 120ms' }}>
              <span style={{ flex: 'none', width: 16, textAlign: 'center', font: '500 13px/1 var(--font-sans)' }}>+</span>
              <span style={{ ...text(13, 'inherit') }}>Install on an account…</span>
            </button>
          )}
          {error && <div data-github-error="1" style={{ marginTop: 6, ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{error}</div>}
          {status && status.connected && status.persisted === false && <div style={{ marginTop: 6, ...text(11.5, '#8f8f8f') }}>Signed in until Engelbart quits: no keychain.</div>}
        </>
      )}
    </div>
  );
}
