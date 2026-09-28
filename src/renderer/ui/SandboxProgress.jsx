import React from 'react';
import { api, errorMessage } from '../api.js';
import Browser from '../workspace/Browser.jsx';
import BuildDetails from '../workspace/BuildDetails.jsx';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { readNotificationState, writeNotificationState, sandboxProgressState, sandboxProgressReducer } from '../model/sandbox-notifications.js';
import useLocalBuildNotifications from './useLocalBuildNotifications.js';

const SandboxContext = React.createContext(null);
export const useSandboxes = () => React.useContext(SandboxContext);

// One listener for the whole app, mounted before the library can submit work.
// The snapshot restores state after renderer reloads; events carry later changes.
export default function SandboxProgress({ dataRoot, library, inWorkspace, children }) {
  const [state, dispatch] = React.useReducer(sandboxProgressReducer, dataRoot, (root) => {
    let saved;
    try { saved = readNotificationState(window.localStorage, root); } catch { /* Storage may be unavailable. */ }
    return sandboxProgressState(root, saved);
  });
  const { items, notifications, dismissed } = state;
  const [preview, setPreview] = React.useState(null);
  const [buildRepoId, setBuildRepoId] = React.useState(null);
  const buildTrigger = React.useRef(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState({});
  const workspace = React.useRef(inWorkspace);
  workspace.current = inWorkspace;
  React.useEffect(() => { if (inWorkspace) setPreview(null); }, [inWorkspace]);
  const openUrl = React.useCallback(url => {
    if (workspace.current) window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url } }));
    else setPreview(url);
  }, []);
  const open = React.useCallback((run) => {
    if (run.status !== 'ready' || !run.preview_url) return;
    dispatch({ type: 'read', ids: notifications.filter((row) => row.runId === run.id).map((row) => row.id) });
    openUrl(run.preview_url);
  }, [notifications, openUrl]);
  const openRepository = React.useCallback(row => { if (row?.url) openUrl(row.url); }, [openUrl]);
  const localBuilds = useLocalBuildNotifications(dataRoot, openUrl);
  const openBuild = React.useCallback((row, trigger) => {
    buildTrigger.current = trigger || document.activeElement;
    setBuildRepoId(row.id);
  }, []);
  const closeBuild = () => {
    setBuildRepoId(null);
    if (buildTrigger.current?.isConnected) buildTrigger.current.focus({ preventScroll: true });
  };
  const markNotificationsRead = React.useCallback((ids) => dispatch({ type: 'read', ids }), []);
  const clearNotifications = React.useCallback((ids) => dispatch({ type: 'clear', ids }), []);
  React.useEffect(() => {
    if (state.dataRoot !== dataRoot) return;
    try { writeNotificationState(window.localStorage, dataRoot, { notifications, dismissed }); } catch { /* Storage may be unavailable. */ }
  }, [dataRoot, state.dataRoot, notifications, dismissed]);
  React.useEffect(() => {
    let live = true;
    let saved;
    try { saved = readNotificationState(window.localStorage, dataRoot); } catch { /* Storage may be unavailable. */ }
    dispatch({ type: 'reset', dataRoot, saved }); setPreview(null); setBuildRepoId(null); setError('');
    const merge = (event) => dispatch({ type: 'progress', event: { ...event, dataRoot } });
    const off = api.onSandboxProgress((event) => {
      if (event.dataRoot !== dataRoot) return;
      merge(event);
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
  const buildRepo = library.find(row => row.id === buildRepoId);
  const button = { border: 0, background: 'transparent', color: '#0070f3', cursor: 'pointer', font: '12px var(--font-sans)', padding: '4px 6px' };
  return <SandboxContext.Provider value={{ items, library, notifications, markNotificationsRead, clearNotifications, error, busy, act, open, openRepository, openBuild, localBuilds }}>
    {children}
    {buildRepo && <BuildDetails key={buildRepo.id} repo={buildRepo} item={items[buildRepo.id]} busy={busy} act={act} open={open} error={error}
      visible onClose={closeBuild} onVisitRepository={openRepository} />}
    {preview && <div data-overlay="1" role="dialog" aria-label="Sandbox preview" style={{ position: 'fixed', inset: '64px 20px 20px', zIndex: 160, background: '#fff', border: '1px solid #ccc', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', font: '13px var(--font-sans)' }}><span>Sandbox preview</span><button style={button} onClick={() => setPreview(null)}>Close</button></div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}><Browser visible initialUrl={preview} /></div>
    </div>}
  </SandboxContext.Provider>;
}
