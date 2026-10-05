import React from 'react';
import { api } from '../api.js';
import { bodyMaps } from '../model/rail.js';

/**
 * What the project's pdfs, notes and workspaces say (MATH-29, 2026-10-05), for model/rail.js to match: asked of the main
 * process (library.bodiesForProject) each time `open` turns on, so an edit since the last time is seen, and let go when it
 * turns off. An answer that arrives after it closed is dropped. null until the answer has come, and with no project.
 */
export function useBodies(projectId, open) {
  const [bodies, setBodies] = React.useState(null);
  React.useEffect(() => {
    if (!open || !projectId) { setBodies(null); return undefined; }
    let live = true;
    api.libraryBodies(projectId).then((reply) => { if (live) setBodies(bodyMaps(reply)); }).catch(() => {});
    return () => { live = false; };
  }, [projectId, open]);
  return bodies;
}
