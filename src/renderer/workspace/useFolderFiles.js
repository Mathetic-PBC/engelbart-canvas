import React from 'react';
import { api } from '../api.js';

const keyOf = (folderId, rel) => `${folderId}\n${rel}`;

/**
 * Whether the files inside library folders that the lines mention are still there (MATH-22, MF-05), for the chips to be
 * drawn by. `fileState(folderId, rel)`: { dir } when it is there, false when it is not, undefined until main has said
 * (asked in one batch a moment after a line first draws it; store/folder-files.cjs folderFiles). Asked again whenever the
 * window comes back to the front, so a file renamed or deleted meanwhile shows as missing; `recheck(folderId, rel)` asks
 * again now (a click on a chip whose file was found gone). A new `fileState` comes with each answer that changes
 * something, which is what redraws the lines.
 */
export function useFolderFiles() {
  const [known, setKnown] = React.useState(() => new Map());
  const asked = React.useRef(new Set());
  const queue = React.useRef(new Map());
  const timer = React.useRef(0);
  const live = React.useRef(true);
  React.useEffect(() => () => { live.current = false; clearTimeout(timer.current); }, []);

  const flush = React.useCallback(() => {
    timer.current = 0;
    const list = [...queue.current.values()];
    queue.current = new Map();
    if (!list.length) return;
    api.folderFiles(list).then((answers) => {
      if (!live.current || !Array.isArray(answers)) return;
      setKnown((current) => {
        let next = null;
        for (const answer of answers) {
          const key = keyOf(answer.folderId, answer.rel), value = answer.exists ? { dir: !!answer.dir } : false, was = current.get(key);
          if (was !== undefined && (was === false ? value === false : value && value.dir === was.dir)) continue;
          if (!next) next = new Map(current);
          next.set(key, value);
        }
        return next || current;
      });
    }).catch(() => { for (const item of list) asked.current.delete(keyOf(item.folderId, item.rel)); });
  }, []);
  const ask = React.useCallback((folderId, rel) => {
    const key = keyOf(folderId, rel);
    asked.current.add(key);
    queue.current.set(key, { folderId, rel });
    if (!timer.current) timer.current = setTimeout(flush, 30);
  }, [flush]);

  // Back to the front: everything known is asked again.
  React.useEffect(() => {
    const again = () => { for (const key of asked.current) { const at = key.indexOf('\n'); ask(key.slice(0, at), key.slice(at + 1)); } };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [ask]);

  const fileState = React.useCallback((folderId, rel) => {
    const key = keyOf(folderId, rel);
    if (!asked.current.has(key)) ask(folderId, rel);
    return known.get(key);
  }, [known, ask]);
  const recheck = React.useCallback((folderId, rel) => ask(folderId, rel), [ask]);
  return { fileState, recheck };
}
