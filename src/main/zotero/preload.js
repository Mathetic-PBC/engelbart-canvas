import { ipcRenderer } from 'electron';
import { readLibraryPage } from './library-page.cjs';

// No window bridge; only the main process may request read-only metadata.
if (process.isMainFrame) ipcRenderer.on('zotero:read-library', async (_event, request) => {
  if (!request || typeof request.id !== 'string' || request.id.length > 80 ||
      typeof request.origin !== 'string' || !(request.start === null || Number.isSafeInteger(request.start))) return;
  let value = { kind: 'unavailable' };
  try { value = await readLibraryPage(request); } catch { /* navigation or layout change */ }
  ipcRenderer.send('zotero:library', request.id, value);
});
