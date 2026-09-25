const LIMIT = 40;
export const notificationStorageKey = (root) => `engelbart:preview-notifications:${root}`;

// Saved alerts can outlive their preview or load before its current run snapshot.
// Only show alerts that can still open the repository's current live preview.
export function availablePreviewNotifications(notifications, items) {
  return notifications.filter((notification) => {
    const run = items[notification.libraryId]?.run;
    return run?.id === notification.runId && run.status === 'ready' && !!run.preview_url;
  });
}

export function readNotificationState(storage, root) {
  try {
    const saved = JSON.parse(storage.getItem(notificationStorageKey(root)) || '{}');
    // Older versions stored just the visible notifications.
    const rows = Array.isArray(saved) ? saved : saved?.notifications;
    const notifications = (Array.isArray(rows) ? rows : []).filter((row) => row && ['id', 'runId', 'libraryId', 'at'].every((key) => typeof row[key] === 'string' && row[key].length < 256)
      && Number.isFinite(Date.parse(row.at)) && typeof row.read === 'boolean').slice(0, LIMIT);
    const dismissed = saved?.dismissed;
    return { notifications, dismissed: Object.fromEntries(Object.entries(dismissed && typeof dismissed === 'object' && !Array.isArray(dismissed) ? dismissed : {})
      .filter(([libraryId, at]) => libraryId.length < 256 && typeof at === 'string' && at.length < 256 && Number.isFinite(Date.parse(at)))) };
  } catch { return { notifications: [], dismissed: {} }; }
}

export function writeNotificationState(storage, root, { notifications, dismissed }) {
  try { storage.setItem(notificationStorageKey(root), JSON.stringify({ notifications: notifications.slice(0, LIMIT), dismissed })); } catch { /* Notifications still work without local storage. */ }
}

export function sandboxProgressState(dataRoot, { notifications = [], dismissed = {} } = {}) {
  return { dataRoot, items: {}, notifications, dismissed };
}

// Progress can arrive before the initial snapshot. Never let an older snapshot
// restore a stopped preview, replace a newer build, or create another alert.
export function sandboxProgressReducer(state, action) {
  if (action.type === 'reset') return sandboxProgressState(action.dataRoot, action.saved);
  if (action.type === 'clear') {
    const ids = new Set(action.ids);
    const cleared = state.notifications.filter((row) => ids.has(row.id));
    if (!cleared.length) return state;
    // Keep one completion timestamp per repository so snapshots and duplicate
    // events cannot recreate cleared alerts, even after a renderer reload.
    const dismissed = { ...state.dismissed };
    for (const row of cleared) {
      if (!(Date.parse(dismissed[row.libraryId]) >= Date.parse(row.at))) dismissed[row.libraryId] = row.at;
    }
    return { ...state, dismissed, notifications: state.notifications.filter((row) => !ids.has(row.id)) };
  }
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
    if (!(Date.parse(state.dismissed[run.library_id]) >= Date.parse(at)) && (!existing || Date.parse(at) > Date.parse(existing.at))) {
      const row = { id: `${run.id}:${at}`, runId: run.id, libraryId: run.library_id, at, read: false };
      notifications = [row, ...notifications.filter((entry) => entry.libraryId !== run.library_id)].slice(0, LIMIT);
    }
  }
  return { ...state, items: { ...state.items, [run.library_id]: { run, message } }, notifications };
}
