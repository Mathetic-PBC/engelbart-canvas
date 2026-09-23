// Where the sidebar's next row and ⌘J go (2026-09-22). Pure: state.json's `recent` and `agents` come in (main/store/
// projects.cjs readNav), one place goes out.

const same = (a, b) => !!a && !!b && a.projectId === b.projectId && a.workspaceId === b.workspaceId;

/**
 * An agent waiting for you comes first, the one that has waited longest (its workspace, once however many wait there);
 * the workspace you are in never counts. With nothing waiting, the workspaces written in last take turns: the one after
 * where you are in `recent`, or its first when you are somewhere else. Writing in a workspace moves it to the front, so
 * after an edit the next row is where you came from; while you only look around, it cycles through all three.
 * → { projectId, workspaceId, name, path, projectName, why: 'agent' | 'recent', at, waiting } | null
 */
export function nextPlace({ here, recent = [], agents = [] }) {
  const waiting = agents
    .filter((agent) => agent.status === 'waiting' && agent.workspaceId && !same(agent, here))
    .sort((a, b) => String(a.finished || '').localeCompare(String(b.finished || '')));
  if (waiting.length) {
    const first = waiting[0];
    const places = new Set(waiting.map((agent) => `${agent.projectId}/${agent.workspaceId}`));
    return { projectId: first.projectId, workspaceId: first.workspaceId, name: first.name, path: first.path, projectName: first.projectName, why: 'agent', at: first.finished, waiting: places.size };
  }
  const at = recent.findIndex((entry) => same(entry, here));
  for (let step = 1; step <= recent.length; step += 1) {
    const entry = recent[at < 0 ? step - 1 : (at + step) % recent.length];
    if (entry && !same(entry, here)) return { projectId: entry.projectId, workspaceId: entry.workspaceId, name: entry.name, path: entry.path, projectName: entry.projectName, why: 'recent', at: entry.at, waiting: 0 };
  }
  return null;
}

/** How long ago, the short way: "now", "4 min", "2 h", "3 d". */
export function ago(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor(Math.max(0, now - then) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (60 * 24))} d`;
}

/** Every workspace of a project's tree, flat, with the names of the workspaces above it. */
export function flatWorkspaces(roots) {
  const out = [];
  const walk = (list, above) => {
    for (const node of list || []) {
      out.push({ id: node.id, name: node.name, status: node.status, above });
      walk(node.children, [...above, node.name]);
    }
  };
  walk(roots, []);
  return out;
}

/** The workspace switcher's search: every workspace whose name holds the words typed, in any order; names that start with them first. */
export function findWorkspaces(all, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = all.filter((workspace) => { const name = workspace.name.toLowerCase(); return words.every((word) => name.includes(word)); });
  const starts = (workspace) => (workspace.name.toLowerCase().startsWith(words[0]) ? 0 : 1);
  return hits.map((workspace, i) => ({ workspace, i })).sort((a, b) => starts(a.workspace) - starts(b.workspace) || a.i - b.i).map(({ workspace }) => workspace);
}
