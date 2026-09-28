import React from 'react';
import { api } from '../api.js';

export function useZoteroStatus() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let live = true, revision = 0;
    const off = api.onZotero(value => { revision++; if (live && value) setStatus(value); });
    const load = () => {
      const ticket = ++revision;
      api.zoteroStatus().then(value => { if (live && ticket === revision) setStatus(value); }).catch(() => {});
    };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; off(); window.removeEventListener('focus', load); };
  }, []);
  return [status, setStatus];
}
