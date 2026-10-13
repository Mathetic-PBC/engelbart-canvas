'use strict';

// The Agent map's IPC (2026-10-12; ./window.cjs). Trusted handlers that need no window's context: the map is no workspace
// window. agentMap:open opens or focuses it (from a workspace window's Agents button); agentMap:runs is every run without
// its big fields, newest first; agentMap:run(id) one run whole; agentMap:design each agent as it is set up now
// (./design.cjs); agentMap:export(html, name) saves a page the map made, through a save dialog. Each change to a run is
// sent to the map alone as engelbart:agent-run (index.cjs, the run log's onChange).

const MAX_EXPORT = 200 * 1024 * 1024;

function registerAgentMapIpc({ ipcMain, trustedHandler, mapWindow, runLog, design, saveFile }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  handle('agentMap:open', () => mapWindow.open());
  handle('agentMap:runs', () => (runLog ? runLog.list() : []));
  handle('agentMap:run', (id) => (runLog && typeof id === 'string' ? runLog.get(id) : null));
  handle('agentMap:design', () => design());
  handle('agentMap:export', async (html, name) => {
    if (typeof html !== 'string' || html.length > MAX_EXPORT) throw new Error('Nothing to export.');
    const safe = String(name || 'agent-runs').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'agent-runs';
    return saveFile(html, `${safe}.html`);
  });
}

module.exports = { registerAgentMapIpc };
