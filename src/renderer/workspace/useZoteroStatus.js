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

// The Zotero items main is looking for a free copy of (MATH-65 build 3, engelbart:zotero-finding): a Set of item keys,
// a new one on each change, for their chips to say "Finding a free copy…".
export function useZoteroFinding() {
  const [finding, setFinding] = React.useState(() => new Set());
  React.useEffect(() => {
    if (typeof api.onZoteroFinding !== 'function') return undefined;
    return api.onZoteroFinding((event) => {
      if (!event || typeof event.key !== 'string') return;
      setFinding((current) => {
        if (current.has(event.key) === !!event.finding) return current;
        const next = new Set(current);
        if (event.finding) next.add(event.key); else next.delete(event.key);
        return next;
      });
    });
  }, []);
  return finding;
}

// The Zotero items whose pdf main waits for in the Downloads folder (MATH-65 build 4: a chip opened the paper in the
// browser; engelbart:zotero-waiting): a Set of item keys, for their chips to say "Waiting for your download…".
export function useZoteroWaiting() {
  const [waiting, setWaiting] = React.useState(() => new Set());
  React.useEffect(() => {
    if (typeof api.onZoteroWaiting !== 'function') return undefined;
    let live = true;
    if (typeof api.zoteroWaiting === 'function') api.zoteroWaiting().then((keys) => { if (live && Array.isArray(keys) && keys.length) setWaiting((current) => new Set([...current, ...keys])); }).catch(() => {});
    const off = api.onZoteroWaiting((event) => {
      if (!event || typeof event.key !== 'string') return;
      setWaiting((current) => {
        if (current.has(event.key) === !!event.waiting) return current;
        const next = new Set(current);
        if (event.waiting) next.add(event.key); else next.delete(event.key);
        return next;
      });
    });
    return () => { live = false; off(); };
  }, []);
  return waiting;
}
