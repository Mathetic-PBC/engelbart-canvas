// Where a project's Builds work (2026-09-29): the repository last picked in the Build panel, remembered in this
// window's storage per project; the default repo (a folder named after the project, in the project folder) until one is
// picked, and again when the one picked is gone. Main finds the folder (src/main/build/manager.cjs → targets, locate); a
// target only names it.

export const DEFAULT_TARGET = Object.freeze({ kind: 'default' });

const storageKey = (projectId) => `engelbart:build-target:${projectId}`;
const clean = (value) => {
  if (!value || typeof value !== 'object') return DEFAULT_TARGET;
  if (value.kind === 'library' && typeof value.id === 'string' && value.id) return { kind: 'library', id: value.id };
  if (value.kind === 'project') return { kind: 'project' };
  return DEFAULT_TARGET;
};

export const targetKey = (target) => (target.kind === 'library' ? `library:${target.id}` : target.kind);
export const sameTarget = (a, b) => !!a && !!b && targetKey(clean(a)) === targetKey(clean(b));

/** The remembered target when `targets` (the list main gave) still holds it, else the default repo. */
export function pickedTarget(projectId, targets) {
  let saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(storageKey(projectId)) || 'null'); } catch { saved = null; }
  const wanted = clean(saved);
  return (targets || []).some((item) => sameTarget(item, wanted)) ? wanted : DEFAULT_TARGET;
}

export function rememberTarget(projectId, target) {
  try { window.localStorage.setItem(storageKey(projectId), JSON.stringify(clean(target))); } catch { /* storage may be unavailable */ }
}

/** A picker row's small label: what kind of repository it is. `sandboxed`: a sandbox preview exists for the row. */
export function targetTag(item, sandboxed = false) {
  if (item.kind === 'default') return 'default';
  if (item.kind === 'project') return 'project';
  if (sandboxed) return 'sandbox';
  return item.place === 'github' ? 'github' : 'local';
}
