// Where a workspace's Builds work (2026-09-29): the repository last picked in the Build panel, remembered in this
// window's storage per workspace (a pick saved before that, per project, counts until the workspace has its own); the
// project's default repo (project.json → defaultTarget, set with Make default) until one is picked, and again when the
// one picked is gone. A post-it's Build has no picker: always the default repo. Main finds the folder
// (src/main/build/manager.cjs → targets, locate); a target only names it.

export const DEFAULT_TARGET = Object.freeze({ kind: 'default' });

const storageKey = (projectId, workspaceId) => `engelbart:build-target:${projectId}:${workspaceId || ''}`;
const projectKey = (projectId) => `engelbart:build-target:${projectId}`; // before 2026-09-29: one pick per project
const clean = (value) => {
  if (!value || typeof value !== 'object') return DEFAULT_TARGET;
  if (value.kind === 'library' && typeof value.id === 'string' && value.id) return { kind: 'library', id: value.id };
  if (value.kind === 'project') return { kind: 'project' };
  return DEFAULT_TARGET;
};

export const targetKey = (target) => (target.kind === 'library' ? `library:${target.id}` : target.kind);
export const sameTarget = (a, b) => !!a && !!b && targetKey(clean(a)) === targetKey(clean(b));

/** The workspace's remembered target (else the project's, as it was saved before) when `targets` (the list main gave) still holds it, else the default repo. */
export function pickedTarget(projectId, workspaceId, targets) {
  let saved = null;
  try {
    const storage = window.localStorage;
    saved = JSON.parse(storage.getItem(storageKey(projectId, workspaceId)) || storage.getItem(projectKey(projectId)) || 'null');
  } catch { saved = null; }
  const wanted = clean(saved);
  return (targets || []).some((item) => sameTarget(item, wanted)) ? wanted : DEFAULT_TARGET;
}

export function rememberTarget(projectId, workspaceId, target) {
  try { window.localStorage.setItem(storageKey(projectId, workspaceId), JSON.stringify(clean(target))); } catch { /* storage may be unavailable */ }
}

/** A picker row's small label: what kind of repository it is. `sandboxed`: a sandbox preview exists for the row. */
export function targetTag(item, sandboxed = false) {
  if (item.kind === 'default') return 'default';
  if (item.kind === 'project') return 'project';
  if (sandboxed) return 'sandbox';
  return item.place === 'github' ? 'github' : 'local';
}
