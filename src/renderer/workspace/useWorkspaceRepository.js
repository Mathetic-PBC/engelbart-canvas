import React from 'react';
import { api, errorMessage } from '../api.js';

// All repository selectors observe the same main-process connection. This module
// is deliberately outside DocEditor: post-it editors do not have the app bridge.
export function useWorkspaceRepository(projectId, workspaceId, revision) {
  const [value, setValue] = React.useState(null), [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false), [epoch, setEpoch] = React.useState(0);
  const refresh = React.useCallback(() => setEpoch(n => n + 1), []);
  React.useEffect(() => api.onRepositoryChanged(event => {
    if (event.projectId === projectId && (!event.workspaceId || event.workspaceId === workspaceId)) refresh();
  }), [projectId, workspaceId, refresh]);
  React.useEffect(() => {
    let live = true;
    setValue(null); setError('');
    if (projectId && workspaceId) api.workspaceRepository(projectId, workspaceId).then(next => { if (live) setValue(next); }, e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [projectId, workspaceId, revision, epoch]);
  const connect = async (input, projectDefault = false) => {
    if (busy) return false;
    setBusy(true); setError('');
    try {
      if (projectDefault) await api.setProjectDefaultRepository(projectId, input);
      else await api.connectWorkspaceRepository(projectId, workspaceId, input);
      refresh(); return true;
    } catch (e) { setError(errorMessage(e)); return false; }
    finally { setBusy(false); }
  };
  return { value, error, busy, connect, refresh, setError, projectId, workspaceId };
}
