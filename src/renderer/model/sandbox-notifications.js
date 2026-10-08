import { expiredRun } from '../../shared/sandbox-sleep.cjs';

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

// A shell in a repository's sandbox to show in the workspace's terminal pane: { session (main's snapshot), show (bring the
// pane forward) } (SandboxProgress.jsx's openTerminal → Workspace.jsx).
export const OPEN_SANDBOX_TERMINAL = 'engelbart:open-sandbox-terminal';

// How a person uses a ready run's repository, as Claude declared it: 'interface', 'terminal' or 'both'. Runs from before
// 2026-10-03 have none, and were all previews.
export const runKind = (run) => (['interface', 'terminal', 'both'].includes(run?.kind) ? run.kind : 'interface');
export const canOpenPreview = (run) => run?.status === 'ready' && runKind(run) !== 'terminal' && !!run.preview_url;
export const canOpenTerminal = (run) => run?.status === 'ready' && runKind(run) !== 'interface' && !!run.terminal;

// Why a build failed, in a few words for the bell (≤ 60 characters); the whole error stays in its build details.
export function failureReason(run) {
  if (run?.status !== 'failed') return '';
  const error = String(run.error || '');
  if (/^Setup stopped|Setup was interrupted/i.test(error)) return 'Setup stopped';
  if (/Claude Code is not installed|Update Claude Code/i.test(error)) return 'Claude Code not installed';
  if (/not signed in to a Claude subscription/i.test(error)) return 'Claude Code not signed in';
  if (/^Desktop apps are not supported yet/i.test(error)) return 'Desktop apps not supported yet';
  if (/web preview|preview is not reachable|public preview/i.test(error)) return 'No web preview found';
  return 'Setup failed';
}

// Progress can arrive before the initial snapshot. Never let an older snapshot
// restore a stopped preview, replace a newer build, or create another alert.
// A saved repository clicked in the workspace's sidebar (2026-09-29): its live preview when there is one (asleep too: opening
// it wakes it), its terminal when it is used from one, both for both (2026-10-03); else its build details (progress, why it
// failed, Run). One ended only because nobody opened it for 7 days is built again ('start'). Without a sandbox (signed
// out, sandboxes off) it opens as it always has.
export function repositoryClick(item) {
  if (!item?.run) return null;
  if (expiredRun(item.run)) return 'start';
  const preview = canOpenPreview(item.run), terminal = canOpenTerminal(item.run);
  return preview && terminal ? 'both' : preview ? 'preview' : terminal ? 'terminal' : 'details';
}

// The repository whose ready preview an address is on (same origin: each sandbox has its own host), or null.
export function previewLibraryId(items, url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return null; }
  for (const { run } of Object.values(items || {})) {
    if (run?.status !== 'ready' || !run.preview_url) continue;
    try { if (new URL(run.preview_url).origin === origin) return run.library_id; } catch { /* not an address */ }
  }
  return null;
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
  // Another window saved its notifications (the shared localStorage's `storage` event, 2026-10-03): what it cleared is
  // cleared here and what it read is read here, so a notification put away in one window neither stays in another nor
  // comes back from it. Nothing is added: each window makes its own from the same progress events.
  if (action.type === 'sync') {
    const saved = action.saved || {};
    const dismissed = { ...state.dismissed };
    let changed = false;
    for (const [key, at] of Object.entries(saved.dismissed || {})) {
      if (!(Date.parse(dismissed[key]) >= Date.parse(at))) { dismissed[key] = at; changed = true; }
    }
    const read = new Set((saved.notifications || []).filter((row) => row.read).map((row) => row.id));
    const notifications = [];
    for (const row of state.notifications) {
      if (Date.parse(dismissed[dismissalKey(row)]) >= Date.parse(row.at)) { changed = true; continue; }
      if (!row.read && read.has(row.id)) { notifications.push({ ...row, read: true }); changed = true; } else notifications.push(row);
    }
    return changed ? { ...state, dismissed, notifications } : state;
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
    const boundary = run.status === 'ready' ? run.build_log?.findLast(entry => entry.message === 'Preview ready' || entry.data?.phase === 'ready')?.time
      : run.status === 'starting' ? run.build_log?.findLast(entry => entry.data?.lifecycle === 'restart')?.time
      : run.finished_at;
    // Preserve read/dismissed state as progress arrives and old log lines age out.
    const at = boundary || (samePhase && existing.at) || (changedPhase || run.status === 'failed' ? run.updated_at : run.created_at);
    const row = { id: `${run.id}:${run.status}:${at}`, runId: run.id, libraryId: run.library_id, status: run.status, at, read: false };
    if ((action.event.reveal || !(Date.parse(state.dismissed[dismissalKey(row)]) >= Date.parse(at))) && (!samePhase || Date.parse(at) > Date.parse(existing.at))) {
      notifications = [row, ...notifications.filter((entry) => entry.libraryId !== run.library_id)].slice(0, LIMIT);
    }
  }
  // `sandbox`: main's last sight of its sandbox, 'asleep' or 'running' (2026-10-04); null while main has not looked yet.
  const sandbox = action.event.sandbox !== undefined ? action.event.sandbox : previous?.run.id === run.id ? previous.sandbox ?? null : null;
  return { ...state, items: { ...state.items, [run.library_id]: { run, message, sandbox } }, notifications };
}

// A ready run's sandbox for the bell (2026-10-04): 'Asleep' (opening it wakes it, which can take a few seconds) or
// 'Running'; '' while unknown, and for a run that is not ready.
export const sandboxStatus = (run, sandbox) => (run?.status !== 'ready' ? '' : sandbox === 'asleep' ? 'Asleep' : sandbox === 'running' ? 'Running' : '');
