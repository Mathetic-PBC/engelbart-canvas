// Sandboxed isolated-world DOM reader. No API is exposed to website scripts.
// Unlike webContents.executeJavaScript, this can read the ready main document
// while Google's unrelated preload frames are still loading.
import { ipcRenderer } from 'electron';
import '../zotero/preload.js';
import { snapshotDrive } from './drive-page.cjs';

if (process.isMainFrame) ipcRenderer.on('google:read-listing', (_event, request) => {
  if (!request || typeof request.id !== 'string' || request.id.length > 80 ||
      (request.query !== null && !/^type:document after:\d{4}-\d{2}-\d{2}$/.test(request.query)) ||
      typeof request.advance !== 'boolean') return;
  let value = { kind: 'unavailable' };
  try { value = snapshotDrive(request.query, request.advance, request.origin); } catch { /* loading/navigation */ }
  ipcRenderer.send('google:listing', request.id, value);
});
