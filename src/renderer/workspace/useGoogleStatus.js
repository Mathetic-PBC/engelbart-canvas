import React from 'react';
import { api } from '../api.js';

export function useGoogleStatus() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let live = true, revision = 0;
    const off = api.onGoogle(value => { revision++; if (live && value) setStatus(value); });
    const load = () => {
      const ticket = ++revision;
      api.googleStatus().then(value => { if (live && ticket === revision) setStatus(value); }).catch(() => {});
    };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; off(); window.removeEventListener('focus', load); };
  }, []);
  return [status, setStatus];
}
