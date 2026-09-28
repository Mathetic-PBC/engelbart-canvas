export const OPEN_LOCAL_BUILD_NOTIFICATION = 'engelbart:show-local-build';
export const localBuildPhase = preview => preview.approval ? 'approval' : preview.error ? 'failed' : ['building', 'installing', 'starting', 'checking', 'repairing'].includes(preview.status) ? 'building' : preview.status;
export const localBuildKey = preview => `${preview.id}:${preview.runId || 'saved'}:${localBuildPhase(preview)}`;
export const localNotificationKey = root => `engelbart:local-build-notifications:${root}`;
export function readLocalNotifications(storage, root) {
  try {
    const saved = JSON.parse(storage.getItem(localNotificationKey(root)) || '{}');
    const keys = value => (Array.isArray(value) ? value : []).filter(key => typeof key === 'string' && key.length < 400).slice(-120);
    return { read: keys(saved.read), dismissed: keys(saved.dismissed) };
  } catch { return { read: [], dismissed: [] }; }
}
export const localNotificationState = (dataRoot, saved = {}) => ({ dataRoot, previews: {}, read: saved.read || [], dismissed: saved.dismissed || [] });
export const visibleLocalNotifications = state => Object.values(state.previews).filter(preview => (preview.runId || preview.recipe) && !state.dismissed.includes(localBuildKey(preview))).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
export function localNotificationReducer(state, action) {
  if (action.type === 'reset') return localNotificationState(action.dataRoot, action.saved);
  if (action.type === 'progress') {
    if (action.dataRoot !== state.dataRoot || !action.preview?.id) return state;
    // Events are ordered. A snapshot requested before them cannot replace one.
    if (action.snapshot && state.previews[action.preview.id]) return state;
    return { ...state, previews: { ...state.previews, [action.preview.id]: action.preview } };
  }
  if (action.type === 'read' || action.type === 'dismiss') {
    const field = action.type === 'read' ? 'read' : 'dismissed';
    return { ...state, [field]: [...new Set([...state[field], ...action.keys])].slice(-120) };
  }
  if (action.type === 'reveal') {
    const preview = state.previews[action.id];
    return preview ? { ...state, dismissed: state.dismissed.filter(key => key !== localBuildKey(preview)) } : state;
  }
  return state;
}
