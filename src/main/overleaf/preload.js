import { ipcRenderer } from 'electron';
import { snapshotOverleaf } from './project-page.cjs';

// No contextBridge exports: only Canvas main can request an account or catalog.
if (process.isMainFrame) ipcRenderer.on('overleaf:read-listing', (_event, request) => {
  if (!request || typeof request.id !== 'string' || request.id.length > 80 ||
      ![null, 'all'].includes(request.query) || request.advance !== false) return;
  let value = { kind: 'unavailable' };
  try { value = snapshotOverleaf(request.query === null, request.origin); } catch { /* navigation */ }
  ipcRenderer.send('overleaf:listing', request.id, value);
});
