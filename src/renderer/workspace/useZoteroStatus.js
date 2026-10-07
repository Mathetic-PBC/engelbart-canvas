import React from 'react';
import { api } from '../api.js';

// The Zotero sign-in's status (src/main/zotero/connection.cjs): what zotero-status answers, then every change on engelbart:zotero.
export function useZoteroStatus() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    api.zoteroStatus().then((value) => { if (live) setStatus(value); }).catch(() => {});
    const off = api.onZotero((value) => { if (live && value) setStatus(value); });
    return () => { live = false; off(); };
  }, []);
  return [status, setStatus];
}
