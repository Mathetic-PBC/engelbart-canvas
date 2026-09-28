import React from 'react';
import { api, errorMessage } from '../api.js';
import { localBuildKey, localNotificationKey, readLocalNotifications, localNotificationState, localNotificationReducer, visibleLocalNotifications, OPEN_LOCAL_BUILD_NOTIFICATION } from '../model/local-build-notifications.js';

export default function useLocalBuildNotifications(dataRoot, openUrl) {
  const [state, dispatch] = React.useReducer(localNotificationReducer, dataRoot, root => localNotificationState(root, readLocalNotifications(window.localStorage, root)));
  const [busy, setBusy] = React.useState({}), [errors, setErrors] = React.useState({});
  const root = React.useRef(dataRoot); root.current = dataRoot;
  React.useEffect(() => {
    let live = true;
    dispatch({ type: 'reset', dataRoot, saved: readLocalNotifications(window.localStorage, dataRoot) });
    setBusy({}); setErrors({});
    const off = api.onLocalPreview(event => { if (live) dispatch({ type: 'progress', dataRoot: event.dataRoot, preview: event.preview }); });
    api.localPreviews().then(rows => { if (live) rows.forEach(preview => dispatch({ type: 'progress', dataRoot, preview, snapshot: true })); }).catch(error => { if (live) setErrors({ all: errorMessage(error) }); });
    return () => { live = false; off(); };
  }, [dataRoot]);
  React.useEffect(() => {
    if (dataRoot !== state.dataRoot) return;
    try { window.localStorage.setItem(localNotificationKey(dataRoot), JSON.stringify({ read: state.read, dismissed: state.dismissed })); } catch { /* in-memory notifications still work */ }
  }, [dataRoot, state.dataRoot, state.read, state.dismissed]);
  React.useEffect(() => {
    const show = event => dispatch({ type: 'reveal', id: event.detail?.id });
    window.addEventListener(OPEN_LOCAL_BUILD_NOTIFICATION, show);
    return () => window.removeEventListener(OPEN_LOCAL_BUILD_NOTIFICATION, show);
  }, []);
  const act = async (preview, action) => {
    const requestRoot = dataRoot;
    setBusy(current => ({ ...current, [preview.id]: action }));
    setErrors(current => ({ ...current, [preview.id]: '' }));
    try {
      const args = [preview.projectId, preview.workspaceId];
      if (action === 'approve' || action === 'decline') await api.approveLocalPreview(...args, preview.approval.id, action === 'approve');
      else if (action === 'folder') await api.revealLocalPreview(...args);
      else if (action === 'stop') await api.stopLocalPreview(...args);
      else if (action === 'restart') await api.restartLocalPreview(...args);
    } catch (error) { if (root.current === requestRoot) setErrors(current => ({ ...current, [preview.id]: errorMessage(error) })); }
    finally { if (root.current === requestRoot) setBusy(current => ({ ...current, [preview.id]: false })); }
  };
  return {
    rows: state.dataRoot === dataRoot ? visibleLocalNotifications(state) : [],
    read: state.read, busy, errors, act,
    markRead: React.useCallback(keys => dispatch({ type: 'read', keys }), []),
    clear: React.useCallback(keys => dispatch({ type: 'dismiss', keys }), []),
    open: preview => { if (preview.status === 'ready' && preview.url) { dispatch({ type: 'read', keys: [localBuildKey(preview)] }); openUrl(preview.url); } },
  };
}
