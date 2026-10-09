// Which Connect your library sessions this window shows right now (screens/ConnectLibrary.jsx marks its own), so the
// dock (ui/ConnectDock.jsx) shows only the ones running out of sight. One set per window.

const open = new Map(); // session id → how many hosts show it
const listeners = new Set();

export function markOpen(id, on) {
  if (!id) return;
  const n = (open.get(id) || 0) + (on ? 1 : -1);
  if (n > 0) open.set(id, n); else open.delete(id);
  for (const listener of listeners) listener();
}

export const isOpen = (id) => open.has(id);

export function onOpenChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
