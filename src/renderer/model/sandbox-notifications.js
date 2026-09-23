const LIMIT = 40;
export const notificationStorageKey = (root) => `engelbart:preview-notifications:${root}`;

export function readNotifications(storage, root) {
  try {
    const rows = JSON.parse(storage.getItem(notificationStorageKey(root)) || '[]');
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && ['id', 'runId', 'libraryId', 'at'].every((key) => typeof row[key] === 'string' && row[key].length < 256)
      && Number.isFinite(Date.parse(row.at)) && typeof row.read === 'boolean').slice(0, LIMIT);
  } catch { return []; }
}

export function writeNotifications(storage, root, notifications) {
  try { storage.setItem(notificationStorageKey(root), JSON.stringify(notifications.slice(0, LIMIT))); } catch { /* Notifications still work without local storage. */ }
}

export function sandboxProgressState(dataRoot, notifications = []) {
  return { dataRoot, items: {}, notifications };
}

// Progress can arrive before the initial snapshot. Never let an older snapshot
// restore a stopped preview, replace a newer build, or create another alert.
export function sandboxProgressReducer(state, action) {
  if (action.type === 'reset') return sandboxProgressState(action.dataRoot, action.notifications);
  if (action.type === 'read') {
    const ids = new Set(action.ids);
    if (!state.notifications.some((row) => !row.read && ids.has(row.id))) return state;
    return { ...state, notifications: state.notifications.map((row) => ids.has(row.id) ? { ...row, read: true } : row) };
  }
  if (action.type !== 'progress' || action.event.dataRoot !== state.dataRoot) return state;
  const { run, message } = action.event;
  if (!run?.id || !run.library_id) return state;
  const previous = state.items[run.library_id];
  if (previous && (previous.run.created_at > run.created_at || (previous.run.id === run.id && previous.run.updated_at > run.updated_at))) return state;
  let notifications = state.notifications;
  if (run.status === 'ready' && run.preview_url && (previous?.run.id !== run.id || previous?.run.status !== 'ready' || action.event.notification === 'preview-ready')) {
    const at = run.build_log?.findLast((entry) => entry.message === 'Preview ready')?.time || run.created_at;
    const existing = notifications.find((row) => row.runId === run.id);
    // The completion line can age out of the bounded build log. Keep the saved
    // notification/read state rather than inventing a fresh alert on reload.
    if (!existing || Date.parse(at) > Date.parse(existing.at)) {
      const row = { id: `${run.id}:${at}`, runId: run.id, libraryId: run.library_id, at, read: false };
      notifications = [row, ...notifications.filter((entry) => entry.libraryId !== run.library_id)].slice(0, LIMIT);
    }
  }
  return { ...state, items: { ...state.items, [run.library_id]: { run, message } }, notifications };
}
