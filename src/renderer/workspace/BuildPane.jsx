import React from 'react';
import { api } from '../api.js';
import { useSandboxes } from '../ui/SandboxProgress.jsx';
import RunTimeline from './RunTimeline.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import './build-pane.css';

const labels = { starting: 'Building…', ready: 'Ready', failed: 'Failed', stopped: 'Stopped' };
const button = { padding: '5px 9px', border: '1px solid #eaeaea', borderRadius: 5, background: '#fff', color: '#171717', cursor: 'pointer', font: '12px var(--font-sans)' };

export default function BuildPane({ repositories, selectedId, onSelect }) {
  const { items, error, busy, act, open } = useSandboxes();
  const repo = repositories.find((row) => row.id === selectedId) || repositories[0];
  const item = repo && items[repo.id];
  const run = item?.run;
  const log = run?.build_log || [];
  const active = run && ['starting', 'ready'].includes(run.status);
  const color = run?.status === 'failed' ? '#c22' : run?.status === 'ready' ? '#171717' : '#666';

  return <section aria-label="Repository build" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, font: '13px/1.5 var(--font-sans)' }}>
    {repo ? <>
      <div style={{ padding: '28px 22px 18px', borderBottom: '1px solid #eaeaea', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="build-repository-field">
          <select className="build-repository-select" aria-label="Repository" value={repo.id} onChange={(event) => onSelect(event.target.value)}>
            {repositories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m4 6 4 4 4-4" /></svg>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span role="status" style={{ color, marginRight: 'auto' }}>{labels[run?.status] || 'Preparing automatically…'}</span>
          {run?.status === 'ready' && <button style={button} onClick={() => open(run)}>Open preview</button>}
          {run && <button style={button} disabled={busy[run.id]} onClick={() => act(run, () => active ? api.stopSandbox(run.id) : api.startSandbox(repo.id))}>{busy[run.id] ? 'Working…' : active ? 'Stop' : 'Retry build'}</button>}
          {run?.status === 'failed' && run.sandbox_id && <button style={button} disabled={busy[run.id]} onClick={() => act(run, () => api.stopSandbox(run.id))}>Stop sandbox</button>}
          <button style={button} onClick={() => act(run || { id: repo.id }, () => api.openExternal(repo.url))}>GitHub ↗</button>
        </div>
        {run && <span style={{ color: '#8f8f8f', fontSize: 11 }}>Started {new Date(run.created_at).toLocaleString()}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <EnvironmentPanel key={repo.id} repo={repo} run={run} />
        <RunTimeline key={`${repo.id}:${run?.id || 'pending'}`} run={run} repoName={repo.name} />
        {run?.error && <p role="alert" style={{ margin: '18px 22px', color: '#c22', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{run.error}</p>}
        {!log.length && <p style={{ margin: '18px 22px', color: '#8f8f8f' }}>{item?.message || (run ? 'Earlier build details are unavailable. New build activity will appear here.' : 'This repository will set up automatically. Build progress will appear here.')}</p>}
        {log.length >= 300 && <p style={{ margin: '18px 22px', color: '#8f8f8f', fontSize: 11 }}>Showing the latest 300 build events.</p>}
      </div>
    </> : <p style={{ margin: 'auto', padding: 28, color: '#8f8f8f', textAlign: 'center' }}>Add a GitHub repository to the library to build it automatically.</p>}
    {error && <p role="alert" style={{ color: '#c22', padding: '0 18px', overflowWrap: 'anywhere' }}>{error}</p>}
  </section>;
}
