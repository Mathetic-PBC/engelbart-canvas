import React from 'react';
import { api } from '../api.js';

// reMarkable's status (src/main/remarkable/sync.cjs): what remarkable-status answers, then every change on engelbart:remarkable.
export function useRemarkableStatus() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    if (typeof api.remarkableStatus !== 'function') return undefined;
    api.remarkableStatus().then((value) => { if (live) setStatus(value); }).catch(() => {});
    const off = api.onRemarkable((value) => { if (live && value) setStatus(value); });
    return () => { live = false; off(); };
  }, []);
  return [status, setStatus];
}
