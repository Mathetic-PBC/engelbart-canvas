import React from 'react';
import { api, errorMessage } from '../api.js';
import BuildDetails from '../workspace/BuildDetails.jsx';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { readNotificationState, writeNotificationState, sandboxProgressState, sandboxProgressReducer, previewLibraryId, notificationStorageKey, canOpenTerminal, OPEN_SANDBOX_TERMINAL } from '../model/sandbox-notifications.js';

const SandboxContext = React.createContext(null);
export const useSandboxes = () => React.useContext(SandboxContext);

// The Stage's page at `url`, while `showing`: when it is a ready preview and the window has the keyboard, it is in use, so
// its sandbox's sleep is put back to 10 minutes away now and every minute after (main's sandbox touch, which also keeps
// pings 30 seconds apart). Another tab in front, the tab closed or the window left stops it. A ping never wakes a sandbox.
export function usePreviewTouch(url, showing) {
  const sandboxes = useSandboxes();
  useSandboxTouch(showing && sandboxes ? previewLibraryId(sandboxes.items, url) : null);
}

// A repository's sandbox in use (`libraryId`, null when none is): while the window has the keyboard, its sleep is put
// back to 10 minutes away now and every minute after. A preview's Stage tab (usePreviewTouch) and a sandbox terminal's
// tab in front (TerminalPane.jsx) use it.
export function useSandboxTouch(libraryId) {
  const [focused, setFocused] = React.useState(() => api.windowFocused());
  React.useEffect(() => api.onWindowFocus((on) => setFocused(!!on)), []);
  React.useEffect(() => {
    if (!libraryId || !focused) return undefined;
    const touch = () => { api.touchSandbox(libraryId).catch(() => {}); };
    touch();
    const timer = setInterval(touch, 60_000);
    return () => clearInterval(timer);
  }, [libraryId, focused]);
}

// A workspace's repositories with a finished build (`libraryIds`, on its rail), woken ahead of a click (2026-10-04): when
// it opens, when one joins it, and each time its window comes back into focus, so that a preview opens at once instead of
// waiting for E2B to resume its sandbox. Each then sleeps 30 minutes on unless it is used (main's wake, once a minute at
// most).
export function useSandboxWake(libraryIds) {
  const [focused, setFocused] = React.useState(() => api.windowFocused());
  React.useEffect(() => api.onWindowFocus((on) => setFocused(!!on)), []);
  const key = [...new Set(libraryIds)].sort().join('\n');
  React.useEffect(() => {
    if (!key || !focused) return;
    api.wakeSandboxes(key.split('\n')).catch(() => {});
  }, [key, focused]);
}

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
  const act = async (run, action) => {
    setBusy((current) => ({ ...current, [run.id]: true })); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e)); }
    finally { setBusy((current) => ({ ...current, [run.id]: false })); }
  };
  // A repository used from a terminal: its shell in the sandbox, as a tab of the workspace's terminal pane (Workspace.jsx
  // adopts it; `show`: and brings the pane forward). Only a workspace has a terminal pane.
  const openTerminal = React.useCallback((run, { show = true } = {}) => {
    if (!canOpenTerminal(run)) return;
    if (!workspace.current) { setError('Open a workspace to use the sandbox terminal.'); return; }
    dispatch({ type: 'read', ids: notifications.filter((row) => row.runId === run.id).map((row) => row.id) });
    void act(run, async () => {
      const session = await api.sandboxTerminal(run.library_id);
      window.dispatchEvent(new CustomEvent(OPEN_SANDBOX_TERMINAL, { detail: { session, show } }));
    });
  }, [notifications]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Every window keeps its own bell from the same events; what another window clears or reads, this one does too.
  React.useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== notificationStorageKey(dataRoot)) return;
      let saved;
      try { saved = readNotificationState(window.localStorage, dataRoot); } catch { return; }
      dispatch({ type: 'sync', saved });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [dataRoot]);
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
  const buildRepo = library.find((row) => row.id === buildRepoId);
  return <SandboxContext.Provider value={{ items, library, notifications, markNotificationsRead, clearNotifications, error, busy, act, open, openTerminal, openRepository, openBuild }}>
    {children}
    {buildRepo && <BuildDetails key={buildRepo.id} repo={buildRepo} item={items[buildRepo.id]} busy={busy} act={act} open={open} openTerminal={openTerminal} error={error}
      visible onClose={closeBuild} onVisitRepository={openRepository} />}
  </SandboxContext.Provider>;
}
