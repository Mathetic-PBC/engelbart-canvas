const LIMIT = 40;
export const notificationStorageKey = (root) => `engelbart:preview-notifications:${root}`;

const notificationStatus = row => row.status || 'ready'; // Existing saved preview alerts.
const dismissalKey = row => notificationStatus(row) === 'ready' ? row.libraryId : `${row.libraryId}:${row.status}`;

// Saved alerts can outlive a run or load before its current snapshot.
// Show only the current build phase, never a stale preview or stopped run.
export function availableBuildNotifications(notifications, items) {
  return notifications.filter((notification) => {
    const run = items[notification.libraryId]?.run;
    return run?.id === notification.runId && ['starting', 'ready', 'failed'].includes(run.status) && run.status === notificationStatus(notification);
  });
}

export function readNotificationState(storage, root) {
  try {
    const saved = JSON.parse(storage.getItem(notificationStorageKey(root)) || '{}');
    // Older versions stored just the visible notifications.
    const rows = Array.isArray(saved) ? saved : saved?.notifications;
    const notifications = (Array.isArray(rows) ? rows : []).filter((row) => row && ['id', 'runId', 'libraryId', 'at'].every((key) => typeof row[key] === 'string' && row[key].length < 256)
      && Number.isFinite(Date.parse(row.at)) && typeof row.read === 'boolean' && (row.status === undefined || ['starting', 'ready', 'failed'].includes(row.status))).slice(0, LIMIT);
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
// A saved repository clicked in the workspace's sidebar (2026-09-29): its live preview when there is one, else its build
// details (progress, why it failed, Run). Without a sandbox (signed out, sandboxes off) it opens as it always has.
export function repositoryClick(item) {
  if (!item?.run) return null;
  return item.run.status === 'ready' && item.run.preview_url ? 'preview' : 'details';
}

export function sandboxProgressReducer(state, action) {
  if (action.type === 'reset') return sandboxProgressState(action.dataRoot, action.saved);
  if (action.type === 'clear') {
    const ids = new Set(action.ids);
    const cleared = state.notifications.filter((row) => ids.has(row.id));
    if (!cleared.length) return state;
    // Remember dismissal per phase, so clearing Building cannot hide completion.
    // Ready keeps the legacy repository key for existing persisted dismissals.
    const dismissed = { ...state.dismissed };
    for (const row of cleared) {
      const key = dismissalKey(row);
      if (!(Date.parse(dismissed[key]) >= Date.parse(row.at))) dismissed[key] = row.at;
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
  if (['starting', 'ready', 'failed'].includes(run.status)) {
    const existing = notifications.find((row) => row.runId === run.id);
    const samePhase = existing && notificationStatus(existing) === run.status;
    const changedPhase = previous?.run.id === run.id && previous.run.status !== run.status;
    const boundary = run.status === 'ready' ? run.build_log?.findLast(entry => entry.message === 'Preview ready')?.time
      : run.status === 'starting' ? run.build_log?.findLast(entry => entry.data?.lifecycle === 'restart')?.time
      : run.finished_at;
    // Preserve read/dismissed state as progress arrives and old log lines age out.
    const at = boundary || (samePhase && existing.at) || (changedPhase || run.status === 'failed' ? run.updated_at : run.created_at);
    const row = { id: `${run.id}:${run.status}:${at}`, runId: run.id, libraryId: run.library_id, status: run.status, at, read: false };
    if ((action.event.reveal || !(Date.parse(state.dismissed[dismissalKey(row)]) >= Date.parse(at))) && (!samePhase || Date.parse(at) > Date.parse(existing.at))) {
      notifications = [row, ...notifications.filter((entry) => entry.libraryId !== run.library_id)].slice(0, LIMIT);
    }
  }
  return { ...state, items: { ...state.items, [run.library_id]: { run, message } }, notifications };
}
