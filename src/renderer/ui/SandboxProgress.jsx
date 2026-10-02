import React from 'react';
import { api, errorMessage } from '../api.js';
import BuildDetails from '../workspace/BuildDetails.jsx';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { readNotificationState, writeNotificationState, sandboxProgressState, sandboxProgressReducer } from '../model/sandbox-notifications.js';

const SandboxContext = React.createContext(null);
export const useSandboxes = () => React.useContext(SandboxContext);

// E2B previews of saved GitHub repositories (src/main/sandbox). One listener for the whole app, mounted before the
// library can submit work. The snapshot restores state after renderer reloads; events carry later changes. A preview or
// a repository opens in the workspace's Stage; on the other screens, in the default browser.
export default function SandboxProgress({ dataRoot, library, inWorkspace, children }) {
  const [state, dispatch] = React.useReducer(sandboxProgressReducer, dataRoot, (root) => {
    let saved;
    try { saved = readNotificationState(window.localStorage, root); } catch { /* Storage may be unavailable. */ }
    return sandboxProgressState(root, saved);
  });
  const { items, notifications, dismissed } = state;
  const [buildRepoId, setBuildRepoId] = React.useState(null);
  const buildTrigger = React.useRef(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState({});
  const workspace = React.useRef(inWorkspace);
  workspace.current = inWorkspace;
  const openUrl = React.useCallback((url) => {
    if (workspace.current) window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url } }));
    else api.openExternal(url).catch((e) => setError(errorMessage(e)));
  }, []);
  const open = React.useCallback((run) => {
    if (run.status !== 'ready' || !run.preview_url) return;
    dispatch({ type: 'read', ids: notifications.filter((row) => row.runId === run.id).map((row) => row.id) });
    openUrl(run.preview_url);
  }, [notifications, openUrl]);
  const openRepository = React.useCallback(row => { if (row?.url) openUrl(row.url); }, [openUrl]);
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
    dispatch({ type: 'reset', dataRoot, saved }); setBuildRepoId(null); setError('');
    const merge = (event) => dispatch({ type: 'progress', event: { ...event, dataRoot } });
    const off = api.onSandboxProgress((event) => {
      if (event.dataRoot !== dataRoot) return;
      merge(event);
    });
    api.sandboxRuns().then((rows) => { if (live) for (const row of rows) merge(row); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; off(); };
  }, [dataRoot]);
  // Saved repositories are prepared once per app session (main skips the ones it already did). Signing in to GitHub
  // brings the E2B key, and signing Claude Code in to a subscription is what does the setup, so preparation that waited
  // for either runs then.
  const [signedIn, setSignedIn] = React.useState(false);
  React.useEffect(() => {
    const take = (status) => setSignedIn(!!(status && status.connected));
    api.githubStatus().then(take).catch(() => {});
    return api.onGithub(take);
  }, []);
  const [claudeSignedIn, setClaudeSignedIn] = React.useState(false);
  React.useEffect(() => {
    const take = (snapshot) => setClaudeSignedIn(snapshot?.tools?.claude?.signedIn === true);
    api.tools().then(take).catch(() => {});
    return api.onTools(take);
  }, []);
  React.useEffect(() => {
    let live = true;
    api.ensureSandboxes().catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [dataRoot, library, signedIn, claudeSignedIn]);
  const act = async (run, action) => {
    setBusy((current) => ({ ...current, [run.id]: true })); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e)); }
    finally { setBusy((current) => ({ ...current, [run.id]: false })); }
  };
  const buildRepo = library.find((row) => row.id === buildRepoId);
  return <SandboxContext.Provider value={{ items, library, notifications, markNotificationsRead, clearNotifications, error, busy, act, open, openRepository, openBuild }}>
    {children}
    {buildRepo && <BuildDetails key={buildRepo.id} repo={buildRepo} item={items[buildRepo.id]} busy={busy} act={act} open={open} error={error}
      visible onClose={closeBuild} onVisitRepository={openRepository} />}
  </SandboxContext.Provider>;
}
