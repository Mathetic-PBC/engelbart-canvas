'use strict';

// The shells open in repositories' sandboxes (manager.cjs's `terminal`): one per repository, a session of the terminal's
// own SessionManager (provider 'sandbox', ../terminal/session-manager.cjs over pty.cjs), so it lives in the terminal
// pane, follows its window and ends with the app like any other. Opening it again shows the same session, woken if its
// sandbox slept. Closing its tab ends the shell, never the sandbox; stopping, replacing or releasing the sandbox
// (manager.cjs) ends the shell and takes its tab away.
//
// `sessions()`: the SessionManager. `own(id)`: the session's output goes to the window that asked
// (src/main/index.cjs). `closed(id)`: main ended it; its tab goes, wherever it is.
function createSandboxTerminals({ sessions, own = () => {}, closed = () => {} }) {
  const open = new Map(); // library id → { id, sandboxId }
  const snapshot = (id) => { try { return sessions().get(id); } catch { return null; } };

  // spec: what SessionManager.createSandbox takes. → the session's snapshot
  function openFor(spec) {
    const current = open.get(spec.libraryId);
    if (current) {
      const session = snapshot(current.id);
      if (session && session.status === 'running' && current.sandboxId === spec.sandboxId) {
        own(current.id);
        void sessions().wake(current.id).catch(() => {});
        return session;
      }
      open.delete(spec.libraryId);
      if (session) void end(current.id);
    }
    const session = sessions().createSandbox(spec);
    open.set(spec.libraryId, { id: session.id, sandboxId: spec.sandboxId });
    own(session.id);
    return session;
  }
  async function end(id) {
    try { await sessions().close(id); } catch { /* already gone */ }
    closed(id);
  }
  async function close(libraryId) {
    const current = open.get(libraryId);
    open.delete(libraryId);
    if (current && snapshot(current.id)) await end(current.id);
  }
  async function closeAll() {
    await Promise.all([...open.keys()].map(close));
  }
  return { open: openFor, close, closeAll };
}

module.exports = { createSandboxTerminals };
