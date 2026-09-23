import React from 'react';
import { api, errorMessage } from '../api.js';
import Browser from '../workspace/Browser.jsx';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { readNotifications, writeNotifications, sandboxProgressState, sandboxProgressReducer } from '../model/sandbox-notifications.js';

const SandboxContext = React.createContext(null);
export const useSandboxes = () => React.useContext(SandboxContext);

// One listener for the whole app, mounted before the library can submit work.
// The snapshot restores state after renderer reloads; events carry later changes.
export default function SandboxProgress({ dataRoot, library, inWorkspace, children }) {
  const [state, dispatch] = React.useReducer(sandboxProgressReducer, dataRoot, (root) => {
    let saved = [];
    try { saved = readNotifications(window.localStorage, root); } catch { /* Storage may be unavailable. */ }
    return sandboxProgressState(root, saved);
  });
  const { items, notifications } = state;
  const [collapsed, setCollapsed] = React.useState(false);
  const [preview, setPreview] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState({});
  const workspace = React.useRef(inWorkspace);
  workspace.current = inWorkspace;
  React.useEffect(() => { if (inWorkspace) setPreview(null); }, [inWorkspace]);
  const open = React.useCallback((run) => {
    if (run.status !== 'ready' || !run.preview_url) return;
    dispatch({ type: 'read', ids: notifications.filter((row) => row.runId === run.id).map((row) => row.id) });
    if (workspace.current) window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url: run.preview_url } }));
    else setPreview(run.preview_url);
  }, [notifications]);
  const markNotificationsRead = React.useCallback((ids) => dispatch({ type: 'read', ids }), []);
  React.useEffect(() => {
    if (state.dataRoot !== dataRoot) return;
    try { writeNotifications(window.localStorage, dataRoot, notifications); } catch { /* Storage may be unavailable. */ }
  }, [dataRoot, state.dataRoot, notifications]);
  React.useEffect(() => {
    let live = true;
    const seen = new Set();
    let saved = [];
    try { saved = readNotifications(window.localStorage, dataRoot); } catch { /* Storage may be unavailable. */ }
    dispatch({ type: 'reset', dataRoot, notifications: saved }); setPreview(null); setError('');
    const merge = (event) => dispatch({ type: 'progress', event: { ...event, dataRoot } });
    const off = api.onSandboxProgress((event) => {
      if (event.dataRoot !== dataRoot) return;
      merge(event);
      if (!seen.has(event.run.id) || event.run.status === 'failed') setCollapsed(false);
      seen.add(event.run.id);
    });
    api.sandboxRuns().then((rows) => { if (live) for (const row of rows) merge(row); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; off(); };
  }, [dataRoot]);
  React.useEffect(() => {
    let live = true;
    api.ensureSandboxes().catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [dataRoot, library]);
  const act = async (run, action) => {
    setBusy((current) => ({ ...current, [run.id]: true })); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e)); }
    finally { setBusy((current) => ({ ...current, [run.id]: false })); }
  };
  const rows = Object.values(items).sort((a, b) => b.run.created_at.localeCompare(a.run.created_at));
  const button = { border: 0, background: 'transparent', color: '#0070f3', cursor: 'pointer', font: '12px var(--font-sans)', padding: '4px 6px' };
  return <SandboxContext.Provider value={{ items, library, notifications, markNotificationsRead, error, busy, act, open }}>
    {children}
    {!inWorkspace && !preview && (rows.length > 0 || error) && <section data-overlay="1" aria-label="Sandbox runs" style={{ position: 'fixed', bottom: 52, left: inWorkspace ? 18 : undefined, right: inWorkspace ? undefined : 18, zIndex: 151, width: inWorkspace ? 280 : 340, maxWidth: 'calc(100vw - 36px)', background: '#fff', border: '1px solid #eaeaea', borderRadius: 10, boxShadow: '0 4px 18px #00000012', font: '12px/1.5 var(--font-sans)' }}>
      <button onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} style={{ ...button, color: '#171717', padding: '10px 12px', width: '100%', textAlign: 'left' }}>Sandbox runs · {rows.length} <span style={{ float: 'right' }}>{collapsed ? '+' : '−'}</span></button>
      {!collapsed && <div style={{ maxHeight: 280, overflowY: 'auto', padding: '0 12px 10px' }}>
        {rows.map(({ run, message }) => <div key={run.id} style={{ padding: '8px 0', borderTop: '1px solid #eee' }}>
          <div style={{ fontWeight: 500 }}>{library.find((row) => row.id === run.library_id)?.name || 'Repository'} · {run.status}</div>
          <div role="status" style={{ color: run.status === 'failed' ? '#c22' : '#666', overflowWrap: 'anywhere', maxHeight: 64, overflowY: 'auto' }}>{run.error || message || run.status}</div>
          <div style={{ marginLeft: -6 }}>
            {run.status === 'ready' && <button style={button} disabled={busy[run.id]} onClick={() => open(run)}>Open preview</button>}
            {['starting', 'ready'].includes(run.status)
              ? <button style={button} disabled={busy[run.id]} onClick={() => act(run, () => api.stopSandbox(run.id))}>Stop</button>
              : <button style={button} disabled={busy[run.id]} onClick={() => act(run, () => api.startSandbox(run.library_id))}>Retry</button>}
          </div>
        </div>)}
        {error && <div role="alert" style={{ color: '#c22' }}>{error}</div>}
      </div>}
    </section>}
    {preview && <div data-overlay="1" role="dialog" aria-label="Sandbox preview" style={{ position: 'fixed', inset: '64px 20px 20px', zIndex: 160, background: '#fff', border: '1px solid #ccc', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', font: '13px var(--font-sans)' }}><span>Sandbox preview</span><button style={button} onClick={() => setPreview(null)}>Close</button></div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}><Browser visible initialUrl={preview} /></div>
    </div>}
  </SandboxContext.Provider>;
}
