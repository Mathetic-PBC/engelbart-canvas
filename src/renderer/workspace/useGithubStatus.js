import React from 'react';
import { api, errorMessage } from '../api.js';

export function useGithubStatus() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    api.githubStatus().then((value) => { if (live) setStatus(value); }).catch(() => {});
    const off = api.onGithub((value) => { if (live && value) setStatus(value); });
    return () => { live = false; off(); };
  }, []);
  return [status, setStatus];
}

